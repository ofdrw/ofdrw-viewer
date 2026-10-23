/**
 * `Signature.xml` 中 References 的 CheckValue 校验。
 *
 * 设计裁决（R8）：CheckValue 是**对文件原始字节做 SM3 后取 Base64**；
 * 为兼容历史实现，同时接受 64 字符十六进制。两者长度均必须为 32 byte。
 *
 * 校验语义：
 * - 缺失文件 → `missing`；
 * - 摘要不符 / CheckValue 无法解码 → `mismatch`；
 * - CheckMethod 不是 SM3 或 References 为空 → `unsupported`（签名整体 invalid）。
 */

import type { VirtualContainer } from '@ofdrw/ofdrw-viewer-engine';
import { OID_SM3 } from '../asn1/oid';
import { CryptoError } from '../errors';
import { sm3Digest } from '../sm/sm3';
import type { CryptoLimits } from '../types/limits';
import { bytesEqual, fromHex, tryFromBase64 } from '../util/bytes';
import { resolvePackagePath } from './paths';
import { readEntry } from './read';
import type { ReferenceCheckResult, ReferenceFailure } from './types';
import type { SignatureReferenceXml } from './signature-xml';

/** Reference 校验选项。 */
export interface VerifyReferencesOptions {
  /** 容器。 */
  readonly container: VirtualContainer;
  /** Signature.xml 所在目录，用于解析相对 FileRef。 */
  readonly baseDir: string;
  /** References@CheckMethod（省略视为 SM3）。 */
  readonly checkMethod?: string;
  /** 资源限制。 */
  readonly limits: CryptoLimits;
  /** 取消信号。 */
  readonly signal?: AbortSignal;
}

/** SM3 摘要长度，单位 byte。 */
const SM3_LENGTH = 32;

/**
 * 逐条校验 Reference CheckValue。
 *
 * @param references Reference 列表（XML 原文）。
 * @param options 容器/目录/限制。
 * @returns 校验结果；不抛错（读取层面的 typed error 会向上抛出）。
 * @throws CryptoError `CRYPTO_INVALID_PACKAGE` / `CRYPTO_LIMIT_EXCEEDED` / `CRYPTO_ABORTED`。
 */
export async function verifyReferences(
  references: readonly SignatureReferenceXml[],
  options: VerifyReferencesOptions,
): Promise<ReferenceCheckResult> {
  if (references.length > options.limits.maxEntries) {
    throw new CryptoError(
      'CRYPTO_LIMIT_EXCEEDED',
      `Reference 数量 ${references.length} 超过上限 ${options.limits.maxEntries}`,
    );
  }
  const method = (options.checkMethod ?? 'SM3').trim().toUpperCase();
  if (references.length === 0) {
    return { status: 'unsupported', total: 0, checked: 0, failures: [] };
  }
  if (method !== 'SM3' && method !== OID_SM3) {
    return {
      status: 'unsupported',
      total: references.length,
      checked: 0,
      failures: references.map((reference) => ({
        fileRef: reference.fileRef,
        reason: 'unsupported' as const,
      })),
    };
  }

  const failures: ReferenceFailure[] = [];
  let checked = 0;
  for (const reference of references) {
    if (options.signal?.aborted) {
      throw new CryptoError('CRYPTO_ABORTED', '操作已取消');
    }
    const fileRef = resolvePackagePath(options.baseDir, reference.fileRef);
    const bytes = await readEntry(fileRef, {
      container: options.container,
      limits: options.limits,
      signal: options.signal,
    });
    if (!bytes) {
      failures.push({ fileRef, reason: 'missing' });
      continue;
    }
    const expected = decodeCheckValue(reference.checkValue);
    if (!expected) {
      failures.push({ fileRef, reason: 'mismatch' });
      continue;
    }
    if (!bytesEqual(sm3Digest(bytes), expected)) {
      failures.push({ fileRef, reason: 'mismatch' });
      continue;
    }
    checked += 1;
  }

  if (failures.some((failure) => failure.reason === 'unsupported')) {
    return { status: 'unsupported', total: references.length, checked, failures };
  }
  return {
    status: failures.length === 0 ? 'valid' : 'invalid',
    total: references.length,
    checked,
    failures,
  };
}

/**
 * 解码 CheckValue。
 *
 * @param text CheckValue 文本。
 * @returns 32 byte 摘要；无法解码返回 undefined。
 */
function decodeCheckValue(text: string): Uint8Array | undefined {
  const clean = text.trim();
  if (clean.length === 0) return undefined;
  if (/^[0-9a-fA-F]{64}$/.test(clean)) return fromHex(clean);
  const base64 = tryFromBase64(clean);
  if (base64 && base64.length === SM3_LENGTH) return base64;
  return undefined;
}