/**
 * UI 冒烟测试（真实浏览器，走 CDP）
 * ------------------------------------------------------------------
 * 不是单元测试，而是"人怎么点"的完整回归：
 *   起两个实例 → 打开本机界面 → 添加对端并配对 → 对比 → 执行 → 制造冲突 → 选"两个都留" → 再执行
 * 每步截图存到 docs/screenshots，控制台报错会被收集并在最后打印。
 *
 * 运行：node scripts/ui-smoke.mjs
 * 依赖：本机装了 Chrome 或 Edge（脚本自动探测），不需要 puppeteer。
 */

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
const SHOTS = path.join(APP_ROOT, 'docs', 'screenshots');
const NODE = process.execPath;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

async function findBrowser() {
  for (const candidate of CANDIDATES) {
    const ok = await fsp.access(candidate).then(() => true).catch(() => false);
    if (ok) return candidate;
  }
  throw new Error('没有找到 Chrome / Edge');
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

async function startNode(label, port) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `ui-${label}-`));
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
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const configPath = path.join(dataDir, 'config.json');
  let config = null;
  let base = '';
  for (let i = 0; i < 120; i += 1) {
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
  if (!base) throw new Error(`节点 ${label} 启动失败\n${output}`);
  return { label, child, root, folder, folder2, base, token: config.adminToken, code: config.pairingCode, output: () => output };
}

/** 通过界面添加文件夹：输路径跳转 → 点目录进入 → 确认（原来"换不掉文件夹"就出在这条路径上） */
async function addFolderViaUi(page, parentPath, dirName) {  await page.click('#pickFolderBtn');
  await page.waitFor("!!document.querySelector('.modal .browser-list')", { label: '文件夹弹窗' });
  await page.fill('.modal input[aria-label="完整路径"]', parentPath);
  await page.eval(`(() => {
    const el = document.querySelector('.modal input[aria-label="完整路径"]');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  const selector = `[...document.querySelectorAll('.modal .browser-item')].some((el) => el.textContent.trim() === ${JSON.stringify(dirName)})`;
  await page.waitFor(selector, { label: `目录 ${dirName} 出现在列表里` });
  await page.eval(`(() => {
    const el = [...document.querySelectorAll('.modal .browser-item')].find((item) => item.textContent.trim() === ${JSON.stringify(dirName)});
    el.click();
    return true;
  })()`);
  await sleep(300);
  const inputValue = await page.eval("document.querySelector('.modal input[aria-label=\"完整路径\"]').value");
  if (!inputValue.replaceAll('\\', '/').endsWith(`/${dirName}`)) {
    throw new Error(`浏览目录后路径框没有跟着更新（换文件夹就会失败）：${inputValue}`);
  }
  await page.click('.modal .modal-foot .btn.primary');
  await page.waitFor("!document.querySelector('.modal')", { label: '文件夹弹窗关闭' });
  await sleep(300);
}

/* --------------------------------------------------------------- CDP */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.consoleErrors = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        const handlers = this.listeners.get(msg.method) || [];
        for (const handler of handlers) handler(msg.params);
      }
    });
  }

  on(method, handler) {
    const list = this.listeners.get(method) || [];
    list.push(handler);
    this.listeners.set(method, list);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 20000);
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`页面脚本异常：${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description || ''}`);
    }
    return result.result?.value;
  }

  /** 拿到元素句柄（给 DOM.setFileInputFiles 用） */
  async evalObject(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: false });
    if (!result.result?.objectId) throw new Error(`找不到元素：${expression}`);
    return result.result.objectId;
  }

  async waitFor(expression, { timeout = 20000, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        if (await this.eval(expression)) return true;
      } catch {
        // 页面还在加载
      }
      await sleep(120);
    }
    throw new Error(`等待超时：${label}`);
  }

  async click(selector) {
    const ok = await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
    if (!ok) throw new Error(`找不到可点击元素：${selector}`);
    await sleep(120);
  }

  async fill(selector, value) {
    const ok = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!ok) throw new Error(`找不到输入框：${selector}`);
  }

  async shot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await fsp.writeFile(file, Buffer.from(data, 'base64'));
  }
}

async function launchBrowser() {
  const binary = await findBrowser();
  const debugPort = 9411;
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'ui-profile-'));
  const child = spawn(binary, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--force-device-scale-factor=1',
    '--window-size=1440,1180',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 100; i += 1) {
    try {
      version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then((res) => res.json());
      if (version?.webSocketDebuggerUrl) break;
    } catch {
      version = null;
    }
    await sleep(150);
  }
  if (!version) throw new Error('浏览器启动失败');
  return { child, port: debugPort, profile };
}

async function openPage(port, url) {
  const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then((res) => res.json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', (event) => reject(new Error(`WebSocket 连接失败：${event?.message || ''}`)), { once: true });
  });
  const cdp = new Cdp(ws);
  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params.type === 'error') {
      cdp.consoleErrors.push(params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
    }
  });
  cdp.on('Runtime.exceptionThrown', (params) => {
    cdp.consoleErrors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || '未知异常');
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1180,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return cdp;
}

/* --------------------------------------------------------------- 主流程 */

async function main() {
  await fsp.mkdir(SHOTS, { recursive: true });

  const A = await startNode('alpha', 47880);
  const B = await startNode('beta', 47881);
  const browser = await launchBrowser();
  const cleanup = async () => {
    for (const node of [A, B]) {
      try {
        node.child.kill();
      } catch {
        // 已退出
      }
    }
    try {
      browser.child.kill();
    } catch {
      // 已退出
    }
    await sleep(300);
    for (const node of [A, B]) await fsp.rm(node.root, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(browser.profile, { recursive: true, force: true }).catch(() => {});
  };

  try {
    // B 的两个文件夹直接用接口建；A 的文件夹特意走界面添加，验证"能加多个 / 能切换"
    await api(B.base, '/api/folders', { method: 'POST', token: B.token, body: { path: B.folder } });
    await api(B.base, '/api/folders', { method: 'POST', token: B.token, body: { path: B.folder2 } });
    await api(A.base, '/api/name', { method: 'POST', token: A.token, body: { name: '设计部 · 我的电脑' } });
    await api(B.base, '/api/name', { method: 'POST', token: B.token, body: { name: '会议室 · 备份机' } });

    await fsp.writeFile(path.join(A.folder, '项目说明.md'), '# 项目说明\n\n这是一次局域网同步的演示。\n');
    await fsp.mkdir(path.join(A.folder, '资料'), { recursive: true });
    await fsp.writeFile(path.join(A.folder, '资料', '需求清单.txt'), '1. 支持双向同步\n2. 冲突要能选\n3. 删除要二次确认\n');
    await fsp.writeFile(path.join(A.folder, '报价单.xlsx'), Buffer.alloc(280 * 1024, 9));
    await fsp.mkdir(path.join(A.folder, '图片'), { recursive: true });
    await fsp.writeFile(path.join(A.folder, '图片', '封面说明.txt'), '占位文件，用于演示子目录同步。\n');

    const page = await openPage(browser.port, `${A.base}/`);
    await page.waitFor("!!document.querySelector('#layout') && !document.querySelector('#layout').hidden", { label: '主界面加载' });
    await page.shot(path.join(SHOTS, '01-empty-state.png'));

    // 界面里连续加两个文件夹（第一次那个操作，就是当年"换不掉"的路径）
    await addFolderViaUi(page, A.root, 'files');
    await addFolderViaUi(page, A.root, 'files2');
    const folderRows = await page.eval("document.querySelectorAll('.folder-row').length");
    if (folderRows !== 2) throw new Error(`界面里应该有两个文件夹，实际 ${folderRows}`);
    await page.shot(path.join(SHOTS, '02-folders.png'));

    // 添加对端：真实走一遍弹窗
    await page.click('#addPeerBtn');
    await page.waitFor("!!document.querySelector('.modal')", { label: '添加对端弹窗' });
    await page.fill('.modal input[placeholder="http://192.168.1.5:47800"]', B.base);
    await page.fill('.modal input[placeholder="6 位数字"]', B.code);
    await page.shot(path.join(SHOTS, '02-pair-dialog.png'));
    await page.click('.modal .modal-foot .btn.primary');
    await page.waitFor("!document.querySelector('.modal')", { label: '配对弹窗关闭', timeout: 25000 });
    await sleep(900);
    const paired = await page.eval(`JSON.stringify({
      folders: (window.__state.info?.folders || []).map((item) => item.name),
      local: window.__state.localFolderId,
      remote: window.__state.remoteFolderId,
      remoteFolders: (window.__state.remoteFolders || []).map((item) => item.name),
      job: window.__state.activeJob,
      toasts: [...document.querySelectorAll('.toast')].map((item) => item.innerText),
    })`);
    console.log(`配对后状态：${paired}`);

    // 刚加完的第二个文件夹会被默认选中（它是空的），这里用同步项下拉切回第一个
    const picked = await page.eval(`(() => {
      const local = document.querySelector('.sync-bar select[aria-label="本机文件夹"]');
      const option = [...local.options].find((item) => item.textContent.trim() === 'files');
      if (!option) return false;
      local.value = option.value;
      local.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!picked) throw new Error('同步项里找不到第一个文件夹 files');
    await sleep(400);
    const clickSyncBar = (label) => page.eval(`(() => {
      const button = [...document.querySelectorAll('.sync-bar .btn')].find((item) => item.textContent.includes(${JSON.stringify(label)}));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!(await clickSyncBar('对比'))) throw new Error('同步项上没有「对比」按钮');

    await page.waitFor("document.querySelectorAll('.row').length > 0", { label: '对比结果出现' });
    await sleep(400);
    await page.shot(path.join(SHOTS, '03-plan.png'));

    const uploadRows = await page.eval("document.querySelectorAll('.row').length");
    console.log(`对比结果行数：${uploadRows}`);

    // 新文案：不是"上传/下载文件"，而是"同步到远端/同步到本地"
    const segLabels = await page.eval(
      "[...document.querySelectorAll('.seg .seg-btn')].map((item) => item.textContent.trim()).filter(Boolean)",
    );
    if (segLabels.some((label) => label === '上传' || label === '下载')) {
      throw new Error(`同步项按钮还残留旧文案：${segLabels.join(' / ')}`);
    }
    if (!segLabels.some((label) => label.includes('同步到远端') || label.includes('同步到本地'))) {
      throw new Error(`同步项按钮没有新文案：${segLabels.join(' / ')}`);
    }
    console.log('同步方向文案：通过');

    // 远端文件（自由下载）的断言放在首次同步之后：那时对方才真的有文件

    // 切换对方的文件夹：旧对比结果必须作废（否则可能把结果执行到另一个文件夹）
    const pickOtherRemote = `(() => {
      const remote = document.querySelector('.sync-bar select[aria-label="对方的文件夹"]');
      const other = [...remote.options].find((option) => option.value && option.value !== remote.value);
      if (!other) return false;
      remote.value = other.value;
      remote.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`;
    if (!(await page.eval(pickOtherRemote))) throw new Error('没有第二个对方文件夹可切换');
    await sleep(400);
    if (await page.eval('!!window.__state.plan')) throw new Error('切换同步项后旧的对比结果没有被清掉');
    if (!(await page.eval("!document.querySelector('.row')"))) throw new Error('切换后列表里还留着旧结果');
    await page.shot(path.join(SHOTS, '03b-sync-item-switch.png'));

    // 切回去重新对比
    await page.eval(pickOtherRemote);
    await sleep(400);
    if (!(await clickSyncBar('对比'))) throw new Error('同步项上没有「对比」按钮');
    await page.waitFor("document.querySelectorAll('.row').length > 0", { label: '切回后重新对比', timeout: 25000 });
    await sleep(300);

    await page.click('#applyBtn');
    await page.waitFor("document.querySelector('#planBody').innerText.includes('完全一致')", {
      label: '同步执行并重新对比完成',
      timeout: 40000,
    });
    await sleep(500);
    const historyText = await page.eval("document.querySelector('#historyBody').innerText.replace(/\\s+/g, ' ')");
    console.log(`同步后历史：${historyText.slice(0, 80)}`);
    if (!historyText.includes('成功')) throw new Error(`同步历史没有记录：${historyText}`);
    await page.shot(path.join(SHOTS, '04-synced.png'));

    // 首次同步之后对方也有文件了：远端文件列表应能列出并给出下载链接
    await page.waitFor("document.querySelectorAll('#remoteFilesBody .file-row').length > 0", {
      label: '远端文件列表出现',
      timeout: 20000,
    });
    const downloadInfo = await page.eval(`(() => {
      const link = document.querySelector('#remoteFilesBody .file-row a');
      const zip = document.getElementById('remoteZipBtn');
      return {
        href: link.getAttribute('href'),
        text: link.textContent.trim(),
        rows: document.querySelectorAll('#remoteFilesBody .file-row').length,
        zipHref: zip.hidden ? '' : zip.getAttribute('href'),
      };
    })()`);
    if (!downloadInfo.href.startsWith('/api/peer/download?')) throw new Error(`下载链接不对：${downloadInfo.href}`);
    if (!downloadInfo.href.includes('token=')) throw new Error('下载链接缺少令牌');
    if (!downloadInfo.zipHref.startsWith('/api/peer/download-zip?')) throw new Error('打包下载链接不对');
    await page.shot(path.join(SHOTS, '03c-remote-files.png'));
    console.log(`远端文件列表：通过（${downloadInfo.rows} 个文件）`);

    // 制造冲突与删除
    await fsp.writeFile(path.join(A.folder, '项目说明.md'), '# 项目说明（A 修改版）\n\nA 电脑在 10:30 更新了这份说明。\n');
    await fsp.writeFile(path.join(B.folder, '项目说明.md'), '# 项目说明（B 修改版）\n\nB 电脑在 10:31 也改了一版。\n');
    await fsp.rm(path.join(B.folder, '图片', '封面说明.txt'));

    await page.click('#rescanBtn');
    await page.waitFor("document.querySelectorAll('.row.is-conflict').length > 0", { label: '冲突行出现' });
    await sleep(300);
    await page.shot(path.join(SHOTS, '05-conflict.png'));

    const conflictText = await page.eval("document.querySelector('.row.is-conflict').innerText.replace(/\\s+/g, ' ')");
    console.log(`冲突行：${conflictText}`);

    const applyDisabled = await page.eval("document.querySelector('#applyBtn').disabled");
    if (!applyDisabled) throw new Error('有未决冲突时「执行同步」不应该可点');

    // 执行阶段必须有进度卡（真实同步太快截不到，这里注入执行中状态走同一条渲染路径）
    const progressVisible = await page.eval(`(() => {
      const s = window.__state;
      const before = s.activeJob;
      s.activeJob = { type: 'apply', id: 'smoke', stage: '正在同步文件' };
      s.progress = { index: 2, total: 5 };
      document.querySelector('#onlyDiff').dispatchEvent(new Event('change', { bubbles: true }));
      const card = document.querySelector('.progress-card');
      const ok = !!card && !!card.querySelector('.bar');
      s.activeJob = before;
      s.progress = null;
      document.querySelector('#onlyDiff').dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#onlyDiff').checked = true;
      return ok;
    })()`);
    if (!progressVisible) throw new Error('执行阶段没有渲染进度卡');

    // 浅色主题与移动端布局各截一张（同一份内容）
    await page.eval("document.documentElement.dataset.theme = 'light'");
    await sleep(350);
    await page.shot(path.join(SHOTS, '10-light-theme.png'));
    await page.eval("document.documentElement.dataset.theme = 'dark'");
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 940, deviceScaleFactor: 1, mobile: true });
    await sleep(350);
    await page.shot(path.join(SHOTS, '11-mobile.png'));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1180, deviceScaleFactor: 1, mobile: false });
    await sleep(200);

    await page.eval(`(() => {
      const row = [...document.querySelectorAll('.row')].find((item) => item.dataset.path === '项目说明.md');
      const btn = row?.querySelector('[data-choice="keep-both"]');
      btn?.click();
      return !!btn;
    })()`);
    await page.eval(`(() => {
      const box = document.querySelector('#allowDeletes');
      if (!box.checked) { box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); }
      return box.checked;
    })()`);
    await sleep(200);
    await page.shot(path.join(SHOTS, '06-conflict-decided.png'));

    await page.click('#applyBtn');
    await page.waitFor("!!document.querySelector('.modal')", { label: '删除二次确认' });
    await page.shot(path.join(SHOTS, '07-delete-confirm.png'));
    await page.click('.modal .modal-foot .btn.danger');
    await page.waitFor("document.querySelector('#planBody').innerText.includes('完全一致')", {
      label: '冲突处理后重新收敛',
      timeout: 40000,
    });
    await sleep(700);
    await page.shot(path.join(SHOTS, '08-after-conflict.png'));

    // 落盘校验：两端都应有两份内容
    const listA = await fsp.readdir(A.folder);    const listB = await fsp.readdir(B.folder);
    console.log(`A 目录：${listA.join(' | ')}`);
    console.log(`B 目录：${listB.join(' | ')}`);
    const copyA = listA.find((name) => name.includes('远端副本'));
    const copyB = listB.find((name) => name.includes('远端副本'));
    if (!copyA || !copyB) throw new Error('冲突副本没有在两端生成');
    const contentA = await fsp.readFile(path.join(A.folder, '项目说明.md'), 'utf8');
    const contentB = await fsp.readFile(path.join(B.folder, '项目说明.md'), 'utf8');
    if (contentA !== contentB) throw new Error('冲突处理后两端内容仍不一致');
    const copyContent = await fsp.readFile(path.join(A.folder, copyA), 'utf8');
    if (!copyContent.includes('B 修改版')) throw new Error(`冲突副本内容不对：${copyContent.slice(0, 40)}`);
    if (await fsp.access(path.join(B.folder, '图片', '封面说明.txt')).then(() => true).catch(() => false)) {
      throw new Error('删除操作没有同步到 B');
    }

    // 一键同步：点一下就把对比 + 执行做完
    await fsp.writeFile(path.join(A.folder, '一键测试.txt'), 'one click\n');
    if (!(await clickSyncBar('一键同步'))) throw new Error('同步项上没有「一键同步」按钮');
    let pushed = false;
    const pushDeadline = Date.now() + 25000;
    while (Date.now() < pushDeadline) {
      if (await fsp.access(path.join(B.folder, '一键测试.txt')).then(() => true).catch(() => false)) {
        pushed = true;
        break;
      }
      await sleep(300);
    }
    if (!pushed) throw new Error('一键同步没有把新文件推过去');
    await sleep(600);
    console.log('一键同步：通过');

    // 自动同步开关（打开 → 服务端记录该项 → 关闭）
    await page.eval(`(() => {
      const box = document.querySelector('.sync-bar input[type="checkbox"]');
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await page.waitFor('!!(window.__state.info?.autoSync?.items || []).length', { label: '自动同步已开启' });
    await sleep(400);
    await page.shot(path.join(SHOTS, '13-auto-sync.png'));
    await page.eval(`(() => {
      const box = document.querySelector('.sync-bar input[type="checkbox"]');
      box.checked = false;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await page.waitFor('!((window.__state.info?.autoSync?.items || []).length)', { label: '自动同步已关闭' });
    console.log('自动同步开关：通过');

    // 手机 App（纯客户端）在电脑端的表现：应该解释"从手机发起"，而不是"对方没有共享文件夹"
    await api(A.base, '/api/pair', {
      method: 'POST',
      body: { code: A.code, id: 'ui-phone', name: '小米手机', port: 0, token: '', kind: 'client', platform: 'android' },
    });
    await page.waitFor(
      `[...document.querySelectorAll('.sync-bar select[aria-label="对端设备"] option')].some((item) => item.textContent.includes('小米手机'))`,
      { label: '手机对端出现在下拉里', timeout: 15000 },
    );
    const switchedToPhone = await page.eval(`(() => {
      const peerSelect = document.querySelector('.sync-bar select[aria-label="对端设备"]');
      if (!peerSelect) return false;
      const option = [...peerSelect.options].find((item) => item.textContent.includes('小米手机'));
      if (!option) return false;
      peerSelect.value = option.value;
      peerSelect.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!switchedToPhone) throw new Error('没能把同步项切到手机对端');
    await page.waitFor("document.querySelector('#planBody').innerText.includes('手机 App')", {
      label: '手机客户端说明出现',
      timeout: 15000,
    });
    const clientText = await page.eval("document.querySelector('#planBody').innerText.replace(/\\s+/g, ' ')");
    if (clientText.includes('对方没有共享文件夹')) throw new Error('对手机客户端仍显示成"对方没有共享文件夹"');
    if (!clientText.includes('同步从手机发起')) throw new Error(`手机客户端说明文案不对：${clientText.slice(0, 80)}`);
    await sleep(400);
    await page.shot(path.join(SHOTS, '14-phone-peer.png'));
    console.log('手机客户端提示：通过');

    // 零安装页面（本机打开，自动带令牌）
    const lite = await openPage(browser.port, `${A.base}/lite`);
    await lite.waitFor("!!document.querySelector('#connectBody')", { label: '零安装页加载' });
    await sleep(500);
    await lite.shot(path.join(SHOTS, '09-lite.png'));

    // —— 手机场景：经局域网 IP 访问，是"非安全上下文"，没有 crypto.subtle ——
    const info = await api(A.base, '/api/info', { token: A.token });
    const lanUrl = info.lanIps[0];
    if (!lanUrl) throw new Error('没有局域网地址可测');
    const lanPing = await fetch(`${lanUrl}/api/ping`).then((res) => res.json()).catch(() => null);
    if (!lanPing?.ok) throw new Error(`局域网地址不可达（可能被防火墙拦了）：${lanUrl}`);

    const phone = await openPage(browser.port, `${lanUrl}/lite`);
    await phone.waitFor("!!document.querySelector('#connectBody input[type=text]')", { label: '手机端连接表单' });
    // 真机尺寸跑一遍，顺便验证窄屏布局与触控目标
    await phone.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    const hasSubtle = await phone.eval('!!globalThis.crypto?.subtle');
    console.log(`局域网页面有 crypto.subtle：${hasSubtle}（应为 false，说明走纯 JS 哈希）`);

    await phone.fill('#connectBody input[type=text]', A.code);
    await phone.click('#connectBody .btn.primary');
    await phone.waitFor("document.querySelector('#connectBody').innerText.includes('已连接')", { label: '手机端配对' });

    const phoneFile = path.join(A.root, '从手机推来的.txt');
    await fsp.writeFile(phoneFile, '这是从局域网浏览器推过去的文件\n');
    await phone.eval('window.__forcePureSha = true');
    await phone.send('DOM.enable');
    const objectId = await phone.evalObject("document.querySelector('#fileInput')");
    await phone.send('DOM.setFileInputFiles', { files: [phoneFile], objectId });
    await phone.waitFor("document.querySelectorAll('#pushBody .row').length > 0", { label: '手机端对比结果' });
    await phone.click('#pushBtn');
    await phone.waitFor("document.querySelector('#logBody').innerText.includes('推送结束')", {
      label: '手机端推送完成',
      timeout: 30000,
    });
    await sleep(300);
    await phone.shot(path.join(SHOTS, '12-phone-lite.png'));
    const landed = await fsp.readFile(path.join(A.folder, '从手机推来的.txt'), 'utf8');
    if (!landed.includes('从局域网浏览器推过去的文件')) throw new Error('手机推送的文件内容不对');
    const pushLog = await phone.eval("document.querySelector('#logBody').innerText.replace(/\\s+/g, ' ')");
    if (!pushLog.includes('成功 1')) throw new Error(`手机推送没有成功：${pushLog.slice(-120)}`);
    console.log(`手机推送已落盘：${landed.trim()}`);

    // 手机选不了文件夹时的主路径：上传 zip，由对方解开
    const archiveStage = path.join(A.root, '压缩源');
    await fsp.mkdir(path.join(archiveStage, '子目录'), { recursive: true });
    await fsp.writeFile(path.join(archiveStage, '包内文件.txt'), '压缩包里的内容\n');
    await fsp.writeFile(path.join(archiveStage, '子目录', '深层.txt'), '嵌套文件\n');
    const zipPath = path.join(A.root, '手机.zip');
    await pipeline(
      Readable.from(zipStream(archiveStage, ['包内文件.txt', '子目录/深层.txt'])),
      createWriteStream(zipPath),
    );
    const archiveObjectId = await phone.evalObject("document.querySelector('#archiveInput')");
    await phone.send('DOM.setFileInputFiles', { files: [zipPath], objectId: archiveObjectId });
    await phone.waitFor("document.querySelector('#logBody').innerText.includes('压缩包已解开')", {
      label: '手机上传 zip 并解包',
      timeout: 30000,
    });
    const unzipped = await fsp.readFile(path.join(A.folder, '包内文件.txt'), 'utf8');
    if (!unzipped.includes('压缩包里的内容')) throw new Error('zip 上传后的文件内容不对');
    const deep = await fsp.readFile(path.join(A.folder, '子目录', '深层.txt'), 'utf8');
    if (!deep.includes('嵌套文件')) throw new Error('zip 里的子目录没有展开');
    console.log('手机上传 zip 并解包：通过');

    const errors = [...page.consoleErrors, ...lite.consoleErrors, ...phone.consoleErrors];
    const errorToasts = await page.eval("[...document.querySelectorAll('.toast.error')].map((item) => item.innerText).join(' | ')");
    if (errorToasts) throw new Error(`界面上出现了错误提示：${errorToasts}`);
    if (errors.length) {
      console.log('\n控制台错误：');
      for (const error of errors) console.log(` - ${error}`);
      throw new Error(`浏览器控制台有 ${errors.length} 条错误`);
    }

    console.log('\nUI 冒烟测试通过，截图在 docs/screenshots');
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error(`\nUI 冒烟测试失败：${err.message}`);
  process.exit(1);
});
