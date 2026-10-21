/**
 * DisplayList 构建器 smoke 测试。
 *
 * 验证 render/display-list.ts 生成的命令形状与 build() 快照语义；
 * 不执行真实绘制。
 */

import { describe, expect, it } from 'vitest';
import { DisplayListBuilder } from '../../packages/ofdrw-viewer-engine/src/render/display-list';
import type { DrawStyle } from '../../packages/ofdrw-viewer-engine/src/common/types';

const style: DrawStyle = {
  lineWidth: 1,
  lineCap: 'Butt',
  lineJoin: 'Miter',
  miterLimit: 4.234,
  dashOffset: 0,
  dashPattern: [],
};

describe('DisplayListBuilder', () => {
  it('记录路径/填充/图片命令并保持顺序', () => {
    const builder = new DisplayListBuilder({ x: 0, y: 0, w: 10, h: 10 });
    builder
      .save()
      .setTransform([1, 0, 0, 1, 0, 0])
      .beginPath()
      .moveTo(0, 0)
      .lineTo(10, 0)
      .closePath()
      .fill(style, { kind: 'color', rgba: { r: 0, g: 0, b: 0, a: 255 } }, 'nonzero')
      .restore();
    const list = builder.build();
    expect(list.bounds).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    expect(list.commands.map((command) => command.op)).toEqual([
      'save',
      'setTransform',
      'beginPath',
      'moveTo',
      'lineTo',
      'closePath',
      'fill',
      'restore',
    ]);
    expect(list.commands[3]).toEqual({ op: 'moveTo', x: 0, y: 0 });
  });

  it('build() 返回快照，后续追加不影响已构建列表', () => {
    const builder = new DisplayListBuilder({ x: 0, y: 0, w: 1, h: 1 });
    builder.beginPath();
    const snapshot = builder.build();
    builder.lineTo(1, 1);
    expect(snapshot.commands).toHaveLength(1);
    expect(builder.build().commands).toHaveLength(2);
  });
});