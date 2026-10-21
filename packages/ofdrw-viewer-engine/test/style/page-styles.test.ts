import { describe, expect, it, vi } from 'vitest';
import type { CompositeGraphicUnit, DrawParam, Pattern, ResourceId } from '../../src/model/types';
import { DrawParamGraph } from '../../src/style/draw-param';
import { createDefaultStyle } from '../../src/style/defaults';
import { resolveBlockStyles, resolvePageStyles } from '../../src/style/page-styles';
import { StyleResolver } from '../../src/style/resolve';
import { makeComposite, makePage, makePath, makeText } from './objects';

/** 构造结算器。 */
function resolverOf(params: DrawParam[] = []): StyleResolver {
  const map = new Map<ResourceId, DrawParam>(params.map((item) => [item.id as ResourceId, item]));
  return new StyleResolver(new DrawParamGraph(map), createDefaultStyle());
}

describe('resolvePageStyles', () => {
  it('覆盖页面所有图元，并递归复合资源内容', () => {
    const text = makeText({ id: '1' });
    const path = makePath({ id: '2' });
    const compositeText = makeText({ id: '3' });
    const composite = makeComposite({ id: '4', resourceId: '10', drawParam: '5' });
    const compositeResource: CompositeGraphicUnit = {
      id: '10',
      width: 100,
      height: 100,
      content: { kind: 'block', children: [compositeText] },
    };
    const page = makePage([{ type: 'Body', children: [text, path, composite] }]);
    const resolver = resolverOf([
      { id: '5', lineWidth: 2, fillColor: { type: 'color', color: { r: 255, g: 0, b: 0, a: 255 } } },
    ]);
    const result = resolvePageStyles(page, resolver, {
      lookup: { getComposite: (id) => (id === '10' ? compositeResource : undefined) },
    });
    expect(result.styles.get(text)?.fill).toBe(true);
    expect(result.styles.get(path)?.stroke).toBe(true);
    expect(result.styles.get(composite)?.lineWidth).toBe(2);
    expect(result.styles.get(compositeText)?.lineWidth).toBe(2);
    expect(result.styles.get(compositeText)?.fillPaint).toEqual({
      kind: 'color',
      rgba: { r: 255, g: 0, b: 0, a: 255 },
    });
  });

  it('复合资源环只 warning，不无限递归', () => {
    const onWarning = vi.fn();
    const inner = makeComposite({ id: '2', resourceId: '10' });
    const resource: CompositeGraphicUnit = {
      id: '10',
      width: 10,
      height: 10,
      content: { kind: 'block', children: [inner] },
    };
    const outer = makeComposite({ id: '1', resourceId: '10' });
    const page = makePage([{ type: 'Body', children: [outer] }]);
    const result = resolvePageStyles(page, resolverOf(), {
      lookup: { getComposite: () => resource },
      onWarning,
    });
    expect(result.styles.has(outer)).toBe(true);
    expect(result.styles.has(inner)).toBe(true);
    expect(onWarning).toHaveBeenCalledWith('W_COMPOSITE_DEPTH', expect.stringContaining('环'), '10');
  });

  it('底纹 cell 内对象也写入 styles', () => {
    const cellText = makeText({ id: '9' });
    const pattern: Pattern = {
      width: 10,
      height: 10,
      xStep: 10,
      yStep: 10,
      reflectMethod: 'Normal',
      relativeTo: 'Object',
      cell: { kind: 'block', children: [cellText] },
    };
    const text = makeText({ id: '1', fillColor: { type: 'pattern', pattern } });
    const page = makePage([{ type: 'Body', children: [text] }]);
    const result = resolvePageStyles(page, resolverOf());
    expect(result.styles.has(text)).toBe(true);
    expect(result.styles.has(cellText)).toBe(true);
    expect(result.styles.get(cellText)?.fill).toBe(true);
  });
});

describe('resolveBlockStyles', () => {
  it('注释外观以传入的 styleRoot 作为继承起点', () => {
    const text = makeText({ id: '1' });
    const root = createDefaultStyle({ lineWidth: 1 });
    const block = { kind: 'block' as const, children: [text] };
    const styles = resolveBlockStyles(block, root, resolverOf());
    expect(styles.get(text)?.lineWidth).toBe(1);
    expect(styles.get(text)?.fill).toBe(true);
  });
});