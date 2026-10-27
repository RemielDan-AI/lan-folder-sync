/**
 * 局域网相关：本机地址、端口探测、UDP 自动发现
 * ------------------------------------------------------------------
 * 发现只是"省得手输 IP"的便利功能，不是同步的必需品；
 * 万一被防火墙挡住，界面里仍然可以手填地址 + 配对码。
 */

import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';

import { DISCOVERY_PORT } from './config.js';

export const DISCOVERY_TAG = 'commsync-discovery';

/** 本机所有可用于局域网访问的 IPv4 地址 */
export function lanAddresses() {
  const out = [];
  const interfaces = os.networkInterfaces();
  for (const [name, items] of Object.entries(interfaces)) {
    for (const item of items || []) {
      if (item.family !== 'IPv4' && item.family !== 4) continue;
      if (item.internal) continue;
      out.push({ iface: name, address: item.address, netmask: item.netmask || '255.255.255.0' });
    }
  }
  return out;
}

function directedBroadcast(address, netmask) {
  try {
    const ip = address.split('.').map(Number);
    const mask = netmask.split('.').map(Number);
    if (ip.length !== 4 || mask.length !== 4) return null;
    const broadcast = ip.map((part, index) => (part & mask[index]) | (~mask[index] & 255));
    return broadcast.join('.');
  } catch {
    return null;
  }
}

/** 端口被占用时顺延找下一个可用端口，避免双击两次就起不来 */
export function probePort(preferred, { host = '0.0.0.0', tries = 20 } = {}) {
  return new Promise((resolve, reject) => {
    let port = preferred;
    let remaining = tries;
    const attempt = () => {
      const server = net.createServer();
      server.unref();
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && remaining > 0) {
          remaining -= 1;
          port += 1;
          attempt();
          return;
        }
        reject(err);
      });
      server.listen({ port, host, exclusive: true }, () => {
        const actual = server.address().port;
        server.close(() => resolve(actual));
      });
    };
    attempt();
  });
}

/**
 * UDP 广播发现：周期性喊出自己的存在，同时收集同网段其它实例。
 * 端口被占用或系统禁止广播时静默降级，不影响主功能。
 */
export class Discovery {
  constructor({ id, name, port, onPeer, onError, intervalMs = 3000, ttlMs = 12000 }) {
    this.id = id;
    this.name = name;
    this.port = port;
    this.onPeer = onPeer || (() => {});
    this.onError = onError || (() => {});
    this.intervalMs = intervalMs;
    this.ttlMs = ttlMs;
    this.socket = null;
    this.timer = null;
    this.peers = new Map();
    this.pruneTimer = null;
  }

  start() {
    if (this.socket) return;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('error', (err) => {
      this.onError(err);
      this.stop();
    });

    socket.on('message', (buffer, rinfo) => {
      let payload;
      try {
        payload = JSON.parse(buffer.toString('utf8'));
      } catch {
        return;
      }
      if (!payload || payload.tag !== DISCOVERY_TAG) return;
      if (payload.id === this.id) return;
      if (!payload.port) return;
      const peer = {
        id: payload.id,
        name: payload.name || payload.id.slice(0, 8),
        address: rinfo.address,
        port: payload.port,
        url: `http://${rinfo.address}:${payload.port}`,
        lastSeen: Date.now(),
      };
      this.peers.set(peer.id, peer);
      this.onPeer(peer);
    });

    socket.bind(DISCOVERY_PORT, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        // 某些受限网络不允许广播
      }
      this.#broadcast();
      this.timer = setInterval(() => this.#broadcast(), this.intervalMs);
      this.pruneTimer = setInterval(() => this.#prune(), Math.max(2000, this.ttlMs / 3));
    });

    socket.on('listening', () => socket.setBroadcast(true));
    this.timer = null;
  }

  #targets() {
    const targets = new Set(['255.255.255.255']);
    for (const item of lanAddresses()) {
      const broadcast = directedBroadcast(item.address, item.netmask);
      if (broadcast) targets.add(broadcast);
    }
    return [...targets];
  }

  #broadcast() {
    if (!this.socket) return;
    const payload = JSON.stringify({ tag: DISCOVERY_TAG, v: 1, id: this.id, name: this.name, port: this.port });
    const buffer = Buffer.from(payload, 'utf8');
    for (const target of this.#targets()) {
      try {
        this.socket.send(buffer, 0, buffer.length, DISCOVERY_PORT, target, () => {});
      } catch {
        // 单个地址发不出去就跳过
      }
    }
  }

  #prune() {
    const now = Date.now();
    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeen > this.ttlMs) this.peers.delete(id);
    }
  }

  list() {
    const now = Date.now();
    return [...this.peers.values()]
      .filter((peer) => now - peer.lastSeen <= this.ttlMs)
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.timer = null;
    this.pruneTimer = null;
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // 已经关了
      }
      this.socket = null;
    }
  }
}

/** 把用户输入的地址补全成规范 baseUrl */
export function normalizeBaseUrl(input) {
  if (!input) return null;
  let value = String(input).trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  try {
    const url = new URL(value);
    if (!url.port) url.port = '47800';
    return `${url.protocol}//${url.hostname === '::1' ? '[::1]' : url.hostname}:${url.port}`;
  } catch {
    return null;
  }
}
