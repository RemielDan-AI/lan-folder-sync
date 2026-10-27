/**
 * 手机端"对端服务"的协议验证。
 *
 * 背景：手机 App 里的 PeerServer 无法在这台机器上运行（没有设备/模拟器），
 * 但它的协议契约必须正确，否则电脑端永远读不到手机的文件夹。
 *
 * 做法：用 Node 严格按 PeerServer 的路由与语义实现一个替身，然后让**真实的电脑端**
 * 去连它：列文件夹 → 扫描 → 上传 → 下载。协议对不对，在这里就能证明。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sha256 = (file) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });

const sigOf = (stat) => `${stat.size}:${Math.round(stat.mtimeMs)}`;

/** 与 PeerServer.kt 一一对应的替身服务 */
function createPhoneMock(rootDir, token, deviceId, deviceName) {
  const json = (res, status, body) => {
    const payload = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length });
    res.end(payload);
  };

  const walk = async () => {
    const out = {};
    async function visit(dir, prefix) {
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(abs, rel);
        else if (entry.isFile()) {
          const stat = await fsp.stat(abs);
          out[rel] = { size: stat.size, mtimeMs: stat.mtimeMs, sig: sigOf(stat) };
        }
      }
    }
    await visit(rootDir, '');
    return out;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://phone');
    const pathname = url.pathname;

    if (pathname === '/api/peer/greet') {
      return json(res, 200, { app: 'commsync', version: 'android', id: deviceId, name: deviceName, port: 0, folderCount: 1 });
    }
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${token}`) return json(res, 401, { error: '需要配对令牌' });

    try {
      if (pathname === '/api/peer/folders') {
        return json(res, 200, { name: deviceName, folders: [{ id: 'local', name: '手机相册', path: '手机/手机相册' }] });
      }
      if (pathname === '/api/peer/manifest') {
        const files = await walk();
        return json(res, 200, {
          root: '手机/手机相册',
          folder: { id: 'local', name: '手机相册' },
          count: Object.keys(files).length,
          files,
        });
      }
      if (pathname === '/api/peer/hashes') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const hashes = {};
        for (const rel of body.paths || []) {
          const abs = path.join(rootDir, rel);
          const ok = await fsp.access(abs).then(() => true).catch(() => false);
          hashes[rel] = ok ? await sha256(abs) : null;
        }
        return json(res, 200, { hashes });
      }
      if (pathname === '/api/peer/file' && req.method === 'GET') {
        const rel = url.searchParams.get('path') || '';
        const abs = path.join(rootDir, rel);
        const stat = await fsp.stat(abs).catch(() => null);
        if (!stat) return json(res, 404, { error: `文件不存在：${rel}` });
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': stat.size,
          'X-File-Mtime': String(Math.round(stat.mtimeMs)),
        });
        createReadStream(abs).pipe(res);
        return undefined;
      }
      if (pathname === '/api/peer/file' && req.method === 'PUT') {
        const rel = url.searchParams.get('path') || '';
        const abs = path.join(rootDir, rel);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        const hash = createHash('sha256');
        await new Promise((resolve, reject) => {
          req.on('data', (chunk) => hash.update(chunk));
          req.pipe(createWriteStream(abs)).on('finish', resolve).on('error', reject);
        });
        const actual = hash.digest('hex');
        const expected = req.headers['x-file-sha256'] || '';
        if (expected && expected !== actual) {
          await fsp.rm(abs, { force: true });
          return json(res, 400, { error: '校验失败：内容与发送方声明不一致' });
        }
        const stat = await fsp.stat(abs);
        return json(res, 200, { ok: true, sha256: actual, size: stat.size, mtimeMs: stat.mtimeMs, sig: sigOf(stat) });
      }
      if (pathname === '/api/peer/delete') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const deleted = [];
        for (const rel of body.paths || []) {
          await fsp.rm(path.join(rootDir, rel), { force: true });
          deleted.push(rel);
        }
        return json(res, 200, { deleted, missing: [], failed: [] });
      }
      if (pathname === '/api/peer/copy') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const from = path.join(rootDir, body.from);
        const to = path.join(rootDir, body.to);
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.copyFile(from, to);
        const stat = await fsp.stat(from);
        await fsp.utimes(to, stat.atime, stat.mtime);
        return json(res, 200, { ok: true, sig: sigOf(stat), size: stat.size });
      }
      return json(res, 404, { error: `接口不存在：${pathname}` });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function startDesktop(dataDir, folder, port) {
  const child = spawn(NODE, [path.join(APP_ROOT, 'server.js')], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      LAN_SYNC_PORT: String(port),
      LAN_SYNC_DATA: dataDir,
      LAN_SYNC_NO_BROWSER: '1',
      LAN_SYNC_DISCOVERY: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));

  const configPath = path.join(dataDir, 'config.json');
  let config = null;
  let base = '';
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      config = JSON.parse(await fsp.readFile(configPath, 'utf8'));
      base = `http://127.0.0.1:${config.port}`;
      const ping = await fetch(`${base}/api/ping`).then((res) => res.json());
      if (ping?.ok) break;
    } catch {
      base = '';
    }
    await sleep(100);
  }
  if (!base) throw new Error(`电脑端启动失败：\n${output}`);
  return { child, base, config };
}

async function api(base, pathname, { method = 'GET', token, body } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${pathname} ${res.status} ${json?.error || text.slice(0, 200)}`);
  return json;
}

test('电脑端可以主动读取手机（对端服务）的文件夹', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'phone-peer-'));
  const phoneDir = path.join(root, 'phone');
  const desktopDir = path.join(root, 'desktop');
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(phoneDir, { recursive: true });
  await fsp.mkdir(desktopDir, { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });

  // 手机端已有文件（这正是"电脑端看不到"的那些）
  await fsp.mkdir(path.join(phoneDir, '照片'), { recursive: true });
  await fsp.writeFile(path.join(phoneDir, '手机拍的.txt'), '来自手机的内容\n');
  await fsp.writeFile(path.join(phoneDir, '照片', '截图.txt'), '子目录里的文件\n');
  // 电脑端已有一个文件
  await fsp.writeFile(path.join(desktopDir, '电脑这边.txt'), '来自电脑的内容\n');

  const phoneToken = 'phone-token-for-desktop';
  const mock = await createPhoneMock(phoneDir, phoneToken, 'phone-mock', '小米手机');

  // 预先写一条"已和手机配对"的记录：手机把自己的端口和令牌交给了电脑
  await fsp.writeFile(
    path.join(dataDir, 'peers.json'),
    `${JSON.stringify([
      {
        id: 'phone-mock',
        name: '小米手机',
        url: `http://127.0.0.1:${mock.port}`,
        kind: 'peer',
        platform: 'android',
        authToken: 'unused',
        callToken: phoneToken,
        pairedAt: new Date().toISOString(),
      },
    ], null, 2)}\n`,
  );

  const desktop = await startDesktop(dataDir, desktopDir, 47890);
  const token = desktop.config.adminToken;
  const cleanup = async () => {
    desktop.child.kill();
    mock.server.close();
    await sleep(250);
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  };

  try {
    const folder = (await api(desktop.base, '/api/folders', { method: 'POST', token, body: { path: desktopDir } })).folder;

    await t.test('电脑端能看到手机共享的文件夹', async () => {
      const list = await api(desktop.base, '/api/peer-folders', { method: 'POST', token, body: { peerId: 'phone-mock' } });
      assert.equal(list.clientOnly ?? false, false, '手机现在提供服务，不应再被当成纯客户端');
      assert.equal(list.folders.length, 1);
      assert.equal(list.folders[0].id, 'local');
      assert.equal(list.folders[0].name, '手机相册');
    });

    let plan = null;
    await t.test('电脑端扫描手机目录：能看到手机上的文件', async () => {
      const { jobId } = await api(desktop.base, '/api/jobs/scan', {
        method: 'POST',
        token,
        body: { peerId: 'phone-mock', localFolderId: folder.id, remoteFolderId: 'local' },
      });
      let job = null;
      for (let i = 0; i < 100; i += 1) {
        job = await api(desktop.base, `/api/jobs?id=${jobId}`, { token });
        if (job.status !== 'running') break;
        await sleep(100);
      }
      assert.equal(job.status, 'done', job.error);
      plan = job.result;
      const byPath = Object.fromEntries(plan.entries.map((entry) => [entry.path, entry]));
      assert.equal(byPath['手机拍的.txt'].kind, 'new-remote', '手机上的文件应显示为"远端新增"');
      assert.equal(byPath['照片/截图.txt'].kind, 'new-remote');
      assert.equal(byPath['电脑这边.txt'].kind, 'new-local');
    });

    await t.test('电脑端一键拉取手机文件并回传自己的文件', async () => {
      const { jobId } = await api(desktop.base, '/api/jobs/apply', {
        method: 'POST',
        token,
        body: { scanJobId: plan.jobId },
      });
      let job = null;
      for (let i = 0; i < 100; i += 1) {
        job = await api(desktop.base, `/api/jobs?id=${jobId}`, { token });
        if (job.status !== 'running') break;
        await sleep(100);
      }
      assert.equal(job.status, 'done', job.error);
      assert.equal(job.result.failed, 0, JSON.stringify(job.result.errors));

      // 手机的文件被拉到电脑
      assert.equal(await fsp.readFile(path.join(desktopDir, '手机拍的.txt'), 'utf8'), '来自手机的内容\n');
      assert.equal(await fsp.readFile(path.join(desktopDir, '照片', '截图.txt'), 'utf8'), '子目录里的文件\n');
      // 电脑的文件被推到手机
      assert.equal(await fsp.readFile(path.join(phoneDir, '电脑这边.txt'), 'utf8'), '来自电脑的内容\n');
    });

    await t.test('再扫一次两端已一致', async () => {
      const { jobId } = await api(desktop.base, '/api/jobs/scan', {
        method: 'POST',
        token,
        body: { peerId: 'phone-mock', localFolderId: folder.id, remoteFolderId: 'local' },
      });
      let job = null;
      for (let i = 0; i < 100; i += 1) {
        job = await api(desktop.base, `/api/jobs?id=${jobId}`, { token });
        if (job.status !== 'running') break;
        await sleep(100);
      }
      assert.equal(job.result.summary.upload, 0);
      assert.equal(job.result.summary.download, 0);
      assert.equal(job.result.summary.conflicts, 0);
    });

    // 上一步之后再往手机放一个文件：验证"自由下载"不会顺手把它同步进本机
    await fsp.writeFile(path.join(phoneDir, '仅远端.txt'), '只在手机上有\n');
    await t.test('浏览远端文件清单（只读）', async () => {
      const query = new URLSearchParams({ peerId: 'phone-mock', folderId: 'local' });
      const data = await api(desktop.base, `/api/peer-listing?${query}`, { token });
      const paths = data.files.map((file) => file.path).sort();
      // 电脑这边.txt 是上一步推过去的，所以手机侧也有
      assert.deepEqual(paths, ['电脑这边.txt', '手机拍的.txt', '照片/截图.txt', '仅远端.txt'].sort());
      assert.equal(data.files.find((file) => file.path === '手机拍的.txt').size, Buffer.byteLength('来自手机的内容\n'));
    });

    await t.test('自由下载单个远端文件，且不写进本机同步文件夹', async () => {
      const query = new URLSearchParams({ peerId: 'phone-mock', folderId: 'local', path: '仅远端.txt', token });
      const res = await fetch(`${desktop.base}/api/peer/download?${query}`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-disposition') || '', /attachment/);
      assert.equal(await res.text(), '只在手机上有\n');
      const landed = await fsp.access(path.join(desktopDir, '仅远端.txt')).then(() => true).catch(() => false);
      assert.equal(landed, false, '自由下载不能落到同步文件夹里');
    });

    await t.test('打包下载远端整个文件夹，标准工具能解开', async () => {
      const query = new URLSearchParams({ peerId: 'phone-mock', folderId: 'local', token });
      const res = await fetch(`${desktop.base}/api/peer/download-zip?${query}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/zip');
      const buffer = Buffer.from(await res.arrayBuffer());
      assert.ok(buffer.length > 200, 'zip 太小');

      const zipPath = path.join(root, 'peer.zip');
      const outDir = path.join(root, 'unzipped');
      await fsp.writeFile(zipPath, buffer);
      await fsp.mkdir(outDir, { recursive: true });
      const ok = await new Promise((resolve) => {
        const child = spawn(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command',
            `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`],
          { stdio: 'ignore' },
        );
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
      });
      if (!ok) {
        t.diagnostic('系统没有 Expand-Archive，跳过解压校验');
        return;
      }
      assert.equal(await fsp.readFile(path.join(outDir, '手机拍的.txt'), 'utf8'), '来自手机的内容\n');
      assert.equal(await fsp.readFile(path.join(outDir, '照片', '截图.txt'), 'utf8'), '子目录里的文件\n');
      assert.equal(await fsp.readFile(path.join(outDir, '仅远端.txt'), 'utf8'), '只在手机上有\n');
    });
  } finally {
    await cleanup();
  }
});
