/**
 * 对端 HTTP 调用（只依赖 node:http）
 * ------------------------------------------------------------------
 * 所有需要访问另一个实例的地方都走这里：统一超时、统一错误类型、
 * 统一把令牌放在请求头里（不放在 URL 上，避免出现在日志里）。
 */

import http from 'node:http';
import { URL } from 'node:url';

export class PeerError extends Error {
  constructor(message, { status = 0, code = '', body = '' } = {}) {
    super(message);
    this.name = 'PeerError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

const CONNECT_TIMEOUT_MS = 8000;
const IDLE_TIMEOUT_MS = 120000;

function headersFor(token, extra) {
  return {
    Accept: 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

/** 发起请求，返回原始响应（调用方决定是读 JSON 还是当流处理） */
export function openRequest(baseUrl, pathname, { method = 'GET', token, headers = {}, body, timeouts = {} } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(pathname, baseUrl);
    } catch {
      reject(new PeerError(`地址无效: ${baseUrl}`));
      return;
    }

    const req = http.request(
      url,
      { method, headers: headersFor(token, headers), agent: false },
      resolve,
    );

    req.setTimeout(timeouts.idle ?? IDLE_TIMEOUT_MS, () => {
      req.destroy(new PeerError('对端响应超时', { code: 'ETIMEDOUT' }));
    });

    req.on('error', (err) => {
      if (err instanceof PeerError) reject(err);
      else reject(new PeerError(`无法连接对端：${err.message}`, { code: err.code || '' }));
    });

    if (body !== undefined && body !== null) {
      if (typeof body === 'string' || Buffer.isBuffer(body)) req.end(body);
      else if (body.pipe) body.pipe(req);
      else req.end(JSON.stringify(body));
    } else {
      req.end();
    }
  });
}

/** 读完整响应体（上限 32MB，防止误连到别的东西把内存吃光） */
export function readBody(res, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        res.destroy(new PeerError('对端响应过大', { status: res.statusCode }));
        return;
      }
      chunks.push(chunk);
    });
    res.on('error', reject);
    res.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

export async function jsonRequest(baseUrl, pathname, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await openRequest(baseUrl, pathname, {
    method,
    token,
    headers: {
      ...(body !== undefined && body !== null ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  });

  const raw = await readBody(res);
  const text = raw.toString('utf8');
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (res.statusCode >= 400) {
    const message = parsed?.error || `对端返回 ${res.statusCode}`;
    throw new PeerError(message, { status: res.statusCode, code: parsed?.code || '', body: text.slice(0, 500) });
  }
  return parsed ?? {};
}

export function fetchPeerGreet(baseUrl) {
  return jsonRequest(baseUrl, '/api/peer/greet');
}

/**
 * 打开对端某个文件的读取流（GET /api/peer/file）。
 * 返回原始的 IncomingMessage，调用方自行 pipe —— 用于"自由下载"，不参与同步。
 */
export async function openPeerFile(baseUrl, token, folderId, rel) {
  const query = `folderId=${encodeURIComponent(folderId || '')}&path=${encodeURIComponent(rel)}`;
  const res = await openRequest(baseUrl, `/api/peer/file?${query}`, { token });
  if (res.statusCode >= 400) {
    const raw = await readBody(res, 64 * 1024).catch(() => Buffer.alloc(0));
    let message = `对端返回 ${res.statusCode}`;
    try {
      message = JSON.parse(raw.toString('utf8')).error || message;
    } catch {
      // 不是 JSON，保留默认信息
    }
    throw new PeerError(message, { status: res.statusCode });
  }
  return res;
}

/** 对端对外共享的文件夹列表（id/名称/路径），让用户挑"同步到哪个文件夹" */
export function fetchPeerFolders(baseUrl, token) {
  return jsonRequest(baseUrl, '/api/peer/folders', { token, method: 'POST', body: {} });
}

export function fetchPeerManifest(baseUrl, token, folderId) {
  return jsonRequest(baseUrl, '/api/peer/manifest', { token, method: 'POST', body: { folderId } });
}

export function fetchPeerHashes(baseUrl, token, folderId, paths) {
  return jsonRequest(baseUrl, '/api/peer/hashes', { token, method: 'POST', body: { folderId, paths } });
}

export function deleteOnPeer(baseUrl, token, folderId, paths) {
  return jsonRequest(baseUrl, '/api/peer/delete', { token, method: 'POST', body: { folderId, paths } });
}

export function pairWithPeer(baseUrl, { code, name, url, id, port, token }) {
  return jsonRequest(baseUrl, '/api/pair', {
    method: 'POST',
    body: { code, name, url, id, port, token },
  });
}

export function registerOnPeer(baseUrl, token, payload) {
  return jsonRequest(baseUrl, '/api/peer/register', { token, method: 'POST', body: payload });
}
