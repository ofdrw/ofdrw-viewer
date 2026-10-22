/**
 * 文本内容收集内核测试。
 *
 * 覆盖横/竖/180/270、DPI 复用、字符映射、图层/模板/注释顺序、可见性、
 * 复合块、上限与空页；所有几何用假字体精确断言。
 */

import { describe, expect, it } from 'vitest';
import type {
  PageBlock,
  PageModel,
  PageObject,
  TextObject,
} from '../../src/model/types';
import type { PreparedPageBundle } from '../../src/render/prepare';
import { setBlockStyles } from '../../src/render/object';
import type { FontFaceSet } from '../../src/font/types';
import type { ResolvedStyle } from '../../src/style/types';
import type { TextCharMm } from '../../src/render/text-content';
import {
  collectTextPageMm,
  toTextPagePx,
} from '../../src/render/text-content';
import {
  createFakeFace,
  createFakeFaceSet,
  createStyle,
  makeTextCode,
  makeTextObject,
} from '../text-layout/fake-font';

/** 假字体：A/B 的 advance 分别为 500/600 字体单位。 */
function makeFaces(): FontFaceSet {
  return createFakeFaceSet(
    createFakeFace({
      key: 'face-a',
      family: 'Content Sans',
      glyphs: [
        { gid: 1, codePoints: [0x41], advanceWidth: 500 },
        { gid: 2, codePoints: [0x42], advanceWidth: 600 },
      ],
    }),
  );
}

/** 创建页面模型。 */
function makePage(overrides: Partial<PageModel> = {}): PageModel {
  return {
    id: 'page-1',
    area: { x: 0, y: 0, w: 100, h: 50 },
    size: { width: 100, height: 50 },
    layers: [],
    templates: [],
    pageRes: [],
    ...overrides,
  };
}

/** 创建带样式的对象。 */
function styled<T extends PageObject>(object: T, style: ResolvedStyle = createStyle()): T {
  return object;
}

/** 构造已准备页面。 */
function makePrepared(options: {
  page?: PageModel;
  templates?: PageModel[];
  blocks?: Map<string, PageBlock>;
  annotationBlocks?: PageBlock[];
  objects?: PageObject[];
  styles?: Map<PageObject, ResolvedStyle>;
} = {}): PreparedPageBundle {
  const page = options.page ?? makePage();
  const styles = new WeakMap<object, ResolvedStyle>();
  const addTree = (objects: readonly PageObject[]): void => {
    for (const object of objects) {
      styles.set(object, createStyle());
      if (object.kind === 'block') addTree(object.children);
    }
  };
  addTree(page.layers.flatMap((layer) => layer.children));
  addTree(options.objects ?? []);
  for (const template of options.templates ?? []) {
    addTree(template.layers.flatMap((layer) => layer.children));
  }
  for (const block of options.blocks?.values() ?? []) addTree(block.children);
  for (const block of options.annotationBlocks ?? []) addTree(block.children);
  for (const [object, style] of options.styles ?? []) styles.set(object, style);
  /** 为独立块内容建立样式映射，模拟 prepare 阶段产物。 */
  const blockStyleMap = (content: PageBlock): WeakMap<import('../../src/model/types').GraphicUnitBase, ResolvedStyle> => {
    const map = new WeakMap<import('../../src/model/types').GraphicUnitBase, ResolvedStyle>();
    const visit = (objects: readonly PageObject[]): void => {
      for (const object of objects) {
        if (object.kind === 'block') {
          visit(object.children);
          continue;
        }
        map.set(object, createStyle());
      }
    };
    visit(content.children);
    return map;
  };
  const blocks = new Map<string, import('../../src/model/types').IndependentBlock>();
  for (const [id, block] of options.blocks ?? []) {
    const independent = {
      id,
      source: 'composite' as const,
      space: { width: 100, height: 50 },
      content: block,
      styleRoot: createStyle(),
      cacheKey: id,
      displayList: { commands: [], bounds: { x: 0, y: 0, w: 100, h: 50 } },
    };
    setBlockStyles(independent, blockStyleMap(block));
    blocks.set(id, independent);
  }
  const annotationBlocks = (options.annotationBlocks ?? []).map((content, index) => {
    const independent = {
      id: `annot-${index + 1}`,
      source: 'annotation' as const,
      space: { width: 100, height: 50 },
      boundary: { x: 5, y: 6, w: 100, h: 50 },
      content,
      styleRoot: createStyle(),
      cacheKey: `annot-${index + 1}`,
      displayList: { commands: [], bounds: { x: 0, y: 0, w: 100, h: 50 } },
    };
    setBlockStyles(independent, blockStyleMap(content));
    return independent;
  });
  return {
    page: {
      page,
      styles: styles as WeakMap<import('../../src/model/types').GraphicUnitBase, ResolvedStyle>,
      annotationBlocks,
    },
    templates: options.templates ?? [],
    fonts: new Map([['1', makeFaces()]]),
    images: new Map(),
    blocks,
    signatureBlocks: [],
  };
}

/** 构造带单个文字对象的页。 */
function textPage(object: TextObject): PageModel {
  return makePage({ layers: [{ type: 'Body', children: [object] }] });
}

/** 比较 mm 与 px 的换算。 */
function expectClose(actual: number, expected: number, digits = 6): void {
  expect(actual).toBeCloseTo(expected, digits);
}

describe('文本内容收集 - 几何与 DPI', () => {
  it('复用 layoutText placement，按 PhysicalBox 原点平移并输出 mm/px', () => {
    const object = makeTextObject({
      id: 'text-1',
      boundary: { x: 10, y: 20, w: 30, h: 20 },
      size: 10,
      codes: [makeTextCode({ text: 'AB', deltaX: [5, 5] })],
    });
    const prepared = makePrepared({
      page: textPage(object),
      styles: new Map([[object, createStyle()]]),
    });
    // 让页面 area 非零，验证 T(-area) 与文字对象 Boundary 平移。
    prepared.page.page.area = { x: 1, y: 2, w: 100, h: 50 };
    prepared.page.page.size = { width: 100, height: 50 };

    const mm = collectTextPageMm(prepared);
    expect(mm.itemCount).toBe(1);
    expect(mm.charCount).toBe(2);
    const item = mm.items[0];
    expect(item.objectId).toBe('text-1');
    expect(item.layer).toBe('page');
    expect(item.layerType).toBe('Body');
    expect(item.font).toMatchObject({ resourceId: '1', family: 'Content Sans' });
    expect(item.text).toBe('AB');
    expect(item.size).toBe(10);
    expect(item.origin).toEqual({ x: 9, y: 18 });
    expectClose(item.advance, 10);
    expectClose(item.rect.x, 9);
    expectClose(item.rect.y, 8);
    // 字符单元宽度取 placement.advance（字体 advance），不是 DeltaX；DeltaX 只推进 pen。
    expectClose(item.rect.width, 11);
    expectClose(item.rect.height, 10);
    expect(item.quad.map((point) => [point.x, point.y])).toEqual([
      [9, 8],
      [20, 8],
      [20, 18],
      [9, 18],
    ]);

    const first = item.chars?.[0] as TextCharMm;
    const second = item.chars?.[1] as TextCharMm;
    expect(first.glyphId).toBe(1);
    expect(first.faceKey).toBe('face-a');
    expect(first.fallback).toBe(false);
    expect(first.approximate).toBe(false);
    expect(first.origin).toEqual({ x: 9, y: 18 });
    expect(second.origin).toEqual({ x: 14, y: 18 });
    expect(second.advance).toBe(6);
    expect(second.rect).toEqual({ x: 14, y: 8, width: 6, height: 10 });

    const px = toTextPagePx(mm, 96);
    expect(px.unit).toBe('px');
    expect(px.dpi).toBe(96);
    expectClose(px.items[0].origin.x, 9 * (96 / 25.4));
    expectClose(px.items[0].advance, 10 * (96 / 25.4));
    expectClose(px.items[0].chars![1].origin.x, 14 * (96 / 25.4));
    expect(px.pageWidth).toBeCloseTo(100 * (96 / 25.4), 6);
  });

  it.each([96, 144, 300])('同一 mm 布局在 %i DPI 下只做比例换算', (dpi) => {
    const object = makeTextObject({
      boundary: { x: 0, y: 0, w: 30, h: 20 },
      size: 10,
      codes: [makeTextCode({ text: 'A', deltaX: [4] })],
    });
    const prepared = makePrepared({ page: textPage(object) });
    const mm = collectTextPageMm(prepared);
    const px = toTextPagePx(mm, dpi);
    expect(px.dpi).toBe(dpi);
    expectClose(px.items[0].size, 10 * (dpi / 25.4));
    expectClose(px.items[0].chars![0].rect.width, (5 * dpi) / 25.4);
    expect(px.itemCount).toBe(1);
  });

  it.each([
    [90, 90],
    [180, 180],
    [270, 270],
    [0, 180],
  ] as const)('ReadDirection=%i/CharDirection=%i 的字符 quad 方向正确', (read, char) => {
    const object = makeTextObject({
      boundary: { x: 0, y: 0, w: 30, h: 30 },
      size: 10,
      readDirection: read,
      charDirection: char,
      codes: [makeTextCode({ text: 'AB', deltaX: [5, 5] })],
    });
    const prepared = makePrepared({ page: textPage(object) });
    const item = collectTextPageMm(prepared).items[0];
    expect(item.chars).toHaveLength(2);
    // 水平阅读方向由 DeltaX 推进（5+5）；垂直方向没有 DeltaY，回退字体 advance（5+6）。
    expectClose(item.advance, read === 90 || read === 270 ? 11 : 10);
    const first = item.chars![0];
    const second = item.chars![1];
    // 阅读方向决定第二个字符的起点；字符方向只旋转字形单元。
    const expected:
      Record<number, { x: number; y: number }> = {
        0: { x: 5, y: 0 },
        90: { x: 0, y: 5 },
        180: { x: -5, y: 0 },
        270: { x: 0, y: -5 },
      };
    expectClose(second.origin.x, expected[read].x);
    expectClose(second.origin.y, expected[read].y);
    // quad 顺序固定；180 度时上边在 baseline 下方。
    const quad = first.quad;
    if (char === 180) {
      expect(quad[0].y).toBeGreaterThan(quad[3].y);
    } else if (char === 90) {
      expect(quad[1].y).toBeGreaterThan(quad[0].y);
    }
    expect(first.rect.width).toBeGreaterThan(0);
    expect(first.rect.height).toBeGreaterThan(0);
  });
});

describe('文本内容收集 - 字符映射与可见性', () => {
  it('includeChars=false 时保留 text/charCount，但省略 chars', () => {
    const object = makeTextObject({
      boundary: { x: 0, y: 0, w: 30, h: 20 },
      codes: [makeTextCode({ text: 'AB', deltaX: [5, 5] })],
    });
    const prepared = makePrepared({ page: textPage(object) });
    const mm = collectTextPageMm(prepared, { includeChars: false });
    expect(mm.items[0].text).toBe('AB');
    expect(mm.items[0].charCount).toBe(2);
    expect(mm.items[0].chars).toBeUndefined();
    expect(mm.charCount).toBe(2);
  });

  it('不可见文字默认跳过；includeInvisible 保留且 visible=false', () => {
    const hidden = makeTextObject({
      id: 'hidden',
      boundary: { x: 0, y: 0, w: 30, h: 20 },
      visible: false,
      codes: [makeTextCode({ text: 'A' })],
    });
    const prepared = makePrepared({ page: textPage(hidden) });
    expect(collectTextPageMm(prepared).items).toHaveLength(0);
    const visible = collectTextPageMm(prepared, { includeInvisible: true });
    expect(visible.items).toHaveLength(1);
    expect(visible.items[0].visible).toBe(false);
  });

  it('无 fill/stroke 或零 Boundary 的文字不进入文本层', () => {
    const noPaint = makeTextObject({
      id: 'no-paint',
      boundary: { x: 0, y: 0, w: 30, h: 20 },
      codes: [makeTextCode({ text: 'A' })],
    });
    const zero = makeTextObject({
      id: 'zero',
      boundary: { x: 0, y: 0, w: 0, h: 20 },
      codes: [makeTextCode({ text: 'A' })],
    });
    const prepared = makePrepared({
      page: makePage({
        layers: [{ type: 'Body', children: [noPaint, zero] }],
      }),
      styles: new Map([[noPaint, createStyle({ fill: false, stroke: false })]]),
    });
    expect(collectTextPageMm(prepared).items).toHaveLength(0);
  });

  it('过滤 XML 排版 CR/LF，保留普通空格与全部可见码点', () => {
    const object = makeTextObject({
      boundary: { x: 0, y: 0, w: 30, h: 20 },
      codes: [makeTextCode({ text: '\r\nA B', deltaX: [5, 5, 5] })],
    });
    const prepared = makePrepared({ page: textPage(object) });
    const item = collectTextPageMm(prepared).items[0];
    expect(item.text).toBe('A B');
    expect(item.charCount).toBe(3);
    expect(item.chars?.map((char) => char.text)).toEqual(['A', ' ', 'B']);
    expect(item.chars?.[1].glyphId).toBeUndefined();
    expect(item.chars?.[1].advance).toBe(0);
  });

  it('缺失字形保留字符项，advance=0 且四点为起点', () => {
    const object = makeTextObject({
      boundary: { x: 0, y: 0, w: 30, h: 20 },
      size: 10,
      codes: [makeTextCode({ text: 'A?', deltaX: [5, 5] })],
    });
    const prepared = makePrepared({ page: textPage(object) });
    const item = collectTextPageMm(prepared).items[0];
    const missing = item.chars?.[1];
    expect(missing?.text).toBe('?');
    expect(missing?.glyphId).toBeUndefined();
    expect(missing?.faceKey).toBeUndefined();
    expect(missing?.advance).toBe(0);
    expect(missing?.rect).toEqual({ x: 5, y: 0, width: 0, height: 0 });
    expect(missing?.quad.every((point) => point.x === 5 && point.y === 0)).toBe(true);
  });

  it('连字/多字形 run 的字符使用组框近似', () => {
    const object = makeTextObject({
      boundary: { x: 0, y: 0, w: 30, h: 20 },
      size: 10,
      codes: [
        makeTextCode({
          text: 'AB',
          deltaX: [10, 0],
          cgTransforms: [{ codePosition: 0, codeCount: 2, glyphCount: 1, glyphs: [9] }],
        }),
      ],
    });
    const face = createFakeFace({
      key: 'ligature',
      glyphs: [{ gid: 9, advanceWidth: 1000 }],
    });
    const prepared = makePrepared({ page: textPage(object) });
    prepared.fonts = new Map([['1', createFakeFaceSet(face)]]);
    const item = collectTextPageMm(prepared).items[0];
    expect(item.chars).toHaveLength(2);
    expect(item.chars![0].approximate).toBe(true);
    expect(item.chars![1].approximate).toBe(true);
    expect(item.chars![0].glyphId).toBeUndefined();
    expect(item.chars![0].advance).toBe(10);
    expect(item.chars![1].origin).toEqual(item.chars![0].origin);
  });
});

describe('文本内容收集 - 图层、模板、复合与注释', () => {
  it('type/document 顺序复用绘制顺序，模板带 templateId/zOrder', () => {
    const templateText = makeTextObject({
      id: 'template-text',
      boundary: { x: 0, y: 0, w: 20, h: 10 },
      codes: [makeTextCode({ text: 'T' })],
    });
    const pageText = makeTextObject({
      id: 'page-text',
      boundary: { x: 0, y: 10, w: 20, h: 10 },
      codes: [makeTextCode({ text: 'P' })],
    });
    const template = makePage({
      id: 'tmpl-1',
      layers: [
        { type: 'Background', children: [] },
        { type: 'Body', children: [templateText] },
      ],
    });
    const page = makePage({
      templates: [{ id: 'tmpl-1', zOrder: 'Body' }],
      layers: [{ type: 'Body', children: [pageText] }],
    });
    const prepared = makePrepared({ page, templates: [template] });
    const type = collectTextPageMm(prepared, { layerOrder: 'type' });
    expect(type.items.map((item) => item.objectId)).toEqual(['template-text', 'page-text']);
    expect(type.items[0]).toMatchObject({
      layer: 'template',
      templateId: 'tmpl-1',
      zOrder: 'Body',
      layerType: 'Body',
    });
    expect(type.items[1].templateId).toBeUndefined();
    expect(type.items[1].zOrder).toBeUndefined();

    const document = collectTextPageMm(prepared, { layerOrder: 'document' });
    expect(document.items.map((item) => item.objectId)).toEqual(['template-text', 'page-text']);
  });

  it('模板缺省 ZOrder 归入 Background；document 保持 XML 顺序', () => {
    const templateText = makeTextObject({
      id: 'template-text',
      boundary: { x: 0, y: 0, w: 20, h: 10 },
      codes: [makeTextCode({ text: 'T' })],
    });
    const bodyText = makeTextObject({
      id: 'body-text',
      boundary: { x: 0, y: 10, w: 20, h: 10 },
      codes: [makeTextCode({ text: 'B' })],
    });
    const backgroundText = makeTextObject({
      id: 'background-text',
      boundary: { x: 0, y: 20, w: 20, h: 10 },
      codes: [makeTextCode({ text: 'G' })],
    });
    const template = makePage({
      id: 'tmpl-default',
      layers: [{ type: 'Body', children: [templateText] }],
    });
    const page = makePage({
      templates: [{ id: 'tmpl-default' }],
      // document 模式验证 XML 顺序：Body 在 Background 前。
      layers: [
        { type: 'Body', children: [bodyText] },
        { type: 'Background', children: [backgroundText] },
      ],
    });
    const prepared = makePrepared({ page, templates: [template] });
    const type = collectTextPageMm(prepared, { layerOrder: 'type' });
    expect(type.items.map((item) => item.objectId)).toEqual([
      'template-text',
      'background-text',
      'body-text',
    ]);
    expect(type.items[0].zOrder).toBe('Background');
    const document = collectTextPageMm(prepared, { layerOrder: 'document' });
    expect(document.items.map((item) => item.objectId)).toEqual([
      'template-text',
      'body-text',
      'background-text',
    ]);
  });

  it('Pattern cell 与 ClipArea.text 不进入文本内容', () => {
    const clipText = makeTextObject({
      id: 'clip-text',
      boundary: { x: 0, y: 0, w: 20, h: 10 },
      codes: [makeTextCode({ text: 'C' })],
    });
    const path = {
      kind: 'path' as const,
      id: 'path-1',
      boundary: { x: 0, y: 0, w: 20, h: 10 },
      alpha: 255,
      visible: true,
      fill: true,
      stroke: false,
      data: 'M0 0L10 0L10 10Z',
      rule: 'nonzero' as const,
      clips: [{ areas: [{ kind: 'text' as const, text: clipText }] }],
    };
    const composite = {
      kind: 'composite' as const,
      resourceId: 'pattern-cell',
      boundary: { x: 0, y: 0, w: 10, h: 10 },
      alpha: 255,
      visible: true,
    };
    const page = makePage({ layers: [{ type: 'Body', children: [path, composite] }] });
    const patternText = makeTextObject({
      id: 'pattern-text',
      boundary: { x: 0, y: 0, w: 10, h: 10 },
      codes: [makeTextCode({ text: 'P' })],
    });
    const prepared = makePrepared({ page });
    (prepared.blocks as Map<string, import('../../src/model/types').IndependentBlock>).set('pattern-cell', {
      id: 'pattern-cell',
      source: 'pattern-cell',
      space: { width: 10, height: 10 },
      content: { kind: 'block', children: [patternText] },
      styleRoot: createStyle(),
      cacheKey: 'pattern-cell',
      displayList: { commands: [], bounds: { x: 0, y: 0, w: 10, h: 10 } },
    });
    expect(collectTextPageMm(prepared).items).toHaveLength(0);
  });

  it('复合对象递归一次生成一组 item，并继承外层层与 blockId', () => {
    const child = makeTextObject({
      id: 'child',
      boundary: { x: 1, y: 2, w: 10, h: 5 },
      codes: [makeTextCode({ text: 'C' })],
    });
    const block: PageBlock = { kind: 'block', children: [child] };
    const composite = {
      kind: 'composite' as const,
      id: 'comp-1',
      resourceId: 'c1',
      boundary: { x: 5, y: 6, w: 20, h: 10 },
      alpha: 255,
      visible: true,
    };
    const page = makePage({ layers: [{ type: 'Body', children: [composite] }] });
    const prepared = makePrepared({ page, blocks: new Map([['c1', block]]) });
    const item = collectTextPageMm(prepared).items[0];
    expect(item.objectId).toBe('child');
    expect(item.blockId).toBe('c1');
    expect(item.layer).toBe('page');
    expectClose(item.origin.x, 6);
    expectClose(item.origin.y, 8);
  });

  it('注释默认不收集，includeAnnotations=true 时最后加入并带 annotationId', () => {
    const pageText = makeTextObject({
      id: 'page-text',
      boundary: { x: 0, y: 0, w: 20, h: 10 },
      codes: [makeTextCode({ text: 'P' })],
    });
    const annotationText = makeTextObject({
      id: 'ann-text',
      boundary: { x: 1, y: 1, w: 20, h: 10 },
      codes: [makeTextCode({ text: 'N' })],
    });
    const page = makePage({ layers: [{ type: 'Body', children: [pageText] }] });
    const prepared = makePrepared({
      page,
      annotationBlocks: [{ kind: 'block', children: [annotationText] }],
    });
    expect(collectTextPageMm(prepared).items).toHaveLength(1);
    const withAnnotations = collectTextPageMm(prepared, { includeAnnotations: true });
    expect(withAnnotations.items.map((item) => item.objectId)).toEqual(['page-text', 'ann-text']);
    expect(withAnnotations.items[1]).toMatchObject({
      layer: 'annotation',
      layerType: 'Body',
      annotationId: 'annot-1',
    });
    // 注释外层 Boundary (5,6) + 对象 Boundary (1,1)
    expectClose(withAnnotations.items[1].origin.x, 6);
    expectClose(withAnnotations.items[1].origin.y, 7);
  });

  it('已取消的 signal 抛 OFD_ABORTED', () => {
    const object = makeTextObject({
      boundary: { x: 0, y: 0, w: 20, h: 10 },
      codes: [makeTextCode({ text: 'A' })],
    });
    const prepared = makePrepared({ page: textPage(object) });
    const controller = new AbortController();
    controller.abort();
    let code: string | undefined;
    try {
      collectTextPageMm(prepared, { signal: controller.signal });
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('OFD_ABORTED');
  });

  it('空页返回空数组与零计数', () => {
    const mm = collectTextPageMm(makePrepared());
    expect(mm.items).toEqual([]);
    expect(mm.itemCount).toBe(0);
    expect(mm.charCount).toBe(0);
    expect(mm.truncated).toEqual({ items: false, chars: false });
  });
});

describe('文本内容收集 - 上限', () => {
  it('达到 maxTextItems 时停止并上报 W_TEXT_ITEM_LIMIT', () => {
    const first = makeTextObject({
      id: 'first',
      boundary: { x: 0, y: 0, w: 20, h: 10 },
      codes: [makeTextCode({ text: 'A' })],
    });
    const second = makeTextObject({
      id: 'second',
      boundary: { x: 0, y: 10, w: 20, h: 10 },
      codes: [makeTextCode({ text: 'B' })],
    });
    const prepared = makePrepared({
      page: makePage({ layers: [{ type: 'Body', children: [first, second] }] }),
    });
    const warnings: string[] = [];
    const mm = collectTextPageMm(prepared, {
      maxTextItems: 1,
      onWarning: (code) => warnings.push(code),
    });
    expect(mm.items).toHaveLength(1);
    expect(mm.items[0].objectId).toBe('first');
    expect(mm.truncated.items).toBe(true);
    expect(warnings).toContain('W_TEXT_ITEM_LIMIT');
  });

  it('达到 maxTextChars 时不加入半个 item 并上报 W_TEXT_CHAR_LIMIT', () => {
    const object = makeTextObject({
      id: 'long',
      boundary: { x: 0, y: 0, w: 20, h: 10 },
      codes: [makeTextCode({ text: 'ABC' })],
    });
    const prepared = makePrepared({ page: textPage(object) });
    const warnings: string[] = [];
    const mm = collectTextPageMm(prepared, {
      maxTextChars: 2,
      onWarning: (code) => warnings.push(code),
    });
    expect(mm.items).toHaveLength(0);
    expect(mm.charCount).toBe(0);
    expect(mm.truncated.chars).toBe(true);
    expect(warnings).toContain('W_TEXT_CHAR_LIMIT');
  });
});
