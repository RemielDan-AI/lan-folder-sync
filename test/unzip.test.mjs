/**
 * ZIP 解包：store / deflate 两种压缩方式、中文名、子目录、zip 穿越防护
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

import { extractZip } from '../lib/unzip.js';
import { zipStream } from '../lib/zip.js';

const exists = (target) => fsp.access(target).then(() => true).catch(() => false);

async function tempDir(name) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `unzip-${name}-`));
  return dir;
}

/** 手工拼一个最简 zip（deflate），用来覆盖我们打包器不产出的压缩方式与恶意路径 */
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.data || '', 'utf8');
    const deflated = zlib.deflateRawSync(raw);
    const crc = 0; // 测试不校验 CRC
    const time = 0;
    const date = 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBuffer, deflated);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + deflated.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralBuffer, end]);
}

test('解开我们自己打的包（store 模式、中文名、子目录）', async (t) => {
  const root = await tempDir('store');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const src = path.join(root, 'src');
  await fsp.mkdir(path.join(src, '子目录'), { recursive: true });
  await fsp.writeFile(path.join(src, 'a.txt'), 'hello 中文\n');
  await fsp.writeFile(path.join(src, '子目录', 'b.txt'), '嵌套文件\n');

  const zipPath = path.join(root, 'pack.zip');
  await pipeline(Readable.from(zipStream(src, ['a.txt', '子目录/b.txt'])), createWriteStream(zipPath));

  const dest = path.join(root, 'dest');
  await fsp.mkdir(dest, { recursive: true });
  const result = await extractZip(zipPath, dest);

  assert.equal(result.files.length, 2);
  assert.equal(await fsp.readFile(path.join(dest, 'a.txt'), 'utf8'), 'hello 中文\n');
  assert.equal(await fsp.readFile(path.join(dest, '子目录', 'b.txt'), 'utf8'), '嵌套文件\n');
});

test('解开 deflate 压缩的包，且支持前缀目录', async (t) => {
  const root = await tempDir('deflate');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const zipPath = path.join(root, 'phone.zip');
  await fsp.writeFile(
    zipPath,
    buildZip([
      { name: '照片/a.txt', data: 'AAA'.repeat(500) },
      { name: 'b.md', data: '# 标题' },
    ]),
  );

  const dest = path.join(root, 'dest');
  await fsp.mkdir(dest, { recursive: true });
  const result = await extractZip(zipPath, dest, { prefix: '从手机' });

  assert.equal(result.files.length, 2);
  assert.match(result.files.map((item) => item.rel).join(','), /从手机\/照片\/a\.txt/);
  assert.equal(await fsp.readFile(path.join(dest, '从手机', '照片', 'a.txt'), 'utf8'), 'AAA'.repeat(500));
  assert.equal(result.files.find((item) => item.rel.endsWith('a.txt')).size, 1500);
});

test('zip 穿越条目被丢弃，不会写到目录外', async (t) => {
  const root = await tempDir('slip');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const zipPath = path.join(root, 'evil.zip');
  await fsp.writeFile(
    zipPath,
    buildZip([
      { name: '../../逃逸.txt', data: '不该出现' },
      { name: '正常.txt', data: '应该出现' },
    ]),
  );

  const dest = path.join(root, 'dest');
  await fsp.mkdir(dest, { recursive: true });
  const result = await extractZip(zipPath, dest);

  assert.equal(await fsp.readFile(path.join(dest, '正常.txt'), 'utf8'), '应该出现');
  assert.equal(await exists(path.join(root, '逃逸.txt')), false, '不能写到目标目录之外');
  assert.equal(await exists(path.join(path.dirname(root), '逃逸.txt')), false);
  assert.equal(result.files.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /路径非法|路径越界/);
});

test('非 zip 文件给出清晰错误', async (t) => {
  const root = await tempDir('bad');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const fake = path.join(root, 'fake.zip');
  await fsp.writeFile(fake, 'this is definitely not a zip file');
  await assert.rejects(extractZip(fake, root), /不是.*zip/i);
});
