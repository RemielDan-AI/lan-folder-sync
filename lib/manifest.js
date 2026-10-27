/**
 * 文件夹清单与哈希
 * ------------------------------------------------------------------
 * 遍历只读不写；跳过符号链接与非普通文件，避免目录环和越界。
 * 签名（size + mtimeMs）用来快速跳过没动过的文件，哈希只对"可能有变化"的文件算。
 */

import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const MAX_DEPTH = 64;
const REPORT_EVERY = 200;

export function sigOfStat(st) {
  return `${st.size}:${Math.round(st.mtimeMs)}`;
}

/** 遍历文件夹，返回 { 'rel/path': {size, mtimeMs, sig} }，路径统一用 / */
export async function walkFolder(root, { onProgress, skipNames = [] } = {}) {
  const skip = new Set(skipNames);
  const files = {};
  let seen = 0;

  async function visit(dir, relPrefix, depth) {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 无权限 / 已消失的目录直接跳过，不中断整次扫描
    }

    const subdirs = [];
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        subdirs.push(entry.name);
        continue;
      }
      if (!entry.isFile()) continue;
      const abs = path.join(dir, entry.name);
      try {
        const st = await fsp.lstat(abs);
        if (!st.isFile()) continue;
        files[rel] = { size: st.size, mtimeMs: st.mtimeMs, sig: sigOfStat(st) };
        seen += 1;
        if (onProgress && seen % REPORT_EVERY === 0) onProgress({ scanned: seen });
      } catch {
        // 单个文件读不到不影响整体
      }
    }

    for (const name of subdirs) {
      await visit(path.join(dir, name), relPrefix ? `${relPrefix}/${name}` : name, depth + 1);
    }
  }

  await visit(root, '', 0);
  return files;
}

/** 单个文件 SHA-256（流式，内存占用恒定） */
export async function hashFile(abs) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(abs);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

/**
 * 批量哈希。cache 是基线里的 { rel: {sig, hash} }，签名没变就直接复用，省掉读盘。
 * 返回值 { rel: hash|null }，null 表示文件已不可读。
 */
export async function hashMany(root, relPaths, { cache = {}, concurrency = 4, onProgress } = {}) {
  const result = {};
  if (!relPaths.length) return result;

  const queue = relPaths.slice();
  let done = 0;
  let reused = 0;

  async function worker() {
    for (;;) {
      const rel = queue.shift();
      if (rel === undefined) return;
      const abs = path.join(root, ...rel.split('/'));
      try {
        const st = await fsp.lstat(abs);
        if (!st.isFile()) {
          result[rel] = null;
        } else {
          const sig = sigOfStat(st);
          const cached = cache[rel];
          if (cached && cached.sig === sig && cached.hash) {
            result[rel] = cached.hash;
            reused += 1;
          } else {
            result[rel] = await hashFile(abs);
          }
        }
      } catch {
        result[rel] = null;
      }
      done += 1;
      if (onProgress) onProgress({ hashed: done, total: relPaths.length, reused, path: rel });
    }
  }

  const workers = Math.max(1, Math.min(concurrency, queue.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return result;
}

/** 目录体积统计（界面展示用，不参与同步判定） */
export function volumeOf(files) {
  let bytes = 0;
  for (const key of Object.keys(files)) bytes += Number(files[key]?.size) || 0;
  return { count: Object.keys(files).length, bytes };
}
