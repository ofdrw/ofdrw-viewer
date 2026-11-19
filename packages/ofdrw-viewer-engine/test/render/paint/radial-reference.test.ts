/**
 * 径向渐变（GB/T 33190—2016 §8.3.4.3 / 表 30）与 `ofd_pdf_match/gradient/` 参考图对照。
 *
 * 本用例把「逐格对照标准效果图」得出的行为固化为断言：几何由起止椭圆圆心与长半轴
 * 同步线性插值决定（表 30），Extend / MapType / 离心率各有明确语义。
 * 采样点坐标取自对象局部空间（原点为对象 Boundary 左上角）。
 */

import { describe, expect, it } from 'vitest';
import type { Rgba, RadialGradientSpec } from '../../../src/common/types';
import { radialGeometry, radialEllipseParameter, rasterizeRadialShadingDevice } from '../../../src/renderer/radial';

/** 表 30 示例配色。 */
const YELLOW: Rgba = { r: 250, g: 210, b: 0, a: 255 };
const BLUE: Rgba = { r: 30, g: 80, b: 220, a: 255 };

/**
 * 构造表 30 的基础渐变（起始圆心 → 结束圆心水平排列）。
 *
 * @param patch 需要覆盖的字段。
 * @returns 径向渐变描述。
 */
function radial(patch: Partial<RadialGradientSpec> = {}): RadialGradientSpec {
  return {
    kind: 'radial',
    start: { x: 15, y: 15 },
    startRadius: 7.5,
    end: { x: 52.5, y: 15 },
    endRadius: 37.5,
    mapType: 'Direct',
    extend: 0,
    segments: [
      { position: 0, color: YELLOW },
      { position: 1, color: BLUE },
    ],
    ...patch,
  };
}

/**
 * 在局部坐标上按 1 mm = 1 px 光栅化并取像素。
 *
 * @param spec 径向渐变描述。
 * @param x 局部横坐标，mm。
 * @param y 局部纵坐标，mm。
 * @param size 输出边长，mm。
 * @returns RGBA。
 */
function sample(spec: RadialGradientSpec, x: number, y: number, size = 62): Rgba {
  const raster = rasterizeRadialShadingDevice({
    spec,
    matrix: [1, 0, 0, 1, 0, 0],
    width: size,
    height: size,
  });
  const index = (Math.floor(y) * raster.width + Math.floor(x)) * 4;
  return {
    r: raster.data[index]!,
    g: raster.data[index + 1]!,
    b: raster.data[index + 2]!,
    a: raster.data[index + 3]!,
  };
}

describe('表 30 径向渐变：几何与 Extend', () => {
  it('椭圆族参数沿圆心连线同步插值，t=0 恰为起始椭圆轮廓', () => {
    const geometry = radialGeometry(radial({ start: { x: 15, y: 37.5 }, end: { x: 52.5, y: 37.5 } }));
    // 起始椭圆轮廓上任意方向：t=0。
    expect(radialEllipseParameter(geometry, 15 + 7.5, 37.5)).toBeCloseTo(0, 5);
    expect(radialEllipseParameter(geometry, 15, 37.5 + 7.5)).toBeCloseTo(0, 5);
    // 沿连线向结束侧推进时参数单调增大，且 r(t)=7.5+30t。
    expect(radialEllipseParameter(geometry, 26, 37.5)!).toBeCloseTo(0.0519, 3);
    expect(radialEllipseParameter(geometry, 41, 37.5)!).toBeCloseTo(0.2741, 3);
    expect(radialEllipseParameter(geometry, 63, 37.5)!).toBeCloseTo(0.6, 3);
  });

  it('Extend=0：起始椭圆以内是空洞，结束椭圆以外不绘制', () => {
    const spec = radial();
    expect(sample(spec, 15, 15).a).toBe(0);
    expect(sample(spec, 40, 30).a).toBe(255);
    expect(sample(spec, 5, 2).a).toBe(0);
  });

  it('Extend=2：扩张型椭圆族整块填充结束色', () => {
    const spec = radial({ extend: 2 });
    expect(sample(spec, 40, 30)).toMatchObject({ r: BLUE.r, g: BLUE.g, b: BLUE.b });
    expect(sample(spec, 5, 2).a).toBe(0);
  });

  it('StartRadius > EndRadius 时椭圆族由大收小，内部仍保留空洞', () => {
    const spec = radial({ startRadius: 37.5, endRadius: 7.5 });
    // 椭圆族由大收小：起始椭圆（半径 37.5、圆心 (15,15)）内的环带可见，
    // 且内圈空心洞按结束椭圆（半径 7.5）界定。
    expect(sample(spec, 30, 15).a).toBe(255);
    expect(sample(spec, 15, 15).a).toBe(255);
  });

  it('偏心率为 0.6 时椭圆在法向压缩为 √(1−e²)=0.8', () => {
    const spec = radial({
      start: { x: 20, y: 20 },
      end: { x: 20, y: 20 },
      startRadius: 1,
      endRadius: 19,
      eccentricity: 0.6,
    });
    // 长轴（+x）方向半径 19 mm，法向（+y）半径 19×0.8=15.2 mm。
    expect(sample(spec, 20 + 18, 20, 40).a).toBe(255);
    expect(sample(spec, 20, 20 + 18, 40).a).toBe(0);
    expect(sample(spec, 20, 20 + 14, 40).a).toBe(255);
  });

  it('MapUnit 以对象空间长度折叠相位，与中心连线长度无关', () => {
    const base = radial({ start: { x: 15, y: 26 }, end: { x: 18.75, y: 33.75 }, startRadius: 3.75, endRadius: 26.25 });
    const direct = sample(base, 19, 43, 60);
    const unit10 = sample({ ...base, mapType: 'Repeat', mapUnit: 10 }, 19, 43, 60);
    const unit5 = sample({ ...base, mapType: 'Repeat', mapUnit: 5 }, 19, 43, 60);
    // 更小的 MapUnit 使相位推进更快，颜色更接近结束色。
    expect(unit5.r).toBeLessThan(unit10.r);
    expect(unit5.b).toBeGreaterThan(unit10.b);
    expect(direct.a).toBe(255);
    expect(unit10.a).toBe(255);
    expect(unit5.a).toBe(255);
  });
});
