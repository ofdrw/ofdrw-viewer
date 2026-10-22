/**
 * 阅读器 UI 错误类型。
 *
 * 引擎错误（`OFDError` + `OFD_*` 码）原样从引擎包重导出，便于宿主统一 `instanceof`
 * 判断；UI 自身只新增与阅读器交互相关的错误码，其中功能关闭固定使用
 * `OFD_FEATURE_DISABLED` 并携带 `feature` 字段。
 */

import type { FeatureState, ViewerFeature } from './features';

export { OFDError, isOFDError, toOFDError } from 'ofdrw-viewer-engine';
export type { OFDErrorCode, OFDErrorOptions } from 'ofdrw-viewer-engine';

/** 功能被关闭时使用的错误码；错误对象必须携带 `feature`。 */
export const OFD_FEATURE_DISABLED = 'OFD_FEATURE_DISABLED' as const;

/** UI 错误码；引擎错误码见引擎包的 `OFDErrorCode`。 */
export type ViewerErrorCode =
  | typeof OFD_FEATURE_DISABLED
  | 'OFD_INVALID_OPTION'
  | 'OFD_INVALID_PAGE'
  | 'OFD_NOT_OPENED'
  | 'OFD_DESTROYED'
  | 'OFD_UNSUPPORTED'
  | 'OFD_EXPORT_FAILED'
  | 'OFD_PRINT_FAILED'
  | 'OFD_SIGNATURE_PARSE_FAILED'
  | 'OFD_CLIPBOARD_FAILED';

/** UI 错误附加信息。 */
export interface ViewerErrorOptions {
  /** 原始错误。 */
  readonly cause?: unknown;
  /** 关联功能；功能关闭错误必填。 */
  readonly feature?: ViewerFeature;
  /** 关联页，1-based。 */
  readonly pageNumber?: number;
}

/** 阅读器 UI 统一错误。 */
export class OFDViewerError extends Error {
  /** 机器可读错误码。 */
  readonly code: ViewerErrorCode;
  /** 关联功能；仅功能类错误存在。 */
  readonly feature?: ViewerFeature;
  /** 关联页，1-based；与页面无关时省略。 */
  readonly pageNumber?: number;
  /** 原始错误。 */
  override readonly cause?: unknown;

  /**
   * 创建 UI 错误。
   *
   * @param code 错误码。
   * @param message 人类可读信息。
   * @param options 附加信息。
   */
  constructor(code: ViewerErrorCode, message: string, options: ViewerErrorOptions = {}) {
    super(message);
    this.name = 'OFDViewerError';
    this.code = code;
    this.feature = options.feature;
    this.pageNumber = options.pageNumber;
    this.cause = options.cause;
  }
}

/**
 * 判断值是否为阅读器 UI 错误。
 *
 * @param value 待判断值。
 * @returns 是 `OFDViewerError` 时返回 true。
 */
export function isOFDViewerError(value: unknown): value is OFDViewerError {
  return value instanceof OFDViewerError;
}

/**
 * 创建功能关闭错误。
 *
 * @param feature 被关闭的功能键。
 * @param message 自定义信息；省略时使用统一中文文案。
 * @returns 带 `OFD_FEATURE_DISABLED` 与 `feature` 的错误。
 */
export function createFeatureDisabledError(
  feature: ViewerFeature,
  message?: string,
): OFDViewerError {
  return new OFDViewerError(
    OFD_FEATURE_DISABLED,
    message ?? `功能“${feature}”已被关闭，无法执行该操作`,
    { feature },
  );
}

/**
 * 判断是否为某个功能的关闭错误。
 *
 * @param value 待判断值。
 * @param feature 可选的期望功能；省略时只校验错误码。
 * @returns 匹配时返回 true。
 */
export function isFeatureDisabledError(
  value: unknown,
  feature?: ViewerFeature,
): value is OFDViewerError {
  if (!(value instanceof OFDViewerError) || value.code !== OFD_FEATURE_DISABLED) {
    return false;
  }
  return feature === undefined || value.feature === feature;
}

/**
 * 断言功能可用；不可用则抛 `OFD_FEATURE_DISABLED`。
 *
 * @param feature 功能键。
 * @param state 该功能的有效状态。
 * @throws {OFDViewerError} 功能不可用时抛出。
 */
export function assertFeatureEnabled(
  feature: ViewerFeature,
  state: FeatureState,
): void {
  if (!state.enabled) throw createFeatureDisabledError(feature);
}

/**
 * 将任意错误包装为 UI 错误；已是 `OFDViewerError` 时原样返回。
 *
 * @param error 原始错误/值。
 * @param code 包装时使用的错误码。
 * @param message 包装时使用的信息。
 * @param options 附加信息。
 * @returns UI 错误实例。
 */
export function toOFDViewerError(
  error: unknown,
  code: ViewerErrorCode,
  message: string,
  options: ViewerErrorOptions = {},
): OFDViewerError {
  if (error instanceof OFDViewerError) return error;
  return new OFDViewerError(code, message, { ...options, cause: error });
}