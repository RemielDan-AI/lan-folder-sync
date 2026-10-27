/**
 * 配置与持久化
 * ------------------------------------------------------------------
 * data/config.json  本机身份、端口、配对码、管理员令牌、共享文件夹列表
 * data/peers.json   已配对的对端（含双向令牌）
 * data/baselines/   每个"同步项"一份"上次同步时的状态"
 * data/history.json 最近若干次同步记录（只用于界面展示）
 *
 * 一个"同步项" = (本机文件夹, 对端, 对端文件夹)。三者的 id 一起构成基线的键，
 * 所以同一个文件夹和不同对端、不同对方文件夹同步时，各自有独立的记忆。
 */

import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const APP_VERSION = '1.1.0';
export const APP_TITLE = 'Communication · 局域网同步';
export const DEFAULT_PORT = 47800;
export const DISCOVERY_PORT = 47801;
export const MAX_FOLDERS = 24;

export class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.configPath = path.join(dataDir, 'config.json');
    this.peersPath = path.join(dataDir, 'peers.json');
    this.baselineDir = path.join(dataDir, 'baselines');
    this.historyPath = path.join(dataDir, 'history.json');
    this.config = null;
    this.peers = [];
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fsp.mkdir(this.baselineDir, { recursive: true });
    this.config = await this.#loadConfig();
    this.peers = await this.#loadJson(this.peersPath, []);
    return this.config;
  }

  async #loadConfig() {
    const existing = await this.#loadJson(this.configPath, null);

    if (!existing || !existing.adminToken || !existing.pairingCode) {
      const fresh = {
        id: crypto.randomUUID(),
        name: os.hostname() || '本机',
        port: DEFAULT_PORT,
        adminToken: crypto.randomBytes(24).toString('hex'),
        pairingCode: makePairingCode(),
        folders: [],
        autoSync: { intervalSec: 120, items: [] },
        createdAt: new Date().toISOString(),
      };
      await this.saveConfig(fresh);
      return this.config;
    }

    let changed = false;
    if (!Array.isArray(existing.folders)) {
      existing.folders = [];
      changed = true;
    }
    // 1.0 时代的单文件夹配置，自动搬进列表，用户不用重新选一次
    if (typeof existing.folder === 'string' && existing.folder) {
      if (!existing.folders.some((item) => samePath(item.path, existing.folder))) {
        existing.folders.push(makeFolder(existing.folder));
      }
      delete existing.folder;
      changed = true;
    }
    if (!existing.autoSync || !Array.isArray(existing.autoSync.items)) {
      existing.autoSync = { intervalSec: 120, items: [] };
      changed = true;
    }
    // 冲突策略已收敛为"手动=人工选 / 自动同步=按修改时间"，不再作为配置项
    if ('conflictPolicy' in existing) {
      delete existing.conflictPolicy;
      changed = true;
    }
    if (changed) await this.saveConfig(existing);
    return existing;
  }

  get info() {
    return this.config;
  }

  /** 串行写入，避免并发同步把 JSON 写坏 */
  #enqueue(task) {
    this.writeQueue = this.writeQueue.then(task, task);
    return this.writeQueue;
  }

  async saveConfig(patch) {
    this.config = { ...this.config, ...patch };
    const snapshot = this.config;
    await this.#enqueue(() => writeJsonAtomic(this.configPath, snapshot));
    return this.config;
  }

  async regeneratePairingCode() {
    return this.saveConfig({ pairingCode: makePairingCode() });
  }

  /* ------------------------------------------------------------ 文件夹 */

  listFolders() {
    return Array.isArray(this.config?.folders) ? this.config.folders : [];
  }

  findFolder(id) {
    if (!id) return null;
    return this.listFolders().find((folder) => folder.id === id) || null;
  }

  async addFolder(absPath, name) {
    const folders = this.listFolders();
    const existing = folders.find((folder) => samePath(folder.path, absPath));
    if (existing) return existing;
    if (folders.length >= MAX_FOLDERS) throw new Error(`最多只能添加 ${MAX_FOLDERS} 个文件夹`);

    const folder = makeFolder(absPath, name);
    await this.saveConfig({ folders: [...folders, folder] });
    return folder;
  }

  async removeFolder(id) {
    const folders = this.listFolders();
    const next = folders.filter((folder) => folder.id !== id);
    if (next.length === folders.length) throw new Error('文件夹不存在');
    // 连带清掉引用它的自动同步项，否则定时器会一直报错
    await this.saveConfig({
      folders: next,
      autoSync: {
        ...this.config.autoSync,
        items: this.listAutoSync().filter((item) => item.localFolderId !== id),
      },
    });
    return next;
  }

  async renameFolder(id, name) {
    const folders = this.listFolders().map((folder) =>
      folder.id === id ? { ...folder, name: String(name || '').slice(0, 40) || folder.name } : folder,
    );
    await this.saveConfig({ folders });
    return folders.find((folder) => folder.id === id) || null;
  }

  /* -------------------------------------------------------------- 对端 */

  async listPeers() {
    return this.peers;
  }

  findPeer(peerId) {
    return this.peers.find((peer) => peer.id === peerId) || null;
  }

  findPeerByToken(token) {
    if (!token) return null;
    return this.peers.find((peer) => peer.authToken === token) || null;
  }

  async upsertPeer(record) {
    const index = this.peers.findIndex((peer) => peer.id === record.id);
    const merged = index >= 0 ? { ...this.peers[index], ...record } : record;
    this.peers = index >= 0
      ? this.peers.map((peer, i) => (i === index ? merged : peer))
      : [...this.peers, merged];
    const snapshot = this.peers;
    await this.#enqueue(() => writeJsonAtomic(this.peersPath, snapshot));
    return merged;
  }

  async removePeer(peerId) {
    this.peers = this.peers.filter((peer) => peer.id !== peerId);
    const snapshot = this.peers;
    await this.#enqueue(() => writeJsonAtomic(this.peersPath, snapshot));
    // 顺手清掉与它相关的基线
    const files = await fsp.readdir(this.baselineDir).catch(() => []);
    for (const file of files) {
      if (file.startsWith(`${safeKey(peerId)}__`)) {
        await fsp.rm(path.join(this.baselineDir, file), { force: true });
      }
    }
    // 以及引用它的自动同步项
    await this.saveConfig({
      autoSync: {
        ...this.config.autoSync,
        items: this.listAutoSync().filter((item) => item.peerId !== peerId),
      },
    });
  }

  /* ---------------------------------------------------------- 自动同步 */

  listAutoSync() {
    return Array.isArray(this.config?.autoSync?.items) ? this.config.autoSync.items : [];
  }

  autoSyncKey(peerId, localFolderId, remoteFolderId) {
    return `${peerId}:${localFolderId}:${remoteFolderId}`;
  }

  findAutoSync(peerId, localFolderId, remoteFolderId) {
    const key = this.autoSyncKey(peerId, localFolderId, remoteFolderId);
    return this.listAutoSync().find((item) => item.key === key) || null;
  }

  async setAutoSyncItem({ peerId, localFolderId, remoteFolderId, enabled, intervalSec }) {
    const key = this.autoSyncKey(peerId, localFolderId, remoteFolderId);
    const items = this.listAutoSync().filter((item) => item.key !== key);
    if (enabled) {
      const previous = this.findAutoSync(peerId, localFolderId, remoteFolderId);
      items.push({
        key,
        peerId,
        localFolderId,
        remoteFolderId,
        intervalSec: clampInterval(intervalSec),
        enabled: true,
        lastRunAt: previous?.lastRunAt || null,
        lastResult: previous?.lastResult || null,
        lastError: '',
      });
    }
    await this.saveConfig({ autoSync: { ...this.config.autoSync, items } });
    return items.find((item) => item.key === key) || null;
  }

  async markAutoSyncRun(key, patch) {
    const items = this.listAutoSync().map((item) => (item.key === key ? { ...item, ...patch } : item));
    await this.saveConfig({ autoSync: { ...this.config.autoSync, items } });
  }

  /* -------------------------------------------------------------- 基线 */

  /** 基线按"同步项"隔离：同一对本机/对端文件夹才有可比性 */
  baselineKey(peerId, localFolderId, remoteFolderId) {
    return `${safeKey(peerId)}__${safeKey(localFolderId)}__${safeKey(remoteFolderId)}`;
  }

  #baselinePath(key) {
    return path.join(this.baselineDir, `${safeKey(key)}.json`);
  }

  async loadBaseline(key, root) {
    const raw = await this.#loadJson(this.#baselinePath(key), null);
    if (!raw || !raw.files || raw.root !== root) {
      // 换了文件夹或首次同步：旧基线没有意义，直接重建
      return { key, root, files: {}, updatedAt: null };
    }
    return raw;
  }

  async saveBaseline(key, root, files) {
    const payload = { key, root, files, updatedAt: new Date().toISOString() };
    await this.#enqueue(() => writeJsonAtomic(this.#baselinePath(key), payload));
    return payload;
  }

  /* -------------------------------------------------------------- 历史 */

  async loadHistory() {
    return this.#loadJson(this.historyPath, []);
  }

  async appendHistory(item) {
    const history = await this.loadHistory();
    const next = [item, ...history].slice(0, 30);
    await this.#enqueue(() => writeJsonAtomic(this.historyPath, next));
    return next;
  }

  async #loadJson(file, fallback) {
    try {
      const text = await fsp.readFile(file, 'utf8');
      return JSON.parse(text);
    } catch {
      return fallback;
    }
  }
}

export function makePairingCode() {
  return String(crypto.randomInt(100000, 1000000));
}

/** 自动同步间隔：默认 2 分钟；下限给到 5 秒（界面只提供 30 秒以上，测试与特殊场景可以更短） */
export function clampInterval(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 120;
  return Math.min(3600, Math.max(5, Math.round(number)));
}

function makeFolder(absPath, name) {
  const base = path.basename(absPath) || absPath;
  return {
    id: crypto.randomBytes(4).toString('hex'),
    path: absPath,
    name: String(name || base).slice(0, 40),
    addedAt: new Date().toISOString(),
  };
}

function safeKey(value) {
  return String(value || '').replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 80);
}

function samePath(a, b) {
  if (!a || !b) return false;
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** 先写临时文件再改名：断电也不会留下半个 JSON */
export async function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
}
