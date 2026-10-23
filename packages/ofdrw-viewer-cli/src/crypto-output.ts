/**
 * crypto 结果在 CLI 控制台的统一呈现辅助。
 *
 * 只输出 crypto 已脱敏的 warning 文案；不输出凭据、私钥、PEM 或 EncryptedWK。
 */

import type { CryptoWarning } from '@ofdrw/ofdrw-viewer-crypto';
import type { Logger } from './log.js';
import { sanitizeDisplayText } from './safe-text.js';

/**
 * 把 crypto warning 逐条写入 stderr。
 *
 * @param logger 日志器
 * @param warnings crypto warning 列表
 */
export function reportCryptoWarnings(
  logger: Logger,
  warnings: readonly CryptoWarning[],
): void {
  for (const warning of warnings) {
    const message = sanitizeDisplayText(warning.message);
    const location =
      warning.path === undefined ? '' : `（${sanitizeDisplayText(warning.path)}）`;
    logger.warn(warning.code, `${message}${location}`);
  }
}