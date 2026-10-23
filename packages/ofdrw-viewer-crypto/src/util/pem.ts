/**
 * PEM 文本解析（证书、私钥共用）。
 */

import { CryptoError } from '../errors';
import { tryFromBase64 } from './bytes';

/** 一个 PEM 块。 */
export interface PemBlock {
  /** 块类型，例如 `CERTIFICATE`、`PRIVATE KEY`、`EC PRIVATE KEY`。 */
  readonly type: string;
  /** DER 字节。 */
  readonly der: Uint8Array;
}

/** PEM 块正则；兼容 CRLF 与块间空白。 */
const PEM_PATTERN = /-----BEGIN ([^-]+)-----([\s\S]*?)-----END \1-----/g;

/**
 * 判断文本是否包含 PEM 块。
 *
 * @param text 文本。
 * @returns 含 `-----BEGIN` 时返回 true。
 */
export function looksLikePem(text: string): boolean {
  return text.includes('-----BEGIN ');
}

/**
 * 解析全部 PEM 块。
 *
 * @param text PEM 文本。
 * @returns PEM 块数组；没有匹配时返回空数组。
 * @throws CryptoError `CRYPTO_ASN1_INVALID`：块内 Base64 非法。
 */
export function parsePemBlocks(text: string): PemBlock[] {
  const blocks: PemBlock[] = [];
  PEM_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PEM_PATTERN.exec(text)) !== null) {
    const type = match[1].trim();
    const der = tryFromBase64(match[2]);
    if (!der) {
      throw new CryptoError('CRYPTO_ASN1_INVALID', `PEM 块 ${type} 的 Base64 非法`);
    }
    blocks.push({ type, der });
  }
  return blocks;
}