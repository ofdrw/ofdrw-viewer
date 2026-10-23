/**
 * 证书解析：仅接收 X.509 证书 DER。
 *
 * PEM/CER/Base64 与多证书识别由入口工具 `certificatesToDer` 完成；
 * 本模块不解析文本，也不感知宿主路径。`parseCertificates` 允许输入由
 * 多张证书 DER 直接拼接的字节，`parseCertificate` 要求恰好一张证书。
 */

import { CryptoError, isCryptoError } from '../errors';
import {
  parseDer,
  parseDerAll,
  type DerParseOptions,
} from '../asn1/der';
import { parseX509Certificate, type X509Certificate } from '../asn1/x509';
import type { CertificateDer } from '../types/certificate';
import { DEFAULT_CRYPTO_LIMITS } from '../types/limits';

/** 证书解析选项。 */
export interface CertificateParseOptions extends DerParseOptions {
  /** 最多解析证书数，默认 `maxCertificates`。 */
  readonly maxCertificates?: number;
}

/**
 * 解析一张或多张证书 DER。
 *
 * 输入可由多张证书 DER 直接拼接；每张证书必须是完整顶层 `SEQUENCE`。
 *
 * @param input 证书 DER 字节。
 * @param options 大小/深度/数量上限。
 * @returns 证书数组；顺序与输入一致。
 * @throws CryptoError `CRYPTO_CERTIFICATE_INVALID` / `CRYPTO_LIMIT_EXCEEDED` / `CRYPTO_INVALID_ARGUMENT`。
 */
export function parseCertificates(
  input: CertificateDer,
  options: CertificateParseOptions = {},
): readonly X509Certificate[] {
  const maxBytes = resolveMaxBytes(options);
  const maxCertificates = resolveMaxCertificates(options);
  requireCertificateDer(input);
  if (input.length === 0) throw certificateError('输入为空');
  if (input.length > maxBytes) throw limitError(input.length, maxBytes);

  let nodes;
  try {
    nodes = parseDerAll(input, derOptions(options, maxBytes));
  } catch (error) {
    throw wrapCertificateError(error, 'DER 结构非法');
  }
  if (nodes.length === 0) throw certificateError('输入为空');
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
 * 解析单张证书 DER（必须恰好一张）。
 *
 * 与 `parseCertificates` 不同，输入必须恰好是一张证书，尾随字节视为非法。
 *
 * @param input 证书 DER 字节。
 * @param options 大小/深度/数量上限。
 * @returns 证书。
 * @throws CryptoError `CRYPTO_CERTIFICATE_INVALID` / `CRYPTO_LIMIT_EXCEEDED` / `CRYPTO_INVALID_ARGUMENT`。
 */
export function parseCertificate(
  input: CertificateDer,
  options: CertificateParseOptions = {},
): X509Certificate {
  const maxBytes = resolveMaxBytes(options);
  requireCertificateDer(input);
  if (input.length === 0) throw certificateError('输入为空');
  if (input.length > maxBytes) throw limitError(input.length, maxBytes);

  let node;
  try {
    node = parseDer(input, derOptions(options, maxBytes));
  } catch (error) {
    throw wrapCertificateError(error, 'DER 结构非法');
  }
  if (!node.isUniversal(0x10)) throw certificateError('DER 顶层不是 SEQUENCE');
  return parseSingle(node.raw, options);
}

/**
 * 校验证书 DER 输入类型。
 *
 * @param input 待校验输入。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT`：不是 `Uint8Array`。
 */
function requireCertificateDer(input: unknown): asserts input is CertificateDer {
  if (!(input instanceof Uint8Array)) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', '证书 DER 必须是 Uint8Array');
  }
}

/**
 * 解析并校验 `maxBytes`。
 *
 * @param options 解析选项。
 * @returns 上限，单位 byte。
 */
function resolveMaxBytes(options: CertificateParseOptions): number {
  const maxBytes = options.maxBytes ?? DEFAULT_CRYPTO_LIMITS.maxAsn1Bytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'maxBytes 必须是正整数');
  }
  return maxBytes;
}

/**
 * 解析并校验 `maxCertificates`。
 *
 * @param options 解析选项。
 * @returns 上限，单位张。
 */
function resolveMaxCertificates(options: CertificateParseOptions): number {
  const maxCertificates = options.maxCertificates ?? DEFAULT_CRYPTO_LIMITS.maxCertificates;
  if (!Number.isSafeInteger(maxCertificates) || maxCertificates <= 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'maxCertificates 必须是正整数');
  }
  return maxCertificates;
}

/**
 * 把公共选项收窄为 DER 解析选项。
 *
 * @param options 证书解析选项。
 * @param maxBytes 已校验的字节上限，单位 byte。
 * @returns DER 解析选项。
 */
function derOptions(
  options: CertificateParseOptions,
  maxBytes: number,
): DerParseOptions {
  return {
    maxBytes,
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    ...(options.maxNodes === undefined ? {} : { maxNodes: options.maxNodes }),
  };
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
    `证书 DER 大小 ${actual} byte 超过上限 ${maxBytes} byte`,
  );
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
  return new CryptoError('CRYPTO_CERTIFICATE_INVALID', `证书解析失败：${message}`);
}