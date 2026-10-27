/**
 * 文件传输
 * ------------------------------------------------------------------
 * 下载：先写 .part 临时文件，边写边算 SHA-256，校验通过才改名覆盖目标；
 *       并把对端的修改时间还原，让两端的"签名"保持一致，下次扫描可以秒过。
 * 上传：流式发送，接收端同样校验哈希，写完才落正式文件。
 * 任何一步失败都保留原有文件，不会出现"半截文件把好文件覆盖了"。
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { PeerError, openRequest, readBody } from './peer-api.js';

function fileUrl(rel, folderId) {
  const params = new URLSearchParams({ path: rel });
  if (folderId) params.set('folderId', folderId);
  return `/api/peer/file?${params.toString()}`;
}

function tmpName(destAbs) {
  return `${destAbs}.part-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
}

async function hashOfFile(abs) {
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
 * 从对端下载一个文件到本地绝对路径。
 * 返回 { sha256, size, mtimeMs, sig }
 */
export async function downloadFromPeer({ baseUrl, token, rel, destAbs, expectedSha256, folderId, onProgress }) {
  await fsp.mkdir(path.dirname(destAbs), { recursive: true });
  const tmp = tmpName(destAbs);

  let res;
  try {
    res = await openRequest(baseUrl, fileUrl(rel, folderId), { token });
  } catch (err) {
    throw err;
  }

  if (res.statusCode !== 200) {
    const raw = await readBody(res).catch(() => Buffer.alloc(0));
    throw new PeerError(`下载 ${rel} 失败（HTTP ${res.statusCode}）`, {
      status: res.statusCode,
      body: raw.toString('utf8').slice(0, 300),
    });
  }

  const declaredSize = Number(res.headers['content-length'] || 0);
  const declaredHash = (res.headers['x-content-sha256'] || '').toString();
  const declaredMtime = Number(res.headers['x-file-mtime'] || 0);

  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _enc, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      if (onProgress) onProgress(bytes, declaredSize || bytes);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(res, meter, createWriteStream(tmp, { flags: 'w' }));
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err instanceof PeerError ? err : new PeerError(`下载 ${rel} 中断：${err.message}`);
  }

  const actualHash = hash.digest('hex');
  const wantHash = expectedSha256 || declaredHash;
  if (wantHash && actualHash !== wantHash) {
    await fsp.rm(tmp, { force: true });
    throw new PeerError(`校验失败：${rel} 内容与预期不一致`, { code: 'HASH_MISMATCH' });
  }

  const mtime = declaredMtime > 0 ? new Date(declaredMtime) : new Date();
  try {
    await fsp.utimes(tmp, mtime, mtime);
  } catch {
    // 个别文件系统不支持改时间，不影响内容
  }

  await fsp.rename(tmp, destAbs);
  const stat = await fsp.stat(destAbs);
  return { sha256: actualHash, size: stat.size, mtimeMs: stat.mtimeMs, sig: `${stat.size}:${Math.round(stat.mtimeMs)}` };
}

/**
 * 上传一个本地文件到对端。
 * 返回对端落盘后的 { sha256, size, mtimeMs, sig }
 */
export async function uploadToPeer({ baseUrl, token, rel, abs, sha256, size, mtimeMs, folderId, onProgress }) {
  const stat = await fsp.stat(abs);
  const contentLength = Number(size ?? stat.size);
  const modified = Number(mtimeMs ?? stat.mtimeMs);
  const digest = sha256 || (await hashOfFile(abs));

  const stream = createReadStream(abs);
  let sent = 0;
  const meter = new Transform({
    transform(chunk, _enc, callback) {
      sent += chunk.length;
      if (onProgress) onProgress(sent, contentLength || sent);
      callback(null, chunk);
    },
  });
  stream.pipe(meter);

  const res = await openRequest(baseUrl, fileUrl(rel, folderId), {
    method: 'PUT',
    token,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(contentLength),
      'X-File-Mtime': String(Math.round(modified)),
      'X-File-Sha256': digest,
    },
    body: meter,
  });

  const raw = await readBody(res).catch(() => Buffer.alloc(0));
  const text = raw.toString('utf8');
  if (res.statusCode !== 200) {
    let message = `上传 ${rel} 失败（HTTP ${res.statusCode}）`;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error) message = parsed.error;
    } catch {
      // 对端没返回 JSON，就用状态码
    }
    throw new PeerError(message, { status: res.statusCode, body: text.slice(0, 300) });
  }

  try {
    return JSON.parse(text);
  } catch {
    return { sha256: digest, size: contentLength, mtimeMs: modified, sig: `${contentLength}:${Math.round(modified)}` };
  }
}

/** 删除本地文件；父目录空了顺手清掉（不动根目录） */
export async function deleteLocalFile(rootAbs, abs) {
  await fsp.rm(abs, { force: true });
  let dir = path.dirname(abs);
  const stop = path.resolve(rootAbs);
  while (dir && path.resolve(dir) !== stop && dir.startsWith(stop)) {
    try {
      const entries = await fsp.readdir(dir);
      if (entries.length) break;
      await fsp.rmdir(dir);
      dir = path.dirname(dir);
    } catch {
      break;
    }
  }
}
