/**
 * T6b 准备阶段单测：资源收集、并行加载、样式结算、模板/注释与独立块。
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  Annotation,
  CompositeGraphicUnit,
  FontResource,
  ImageResource,
  PageModel,
  PageObject,
} from '../../src/model/types';
import type { PageResourceScope } from '../../src/resource/types';
import type { DecodedImage } from '../../src/common/types';
import type { FontFaceSet } from '../../src/font/types';
import type { PreparePageLoader } from '../../src/render/prepare';
import { preparePage } from '../../src/render/prepare';

/** 构造最小页面。 */
function page(layers: PageModel['layers'], templates: PageModel['templates'] = []): PageModel {
  return {
    id: 'p1',
    area: { x: 0, y: 0, w: 210, h: 297 },
    size: { width: 210, height: 297 },
    layers,
    templates,
    pageRes: [],
  };
}

/** 构造路径对象。 */
function path(id: string, boundary = { x: 0, y: 0, w: 10, h: 10 }): PageObject {
  return {
    kind: 'path',
    id,
    boundary,
    alpha: 255,
    visible: true,
    data: 'M0 0 L10 0 L10 10 Z',
    fill: true,
    stroke: false,
    rule: 'nonzero',
  };
}

/** 构造图片对象。 */
function image(id: string, resourceId: string, extra: Record<string, unknown> = {}): PageObject {
  return {
    kind: 'image',
    id,
    resourceId,
    boundary: { x: 0, y: 0, w: 10, h: 10 },
    ctm: [10, 0, 0, 10, 0, 0],
    alpha: 255,
    visible: true,
    ...extra,
  };
}

/** 构造资源作用域。 */
function scope(input: {
  fonts?: FontResource[];
  images?: ImageResource[];
  composites?: CompositeGraphicUnit[];
}): PageResourceScope {
  const fonts = new Map((input.fonts ?? []).map((item) => [item.id, item]));
  const images = new Map((input.images ?? []).map((item) => [item.id, item]));
  const composites = new Map((input.composites ?? []).map((item) => [item.id, item]));
  const empty = new Map();
  return {
    pageId: 'p1',
    templateIds: [],
    fonts,
    images,
    drawParams: empty,
    compositeGraphicUnits: composites,
    patterns: empty,
    colorSpaces: empty,
    getFont: (id: string) => fonts.get(id),
    getImage: (id: string) => images.get(id),
    getDrawParam: (_id: string) => undefined,
    getComposite: (id: string) => composites.get(id),
    getPattern: (_id: string) => undefined,
  };
}

/** 构造解码图片。 */
function decoded(width = 2, height = 2): DecodedImage {
  return {
    width,
    height,
    data: { width, height, data: new Uint8ClampedArray(width * height * 4) },
    kind: 'imagedata',
  };
}

/** 构造 loader。 */
function loader(input: {
  templates?: PageModel[];
  annotations?: Annotation[];
  images?: Record<string, DecodedImage>;
  fonts?: Record<string, FontFaceSet>;
  onTemplate?: (ref: unknown) => void;
}): PreparePageLoader {
  return {
    async loadFontFaces(resources) {
      const result = new Map();
      for (const font of resources) {
        const faces = input.fonts?.[font.id];
        if (faces) result.set(font.id, faces);
      }
      return result;
    },
    async decodeImage(resource) {
      const value = input.images?.[resource.id];
      if (!value) throw new Error(`missing ${resource.id}`);
      return value;
    },
    async loadTemplatePage(ref) {
      input.onTemplate?.(ref);
      const model = input.templates?.find((item) => item.id === ref.id);
      if (!model) throw new Error('missing template');
      return model;
    },
    async loadAnnotations() {
      return input.annotations ?? [];
    },
  };
}

/** 构造字体占位。 */
function fakeFaces(): FontFaceSet {
  return { primary: {}, fallbacks: [] } as unknown as FontFaceSet;
}

describe('preparePage', () => {
  it('收集并并行加载去重后的字体/图片，结算样式并构建独立块', async () => {
    const font: FontResource = {
      id: 'f1',
      fontName: 'F',
      charset: 'unicode',
      serif: false,
      bold: false,
      italic: false,
      fixedSize: false,
    };
    const imageRes: ImageResource = { id: 'i1', mediaFile: 'img.png', format: 'png' };
    const unit: CompositeGraphicUnit = {
      id: 'c1',
      width: 100,
      height: 50,
      content: { kind: 'block', children: [image('img-in-composite', 'i1')] },
    };
    const composite: PageObject = {
      kind: 'composite',
      id: 'comp1',
      resourceId: 'c1',
      boundary: { x: 0, y: 0, w: 30, h: 20 },
      alpha: 255,
      visible: true,
    };
    const model = page(
      [
        {
          type: 'Body',
          children: [
            {
              kind: 'text',
              id: 't1',
              font: 'f1',
              boundary: { x: 0, y: 0, w: 20, h: 5 },
              size: 3,
              hScale: 1,
              readDirection: 0,
              charDirection: 0,
              weight: 400,
              italic: false,
              fill: true,
              stroke: false,
              alpha: 255,
              visible: true,
              codes: [],
            },
            image('im1', 'i1'),
            image('im2', 'i1'),
            composite,
          ],
        },
      ],
      [{ id: 'tpl1', loc: 'tpl.xml', zOrder: 'Background' }],
    );
    const template = page(
      [{ type: 'Background', children: [image('tpl-img', 'i1')] }],
    );
    template.id = 'tpl1';

    const loadFontFaces = vi.fn(async () => new Map([['f1', fakeFaces()]]));
    const decodeImage = vi.fn(async () => decoded());
    const base = loader({ templates: [template], images: { i1: decoded() } });
    const bundle = await preparePage({
      page: model,
      resources: scope({ fonts: [font], images: [imageRes], composites: [unit] }),
      loader: { ...base, loadFontFaces, decodeImage },
    });

    expect(loadFontFaces).toHaveBeenCalledTimes(1);
    expect(decodeImage).toHaveBeenCalledTimes(1);
    expect(bundle.fonts.get('f1')).toBeDefined();
    expect(bundle.images.get('i1')?.width).toBe(2);
    expect(bundle.templates).toHaveLength(1);
    expect(bundle.page.styles.get(composite)).toBeDefined();
    expect(bundle.blocks.get('c1')?.source).toBe('composite');
    expect(bundle.blocks.get('c1')?.space).toEqual({ width: 35.28, height: 17.64 });
    expect(bundle.page.annotationBlocks).toEqual([]);
  });

  it('注释为空/不可见/无边界时跳过并 warning', async () => {
    const warnings: string[] = [];
    const annotations: Annotation[] = [
      { id: 'a1', type: 'Stamp', visible: false, appearance: { kind: 'block', children: [path('p')] } },
      { id: 'a2', type: 'Stamp', visible: true },
      {
        id: 'a3',
        type: 'Watermark',
        visible: true,
        appearance: { kind: 'block', children: [path('p2')] },
        boundary: { x: 1, y: 2, w: 0, h: 10 },
      },
      {
        id: 'a4',
        type: 'Stamp',
        visible: true,
        appearance: { kind: 'block', children: [path('p3')] },
        boundary: { x: 10, y: 20, w: 30, h: 40 },
      },
    ];
    const annotated = page([]);
    annotated.annotationFile = 'Annots/Annotations.xml';
    const bundle = await preparePage({
      page: annotated,
      resources: scope({}),
      loader: loader({ annotations }),
      onWarning: (warning) => warnings.push(warning.code),
    });

    expect(bundle.page.annotationBlocks).toHaveLength(1);
    expect(bundle.page.annotationBlocks[0]?.boundary).toEqual({ x: 10, y: 20, w: 30, h: 40 });
    expect(warnings).toContain('W_ANNOT_EMPTY');
  });

  it('复合资源循环引用时 warning 并返回空内容块', async () => {
    const cyclic: CompositeGraphicUnit = {
      id: 'c1',
      width: 10,
      height: 10,
      content: {
        kind: 'block',
        children: [
          {
            kind: 'composite',
            id: 'self',
            resourceId: 'c1',
            boundary: { x: 0, y: 0, w: 10, h: 10 },
            alpha: 255,
            visible: true,
          },
        ],
      },
    };
    const warnings: string[] = [];
    const bundle = await preparePage({
      page: page([
        {
          type: 'Body',
          children: [
            {
              kind: 'composite',
              id: 'root',
              resourceId: 'c1',
              boundary: { x: 0, y: 0, w: 10, h: 10 },
              alpha: 255,
              visible: true,
            },
          ],
        },
      ]),
      resources: scope({ composites: [cyclic] }),
      loader: loader({}),
      onWarning: (warning) => warnings.push(warning.code),
    });
    expect(warnings).toContain('W_COMPOSITE_DEPTH');
    expect(bundle.blocks.get('c1')).toBeDefined();
  });
});