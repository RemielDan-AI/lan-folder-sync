/**
 * 端到端：起两个真实实例，走完整链路
 *   配对 → 对比 → 执行 → 冲突 → 反向 → 多文件夹隔离 → 压缩包上传
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { zipStream } from '../lib/zip.js';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    const error = new Error(`${method} ${pathname} → ${res.status} ${json?.error || text.slice(0, 200)}`);
    error.status = res.status;
    throw error;
  }
  return json;
}

async function exists(target) {
  return fsp
    .access(target)
    .then(() => true)
    .catch(() => false);
}

async function startNode(label, port) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `lan-sync-${label}-`));
  const dataDir = path.join(root, 'data');
  const folder = path.join(root, 'files');
  const folder2 = path.join(root, 'files2');
  await fsp.mkdir(folder, { recursive: true });
  await fsp.mkdir(folder2, { recursive: true });

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
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  const configPath = path.join(dataDir, 'config.json');
  let config = null;
  let base = '';
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      config = JSON.parse(await fsp.readFile(configPath, 'utf8'));
      base = `http://127.0.0.1:${config.port}`;
      const ping = await api(base, '/api/ping');
      if (ping?.ok) break;
    } catch {
      base = '';
    }
    await sleep(100);
  }
  assert.ok(base, `节点 ${label} 未能启动：\n${output}`);
  assert.ok(config?.adminToken, `节点 ${label} 配置缺失：\n${output}`);

  return {
    label,
    child,
    root,
    folder,
    folder2,
    dataDir,
    base,
    token: config.adminToken,
    code: config.pairingCode,
    output: () => output,
  };
}

async function waitJob(node, jobId, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await api(node.base, `/api/jobs?id=${jobId}`, { token: node.token });
    if (job.status !== 'running') return job;
    await sleep(100);
  }
  throw new Error(`任务 ${jobId} 超时`);
}

async function addFolder(node, absPath) {
  const result = await api(node.base, '/api/folders', { method: 'POST', token: node.token, body: { path: absPath } });
  return result.folder;
}

async function scan(node, peerId, localFolderId, remoteFolderId) {
  const { jobId } = await api(node.base, '/api/jobs/scan', {
    method: 'POST',
    token: node.token,
    body: { peerId, localFolderId, remoteFolderId },
  });
  const job = await waitJob(node, jobId);
  assert.equal(job.status, 'done', `扫描失败：${job.error}\n${node.output()}`);
  return job.result;
}

async function apply(node, scanJobId, extra = {}) {
  const { jobId } = await api(node.base, '/api/jobs/apply', {
    method: 'POST',
    token: node.token,
    body: { scanJobId, ...extra },
  });
  const job = await waitJob(node, jobId);
  assert.equal(job.status, 'done', `执行失败：${job.error}\n${node.output()}`);
  return job.result;
}

const entryOf = (plan, rel) => plan.entries.find((entry) => entry.path === rel);

/** 本机持有一枚"调用对端时该用的令牌"，存在 peers.json 的 callToken 里 */
async function peerTokenOf(node) {
  const peers = JSON.parse(await fsp.readFile(path.join(node.dataDir, 'peers.json'), 'utf8'));
  return peers[0]?.callToken || '';
}

test('局域网同步端到端', async (t) => {
  const A = await startNode('alpha', 47860);
  const B = await startNode('beta', 47861);
  let peerOnA = null;
  let aMain = null;
  let bMain = null;
  let aDocs = null;
  let bDocs = null;

  t.after(async () => {
    for (const node of [A, B]) {
      try {
        node.child.kill();
      } catch {
        // 已经退出
      }
    }
    await sleep(250);
    for (const node of [A, B]) await fsp.rm(node.root, { recursive: true, force: true }).catch(() => {});
  });

  await api(A.base, '/api/name', { method: 'POST', token: A.token, body: { name: '设计部 A' } });
  await api(B.base, '/api/name', { method: 'POST', token: B.token, body: { name: '备份机 B' } });

  await fsp.writeFile(path.join(A.folder, 'from-a.txt'), '你好，来自 A\n');
  await fsp.mkdir(path.join(A.folder, '子目录'), { recursive: true });
  await fsp.writeFile(path.join(A.folder, '子目录', 'note.md'), '# 中文文件名测试\n');
  await fsp.writeFile(path.join(A.folder, 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 7));

  await t.test('两个文件夹都能加进列表', async () => {
    const first = await addFolder(A, A.folder);
    const second = await addFolder(A, A.folder2);
    assert.equal(first.id.length > 0, true);
    assert.notEqual(first.id, second.id);

    const again = await addFolder(A, A.folder);
    assert.equal(again.id, first.id, '同一路径不应重复添加');

    const info = await api(A.base, '/api/info', { token: A.token });
    assert.equal(info.folders.length, 2);
    assert.equal(info.folders.every((folder) => folder.exists), true);

    aMain = info.folders[0];
    aDocs = info.folders[1];
    bMain = await addFolder(B, B.folder);
    bDocs = await addFolder(B, B.folder2);
  });

  await t.test('配对码错误会被拒绝', async () => {
    await assert.rejects(
      api(A.base, '/api/pair-peer', { method: 'POST', token: A.token, body: { url: B.base, code: '000000' } }),
      /配对码不正确/,
    );
  });

  await t.test('未配对设备读不到共享文件夹', async () => {
    const res = await fetch(`${A.base}/api/peer/manifest`, {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    assert.equal(res.status, 401);
  });

  await t.test('输一次配对码即可双向配对，并能列出对方文件夹', async () => {
    const { peer } = await api(A.base, '/api/pair-peer', {
      method: 'POST',
      token: A.token,
      body: { url: B.base, code: B.code },
    });
    assert.equal(peer.canCall, true, 'A 应持有调用 B 的令牌');

    const infoB = await api(B.base, '/api/info', { token: B.token });
    assert.equal(infoB.peers.length, 1, 'B 应记录 A');
    assert.equal(infoB.peers[0].canCall, true, 'B 也应能主动调 A');

    const infoA = await api(A.base, '/api/info', { token: A.token });
    peerOnA = infoA.peers[0].id;

    const list = await api(A.base, '/api/peer-folders', { method: 'POST', token: A.token, body: { peerId: peerOnA } });
    assert.equal(list.folders.length, 2, '应该看到对方两个文件夹');
    assert.equal(list.folders[0].id, bMain.id);
  });

  let plan = null;

  await t.test('首次对比：A 的 3 个文件待上传', async () => {
    plan = await scan(A, peerOnA, aMain.id, bMain.id);
    assert.equal(plan.folder.localName, aMain.name);
    assert.equal(plan.folder.remoteFolderId, bMain.id);
    assert.equal(plan.summary.upload, 3);
    assert.equal(plan.summary.download, 0);
    assert.equal(entryOf(plan, 'from-a.txt').kind, 'new-local');
    assert.equal(entryOf(plan, 'big.bin').kind, 'new-local');
    assert.equal(entryOf(plan, '子目录/note.md').kind, 'new-local');
  });

  await t.test('执行后 B 收到全部文件且内容一致', async () => {
    const result = await apply(A, plan.jobId);
    assert.equal(result.ok, 3);
    assert.equal(result.failed, 0);
    assert.equal(await fsp.readFile(path.join(B.folder, 'from-a.txt'), 'utf8'), '你好，来自 A\n');
    assert.equal(await fsp.readFile(path.join(B.folder, '子目录', 'note.md'), 'utf8'), '# 中文文件名测试\n');
    const big = await fsp.readFile(path.join(B.folder, 'big.bin'));
    assert.equal(big.length, 2 * 1024 * 1024);
    assert.equal(big[0], 7);
  });

  await t.test('同步完成后再对比是空计划', async () => {
    plan = await scan(A, peerOnA, aMain.id, bMain.id);
    assert.equal(plan.summary.upload, 0);
    assert.equal(plan.summary.download, 0);
    assert.equal(plan.summary.conflicts, 0);
    assert.equal(plan.summary.same, 3);
  });

  await t.test('远端改动与删除都能被识别', async () => {
    await fsp.writeFile(path.join(B.folder, 'from-a.txt'), 'B 改过\n');
    await fsp.rm(path.join(B.folder, 'big.bin'));

    plan = await scan(A, peerOnA, aMain.id, bMain.id);
    assert.equal(entryOf(plan, 'from-a.txt').kind, 'modified-remote');
    assert.equal(entryOf(plan, 'from-a.txt').action, 'download');
    assert.equal(entryOf(plan, 'big.bin').kind, 'deleted-remote');
    assert.equal(entryOf(plan, 'big.bin').action, 'delete-local');
  });

  await t.test('删除默认被安全开关拦住，只同步修改', async () => {
    const result = await apply(A, plan.jobId);
    assert.equal(result.ok, 1, `应只有 1 个操作，实际 ${result.ok}`);
    assert.equal(await fsp.readFile(path.join(A.folder, 'from-a.txt'), 'utf8'), 'B 改过\n');
    assert.equal(await exists(path.join(A.folder, 'big.bin')), true, '未开启删除时不该删本地文件');
  });

  await t.test('显式开启删除后才同步删除', async () => {
    plan = await scan(A, peerOnA, aMain.id, bMain.id);
    assert.equal(entryOf(plan, 'big.bin').kind, 'deleted-remote');
    const result = await apply(A, plan.jobId, { allowDeletes: true });
    assert.equal(result.ok, 1);
    assert.equal(await exists(path.join(A.folder, 'big.bin')), false);
  });

  await t.test('冲突：两端各改一份，选"都留"后两端都有两份', async () => {
    await fsp.writeFile(path.join(A.folder, '冲突.txt'), 'v1\n');
    plan = await scan(A, peerOnA, aMain.id, bMain.id);
    await apply(A, plan.jobId);
    assert.equal(await fsp.readFile(path.join(B.folder, '冲突.txt'), 'utf8'), 'v1\n');

    await fsp.writeFile(path.join(A.folder, '冲突.txt'), 'A 的版本\n');
    await fsp.writeFile(path.join(B.folder, '冲突.txt'), 'B 的版本\n');

    plan = await scan(A, peerOnA, aMain.id, bMain.id);
    const conflict = entryOf(plan, '冲突.txt');
    assert.equal(conflict.kind, 'conflict-modify');
    assert.equal(conflict.action, 'none', '冲突不应有默认动作');
    assert.equal(plan.summary.conflicts, 1);
    assert.equal(plan.summary.pendingConflicts, 1);

    const result = await apply(A, plan.jobId, { choices: { '冲突.txt': 'keep-both' } });
    assert.equal(result.failed, 0);

    assert.equal(await fsp.readFile(path.join(A.folder, '冲突.txt'), 'utf8'), 'A 的版本\n');
    assert.equal(await fsp.readFile(path.join(B.folder, '冲突.txt'), 'utf8'), 'A 的版本\n');

    const listOf = async (dir) => (await fsp.readdir(dir, { recursive: true }))
      .map((item) => String(item).replace(/\\/g, '/'))
      .filter((item) => item.includes('远端副本'));
    const copiesA = await listOf(A.folder);
    const copiesB = await listOf(B.folder);
    assert.equal(copiesA.length, 1, `A 应有一个冲突副本，实际 ${copiesA.join(',')}`);
    assert.equal(copiesB.length, 1, `B 应有一个冲突副本，实际 ${copiesB.join(',')}`);
    assert.match(copiesA[0], /^冲突 \(远端副本 \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\)\.txt$/);
    assert.equal(await fsp.readFile(path.join(A.folder, copiesA[0]), 'utf8'), 'B 的版本\n');
    assert.equal(await fsp.readFile(path.join(B.folder, copiesB[0]), 'utf8'), 'B 的版本\n');
  });

  await t.test('冲突处理完再对比不再重复报冲突', async () => {
    const after = await scan(A, peerOnA, aMain.id, bMain.id);
    assert.equal(after.summary.conflicts, 0);
    assert.equal(after.summary.upload, 0);
    assert.equal(after.summary.download, 0);
  });

  await t.test('反向同步：B 主动对比也一致', async () => {
    const infoB = await api(B.base, '/api/info', { token: B.token });
    const planB = await scan(B, infoB.peers[0].id, bMain.id, aMain.id);
    assert.equal(planB.summary.upload, 0);
    assert.equal(planB.summary.download, 0);
    assert.equal(planB.summary.conflicts, 0);
  });

  await t.test('多文件夹互不串味', async () => {
    await fsp.writeFile(path.join(A.folder2, 'doc.md'), '第二个文件夹的内容\n');

    // 第一个同步项看不到第二个文件夹的文件
    const mainPlan = await scan(A, peerOnA, aMain.id, bMain.id);
    assert.equal(entryOf(mainPlan, 'doc.md'), undefined);
    assert.equal(await exists(path.join(B.folder, 'doc.md')), false);

    // 第二个同步项只看自己这一对
    const docsPlan = await scan(A, peerOnA, aDocs.id, bDocs.id);
    assert.equal(docsPlan.summary.upload, 1);
    assert.equal(entryOf(docsPlan, 'doc.md').kind, 'new-local');

    await apply(A, docsPlan.jobId);
    assert.equal(await fsp.readFile(path.join(B.folder2, 'doc.md'), 'utf8'), '第二个文件夹的内容\n');
    assert.equal(await exists(path.join(B.folder, 'doc.md')), false, '不能写进另一个共享文件夹');

    // 基线按同步项隔离：再对比两边都干净
    const again = await scan(A, peerOnA, aDocs.id, bDocs.id);
    assert.equal(again.summary.upload, 0);
  });

  await t.test('打包下载可用且是合法 zip', async () => {
    const res = await fetch(`${A.base}/api/peer/zip?all=1&folderId=${aMain.id}&token=${A.token}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    const buffer = Buffer.from(await res.arrayBuffer());
    assert.equal(buffer.readUInt32LE(0), 0x04034b50, '应以本地文件头开头');
    const eocdIndex = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.ok(eocdIndex > 0, '应包含中央目录结束标记');
    const count = buffer.readUInt16LE(eocdIndex + 10);
    assert.equal(count >= 3, true, `应至少打包 3 个文件，实际 ${count}`);
  });

  await t.test('手机场景：上传 zip 自动解包到指定文件夹', async () => {
    // 用工具自己的打包器做一个带子目录与中文名的压缩包
    const stage = path.join(A.root, '打包源');
    await fsp.mkdir(path.join(stage, '照片'), { recursive: true });
    await fsp.writeFile(path.join(stage, '说明.txt'), '来自压缩包\n');
    await fsp.writeFile(path.join(stage, '照片', '图.txt'), '嵌套一层的文件\n');
    const zipPath = path.join(A.root, 'phone.zip');
    await pipeline(
      Readable.from(zipStream(stage, ['说明.txt', '照片/图.txt'])),
      createWriteStream(zipPath),
    );

    const stat = await fsp.stat(zipPath);
    // 走对端接口要用"对方发给我的令牌"，不是自己的管理员令牌
    const callToken = await peerTokenOf(A);
    const res = await fetch(`${B.base}/api/peer/archive?folderId=${bDocs.id}&prefix=${encodeURIComponent('手机上传')}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${callToken}`,
        'content-type': 'application/zip',
        'content-length': String(stat.size),
      },
      body: await fsp.readFile(zipPath),
    });
    assert.equal(res.status, 200, await res.clone().text());
    const payload = await res.json();
    assert.equal(payload.extracted, 2);

    assert.equal(await fsp.readFile(path.join(B.folder2, '手机上传', '说明.txt'), 'utf8'), '来自压缩包\n');
    assert.equal(await fsp.readFile(path.join(B.folder2, '手机上传', '照片', '图.txt'), 'utf8'), '嵌套一层的文件\n');

    // 解出来的文件应该能被正常对比
    const planB = await scan(B, (await api(B.base, '/api/info', { token: B.token })).peers[0].id, bDocs.id, aDocs.id);
    assert.equal(planB.summary.upload >= 2, true, `应有新增文件待上传，实际 ${planB.summary.upload}`);
  });

  await t.test('压缩包路径越界会被拒绝', async () => {
    const zipPath = path.join(A.root, 'evil.zip');
    // 打包器不会产出 ../ 条目，这里手工拼一个
    const name = Buffer.from('../逃逸.txt', 'utf8');
    const data = Buffer.from('bad', 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12);
    end.writeUInt32LE(local.length + name.length + data.length, 16);
    await fsp.writeFile(zipPath, Buffer.concat([local, name, data, central, name, end]));

    const stat = await fsp.stat(zipPath);
    const callToken = await peerTokenOf(A);
    const res = await fetch(`${B.base}/api/peer/archive?folderId=${bDocs.id}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${callToken}`,
        'content-type': 'application/zip',
        'content-length': String(stat.size),
      },
      body: await fsp.readFile(zipPath),
    });
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.extracted, 0);
    assert.equal(payload.skipped.length, 1);
    assert.equal(await exists(path.join(B.root, '逃逸.txt')), false);
  });

  await t.test('手机 App（纯客户端）不会被电脑端当成文件夹来源', async () => {
    const pair = await api(A.base, '/api/pair', {
      method: 'POST',
      body: { code: A.code, id: 'phone-e2e', name: '手机', port: 0, token: '', kind: 'client', platform: 'android' },
    });
    assert.ok(pair.token, '客户端应该拿到令牌');

    const info = await api(A.base, '/api/info', { token: A.token });
    const phonePeer = info.peers.find((peer) => peer.id === 'phone-e2e');
    assert.equal(phonePeer.kind, 'client');

    // 电脑端不该去枚举手机的文件，也不该报错
    const list = await api(A.base, '/api/peer-folders', { method: 'POST', token: A.token, body: { peerId: 'phone-e2e' } });
    assert.equal(list.clientOnly, true);
    assert.equal(list.folders.length, 0);

    // 电脑端也不能反向发起同步
    await assert.rejects(
      api(A.base, '/api/jobs/scan', {
        method: 'POST',
        token: A.token,
        body: { peerId: 'phone-e2e', localFolderId: aMain.id, remoteFolderId: bMain.id },
      }),
      /只能由手机发起同步/,
    );
  });

  await t.test('一键同步：没有冲突时一步到位', async () => {
    await fsp.writeFile(path.join(A.folder, '一键.txt'), 'one click\n');
    const { jobId } = await api(A.base, '/api/jobs/sync', {
      method: 'POST',
      token: A.token,
      body: { peerId: peerOnA, localFolderId: aMain.id, remoteFolderId: bMain.id },
    });
    const job = await waitJob(A, jobId);
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.result.applied, true);
    assert.equal(job.result.apply.ok, 1);
    assert.equal(await fsp.readFile(path.join(B.folder, '一键.txt'), 'utf8'), 'one click\n');
  });

  await t.test('一键同步：遇到冲突就停下来等用户选，绝不擅自覆盖', async () => {
    await fsp.writeFile(path.join(A.folder, '冲突2.txt'), 'v1\n');
    const first = await waitJob(A, (await api(A.base, '/api/jobs/sync', {
      method: 'POST',
      token: A.token,
      body: { peerId: peerOnA, localFolderId: aMain.id, remoteFolderId: bMain.id },
    })).jobId);
    assert.equal(first.result.applied, true, '首次应正常同步');

    await fsp.writeFile(path.join(A.folder, '冲突2.txt'), 'A 版本\n');
    await fsp.writeFile(path.join(B.folder, '冲突2.txt'), 'B 版本\n');

    const second = await waitJob(A, (await api(A.base, '/api/jobs/sync', {
      method: 'POST',
      token: A.token,
      body: { peerId: peerOnA, localFolderId: aMain.id, remoteFolderId: bMain.id },
    })).jobId);
    assert.equal(second.result.applied, false, '有冲突时不应自动执行');
    assert.equal(second.result.conflicts, 1);
    assert.equal(await fsp.readFile(path.join(A.folder, '冲突2.txt'), 'utf8'), 'A 版本\n');
    assert.equal(await fsp.readFile(path.join(B.folder, '冲突2.txt'), 'utf8'), 'B 版本\n', '手动场景不能擅自覆盖另一端');
  });

  await t.test('自动同步：冲突按修改时间裁决，新的留下、旧的存副本', async () => {
    const oldTime = new Date(Date.now() - 120_000);
    const newTime = new Date();
    await fsp.writeFile(path.join(A.folder, '冲突2.txt'), 'A 旧版本\n');
    await fsp.utimes(path.join(A.folder, '冲突2.txt'), oldTime, oldTime);
    await fsp.writeFile(path.join(B.folder, '冲突2.txt'), 'B 新版本\n');
    await fsp.utimes(path.join(B.folder, '冲突2.txt'), newTime, newTime);

    const enabled = await api(A.base, '/api/auto-sync', {
      method: 'POST',
      token: A.token,
      body: { peerId: peerOnA, localFolderId: aMain.id, remoteFolderId: bMain.id, enabled: true, intervalSec: 5 },
    });
    assert.equal(enabled.item.enabled, true);

    let ran = null;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const info = await api(A.base, '/api/info', { token: A.token });
      const item = info.autoSync.items.find((entry) => entry.key === enabled.item.key);
      if (item?.lastResult) {
        ran = item;
        break;
      }
      await sleep(400);
    }
    assert.ok(ran, '自动同步没有在预期时间内运行');
    assert.equal(ran.lastError, '');

    assert.equal(await fsp.readFile(path.join(A.folder, '冲突2.txt'), 'utf8'), 'B 新版本\n', '较新的一方应成为正式版本');
    assert.equal(await fsp.readFile(path.join(B.folder, '冲突2.txt'), 'utf8'), 'B 新版本\n');
    const copies = (await fsp.readdir(A.folder)).filter((name) => name.includes('本地副本'));
    assert.equal(copies.length, 1, `A 应保留一个本地副本，实际 ${copies.join(',')}`);
    assert.equal(await fsp.readFile(path.join(A.folder, copies[0]), 'utf8'), 'A 旧版本\n');

    await api(A.base, '/api/auto-sync', {
      method: 'POST',
      token: A.token,
      body: { peerId: peerOnA, localFolderId: aMain.id, remoteFolderId: bMain.id, enabled: false },
    });
  });
});
