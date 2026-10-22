/**
 * T14b 真实样本签章回归：h / V4RideRight 的 Signatures.xml + Seal.esl。
 *
 * 这里只通过 model/container 读取签名数据，再以 PreparePageLoader 注入 render；
 * 用于验证 render 不依赖 XML/容器，同时覆盖真实骑缝章切片。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ArrayBufferSource } from '../../src/container/byte-source';
import { ZipReader } from '../../src/container/zip-reader';
import { parseXml } from '../../src/xml/parser';
import { decodeDocument } from '../../src/model/decode';
import { decodeSignatureBundle } from '../../src/model/signature';
import { decodeWithImageDecoder } from '../../src/image/format';
import type { PageResourceScope } from '../../src/resource/types';
import type { PageModel, SealImage } from '../../src/model/types';
import type { PreparePageLoader, SignatureStampSource } from '../../src/render/prepare';
import { preparePage } from '../../src/render/prepare';
import { drawPage } from '../../src/render/page';
import { nodeImageDecoders } from '../helpers/node-image-decoder';
import { FakeRenderer } from '../render/path/fake-renderer';

/** 构造空资源作用域。 */
function scope(): PageResourceScope {
  const empty = new Map();
  return {
    pageId: 'p',
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

/** 构造最小页面模型；签章测试不需要页面内容。 */
function page(id: string): PageModel {
  return {
    id,
    area: { x: 0, y: 0, w: 210, h: 297 },
    size: { width: 210, height: 297 },
    layers: [],
    templates: [],
    pageRes: [],
  };
}

/** 用真实 ZIP 读取签名索引与 Seal 图片。 */
async function readSignatureSources(ofdPath: string): Promise<{
  pageIds: string[];
  sources: SignatureStampSource[][];
}> {
  const zip = await ZipReader.open(new ArrayBufferSource(readFileSync(ofdPath)));
  try {
    const documentNode = parseXml(await zip.readEntry('Doc_0/Document.xml'));
    const document = decodeDocument(documentNode, 'Doc_0/Document.xml');
    const signaturesPath = 'Doc_0/Signs/Signatures.xml';
    const indexNode = parseXml(await zip.readEntry(signaturesPath));
    const bundle = await decodeSignatureBundle({
      index: indexNode,
      indexFilePath: signaturesPath,
      pageIds: document.pages.map((item) => item.id),
      readFile: (path) => zip.readEntry(path),
    });
    const sources = document.pages.map((_, pageIndex) => {
      const stamps = bundle.pageIndex[pageIndex] ?? [];
      return stamps.map((stamp) => {
        const signature = bundle.signatures.find((item) => item.stamps.includes(stamp));
        if (!signature) throw new Error(`StampAnnot ${stamp.id ?? ''} 找不到所属签名`);
        return {
          signatureId: signature.id,
          stamp,
          ...(signature.seal ? { seal: signature.seal } : {}),
        };
      });
    });
    return { pageIds: document.pages.map((item) => item.id), sources };
  } finally {
    await zip.close();
  }
}

/** 注入真实 Seal 图片解码的 loader。 */
function loader(stamps: readonly SignatureStampSource[]): PreparePageLoader {
  return {
    async loadFontFaces() {
      return new Map();
    },
    async decodeImage() {
      throw new Error('签章测试不加载页面图片');
    },
    async loadTemplatePage() {
      throw new Error('签章测试不加载模板');
    },
    async loadAnnotations() {
      return [];
    },
    async loadSignatureStamps() {
      return stamps;
    },
    async decodeSeal(seal: SealImage) {
      const decoded = await decodeWithImageDecoder(seal.data, seal.type.toLowerCase(), nodeImageDecoders, {
        maxPixels: 1_000_000,
      });
      if (!decoded) throw new Error(`Seal ${seal.type} 解码失败`);
      return decoded;
    },
  };
}

describe('真实样本签章', () => {
  const samples = [
    { name: 'h.ofd', perPage: [2, 1, 1, 1, 1] },
    { name: 'V4RideRight.ofd', perPage: [1, 1, 1, 1, 1] },
  ] as const;

  for (const sample of samples) {
    it(`${sample.name} 按 PageRef 分组并绘制 Seal 骑缝章`, async () => {
      const path = fileURLToPath(new URL(`../../../../ofd_pdf_match/${sample.name}`, import.meta.url));
      const { pageIds, sources } = await readSignatureSources(path);
      expect(pageIds).toEqual(['1', '21', '43', '63', '83']);
      expect(sources.map((item) => item.length)).toEqual(sample.perPage);

      for (const [index, stamps] of sources.entries()) {
        let bundle;
        try {
          bundle = await preparePage({
            page: page(pageIds[index]!),
            resources: scope(),
            loader: loader(stamps),
          });
        } catch (error) {
          throw new Error(`第 ${index + 1} 页准备失败：${String(error)}`);
        }
        expect(bundle.signatureBlocks).toHaveLength(sample.perPage[index]!);
        expect(bundle.signatureBlocks.map((block) => block.boundary)).toEqual(
          stamps.map((source) => source.stamp.boundary),
        );
        if (sample.name === 'h.ofd' && index === 0) {
          // h 第 1 页：右缘 8mm 骑缝章 + 左上完整章；完整章无 Clip。
          expect(bundle.signatureBlocks.map((block) => Boolean(block.stamp.clip))).toEqual([true, false]);
          expect(bundle.signatureBlocks[1]?.displayList.commands.map((command) => command.op)).toEqual([
            'drawImage',
          ]);
        }

        const renderer = new FakeRenderer();
        drawPage(bundle, renderer, {} as never, { width: 794, height: 1123, dpi: 96 });
        expect(renderer.callsOf('createImage')).toHaveLength(sample.perPage[index]!);
        expect(renderer.callsOf('drawImage')).toHaveLength(sample.perPage[index]!);
        expect(renderer.callsOf('drawImage').every((call) => {
          const transform = call.args[1] as number[];
          return transform[0] === 40 && transform[3] === 40;
        })).toBe(true);
      }
    });
  }
});
