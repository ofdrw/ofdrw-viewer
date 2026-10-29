/**
 * 阅读器 UI 版本与依赖包版本。
 *
 * UI 自身版本随 package.json 的 version 同步维护；engine/crypto 版本直接复用
 * 各包导出的 `VERSION`，保证故障排查时看到的是实际加载的实现版本。
 */
import { VERSION as ENGINE_VERSION } from '@ofdrw/ofdrw-viewer-engine';
import { VERSION as CRYPTO_VERSION } from '@ofdrw/ofdrw-viewer-crypto';

/** 阅读器 UI 版本。 */
export const VERSION = '0.1.5';

/** 阅读器各组成包的版本集合。 */
export interface ViewerVersions {
  /** 阅读器 UI 版本。 */
  readonly ui: string;
  /** 渲染引擎版本。 */
  readonly engine: string;
  /** 密码能力包版本。 */
  readonly crypto: string;
}

/**
 * 查询阅读器各组成包的版本。
 *
 * @returns UI、engine 与 crypto 的版本号
 */
export function getVersions(): ViewerVersions {
  return {
    ui: VERSION,
    engine: ENGINE_VERSION,
    crypto: CRYPTO_VERSION,
  };
}