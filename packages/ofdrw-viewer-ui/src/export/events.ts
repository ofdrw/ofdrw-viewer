/**
 * 输出任务事件转发。
 *
 * 核心 `OFDViewer` 通过 `on('printprogress' | 'exportprogress' | 'warning')`
 * 暴露输出事件，但扩展模块拿不到公开的 emit。这里以结构化方式探测实例内部的
 * 类型化事件总线：存在则转发，不存在则静默（宿主自绘工具栏可继续用
 * `onProgress`/`onWarning` 回调）。不修改 `viewer.ts`。
 */

import type { ViewerEventMap, ViewerEventName } from '../types';
import type { OutputHost } from './host';

/** 带内部事件总线的宿主；`OFDViewer` 运行时结构兼容。 */
interface EventEmitterHost {
  emit?: <K extends ViewerEventName>(event: K, payload: ViewerEventMap[K]) => void;
}

/**
 * 转发输出事件。
 *
 * @param host 输出宿主。
 * @param event 事件名。
 * @param payload 事件载荷。
 */
export function emitOutputEvent<K extends ViewerEventName>(
  host: OutputHost,
  event: K,
  payload: ViewerEventMap[K],
): void {
  const emitter = host as unknown as EventEmitterHost;
  if (typeof emitter.emit !== 'function') return;
  try {
    emitter.emit.call(host, event, payload);
  } catch {
    // 事件监听器异常由核心事件总线隔离；此处只防御内部结构变化。
  }
}