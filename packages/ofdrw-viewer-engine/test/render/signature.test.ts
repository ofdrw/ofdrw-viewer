/**
 * T14b 签章渲染单测：StampAnnot Boundary/Clip、骑缝章切片、延迟图片与失败降级。
 */

import { describe, expect, it } from 'vitest';
import type { DecodedImage } from '../../src/common/types';
import type {
  Annotation,
  ImageObject,
  PageModel,
  SealImage,
  SignatureStamp,
} from '../../src/model/types';
import type { PageResourceScope } from '../../src/resource/types';
import type { PreparePageLoader, SignatureStampSource } from '../../src/render/prepare';
import { preparePage } from '../../src/render/prepare';
import { drawPage } from '../../src/render/page';
import { isDeferredImageHandle } from '../../src/render/object';
import { FakeRenderer } from './path/fake-renderer';

/** 构造最小页面。 */
function page(id = 'p1'): PageModel {
  return {
    id,
    area: { x: 0, y: 0, w: 210, h: 297 },
    size: { width: 210, height: 297 },
    layers: [],
    templates: [],
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
function seal(type = 'PNG'): SealImage {
  return { version: 'v4', type, data: new Uint8Array([1, 2, 3]), width: 40, height: 40 };
}

/** 构造签章戳记。 */
function stamp(
  id: string,
  boundary: SignatureStamp['boundary'],
  clip?: SignatureStamp['boundary'],
): SignatureStamp {
  return { id, pageId: 'p1', boundary, ...(clip ? { clip } : {}) };
}

/** 构造包含可选签章 loader 的测试加载器。 */
function loader(input: {
  stamps?: readonly SignatureStampSource[];
  annotations?: readonly Annotation[];
  decode?: (seal: SealImage) => Promise<DecodedImage>;
  throwLoad?: boolean;
} = {}): PreparePageLoader {
  return {
    async loadFontFaces() {
      return new Map();
    },
    async decodeImage() {
      return decoded();
    },
    async loadTemplatePage() {
      throw new Error('no templates');
    },
    async loadAnnotations() {
      return input.annotations ?? [];
    },
    async loadSignatureStamps() {
      if (input.throwLoad) throw new Error('signature index broken');
      return input.stamps ?? [];
    },
    async decodeSeal(sealImage) {
      if (input.decode) return input.decode(sealImage);
      return decoded();
    },
  };
}

/** h/V4RideRight 的 5 个骑缝章切片：全章 40×40mm，每页只显示 8mm 宽。 */
const H_STAMPS: readonly SignatureStampSource[] = [
  { signatureId: 'sig-h', stamp: stamp('s002', { x: 202, y: 128.5, w: 40, h: 40 }, { x: 0, y: 0, w: 8, h: 40 }), seal: seal() },
  { signatureId: 'sig-h', stamp: stamp('s003', { x: 194, y: 128.5, w: 40, h: 40 }, { x: 8, y: 0, w: 8, h: 40 }), seal: seal() },
  { signatureId: 'sig-h', stamp: stamp('s004', { x: 186, y: 128.5, w: 40, h: 40 }, { x: 16, y: 0, w: 8, h: 40 }), seal: seal() },
  { signatureId: 'sig-h', stamp: stamp('s005', { x: 178, y: 128.5, w: 40, h: 40 }, { x: 24, y: 0, w: 8, h: 40 }), seal: seal() },
  { signatureId: 'sig-h', stamp: stamp('s006', { x: 170, y: 128.5, w: 40, h: 40 }, { x: 32, y: 0, w: 8, h: 40 }), seal: seal() },
];

describe('签章渲染', () => {
  it('按 StampAnnot Boundary 放置，按 Clip 裁剪出 5 页骑缝章切片', async () => {
    for (const [index, source] of H_STAMPS.entries()) {
      const bundle = await preparePage({
        page: page(`p${index + 1}`),
        resources: scope(),
        loader: loader({ stamps: [source] }),
      });
      expect(bundle.signatureBlocks).toHaveLength(1);
      const block = bundle.signatureBlocks[0]!;
      expect(block.boundary).toEqual(source.stamp.boundary);
      expect(block.displayList.commands.slice(0, 3)).toEqual([
        { op: 'beginPath' },
        { op: 'rect', x: source.stamp.clip!.x, y: 0, w: 8, h: 40 },
        { op: 'clip', rule: 'nonzero' },
      ]);
      const draw = block.displayList.commands.find((command) => command.op === 'drawImage');
      expect(draw && draw.op === 'drawImage' ? draw.transform : null).toEqual([40, 0, 0, 40, 0, 0]);
      const imageCommand = draw as { image: { width: number; height: number } };
      expect(imageCommand.image).toMatchObject({ width: 2, height: 2 });
      expect(isDeferredImageHandle(imageCommand.image as never)).toBe(true);
    }
  });

  it('drawPage 在注释之后按 Boundary 平移、裁剪并物化 deferred 图片', async () => {
    const bundle = await preparePage({
      page: page(),
      resources: scope(),
      loader: loader({ stamps: [H_STAMPS[1]!] }),
    });
    const renderer = new FakeRenderer();
    drawPage(bundle, renderer, {} as never, { width: 794, height: 1123, dpi: 96 });

    expect(renderer.callsOf('translate').map((call) => call.args)).toContainEqual([194, 128.5]);
    expect(renderer.callsOf('rect').map((call) => call.args)).toContainEqual([8, 0, 8, 40]);
    expect(renderer.callsOf('clip')).toHaveLength(2);
    expect(renderer.callsOf('createImage')).toHaveLength(1);
    expect(renderer.callsOf('drawImage')[0]?.args.slice(0, 2)).toEqual([
      expect.objectContaining({ width: 2, height: 2 }),
      [40, 0, 0, 40, 0, 0],
    ]);
  });

  it('无 Clip 时只绘制完整印章，不生成裁剪命令', async () => {
    const bundle = await preparePage({
      page: page(),
      resources: scope(),
      loader: loader({
        stamps: [{ signatureId: 's1', stamp: stamp('s1a', { x: 10, y: 20, w: 42, h: 42 }), seal: seal('PNG') }],
      }),
    });
    expect(bundle.signatureBlocks[0]?.displayList.commands.map((command) => command.op)).toEqual([
      'drawImage',
    ]);
  });

  it('缺少 Seal 图片、解码失败、尺寸非正均 warning 且不崩页', async () => {
    const missingWarnings: string[] = [];
    const missing = await preparePage({
      page: page(),
      resources: scope(),
      loader: loader({
        stamps: [{ signatureId: 's1', stamp: stamp('s1a', { x: 0, y: 0, w: 10, h: 10 }) }],
      }),
      onWarning: (warning) => missingWarnings.push(warning.code),
    });
    expect(missing.signatureBlocks).toHaveLength(0);
    expect(missingWarnings).toContain('W_IMAGE_DECODE');

    const emptySealWarnings: string[] = [];
    const emptySeal = await preparePage({
      page: page(),
      resources: scope(),
      loader: loader({
        stamps: [
          {
            signatureId: 's1',
            stamp: stamp('s1a', { x: 0, y: 0, w: 10, h: 10 }),
            seal: { ...seal(), data: new Uint8Array(0) },
          },
        ],
      }),
      onWarning: (warning) => emptySealWarnings.push(warning.code),
    });
    expect(emptySeal.signatureBlocks).toHaveLength(0);
    expect(emptySealWarnings).toContain('W_IMAGE_DECODE');

    const failedWarnings: string[] = [];
    const failed = await preparePage({
      page: page(),
      resources: scope(),
      loader: loader({
        stamps: [{ signatureId: 's1', stamp: stamp('s1a', { x: 0, y: 0, w: 10, h: 10 }), seal: seal() }],
        decode: async () => {
          throw new Error('bad png');
        },
      }),
      onWarning: (warning) => failedWarnings.push(warning.code),
    });
    expect(failed.signatureBlocks).toHaveLength(0);
    expect(failedWarnings).toContain('W_IMAGE_DECODE');

    const emptyWarnings: string[] = [];
    const empty = await preparePage({
      page: page(),
      resources: scope(),
      loader: loader({
        stamps: [{ signatureId: 's1', stamp: stamp('s1a', { x: 0, y: 0, w: 10, h: 10 }), seal: seal() }],
        decode: async () => ({ ...decoded(), width: 0, height: 0 }),
      }),
      onWarning: (warning) => emptyWarnings.push(warning.code),
    });
    expect(empty.signatureBlocks).toHaveLength(0);
    expect(emptyWarnings).toContain('W_IMAGE_DECODE');
  });

  it('签章索引加载失败 warning，不影响页面其余内容', async () => {
    const warnings: string[] = [];
    const bundle = await preparePage({
      page: page(),
      resources: scope(),
      loader: loader({ throwLoad: true }),
      onWarning: (warning) => warnings.push(warning.code),
    });
    expect(bundle.signatureBlocks).toHaveLength(0);
    expect(warnings).toContain('W_UNSUPPORTED_PAINT');
  });

  it('绘制顺序为页面图层 → 注释 → 签章', async () => {
    const annotation: Annotation = {
      id: 'a1',
      type: 'Stamp',
      visible: true,
      boundary: { x: 10, y: 20, w: 5, h: 5 },
      appearance: {
        kind: 'block',
        children: [
          {
            kind: 'path',
            id: 'ap1',
            boundary: { x: 0, y: 0, w: 5, h: 5 },
            alpha: 255,
            visible: true,
            data: 'M0 0 L5 0 L5 5 Z',
            fill: true,
            stroke: false,
            rule: 'nonzero',
          },
        ],
      },
    };
    const bundle = await preparePage({
      page: { ...page(), annotationFile: 'annot.xml' },
      resources: scope(),
      loader: loader({ stamps: [H_STAMPS[0]!], annotations: [annotation] }),
    });
    const renderer = new FakeRenderer();
    drawPage(bundle, renderer, {} as never, { width: 794, height: 1123, dpi: 96 });

    const translates = renderer.callsOf('translate').map((call) => call.args);
    expect(translates).toContainEqual([10, 20]);
    expect(translates).toContainEqual([202, 128.5]);
    const annotationIndex = translates.findIndex((args) => args[0] === 10 && args[1] === 20);
    const signatureIndex = translates.findIndex((args) => args[0] === 202 && args[1] === 128.5);
    expect(annotationIndex).toBeLessThan(signatureIndex);
  });

  it('支持 PNG/GIF/JPG/BMP 类型元数据（解码委托给 loader）', async () => {
    const seen: string[] = [];
    const bundle = await preparePage({
      page: page(),
      resources: scope(),
      loader: loader({
        stamps: ['PNG', 'GIF', 'JPG', 'BMP'].map((type, index) => ({
          signatureId: `s${index}`,
          stamp: stamp(`st${index}`, { x: index * 10, y: 0, w: 40, h: 40 }),
          seal: seal(type),
        })),
        decode: async (sealImage) => {
          seen.push(sealImage.type);
          return decoded();
        },
      }),
    });
    expect(bundle.signatureBlocks).toHaveLength(4);
    expect(seen).toEqual(['PNG', 'GIF', 'JPG', 'BMP']);
  });
});
