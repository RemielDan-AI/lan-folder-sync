/**
 * 极简 ZIP 打包（仅存储模式，不压缩）
 * ------------------------------------------------------------------
 * 用途：零安装浏览器页一键把整个文件夹下载回去。
 * 之所以不压缩：同步场景里文件多为已压缩格式（图片/文档/压缩包），
 * 再压一遍既慢又几乎没收益；存储模式实现简单、可流式输出、内存恒定。
 * 限制：单文件与总大小需小于 4GB（zip64 不支持），超了直接报错而不是产出坏包。
 */

import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_32 = 0xffffffff;

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  CRC_TABLE = table;
  return table;
}

export function crc32Update(crc, buffer) {
  const table = crcTable();
  let value = crc ^ 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    value = table[(value ^ buffer[i]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

export function crc32(buffer) {
  return crc32Update(0, buffer);
}

async function crcOfFile(abs) {
  let crc = 0;
  await new Promise((resolve, reject) => {
    const stream = createReadStream(abs);
    stream.on('data', (chunk) => {
      crc = crc32Update(crc, chunk);
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return crc >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

function localHeader({ nameLength, crc, size, time, date }) {
  const buffer = Buffer.alloc(30);
  buffer.writeUInt32LE(0x04034b50, 0);
  buffer.writeUInt16LE(20, 4); // 解压所需版本
  buffer.writeUInt16LE(0x0800, 6); // UTF-8 文件名
  buffer.writeUInt16LE(0, 8); // 存储模式
  buffer.writeUInt16LE(time, 10);
  buffer.writeUInt16LE(date, 12);
  buffer.writeUInt32LE(crc, 14);
  buffer.writeUInt32LE(size, 18); // 压缩后大小
  buffer.writeUInt32LE(size, 22); // 原始大小
  buffer.writeUInt16LE(nameLength, 26);
  buffer.writeUInt16LE(0, 28); // extra 长度
  return buffer;
}

function centralHeader({ nameLength, crc, size, time, date, offset }) {
  const buffer = Buffer.alloc(46);
  buffer.writeUInt32LE(0x02014b50, 0);
  buffer.writeUInt16LE(20, 4); // 创建方版本
  buffer.writeUInt16LE(20, 6); // 解压所需版本
  buffer.writeUInt16LE(0x0800, 8);
  buffer.writeUInt16LE(0, 10);
  buffer.writeUInt16LE(time, 12);
  buffer.writeUInt16LE(date, 14);
  buffer.writeUInt32LE(crc, 16);
  buffer.writeUInt32LE(size, 20);
  buffer.writeUInt32LE(size, 24);
  buffer.writeUInt16LE(nameLength, 28);
  buffer.writeUInt16LE(0, 30);
  buffer.writeUInt16LE(0, 32);
  buffer.writeUInt16LE(0, 34);
  buffer.writeUInt16LE(0, 36);
  buffer.writeUInt32LE(0, 38);
  buffer.writeUInt32LE(offset, 42);
  return buffer;
}

function endOfCentralDirectory({ count, size, offset }) {
  const buffer = Buffer.alloc(22);
  buffer.writeUInt32LE(0x06054b50, 0);
  buffer.writeUInt16LE(0, 4);
  buffer.writeUInt16LE(0, 6);
  buffer.writeUInt16LE(count, 8);
  buffer.writeUInt16LE(count, 10);
  buffer.writeUInt32LE(size, 12);
  buffer.writeUInt32LE(offset, 16);
  buffer.writeUInt16LE(0, 20);
  return buffer;
}

function localHeaderStreaming({ nameLength, time, date }) {
  const buffer = Buffer.alloc(30);
  buffer.writeUInt32LE(0x04034b50, 0);
  buffer.writeUInt16LE(20, 4);
  // 0x0800 = UTF-8 文件名，0x0008 = CRC/长度写在数据之后（数据描述符）
  buffer.writeUInt16LE(0x0808, 6);
  buffer.writeUInt16LE(0, 8);
  buffer.writeUInt16LE(time, 10);
  buffer.writeUInt16LE(date, 12);
  buffer.writeUInt32LE(0, 14);
  buffer.writeUInt32LE(0, 18);
  buffer.writeUInt32LE(0, 22);
  buffer.writeUInt16LE(nameLength, 26);
  buffer.writeUInt16LE(0, 28);
  return buffer;
}

function dataDescriptor({ crc, size }) {
  const buffer = Buffer.alloc(16);
  buffer.writeUInt32LE(0x08074b50, 0);
  buffer.writeUInt32LE(crc, 4);
  buffer.writeUInt32LE(size, 8);
  buffer.writeUInt32LE(size, 12);
  return buffer;
}

/**
 * 从任意数据源生成 ZIP 字节流（用于"打包下载对方文件夹"）。
 *
 * 与 zipStream 的区别：这里的文件在对端，不能为了算 CRC 先下载一遍，
 * 所以用数据描述符（general purpose bit 3）：本地头里 CRC/长度留 0，
 * 数据写完后再补 16 字节的描述符，中央目录里仍然是真实值。
 *
 * @param {Array<{name: string, size: number, mtimeMs?: number, open: () => Promise<AsyncIterable<Buffer>>}>} sources
 */
export async function* zipStreamFromSources(sources, { onProgress } = {}) {
  const central = [];
  let cursor = 0;
  let done = 0;

  for (const source of sources) {
    if (source.size > MAX_32) {
      throw new Error(`${source.name} 超过 4GB，打包下载不支持`);
    }
    const { time, date } = dosDateTime(new Date(source.mtimeMs || Date.now()));
    const nameBuffer = Buffer.from(source.name, 'utf8');
    const offset = cursor;

    const header = localHeaderStreaming({ nameLength: nameBuffer.length, time, date });
    yield header;
    yield nameBuffer;
    cursor += header.length + nameBuffer.length;

    let crc = 0;
    let written = 0;
    const stream = await source.open();
    for await (const chunk of stream) {
      crc = crc32Update(crc, chunk);
      written += chunk.length;
      cursor += chunk.length;
      yield chunk;
    }
    if (written !== source.size) {
      throw new Error(`${source.name} 传输中断（收到 ${written}/${source.size} 字节）`);
    }

    const descriptor = dataDescriptor({ crc: crc >>> 0, size: written });
    yield descriptor;
    cursor += descriptor.length;

    central.push({ nameBuffer, crc: crc >>> 0, size: written, time, date, offset });
    done += 1;
    if (onProgress) onProgress(done, sources.length, source.name);
  }

  const centralStart = cursor;
  for (const item of central) {
    const header = centralHeader({
      nameLength: item.nameBuffer.length,
      crc: item.crc,
      size: item.size,
      time: item.time,
      date: item.date,
      offset: item.offset,
    });
    yield header;
    yield item.nameBuffer;
    cursor += header.length + item.nameBuffer.length;
  }

  const centralSize = cursor - centralStart;
  if (centralSize > MAX_32 || cursor > MAX_32) {
    throw new Error('总大小超过 4GB，打包下载不支持');
  }

  yield endOfCentralDirectory({ count: central.length, size: centralSize, offset: centralStart });
}

/**
 * 生成 ZIP 字节流：逐个文件产出 Buffer，调用方直接写进 HTTP 响应。
 * @param {string} root 本地根目录绝对路径
 * @param {string[]} relPaths 相对路径列表（/ 分隔）
 */
export async function* zipStream(root, relPaths, { onProgress } = {}) {
  const central = [];
  let cursor = 0;
  let done = 0;

  for (const rel of relPaths) {
    const abs = path.join(root, ...rel.split('/'));
    const stat = await fsp.stat(abs);
    if (stat.size > MAX_32) {
      throw new Error(`${rel} 超过 4GB，打包下载不支持`);
    }

    const crc = await crcOfFile(abs);
    const { time, date } = dosDateTime(stat.mtime);
    const nameBuffer = Buffer.from(rel, 'utf8');
    const offset = cursor;

    const header = localHeader({ nameLength: nameBuffer.length, crc, size: stat.size, time, date });
    yield header;
    yield nameBuffer;
    cursor += header.length + nameBuffer.length;

    let written = 0;
    for await (const chunk of createReadStream(abs)) {
      written += chunk.length;
      cursor += chunk.length;
      yield chunk;
    }
    if (written !== stat.size) {
      throw new Error(`${rel} 在打包过程中被修改，已中止`);
    }

    central.push({ nameBuffer, crc, size: stat.size, time, date, offset });
    done += 1;
    if (onProgress) onProgress(done, relPaths.length, rel);
  }

  const centralStart = cursor;
  for (const item of central) {
    const header = centralHeader({
      nameLength: item.nameBuffer.length,
      crc: item.crc,
      size: item.size,
      time: item.time,
      date: item.date,
      offset: item.offset,
    });
    yield header;
    yield item.nameBuffer;
    cursor += header.length + item.nameBuffer.length;
  }

  const centralSize = cursor - centralStart;
  if (centralSize > MAX_32 || cursor > MAX_32) {
    throw new Error('总大小超过 4GB，打包下载不支持');
  }

  yield endOfCentralDirectory({ count: central.length, size: centralSize, offset: centralStart });
}
