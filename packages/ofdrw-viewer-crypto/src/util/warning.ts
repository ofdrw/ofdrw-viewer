/**
 * warning 收集器。
 *
 * 去重规则：`(code, path, message)` 完全相同的 warning 只保留一次，
 * 避免多层解密/多个签名重复上报同一条问题。
 */

import type { CryptoWarning, CryptoWarningHandler } from '../types/warnings';

/** warning 收集器。 */
export interface WarningCollector {
  /** 已收集的 warning（按上报顺序）。 */
  readonly warnings: readonly CryptoWarning[];
  /**
   * 上报一条 warning。
   *
   * @param warning warning 内容。
   */
  emit(warning: CryptoWarning): void;
}

/**
 * 创建 warning 收集器。
 *
 * @param handler 额外的宿主导出回调（可选）；回调异常会被吞掉，不影响主流程。
 * @returns warning 收集器。
 */
export function createWarningCollector(handler?: CryptoWarningHandler): WarningCollector {
  const warnings: CryptoWarning[] = [];
  const seen = new Set<string>();
  return {
    get warnings() {
      return warnings;
    },
    emit(warning) {
      const key = `${warning.code}\u0000${warning.path ?? ''}\u0000${warning.message}`;
      if (seen.has(key)) return;
      seen.add(key);
      warnings.push(warning);
      if (handler) {
        try {
          handler(warning);
        } catch {
          // 宿主回调异常不得影响解密/验证主流程。
        }
      }
    },
  };
}