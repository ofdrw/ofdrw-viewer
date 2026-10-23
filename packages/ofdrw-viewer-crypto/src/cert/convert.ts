/**
 * 证书入口转换工具：把 DER/CER、PEM、Base64 输入转换为逐张证书 DER。
 *
 * 只做格式识别、字节拆分与 X.509 最小合法性校验，不建信任链、不输出摘要/
 * 指纹，也不判定 valid/untrusted/unknown。UI/CLI 在调用 crypto 证书接口前
 * 统一经过本工具，crypto 内核只接收 `CertificateDer`。
 */

import { CryptoError, isCryptoError } from '../errors';
import { parseDer, parseDerAll, type DerNode } from '../asn1/der';
import { parseX509Certificate } from '../asn1/x509';
import type { CertificateDer } from '../types/certificate';
import { DEFAULT_CRYPTO_LIMITS } from '../types/limits';
import {
  copyBytes,
  tryFromBase64,
  utf8Decode,
  utf8Encode,
} from '../util/bytes';
import { parsePemBlocks } from '../util/pem';

/** 证书转换选项；字节类字段单位均为 byte。 */
export interface CertificatesToDerOptions {
  /** 原始输入与单张输出 DER 的上限，单位 byte；默认 `maxAsn1Bytes`。 */
  readonly maxBytes?: number;
  /** 输出证书张数上限；默认 `maxCertificates`。 */
  readonly maxCertificates?: number;
}

/** PEM 中允许的证书块类型。 */
const CERTIFICATE_PEM_TYPES = new Set([
  'CERTIFICATE',
  'X509 CERTIFICATE',
  'TRUSTED CERTIFICATE',
]);

/**
 * 把证书输入转换为逐张 DER。
 *
 * 支持 DER/CER 字节、DER 拼接、PEM（单/多证书、CRLF、块外文字）与 Base64 文本。
 * 输出顺序与输入一致；每项为独立副本，归调用方所有。
 *
 * @param input 原始输入：ArrayBuffer/Uint8Array 或 PEM/Base64 字符串。
 * @param options 大小与数量上限；`maxBytes` 单位 byte。
 * @returns 按输入顺序排列的每张证书 DER。
 * @throws CryptoError `CRYPTO_CERTIFICATE_INVALID` / `CRYPTO_LIMIT_EXCEEDED` / `CRYPTO_INVALID_ARGUMENT`。
 */
export function certificatesToDer(
  input: ArrayBuffer | Uint8Array | string,
  options: CertificatesToDerOptions = {},
): readonly CertificateDer[] {
  const maxBytes = resolveMaxBytes(options);
  const maxCertificates = resolveMaxCertificates(options);
  const bytes = toInputBytes(input);
  if (bytes.length === 0) throw certificateError('输入为空');
  if (bytes.length > maxBytes) throw limitError(bytes.length, maxBytes);

  // 文本输入允许 UTF-8 BOM；DER 不会以 BOM 开头，统一裁掉后再识别。
  const content = stripUtf8Bom(bytes);
  if (content.length === 0) throw certificateError('输入为空');
  const text = utf8Decode(content);
  let certificates: readonly CertificateDer[];

  if (text.includes('-----BEGIN ')) {
    certificates = parsePemCertificates(text, maxBytes);
  } else if (typeof input !== 'string' && firstNonWhitespaceByte(content) === 0x30) {
    try {
      certificates = parseDerBundle(content, maxBytes);
    } catch (error) {
      // Base64 文本可能以字符 `0`（0x30）开头；DER 解析失败后按可打印文本
      // 回退一次 Base64，避免仅因首字节相同而误判。
      if (!isPrintableText(text) || isLimitError(error)) throw error;
      const decoded = tryFromBase64(text);
      if (!decoded || decoded.length === 0) throw error;
      certificates = parseDerBundle(decoded, maxBytes);
    }
  } else {
    const decoded = tryFromBase64(text);
    if (!decoded || decoded.length === 0) {
      throw certificateError('既不是 PEM/DER，也不是合法 Base64');
    }
    certificates = parseDerBundle(decoded, maxBytes);
  }

  if (certificates.length > maxCertificates) {
    throw new CryptoError(
      'CRYPTO_LIMIT_EXCEEDED',
      `证书数量 ${certificates.length} 超过上限 ${maxCertificates}`,
    );
  }
  return certificates;
}

/**
 * 把输入统一为字节。
 *
 * @param input 原始输入。
 * @returns UTF-8 字节或原始 DER 字节。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT`：类型不受支持。
 */
function toInputBytes(input: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof input === 'string') return utf8Encode(input);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new CryptoError(
    'CRYPTO_INVALID_ARGUMENT',
    '证书输入必须是 ArrayBuffer、Uint8Array 或字符串',
  );
}

/**
 * 解析并校验 `maxBytes`。
 *
 * @param options 转换选项。
 * @returns 上限，单位 byte。
 */
function resolveMaxBytes(options: CertificatesToDerOptions): number {
  const maxBytes = options.maxBytes ?? DEFAULT_CRYPTO_LIMITS.maxAsn1Bytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'maxBytes 必须是正整数');
  }
  return maxBytes;
}

/**
 * 解析并校验 `maxCertificates`。
 *
 * @param options 转换选项。
 * @returns 上限，单位张。
 */
function resolveMaxCertificates(options: CertificatesToDerOptions): number {
  const maxCertificates = options.maxCertificates ?? DEFAULT_CRYPTO_LIMITS.maxCertificates;
  if (!Number.isSafeInteger(maxCertificates) || maxCertificates <= 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'maxCertificates 必须是正整数');
  }
  return maxCertificates;
}

/**
 * 解析 PEM 文本中的证书。
 *
 * 非证书块在存在证书块时忽略；只有非证书块时视为非法输入。
 *
 * @param text PEM 文本。
 * @param maxBytes 单张 DER 上限，单位 byte。
 * @returns 逐张证书 DER。
 */
function parsePemCertificates(
  text: string,
  maxBytes: number,
): readonly CertificateDer[] {
  let blocks;
  try {
    blocks = parsePemBlocks(text);
  } catch (error) {
    throw wrapCertificateError(error, 'PEM 解析失败');
  }
  const certificateBlocks = blocks.filter((block) => CERTIFICATE_PEM_TYPES.has(block.type));
  if (certificateBlocks.length === 0) {
    throw certificateError('PEM 中没有 CERTIFICATE 块');
  }
  return certificateBlocks.map((block) => {
    if (block.der.length === 0) throw certificateError('PEM 证书内容为空');
    if (block.der.length > maxBytes) throw limitError(block.der.length, maxBytes);
    if (block.type === 'TRUSTED CERTIFICATE') {
      // TRUSTED CERTIFICATE 在证书 DER 后可能附加 OpenSSL 信任信息；只取首个 TLV。
      const nodes = parseDerNodes(block.der, maxBytes);
      const first = nodes[0];
      if (!first) throw certificateError('TRUSTED CERTIFICATE 内容为空');
      return parseDerCertificate(first.raw, maxBytes);
    }
    return parseDerCertificate(block.der, maxBytes);
  });
}

/**
 * 解析由 DER 证书直接拼接的字节。
 *
 * @param bytes DER 字节。
 * @param maxBytes 输入与单张证书 DER 上限，单位 byte。
 * @returns 逐张证书 DER。
 */
function parseDerBundle(
  bytes: Uint8Array,
  maxBytes: number,
): readonly CertificateDer[] {
  if (bytes.length === 0) throw certificateError('输入为空');
  if (bytes.length > maxBytes) throw limitError(bytes.length, maxBytes);
  const nodes = parseDerNodes(bytes, maxBytes);
  if (nodes.length === 0) throw certificateError('输入为空');
  return nodes.map((node) => {
    if (!node.isUniversal(0x10)) throw certificateError('DER 顶层不是 SEQUENCE');
    return parseDerCertificate(node.raw, maxBytes);
  });
}

/**
 * 按长度边界解析连续 DER TLV。
 *
 * @param bytes DER 字节。
 * @param maxBytes 字节上限，单位 byte。
 * @returns DER 节点。
 */
function parseDerNodes(bytes: Uint8Array, maxBytes: number): readonly DerNode[] {
  try {
    return parseDerAll(bytes, { maxBytes });
  } catch (error) {
    throw wrapCertificateError(error, 'DER 结构非法');
  }
}

/**
 * 解析并校验单张证书 DER。
 *
 * @param der 证书 DER（必须恰好一个 TLV）。
 * @param maxBytes 字节上限，单位 byte。
 * @returns 证书 DER 的独立副本。
 */
function parseDerCertificate(der: Uint8Array, maxBytes: number): CertificateDer {
  let node;
  try {
    node = parseDer(der, { maxBytes });
  } catch (error) {
    throw wrapCertificateError(error, 'DER 结构非法');
  }
  if (!node.isUniversal(0x10)) throw certificateError('DER 顶层不是 SEQUENCE');
  try {
    parseX509Certificate(node.raw, { maxBytes });
  } catch (error) {
    throw wrapCertificateError(error, 'X.509 结构非法');
  }
  return copyBytes(node.raw);
}

/**
 * 裁掉输入开头的 UTF-8 BOM。
 *
 * @param bytes 输入字节。
 * @returns 去掉 BOM 后的视图；无 BOM 时返回原视图。
 */
function stripUtf8Bom(bytes: Uint8Array): Uint8Array {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? bytes.subarray(3)
    : bytes;
}

/**
 * 获取首个非 ASCII 空白字节。
 *
 * @param bytes 输入字节。
 * @returns 字节值；没有时返回 -1。
 */
function firstNonWhitespaceByte(bytes: Uint8Array): number {
  for (const byte of bytes) {
    if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x20) return byte;
  }
  return -1;
}

/**
 * 判断文本是否只含可打印 ASCII 与空白。
 *
 * @param text 文本。
 * @returns 可打印时返回 true。
 */
function isPrintableText(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/**
 * 判断错误是否为超限错误。
 *
 * @param error 错误。
 * @returns 超限时返回 true。
 */
function isLimitError(error: unknown): boolean {
  return isCryptoError(error) && error.code === 'CRYPTO_LIMIT_EXCEEDED';
}

/**
 * 构造超限错误。
 *
 * @param actual 实际字节数，单位 byte。
 * @param maxBytes 上限，单位 byte。
 * @returns CryptoError。
 */
function limitError(actual: number, maxBytes: number): CryptoError {
  return new CryptoError(
    'CRYPTO_LIMIT_EXCEEDED',
    `证书输入大小 ${actual} byte 超过上限 ${maxBytes} byte`,
  );
}

/**
 * 包装解析错误为 `CRYPTO_CERTIFICATE_INVALID`。
 *
 * @param error 原始错误。
 * @param message 前缀。
 * @returns CryptoError。
 */
function wrapCertificateError(error: unknown, message: string): CryptoError {
  if (isLimitError(error)) return error as CryptoError;
  if (isCryptoError(error) && error.code === 'CRYPTO_CERTIFICATE_INVALID') return error;
  if (isCryptoError(error) && error.code === 'CRYPTO_INVALID_ARGUMENT') return error;
  const detail = error instanceof Error ? error.message : String(error);
  return certificateError(`${message}：${detail}`);
}

/**
 * 构造证书错误。
 *
 * @param message 信息。
 * @returns CryptoError。
 */
function certificateError(message: string): CryptoError {
  return new CryptoError('CRYPTO_CERTIFICATE_INVALID', `证书转换失败：${message}`);
}