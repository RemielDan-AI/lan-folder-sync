import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION,
  KIND,
  applyChoices,
  applyNewestPolicy,
  conflictCopyName,
  expandOperations,
  pendingHashes,
  quickPlan,
  resolvePlan,
  summarize,
} from '../shared/diff.js';

const stat = (size, mtime, hash) => ({
  size,
  mtimeMs: mtime,
  sig: `${size}:${mtime}`,
  ...(hash ? { hash } : {}),
});

const base = (hash, localSig, remoteSig, extra = {}) => ({
  hash,
  remoteHash: hash,
  localSig,
  remoteSig,
  ...extra,
});

/** 走完整三阶段：quick → 补哈希 → resolve */
function plan(local, remote, baseline, localHashes = {}, remoteHashes = {}) {
  return resolvePlan(quickPlan({ local, remote, baseline }), {
    local: localHashes,
    remote: remoteHashes,
  });
}

function only(entries) {
  assert.equal(entries.length, 1, `期望 1 条，实际 ${entries.length}`);
  return entries[0];
}

test('仅本地有的文件 → 上传', () => {
  const entry = only(plan({ 'a.txt': stat(10, 100) }, {}, {}));
  assert.equal(entry.kind, KIND.NEW_LOCAL);
  assert.equal(entry.action, ACTION.UPLOAD);
});

test('仅远端有的文件 → 下载', () => {
  const entry = only(plan({}, { 'b.txt': stat(20, 200) }, {}));
  assert.equal(entry.kind, KIND.NEW_REMOTE);
  assert.equal(entry.action, ACTION.DOWNLOAD);
});

test('首次同步：签名一致的两份文件直接视为一致', () => {
  const s = stat(10, 100);
  const quick = quickPlan({ local: { 'a.txt': s }, remote: { 'a.txt': s }, baseline: {} });
  assert.deepEqual(pendingHashes(quick), { local: ['a.txt'], remote: [] });
  const entry = only(resolvePlan(quick, { local: { 'a.txt': 'h1' } }));
  assert.equal(entry.kind, KIND.SAME);
  assert.equal(entry.action, ACTION.NONE);
  assert.equal(entry.localHash, 'h1');
});

test('首次同步：两端都有但内容不同 → 首次冲突，无默认动作', () => {
  const entry = only(
    plan(
      { 'a.txt': stat(10, 100) },
      { 'a.txt': stat(11, 200) },
      {},
      { 'a.txt': 'h1' },
      { 'a.txt': 'h2' },
    ),
  );
  assert.equal(entry.kind, KIND.CONFLICT_ADD);
  assert.equal(entry.action, ACTION.NONE);
});

test('首次同步：签名不同但内容相同 → 一致', () => {
  const entry = only(
    plan(
      { 'a.txt': stat(10, 100) },
      { 'a.txt': stat(10, 999) },
      {},
      { 'a.txt': 'same' },
      { 'a.txt': 'same' },
    ),
  );
  assert.equal(entry.kind, KIND.SAME);
});

test('基线存在：只有 mtime 变了（内容没变）→ 一致，不传', () => {
  const entry = only(
    plan(
      { 'a.txt': stat(10, 555) },
      { 'a.txt': stat(10, 100) },
      { 'a.txt': base('h1', '10:100', '10:100') },
      { 'a.txt': 'h1' },
    ),
  );
  assert.equal(entry.kind, KIND.SAME);
  assert.equal(entry.action, ACTION.NONE);
});

test('基线存在：本地内容改了 → 上传', () => {
  const entry = only(
    plan(
      { 'a.txt': stat(12, 555) },
      { 'a.txt': stat(10, 100) },
      { 'a.txt': base('h1', '10:100', '10:100') },
      { 'a.txt': 'h2' },
    ),
  );
  assert.equal(entry.kind, KIND.MODIFIED_LOCAL);
  assert.equal(entry.action, ACTION.UPLOAD);
});

test('基线存在：远端内容改了 → 下载', () => {
  const entry = only(
    plan(
      { 'a.txt': stat(10, 100) },
      { 'a.txt': stat(12, 555) },
      { 'a.txt': base('h1', '10:100', '10:100') },
      {},
      { 'a.txt': 'h2' },
    ),
  );
  assert.equal(entry.kind, KIND.MODIFIED_REMOTE);
  assert.equal(entry.action, ACTION.DOWNLOAD);
});

test('两端都改但改成了同一内容 → 一致，不报冲突', () => {
  const entry = only(
    plan(
      { 'a.txt': stat(12, 111) },
      { 'a.txt': stat(12, 222) },
      { 'a.txt': base('h1', '10:100', '10:100') },
      { 'a.txt': 'h9' },
      { 'a.txt': 'h9' },
    ),
  );
  assert.equal(entry.kind, KIND.SAME);
});

test('两端都改且内容不同 → 修改冲突', () => {
  const entry = only(
    plan(
      { 'a.txt': stat(13, 111) },
      { 'a.txt': stat(14, 222) },
      { 'a.txt': base('h1', '10:100', '10:100') },
      { 'a.txt': 'h2' },
      { 'a.txt': 'h3' },
    ),
  );
  assert.equal(entry.kind, KIND.CONFLICT_MODIFY);
  assert.equal(entry.action, ACTION.NONE);
});

test('远端删了、本地没改 → 本地也应删除', () => {
  const entry = only(
    plan(
      { 'a.txt': stat(10, 100) },
      {},
      { 'a.txt': base('h1', '10:100', '10:100') },
    ),
  );
  assert.equal(entry.kind, KIND.DELETED_REMOTE);
  assert.equal(entry.action, ACTION.DELETE_LOCAL);
});

test('本地删了、远端没改 → 远端也应删除', () => {
  const entry = only(
    plan({}, { 'a.txt': stat(10, 100) }, { 'a.txt': base('h1', '10:100', '10:100') }),
  );
  assert.equal(entry.kind, KIND.DELETED_LOCAL);
  assert.equal(entry.action, ACTION.DELETE_REMOTE);
});

test('远端删了、本地改过 → 删除/修改冲突，且标明存活方是本地', () => {
  const entry = only(
    plan(
      { 'a.txt': stat(11, 777) },
      {},
      { 'a.txt': base('h1', '10:100', '10:100') },
      { 'a.txt': 'h2' },
    ),
  );
  assert.equal(entry.kind, KIND.CONFLICT_DELETE_MODIFY);
  assert.equal(entry.survivor, 'local');
  assert.equal(entry.action, ACTION.NONE);
});

test('远端删了、本地只是 mtime 变了 → 不算修改，按删除处理', () => {
  const entry = only(
    plan(
      { 'a.txt': stat(10, 777) },
      {},
      { 'a.txt': base('h1', '10:100', '10:100') },
      { 'a.txt': 'h1' },
    ),
  );
  assert.equal(entry.kind, KIND.DELETED_REMOTE);
});

test('两端都删了 → 清基线，不动文件', () => {
  const entry = only(plan({}, {}, { 'a.txt': base('h1', '10:100', '10:100') }));
  assert.equal(entry.kind, KIND.BOTH_DELETED);
  assert.equal(entry.action, ACTION.NONE);
});

test('确认过分歧的文件不再重复报冲突', () => {
  const entry = only(
    plan(
      { 'a.txt': stat(10, 100) },
      { 'a.txt': stat(11, 200) },
      { 'a.txt': base('h1', '10:100', '11:200', { diverged: true }) },
    ),
  );
  assert.equal(entry.kind, KIND.SAME);
});

test('冲突选择：保留本地 / 保留远端 / 两个都留', () => {
  const entries = plan(
    { 'a.txt': stat(13, 111) },
    { 'a.txt': stat(14, 222) },
    { 'a.txt': base('h1', '10:100', '10:100') },
    { 'a.txt': 'h2' },
    { 'a.txt': 'h3' },
  );

  assert.equal(applyChoices(entries, { 'a.txt': 'keep-local' })[0].action, ACTION.UPLOAD);
  assert.equal(applyChoices(entries, { 'a.txt': 'keep-remote' })[0].action, ACTION.DOWNLOAD);
  assert.equal(applyChoices(entries, { 'a.txt': 'keep-both' })[0].action, ACTION.KEEP_BOTH);
  assert.equal(applyChoices(entries, { 'a.txt': 'skip' })[0].action, ACTION.NONE);
  // 没选的冲突项保持待决策
  assert.equal(applyChoices(entries, {})[0].action, ACTION.NONE);
});

test('普通条目也能用同一套选择口径改变方向', () => {
  const entries = plan({ 'a.txt': stat(10, 100) }, {}, {});
  assert.equal(entries[0].kind, KIND.NEW_LOCAL);
  assert.equal(applyChoices(entries, { 'a.txt': 'keep-local' })[0].action, ACTION.UPLOAD);
  // "保留远端"意味着接受远端没有这个文件 → 删掉本地；普通行界面不会给出这个选项，
  // 但删除类条目正是靠这条统一规则工作的（见下一个用例）
  assert.equal(applyChoices(entries, { 'a.txt': 'keep-remote' })[0].action, ACTION.DELETE_LOCAL);
  assert.equal(applyChoices(entries, { 'a.txt': 'skip' })[0].action, ACTION.NONE);
});

test('删除类条目：保留本地 = 远端也删，保留远端 = 本地恢复', () => {
  const remoteDeleted = plan({ 'a.txt': stat(10, 100) }, {}, { 'a.txt': base('h1', '10:100', '10:100') });
  assert.equal(remoteDeleted[0].kind, KIND.DELETED_REMOTE);
  assert.equal(applyChoices(remoteDeleted, { 'a.txt': 'keep-local' })[0].action, ACTION.UPLOAD, '应把文件补回远端');
  assert.equal(applyChoices(remoteDeleted, { 'a.txt': 'keep-remote' })[0].action, ACTION.DELETE_LOCAL, '应接受删除');

  const localDeleted = plan({}, { 'a.txt': stat(10, 100) }, { 'a.txt': base('h1', '10:100', '10:100') });
  assert.equal(localDeleted[0].kind, KIND.DELETED_LOCAL);
  assert.equal(applyChoices(localDeleted, { 'a.txt': 'keep-local' })[0].action, ACTION.DELETE_REMOTE);
  assert.equal(applyChoices(localDeleted, { 'a.txt': 'keep-remote' })[0].action, ACTION.DOWNLOAD);
});

test('删除类动作默认被安全开关拦下', () => {
  const entries = plan({}, { 'a.txt': stat(10, 100) }, { 'a.txt': base('h1', '10:100', '10:100') });
  assert.equal(expandOperations(entries[0], { allowDeletes: false }).length, 0);
  const ops = expandOperations(entries[0], { allowDeletes: true });
  assert.equal(ops[0].op, 'delete-remote');
});

test('两个都留 → 先在远端另存旧版本，再让本地版本成为两端原名', () => {
  const entries = applyChoices(
    plan(
      { 'dir/a.txt': stat(13, 111) },
      { 'dir/a.txt': stat(14, 222) },
      { 'dir/a.txt': base('h1', '10:100', '10:100') },
      { 'dir/a.txt': 'h2' },
      { 'dir/a.txt': 'h3' },
    ),
    { 'dir/a.txt': 'keep-both' },
  );
  const ops = expandOperations(entries[0], { now: new Date('2026-10-26T23:30:15') });
  assert.deepEqual(
    ops.map((op) => `${op.op}:${op.from}->${op.to}`),
    [
      'copy-remote:dir/a.txt->dir/a (远端副本 2026-10-26 23-30-15).txt',
      'upload:dir/a.txt->dir/a.txt',
      'download:dir/a (远端副本 2026-10-26 23-30-15).txt->dir/a (远端副本 2026-10-26 23-30-15).txt',
    ],
  );
});

test('副本名保留扩展名且不含 Windows 非法字符', () => {
  const name = conflictCopyName('报告 v2.md', '远端副本', new Date('2026-01-02T03:04:05'));
  assert.equal(name, '报告 v2 (远端副本 2026-01-02 03-04-05).md');
  assert.doesNotMatch(name, /[<>:"/\\|?*]/);
});

test('摘要统计口径正确', () => {
  const entries = plan(
    {
      'new.txt': stat(100, 1),
      'changed.txt': stat(1, 1),
      'conf.txt': stat(50, 2),
      'same.txt': stat(7, 3),
    },
    {
      'changed.txt': stat(200, 4),
      'conf.txt': stat(60, 5),
      'same.txt': stat(7, 3),
    },
    {
      'changed.txt': base('hm', '1:1', '1:1'),
      'conf.txt': base('hc', '40:1', '40:1'),
      'same.txt': base('hs', '7:3', '7:3'),
    },
    { 'conf.txt': 'h2' },
    { 'changed.txt': 'h9', 'conf.txt': 'h3' },
  );
  const summary = summarize(entries);
  assert.equal(summary.upload, 1, '新增文件应计入上传');
  assert.equal(summary.download, 1, '远端修改应计入下载');
  assert.equal(summary.deletes, 0, '没有删除操作');
  assert.equal(summary.conflicts, 1);
  assert.equal(summary.pendingConflicts, 1, '未决策的冲突应被计数');
  assert.equal(summary.uploadBytes, 100);
  assert.equal(summary.downloadBytes, 200);
  assert.equal(summary.same, 1, 'same.txt 应视为一致');
});

test('pendingHashes 只声明真正需要的哈希', () => {
  const entries = quickPlan({
    local: { 'a.txt': stat(10, 100) },
    remote: { 'a.txt': stat(10, 100) },
    baseline: { 'b.txt': base('h', '1:1', '1:1') },
  });
  const need = pendingHashes(entries);
  assert.deepEqual(need.local, ['a.txt']);
  assert.deepEqual(need.remote, []);
});

/* ------------------------------ 按修改时间自动裁决 ------------------------------ */

test('按时间裁决：本地较新则本地胜出，远端那版存副本', () => {
  const entries = applyNewestPolicy(
    plan(
      { 'a.txt': stat(13, 2_000) },
      { 'a.txt': stat(14, 1_000) },
      { 'a.txt': base('h1', '10:100', '10:100') },
      { 'a.txt': 'h2' },
      { 'a.txt': 'h3' },
    ),
  );
  const entry = only(entries);
  assert.equal(entry.action, ACTION.NEWEST);
  assert.equal(entry.autoWinner, 'local');
  assert.match(entry.note, /本地较新/);
  assert.equal(summarize(entries).autoResolved, 1);
});

test('按时间裁决：远端较新则远端胜出', () => {
  const entry = only(
    applyNewestPolicy(
      plan(
        { 'a.txt': stat(13, 1_000) },
        { 'a.txt': stat(14, 9_000) },
        { 'a.txt': base('h1', '10:100', '10:100') },
        { 'a.txt': 'h2' },
        { 'a.txt': 'h3' },
      ),
    ),
  );
  assert.equal(entry.action, ACTION.NEWEST);
  assert.equal(entry.autoWinner, 'remote');
});

test('按时间裁决：修改时间相同或太接近时不硬判，仍交给使用者', () => {
  const entry = only(
    applyNewestPolicy(
      plan(
        { 'a.txt': stat(13, 5_000) },
        { 'a.txt': stat(14, 5_500) },
        { 'a.txt': base('h1', '10:100', '10:100') },
        { 'a.txt': 'h2' },
        { 'a.txt': 'h3' },
      ),
    ),
  );
  assert.equal(entry.action, ACTION.NONE);
  assert.equal(entry.autoWinner ?? null, null);
  assert.match(entry.note, /需要你决定/);
});

test('按时间裁决：一边删除一边修改时保留文件，绝不因删除丢内容', () => {
  // 远端删了、本地改过
  const localSurvives = only(
    applyNewestPolicy(
      plan({ 'a.txt': stat(11, 777) }, {}, { 'a.txt': base('h1', '10:100', '10:100') }, { 'a.txt': 'h2' }),
    ),
  );
  assert.equal(localSurvives.action, ACTION.UPLOAD);
  assert.equal(localSurvives.autoWinner, 'local');

  // 本地删了、远端改过
  const remoteSurvives = only(
    applyNewestPolicy(
      plan({}, { 'a.txt': stat(11, 777) }, { 'a.txt': base('h1', '10:100', '10:100') }, {}, { 'a.txt': 'h2' }),
    ),
  );
  assert.equal(remoteSurvives.action, ACTION.DOWNLOAD);
  assert.equal(remoteSurvives.autoWinner, 'remote');
});

test('按时间裁决不会动没冲突的条目', () => {
  const entries = applyNewestPolicy(plan({ 'a.txt': stat(10, 100) }, {}, {}));
  assert.equal(entries[0].kind, KIND.NEW_LOCAL);
  assert.equal(entries[0].action, ACTION.UPLOAD);
});

test('本地较新：远端旧版先另存，再把本地版推上去，最后把副本拉回来', () => {
  const entries = applyNewestPolicy(
    plan(
      { 'dir/a.txt': stat(13, 2_000) },
      { 'dir/a.txt': stat(14, 1_000) },
      { 'dir/a.txt': base('h1', '10:100', '10:100') },
      { 'dir/a.txt': 'h2' },
      { 'dir/a.txt': 'h3' },
    ),
  );
  const ops = expandOperations(entries[0], { now: new Date('2026-10-27T11:00:00') });
  assert.deepEqual(
    ops.map((op) => `${op.op}:${op.from}->${op.to}`),
    [
      'copy-remote:dir/a.txt->dir/a (远端副本 2026-10-27 11-00-00).txt',
      'upload:dir/a.txt->dir/a.txt',
      'download:dir/a (远端副本 2026-10-27 11-00-00).txt->dir/a (远端副本 2026-10-27 11-00-00).txt',
    ],
  );
});

test('远端较新：本地旧版先另存，再用远端覆盖本地，最后把副本推回去', () => {
  const entries = applyNewestPolicy(
    plan(
      { 'dir/a.txt': stat(13, 1_000) },
      { 'dir/a.txt': stat(14, 2_000) },
      { 'dir/a.txt': base('h1', '10:100', '10:100') },
      { 'dir/a.txt': 'h2' },
      { 'dir/a.txt': 'h3' },
    ),
  );
  const ops = expandOperations(entries[0], { now: new Date('2026-10-27T11:00:00') });
  assert.deepEqual(
    ops.map((op) => `${op.op}:${op.from}->${op.to}`),
    [
      'copy-local:dir/a.txt->dir/a (本地副本 2026-10-27 11-00-00).txt',
      'download:dir/a.txt->dir/a.txt',
      'upload:dir/a (本地副本 2026-10-27 11-00-00).txt->dir/a (本地副本 2026-10-27 11-00-00).txt',
    ],
  );
});

test('自动裁决的结果也能被使用者改回手动选择', () => {
  const entries = applyNewestPolicy(
    plan(
      { 'a.txt': stat(13, 1_000) },
      { 'a.txt': stat(14, 9_000) },
      { 'a.txt': base('h1', '10:100', '10:100') },
      { 'a.txt': 'h2' },
      { 'a.txt': 'h3' },
    ),
  );
  assert.equal(entries[0].autoWinner, 'remote');
  assert.equal(applyChoices(entries, { 'a.txt': 'keep-local' })[0].action, ACTION.UPLOAD);
  assert.equal(applyChoices(entries, { 'a.txt': 'skip' })[0].action, ACTION.NONE);
  assert.equal(applyChoices(entries, { 'a.txt': 'newest' })[0].action, ACTION.NEWEST);
});
