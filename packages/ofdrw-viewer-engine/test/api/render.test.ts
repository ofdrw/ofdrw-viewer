/**
 * T7 渲染任务：像素输出、尺寸校验、取消、同 Canvas 串行与关闭语义。
 */

import { describe, expect, it } from 'vitest';
import { OFDError, isOFDError } from '../../src/errors';
import type { PageContentFilter } from '../../src/api/types';
import { KNOWN_ANNOTATION_TYPES } from '../../src/index';
import { RecordingRenderer } from '../../src/renderer/recording';
import {
  OFD_NS,
  buildFixtureOfd,
  createPng,
  createTestCanvas,
  openTestDocument,
  renderPage,
  trackRenderer,
  createTestRenderer,
} from './helpers';
import { buildXmlDocument } from '../fixtures/xml';
import type { XmlElementSpec } from '../fixtures/xml';

/** 捕获 promise 拒绝并返回错误。 */
async function rejectOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('promise 未按预期拒绝');
}

/** 取错误码。 */
function errorCode(error: unknown): string | undefined {
  return isOFDError(error) ? error.code : undefined;
}

/** 100×100mm 单页，左上角 10mm 红色矩形。 */
function buildPageOfd(): Uint8Array {
  const red: XmlElementSpec = {
    name: 'ofd:PathObject',
    attrs: {
      ID: 11,
      Boundary: '0 0 10 10',
      Fill: 'true',
      Stroke: 'false',
    },
    children: [
      {
        name: 'ofd:AbbreviatedData',
        children: ['M 0 0 L 10 0 L 10 10 L 0 10 Z'],
      },
      { name: 'ofd:FillColor', attrs: { Value: '255 0 0' } },
    ],
  };
  return buildFixtureOfd({ pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [red] }] });
}

describe('页面渲染', () => {
  it('按 viewport 绘制且不改变 canvas 尺寸/背景', async () => {
    const doc = await openTestDocument(buildPageOfd());
    try {
      const page = await doc.getPage(0);
      expect(page.getSize()).toEqual({ width: 100, height: 100 });
      const { canvas, viewport } = await renderPage(page, { dpi: 300 });
      expect(canvas.canvas.width).toBe(Math.ceil(viewport.width));
      expect(canvas.canvas.height).toBe(Math.ceil(viewport.height));
      // 10mm ≈ 118px；取左上角内部像素。
      expect(canvas.pixel(10, 10)).toEqual([255, 0, 0, 255]);
      // 矩形外保持宿主预置的白底。
      expect(canvas.pixel(400, 400)).toEqual([255, 255, 255, 255]);
    } finally {
      await doc.close();
    }
  });

  it('canvas 小于 viewport 返回 OFD_CANVAS_SIZE_MISMATCH', async () => {
    const doc = await openTestDocument(buildPageOfd());
    try {
      const page = await doc.getPage(0);
      const viewport = page.getViewport();
      const small = createTestCanvas(100, 100);
      const task = page.render({
        canvasContext: small.context,
        viewport: { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height), dpi: 96 },
      });
      const error = await rejectOf(task.promise);
      expect(errorCode(error)).toBe('OFD_CANVAS_SIZE_MISMATCH');
    } finally {
      await doc.close();
    }
  });

  it('viewport 超过 maxCanvasPixels 返回 OFD_CANVAS_TOO_LARGE', async () => {
    const doc = await openTestDocument(buildPageOfd(), {
      limits: { maxCanvasPixels: 1000 },
    });
    try {
      const page = await doc.getPage(0);
      const viewport = page.getViewport();
      const canvas = createTestCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      const error = await rejectOf(
        page.render({
          canvasContext: canvas.context,
          viewport: { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height), dpi: 96 },
        }).promise,
      );
      expect(errorCode(error)).toBe('OFD_CANVAS_TOO_LARGE');
    } finally {
      await doc.close();
    }
  });

  it('非法 viewport 返回 OFD_CANVAS_SIZE_MISMATCH', async () => {
    const doc = await openTestDocument(buildPageOfd());
    try {
      const page = await doc.getPage(0);
      const canvas = createTestCanvas(400, 400);
      const error = await rejectOf(
        page.render({
          canvasContext: canvas.context,
          viewport: { width: 0, height: Number.NaN, dpi: 96 },
        }).promise,
      );
      expect(errorCode(error)).toBe('OFD_CANVAS_SIZE_MISMATCH');
    } finally {
      await doc.close();
    }
  });

  it('task.cancel() 以 OFD_ABORTED 结束', async () => {
    const doc = await openTestDocument(buildPageOfd());
    try {
      const page = await doc.getPage(0);
      const canvas = createTestCanvas(378, 378);
      const task = page.render({
        canvasContext: canvas.context,
        viewport: { width: 378, height: 378, dpi: 96 },
      });
      task.cancel();
      const error = await rejectOf(task.promise);
      expect(error).toBeInstanceOf(OFDError);
      expect(errorCode(error)).toBe('OFD_ABORTED');
      // 重复取消无副作用。
      task.cancel();
    } finally {
      await doc.close();
    }
  });

  it('宿主 AbortSignal 预先中止时以 OFD_ABORTED 结束', async () => {
    const doc = await openTestDocument(buildPageOfd());
    try {
      const page = await doc.getPage(0);
      const canvas = createTestCanvas(378, 378);
      const controller = new AbortController();
      controller.abort();
      const error = await rejectOf(
        page.render({
          canvasContext: canvas.context,
          viewport: { width: 378, height: 378, dpi: 96 },
          signal: controller.signal,
        }).promise,
      );
      expect(errorCode(error)).toBe('OFD_ABORTED');
    } finally {
      await doc.close();
    }
  });

  it('同一 Canvas 的并发渲染串行执行', async () => {
    const tracked = trackRenderer(createTestRenderer());
    const doc = await openTestDocument(buildPageOfd(), { renderer: tracked.renderer });
    try {
      const page = await doc.getPage(0);
      const canvas = createTestCanvas(378, 378);
      const viewport = { width: 378, height: 378, dpi: 96 };
      const first = page.render({ canvasContext: canvas.context, viewport });
      const second = page.render({ canvasContext: canvas.context, viewport });
      await Promise.all([first.promise, second.promise]);
      expect(tracked.stats.begin).toBe(2);
      expect(tracked.stats.end).toBe(2);
      expect(tracked.stats.maxConcurrent).toBe(1);
      expect(canvas.pixel(10, 10)).toEqual([255, 0, 0, 255]);
    } finally {
      await doc.close();
    }
  });

  it('不同 Canvas 的渲染互不影响', async () => {
    const doc = await openTestDocument(buildPageOfd());
    try {
      const page = await doc.getPage(0);
      const a = createTestCanvas(378, 378);
      const b = createTestCanvas(378, 378);
      const viewport = { width: 378, height: 378, dpi: 96 };
      await Promise.all([
        page.render({ canvasContext: a.context, viewport }).promise,
        page.render({ canvasContext: b.context, viewport }).promise,
      ]);
      expect(a.pixel(10, 10)).toEqual([255, 0, 0, 255]);
      expect(b.pixel(10, 10)).toEqual([255, 0, 0, 255]);
    } finally {
      await doc.close();
    }
  });

  it('close() 幂等，关闭后 getPage/render 返回 OFD_CLOSED', async () => {
    const doc = await openTestDocument(buildPageOfd());
    const page = await doc.getPage(0);
    await doc.close();
    await doc.close();
    const pageError = await rejectOf(doc.getPage(0));
    expect(errorCode(pageError)).toBe('OFD_CLOSED');
    const canvas = createTestCanvas(378, 378);
    const renderError = await rejectOf(
      page.render({
        canvasContext: canvas.context,
        viewport: { width: 378, height: 378, dpi: 96 },
      }).promise,
    );
    expect(errorCode(renderError)).toBe('OFD_CLOSED');
  });

  it('close() 中止进行中的渲染', async () => {
    const doc = await openTestDocument(buildPageOfd());
    const page = await doc.getPage(0);
    const canvas = createTestCanvas(378, 378);
    const task = page.render({
      canvasContext: canvas.context,
      viewport: { width: 378, height: 378, dpi: 96 },
    });
    await doc.close();
    const error = await rejectOf(task.promise);
    // close 与 render 的竞态：未开始校验时为 OFD_CLOSED，已进入准备/绘制时为 OFD_ABORTED。
    expect(['OFD_ABORTED', 'OFD_CLOSED']).toContain(errorCode(error));
  });

  it('渲染失败后可继续渲染（串行链不会卡死）', async () => {
    const doc = await openTestDocument(buildPageOfd());
    try {
      const page = await doc.getPage(0);
      const small = createTestCanvas(50, 50);
      const failed = page.render({
        canvasContext: small.context,
        viewport: { width: 378, height: 378, dpi: 96 },
      });
      await rejectOf(failed.promise);
      const ok = createTestCanvas(378, 378);
      await page.render({
        canvasContext: ok.context,
        viewport: { width: 378, height: 378, dpi: 96 },
      }).promise;
      expect(ok.pixel(10, 10)).toEqual([255, 0, 0, 255]);
    } finally {
      await doc.close();
    }
  });
});

/** 正文层红色矩形，位于左上 10mm 内；其余区域保持宿主白底。 */
function bodyRect(): XmlElementSpec {
  return {
    name: 'ofd:PathObject',
    attrs: { ID: 11, Boundary: '0 0 10 10', Fill: 'true', Stroke: 'false' },
    children: [
      { name: 'ofd:AbbreviatedData', children: ['M 0 0 L 10 0 L 10 10 L 0 10 Z'] },
      { name: 'ofd:FillColor', attrs: { Value: '255 0 0' } },
    ],
  };
}

/**
 * 合成 100×100mm 单页：正文层红色矩形 + 绿色 Highlight 注释 + 蓝色位图签章。
 *
 * @param options 是否附加注释与签章。
 * @returns OFD ZIP 字节。
 */
function buildFilterOfd(options: { annotation: boolean; signature: boolean }): Uint8Array {
  const annotationRoot: XmlElementSpec = {
    name: 'ofd:PageAnnot',
    attrs: { 'xmlns:ofd': OFD_NS },
    children: [
      {
        name: 'ofd:Annot',
        attrs: { ID: 100, Type: 'Highlight' },
        children: [
          {
            name: 'ofd:Appearance',
            attrs: { Boundary: '50 50 20 20' },
            children: [
              {
                name: 'ofd:PathObject',
                attrs: { ID: 101, Boundary: '0 0 20 20', Fill: 'true', Stroke: 'false' },
                children: [
                  { name: 'ofd:AbbreviatedData', children: ['M 0 0 L 20 0 L 20 20 L 0 20 Z'] },
                  { name: 'ofd:FillColor', attrs: { Value: '0 255 0' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  return buildFixtureOfd({
    pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [bodyRect()] }],
    ...(options.annotation
      ? {
          annotations: {
            files: [{ pageId: 1, filePath: 'Annots/Page_1.xml' }],
            entries: [{ name: 'Doc_0/Annots/Page_1.xml', data: buildXmlDocument(annotationRoot) }],
          },
        }
      : {}),
    ...(options.signature
      ? {
          extraEntries: [
            {
              name: 'Doc_0/Signs/Signatures.xml',
              data: `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Signatures xmlns:ofd="http://www.ofdspec.org/2016">
<ofd:Signature ID="1" Type="Seal" BaseLoc="/Doc_0/Signs/Sign_0/Signature.xml"/>
</ofd:Signatures>`,
            },
            {
              name: 'Doc_0/Signs/Sign_0/Signature.xml',
              data: `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Signature xmlns:ofd="http://www.ofdspec.org/2016"><ofd:SignedInfo>
<ofd:StampAnnot ID="s1" PageRef="1" Boundary="50 50 40 40"/>
</ofd:SignedInfo><ofd:SignedValue>SignedValue.dat</ofd:SignedValue></ofd:Signature>`,
            },
            { name: 'Doc_0/Signs/Sign_0/SignedValue.dat', data: sealPngSignedValue() },
          ],
        }
      : {}),
  });
}

/**
 * 构造内嵌 1×1 蓝色 PNG 的 v1 签章 DER。
 *
 * @returns SignedValue.dat 字节。
 */
function sealPngSignedValue(): Uint8Array {
  const png = createPng('#0000ff');
  const picture = derSeq(derIa5('PNG'), derOctet(png), derInt(40), derInt(40));
  const sealInfo = derSeq(
    derSeq(derIa5('ES'), derInt(4), derIa5('V')),
    derIa5('id'),
    derSeq(),
    picture,
  );
  return derSeq(derSeq(derInt(4), derSeq(sealInfo, derSeq())), derOctet(Uint8Array.from([1])));
}

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

/** 单次页面绘制中被记录的内容：正文填充、注释填充、签章图片。 */
interface DrawnContent {
  /** 是否有红色正文填充（#ff0000）。 */
  body: boolean;
  /** 注释外观是否绘制：绿色填充（#00ff00）。 */
  annotation: boolean;
  /** 是否绘制签章图片。 */
  signature: boolean;
}

/**
 * 用 RecordingRenderer 渲染一页并返回本次绘制内容；不产生像素。
 *
 * @param page 页面。
 * @param renderer 记录渲染器；每次调用前清空。
 * @param contentFilter 可选内容过滤。
 * @returns 本次调用的绘制内容。
 */
async function drawFiltered(
  page: Parameters<typeof renderPage>[0],
  renderer: RecordingRenderer,
  contentFilter?: PageContentFilter,
): Promise<DrawnContent> {
  renderer.calls.length = 0;
  await page.render({
    canvasContext: createTestCanvas(378, 378).context,
    viewport: { width: 378, height: 378, dpi: 96 },
    ...(contentFilter !== undefined ? { contentFilter } : {}),
  }).promise;
  const fills = renderer.calls.filter(
    (call): call is Extract<(typeof renderer.calls)[number], { op: 'fill' }> => call.op === 'fill',
  );
  const hasFill = (r: number, g: number, b: number): boolean =>
    fills.some(
      (call) =>
        call.paint.kind === 'color' &&
        call.paint.rgba.r === r &&
        call.paint.rgba.g === g &&
        call.paint.rgba.b === b,
    );
  return {
    body: hasFill(255, 0, 0),
    annotation: hasFill(0, 255, 0),
    signature: renderer.calls.some((call) => call.op === 'drawImage'),
  };
}

describe('页面渲染 contentFilter', () => {
  it('不传 contentFilter 或传与全画等价的配置：与改动前一致（层/注释/签章全画）', async () => {
    const renderer = new RecordingRenderer();
    const doc = await openTestDocument(buildFilterOfd({ annotation: true, signature: true }), {
      renderer,
    });
    try {
      const page = await doc.getPage(0);
      expect(await drawFiltered(page, renderer)).toEqual({
        body: true,
        annotation: true,
        signature: true,
      });
      expect(
        await drawFiltered(page, renderer, {
          layers: { background: true, body: true, foreground: true, custom: true },
          annotations: true,
          signatures: true,
        }),
      ).toEqual({ body: true, annotation: true, signature: true });
    } finally {
      await doc.close();
    }
  });

  it('contentFilter 透传到 drawPage：白名单只绘制指定层/注释类型/签章', async () => {
    const renderer = new RecordingRenderer();
    const doc = await openTestDocument(buildFilterOfd({ annotation: true, signature: true }), {
      renderer,
    });
    try {
      const page = await doc.getPage(0);
      expect(await drawFiltered(page, renderer, { layers: { body: true } })).toEqual({
        body: true,
        annotation: false,
        signature: false,
      });
      // annotationTypes 出现即开启注释；页面层与签章都不出现，因此不画。
      expect(await drawFiltered(page, renderer, { annotationTypes: ['Highlight'] })).toEqual({
        body: false,
        annotation: true,
        signature: false,
      });
      expect(await drawFiltered(page, renderer, { signatures: true })).toEqual({
        body: false,
        annotation: false,
        signature: true,
      });
      // 类型不在白名单：注释不画。
      expect(await drawFiltered(page, renderer, { annotationTypes: ['Stamp'] })).toEqual({
        body: false,
        annotation: false,
        signature: false,
      });
      // annotations:false 优先于类型列表。
      expect(
        await drawFiltered(page, renderer, { annotations: false, annotationTypes: ['Highlight'] }),
      ).toEqual({ body: false, annotation: false, signature: false });
    } finally {
      await doc.close();
    }
  });

  it('每次调用独立：不记忆上一次过滤；{} 为空白页；之后不传仍全画', async () => {
    const renderer = new RecordingRenderer();
    const doc = await openTestDocument(buildFilterOfd({ annotation: true, signature: true }), {
      renderer,
    });
    try {
      const page = await doc.getPage(0);
      expect(await drawFiltered(page, renderer, { layers: { body: true } })).toEqual({
        body: true,
        annotation: false,
        signature: false,
      });
      // 不传过滤：重新全画。
      expect(await drawFiltered(page, renderer)).toEqual({
        body: true,
        annotation: true,
        signature: true,
      });
      // {} 是白名单里没有任何内容 → 空白页，但仍正常走 beginPage/endPage。
      expect(await drawFiltered(page, renderer, {})).toEqual({
        body: false,
        annotation: false,
        signature: false,
      });
      expect(renderer.calls.filter((call) => call.op === 'beginPage')).toHaveLength(1);
      expect(renderer.calls.filter((call) => call.op === 'endPage')).toHaveLength(1);
      expect(await drawFiltered(page, renderer)).toEqual({
        body: true,
        annotation: true,
        signature: true,
      });
    } finally {
      await doc.close();
    }
  });

  it('非法 contentFilter 不抛错，按未指定处理（不绘制对应内容）', async () => {
    const renderer = new RecordingRenderer();
    const doc = await openTestDocument(buildFilterOfd({ annotation: true, signature: true }), {
      renderer,
    });
    try {
      const page = await doc.getPage(0);
      expect(
        await drawFiltered(page, renderer, {
          layers: { body: { page: 'yes' as unknown as boolean } },
          annotationTypes: 'Highlight' as unknown as readonly string[],
        }),
      ).toEqual({ body: false, annotation: false, signature: false });
    } finally {
      await doc.close();
    }
  });
});

describe('公共导出：内容过滤类型', () => {
  it('KNOWN_ANNOTATION_TYPES 从包根导出且为冻结常量', () => {
    expect(KNOWN_ANNOTATION_TYPES).toEqual(['Link', 'Path', 'Highlight', 'Stamp', 'Watermark']);
    expect(Object.isFrozen(KNOWN_ANNOTATION_TYPES)).toBe(true);
  });
});
