/**
 * T14c 签章 API 接线：Signatures.xml/Seal.esl 通过 PreparePageLoader 进入页面渲染。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it, vi } from 'vitest';
import { ArrayBufferSource } from '../../src/container/byte-source';
import { ZipReader } from '../../src/container/zip-reader';
import type { Canvas2DLike } from '../../src/renderer/types';
import { RecordingRenderer } from '../../src/renderer/recording';
import type { OFDWarning } from '../../src/warnings';
import type { XmlElementSpec } from '../fixtures/xml';
import { ensureFixtures, readFixture } from '../font/fixtures';
import { nodeImageDecoders } from '../helpers/node-image-decoder';
import { buildFixtureOfd, createTestCanvas, openTestDocument, renderPage } from './helpers';

const fixtures = ensureFixtures();

/**
 * 构造文本对象。
 *
 * @param id 对象 ID。
 * @param text 文本内容。
 * @returns TextObject XML 描述。
 */
function textObject(id: number, text: string): XmlElementSpec {
  return {
    name: 'ofd:TextObject',
    attrs: { ID: id, Boundary: '10 10 40 20', Font: 1, Size: 10 },
    children: [
      {
        name: 'ofd:TextCode',
        attrs: { X: 0, Y: 10 },
        children: [text],
      },
    ],
  };
}

/**
 * 构造含文本、但字体资源没有内嵌 FontFile 的矢量章 OFD。
 *
 * @param text 页面文本。
 * @returns OFD ZIP 字节。
 */
function vectorTextOfd(text: string): Uint8Array {
  return buildFixtureOfd({
    pages: [{ id: 1, widthMm: 60, heightMm: 30, objects: [textObject(1, text)] }],
    documentRes: [
      {
        path: 'Doc_0/Res/Res.xml',
        children: [
          {
            name: 'ofd:Fonts',
            children: [
              {
                name: 'ofd:Font',
                attrs: {
                  ID: 1,
                  FontName: 'Missing Vector Font',
                  FamilyName: 'Missing Vector Font',
                  Charset: 'unicode',
                },
              },
            ],
          },
        ],
      },
    ],
  });
}

/** 读取样本字节。 */
function sample(name: string): Uint8Array {
  const path = fileURLToPath(new URL(`../../../../ofd_pdf_match/${name}`, import.meta.url));
  return new Uint8Array(readFileSync(path));
}

/** 从真实样本读取 SignedValue.dat。 */
async function sampleSignedValue(name: string): Promise<Uint8Array> {
  const zip = await ZipReader.open(new ArrayBufferSource(sample(name)));
  try {
    return new Uint8Array(await zip.readEntry('Doc_0/Signs/Sign_0/SignedValue.dat'));
  } finally {
    await zip.close();
  }
}

/** 用 SignedValue 字节构造带签章索引的最小 OFD。 */
function signedValuePackage(signedValue: Uint8Array): Uint8Array {
  const signature = `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Signature xmlns:ofd="http://www.ofdspec.org/2016"><ofd:SignedInfo>
<ofd:StampAnnot ID="1" PageRef="1" Boundary="10 10 34 26"/>
</ofd:SignedInfo><ofd:SignedValue>SignedValue.dat</ofd:SignedValue></ofd:Signature>`;
  const index = `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Signatures xmlns:ofd="http://www.ofdspec.org/2016">
<ofd:Signature ID="1" Type="Seal" BaseLoc="/Doc_0/Signs/Sign_0/Signature.xml"/>
</ofd:Signatures>`;
  return buildFixtureOfd({
    pages: [{ id: 1, objects: [] }],
    extraEntries: [
      { name: 'Doc_0/Signs/Signatures.xml', data: index },
      { name: 'Doc_0/Signs/Sign_0/Signature.xml', data: signature },
      { name: 'Doc_0/Signs/Sign_0/SignedValue.dat', data: signedValue },
    ],
  });
}

/** 查找 ZIP 本地文件头偏移；找不到返回 -1。 */
function zipOffset(data: Uint8Array): number {
  for (let index = 0; index + 4 <= data.length; index += 1) {
    if (data[index] === 0x50 && data[index + 1] === 0x4b && data[index + 2] === 3 && data[index + 3] === 4) {
      return index;
    }
  }
  return -1;
}

/** 判断画布中是否存在红色像素（矢量印章线条）。 */
function canvasHasRedPixel(canvas: Canvas2DLike): boolean {
  if (canvas.width <= 0 || canvas.height <= 0) return false;
  const context = canvas.getContext('2d') as unknown as {
    getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray };
  } | null;
  if (!context) return false;
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < data.length; index += 4) {
    if ((data[index] ?? 0) > 150 && (data[index + 1] ?? 0) < 120 && (data[index + 2] ?? 0) < 120) {
      return true;
    }
  }
  return false;
}

/** 判断画布中是否存在深色像素（矢量章文本）。 */
function canvasHasDarkPixel(canvas: Canvas2DLike): boolean {
  if (canvas.width <= 0 || canvas.height <= 0) return false;
  const context = canvas.getContext('2d') as unknown as {
    getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray };
  } | null;
  if (!context) return false;
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < data.length; index += 4) {
    if ((data[index + 3] ?? 0) > 0 && (data[index] ?? 255) < 128) return true;
  }
  return false;
}

/** 收集渲染器中的图片绘制调用。 */
function drawCalls(renderer: RecordingRenderer): Array<{ width: number; height: number }> {
  return renderer.calls.flatMap((call) =>
    call.op === 'drawImage' ? [{ width: call.transform[0] ?? 0, height: call.transform[3] ?? 0 }] : [],
  );
}

describe('签章 API 接线', () => {
  it('h.ofd 通过 loader 读取 Seal.esl 并绘制 2 个印章', async () => {
    const warnings: OFDWarning[] = [];
    const renderer = new RecordingRenderer();
    const readEntry = vi.spyOn(ZipReader.prototype, 'readEntry');
    const doc = await openTestDocument(sample('h.ofd'), {
      renderer,
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      const page = await doc.getPage(0);
      await renderPage(page);
      expect(drawCalls(renderer)).toEqual([
        { width: 40, height: 40 },
        { width: 40, height: 40 },
      ]);
      expect(readEntry.mock.calls.some(([path]) => path === 'Doc_0/Signs/Signatures.xml')).toBe(true);
      expect(readEntry.mock.calls.some(([path]) => /Seal\.esl$/i.test(path))).toBe(true);
      expect(warnings.some((warning) => warning.code === 'W_IMAGE_DECODE')).toBe(false);
    } finally {
      readEntry.mockRestore();
      await doc.close();
    }
  });

  it('hello.ofd 无 Signatures.xml：不读取签章条目且不绘制印章', async () => {
    const warnings: OFDWarning[] = [];
    const renderer = new RecordingRenderer();
    const readEntry = vi.spyOn(ZipReader.prototype, 'readEntry');
    const doc = await openTestDocument(sample('hello.ofd'), {
      renderer,
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      await renderPage(await doc.getPage(0));
      expect(drawCalls(renderer)).toEqual([]);
      expect(readEntry.mock.calls.some(([path]) => /Signs|Seal\.esl/i.test(path))).toBe(false);
      expect(warnings.some((warning) => /签章|Seal/i.test(warning.message))).toBe(false);
    } finally {
      readEntry.mockRestore();
      await doc.close();
    }
  });

  it('同一页重复渲染复用已解码 Seal 图片', async () => {
    const png = nodeImageDecoders.find((decoder) => decoder.format === 'png');
    if (!png) throw new Error('测试环境缺少 PNG 解码器');
    let decodes = 0;
    const countingDecoder = {
      format: 'png',
      decode: async (data: Uint8Array) => {
        decodes += 1;
        return png.decode(data);
      },
    };
    const doc = await openTestDocument(sample('h.ofd'), {
      renderer: new RecordingRenderer(),
      imageDecoders: [countingDecoder],
    });
    try {
      const page = await doc.getPage(0);
      await renderPage(page);
      await renderPage(page);
      // h 的两个签名共享同一 Seal 内容，按 cacheKey 去重后只解码一次。
      expect(decodes).toBe(1);
    } finally {
      await doc.close();
    }
  });

  it('取消 Seal.esl 读取不会把缺少 Seal 的签章集合缓存下来', async () => {
    const warnings: OFDWarning[] = [];
    const renderer = new RecordingRenderer();
    const original = ZipReader.prototype.readEntry;
    let releaseSeal: (() => void) | undefined;
    let notifySealRead: (() => void) | undefined;
    const sealReadStarted = new Promise<void>((resolve) => {
      notifySealRead = resolve;
    });
    const sealGate = new Promise<void>((resolve) => {
      releaseSeal = resolve;
    });
    const readEntry = vi
      .spyOn(ZipReader.prototype, 'readEntry')
      .mockImplementation(async function (
        this: ZipReader,
        path: string,
        options?: Parameters<ZipReader['readEntry']>[1],
      ) {
        if (/Seal\.esl$/i.test(path)) {
          notifySealRead?.();
          await sealGate;
        }
        return original.call(this, path, options);
      });
    const doc = await openTestDocument(sample('ofd-viewer-ui-showcase.ofd'), {
      renderer,
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      // 第 9 页（索引 8）带 StampAnnot s002，首次渲染会触发签章集合加载。
      const page = await doc.getPage(8);
      const viewport = page.getViewport({ dpi: 96 });
      const canvas = createTestCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const size = {
        width: canvas.canvas.width,
        height: canvas.canvas.height,
        dpi: viewport.dpi,
      };
      const controller = new AbortController();
      const task = page.render({
        canvasContext: canvas.context,
        viewport: size,
        signal: controller.signal,
      });
      await sealReadStarted;
      // 模拟 UI 渲染队列在 Seal.esl 读取途中取消本轮渲染。
      controller.abort();
      releaseSeal?.();
      await expect(task.promise).rejects.toMatchObject({ code: 'OFD_ABORTED' });
      // 取消后的重绘不能复用缺少 Seal 的半成品签章集合，也不能把取消报成绘制降级。
      warnings.length = 0;
      await page.render({ canvasContext: canvas.context, viewport: size }).promise;
      expect(warnings.some((warning) => warning.message.includes('缺少 Seal 图片'))).toBe(false);
      expect(
        warnings.some(
          (warning) => warning.code === 'W_UNSUPPORTED_PAINT' && warning.message.includes('签章'),
        ),
      ).toBe(false);
      expect(drawCalls(renderer)).toHaveLength(1);
    } finally {
      readEntry.mockRestore();
      await doc.close();
    }
  });

  it('Seal 图片解码失败只 warning，页面继续渲染', async () => {
    const warnings: OFDWarning[] = [];
    const renderer = new RecordingRenderer();
    const doc = await openTestDocument(sample('h.ofd'), {
      renderer,
      imageDecoders: [],
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      const page = await doc.getPage(0);
      await expect(renderPage(page)).resolves.toBeDefined();
      expect(warnings.some((warning) => warning.code === 'W_IMAGE_DECODE')).toBe(true);
      expect(drawCalls(renderer)).toEqual([]);
    } finally {
      await doc.close();
    }
  });

  it('Signatures.xml 损坏时 warning 后继续渲染页面', async () => {
    const warnings: OFDWarning[] = [];
    const bytes = buildFixtureOfd({
      pages: [{ id: 1, widthMm: 80, heightMm: 120, objects: [] }],
      extraEntries: [{ name: 'Doc_0/Signs/Signatures.xml', data: '<ofd:Signatures' }],
    });
    const renderer = new RecordingRenderer();
    const doc = await openTestDocument(bytes, {
      renderer,
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      const page = await doc.getPage(0);
      await expect(renderPage(page)).resolves.toBeDefined();
      expect(warnings.some((warning) => warning.code === 'W_BAD_NUMBER' && warning.message.includes('签章索引'))).toBe(true);
    } finally {
      await doc.close();
    }
  });

  it('SignScaleError：SignedValue 的 type=ofd 矢量章按内嵌 OFD 首页渲染', async () => {
    const warnings: OFDWarning[] = [];
    const canvases: Canvas2DLike[] = [];
    const renderer = new RecordingRenderer();
    const doc = await openTestDocument(sample('SignScaleError.ofd'), {
      renderer,
      createCanvas: (width, height) => {
        const canvas = createCanvas(width, height);
        canvases.push(canvas as unknown as Canvas2DLike);
        return canvas as unknown as Canvas2DLike;
      },
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      await renderPage(await doc.getPage(0));
      expect(warnings.some((warning) => warning.code === 'W_IMAGE_DECODE')).toBe(false);
      expect(renderer.calls.filter((call) => call.op === 'drawImage').length).toBeGreaterThan(0);
      expect(canvases.some(canvasHasRedPixel)).toBe(true);
    } finally {
      await doc.close();
    }
  });

  it('不规范资源路径：SignedValue 位图章正常解码且不报缺 Seal', async () => {
    const warnings: OFDWarning[] = [];
    const renderer = new RecordingRenderer();
    const doc = await openTestDocument(sample('不规范资源路径.ofd'), {
      renderer,
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      await renderPage(await doc.getPage(0));
      expect(warnings.some((warning) => warning.code === 'W_IMAGE_DECODE')).toBe(false);
      const draws = renderer.calls.filter((call) => call.op === 'drawImage');
      expect(draws.length).toBeGreaterThan(0);
      expect(draws.some((call) => call.op === 'drawImage' && call.transform[0] === 39.9)).toBe(true);
    } finally {
      await doc.close();
    }
  });

  it('矢量章内嵌 ZIP 损坏只 warning，父页面继续渲染', async () => {
    const raw = await sampleSignedValue('SignScaleError.ofd');
    const corrupt = new Uint8Array(raw);
    const offset = zipOffset(corrupt);
    expect(offset).toBeGreaterThan(0);
    corrupt[offset + 100] = (corrupt[offset + 100] ?? 0) ^ 0xff;
    const warnings: OFDWarning[] = [];
    const renderer = new RecordingRenderer();
    const doc = await openTestDocument(signedValuePackage(corrupt), {
      renderer,
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      await expect(renderPage(await doc.getPage(0))).resolves.toBeDefined();
      expect(warnings.some((warning) => warning.code === 'W_IMAGE_DECODE')).toBe(true);
      expect(renderer.calls.filter((call) => call.op === 'drawImage')).toHaveLength(0);
    } finally {
      await doc.close();
    }
  });

  it('矢量章离屏渲染受像素上限约束', async () => {
    const warnings: OFDWarning[] = [];
    const canvases: Canvas2DLike[] = [];
    const doc = await openTestDocument(sample('SignScaleError.ofd'), {
      renderer: new RecordingRenderer(),
      limits: { maxImagePixels: 1000 },
      createCanvas: (width, height) => {
        const canvas = createCanvas(width, height);
        canvases.push(canvas as unknown as Canvas2DLike);
        return canvas as unknown as Canvas2DLike;
      },
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      await renderPage(await doc.getPage(0));
      expect(warnings.some((warning) => warning.code === 'W_IMAGE_DECODE')).toBe(false);
      expect(
        canvases.some(
          (canvas) => canvas.width * canvas.height <= 1000 && canvasHasRedPixel(canvas),
        ),
      ).toBe(true);
    } finally {
      await doc.close();
    }
  });

  it.skipIf(!fixtures.dejavu)('矢量章内嵌 OFD 使用宿主 defaultFonts 补字', async () => {
    const parentBytes = signedValuePackage(signedValueOfd(vectorTextOfd('AB')));

    // 不传 defaultFonts：嵌套文档缺字体，印章文字空白并上报 W_FONT_MISSING。
    const withoutWarnings: OFDWarning[] = [];
    const withoutCanvases: Canvas2DLike[] = [];
    const without = await openTestDocument(parentBytes, {
      renderer: new RecordingRenderer(),
      createCanvas: (width, height) => {
        const canvas = createCanvas(width, height) as unknown as Canvas2DLike;
        withoutCanvases.push(canvas);
        return canvas;
      },
      onWarning: (warning) => withoutWarnings.push(warning),
    });
    try {
      await renderPage(await without.getPage(0));
      expect(withoutWarnings.some((warning) => warning.code === 'W_FONT_MISSING')).toBe(true);
      expect(withoutCanvases.some(canvasHasDarkPixel)).toBe(false);
    } finally {
      await without.close();
    }

    // 传 defaultFonts：嵌套文档继承默认字体，印章文字可见且不再报缺字体。
    const warnings: OFDWarning[] = [];
    const canvases: Canvas2DLike[] = [];
    const doc = await openTestDocument(parentBytes, {
      renderer: new RecordingRenderer(),
      defaultFonts: [{ data: readFixture(fixtures.dejavu as string), family: 'DejaVu Sans' }],
      createCanvas: (width, height) => {
        const canvas = createCanvas(width, height) as unknown as Canvas2DLike;
        canvases.push(canvas);
        return canvas;
      },
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      await renderPage(await doc.getPage(0));
      expect(warnings.some((warning) => warning.code === 'W_FONT_MISSING')).toBe(false);
      expect(canvases.some(canvasHasDarkPixel)).toBe(true);
    } finally {
      await doc.close();
    }
  });

  it('矢量章嵌套 OFD 不递归加载自身签章', async () => {
    const nestedBytes = buildFixtureOfd({
      pages: [{ id: 1, objects: [] }],
      extraEntries: [{ name: 'Doc_0/Signatures.xml', data: '<not-valid' }],
    });
    const warnings: OFDWarning[] = [];
    const readEntry = vi.spyOn(ZipReader.prototype, 'readEntry');
    const doc = await openTestDocument(signedValuePackage(signedValueOfd(nestedBytes)), {
      renderer: new RecordingRenderer(),
      createCanvas: (width, height) => createCanvas(width, height) as unknown as Canvas2DLike,
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      await renderPage(await doc.getPage(0));
      expect(readEntry.mock.calls.some(([path]) => path === 'Doc_0/Signatures.xml')).toBe(false);
      expect(warnings.some((warning) => warning.code === 'W_IMAGE_DECODE')).toBe(false);
    } finally {
      readEntry.mockRestore();
      await doc.close();
    }
  });
})

/** DER TLV 编码；仅测试构造 SignedValue 用。 */
function derTlv(tag: number, content: Uint8Array): Uint8Array {
  const prefix: number[] = [tag];
  if (content.length < 0x80) prefix.push(content.length);
  else {
    const bytes: number[] = [];
    let value = content.length;
    while (value > 0) {
      bytes.unshift(value & 0xff);
      value >>= 8;
    }
    prefix.push(0x80 | bytes.length, ...bytes);
  }
  return Uint8Array.from([...prefix, ...content]);
}

/** DER SEQUENCE。 */
function derSeq(...children: Uint8Array[]): Uint8Array {
  return derTlv(0x30, Uint8Array.from(children.flatMap((child) => [...child])));
}

/** DER INTEGER（非负小整数）。 */
function derInt(value: number): Uint8Array {
  return derTlv(0x02, Uint8Array.from([value]));
}

/** DER IA5String。 */
function derIa5(value: string): Uint8Array {
  return derTlv(0x16, Uint8Array.from([...value].map((char) => char.charCodeAt(0))));
}

/** DER OCTET STRING。 */
function derOctet(value: Uint8Array): Uint8Array {
  return derTlv(0x04, value);
}

/** 构造只含 type=ofd 图片的 SignedValue DER。 */
function signedValueOfd(zip: Uint8Array): Uint8Array {
  const picture = derSeq(derIa5('ofd'), derOctet(zip), derInt(34), derInt(26));
  const sealInfo = derSeq(
    derSeq(derIa5('ES'), derInt(4), derIa5('V')),
    derIa5('id'),
    derSeq(),
    picture,
  );
  return derSeq(
    derSeq(derInt(4), derSeq(sealInfo, derSeq())),
    derOctet(Uint8Array.from([1])),
    derOctet(Uint8Array.from([2])),
    derOctet(Uint8Array.from([3])),
  );
}
