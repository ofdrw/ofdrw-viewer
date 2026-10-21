/**
 * 公共 API 层的 warning 路由与去重。
 *
 * 下层（容器/模型/字体/渲染管线）各自只负责产生 `OFDWarning`；本文件把它们
 * 统一交给 `WarningCollector`，按 `(code, pageIndex, objectId)` 去重后再转发给
 * 宿主 `onWarning`。默认没有宿主回调时静默。
 */

import { WarningCollector } from '../warnings';
import type { OFDWarning, WarningHandler } from '../warnings';

/**
 * 创建文档级 warning 收集器。
 *
 * @param onWarning 宿主回调；缺省静默。
 * @returns 去重收集器。
 */
export function createWarningCollector(onWarning?: WarningHandler): WarningCollector {
  return new WarningCollector(onWarning);
}

/**
 * 把 warning 的上下文补全后交给收集器。
 *
 * @param collector 收集器。
 * @param warning 原始 warning。
 * @param pageIndex 缺省页索引，从 0 开始。
 */
function forward(collector: WarningCollector, warning: OFDWarning, pageIndex?: number): void {
  const context: { pageIndex?: number; objectId?: string; resourceId?: string } = {};
  const resolvedPage = warning.pageIndex ?? pageIndex;
  if (resolvedPage !== undefined) context.pageIndex = resolvedPage;
  if (warning.objectId !== undefined) context.objectId = warning.objectId;
  if (warning.resourceId !== undefined) context.resourceId = warning.resourceId;
  collector.warn(warning.code, warning.message, context);
}

/**
 * 创建带页面归属的 warning 处理器。
 *
 * 下层 warning 若自带 `pageIndex` 则优先使用，否则补上当前页索引；
 * 这样同一个 warning 在不同页仍会分别上报，而同一页内重复 warning 被去重。
 *
 * @param collector 收集器。
 * @param pageIndex 当前页索引，从 0 开始。
 * @returns warning 处理器。
 */
export function createPageWarningHandler(
  collector: WarningCollector,
  pageIndex: number,
): WarningHandler {
  return (warning) => forward(collector, warning, pageIndex);
}

/**
 * 创建文档级 warning 处理器。
 *
 * @param collector 收集器。
 * @returns warning 处理器。
 */
export function createDocumentWarningHandler(collector: WarningCollector): WarningHandler {
  return (warning) => forward(collector, warning);
}

/**
 * 字体层 warning 适配器；把 `(code, message, {resourceId})` 转成 OFDWarning。
 *
 * @param collector 收集器。
 * @param pageIndex 可选页索引（预加载字体时使用）。
 * @returns 字体层 warning 回调。
 */
export function createFontWarningHandler(
  collector: WarningCollector,
  pageIndex?: number,
): (code: string, message: string, context?: { resourceId?: string }) => void {
  return (code, message, context) => {
    const warning: OFDWarning = { code, message };
    if (context?.resourceId !== undefined) warning.resourceId = context.resourceId;
    forward(collector, warning, pageIndex);
  };
}