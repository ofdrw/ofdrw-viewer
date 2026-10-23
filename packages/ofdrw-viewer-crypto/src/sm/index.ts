/**
 * SM 基础层公共入口：SM3、SM4-CBC、SM2、KDF 与私钥解析。
 */

export { SM4_BLOCK_SIZE, sm4DecryptCbc, sm4EncryptCbc } from './sm4';
export type { Sm4CbcOptions, Sm4Padding } from './sm4';

export { sm3Digest, sm3Hex, sm3OfText } from './sm3';

export { derivePasswordKey, kdfSm3 } from './kdf';

export {
  isValidSm2PublicKey,
  normalizeSm2PrivateKey,
  normalizeSm2PublicKey,
  sm2Decrypt,
  sm2Encrypt,
  sm2GetPublicKey,
  sm2Sign,
  sm2Verify,
} from './sm2';
export type { Sm2DecryptOptions, Sm2SignOptions } from './sm2';

export {
  SM2_CURVE,
  isSm2PointOnCurve,
  isSm2PrivateKeyScalar,
} from './curve';
export type { Sm2CurveParams } from './curve';

export { parseSm2PrivateKey } from './private-key';
export type { Sm2PrivateKey, Sm2PrivateKeyParseOptions } from './private-key';