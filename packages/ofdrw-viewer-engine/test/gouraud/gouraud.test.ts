/**
 * Gouraud/LaGouraud 软件光栅化像素级测试。
 *
 * 覆盖三角形重心插值、EdgeFlag 0/1/2、尾部三角形、LaGouraud 网格、
 * Extend/BackColor、像素上限降采样，以及与 renderer 内部等价实现的一致性。
 */

import { describe, expect, it } from 'vitest';
import { rasterizeMeshShading } from '../../src/render/gouraud';
import { rasterizeMeshShadingDevice } from '../../src/renderer/mesh';
import type { ImageDataLike, MeshShadingPoint, MeshShadingSpec, Rgba } from '../../src/common/types';

/** 红。 */
const RED: Rgba = { r: 255, g: 0, b: 0, a: 255 };

/** 绿。 */
const GREEN: Rgba = { r: 0, g: 255, b: 0, a: 255 };

/** 蓝。 */
const BLUE: Rgba = { r: 0, g: 0, b: 255, a: 255 };

/** 白。 */
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };

/** 黄。 */
const YELLOW: Rgba = { r: 255, g: 255, b: 0, a: 255 };

/**
 * 读取输出像素。
 *
 * @param image 光栅化结果。
 * @param x X 坐标，像素。
 * @param y Y 坐标，像素。
 * @returns RGBA 通道。
 */
function pixel(image: ImageDataLike, x: number, y: number): [number, number, number, number] {
  const index = (y * image.width + x) * 4;
  return [
    image.data[index] ?? 0,
    image.data[index + 1] ?? 0,
    image.data[index + 2] ?? 0,
    image.data[index + 3] ?? 0,
  ];
}

/**
 * 构造点。
 *
 * @param x X 坐标。
 * @param y Y 坐标。
 * @param color 颜色。
 * @param edgeFlag 可选方向标志。
 * @returns 控制点。
 */
function point(x: number, y: number, color: Rgba, edgeFlag?: 0 | 1 | 2): MeshShadingPoint {
  return edgeFlag === undefined ? { x, y, color } : { x, y, color, edgeFlag };
}

/**
 * 构造 Gouraud 描述。
 *
 * @param points 控制点。
 * @param extend 延伸方式。
 * @param backColor 背景色。
 * @returns 网格描述。
 */
function gouraud(
  points: MeshShadingPoint[],
  extend: 0 | 1 = 0,
  backColor?: Rgba,
): MeshShadingSpec {
  return { kind: 'gouraud', points, extend, backColor };
}

describe('rasterizeMeshShading：Gouraud', () => {
  it('三角形按面积重心插值颜色', () => {
    const image = rasterizeMeshShading({
      spec: gouraud([point(0, 0, RED), point(16, 0, GREEN), point(0, 16, BLUE)]),
      matrix: [1, 0, 0, 1, 0, 0],
      width: 16,
      height: 16,
    });

    const nearA = pixel(image, 1, 1);
    expect(nearA[3]).toBe(255);
    expect(nearA[0]).toBeGreaterThan(180);
    expect(nearA[1]).toBeLessThan(60);
    expect(nearA[2]).toBeLessThan(60);

    const nearB = pixel(image, 14, 1);
    expect(nearB[1]).toBeGreaterThan(220);

    const nearC = pixel(image, 1, 14);
    expect(nearC[2]).toBeGreaterThan(220);

    // 三角形外（x+y>16）透明。
    expect(pixel(image, 12, 12)[3]).toBe(0);
  });

  it('EdgeFlag=1 沿 Vb-Vc 拆分菱形', () => {
    const image = rasterizeMeshShading({
      spec: gouraud([
        point(5, 0, RED, 1),
        point(0, 5, GREEN),
        point(10, 5, BLUE),
        point(5, 10, WHITE),
      ]),
      matrix: [1, 0, 0, 1, 0, 0],
      width: 12,
      height: 12,
    });

    expect(pixel(image, 5, 2)[3]).toBe(255);
    expect(pixel(image, 5, 8)[3]).toBe(255);
    expect(pixel(image, 1, 1)[3]).toBe(0);
  });

  it('EdgeFlag=2 沿 Va-Vc 拆分四边形；EdgeFlag=1 使用另一条对角线', () => {
    const points = (edgeFlag: 0 | 1 | 2): MeshShadingPoint[] => [
      point(0, 0, RED, edgeFlag),
      point(0, 10, GREEN),
      point(10, 10, BLUE),
      point(10, 0, WHITE),
    ];

    const image2 = rasterizeMeshShading({
      spec: gouraud(points(2)),
      matrix: [1, 0, 0, 1, 0, 0],
      width: 12,
      height: 12,
    });
    expect(pixel(image2, 2, 2)[3]).toBe(255);
    expect(pixel(image2, 2, 8)[3]).toBe(255);

    const image1 = rasterizeMeshShading({
      spec: gouraud(points(1)),
      matrix: [1, 0, 0, 1, 0, 0],
      width: 12,
      height: 12,
    });
    // EdgeFlag=1 的 b-c 边在底部，左上角不在任何三角形内。
    expect(pixel(image1, 2, 1)[3]).toBe(0);
    expect(pixel(image1, 2, 8)[3]).toBe(255);

    // 契约：EdgeFlag=0 与 2 一样按 a-c 拆四边形。
    const image0 = rasterizeMeshShading({
      spec: gouraud(points(0)),
      matrix: [1, 0, 0, 1, 0, 0],
      width: 12,
      height: 12,
    });
    expect(pixel(image0, 2, 1)[3]).toBe(255);
  });

  it('7 个点：1 个四边形 + 尾部独立三角形', () => {
    const image = rasterizeMeshShading({
      spec: gouraud([
        point(0, 0, RED, 2),
        point(10, 0, GREEN),
        point(0, 10, BLUE),
        point(10, 10, WHITE),
        point(20, 0, RED),
        point(30, 0, GREEN),
        point(20, 10, BLUE),
      ]),
      matrix: [1, 0, 0, 1, 0, 0],
      width: 32,
      height: 12,
    });

    expect(pixel(image, 1, 1)[3]).toBe(255);
    expect(pixel(image, 22, 2)[3]).toBe(255);
    expect(pixel(image, 29, 2)[3]).toBe(0);
  });

  it('Extend=0 范围外透明；Extend=1 填 BackColor', () => {
    const base = [point(0, 0, RED), point(5, 0, GREEN), point(0, 5, BLUE)];
    const transparent = rasterizeMeshShading({
      spec: gouraud(base),
      matrix: [1, 0, 0, 1, 0, 0],
      width: 10,
      height: 10,
    });
    expect(pixel(transparent, 8, 8)[3]).toBe(0);

    const extended = rasterizeMeshShading({
      spec: gouraud(base, 1, YELLOW),
      matrix: [1, 0, 0, 1, 0, 0],
      width: 10,
      height: 10,
    });
    expect(pixel(extended, 8, 8)).toEqual([255, 255, 0, 255]);
  });

  it('matrix 把对象空间顶点变到目标像素空间', () => {
    const image = rasterizeMeshShading({
      spec: gouraud([point(0, 0, RED), point(10, 0, GREEN), point(0, 10, BLUE)]),
      matrix: [1, 0, 0, 1, 5, 5],
      width: 20,
      height: 20,
    });
    const atOrigin = pixel(image, 6, 6);
    expect(atOrigin[3]).toBe(255);
    expect(atOrigin[0]).toBeGreaterThan(170);
    expect(pixel(image, 1, 1)[3]).toBe(0);
  });

  it('alpha 也参与重心插值（straight alpha）', () => {
    const image = rasterizeMeshShading({
      spec: gouraud([
        point(0, 0, { r: 255, g: 0, b: 0, a: 0 }),
        point(10, 0, { r: 0, g: 255, b: 0, a: 255 }),
        point(0, 10, { r: 0, g: 0, b: 255, a: 255 }),
      ]),
      matrix: [1, 0, 0, 1, 0, 0],
      width: 10,
      height: 10,
    });
    const middle = pixel(image, 2, 2);
    expect(middle[3]).toBeGreaterThan(100);
    expect(middle[3]).toBeLessThan(255);
  });

  it('少于 3 个点时输出全透明；退化三角形不写入', () => {
    const two = rasterizeMeshShading({
      spec: gouraud([point(0, 0, RED), point(1, 1, GREEN)]),
      matrix: [1, 0, 0, 1, 0, 0],
      width: 4,
      height: 4,
    });
    expect(Array.from(two.data).every((value) => value === 0)).toBe(true);

    const degenerate = rasterizeMeshShading({
      spec: gouraud([point(0, 0, RED), point(1, 0, GREEN), point(2, 0, BLUE)]),
      matrix: [1, 0, 0, 1, 0, 0],
      width: 4,
      height: 4,
    });
    expect(Array.from(degenerate.data).every((value) => value === 0)).toBe(true);
  });

  it('超过 maxPixels 时等比降采样，数据长度与尺寸一致', () => {
    const image = rasterizeMeshShading({
      spec: gouraud([point(0, 0, RED), point(100, 0, GREEN), point(0, 100, BLUE)]),
      matrix: [1, 0, 0, 1, 0, 0],
      width: 100,
      height: 100,
      maxPixels: 100,
    });
    expect(image.width * image.height).toBeLessThanOrEqual(100);
    expect(image.width).toBeGreaterThan(0);
    expect(image.height).toBeGreaterThan(0);
    expect(image.data.length).toBe(image.width * image.height * 4);
  });
});

describe('rasterizeMeshShading：LaGouraud', () => {
  /**
   * 构造 row×column 网格点。
   *
   * @param rows 行数。
   * @param columns 列数。
   * @param step 网格间距，像素。
   * @param colors 逐行颜色。
   * @returns 点列表。
   */
  function grid(rows: number, columns: number, step: number, colors: Rgba[]): MeshShadingPoint[] {
    const points: MeshShadingPoint[] = [];
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        points.push(point(column * step, row * step, colors[row] ?? colors[0]!));
      }
    }
    return points;
  }

  it('VerticesPerRow 按每行顶点数组网格并插值', () => {
    const image = rasterizeMeshShading({
      spec: {
        kind: 'lagouraud',
        points: grid(3, 3, 5, [RED, GREEN, BLUE]),
        verticesPerRow: 3,
        extend: 0,
      },
      matrix: [1, 0, 0, 1, 0, 0],
      width: 12,
      height: 12,
    });

    const top = pixel(image, 2, 1);
    expect(top[3]).toBe(255);
    expect(top[0]).toBeGreaterThan(170);
    expect(top[1]).toBeLessThan(110);

    const bottom = pixel(image, 2, 9);
    expect(bottom[3]).toBe(255);
    expect(bottom[2]).toBeGreaterThan(200);
    expect(pixel(image, 8, 8)[3]).toBe(255);
  });

  it('缺行/缺点时跳过不完整单元', () => {
    const image = rasterizeMeshShading({
      spec: {
        kind: 'lagouraud',
        points: [
          point(0, 0, RED),
          point(5, 0, GREEN),
          point(10, 0, BLUE),
          point(0, 5, RED),
          point(5, 5, GREEN),
          point(10, 5, BLUE),
          point(0, 10, RED),
        ],
        verticesPerRow: 3,
        extend: 0,
      },
      matrix: [1, 0, 0, 1, 0, 0],
      width: 12,
      height: 12,
    });

    expect(pixel(image, 2, 2)[3]).toBe(255);
    expect(pixel(image, 2, 8)[3]).toBe(0);
  });

  it('VerticesPerRow<2 时不产生三角形', () => {
    const image = rasterizeMeshShading({
      spec: {
        kind: 'lagouraud',
        points: grid(2, 2, 5, [RED, GREEN]),
        verticesPerRow: 1,
        extend: 0,
      },
      matrix: [1, 0, 0, 1, 0, 0],
      width: 8,
      height: 8,
    });
    expect(Array.from(image.data).every((value) => value === 0)).toBe(true);
  });
});

describe('renderer 内部实现与 render/gouraud 一致', () => {
  it('同一请求输出逐字节相同', () => {
    const specs: MeshShadingSpec[] = [
      gouraud([point(0, 0, RED), point(10, 0, GREEN), point(0, 10, BLUE)]),
      gouraud([
        point(5, 0, RED, 1),
        point(0, 5, GREEN),
        point(10, 5, BLUE),
        point(5, 10, WHITE),
      ]),
      gouraud(
        [point(0, 0, RED), point(5, 0, GREEN), point(0, 5, BLUE)],
        1,
        YELLOW,
      ),
      {
        kind: 'lagouraud',
        points: [
          point(0, 0, RED),
          point(5, 0, GREEN),
          point(0, 5, BLUE),
          point(5, 5, WHITE),
        ],
        verticesPerRow: 2,
        extend: 0,
      },
    ];

    for (const spec of specs) {
      const request = {
        spec,
        matrix: [1.5, 0, 0, 1.5, 2, 2] as const,
        width: 20,
        height: 20,
      };
      const publicResult = rasterizeMeshShading(request);
      const rendererResult = rasterizeMeshShadingDevice(request);
      expect(rendererResult.width).toBe(publicResult.width);
      expect(rendererResult.height).toBe(publicResult.height);
      expect(Array.from(rendererResult.data)).toEqual(Array.from(publicResult.data));
    }
  });
});