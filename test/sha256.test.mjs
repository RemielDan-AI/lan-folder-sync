/**
 * 纯 JS SHA-256：标准测试向量 + 分块一致性
 * （分块这块最容易写错，必须验证"一次喂完"和"切碎喂"结果相同）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createSha256, sha256Hex, toHex } from '../shared/sha256.js';

const utf8 = (text) => new TextEncoder().encode(text);

test('标准测试向量', () => {
  assert.equal(sha256Hex(utf8('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex(utf8('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    sha256Hex(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
});

test('与 node:crypto 结果一致（含中文与二进制）', () => {
  const samples = [
    utf8('局域网同步 · Communication'),
    new Uint8Array(0),
    new Uint8Array([0, 255, 128, 7]),
    new Uint8Array(1024).fill(0xab),
    new Uint8Array(65_000).map((_, index) => index % 251),
  ];
  for (const sample of samples) {
    assert.equal(sha256Hex(sample), createHash('sha256').update(sample).digest('hex'));
  }
});

test('任意分块方式结果一致', () => {
  const data = new Uint8Array(5000).map((_, index) => (index * 31) % 256);
  const expected = createHash('sha256').update(data).digest('hex');

  for (const size of [1, 3, 63, 64, 65, 127, 1000]) {
    const hasher = createSha256();
    for (let offset = 0; offset < data.length; offset += size) {
      hasher.update(data.subarray(offset, Math.min(offset + size, data.length)));
    }
    assert.equal(toHex(hasher.digest()), expected, `分块大小 ${size} 时结果不一致`);
  }
});

test('在 64 字节边界上更新也对', () => {
  const data = new Uint8Array(64).fill(1);
  const expected = createHash('sha256').update(data).digest('hex');
  const hasher = createSha256();
  hasher.update(data.subarray(0, 64));
  assert.equal(toHex(hasher.digest()), expected);

  const hasher2 = createSha256();
  hasher2.update(data.subarray(0, 56)); // 触发双块填充
  hasher2.update(data.subarray(56));
  assert.equal(toHex(hasher2.digest()), expected);
});
