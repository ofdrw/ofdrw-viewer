/**
 * 无 OFD 语义的公共类型。
 *
 * 本文件只包含矩阵、几何、颜色、绘制样式、渲染器可消费的 Paint 描述，
 * 以及平台图像/句柄类型；不得引用 model/style/render/api 中的任何类型。
 */

import type { DisplayList } from './display-list';
import type { PageBlock } from '../model/types';
import type { ResolvedStyle } from '../style/types';

/** 2×3 仿射矩阵，列主序：`[a, b, c, d, e, f]` 对应 `x' = a·x + c·y + e`、`y' = b·x + d·y + f`。 */
export type Matrix = readonly [number, number, number, number, number, number];

/** 页面/对象空间中的点，单位由调用方上下文决定（通常为 mm）。 */
export interface Point {
  x: number;
  y: number;
}

/** 轴对齐矩形；x/y 为左上角，w/h 必须由使用方归一化为非负值。单位 mm。 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** RGBA 颜色，四个通道均为 0..255 的整数；`a=255` 表示不透明。 */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** 线段端点样式，取值与 Canvas `lineCap` 的 OFD 语义一致。 */
export type LineCap = 'Butt' | 'Round' | 'Square';

/** 线段连接样式，取值与 Canvas `lineJoin` 的 OFD 语义一致。 */
export type LineJoin = 'Miter' | 'Round' | 'Bevel';

/** 填充规则：与 Canvas 的 `fill(rule)` / `clip(rule)` 一致。 */
export type FillRule = 'nonzero' | 'evenodd';

/**
 * 渲染器绘制路径时使用的最终线型。
 *
 * 所有长度字段都位于“当前对象空间”（通常是 mm），由渲染器在现有变换下使用，
 * 因此不需要 engine 预先乘以 DPI。`lineWidth=0` 表示 hairline，由渲染器按 1 设备像素近似。
 */
export interface DrawStyle {
  /** 线宽，当前对象空间单位（通常 mm）；0 表示 hairline。 */
  lineWidth: number;
  /** 端点样式。 */
  lineCap: LineCap;
  /** 连接样式。 */
  lineJoin: LineJoin;
  /** 斜接限制，无量纲。 */
  miterLimit: number;
  /** 虚线起点偏移，当前对象空间单位（通常 mm）。 */
  dashOffset: number;
  /** 虚线段数组，当前对象空间单位（通常 mm）；空数组表示实线。 */
  dashPattern: number[];
}

/** 字形/路径轮廓命令；坐标为调用方空间（字体单位时 y 向上，转换由使用方负责）。 */
export type PathCommand =
  | { type: 'moveTo'; x: number; y: number }
  | { type: 'lineTo'; x: number; y: number }
  | { type: 'quadraticCurveTo'; cpx: number; cpy: number; x: number; y: number }
  | { type: 'bezierCurveTo'; cp1x: number; cp1y: number; cp2x: number; cp2y: number; x: number; y: number }
  | { type: 'closePath' };

/** 渐变颜色段；`position` 为 0..1 的单调位置。 */
export interface GradientStop {
  position: number;
  color: Rgba;
}

/** 渐变映射方式，对应 OFD `MapType`。 */
export type GradientMapType = 'Direct' | 'Repeat' | 'Reflect';

/** 渐变延伸方式，对应 OFD `Extend`：0=两端裁剪，1=终点外延伸，2=起点外延伸，3=不裁剪。 */
export type GradientExtend = 0 | 1 | 2 | 3;

/**
 * 渲染器可消费的轴向渐变描述。
 *
 * 坐标位于对象空间；`segments` 已按位置排序并保证单调不减。
 */
export interface AxialGradientSpec {
  kind: 'axial';
  start: Point;
  end: Point;
  mapType: GradientMapType;
  /** 映射单元长度，对象空间单位；缺省为轴线长度。 */
  mapUnit?: number;
  extend: GradientExtend;
  segments: GradientStop[];
}

/**
 * 渲染器可消费的径向渐变描述（v1 仅用于类型与降级标记，不要求 H5 渲染器实现）。
 *
 * 坐标与半径均位于对象空间；v1 样式层遇到径向渐变会发 `W_RADIAL_UNSUPPORTED`
 * 并改用平均色/透明降级。
 */
export interface RadialGradientSpec {
  kind: 'radial';
  start: Point;
  startRadius: number;
  end: Point;
  endRadius: number;
  mapType: GradientMapType;
  mapUnit?: number;
  extend: GradientExtend;
  segments: GradientStop[];
}

/** 渐变描述联合；v1 渲染器至少支持 `axial`。 */
export type GradientSpec = AxialGradientSpec | RadialGradientSpec;

/** Gouraud/LaGouraud 网格顶点颜色；`edgeFlag` 仅对四边形对角线选择有意义。 */
export interface MeshShadingPoint {
  x: number;
  y: number;
  color: Rgba;
  edgeFlag?: 0 | 1 | 2;
}

/**
 * Gouraud/LaGouraud 网格渐变描述。
 *
 * `verticesPerRow` 是每行“顶点数”（不是格子数），LaGouraud 必填；
 * 坐标位于对象空间，渲染器内部转换到设备空间后做重心插值。
 */
export interface MeshShadingSpec {
  kind: 'gouraud' | 'lagouraud';
  points: MeshShadingPoint[];
  verticesPerRow?: number;
  extend: 0 | 1;
  backColor?: Rgba;
}

/** 底纹排列方式，对应 OFD `ReflectMethod`。 */
export type PatternReflect = 'Normal' | 'Column' | 'Row' | 'RowAndColumn';

/** 底纹平铺参数；tile 内容由独立块生成，此处只描述几何。 */
export interface PatternSpec {
  /**
   * 底纹资源标识（十进制文本）；用于在准备阶段的 BlockStore 中查找预构建的
   * tile DisplayList。样式层不依赖 render/model，因此只传 ID。
   */
  patternId?: string;
  /** tile 宽度，对象空间单位（通常 mm）。 */
  width: number;
  /** tile 高度，对象空间单位（通常 mm）。 */
  height: number;
  /** 水平步进，对象空间单位（通常 mm）；小于 width 时按 width 处理。 */
  xStep: number;
  /** 垂直步进，对象空间单位（通常 mm）；小于 height 时按 height 处理。 */
  yStep: number;
  reflect: PatternReflect;
  relativeTo: 'Object' | 'Page';
  /** 对整个平铺排列生效的矩阵；不作用于单个 tile 内容。 */
  ctm?: Matrix;
  /** 底纹 CellContent 页面块；PaintBinder 用它构建 tile DisplayList。 */
  cell: PageBlock;
  /** tile 内对象继承的起点；由样式层在该底纹作用域结算后填入。 */
  styleRoot: ResolvedStyle;
  /** 由独立块构建的目标无关 tile 绘制命令；样式绑定前可为空。 */
  tile?: DisplayList;
}

/**
 * 样式层输出的、尚未绑定到具体渲染器的 Paint 描述。
 *
 * `pattern.tile` 在 PaintBinder 绑定后填充；渲染器不得再解析 OFD 的 Paint 结构。
 */
export type PaintSpec =
  | { kind: 'color'; rgba: Rgba }
  | { kind: 'gradient'; spec: GradientSpec }
  | { kind: 'pattern'; spec: PatternSpec }
  | { kind: 'shading'; spec: MeshShadingSpec };

/** 底纹绑定结果：tile 必须是目标无关的 DisplayList，engine 不持有 tile surface。 */
export interface PatternPaint {
  kind: 'pattern';
  tile: DisplayList;
  /** tile 宽度，对象空间单位（通常 mm）。 */
  width: number;
  /** tile 高度，对象空间单位（通常 mm）。 */
  height: number;
  /** 水平步进，对象空间单位（通常 mm）。 */
  xStep: number;
  /** 垂直步进，对象空间单位（通常 mm）。 */
  yStep: number;
  reflect: PatternReflect;
  /** 对整个平铺排列生效的矩阵。 */
  ctm: Matrix;
}

/**
 * 渲染器最终消费的 Paint。
 *
 * 由 `render/paint.ts` 的 PaintBinder 从 `PaintSpec` 绑定得到；渲染器只认这个联合，
 * 不需要理解 OFD 的颜色空间、渐变 XML 或底纹资源结构。
 */
export type ResolvedPaint =
  | { kind: 'color'; rgba: Rgba }
  | { kind: 'gradient'; spec: GradientSpec }
  | PatternPaint
  | { kind: 'shading'; spec: MeshShadingSpec };

/** 渲染器内部图像句柄；核心只依赖宽高，不假设底层是 Canvas/ImageBitmap/纹理。 */
export interface ImageHandle {
  /** 图像宽度，像素。 */
  readonly width: number;
  /** 图像高度，像素。 */
  readonly height: number;
}

/** RGBA8 像素数据；`data.length` 必须为 `width * height * 4`。 */
export interface ImageDataLike {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** 宿主平台可直接绘制的图像对象（ImageBitmap/HTMLImageElement/Node canvas Image 等）。 */
export type CanvasImageSourceLike = object;

/**
 * 平台图片解码结果。
 *
 * `kind` 用于区分“RGBA 像素”与“平台可绘制对象”，缺省由使用方探测。
 * 宽度/高度单位为像素。
 */
export interface DecodedImage {
  width: number;
  height: number;
  data: ImageDataLike | CanvasImageSourceLike;
  kind?: 'imagedata' | 'source';
}

/**
 * 页面在指定 DPI 下的像素尺寸。
 *
 * `width`/`height` 单位为设备像素；`dpi` 为输出精度（默认 96），不是阅读器缩放。
 */
export interface Viewport {
  width: number;
  height: number;
  dpi: number;
}