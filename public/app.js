/**
 * 主控台前端
 * ------------------------------------------------------------------
 * 只做三件事：驱动 API、把差异计划渲染成可点选的行、把执行进度画出来。
 * 判定逻辑全部来自 /shared/diff.js —— 与服务端同一份代码，避免两边规则漂移。
 */

import { ACTION, KIND, isConflict, resolveChoiceAction } from '/shared/diff.js';

const boot = window.__BOOT__ || { token: null, loopback: false, version: '' };

const state = {
  info: null,
  plan: null,
  choices: {},
  results: {},
  allowDeletes: false,
  onlyDiff: true,
  rowLimit: 400,
  activePeerId: null,
  // 一个同步项 = (本机文件夹, 对端, 对端文件夹)
  localFolderId: '',
  remoteFolderId: '',
  remoteFolders: [],
  remoteFoldersError: '',
  remoteFoldersFor: '',
  remoteClientOnly: false,
  // 远端文件（自由下载，不参与同步）
  remoteFiles: null,
  remoteFilesFor: '',
  remoteFilesError: '',
  remoteFilesLoading: false,
  activeJob: null,
  progress: null,
  logLines: [],
  history: [],
  discovered: [],
  applying: false,
  finished: false,
  planStale: false,
  lastAuto: null,
};

/* ------------------------------------------------------------ 基础工具 */

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function icon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `icon ${cls}`.trim());
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
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[index]}`;
};

const fmtTime = (iso) => {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

function toast(message, kind = 'ok') {
  const root = document.getElementById('toastRoot');
  const node = h(
    'div',
    { class: `toast ${kind === 'ok' ? '' : kind}`, role: 'status' },
    icon(kind === 'error' ? 'alert' : kind === 'warn' ? 'alert' : 'check'),
    h('div', { text: message }),
  );
  root.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 240);
  }, kind === 'error' ? 6000 : 4000);
}

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(pathname, {
    method,
    headers: {
      ...(boot.token ? { authorization: `Bearer ${boot.token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const error = new Error(json?.error || `请求失败（${res.status}）`);
    error.status = res.status;
    throw error;
  }
  return json;
}

/* ------------------------------------------------------------ 文案映射 */

const KIND_META = {
  [KIND.SAME]: { label: '一致', tone: '', icon: 'check' },
  [KIND.NEW_LOCAL]: { label: '本地新增', tone: 'up', icon: 'upload' },
  [KIND.NEW_REMOTE]: { label: '远端新增', tone: 'down', icon: 'download' },
  [KIND.MODIFIED_LOCAL]: { label: '本地已修改', tone: 'up', icon: 'upload' },
  [KIND.MODIFIED_REMOTE]: { label: '远端已修改', tone: 'down', icon: 'download' },
  [KIND.DELETED_LOCAL]: { label: '本地已删除', tone: 'del', icon: 'trash' },
  [KIND.DELETED_REMOTE]: { label: '远端已删除', tone: 'del', icon: 'trash' },
  [KIND.BOTH_DELETED]: { label: '两端已删除', tone: '', icon: 'check' },
  [KIND.CONFLICT_ADD]: { label: '两端都有且不同', tone: 'conflict', icon: 'alert' },
  [KIND.CONFLICT_MODIFY]: { label: '两端都改过', tone: 'conflict', icon: 'alert' },
  [KIND.CONFLICT_DELETE_MODIFY]: { label: '一边删除一边修改', tone: 'conflict', icon: 'alert' },
};

const OPTION_CLASS = { upload: 'up', download: 'down', delete: 'del', both: 'both' };

function choiceLabels(entry) {
  if (entry.kind === KIND.DELETED_REMOTE) return { local: '保留（补回远端）', remote: '接受删除' };
  if (entry.kind === KIND.DELETED_LOCAL) return { local: '接受删除', remote: '保留（拉回本地）' };
  if (entry.kind === KIND.CONFLICT_DELETE_MODIFY) {
    return entry.survivor === 'local'
      ? { local: '保留修改（补回远端）', remote: '接受删除（删本地）' }
      : { local: '接受删除（删远端）', remote: '保留修改（拉回本地）' };
  }
  // 这里不是"上传/下载一个文件"，而是"以哪一边为准把两边同步成一样"：
  // 同步到远端 = 用本机这份覆盖远端；同步到本地 = 用远端这份覆盖本机
  return { local: '同步到远端', remote: '同步到本地' };
}

/** 条目默认该取哪种选择 */
function defaultChoice(entry) {
  switch (entry.action) {
    case ACTION.UPLOAD:
      return 'keep-local';
    case ACTION.DOWNLOAD:
      return 'keep-remote';
    case ACTION.DELETE_LOCAL:
      return 'keep-remote';
    case ACTION.DELETE_REMOTE:
      return 'keep-local';
    case ACTION.KEEP_BOTH:
      return 'keep-both';
    default:
      return isConflict(entry) ? null : 'skip';
  }
}

function choiceOf(entry) {
  return Object.prototype.hasOwnProperty.call(state.choices, entry.path) ? state.choices[entry.path] : defaultChoice(entry);
}

function actionOf(entry) {
  const choice = choiceOf(entry);
  if (!choice) return ACTION.NONE;
  return resolveChoiceAction(entry, choice) ?? ACTION.NONE;
}

function isSettled(entry) {
  if (entry.kind === KIND.SAME || entry.kind === KIND.BOTH_DELETED) return true;
  return !isConflict(entry) || choiceOf(entry) !== null;
}

/* ------------------------------------------------------------ 统计计算 */

function computeOps() {
  const ops = {
    upload: 0,
    download: 0,
    deleteLocal: 0,
    deleteRemote: 0,
    undecided: 0,
    same: 0,
    bytesUp: 0,
    bytesDown: 0,
  };
  if (!state.plan) return ops;
  for (const entry of state.plan.entries) {
    if (entry.kind === KIND.SAME || entry.kind === KIND.BOTH_DELETED) {
      ops.same += 1;
      continue;
    }
    const choice = choiceOf(entry);
    if (isConflict(entry) && !choice) {
      ops.undecided += 1;
      continue;
    }
    switch (actionOf(entry)) {
      case ACTION.UPLOAD:
        ops.upload += 1;
        ops.bytesUp += Number(entry.local?.size) || 0;
        break;
      case ACTION.DOWNLOAD:
        ops.download += 1;
        ops.bytesDown += Number(entry.remote?.size) || 0;
        break;
      case ACTION.DELETE_LOCAL:
        ops.deleteLocal += 1;
        break;
      case ACTION.DELETE_REMOTE:
        ops.deleteRemote += 1;
        break;
      case ACTION.KEEP_BOTH:
        ops.upload += 1;
        ops.download += 1;
        ops.bytesUp += Number(entry.local?.size) || 0;
        ops.bytesDown += Number(entry.remote?.size) || 0;
        break;
      default:
        break;
    }
  }
  return ops;
}

function opTotal() {
  const ops = computeOps();
  return ops.upload + ops.download + (state.allowDeletes ? ops.deleteLocal + ops.deleteRemote : 0);
}

/* ------------------------------------------------------------ 渲染：本机 */

function renderSelf() {
  const info = state.info;
  const body = document.getElementById('selfBody');
  body.replaceChildren();
  if (!info) return;

  const nameRow = h(
    'div',
    { class: 'kv' },
    h('dt', { text: '设备名' }),
    h('dd', {}, h('span', { text: info.name }), ' ',
      h('button', { class: 'btn small', type: 'button', onclick: openRenameModal }, '改名')),
    h('dt', { text: '局域网' }),
    h('dd', { class: 'peer-url', text: info.lanIps?.[0] || `http://127.0.0.1:${info.port}` }),
    h('dt', { text: '端口' }),
    h('dd', { text: String(info.port) }),
  );

  body.append(
    nameRow,
    h(
      'div',
      { class: 'code-box' },
      h('div', {},
        h('div', { style: 'font-size:12px;color:var(--text-dim)', text: '让对方输入这组配对码' }),
        h('div', { class: 'code-value', text: info.pairingCode })),
      h('div', { style: 'display:flex;flex-direction:column;gap:6px' },
        h('button', { class: 'btn small', type: 'button', onclick: () => copyText(info.lanIps?.[0] || `http://127.0.0.1:${info.port}`) },
          icon('copy'), '复制地址'),
        h('button', { class: 'btn small ghost', type: 'button', onclick: regenerateCode }, '换一个')),
    ),
  );
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板');
  } catch {
    toast('浏览器不允许自动复制，请手动选取', 'warn');
  }
}

async function regenerateCode() {
  try {
    const result = await api('/api/pairing-code', { method: 'POST' });
    if (state.info) state.info.pairingCode = result.pairingCode;
    renderSelf();
    toast('配对码已更新，旧配对码立即失效');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ------------------------------------------------------------ 同步项选择 */

const SYNC_ITEM_KEY = 'sync-item';

function saveSyncItem() {
  try {
    localStorage.setItem(SYNC_ITEM_KEY, JSON.stringify({
      peerId: state.activePeerId,
      localFolderId: state.localFolderId,
      remoteFolderId: state.remoteFolderId,
    }));
  } catch {
    // 隐私模式下写不了，不影响功能
  }
}

function restoreSyncItem() {
  try {
    const raw = localStorage.getItem(SYNC_ITEM_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.peerId) state.activePeerId = saved.peerId;
    if (saved.localFolderId) state.localFolderId = saved.localFolderId;
    if (saved.remoteFolderId) state.remoteFolderId = saved.remoteFolderId;
  } catch {
    // 忽略坏数据
  }
}

/** 切换同步项：只要一端变了，旧的对比结果就作废 */
function selectSyncItem(peerId, localFolderId, remoteFolderId) {
  const peerChanged = peerId && peerId !== state.activePeerId;
  state.activePeerId = peerId || state.activePeerId;
  state.localFolderId = localFolderId || state.localFolderId;
  state.remoteFolderId = remoteFolderId || state.remoteFolderId;
  if (peerChanged) {
    state.remoteFolders = [];
    state.remoteFoldersError = '';
    state.remoteFolderId = '';
  }
  state.plan = null;
  state.choices = {};
  state.results = {};
  state.finished = false;
  saveSyncItem();
  renderLocal();
  renderPeers();
  renderPlan();
  if (peerChanged) loadRemoteFolders(state.activePeerId);
}

async function loadRemoteFolders(peerId) {
  if (!peerId) return;
  if (state.remoteFoldersFor === peerId && state.remoteFolders.length) return;
  state.remoteFoldersFor = peerId;
  state.remoteFoldersError = '';
  try {
    const data = await api('/api/peer-folders', { method: 'POST', body: { peerId } });
    state.remoteFolders = data.folders || [];
    // 手机 App 这类客户端没有服务端，也不会向电脑提供文件夹
    state.remoteClientOnly = !!data.clientOnly;
    if (!state.remoteFolders.some((folder) => folder.id === state.remoteFolderId)) {
      state.remoteFolderId = state.remoteFolders[0]?.id || '';
    }
    saveSyncItem();
  } catch (err) {
    state.remoteFolders = [];
    state.remoteClientOnly = false;
    state.remoteFoldersError = err.message;
  }
  renderPeers();
  renderPlan();
}

async function removeFolder(folder) {
  const ok = await confirmDialog({
    title: `移除文件夹「${folder.name}」`,
    message: '只是不再共享/同步它，不会删除任何文件。',
    confirmText: '移除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('/api/folders/remove', { method: 'POST', body: { id: folder.id } });
    if (state.localFolderId === folder.id) {
      state.localFolderId = '';
      state.plan = null;
    }
    await refreshInfo();
    toast('已移除');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ------------------------------------------------------------ 渲染：文件夹 */

function renderLocal() {
  const info = state.info;
  const body = document.getElementById('localBody');
  body.replaceChildren();
  if (!info) return;

  const folders = info.folders || [];
  if (!folders.length) {
    body.append(
      h('div', { class: 'empty' },
        icon('folder'),
        h('p', {}, h('strong', { text: '还没有添加文件夹' }), h('br'), '可以添加多个。它们既是电脑共享出去的目录，也是手机 App 里「对方共享的文件夹」下拉的内容。'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => openFolderModal() }, '添加文件夹')),
    );
    return;
  }

  const list = h('div', { class: 'folder-list' });
  for (const folder of folders) {
    const isActive = state.localFolderId === folder.id;
    list.append(
      h('div', { class: `folder-row ${isActive ? 'is-active' : ''}` },
        icon('folder'),
        h('div', { class: 'folder-row-main' },
          h('div', { class: 'folder-row-name' },
            h('span', { text: folder.name }),
            folder.exists === false ? h('span', { class: 'tag del', text: '路径不存在' }) : null,
            isActive ? h('span', { class: 'tag up', text: '当前' }) : null),
          h('div', { class: 'folder-row-path', text: folder.path })),
        h('button', {
          class: 'icon-btn small',
          type: 'button',
          title: '移除这个文件夹',
          'aria-label': `移除 ${folder.name}`,
          onclick: () => removeFolder(folder),
        }, icon('x'))),
    );
  }

  body.append(
    list,
    h('div', { class: 'folder-meta', style: 'margin-top:10px;justify-content:space-between;align-items:center' },
      h('span', { text: `共 ${folders.length} 个（最多 ${info.maxFolders || 24} 个）` }),
      h('button', { class: 'btn small', type: 'button', onclick: () => openFolderModal() }, icon('plus'), '再加一个')),
  );
}

/* ------------------------------------------------------------ 渲染：对端 */

function renderPeerFolders(peer) {
  const wrap = h('div', { class: 'peer-folders' });

  if (state.remoteFoldersFor !== peer.id) {
    wrap.append(h('div', { class: 'folder-meta', text: '正在读取对方的文件夹…' }));
    return wrap;
  }
  if (state.remoteFoldersError) {
    wrap.append(
      h('div', { class: 'folder-meta' }, `读取对方文件夹失败：${state.remoteFoldersError} `,
        h('button', { class: 'btn small', type: 'button', onclick: () => { state.remoteFoldersFor = ''; loadRemoteFolders(peer.id); } }, '重试')),
    );
    return wrap;
  }
  if (state.remoteClientOnly) {
    // 手机 App：只能由它发起同步，电脑这边没有"对方的文件夹"可选
    const localFolders = state.info?.folders || [];
    wrap.append(
      h('div', { class: 'peer-note' },
        h('div', { class: 'peer-note-title', text: '这是手机 App（客户端）' }),
        h('div', { class: 'folder-meta', text: '它只负责发起同步，不向电脑提供文件夹——所以这里没有"对方的文件夹"可选，也不需要选。' }),
        h('div', { class: 'folder-meta', text: '在手机上点「对比 / 一键同步」，目标就是电脑下面这些共享文件夹：' }),
        localFolders.length
          ? h('div', { class: 'folder-meta' }, localFolders.map((folder) => h('span', { class: 'tag', text: folder.name })))
          : h('div', { class: 'folder-meta warn-text', text: '但电脑还没有共享文件夹，手机那边会是空的——先点左上「我的文件夹 → 添加」。' }),
      ),
    );
    return wrap;
  }
  if (!state.remoteFolders.length) {
    wrap.append(h('div', { class: 'folder-meta', text: '对方还没有添加共享文件夹（让对方在它的界面上加一个）。' }));
    return wrap;
  }

  wrap.append(h('div', { class: 'folder-meta', text: '同步目标：' }));
  for (const folder of state.remoteFolders) {
    const selected = state.remoteFolderId === folder.id;
    wrap.append(
      h('button', {
        class: `peer-folder ${selected ? 'is-active' : ''}`,
        type: 'button',
        onclick: () => selectSyncItem(peer.id, state.localFolderId, folder.id),
      },
        icon('folder'),
        h('span', { class: 'peer-folder-main' },
          h('span', { class: 'peer-folder-name', text: folder.name }),
          h('span', { class: 'peer-folder-path', text: folder.path })),
        selected ? h('span', { class: 'tag up', text: '目标' }) : null),
    );
  }
  return wrap;
}

function renderPeers() {
  const body = document.getElementById('peerBody');
  body.replaceChildren();
  const peers = state.info?.peers || [];

  if (!peers.length) {
    body.append(
      h('div', { class: 'empty' },
        icon('devices'),
        h('p', {}, h('strong', { text: '还没有配对的对端' }), h('br'), '在同一局域网的另一台电脑上打开本工具，用它的配对码连过来。')),
    );
  }

  for (const peer of peers) {
    const isActive = state.activePeerId === peer.id;
    body.append(
      h('div', { class: 'peer' },
        h('span', { class: `dot ${peer.online ? 'online' : ''}`, title: peer.online ? '在线' : '未探测到（仍可尝试）' }),
        h('div', { class: 'peer-body' },
          h('div', { class: 'peer-name' }, peer.name, isActive ? h('span', { class: 'tag up', text: '当前' }) : null),
          h('div', { class: 'peer-url', text: peer.currentUrl || peer.url })),
        h('div', { class: 'peer-actions' },
          h('button', {
            class: 'btn small',
            type: 'button',
            disabled: peer.kind === 'client' || (isActive && state.remoteClientOnly),
            title: peer.kind === 'client' || (isActive && state.remoteClientOnly) ? '手机 App 只能由手机发起同步' : '',
            onclick: () => {
              selectSyncItem(peer.id, state.localFolderId, state.remoteFolderId);
              startScan();
            },
          }, icon('compare'), '对比'),
          h('button', { class: 'btn small ghost', type: 'button', title: '移除配对', 'aria-label': `移除 ${peer.name}`, onclick: () => removePeer(peer) }, icon('trash'))),
      ),
    );
    if (isActive) body.append(renderPeerFolders(peer));
  }

  const unpaired = (state.discovered || []).filter((item) => !peers.some((peer) => peer.id === item.id));
  if (unpaired.length) {
    body.append(h('div', { class: 'folder-meta', style: 'margin-top:12px', text: '局域网内发现：' }));
    for (const item of unpaired) {
      body.append(
        h('div', { class: 'discovered' },
          h('span', {}, `${item.name} · ${item.url.replace(/^https?:\/\//, '')}`),
          h('button', { class: 'btn small', type: 'button', onclick: () => openPairModal(item.url) }, '配对')),
      );
    }
  }

  if (state.info?.discoveryEnabled && !peers.length) {
    body.append(h('div', { class: 'folder-meta' }, '自动发现已开启，同网段的节点会出现在这里。'));
  }
}

async function removePeer(peer) {
  const ok = await confirmDialog({
    title: `移除对端「${peer.name}」`,
    message: '只删除配对关系，不会删除任何文件。需要时可以用配对码重新添加。',
    confirmText: '移除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('/api/peer-remove', { method: 'POST', body: { id: peer.id } });
    if (state.activePeerId === peer.id) {
      state.activePeerId = null;
      state.plan = null;
    }
    await refreshInfo();
    toast('已移除配对');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ------------------------------------------------------------ 渲染：计划 */

/** 同步项选择条：本机文件夹 ↔ 对端 / 对方文件夹 */
function renderSyncBar() {
  const info = state.info || {};
  const peers = info.peers || [];
  const localFolders = info.folders || [];
  const remoteFolders = state.remoteFoldersFor === state.activePeerId ? state.remoteFolders : [];
  const clientOnly = state.remoteClientOnly && state.remoteFoldersFor === state.activePeerId;
  const ready = !!(state.activePeerId && state.localFolderId && state.remoteFolderId) && !clientOnly;

  const localSelect = h('select', {
    class: 'select',
    'aria-label': '本机文件夹',
    disabled: localFolders.length < 2,
    onchange: (event) => selectSyncItem(state.activePeerId, event.target.value, state.remoteFolderId),
  });
  for (const folder of localFolders) {
    const option = h('option', { value: folder.id, text: folder.name });
    if (folder.id === state.localFolderId) option.selected = true;
    localSelect.append(option);
  }

  const peerSelect = h('select', {
    class: 'select',
    'aria-label': '对端设备',
    disabled: peers.length < 2,
    onchange: (event) => selectSyncItem(event.target.value, state.localFolderId, ''),
  });
  for (const peer of peers) {
    const option = h('option', { value: peer.id, text: peer.name });
    if (peer.id === state.activePeerId) option.selected = true;
    peerSelect.append(option);
  }

  const remoteSelect = h('select', {
    class: 'select',
    'aria-label': '对方的文件夹',
    disabled: remoteFolders.length < 2,
    onchange: (event) => selectSyncItem(state.activePeerId, state.localFolderId, event.target.value),
  });
  if (!remoteFolders.length) {
    remoteSelect.append(h('option', {
      value: '',
      text: clientOnly ? '（手机 App，无需选择）'
        : state.remoteFoldersFor === state.activePeerId ? '（对方没有共享文件夹）' : '（读取中…）',
    }));
  }
  for (const folder of remoteFolders) {
    const option = h('option', { value: folder.id, text: folder.name });
    if (folder.id === state.remoteFolderId) option.selected = true;
    remoteSelect.append(option);
  }

  const autoKey = `${state.activePeerId || ''}:${state.localFolderId || ''}:${state.remoteFolderId || ''}`;
  const autoItem = (info.autoSync?.items || []).find((item) => item.key === autoKey);
  const autoOn = !!autoItem?.enabled;
  const intervalValue = String(autoItem?.intervalSec || info.autoSync?.intervalSec || 120);

  const intervalSelect = h('select', {
    class: 'select',
    'aria-label': '自动同步间隔',
    disabled: !ready,
    onchange: (event) => toggleAutoSync(true, Number(event.target.value)),
  });
  for (const [value, label] of [[30, '30 秒'], [60, '1 分钟'], [120, '2 分钟'], [300, '5 分钟'], [900, '15 分钟']]) {
    const option = h('option', { value: String(value), text: label });
    if (String(value) === intervalValue) option.selected = true;
    intervalSelect.append(option);
  }

  return h('div', { class: 'sync-bar' },
    h('span', { class: 'sync-bar-label', text: '同步项' }),
    localSelect,
    h('span', { class: 'sync-bar-arrow', text: '↔' }),
    peerSelect,
    h('span', { class: 'sync-bar-arrow', text: '/' }),
    remoteSelect,
    h('button', {
      class: 'btn small',
      type: 'button',
      disabled: !ready,
      onclick: () => startScan(),
    }, icon('compare'), '对比'),
    h('button', {
      class: 'btn small primary',
      type: 'button',
      disabled: !ready || state.applying,
      title: '一次完成对比 + 执行（遇到冲突会停下来让你选）',
      onclick: () => oneClickSync(),
    }, icon('play'), '一键同步'),
    h('label', { class: 'switch', title: '定时自动对比并同步（冲突按修改时间：较新者胜，另一份存副本）' },
      h('input', {
        type: 'checkbox',
        checked: autoOn,
        disabled: !ready,
        onchange: (event) => toggleAutoSync(event.target.checked, Number(intervalValue)),
      }),
      h('span', { text: '自动同步' })),
    intervalSelect,
    autoItem?.lastRunAt
      ? h('span', { class: 'sync-bar-note', text: `上次 ${fmtTime(autoItem.lastRunAt)}${autoItem.lastError ? ' · 失败' : ''}` })
      : null,
  );
}

function severityOf(entry) {
  if (!isSettled(entry)) return 0;
  if (entry.kind === KIND.SAME || entry.kind === KIND.BOTH_DELETED) return 3;
  const action = actionOf(entry);
  if (!action || action === ACTION.NONE) return 2;
  return 1;
}

function renderPlan() {
  renderRemoteFiles();
  const body = document.getElementById('planBody');
  const actions = document.getElementById('planActions');
  const execBar = document.getElementById('execBar');
  body.replaceChildren();

  const info = state.info;
  if (!(info?.folders || []).length) {
    actions.hidden = true;
    execBar.hidden = true;
    const hasPeers = (info?.peers || []).length > 0;
    body.append(
      h('div', { class: 'empty' },
        icon('folder'),
        h('p', {},
          h('strong', { text: '电脑这边还没有共享文件夹' }),
          h('br'),
          hasPeers
            ? '手机 App 能同步的目标，就是这里共享出来的文件夹。先在左侧「我的文件夹」点「添加」选一个，手机那边才会出现它。'
            : '先在左侧「我的文件夹」点「添加」选一个：它既是电脑要共享出去的目录，也是手机端可选的同步目标。'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => openFolderModal() }, '添加共享文件夹')),
    );
    return;
  }
  if (!(info.peers || []).length) {
    actions.hidden = true;
    execBar.hidden = true;
    body.append(h('div', { class: 'empty' }, icon('devices'), h('p', { text: '还没有对端。点右侧「添加」，输入对方地址与配对码。' })));
    return;
  }

  // 同步项选择条：本地文件夹 ↔ 对端/对方文件夹
  body.append(renderSyncBar());

  if (state.activeJob) {
    body.append(renderProgressCard(
      state.activeJob.type === 'scan' ? '正在对比两端文件'
        : state.activeJob.type === 'sync' ? '正在一键同步' : '正在同步文件',
    ));
    if (state.activeJob.type === 'scan') {
      actions.hidden = true;
      execBar.hidden = true;
      return;
    }
  }

  if (!state.plan) {
    actions.hidden = true;
    execBar.hidden = true;
    // 任务进行中就不再叠一个"开始对比"的空状态了
    if (state.activeJob) return;

    // 对端是手机 App：电脑这边不需要选"对方的文件夹"，同步应当从手机发起
    if (state.remoteClientOnly && state.remoteFoldersFor === state.activePeerId) {
      const peerName = (info.peers || []).find((item) => item.id === state.activePeerId)?.name || '手机';
      const sharedFolders = info.folders || [];
      body.append(
        h('div', { class: 'empty' },
          icon('devices'),
          h('p', {},
            h('strong', { text: `${peerName} 是手机 App（客户端）` }),
            h('br'),
            sharedFolders.length
              ? '同步从手机发起：打开手机 App →「对方共享的文件夹」里选下面这几个之一 → 点「对比」或「一键同步」。电脑这边不需要选对方的文件夹。'
              : '但电脑还没有共享文件夹，手机那边会是空的——先在左侧「我的文件夹」点「添加」选一个。'),
          sharedFolders.length
            ? h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;justify-content:center' },
              sharedFolders.map((folder) => h('span', { class: 'tag up', text: folder.name })))
            : h('button', { class: 'btn primary', type: 'button', onclick: () => openFolderModal() }, '添加共享文件夹')),
      );
      return;
    }

    const ready = state.activePeerId && state.localFolderId && state.remoteFolderId;
    body.append(
      h('div', { class: 'empty' },
        icon('compare'),
        h('p', {}, ready
          ? '点「对比」先看清楚会发生什么，再决定要不要执行。'
          : '选好上面的同步项（本机文件夹 ↔ 对方的文件夹）后点「对比」。'),
        h('button', {
          class: 'btn primary',
          type: 'button',
          disabled: !ready,
          onclick: () => startScan(),
        }, icon('compare'), '开始对比')),
    );
    return;
  }

  const plan = state.plan;
  actions.hidden = false;
  const summary = computeOps();
  const entries = [...plan.entries].sort((a, b) => {
    const diff = severityOf(a) - severityOf(b);
    return diff !== 0 ? diff : a.path.localeCompare(b.path, 'zh-Hans-CN', { numeric: true });
  });
  const visible = state.onlyDiff
    ? entries.filter((entry) => !(entry.kind === KIND.SAME || entry.kind === KIND.BOTH_DELETED))
    : entries;
  const shown = visible.slice(0, state.rowLimit);

  body.append(
    h('div', { class: 'summary' },
      summary.upload ? h('span', { class: 'chip up' }, icon('upload'), '同步到远端 ', h('b', { text: summary.upload }), ` · ${fmtBytes(summary.bytesUp)}`) : null,
      summary.download ? h('span', { class: 'chip down' }, icon('download'), '同步到本地 ', h('b', { text: summary.download }), ` · ${fmtBytes(summary.bytesDown)}`) : null,
      summary.deleteLocal + summary.deleteRemote
        ? h('span', { class: 'chip del' }, icon('trash'), '删除 ', h('b', { text: summary.deleteLocal + summary.deleteRemote }))
        : null,
      summary.undecided ? h('span', { class: 'chip conflict' }, icon('alert'), h('b', { text: summary.undecided }), ' 个冲突待决定') : null,
      h('span', { class: 'chip' }, '一致 ', h('b', { text: summary.same })),
      h('span', { class: 'chip' }, icon('sync'),
        h('b', { text: plan.folder?.localName || '' }), ' ↔ ',
        h('b', { text: `${plan.peer?.name || ''} / ${plan.folder?.remoteName || ''}` })),
    ),
  );

  if (!visible.length) {
    body.append(h('div', { class: 'empty' }, icon('check'), h('p', { text: '两端已经完全一致，没有需要搬运的文件。' })));
  } else {
    const rows = h('div', { class: 'rows' });
    for (const entry of shown) rows.append(renderRow(entry));
    body.append(rows);
    if (visible.length > shown.length) {
      body.append(
        h('div', { class: 'folder-meta', style: 'margin-top:12px;justify-content:space-between;align-items:center' },
          h('span', { text: `还有 ${visible.length - shown.length} 项未显示` }),
          h('button', { class: 'btn small', type: 'button', onclick: () => { state.rowLimit += 600; renderPlan(); } }, '显示更多')),
      );
    }
  }

  renderExecBar(summary);
}

function renderRow(entry) {
  const meta = KIND_META[entry.kind] || { label: entry.kind, tone: '', icon: 'file' };
  const action = actionOf(entry);
  const settled = isSettled(entry);
  const tone =
    entry.kind === KIND.SAME || entry.kind === KIND.BOTH_DELETED ? ''
      : !settled ? 'conflict'
        : action === ACTION.UPLOAD ? 'up'
          : action === ACTION.DOWNLOAD ? 'down'
            : action === ACTION.DELETE_LOCAL || action === ACTION.DELETE_REMOTE ? 'del'
              : 'conflict';

  const classes = ['row'];
  if (isConflict(entry)) classes.push('is-conflict');
  if (settled && (!action || action === ACTION.NONE)) classes.push('is-skip');
  const result = state.results[entry.path];
  if (result?.ok === true) classes.push('is-done');
  if (result?.ok === false) classes.push('is-fail');

  const sizeText = entry.local && entry.remote
    ? `本地 ${fmtBytes(entry.local.size)} · 远端 ${fmtBytes(entry.remote.size)}`
    : entry.local
      ? `本地 ${fmtBytes(entry.local.size)}`
      : entry.remote
        ? `远端 ${fmtBytes(entry.remote.size)}`
        : '';

  return h('div', { class: classes.join(' '), dataset: { path: entry.path } },
    h('div', { class: `row-icon ${tone}` }, icon(result?.ok === false ? 'alert' : meta.icon)),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-path', text: entry.path }),
      h('div', { class: 'row-meta' },
        h('span', { class: `tag ${meta.tone}`, text: meta.label }),
        sizeText ? h('span', { text: sizeText }) : null,
        result?.ok === false ? h('span', { class: 'tag del', text: result.error || '失败' }) : null,
        !settled ? h('span', { class: 'tag conflict', text: '请选择' }) : null,
        entry.note ? h('span', { text: entry.note }) : null)),
    h('div', { class: 'row-actions' }, renderSeg(entry)),
  );
}

function renderSeg(entry) {
  const labels = choiceLabels(entry);
  const options = [];

  if (isConflict(entry)) {
    options.push({ value: 'keep-local', label: labels.local, tone: 'up', disabled: !entry.local });
    options.push({ value: 'keep-remote', label: labels.remote, tone: 'down', disabled: !entry.remote });
    if (entry.kind !== KIND.CONFLICT_DELETE_MODIFY) {
      options.push({ value: 'keep-both', label: '两个都留', tone: 'both', disabled: false });
    }
  } else if (entry.kind === KIND.SAME || entry.kind === KIND.BOTH_DELETED) {
    options.push({ value: 'skip', label: '不动', tone: '', disabled: true });
  } else if (entry.kind === KIND.NEW_LOCAL) {
    options.push({ value: 'keep-local', label: '同步到远端', tone: 'up' });
  } else if (entry.kind === KIND.NEW_REMOTE) {
    options.push({ value: 'keep-remote', label: '同步到本地', tone: 'down' });
  } else if (entry.kind === KIND.DELETED_REMOTE || entry.kind === KIND.DELETED_LOCAL) {
    options.push({ value: 'keep-local', label: '保留（补回远端）', tone: 'up' });
    options.push({ value: 'keep-remote', label: '删除', tone: 'del' });
  } else {
    options.push({ value: 'keep-local', label: '同步到远端', tone: 'up' });
    options.push({ value: 'keep-remote', label: '同步到本地', tone: 'down' });
  }
  if (!(entry.kind === KIND.SAME || entry.kind === KIND.BOTH_DELETED)) {
    options.push({ value: 'skip', label: '跳过', tone: '' });
  }

  const current = choiceOf(entry);
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': `${entry.path} 的处理方式` });
  for (const option of options) {
    const pressed = current === option.value;
    seg.append(
      h('button', {
        class: `seg-btn ${pressed ? OPTION_CLASS[option.tone] || option.tone || '' : ''}`,
        type: 'button',
        'aria-pressed': pressed ? 'true' : 'false',
        disabled: option.disabled,
        dataset: { choice: option.value, path: entry.path },
        text: option.label,
      }),
    );
  }
  return seg;
}

function renderExecBar(summary) {
  const bar = document.getElementById('execBar');
  const summaryNode = document.getElementById('execSummary');
  const applyBtn = document.getElementById('applyBtn');
  const allow = document.getElementById('allowDeletes');
  bar.hidden = false;

  const deleting = summary.deleteLocal + summary.deleteRemote;
  const parts = [];
  if (summary.upload) parts.push(`同步到远端 ${summary.upload} 个（${fmtBytes(summary.bytesUp)}）`);
  if (summary.download) parts.push(`同步到本地 ${summary.download} 个（${fmtBytes(summary.bytesDown)}）`);
  if (deleting) parts.push(state.allowDeletes ? `删除 ${deleting} 个` : `删除 ${deleting} 个（未开启）`);

  summaryNode.replaceChildren(
    ...[
      parts.length ? h('span', {}, parts.join(' · ')) : h('span', { text: '没有需要执行的改动' }),
      summary.undecided ? h('span', { class: 'warn', text: `　· ${summary.undecided} 个冲突还没决定（手动模式下需要你自己选）` }) : null,
      state.planStale ? h('span', { class: 'warn', text: '　· 自动同步刚改动过，请重新对比' }) : null,
      state.finished ? h('span', { class: 'warn', text: '　· 本次已执行，建议重新对比' }) : null,
    ].filter(Boolean),
  );

  allow.checked = state.allowDeletes;
  allow.disabled = deleting === 0 || state.applying;
  applyBtn.disabled = state.applying || summary.undecided > 0 || opTotal() === 0 || state.planStale;
  applyBtn.replaceChildren(icon(state.applying ? 'stop' : 'play'), state.applying ? '取消执行' : '执行同步');
}

function renderProgressCard(title) {
  const job = state.activeJob;
  const progress = state.progress || { index: 0, total: 0 };
  const percent = progress.total ? Math.min(100, Math.round((progress.index / progress.total) * 100)) : 0;
  const card = h('div', { class: 'progress-card' },
    h('div', { class: 'progress-head' },
      h('span', {}, h('b', { text: title }), job?.stage ? ` · ${job.stage}` : ''),
      h('span', { text: progress.total ? `${progress.index}/${progress.total}` : '准备中' })),
    h('div', { class: `bar ${progress.total ? '' : 'indeterminate'}`, role: 'progressbar', 'aria-valuenow': String(percent), 'aria-valuemin': '0', 'aria-valuemax': '100' },
      h('span', { style: `width:${progress.total ? Math.max(2, percent) : 34}%` })),
  );
  if (state.logLines.length) {
    const log = h('div', { class: 'log' });
    for (const line of state.logLines.slice(-40)) {
      log.append(h('div', {}, h('span', { class: line.ok === false ? 'fail' : 'ok', text: line.ok === false ? '×' : '·' }), h('span', { text: line.text })));
    }
    card.append(log);
  }
  return card;
}

/* ------------------------------------------------------------ 渲染：历史 */

function renderHistory() {
  const body = document.getElementById('historyBody');
  body.replaceChildren();
  if (!state.history.length) {
    body.append(h('div', { class: 'folder-meta', text: '还没有同步记录。' }));
    return;
  }
  const wrap = h('div', { class: 'history' });
  for (const item of state.history.slice(0, 8)) {
    wrap.append(
      h('div', { class: 'history-item' },
        h('span', { class: 'time', text: fmtTime(item.at) }),
        h('span', {}, h('span', { class: 'name', text: item.peerName || '对端' }), ` · 成功 ${item.ok} 项${item.failed ? ` · 失败 ${item.failed} 项` : ''}`),
        h('span', { text: fmtBytes(item.bytes) })),
    );
  }
  body.append(wrap);
}

/* ------------------------------------------------------------ 事件与动作 */

async function refreshInfo() {
  const info = await api('/api/info');
  state.info = info;

  if (!state.activePeerId || !(info.peers || []).some((peer) => peer.id === state.activePeerId)) {
    state.activePeerId = info.peers?.[0]?.id || null;
  }
  if (!state.localFolderId || !(info.folders || []).some((folder) => folder.id === state.localFolderId)) {
    state.localFolderId = info.folders?.[0]?.id || '';
  }

  document.getElementById('nodePill').hidden = false;
  document.getElementById('nodePill').textContent = `${info.name} · :${info.port}`;
  renderSelf();
  renderLocal();
  renderPeers();
  // 已有对比结果时不要每次轮询都重画（会打断滚动），只在空状态下刷新
  if (!state.plan) renderPlan();

  if (state.activePeerId) await loadRemoteFolders(state.activePeerId).catch(() => {});
  saveSyncItem();
}

async function refreshDiscovered() {
  try {
    const data = await api('/api/discover');
    state.discovered = data.peers || [];
    renderPeers();
  } catch {
    // 自动发现失败不影响主流程
  }
}

async function refreshHistory() {
  try {
    const data = await api('/api/history');
    state.history = data.history || [];
    renderHistory();
  } catch {
    // 历史只是展示，失败可忽略
  }
}

async function startScan(overrides = {}) {
  if (state.applying) {
    toast('正在执行同步，请稍候', 'warn');
    return;
  }
  const folders = state.info?.folders || [];
  if (!folders.length) {
    toast('先添加要同步的文件夹', 'warn');
    openFolderModal();
    return;
  }

  if (overrides.peerId) state.activePeerId = overrides.peerId;
  if (overrides.localFolderId) state.localFolderId = overrides.localFolderId;
  if (overrides.remoteFolderId) state.remoteFolderId = overrides.remoteFolderId;

  if (!state.activePeerId) {
    toast('先与对端配对', 'warn');
    return;
  }
  if (!state.localFolderId) {
    toast('先选择本机文件夹', 'warn');
    return;
  }
  if (!state.remoteFolderId) {
    await loadRemoteFolders(state.activePeerId);
    state.remoteFolderId = state.remoteFolders?.[0]?.id || '';
  }
  if (!state.remoteFolderId) {
    toast(
      state.remoteClientOnly
        ? '这是手机 App：请在手机上发起同步，电脑这边不需要选对方的文件夹'
        : '对方还没有共享文件夹',
      'warn',
    );
    return;
  }

  state.plan = null;
  state.choices = {};
  state.results = {};
  state.logLines = [];
  state.finished = false;
  state.progress = { index: 0, total: 0 };
  state.activeJob = { type: 'scan', id: null, stage: '正在连接对端' };
  saveSyncItem();
  renderLocal();
  renderPeers();
  renderPlan();

  try {
    const { jobId } = await api('/api/jobs/scan', {
      method: 'POST',
      body: {
        peerId: state.activePeerId,
        localFolderId: state.localFolderId,
        remoteFolderId: state.remoteFolderId,
      },
    });
    // 打小文件夹时后端可能先推完 plan 事件（activeJob 已被清空），这里不能盲赋值
    if (state.activeJob && state.activeJob.id === null) state.activeJob.id = jobId;
    saveSyncItem();
    watchJob(jobId);
  } catch (err) {
    state.activeJob = null;
    renderPlan();
    toast(err.message, 'error');
  }
}

/** 开关当前同步项的自动同步（服务端定时跑，关掉浏览器也照跑） */
async function toggleAutoSync(enabled, intervalSec) {
  if (!state.activePeerId || !state.localFolderId || !state.remoteFolderId) {
    toast('先选好同步项', 'warn');
    return;
  }
  try {
    const data = await api('/api/auto-sync', {
      method: 'POST',
      body: {
        peerId: state.activePeerId,
        localFolderId: state.localFolderId,
        remoteFolderId: state.remoteFolderId,
        enabled: !!enabled,
        intervalSec,
      },
    });
    if (state.info) state.info.autoSync = data.autoSync;
    renderPlan();
    const label = { 30: '30 秒', 60: '1 分钟', 120: '2 分钟', 300: '5 分钟', 900: '15 分钟' }[intervalSec] || `${intervalSec} 秒`;
    toast(enabled ? `已开启自动同步：每 ${label} 一次（冲突按修改时间处理）` : '已关闭自动同步');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** 一键同步：对比 + 执行合成一步；遇到冲突会停下来让你选 */
async function oneClickSync() {
  if (state.applying) {
    toast('正在同步中，请稍候', 'warn');
    return;
  }
  if (!state.activePeerId || !state.localFolderId || !state.remoteFolderId) {
    toast('先选好同步项', 'warn');
    return;
  }

  state.applying = true;
  state.finished = false;
  state.planStale = false;
  state.logLines = [];
  state.plan = null;
  state.choices = {};
  state.results = {};
  state.progress = { index: 0, total: 0 };
  state.activeJob = { type: 'sync', id: null, stage: '正在对比' };
  renderLocal();
  renderPlan();

  try {
    const { jobId } = await api('/api/jobs/sync', {
      method: 'POST',
      body: {
        peerId: state.activePeerId,
        localFolderId: state.localFolderId,
        remoteFolderId: state.remoteFolderId,
        allowDeletes: state.allowDeletes,
      },
    });
    if (state.activeJob && state.activeJob.id === null) state.activeJob.id = jobId;
    watchJob(jobId);
  } catch (err) {
    state.applying = false;
    state.activeJob = null;
    renderPlan();
    toast(err.message, 'error');
  }
}

async function doApply() {  if (!state.plan) return;
  const summary = computeOps();
  if (summary.undecided > 0) {
    toast(`还有 ${summary.undecided} 个冲突需要先决定怎么处理`, 'warn');
    return;
  }
  const deleting = summary.deleteLocal + summary.deleteRemote;
  if (deleting > 0 && !state.allowDeletes) {
    toast('有删除操作但未开启「同步删除操作」', 'warn');
    return;
  }
  if (deleting > 0 && state.allowDeletes) {
    const ok = await confirmDialog({
      title: '确认删除这些文件？',
      message: `将删除 ${deleting} 个文件，删除不可撤销（不进回收站）。确定继续吗？`,
      confirmText: '确认删除并同步',
      danger: true,
    });
    if (!ok) return;
  }

  state.applying = true;
  state.finished = false;
  state.logLines = [];
  state.progress = { index: 0, total: opTotal() };
  state.activeJob = { type: 'apply', id: null, stage: '正在准备' };
  renderPlan();

  try {
    const { jobId } = await api('/api/jobs/apply', {
      method: 'POST',
      body: {
        scanJobId: state.plan.jobId,
        choices: state.choices,
        allowDeletes: state.allowDeletes,
      },
    });
    // 同理：小任务可能在 POST 返回前就推完了 SSE，此时 activeJob 已被收尾，不能盲赋值
    if (state.activeJob && state.activeJob.id === null) state.activeJob.id = jobId;
    watchJob(jobId);
  } catch (err) {
    state.applying = false;
    state.activeJob = null;
    renderPlan();
    toast(err.message, 'error');
  }
}

async function cancelJob() {
  if (!state.activeJob?.id) return;
  try {
    await api('/api/jobs/cancel', { method: 'POST', body: { jobId: state.activeJob.id } });
    toast('已请求取消，正在收尾', 'warn');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* 任务观察：优先用 SSE 推送，同时用低频轮询兜底，避免事件丢了界面卡住 */
const watched = new Map();

function watchJob(jobId) {
  if (!jobId || watched.has(jobId)) return;
  const entry = { id: jobId, done: false };
  watched.set(jobId, entry);

  const poll = setInterval(async () => {
    if (entry.done) {
      clearInterval(poll);
      return;
    }
    try {
      const job = await api(`/api/jobs?id=${encodeURIComponent(jobId)}`);
      if (job.status !== 'running') {
        clearInterval(poll);
        finishJob(jobId, job);
      }
    } catch {
      // 网络抖动时继续轮询
    }
  }, 1600);

  setTimeout(() => {
    clearInterval(poll);
    watched.delete(jobId);
  }, 30 * 60 * 1000);
}

function finishJob(jobId, job) {
  const entry = watched.get(jobId);
  if (entry?.done) return;
  if (entry) entry.done = true;
  watched.delete(jobId);

  const isActive = state.activeJob?.id === jobId || state.activeJob?.id === null;
  if (!isActive) return;

  if (job.status === 'error') {
    state.applying = false;
    state.activeJob = null;
    renderPlan();
    toast(job.error || '任务失败', 'error');
    return;
  }
  if (job.status === 'cancelled') {
    state.applying = false;
    state.activeJob = null;
    renderPlan();
    toast('已取消', 'warn');
    return;
  }

  if (job.type === 'scan') {
    state.plan = job.result;
    state.activeJob = null;
    state.planStale = false;
    seedRemoteFilesFromPlan(job.result);
    renderLocal();
    renderPlan();
    const summary = job.result?.summary;
    if (summary && summary.total === 0) toast('这个文件夹是空的');
    return;
  }

  if (job.type === 'sync') {
    state.applying = false;
    state.activeJob = null;
    const result = job.result || {};
    if (result.applied === false) {
      // 有事需要你拍板：切回普通对比，让你逐条选
      toast(`有 ${result.conflicts} 个冲突需要你先选，已切换成手动模式`, 'warn');
      setTimeout(() => startScan(), 300);
      return;
    }
    state.finished = true;
    renderPlan();
    refreshHistory();
    const failed = result.apply?.failed || 0;
    const done = result.apply?.ok || 0;
    toast(done ? `一键同步完成：${done} 项已处理` : '一键同步完成：两端已经一致', failed ? 'warn' : 'ok');
    setTimeout(() => startScan(), 600);
    return;
  }

  if (job.type === 'apply') {
    state.applying = false;
    state.activeJob = null;
    state.finished = true;
    const result = job.result || {};
    renderPlan();
    refreshHistory();
    const failed = result.failed || 0;
    toast(failed ? `同步完成，${result.ok} 项成功、${failed} 项失败` : `同步完成，${result.ok} 项操作已生效`, failed ? 'warn' : 'ok');
    if (failed && result.errors?.length) {
      for (const item of result.errors.slice(0, 3)) toast(`${item.path}：${item.message}`, 'error');
    }
    if (state.activePeerId) {
      // 延迟重扫：期间用户可能已经切了同步项，别拿旧项去扫（会弹出莫名其妙的提示）
      const itemAtFinish = `${state.activePeerId}:${state.localFolderId}:${state.remoteFolderId}`;
      setTimeout(() => {
        if (`${state.activePeerId}:${state.localFolderId}:${state.remoteFolderId}` === itemAtFinish) startScan();
      }, 600);
    }
  }
}

function handleEvent(event) {
  if (event.jobId && state.activeJob?.id && event.jobId !== state.activeJob.id) return;

  switch (event.type) {
    case 'plan':
      if (event.plan) {
        state.plan = event.plan;
        state.activeJob = null;
        state.planStale = false;
        seedRemoteFilesFromPlan(event.plan);
        renderLocal();
        renderPlan();
      }
      break;
    case 'auto-run': {
      state.lastAuto = event;
      const same = event.peerId === state.activePeerId
        && event.localFolderId === state.localFolderId
        && event.remoteFolderId === state.remoteFolderId;
      if (event.error) {
        toast(`自动同步失败：${event.error}`, 'error');
      } else if (event.ok || event.failed) {
        toast(`自动同步：${event.ok} 项已更新`, 'ok');
      }
      if (same) {
        // 自动同步动过文件，手上这份对比结果就过期了，必须重新对比才能执行
        state.planStale = true;
        renderPlan();
      }
      break;
    }
    case 'settings':
      refreshInfo().catch(() => {});
      break;
    case 'stage':
      if (state.activeJob) {
        state.activeJob.stage = event.message || event.stage;
        renderPlan();
      }
      break;
    case 'scan-progress':
      state.progress = { index: event.count || 0, total: 0 };
      break;
    case 'hash-progress':
      state.progress = { index: event.done || 0, total: event.total || 0 };
      if (state.activeJob) state.activeJob.type = 'scan';
      renderPlan();
      break;
    case 'file-start':
      state.progress = { index: event.index || 0, total: event.total || 0 };
      if (state.activeJob) state.activeJob.stage = `${event.path}`;
      renderPlan();
      break;
    case 'file-done':
      state.results[event.path] = { ok: event.ok, error: event.error };
      state.logLines.push({ text: `${event.ok ? '完成' : '失败'} ${event.path}${event.error ? `：${event.error}` : ''}`, ok: event.ok });
      renderPlan();
      break;
    case 'log':
      state.logLines.push({ text: event.message });
      break;
    case 'done':
      break;
    case 'peers':
      refreshInfo();
      break;
    case 'folders':
      refreshInfo();
      break;
    case 'folder-changed':
      refreshInfo();
      break;
    case 'pairing-code':
      refreshInfo();
      break;
    case 'discovered':
      refreshDiscovered();
      break;
    default:
      break;
  }
}

function connectEvents() {
  if (!boot.token) return;
  try {
    const source = new EventSource(`/api/events?token=${encodeURIComponent(boot.token)}`);
    source.onmessage = (message) => {
      let data = null;
      try {
        data = JSON.parse(message.data);
      } catch {
        return;
      }
      if (data) handleEvent(data);
    };
    source.onerror = () => {
      // 浏览器会自动重连，这里不做处理
    };
  } catch {
    // 老浏览器不支持 EventSource 时靠轮询兜底
  }
}

/* ------------------------------------------------------------ 弹窗 */

let closeActiveModal = null;

function openModal({ title, body, footer, wide = false }) {
  const root = document.getElementById('modalRoot');
  const previous = document.activeElement;

  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    closeActiveModal = null;
    if (previous instanceof HTMLElement) previous.focus();
  };

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (event) => {
    if (event.target === backdrop) close();
  } },
  h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' },
      h('h2', { text: title }),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': '关闭', onclick: close }, icon('x'))),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null));

  document.addEventListener('keydown', onKey);
  root.append(backdrop);
  closeActiveModal = close;
  const focusable = backdrop.querySelector('input, button, textarea, [tabindex]');
  if (focusable instanceof HTMLElement) setTimeout(() => focusable.focus(), 30);
  return close;
}

function confirmDialog({ title, message, confirmText = '确定', danger = false }) {
  return new Promise((resolve) => {
    const close = openModal({
      title,
      body: h('p', { style: 'margin:0;color:var(--text-dim);font-size:13px', text: message }),
      footer: h('div', { style: 'display:flex;gap:8px' },
        h('button', { class: 'btn', type: 'button', onclick: () => { close(); resolve(false); } }, '取消'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', onclick: () => { close(); resolve(true); } }, confirmText)),
    });
  });
}

/* 文件夹选择器：不用系统对话框，直接在本机后端浏览目录，跨平台一致 */
async function openFolderModal(startPath) {
  const known = state.info?.folders || [];
  let current = startPath || known[known.length - 1]?.path || '';
  let selected = '';

  const pathBar = h('div', { class: 'browser-path', text: current || '选择一个驱动器' });
  const list = h('div', { class: 'browser-list' });
  const drivesRow = h('div', { class: 'folder-meta', style: 'margin-top:8px' });
  const confirmBtn = h('button', { class: 'btn primary', type: 'button' }, '添加这个文件夹');
  const upBtn = h('button', { class: 'btn small', type: 'button' }, icon('chevron'), '上一级');
  const manual = h('input', { type: 'text', placeholder: '也可以直接粘贴完整路径，例如 D:\\工作\\共享', 'aria-label': '完整路径' });

  const load = async (target) => {
    list.replaceChildren(h('div', { class: 'folder-meta', text: '读取中…' }));
    try {
      const data = await api(`/api/browse?path=${encodeURIComponent(target || '')}`);
      current = data.path || '';
      pathBar.textContent = current || '选择一个驱动器';

      list.replaceChildren();
      if (!current) {
        for (const drive of data.drives || []) {
          list.append(h('button', { class: 'browser-item', type: 'button', onclick: () => load(drive) }, icon('drive'), drive));
        }
        drivesRow.replaceChildren(h('span', { text: '点一个驱动器开始浏览' }));
        selected = '';
        manual.value = '';
        confirmBtn.disabled = true;
        return;
      }

      if (!(data.dirs || []).length) list.append(h('div', { class: 'folder-meta', text: '这个文件夹里没有子文件夹' }));
      for (const dir of data.dirs || []) {
        list.append(h('button', { class: 'browser-item', type: 'button', onclick: () => load(dir.path) }, icon('folder'), dir.name));
      }
      drivesRow.replaceChildren(
        ...(data.drives || []).map((drive) => h('button', { class: 'btn small ghost', type: 'button', onclick: () => load(drive) }, drive)),
      );
      upBtn.disabled = !data.parent;
      upBtn.onclick = () => load(data.parent || '');
      selected = current;
      // 关键：浏览到哪，输入框就跟着到哪，否则确认时又用回旧路径（换不了文件夹的老 bug）
      manual.value = current;
      confirmBtn.disabled = false;
    } catch (err) {
      list.replaceChildren(h('div', { class: 'folder-meta', text: err.message }));
    }
  };

  manual.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      load(manual.value.trim());
    }
  });

  const close = openModal({
    title: '添加要同步的文件夹',
    wide: true,
    body: h('div', {},
      h('div', { class: 'browser-bar' }, upBtn, pathBar),
      list,
      drivesRow,
      h('div', { class: 'field', style: 'margin-top:16px;margin-bottom:0' },
        h('label', { text: '完整路径' }),
        manual,
        h('div', { class: 'hint', text: '可以添加多个文件夹，每个都能单独和对方某个文件夹同步' })),
    ),
    footer: h('div', { style: 'display:flex;gap:8px' },
      h('button', { class: 'btn', type: 'button', onclick: () => close() }, '取消'),
      confirmBtn),
  });

  confirmBtn.disabled = true;
  confirmBtn.addEventListener('click', async () => {
    const target = (manual.value || selected || '').trim();
    if (!target) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = '添加中…';
    try {
      const result = await api('/api/folders', { method: 'POST', body: { path: target } });
      close();
      state.plan = null;
      state.choices = {};
      state.localFolderId = result.folder.id;
      await refreshInfo();
      toast(`已添加文件夹：${result.folder.name}`);
    } catch (err) {
      toast(err.message, 'error');
      confirmBtn.disabled = false;
      confirmBtn.textContent = '添加这个文件夹';
    }
  });

  await load(current);
}

async function openPairModal(presetUrl = '') {
  const urlInput = h('input', { type: 'text', placeholder: 'http://192.168.1.5:47800', 'aria-label': '对端地址' });
  urlInput.value = presetUrl || '';
  const codeInput = h('input', { type: 'text', placeholder: '6 位数字', inputmode: 'numeric', maxlength: '6', 'aria-label': '配对码' });

  const submit = async () => {
    const url = urlInput.value.trim();
    const code = codeInput.value.trim();
    if (!url) return toast('请填写对方地址', 'warn');
    if (!/^\d{6}$/.test(code)) return toast('配对码是 6 位数字', 'warn');
    confirmBtn.disabled = true;
    confirmBtn.textContent = '连接中…';
    try {
      const { peer } = await api('/api/pair-peer', { method: 'POST', body: { url, code } });
      close();
      state.activePeerId = peer.id;
      state.remoteFolders = [];
      state.remoteFoldersFor = '';
      state.remoteFolderId = '';
      state.plan = null;
      await refreshInfo();
      await refreshHistory();
      toast(`已与「${peer.name}」配对`);
      if ((state.info?.folders || []).length) await startScan();
      else openFolderModal();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = '连接并配对';
    }
  };

  const confirmBtn = h('button', { class: 'btn primary', type: 'button', onclick: submit }, '连接并配对');

  const close = openModal({
    title: '添加对端设备',
    body: h('div', {},
      h('div', { class: 'steps' },
        h('span', { class: 'step' }, h('b', { text: '1' }), '对方打开本工具'),
        h('span', { class: 'step' }, h('b', { text: '2' }), '填地址与配对码'),
        h('span', { class: 'step' }, h('b', { text: '3' }), '开始对比')),
      h('div', { class: 'field' },
        h('label', { text: '对方地址（对方界面「本机」里能看到）' }),
        urlInput,
        h('div', { class: 'hint', text: '同一台电脑测试时可以用 http://127.0.0.1:端口' })),
      h('div', { class: 'field', style: 'margin-bottom:0' },
        h('label', { text: '对方配对码' }),
        codeInput,
        h('div', { class: 'hint', text: '对方界面左侧「本机」卡片里那 6 位数字，输一次即可双向同步' })),
    ),
    footer: h('div', { style: 'display:flex;gap:8px' },
      h('button', { class: 'btn', type: 'button', onclick: () => close() }, '取消'),
      confirmBtn),
  });
}

function openRenameModal() {
  const input = h('input', { type: 'text', value: state.info?.name || '', 'aria-label': '设备名称', maxlength: '40' });
  const submit = async () => {
    try {
      await api('/api/name', { method: 'POST', body: { name: input.value.trim() } });
      close();
      await refreshInfo();
      toast('设备名已更新');
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });
  const close = openModal({
    title: '修改设备名',
    body: h('div', { class: 'field', style: 'margin-bottom:0' }, h('label', { text: '显示名称' }), input,
      h('div', { class: 'hint', text: '会出现在对方设备的对端列表里' })),
    footer: h('div', { style: 'display:flex;gap:8px' },
      h('button', { class: 'btn', type: 'button', onclick: () => close() }, '取消'),
      h('button', { class: 'btn primary', type: 'button', onclick: submit }, '保存')),
  });
}

function openHelpModal() {
  const section = (title, text) => h('div', { style: 'margin-bottom:16px' },
    h('h3', { style: 'font-size:13px;margin-bottom:4px', text: title }),
    h('p', { style: 'margin:0;color:var(--text-dim);font-size:13px' }, text));

  openModal({
    title: '使用说明',
    wide: true,
    body: h('div', {},
      section('1. 两台电脑都要打开本工具', '双击「启动.bat」会启动服务并自动打开浏览器。另一台电脑从网盘或 U 盘拷一份同样的文件夹，同样双击启动。'),
      section('2. 各自添加要共享的文件夹（可以加多个）', '「我的文件夹 → 添加」选目录，重复添加同一路径会自动去重；行尾 × 只是取消共享，不会删文件。'),
      section('3. 配对只需一次', '在 A 的界面点「添加」，填 B 的地址和 B 显示的 6 位配对码。配对会双向交换令牌，之后两边都能主动发起同步。'),
      section('4. 选同步项', '一个同步项 = 本机某个文件夹 ↔ 某台对端 / 对方的某个文件夹。在「对比结果」顶部的下拉里选，两条线互不干扰。'),
      section('5. 先对比，再执行', '点「对比」只做检查，不会改动任何文件。看清「同步到远端 / 同步到本地 / 删除」清单后再点「执行同步」。'),
      section('6. 只想拿对方一个文件', '右下角「远端文件」卡片里可以直接点「下载」——只存到浏览器下载目录，不改本机同步文件夹、不进基线；要整包就拿「打包下载全部」。'),
      section('7. 冲突由你决定', '同一个文件两端都改过时，会显示成冲突，可选：保留本地、保留远端、两个都留（本地版本为准，对方旧版本自动另存为「远端副本」）。'),
      section('8. 删除默认关闭', '删除是不可撤销的，必须先勾选「同步删除操作」并二次确认，才会把删除同步到对面。'),
      section('9. 没装 Node 的电脑 / 手机', '用浏览器访问 http://本机IP:端口/lite ：可以推文件、上传整个文件夹的 zip（服务端解包），或者把对方文件打包下载。'),
      h('p', { style: 'font-size:12px;color:var(--text-mute);margin:20px 0 0' },
        '数据保存在本目录的 data 文件夹；删掉它等于忘记所有配对与同步记录（不会动你的文件）。'),
    ),
    footer: h('button', { class: 'btn primary', type: 'button', onclick: () => closeActiveModal?.() }, '知道了'),
  });
}

/* ------------------------------------------------------------ 主题 */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = document.getElementById('themeBtn');
  btn.replaceChildren(icon(theme === 'dark' ? 'moon' : 'sun'));
  try {
    localStorage.setItem('sync-theme', theme);
  } catch {
    // 隐私模式下写不了 localStorage，忽略
  }
}

/* ---------------------------------------------- 远端文件（自由下载，不参与同步） */

function remoteTarget() {
  if (!state.activePeerId || !state.remoteFolderId) return null;
  return { peerId: state.activePeerId, folderId: state.remoteFolderId };
}

function downloadUrl(target, rel) {
  const query = new URLSearchParams({
    peerId: target.peerId,
    folderId: target.folderId,
    path: rel,
    token: boot.token,
  });
  return `/api/peer/download?${query.toString()}`;
}

function remoteZipUrl(target) {
  const query = new URLSearchParams({ peerId: target.peerId, folderId: target.folderId, token: boot.token });
  return `/api/peer/download-zip?${query.toString()}`;
}

function fmtMtime(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 对比结果里本来就带着远端清单，直接拿来用，不必再请求一次 */
function seedRemoteFilesFromPlan(plan) {
  if (!plan || !Array.isArray(plan.entries) || !state.activePeerId || !state.remoteFolderId) return;
  const files = plan.entries
    .filter((entry) => entry.remote)
    .map((entry) => ({ path: entry.path, size: entry.remote.size, mtimeMs: entry.remote.mtimeMs }));
  state.remoteFiles = files.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN', { numeric: true }));
  state.remoteFilesFor = `${state.activePeerId}|${state.remoteFolderId}`;
  state.remoteFilesError = '';
  state.remoteFilesLoading = false;
  renderRemoteFiles();
}

async function loadRemoteFiles(force = false) {
  const body = document.getElementById('remoteFilesBody');
  const target = remoteTarget();
  if (!target) {
    state.remoteFiles = null;
    state.remoteFilesFor = '';
    renderRemoteFiles();
    return;
  }
  const key = `${target.peerId}|${target.folderId}`;
  if (!force && state.remoteFilesFor === key && state.remoteFiles) {
    renderRemoteFiles();
    return;
  }
  state.remoteFilesFor = key;
  state.remoteFiles = null;
  state.remoteFilesError = '';
  state.remoteFilesLoading = true;
  renderRemoteFiles();
  try {
    const query = new URLSearchParams({ peerId: target.peerId, folderId: target.folderId });
    const data = await api(`/api/peer-listing?${query.toString()}`);
    if (state.remoteFilesFor !== key) return;
    state.remoteFiles = Array.isArray(data.files) ? data.files : [];
  } catch (err) {
    if (state.remoteFilesFor !== key) return;
    state.remoteFiles = null;
    state.remoteFilesError = err.message;
  } finally {
    if (state.remoteFilesFor === key) state.remoteFilesLoading = false;
    renderRemoteFiles();
    void body;
  }
}

function renderRemoteFiles() {
  const body = document.getElementById('remoteFilesBody');
  if (!body) return;
  const zipBtn = document.getElementById('remoteZipBtn');
  const target = remoteTarget();
  const key = target ? `${target.peerId}|${target.folderId}` : '';
  // 换了同步项就不能再显示上一个对端的清单
  const files = target && state.remoteFilesFor === key ? state.remoteFiles : null;

  if (zipBtn) {
    if (target && files && files.length) {
      zipBtn.href = remoteZipUrl(target);
      zipBtn.hidden = false;
    } else {
      zipBtn.hidden = true;
    }
  }

  if (!target) {
    body.replaceChildren(
      h('div', { class: 'empty small' },
        h('p', { text: '选好同步项（对端 + 对方的文件夹）后，这里可以浏览并下载对方的文件。' }),
        h('p', { class: 'folder-meta', text: '下载只是把文件存到浏览器的下载目录，不会改动本机的同步文件夹，也不会进基线。' })),
    );
    return;
  }
  if (state.remoteFilesLoading) {
    body.replaceChildren(h('div', { class: 'folder-meta', text: '正在读取对方的文件列表…' }));
    return;
  }
  if (state.remoteFilesError) {
    body.replaceChildren(
      h('div', { class: 'empty small' },
        h('p', { text: `读取失败：${state.remoteFilesError}` }),
        h('button', { class: 'btn small', type: 'button', onclick: () => loadRemoteFiles(true) }, '重试')),
    );
    return;
  }
  if (!state.remoteFiles || state.remoteFilesFor !== key) {
    body.replaceChildren(
      h('div', { class: 'empty small' },
        h('p', { text: '点「刷新列表」读取对方的文件；或者先点「对比」，对比时会顺带取到清单。' })),
    );
    return;
  }
  if (!state.remoteFiles.length) {
    body.replaceChildren(h('div', { class: 'folder-meta', text: '对方这个文件夹里没有文件。' }));
    return;
  }

  const shown = state.remoteFiles.slice(0, 400);
  const rows = shown.map((file) =>
    h('div', { class: 'file-row' },
      h('div', { class: 'file-main' },
        h('div', { class: 'file-path', text: file.path }),
        h('div', { class: 'file-meta', text: `${fmtBytes(file.size)}${file.mtimeMs ? ` · ${fmtMtime(file.mtimeMs)}` : ''}` })),
      h('a', {
        class: 'btn small',
        href: downloadUrl(target, file.path),
        download: file.path.split('/').pop() || 'download',
      }, icon('download'), '下载')));

  if (state.remoteFiles.length > shown.length) {
    rows.push(h('div', { class: 'folder-meta' }, `只显示前 ${shown.length} 个，共 ${state.remoteFiles.length} 个文件。需要全部的话用「打包下载全部」。`));
  }
  body.replaceChildren(...rows);
}

/* ------------------------------------------------------------ 绑定与启动 */

function bind() {
  document.getElementById('pickFolderBtn').addEventListener('click', () => openFolderModal());
  document.getElementById('addPeerBtn').addEventListener('click', () => openPairModal());
  document.getElementById('helpBtn').addEventListener('click', openHelpModal);
  document.getElementById('rescanBtn').addEventListener('click', () => {
    if (state.activePeerId && state.localFolderId && state.remoteFolderId) startScan();
    else toast('先选好本机文件夹、对端和对方的文件夹', 'warn');
  });
  document.getElementById('remoteFilesRefresh').addEventListener('click', () => loadRemoteFiles(true));
  document.getElementById('onlyDiff').addEventListener('change', (event) => {
    state.onlyDiff = event.target.checked;
    state.rowLimit = 400;
    renderPlan();
  });
  document.getElementById('allowDeletes').addEventListener('change', (event) => {
    state.allowDeletes = event.target.checked;
    renderExecBar(computeOps());
  });
  document.getElementById('applyBtn').addEventListener('click', () => {
    if (state.applying) cancelJob();
    else doApply();
  });
  document.getElementById('themeBtn').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  // 行内分段按钮：事件委托，避免给每一行挂监听
  document.getElementById('planBody').addEventListener('click', (event) => {
    const target = event.target.closest('[data-choice]');
    if (!target || target.disabled) return;
    const { choice, path } = target.dataset;
    state.choices[path] = choice;
    renderPlan();
  });
}

async function main() {
  let savedTheme = 'dark';
  try {
    savedTheme = localStorage.getItem('sync-theme') || 'dark';
  } catch {
    savedTheme = 'dark';
  }
  applyTheme(savedTheme);

  if (!boot.token || !boot.loopback) {
    document.getElementById('remoteGate').hidden = false;
    return;
  }

  bind();
  document.getElementById('layout').hidden = false;
  // 便于自动化脚本与排障时观察界面状态（只读挂载，不影响逻辑）
  window.__state = state;
  restoreSyncItem();

  try {
    await refreshInfo();
    await refreshHistory();
    renderPlan();
    connectEvents();
    refreshDiscovered();
    setInterval(refreshDiscovered, 5000);
    setInterval(() => {
      if (!document.hidden) refreshInfo().catch(() => {});
    }, 30000);
  } catch (err) {
    toast(err.message, 'error');
    document.getElementById('layout').hidden = true;
    document.getElementById('remoteGate').hidden = false;
  }
}

main();
