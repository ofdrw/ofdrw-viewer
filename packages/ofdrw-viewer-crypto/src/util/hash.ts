/**
 * SHA-256 摘要（纯 JS，浏览器/Node 共用）。
 *
 * 用途：证书 DER 指纹（`CertificateSummary.fingerprintSha256`）与来源去重。
 * 该实现不用于 SM 系列算法；SM3 见 `sm/sm3.ts`。
 *
 * 说明：一次性处理整个输入，不做流式分块；调用方应先用 `CryptoLimits`
 * 限制输入大小（证书/ASN.1 结构远小于上限）。
 */

/** SHA-256 轮常量。 */
const K = /* @__PURE__ */ new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 初始哈希值。 */
const INIT = /* @__PURE__ */ new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/**
 * 32 位循环右移。
 *
 * @param value 输入值。
 * @param bits 位移位数，单位 bit（0..31）。
 * @returns 循环右移结果。
 */
function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/**
 * 计算 SHA-256 摘要。
 *
 * @param data 输入字节。
 * @returns 32 byte 摘要。
 */
export function sha256(data: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil((data.length + 9) / 64) * 64;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(data);
  buffer[data.length] = 0x80;

  // 末尾 8 byte 写入 64 位大端比特长度；输入长度受调用方上限约束，远小于 2^53 bit。
  const bitLength = data.length * 8;
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  buffer[paddedLength - 8] = (high >>> 24) & 0xff;
  buffer[paddedLength - 7] = (high >>> 16) & 0xff;
  buffer[paddedLength - 6] = (high >>> 8) & 0xff;
  buffer[paddedLength - 5] = high & 0xff;
  buffer[paddedLength - 4] = (low >>> 24) & 0xff;
  buffer[paddedLength - 3] = (low >>> 16) & 0xff;
  buffer[paddedLength - 2] = (low >>> 8) & 0xff;
  buffer[paddedLength - 1] = low & 0xff;

  const hash = INIT.slice();
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4;
      w[i] = ((buffer[j] << 24) | (buffer[j + 1] << 16) | (buffer[j + 2] << 8) | buffer[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = hash[0];
    let b = hash[1];
    let c = hash[2];
    let d = hash[3];
    let e = hash[4];
    let f = hash[5];
    let g = hash[6];
    let h = hash[7];

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i += 1) {
    out[i * 4] = (hash[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (hash[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (hash[i] >>> 8) & 0xff;
    out[i * 4 + 3] = hash[i] & 0xff;
  }
  return out;
}

/**
 * 计算 SHA-256 并输出小写十六进制。
 *
 * @param data 输入字节。
 * @returns 64 字符小写十六进制。
 */
export function sha256Hex(data: Uint8Array): string {
  let out = '';
  for (const byte of sha256(data)) out += byte.toString(16).padStart(2, '0');
  return out;
}