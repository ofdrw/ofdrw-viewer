/**
 * SM2 签名/验签与加解密封装（GB/T 32918.2/4，C1C3C2 模式）。
 *
 * 约定：
 * - 签名/验签使用标准 userId `1234567812345678`，可通过 options 覆盖；
 *   不得从证书推导 userId。
 * - 加解密不依赖 userId；密文为 C1C3C2（X||Y||C3||C2），API 默认不带 `04` 前缀，
 *   解密时可按 `c1Prefix` 声明或自动兼容。
 * - 私钥/公钥在进入底层库前统一做长度、标量与曲线校验。
 */

import { CryptoError } from '../errors';
import { bytesEqual, fromHex, leftPadBytes, toHex } from '../util/bytes';
import { resolveSm2UserId } from '../util/options';
import { isSm2PrivateKeyScalar, bytesToBigInt, decodeSm2PublicKey, SM2_CURVE, bigIntToBytes } from './curve';
import { sm2 } from './sm-crypto';

/** SM2 签名选项。 */
export interface Sm2SignOptions {
  /** 用户 ID；默认标准值 `1234567812345678`。 */
  readonly userId?: string;
}

/** SM2 解密选项。 */
export interface Sm2DecryptOptions {
  /**
   * C1 的 `04` 前缀声明：
   * - `auto`（默认）同时尝试完整 C1C3C2 与去 `04` 候选，以 C3 校验结果为准；
   * - `present` 输入必须带 `04`；
   * - `absent` 输入不带 `04`。
   */
  readonly c1Prefix?: 'auto' | 'present' | 'absent';
}

/**
 * 归一化 SM2 私钥为 64 字符小写十六进制。
 *
 * @param privateKey 32 byte 标量或十六进制字符串（允许左侧补零）。
 * @returns 64 字符十六进制。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT`：长度/范围非法。
 */
export function normalizeSm2PrivateKey(privateKey: Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof privateKey === 'string') {
    const clean = privateKey.trim();
    if (clean.length === 0) {
      throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM2 私钥不能为空');
    }
    bytes = fromHex(clean);
  } else if (privateKey instanceof Uint8Array) {
    bytes = privateKey;
  } else {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM2 私钥必须是 Uint8Array 或十六进制字符串');
  }
  const normalized = leftPadBytes(bytes, 32);
  const scalar = bytesToBigInt(normalized);
  if (!isSm2PrivateKeyScalar(scalar)) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM2 私钥标量不在合法范围');
  }
  return toHex(normalized);
}

/**
 * 归一化 SM2 公钥为 130 字符未压缩点（`04||X||Y`）。
 *
 * @param publicKey 64/65 byte 字节或十六进制字符串。
 * @returns 130 字符小写十六进制。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT`：长度/前缀/曲线非法。
 */
export function normalizeSm2PublicKey(publicKey: Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof publicKey === 'string') {
    const clean = publicKey.trim();
    if (clean.length === 0) {
      throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM2 公钥不能为空');
    }
    bytes = fromHex(clean);
  } else if (publicKey instanceof Uint8Array) {
    bytes = publicKey;
  } else {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM2 公钥必须是 Uint8Array 或十六进制字符串');
  }
  let normalized: Uint8Array;
  if (bytes.length === 65) {
    if (bytes[0] !== 0x04) {
      throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM2 公钥前缀必须是 04');
    }
    normalized = bytes;
  } else if (bytes.length === 64) {
    normalized = new Uint8Array(65);
    normalized[0] = 0x04;
    normalized.set(bytes, 1);
  } else {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM2 公钥必须是 64/65 byte');
  }
  if (!decodeSm2PublicKey(normalized)) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM2 公钥不是 sm2p256v1 曲线上的点');
  }
  return toHex(normalized);
}

/**
 * 由私钥推导未压缩公钥。
 *
 * @param privateKey 32 byte 标量或十六进制字符串。
 * @returns 65 byte 公钥（`04||X||Y`）。
 */
export function sm2GetPublicKey(privateKey: Uint8Array | string): Uint8Array {
  const privateKeyHex = normalizeSm2PrivateKey(privateKey);
  const publicKeyHex = sm2.getPublicKeyFromPrivateKey(privateKeyHex);
  const publicKey = fromHex(publicKeyHex);
  if (!decodeSm2PublicKey(publicKey)) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM2 公钥推导结果非法');
  }
  return publicKey;
}

/**
 * 计算 SM2 签名（SM3withSM2，DER 编码）。
 *
 * @param message 待签名原文；不做二次序列化。
 * @param privateKey 32 byte 标量或十六进制字符串。
 * @param options 用户 ID（默认标准值）。
 * @returns DER 编码签名 `SEQUENCE { r INTEGER, s INTEGER }`。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT`：参数非法或签名失败。
 */
export function sm2Sign(
  message: Uint8Array,
  privateKey: Uint8Array | string,
  options: Sm2SignOptions = {},
): Uint8Array {
  if (!(message instanceof Uint8Array)) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM2 签名输入必须是 Uint8Array');
  }
  const privateKeyHex = normalizeSm2PrivateKey(privateKey);
  const userId = resolveSm2UserId(options.userId);
  try {
    return fromHex(
      sm2.doSignature(Array.from(message), privateKeyHex, { der: true, userId }),
    );
  } catch {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM2 签名失败');
  }
}

/**
 * 验证 SM2 签名（SM3withSM2，DER 编码）。
 *
 * @param message 待验签原文（与签名时完全一致的字节）。
 * @param signature DER 编码签名。
 * @param publicKey 64/65 byte 公钥或十六进制字符串。
 * @param options 用户 ID（默认标准值）。
 * @returns 数学验签通过返回 true；签名格式/内容错误返回 false（不抛错）。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT`：公钥/消息参数非法。
 */
export function sm2Verify(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array | string,
  options: Sm2SignOptions = {},
): boolean {
  if (!(message instanceof Uint8Array)) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM2 验签输入必须是 Uint8Array');
  }
  if (!(signature instanceof Uint8Array) || signature.length === 0) {
    return false;
  }
  const publicKeyHex = normalizeSm2PublicKey(publicKey);
  const userId = resolveSm2UserId(options.userId);
  try {
    return sm2.doVerifySignature(Array.from(message), toHex(signature), publicKeyHex, {
      der: true,
      userId,
    });
  } catch {
    // 非规范 DER、超长整数等一律视为验签失败。
    return false;
  }
}

/**
 * SM2 加密（C1C3C2）。
 *
 * 空明文不受支持：`SM2Cipher.C2` 必须非空，且底层库对空明文与 C3
 * 校验失败都返回空数组，无法安全区分。
 *
 * @param plaintext 明文；必须至少 1 byte。
 * @param publicKey 64/65 byte 公钥或十六进制字符串。
 * @returns C1C3C2 字节（X||Y||C3||C2），**不含** `04` 前缀。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT`：参数非法、空明文或加密失败。
 */
export function sm2Encrypt(
  plaintext: Uint8Array,
  publicKey: Uint8Array | string,
): Uint8Array {
  if (!(plaintext instanceof Uint8Array)) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM2 明文必须是 Uint8Array');
  }
  if (plaintext.length === 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM2 不支持空明文');
  }
  const publicKeyHex = normalizeSm2PublicKey(publicKey);
  try {
    return fromHex(sm2.doEncrypt(Array.from(plaintext), publicKeyHex, 1));
  } catch {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM2 加密失败');
  }
}

/**
 * SM2 解密（C1C3C2）。
 *
 * 底层对 C3 校验失败时返回空数组；本函数将其统一转换为
 * `CRYPTO_DECRYPT_FAILED`，由调用方按场景映射为私钥不匹配等错误码。
 *
 * @param ciphertext C1C3C2 密文；是否带 `04` 前缀由 `options.c1Prefix` 控制。
 * @param privateKey 32 byte 标量或十六进制字符串。
 * @param options C1 前缀模式，默认 `auto`。
 * @returns 明文（至少 1 byte）。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT`：参数非法；
 *   `CRYPTO_DECRYPT_FAILED`：密文/私钥不匹配、C3 校验失败或前缀歧义。
 */
export function sm2Decrypt(
  ciphertext: Uint8Array,
  privateKey: Uint8Array | string,
  options: Sm2DecryptOptions = {},
): Uint8Array {
  if (!(ciphertext instanceof Uint8Array)) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM2 密文必须是 Uint8Array');
  }
  const privateKeyHex = normalizeSm2PrivateKey(privateKey);
  const mode = options.c1Prefix ?? 'auto';
  if (mode !== 'auto' && mode !== 'present' && mode !== 'absent') {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'c1Prefix 必须是 auto/present/absent');
  }
  const candidates: Uint8Array[] = [];

  if (mode === 'present') {
    if (ciphertext.length < 98 || ciphertext[0] !== 0x04) {
      throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM2 密文缺少 04 前缀');
    }
    candidates.push(ciphertext.subarray(1));
  } else if (mode === 'absent') {
    candidates.push(ciphertext);
  } else {
    // auto：完整 C1C3C2 与去 04 候选都参与 C3 校验，不按首字节提前返回。
    candidates.push(ciphertext);
    if (ciphertext.length >= 98 && ciphertext[0] === 0x04) {
      candidates.push(ciphertext.subarray(1));
    }
  }

  const successes: Uint8Array[] = [];
  for (const candidate of candidates) {
    // C2 至少 1 byte；空明文不受支持，因此空结果一律按 C3 校验失败处理。
    if (candidate.length < 97) continue;
    let result: number[];
    try {
      result = sm2.doDecrypt(toHex(candidate), privateKeyHex, 1, {
        output: 'array',
      }) as number[];
    } catch {
      continue;
    }
    if (result.length > 0) successes.push(Uint8Array.from(result));
  }
  if (successes.length === 1) return successes[0] as Uint8Array;
  if (successes.length > 1) {
    const first = successes[0] as Uint8Array;
    if (successes.every((item) => bytesEqual(item, first))) return first;
    throw new CryptoError('CRYPTO_DECRYPT_FAILED', 'SM2 解密失败：密文前缀歧义');
  }
  throw new CryptoError('CRYPTO_DECRYPT_FAILED', 'SM2 解密失败：密文或私钥不匹配');
}

/**
 * 校验公钥是否在 SM2 曲线上。
 *
 * @param publicKey 64/65 byte 公钥。
 * @returns 合法返回 true。
 */
export function isValidSm2PublicKey(publicKey: Uint8Array): boolean {
  return decodeSm2PublicKey(publicKey) !== null;
}

/**
 * 获取 SM2 曲线阶（诊断/测试用）。
 *
 * @returns 曲线阶 n。
 */
export function sm2CurveOrder(): bigint {
  return SM2_CURVE.n;
}

/**
 * 把标量写成 32 byte 大端（诊断/测试用）。
 *
 * @param scalar 0..n-1。
 * @returns 32 byte 字节。
 */
export function sm2ScalarBytes(scalar: bigint): Uint8Array {
  return bigIntToBytes(scalar, 32);
}