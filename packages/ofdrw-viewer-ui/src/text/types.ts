/**
 * 文本模块内部共享类型。
 *
 * 查找控制器只向“高亮渲染器”发布命中集合，不直接操作 DOM；文本层服务实现该
 * 接口，从而保持 FindController 的纯逻辑可测试性。
 */

import type { HighlightBox } from './geometry';

/** 单个查找命中。 */
export interface FindMatch {
  /** 稳定 ID，用于高亮 DOM 的 `data-match-id`。 */
  readonly id: string;
  /** 页码，1-based。 */
  readonly pageNumber: number;
  /** 在可搜索文本中的起始下标。 */
  readonly start: number;
  /** 结束下标（不含）。 */
  readonly end: number;
  /** 命中文本。 */
  readonly text: string;
  /** 高亮框，单位 CSS px（96 DPI）。 */
  readonly boxes: readonly HighlightBox[];
}

/** 高亮渲染器；由文本层服务实现。 */
export interface FindHighlightRenderer {
  /**
   * 更新命中集合并重绘可见页高亮。
   *
   * @param matches 全部命中。
   * @param current 当前命中序号，1-based；0 表示无。
   * @param highlightAll 是否显示全部命中。
   */
  setFindMatches(matches: readonly FindMatch[], current: number, highlightAll: boolean): void;
  /**
   * 更新当前命中并重绘。
   *
   * @param current 当前命中序号，1-based。
   */
  setFindCurrent(current: number): void;
  /** 清除全部查找高亮。 */
  clearFindHighlights(): void;
  /**
   * 滚动到指定命中并确保其高亮可见。
   *
   * @param match 命中项。
   */
  scrollToMatch(match: FindMatch): void;
}

/** 分片调度器；默认使用 requestIdleCallback/setTimeout，测试可注入。 */
export interface SliceScheduler {
  /**
   * 请求在下一个空闲/宏任务执行回调。
   *
   * @param callback 回调。
   */
  request(callback: () => void): void;
}