/**
 * ZIP 解包（流式）
 * ------------------------------------------------------------------
 * 用途：手机/iOS 不能选整个文件夹，于是让用户把文件夹压成 zip 传上来，服务端解开。
 * 安全：每个条目都过 normalizeRel + resolveInside，`../` 与绝对路径一律丢弃（防 zip 穿越）。
 * 内存：单个条目走流式 inflate，几百 MB 的视频也不会把进程撑爆。
 * 限制：不支持 zip64（>4GB 的包会明确报错，而不是解出半个目录）。
 */

import { createReadStream, createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

import { normalizeRel, resolveInside } from './safe-path.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_UINT32 = 0xffffffff;

/** 在文件尾部找中央目录结束标记（注释最长 65535 字节） */
async function findEndOfCentralDirectory(handle, size) {
  const maxScan = Math.min(size, 65535 + 22);
  const buffer = Buffer.alloc(maxScan);
  await handle.read(buffer, 0, maxScan, size - maxScan);
  for (let i = maxScan - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      return {
        offset: size - maxScan + i,
        entryCount: buffer.readUInt16LE(i + 10),
        centralSize: buffer.readUInt32LE(i + 12),
        centralOffset: buffer.readUInt32LE(i + 16),
      };
    }
  }
  return null;
}

async function readCentralDirectory(handle, eocd) {
  const buffer = Buffer.alloc(eocd.centralSize);
  await handle.read(buffer, 0, eocd.centralSize, eocd.centralOffset);

  const entries = [];
  let offset = 0;
  while (offset + 46 <= buffer.length && buffer.readUInt32LE(offset) === CENTRAL_SIGNATURE) {
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const dosTime = buffer.readUInt16LE(offset + 12);
    const dosDate = buffer.readUInt16LE(offset + 14);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    if (compressedSize === MAX_UINT32 || uncompressedSize === MAX_UINT32 || localOffset === MAX_UINT32) {
      throw new Error('这个压缩包用了 zip64（单文件或总量超过 4GB），暂不支持');
    }

    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
      encrypted: (flags & 0x0001) === 1,
      mtime: dosToDate(dosTime, dosDate),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function dosToDate(time, date) {
  const year = ((date >> 9) & 0x7f) + 1980;
  const month = (date >> 5) & 0x0f;
  const day = date & 0x1f;
  const hours = (time >> 11) & 0x1f;
  const minutes = (time >> 5) & 0x3f;
  const seconds = (time & 0x1f) * 2;
  return new Date(year, Math.max(0, month - 1), Math.max(1, day), hours, minutes, seconds);
}

/** 读本地文件头，拿到数据区起点 */
async function dataOffsetOf(handle, entry) {
  const header = Buffer.alloc(30);
  await handle.read(header, 0, 30, entry.localOffset);
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new Error(`压缩包损坏：${entry.name}`);
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  return entry.localOffset + 30 + nameLength + extraLength;
}

/**
 * 把 zip 解到 destRoot。
 * @returns {Promise<{files:{rel:string,size:number}[], skipped:{name:string,reason:string}[]}>}
 */
export async function extractZip(zipPath, destRoot, { prefix = '', maxEntries = 20000, maxTotalBytes = 16 * 1024 ** 3 } = {}) {
  const stat = await fsp.stat(zipPath);
  const handle = await fsp.open(zipPath, 'r');
  const files = [];
  const skipped = [];
  let total = 0;

  try {
    const eocd = await findEndOfCentralDirectory(handle, stat.size);
    if (!eocd) throw new Error('这不是一个有效的 zip 文件');

    const entries = await readCentralDirectory(handle, eocd);
    if (entries.length > maxEntries) throw new Error(`压缩包里文件太多（${entries.length}），超过上限 ${maxEntries}`);

    for (const entry of entries) {
      if (entry.name.endsWith('/') || entry.name.endsWith('\\')) {
        skipped.push({ name: entry.name, reason: '目录条目' });
        continue;
      }
      if (entry.encrypted) {
        skipped.push({ name: entry.name, reason: '加密条目' });
        continue;
      }
      if (entry.method !== 0 && entry.method !== 8) {
        skipped.push({ name: entry.name, reason: `不支持的压缩方式 ${entry.method}` });
        continue;
      }

      let rel;
      try {
        rel = normalizeRel(prefix ? `${prefix}/${entry.name}` : entry.name);
      } catch {
        rel = null;
      }
      if (!rel) {
        skipped.push({ name: entry.name, reason: '路径非法（忽略）' });
        continue;
      }

      total += entry.uncompressedSize;
      if (total > maxTotalBytes) throw new Error('解压后总体积超过上限，已中止');

      let abs;
      try {
        abs = resolveInside(destRoot, rel);
      } catch {
        skipped.push({ name: entry.name, reason: '路径越界（忽略）' });
        continue;
      }

      const start = await dataOffsetOf(handle, entry);
      const end = start + entry.compressedSize - 1;
      const source = entry.compressedSize > 0 ? createReadStream(zipPath, { start, end }) : null;

      await fsp.mkdir(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.part-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;

      try {
        if (!source) {
          await fsp.writeFile(tmp, Buffer.alloc(0));
        } else if (entry.method === 8) {
          await pipeline(source, zlib.createInflateRaw(), createWriteStream(tmp));
        } else {
          await pipeline(source, createWriteStream(tmp));
        }
        try {
          await fsp.utimes(tmp, entry.mtime, entry.mtime);
        } catch {
          // 时间设置失败不影响内容
        }
        await fsp.rename(tmp, abs);
      } catch (err) {
        await fsp.rm(tmp, { force: true });
        skipped.push({ name: entry.name, reason: `解压失败：${err.message}` });
        continue;
      }

      files.push({ rel, size: entry.uncompressedSize });
    }
  } finally {
    await handle.close();
  }

  return { files, skipped };
}
