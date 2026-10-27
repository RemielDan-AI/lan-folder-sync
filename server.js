#!/usr/bin/env node
/**
 * Communication · 局域网文件夹同步
 * ------------------------------------------------------------------
 * 单文件 HTTP 服务：静态界面 + 本机控制 API + 对端同步 API + SSE 进度推送。
 * 零第三方依赖，只用 Node 内置模块。
 *
 * 角色：
 *   admin  → 本机浏览器（回环地址拿到的管理员令牌），可以管理文件夹、发起同步
 *   peer   → 局域网另一台机器/手机浏览器，只能读写被共享文件夹的内容
 *
 * 多文件夹模型：每台机器可以共享多个文件夹；一次同步是
 * "(本机文件夹, 对端, 对端文件夹)" 这个三元组，对端接口都用 folderId 指明是哪一个。
 */

import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { APP_TITLE, APP_VERSION, DEFAULT_PORT, MAX_FOLDERS, Store, clampInterval } from './lib/config.js';
import { applyPlan, scanPlan } from './lib/engine.js';
import { hashMany, walkFolder } from './lib/manifest.js';
import { Discovery, lanAddresses, normalizeBaseUrl, probePort } from './lib/net.js';
import { fetchPeerFolders, fetchPeerGreet, fetchPeerManifest, openPeerFile, pairWithPeer } from './lib/peer-api.js';
import { normalizeRel, resolveInside } from './lib/safe-path.js';
import { deleteLocalFile } from './lib/transfer.js';
import { extractZip } from './lib/unzip.js';
import { zipStream, zipStreamFromSources } from './lib/zip.js';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_ROOT, 'public');
const SHARED_DIR = path.join(APP_ROOT, 'shared');
const DATA_DIR = process.env.LAN_SYNC_DATA ? path.resolve(process.env.LAN_SYNC_DATA) : path.join(APP_ROOT, 'data');
const DISCOVERY_OFF = process.env.LAN_SYNC_DISCOVERY === '0';
const NO_BROWSER = process.env.LAN_SYNC_NO_BROWSER === '1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const store = new Store(DATA_DIR);
let discovery = null;
let serverPort = DEFAULT_PORT;

/* ------------------------------------------------------------------ 工具 */

class HttpError extends Error {
  constructor(status, message, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message, code = '') {
  sendJson(res, status, { error: message, code });
}

async function readJson(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, '请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

function remoteIp(req) {
  const raw = req.socket.remoteAddress || '';
  if (raw === '::1') return '127.0.0.1';
  return raw.replace(/^::ffff:/, '');
}

function isLoopback(req) {
  const ip = remoteIp(req);
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.');
}

function peerUrlFrom(req, reportedPort) {
  const port = Number(reportedPort) || DEFAULT_PORT;
  const ip = remoteIp(req);
  const host = ip.includes(':') ? `[${ip}]` : ip;
  return `http://${host}:${port}`;
}

/** 取共享文件夹：给了 id 就用它；没给且只有一个共享文件夹时用它 */
function resolveFolder(folderId) {
  const folders = store.listFolders();
  if (folderId) {
    const folder = store.findFolder(folderId);
    if (!folder) throw new HttpError(404, '没有这个共享文件夹（可能已被移除）', 'NO_FOLDER');
    return folder;
  }
  if (folders.length === 1) return folders[0];
  if (!folders.length) throw new HttpError(400, '对方还没有添加要共享的文件夹', 'NO_FOLDER');
  throw new HttpError(400, '对方有多个共享文件夹，需要指定 folderId', 'FOLDER_REQUIRED');
}

function publicFolder(folder) {
  return { id: folder.id, name: folder.name, path: folder.path };
}

/** 能主动调用（下载/扫描）的对端；手机这类纯客户端会被拒绝 */
function callablePeer(peerId) {
  const peer = store.findPeer(String(peerId || ''));
  if (!peer) throw new HttpError(404, '对端不存在');
  if (peer.kind === 'client') throw new HttpError(400, '这是纯客户端对端，无法主动读取它的文件');
  if (!peer.callToken) throw new HttpError(400, '对端令牌缺失，请重新配对');
  return peer;
}

function remoteFolderId(url) {
  const folderId = String(url.searchParams.get('folderId') || '').trim();
  if (!folderId) throw new HttpError(400, '缺少 folderId');
  return folderId;
}

/* ------------------------------------------------------------------ 鉴权 */

function tokenFrom(req, url) {
  const header = req.headers.authorization || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  const alt = req.headers['x-auth-token'];
  if (typeof alt === 'string' && alt) return alt;
  return url.searchParams.get('token') || '';
}

function authenticate(req, url) {
  const token = tokenFrom(req, url);
  if (!token) return null;
  if (token === store.info.adminToken) {
    return { role: 'admin', id: store.info.id, name: store.info.name };
  }
  const peer = store.findPeerByToken(token);
  if (peer) return { role: 'peer', id: peer.id, name: peer.name, peer };
  return null;
}

const pairAttempts = new Map();
function allowPairAttempt(ip) {
  const now = Date.now();
  const item = pairAttempts.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > item.resetAt) {
    item.count = 0;
    item.resetAt = now + 60_000;
  }
  item.count += 1;
  pairAttempts.set(ip, item);
  return item.count <= 8;
}

/* --------------------------------------------------------------- SSE 推送 */

const sseClients = new Set();

function emit(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(line);
    } catch {
      sseClients.delete(res);
    }
  }
}

const heartbeat = setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(': ping\n\n');
    } catch {
      sseClients.delete(res);
    }
  }
}, 25_000);
heartbeat.unref();

/* ------------------------------------------------------------------ 任务 */

const jobs = new Map();

function createJob(type, meta = {}) {
  const job = {
    id: randomUUID().slice(0, 8),
    type,
    status: 'running',
    stage: '准备中',
    startedAt: new Date().toISOString(),
    controller: new AbortController(),
    result: null,
    error: '',
    progress: { index: 0, total: 0 },
    ...meta,
  };
  jobs.set(job.id, job);
  const finished = [...jobs.values()].filter((item) => item.status !== 'running');
  if (finished.length > 20) {
    finished.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
    for (const stale of finished.slice(0, finished.length - 20)) jobs.delete(stale.id);
  }
  return job;
}

function publicJob(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    stage: job.stage,
    startedAt: job.startedAt,
    error: job.error,
    progress: job.progress,
    result: job.result,
  };
}

function runJob(job, runner) {
  Promise.resolve()
    .then(runner)
    .then((result) => {
      job.status = 'done';
      job.result = result ?? job.result;
      emit({ jobId: job.id, type: 'job-done', status: 'done', result: job.result });
    })
    .catch((err) => {
      if (err?.name === 'CancelledError' || job.controller.signal.aborted) {
        job.status = 'cancelled';
        emit({ jobId: job.id, type: 'job-done', status: 'cancelled' });
        return;
      }
      job.status = 'error';
      job.error = err?.message || String(err);
      emit({ jobId: job.id, type: 'job-done', status: 'error', error: job.error });
    });
}

/* --------------------------------------------------------------- 自动同步 */

const autoRunning = new Set();
let autoTimer = null;

function anyJobRunning() {
  return [...jobs.values()].some((job) => job.status === 'running');
}

/** 一次完整的"对比 + 执行"（一键同步和自动同步共用）
 *  conflictPolicy: 'manual' → 有冲突就停下让用户选；'newest' → 按修改时间自动裁决（仅自动同步用）
 */
async function runSyncCycle({
  peer,
  localFolderId,
  remoteFolderId,
  allowDeletes = false,
  conflictPolicy = 'manual',
  signal,
  onEvent,
}) {
  const plan = await scanPlan({
    store,
    peer,
    localFolderId,
    remoteFolderId,
    signal,
    onEvent,
    conflictPolicy,
  });
  // 手动场景下遇到冲突一律不替你决定：把计划交回去让你选
  if (conflictPolicy === 'manual' && plan.summary.pendingConflicts > 0) {
    return {
      plan,
      results: { ok: 0, failed: 0, bytes: 0, skipped: 0, errors: [] },
      applied: false,
      conflicts: plan.summary.pendingConflicts,
    };
  }
  const pending = plan.entries.filter((entry) => entry.action && entry.action !== 'none');
  if (!pending.length) {
    return { plan, results: { ok: 0, failed: 0, bytes: 0, skipped: 0, errors: [] }, applied: true, conflicts: 0 };
  }
  const results = await applyPlan({
    store,
    peer,
    localFolderId,
    remoteFolderId,
    entries: plan.entries,
    allowDeletes,
    signal,
    onEvent,
  });
  await store.appendHistory({
    at: new Date().toISOString(),
    peerId: peer.id,
    peerName: peer.name,
    localName: plan.folder?.localName || '',
    remoteName: plan.folder?.remoteName || '',
    ok: results.ok,
    failed: results.failed,
    bytes: results.bytes,
  });
  return { plan, results, applied: true, conflicts: 0 };
}

async function runAutoSync(item, peer) {
  const startedAt = new Date().toISOString();
  const base = {
    autoKey: item.key,
    peerId: peer.id,
    localFolderId: item.localFolderId,
    remoteFolderId: item.remoteFolderId,
    at: startedAt,
  };
  try {
    const { results } = await runSyncCycle({
      peer,
      localFolderId: item.localFolderId,
      remoteFolderId: item.remoteFolderId,
      allowDeletes: false,
      // 自动同步没人看着，冲突按修改时间裁决：较新者胜，另一方存副本
      conflictPolicy: 'newest',
    });
    await store.markAutoSyncRun(item.key, {
      lastRunAt: startedAt,
      lastResult: { ok: results.ok, failed: results.failed, bytes: results.bytes, at: startedAt },
      lastError: '',
    });
    emit({ type: 'auto-run', ...base, ok: results.ok, failed: results.failed, bytes: results.bytes });
  } catch (err) {
    await store.markAutoSyncRun(item.key, { lastRunAt: startedAt, lastError: err.message || String(err) });
    emit({ type: 'auto-run', ...base, ok: 0, failed: 1, error: err.message || String(err) });
  }
}

/** 每 5 秒看一眼哪些同步项到点了；一次只跑一个，避免同时打满磁盘和网络 */
async function autoSyncTick() {
  const items = store.listAutoSync().filter((item) => item.enabled);
  if (!items.length || anyJobRunning()) return;
  const now = Date.now();
  for (const item of items) {
    if (autoRunning.has(item.key)) continue;
    const last = item.lastRunAt ? Date.parse(item.lastRunAt) : 0;
    if (last && now - last < (Number(item.intervalSec) || 120) * 1000) continue;

    const peer = store.findPeer(item.peerId);
    if (!peer) {
      await store.markAutoSyncRun(item.key, { enabled: false, lastError: '对端已被移除' });
      continue;
    }
    if (!store.findFolder(item.localFolderId)) {
      await store.markAutoSyncRun(item.key, { enabled: false, lastError: '本机文件夹已被移除' });
      continue;
    }
    autoRunning.add(item.key);
    runAutoSync(item, peer)
      .catch(() => {})
      .finally(() => autoRunning.delete(item.key));
    return;
  }
}

/* ------------------------------------------------------------- 路由分发 */

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method || 'GET';

  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, url, pathname, method);
    return await handleStatic(req, res, pathname);
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    sendError(res, err?.status || 500, err?.message || '服务器内部错误', err?.code || '');
  }
}

async function handleApi(req, res, url, pathname, method) {
  /* ---- 不需要鉴权 ---- */
  if (pathname === '/api/ping') return sendJson(res, 200, { ok: true, app: 'commsync', version: APP_VERSION });

  if (pathname === '/api/peer/greet') {
    return sendJson(res, 200, {
      app: 'commsync',
      version: APP_VERSION,
      id: store.info.id,
      name: store.info.name,
      port: serverPort,
      folderCount: store.listFolders().length,
    });
  }

  if (pathname === '/api/pair' && method === 'POST') return handlePair(req, res);

  /* ---- 以下都需要令牌 ---- */
  const auth = authenticate(req, url);
  if (!auth) return sendError(res, 401, '需要配对码或令牌', 'UNAUTHORIZED');

  const isAdmin = auth.role === 'admin';

  switch (pathname) {
    /* ---------------- 对端接口：任何已配对设备都能用 ---------------- */
    case '/api/peer/folders': {
      return sendJson(res, 200, {
        name: store.info.name,
        folders: store.listFolders().map(publicFolder),
      });
    }

    case '/api/peer/manifest': {
      const body = await readJson(req);
      const folder = resolveFolder(body.folderId);
      const files = await walkFolder(folder.path);
      return sendJson(res, 200, {
        root: folder.path,
        folder: publicFolder(folder),
        count: Object.keys(files).length,
        files,
      });
    }

    case '/api/peer/hashes': {
      const body = await readJson(req);
      const folder = resolveFolder(body.folderId);
      const paths = Array.isArray(body.paths) ? body.paths.slice(0, 20000) : [];
      const clean = paths.map((item) => normalizeRel(item)).filter(Boolean);
      const hashes = await hashMany(folder.path, clean);
      return sendJson(res, 200, { hashes });
    }

    case '/api/peer/file': {
      if (method === 'GET') return handleDownload(req, res, url);
      if (method === 'PUT') return handleUpload(req, res, url);
      return sendError(res, 405, '不支持的方法');
    }

    case '/api/peer/delete': {
      const body = await readJson(req);
      const folder = resolveFolder(body.folderId);
      const root = folder.path;
      const paths = Array.isArray(body.paths) ? body.paths : [];
      const deleted = [];
      const missing = [];
      const failed = [];
      for (const raw of paths) {
        try {
          const rel = normalizeRel(raw);
          if (!rel) throw new Error('非法路径');
          const abs = resolveInside(root, rel);
          const st = await fsp.lstat(abs).catch(() => null);
          if (!st) {
            missing.push(rel);
            continue;
          }
          await deleteLocalFile(root, abs);
          deleted.push(rel);
        } catch (err) {
          failed.push({ path: raw, error: err.message });
        }
      }
      return sendJson(res, 200, { deleted, missing, failed });
    }

    case '/api/peer/copy': {
      const body = await readJson(req);
      const folder = resolveFolder(body.folderId);
      const from = normalizeRel(body.from);
      const to = normalizeRel(body.to);
      if (!from || !to) return sendError(res, 400, '路径非法');
      const srcAbs = resolveInside(folder.path, from);
      const dstAbs = resolveInside(folder.path, to);
      await fsp.mkdir(path.dirname(dstAbs), { recursive: true });
      await fsp.copyFile(srcAbs, dstAbs);
      const st = await fsp.stat(srcAbs);
      await fsp.utimes(dstAbs, st.atime, st.mtime);
      return sendJson(res, 200, { ok: true, sig: `${st.size}:${Math.round(st.mtimeMs)}`, size: st.size });
    }

    case '/api/peer/zip': {
      if (method !== 'GET') return sendError(res, 405, '不支持的方法');
      const folder = resolveFolder(url.searchParams.get('folderId'));
      const root = folder.path;
      let relPaths;
      if (url.searchParams.get('all') === '1') {
        const files = await walkFolder(root);
        relPaths = Object.keys(files);
      } else {
        relPaths = (url.searchParams.get('paths') || '')
          .split(',')
          .map((item) => normalizeRel(item))
          .filter(Boolean);
      }
      if (!relPaths.length) return sendError(res, 400, '没有要打包的文件');
      const stamp = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="sync-${stamp}.zip"; filename*=UTF-8''${encodeURIComponent(`同步包-${stamp}.zip`)}`,
        'Cache-Control': 'no-store',
      });
      for await (const chunk of zipStream(root, relPaths)) {
        if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
      }
      res.end();
      return undefined;
    }

    // 自由下载：把对端的单个文件转给浏览器（不参与同步，不写进本机同步文件夹）
    case '/api/peer/download': {
      if (method !== 'GET') return sendError(res, 405, '不支持的方法');
      const peer = callablePeer(url.searchParams.get('peerId'));
      const folder = remoteFolderId(url);
      const rel = normalizeRel(url.searchParams.get('path'));
      if (!rel) return sendError(res, 400, '路径非法');

      const upstream = await openPeerFile(peer.url, peer.callToken, folder, rel);
      const fileName = rel.split('/').pop() || 'download';
      const headers = {
        'Content-Type': 'application/octet-stream',
        // 中文文件名：ASCII 兜底 + filename* 给现代浏览器
        'Content-Disposition': `attachment; filename="${fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'Cache-Control': 'no-store',
      };
      if (upstream.headers['content-length']) headers['Content-Length'] = upstream.headers['content-length'];
      res.writeHead(200, headers);
      await pipeline(upstream, res).catch(() => {});
      return undefined;
    }

    // 自由下载：把对端整个文件夹打包成 zip 流给浏览器（边拉边打包，不落临时文件）
    case '/api/peer/download-zip': {
      if (method !== 'GET') return sendError(res, 405, '不支持的方法');
      const peer = callablePeer(url.searchParams.get('peerId'));
      const folder = remoteFolderId(url);
      const manifest = await fetchPeerManifest(peer.url, peer.callToken, folder);
      const files = manifest?.files && typeof manifest.files === 'object' ? manifest.files : {};
      const relPaths = Object.keys(files).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }));
      if (!relPaths.length) return sendError(res, 400, '对方这个文件夹里没有文件');

      const sources = relPaths.map((rel) => ({
        name: rel,
        size: Number(files[rel]?.size) || 0,
        mtimeMs: Number(files[rel]?.mtimeMs) || Date.now(),
        open: () => openPeerFile(peer.url, peer.callToken, folder, rel),
      }));
      const stamp = new Date().toISOString().slice(0, 10);
      const zipName = `${peer.name || '对端'}-${manifest?.folder?.name || '文件'}-${stamp}.zip`;
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="peer-${stamp}.zip"; filename*=UTF-8''${encodeURIComponent(zipName)}`,
        'Cache-Control': 'no-store',
      });
      for await (const chunk of zipStreamFromSources(sources)) {
        if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
      }
      res.end();
      return undefined;
    }

    // 手机上传整个文件夹：先压缩再 PUT 上来，服务端解开（iOS 不支持网页选文件夹）
    case '/api/peer/archive': {
      if (method !== 'PUT') return sendError(res, 405, '不支持的方法');
      const folder = resolveFolder(url.searchParams.get('folderId'));
      const prefix = normalizeRel(url.searchParams.get('prefix') || '') || '';
      const temp = path.join(DATA_DIR, `upload-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.zip`);
      await fsp.mkdir(DATA_DIR, { recursive: true });

      try {
        await pipeline(req, createWriteStream(temp));
        const result = await extractZip(temp, folder.path, { prefix });
        return sendJson(res, 200, {
          ok: true,
          extracted: result.files.length,
          skipped: result.skipped,
        });
      } finally {
        await fsp.rm(temp, { force: true });
      }
    }

    /* ---------------- 管理员接口：只给本机界面 ---------------- */
    default:
      break;
  }

  if (!isAdmin) return sendError(res, 403, '该操作只能在本机界面执行', 'ADMIN_ONLY');

  switch (pathname) {
    case '/api/info':
      return sendJson(res, 200, await buildInfo());

    case '/api/browse':
      return sendJson(res, 200, await browseFolder(url.searchParams.get('path') || ''));

    case '/api/folders': {
      if (method === 'GET') return sendJson(res, 200, { folders: await folderListWithState() });
      if (method !== 'POST') break;
      const body = await readJson(req);
      const target = String(body.path || '').trim();
      if (!target) throw new HttpError(400, '请提供文件夹路径');
      const abs = path.resolve(target);
      const st = await fsp.stat(abs).catch(() => null);
      if (!st || !st.isDirectory()) throw new HttpError(400, '路径不存在或不是文件夹');
      const folder = await store.addFolder(abs, String(body.name || '').trim() || undefined);
      emit({ type: 'folders' });
      return sendJson(res, 200, { folder: publicFolder(folder), folders: await folderListWithState() });
    }

    case '/api/folders/remove': {
      if (method !== 'POST') break;
      const body = await readJson(req);
      const id = String(body.id || '');
      if (!id) throw new HttpError(400, '缺少文件夹 id');
      await store.removeFolder(id);
      emit({ type: 'folders' });
      return sendJson(res, 200, { folders: await folderListWithState() });
    }

    case '/api/folders/rename': {
      if (method !== 'POST') break;
      const body = await readJson(req);
      const folder = await store.renameFolder(String(body.id || ''), String(body.name || ''));
      emit({ type: 'folders' });
      return sendJson(res, 200, { folder: folder ? publicFolder(folder) : null, folders: await folderListWithState() });
    }

    // 给某个同步项开关自动同步
    case '/api/auto-sync': {
      if (method !== 'POST') break;
      const body = await readJson(req);
      const peer = store.findPeer(String(body.peerId || ''));
      if (!peer) throw new HttpError(400, '对端不存在');
      const localFolderId = String(body.localFolderId || '');
      const remoteFolderId = String(body.remoteFolderId || '');
      if (!store.findFolder(localFolderId)) throw new HttpError(400, '本机文件夹不存在');
      if (!remoteFolderId) throw new HttpError(400, '请选择对方的文件夹');
      const item = await store.setAutoSyncItem({
        peerId: peer.id,
        localFolderId,
        remoteFolderId,
        enabled: !!body.enabled,
        intervalSec: clampInterval(body.intervalSec),
      });
      emit({ type: 'settings' });
      return sendJson(res, 200, { item, autoSync: buildAutoSyncInfo() });
    }

    case '/api/pairing-code': {
      if (method !== 'POST') break;
      await store.regeneratePairingCode();
      emit({ type: 'pairing-code', code: store.info.pairingCode });
      return sendJson(res, 200, { pairingCode: store.info.pairingCode });
    }

    case '/api/name': {
      if (method !== 'POST') break;
      const body = await readJson(req);
      const name = String(body.name || '').trim().slice(0, 40);
      if (!name) throw new HttpError(400, '名称不能为空');
      await store.saveConfig({ name });
      return sendJson(res, 200, { name });
    }

    case '/api/discover':
      return sendJson(res, 200, {
        enabled: !DISCOVERY_OFF,
        peers: discovery ? discovery.list().filter((peer) => !store.findPeer(peer.id)) : [],
      });

    case '/api/pair-peer': {
      if (method !== 'POST') break;
      const body = await readJson(req);
      const baseUrl = normalizeBaseUrl(body.url);
      if (!baseUrl) throw new HttpError(400, '地址格式不正确');
      const code = String(body.code || '').trim();
      if (!/^\d{6}$/.test(code)) throw new HttpError(400, '配对码应为 6 位数字');

      const greet = await fetchPeerGreet(baseUrl);
      if (greet?.app !== 'commsync') throw new HttpError(400, '目标不是本工具的节点');

      // 本地先准备一枚给对端用的回连令牌，双方各持一枚，配对一次即可双向同步
      const authToken = createHash('sha256')
        .update(`${store.info.adminToken}:${greet.id}:${Date.now()}`)
        .digest('hex')
        .slice(0, 40);

      const reply = await pairWithPeer(baseUrl, {
        code,
        id: store.info.id,
        name: store.info.name,
        port: serverPort,
        token: authToken,
        // 不猜自己的局域网地址：对端会按这次请求的来源地址写回连地址，永远可达
        url: '',
      });

      const peer = await store.upsertPeer({
        id: greet.id,
        name: greet.name || reply?.name || '对端',
        version: greet.version || '',
        url: baseUrl,
        callToken: reply?.token || '',
        authToken,
        pairedAt: new Date().toISOString(),
      });
      emit({ type: 'peers' });
      return sendJson(res, 200, { peer: redactPeer(peer) });
    }

    // 浏览对端的文件清单（只读，用于"自由下载"，不参与同步、不写基线）
    case '/api/peer-listing': {
      if (method !== 'GET') return sendError(res, 405, '不支持的方法');
      const peer = callablePeer(url.searchParams.get('peerId'));
      const folder = remoteFolderId(url);
      const manifest = await fetchPeerManifest(peer.url, peer.callToken, folder);
      const raw = manifest?.files && typeof manifest.files === 'object' ? manifest.files : {};
      const files = Object.entries(raw)
        .map(([rel, item]) => ({ path: rel, size: Number(item?.size) || 0, mtimeMs: Number(item?.mtimeMs) || 0 }))
        .sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN', { numeric: true }));
      return sendJson(res, 200, {
        root: manifest?.root || '',
        folder: manifest?.folder || { id: folder, name: '' },
        files,
      });
    }

    // 列出对端共享了哪些文件夹（界面用它做"同步到哪个文件夹"的下拉）
    case '/api/peer-folders': {
      if (method !== 'POST') break;
      const body = await readJson(req);
      const peer = store.findPeer(String(body.peerId || ''));
      if (!peer) throw new HttpError(404, '对端不存在');
      // 手机 App 是纯客户端：它没有服务端，也没有共享文件夹。
      // 老版本 App 配对时不会带 kind，但它同样拿不到回连令牌——两种都按"客户端"处理，
      // 免得界面显示成"对方没有共享文件夹"这种让人误解的状态。
      if (peer.kind === 'client' || !peer.callToken) {
        return sendJson(res, 200, {
          name: peer.name,
          folders: [],
          clientOnly: true,
          platform: peer.platform || '',
          reason: peer.kind === 'client' ? 'client' : 'no-call-token',
        });
      }
      if (!peer.callToken) throw new HttpError(400, '对端令牌缺失，请重新配对');
      try {
        const payload = await fetchPeerFolders(peer.url, peer.callToken);
        return sendJson(res, 200, { name: payload?.name || peer.name, folders: payload?.folders || [] });
      } catch (err) {
        throw new HttpError(502, `读取对端文件夹失败：${err.message}`);
      }
    }

    case '/api/peer-remove': {
      if (method !== 'POST') break;
      const body = await readJson(req);
      await store.removePeer(String(body.id || ''));
      emit({ type: 'peers' });
      return sendJson(res, 200, { ok: true });
    }

    case '/api/jobs/scan': {
      if (method !== 'POST') break;
      const body = await readJson(req);
      const peer = store.findPeer(String(body.peerId || ''));
      if (!peer) throw new HttpError(400, '请先与对端配对');
      if (peer.kind === 'client') {
        throw new HttpError(400, '这是手机 App 这类客户端：只能由手机发起同步，电脑端不能主动拉它的文件');
      }
      if (!peer.callToken) throw new HttpError(400, '对端令牌缺失，请重新配对');
      const localFolderId = String(body.localFolderId || '');
      const remoteFolderId = String(body.remoteFolderId || '');
      if (!store.findFolder(localFolderId)) throw new HttpError(400, '请选择本机文件夹');
      if (!remoteFolderId) throw new HttpError(400, '请选择对方的文件夹');

      const job = createJob('scan', { peerId: peer.id, localFolderId, remoteFolderId });
      runJob(job, async () => {
        const plan = await scanPlan({
          store,
          peer,
          localFolderId,
          remoteFolderId,
          signal: job.controller.signal,
          onEvent: (event) => {
            if (event.stage) job.stage = event.message || event.stage;
            if (event.type === 'scan-progress') job.progress = { index: event.count, total: 0, side: event.side };
            if (event.type === 'hash-progress') job.progress = { index: event.done, total: event.total, side: event.side };
            emit({ jobId: job.id, ...event });
          },
        });
        job.stage = '扫描完成';
        const payload = planPayload(job, plan);
        emit({ jobId: job.id, type: 'plan', plan: payload });
        return payload;
      });
      return sendJson(res, 200, { jobId: job.id });
    }

    case '/api/jobs/apply': {
      if (method !== 'POST') break;
      const body = await readJson(req);
      const scanJob = jobs.get(String(body.scanJobId || ''));
      if (!scanJob || scanJob.type !== 'scan' || scanJob.status !== 'done' || !scanJob.result) {
        throw new HttpError(400, '对比结果已失效，请重新对比');
      }
      const peer = store.findPeer(scanJob.peerId);
      if (!peer) throw new HttpError(400, '对端已被移除');

      const job = createJob('apply', {
        peerId: peer.id,
        localFolderId: scanJob.localFolderId,
        remoteFolderId: scanJob.remoteFolderId,
        scanJobId: scanJob.id,
      });
      runJob(job, async () => {
        const results = await applyPlan({
          store,
          peer,
          localFolderId: scanJob.localFolderId,
          remoteFolderId: scanJob.remoteFolderId,
          entries: scanJob.result.entries,
          choices: body.choices || {},
          allowDeletes: !!body.allowDeletes,
          signal: job.controller.signal,
          onEvent: (event) => {
            if (event.type === 'file-start') {
              job.stage = `正在处理 ${event.index}/${event.total}`;
              job.progress = { index: event.index, total: event.total };
            }
            if (event.type === 'transfer') job.progress = { ...job.progress, bytes: event.done };
            emit({ jobId: job.id, ...event });
          },
        });
        await store.appendHistory({
          at: new Date().toISOString(),
          peerId: peer.id,
          peerName: peer.name,
          localName: scanJob.result.folder?.localName || '',
          remoteName: scanJob.result.folder?.remoteName || '',
          ok: results.ok,
          failed: results.failed,
          bytes: results.bytes,
        });
        return results;
      });
      return sendJson(res, 200, { jobId: job.id });
    }

    // 一键同步：对比 + 执行合成一个任务，界面只需点一次
    case '/api/jobs/sync': {
      if (method !== 'POST') break;
      const body = await readJson(req);
      const peer = store.findPeer(String(body.peerId || ''));
      if (!peer) throw new HttpError(400, '请先与对端配对');
      if (peer.kind === 'client') {
        throw new HttpError(400, '这是手机 App 这类客户端：只能由手机发起同步，电脑端不能主动拉它的文件');
      }
      if (!peer.callToken) throw new HttpError(400, '对端令牌缺失，请重新配对');
      const localFolderId = String(body.localFolderId || '');
      const remoteFolderId = String(body.remoteFolderId || '');
      if (!store.findFolder(localFolderId)) throw new HttpError(400, '请选择本机文件夹');
      if (!remoteFolderId) throw new HttpError(400, '请选择对方的文件夹');

      const job = createJob('sync', { peerId: peer.id, localFolderId, remoteFolderId });
      runJob(job, async () => {
        job.stage = '正在对比';
        const { plan, results, applied, conflicts } = await runSyncCycle({
          peer,
          localFolderId,
          remoteFolderId,
          allowDeletes: !!body.allowDeletes,
          conflictPolicy: 'manual',
          signal: job.controller.signal,
          onEvent: (event) => {
            if (event.type === 'stage') job.stage = event.message || event.stage;
            if (event.type === 'scan-progress') job.progress = { index: event.count, total: 0 };
            if (event.type === 'hash-progress') job.progress = { index: event.done, total: event.total };
            if (event.type === 'file-start') {
              job.stage = `正在处理 ${event.index}/${event.total}`;
              job.progress = { index: event.index, total: event.total };
            }
            emit({ jobId: job.id, ...event });
          },
        });
        job.stage = applied ? '完成' : '等你决定冲突';
        // 没执行（有冲突）时把完整计划交给界面，让你挑
        return {
          applied,
          conflicts,
          folder: plan.folder,
          peer: plan.peer,
          summary: plan.summary,
          entries: applied ? undefined : plan.entries,
          planJobId: null,
          apply: results,
        };
      });
      return sendJson(res, 200, { jobId: job.id });
    }

    case '/api/jobs/cancel': {
      if (method !== 'POST') break;
      const body = await readJson(req);
      const job = jobs.get(String(body.jobId || ''));
      if (job && job.status === 'running') job.controller.abort();
      return sendJson(res, 200, { ok: true });
    }

    case '/api/jobs': {
      const id = url.searchParams.get('id');
      if (id) {
        const job = jobs.get(id);
        if (!job) return sendError(res, 404, '任务不存在');
        return sendJson(res, 200, publicJob(job));
      }
      return sendJson(res, 200, { jobs: [...jobs.values()].map(publicJob).slice(-10) });
    }

    case '/api/history':
      return sendJson(res, 200, { history: await store.loadHistory() });

    case '/api/events':
      return openEventStream(req, res);

    default:
      return sendError(res, 404, '接口不存在');
  }
  return sendError(res, 405, '不支持的方法');
}

function redactPeer(peer) {
  if (!peer) return null;
  const { authToken, callToken, ...rest } = peer;
  return { ...rest, canCall: !!callToken };
}

function planPayload(job, plan) {
  return {
    jobId: job.id,
    root: plan.root,
    peer: plan.peer,
    folder: plan.folder,
    entries: plan.entries,
    summary: plan.summary,
    counts: plan.counts,
  };
}

/* ------------------------------------------------------------------ 配对 */

async function handlePair(req, res) {
  const ip = remoteIp(req);
  if (!allowPairAttempt(ip)) return sendError(res, 429, '尝试过于频繁，请稍后再试', 'RATE_LIMIT');
  const body = await readJson(req);
  const code = String(body.code || '').trim();
  if (!code || code !== store.info.pairingCode) {
    return sendError(res, 401, '配对码不正确', 'BAD_CODE');
  }

  const peerId = String(body.id || randomUUID());
  const name = String(body.name || '未命名设备').slice(0, 40);
  const url = String(body.url || '').trim() || peerUrlFrom(req, body.port);
  const theirTokenForUs = typeof body.token === 'string' && body.token ? String(body.token).slice(0, 80) : '';
  // 手机 App 这类"只发起、不提供服务"的客户端会带 kind=client：
  // 它没有自己的共享文件夹，电脑端就不该去枚举它，也不该尝试从它拉文件
  const kind = body.kind === 'client' ? 'client' : 'peer';
  const platform = String(body.platform || '').slice(0, 20);

  // 我们发给对端的令牌（对端用它访问本机）
  const ourTokenForThem = createHash('sha256')
    .update(`${store.info.adminToken}:${peerId}:${Date.now()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 40);

  await store.upsertPeer({
    id: peerId,
    name,
    url,
    kind,
    platform,
    authToken: ourTokenForThem,
    ...(theirTokenForUs ? { callToken: theirTokenForUs } : {}),
    pairedAt: new Date().toISOString(),
  });
  emit({ type: 'peers' });

  return sendJson(res, 200, {
    token: ourTokenForThem,
    id: store.info.id,
    name: store.info.name,
    version: APP_VERSION,
  });
}

/* --------------------------------------------------------- 文件收发接口 */

async function handleDownload(req, res, url) {
  const folder = resolveFolder(url.searchParams.get('folderId'));
  const rel = normalizeRel(url.searchParams.get('path'));
  if (!rel) return sendError(res, 400, '路径非法');
  const abs = resolveInside(folder.path, rel);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isFile()) return sendError(res, 404, '文件不存在');

  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': st.size,
    'X-File-Mtime': String(Math.round(st.mtimeMs)),
    'Cache-Control': 'no-store',
  });
  await pipeline(createReadStream(abs), res);
}

async function handleUpload(req, res, url) {
  const folder = resolveFolder(url.searchParams.get('folderId'));
  const root = folder.path;
  const rel = normalizeRel(url.searchParams.get('path'));
  if (!rel) return sendError(res, 400, '路径非法');
  const abs = resolveInside(root, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });

  const tmp = `${abs}.part-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  const hash = createHash('sha256');
  const meter = new Transform({
    transform(chunk, _enc, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(req, meter, createWriteStream(tmp));
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    return sendError(res, 400, `接收失败：${err.message}`);
  }

  const digest = hash.digest('hex');
  const expected = (req.headers['x-file-sha256'] || '').toString();
  if (expected && expected !== digest) {
    await fsp.rm(tmp, { force: true });
    return sendError(res, 400, '校验失败：内容与发送方声明不一致', 'HASH_MISMATCH');
  }

  const mtime = Number(req.headers['x-file-mtime'] || 0);
  if (mtime > 0) {
    try {
      const when = new Date(mtime);
      await fsp.utimes(tmp, when, when);
    } catch {
      // 某些文件系统不支持，忽略
    }
  }

  await fsp.rename(tmp, abs);
  const st = await fsp.stat(abs);
  return sendJson(res, 200, {
    ok: true,
    sha256: digest,
    size: st.size,
    mtimeMs: st.mtimeMs,
    sig: `${st.size}:${Math.round(st.mtimeMs)}`,
  });
}

/* ------------------------------------------------------------ 信息与浏览 */

async function folderListWithState() {
  const folders = store.listFolders();
  const out = [];
  for (const folder of folders) {
    const st = await fsp.stat(folder.path).catch(() => null);
    out.push({ ...publicFolder(folder), exists: !!st?.isDirectory(), addedAt: folder.addedAt });
  }
  return out;
}

async function buildInfo() {
  const peers = await store.listPeers();
  return {
    app: 'commsync',
    version: APP_VERSION,
    title: APP_TITLE,
    id: store.info.id,
    name: store.info.name,
    port: serverPort,
    folders: await folderListWithState(),
    maxFolders: MAX_FOLDERS,
    autoSync: buildAutoSyncInfo(),
    pairingCode: store.info.pairingCode,
    lanIps: lanAddresses().map((item) => `http://${item.address}:${serverPort}`),
    discoveryEnabled: !DISCOVERY_OFF,
    peers: peers.map((peer) => {
      const publicPeer = redactPeer(peer);
      const discovered = discovery ? discovery.list().find((item) => item.id === peer.id) : null;
      return { ...publicPeer, online: !!discovered, currentUrl: discovered ? discovered.url : peer.url };
    }),
  };
}

function buildAutoSyncInfo() {
  return {
    intervalSec: store.info.autoSync?.intervalSec || 120,
    items: store.listAutoSync().map((item) => ({ ...item, running: autoRunning.has(item.key) })),
  };
}

async function browseFolder(rawPath) {
  const platform = process.platform;
  const drives = [];
  if (platform === 'win32') {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZAB') {
      const candidate = `${letter}:\\`;
      const ok = await fsp
        .access(candidate)
        .then(() => true)
        .catch(() => false);
      if (ok) drives.push(candidate);
    }
  } else {
    drives.push('/');
  }

  let current = String(rawPath || '').trim();
  if (!current) {
    return { path: '', parent: null, dirs: [], drives, platform };
  }

  current = path.resolve(current);
  const st = await fsp.stat(current).catch(() => null);
  if (!st || !st.isDirectory()) {
    return { path: '', parent: null, dirs: [], drives, platform, error: '目录不可用' };
  }

  let entries = [];
  try {
    entries = await fsp.readdir(current, { withFileTypes: true });
  } catch {
    entries = [];
  }

  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => ({ name: entry.name, path: path.join(current, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));

  const parent = path.dirname(current);
  return {
    path: current,
    parent: parent === current ? null : parent,
    dirs,
    drives,
    platform,
  };
}

function openEventStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

/* ---------------------------------------------------------------- 静态页 */

async function handleStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let baseDir = PUBLIC_DIR;

  if (rel.startsWith('shared/')) {
    baseDir = SHARED_DIR;
    rel = rel.slice('shared/'.length);
  }
  if (rel === 'lite') rel = 'lite.html';

  const safeRel = rel.split('/').filter((part) => part && part !== '..' && part !== '.').join('/');
  if (!safeRel) return sendError(res, 404, '页面不存在');

  const abs = path.join(baseDir, safeRel);
  if (!abs.startsWith(baseDir)) return sendError(res, 403, '拒绝访问');

  let buffer;
  try {
    buffer = await fsp.readFile(abs);
  } catch {
    return sendError(res, 404, '页面不存在');
  }

  const ext = path.extname(abs).toLowerCase();
  if (ext === '.html') {
    const boot = {
      version: APP_VERSION,
      token: isLoopback(req) ? store.info.adminToken : null,
      loopback: isLoopback(req),
    };
    buffer = Buffer.from(
      buffer
        .toString('utf8')
        .replace('<!--__BOOT__-->', `<script>window.__BOOT__=${JSON.stringify(boot)};</script>`),
    );
  }

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
  });
  res.end(buffer);
}

/* ------------------------------------------------------------------ 启动 */

function openBrowser(url) {
  if (NO_BROWSER) return;
  import('node:child_process')
    .then(({ exec }) => {
      const command =
        process.platform === 'win32'
          ? `cmd /c start "" "${url}"`
          : process.platform === 'darwin'
            ? `open "${url}"`
            : `xdg-open "${url}"`;
      exec(command, { windowsHide: true }, () => {});
    })
    .catch(() => {});
}

/**
 * 同一个数据目录只应该跑一个实例。
 *
 * 之前的毛病：上一个终端没关，再双击启动就会在 47801/47802… 再起一个，
 * 端口"只加不降"，手机里存的地址也跟着失效。现在启动前先探一圈，
 * 发现"同一个数据目录"的实例已经在跑，就直接用它、打开浏览器，不再起第二个。
 */
async function findRunningInstance(preferredPorts) {
  const seen = new Set();
  for (const start of preferredPorts) {
    if (!Number.isFinite(start)) continue;
    for (let port = start; port < start + 20; port += 1) {
      if (seen.has(port)) continue;
      seen.add(port);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/peer/greet`, { signal: AbortSignal.timeout(600) });
        if (!res.ok) continue;
        const data = await res.json().catch(() => null);
        if (data?.app !== 'commsync') continue;
        // id 由数据目录里的配置决定：只有"同一个数据目录"才算重复实例
        if (data.id !== store.info.id) continue;
        return { port, url: `http://127.0.0.1:${port}` };
      } catch {
        // 这个端口没有服务，继续找
      }
    }
  }
  return null;
}

async function main() {
  await store.init();

  const preferred = Number(process.env.LAN_SYNC_PORT || store.info.port || DEFAULT_PORT);

  const running = await findRunningInstance([preferred, DEFAULT_PORT]);
  if (running) {
    console.log(`${APP_TITLE} v${APP_VERSION} 已经在运行`);
    console.log(`  地址 : ${running.url}`);
    console.log('  说明 : 同一个数据目录只会跑一个实例，不用重复启动；这个终端可以直接关掉。');
    openBrowser(running.url);
    return;
  }

  serverPort = await probePort(preferred);
  if (store.info.port !== serverPort) await store.saveConfig({ port: serverPort });

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (!res.headersSent) sendError(res, 500, err?.message || '服务器内部错误');
      else res.end();
    });
  });

  server.on('error', (err) => {
    console.error(`启动失败：${err.message}`);
    process.exit(1);
  });

  await new Promise((resolve) => server.listen(serverPort, '0.0.0.0', resolve));

  if (!DISCOVERY_OFF) {
    discovery = new Discovery({
      id: store.info.id,
      name: store.info.name,
      port: serverPort,
      onPeer: (peer) => emit({ type: 'discovered', peer }),
      onError: (err) => console.warn(`自动发现不可用（不影响手动连接）：${err.message}`),
    });
    discovery.start();
  }

  const ips = lanAddresses();
  const folders = store.listFolders();
  console.log('');
  console.log(`  ${APP_TITLE}  v${APP_VERSION}`);
  console.log(`  本机名称 : ${store.info.name}`);
  console.log(`  本机地址 : http://127.0.0.1:${serverPort}`);
  for (const item of ips) console.log(`  局域网   : http://${item.address}:${serverPort}  (${item.iface})`);
  console.log(`  配对码   : ${store.info.pairingCode}`);
  if (serverPort !== preferred && !process.env.LAN_SYNC_PORT) {
    console.log(`  提示     : ${preferred} 被占用（可能上一个终端还没关），改用 ${serverPort}；`);
    console.log(`             关掉占用它的程序后会回到 ${preferred}，手机里的地址也要跟着改。`);
  }
  if (folders.length) {
    console.log(`  共享文件夹 (${folders.length})：`);
    for (const folder of folders) console.log(`     - ${folder.name} : ${folder.path}`);
  } else {
    console.log('  共享文件夹 : （尚未添加，界面里点「添加」）');
  }
  const autoItems = store.listAutoSync().filter((item) => item.enabled);
  if (autoItems.length) {
    console.log(`  自动同步 : ${autoItems.length} 个同步项已开启（每 ${autoItems[0].intervalSec} 秒起）`);
  }
  console.log('');

  // 自动同步调度：每 5 秒检查一次，到点且没有别的任务在跑才启动
  autoTimer = setInterval(() => {
    autoSyncTick().catch((err) => console.warn(`自动同步检查失败：${err.message}`));
  }, 5000);
  autoTimer.unref();

  openBrowser(`http://127.0.0.1:${serverPort}/`);

  const shutdown = () => {
    discovery?.stop();
    clearInterval(heartbeat);
    if (autoTimer) clearInterval(autoTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(`无法启动：${err.stack || err.message}`);
  process.exit(1);
});
