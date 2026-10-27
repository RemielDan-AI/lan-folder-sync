/**
 * ZIP 打包器：CRC32 已知向量 + 系统解压工具真实还原
 * （自己解析自己写的包没有意义，所以这里用 Windows 自带 Expand-Archive 验一次）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import { crc32, zipStream } from '../lib/zip.js';

const run = promisify(execFile);

test('CRC32 与标准测试向量一致', () => {
  assert.equal(crc32(Buffer.from('123456789')).toString(16), 'cbf43926');
  assert.equal(crc32(Buffer.from('')), 0);
  assert.equal(crc32(Buffer.from('a')).toString(16), 'e8b7be43');
});

test('打包出的 zip 能被系统工具正确还原', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'zip-check-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const src = path.join(root, 'src');
  await fsp.mkdir(path.join(src, '子目录'), { recursive: true });
  await fsp.writeFile(path.join(src, 'a.txt'), 'hello 中文\n');
  await fsp.writeFile(path.join(src, '子目录', 'b.bin'), Buffer.alloc(1000, 3));

  const zipPath = path.join(root, 'out.zip');
  await pipeline(Readable.from(zipStream(src, ['a.txt', '子目录/b.bin'])), createWriteStream(zipPath));

  const stat = await fsp.stat(zipPath);
  assert.equal(stat.size > 1100, true, 'zip 体积应大于内容总和');

  if (process.platform !== 'win32') {
    t.skip('仅在 Windows 上验证系统解压');
    return;
  }

  const out = path.join(root, 'unzipped');
  await run('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${out}' -Force`,
  ]);

  assert.equal(await fsp.readFile(path.join(out, 'a.txt'), 'utf8'), 'hello 中文\n');
  const bin = await fsp.readFile(path.join(out, '子目录', 'b.bin'));
  assert.equal(bin.length, 1000);
  assert.equal(bin[999], 3);
});
