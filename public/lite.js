/**
 * 零安装模式（纯浏览器）
 * ------------------------------------------------------------------
 * 用途：局域网里没有装 Node 的那台电脑，只需浏览器就能：
 *   1) 把本地文件夹推送到对方共享目录（带哈希校验、冲突提示）
 *   2) 把对方文件打包 zip 下载回去
 *
 * 限制（浏览器安全模型决定的，不是实现取巧）：
 *   - 无法在没有 HTTPS 的局域网页面上申请"写入任意文件夹"的权限，
 *     所以下载只能落到浏览器下载目录；要真正双向同步请用本机控制台。
 */

import {
  ACTION,
  KIND,
  isConflict,
  pendingHashes,
  quickPlan,
  resolvePlan,
  resolveChoiceAction,
} from '/shared/diff.js';
import { createSha256, toHex } from '/shared/sha256.js';

const boot = window.__BOOT__ || {};
const browserIdKey = 'lite-browser-id';
const tokenKey = 'lite-token';
const hostKey = 'lite-host';
const baselineKey = (hostId) => `lite-baseline:${hostId}`;

const state = {
  token: null,
  host: null, // {id, name, root}
  folders: [], // 对方共享出来的文件夹列表
  folderId: '',
  hostFiles: {},
  localFiles: [],
  localManifest: {},
  plan: null,
  choices: {},
  pushing: false,
  progress: '',
};

/* ---------------------------------------------------------------- 工具 */

const $ = (id) => document.getElementById(id);

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const fmtBytes = (bytes) => {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i += 1;
  }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[i]}`;
};

function toast(message, kind = 'ok') {
  const node = h('div', { class: `toast ${kind === 'ok' ? '' : kind}`, role: 'status' },
    icon(kind === 'ok' ? 'check' : 'alert'), h('div', { text: message }));
  $('toastRoot').append(node);
  setTimeout(() => node.remove(), kind === 'error' ? 6000 : 4000);
}

function logLine(text) {
  const box = $('logBody');
  const line = h('div', { class: 'folder-meta', style: 'margin:2px 0', text });
  box.append(line);
  while (box.childElementCount > 60) box.firstElementChild.remove();
}

async function api(pathname, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(pathname, {
    method,
    headers: {
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) throw new Error(json?.error || `请求失败（${res.status}）`);
  return json;
}

/**
 * 计算文件哈希。
 * crypto.subtle 只在安全上下文（https / localhost）存在；手机经 192.168.x.x 访问时是纯 HTTP，
 * 它根本不存在，所以必须有纯 JS 兜底，否则零安装页在手机上一点推送就报错。
 */
async function hashFile(file) {
  const subtleAvailable = !window.__forcePureSha && !!globalThis.crypto?.subtle;
  if (subtleAvailable && file.size <= 100 * 1024 * 1024) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      return toHex(new Uint8Array(digest));
    } catch {
      // 某些浏览器在非安全上下文里会抛异常，落到纯 JS 实现
    }
  }

  const hasher = createSha256();
  if (file.stream && file.stream instanceof Function) {
    const reader = file.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
    }
  } else {
    hasher.update(new Uint8Array(await file.arrayBuffer()));
  }
  return toHex(hasher.digest());
}

function getBrowserId() {
  let id = localStorage.getItem(browserIdKey);
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `browser-${Date.now()}`;
    localStorage.setItem(browserIdKey, id);
  }
  return id;
}

/* ---------------------------------------------------------------- 连接 */

function renderConnect() {
  const body = $('connectBody');
  body.replaceChildren();

  if (state.token) {
    const folderSelect = h('select', {
      class: 'select',
      'aria-label': '对方的文件夹',
      disabled: state.folders.length < 2,
      onchange: async (event) => {
        state.folderId = event.target.value;
        state.plan = null;
        state.choices = {};
        await loadHostManifest();
      },
    });
    for (const folder of state.folders) {
      const option = h('option', { value: folder.id, text: folder.name });
      if (folder.id === state.folderId) option.selected = true;
      folderSelect.append(option);
    }

    body.append(
      h('div', { class: 'folder-path' }, icon('check'), h('div', {},
        h('div', { text: `已连接：${state.host?.name || '对方设备'}` }),
        h('code', { text: state.host?.root || '（对方尚未添加文件夹）' }))),
      h('div', { class: 'folder-meta', style: 'align-items:center;gap:8px;margin-top:10px' },
        h('span', { text: '对方的文件夹：' }),
        state.folders.length ? folderSelect : h('span', { class: 'hint-inline', text: '（对方还没有添加共享文件夹）' })),
      h('div', { class: 'folder-meta', style: 'margin-top:6px' },
        h('span', { text: `本页地址 ${location.origin}` }),
        h('button', { class: 'btn small ghost', type: 'button', onclick: disconnect }, '断开重连')),
    );
    return;
  }

  const input = h('input', { type: 'text', placeholder: '6 位数字', inputmode: 'numeric', maxlength: '6', 'aria-label': '配对码' });
  const submit = async () => {
    const code = input.value.trim();
    if (!/^\d{6}$/.test(code)) {
      toast('请输入 6 位配对码', 'warn');
      return;
    }
    button.disabled = true;
    button.textContent = '连接中…';
    try {
      const reply = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          id: getBrowserId(),
          name: `浏览器 · ${navigator.platform || 'Web'}`,
          port: Number(location.port) || 80,
          token: '',
        }),
      }).then(async (res) => {
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error || `连接失败（${res.status}）`);
        return json;
      });

      state.token = reply.token;
      state.host = { id: reply.id, name: reply.name };
      localStorage.setItem(tokenKey, reply.token);
      localStorage.setItem(hostKey, JSON.stringify(state.host));
      logLine(`已连接到 ${reply.name}`);
      renderConnect();
      await loadHostManifest();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = '连接';
    }
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });

  const button = h('button', { class: 'btn primary', type: 'button', onclick: submit }, '连接');

  body.append(
    h('div', { class: 'field' },
      h('label', { text: '对方界面上显示的 6 位配对码' }),
      input,
      h('div', { class: 'hint', text: '配对码在运行本工具的那台电脑的「本机」卡片里' })),
    h('div', { style: 'display:flex;gap:8px' }, button),
  );
}

function disconnect() {
  state.token = null;
  state.host = null;
  state.hostFiles = {};
  state.folders = [];
  state.folderId = '';
  state.plan = null;
  localStorage.removeItem(tokenKey);
  localStorage.removeItem(hostKey);
  renderConnect();
  renderDownload();
  renderPush();
}

/* ---------------------------------------------------------------- 下载 */

async function loadHostManifest() {
  try {
    // 先拿对方的文件夹列表（对方可能共享了多个）
    if (!state.folders.length) {
      const list = await api('/api/peer/folders', { method: 'POST', body: {} });
      state.folders = list.folders || [];
      if (!state.folders.some((folder) => folder.id === state.folderId)) {
        state.folderId = state.folders[0]?.id || '';
      }
    }
    if (!state.folderId) {
      state.hostFiles = {};
      logLine('对方还没有添加共享文件夹');
      renderConnect();
      renderDownload();
      return;
    }

    const manifest = await api('/api/peer/manifest', { method: 'POST', body: { folderId: state.folderId } });
    state.host = { ...(state.host || {}), root: manifest.root, id: state.host?.id, folderId: state.folderId };
    state.hostFiles = manifest.files || {};
    state.plan = null;
    logLine(`对方共享目录：${manifest.root}（${Object.keys(state.hostFiles).length} 个文件）`);
    renderConnect();
    renderDownload();
    renderPush();
  } catch (err) {
    toast(`读取对方文件列表失败：${err.message}`, 'error');
  }
}

function renderDownload() {
  const body = $('downloadBody');
  body.replaceChildren();
  $('refreshBtn').disabled = !state.token;

  const paths = Object.keys(state.hostFiles).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }));
  if (!state.token) {
    body.append(h('p', { class: 'hint-inline', text: '先完成第 1 步连接。' }));
    return;
  }
  if (!paths.length) {
    body.append(h('p', { class: 'hint-inline', text: '对方共享目录是空的，或者读取被拒绝。' }));
    return;
  }

  const total = paths.reduce((sum, path) => sum + (Number(state.hostFiles[path]?.size) || 0), 0);
  const folderParam = state.folderId ? `folderId=${encodeURIComponent(state.folderId)}&` : '';
  const zipUrl = `/api/peer/zip?all=1&${folderParam}token=${encodeURIComponent(state.token)}`;

  body.append(
    ...[
      h('div', { class: 'folder-meta', style: 'margin-bottom:10px' },
        h('span', { text: `${paths.length} 个文件 · ${fmtBytes(total)}` }),
        h('a', { class: 'btn small primary', href: zipUrl, download: 'sync.zip' }, icon('zip'), '打包成 zip 下载')),
      h('div', { class: 'dl-list' },
        ...paths.slice(0, 200).map((path) => h('div', { class: 'dl-item' },
          h('span', { class: 'path', text: path }),
          h('span', {}, h('span', { class: 'hint-inline', text: fmtBytes(state.hostFiles[path]?.size) }), ' ',
            h('a', {
              href: `/api/peer/file?${folderParam}path=${encodeURIComponent(path)}&token=${encodeURIComponent(state.token)}`,
              download: path.split('/').pop(),
            }, '下载'))))),
      paths.length > 200 ? h('p', { class: 'hint-inline', text: '列表只显示前 200 个，完整内容请用打包下载。' }) : null,
      h('p', { class: 'hint-inline', style: 'margin-top:10px', text: '浏览器只能把文件存到默认下载目录；要写回指定文件夹，请用对方电脑上的本机控制台。' }),
    ].filter(Boolean),
  );
}

/* ---------------------------------------------------------------- 推送 */

function renderPush() {
  const body = $('pushBody');
  body.replaceChildren();
  $('pushBtn').disabled = !state.token || !state.plan || state.pushing || !hasPushOps();

  const drop = h('label', { class: 'file-drop' },
    icon('upload'),
    h('span', { text: '点这里选择要推送的文件夹' }),
    h('span', { class: 'hint-inline', text: '会递归包含子目录；对面更新的文件不会被旧版本覆盖' }),
    h('input', {
      id: 'folderInput',
      type: 'file',
      webkitdirectory: true,
      directory: true,
      multiple: true,
      onchange: (event) => onFilesPicked(event.target.files, 'folder'),
    }),
  );

  // 手机（尤其 iOS Safari）不支持选择整个文件夹，这里给两条替代路：多选文件 / 传 zip
  const singlePick = h('div', { class: 'folder-meta', style: 'align-items:center;gap:8px;margin-top:12px' },
    h('span', { text: '手机 / 不能选文件夹时：' }),
    h('label', { class: 'btn small', style: 'cursor:pointer' },
      '选择文件',
      h('input', {
        id: 'fileInput',
        type: 'file',
        multiple: true,
        style: 'display:none',
        onchange: (event) => onFilesPicked(event.target.files, 'files'),
      })),
    h('input', {
      id: 'prefixInput',
      type: 'text',
      placeholder: '推送到哪个子目录（可留空）',
      'aria-label': '子目录前缀',
      style: 'flex:1;min-width:0;min-height:32px;padding:4px 10px;font-size:12px;font-family:var(--font-mono);color:var(--text);background:var(--surface-2);border:1px solid var(--border);border-radius:8px',
    }),
  );

  // iOS 完全没法在网页里"选文件夹"，但可以传压缩包：服务端解开
  const archivePick = h('div', { class: 'folder-meta', style: 'align-items:center;gap:8px;margin-top:8px' },
    h('span', { text: '整个文件夹打包上传：' }),
    h('label', { class: 'btn small', style: 'cursor:pointer' },
      icon('zip'), '选 zip 上传',
      h('input', {
        id: 'archiveInput',
        type: 'file',
        accept: '.zip,application/zip,application/x-zip-compressed',
        style: 'display:none',
        onchange: (event) => uploadArchive(event.target.files?.[0]),
      })),
    h('span', { class: 'hint-inline', text: '先在手机上把文件夹压成 zip，路径会原样保留（可配合上面的子目录）' }),
  );

  body.append(drop, singlePick, archivePick);

  if (!state.token) {
    body.append(h('p', { class: 'hint-inline', style: 'margin-top:10px', text: '先完成第 1 步连接。' }));
    return;
  }

  if (state.localFiles.length) {
    const totalBytes = state.localFiles.reduce((sum, item) => sum + item.file.size, 0);
    body.append(h('div', { class: 'folder-meta', style: 'margin-top:12px' },
      h('span', { text: `已选 ${state.localFiles.length} 个文件 · ${fmtBytes(totalBytes)}` })));
  }

  if (!state.plan) {
    body.append(h('p', { class: 'hint-inline', style: 'margin-top:10px', text: '选择文件夹后会自动与对方对比，再决定推不推。' }));
    return;
  }

  const uploads = state.plan.entries.filter((entry) => isPushEntry(entry));
  const conflicts = state.plan.entries.filter((entry) => isConflict(entry));
  const skipped = state.plan.entries.filter((entry) => !isPushEntry(entry) && entry.kind !== KIND.SAME);

  body.append(h('div', { class: 'summary' },
    h('span', { class: 'chip up' }, h('b', { text: uploads.length }), ' 个待推送'),
    conflicts.length ? h('span', { class: 'chip conflict' }, h('b', { text: conflicts.length }), ' 个冲突') : null,
    h('span', { class: 'chip' }, h('b', { text: skipped.length }), ' 个不推送')));

  const rows = h('div', { class: 'rows' });
  for (const entry of state.plan.entries.slice(0, 300)) {
    if (entry.kind === KIND.SAME) continue;
    rows.append(renderPushRow(entry));
  }
  body.append(rows);
}

function renderPushRow(entry) {
  const meta = {
    [KIND.NEW_LOCAL]: '新增',
    [KIND.MODIFIED_LOCAL]: '修改',
    [KIND.NEW_REMOTE]: '仅对方有',
    [KIND.MODIFIED_REMOTE]: '对方有更新',
    [KIND.CONFLICT_ADD]: '冲突：两端不同',
    [KIND.CONFLICT_MODIFY]: '冲突：两端都改',
    [KIND.DELETED_REMOTE]: '对方已删除',
    [KIND.DELETED_LOCAL]: '本地已删除',
  }[entry.kind] || entry.kind;
  const tone = isConflict(entry) ? 'conflict' : entry.kind === KIND.NEW_LOCAL || entry.kind === KIND.MODIFIED_LOCAL ? 'up' : 'down';

  let control;
  if (isConflict(entry)) {
    const select = h('select', { class: 'seg-btn', 'aria-label': `${entry.path} 冲突处理` },
      h('option', { value: 'skip', text: '跳过（不动对方）' }),
      h('option', { value: 'keep-local', text: '用我的覆盖' }));
    select.value = state.choices[entry.path] || 'skip';
    select.addEventListener('change', () => {
      state.choices[entry.path] = select.value;
      renderPush();
      $('pushBtn').disabled = !hasPushOps();
    });
    control = select;
  } else if (isPushEntry(entry)) {
    control = h('span', { class: 'tag up', text: '将推送' });
  } else {
    control = h('span', { class: 'tag', text: '不推送' });
  }

  return h('div', { class: 'row' },
    h('div', { class: `row-icon ${tone}` }, icon(tone === 'up' ? 'upload' : tone === 'down' ? 'download' : 'alert')),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-path', text: entry.path }),
      h('div', { class: 'row-meta' },
        h('span', { class: `tag ${tone}`, text: meta }),
        h('span', { text: fmtBytes(entry.local?.size ?? entry.remote?.size ?? 0) }))),
    h('div', { class: 'row-actions' }, control));
}

function isPushEntry(entry) {
  if (entry.kind === KIND.SAME) return false;
  if (isConflict(entry)) return resolveChoiceAction(entry, state.choices[entry.path] || 'skip') === ACTION.UPLOAD;
  // 只推引擎判定为"本地更新"的文件；远端更新过的不要用旧版本盖掉
  return entry.action === ACTION.UPLOAD;
}

function hasPushOps() {
  return !!state.plan && state.plan.entries.some((entry) => isPushEntry(entry));
}

async function onFilesPicked(fileList, mode) {
  const files = Array.from(fileList || []).filter((file) => file && file.name);
  if (!files.length) return;

  const prefix = mode === 'files' ? String($('prefixInput')?.value || '').trim().replace(/^\/+|\/+$/g, '') : '';
  const items = [];
  for (const file of files) {
    const relative = file.webkitRelativePath || '';
    // 选文件夹时去掉用户选中的根目录名，只同步"文件夹里的内容"
    const base = relative ? relative.split('/').slice(1).join('/') : file.name;
    if (!base) continue;
    items.push({ file, rel: prefix ? `${prefix}/${base}` : base });
  }
  if (!items.length) return;

  // Android Chrome 的 webkitdirectory 常常被系统选择器降级成"选文件"，
  // 这时 webkitRelativePath 是空的，目录结构会丢——必须明说，不能悄悄摊平
  const degraded = mode === 'folder' && items.every((item) => !item.file.webkitRelativePath);
  if (degraded) {
    logLine('这个浏览器把「选文件夹」降级成了「选文件」：文件会直接放在目标目录下。要保留目录结构请用「选 zip 上传」。');
    toast('当前浏览器不支持直接选文件夹，已按平铺处理；保留目录请用 zip 上传', 'warn');
  }

  state.localFiles = items;
  state.plan = null;
  state.choices = {};
  logLine(`已读取 ${items.length} 个文件，正在计算校验值…`);
  renderPush();

  const manifest = {};
  let done = 0;
  for (const item of items) {
    const hash = await hashFile(item.file);
    manifest[item.rel] = {
      size: item.file.size,
      mtimeMs: item.file.lastModified,
      sig: `${item.file.size}:${Math.round(item.file.lastModified)}`,
      hash,
    };
    done += 1;
    if (done % 20 === 0 || done === items.length) logLine(`校验中 ${done}/${items.length}`);
  }
  state.localManifest = manifest;
  logLine('校验完成，正在与对方对比…');

  try {
    const baseline = readBaseline();
    const quick = quickPlan({ local: manifest, remote: state.hostFiles, baseline });
    const need = pendingHashes(quick);
    let remoteHashes = {};
    if (need.remote.length) {
      const reply = await api('/api/peer/hashes', {
        method: 'POST',
        body: { folderId: state.folderId, paths: need.remote.slice(0, 5000) },
      });
      remoteHashes = reply.hashes || {};
    }
    // 本地哈希已经算过，直接喂给引擎
    state.plan = { entries: resolvePlan(quick, { local: {}, remote: remoteHashes }) };
    logLine(`对比完成：${state.plan.entries.filter((entry) => entry.kind !== KIND.SAME).length} 个差异`);
  } catch (err) {
    toast(`对比失败：${err.message}`, 'error');
  }
  renderPush();
}

/* ---------------------------------------------------------------- 推送执行 */

async function doPush() {
  if (!state.plan || state.pushing) return;
  const targets = state.plan.entries.filter((entry) => isPushEntry(entry));
  if (!targets.length) {
    toast('没有需要推送的文件', 'warn');
    return;
  }

  state.pushing = true;
  renderPush();
  let ok = 0;
  let failed = 0;
  const baseline = readBaseline();

  for (const entry of targets) {
    const item = state.localFiles.find((candidate) => candidate.rel === entry.path);
    const file = item?.file;
    if (!file) {
      failed += 1;
      logLine(`× 找不到本地文件：${entry.path}`);
      continue;
    }
    try {
      logLine(`↑ 正在推送 ${entry.path}（${fmtBytes(file.size)}）`);
      const res = await fetch(`/api/peer/file?folderId=${encodeURIComponent(state.folderId)}&path=${encodeURIComponent(entry.path)}`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${state.token}`,
          'content-type': 'application/octet-stream',
          'x-file-sha256': entry.localHash || state.localManifest[entry.path]?.hash || '',
          'x-file-mtime': String(Math.round(file.lastModified)),
        },
        body: file,
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      ok += 1;
      baseline[entry.path] = {
        hash: json?.sha256 || entry.localHash,
        remoteHash: json?.sha256 || entry.localHash,
        localSig: `${file.size}:${Math.round(file.lastModified)}`,
        remoteSig: json?.sig || null,
      };
      state.hostFiles[entry.path] = { size: file.size, mtimeMs: json?.mtimeMs || file.lastModified, sig: json?.sig };
    } catch (err) {
      failed += 1;
      logLine(`× ${entry.path}：${err.message}`);
    }
  }

  writeBaseline(baseline);
  state.pushing = false;
  logLine(`推送结束：成功 ${ok}，失败 ${failed}`);
  toast(failed ? `推送完成，${ok} 成功 / ${failed} 失败` : `推送完成，${ok} 个文件已送达`, failed ? 'warn' : 'ok');
  state.plan = null;
  state.choices = {};
  await loadHostManifest();
  renderPush();
}

/** 传一个 zip 上去，由对方解开（手机没法选文件夹时的主路径） */
async function uploadArchive(file) {
  if (!file) return;
  if (!state.token || !state.folderId) {
    toast('先完成连接并选择对方的文件夹', 'warn');
    return;
  }
  const prefix = String($('prefixInput')?.value || '').trim().replace(/^\/+|\/+$/g, '');
  logLine(`↑ 正在上传压缩包 ${file.name}（${fmtBytes(file.size)}）`);
  try {
    const query = new URLSearchParams({ folderId: state.folderId });
    if (prefix) query.set('prefix', prefix);
    const res = await fetch(`/api/peer/archive?${query.toString()}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${state.token}`,
        'content-type': 'application/zip',
      },
      body: file,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
    const skipped = json?.skipped?.length || 0;
    logLine(`压缩包已解开：${json.extracted} 个文件${skipped ? `，跳过 ${skipped} 个` : ''}`);
    toast(`已上传并解开 ${json.extracted} 个文件`, skipped ? 'warn' : 'ok');
    await loadHostManifest();
  } catch (err) {
    logLine(`× 上传压缩包失败：${err.message}`);
    toast(`上传压缩包失败：${err.message}`, 'error');
  }
}

/* ---------------------------------------------------------------- 基线 */

function readBaseline() {
  try {
    const raw = localStorage.getItem(baselineKey(state.host?.id || 'default'));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeBaseline(baseline) {
  try {
    localStorage.setItem(baselineKey(state.host?.id || 'default'), JSON.stringify(baseline));
  } catch {
    // 存不下就只影响下次冲突判定，不影响推送本身
  }
}

/* ---------------------------------------------------------------- 启动 */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('themeBtn').replaceChildren(icon(theme === 'dark' ? 'moon' : 'sun'));
  try {
    localStorage.setItem('sync-theme', theme);
  } catch {
    // 忽略
  }
}

async function main() {
  let theme = 'dark';
  try {
    theme = localStorage.getItem('sync-theme') || 'dark';
  } catch {
    theme = 'dark';
  }
  applyTheme(theme);
  $('themeBtn').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  $('pushBtn').addEventListener('click', doPush);
  $('refreshBtn').addEventListener('click', loadHostManifest);

  const savedToken = localStorage.getItem(tokenKey);
  const savedHost = localStorage.getItem(hostKey);
  if (boot.token) {
    // 在本机用浏览器打开：直接复用管理员令牌，省掉再输一遍自己的配对码
    state.token = boot.token;
    state.host = { name: '本机' };
  } else if (savedToken) {
    state.token = savedToken;
    try {
      state.host = savedHost ? JSON.parse(savedHost) : null;
    } catch {
      state.host = null;
    }
  }

  renderConnect();
  renderDownload();
  renderPush();

  if (state.token) {
    try {
      await loadHostManifest();
    } catch {
      disconnect();
    }
  }

  if (boot.loopback) {
    $('liteSub').textContent = '本机浏览器：可以直接推送文件夹或打包下载（要双向同步请用本机控制台）';
  }
}

main();
