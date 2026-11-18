/**
 * 动作几何换算（UI 动作处理机制设计 §6.6 / 音视频与动作方案设计 §5.5 / §7.2）。
 *
 * **本模块是动作模块与 engine 几何 API 之间唯一的接缝**：命中表与媒体层定位都只
 * 通过这里拿页面像素几何，避免几何换算散落在多处。
 *
 * ## 坐标口径（必须与文本层一致）
 *
 * - engine 输出**未旋转的页面像素**（原点页面 `PhysicalBox` 左上角，y 向下），与
 *   `toTextPagePx()` 使用同一套 `getPageTransform(area, dpi)`（`scale = dpi / 25.4`
 *   并已含 `PhysicalBox` 原点平移）；
 * - 页面旋转由 `surface` 的 CSS transform 承担，这里不做任何旋转补偿；
 * - 缩放由页面容器的 `--scale-factor` 承担，这里也不乘缩放倍率。
 *
 * ## 硬约束：不手写 DPI 换算
 *
 * 本模块**不自行把毫米换算成像素**。一旦这里写第二份换算，就会与 engine 的
 * `getPageTransform` 产生口径偏差（原点平移、dpi 取整、缩放叠加后漂移），且这种
 * 偏差只在特定页面/倍率下暴露，属于最难排查的一类缺陷。因此几何全部来自 engine：
 * 批量入口 `getPageActionGeometries()`，单条入口 `getActionGeometry()`。
 */

import type { ActionGeometry, ActionInfo } from '@ofdrw/ofdrw-viewer-engine';
import type { ActionBox, ActionPoint } from './types';

/** 输出 DPI；动作层与文本层统一按 96 DPI CSS 像素构建。 */
export const ACTION_GEOMETRY_DPI = 96;

/**
 * 把 engine 的 `ActionGeometry` 转为命中表使用的像素矩形。
 *
 * `PixelBox` 与 `ActionBox` 同为页面像素、原点页面左上角、y 向下，只是字段名不同，
 * 这里只做字段重命名，**不做任何数值换算**。
 *
 * @param geometry engine 几何。
 * @returns 页面像素矩形。
 */
export function toActionBox(geometry: ActionGeometry): ActionBox {
  const { bbox } = geometry;
  return { left: bbox.x, top: bbox.y, width: bbox.width, height: bbox.height };
}

/**
 * 把 engine 几何的折线近似转为命中用多边形点列。
 *
 * @param geometry engine 几何。
 * @returns 每个 `Area` 一个多边形（页面像素）；无 `areas` 时返回空数组。
 */
export function toActionAreas(geometry: ActionGeometry): readonly (readonly ActionPoint[])[] {
  const areas = geometry.areas;
  if (!areas || areas.length === 0) return [];
  const result: ActionPoint[][] = [];
  for (const area of areas) {
    const points: ActionPoint[] = [];
    for (const point of area) points.push({ x: point.x, y: point.y });
    if (points.length >= 3) result.push(points);
  }
  return result;
}