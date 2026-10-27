/**
 * 同步引擎
 * ------------------------------------------------------------------
 * 一个同步项 = (本机文件夹, 对端, 对端文件夹)。
 * scanPlan：本地清单 + 远端清单 + 该同步项的基线 → 差异计划（按需补哈希，避免全量读盘）
 * applyPlan：按计划执行上传/下载/删除，逐项回写基线
 *
 * 基线记录每个路径"上次同步完成时"的内容哈希与两端签名。
 * 有了它才能区分"对方删了文件"和"我这边新增了文件"——没有基线就只能猜。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  KIND,
  applyChoices,
  applyNewestPolicy,
  expandOperations,
  pendingHashes,
  quickPlan,
  resolvePlan,
  summarize,
} from '../shared/diff.js';
import { hashFile, hashMany, walkFolder } from './manifest.js';
import { deleteOnPeer, fetchPeerHashes, fetchPeerManifest, jsonRequest } from './peer-api.js';
import { deleteLocalFile, downloadFromPeer, uploadToPeer } from './transfer.js';
import { resolveInside } from './safe-path.js';

export class CancelledError extends Error {
  constructor() {
    super('任务已取消');
    this.name = 'CancelledError';
  }
}

function assertNotCancelled(signal) {
  if (signal?.aborted) throw new CancelledError();
}

function baselineCache(baselineFiles) {
  const cache = {};
  for (const [rel, item] of Object.entries(baselineFiles || {})) {
    if (!item) continue;
    cache[rel] = { sig: item.localSig ?? item.sig ?? null, hash: item.hash ?? null };
  }
  return cache;
}

/** 解析同步项：本机文件夹必须存在，对端文件夹 id 必须给 */
export function resolveSyncItem(store, peer, localFolderId, remoteFolderId) {
  const localFolder = store.findFolder(localFolderId);
  if (!localFolder) throw new Error('请选择本机的同步文件夹');
  if (!remoteFolderId) throw new Error('请选择对方的同步文件夹');
  return {
    localFolder,
    remoteFolderId,
    root: localFolder.path,
    baselineKey: store.baselineKey(peer.id, localFolder.id, remoteFolderId),
  };
}

async function assertLocalFolder(root) {
  try {
    const st = await fsp.stat(root);
    if (!st.isDirectory()) throw new Error('不是文件夹');
  } catch (err) {
    throw new Error(`本地文件夹不可用：${root}（${err.code || err.message}）`);
  }
}

/**
 * 扫描并对齐两端清单，产出计划。
 */
export async function scanPlan({ store, peer, localFolderId, remoteFolderId, signal, onEvent = () => {}, conflictPolicy }) {
  const item = resolveSyncItem(store, peer, localFolderId, remoteFolderId);
  const { root } = item;
  await assertLocalFolder(root);

  assertNotCancelled(signal);
  onEvent({ type: 'stage', stage: 'local-manifest', message: '正在读取本地文件列表' });
  const localFiles = await walkFolder(root, {
    onProgress: ({ scanned }) => onEvent({ type: 'scan-progress', side: 'local', count: scanned }),
  });

  assertNotCancelled(signal);
  onEvent({ type: 'stage', stage: 'remote-manifest', message: '正在读取对端文件列表' });
  const remote = await fetchPeerManifest(peer.url, peer.callToken, remoteFolderId);
  if (remote?.error) throw new Error(`对端不可用：${remote.error}`);
  if (!remote?.root) throw new Error('对端还没有共享这个文件夹');
  const remoteFiles = remote.files || {};

  assertNotCancelled(signal);
  const baseline = await store.loadBaseline(item.baselineKey, root);
  const quick = quickPlan({ local: localFiles, remote: remoteFiles, baseline: baseline.files || {} });

  const need = pendingHashes(quick);
  const cache = baselineCache(baseline.files);

  let localHashes = {};
  if (need.local.length) {
    onEvent({
      type: 'stage',
      stage: 'hash-local',
      message: `正在校验 ${need.local.length} 个本地文件`,
      total: need.local.length,
    });
    localHashes = await hashMany(root, need.local, {
      cache,
      onProgress: ({ hashed, total }) => onEvent({ type: 'hash-progress', side: 'local', done: hashed, total }),
    });
  }

  assertNotCancelled(signal);
  let remoteHashes = {};
  if (need.remote.length) {
    onEvent({ type: 'stage', stage: 'hash-remote', message: `正在校验 ${need.remote.length} 个远端文件` });
    const payload = await fetchPeerHashes(peer.url, peer.callToken, remoteFolderId, need.remote);
    remoteHashes = payload?.hashes || {};
  }

  const resolved = resolvePlan(quick, { local: localHashes, remote: remoteHashes });
  // 手动对比一律"不替你决定"；只有自动同步才传 newest 走按时间裁决
  const policy = conflictPolicy === 'newest' ? 'newest' : 'manual';
  const entries = policy === 'newest' ? applyNewestPolicy(resolved) : resolved;
  const summary = summarize(entries);

  return {
    root,
    peer: { id: peer.id, name: peer.name, url: peer.url },
    folder: {
      localFolderId: item.localFolder.id,
      localName: item.localFolder.name,
      remoteFolderId,
      remoteName: remote.folder?.name || '',
      remoteRoot: remote.root,
    },
    entries,
    summary,
    counts: { local: Object.keys(localFiles).length, remote: Object.keys(remoteFiles).length },
  };
}

/**
 * 执行计划。choices 形如 { 'a.txt': 'keep-local' | 'keep-remote' | 'keep-both' | 'skip' }。
 */
export async function applyPlan({
  store,
  peer,
  localFolderId,
  remoteFolderId,
  entries,
  choices = {},
  allowDeletes = false,
  signal,
  onEvent = () => {},
}) {
  const item = resolveSyncItem(store, peer, localFolderId, remoteFolderId);
  const { root } = item;
  const decided = applyChoices(entries, choices);
  const now = new Date();

  const operations = [];
  for (const entry of decided) {
    for (const op of expandOperations(entry, { allowDeletes, now })) operations.push(op);
  }

  const baseline = await store.loadBaseline(item.baselineKey, root);
  const files = { ...(baseline.files || {}) };
  const results = { ok: 0, failed: 0, bytes: 0, skipped: 0, errors: [] };

  const recordBase = (rel, payload) => {
    if (!rel) return;
    files[rel] = { ...payload, updatedAt: new Date().toISOString() };
  };
  const dropBase = (rel) => {
    delete files[rel];
  };

  // 没有产生操作项的条目也要维护基线：一致的文件刷新签名，双方都删掉的清掉记录
  const touched = new Set(operations.map((op) => op.from || op.path));
  for (const entry of decided) {
    if (touched.has(entry.path)) continue;
    if (entry.kind === KIND.BOTH_DELETED) {
      dropBase(entry.path);
      continue;
    }
    if (entry.kind === KIND.SAME && (entry.localHash || entry.remoteHash)) {
      const previous = (baseline.files || {})[entry.path];
      recordBase(entry.path, {
        hash: entry.localHash || entry.remoteHash,
        remoteHash: entry.remoteHash || entry.localHash,
        localSig: entry.local?.sig ?? null,
        remoteSig: entry.remote?.sig ?? null,
        size: entry.local?.size ?? entry.remote?.size ?? 0,
        ...(previous?.diverged ? { diverged: true } : {}),
      });
    }
  }

  let index = 0;
  for (const op of operations) {
    assertNotCancelled(signal);
    index += 1;
    const entry = op.entry;
    const label = op.from || op.path;
    onEvent({ type: 'file-start', index, total: operations.length, op: op.op, path: label, to: op.to || label });

    try {
      switch (op.op) {
        case 'upload': {
          const abs = resolveInside(root, op.from);
          const localHash = op.from === entry.path && entry.localHash ? entry.localHash : await hashFile(abs);
          const st = await fsp.stat(abs);
          const result = await uploadToPeer({
            baseUrl: peer.url,
            token: peer.callToken,
            rel: op.to,
            abs,
            sha256: localHash,
            size: st.size,
            mtimeMs: st.mtimeMs,
            folderId: remoteFolderId,
            onProgress: (done, total) =>
              onEvent({ type: 'transfer', index, total: operations.length, path: label, done, bytes: total }),
          });
          recordBase(op.to, {
            hash: result.sha256 || localHash,
            remoteHash: result.sha256 || localHash,
            localSig: `${st.size}:${Math.round(st.mtimeMs)}`,
            remoteSig: result.sig || null,
            size: result.size ?? st.size,
          });
          results.bytes += result.size ?? st.size;
          break;
        }
        case 'download': {
          const destAbs = resolveInside(root, op.to);
          let remoteHash = op.from === entry.path ? entry.remoteHash : null;
          if (!remoteHash) {
            const payload = await fetchPeerHashes(peer.url, peer.callToken, remoteFolderId, [op.from]);
            remoteHash = payload?.hashes?.[op.from] || null;
          }
          const result = await downloadFromPeer({
            baseUrl: peer.url,
            token: peer.callToken,
            rel: op.from,
            destAbs,
            expectedSha256: remoteHash,
            folderId: remoteFolderId,
            onProgress: (done, total) =>
              onEvent({ type: 'transfer', index, total: operations.length, path: label, done, bytes: total }),
          });
          recordBase(op.to, {
            hash: result.sha256,
            remoteHash: remoteHash || result.sha256,
            localSig: result.sig,
            remoteSig: entry.remote?.sig ?? result.sig,
            size: result.size,
          });
          results.bytes += result.size;
          break;
        }
        case 'copy-remote': {
          const result = await copyOnPeer(peer, remoteFolderId, op.from, op.to);
          if (!result?.ok) throw new Error(result?.error || '远端复制失败');
          onEvent({ type: 'log', message: `已在远端另存：${op.to}` });
          break;
        }
        case 'copy-local': {
          // 远端较新、本地那版要保命时用：先在本地把原名复制成副本，再让远端覆盖原名
          const fromAbs = resolveInside(root, op.from);
          const toAbs = resolveInside(root, op.to);
          await fsp.mkdir(path.dirname(toAbs), { recursive: true });
          await fsp.copyFile(fromAbs, toAbs);
          const st = await fsp.stat(fromAbs);
          try {
            await fsp.utimes(toAbs, st.atime, st.mtime);
          } catch {
            // 时间设置失败不影响内容
          }
          onEvent({ type: 'log', message: `已在本地另存：${op.to}` });
          break;
        }
        case 'delete-local': {
          const abs = resolveInside(root, op.path);
          await deleteLocalFile(root, abs);
          dropBase(op.path);
          onEvent({ type: 'log', message: `已删除本地：${op.path}` });
          break;
        }
        case 'delete-remote': {
          const result = await deleteOnPeer(peer.url, peer.callToken, remoteFolderId, [op.path]);
          if (result?.failed?.length) throw new Error(result.failed[0]?.error || '远端删除失败');
          dropBase(op.path);
          onEvent({ type: 'log', message: `已删除远端：${op.path}` });
          break;
        }
        default:
          throw new Error(`未知操作 ${op.op}`);
      }
      results.ok += 1;
      onEvent({ type: 'file-done', index, total: operations.length, path: label, to: op.to || label, ok: true });
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      results.failed += 1;
      const message = err.message || String(err);
      results.errors.push({ path: label, message });
      onEvent({ type: 'file-done', index, total: operations.length, path: label, to: op.to || label, ok: false, error: message });
    }
  }

  await store.saveBaseline(item.baselineKey, root, files);
  onEvent({ type: 'done', ...results });
  return results;
}

/** 让对端把一个文件复制成另一个名字（"都留"时保留对方旧版本，避免来回传字节） */
async function copyOnPeer(peer, folderId, from, to) {
  return jsonRequest(peer.url, '/api/peer/copy', {
    token: peer.callToken,
    method: 'POST',
    body: { folderId, from, to },
  });
}
