/**
 * 证书加载器：公共输入为单张证书 DER。
 *
 * PEM/CER/Base64 与多证书拆分由入口工具 `certificatesToDer` 完成；
 * URL/path/filePath 由 UI/CLI 读取成字节并转换，crypto 不 import `node:*`。
 * 所有输入受 `maxBytes`/`maxCertificates` 限制，重复证书按 SHA-256 指纹去重。
 */

import { CryptoError, isCryptoError, type CryptoErrorCode } from '../errors';
import type { X509Certificate } from '../asn1/x509';
import type { CertificateDer } from '../types/certificate';
import { DEFAULT_CRYPTO_LIMITS } from '../types/limits';
import type { CryptoWarningHandler } from '../types/warnings';
import { throwIfAborted } from '../util/argument';
import { createWarningCollector, type WarningCollector } from '../util/warning';
import { parseCertificate } from './parse';

/** 证书加载选项。 */
export interface CertificateLoadOptions {
  /** 单张证书 DER 上限，单位 byte；默认 `maxAsn1Bytes`。 */
  readonly maxBytes?: number;
  /** 证书总数上限，默认 `maxCertificates`。 */
  readonly maxCertificates?: number;
  /** 取消信号。 */
  readonly signal?: AbortSignal;
  /** warning 回调。 */
  readonly onWarning?: CryptoWarningHandler;
  /** 非法项跳过并 warning（默认 false：抛错）。 */
  readonly skipInvalid?: boolean;
  /** 失败时映射的错误码；默认 `CRYPTO_CERTIFICATE_INVALID`。 */
  readonly invalidCode?: CryptoErrorCode;
}

/**
 * 加载并解析多个证书 DER。
 *
 * @param inputs 证书 DER 数组；每项为恰好一张证书的完整 DER。
 * @param options 加载选项；`maxBytes` 单位 byte。
 * @returns 按输入顺序去重后的证书数组。
 * @throws CryptoError `CRYPTO_CERTIFICATE_INVALID`（或 `invalidCode`）/
 *   `CRYPTO_LIMIT_EXCEEDED` / `CRYPTO_ABORTED` / `CRYPTO_INVALID_ARGUMENT`。
 */
export async function loadCertificates(
  inputs: readonly CertificateDer[],
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
    if (!(input instanceof Uint8Array)) {
      throw new CryptoError('CRYPTO_INVALID_ARGUMENT', '证书输入必须是 Uint8Array');
    }
    if (certificates.length >= maxCertificates) {
      throw new CryptoError('CRYPTO_LIMIT_EXCEEDED', `证书数量超过上限 ${maxCertificates}`);
    }

    let certificate: X509Certificate;
    try {
      certificate = parseCertificate(input, { maxBytes });
    } catch (error) {
      handleFailure(error, invalidCode, skipInvalid, collector);
      continue;
    }
    if (seen.has(certificate.fingerprintSha256)) continue;
    seen.add(certificate.fingerprintSha256);
    certificates.push(certificate);
  }
  return certificates;
}

/**
 * 加载并解析单个证书 DER。
 *
 * @param input 单张证书 DER。
 * @param options 加载选项。
 * @returns 证书。
 * @throws CryptoError `CRYPTO_CERTIFICATE_INVALID`（或 `invalidCode`）：没有可用证书。
 */
export async function loadCertificate(
  input: CertificateDer,
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
 * 处理单个输入失败：按 `skipInvalid` 抛错或 warning 后跳过。
 *
 * @param error 原始错误。
 * @param invalidCode 映射错误码。
 * @param skipInvalid 是否跳过。
 * @param collector warning 收集器。
 */
function handleFailure(
  error: unknown,
  invalidCode: CryptoErrorCode,
  skipInvalid: boolean,
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
    if (error.code === 'CRYPTO_SOURCE_UNSUPPORTED') {
      if (!skipInvalid) throw error;
      collector.emit({
        code: 'W_CRYPTO_CERT_SOURCE_UNSUPPORTED',
        message: error.message,
        path: 'der',
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
    path: 'der',
  });
}