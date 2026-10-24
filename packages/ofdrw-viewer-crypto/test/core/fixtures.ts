/**
 * 测试共享的 fixture 读取与跨语言测试向量。
 *
 * 向量来源：
 * - SM3/SM4 为 GB/T 32905 / GB/T 32907 标准示例；
 * - SM2 签名、SM2Cipher 密文与 KDF 派生由 Java BouncyCastle PoC 生成后固化
 *   （PoC 脚本已随 `scripts/` 移除）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURE_ROOT = new URL('../fixtures/crypto/', import.meta.url);

/**
 * 证书有效期判断使用的固定「当前时间」。
 *
 * 夹具证书有效期为 2025-01-01～2040-01-01，该时间落在全部夹具证书的有效区间内。
 * 测试必须显式注入该时间，不得依赖真实系统时间：否则夹具到期（2040-01-01）后，
 * 所有断言证书链为 `valid` 的用例都会统一失败。
 */
export const FIXED_NOW = new Date('2026-10-23T00:00:00Z');

/**
 * 读取 fixture 字节。
 *
 * @param segments 相对 `test/fixtures/crypto/` 的路径片段。
 * @returns 文件字节。
 */
export function fixtureBytes(...segments: string[]): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(segments.join('/'), FIXTURE_ROOT))));
}

/**
 * 读取 fixture 文本。
 *
 * @param segments 相对 `test/fixtures/crypto/` 的路径片段。
 * @returns 文件文本。
 */
export function fixtureText(...segments: string[]): string {
  return readFileSync(fileURLToPath(new URL(segments.join('/'), FIXTURE_ROOT)), 'utf8');
}

/** SM3("abc")。 */
export const SM3_ABC =
  '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0';
/** SM3("")。 */
export const SM3_EMPTY =
  '1ab21d8355cfa17f8e61194831e81a8f22bec8c728fefb747ed035eb5082aa2b';
/** SM4 标准分组明文/密钥。 */
export const SM4_BLOCK_KEY = '0123456789abcdeffedcba9876543210';
/** SM4 标准单分组密文。 */
export const SM4_BLOCK_CIPHER = '681edf34d206965e86b3e94f536e4246';
/** SM4-CBC/PKCS#7 明文（`OFD crypto PoC SM4-CBC PKCS#7 中文`）。 */
export const SM4_CBC_PLAIN =
  '4f46442063727970746f20506f4320534d342d43424320504b4353233720e4b8ade69687';
/** SM4-CBC 测试 IV。 */
export const SM4_CBC_IV = '000102030405060708090a0b0c0d0e0f';
/** SM4-CBC/PKCS#7 密文。 */
export const SM4_CBC_CIPHER =
  '49b38e969049b32598d3feac747819ec7ce7aa387a6689d8cfa2a205f3f82b98900e2fb854c82f8721869f1c20dff067';
/** KDF 测试口令（UTF-8 "PocPass123"）。 */
export const KDF_PASSWORD_HEX = '506f6350617373313233';
/** KDF 测试派生密钥。 */
export const KDF_DERIVED_HEX = 'b5d32da4c15e9b9dcc960d91d9c69e6c';

/** Java PoC 生成的 SM2 互操作向量。 */
export const JAVA_SM2 = Object.freeze({
  /** 公钥（未压缩点）。 */
  publicKey:
    '041f4253e406bf52eb0b01d5e11b2c7dedf5b958a8eaddfa25d54103f73127019de13acb8e496eb0060df0a2e88e2511a7ee8922f066862d65490c76ec9ca48304',
  /** 私钥标量。 */
  privateKey: '41afc447e63af126a6a827f7f5a5162f86647ca30ac8c85a10d2391fd89edf6f',
  /** 消息（`OFDRW-CRYPTO-POC-MESSAGE-中文`）。 */
  message: '4f464452572d43525950544f2d504f432d4d4553534147452de4b8ade69687',
  /** 默认 userId 下的签名 DER。 */
  signature:
    '3045022100d00118b5498ca41e76754d70771f4af0c0aa4c471458a2fe436b013f3e09ab770220119b977f1b0dc53ea9a9b51bfb4d9a526565a147b266b4a01e2d867ea3f14aa7',
  /** SM2Cipher DER 的 Base64。 */
  cipherDerBase64:
    'MHkCIQCB8gVS1nNaM1OQ7Pxi9sR2iwJ5PXeE7fA0AyFDJ/UY7QIgeFKCpcBkZUrUMlzfAnKbuspONWPyFweo43cwstqD3nUEIM5a5xMjH7acnUV4FB81BXGC5qZxJIVthBAuDTZw721eBBAN8J2oKEX5JgL55NsH9psu',
  /** SM2Cipher 明文。 */
  plaintext: '00112233445566778899aabbccddeeff',
});