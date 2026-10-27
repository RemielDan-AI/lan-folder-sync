/**
 * 纯 JS SHA-256（流式）
 * ------------------------------------------------------------------
 * 为什么需要它：crypto.subtle 只在"安全上下文"（https 或 localhost）里存在。
 * 手机/另一台电脑用 http://192.168.x.x:47800/lite 打开时没有 crypto.subtle，
 * 没有这个实现，零安装页的推送就没有校验值可用。
 *
 * 用法：
 *   const hasher = createSha256();
 *   hasher.update(uint8array);   // 可多次
 *   const hex = toHex(hasher.digest());
 * 内存占用恒定（只缓存一个 64 字节块），可以边读边算。
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INIT = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

const rotr = (value, bits) => (value >>> bits) | (value << (32 - bits));

export function createSha256() {
  const state = new Uint32Array(INIT);
  const schedule = new Uint32Array(64);
  const buffer = new Uint8Array(64);
  let bufferLength = 0;
  let totalLength = 0;

  function compress(block, offset) {
    for (let i = 0; i < 16; i += 1) {
      const p = offset + i * 4;
      schedule[i] = ((block[p] << 24) | (block[p + 1] << 16) | (block[p + 2] << 8) | block[p + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = schedule[i - 15];
      const w2 = schedule[i - 2];
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      schedule[i] = (schedule[i - 16] + s0 + schedule[i - 7] + s1) >>> 0;
    }

    let a = state[0];
    let b = state[1];
    let c = state[2];
    let d = state[3];
    let e = state[4];
    let f = state[5];
    let g = state[6];
    let h = state[7];

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + schedule[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }

  return {
    update(bytes) {
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      totalLength += data.length;
      let offset = 0;

      if (bufferLength > 0) {
        const need = Math.min(64 - bufferLength, data.length);
        buffer.set(data.subarray(0, need), bufferLength);
        bufferLength += need;
        offset = need;
        if (bufferLength < 64) return this;
        compress(buffer, 0);
        bufferLength = 0;
      }

      while (offset + 64 <= data.length) {
        compress(data, offset);
        offset += 64;
      }

      if (offset < data.length) {
        buffer.set(data.subarray(offset));
        bufferLength = data.length - offset;
      }
      return this;
    },

    digest() {
      const totalBits = totalLength * 8;
      const paddedLength = bufferLength < 56 ? 64 : 128;
      const padded = new Uint8Array(paddedLength);
      padded.set(buffer.subarray(0, bufferLength));
      padded[bufferLength] = 0x80;

      const view = new DataView(padded.buffer);
      // 长度字段是 64 位大端；JS 数字最多精确到 2^53，这里拆高低位写入
      view.setUint32(paddedLength - 8, Math.floor(totalBits / 0x100000000));
      view.setUint32(paddedLength - 4, totalBits >>> 0);

      for (let offset = 0; offset < paddedLength; offset += 64) compress(padded, offset);

      const out = new Uint8Array(32);
      for (let i = 0; i < 8; i += 1) {
        out[i * 4] = (state[i] >>> 24) & 0xff;
        out[i * 4 + 1] = (state[i] >>> 16) & 0xff;
        out[i * 4 + 2] = (state[i] >>> 8) & 0xff;
        out[i * 4 + 3] = state[i] & 0xff;
      }
      return out;
    },
  };
}

export function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export function sha256Hex(bytes) {
  return toHex(createSha256().update(bytes).digest());
}
