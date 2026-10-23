/**
 * SM2 私钥解析（PKCS#8 / SEC1 PEM/DER）。
 *
 * 本期支持：
 * - 未加密 PKCS#8 PEM/DER；
 * - 未加密 SEC1（`EC PRIVATE KEY`）PEM；
 * - 私钥必须落在 sm2p256v1 曲线；非 SM2/非 EC 一律拒绝。
 *
 * 加密 PKCS#8（PBES2）不在此层解密：缺少口令抛 `CRYPTO_PRIVATE_KEY_PASSPHRASE_REQUIRED`，
 * 提供口令但算法未支持抛 `CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION`。
 *
 * 安全：私钥字节只作为返回值/局部变量存在，错误信息不包含任何私钥内容。
 */

import { CryptoError } from '../errors';
import {
  decodeOid,
  parseDer,
  type DerNode,
  type DerParseOptions,
} from '../asn1/der';
import { OID_EC_PUBLIC_KEY, OID_PBES2, OID_SM2_CURVE } from '../asn1/oid';
import type { Sm2PrivateKeyInput } from '../types/credentials';
import type { ParseOptions } from '../types/options';
import type { CryptoWarningHandler } from '../types/warnings';
import { constantTimeEqual } from '../util/compare';
import { copyBytes, fromHex } from '../util/bytes';
import { resolveParseOptions } from '../util/options';
import { parsePemBlocks } from '../util/pem';
import { normalizeSm2PrivateKey, sm2GetPublicKey, normalizeSm2PublicKey } from './sm2';

/** 解析后的 SM2 私钥。 */
export interface Sm2PrivateKey {
  /** 来源格式。 */
  readonly format: 'pkcs8' | 'sec1';
  /** 32 byte 私钥标量。 */
  readonly privateKey: Uint8Array;
  /** 65 byte 未压缩公钥（`04||X||Y`）。 */
  readonly publicKey: Uint8Array;
  /** 结构内嵌公钥（若存在），已归一化为 65 byte。 */
  readonly embeddedPublicKey?: Uint8Array;
}

/** 私钥解析选项。 */
export interface Sm2PrivateKeyParseOptions extends ParseOptions {
  /** 非致命 warning 回调；例如未加密私钥传了 passphrase。 */
  readonly onWarning?: CryptoWarningHandler;
}

/** 内部生效的解析上限与 warning 回调。 */
interface ResolvedPrivateKeyOptions {
  /** 输入字节上限，单位 byte。 */
  readonly maxBytes: number;
  /** 最大嵌套深度，单位层。 */
  readonly maxDepth: number;
  /** warning 回调。 */
  readonly onWarning?: CryptoWarningHandler;
}

/**
 * 解析 SM2 私钥。
 *
 * @param input `pem` 或 `der` 二选一；`passphrase` 仅用于加密 PKCS#8。
 * @param options DER 大小/深度上限；`onWarning` 接收未加密私钥忽略口令的 warning。
 * @returns 私钥标量与派生公钥。
 * @throws CryptoError `CRYPTO_PRIVATE_KEY_INVALID` / `CRYPTO_PRIVATE_KEY_PASSPHRASE_REQUIRED` /
 *   `CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION` / `CRYPTO_INVALID_ARGUMENT`。
 */
export function parseSm2PrivateKey(
  input: Sm2PrivateKeyInput,
  options?: Sm2PrivateKeyParseOptions,
): Sm2PrivateKey {
  if (!input || typeof input !== 'object') {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', '私钥输入必须是对象');
  }
  const hasPem = typeof input.pem === 'string';
  const hasDer = input.der instanceof Uint8Array;
  if (hasPem === hasDer) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', '私钥输入必须且只能提供 pem 或 der');
  }
  const resolved: ResolvedPrivateKeyOptions = {
    ...resolveParseOptions(options),
    ...(options?.onWarning ? { onWarning: options.onWarning } : {}),
  };

  if (hasPem) {
    let blocks;
    try {
      blocks = parsePemBlocks(input.pem as string);
    } catch {
      throw privateKeyError('PEM 解析失败');
    }
    const encrypted = blocks.find((block) => block.type === 'ENCRYPTED PRIVATE KEY');
    if (encrypted) return rejectEncrypted(input.passphrase);
    const pkcs8 = blocks.find((block) => block.type === 'PRIVATE KEY');
    if (pkcs8) {
      if (input.passphrase !== undefined) emitIgnoredPassphrase(resolved);
      assertSize(pkcs8.der, resolved.maxBytes);
      return parsePkcs8(pkcs8.der, resolved);
    }
    const sec1 = blocks.find((block) => block.type === 'EC PRIVATE KEY');
    if (sec1) {
      if (input.passphrase !== undefined) emitIgnoredPassphrase(resolved);
      assertSize(sec1.der, resolved.maxBytes);
      return parseSec1(sec1.der, resolved);
    }
    throw privateKeyError('PEM 中没有 PKCS#8 或 SEC1 私钥');
  }

  const der = input.der as Uint8Array;
  assertSize(der, resolved.maxBytes);
  return parsePkcs8OrEncrypted(der, resolved, input.passphrase);
}

/**
 * 解析 PKCS#8 或 EncryptedPrivateKeyInfo DER。
 *
 * @param der DER。
 * @param resolved 解析上限。
 * @param passphrase 口令。
 * @returns 私钥。
 */
function parsePkcs8OrEncrypted(
  der: Uint8Array,
  resolved: ResolvedPrivateKeyOptions,
  passphrase?: string,
): Sm2PrivateKey {
  let root: DerNode;
  try {
    root = parseDer(der, resolved);
  } catch (error) {
    rethrowLimit(error);
    throw privateKeyError('DER 结构非法');
  }
  // EncryptedPrivateKeyInfo ::= SEQUENCE { AlgorithmIdentifier, OCTET STRING }；
  // 与 PrivateKeyInfo/SEC1 的结构差异在首字段（SEQUENCE vs INTEGER）。
  if (
    root.isUniversal(0x10) &&
    root.children.length === 2 &&
    root.children[0].isUniversal(0x10) &&
    root.children[1].isUniversal(0x04)
  ) {
    const algorithm = root.children[0];
    let oid: string | undefined;
    try {
      oid = algorithm.children[0]?.asOid();
    } catch {
      oid = undefined;
    }
    if (oid === OID_PBES2) return rejectEncrypted(passphrase);
    throw new CryptoError(
      'CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION',
      '不支持的加密 PKCS#8 算法',
    );
  }
  if (passphrase !== undefined) emitIgnoredPassphrase(resolved);
  return parsePkcs8(der, resolved);
}

/**
 * 对未加密私钥忽略 passphrase 时发出 warning。
 *
 * @param resolved 解析选项。
 */
function emitIgnoredPassphrase(resolved: ResolvedPrivateKeyOptions): void {
  resolved.onWarning?.({
    code: 'W_CRYPTO_CREDENTIAL_IGNORED',
    message: '未加密私钥忽略 passphrase',
  });
}

/**
 * 保留资源超限错误，不映射为结构非法。
 *
 * @param error 原始错误。
 */
function rethrowLimit(error: unknown): void {
  if (error instanceof CryptoError && error.code === 'CRYPTO_LIMIT_EXCEEDED') throw error;
}

/**
 * 解析未加密 PKCS#8。
 *
 * @param der DER。
 * @param resolved 解析上限。
 * @returns 私钥。
 */
function parsePkcs8(
  der: Uint8Array,
  resolved: ResolvedPrivateKeyOptions,
): Sm2PrivateKey {
  let root: DerNode;
  try {
    root = parseDer(der, resolved).requireSequence('PrivateKeyInfo');
  } catch (error) {
    rethrowLimit(error);
    throw privateKeyError('PKCS#8 DER 结构非法');
  }
  if (root.children.length < 3) throw privateKeyError('PKCS#8 字段不足');
  let version: bigint;
  try {
    version = root.children[0].asInteger();
  } catch {
    throw privateKeyError('PKCS#8 version 非法');
  }
  if (version !== 0n && version !== 1n) throw privateKeyError('PKCS#8 version 必须为 0/1');

  const algorithm = root.children[1];
  if (!algorithm.isUniversal(0x10)) throw privateKeyError('PKCS#8 algorithm 非法');
  let algorithmOid: string;
  try {
    algorithmOid = algorithm.children[0].asOid();
  } catch {
    throw privateKeyError('PKCS#8 algorithm OID 非法');
  }
  if (algorithmOid !== OID_EC_PUBLIC_KEY) {
    throw privateKeyError(`不是 EC 私钥（算法 ${algorithmOid}）`);
  }
  const curveParameter = algorithm.children[1];
  if (!curveParameter) throw privateKeyError('PKCS#8 缺少曲线参数');
  let curveOid: string | undefined;
  try {
    curveOid = parseDer(curveParameter.raw, resolved).asOid();
  } catch {
    curveOid = undefined;
  }
  if (curveOid !== OID_SM2_CURVE) throw privateKeyError('私钥曲线不是 sm2p256v1');

  let ecPrivateKey: Uint8Array;
  try {
    ecPrivateKey = root.children[2].asOctets();
  } catch {
    throw privateKeyError('PKCS#8 privateKey 非法');
  }
  const sec1 = parseSec1(ecPrivateKey, resolved);

  let embeddedPublicKey = sec1.embeddedPublicKey;
  const publicKeyNode = root.findContext(1);
  if (publicKeyNode) {
    const bits = publicKeyNode.tag.constructed
      ? parseDer(publicKeyNode.value, resolved).asBitString()
      : { unusedBits: publicKeyNode.value[0] ?? 0, bytes: publicKeyNode.value.subarray(1) };
    if (bits.unusedBits !== 0) throw privateKeyError('PKCS#8 公钥未按字节对齐');
    embeddedPublicKey = normalizeEmbeddedPublicKey(bits.bytes, embeddedPublicKey);
  }
  return finalizePrivateKey('pkcs8', sec1.privateKey, embeddedPublicKey);
}

/**
 * 解析 SEC1 ECPrivateKey。
 *
 * @param der DER。
 * @param resolved 解析上限。
 * @returns 私钥标量、内嵌公钥与格式。
 */
function parseSec1(
  der: Uint8Array,
  resolved: ResolvedPrivateKeyOptions,
): Sm2PrivateKey {
  let root: DerNode;
  try {
    root = parseDer(der, resolved).requireSequence('ECPrivateKey');
  } catch (error) {
    rethrowLimit(error);
    throw privateKeyError('SEC1 私钥结构非法');
  }
  if (root.children.length < 2) throw privateKeyError('SEC1 字段不足');
  let version: bigint;
  try {
    version = root.children[0].asInteger();
  } catch {
    throw privateKeyError('SEC1 version 非法');
  }
  if (version !== 1n) throw privateKeyError('SEC1 version 必须为 1');

  const parameterNode = root.findContext(0);
  if (parameterNode) {
    let curveOid: string | undefined;
    try {
      curveOid = parameterNode.tag.constructed
        ? parseDer(parameterNode.value, resolved).asOid()
        : decodeOid(parameterNode.value);
    } catch {
      curveOid = undefined;
    }
    if (curveOid !== OID_SM2_CURVE) throw privateKeyError('SEC1 曲线参数不是 sm2p256v1');
  }

  let privateKey: Uint8Array;
  try {
    privateKey = root.children[1].asOctets();
  } catch {
    throw privateKeyError('SEC1 privateKey 非法');
  }
  if (privateKey.length === 0 || privateKey.length > 32) {
    throw privateKeyError('SM2 私钥标量长度必须为 1..32 byte');
  }
  const padded = new Uint8Array(32);
  padded.set(privateKey, 32 - privateKey.length);

  let embeddedPublicKey: Uint8Array | undefined;
  const publicKeyNode = root.findContext(1);
  if (publicKeyNode) {
    let bits: { readonly unusedBits: number; readonly bytes: Uint8Array };
    try {
      bits = publicKeyNode.tag.constructed
        ? parseDer(publicKeyNode.value, resolved).asBitString()
        : {
            unusedBits: publicKeyNode.value[0] ?? 8,
            bytes: publicKeyNode.value.subarray(1),
          };
    } catch {
      throw privateKeyError('SEC1 公钥非法');
    }
    if (bits.unusedBits !== 0) throw privateKeyError('SEC1 公钥未按字节对齐');
    embeddedPublicKey = normalizeEmbeddedPublicKey(bits.bytes);
  }
  return finalizePrivateKey('sec1', padded, embeddedPublicKey);
}

/**
 * 归一化结构内嵌公钥。
 *
 * @param bytes 公钥字节。
 * @param existing 已存在的内嵌公钥（可选）。
 * @returns 65 byte 公钥。
 */
function normalizeEmbeddedPublicKey(
  bytes: Uint8Array,
  existing?: Uint8Array,
): Uint8Array {
  try {
    const normalized = fromHex(normalizeSm2PublicKey(bytes));
    if (existing && !constantTimeEqual(existing, normalized)) {
      throw privateKeyError('私钥结构内存在不一致的内嵌公钥');
    }
    return normalized;
  } catch (error) {
    if (error instanceof CryptoError && error.code === 'CRYPTO_PRIVATE_KEY_INVALID') throw error;
    throw privateKeyError('内嵌公钥非法');
  }
}

/**
 * 校验私钥标量并派生公钥。
 *
 * @param format 来源格式。
 * @param privateKey 32 byte 标量。
 * @param embeddedPublicKey 内嵌公钥（可选）。
 * @returns 私钥结构。
 */
function finalizePrivateKey(
  format: 'pkcs8' | 'sec1',
  privateKey: Uint8Array,
  embeddedPublicKey?: Uint8Array,
): Sm2PrivateKey {
  let privateKeyHex: string;
  try {
    privateKeyHex = normalizeSm2PrivateKey(privateKey);
  } catch {
    throw privateKeyError('SM2 私钥标量不在合法范围');
  }
  let publicKey: Uint8Array;
  try {
    publicKey = sm2GetPublicKey(privateKeyHex);
  } catch {
    throw privateKeyError('SM2 公钥推导失败');
  }
  if (embeddedPublicKey && !constantTimeEqual(embeddedPublicKey, publicKey)) {
    throw privateKeyError('私钥与内嵌公钥不匹配');
  }
  return { format, privateKey: copyBytes(privateKey), publicKey, embeddedPublicKey };
}

/**
 * 拒绝加密 PKCS#8。
 *
 * @param passphrase 调用方口令。
 * @returns 不返回，始终抛错。
 */
function rejectEncrypted(passphrase?: string): never {
  if (passphrase === undefined || passphrase.length === 0) {
    throw new CryptoError('CRYPTO_PRIVATE_KEY_PASSPHRASE_REQUIRED', '加密 PKCS#8 私钥需要口令');
  }
  throw new CryptoError(
    'CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION',
    '不支持的加密 PKCS#8 算法',
  );
}

/**
 * 校验 DER 大小。
 *
 * @param der DER 字节。
 * @param maxBytes 上限，单位 byte。
 */
function assertSize(der: Uint8Array, maxBytes: number): void {
  if (der.length > maxBytes) {
    throw new CryptoError(
      'CRYPTO_LIMIT_EXCEEDED',
      `私钥 DER 大小 ${der.length} byte 超过上限 ${maxBytes} byte`,
    );
  }
}

/**
 * 构造私钥结构错误。
 *
 * @param message 信息。
 * @returns CryptoError。
 */
function privateKeyError(message: string): CryptoError {
  return new CryptoError('CRYPTO_PRIVATE_KEY_INVALID', `私钥非法：${message}`);
}
