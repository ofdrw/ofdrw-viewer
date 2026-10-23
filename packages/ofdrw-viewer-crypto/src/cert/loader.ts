/**
 * 证书输入加载器。
 *
 * 公共输入为设计 §3.1 的 `data`/`pem`/`der` 三态，自包含、直接解析；
 * URL/path/filePath 由 UI/CLI 读取成字节后转成三态输入，crypto 不 import `node:*`。
 * 所有输入受 `maxBytes`/`maxCertificates` 限制，重复证书按 SHA-256 指纹去重。
 */

import { CryptoError, isCryptoError, type CryptoErrorCode } from '../errors';
import type { X509Certificate } from '../asn1/x509';
import type { CertificateInput } from '../types/certificate';
import { DEFAULT_CRYPTO_LIMITS } from '../types/limits';
import type { CryptoWarningHandler } from '../types/warnings';
import { requireWithinBytes, throwIfAborted } from '../util/argument';
import { toUint8Array, utf8Encode } from '../util/bytes';
import { createWarningCollector, type WarningCollector } from '../util/warning';
import { parseCertificates } from './parse';

/** 证书加载选项。 */
export interface CertificateLoadOptions {
  /** 单个来源字节上限，单位 byte；默认 `maxAsn1Bytes`。 */
  readonly maxBytes?: number;
  /** 证书总数上限，默认 `maxCertificates`。 */
  readonly maxCertificates?: number;
  /** 取消信号。 */
  readonly signal?: AbortSignal;
  /** warning 回调。 */
  readonly onWarning?: CryptoWarningHandler;
  /** 来源/解析失败时跳过并 warning（默认 false：抛错）。 */
  readonly skipInvalid?: boolean;
  /** 失败时映射的错误码；默认 `CRYPTO_CERTIFICATE_INVALID`。 */
  readonly invalidCode?: CryptoErrorCode;
}

/**
 * 加载并解析多个证书输入。
 *
 * @param inputs 证书输入数组；每项 `data`/`pem`/`der` 三选一。
 * @param options 加载选项。
 * @returns 去重后的证书数组。
 * @throws CryptoError `CRYPTO_CERTIFICATE_INVALID`（或 `invalidCode`）/
 *   `CRYPTO_LIMIT_EXCEEDED` / `CRYPTO_ABORTED` / `CRYPTO_INVALID_ARGUMENT`。
 */
export async function loadCertificates(
  inputs: readonly CertificateInput[],
  options: CertificateLoadOptions = {},
): Promise<readonly X509Certificate[]> {
  if (!Array.isArray(inputs)) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', '证书输入必须是数组');
  }
  const maxBytes = options.maxBytes ?? DEFAULT_CRYPTO_LIMITS.maxAsn1Bytes;
  const maxCertificates = options.maxCertificates ?? DEFAULT_CRYPTO_LIMITS.maxCertificates;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'maxBytes 必须是正整数');
  }
  if (!Number.isSafeInteger(maxCertificates) || maxCertificates <= 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'maxCertificates 必须是正整数');
  }
  const invalidCode = options.invalidCode ?? 'CRYPTO_CERTIFICATE_INVALID';
  const skipInvalid = options.skipInvalid ?? false;
  const collector = createWarningCollector(options.onWarning);
  const certificates: X509Certificate[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    throwIfAborted(options.signal);
    if (!input || typeof input !== 'object' || countInputSources(input) !== 1) {
      throw new CryptoError(
        'CRYPTO_INVALID_ARGUMENT',
        '证书输入必须且只能提供 data/pem/der 之一',
      );
    }
    if (certificates.length >= maxCertificates) {
      throw new CryptoError('CRYPTO_LIMIT_EXCEEDED', `证书数量超过上限 ${maxCertificates}`);
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await readInputBytes(input, maxBytes, options.signal);
    } catch (error) {
      handleFailure(error, invalidCode, skipInvalid, input, collector);
      continue;
    }
    if (!bytes) continue;

    let parsed: readonly X509Certificate[];
    try {
      parsed = parseCertificates(bytes, {
        maxBytes,
        maxCertificates: maxCertificates - certificates.length,
      });
    } catch (error) {
      handleFailure(error, invalidCode, skipInvalid, input, collector);
      continue;
    }
    for (const certificate of parsed) {
      if (seen.has(certificate.fingerprintSha256)) continue;
      seen.add(certificate.fingerprintSha256);
      certificates.push(certificate);
      if (certificates.length > maxCertificates) {
        throw new CryptoError(
          'CRYPTO_LIMIT_EXCEEDED',
          `证书数量超过上限 ${maxCertificates}`,
        );
      }
    }
  }
  return certificates;
}

/**
 * 加载并解析单个证书输入（取第一张）。
 *
 * @param input 证书输入。
 * @param options 加载选项。
 * @returns 证书。
 * @throws CryptoError `CRYPTO_CERTIFICATE_INVALID`（或 `invalidCode`）：没有可用证书。
 */
export async function loadCertificate(
  input: CertificateInput,
  options: CertificateLoadOptions = {},
): Promise<X509Certificate> {
  const certificates = await loadCertificates([input], options);
  const first = certificates[0];
  if (!first) {
    throw new CryptoError(
      options.invalidCode ?? 'CRYPTO_CERTIFICATE_INVALID',
      '没有加载到可用证书',
    );
  }
  return first;
}

/**
 * 统计输入声明的来源数量。
 *
 * @param input 证书输入。
 * @returns 来源字段数。
 */
function countInputSources(input: CertificateInput): number {
  let count = 0;
  if (input.data !== undefined) count += 1;
  if (input.pem !== undefined) count += 1;
  if (input.der !== undefined) count += 1;
  return count;
}

/**
 * 获取来源显示名（不含 URL 查询串等潜在敏感内容）。
 *
 * @param input 证书输入。
 * @returns 显示名。
 */
function sourceLabel(input: CertificateInput): string {
  if (input.pem !== undefined) return 'pem';
  if (input.der !== undefined) return 'der';
  return 'data';
}

/**
 * 读取输入字节。
 *
 * @param input 证书输入。
 * @param maxBytes 单来源上限，单位 byte。
 * @param signal 取消信号。
 * @returns 字节。
 */
async function readInputBytes(
  input: CertificateInput,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  throwIfAborted(signal);
  if (input.data !== undefined) {
    const bytes = toUint8Array(input.data);
    requireWithinBytes(bytes.length, maxBytes, '证书输入');
    return bytes;
  }
  if (input.pem !== undefined) {
    const bytes = utf8Encode(input.pem);
    requireWithinBytes(bytes.length, maxBytes, '证书输入');
    return bytes;
  }
  if (input.der !== undefined) {
    const bytes = toUint8Array(input.der);
    requireWithinBytes(bytes.length, maxBytes, '证书输入');
    return bytes;
  }
  throw new CryptoError(
    'CRYPTO_INVALID_ARGUMENT',
    '证书输入必须且只能提供 data/pem/der 之一',
  );
}

/**
 * 处理单个输入失败：按 `skipInvalid` 抛错或 warning 后跳过。
 *
 * @param error 原始错误。
 * @param invalidCode 映射错误码。
 * @param skipInvalid 是否跳过。
 * @param input 当前输入。
 * @param collector warning 收集器。
 */
function handleFailure(
  error: unknown,
  invalidCode: CryptoErrorCode,
  skipInvalid: boolean,
  input: CertificateInput,
  collector: WarningCollector,
): void {
  if (isCryptoError(error)) {
    if (
      error.code === 'CRYPTO_INVALID_ARGUMENT' ||
      error.code === 'CRYPTO_ABORTED' ||
      error.code === 'CRYPTO_LIMIT_EXCEEDED'
    ) {
      throw error;
    }
    // 来源缺失/不支持保留原错误码；只有内容非法才映射为 invalidCode。
    if (error.code === 'CRYPTO_SOURCE_UNSUPPORTED') {
      if (!skipInvalid) throw error;
      collector.emit({
        code: 'W_CRYPTO_CERT_SOURCE_UNSUPPORTED',
        message: error.message,
        path: sourceLabel(input),
      });
      return;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (!skipInvalid) {
    throw new CryptoError(invalidCode, message, { cause: error });
  }
  collector.emit({
    code: 'W_CRYPTO_CERT_SOURCE_UNSUPPORTED',
    message,
    path: sourceLabel(input),
  });
}