/**
 * T6a 图片单测：单位矩形 + CTM、无 CTM 兼容、边框、蒙版、替换图。
 */

import { describe, expect, it } from 'vitest';
import type { ImageBorder, ImageObject } from '../../../src/model/types';
import {
  computeImageTransform,
  drawImageObject,
  type ImageDrawContext,
} from '../../../src/render/image';
import { IDENTITY_MATRIX } from '../../../src/common/matrix';
import { BASE_STYLE, FakeRenderer, imageHandle, warningCollector } from '../path/fake-renderer';

function imageObject(overrides: Partial<ImageObject> = {}): ImageObject {
  return {
    kind: 'image',
    boundary: { x: 10, y: 20, w: 100, h: 50 },
    alpha: 255,
    visible: true,
    resourceId: '1',
    ...overrides,
  };
}

function border(overrides: Partial<ImageBorder> = {}): ImageBorder {
  return {
    lineWidth: 0.5,
    horizontalRadius: 5,
    verticalRadius: 5,
    dashOffset: 2,
    dashPattern: [3, 1],
    color: { r: 255, g: 0, b: 0, a: 128 },
    ...overrides,
  };
}

describe('computeImageTransform', () => {
  it('有 CTM 时直接返回 CTM', () => {
    const ctm = [2, 0, 0, 2, 3, 4] as const;
    expect(computeImageTransform(imageObject({ ctm }), true)).toEqual(ctm);
  });

  it('无 CTM 且严格模式返回 identity（1×1）', () => {
    expect(computeImageTransform(imageObject(), true)).toEqual(IDENTITY_MATRIX);
  });

  it('无 CTM 且 strictImageCtm=false 时铺满 Boundary', () => {
    expect(computeImageTransform(imageObject(), false)).toEqual([100, 0, 0, 50, 0, 0]);
  });
});

describe('drawImageObject', () => {
  it('有 CTM 时按单位矩形 + 当前 CTM 绘制，不重复应用 CTM', () => {
    const renderer = new FakeRenderer();
    const context: ImageDrawContext = { renderer, image: imageHandle() };
    drawImageObject(
      context,
      imageObject({ ctm: [0, 1, -1, 0, 0, 0] }),
      BASE_STYLE,
    );
    const draw = renderer.callsOf('drawImage')[0]!;
    expect(draw.args[1]).toEqual(IDENTITY_MATRIX);
    expect(draw.args[2]).toBe(1);
    expect(draw.args[3]).toBe(true);
    expect(renderer.ops()).toEqual(['save', 'drawImage', 'restore']);
  });

  it('无 CTM 默认 identity 1×1 并 warning', () => {
    const renderer = new FakeRenderer();
    const warnings = warningCollector();
    drawImageObject(
      { renderer, image: imageHandle(), onWarning: warnings.warnings },
      imageObject(),
      BASE_STYLE,
    );
    expect(renderer.callsOf('transform')).toHaveLength(0);
    expect(renderer.callsOf('drawImage')[0]!.args[1]).toEqual(IDENTITY_MATRIX);
    expect(warnings.codes).toContain('W_IMAGE_NO_CTM');
  });

  it('strictImageCtm=false 时按 Boundary 尺寸缩放', () => {
    const renderer = new FakeRenderer();
    drawImageObject(
      { renderer, image: imageHandle(), strictImageCtm: false },
      imageObject(),
      BASE_STYLE,
    );
    expect(renderer.callsOf('transform')[0]!.args).toEqual([[100, 0, 0, 50, 0, 0]]);
    expect(renderer.callsOf('drawImage')[0]!.args[1]).toEqual(IDENTITY_MATRIX);
  });

  it('边框在对象空间绘制：逆 CTM、圆角、虚线与颜色 alpha', () => {
    const renderer = new FakeRenderer();
    drawImageObject(
      { renderer, image: imageHandle() },
      imageObject({ ctm: [0, 1, -1, 0, 0, 0], border: border() }),
      BASE_STYLE,
    );
    const transform = renderer.callsOf('transform')[0]!;
    expect((transform.args[0] as number[]).map((value) => (value === 0 ? 0 : value))).toEqual([
      0,
      -1,
      1,
      0,
      0,
      0,
    ]);
    expect(renderer.callsOf('quadraticCurveTo')).toHaveLength(4);
    const stroke = renderer.callsOf('stroke')[0]!;
    const style = stroke.args[0] as { lineWidth: number; dashPattern: number[]; dashOffset: number };
    expect(style.lineWidth).toBe(0.5);
    expect(style.dashPattern).toEqual([3, 1]);
    expect(style.dashOffset).toBe(2);
    expect((stroke.args[1] as { rgba: { a: number } }).rgba.a).toBe(128);
  });

  it('边框 LineWidth=0 时不描边', () => {
    const renderer = new FakeRenderer();
    drawImageObject(
      { renderer, image: imageHandle() },
      imageObject({ border: border({ lineWidth: 0 }) }),
      BASE_STYLE,
    );
    expect(renderer.callsOf('stroke')).toHaveLength(0);
  });

  it('无圆角时不产生 quadraticCurveTo', () => {
    const renderer = new FakeRenderer();
    drawImageObject(
      { renderer, image: imageHandle() },
      imageObject({ border: border({ horizontalRadius: 0, verticalRadius: 0 }) }),
      BASE_STYLE,
    );
    expect(renderer.callsOf('quadraticCurveTo')).toHaveLength(0);
    expect(renderer.callsOf('stroke')).toHaveLength(1);
  });

  it('ImageMask 提供蒙版句柄时传给 drawImage', () => {
    const renderer = new FakeRenderer();
    const mask = imageHandle(20, 20);
    drawImageObject(
      { renderer, image: imageHandle(), mask },
      imageObject({ imageMask: '9' }),
      BASE_STYLE,
    );
    expect(renderer.callsOf('drawImage')[0]!.args[4]).toBe(mask);
  });

  it('ImageMask 缺蒙版句柄时 warning 并按无蒙版绘制', () => {
    const renderer = new FakeRenderer();
    const warnings = warningCollector();
    drawImageObject(
      { renderer, image: imageHandle(), onWarning: warnings.warnings },
      imageObject({ imageMask: '9' }),
      BASE_STYLE,
    );
    expect(warnings.codes).toContain('W_IMAGE_DECODE');
    expect(renderer.callsOf('drawImage')[0]!.args[4]).toBeUndefined();
  });

  it('Substitution auto：dpi>200 优先替换图，否则主图', () => {
    const main = imageHandle(10, 10);
    const substitute = imageHandle(200, 200);
    const object = imageObject({ substitution: '8' });

    const high = new FakeRenderer();
    drawImageObject(
      { renderer: high, image: main, substitutionImage: substitute, dpi: 300 },
      object,
      BASE_STYLE,
    );
    expect(high.callsOf('drawImage')[0]!.args[0]).toBe(substitute);

    const low = new FakeRenderer();
    drawImageObject(
      { renderer: low, image: main, substitutionImage: substitute, dpi: 96 },
      object,
      BASE_STYLE,
    );
    expect(low.callsOf('drawImage')[0]!.args[0]).toBe(main);
  });

  it('Substitution always/never 强制选择', () => {
    const main = imageHandle(10, 10);
    const substitute = imageHandle(200, 200);
    const object = imageObject({ substitution: '8' });

    const always = new FakeRenderer();
    drawImageObject(
      { renderer: always, image: main, substitutionImage: substitute, substitutionMode: 'always', dpi: 96 },
      object,
      BASE_STYLE,
    );
    expect(always.callsOf('drawImage')[0]!.args[0]).toBe(substitute);

    const never = new FakeRenderer();
    drawImageObject(
      { renderer: never, image: main, substitutionImage: substitute, substitutionMode: 'never', dpi: 300 },
      object,
      BASE_STYLE,
    );
    expect(never.callsOf('drawImage')[0]!.args[0]).toBe(main);
  });

  it('Substitution 资源缺失时 warning 并回退主图', () => {
    const renderer = new FakeRenderer();
    const warnings = warningCollector();
    drawImageObject(
      { renderer, image: imageHandle(), dpi: 300, onWarning: warnings.warnings },
      imageObject({ substitution: '8' }),
      BASE_STYLE,
    );
    expect(warnings.codes).toContain('W_IMAGE_DECODE');
  });

  it('smoothing=false 透传渲染器', () => {
    const renderer = new FakeRenderer();
    drawImageObject(
      { renderer, image: imageHandle(), smoothing: false },
      imageObject({ ctm: [1, 0, 0, 1, 0, 0] }),
      BASE_STYLE,
    );
    expect(renderer.callsOf('drawImage')[0]!.args[3]).toBe(false);
  });
});