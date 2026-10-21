/**
 * 引擎 warning 类型、warning 码索引与去重收集器（对应设计方案 15.4）。
 *
 * warning 不中断渲染；同一 `(code, pageIndex, objectId)` 只上报一次。
 */

import type { ResourceId } from './model/types';

/** 公共 warning 码（冻结）。 */
export type WarningCode =
  | 'W_FONT_MISSING'
  | 'W_GLYPH_MISSING'
  | 'W_IMAGE_DECODE'
  | 'W_UNSUPPORTED_PAINT'
  | 'W_UNSUPPORTED_CLIP'
  | 'W_BAD_NUMBER'
  | 'W_BAD_PATH'
  | 'W_DUPLICATE_RESOURCE'
  | 'W_COMPOSITE_DEPTH'
  | 'W_PATTERN_LIMIT'
  | 'W_ZERO_BOUNDARY'
  | 'W_PHYSICALBOX_ORIGIN'
  | 'W_IMAGE_NO_CTM'
  | 'W_NEGATIVE_BOUNDARY'
  | 'W_LAYER_ORDER'
  | 'W_BLEND_MODE'
  | 'W_RADIAL_UNSUPPORTED'
  | 'W_GOURAUD_APPROX'
  | 'W_ANNOT_EMPTY'
  | 'W_JBIG2_DECODE';

/** warning 码索引；顺序与上表一致，供文档/测试断言。 */
export const WARNING_CODES: readonly WarningCode[] = Object.freeze([
  'W_FONT_MISSING',
  'W_GLYPH_MISSING',
  'W_IMAGE_DECODE',
  'W_UNSUPPORTED_PAINT',
  'W_UNSUPPORTED_CLIP',
  'W_BAD_NUMBER',
  'W_BAD_PATH',
  'W_DUPLICATE_RESOURCE',
  'W_COMPOSITE_DEPTH',
  'W_PATTERN_LIMIT',
  'W_ZERO_BOUNDARY',
  'W_PHYSICALBOX_ORIGIN',
  'W_IMAGE_NO_CTM',
  'W_NEGATIVE_BOUNDARY',
  'W_LAYER_ORDER',
  'W_BLEND_MODE',
  'W_RADIAL_UNSUPPORTED',
  'W_GOURAUD_APPROX',
  'W_ANNOT_EMPTY',
  'W_JBIG2_DECODE',
]);

/** 一条 warning。 */
export interface OFDWarning {
  /** warning 码；类型上允许字符串以兼容扩展。 */
  code: WarningCode | string;
  /** 诊断信息。 */
  message: string;
  /** 页索引，从 0 开始。 */
  pageIndex?: number;
  /** 对象 ID。 */
  objectId?: ResourceId;
  /** 资源 ID。 */
  resourceId?: ResourceId;
}

/** warning 上下文。 */
export interface WarningContext {
  pageIndex?: number;
  objectId?: ResourceId;
  resourceId?: ResourceId;
}

/** warning 回调。 */
export type WarningHandler = (warning: OFDWarning) => void;

/** warning 上报接口；实现负责去重与转发。 */
export interface WarningEmitter {
  /**
   * 上报一条 warning。
   *
   * @param code warning 码。
   * @param message 诊断信息。
   * @param context 可选页/对象/资源上下文。
   */
  warn(code: WarningCode | string, message: string, context?: WarningContext): void;
}

/**
 * warning 收集器：按 `(code, pageIndex, objectId)` 去重，并转发给宿主回调。
 *
 * 默认回调为空（不打印），符合设计方案“默认 onWarning 为空”。
 */
export class WarningCollector implements WarningEmitter {
  private readonly seen = new Set<string>();
  private readonly items: OFDWarning[] = [];

  /**
   * 创建收集器。
   *
   * @param handler 宿主回调；不传时只记录不输出。
   */
  constructor(private readonly handler?: WarningHandler) {}

  /** 已收集的 warning（去重后，按首次出现顺序）。 */
  get warnings(): readonly OFDWarning[] {
    return this.items;
  }

  /**
   * 上报 warning。
   *
   * @param code warning 码。
   * @param message 诊断信息。
   * @param context 页/对象/资源上下文。
   */
  warn(code: WarningCode | string, message: string, context: WarningContext = {}): void {
    const pageIndex = context.pageIndex;
    const objectId = context.objectId;
    const key = `${code}\u0000${pageIndex ?? ''}\u0000${objectId ?? ''}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const warning: OFDWarning = { code, message };
    if (pageIndex !== undefined) warning.pageIndex = pageIndex;
    if (objectId !== undefined) warning.objectId = objectId;
    if (context.resourceId !== undefined) warning.resourceId = context.resourceId;
    this.items.push(warning);
    this.handler?.(warning);
  }

  /** 清空去重集合与已收集列表。 */
  clear(): void {
    this.seen.clear();
    this.items.length = 0;
  }
}