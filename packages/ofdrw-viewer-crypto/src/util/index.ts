/**
 * 工具层公共入口：字节/编码、常量时间比较、SHA-256、PEM、取消信号、
 * 参数校验、warning 收集、选项解析与输入源读取。
 */

export {
  bytesEqual,
  concatBytes,
  copyBytes,
  fromBase64,
  fromHex,
  leftPadBytes,
  toBase64,
  toHex,
  toUint8Array,
  tryFromBase64,
  utf8Decode,
  utf8Encode,
  zeroize,
} from './bytes';
export { constantTimeEqual } from './compare';
export { sha256, sha256Hex } from './hash';
export { looksLikePem, parsePemBlocks } from './pem';
export type { PemBlock } from './pem';
export {
  requirePositiveInteger,
  requireString,
  requireWithinBytes,
  throwIfAborted,
} from './argument';
export { createWarningCollector } from './warning';
export type { WarningCollector } from './warning';
export {
  DEFAULT_SM2_USER_ID,
  resolveCryptoLimits,
  resolveCryptoOptions,
  resolveParseOptions,
  resolveSm2UserId,
} from './options';
export type { ResolvedCryptoOptions } from './options';
export { readCryptoSource } from './source';
export type { ReadCryptoSourceOptions } from './source';