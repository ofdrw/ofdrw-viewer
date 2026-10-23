/**
 * SM2Cipher ASN.1 编解码（GB/T 35276 / GM/T 0009）。
 *
 * ```text
 * SM2Cipher ::= SEQUENCE {
 *   X          INTEGER,
 *   Y          INTEGER,
 *   HASH       OCTET STRING SIZE(32),   -- C3
 *   CIPHERTEXT OCTET STRING             -- C2
 * }
 * ```
 *
 * 约定：
 * - `parseSm2Cipher` 保留坐标/密文的字节视图，并校验 X/Y 在 sm2p256v1 曲线上；
 * - `sm2CipherToC1C3C2` 输出 `04||X||Y||C3||C2`（C1 带未压缩前缀）；
 * - `c1c3c2ToSm2Cipher` 由调用方声明前缀；`auto` 时分别尝试完整 C1C3C2
 *   与去 `04` 候选，只在恰好一个候选在曲线上时返回，不按首字节猜测。
 */

import { CryptoError } from '../errors';
import { isSm2PointOnCurve, bytesToBigInt } from '../sm/curve';
import { concatBytes, copyBytes } from '../util/bytes';
import {
  derInteger,
  derOctetString,
  derSequence,
  parseDer,
  type DerParseOptions,
} from './der';

/** C3 摘要长度，单位 byte。 */
const C3_LENGTH = 32;
/** C1 坐标长度（X/Y 各 32 byte），单位 byte。 */
const COORDINATE_LENGTH = 32;
/** C1C3C2 去掉前缀后的最小长度（C2 至少 1 byte），单位 byte。 */
const MIN_BODY_LENGTH = COORDINATE_LENGTH * 2 + C3_LENGTH + 1;

/** C1C3C2 前缀解析选项。 */
export interface C1C3C2ParseOptions {
  /**
   * C1 前缀声明：
   * - `auto`（默认）同时尝试完整 C1C3C2 与去 `04` 候选，唯一曲线合法者胜出；
   * - `present` 输入必须带 `04`；
   * - `absent` 输入不带 `04`。
   */
  readonly c1Prefix?: 'auto' | 'present' | 'absent';
}

/** SM2Cipher 结构。 */
export interface Sm2Cipher {
  /** C1 横坐标，32 byte 大端。 */
  readonly x: Uint8Array;
  /** C1 纵坐标，32 byte 大端。 */
  readonly y: Uint8Array;
  /** C3 摘要，32 byte。 */
  readonly c3: Uint8Array;
  /** C2 密文，长度 ≥ 1 byte。 */
  readonly c2: Uint8Array;
}

/**
 * 解析 SM2Cipher DER。
 *
 * @param der DER 字节。
 * @param options DER 解析上限。
 * @returns SM2Cipher 结构。
 * @throws CryptoError `CRYPTO_ASN1_INVALID`：结构/长度/曲线非法。
 */
export function parseSm2Cipher(der: Uint8Array, options?: DerParseOptions): Sm2Cipher {
  const sequence = parseDer(der, options).requireSequence('SM2Cipher');
  if (sequence.children.length !== 4) {
    throw sm2CipherError('SM2Cipher 必须包含 X/Y/HASH/CIPHERTEXT 四个字段');
  }
  const x = sequence.children[0].asUnsignedIntegerBytes(COORDINATE_LENGTH);
  const y = sequence.children[1].asUnsignedIntegerBytes(COORDINATE_LENGTH);
  const c3 = sequence.children[2].asOctets();
  const c2 = sequence.children[3].asOctets();
  if (c3.length !== C3_LENGTH) {
    throw sm2CipherError(`SM2Cipher.HASH 必须为 ${C3_LENGTH} byte`);
  }
  if (c2.length === 0) {
    throw sm2CipherError('SM2Cipher.CIPHERTEXT 不能为空');
  }
  validatePoint(x, y);
  return { x, y, c3, c2 };
}

/**
 * 编码 SM2Cipher DER。
 *
 * @param cipher 结构；坐标/摘要长度与曲线会被校验。
 * @returns DER 字节。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT` / `CRYPTO_ASN1_INVALID`。
 */
export function encodeSm2Cipher(cipher: Sm2Cipher): Uint8Array {
  if (!(cipher.x instanceof Uint8Array) || cipher.x.length !== COORDINATE_LENGTH) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM2Cipher.X 必须是 32 byte');
  }
  if (!(cipher.y instanceof Uint8Array) || cipher.y.length !== COORDINATE_LENGTH) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM2Cipher.Y 必须是 32 byte');
  }
  if (!(cipher.c3 instanceof Uint8Array) || cipher.c3.length !== C3_LENGTH) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM2Cipher.C3 必须是 32 byte');
  }
  if (!(cipher.c2 instanceof Uint8Array) || cipher.c2.length === 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM2Cipher.C2 不能为空');
  }
  validatePoint(cipher.x, cipher.y);
  return derSequence(
    derInteger(cipher.x),
    derInteger(cipher.y),
    derOctetString(cipher.c3),
    derOctetString(cipher.c2),
  );
}

/**
 * 转为 C1C3C2 字节（`04||X||Y||C3||C2`）。
 *
 * @param cipher 结构。
 * @returns C1C3C2 字节。
 */
export function sm2CipherToC1C3C2(cipher: Sm2Cipher): Uint8Array {
  return concatBytes(Uint8Array.of(0x04), cipher.x, cipher.y, cipher.c3, cipher.c2);
}

/**
 * 从 C1C3C2 字节解析结构。
 *
 * @param bytes C1C3C2；前缀由 `options.c1Prefix` 声明。
 * @param options 前缀模式；默认 `auto`。
 * @returns 结构。
 * @throws CryptoError `CRYPTO_ASN1_INVALID`：长度/曲线非法或 `auto` 歧义。
 */
export function c1c3c2ToSm2Cipher(
  bytes: Uint8Array,
  options: C1C3C2ParseOptions = {},
): Sm2Cipher {
  if (!(bytes instanceof Uint8Array)) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'C1C3C2 必须是 Uint8Array');
  }
  const mode = options.c1Prefix ?? 'auto';
  if (mode !== 'auto' && mode !== 'present' && mode !== 'absent') {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'c1Prefix 必须是 auto/present/absent');
  }
  const candidates: Uint8Array[] = [];
  if (mode === 'present') {
    if (bytes.length < 1 + MIN_BODY_LENGTH || bytes[0] !== 0x04) {
      throw sm2CipherError('C1C3C2 缺少 04 前缀');
    }
    candidates.push(bytes.subarray(1));
  } else if (mode === 'absent') {
    candidates.push(bytes);
  } else {
    // auto：完整字节与去 04 候选都交给结构/曲线校验，不先看首字节下结论。
    candidates.push(bytes);
    if (bytes[0] === 0x04) candidates.push(bytes.subarray(1));
  }

  const parsed: Sm2Cipher[] = [];
  let lastError: CryptoError | undefined;
  for (const body of candidates) {
    try {
      parsed.push(parseC11Body(body));
    } catch (error) {
      lastError = error instanceof CryptoError ? error : sm2CipherError('C1C3C2 非法');
    }
  }
  if (parsed.length === 1) return parsed[0] as Sm2Cipher;
  if (parsed.length === 0) {
    throw lastError ?? sm2CipherError('C1C3C2 无法解析');
  }
  throw sm2CipherError('C1C3C2 前缀歧义，请显式指定 c1Prefix');
}

/**
 * 解析不带 `04` 前缀的 C1C3C2 主体。
 *
 * @param body X||Y||C3||C2。
 * @returns 结构。
 * @throws CryptoError `CRYPTO_ASN1_INVALID`。
 */
function parseC11Body(body: Uint8Array): Sm2Cipher {
  if (body.length < MIN_BODY_LENGTH) {
    throw sm2CipherError('C1C3C2 长度不足或 C2 为空');
  }
  const x = copyBytes(body.subarray(0, COORDINATE_LENGTH));
  const y = copyBytes(body.subarray(COORDINATE_LENGTH, COORDINATE_LENGTH * 2));
  const c3 = copyBytes(body.subarray(COORDINATE_LENGTH * 2, COORDINATE_LENGTH * 2 + C3_LENGTH));
  const c2 = copyBytes(body.subarray(COORDINATE_LENGTH * 2 + C3_LENGTH));
  validatePoint(x, y);
  return { x, y, c3, c2 };
}

/**
 * 校验坐标在 SM2 曲线上。
 *
 * @param x 横坐标。
 * @param y 纵坐标。
 * @throws CryptoError `CRYPTO_ASN1_INVALID`。
 */
function validatePoint(x: Uint8Array, y: Uint8Array): void {
  if (!isSm2PointOnCurve(bytesToBigInt(x), bytesToBigInt(y))) {
    throw sm2CipherError('SM2Cipher 公钥点不在 sm2p256v1 曲线上');
  }
}

/**
 * 构造 ASN.1 结构错误。
 *
 * @param message 信息。
 * @returns CryptoError。
 */
function sm2CipherError(message: string): CryptoError {
  return new CryptoError('CRYPTO_ASN1_INVALID', `SM2Cipher 非法：${message}`);
}