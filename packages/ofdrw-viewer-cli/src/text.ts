/**
 * 空间文本记录构建。
 *
 * engine 的 `OFDPage.getTextContent` 返回 px 坐标的 `TextItem` 列表；CLI 只
 * 保留每项文本与轴对齐包围盒，输出扁平数组，便于直接叠加到同页图片。
 */

import type { TextContent } from '@ofdrw/ofdrw-viewer-engine';

/** 单条空间文本记录；仅包含设计约定的五个字段。 */
export interface TextRecord {
  /** 原始文本内容（可能含空白/换行）。 */
  readonly text: string;
  /** 包围盒左上角 x，px。 */
  readonly x: number;
  /** 包围盒左上角 y，px。 */
  readonly y: number;
  /** 包围盒宽，px。 */
  readonly w: number;
  /** 包围盒高，px。 */
  readonly h: number;
}

/**
 * 把 engine 文本内容扁平化为 JSON 记录。
 *
 * 保持 `items` 原始顺序，跳过空文本；坐标直接取 `rect`，保留原始小数。
 *
 * @param content engine 返回的页面文本内容
 * @returns 仅含 text/x/y/w/h 的记录数组；空页返回 `[]`
 */
export function buildTextRecords(content: Pick<TextContent, 'items'>): TextRecord[] {
  return content.items
    .filter((item) => item.text.length > 0)
    .map((item) => ({
      text: item.text,
      x: item.rect.x,
      y: item.rect.y,
      w: item.rect.width,
      h: item.rect.height,
    }));
}
