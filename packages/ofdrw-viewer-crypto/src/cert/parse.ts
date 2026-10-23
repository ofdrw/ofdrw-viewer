/**
 * 证书解析：PEM / DER / CER / Base64 文本，支持单证书与多证书拼接。
 */

import { CryptoError, isCryptoError } from '../errors';
import { parseDerAll, type DerParseOptions } from '../asn1/der';
import { parseX509Certificate, type X509Certificate } from '../asn1/x509';
import { DEFAULT_CRYPTO_LIMITS } from '../types/limits';
import { tryFromBase64, utf8Decode, utf8Encode } from '../util/bytes';
import { looksLikePem, parsePemBlocks } from '../util/pem';

/** 证书解析选项。 */
export interface CertificateParseOptions extends DerParseOptions {
  /** 最多解析证书数，默认 `maxCertificates`。 */
  readonly maxCertificates?: number;
}

/** PEM 中允许的证书块类型。 */
const CERTIFICATE_PEM_TYPES = new Set([
  'CERTIFICATE',
  'X509 CERTIFICATE',
  'TRUSTED CERTIFICATE',
]);

/**
 * 解析一张或多张证书。
 *
 * 输入可以是：
 * - PEM 文本（可含多张证书）；
 * - DER/CER 字节（可拼接多张）；
 * - Base64 文本（DER 的 Base64）。
 *
 * @param input 文本或字节。
 * @param options 大小/深度/数量上限。
 * @returns 证书数组；顺序与输入一致。
 * @throws CryptoError `CRYPTO_CERTIFICATE_INVALID` / `CRYPTO_LIMIT_EXCEEDED` / `CRYPTO_INVALID_ARGUMENT`。
 */
export function parseCertificates(
  input: Uint8Array | string,
  options: CertificateParseOptions = {},
): readonly X509Certificate[] {
  const maxBytes = options.maxBytes ?? DEFAULT_CRYPTO_LIMITS.maxAsn1Bytes;
  const maxCertificates = options.maxCertificates ?? DEFAULT_CRYPTO_LIMITS.maxCertificates;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'maxBytes 必须是正整数');
  }
  if (!Number.isSafeInteger(maxCertificates) || maxCertificates <= 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'maxCertificates 必须是正整数');
  }

  const bytes = toInputBytes(input);
  if (bytes.length > maxBytes) {
    throw new CryptoError(
      'CRYPTO_LIMIT_EXCEEDED',
      `证书输入大小 ${bytes.length} byte 超过上限 ${maxBytes} byte`,
    );
  }
  if (bytes.length === 0) throw certificateError('输入为空');

  const text = utf8Decode(bytes);
  if (looksLikePem(text)) {
    let blocks;
    try {
      blocks = parsePemBlocks(text);
    } catch (error) {
      throw wrapCertificateError(error, 'PEM 解析失败');
    }
    const certificates = blocks.filter((block) => CERTIFICATE_PEM_TYPES.has(block.type));
    if (certificates.length === 0) {
      throw certificateError('PEM 中没有 CERTIFICATE 块');
    }
    if (certificates.length > maxCertificates) {
      throw new CryptoError(
        'CRYPTO_LIMIT_EXCEEDED',
        `证书数量 ${certificates.length} 超过上限 ${maxCertificates}`,
      );
    }
    return certificates.map((block) => parseSingle(block.der, options));
  }

  // DER/CER：首字节为 SEQUENCE，允许拼接多张；否则尝试按 Base64 文本解码。
  if (bytes[0] === 0x30) {
    return parseDerCertificates(bytes, options, maxCertificates);
  }
  const decoded = tryFromBase64(text);
  if (!decoded || decoded.length === 0) {
    throw certificateError('既不是 PEM/DER，也不是合法 Base64');
  }
  return parseDerCertificates(decoded, options, maxCertificates);
}

/**
 * 解析单张证书（取第一张）。
 *
 * @param input 文本或字节。
 * @param options 大小/深度/数量上限。
 * @returns 第一张证书。
 * @throws CryptoError `CRYPTO_CERTIFICATE_INVALID` / `CRYPTO_LIMIT_EXCEEDED`。
 */
export function parseCertificate(
  input: Uint8Array | string,
  options: CertificateParseOptions = {},
): X509Certificate {
  const certificates = parseCertificates(input, options);
  const first = certificates[0];
  if (!first) throw certificateError('没有可解析的证书');
  return first;
}

/**
 * 把文本/字节输入统一为字节。
 *
 * @param input 输入。
 * @returns 字节。
 */
function toInputBytes(input: Uint8Array | string): Uint8Array {
  if (typeof input === 'string') return utf8Encode(input);
  if (input instanceof Uint8Array) return input;
  throw new CryptoError('CRYPTO_INVALID_ARGUMENT', '证书输入必须是 string 或 Uint8Array');
}

/**
 * 解析连续 DER 证书。
 *
 * @param bytes DER 字节。
 * @param options 解析上限。
 * @param maxCertificates 数量上限。
 * @returns 证书数组。
 */
function parseDerCertificates(
  bytes: Uint8Array,
  options: CertificateParseOptions,
  maxCertificates: number,
): readonly X509Certificate[] {
  let nodes;
  try {
    nodes = parseDerAll(bytes, options);
  } catch (error) {
    throw wrapCertificateError(error, 'DER 结构非法');
  }
  if (nodes.length > maxCertificates) {
    throw new CryptoError(
      'CRYPTO_LIMIT_EXCEEDED',
      `证书数量 ${nodes.length} 超过上限 ${maxCertificates}`,
    );
  }
  return nodes.map((node) => {
    if (!node.isUniversal(0x10)) throw certificateError('DER 顶层不是 SEQUENCE');
    return parseSingle(node.raw, options);
  });
}

/**
 * 解析单张证书 DER。
 *
 * @param der 证书 DER。
 * @param options 解析上限。
 * @returns 证书。
 */
function parseSingle(der: Uint8Array, options: CertificateParseOptions): X509Certificate {
  try {
    return parseX509Certificate(der, options);
  } catch (error) {
    throw wrapCertificateError(error, 'X.509 结构非法');
  }
}

/**
 * 包装解析错误为 `CRYPTO_CERTIFICATE_INVALID`。
 *
 * @param error 原始错误。
 * @param message 前缀。
 * @returns CryptoError。
 */
function wrapCertificateError(error: unknown, message: string): CryptoError {
  if (isCryptoError(error) && error.code === 'CRYPTO_LIMIT_EXCEEDED') return error;
  if (isCryptoError(error) && error.code === 'CRYPTO_CERTIFICATE_INVALID') return error;
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
  return new CryptoError('CRYPTO_CERTIFICATE_INVALID', `证书解析失败：${message}`);
}