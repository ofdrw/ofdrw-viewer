/**
 * sm-crypto 标准向量与互操作测试（Node 与浏览器共用）。
 *
 * 期望值来源：
 * - SM3("abc")：GB/T 32905-2016 附录 A 示例；
 * - SM4 单块加密：GB/T 32907-2016 附录 A 示例；
 * - SM4-CBC、KDF、SM2 签名/密文：由 ofdrw 2.4.0 + BouncyCastle 1.85 的 Java PoC 生成。
 */
import {
  base64ToBytes, bytesToBase64, bytesToHex, hexToBytes,
} from './der.mjs';
import {
  c1c3c2ToSm2CipherDer, kdfSm3, sm2CipherDerToC1C3C2, sm4CbcDecrypt, sm4CbcEncrypt,
} from './ofd.mjs';

export const DEFAULTS = {
  sm3Abc: '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0',
  sm4KeyHex: '0123456789abcdeffedcba9876543210',
  sm4IvHex: '000102030405060708090a0b0c0d0e0f',
  sm4PlainHex: '4f46442063727970746f20506f4320534d342d43424320504b4353233720e4b8ade69687',
  sm4CipherHex: '49b38e969049b32598d3feac747819ec7ce7aa387a6689d8cfa2a205f3f82b98900e2fb854c82f8721869f1c20dff067',
  kdfPasswordUtf8Hex: '506f6350617373313233',
  kdfDerivedKeyHex: 'b5d32da4c15e9b9dcc960d91d9c69e6c',
  sm2MessageUtf8: 'OFDRW-CRYPTO-POC-MESSAGE-中文',
  sm2MessageHex: '4f464452572d43525950544f2d504f432d4d4553534147452de4b8ade69687',
  sm2UserId: '1234567812345678',
  sm2SignatureDerHex: '3045022100d00118b5498ca41e76754d70771f4af0c0aa4c471458a2fe436b013f3e09ab770220119b977f1b0dc53ea9a9b51bfb4d9a526565a147b266b4a01e2d867ea3f14aa7',
  sm2PublicKeyHex: '041f4253e406bf52eb0b01d5e11b2c7dedf5b958a8eaddfa25d54103f73127019de13acb8e496eb0060df0a2e88e2511a7ee8922f066862d65490c76ec9ca48304',
  sm2PrivateKeyHex: '41afc447e63af126a6a827f7f5a5162f86647ca30ac8c85a10d2391fd89edf6f',
  sm2CipherDerB64: 'MHkCIQCB8gVS1nNaM1OQ7Pxi9sR2iwJ5PXeE7fA0AyFDJ/UY7QIgeFKCpcBkZUrUMlzfAnKbuspONWPyFweo43cwstqD3nUEIM5a5xMjH7acnUV4FB81BXGC5qZxJIVthBAuDTZw721eBBAN8J2oKEX5JgL55NsH9psu',
  sm2PlaintextHex: '00112233445566778899aabbccddeeff',
};

/**
 * 运行全部 sm-crypto 向量与互操作测试。
 * @param {{sm2: object, sm3: Function, sm4: object}} smCrypto sm-crypto 模块
 * @param {object} expected 期望值集合，默认使用 DEFAULTS
 * @param {boolean} generate 是否生成 JS 侧签名/密文（浏览器只验证时可为 true）
 */
export function runVectors(smCrypto, expected = DEFAULTS, generate = true) {
  const { sm2, sm3, sm4 } = smCrypto;
  const results = [];
  const check = (name, actual, wanted, extra = {}) => {
    const ok = String(actual).toLowerCase() === String(wanted).toLowerCase();
    results.push({ name, ok, actual, expected: wanted, ...extra });
    return ok;
  };

  // 1. SM3
  check('SM3("abc") 标准向量', sm3('abc'), expected.sm3Abc);

  // 2. SM4 单块（ECB，无填充）标准向量
  const sm4Single = bytesToHex(Uint8Array.from(sm4.encrypt(hexToBytes(expected.sm4KeyHex),
    expected.sm4KeyHex, { padding: 'none', output: 'array' })));
  check('SM4 单块加密标准向量', sm4Single, '681edf34d206965e86b3e94f536e4246');
  const sm4SingleDec = bytesToHex(Uint8Array.from(sm4.decrypt('681edf34d206965e86b3e94f536e4246',
    expected.sm4KeyHex, { padding: 'none', output: 'array' })));
  check('SM4 单块解密标准向量', sm4SingleDec, expected.sm4KeyHex);

  // 3. SM4-CBC/PKCS#7 与 Java(BC) 结果对比
  const sm4Cipher = sm4CbcEncrypt(sm4, hexToBytes(expected.sm4PlainHex),
    hexToBytes(expected.sm4KeyHex), hexToBytes(expected.sm4IvHex));
  check('SM4-CBC/PKCS#7 加密与 Java 一致', bytesToHex(sm4Cipher), expected.sm4CipherHex);
  const sm4Plain = sm4CbcDecrypt(sm4, hexToBytes(expected.sm4CipherHex),
    hexToBytes(expected.sm4KeyHex), hexToBytes(expected.sm4IvHex));
  check('SM4-CBC/PKCS#7 解密与 Java 一致', bytesToHex(sm4Plain), expected.sm4PlainHex);

  // 4. KDF（GB/T 32918.3）
  const kdfKey = kdfSm3(sm3, hexToBytes(expected.kdfPasswordUtf8Hex), 16);
  check('KDF(SM3, password, 16) 与 Java 一致', bytesToHex(kdfKey), expected.kdfDerivedKeyHex);

  // 5. SM2 验签：Java BC 签名 -> sm-crypto，默认 userId
  const message = hexToBytes(expected.sm2MessageHex);
  const javaSigOk = sm2.doVerifySignature(Array.from(message), expected.sm2SignatureDerHex,
    expected.sm2PublicKeyHex, { der: true });
  check('Java SM2 签名 -> JS 验签（默认 userId）', javaSigOk, true);
  // 显式使用默认 userId，结果应一致
  const javaSigOkExplicit = sm2.doVerifySignature(Array.from(message), expected.sm2SignatureDerHex,
    expected.sm2PublicKeyHex, { der: true, userId: expected.sm2UserId });
  check('默认 userId 与显式 1234567812345678 等价', javaSigOkExplicit, true);
  // 错误 userId 应失败，证明 user ID/ZA 语义敏感
  const wrongUserIdOk = sm2.doVerifySignature(Array.from(message), expected.sm2SignatureDerHex,
    expected.sm2PublicKeyHex, { der: true, userId: 'wrong-user-id' });
  check('错误 userId 验签失败（ZA 语义敏感）', wrongUserIdOk, false);

  // 6. SM2 私钥解密 Java 生成的 ASN.1 SM2Cipher DER
  const derBytes = base64ToBytes(expected.sm2CipherDerB64);
  const c1c3c2 = sm2CipherDerToC1C3C2(derBytes);
  // sm-crypto 的 C1C3C2 不含 04 前缀；ASN.1 解析结果含 04，需要去掉
  const decrypted = Uint8Array.from(sm2.doDecrypt(bytesToHex(c1c3c2.subarray(1)),
    expected.sm2PrivateKeyHex, 1, { output: 'array' }));
  check('ASN.1 SM2Cipher -> C1C3C2 -> JS 私钥解密', bytesToHex(decrypted), expected.sm2PlaintextHex);
  // 直接解密原始 C1C3C2（Java 输出带 04 前缀，sm-crypto 会自动补 04）
  const decryptedRaw = Uint8Array.from(sm2.doDecrypt(bytesToHex(c1c3c2.subarray(1)),
    expected.sm2PrivateKeyHex, 1, { output: 'array' }));
  check('原始 C1C3C2 与 ASN.1 解密结果一致', bytesToHex(decryptedRaw), expected.sm2PlaintextHex);

  const artifacts = {};
  if (generate) {
    // 7. JS 生成 SM2 签名（DER），供 Java 验证
    const jsSigHex = sm2.doSignature(Array.from(message), expected.sm2PrivateKeyHex, { der: true });
    const jsSigOk = sm2.doVerifySignature(Array.from(message), jsSigHex,
      expected.sm2PublicKeyHex, { der: true });
    check('JS SM2 签名/DER 自验签', jsSigOk, true);
    artifacts.signatureDerHex = jsSigHex;
    artifacts.signatureDerB64 = bytesToBase64(hexToBytes(jsSigHex));

    // 8. JS 生成 SM2 密文（C1C3C2），并编码为 ASN.1 SM2Cipher DER，供 Java 解密
    const jsCipherHex = sm2.doEncrypt(Array.from(hexToBytes(expected.sm2PlaintextHex)),
      expected.sm2PublicKeyHex, 1);
    const jsC1C3C2 = hexToBytes(jsCipherHex);
    const jsDer = c1c3c2ToSm2CipherDer(jsC1C3C2, false);
    artifacts.cipherC1C3C2Hex = jsCipherHex;
    artifacts.cipherDerB64 = bytesToBase64(jsDer);
    check('JS SM2 加密输出长度（C1C3C2）', jsCipherHex.length / 2, 112);
    // JS 自解密
    const jsDecrypted = Uint8Array.from(sm2.doDecrypt(jsCipherHex, expected.sm2PrivateKeyHex, 1,
      { output: 'array' }));
    check('JS 加密 -> JS 解密', bytesToHex(jsDecrypted), expected.sm2PlaintextHex);
    artifacts.plaintextHex = expected.sm2PlaintextHex;
  }
  return { results, artifacts, allPassed: results.every((r) => r.ok) };
}