/**
 * 页级绘制内容过滤接入测试：resolvePageDrawOrder 图层/模板/注释白名单、drawPage 注释与签章开关。
 */

import { describe, expect, it } from 'vitest';
import type { DecodedImage, Viewport } from '../../src/common/types';
import type {
  Annotation,
  PageModel,
  PageObject,
  SealImage,
  SignatureStamp,
} from '../../src/model/types';
import type { PageResourceScope } from '../../src/resource/types';
import type { CanvasRenderingContext2DLike } from '../../src/renderer/types';
import type { PageContentFilter } from '../../src/render/content-filter';
import type { PreparePageLoader, SignatureStampSource } from '../../src/render/prepare';
import { preparePage } from '../../src/render/prepare';
import { drawPage, resolvePageDrawOrder } from '../../src/render/page';
import { FakeRenderer } from './path/fake-renderer';

/** 构造路径对象。 */
function path(id: string, x = 0, y = 0, w = 10, h = 10): PageObject {
  return {
    kind: 'path',
    id,
    boundary: { x, y, w, h },
    alpha: 255,
    visible: true,
    data: 'M0 0 L10 0 L10 10 Z',
    fill: true,
    stroke: false,
    rule: 'nonzero',
  };
}

/** 绘制视口：A4 页面在 96 DPI 下的像素尺寸。 */
const VIEWPORT: Viewport = { width: 794, height: 1123, dpi: 96 };

/** 绘制用 2D 上下文占位；假渲染器不读取内容。 */
const CANVAS = {} as CanvasRenderingContext2DLike;

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

/** 构造空资源作用域。 */
function scope(): PageResourceScope {
  const empty = new Map();
  return {
    pageId: 'p1',
    templateIds: [],
    fonts: empty,
    images: empty,
    drawParams: empty,
    compositeGraphicUnits: empty,
    patterns: empty,
    colorSpaces: empty,
    getFont: () => undefined,
    getImage: () => undefined,
    getDrawParam: () => undefined,
    getComposite: () => undefined,
    getPattern: () => undefined,
  };
}

/** 构造 2×2 的已解码图片。 */
function decoded(): DecodedImage {
  return {
    width: 2,
    height: 2,
    kind: 'imagedata',
    data: { width: 2, height: 2, data: new Uint8ClampedArray(16) },
  };
}

/** 构造 Seal 图片元数据。 */
function seal(): SealImage {
  return { version: 'v4', type: 'PNG', data: new Uint8Array([1, 2, 3]), width: 40, height: 40 };
}

/** 构造签章戳记。 */
function stamp(id: string): SignatureStamp {
  return { id, pageId: 'p1', boundary: { x: 50, y: 60, w: 40, h: 40 } };
}

/** 构造测试 loader。 */
function loader(input: {
  templates?: PageModel[];
  annotations?: Annotation[];
  signatures?: SignatureStampSource[];
} = {}): PreparePageLoader {
  return {
    async loadFontFaces() {
      return new Map();
    },
    async decodeImage() {
      return decoded();
    },
    async loadTemplatePage(ref) {
      const model = input.templates?.find((item) => item.id === ref.id);
      if (!model) throw new Error('missing template');
      return model;
    },
    async loadAnnotations() {
      return input.annotations ?? [];
    },
    async loadSignatureStamps() {
      return input.signatures ?? [];
    },
    async decodeSeal() {
      return decoded();
    },
  };
}

/** 构造带三个图层对象的页面：背景/正文/前景。 */
function layeredPage(): PageModel {
  return page([
    { type: 'Background', children: [path('pb', 1)] },
    { type: 'Body', children: [path('po', 2)] },
    { type: 'Foreground', children: [path('pf', 3)] },
    { type: 'Custom', children: [path('pc', 4)] },
  ]);
}

/**
 * 统计绘制期签章块的放置平移次数。
 *
 * 签章块只能按 StampAnnot Boundary（本文件为 (50,60)）平移；取不到有效图片时会被
 * 跳过并记 warning，因此以 translate(50,60) 作为“签章是否参与绘制”的判据。
 *
 * @param renderer 假渲染器。
 * @returns 签章放置平移次数。
 */
function signatureTranslates(renderer: FakeRenderer): number {
  return renderer.callsOf('translate').filter((call) => call.args[1] === 60).length;
}

/** 展开顺序中的页面对象 ID。 */
function pageObjectIds(entries: ReturnType<typeof resolvePageDrawOrder>): string[] {
  return entries.flatMap((entry) =>
    entry.kind === 'page' ? entry.objects.map((object) => String(object.id)) : [],
  );
}

/** 展开顺序中的模板对象 ID。 */
function templateObjectIds(entries: ReturnType<typeof resolvePageDrawOrder>): string[] {
  return entries.flatMap((entry) =>
    entry.kind === 'template' ? entry.objects.map((object) => String(object.id)) : [],
  );
}

describe('resolvePageDrawOrder 内容过滤', () => {
  it('未传 filter 时输出与旧行为一致', async () => {
    const template = page([{ type: 'Background', children: [path('tb', 1)] }]);
    template.id = 'tpl1';
    const bundle = await preparePage({
      page: page(layeredPage().layers, [{ id: 'tpl1', zOrder: 'Background' }]),
      resources: scope(),
      loader: loader({ templates: [template] }),
    });
    const baseline = resolvePageDrawOrder(bundle);
    const withFilter = resolvePageDrawOrder(bundle, { contentFilter: undefined });
    expect(withFilter).toEqual(baseline);
    expect(pageObjectIds(baseline)).toEqual(['pb', 'po', 'pf', 'pc']);
    expect(templateObjectIds(baseline)).toEqual(['tb']);
  });

  it('只画某层（页面 + 模板）', async () => {
    const template = page([{ type: 'Background', children: [path('tb', 1)] }]);
    template.id = 'tpl1';
    const bundle = await preparePage({
      page: page(layeredPage().layers, [{ id: 'tpl1', zOrder: 'Background' }]),
      resources: scope(),
      loader: loader({ templates: [template] }),
    });
    const entries = resolvePageDrawOrder(bundle, { contentFilter: { layers: { body: true } } });
    expect(pageObjectIds(entries)).toEqual(['po']);
    expect(templateObjectIds(entries)).toEqual([]);
  });

  it('只画某层页面内容，模板不受影响', async () => {
    const template = page([{ type: 'Body', children: [path('tbo', 1)] }]);
    template.id = 'tpl1';
    const bundle = await preparePage({
      page: page(layeredPage().layers, [{ id: 'tpl1', zOrder: 'Body' }]),
      resources: scope(),
      loader: loader({ templates: [template] }),
    });
    const pageOnly = resolvePageDrawOrder(bundle, {
      contentFilter: { layers: { body: { page: true } } },
    });
    expect(pageObjectIds(pageOnly)).toEqual(['po']);
    expect(templateObjectIds(pageOnly)).toEqual([]);
  });

  it('只画某层模板，页面内容不受影响', async () => {
    const template = page([{ type: 'Body', children: [path('tbo', 1)] }]);
    template.id = 'tpl1';
    const bundle = await preparePage({
      page: page(layeredPage().layers, [{ id: 'tpl1', zOrder: 'Body' }]),
      resources: scope(),
      loader: loader({ templates: [template] }),
    });
    const templateOnly = resolvePageDrawOrder(bundle, {
      contentFilter: { layers: { body: { templates: true } } },
    });
    expect(pageObjectIds(templateOnly)).toEqual([]);
    expect(templateObjectIds(templateOnly)).toEqual(['tbo']);
  });

  it('模板按 ZOrder 过滤，不看模板内部 Layer/@Type', async () => {
    const template = page([
      { type: 'Body', children: [path('t-body', 1)] },
      { type: 'Foreground', children: [path('t-fg', 2)] },
    ]);
    template.id = 'tpl1';
    const bundle = await preparePage({
      page: page(layeredPage().layers, [{ id: 'tpl1', zOrder: 'Background' }]),
      resources: scope(),
      loader: loader({ templates: [template] }),
    });
    // 只画背景模板：模板整体绘制，即使内部有 Body/Foreground 图层。
    const backgroundTemplate = resolvePageDrawOrder(bundle, {
      contentFilter: { layers: { background: { templates: true } } },
    });
    expect(templateObjectIds(backgroundTemplate)).toEqual(['t-body', 't-fg']);
    // 只画正文（含模板）：Background 归属的模板不画。
    const body = resolvePageDrawOrder(bundle, { contentFilter: { layers: { body: true } } });
    expect(templateObjectIds(body)).toEqual([]);
  });

  it('document 与 type 两种顺序都应用同一过滤', async () => {
    const template = page([{ type: 'Body', children: [path('tbo', 1)] }]);
    template.id = 'tpl1';
    const bundle = await preparePage({
      page: page(layeredPage().layers, [{ id: 'tpl1', zOrder: 'Background' }]),
      resources: scope(),
      loader: loader({ templates: [template] }),
    });
    const filter: PageContentFilter = { layers: { background: true, foreground: true } };
    const documentOrder = resolvePageDrawOrder(bundle, { layerOrder: 'document', contentFilter: filter });
    const typeOrder = resolvePageDrawOrder(bundle, { layerOrder: 'type', contentFilter: filter });
    for (const entries of [documentOrder, typeOrder]) {
      expect(pageObjectIds(entries)).toEqual(['pb', 'pf']);
      expect(templateObjectIds(entries)).toEqual(['tbo']);
    }
  });

  it('PageDrawEntry.layerType 仍是模板内部图层类型', async () => {
    const template = page([{ type: 'Body', children: [path('tbo', 1)] }]);
    template.id = 'tpl1';
    const bundle = await preparePage({
      page: page([], [{ id: 'tpl1', zOrder: 'Foreground' }]),
      resources: scope(),
      loader: loader({ templates: [template] }),
    });
    const entries = resolvePageDrawOrder(bundle, {
      contentFilter: { layers: { foreground: { templates: true } } },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'template', layerType: 'Body', zOrder: 'Foreground' });
  });

  it('注释 entry 按类型白名单过滤', async () => {
    const bundle = await preparePage({
      page: { ...layeredPage(), annotationFile: 'Page/Page_0/Annotation.xml' },
      resources: scope(),
      loader: loader({
        annotations: [
          { id: 'an-stamp', type: 'Stamp', visible: true, appearance: { kind: 'block', children: [path('as', 1)] }, boundary: { x: 0, y: 0, w: 10, h: 10 } },
          { id: 'an-link', type: 'Link', visible: true, appearance: { kind: 'block', children: [path('al', 1)] }, boundary: { x: 0, y: 0, w: 10, h: 10 } },
        ],
      }),
    });
    const annotationIds = (filter?: PageContentFilter): string[] =>
      resolvePageDrawOrder(bundle, { includeAnnotations: true, contentFilter: filter }).flatMap(
        (entry) => (entry.kind === 'annotation' ? [String(entry.block.id)] : []),
      );
    expect(annotationIds()).toEqual(['an-stamp', 'an-link']);
    expect(annotationIds({ annotationTypes: ['Stamp'] })).toEqual(['an-stamp']);
    expect(annotationIds({ annotations: true })).toEqual(['an-stamp', 'an-link']);
    expect(annotationIds({ annotationTypes: [] })).toEqual([]);
  });
});

describe('drawPage 内容过滤', () => {
  it('签名块对象只画白名单内的图层', async () => {
    const bundle = await preparePage({
      page: layeredPage(),
      resources: scope(),
      loader: loader(),
    });
    const renderer = new FakeRenderer();
    drawPage(bundle, renderer, CANVAS, VIEWPORT, {
      contentFilter: { layers: { body: true } },
    });
    // 只画正文：四个路径对象中仅 po 参与路径绘制（含页面裁剪路径）。
    expect(renderer.callsOf('moveTo')).toHaveLength(1);
    expect(renderer.callsOf('lineTo')).toHaveLength(2);
  });

  it('注释循环按类型过滤，签章按 signatures 开关', async () => {
    const annotations: Annotation[] = [
      { id: 'an-stamp', type: 'Stamp', visible: true, appearance: { kind: 'block', children: [path('as', 1)] }, boundary: { x: 0, y: 0, w: 10, h: 10 } },
      { id: 'an-link', type: 'Link', visible: true, appearance: { kind: 'block', children: [path('al', 1)] }, boundary: { x: 0, y: 0, w: 10, h: 10 } },
    ];
    const build = (items: Annotation[]): Promise<Awaited<ReturnType<typeof preparePage>>> =>
      preparePage({
        page: { ...layeredPage(), annotationFile: 'Page/Page_0/Annotation.xml' },
        resources: scope(),
        loader: loader({
          annotations: items,
          signatures: [{ signatureId: 'sig-1', stamp: stamp('s1'), seal: seal() }],
        }),
      });
    const bundle = await build(annotations);
    expect(bundle.page.annotationBlocks).toHaveLength(2);
    expect(bundle.signatureBlocks).toHaveLength(1);

    /**
     * 统计一次绘制中进入注释循环的块数。
     *
     * 注释块放置为 translate(0,0)；页面路径对象在 Background 内平移 (1,0)，
     * 因此只统计 (0,0) 即可区分注释放置。
     */
    const zeroTranslates = (renderer: FakeRenderer): number =>
      renderer.callsOf('translate').filter((call) => call.args[0] === 0 && call.args[1] === 0)
        .length;

    /** 逐个注释单独准备并绘制，隔离计数。 */
    const drawSingleAnnotation = async (filter?: PageContentFilter): Promise<number> => {
      const single = await build([annotations[0]!]);
      const renderer = new FakeRenderer();
      drawPage(single, renderer, CANVAS, VIEWPORT, filter ? { contentFilter: filter } : {});
      return zeroTranslates(renderer);
    };
    // 白名单模式下只用类型列表开启注释，无需图层配置。
    expect(await drawSingleAnnotation({ annotationTypes: ['Link'] })).toBe(0);
    expect(await drawSingleAnnotation({ annotationTypes: ['Stamp'] })).toBe(1);
    expect(await drawSingleAnnotation({ annotations: true })).toBe(1);
    expect(await drawSingleAnnotation(undefined)).toBe(1);
    expect(await drawSingleAnnotation({ annotations: false, annotationTypes: ['Stamp'] })).toBe(0);

    /** 统计一次绘制中的签章放置平移次数。 */
    const drawSignatures = (filter?: PageContentFilter): number => {
      const renderer = new FakeRenderer();
      drawPage(bundle, renderer, CANVAS, VIEWPORT, filter ? { contentFilter: filter } : {});
      return signatureTranslates(renderer);
    };
    expect(drawSignatures()).toBe(1);
    expect(drawSignatures({ layers: { body: true } })).toBe(0);
    expect(drawSignatures({ layers: { body: true }, signatures: true })).toBe(1);
  });

  it('自定义注释类型可被白名单命中', async () => {
    const bundle = await preparePage({
      page: { ...layeredPage(), annotationFile: 'Page/Page_0/Annotation.xml' },
      resources: scope(),
      loader: loader({
        annotations: [
          { id: 'an-x', type: 'CustomMark', visible: true, appearance: { kind: 'block', children: [path('ax', 1)] }, boundary: { x: 0, y: 0, w: 10, h: 10 } },
        ],
      }),
    });
    const renderer = new FakeRenderer();
    drawPage(bundle, renderer, CANVAS, VIEWPORT, {
      contentFilter: { annotationTypes: ['CustomMark'] },
    });
    // 注释块按 Appearance.Boundary(0,0) 放置。
    expect(
      renderer.callsOf('translate').filter((call) => call.args[0] === 0 && call.args[1] === 0),
    ).toHaveLength(1);
  });
});
