/**
 * 差异引擎（纯函数，Node 与浏览器共用）
 * ------------------------------------------------------------------
 * 目标：给定「本地清单 + 远端清单 + 上次同步基线」，判定每个相对路径该怎么处理。
 * 输入：三份 plain object（path -> stat），stat 至少含 size / mtimeMs，可选 sig / hash。
 * 输出：可执行条目数组；冲突条目不带默认动作，交给使用者选择。
 * 边界：不碰文件系统、不做哈希——需要哈希时通过 pending.needs 声明需求，
 *       由调用方（Node 端或浏览器端）补齐后调用 resolvePlan。
 */

export const KIND = Object.freeze({
  SAME: 'same',
  NEW_LOCAL: 'new-local',
  NEW_REMOTE: 'new-remote',
  MODIFIED_LOCAL: 'modified-local',
  MODIFIED_REMOTE: 'modified-remote',
  DELETED_LOCAL: 'deleted-local',
  DELETED_REMOTE: 'deleted-remote',
  BOTH_DELETED: 'both-deleted',
  CONFLICT_ADD: 'conflict-add',
  CONFLICT_MODIFY: 'conflict-modify',
  CONFLICT_DELETE_MODIFY: 'conflict-delete-modify',
});

export const ACTION = Object.freeze({
  UPLOAD: 'upload',
  DOWNLOAD: 'download',
  DELETE_LOCAL: 'delete-local',
  DELETE_REMOTE: 'delete-remote',
  KEEP_BOTH: 'keep-both',
  // 按修改时间自动裁决：较新的一方成为正式版本，另一方另存为副本
  NEWEST: 'newest',
  NONE: 'none',
});

/** mtime 容差：差不到 1 秒就当作并列（不同文件系统精度不同，别硬判） */
export const MTIME_TOLERANCE_MS = 1000;

export const CONFLICT_KINDS = Object.freeze([
  KIND.CONFLICT_ADD,
  KIND.CONFLICT_MODIFY,
  KIND.CONFLICT_DELETE_MODIFY,
]);

const CONFLICT_SET = new Set(CONFLICT_KINDS);

/** 删除类条目：本地删了同步到远端 / 远端删了同步到本地 */
const DELETION_ACTIONS = new Set([ACTION.DELETE_LOCAL, ACTION.DELETE_REMOTE]);

const DEFAULT_ACTION = {
  [KIND.NEW_LOCAL]: ACTION.UPLOAD,
  [KIND.MODIFIED_LOCAL]: ACTION.UPLOAD,
  [KIND.NEW_REMOTE]: ACTION.DOWNLOAD,
  [KIND.MODIFIED_REMOTE]: ACTION.DOWNLOAD,
  [KIND.DELETED_LOCAL]: ACTION.DELETE_REMOTE,
  [KIND.DELETED_REMOTE]: ACTION.DELETE_LOCAL,
  [KIND.SAME]: ACTION.NONE,
  [KIND.BOTH_DELETED]: ACTION.NONE,
};

/** 从 stat 派生签名：内容判定走哈希，签名只用来"快速跳过没动过的文件" */
export function sigOf(stat) {
  if (!stat) return null;
  if (typeof stat.sig === 'string' && stat.sig) return stat.sig;
  const size = Number(stat.size) || 0;
  const mtime = Number(stat.mtimeMs) || 0;
  return `${size}:${Math.round(mtime)}`;
}

export function isConflict(entry) {
  return !!entry && CONFLICT_SET.has(entry.kind);
}

export function isDeletion(entry) {
  return !!entry && DELETION_ACTIONS.has(entry.action);
}

function makeEntry(path, kind, action, extra = {}) {
  return {
    path,
    kind,
    action: action ?? DEFAULT_ACTION[kind] ?? ACTION.NONE,
    pending: null,
    local: null,
    remote: null,
    baseline: null,
    localHash: null,
    remoteHash: null,
    survivor: null,
    note: '',
    ...extra,
  };
}

function pendingEntry(path, reason, needs, ctx, note) {
  return {
    path,
    kind: null,
    action: null,
    pending: { reason, needs, side: ctx.survivor || null },
    local: ctx.local || null,
    remote: ctx.remote || null,
    baseline: ctx.baseline || null,
    localHash: null,
    remoteHash: null,
    survivor: ctx.survivor || null,
    note,
  };
}

function comparePath(a, b) {
  return a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

/** 第一阶段：只看签名就能定下来的直接定；定不下来的标记 pending 并声明需要哪边的哈希 */
export function quickPlan({ local = {}, remote = {}, baseline = {} } = {}) {
  const paths = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(baseline)]);
  const entries = [];
  for (const path of Array.from(paths).sort(comparePath)) {
    entries.push(classify(path, local[path] || null, remote[path] || null, baseline[path] || null));
  }
  return entries;
}

function classify(path, L, R, B) {
  const ctx = { local: L, remote: R, baseline: B };

  if (L && R) {
    const ls = sigOf(L);
    const rs = sigOf(R);
    if (!B) {
      if (ls === rs) return pendingEntry(path, 'sig-equal', { local: true }, ctx, '两端签名一致，待记录基线');
      return pendingEntry(path, 'first-meet', { local: true, remote: true }, ctx, '首次同步，需要比对内容');
    }
    const lChanged = ls !== B.localSig;
    const rChanged = rs !== B.remoteSig;
    if (!lChanged && !rChanged) return makeEntry(path, KIND.SAME, ACTION.NONE, ctx);
    if (!lChanged) return pendingEntry(path, 'remote-touch', { remote: true }, ctx, '远端签名变化');
    if (!rChanged) return pendingEntry(path, 'local-touch', { local: true }, ctx, '本地签名变化');
    return pendingEntry(path, 'both-touch', { local: true, remote: true }, ctx, '两端都变化');
  }

  if (L) {
    if (!B) return makeEntry(path, KIND.NEW_LOCAL, ACTION.UPLOAD, { ...ctx, note: '仅本地有' });
    if (sigOf(L) === B.localSig) {
      return makeEntry(path, KIND.DELETED_REMOTE, ACTION.DELETE_LOCAL, { ...ctx, note: '远端已删除，本地未改' });
    }
    return pendingEntry(path, 'remote-gone-local-changed', { local: true }, { ...ctx, survivor: 'local' }, '远端删除，本地有改动');
  }

  if (R) {
    if (!B) return makeEntry(path, KIND.NEW_REMOTE, ACTION.DOWNLOAD, { ...ctx, note: '仅远端有' });
    if (sigOf(R) === B.remoteSig) {
      return makeEntry(path, KIND.DELETED_LOCAL, ACTION.DELETE_REMOTE, { ...ctx, note: '本地已删除，远端未改' });
    }
    return pendingEntry(path, 'local-gone-remote-changed', { remote: true }, { ...ctx, survivor: 'remote' }, '本地删除，远端有改动');
  }

  if (B) return makeEntry(path, KIND.BOTH_DELETED, ACTION.NONE, { ...ctx, note: '两端都已删除' });
  return makeEntry(path, KIND.SAME, ACTION.NONE, ctx);
}

/** 告诉调用方：为了完成判定，需要分别对哪些路径算哈希 */
export function pendingHashes(entries) {
  const need = { local: [], remote: [] };
  for (const entry of entries) {
    if (!entry.pending) continue;
    if (entry.pending.needs.local) need.local.push(entry.path);
    if (entry.pending.needs.remote) need.remote.push(entry.path);
  }
  return need;
}

/** 第二阶段：拿哈希把 pending 条目落到最终分类 */
export function resolvePlan(entries, hashes = {}) {
  const localHashes = hashes.local || {};
  const remoteHashes = hashes.remote || {};
  return entries.map((entry) => (entry.pending ? resolveOne(entry, localHashes, remoteHashes) : entry));
}

function resolveOne(entry, localHashes, remoteHashes) {
  const lh = localHashes[entry.path] ?? entry.local?.hash ?? null;
  const rh = remoteHashes[entry.path] ?? entry.remote?.hash ?? null;
  const B = entry.baseline || {};
  const baseHash = B.hash ?? null;
  const baseRemoteHash = B.remoteHash ?? B.hash ?? null;
  const ctx = { local: entry.local, remote: entry.remote, baseline: entry.baseline, survivor: entry.survivor };
  const settle = (kind, action, note) =>
    makeEntry(entry.path, kind, action, { ...ctx, note, localHash: lh, remoteHash: rh });

  switch (entry.pending.reason) {
    case 'sig-equal':
      return settle(KIND.SAME, ACTION.NONE, '两端一致');
    case 'first-meet':
      if (lh && lh === rh) return settle(KIND.SAME, ACTION.NONE, '内容一致');
      return settle(KIND.CONFLICT_ADD, ACTION.NONE, '两端都有，内容不同');
    case 'local-touch':
      if (lh && lh === baseHash) return settle(KIND.SAME, ACTION.NONE, '仅时间戳变化');
      return settle(KIND.MODIFIED_LOCAL, ACTION.UPLOAD, '本地已修改');
    case 'remote-touch':
      if (rh && rh === baseRemoteHash) return settle(KIND.SAME, ACTION.NONE, '仅时间戳变化');
      return settle(KIND.MODIFIED_REMOTE, ACTION.DOWNLOAD, '远端已修改');
    case 'both-touch': {
      if (lh && lh === rh) return settle(KIND.SAME, ACTION.NONE, '两端改成同一内容');
      if (lh && lh === baseHash && rh && rh === baseRemoteHash) return settle(KIND.SAME, ACTION.NONE, '签名抖动，内容未变');
      if (lh && lh === baseHash) return settle(KIND.MODIFIED_REMOTE, ACTION.DOWNLOAD, '仅远端修改');
      if (rh && rh === baseRemoteHash) return settle(KIND.MODIFIED_LOCAL, ACTION.UPLOAD, '仅本地修改');
      return settle(KIND.CONFLICT_MODIFY, ACTION.NONE, '两端都修改且内容不同');
    }
    case 'remote-gone-local-changed':
      if (lh && lh === baseHash) {
        return settle(KIND.DELETED_REMOTE, ACTION.DELETE_LOCAL, '远端已删除，本地未改');
      }
      return settle(KIND.CONFLICT_DELETE_MODIFY, ACTION.NONE, '远端删除，本地有改动');
    case 'local-gone-remote-changed':
      if (rh && rh === baseRemoteHash) {
        return settle(KIND.DELETED_LOCAL, ACTION.DELETE_REMOTE, '本地已删除，远端未改');
      }
      return settle(KIND.CONFLICT_DELETE_MODIFY, ACTION.NONE, '本地删除，远端有改动');
    default:
      return settle(KIND.SAME, ACTION.NONE, '未识别状态，跳过');
  }
}

/**
 * 按修改时间自动裁决冲突（只给"自动同步"用）。
 * 手动对比/手动下载一律不替你决定——冲突就得你自己选。
 * - 两端都能比较时间：较新者成为两端的正式版本，较旧者另存为「远端副本 / 本地副本」
 * - 时间相同或缺失：不硬判，留给使用者决定
 * - 一边删除一边修改：删除没有"修改时间"可比，保留还在的那一份（最保守，绝不丢数据）
 */
export function applyNewestPolicy(entries) {
  return entries.map((entry) => {
    if (entry.kind === KIND.CONFLICT_DELETE_MODIFY) {
      const keepFile = entry.survivor === 'local' ? ACTION.UPLOAD : ACTION.DOWNLOAD;
      return {
        ...entry,
        action: keepFile,
        autoWinner: entry.survivor,
        chosen: true,
        note: '按时间策略：一边已删除，保留还有文件的一方',
      };
    }
    if (entry.kind !== KIND.CONFLICT_ADD && entry.kind !== KIND.CONFLICT_MODIFY) return entry;

    const localTime = Number(entry.local?.mtimeMs) || 0;
    const remoteTime = Number(entry.remote?.mtimeMs) || 0;
    if (!localTime || !remoteTime || Math.abs(localTime - remoteTime) < MTIME_TOLERANCE_MS) {
      return { ...entry, note: '修改时间相同或缺失，需要你决定' };
    }

    const winner = localTime > remoteTime ? 'local' : 'remote';
    return {
      ...entry,
      action: ACTION.NEWEST,
      autoWinner: winner,
      chosen: true,
      note: winner === 'local' ? '按时间：本地较新，远端那版存为副本' : '按时间：远端较新，本地那版存为副本',
    };
  });
}

/** 使用者对冲突的选择：keep-local / keep-remote / keep-both / newest / skip */
export function applyChoices(entries, choices = {}) {
  return entries.map((entry) => {
    const choice = choices[entry.path];
    if (!choice) return entry;
    const action = resolveChoiceAction(entry, choice);
    if (!action) return entry;
    return { ...entry, action, chosen: true };
  });
}

export function resolveChoiceAction(entry, choice) {
  if (choice === 'skip') return ACTION.NONE;
  if (choice === 'newest') return ACTION.NEWEST;

  // 统一口径：keep-local = 保留"本地这一侧的状态"（本地没有 = 本地已删除 → 让远端也删）
  if (choice === 'keep-local') {
    if (entry.local) return ACTION.UPLOAD;
    if (entry.remote) return ACTION.DELETE_REMOTE;
    return null;
  }

  if (choice === 'keep-remote') {
    if (entry.remote) return ACTION.DOWNLOAD;
    if (entry.local) return ACTION.DELETE_LOCAL;
    return null;
  }

  if (choice === 'keep-both') {
    return entry.kind === KIND.CONFLICT_DELETE_MODIFY ? null : ACTION.KEEP_BOTH;
  }

  return null;
}

/** 统计：给界面顶部摘要与执行前确认用 */
export function summarize(entries) {
  const summary = {
    total: entries.length,
    same: 0,
    upload: 0,
    download: 0,
    deletes: 0,
    conflicts: 0,
    pendingConflicts: 0,
    autoResolved: 0,
    uploadBytes: 0,
    downloadBytes: 0,
  };
  for (const entry of entries) {
    if (entry.kind === KIND.SAME || entry.kind === KIND.BOTH_DELETED) {
      summary.same += 1;
      continue;
    }
    if (isConflict(entry)) {
      summary.conflicts += 1;
      if (entry.action === ACTION.NONE) summary.pendingConflicts += 1;
    }
    if (entry.action === ACTION.UPLOAD) {
      summary.upload += 1;
      summary.uploadBytes += Number(entry.local?.size) || 0;
    } else if (entry.action === ACTION.DOWNLOAD) {
      summary.download += 1;
      summary.downloadBytes += Number(entry.remote?.size) || 0;
    } else if (DELETION_ACTIONS.has(entry.action)) {
      summary.deletes += 1;
    } else if (entry.action === ACTION.KEEP_BOTH) {
      summary.upload += 1;
      summary.download += 1;
    } else if (entry.action === ACTION.NEWEST) {
      // 较新的一份要传过去，较旧的一份要作为副本传回来，字节两边都算
      summary.autoResolved += 1;
      summary.upload += 1;
      summary.download += 1;
      summary.uploadBytes += Number(entry.autoWinner === 'local' ? entry.local?.size : entry.remote?.size) || 0;
      summary.downloadBytes += Number(entry.autoWinner === 'local' ? entry.remote?.size : entry.local?.size) || 0;
    }
  }
  return summary;
}

/** 冲突留副本时的文件名：空格与中文都可读，且不含 Windows 非法字符 */
export function conflictCopyName(path, tag, date = new Date()) {
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-') + ' ' + [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ].join('-');

  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  return `${dir}${stem} (${tag} ${stamp})${ext}`;
}

/** 把待执行条目展开成原子操作（执行层只认这个结构） */
export function expandOperations(entry, { allowDeletes = false, now = new Date() } = {}) {
  const action = entry.action;
  if (!action || action === ACTION.NONE) return [];
  if (DELETION_ACTIONS.has(action) && !allowDeletes) return [];

  switch (action) {
    case ACTION.UPLOAD:
      return [{ op: 'upload', from: entry.path, to: entry.path, entry }];
    case ACTION.DOWNLOAD:
      return [{ op: 'download', from: entry.path, to: entry.path, entry }];
    case ACTION.DELETE_LOCAL:
      return [{ op: 'delete-local', path: entry.path, from: entry.path, entry }];
    case ACTION.DELETE_REMOTE:
      return [{ op: 'delete-remote', path: entry.path, from: entry.path, entry }];
    case ACTION.KEEP_BOTH: {
      const remoteCopy = conflictCopyName(entry.path, '远端副本', now);
      return [
        // 先把对端那份另存，再让本地版本成为两端统一的原名，最后把另存的副本拉回本地
        { op: 'copy-remote', from: entry.path, to: remoteCopy, entry },
        { op: 'upload', from: entry.path, to: entry.path, entry },
        { op: 'download', from: remoteCopy, to: remoteCopy, entry },
      ];
    }
    case ACTION.NEWEST: {
      if (entry.autoWinner === 'remote') {
        // 远端较新：本地那份先另存成副本，再用远的覆盖本地原名，最后把副本传回去
        const localCopy = conflictCopyName(entry.path, '本地副本', now);
        return [
          { op: 'copy-local', from: entry.path, to: localCopy, entry },
          { op: 'download', from: entry.path, to: entry.path, entry },
          { op: 'upload', from: localCopy, to: localCopy, entry },
        ];
      }
      const remoteCopy = conflictCopyName(entry.path, '远端副本', now);
      return [
        { op: 'copy-remote', from: entry.path, to: remoteCopy, entry },
        { op: 'upload', from: entry.path, to: entry.path, entry },
        { op: 'download', from: remoteCopy, to: remoteCopy, entry },
      ];
    }
    default:
      return [];
  }
}
