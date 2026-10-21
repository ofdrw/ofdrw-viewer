/**
 * RecordingRenderer 契约测试：记录路径/样式/矩阵/group 调用序列，不真正绘制。
 */

import { describe, expect, it } from 'vitest';
import { RecordingRenderer } from '../../src/renderer/recording';
import type { Renderer } from '../../src/renderer/types';
import type { DrawStyle, ResolvedPaint, Rgba, Viewport } from '../../src/common/types';
import { createNodeCanvas } from './helpers';

/** 测试用线型。 */
const STYLE: DrawStyle = {
  lineWidth: 1,
  lineCap: 'Butt',
  lineJoin: 'Miter',
  miterLimit: 10,
  dashOffset: 0,
  dashPattern: [],
};

/** 测试用颜色。 */
const RED: Rgba = { r: 255, g: 0, b: 0, a: 255 };

/** 测试用纯色 Paint。 */
const PAINT: ResolvedPaint = { kind: 'color', rgba: RED };

/** 测试用 viewport。 */
const VIEWPORT: Viewport = { width: 200, height: 100, dpi: 96 };

describe('RecordingRenderer', () => {
  it('实现 Renderer 全接口并记录完整调用序列', () => {
    const renderer: Renderer = new RecordingRenderer();
    const { context } = createNodeCanvas(10, 10);

    renderer.beginPage(context, VIEWPORT);
    renderer.save();
    renderer.setTransform([1, 0, 0, 1, 2, 3]);
    renderer.transform([2, 0, 0, 2, 0, 0]);
    renderer.translate(4, 5);
    renderer.multiplyAlpha(0.5);
    renderer.beginPath();
    renderer.moveTo(0, 0);
    renderer.lineTo(1, 1);
    renderer.quadraticCurveTo(2, 2, 3, 3);
    renderer.cubicCurveTo(4, 4, 5, 5, 6, 6);
    renderer.rect(0, 0, 8, 8);
    renderer.closePath();
    renderer.clip('evenodd');
    renderer.fill(STYLE, PAINT, 'evenodd');
    renderer.stroke(STYLE, PAINT);
    renderer.clear();
    renderer.beginGroup({
      bounds: { x: 0, y: 0, w: 8, h: 8 },
      matrix: [1, 0, 0, 1, 0, 0],
      alpha: 0.5,
      isolated: true,
      composite: 'multiply',
    });
    renderer.multiplyAlpha(0.25);
    renderer.endGroup();
    const image = renderer.createImage({
      width: 2,
      height: 3,
      data: { width: 2, height: 3, data: new Uint8ClampedArray(2 * 3 * 4) },
    });
    renderer.drawImage(image, [1, 0, 0, 1, 0, 0], 1, true, image);
    renderer.restore();
    renderer.endPage();
    renderer.close();

    const recording = renderer as RecordingRenderer;
    expect(recording.lastViewport).toEqual(VIEWPORT);
    expect(recording.closed).toBe(true);
    expect(recording.calls.map((call) => call.op)).toEqual([
      'beginPage',
      'save',
      'setTransform',
      'transform',
      'translate',
      'multiplyAlpha',
      'beginPath',
      'moveTo',
      'lineTo',
      'quadraticCurveTo',
      'cubicCurveTo',
      'rect',
      'closePath',
      'clip',
      'fill',
      'stroke',
      'clear',
      'beginGroup',
      'multiplyAlpha',
      'endGroup',
      'createImage',
      'drawImage',
      'restore',
      'endPage',
      'close',
    ]);

    const fill = recording.calls.find((call) => call.op === 'fill');
    expect(fill).toMatchObject({ op: 'fill', rule: 'evenodd', paint: PAINT, style: STYLE });
    const group = recording.calls.find((call) => call.op === 'beginGroup');
    expect(group).toMatchObject({ op: 'beginGroup', options: { alpha: 0.5, composite: 'multiply' } });
    const imageCall = recording.calls.find((call) => call.op === 'createImage');
    expect(imageCall).toMatchObject({ op: 'createImage', width: 2, height: 3 });
  });

  it('createImage 返回只含宽高的不透明句柄，不暴露 surface', () => {
    const renderer = new RecordingRenderer();
    const handle = renderer.createImage({
      width: 4,
      height: 5,
      data: { width: 4, height: 5, data: new Uint8ClampedArray(4 * 5 * 4) },
    });
    expect(handle).toEqual({ width: 4, height: 5 });
    expect(Object.keys(handle).sort()).toEqual(['height', 'width']);
    expect(renderer.calls[0]).toMatchObject({ op: 'createImage', width: 4, height: 5 });
  });

  it('reset 清空记录，不改变 closed', () => {
    const renderer = new RecordingRenderer();
    const { context } = createNodeCanvas(1, 1);
    renderer.beginPage(context, VIEWPORT);
    renderer.close();
    renderer.reset();
    expect(renderer.calls).toEqual([]);
    expect(renderer.lastViewport).toBeNull();
    expect(renderer.closed).toBe(true);
  });
});