/**
 * 解密凭据类型（对应设计方案 §3.1）。
 *
 * 口令与私钥只作为调用栈内的局部变量使用，不得进入结果/warning/日志。
 */

/** SM2 私钥输入；`pem` 与 `der` 二选一。 */
export interface Sm2PrivateKeyInput {
  /** PKCS#8 PEM / SEC1 PEM；可含加密 PKCS#8 头。 */
  readonly pem?: string;
  /** PKCS#8 DER（未加密）；与 `pem` 互斥。 */
  readonly der?: Uint8Array;
  /** 加密 PKCS#8 口令；未加密私钥传该值会被忽略。 */
  readonly passphrase?: string;
}

/** 口令凭据，对应 OFD `DecyptSeed/UserInfo@UserName`。 */
export interface PasswordCredential {
  readonly kind: 'password';
  /** 用户名；省略时仅在唯一匹配用户时自动选择。 */
  readonly userName?: string;
  /** 口令；按 UTF-8 编码参与 KDF，不做 Unicode 归一化。 */
  readonly password: string;
}

/** SM2 私钥凭据，对应证书加密用户。 */
export interface PrivateKeyCredential {
  readonly kind: 'private-key';
  /** 用户名；省略时仅在唯一匹配用户时自动选择。 */
  readonly userName?: string;
  /** SM2 私钥（PKCS#8/SEC1）。 */
  readonly privateKey: Sm2PrivateKeyInput;
}

/** 解密凭据联合类型。 */
export type CryptoCredential = PasswordCredential | PrivateKeyCredential;