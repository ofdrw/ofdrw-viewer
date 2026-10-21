/**
 * T6a 独立块单测：构建/复用、深度与循环、group alpha、注释块放置。
 */

import { describe, expect, it } from 'vitest';
import type { DisplayList } from '../../../src/common/display-list';
import { DisplayListBuilder } from '../../../src/render/display-list';
import {
  MAX_BLOCK_DEPTH,
  BlockStore,
  buildIndependentBlock,
  drawAnnotationBlocks,
  drawIndependentBlock,
  type BuildBlockInput,
  type PreparedBlock,
} from '../../../src/render/block';
import { createPaintBinder } from '../../../src/render/paint';
import { IDENTITY_MATRIX } from '../../../src/common/matrix';
import { BASE_STYLE, FakeRenderer, warningCollector } from '../path/fake-renderer';

function blockInput(cacheKey = 'block-1'): BuildBlockInput {
  return {
    id: '1',
    source: 'composite',
    space: { width: 10, height: 5 },
    content: { kind: 'block', children: [] },
    styleRoot: BASE_STYLE,
    boundary: { x: 3, y: 4, w: 10, h: 5 },
    cacheKey,
  };
}

function displayList(): DisplayList {
  return new DisplayListBuilder({ x: 0, y: 0, w: 10, h: 5 })
    .save()
    .beginPath()
    .moveTo(0, 0)
    .lineTo(5, 5)
    .stroke(BASE_STYLE, { kind: 'color', rgba: { r: 0, g: 0, b: 0, a: 255 } })
    .restore()
    .build();
}

function prepared(cacheKey = 'block-1'): PreparedBlock {
  return buildIndependentBlock(blockInput(cacheKey), () => displayList());
}

function emptyBlock(space = { width: 10, height: 5 }): PreparedBlock {
  return {
    ...blockInput(),
    space,
    displayList: { commands: [], bounds: { x: 0, y: 0, w: space.width, h: space.height } },
  };
}

describe('buildIndependentBlock', () => {
  it('调用构建回调并返回带 displayList 的块，不套用放置平移', () => {
    const input = blockInput();
    let received: BuildBlockInput | null = null;
    const list = displayList();
    const block = buildIndependentBlock(input, (current) => {
      received = current;
      return list;
    });
    expect(received).toBe(input);
    expect(block.displayList).toBe(list);
    expect(block.boundary).toEqual({ x: 3, y: 4, w: 10, h: 5 });
    expect(block.cacheKey).toBe('block-1');
  });

  it('递归深度超过 16 时返回空显示列表并 warning', () => {
    const warnings = warningCollector();
    const block = buildIndependentBlock(blockInput(), () => displayList(), {
      depth: MAX_BLOCK_DEPTH + 1,
      onWarning: warnings.warnings,
    });
    expect(block.displayList.commands).toEqual([]);
    expect(warnings.codes).toContain('W_COMPOSITE_DEPTH');
  });

  it('深度等于上限时允许构建', () => {
    const block = buildIndependentBlock(blockInput(), () => displayList(), {
      depth: MAX_BLOCK_DEPTH,
    });
    expect(block.displayList.commands.length).toBeGreaterThan(0);
  });

  it('cacheKey 已在祖先栈中时视为循环，返回空列表并 warning', () => {
    const warnings = warningCollector();
    const block = buildIndependentBlock(blockInput('loop'), () => displayList(), {
      ancestors: ['loop'],
      onWarning: warnings.warnings,
    });
    expect(block.displayList.commands).toEqual([]);
    expect(warnings.codes).toContain('W_COMPOSITE_DEPTH');
  });
});

describe('BlockStore', () => {
  it('按 cacheKey 复用块，并按 patternId 提供 tile', () => {
    const store = new BlockStore();
    const block = prepared();
    store.set(block);
    expect(store.size).toBe(1);
    expect(store.get('block-1')).toBe(block);

    const tile = displayList();
    const patternBlock: PreparedBlock = {
      ...blockInput('pattern-7'),
      id: '7',
      source: 'pattern-cell',
      displayList: tile,
    };
    store.set(patternBlock);
    expect(store.getPatternTile('7')).toBe(tile);
    expect(store.resolvePatternTile('7')).toBe(tile);
    expect(store.resolvePatternTile('missing')).toBeUndefined();

    store.clear();
    expect(store.size).toBe(0);
    expect(store.getPatternTile('7')).toBeUndefined();
  });
});

describe('drawIndependentBlock', () => {
  it('alpha=1 不回放 group；块空间裁剪并回放显示列表', () => {
    const renderer = new FakeRenderer();
    const binder = createPaintBinder(renderer);
    drawIndependentBlock({ renderer, binder }, prepared());
    expect(renderer.callsOf('beginGroup')).toHaveLength(0);
    expect(renderer.callsOf('endGroup')).toHaveLength(0);
    expect(renderer.ops()).toEqual([
      'save',
      'beginPath',
      'rect',
      'clip',
      'save',
      'beginPath',
      'moveTo',
      'lineTo',
      'stroke',
      'restore',
      'restore',
    ]);
    const rect = renderer.callsOf('rect')[0]!;
    expect(rect.args).toEqual([0, 0, 10, 5]);
    expect(renderer.callsOf('clip')[0]!.args).toEqual(['nonzero']);
  });

  it('alpha<1 时 beginGroup/endGroup，alpha 只在 group 结束乘一次', () => {
    const renderer = new FakeRenderer();
    const binder = createPaintBinder(renderer);
    drawIndependentBlock({ renderer, binder, alpha: 0.5 }, prepared());
    const groups = renderer.callsOf('beginGroup');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.args[0]).toEqual({
      bounds: { x: 0, y: 0, w: 10, h: 5 },
      matrix: IDENTITY_MATRIX,
      alpha: 0.5,
      isolated: false,
      composite: 'source-over',
    });
    expect(renderer.ops().filter((op) => op === 'beginGroup')).toHaveLength(1);
    expect(renderer.ops().filter((op) => op === 'endGroup')).toHaveLength(1);
    expect(renderer.ops().filter((op) => op === 'multiplyAlpha')).toHaveLength(0);
  });

  it('isolated/composite/matrix 透传到 GroupOptions', () => {
    const renderer = new FakeRenderer();
    const binder = createPaintBinder(renderer);
    const matrix = [2, 0, 0, 2, 10, 20] as const;
    drawIndependentBlock(
      { renderer, binder, isolated: true, composite: 'multiply', matrix },
      prepared(),
    );
    expect(renderer.callsOf('beginGroup')[0]!.args[0]).toMatchObject({
      matrix,
      isolated: true,
      composite: 'multiply',
    });
  });

  it('空显示列表 warning W_ANNOT_EMPTY，不产生绘制调用', () => {
    const renderer = new FakeRenderer();
    const binder = createPaintBinder(renderer);
    const warnings = warningCollector();
    drawIndependentBlock({ renderer, binder, onWarning: warnings.warnings }, emptyBlock());
    expect(renderer.calls).toHaveLength(0);
    expect(warnings.codes).toContain('W_ANNOT_EMPTY');
  });

  it('块空间尺寸非正时 warning W_ZERO_BOUNDARY', () => {
    const renderer = new FakeRenderer();
    const binder = createPaintBinder(renderer);
    const warnings = warningCollector();
    drawIndependentBlock(
      { renderer, binder, onWarning: warnings.warnings },
      { ...prepared(), space: { width: 0, height: 5 } },
    );
    expect(warnings.codes).toContain('W_ZERO_BOUNDARY');
    expect(renderer.calls).toHaveLength(0);
  });

  it('回放异常时仍 endGroup 并 restore', () => {
    const renderer = new FakeRenderer();
    renderer.throwOn = 'stroke';
    const binder = createPaintBinder(renderer);
    const warnings = warningCollector();
    drawIndependentBlock(
      { renderer, binder, alpha: 0.5, onWarning: warnings.warnings },
      prepared(),
    );
    expect(warnings.codes).toContain('W_UNSUPPORTED_PAINT');
    expect(renderer.callsOf('endGroup')).toHaveLength(1);
    expect(renderer.ops().at(-1)).toBe('restore');
  });
});

describe('drawAnnotationBlocks', () => {
  it('按顺序 save/translate(boundary)/绘制/restore，空块不影响后续', () => {
    const renderer = new FakeRenderer();
    const binder = createPaintBinder(renderer);
    const warnings = warningCollector();
    const first = prepared('a');
    const empty = emptyBlock();
    drawAnnotationBlocks(renderer, binder, [empty, first], warnings.warnings);

    // 空块与正常块都带 boundary，各自独立放置；空块不产生路径/描边。
    expect(renderer.callsOf('translate')).toEqual([
      { op: 'translate', args: [3, 4] },
      { op: 'translate', args: [3, 4] },
    ]);
    expect(warnings.codes).toContain('W_ANNOT_EMPTY');
    // 外层 2 次 + 正常块的 drawIndependentBlock save + 显示列表 save。
    expect(renderer.ops().filter((op) => op === 'save')).toHaveLength(4);
    expect(renderer.ops().at(-1)).toBe('restore');
  });

  it('多个注释块各自独立放置', () => {
    const renderer = new FakeRenderer();
    const binder = createPaintBinder(renderer);
    const first = prepared('a');
    const second: PreparedBlock = {
      ...prepared('b'),
      boundary: { x: 50, y: 60, w: 10, h: 5 },
    };
    drawAnnotationBlocks(renderer, binder, [first, second]);
    expect(renderer.callsOf('translate').map((call) => call.args)).toEqual([
      [3, 4],
      [50, 60],
    ]);
  });
});