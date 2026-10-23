/**
 * `sm-crypto@0.5.7` 的最小类型声明。
 *
 * 上游包未提供 TypeScript 类型；这里只声明 crypto 包实际使用的
 * SM2/SM3/SM4 方法，参数/返回值语义与上游实现一致：
 * - 字节入参统一为普通数组或 Uint8Array；
 * - SM3/签名/密文输出为十六进制字符串；
 * - SM2 密文为 C1C3C2，且不含未压缩点前缀 `04`。
 */
declare module 'sm-crypto' {
  /** SM3 摘要：输入字符串（UTF-8）或字节数组，返回小写十六进制。 */
  export type Sm3 = (input: string | number[] | Uint8Array) => string;

  export interface Sm2SignatureOptions {
    /** 是否输出/输入 DER 编码签名；默认 false（r||s 定长）。 */
    readonly der?: boolean;
    /** 是否先做 SM3 杂凑；默认 true。 */
    readonly hash?: boolean;
    /** 验签/签名使用的公钥；默认由私钥推导。 */
    readonly publicKey?: string;
    /** SM2 用户 ID；默认 `1234567812345678`。 */
    readonly userId?: string;
    /** 预计算点池（性能优化）。 */
    readonly pointPool?: unknown[];
  }

  export interface Sm2EncryptOptions {
    /** 0 = C1C2C3，1 = C1C3C2；默认 1。 */
    readonly cipherMode?: 0 | 1;
  }

  export interface Sm2DecryptOptions {
    /** 输出形态；`array` 返回字节数组，`string` 返回 UTF-8 字符串。 */
    readonly output?: 'string' | 'array';
  }

  export interface Sm2KeyPair {
    readonly publicKey: string;
    readonly privateKey: string;
  }

  export interface Sm2 {
    generateKeyPairHex(): Sm2KeyPair;
    getPublicKeyFromPrivateKey(privateKey: string): string;
    compressPublicKeyHex(publicKey: string): string;
    verifyPublicKey(publicKey: string): boolean;
    doSignature(
      message: string | number[] | Uint8Array,
      privateKey: string,
      options?: Sm2SignatureOptions,
    ): string;
    doVerifySignature(
      message: string | number[] | Uint8Array,
      signature: string,
      publicKey: string,
      options?: Sm2SignatureOptions,
    ): boolean;
    doEncrypt(
      message: string | number[] | Uint8Array,
      publicKey: string,
      cipherMode?: 0 | 1,
    ): string;
    doDecrypt(
      ciphertext: string,
      privateKey: string,
      cipherMode?: 0 | 1,
      options?: Sm2DecryptOptions,
    ): string | number[];
  }

  export interface Sm4Options {
    /** 填充方式；`none` 表示不做填充，调用方自行处理 PKCS#7。 */
    readonly padding?: 'pkcs#5' | 'pkcs#7' | 'none';
    /** 分组模式；crypto 只使用 CBC。 */
    readonly mode?: 'cbc';
    /** IV；十六进制字符串或字节数组，CBC 模式必须 16 byte。 */
    readonly iv?: string | number[];
    /** 输出形态；`array` 返回字节数组。 */
    readonly output?: 'string' | 'array';
  }

  export interface Sm4 {
    encrypt(
      data: string | number[] | Uint8Array,
      key: string | number[],
      options?: Sm4Options,
    ): string | number[];
    decrypt(
      data: string | number[] | Uint8Array,
      key: string | number[],
      options?: Sm4Options,
    ): string | number[];
  }

  const smCrypto: {
    readonly sm2: Sm2;
    readonly sm3: Sm3;
    readonly sm4: Sm4;
  };

  export default smCrypto;
}