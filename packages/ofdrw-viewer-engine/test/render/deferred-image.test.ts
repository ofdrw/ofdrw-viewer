/**
 * T6i 定向测试：deferred 图片替换图模式保留，以及公开块回放的图片 resolver。
 */

import { describe, expect, it } from 'vitest';
import type {
  CompositeGraphicUnit,
  ImageObject,
  ImageResource,
  IndependentBlock,
  PageModel,
} from '../../src/model/types';
import type { DecodedImage } from '../../src/common/types';
import type { PreparedPageBundle } from '../../src/render/prepare';
import { preparePage } from '../../src/render/prepare';
import { createDefaultStyle } from '../../src/style/defaults';
import { createPaintBinder } from '../../src/render/paint';
import {
  createDeferredImageHandle,
  resolveDisplayImage,
} from '../../src/render/object';
import { drawIndependentBlock, drawAnnotationBlocks } from '../../src/render/block';
import { FakeRenderer } from './path/fake-renderer';

/** 构造解码图片；像素尺寸用于识别主图/替换图。 */
function decoded(width: number): DecodedImage {
  return {
    width,
    height: width,
    data: { width, height: width, data: new Uint8ClampedArray(width * width * 4) },
    kind: 'imagedata',
  };
}

/** 构造图片对象。 */
function imageObject(): ImageObject {
  return {
    kind: 'image',
    id: 'img',
    resourceId: 'main',
    substitution: 'sub',
    boundary: { x: 0, y: 0, w: 10, h: 10 },
    ctm: [10, 0, 0, 10, 0, 0],
    alpha: 255,
    visible: true,
  };
}

/** 构造最小准备产物。 */
function preparedBundle(): PreparedPageBundle {
  const page: PageModel = {
    id: 'p1',
    area: { x: 0, y: 0, w: 210, h: 297 },
    size: { width: 210, height: 297 },
    layers: [],
    templates: [],
    pageRes: [],
  };
  return {
    page: { page, styles: new WeakMap(), annotationBlocks: [] },
    templates: [],
    fonts: new Map(),
    images: new Map([
      ['main', decoded(2)],
      ['sub', decoded(4)],
    ]),
    blocks: new Map(),
    signatureBlocks: [],
  };
}

/** 构造含 deferred drawImage 的独立块。 */
function imageBlock(): { block: IndependentBlock; marker: ReturnType<typeof createDeferredImageHandle> } {
  const object = imageObject();
  const marker = createDeferredImageHandle(object, decoded(2), 'main', 'always');
  return {
    marker,
    block: {
      id: 'block-with-image',
      source: 'composite',
      space: { width: 10, height: 10 },
      content: { kind: 'block', children: [] },
      styleRoot: createDefaultStyle(),
      cacheKey: 'block-with-image',
      displayList: {
        commands: [
          {
            op: 'drawImage',
            image: marker,
            transform: [1, 0, 0, 1, 0, 0],
            alpha: 1,
            smoothing: true,
          },
        ],
        bounds: { x: 0, y: 0, w: 10, h: 10 },
      },
    },
  };
}

describe('deferred image substitution mode', () => {
  it('always 忽略 dpi 使用替换图，never 始终用主图', () => {
    const bundle = preparedBundle();
    const alwaysRenderer = new FakeRenderer();
    const always = createDeferredImageHandle(imageObject(), decoded(2), 'main', 'always');
    const alwaysHandle = resolveDisplayImage(alwaysRenderer, bundle, always, 'image', 96);
    expect(alwaysHandle.width).toBe(4);

    const neverRenderer = new FakeRenderer();
    const never = createDeferredImageHandle(imageObject(), decoded(2), 'main', 'never');
    const neverHandle = resolveDisplayImage(neverRenderer, bundle, never, 'image', 300);
    expect(neverHandle.width).toBe(2);
  });

  it('auto 按绘制 dpi 选择主图/替换图', () => {
    const bundle = preparedBundle();
    const low = createDeferredImageHandle(imageObject(), decoded(2), 'main', 'auto');
    expect(resolveDisplayImage(new FakeRenderer(), bundle, low, 'image', 96).width).toBe(2);
    const high = createDeferredImageHandle(imageObject(), decoded(2), 'main', 'auto');
    expect(resolveDisplayImage(new FakeRenderer(), bundle, high, 'image', 300).width).toBe(4);
  });
});

describe('prepare 到块内 deferred plan', () => {
  it('prepare 的 substitutionMode=always 保留到块内图片，绘制期使用替换图', async () => {
    const image = imageObject();
    const unit: CompositeGraphicUnit = {
      id: 'c1',
      width: 10,
      height: 10,
      content: { kind: 'block', children: [image] },
    };
    const page: PageModel = {
      id: 'p1',
      area: { x: 0, y: 0, w: 210, h: 297 },
      size: { width: 210, height: 297 },
      layers: [
        {
          type: 'Body',
          children: [
            {
              kind: 'composite',
              id: 'comp',
              resourceId: 'c1',
              boundary: { x: 0, y: 0, w: 10, h: 10 },
              alpha: 255,
              visible: true,
            },
          ],
        },
      ],
      templates: [],
      pageRes: [],
    };
    const empty = new Map();
    const images = new Map<string, ImageResource>([
      ['main', { id: 'main', mediaFile: 'main.png', format: 'png' }],
      ['sub', { id: 'sub', mediaFile: 'sub.png', format: 'png' }],
    ]);
    const decodedImages = new Map([
      ['main', decoded(2)],
      ['sub', decoded(4)],
    ]);
    const resources = {
      pageId: 'p1',
      templateIds: [],
      fonts: empty,
      images,
      drawParams: empty,
      compositeGraphicUnits: new Map([['c1', unit]]),
      patterns: empty,
      colorSpaces: empty,
      getFont: () => undefined,
      getImage: (id: string) => images.get(id),
      getDrawParam: () => undefined,
      getComposite: (id: string) => (id === 'c1' ? unit : undefined),
      getPattern: () => undefined,
    };
    const loader = {
      async loadFontFaces() {
        return new Map();
      },
      async decodeImage(resource: ImageResource) {
        const value = decodedImages.get(resource.id);
        if (!value) throw new Error('missing');
        return value;
      },
      async loadTemplatePage(): Promise<PageModel> {
        throw new Error('no template');
      },
      async loadAnnotations() {
        return [];
      },
    };
    const bundle = await preparePage({
      page,
      resources,
      loader,
      dpi: 96,
      substitutionMode: 'always',
    });
    const block = bundle.blocks.get('c1');
    expect(block).toBeDefined();
    const renderer = new FakeRenderer();
    const binder = createPaintBinder(renderer);
    drawIndependentBlock(
      {
        renderer,
        binder,
        resolveImage: (handle, role) => resolveDisplayImage(renderer, bundle, handle, role, 96),
      },
      block!,
    );
    const created = renderer.callsOf('createImage').map((call) => {
      const value = call.args[0] as DecodedImage;
      return value.width;
    });
    expect(created).toEqual([4]);
  });
});

describe('公开块回放 resolver', () => {
  it('drawIndependentBlock 接受 resolveImage 并物化 deferred 句柄', () => {
    const bundle = preparedBundle();
    const renderer = new FakeRenderer();
    const { block } = imageBlock();
    const binder = createPaintBinder(renderer);
    drawIndependentBlock(
      {
        renderer,
        binder,
        resolveImage: (handle, role) => resolveDisplayImage(renderer, bundle, handle, role, 96),
      },
      block,
    );
    expect(renderer.callsOf('createImage')).toHaveLength(1);
    expect(renderer.callsOf('drawImage')).toHaveLength(1);
  });

  it('drawAnnotationBlocks 接受 resolveImage 并透传到块回放', () => {
    const bundle = preparedBundle();
    const renderer = new FakeRenderer();
    const { block } = imageBlock();
    const binder = createPaintBinder(renderer);
    drawAnnotationBlocks(
      renderer,
      binder,
      [block],
      undefined,
      (handle, role) => resolveDisplayImage(renderer, bundle, handle, role, 96),
    );
    expect(renderer.callsOf('createImage')).toHaveLength(1);
    expect(renderer.callsOf('drawImage')).toHaveLength(1);
  });
});
