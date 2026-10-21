/**
 * Gouraud/LaGouraud 软件光栅化。
 *
 * 三角形内按重心坐标线性插值顶点颜色，输出 RGBA8（straight alpha）。
 * 该模块只依赖 `common/`，可被绘制管线、测试和自定义渲染器复用；
 * H5 渲染器因架构边界（renderer 不能 import render）在 `renderer/mesh.ts`
 * 保留一份等价实现，两处算法必须保持一致。
 */

import type { ImageDataLike, Matrix, MeshShadingSpec, Rgba } from '../common/types';
import { scaleMatrix, transformPoint } from '../common/matrix';

/** 光栅化请求。 */
export interface GouraudRasterRequest {
  spec: MeshShadingSpec;
  /** 对象空间 → 目标像素空间的矩阵。 */
  matrix: Matrix;
  /** 输出宽度，像素。 */
  width: number;
  /** 输出高度，像素。 */
  height: number;
  /** 单图元 bbox 像素上限；超过时降采样并 warning。 */
  maxPixels?: number;
}

/** 设备空间顶点。 */
interface DeviceVertex {
  x: number;
  y: number;
  color: Rgba;
}

/** 默认单图元像素上限：4 MP（对应设计方案 13.5）。 */
const DEFAULT_MAX_PIXELS = 4_000_000;

/**
 * 将网格渐变光栅化为 RGBA8。
 *
 * @param request 网格、矩阵、输出尺寸与像素上限。
 * @returns RGBA8 像素（straight alpha）；超过 `maxPixels` 时返回降采样后的尺寸。
 */
export function rasterizeMeshShading(request: GouraudRasterRequest): ImageDataLike {
  const spec = request.spec;
  const requestedWidth = Math.max(1, Math.floor(request.width));
  const requestedHeight = Math.max(1, Math.floor(request.height));
  const maxPixels = Math.max(1, Math.floor(request.maxPixels ?? DEFAULT_MAX_PIXELS));

  // 超过像素上限时按等比缩放渲染，调用方可再把结果拉伸回 bbox。
  const scale = Math.min(1, Math.sqrt(maxPixels / Math.max(1, requestedWidth * requestedHeight)));
  const width = Math.max(1, Math.floor(requestedWidth * scale));
  const height = Math.max(1, Math.floor(requestedHeight * scale));
  const matrix = scale < 1 ? scaleMatrix(request.matrix, scale, scale) : request.matrix;

  const data = new Uint8ClampedArray(width * height * 4);

  // Extend=1：先用 BackColor 填满整个输出区域，三角形再覆盖在其上。
  if (spec.extend === 1) {
    const back = spec.backColor ?? { r: 0, g: 0, b: 0, a: 255 };
    fillBuffer(data, back);
  }

  const points = spec.points;
  if (!points || points.length < 3) return { width, height, data };

  const vertices: DeviceVertex[] = points.map((point) => {
    const device = transformPoint(matrix, point);
    return { x: device.x, y: device.y, color: point.color };
  });

  const triangles = buildTriangles(spec, vertices);
  for (const triangle of triangles) {
    rasterizeTriangle(data, width, height, triangle[0], triangle[1], triangle[2]);
  }

  return { width, height, data };
}

/**
 * 生成三角形列表。
 *
 * Gouraud：每 4 个点构成一个四边形，按第一个点的 `edgeFlag` 选对角线；不足 4 个的
 * 尾部按三角形处理。LaGouraud：`verticesPerRow` 是每行顶点数，相邻 4 点构成网格
 * 单元，`edgeFlag` 固定为 1；缺行/缺点的尾部单元跳过。
 *
 * @param spec 网格描述。
 * @param vertices 设备空间顶点。
 * @returns 三角形数组，每个三角形 3 个顶点。
 */
function buildTriangles(
  spec: MeshShadingSpec,
  vertices: readonly DeviceVertex[],
): Array<readonly [DeviceVertex, DeviceVertex, DeviceVertex]> {
  const triangles: Array<readonly [DeviceVertex, DeviceVertex, DeviceVertex]> = [];

  if (spec.kind === 'lagouraud') {
    const verticesPerRow = Math.floor(spec.verticesPerRow ?? 0);
    if (verticesPerRow < 2) return triangles;
    const rows = Math.ceil(vertices.length / verticesPerRow);
    for (let row = 0; row < rows - 1; row += 1) {
      for (let column = 0; column < verticesPerRow - 1; column += 1) {
        const topLeft = row * verticesPerRow + column;
        const topRight = topLeft + 1;
        const bottomLeft = (row + 1) * verticesPerRow + column;
        const bottomRight = bottomLeft + 1;
        if (bottomRight >= vertices.length) continue;
        pushQuad(
          triangles,
          vertices[topLeft]!,
          vertices[topRight]!,
          vertices[bottomLeft]!,
          vertices[bottomRight]!,
          1,
        );
      }
    }
    return triangles;
  }

  let index = 0;
  while (index + 3 < vertices.length) {
    const edgeFlag = spec.points[index]?.edgeFlag ?? 0;
    pushQuad(
      triangles,
      vertices[index]!,
      vertices[index + 1]!,
      vertices[index + 2]!,
      vertices[index + 3]!,
      edgeFlag,
    );
    index += 4;
  }
  // 不足 4 个的尾部：剩余至少 3 个点时按独立三角形处理。
  if (vertices.length - index >= 3) {
    triangles.push([vertices[index]!, vertices[index + 1]!, vertices[index + 2]!]);
  }
  return triangles;
}

/**
 * 把一个四边形拆成两个三角形。
 *
 * @param triangles 输出数组。
 * @param a 第 1 个顶点。
 * @param b 第 2 个顶点。
 * @param c 第 3 个顶点。
 * @param d 第 4 个顶点。
 * @param edgeFlag 0=独立三角形（按 a-c 拆），1=沿 b-c 拆，2=沿 a-c 拆。
 */
function pushQuad(
  triangles: Array<readonly [DeviceVertex, DeviceVertex, DeviceVertex]>,
  a: DeviceVertex,
  b: DeviceVertex,
  c: DeviceVertex,
  d: DeviceVertex,
  edgeFlag: number,
): void {
  triangles.push([a, b, c]);
  if (edgeFlag === 1) {
    // 对角线 b-c（菱形）。
    triangles.push([b, d, c]);
  } else {
    // EdgeFlag 0/2：对角线 a-c。
    triangles.push([a, c, d]);
  }
}

/**
 * 光栅化单个三角形，写入 RGBA8 缓冲区。
 *
 * @param data 目标像素缓冲区。
 * @param width 缓冲区宽，像素。
 * @param height 缓冲区高，像素。
 * @param first 三角形第 1 个顶点。
 * @param second 三角形第 2 个顶点。
 * @param third 三角形第 3 个顶点。
 */
function rasterizeTriangle(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  first: DeviceVertex,
  second: DeviceVertex,
  third: DeviceVertex,
): void {
  let a = first;
  let b = second;
  let c = third;
  let area = edge(a, b, c);
  if (!Number.isFinite(area) || Math.abs(area) < 1e-9) return;
  if (area < 0) {
    // 统一为正向，保证重心坐标非负判定一致。
    const swap = b;
    b = c;
    c = swap;
    area = -area;
  }

  const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  if (maxX < minX || maxY < minY) return;

  const inverseArea = 1 / area;
  for (let y = minY; y <= maxY; y += 1) {
    const sampleY = y + 0.5;
    for (let x = minX; x <= maxX; x += 1) {
      const sampleX = x + 0.5;
      const weightA = edge(b, c, { x: sampleX, y: sampleY }) * inverseArea;
      if (weightA < -1e-6) continue;
      const weightB = edge(c, a, { x: sampleX, y: sampleY }) * inverseArea;
      if (weightB < -1e-6) continue;
      const weightC = 1 - weightA - weightB;
      if (weightC < -1e-6) continue;

      const index = (y * width + x) * 4;
      data[index] = mixChannel(a.color.r, b.color.r, c.color.r, weightA, weightB, weightC);
      data[index + 1] = mixChannel(a.color.g, b.color.g, c.color.g, weightA, weightB, weightC);
      data[index + 2] = mixChannel(a.color.b, b.color.b, c.color.b, weightA, weightB, weightC);
      data[index + 3] = mixChannel(a.color.a, b.color.a, c.color.a, weightA, weightB, weightC);
    }
  }
}

/**
 * 计算向量叉积（边函数）。
 *
 * @param p 起点。
 * @param q 终点。
 * @param r 待判定点。
 * @returns 有符号面积的两倍。
 */
function edge(
  p: { x: number; y: number },
  q: { x: number; y: number },
  r: { x: number; y: number },
): number {
  return (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
}

/**
 * 按重心坐标混合通道值。
 *
 * @param channelA 顶点 A 的通道值，0..255。
 * @param channelB 顶点 B 的通道值，0..255。
 * @param channelC 顶点 C 的通道值，0..255。
 * @param weightA 顶点 A 权重。
 * @param weightB 顶点 B 权重。
 * @param weightC 顶点 C 权重。
 * @returns 混合后的通道值，0..255。
 */
function mixChannel(
  channelA: number,
  channelB: number,
  channelC: number,
  weightA: number,
  weightB: number,
  weightC: number,
): number {
  return channelA * weightA + channelB * weightB + channelC * weightC;
}

/**
 * 用单色填满像素缓冲区。
 *
 * @param data 目标像素缓冲区。
 * @param color 填充颜色。
 */
function fillBuffer(data: Uint8ClampedArray, color: Rgba): void {
  for (let index = 0; index < data.length; index += 4) {
    data[index] = color.r;
    data[index + 1] = color.g;
    data[index + 2] = color.b;
    data[index + 3] = color.a;
  }
}