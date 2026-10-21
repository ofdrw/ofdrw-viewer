/**
 * H5 渲染器内部的 Gouraud/LaGouraud 软件光栅化。
 *
 * 架构约束：`renderer/` 不能 import `render/`（见 test/smoke/import-boundaries），
 * 因此这里保留一份与 `render/gouraud.ts` 等价的实现；两处算法、边界处理与
 * 像素语义必须同步修改。渲染器只在内部离屏 canvas 使用，engine 看不到 surface。
 */

import type { ImageDataLike, Matrix, MeshShadingSpec, Rgba } from '../common/types';
import { scaleMatrix, transformPoint } from '../common/matrix';

/** 渲染器内部光栅化请求。 */
export interface MeshRasterRequest {
  spec: MeshShadingSpec;
  /** 对象空间 → 目标像素空间的矩阵。 */
  matrix: Matrix;
  /** 输出宽度，像素。 */
  width: number;
  /** 输出高度，像素。 */
  height: number;
  /** 单图元 bbox 像素上限；超过时降采样。 */
  maxPixels?: number;
}

/** 设备空间顶点。 */
interface DeviceVertex {
  x: number;
  y: number;
  color: Rgba;
}

/** 默认单图元像素上限：4 MP。 */
const DEFAULT_MAX_PIXELS = 4_000_000;

/**
 * 将网格渐变光栅化为 RGBA8。
 *
 * @param request 网格、矩阵、输出尺寸与像素上限。
 * @returns RGBA8 像素（straight alpha）；超过 `maxPixels` 时返回降采样后的尺寸。
 */
export function rasterizeMeshShadingDevice(request: MeshRasterRequest): ImageDataLike {
  const spec = request.spec;
  const requestedWidth = Math.max(1, Math.floor(request.width));
  const requestedHeight = Math.max(1, Math.floor(request.height));
  const maxPixels = Math.max(1, Math.floor(request.maxPixels ?? DEFAULT_MAX_PIXELS));

  const scale = Math.min(1, Math.sqrt(maxPixels / Math.max(1, requestedWidth * requestedHeight)));
  const width = Math.max(1, Math.floor(requestedWidth * scale));
  const height = Math.max(1, Math.floor(requestedHeight * scale));
  const matrix = scale < 1 ? scaleMatrix(request.matrix, scale, scale) : request.matrix;

  const data = new Uint8ClampedArray(width * height * 4);

  // Extend=1：先用 BackColor 填满输出区域，三角形覆盖其上。
  if (spec.extend === 1) {
    fillBuffer(data, spec.backColor ?? { r: 0, g: 0, b: 0, a: 255 });
  }

  const points = spec.points;
  if (!points || points.length < 3) return { width, height, data };

  const vertices: DeviceVertex[] = points.map((point) => {
    const device = transformPoint(matrix, point);
    return { x: device.x, y: device.y, color: point.color };
  });

  for (const triangle of buildTriangles(spec, vertices)) {
    rasterizeTriangle(data, width, height, triangle[0], triangle[1], triangle[2]);
  }

  return { width, height, data };
}

/**
 * 生成三角形列表；规则与 `render/gouraud.ts` 一致。
 *
 * @param spec 网格描述。
 * @param vertices 设备空间顶点。
 * @returns 三角形数组。
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
        const bottomLeft = (row + 1) * verticesPerRow + column;
        const bottomRight = bottomLeft + 1;
        if (bottomRight >= vertices.length) continue;
        pushQuad(
          triangles,
          vertices[topLeft]!,
          vertices[topLeft + 1]!,
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
    pushQuad(
      triangles,
      vertices[index]!,
      vertices[index + 1]!,
      vertices[index + 2]!,
      vertices[index + 3]!,
      spec.points[index]?.edgeFlag ?? 0,
    );
    index += 4;
  }
  if (vertices.length - index >= 3) {
    triangles.push([vertices[index]!, vertices[index + 1]!, vertices[index + 2]!]);
  }
  return triangles;
}

/**
 * 把四边形拆成两个三角形。
 *
 * @param triangles 输出数组。
 * @param a 第 1 个顶点。
 * @param b 第 2 个顶点。
 * @param c 第 3 个顶点。
 * @param d 第 4 个顶点。
 * @param edgeFlag 0/2=沿 a-c 拆，1=沿 b-c 拆。
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
  if (edgeFlag === 1) triangles.push([b, d, c]);
  else triangles.push([a, c, d]);
}

/**
 * 光栅化单个三角形。
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
      data[index] = mix(a.color.r, b.color.r, c.color.r, weightA, weightB, weightC);
      data[index + 1] = mix(a.color.g, b.color.g, c.color.g, weightA, weightB, weightC);
      data[index + 2] = mix(a.color.b, b.color.b, c.color.b, weightA, weightB, weightC);
      data[index + 3] = mix(a.color.a, b.color.a, c.color.a, weightA, weightB, weightC);
    }
  }
}

/**
 * 计算边函数（叉积）。
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
 * @param channelA 顶点 A 通道值，0..255。
 * @param channelB 顶点 B 通道值，0..255。
 * @param channelC 顶点 C 通道值，0..255。
 * @param weightA 顶点 A 权重。
 * @param weightB 顶点 B 权重。
 * @param weightC 顶点 C 权重。
 * @returns 混合后的通道值，0..255。
 */
function mix(
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