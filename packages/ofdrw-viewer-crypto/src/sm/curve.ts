/**
 * SM2 曲线参数与点/标量校验（sm2p256v1）。
 *
 * 参数来源：GB/T 32918.5-2017 / GM/T 0003；用于在 DER/公钥输入阶段
 * 拒绝非曲线点与非法私钥标量，避免把畸形数据交给底层库。
 */

import { CryptoError } from '../errors';
import { fromHex, toHex } from '../util/bytes';

/** SM2 曲线参数（全部为无符号大整数）。 */
export interface Sm2CurveParams {
  /** 素域模数 p。 */
  readonly p: bigint;
  /** 曲线系数 a。 */
  readonly a: bigint;
  /** 曲线系数 b。 */
  readonly b: bigint;
  /** 基点阶 n。 */
  readonly n: bigint;
  /** 基点 x。 */
  readonly gx: bigint;
  /** 基点 y。 */
  readonly gy: bigint;
}

/** SM2 推荐曲线 sm2p256v1。 */
export const SM2_CURVE: Readonly<Sm2CurveParams> = Object.freeze({
  p: BigInt('0xFFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00000000FFFFFFFFFFFFFFFF'),
  a: BigInt('0xFFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00000000FFFFFFFFFFFFFFFC'),
  b: BigInt('0x28E9FA9E9D9F5E344D5A9E4BCF6509A7F39789F515AB8F92DDBCBD414D940E93'),
  n: BigInt('0xFFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFF7203DF6B21C6052B53BBF40939D54123'),
  gx: BigInt('0x32C4AE2C1F1981195F9904466A39C9948FE30BBFF2660BE1715A4589334C74C7'),
  gy: BigInt('0xBC3736A2F4F6779C59BDCEE36B692153D0A9877CC62A474002DF32E52139F0A0'),
});

/**
 * 无符号字节数组转 BigInt。
 *
 * @param bytes 大端无符号字节。
 * @returns 非负 BigInt。
 */
export function bytesToBigInt(bytes: Uint8Array): bigint {
  if (bytes.length === 0) return 0n;
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * 非负 BigInt 转固定长度大端字节。
 *
 * @param value 非负整数。
 * @param length 目标长度，单位 byte。
 * @returns 大端字节。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT`：负数或超出目标长度。
 */
export function bigIntToBytes(value: bigint, length: number): Uint8Array {
  if (value < 0n) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'BigInt 不能为负数');
  }
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  if (rest !== 0n) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', `BigInt 超出 ${length} byte`);
  }
  return out;
}

/**
 * 判断点是否在 SM2 曲线上（不含无穷远点）。
 *
 * @param x 横坐标。
 * @param y 纵坐标。
 * @returns 在曲线上且坐标在素域内返回 true。
 */
export function isSm2PointOnCurve(x: bigint, y: bigint): boolean {
  const { p, a, b } = SM2_CURVE;
  if (x < 0n || x >= p || y < 0n || y >= p) return false;
  const left = (y * y) % p;
  const right = (x * x * x + a * x + b) % p;
  return left === right;
}

/**
 * 判断私钥标量是否合法（1 ≤ d ≤ n-2）。
 *
 * @param d 私钥标量。
 * @returns 合法返回 true。
 */
export function isSm2PrivateKeyScalar(d: bigint): boolean {
  return d >= 1n && d <= SM2_CURVE.n - 2n;
}

/**
 * 把 64/65 byte 公钥拆成曲线坐标。
 *
 * @param publicKey 未压缩点（可带 04 前缀）。
 * @returns 坐标；长度/前缀/曲线非法时返回 null。
 */
export function decodeSm2PublicKey(
  publicKey: Uint8Array,
): { readonly x: bigint; readonly y: bigint } | null {
  if (publicKey.length === 65) {
    if (publicKey[0] !== 0x04) return null;
    return decodeCoordinates(publicKey.subarray(1));
  }
  if (publicKey.length === 64) return decodeCoordinates(publicKey);
  return null;
}

/**
 * 解析 64 byte 坐标并校验曲线。
 *
 * @param coordinates X||Y 字节。
 * @returns 坐标；非法返回 null。
 */
function decodeCoordinates(
  coordinates: Uint8Array,
): { readonly x: bigint; readonly y: bigint } | null {
  const x = bytesToBigInt(coordinates.subarray(0, 32));
  const y = bytesToBigInt(coordinates.subarray(32, 64));
  return isSm2PointOnCurve(x, y) ? { x, y } : null;
}

/**
 * SM2 曲线参数十六进制表示（诊断/文档用）。
 *
 * @param value 参数值。
 * @returns 64 字符十六进制。
 */
export function sm2ParamHex(value: bigint): string {
  return toHex(bigIntToBytes(value, 32));
}

/**
 * 十六进制字符串转 SM2 标量（内部工具）。
 *
 * @param hex 64 字符十六进制。
 * @returns BigInt。
 */
export function sm2ScalarFromHex(hex: string): bigint {
  return bytesToBigInt(fromHex(hex));
}