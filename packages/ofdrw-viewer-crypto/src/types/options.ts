/**
 * 公共选项类型（对应设计方案 §3.1）。
 */

import type { CryptoLimits } from './limits';
import type { CryptoWarningHandler } from './warnings';

/** 所有 crypto 公共入口共享的选项。 */
export interface CryptoOptions {
  /** 资源上限；省略字段使用 `DEFAULT_CRYPTO_LIMITS`。 */
  readonly limits?: Partial<CryptoLimits>;
  /** 取消信号；中止时抛 `CRYPTO_ABORTED`。 */
  readonly signal?: AbortSignal;
  /** warning 回调，不中断处理。 */
  readonly onWarning?: CryptoWarningHandler;
  /** SM2 签名 userId，默认标准值 `1234567812345678`；不从证书推导。 */
  readonly sm2UserId?: string;
  /** 校验证书有效期使用的当前时间，默认 `new Date()`；测试可注入。 */
  readonly now?: Date;
}

/** 纯解析 API（ASN.1/证书/签章/时间戳）的选项。 */
export interface ParseOptions {
  /** 输入字节上限，单位 byte；默认 `maxAsn1Bytes`。 */
  readonly maxBytes?: number;
  /** ASN.1 嵌套深度上限，单位层；默认 `maxAsn1Depth`。 */
  readonly maxDepth?: number;
}