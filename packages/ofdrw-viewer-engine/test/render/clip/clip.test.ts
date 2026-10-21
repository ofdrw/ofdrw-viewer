/**
 * T6a 裁剪单测：Clip 交集、Area 并集、CTM 组合顺序、Text 裁剪。
 */

import { describe, expect, it } from 'vitest';
import type { Clip, PathObject, TextObject } from '../../../src/model/types';
import { applyClips } from '../../../src/render/clip';
import { FakeRenderer, warningCollector } from '../path/fake-renderer';

function clipPath(data: string, overrides: Partial<PathObject> = {}): PathObject {
  return {
    kind: 'path',
    boundary: { x: 0, y: 0, w: 10, h: 10 },
    alpha: 255,
    visible: true,
    data,
    fill: true,
    stroke: false,
    rule: 'nonzero',
    ...overrides,
  };
}

function textObject(): TextObject {
  return {
    kind: 'text',
    boundary: { x: 1, y: 2, w: 10, h: 10 },
    ctm: [2, 0, 0, 2, 0, 0],
    alpha: 255,
    visible: true,
    font: '1',
    size: 3.5,
    hScale: 1,
    readDirection: 0,
    charDirection: 0,
    weight: 400,
    italic: false,
    fill: true,
    stroke: false,
    codes: [],
  };
}

describe('applyClips', () => {
  it('无 clips 时不做任何调用', () => {
    const renderer = new FakeRenderer();
    applyClips({ renderer }, undefined);
    applyClips({ renderer }, []);
    expect(renderer.calls).toHaveLength(0);
  });

  it('多个 Clip 依次 clip，形成交集', () => {
    const renderer = new FakeRenderer();
    const clips: Clip[] = [
      { areas: [{ kind: 'path', path: clipPath('M 0 0 L 5 0 L 5 5 C') }] },
      { areas: [{ kind: 'path', path: clipPath('M 1 1 L 4 1 L 4 4 C') }] },
    ];
    applyClips({ renderer }, clips);
    expect(renderer.callsOf('beginPath')).toHaveLength(2);
    expect(renderer.callsOf('clip')).toHaveLength(2);
  });

  it('单个 Clip 的多个 Area 合并为一次 clip（并集）', () => {
    const renderer = new FakeRenderer();
    applyClips(
      { renderer },
      [
        {
          areas: [
            { kind: 'path', path: clipPath('M 0 0 L 5 0 L 5 5 C') },
            { kind: 'path', path: clipPath('M 10 10 L 15 10 L 15 15 C') },
          ],
        },
      ],
    );
    expect(renderer.callsOf('beginPath')).toHaveLength(1);
    expect(renderer.callsOf('clip')).toHaveLength(1);
    expect(renderer.callsOf('moveTo')).toHaveLength(2);
  });

  it('Area 变换顺序为 Clip.CTM × T(Boundary) × Path.CTM', () => {
    const renderer = new FakeRenderer();
    const path = clipPath('M 1 2 L 3 4', {
      boundary: { x: 5, y: 7, w: 10, h: 10 },
      ctm: [1, 0, 0, 1, 3, 4],
    });
    applyClips({ renderer }, [{ ctm: [2, 0, 0, 2, 10, 20], areas: [{ kind: 'path', path }] }]);
    expect(renderer.callsOf('moveTo')[0]!.args).toEqual([28, 46]);
    expect(renderer.callsOf('lineTo')[0]!.args).toEqual([32, 50]);
  });

  it('Text 裁剪通过字形轮廓提供者生成路径', () => {
    const renderer = new FakeRenderer();
    const text = textObject();
    applyClips(
      {
        renderer,
        textPath: (input) => {
          expect(input).toBe(text);
          return [
            { type: 'moveTo', x: 0, y: 0 },
            { type: 'lineTo', x: 5, y: 0 },
            { type: 'lineTo', x: 5, y: 5 },
            { type: 'closePath' },
          ];
        },
      },
      [{ areas: [{ kind: 'text', text }] }],
    );
    expect(renderer.callsOf('moveTo')[0]!.args).toEqual([1, 2]);
    expect(renderer.callsOf('clip')).toHaveLength(1);
  });

  it('Text 裁剪缺少轮廓提供者时 warning 并跳过', () => {
    const renderer = new FakeRenderer();
    const warnings = warningCollector();
    applyClips(
      { renderer, onWarning: warnings.warnings },
      [{ areas: [{ kind: 'text', text: textObject() }] }],
    );
    expect(renderer.callsOf('clip')).toHaveLength(0);
    expect(warnings.codes).toContain('W_UNSUPPORTED_CLIP');
  });

  it('Stroke-only 裁剪路径降级为 Fill 并 warning', () => {
    const renderer = new FakeRenderer();
    const warnings = warningCollector();
    applyClips(
      { renderer, onWarning: warnings.warnings },
      [
        {
          areas: [
            {
              kind: 'path',
              path: clipPath('M 0 0 L 5 0 L 5 5 C', { fill: false, stroke: true }),
            },
          ],
        },
      ],
    );
    expect(renderer.callsOf('clip')).toHaveLength(1);
    expect(warnings.codes).toContain('W_UNSUPPORTED_CLIP');
  });

  it('同一 Clip 内不同 FillRule 取第一个并 warning', () => {
    const renderer = new FakeRenderer();
    const warnings = warningCollector();
    applyClips(
      { renderer, onWarning: warnings.warnings },
      [
        {
          areas: [
            { kind: 'path', path: clipPath('M 0 0 L 5 0 L 5 5 C') },
            {
              kind: 'path',
              path: clipPath('M 1 1 L 4 1 L 4 4 C', { rule: 'evenodd' }),
            },
          ],
        },
      ],
    );
    expect(renderer.callsOf('clip')[0]!.args).toEqual(['nonzero']);
    expect(warnings.codes).toContain('W_UNSUPPORTED_CLIP');
  });

  it('Fill/Stroke 均为 false 的裁剪 Area 跳过且不执行空 clip', () => {
    const renderer = new FakeRenderer();
    const warnings = warningCollector();
    applyClips(
      { renderer, onWarning: warnings.warnings },
      [
        {
          areas: [
            {
              kind: 'path',
              path: clipPath('M 0 0 L 5 5', { fill: false, stroke: false }),
            },
          ],
        },
      ],
    );
    expect(renderer.callsOf('clip')).toHaveLength(0);
    expect(warnings.codes).toContain('W_UNSUPPORTED_CLIP');
  });
});