/**
 * T6b 页面管线集成测试：对象顺序、图片句柄缓存与独立块物化/递归。
 */

import { describe, expect, it } from 'vitest';
import type {
  Annotation,
  CompositeGraphicUnit,
  ImageResource,
  PageModel,
  Pattern,
  PageObject,
} from '../../src/model/types';
import type { PageResourceScope } from '../../src/resource/types';
import type { DecodedImage } from '../../src/common/types';
import type { PreparePageLoader } from '../../src/render/prepare';
import { preparePage } from '../../src/render/prepare';
import { drawPage } from '../../src/render/page';
import { FakeRenderer } from '../render/path/fake-renderer';
import { replayDisplayList } from '../../src/render/display-list';
import type { DrawStyle, FillRule, ResolvedPaint } from '../../src/common/types';

/** 构造页面。 */
function page(layers: PageModel['layers']): PageModel {
  return {
    id: 'p1',
    area: { x: 0, y: 0, w: 210, h: 297 },
    size: { width: 210, height: 297 },
    layers,
    templates: [],
    pageRes: [],
  };
}

/** 构造路径。 */
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
    fillColor: { type: 'color', color: { r: 0, g: 0, b: 0, a: 255 } },
  };
}

/** 构造解码图片。 */
function decoded(): DecodedImage {
  return {
    width: 4,
    height: 3,
    data: { width: 4, height: 3, data: new Uint8ClampedArray(48) },
    kind: 'imagedata',
  };
}

/** 构造资源作用域。 */
function scope(input: {
  images?: ImageResource[];
  composites?: CompositeGraphicUnit[];
  patterns?: [string, Pattern][];
} = {}): PageResourceScope {
  const empty = new Map();
  const images = new Map((input.images ?? []).map((item) => [item.id, item]));
  const composites = new Map((input.composites ?? []).map((item) => [item.id, item]));
  const patterns = new Map(input.patterns ?? []);
  return {
    pageId: 'p1',
    templateIds: [],
    fonts: empty,
    images,
    drawParams: empty,
    compositeGraphicUnits: composites,
    patterns,
    colorSpaces: empty,
    getFont: () => undefined,
    getImage: (id: string) => images.get(id),
    getDrawParam: (_id: string) => undefined,
    getComposite: (id: string) => composites.get(id),
    getPattern: (id: string) => patterns.get(id),
  };
}

/** 构造 loader。 */
function loader(annotations: Annotation[] = []): PreparePageLoader {
  return {
    async loadFontFaces() {
      return new Map();
    },
    async decodeImage() {
      return decoded();
    },
    async loadTemplatePage() {
      throw new Error('unexpected');
    },
    async loadAnnotations() {
      return annotations;
    },
  };
}

/** 回放底纹 tile 的假渲染器；用于验证 tile 内图片已被物化。 */
class PatternReplayRenderer extends FakeRenderer {
  override fill(style: DrawStyle, paint: ResolvedPaint, rule: FillRule): void {
    this.calls.push({ op: 'fill', args: [style, paint, rule] });
    if (paint.kind === 'pattern' && paint.tile) replayDisplayList(this, paint.tile);
  }
}

describe('页面绘制管线', () => {
  it('对象顺序：Boundary clip → Clips → CTM → alpha → 图元', async () => {
    const clipPath = {
      ...path('clip-path'),
      data: 'M0 0 L4 0 L4 4 Z',
      boundary: { x: 0, y: 0, w: 4, h: 4 },
    } as PageObject;
    const object = {
      ...path('main', { x: 2, y: 3, w: 20, h: 30 }),
      ctm: [2, 0, 0, 2, 0, 0],
      clips: [{ areas: [{ kind: 'path', path: clipPath as never }] }],
    } as PageObject;
    const bundle = await preparePage({
      page: page([{ type: 'Body', children: [object] }]),
      resources: scope(),
      loader: loader(),
    });
    const renderer = new FakeRenderer();
    drawPage(bundle, renderer, {} as never, { width: 794, height: 1123, dpi: 96 });
    const ops = renderer.ops();
    const saveIndex = ops.indexOf('save');
    const translateIndex = ops.indexOf('translate');
    const firstClip = ops.indexOf('clip');
    const transformIndex = ops.indexOf('transform');
    const alphaIndex = ops.indexOf('multiplyAlpha');
    const fillIndex = ops.indexOf('fill');
    expect(saveIndex).toBeLessThan(translateIndex);
    expect(translateIndex).toBeLessThan(firstClip);
    expect(firstClip).toBeLessThan(transformIndex);
    expect(transformIndex).toBeLessThan(alphaIndex);
    expect(alphaIndex).toBeLessThan(fillIndex);
  });

  it('同一资源的多张图片只 createImage 一次', async () => {
    const imageRes: ImageResource = { id: 'i1', mediaFile: 'a.png', format: 'png' };
    const image = (id: string, x: number): PageObject => ({
      kind: 'image',
      id,
      resourceId: 'i1',
      boundary: { x, y: 0, w: 10, h: 10 },
      ctm: [10, 0, 0, 10, 0, 0],
      alpha: 255,
      visible: true,
    });
    const bundle = await preparePage({
      page: page([{ type: 'Body', children: [image('i1a', 0), image('i1b', 20)] }]),
      resources: scope({ images: [imageRes] }),
      loader: loader(),
    });
    const renderer = new FakeRenderer();
    drawPage(bundle, renderer, {} as never, { width: 794, height: 1123, dpi: 96 });
    expect(renderer.callsOf('createImage')).toHaveLength(1);
    expect(renderer.callsOf('drawImage')).toHaveLength(2);
  });

  it('注释/复合块中的图片在绘制期物化，显示列表保持占位句柄', async () => {
    const imageRes: ImageResource = { id: 'i1', mediaFile: 'a.png', format: 'png' };
    const composite: PageObject = {
      kind: 'composite',
      id: 'comp',
      resourceId: 'c1',
      boundary: { x: 0, y: 0, w: 20, h: 10 },
      ctm: [20, 0, 0, 10, 0, 0],
      alpha: 255,
      visible: true,
    };
    const unit: CompositeGraphicUnit = {
      id: 'c1',
      width: 20,
      height: 10,
      content: {
        kind: 'block',
        children: [
          {
            kind: 'image',
            id: 'inner',
            resourceId: 'i1',
            boundary: { x: 0, y: 0, w: 20, h: 10 },
            ctm: [20, 0, 0, 10, 0, 0],
            alpha: 255,
            visible: true,
          },
        ],
      },
    };
    const bundle = await preparePage({
      page: page([{ type: 'Body', children: [composite] }]),
      resources: scope({ images: [imageRes], composites: [unit] }),
      loader: loader(),
    });
    const block = bundle.blocks.get('c1');
    expect(block).toBeDefined();
    const drawCommand = block!.displayList.commands.find((command) => command.op === 'drawImage');
    expect(drawCommand).toBeDefined();
    // 准备阶段没有渲染器，显示列表里只能是占位句柄。
    expect((drawCommand as { image: { width: number; height: number } }).image).toMatchObject({
      width: 4,
      height: 3,
    });

    const renderer = new FakeRenderer();
    drawPage(bundle, renderer, {} as never, { width: 794, height: 1123, dpi: 96 });
    expect(renderer.callsOf('createImage')).toHaveLength(1);
    expect(renderer.callsOf('drawImage')).toHaveLength(1);
  });


  it('注释 Appearance 内 Composite CTM 只应用一次（发票监制章尺度）', async () => {
    const imageRes: ImageResource = { id: '64', mediaFile: 'image_63.png', format: 'png' };
    const composite: PageObject = {
      kind: 'composite',
      id: '66',
      resourceId: '67',
      boundary: { x: 0, y: 0, w: 42.6861, h: 29.2806 },
      ctm: [0.3528, 0, 0, 0.3528, 0, 0],
      alpha: 255,
      visible: true,
    };
    const unit: CompositeGraphicUnit = {
      id: '67',
      width: 342.9921,
      height: 235.2756,
      content: {
        kind: 'block',
        children: [
          {
            kind: 'image',
            id: '65',
            resourceId: '64',
            boundary: { x: 0, y: 0, w: 121, h: 83 },
            ctm: [106, 0, 0, 79, 7.5, 2],
            alpha: 255,
            visible: true,
          },
        ],
      },
    };
    const annotation: Annotation = {
      id: '62',
      type: 'Stamp',
      visible: true,
      boundary: { x: 166.8639, y: 106.1897, w: 42.6861, h: 29.2806 },
      appearance: { kind: 'block', children: [composite] },
    };
    const bundle = await preparePage({
      page: { ...page([]), annotationFile: 'annot.xml' },
      resources: scope({ images: [imageRes], composites: [unit] }),
      loader: loader([annotation]),
    });
    const block = bundle.page.annotationBlocks[0]!;
    const transforms = block.displayList.commands
      .filter((command) => command.op === 'transform')
      .map((command) => command.matrix);

    // 外层 CompositeObject CTM 0.3528 只能出现一次；内层 ImageObject CTM 106×79 保持原值。
    expect(transforms.filter((matrix) => matrix[0] === 0.3528 && matrix[3] === 0.3528)).toHaveLength(1);
    expect(transforms.filter((matrix) => matrix[0] === 106 && matrix[3] === 79)).toHaveLength(1);

    const renderer = new FakeRenderer();
    drawPage(bundle, renderer, {} as never, { width: 813, height: 526, dpi: 96 });
    expect(renderer.callsOf('drawImage')).toHaveLength(1);
    // 42.6861mm 边界按 0.3528 仅缩放一次；若重复应用会退化为约 15.06mm。
    const pageTransform = renderer.callsOf('setTransform').at(-1)?.args[0] as number[];
    expect(pageTransform[0]).toBeCloseTo(96 / 25.4, 6);
  });

  it('底纹 cell 在准备阶段构建并在绘制期补 tile', async () => {
    const cell = {
      kind: 'block' as const,
      children: [path('pattern-cell-path')],
    };
    const patternObject = {
      ...path('patterned', { x: 0, y: 0, w: 20, h: 20 }),
      fillColor: {
        type: 'pattern' as const,
        pattern: {
          width: 5,
          height: 5,
          xStep: 5,
          yStep: 5,
          reflectMethod: 'Normal' as const,
          relativeTo: 'Object' as const,
          cell,
        },
      },
    } as PageObject;
    const bundle = await preparePage({
      page: page([{ type: 'Body', children: [patternObject] }]),
      resources: scope(),
      loader: loader(),
    });
    const renderer = new FakeRenderer();
    drawPage(bundle, renderer, {} as never, { width: 794, height: 1123, dpi: 96 });
    const fills = renderer.callsOf('fill');
    expect(fills.length).toBeGreaterThan(0);
    const paint = fills[0]!.args[1] as { kind: string; tile?: { commands: unknown[] } };
    expect(paint.kind).toBe('pattern');
    expect(paint.tile?.commands.length).toBeGreaterThan(0);
  });


  it('替换图按输出 DPI 选择，块内占位句柄在绘制期物化', async () => {
    const imageRes: ImageResource = { id: 'i1', mediaFile: 'main.png', format: 'png' };
    const subRes: ImageResource = { id: 'i2', mediaFile: 'sub.png', format: 'png' };
    const imageObject = {
      kind: 'image',
      id: 'img',
      resourceId: 'i1',
      substitution: 'i2',
      boundary: { x: 0, y: 0, w: 10, h: 10 },
      ctm: [10, 0, 0, 10, 0, 0],
      alpha: 255,
      visible: true,
    } as PageObject;
    const customLoader: PreparePageLoader = {
      async loadFontFaces() {
        return new Map();
      },
      async decodeImage(resource) {
        const value = decoded();
        return { ...value, width: resource.id === 'i2' ? 8 : 4 };
      },
      async loadTemplatePage() {
        throw new Error('unexpected');
      },
      async loadAnnotations() {
        return [];
      },
    };
    const bundle = await preparePage({
      page: page([{ type: 'Body', children: [imageObject] }]),
      resources: scope({ images: [imageRes, subRes] }),
      loader: customLoader,
    });
    const low = new FakeRenderer();
    drawPage(bundle, low, {} as never, { width: 794, height: 1123, dpi: 96 });
    expect((low.callsOf('drawImage')[0]!.args[0] as { width: number }).width).toBe(4);

    const high = new FakeRenderer();
    drawPage(bundle, high, {} as never, { width: 2381, height: 3369, dpi: 288 });
    expect((high.callsOf('drawImage')[0]!.args[0] as { width: number }).width).toBe(8);
  });


  it('Pattern cell 含图片时构建 tile，draw 期物化并调用 drawImage', async () => {
    const imageRes: ImageResource = { id: 'i1', mediaFile: 'tile.png', format: 'png' };
    const pattern: Pattern = {
      width: 5,
      height: 5,
      xStep: 5,
      yStep: 5,
      reflectMethod: 'Normal',
      relativeTo: 'Object',
      cell: {
        kind: 'block',
        children: [
          {
            kind: 'image',
            id: 'tile-image',
            resourceId: 'i1',
            boundary: { x: 0, y: 0, w: 5, h: 5 },
            ctm: [5, 0, 0, 5, 0, 0],
            alpha: 255,
            visible: true,
          },
        ],
      },
    };
    const patterned = {
      ...path('pattern-image', { x: 0, y: 0, w: 20, h: 20 }),
      fillColor: { type: 'pattern' as const, pattern },
    } as PageObject;
    const bundle = await preparePage({
      page: page([{ type: 'Body', children: [patterned] }]),
      resources: scope({ images: [imageRes], patterns: [['pat1', pattern]] }),
      loader: loader(),
    });
    expect(bundle.blocks.get('pat1')?.source).toBe('pattern-cell');
    expect(bundle.blocks.get('pat1')?.displayList.commands.some((item) => item.op === 'drawImage')).toBe(true);

    const warnings: string[] = [];
    const renderer = new PatternReplayRenderer();
    drawPage(bundle, renderer, {} as never, { width: 794, height: 1123, dpi: 96 }, {
      onWarning: (warning) => warnings.push(warning.code),
    });
    expect(renderer.callsOf('drawImage').length).toBeGreaterThan(0);
    expect(warnings).not.toContain('W_UNSUPPORTED_PAINT');
  });

  it('嵌套 composite 需要 group 时父块走绘制期递归，alpha 只乘一次', async () => {
    const inner: PageObject = {
      kind: 'composite',
      id: 'inner-comp',
      resourceId: 'c2',
      boundary: { x: 0, y: 0, w: 10, h: 10 },
      alpha: 128,
      visible: true,
    };
    const outer: PageObject = {
      kind: 'composite',
      id: 'outer-comp',
      resourceId: 'c1',
      boundary: { x: 0, y: 0, w: 20, h: 20 },
      alpha: 255,
      visible: true,
    };
    const scopeWithComposite = scope({
      composites: [
        { id: 'c1', width: 20, height: 20, content: { kind: 'block', children: [inner] } },
        {
          id: 'c2',
          width: 10,
          height: 10,
          content: { kind: 'block', children: [path('inner-path')] },
        },
      ],
    });
    const bundle = await preparePage({
      page: page([{ type: 'Body', children: [outer] }]),
      resources: scopeWithComposite,
      loader: loader(),
    });
    const renderer = new FakeRenderer();
    drawPage(bundle, renderer, {} as never, { width: 794, height: 1123, dpi: 96 });
    const groups = renderer.callsOf('beginGroup');
    expect(groups).toHaveLength(1);
    const options = groups[0]!.args[0] as { alpha: number };
    expect(options.alpha).toBeCloseTo(128 / 255, 5);
    expect(renderer.callsOf('endGroup')).toHaveLength(1);
    expect(renderer.callsOf('fill').length).toBeGreaterThan(0);
  });
});