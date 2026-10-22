/**
 * T7 公共 API：打开、来源、页尺寸回退、模板/注释注入与错误码。
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { isOFDError } from '../../src/errors';
import { ArrayBufferSource } from '../../src/container/byte-source';
import {
  OFD_NS,
  buildFixtureOfd,
  createPng,
  createTestCanvas,
  createTestRenderer,
  openTestDocument,
  renderPage,
} from './helpers';
import { buildXmlDocument } from '../fixtures/xml';
import type { XmlElementSpec } from '../fixtures/xml';

/** 读取错误码。 */
function errorCode(error: unknown): string | undefined {
  return isOFDError(error) ? error.code : undefined;
}

/** 捕获 promise 拒绝并返回错误。 */
async function rejectOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('promise 未按预期拒绝');
}

/** 页对象：纯色填充矩形。 */
function filledRect(
  id: number,
  boundary: string,
  color: string,
  extraAttrs: Record<string, string | number> = {},
): XmlElementSpec {
  return {
    name: 'ofd:PathObject',
    attrs: { ID: id, Boundary: boundary, Fill: 'true', Stroke: 'false', ...extraAttrs },
    children: [
      {
        name: 'ofd:AbbreviatedData',
        children: ['M 0 0 L 10 0 L 10 10 L 0 10 Z'],
      },
      { name: 'ofd:FillColor', attrs: { Value: color } },
    ],
  };
}

/** 构造两页最小包。 */
function buildTwoPageOfd(): Uint8Array {
  return buildFixtureOfd({
    pages: [
      { id: 1, widthMm: 100, heightMm: 200, objects: [filledRect(11, '0 0 10 10', '255 0 0')] },
      { id: 2, widthMm: 50, heightMm: 80, objects: [filledRect(21, '0 0 10 10', '0 0 255')] },
    ],
  });
}

describe('OFDDocument 打开与来源', () => {
  it('arraybuffer 来源：页数、页尺寸与 getViewport', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      expect(doc.pageCount).toBe(2);
      const first = await doc.getPage(0);
      expect(first.index).toBe(0);
      expect(first.getSize()).toEqual({ width: 100, height: 200 });
      const viewport = first.getViewport({ dpi: 300 });
      // viewport 固定保留 3 位小数（0.001px）。
      expect(viewport.width).toBe(1181.102);
      expect(viewport.height).toBe(2362.205);
      expect(viewport.dpi).toBe(300);
      expect(first.getViewport()).toEqual(first.getViewport({ dpi: 96 }));
      const second = await doc.getPage(1);
      expect(second.getSize()).toEqual({ width: 50, height: 80 });
    } finally {
      await doc.close();
    }
  });

  it('页码越界返回 OFD_PAGE_NOT_FOUND', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      for (const index of [-1, 2, 1.5]) {
        const error = await rejectOf(doc.getPage(index));
        expect(errorCode(error)).toBe('OFD_PAGE_NOT_FOUND');
      }
    } finally {
      await doc.close();
    }
  });

  it('blob 来源可打开并渲染', async () => {
    const bytes = buildTwoPageOfd();
    const doc = await openTestDocument(bytes, {
      source: { kind: 'blob', blob: new Blob([new Uint8Array(bytes)]) },
    });
    try {
      const page = await doc.getPage(0);
      const { canvas } = await renderPage(page);
      expect(canvas.pixel(4, 4)).toEqual([255, 0, 0, 255]);
    } finally {
      await doc.close();
    }
  });

  it('custom 来源直接使用宿主 ByteSource', async () => {
    const bytes = buildTwoPageOfd();
    let reads = 0;
    const base = new ArrayBufferSource(bytes);
    const doc = await openTestDocument(bytes, {
      source: {
        kind: 'custom',
        source: {
          size: base.size,
          read: async (offset, length) => {
            reads += 1;
            return base.read(offset, length);
          },
        },
      },
    });
    try {
      expect(reads).toBeGreaterThan(0);
      expect(doc.pageCount).toBe(2);
    } finally {
      await doc.close();
    }
    expect(reads).toBeGreaterThan(0);
  });

  it('node-file 来源本轮明确不支持（Node 适配另行规划）', async () => {
    const error = await rejectOf(
      openTestDocument(new Uint8Array(0), {
        source: { kind: 'node-file', path: '/tmp/sample.ofd' },
      }),
    );
    expect(errorCode(error)).toBe('OFD_RENDERER_UNSUPPORTED');
  });

  it('wechat-file 来源明确不支持', async () => {
    const error = await rejectOf(
      openTestDocument(new Uint8Array(0), {
        source: { kind: 'wechat-file', filePath: 'wxfile://tmp/a.ofd' },
      }),
    );
    expect(errorCode(error)).toBe('OFD_RENDERER_UNSUPPORTED');
  });

  it('url 来源（HTTP Range）可打开与渲染', async () => {
    const bytes = buildTwoPageOfd();
    const payload = Buffer.from(bytes);
    const server = createServer((request, response) => {
      if (request.method === 'HEAD') {
        response.writeHead(200, { 'Content-Length': payload.byteLength, 'Accept-Ranges': 'bytes' });
        response.end();
        return;
      }
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(Number(range[2]), payload.byteLength - 1);
        response.writeHead(206, {
          'Content-Type': 'application/ofd',
          'Content-Range': `bytes ${start}-${end}/${payload.byteLength}`,
          'Content-Length': end - start + 1,
        });
        response.end(payload.subarray(start, end + 1));
        return;
      }
      response.writeHead(200, { 'Content-Length': payload.byteLength });
      response.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const doc = await openTestDocument(bytes, {
        source: { kind: 'url', url: `http://127.0.0.1:${port}/sample.ofd` },
      });
      try {
        expect(doc.pageCount).toBe(2);
        const page = await doc.getPage(0);
        const { canvas } = await renderPage(page);
        expect(canvas.pixel(4, 4)).toEqual([255, 0, 0, 255]);
      } finally {
        await doc.close();
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('缺少 source / 非法 ZIP 返回 OFD_INVALID_PACKAGE', async () => {
    const missing = await rejectOf(
      // 故意构造缺少 source 的输入。
      Promise.resolve().then(() => openTestDocument(new Uint8Array(0), { source: undefined as never })),
    );
    expect(errorCode(missing)).toBe('OFD_INVALID_PACKAGE');
    const invalid = await rejectOf(openTestDocument(new Uint8Array([1, 2, 3, 4])));
    expect(errorCode(invalid)).toBe('OFD_INVALID_PACKAGE');
  });

  it.each(['Doc_0/Document.xml', 'Doc_0', ''])('DocRoot=%j 可正确定位 Document.xml', async (docRoot) => {
    const bytes = buildFixtureOfd({
      docRoot,
      pages: [{ id: 1, widthMm: 60, heightMm: 90, objects: [filledRect(11, '0 0 10 10', '255 0 0')] }],
    });
    const doc = await openTestDocument(bytes);
    try {
      expect(doc.pageCount).toBe(1);
      expect((await doc.getPage(0)).getSize()).toEqual({ width: 60, height: 90 });
    } finally {
      await doc.close();
    }
  });

  it('真实样本 ofd_pdf_match/hello.ofd 可打开并完成最小渲染', async () => {
    const path = fileURLToPath(new URL('../../../../ofd_pdf_match/hello.ofd', import.meta.url));
    const bytes = new Uint8Array(readFileSync(path));
    const doc = await openTestDocument(bytes);
    try {
      expect(doc.pageCount).toBe(2);
      const page = await doc.getPage(0);
      expect(page.getSize()).toEqual({ width: 210, height: 297 });
      const { canvas } = await renderPage(page);
      expect(canvas.canvas.width).toBeGreaterThan(0);
      expect(canvas.canvas.height).toBeGreaterThan(0);
    } finally {
      await doc.close();
    }
  });

  it('documentIndex 越界返回 OFD_INVALID_PACKAGE', async () => {
    const error = await rejectOf(
      openTestDocument(buildTwoPageOfd(), { documentIndex: 3 }),
    );
    expect(errorCode(error)).toBe('OFD_INVALID_PACKAGE');
  });
});

describe('页尺寸回退、模板与注释注入', () => {
  it('页 Area 优先', async () => {
    const doc = await openTestDocument(
      buildFixtureOfd({
        commonPageArea: { widthMm: 80, heightMm: 160 },
        pages: [{ id: 1, widthMm: 100, heightMm: 120, objects: [] }],
      }),
    );
    try {
      expect((await doc.getPage(0)).getSize()).toEqual({ width: 100, height: 120 });
    } finally {
      await doc.close();
    }
  });

  it('缺页 Area 时取第一个带 Area 的模板并绘制模板内容', async () => {
    const bytes = buildFixtureOfd({
      commonPageArea: { widthMm: 80, heightMm: 160 },
      pages: [{ id: 1, templateIds: [1], objects: [] }],
      templates: [
        {
          id: 1,
          baseLoc: 'Doc_0/Tpl_1',
          widthMm: 120,
          heightMm: 240,
          objects: [filledRect(31, '0 0 60 60', '0 0 255')],
        },
      ],
    });
    const doc = await openTestDocument(bytes);
    try {
      const page = await doc.getPage(0);
      expect(page.getSize()).toEqual({ width: 120, height: 240 });
      const viewport = page.getViewport({ dpi: 96 });
      const canvas = createTestCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      await page.render({
        canvasContext: canvas.context,
        viewport: { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height), dpi: 96 },
      }).promise;
      expect(canvas.pixel(10, 10)).toEqual([0, 0, 255, 255]);
    } finally {
      await doc.close();
    }
  });

  it('缺页/模板 Area 时用 CommonData/PageArea', async () => {
    const doc = await openTestDocument(
      buildFixtureOfd({
        commonPageArea: { widthMm: 80, heightMm: 160 },
        pages: [{ id: 1, objects: [] }],
        templates: [{ id: 1, baseLoc: 'Doc_0/Tpl_1', objects: [] }],
      }),
    );
    try {
      expect((await doc.getPage(0)).getSize()).toEqual({ width: 80, height: 160 });
    } finally {
      await doc.close();
    }
  });

  it('三层都缺失时回退 A4 并 warning', async () => {
    const warnings: string[] = [];
    const doc = await openTestDocument(buildFixtureOfd({ pages: [{ id: 1, objects: [] }] }), {
      onWarning: (warning) => warnings.push(warning.code),
    });
    try {
      expect((await doc.getPage(0)).getSize()).toEqual({ width: 210, height: 297 });
      expect(warnings).toContain('W_BAD_NUMBER');
    } finally {
      await doc.close();
    }
  });

  it('DocumentModel.pageAnnotIndex 注入并按注释外观绘制', async () => {
    const annotationRoot: XmlElementSpec = {
      name: 'ofd:PageAnnot',
      attrs: { 'xmlns:ofd': OFD_NS },
      children: [
        {
          name: 'ofd:Annot',
          attrs: { ID: 100, Type: 'Path' },
          children: [
            {
              name: 'ofd:Appearance',
              attrs: { Boundary: '0 60 40 40' },
              children: [
                {
                  name: 'ofd:PathObject',
                  attrs: { ID: 101, Boundary: '0 0 40 40', Fill: 'true' },
                  children: [
                    {
                      name: 'ofd:AbbreviatedData',
                      children: ['M 0 0 L 40 0 L 40 40 L 0 40 Z'],
                    },
                    { name: 'ofd:FillColor', attrs: { Value: '0 255 0' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const bytes = buildFixtureOfd({
      pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [] }],
      annotations: {
        files: [{ pageId: 1, filePath: 'Annots/Page_1.xml' }],
        entries: [
          {
            name: 'Doc_0/Annots/Page_1.xml',
            data: buildXmlDocument(annotationRoot),
          },
        ],
      },
    });
    const doc = await openTestDocument(bytes);
    try {
      const page = await doc.getPage(0);
      const { canvas } = await renderPage(page);
      // 10mm/70mm 落在绿色注释块内（96dpi ≈ 37.8px / 264.6px）。
      expect(canvas.pixel(38, 265)).toEqual([0, 255, 0, 255]);
      // 注释块之外保持白底。
      expect(canvas.pixel(38, 38)).toEqual([255, 255, 255, 255]);
    } finally {
      await doc.close();
    }
  });

  it('模板 PageRes 与页面 PageRes 参与资源作用域', async () => {
    // 模板与页面各自声明一个 XObject 图片资源；页对象引用页面资源。
    const png = createPng('#00ff00');
    const bytes = buildFixtureOfd({
      pages: [
        {
          id: 1,
          widthMm: 100,
          heightMm: 100,
          templateIds: [1],
          pageRes: ['/Doc_0/Pages/Page_1/Res.xml'],
          objects: [
            {
              name: 'ofd:ImageObject',
              attrs: { ID: 11, Boundary: '10 10 10 10', ResourceID: '10', CTM: '10 0 0 10 0 0' },
            },
          ],
        },
      ],
      templates: [
        {
          id: 1,
          baseLoc: 'Doc_0/Tpl_1',
          widthMm: 100,
          heightMm: 100,
          pageRes: ['/Doc_0/Tpl_1/Res.xml'],
          objects: [],
        },
      ],
      extraEntries: [
        { name: 'Doc_0/Pages/Page_1/Res.xml', data: buildXmlDocument(resXml('10', 'page.png')) },
        { name: 'Doc_0/Tpl_1/Res.xml', data: buildXmlDocument(resXml('11', 'tpl.png')) },
        { name: 'Doc_0/Pages/Page_1/page.png', data: png },
        { name: 'Doc_0/Tpl_1/tpl.png', data: png },
      ],
    });
    const doc = await openTestDocument(bytes);
    try {
      const page = await doc.getPage(0);
      const { canvas } = await renderPage(page);
      expect(canvas.pixel(57, 57)).toEqual([0, 255, 0, 255]);
    } finally {
      await doc.close();
    }
  });
});

/** 生成含单个图片资源的 Resource XML。 */
function resXml(id: string, mediaFile: string): XmlElementSpec {
  return {
    name: 'ofd:Res',
    attrs: { 'xmlns:ofd': OFD_NS },
    children: [
      {
        name: 'ofd:MultiMedias',
        children: [
          {
            name: 'ofd:MultiMedia',
            attrs: { ID: id, Type: 'Image', Format: 'PNG' },
            children: [{ name: 'ofd:MediaFile', children: [mediaFile] }],
          },
        ],
      },
    ],
  };
}