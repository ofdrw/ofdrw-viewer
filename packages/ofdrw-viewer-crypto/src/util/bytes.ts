/**
 * 字节、十六进制、Base64 与 UTF-8 工具。
 *
 * 浏览器与 Node 22 共用：不依赖 `Buffer`、`node:*`，Base64 使用纯 JS 实现，
 * 以便对非法字符/长度做严格校验。
 */

import { CryptoError } from '../errors';
import { constantTimeEqual } from './compare';

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 字符到 6 bit 值的反查表；-1 表示非法字符。 */
const BASE64_LOOKUP = /* @__PURE__ */ (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i += 1) {
    table[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/**
 * 把 `ArrayBuffer` / `Uint8Array` 统一为 `Uint8Array` 视图。
 *
 * @param value 输入字节。
 * @returns `Uint8Array` 视图；`ArrayBuffer` 输入会创建新视图但不复制。
 */
export function toUint8Array(value: ArrayBuffer | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new CryptoError('CRYPTO_INVALID_ARGUMENT', '期望 ArrayBuffer 或 Uint8Array');
}

/**
 * 拼接多个字节数组。
 *
 * @param parts 字节数组片段。
 * @returns 新数组。
 */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * 复制字节数组，避免调用方修改内部缓存。
 *
 * @param bytes 输入字节。
 * @returns 新的独立副本。
 */
export function copyBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

/**
 * 常量时间比较两个字节数组（长度不等时立即返回 false）。
 *
 * @param a 字节数组 A。
 * @param b 字节数组 B。
 * @returns 完全相等返回 true。
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return constantTimeEqual(a, b);
}

/**
 * 字节数组转小写十六进制。
 *
 * @param bytes 输入字节。
 * @returns 小写十六进制字符串。
 */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * 严格解析十六进制字符串。
 *
 * @param hex 十六进制字符串；忽略空白。
 * @returns 字节数组。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT`：长度非偶数或含非法字符。
 */
export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  if (clean.length % 2 !== 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', '十六进制字符串长度必须为偶数');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const high = hexNibble(clean.charCodeAt(i * 2));
    const low = hexNibble(clean.charCodeAt(i * 2 + 1));
    if (high < 0 || low < 0) {
      throw new CryptoError('CRYPTO_INVALID_ARGUMENT', '十六进制字符串包含非法字符');
    }
    out[i] = (high << 4) | low;
  }
  return out;
}

/**
 * 单个十六进制字符转 4 bit 值。
 *
 * @param code 字符码点。
 * @returns 0..15；非法返回 -1。
 */
function hexNibble(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  return -1;
}

/**
 * 字节数组转标准 Base64（带 `=` 填充）。
 *
 * @param bytes 输入字节。
 * @returns Base64 字符串。
 */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const hasB1 = i + 1 < bytes.length;
    const hasB2 = i + 2 < bytes.length;
    const b1 = hasB1 ? bytes[i + 1] : 0;
    const b2 = hasB2 ? bytes[i + 2] : 0;
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += hasB1 ? BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += hasB2 ? BASE64_ALPHABET[b2 & 0x3f] : '=';
  }
  return out;
}

/**
 * 严格解析 Base64。
 *
 * 规则：忽略 ASCII 空白；长度必须是 4 的倍数；`=` 只允许出现在末尾且最多 2 个；
 * 不允许 URL-safe 字符（`-`/`_`）。任何违规都返回 `null`，由调用方决定错误码。
 *
 * @param text Base64 文本。
 * @returns 字节数组；非法返回 null。
 */
export function tryFromBase64(text: string): Uint8Array | null {
  const clean = text.replace(/[\t\n\r ]+/g, '');
  if (clean.length === 0) return new Uint8Array(0);
  if (clean.length % 4 !== 0) return null;

  let padding = 0;
  if (clean.endsWith('==')) padding = 2;
  else if (clean.endsWith('=')) padding = 1;
  const dataLength = clean.length - padding;
  if (padding > 0) {
    for (let i = dataLength; i < clean.length; i += 1) {
      if (clean.charCodeAt(i) !== 0x3d) return null;
    }
  }

  const out = new Uint8Array((clean.length / 4) * 3 - padding);
  let outIndex = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = base64Value(clean.charCodeAt(i));
    const c1 = base64Value(clean.charCodeAt(i + 1));
    const c2 = i + 2 < dataLength ? base64Value(clean.charCodeAt(i + 2)) : 0;
    const c3 = i + 3 < dataLength ? base64Value(clean.charCodeAt(i + 3)) : 0;
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) return null;
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (outIndex < out.length) out[outIndex++] = (triple >> 16) & 0xff;
    if (outIndex < out.length) out[outIndex++] = (triple >> 8) & 0xff;
    if (outIndex < out.length) out[outIndex++] = triple & 0xff;
  }
  return out;
}

/**
 * Base64 字符码点转 6 bit 值。
 *
 * @param code 字符码点。
 * @returns 0..63；非法返回 -1。
 */
function base64Value(code: number): number {
  if (code >= 128) return -1;
  return BASE64_LOOKUP[code];
}

/**
 * 严格解析 Base64；非法时抛 `CRYPTO_INVALID_ARGUMENT`。
 *
 * 需要上下文错误码（如 `CRYPTO_CERTIFICATE_INVALID`）时请使用 `tryFromBase64`。
 *
 * @param text Base64 文本。
 * @returns 字节数组。
 */
export function fromBase64(text: string): Uint8Array {
  const bytes = tryFromBase64(text);
  if (!bytes) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'Base64 文本非法');
  }
  return bytes;
}

/**
 * UTF-8 编码。
 *
 * @param text 文本。
 * @returns UTF-8 字节。
 */
export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * UTF-8 解码。
 *
 * @param bytes UTF-8 字节。
 * @returns 文本；非法序列会替换为 U+FFFD（不抛错，便于诊断）。
 */
export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * 把字节数组清零，用于释放明文/密钥引用前的清理。
 *
 * @param bytes 待清零数组；调用方负责不再使用。
 */
export function zeroize(bytes: Uint8Array): void {
  bytes.fill(0);
}

/**
 * 左侧补零到指定长度。
 *
 * @param bytes 输入字节。
 * @param length 目标长度，单位 byte。
 * @returns 长度不足时返回新数组；超长时抛 `CRYPTO_INVALID_ARGUMENT`。
 */
export function leftPadBytes(bytes: Uint8Array, length: number): Uint8Array {
  if (bytes.length > length) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', `字节长度超过预期 ${length}`);
  }
  if (bytes.length === length) return bytes;
  const out = new Uint8Array(length);
  out.set(bytes, length - bytes.length);
  return out;
}