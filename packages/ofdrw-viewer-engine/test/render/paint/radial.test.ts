/**
 * 径向渐变（GB/T 33190—2016 §8.3.4.3 / 表 30）单元测试。
 *
 * 覆盖解析几何、区间折叠、逐像素采样（`renderer/radial.ts`），以及通过渲染器
 * 端到端绘制时的 Extend / MapType / 离心率 / Angle / CTM 行为。
 */

import { describe, expect, it } from 'vitest';
import type { Matrix, RadialGradientSpec, Rgba } from '../../../src/common/types';
import {
  radialAxisProjection,
  radialAxisRadius,
  radialFoldParameter,
  radialGeometry,
  rasterizeRadialShadingDevice,
} from '../../../src/renderer/radial';
import { createTestCanvas, createTestRenderer } from '../../api/helpers';

/** 端到端绘制用的默认线型（径向渐变只用于填充时不影响结果）。 */
const STYLE = {
  lineWidth: 1,
  lineCap: 'Butt' as const,
  lineJoin: 'Miter' as const,
  miterLimit: 4,
  dashOffset: 0,
  dashPattern: [],
};

/** 不透明颜色。 */
const RED: Rgba = { r: 255, g: 0, b: 0, a: 255 };
const BLUE: Rgba = { r: 0, g: 0, b: 255, a: 255 };

/**
 * 构造径向渐变描述。
 *
 * @param patch 需要覆盖的字段；缺省为「圆心 (0,0) → (10,0)，半径 0 → 10，Direct，Extend=0」。
 * @returns 径向渐变描述；坐标与半径单位为 mm，角度单位为度。
 */
function radial(patch: Partial<RadialGradientSpec> = {}): RadialGradientSpec {
  return {
    kind: 'radial',
    start: { x: 0, y: 0 },
    startRadius: 0,
    end: { x: 10, y: 0 },
    endRadius: 10,
    mapType: 'Direct',
    extend: 0,
    segments: [
      { position: 0, color: RED },
      { position: 1, color: BLUE },
    ],
    ...patch,
  };
}

/**
 * 用恒等矩阵（1 mm = 1 px）光栅化，并读取某像素中心颜色。
 *
 * @param spec 径向渐变描述。
 * @param size 输出边长，像素（同时是 mm 范围 0..size）。
 * @param x 读取像素 x，像素。
 * @param y 读取像素 y，像素。
 * @returns RGBA；alpha 为 0 表示该处不绘制。
 */
function sampleAt(spec: RadialGradientSpec, size: number, x: number, y: number): Rgba {
  const raster = rasterizeRadialShadingDevice({
    spec,
    matrix: [1, 0, 0, 1, 0, 0],
    width: size,
    height: size,
  });
  const index = (y * raster.width + x) * 4;
  return {
    r: raster.data[index]!,
    g: raster.data[index + 1]!,
    b: raster.data[index + 2]!,
    a: raster.data[index + 3]!,
  };
}

/**
 * 断言颜色近似相等。
 *
 * @param actual 实际颜色。
 * @param expected 期望颜色。
 * @param tolerance 每通道容差，0..255。
 */
function expectColor(actual: Rgba, expected: Rgba, tolerance = 3): void {
  expect(Math.abs(actual.r - expected.r)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.g - expected.g)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.b - expected.b)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.a - expected.a)).toBeLessThanOrEqual(tolerance);
}

describe('radialGeometry：解析几何', () => {
  it('长轴沿中心连线，短半轴按离心率收缩', () => {
    const geometry = radialGeometry(radial({ end: { x: 0, y: 10 }, eccentricity: 0.6 }));
    expect(geometry.centerDistance).toBeCloseTo(10, 10);
    expect([geometry.ux, geometry.uy]).toEqual([0, 1]);
    expect([geometry.vx, geometry.vy]).toEqual([-1, 0]);
    expect(geometry.axisRatio).toBeCloseTo(0.8, 10);
  });

  it('离心率 0 时退化为圆（长短半轴相等）', () => {
    expect(radialGeometry(radial()).axisRatio).toBeCloseTo(1, 10);
  });

  it('两中心重合时长轴方向由 Angle 决定', () => {
    const geometry = radialGeometry(
      radial({ start: { x: 5, y: 5 }, end: { x: 5, y: 5 }, angle: 90 }),
    );
    expect(geometry.centerDistance).toBe(0);
    expect(geometry.ux).toBeCloseTo(0, 10);
    expect(geometry.uy).toBeCloseTo(1, 10);
  });

  it('Angle=-30 时法向按顺时针 90° 旋转', () => {
    const geometry = radialGeometry(
      radial({ start: { x: 5, y: 5 }, end: { x: 5, y: 5 }, angle: -30 }),
    );
    expect(geometry.ux).toBeCloseTo(Math.cos(Math.PI / 6), 10);
    expect(geometry.uy).toBeCloseTo(-0.5, 10);
    expect(geometry.vx).toBeCloseTo(0.5, 10);
  });

  it('离心率越界时 clamp 到 [0, 0.999999]', () => {
    expect(radialGeometry(radial({ eccentricity: 1 })).axisRatio).toBeGreaterThan(0);
    expect(radialGeometry(radial({ eccentricity: -1 })).axisRatio).toBeCloseTo(1, 10);
  });
});

describe('radialFoldParameter：MapType / MapUnit', () => {
  const geometry = radialGeometry(radial());
  const unit = 10;

  it('Direct 不折叠，投影可直接越出 [0,1]', () => {
    expect(radialFoldParameter(geometry, 'Direct', undefined, 20)).toBeCloseTo(2, 10);
    expect(radialFoldParameter(geometry, 'Direct', undefined, -5)).toBeCloseTo(-0.5, 10);
  });

  it('Repeat 按 MapUnit 取模', () => {
    expect(radialFoldParameter(geometry, 'Repeat', unit, 25)).toBeCloseTo(0.5, 10);
    expect(radialFoldParameter(geometry, 'Repeat', unit, -2.5)).toBeCloseTo(0.75, 10);
  });

  it('Reflect 为三角波，每两个区间往返', () => {
    expect(radialFoldParameter(geometry, 'Reflect', unit, 15)).toBeCloseTo(0.5, 10);
    expect(radialFoldParameter(geometry, 'Reflect', unit, -2.5)).toBeCloseTo(0.25, 10);
  });

  it('MapUnit 缺省时一个区间等于中心连线长度', () => {
    expect(radialFoldParameter(geometry, 'Repeat', undefined, 15)).toBeCloseTo(0.5, 10);
  });
});

describe('radialAxisRadius：椭圆族半径', () => {
  it('EndRadius > StartRadius 时随参数扩张，反向时收缩', () => {
    const forward = radialGeometry(radial());
    expect(radialAxisRadius(forward, 0)).toBeCloseTo(0, 10);
    expect(radialAxisRadius(forward, 0.5)).toBeCloseTo(5, 10);
    expect(radialAxisRadius(forward, 1)).toBeCloseTo(10, 10);

    const backward = radialGeometry(radial({ startRadius: 10, endRadius: 2 }));
    expect(radialAxisRadius(backward, 0)).toBeCloseTo(10, 10);
    expect(radialAxisRadius(backward, 0.5)).toBeCloseTo(6, 10);
    expect(radialAxisRadius(backward, 1)).toBeCloseTo(2, 10);
  });

  it('投影沿中心连线方向计量', () => {
    const geometry = radialGeometry(radial({ end: { x: 0, y: 10 } }));
    expect(radialAxisProjection(geometry, 0, 4)).toBeCloseTo(4, 10);
    expect(radialAxisProjection(geometry, 7, 4)).toBeCloseTo(4, 10);
  });
});

describe('rasterizeRadialShadingDevice：颜色与 Extend', () => {
  // 输出范围 0..60 px，且 1 mm = 1 px，取样点全部落在画布内。
  const size = 60;

  it('区间内颜色按椭圆族半径插值', () => {
    // 同心椭圆（圆心 (8,10)，半径 4 → 14，离心率 0）：起始椭圆内部是空心洞（§8.3.4.3
    // 「先由起始点椭圆中心点开始绘制一个起始点颜色的空心椭圆」），洞外为红蓝过渡。
    const concentric = radial({ start: { x: 8, y: 10 }, startRadius: 4, end: { x: 8, y: 10 }, endRadius: 14 });
    expect(sampleAt(concentric, size, 8, 10).a).toBe(0);
    // 洞外（距圆心 5~14）落在椭圆族内，颜色由内向外渐变。
    const ring = sampleAt(concentric, size, 8, 14);
    expect(ring.a).toBe(255);
    expect(ring.r).toBeGreaterThan(ring.b);
    // 结束椭圆外侧（距圆心 20 > 14）在 Extend=0 下不绘制。
    expect(sampleAt(concentric, size, 8, 26).a).toBe(0);

    // 非同心：结束椭圆内部各点参数不同，应为红蓝过渡色。
    const shifting = radial({ start: { x: 0, y: 0 }, startRadius: 0, end: { x: 10, y: 0 }, endRadius: 10 });
    // 颜色取「覆盖该点的最小圈」参数：离起点越远，该圈参数越大，红分量递减、蓝分量递增。
    const nearStart = sampleAt(shifting, size, 3, 0);
    const nearEnd = sampleAt(shifting, size, 9, 0);
    expect(nearStart.r).toBeGreaterThan(nearEnd.r);
    expect(nearEnd.b).toBeGreaterThan(nearStart.b);
    expect(nearEnd.r).toBeGreaterThan(0);
    // 竖直方向超出当前参数对应椭圆（半径 5、法向 5）时不绘制。
    expect(sampleAt(shifting, size, 5, 20).a).toBe(0);
  });

  it('Extend=0 只在椭圆族内绘制（两端椭圆以外的区域留空）', () => {
    // 中心连线 0→20、半径 8→16：族内区域是两端椭圆的并集。
    const band = radial({ end: { x: 20, y: 0 }, startRadius: 8, endRadius: 16, extend: 0 });
    expect(sampleAt(band, size, 20, 15).a).toBe(255);
    // 起始椭圆（圆心 (0,0)、半径 8）外侧的竖直方向留空。
    expect(sampleAt(band, size, 0, 15).a).toBe(0);
    // 结束椭圆（圆心 (20,0)、半径 16）右侧留空。
    expect(sampleAt(band, size, 45, 10).a).toBe(0);
  });

  it('Extend=1 向起始侧延伸：起始椭圆以内不再是空洞', () => {
    const spec = radial({ end: { x: 20, y: 0 }, startRadius: 8, endRadius: 16, extend: 1 });
    // Extend=1 时起始侧方向三角被补绘：起始椭圆圆心处（原「空心椭圆」内部）有了颜色。
    expect(sampleAt(spec, size, 0, 0).a).toBe(255);
    expect(sampleAt(spec, size, 2, 0).a).toBe(255);
    // 结束侧不延伸：结束椭圆右侧仍留空。
    expect(sampleAt(spec, size, 45, 0).a).toBe(0);
  });

  it('Extend=2 向结束侧延伸并取结束色', () => {
    const spec = radial({ end: { x: 20, y: 0 }, startRadius: 8, endRadius: 16, extend: 2 });
    // 结束椭圆右侧按结束色延伸。
    expectColor(sampleAt(spec, size, 45, 0), BLUE);
    // 起始椭圆之外的竖直方向同属填充区，取结束色。
    expectColor(sampleAt(spec, size, 10, 40), BLUE);
    // 起始椭圆内部的空心洞始终不绘制。
    expect(sampleAt(spec, size, 0, 40).a).toBe(0);
  });

  it('Extend=3 两侧都延伸，且空心洞也按起始色填充', () => {
    const spec = radial({ start: { x: 10, y: 10 }, startRadius: 4, end: { x: 20, y: 10 }, endRadius: 14, extend: 3 });
    // 起始椭圆内部的洞（距圆心 2 < 4）取起始色。
    expectColor(sampleAt(spec, size, 8, 10), RED);
    // 结束椭圆外侧取结束色。
    expectColor(sampleAt(spec, size, 36, 10), BLUE);
  });

  it('StartRadius>EndRadius 时按参数由起始半径收缩到结束半径', () => {
    // 同心椭圆（圆心 (30,20)），起始半径 12、结束半径 4：由大收小，内圈洞是结束椭圆（半径 4）。
    const shrink = radial({ start: { x: 30, y: 20 }, startRadius: 12, end: { x: 30, y: 20 }, endRadius: 4, extend: 0 });
    expect(sampleAt(shrink, size, 30, 31).a).toBe(255);
    // 外边界是起始椭圆（半径 12）。
    expect(sampleAt(shrink, size, 30, 33).a).toBe(0);
    // 内圈洞（距圆心 2 < 4）留空。
    expect(sampleAt(shrink, size, 30, 22).a).toBe(0);
    // 环带内取中间色。
    expect(sampleAt(shrink, size, 30, 30).a).toBe(255);

    // 非同心：起始椭圆半径 12、结束椭圆半径 4，环带仍在。
    const reverse = radial({ start: { x: 5, y: 20 }, startRadius: 12, end: { x: 25, y: 20 }, endRadius: 4, extend: 0 });
    expect(sampleAt(reverse, size, 5, 30).a).toBe(255);
  });

  it('Repeat 与 Reflect 按 MapUnit 折叠渐变相位', () => {
    // 中心连线 0→10（长度 10）、MapUnit=10 时一个区间恰为中心连线长度，
    // 因此 Repeat 与 Direct 的相位一致；MapUnit 取 5 时相位压缩为一半。
    const direct = radial({ startRadius: 3, endRadius: 9, extend: 0 });
    const repeatUnit10 = radial({ startRadius: 3, endRadius: 9, mapType: 'Repeat', mapUnit: 10 });
    const repeatUnit5 = radial({ startRadius: 3, endRadius: 9, mapType: 'Repeat', mapUnit: 5 });

    // 4 mm 处（椭圆族内）：MapUnit=10 与 Direct 相位一致，MapUnit 越小相位推进越快。
    const atDirect = sampleAt(direct, size, 4, 0);
    const atRepeat10 = sampleAt(repeatUnit10, size, 4, 0);
    const atRepeat5 = sampleAt(repeatUnit5, size, 4, 0);
    expectColor(atRepeat10, atDirect, 2);
    // 相位更大即更接近结束色：红分量更低、蓝分量更高。
    expect(atRepeat5.r).toBeLessThan(atRepeat10.r);
    expect(atRepeat5.b).toBeGreaterThan(atRepeat10.b);

    // 可见范围只由椭圆族几何决定，与 MapType 无关。
    for (const spec of [direct, repeatUnit10, repeatUnit5]) {
      expect(sampleAt(spec, size, 20, 0).a).toBe(0);
    }
    // Reflect 与 Repeat 在第一个区间内相位相同。
    const reflect = radial({ startRadius: 3, endRadius: 9, mapType: 'Reflect', mapUnit: 5, extend: 0 });
    expectColor(sampleAt(reflect, size, 4, 0), atRepeat5, 2);
  });

  it('离心率 0.6 与 0.8 让椭圆在法向更扁', () => {
    // 结束椭圆中心 (20,30)、长半轴 14、离心率 0.6 → 法向半轴 14 × 0.8 = 11.2。
    const spec = radial({ start: { x: 10, y: 30 }, startRadius: 4, end: { x: 20, y: 30 }, endRadius: 14, eccentricity: 0.6, extend: 0 });
    expect(sampleAt(spec, size, 20, 40).a).toBe(255);
    expect(sampleAt(spec, size, 20, 43).a).toBe(0);

    // 离心率 0.8 → 法向半轴 14 × 0.6 = 8.4。
    const flatter = radial({ start: { x: 10, y: 30 }, startRadius: 4, end: { x: 20, y: 30 }, endRadius: 14, eccentricity: 0.8, extend: 0 });
    expect(sampleAt(flatter, size, 20, 36).a).toBe(255);
    expect(sampleAt(flatter, size, 20, 41).a).toBe(0);
    // 长轴方向不受离心率影响：结束椭圆中心右侧 13 mm 仍可见，15 mm 起不可见。
    expect(sampleAt(flatter, size, 33, 30).a).toBe(255);
    expect(sampleAt(flatter, size, 35, 30).a).toBe(0);
  });

  it('Angle 只在两中心重合时决定长轴方向', () => {
    // 圆心固定 (30,30)、结束半径 14、Angle=-30°：长轴沿 (cos30°, −sin30°)。
    const rotated = radial({
      start: { x: 30, y: 30 },
      startRadius: 0,
      end: { x: 30, y: 30 },
      endRadius: 14,
      angle: -30,
      extend: 0,
    });
    // 沿长轴 13 mm 处（椭圆内）：可见。
    expect(sampleAt(rotated, size, 41, 23).a).toBe(255);
    // 正右方 12 mm：沿长轴投影 10.4、法向 6，仍在半径范围内可见。
    expect(sampleAt(rotated, size, 42, 30).a).toBe(255);
    // 正上方 12 mm：法向分量 12·cos30° = 10.4，沿长轴投影 6，仍在椭圆内。
    expect(sampleAt(rotated, size, 30, 18).a).toBe(255);
    // 未设置 Angle（默认 0°）时椭圆是圆（离心率 0），任意方向 13 mm 同样可见。
    const aligned = radial({ start: { x: 30, y: 30 }, startRadius: 0, end: { x: 30, y: 30 }, endRadius: 14, extend: 0 });
    expect(sampleAt(aligned, size, 43, 30).a).toBe(255);
    // 带离心率时 Angle 决定长短轴方向：e=0.6、Angle=90° 时长轴沿 y 轴（法向半轴 12.8），
    // 因此正上方 12 mm 可见；起点在圆心处，其它方向只要在半径内同样可见。
    const flatRotated = radial({ start: { x: 30, y: 30 }, startRadius: 0, end: { x: 30, y: 30 }, endRadius: 16, eccentricity: 0.6, angle: 90, extend: 0 });
    expect(sampleAt(flatRotated, size, 30, 18).a).toBe(255);
    expect(sampleAt(flatRotated, size, 30, 43).a).toBe(255);
  });

  it('矩阵带缩放/平移时，采样点位置正确', () => {
    // 同心椭圆：圆心 (10,10)、半径 5 → 15（像素），颜色只随半径变化。
    const spec = radial({ start: { x: 10, y: 10 }, startRadius: 5, end: { x: 10, y: 10 }, endRadius: 15 });
    // 2 倍缩放 + 平移 (10, 10)：对象空间 (10,10) 落在像素 (30,30)。
    const raster = rasterizeRadialShadingDevice({
      spec,
      matrix: [2, 0, 0, 2, 10, 10],
      width: 60,
      height: 60,
    });
    const pixel = (x: number, y: number): Rgba => {
      const index = (y * raster.width + x) * 4;
      return {
        r: raster.data[index]!,
        g: raster.data[index + 1]!,
        b: raster.data[index + 2]!,
        a: raster.data[index + 3]!,
      };
    };
    // 圆心处是空心洞（起始椭圆半径 5 内部），不绘制。
    expect(pixel(30, 30).a).toBe(0);
    // 环带内颜色随半径由起始色走向结束色：圆心 (30,30) 右侧沿 +x 采样，
    // 跳过洞内（半径 < 5）后，r 分量应随半径单调不增（越来越接近结束色）。
    const ring: Rgba[] = [];
    for (let x = 36; x <= 48; x += 1) {
      const color = pixel(x, 30);
      if (color.a === 255) ring.push(color);
    }
    expect(ring.length).toBeGreaterThan(5);
    for (let index = 1; index < ring.length; index += 1) {
      expect(ring[index]!.r).toBeLessThanOrEqual(ring[index - 1]!.r + 2);
    }
  });

  it('超过像素上限时降采样返回更小缓冲', () => {
    const raster = rasterizeRadialShadingDevice({
      spec: radial(),
      matrix: [1, 0, 0, 1, 0, 0],
      width: 3000,
      height: 3000,
      maxPixels: 1_000_000,
    });
    expect(raster.width * raster.height).toBeLessThanOrEqual(1_000_000);
  });
});

describe('H5Canvas2DRenderer：径向渐变填充', () => {
  it('填充时按椭圆几何绘制，且不使用平均色降级', () => {
    const renderer = createTestRenderer();
    const target = createTestCanvas(60, 60);
    // 1 mm = 1 px 的视口，对象空间坐标直接等于像素坐标。
    renderer.beginPage(target.context, { width: 60, height: 60, dpi: 96 });
    renderer.setTransform([1, 0, 0, 1, 0, 0]);

    // 起始椭圆圆心 (20,20)、半径 5；结束椭圆圆心 (20,20) 平移无关，半径 15。
    const paint = {
      kind: 'gradient' as const,
      spec: radial({ start: { x: 20, y: 20 }, startRadius: 5, end: { x: 20, y: 20 }, endRadius: 15, extend: 0 }),
    };
    renderer.beginPath();
    renderer.rect(0, 0, 60, 60);
    renderer.fill(STYLE, paint, 'nonzero');
    renderer.endPage();

    // 起点像素为起始色（红），远离圆心的环带逐渐过渡到结束色（蓝）。
    expect(target.pixel(20, 20)[0]).toBeGreaterThan(200);
    const near = target.pixel(29, 20);
    const far = target.pixel(34, 20);
    expect(far[2]).toBeGreaterThan(near[2]);
    expect(near[0]).toBeGreaterThan(far[0]);
  });

  it('CTM 缩放后径向渐变位置跟随对象', () => {
    const renderer = createTestRenderer();
    const target = createTestCanvas(80, 80);
    renderer.beginPage(target.context, { width: 80, height: 80, dpi: 96 });
    renderer.setTransform([1, 0, 0, 1, 0, 0]);
    const matrix: Matrix = [2, 0, 0, 2, 10, 10];
    renderer.save();
    renderer.transform(matrix);
    // 对象空间同心椭圆：圆心 (10,10)、半径 5 → 15；经 2 倍缩放后圆心落在像素 (30,30)。
    const paint = {
      kind: 'gradient' as const,
      spec: radial({ start: { x: 10, y: 10 }, startRadius: 5, end: { x: 10, y: 10 }, endRadius: 15, extend: 0 }),
    };
    renderer.beginPath();
    renderer.rect(0, 0, 40, 40);
    renderer.fill(STYLE, paint, 'nonzero');
    renderer.restore();
    renderer.endPage();

    // 绘制区域覆盖像素 (10,10)-(90,90) 与画布的交集；CTM 把对象坐标放大 2 倍并平移 (10,10)。
    // 结束椭圆（半径 15 mm → 30 px）内部颜色随半径由起始色过渡到结束色。
    expect(target.pixel(25, 40)[0]).toBeGreaterThan(target.pixel(50, 40)[0]);
    // 结束椭圆内部（像素半径 30）仍有渐变覆盖：起点附近偏红，远处偏蓝。
    const near = target.pixel(40, 30);
    const far = target.pixel(55, 30);
    expect(near[0]).toBeGreaterThan(far[0]);
    expect(far[2]).toBeGreaterThan(near[2]);
  });
});