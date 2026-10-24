/**
 * 文本层内容过滤测试：与绘制共用 resolvePageDrawOrder，隐藏的层/模板/注释类型不进入文本。
 */

import { describe, expect, it } from 'vitest';
import type { PageModel, TextObject } from '../../src/model/types';
import type { FontFaceSet } from '../../src/font/types';
import type { ResolvedStyle } from '../../src/style/types';
import { setBlockStyles } from '../../src/render/object';
import { collectTextPageMm } from '../../src/render/text-content';
import type { TextContentCollectOptions } from '../../src/render/text-content';
import {
  createFakeFace,
  createFakeFaceSet,
  createStyle,
  makeTextCode,
  makeTextObject,
} from '../text-layout/fake-font';

/** 假字体：A 的 advance 为 500 字体单位。 */
function makeFaces(): FontFaceSet {
  return createFakeFaceSet(
    createFakeFace({
      key: 'face-a',
      family: 'Content Sans',
      glyphs: [{ gid: 1, codePoints: [0x41], advanceWidth: 500 }],
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

/** 创建一行文字的 TextObject。 */
function text(id: string, y = 0): TextObject {
  return makeTextObject({
    id,
    boundary: { x: 0, y, w: 20, h: 10 },
    codes: [makeTextCode({ text: 'A' })],
  });
}

/**
 * 构造已准备页面：页面层、模板层与注释块都建立样式映射。
 *
 * @param options 页面、模板、注释文字与注释类型。
 * @returns 最小可用的 PreparedPageBundle。
 */
function makePrepared(
  options: {
    page: PageModel;
    templates?: PageModel[];
    annotations?: { type?: string; object: TextObject }[];
  },
): Parameters<typeof collectTextPageMm>[0] {
  const styles = new WeakMap<object, ResolvedStyle>();
  const addTree = (objects: readonly import('../../src/model/types').PageObject[]): void => {
    for (const object of objects) {
      styles.set(object, createStyle());
      if (object.kind === 'block') addTree(object.children);
    }
  };
  addTree(options.page.layers.flatMap((layer) => layer.children));
  for (const template of options.templates ?? []) {
    addTree(template.layers.flatMap((layer) => layer.children));
  }
  const annotationBlocks = (options.annotations ?? []).map((entry, index) => {
    const content = { kind: 'block' as const, children: [entry.object] };
    addTree(content.children);
    const block = {
      id: `annot-${index + 1}`,
      source: 'annotation' as const,
      space: { width: 100, height: 50 },
      boundary: { x: 5, y: 6, w: 100, h: 50 },
      content,
      styleRoot: createStyle(),
      cacheKey: `annot-${index + 1}`,
      displayList: { commands: [], bounds: { x: 0, y: 0, w: 100, h: 50 } },
      ...(entry.type !== undefined ? { annotationType: entry.type } : {}),
    };
    const blockStyles = new WeakMap<import('../../src/model/types').GraphicUnitBase, ResolvedStyle>();
    blockStyles.set(entry.object, createStyle());
    setBlockStyles(block, blockStyles);
    return block;
  });
  return {
    page: {
      page: options.page,
      styles: styles as WeakMap<import('../../src/model/types').GraphicUnitBase, ResolvedStyle>,
      annotationBlocks,
    },
    templates: options.templates ?? [],
    fonts: new Map([['1', makeFaces()]]),
    images: new Map(),
    blocks: new Map(),
    signatureBlocks: [],
  };
}

/** 三个图层各一行文字的页面；模板 tmpl-1 归属 Body 层。 */
function layeredPrepared(): ReturnType<typeof makePrepared> {
  const template = makePage({
    id: 'tmpl-1',
    layers: [{ type: 'Body', children: [text('template-text')] }],
  });
  const page = makePage({
    templates: [{ id: 'tmpl-1', zOrder: 'Body' }],
    layers: [
      { type: 'Background', children: [text('background-text', 0)] },
      { type: 'Body', children: [text('body-text', 10)] },
      { type: 'Foreground', children: [text('foreground-text', 20)] },
    ],
  });
  return makePrepared({
    page,
    templates: [template],
    annotations: [
      { type: 'Stamp', object: text('stamp-annot', 30) },
      { type: 'Highlight', object: text('highlight-annot', 40) },
    ],
  });
}

/** 取文本项的 objectId 列表。 */
function objectIds(prepared: ReturnType<typeof makePrepared>, options: TextContentCollectOptions = {}): string[] {
  return collectTextPageMm(prepared, options).items.map((item) => String(item.objectId));
}

describe('文本层内容过滤', () => {
  it('未传 filter 时全画，与旧行为一致', () => {
    const prepared = layeredPrepared();
    // 绘制顺序：Background 页面层 → Body 模板 → Body 页面层 → Foreground。
    const all = ['background-text', 'template-text', 'body-text', 'foreground-text'];
    expect(objectIds(prepared)).toEqual(all);
    expect(objectIds(prepared, { contentFilter: undefined })).toEqual(all);
  });

  it('传 filter 后隐藏层不进入文本', () => {
    const prepared = layeredPrepared();
    expect(objectIds(prepared, { contentFilter: { layers: { body: true } } })).toEqual([
      'template-text',
      'body-text',
    ]);
    expect(objectIds(prepared, { contentFilter: {} })).toEqual([]);
  });

  it('隐藏模板不影响同层页面文字', () => {
    const prepared = layeredPrepared();
    expect(
      objectIds(prepared, { contentFilter: { layers: { body: { page: true } } } }),
    ).toEqual(['body-text']);
    expect(
      objectIds(prepared, { contentFilter: { layers: { body: { templates: true } } } }),
    ).toEqual(['template-text']);
  });

  it('注释类型过滤：文本层与画面一致', () => {
    const prepared = layeredPrepared();
    const base = { contentFilter: { annotationTypes: ['Stamp'] } } as const;
    // 默认不收集注释。
    expect(objectIds(prepared, base)).toEqual([]);
    expect(objectIds(prepared, { ...base, includeAnnotations: true })).toEqual(['stamp-annot']);
    expect(
      objectIds(prepared, {
        contentFilter: { annotationTypes: ['Highlight'] },
        includeAnnotations: true,
      }),
    ).toEqual(['highlight-annot']);
    expect(
      objectIds(prepared, {
        contentFilter: { annotations: true },
        includeAnnotations: true,
      }),
    ).toEqual(['stamp-annot', 'highlight-annot']);
    // annotations:false 优先于类型列表。
    expect(
      objectIds(prepared, {
        contentFilter: { annotations: false, annotationTypes: ['Stamp'] },
        includeAnnotations: true,
      }),
    ).toEqual([]);
  });

  it('白名单注释无需图层配置也能收集文字', () => {
    const prepared = layeredPrepared();
    expect(
      objectIds(prepared, {
        contentFilter: { annotationTypes: ['Stamp'] },
        includeAnnotations: true,
      }),
    ).toEqual(['stamp-annot']);
  });

  it('过滤变化使文本结果变化（对应缓存键需包含过滤签名）', () => {
    const prepared = layeredPrepared();
    const all = objectIds(prepared);
    const bodyOnly = objectIds(prepared, { contentFilter: { layers: { body: true } } });
    expect(bodyOnly).not.toEqual(all);
    // 同一 prepared 上重复收集同一过滤，结果稳定。
    expect(objectIds(prepared, { contentFilter: { layers: { body: true } } })).toEqual(bodyOnly);
  });
});
