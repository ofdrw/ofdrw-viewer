/**
 * T6b 页面管线单测：页面变换、图层/模板顺序、对象顺序与组 alpha。
 */

import { describe, expect, it } from 'vitest';
import type {
  Annotation,
  ImageResource,
  PageModel,
  PageObject,
} from '../../src/model/types';
import type { PageResourceScope } from '../../src/resource/types';
import type { PreparePageLoader } from '../../src/render/prepare';
import { preparePage } from '../../src/render/prepare';
import { drawPage } from '../../src/render/page';
import { FakeRenderer } from './path/fake-renderer';

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
function path(id: string, x: number, y = 0, w = 10, h = 10): PageObject {
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

/** 构造空资源作用域。 */
function scope(input: { images?: ImageResource[] } = {}): PageResourceScope {
  const empty = new Map();
  const images = new Map((input.images ?? []).map((item) => [item.id, item]));
  return {
    pageId: 'p1',
    templateIds: [],
    fonts: empty,
    images,
    drawParams: empty,
    compositeGraphicUnits: empty,
    patterns: empty,
    colorSpaces: empty,
    getFont: () => undefined,
    getImage: (id: string) => images.get(id),
    getDrawParam: (_id: string) => undefined,
    getComposite: () => undefined,
    getPattern: (_id: string) => undefined,
  };
}

/** 构造 loader。 */
function loader(input: {
  templates?: PageModel[];
  annotations?: Annotation[];
}): PreparePageLoader {
  return {
    async loadFontFaces() {
      return new Map();
    },
    async decodeImage() {
      return {
        width: 2,
        height: 2,
        data: { width: 2, height: 2, data: new Uint8ClampedArray(16) },
        kind: 'imagedata',
      };
    },
    async loadTemplatePage(ref) {
      const model = input.templates?.find((item) => item.id === ref.id);
      if (!model) throw new Error('missing template');
      return model;
    },
    async loadAnnotations() {
      return input.annotations ?? [];
    },
  };
}

/** 收集对象 boundary 平移顺序。 */
function translatedXs(renderer: FakeRenderer): number[] {
  return renderer
    .callsOf('translate')
    .map((call) => call.args[0] as number)
    .filter((x) => Number.isFinite(x));
}

describe('drawPage', () => {
  it('按图 16 顺序绘制：类型模板→类型图层，同组后画覆盖先画（ref ZOrder 优先）', async () => {
    const template = page([
      { type: 'Background', children: [path('tb', 1)] },
      { type: 'Body', children: [path('tbo', 2)] },
      { type: 'Foreground', children: [path('tf', 3)] },
    ]);
    template.id = 'tpl1';
    const model = page(
      [
        { type: 'Background', children: [path('pb', 11)] },
        { type: 'Body', children: [path('pbo', 12)] },
        { type: 'Foreground', children: [path('pf', 13)] },
        { type: 'Custom', children: [path('pc', 14)] },
      ],
      [{ id: 'tpl1', zOrder: 'Background' }],
    );
    const bundle = await preparePage({
      page: model,
      resources: scope(),
      loader: loader({ templates: [template] }),
    });
    const renderer = new FakeRenderer();
    drawPage(bundle, renderer, {} as never, { width: 794, height: 1123, dpi: 96 });

    // 模板整体归入 ref.zOrder=Background，模板内 XML 顺序全部先画。
    expect(translatedXs(renderer)).toEqual([1, 2, 3, 11, 12, 13, 14]);
    expect(renderer.ops()[0]).toBe('beginPage');
    expect(renderer.ops().at(-1)).toBe('endPage');
  });

  it('TemplateRef.zOrder 覆盖模板页自身图层类型', async () => {
    const template = page([{ type: 'Foreground', children: [path('template-own-foreground', 1)] }]);
    template.id = 'tpl1';
    const model = page(
      [
        { type: 'Background', children: [path('pb', 11)] },
        { type: 'Body', children: [path('pbo', 12)] },
        { type: 'Foreground', children: [path('pf', 13)] },
      ],
      [{ id: 'tpl1', zOrder: 'Background' }],
    );
    const bundle = await preparePage({
      page: model,
      resources: scope(),
      loader: loader({ templates: [template] }),
    });
    const renderer = new FakeRenderer();
    drawPage(bundle, renderer, {} as never, { width: 794, height: 1123, dpi: 96 });
    // 模板自身是 Foreground，但页面引用 ZOrder=Background：应最先画。
    expect(translatedXs(renderer)).toEqual([1, 11, 12, 13]);
  });

  it('TemplateRef.zOrder 缺省按 Background', async () => {
    const template = page([{ type: 'Body', children: [path('template-own-body', 1)] }]);
    template.id = 'tpl1';
    const model = page(
      [
        { type: 'Background', children: [path('pb', 11)] },
        { type: 'Body', children: [path('pbo', 12)] },
      ],
      [{ id: 'tpl1' }],
    );
    const bundle = await preparePage({
      page: model,
      resources: scope(),
      loader: loader({ templates: [template] }),
    });
    const renderer = new FakeRenderer();
    drawPage(bundle, renderer, {} as never, { width: 794, height: 1123, dpi: 96 });
    // 缺省 Background：模板排在页 Background 图层之前，而不是模板自身 Body 组。
    expect(translatedXs(renderer)).toEqual([1, 11, 12]);
  });

  it('三图层交错：Background 模板/图层 → Body 模板/图层 → Foreground 模板/图层', async () => {
    const backgroundTemplate = page([
      { type: 'Foreground', children: [path('tb-own-foreground', 1)] },
    ]);
    backgroundTemplate.id = 'tpl-bg';
    const bodyTemplate = page([{ type: 'Background', children: [path('tm-own-background', 2)] }]);
    bodyTemplate.id = 'tpl-body';
    const foregroundTemplate = page([{ type: 'Body', children: [path('tf-own-body', 3)] }]);
    foregroundTemplate.id = 'tpl-fg';
    const model = page(
      [
        { type: 'Background', children: [path('pb1', 11), path('pb2', 12)] },
        { type: 'Body', children: [path('pbo', 13)] },
        { type: 'Foreground', children: [path('pf', 14)] },
      ],
      [
        { id: 'tpl-bg', zOrder: 'Background' },
        { id: 'tpl-body', zOrder: 'Body' },
        { id: 'tpl-fg', zOrder: 'Foreground' },
      ],
    );
    const bundle = await preparePage({
      page: model,
      resources: scope(),
      loader: loader({ templates: [backgroundTemplate, bodyTemplate, foregroundTemplate] }),
    });
    const renderer = new FakeRenderer();
    drawPage(bundle, renderer, {} as never, { width: 794, height: 1123, dpi: 96 });
    expect(translatedXs(renderer)).toEqual([1, 11, 12, 2, 13, 3, 14]);
  });

  it('模板归入 ref 组后，组内仍按模板自身 Layer 类型 + XML 顺序', async () => {
    const template = page([
      { type: 'Foreground', children: [path('tf', 3)] },
      { type: 'Background', children: [path('tb', 1)] },
      { type: 'Body', children: [path('tbo', 2)] },
    ]);
    template.id = 'tpl1';
    const model = page(
      [{ type: 'Background', children: [path('pb', 11)] }],
      [{ id: 'tpl1', zOrder: 'Background' }],
    );
    const bundle = await preparePage({
      page: model,
      resources: scope(),
      loader: loader({ templates: [template] }),
    });
    const renderer = new FakeRenderer();
    drawPage(bundle, renderer, {} as never, { width: 794, height: 1123, dpi: 96 });
    // 模板整体在 Background 组，但组内仍按 Background→Body→Foreground 类型序。
    expect(translatedXs(renderer)).toEqual([1, 2, 3, 11]);
  });

  it('同层多个模板按页面引用顺序、页图层按 XML 顺序', async () => {
    const first = page([{ type: 'Foreground', children: [path('first', 1)] }]);
    first.id = 'tpl1';
    const second = page([{ type: 'Body', children: [path('second', 2)] }]);
    second.id = 'tpl2';
    const model = page(
      [
        { type: 'Background', children: [path('pb1', 11), path('pb2', 12)] },
        { type: 'Body', children: [path('pbo', 13)] },
      ],
      [
        { id: 'tpl1', zOrder: 'Background' },
        { id: 'tpl2', zOrder: 'Background' },
      ],
    );
    const bundle = await preparePage({
      page: model,
      resources: scope(),
      loader: loader({ templates: [first, second] }),
    });
    const renderer = new FakeRenderer();
    drawPage(bundle, renderer, {} as never, { width: 794, height: 1123, dpi: 96 });
    expect(translatedXs(renderer)).toEqual([1, 2, 11, 12, 13]);
  });

  it('document 模式按模板引用顺序 + 页图层 XML 顺序绘制', async () => {
    const template = page([
      { type: 'Foreground', children: [path('tf', 3)] },
      { type: 'Background', children: [path('tb', 1)] },
    ]);
    template.id = 'tpl1';
    const model = page(
      [
        { type: 'Custom', children: [path('pc', 14)] },
        { type: 'Body', children: [path('pbo', 12)] },
      ],
      [{ id: 'tpl1' }],
    );
    const bundle = await preparePage({
      page: model,
      resources: scope(),
      loader: loader({ templates: [template] }),
    });
    const renderer = new FakeRenderer();
    drawPage(bundle, renderer, {} as never, { width: 794, height: 1123, dpi: 96 }, {
      layerOrder: 'document',
    });
    expect(translatedXs(renderer)).toEqual([3, 1, 14, 12]);
  });

  it('绘制前以 identity + M_page 绝对覆盖预置 CTM', async () => {
    const model = page([{ type: 'Body', children: [path('p', 0)] }]);
    model.area = { x: 10, y: 20, w: 210, h: 297 };
    const bundle = await preparePage({
      page: model,
      resources: scope(),
      loader: loader({}),
    });
    const renderer = new FakeRenderer();
    drawPage(bundle, renderer, {} as never, { width: 794, height: 1123, dpi: 96 });
    const transforms = renderer.callsOf('setTransform').map((call) => call.args[0]);
    expect(transforms[0]).toEqual([1, 0, 0, 1, 0, 0]);
    const scale = 96 / 25.4;
    expect(transforms[1]).toEqual([scale, 0, 0, scale, -scale * 10, -scale * 20]);
  });

  it('复合对象 alpha 只在 group 结束乘一次，matrix 为 group→device 绝对矩阵', async () => {
    const model = page([
      {
        type: 'Body',
        children: [
          {
            kind: 'composite',
            id: 'comp',
            resourceId: 'c1',
            boundary: { x: 10, y: 20, w: 30, h: 20 },
            ctm: [2, 0, 0, 2, 0, 0],
            alpha: 128,
            visible: true,
          },
        ],
      },
    ]);
    const scopeWithComposite = scope();
    const composites = new Map([
      [
        'c1',
        {
          id: 'c1',
          width: 30,
          height: 20,
          content: { kind: 'block' as const, children: [path('inner', 0)] },
        },
      ],
    ]);
    Object.assign(scopeWithComposite, {
      compositeGraphicUnits: composites,
      getComposite: (id: string) => composites.get(id),
    });
    const bundle = await preparePage({
      page: model,
      resources: scopeWithComposite,
      loader: loader({}),
    });
    const renderer = new FakeRenderer();
    drawPage(bundle, renderer, {} as never, { width: 794, height: 1123, dpi: 96 });

    const groups = renderer.callsOf('beginGroup');
    expect(groups).toHaveLength(1);
    const options = groups[0]!.args[0] as { matrix: number[]; alpha: number };
    const s = 96 / 25.4;
    expect(options.matrix).toEqual([2 * s, 0, 0, 2 * s, 10 * s, 20 * s]);
    expect(options.alpha).toBeCloseTo(128 / 255, 5);
    expect(renderer.callsOf('endGroup')).toHaveLength(1);
    const alphas = renderer.callsOf('multiplyAlpha').map((call) => call.args[0] as number);
    expect(alphas).toContain(1);
    expect(alphas).not.toContain(128 / 255);
  });

  it('零 Boundary 跳过、负 Boundary 归一化并 warning、异常后仍 restore', async () => {
    const warnings: string[] = [];
    const model = page([
      {
        type: 'Body',
        children: [
          path('zero', 0, 0, 0, 10),
          path('negative', 30, 40, -10, -20),
        ],
      },
    ]);
    const bundle = await preparePage({
      page: model,
      resources: scope(),
      loader: loader({}),
      onWarning: (warning) => warnings.push(warning.code),
    });
    const renderer = new FakeRenderer();
    renderer.throwOn = 'fill';
    drawPage(bundle, renderer, {} as never, { width: 794, height: 1123, dpi: 96 }, {
      onWarning: (warning) => warnings.push(warning.code),
    });

    expect(warnings).toContain('W_ZERO_BOUNDARY');
    expect(warnings).toContain('W_NEGATIVE_BOUNDARY');
    expect(translatedXs(renderer)).toEqual([20]);
    expect(renderer.callsOf('restore').length).toBeGreaterThan(0);
  });
});