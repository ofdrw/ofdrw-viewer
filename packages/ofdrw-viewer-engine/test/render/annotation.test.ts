/**
 * T6b 注释管线单测：PageID 映射后的外观顺序、Boundary 平移、空外观与可见性。
 */

import { describe, expect, it } from 'vitest';
import type {
  Annotation,
  IndependentBlock,
  PageModel,
  PageObject,
} from '../../src/model/types';
import type { PageResourceScope } from '../../src/resource/types';
import { buildAnnotationBlocks } from '../../src/render/annotation';
import { preparePage } from '../../src/render/prepare';
import { drawPage } from '../../src/render/page';
import { createDefaultStyle } from '../../src/style/defaults';
import { FakeRenderer } from './path/fake-renderer';

/** 构造路径对象。 */
function path(id: string, x = 0, y = 0): PageObject {
  return {
    kind: 'path',
    id,
    boundary: { x, y, w: 10, h: 10 },
    alpha: 255,
    visible: true,
    data: 'M0 0 L10 0 L10 10 Z',
    fill: true,
    stroke: false,
    rule: 'nonzero',
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
    getDrawParam: (_id: string) => undefined,
    getComposite: () => undefined,
    getPattern: (_id: string) => undefined,
  };
}

/** 构造注释块构建器。 */
function blockBuilder(
  blocks: IndependentBlock[],
): (annotation: Annotation, appearance: PageObject, boundary: { x: number; y: number; w: number; h: number }) => IndependentBlock {
  return (annotation, _appearance, boundary) => {
    const block: IndependentBlock = {
      id: annotation.id,
      source: 'annotation',
      space: { width: boundary.w, height: boundary.h },
      content: annotation.appearance!,
      styleRoot: createDefaultStyle(),
      cacheKey: `a:${annotation.id}`,
      boundary,
      displayList: {
        commands: [
          { op: 'beginPath' },
          { op: 'rect', x: 0, y: 0, w: boundary.w, h: boundary.h },
          { op: 'fill', style: { lineWidth: 1, lineCap: 'Butt', lineJoin: 'Miter', miterLimit: 4, dashOffset: 0, dashPattern: [] }, paint: { kind: 'color', rgba: { r: 0, g: 0, b: 0, a: 255 } }, rule: 'nonzero' },
        ],
        bounds: { x: 0, y: 0, w: boundary.w, h: boundary.h },
      },
    };
    blocks.push(block);
    return block;
  };
}

describe('buildAnnotationBlocks', () => {
  it('按文件顺序构建可见非空外观，并归一化负 Boundary', () => {
    const warnings: string[] = [];
    const built: IndependentBlock[] = [];
    const annotations: Annotation[] = [
      { id: 'a1', type: 'Stamp', visible: true, appearance: { kind: 'block', children: [path('p1')] }, boundary: { x: 10, y: 20, w: 30, h: 40 } },
      { id: 'a2', type: 'Stamp', visible: false, appearance: { kind: 'block', children: [path('p2')] }, boundary: { x: 0, y: 0, w: 10, h: 10 } },
      { id: 'a3', type: 'Stamp', visible: true, boundary: { x: 0, y: 0, w: 10, h: 10 } },
      { id: 'a4', type: 'Stamp', visible: true, appearance: { kind: 'block', children: [] }, boundary: { x: 0, y: 0, w: 10, h: 10 } },
      { id: 'a5', type: 'Stamp', visible: true, appearance: { kind: 'block', children: [path('p5')] }, boundary: { x: 50, y: 60, w: -10, h: -20 } },
    ];
    const blocks = buildAnnotationBlocks(annotations, {
      styleRoot: createDefaultStyle(),
      baseDir: '',
      onWarning: (code) => warnings.push(code),
      buildBlock: blockBuilder(built),
    });

    expect(blocks.map((block) => block.id)).toEqual(['a1', 'a5']);
    expect(blocks[1]?.boundary).toEqual({ x: 40, y: 40, w: 10, h: 20 });
    expect(warnings.filter((code) => code === 'W_ANNOT_EMPTY')).toHaveLength(2);
  });

  it('页面绘制时注释在图层之后、按文件顺序平移 Appearance Boundary', async () => {
    const model: PageModel = {
      id: 'p1',
      area: { x: 0, y: 0, w: 210, h: 297 },
      size: { width: 210, height: 297 },
      layers: [{ type: 'Body', children: [path('layer', 5, 0)] }],
      templates: [],
      pageRes: [],
      annotationFile: 'Annots/Annotations.xml',
    };
    const annotations: Annotation[] = [
      { id: 'a1', type: 'Stamp', visible: true, appearance: { kind: 'block', children: [path('ap1')] }, boundary: { x: 100, y: 50, w: 30, h: 40 } },
      { id: 'a2', type: 'Watermark', visible: true, appearance: { kind: 'block', children: [path('ap2')] }, boundary: { x: 120, y: 60, w: 30, h: 40 } },
    ];
    const bundle = await preparePage({
      page: model,
      resources: scope(),
      loader: {
        async loadFontFaces() {
          return new Map();
        },
        async decodeImage() {
          throw new Error('unexpected');
        },
        async loadTemplatePage() {
          throw new Error('unexpected');
        },
        async loadAnnotations() {
          return annotations;
        },
      },
    });
    expect(bundle.page.annotationBlocks.map((block) => block.id)).toEqual(['a1', 'a2']);

    const renderer = new FakeRenderer();
    drawPage(bundle, renderer, {} as never, { width: 794, height: 1123, dpi: 96 });
    const xs = renderer
      .callsOf('translate')
      .map((call) => call.args[0] as number)
      .filter((x) => Number.isFinite(x));
    expect(xs.filter((x) => x > 0)).toEqual([5, 100, 120]);
  });

  it('NoZoom/NoRotate 不参与外观变换（只有 Boundary 平移）', async () => {
    const model: PageModel = {
      id: 'p1',
      area: { x: 0, y: 0, w: 210, h: 297 },
      size: { width: 210, height: 297 },
      layers: [],
      templates: [],
      pageRes: [],
      annotationFile: 'Annots/Annotations.xml',
    };
    const annotation = {
      id: 'watermark',
      type: 'Watermark',
      visible: true,
      appearance: { kind: 'block', children: [path('ap')] },
      boundary: { x: 30, y: 40, w: 50, h: 20 },
      noZoom: true,
      noRotate: true,
    } as unknown as Annotation;
    const bundle = await preparePage({
      page: model,
      resources: scope(),
      loader: {
        async loadFontFaces() {
          return new Map();
        },
        async decodeImage() {
          throw new Error('unexpected');
        },
        async loadTemplatePage() {
          throw new Error('unexpected');
        },
        async loadAnnotations() {
          return [annotation];
        },
      },
    });
    const renderer = new FakeRenderer();
    drawPage(bundle, renderer, {} as never, { width: 794, height: 1123, dpi: 96 });
    const transforms = renderer.callsOf('transform');
    expect(transforms).toHaveLength(0);
    const rects = renderer.callsOf('rect');
    expect(rects.some((call) => call.args[0] === 0 && call.args[1] === 0)).toBe(true);
  });
});