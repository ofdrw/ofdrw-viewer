/**
 * 动作触发区域的几何计算（页面像素）。
 *
 * 计算链（与文本层同一口径）：
 * `Region / 图元 Boundary（mm）→ 图元 CTM → 页面坐标系 → getPageTransform(area, dpi) → 页面像素`。
 * 输出是**未旋转的页面像素**：缩放与旋转由宿主（UI 的 surface CSS transform）施加，
 * engine 不叠加任何页面级变换。
 *
 * 本模块只做纯数学，不读包内容、不依赖 DOM。
 */

import type { Box, Matrix, Point } from '../common/types';
import { IDENTITY_MATRIX, multiplyMatrix, transformBox, translateMatrix } from '../common/matrix';
import type { ActionInfo, ActionRegionPath, Layer, PageModel, PageObject } from '../model/types';
import { getPageTransform } from './viewport';

/** 贝塞尔曲线离散段数；第一版固定 8 段，不做可配置精度。 */
const CURVE_SEGMENTS = 8;

/**
 * 轴对齐矩形，单位 px。
 *
 * 坐标系：未旋转页面像素，原点为页面左上角（`PhysicalBox` 原点已平移），y 向下。
 */
export interface PixelBox {
  /** 左上角 x，px。 */
  x: number;
  /** 左上角 y，px。 */
  y: number;
  /** 宽，px。 */
  width: number;
  /** 高，px。 */
  height: number;
}

/**
 * 折线路径：一组首尾相接的点。
 *
 * 用于区域命中测试；曲线已离散为折线段。
 */
export type PixelPath = readonly Point[];

/** 动作几何来源。 */
export type ActionGeometrySource = 'region' | 'object' | 'page';

/** 动作触发区域的页内像素几何。 */
export interface ActionGeometry {
  /** 页索引，从 0 开始。 */
  pageIndex: number;
  /** 外接矩形，页面像素（px）。 */
  bbox: PixelBox;
  /**
   * 几何四角点（px），按「左上 → 右上 → 右下 → 左下」顺序。
   *
   * 图元 `CTM` 不含旋转/倾斜时是 `bbox` 的四角，可省略；含旋转时给出精确四角，
   * 宿主按 `matrix()` 还原，避免包围盒放大导致播放器错位。
   */
  corners?: readonly [Point, Point, Point, Point];
  /** 显式 `Region` 的折线近似（px，已离散曲线）；无 `Region` 时省略。 */
  areas?: readonly PixelPath[];
  /** 几何来源：显式区域 / 图元 Boundary / 页面区域。 */
  source: ActionGeometrySource;
}

/** `getActionGeometry` 的计算参数。 */
export interface ActionGeometryOptions {
  /** 页面 `PhysicalBox`，单位 mm；用于 `getPageTransform` 的原点平移。 */
  area: Box;
  /** 输出 DPI，默认 96；非有限或 <=0 时回退 96。 */
  dpi?: number;
  /**
   * 图元几何：`boundary` 为对象空间矩形（mm），`ctm` 为图元局部变换。
   *
   * 宿主为 `object` 且未提供时，退化为页面左上角的零矩形并标记 `source='object'`。
   */
  object?: { boundary: Box; ctm?: Matrix };
  /**
   * 文档级/大纲级动作所在页索引（从 0 开始）。
   *
   * 只在动作带显式 `Region` 时生效：这两类宿主本身没有页面坐标，必须由宿主指定
   * 区域所在页才能换算像素几何；不提供时这两类动作返回 `undefined`。
   */
  pageIndex?: number;
}

/** 默认输出 DPI。 */
const DEFAULT_GEOMETRY_DPI = 96;

/**
 * 图层绘制顺序，与 `render/page.ts` 的 `LAYER_TYPES` 一致。
 *
 * 批量几何按同一层序展开图元，保证返回顺序等于绘制顺序。
 */
const LAYER_DRAW_ORDER: readonly Layer['type'][] = ['Background', 'Body', 'Foreground', 'Custom'];

/** 一条动作与其页面像素几何。 */
export interface ActionGeometryEntry {
  /** 动作信息。 */
  action: ActionInfo;
  /** 该动作的页面像素几何。 */
  geometry: ActionGeometry;
}

/**
 * 取一页全部可定位动作的页面像素几何。
 *
 * 只包含能定位的动作：图元动作（几何取自页模型的 `Boundary`/`CTM`）与带 `Region` 的
 * 页面级动作。文档级动作与无 `Region` 的页面级动作不在结果中。
 *
 * 返回顺序：页级动作在前（XML 顺序），其后图元按**绘制序**（层序 `Background → Body →
 * Foreground → Custom`，层内按 XML 顺序，嵌套 `PageBlock` 递归展开）。宿主命中时应
 * **反向**遍历（后绘制者在上）。
 *
 * @param page 页面模型（`area` 已按回退链解析）。
 * @param actions 页级动作（XML 顺序）。
 * @param objectActions 图元动作：图元 ID → 动作。
 * @param pathActions 无 ID 图元的动作：页内路径键 → 动作。
 * @param dpi 输出 DPI；非有限或 <=0 时回退 96。
 * @returns 动作与几何列表；无可定位动作时为空数组。
 */
export function collectPageActionGeometries(
  page: PageModel,
  actions: readonly ActionInfo[],
  objectActions: ReadonlyMap<string, readonly ActionInfo[]>,
  pathActions: ReadonlyMap<string, readonly ActionInfo[]>,
  dpi?: number,
): ActionGeometryEntry[] {
  const result: ActionGeometryEntry[] = [];
  const resolvedDpi = normalizeDpi(dpi);
  for (const action of actions) {
    const geometry = getActionGeometry(action, { area: page.area, dpi: resolvedDpi });
    if (geometry) result.push({ action, geometry });
  }
  const visited = new Set<string>();
  const pushObject = (object: PageObject, path: readonly number[]): void => {
    const key = path.join('.');
    if (object.kind === 'block') {
      // 嵌套 PageBlock 的自身没有几何，其子图元按同一路径规则继续展开。
      object.children.forEach((child, index) => pushObject(child, [...path, index]));
      return;
    }
    const group = object.id ? objectActions.get(object.id) : pathActions.get(key);
    if (group && group.length > 0) {
      visited.add(object.id ?? key);
      for (const action of group) {
        const geometry = getActionGeometry(action, {
          area: page.area,
          dpi: resolvedDpi,
          object: { boundary: object.boundary, ...(object.ctm ? { ctm: object.ctm } : {}) },
        });
        if (geometry) result.push({ action, geometry });
      }
    }
  };
  for (const type of LAYER_DRAW_ORDER) {
    for (const layer of page.layers) {
      if (layer.type !== type) continue;
      layer.children.forEach((object, index) => pushObject(object, [index]));
    }
  }
  // 未在绘制遍历中命中的图元（例如不支持的节点类型）按存储顺序追加，避免静默丢失。
  for (const [key, group] of pathActions) {
    if (visited.has(key)) continue;
    for (const action of group) {
      const geometry = getActionGeometry(action, { area: page.area, dpi: resolvedDpi });
      if (geometry) result.push({ action, geometry });
    }
  }
  return result;
}

/**
 * 计算动作在指定 DPI 下的页内像素几何。
 *
 * 几何优先级：显式 `Action/Region` → 宿主图元 `Boundary`（叠加 `CTM`）→ 页面区域。
 * 文档级与大纲级动作没有页面坐标，除非带显式 `Region` 且指定了页索引，否则返回 `undefined`。
 *
 * @param action 动作信息。
 * @param options 计算参数：页面区域、DPI 与图元几何。
 * @returns 像素几何；无法定位时返回 `undefined`。
 */
export function getActionGeometry(
  action: ActionInfo,
  options: ActionGeometryOptions,
): ActionGeometry | undefined {
  const pageIndex = actionPageIndex(action) ?? options.pageIndex;
  if (pageIndex === undefined) return undefined;
  const dpi = normalizeDpi(options.dpi);
  const pageMatrix = getPageTransform(options.area, dpi);

  if (action.region) {
    const region = regionGeometry(action.region.areas, pageIndex, pageMatrix);
    if (region) return region;
  }

  const boundary = resolveBoundary(action, options);
  if (!boundary) return undefined;
  return objectGeometry(boundary, pageIndex, pageMatrix);
}

/**
 * 判断页面像素点是否落在动作区域内。
 *
 * 有 `areas` 时按 even-odd 规则对各折线求交；无 `areas` 时退化为 `bbox` 包含判定。
 *
 * @param geometry 动作几何（`getActionGeometry` 的结果）。
 * @param point 页面像素点（px，未旋转页面坐标）。
 * @returns 命中返回 `true`。
 */
export function isPointInActionRegion(geometry: ActionGeometry, point: Point): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  if (!areasGeometryContains(geometry.areas, point)) return false;
  if (geometry.areas !== undefined && geometry.areas.length > 0) return true;
  return pointInBox(geometry.bbox, point);
}

/**
 * 取宿主自带的页索引。
 *
 * @param action 动作信息。
 * @returns 页索引；文档级/大纲级动作返回 `undefined`（由调用方经 `options.pageIndex` 补充）。
 */
function actionPageIndex(action: ActionInfo): number | undefined {
  const owner = action.owner;
  if (owner.kind === 'page' || owner.kind === 'object') return owner.pageIndex;
  return undefined;
}

/**
 * 规范化 DPI。
 *
 * @param dpi 请求的 DPI；省略或非法时回退 96。
 * @returns 可用于 `getPageTransform` 的 DPI。
 */
function normalizeDpi(dpi: number | undefined): number {
  return dpi !== undefined && Number.isFinite(dpi) && dpi > 0 ? dpi : DEFAULT_GEOMETRY_DPI;
}

/**
 * 解析动作的缺省矩形：图元 `Boundary` → 页面区域。
 *
 * @param action 动作信息。
 * @param options 计算参数。
 * @returns 对象空间矩形与其 CTM；无可用几何时 undefined。
 */
function resolveBoundary(
  action: ActionInfo,
  options: ActionGeometryOptions,
): { boundary: Box; ctm: Matrix; hasCtm: boolean } | undefined {
  if (action.owner.kind === 'object' && options.object) {
    const ctm = options.object.ctm;
    return {
      boundary: options.object.boundary,
      ctm: ctm ?? IDENTITY_MATRIX,
      hasCtm: ctm !== undefined,
    };
  }
  if (action.owner.kind === 'object') {
    // 宿主未提供图元几何：给出对象空间零矩形，避免静默返回 undefined 让 UI 丢命中区。
    return { boundary: { x: 0, y: 0, w: 0, h: 0 }, ctm: IDENTITY_MATRIX, hasCtm: false };
  }
  return undefined;
}

/**
 * 计算图元几何：Boundary 原点平移 + CTM，换算为页面像素。
 *
 * 渲染侧顺序（`render/object.ts` 的 `drawObject`）为：
 * `translate(boundary.x, boundary.y)` → `clip(0, 0, boundary.w, boundary.h)` → `transform(CTM)`，
 * 图元内容在 CTM 空间中绘制。因此命中区按「内容在 CTM 空间中的范围」计算：
 * - 声明了 CTM：图片以单位正方形描述，范围为**单位矩形**经 `CTM` 变换（`Boundary` 只负责裁剪）；
 * - 未声明 CTM：图元按对象空间坐标绘制，范围为 `Boundary` 本身。
 *
 * 对图片而言，`CTM` 通常已把单位正方形放大到 `Boundary` 尺寸，此时两种口径结果一致，
 * 不会出现"再乘一次 Boundary 宽高"的双重缩放。
 *
 * @param source 对象空间矩形（mm）、图元 CTM 与是否声明 CTM。
 * @param pageIndex 页索引。
 * @param pageMatrix mm → 页面像素的页面矩阵。
 * @returns 动作几何；`source` 固定为 `object`。
 */
function objectGeometry(
  source: { boundary: Box; ctm: Matrix; hasCtm: boolean },
  pageIndex: number,
  pageMatrix: Matrix,
): ActionGeometry {
  const { boundary, ctm, hasCtm } = source;
  const itemMatrix = multiplyMatrix(
    translateMatrix(pageMatrix, boundary.x, boundary.y),
    ctm,
  );
  const size = hasCtm ? { x: 1, y: 1 } : { x: boundary.w, y: boundary.h };
  const corners = rectCorners(itemMatrix, size);
  const bbox = boxOfPoints(corners);
  const geometry: ActionGeometry = { pageIndex, bbox, source: 'object' };
  if (!isAxisAligned(itemMatrix)) geometry.corners = corners;
  return geometry;
}

/**
 * 计算显式区域的几何：mm 路径 → 页面像素折线 + 外接矩形。
 *
 * @param areas 区域集合（Area → 路径 → 命令）。
 * @param pageIndex 页索引。
 * @param pageMatrix mm → 页面像素的页面矩阵。
 * @returns 动作几何；没有可用折线时 undefined（回退调用方其它几何来源）。
 */
function regionGeometry(
  areas: readonly (readonly (readonly ActionRegionPath[])[])[],
  pageIndex: number,
  pageMatrix: Matrix,
): ActionGeometry | undefined {
  const paths: PixelPath[] = [];
  for (const area of areas) {
    for (const path of area) {
      const flattened = flattenPath(path, pageMatrix);
      if (flattened.length >= 3) paths.push(flattened);
    }
  }
  if (paths.length === 0) return undefined;
  const points = paths.flat();
  return { pageIndex, bbox: boxOfPoints(points), areas: paths, source: 'region' };
}

/**
 * 把区域路径命令离散为页面像素折线。
 *
 * `closePath` 会把首点补到末尾，保证 even-odd 求交闭合。
 *
 * @param path 路径命令（mm）。
 * @param pageMatrix mm → 页面像素的页面矩阵。
 * @returns 折线点（px）。
 */
function flattenPath(path: readonly ActionRegionPath[], pageMatrix: Matrix): Point[] {
  const points: Point[] = [];
  let current: Point | undefined;
  let start: Point | undefined;
  for (const command of path) {
    if (command.type === 'moveTo') {
      current = transformPointOf(pageMatrix, command.x, command.y);
      start = current;
      points.push(current);
      continue;
    }
    if (command.type === 'lineTo') {
      current = transformPointOf(pageMatrix, command.x, command.y);
      points.push(current);
      continue;
    }
    if (command.type === 'closePath') {
      if (start && current && !samePoint(current, start)) points.push({ ...start });
      current = start;
      continue;
    }
    // 三次贝塞尔：mm 空间按固定段数离散后逐点变换。
    const from = current ?? { x: 0, y: 0 };
    for (let step = 1; step <= CURVE_SEGMENTS; step += 1) {
      const t = step / CURVE_SEGMENTS;
      const x = cubicAt(from.x, command.cp1x, command.cp2x, command.x, t);
      const y = cubicAt(from.y, command.cp1y, command.cp2y, command.y, t);
      points.push(transformPointOf(pageMatrix, x, y));
    }
    current = { x: command.x, y: command.y };
  }
  return points;
}

/**
 * 用矩阵变换 mm 坐标点。
 *
 * @param matrix 变换矩阵。
 * @param x 输入 x，mm。
 * @param y 输入 y，mm。
 * @returns 页面像素点。
 */
function transformPointOf(matrix: Matrix, x: number, y: number): Point {
  const [a, b, c, d, e, f] = matrix;
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

/**
 * 计算三次贝塞尔在参数 t 处的值。
 *
 * @param p0 起点。
 * @param p1 控制点 1。
 * @param p2 控制点 2。
 * @param p3 终点。
 * @param t 参数，0..1。
 * @returns 该维度的值。
 */
function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

/**
 * 计算对象空间原点矩形在当前矩阵下的四角点。
 *
 * @param matrix 图元矩阵（已含页面矩阵）。
 * @param size 对象空间宽高，单位 mm。
 * @returns 四角点，顺序「左上 → 右上 → 右下 → 左下」，px。
 */
function rectCorners(matrix: Matrix, size: Point): [Point, Point, Point, Point] {
  return [
    transformPointOf(matrix, 0, 0),
    transformPointOf(matrix, size.x, 0),
    transformPointOf(matrix, size.x, size.y),
    transformPointOf(matrix, 0, size.y),
  ];
}

/**
 * 判断矩阵是否不含旋转/倾斜（`b==0 && c==0`）。
 *
 * @param matrix 输入矩阵。
 * @returns 是否轴对齐。
 */
function isAxisAligned(matrix: Matrix): boolean {
  return Math.abs(matrix[1]) <= 1e-9 && Math.abs(matrix[2]) <= 1e-9;
}

/**
 * 计算点集的外接矩形。
 *
 * @param points 点集。
 * @returns 外接矩形（px）；空集为零矩形。
 */
function boxOfPoints(points: readonly Point[]): PixelBox {
  const first = points[0] ?? { x: 0, y: 0 };
  let minX = first.x;
  let minY = first.y;
  let maxX = first.x;
  let maxY = first.y;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * 点是否落在矩形内（含边界）。
 *
 * @param box 矩形（px）。
 * @param point 点（px）。
 * @returns 是否命中。
 */
function pointInBox(box: PixelBox, point: Point): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

/**
 * 用 even-odd 规则判断点是否落在折线集合内部。
 *
 * 各折线独立计交点：同一点被奇数条折线覆盖即视为命中。
 *
 * @param areas 折线集合（px）；undefined 时不做路径判定。
 * @param point 点（px）。
 * @returns 是否命中；`areas` 为空数组时返回 false。
 */
function areasGeometryContains(areas: readonly PixelPath[] | undefined, point: Point): boolean {
  if (areas === undefined) return true;
  if (areas.length === 0) return false;
  let inside = false;
  for (const path of areas) {
    for (let index = 0, prev = path.length - 1; index < path.length; prev = index, index += 1) {
      const current = path[index] as Point;
      const last = path[prev] as Point;
      if (current.y === last.y) continue;
      if (point.y < Math.min(current.y, last.y) || point.y > Math.max(current.y, last.y)) continue;
      const x = ((point.y - current.y) * (last.x - current.x)) / (last.y - current.y) + current.x;
      if (point.x < x) inside = !inside;
    }
  }
  return inside;
}

/**
 * 判断两点是否重合（容差 1e-9）。
 *
 * @param a 点 A。
 * @param b 点 B。
 * @returns 是否重合。
 */
function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) <= 1e-9 && Math.abs(a.y - b.y) <= 1e-9;
}

/**
 * 把对象空间矩形经矩阵变换后的轴对齐包围盒换算为 `PixelBox`。
 *
 * @param matrix 变换矩阵。
 * @param box 对象空间矩形（mm）。
 * @returns 页面像素矩形。
 */
export function transformPixelBox(matrix: Matrix, box: Box): PixelBox {
  const result = transformBox(matrix, box);
  return { x: result.x, y: result.y, width: result.w, height: result.h };
}