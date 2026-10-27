/**
 * 路径安全：所有来自网络或界面的相对路径都必须过这里，防止 ../ 越界与绝对路径注入。
 */

import path from 'node:path';

/** 规范化相对路径：统一用 / 分隔，去掉空段与 .，拒绝任何越界写法。非法返回 null。 */
export function normalizeRel(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;
  if (raw.includes('\0')) return null;
  if (/^[a-zA-Z]:/.test(raw)) return null; // 驱动器绝对路径
  if (raw.startsWith('/') || raw.startsWith('\\')) return null;

  const segments = raw.split(/[\\/]+/);
  const out = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return null;
    out.push(segment);
  }
  if (!out.length) return null;
  return out.join('/');
}

/** 把相对路径解析到根目录内，越界抛错 */
export function resolveInside(root, rel) {
  const normalized = normalizeRel(rel);
  if (!normalized) throw new Error(`非法路径: ${String(rel)}`);
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, ...normalized.split('/'));
  const withSep = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  const sameCase = process.platform === 'win32' ? abs.toLowerCase() : abs;
  const rootCase = process.platform === 'win32' ? withSep.toLowerCase() : withSep;
  if (sameCase !== rootCase.slice(0, -1) && !sameCase.startsWith(rootCase)) {
    throw new Error(`路径越界: ${normalized}`);
  }
  return abs;
}

/** 判断绝对路径是否在根目录内（用于校验用户选的文件夹） */
export function isInside(root, absPath) {
  const rootAbs = path.resolve(root);
  const target = path.resolve(absPath);
  const withSep = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  const a = process.platform === 'win32' ? target.toLowerCase() : target;
  const b = process.platform === 'win32' ? withSep.toLowerCase() : withSep;
  return a === b.slice(0, -1) || a.startsWith(b);
}
