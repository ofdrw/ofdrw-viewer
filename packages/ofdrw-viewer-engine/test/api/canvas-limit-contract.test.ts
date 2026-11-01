/**
 * 画布像素预算的归属契约：引擎不再内置 64MP 限制，由调用方决策。
 *
 * 回归背景：UI 阅读器按自身 `maxCanvasPixels`（桌面 256MP）收敛画布后调用
 * `page.render()`，而引擎旧默认 64MP 会拒绝该请求（窄长页面从 500% 起必现）。
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_RESOURCE_LIMITS } from '../../src/api/types';
import { OFDDocument } from '../../src/api/document';
import { createTestCanvas, openTestDocument } from './helpers';
import { buildXmlDocument, type XmlElementSpec } from '../fixtures/xml';
import { createZip } from '../fixtures/zip-builder';

const OFD_NS = 'http://www.ofdspec.org/2016';
/** 窄长票据页尺寸，单位 mm。 */
const LONG_PAGE_MM = { width: 215.9, height: 1152.144 };

/**
 * 构造单页窄长 OFD 包。
 *
 * @returns OFD ZIP 字节。
 */
function buildLongPageOfd(): Uint8Array {
  const page = (): XmlElementSpec => ({
    name: 'ofd:Page',
    attrs: { 'xmlns:ofd': OFD_NS },
    children: [
      {
        name: 'ofd:Area',
        children: [
          { name: 'ofd:PhysicalBox', children: [`0 0 ${LONG_PAGE_MM.width} ${LONG_PAGE_MM.height}`] },
        ],
      },
      {
        name: 'ofd:Content',
        children: [
          {
            name: 'ofd:Layer',
            attrs: { ID: 2 },
            children: [
              {
                name: 'ofd:PathObject',
                attrs: { ID: 3, Boundary: '0 0 10 10', Fill: 'true', Stroke: 'false' },
                children: [
                  { name: 'ofd:AbbreviatedData', children: ['M 0 0 L 10 0 L 10 10 L 0 10 Z'] },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  return createZip([
    {
      name: 'OFD.xml',
      data: buildXmlDocument({
        name: 'ofd:OFD',
        attrs: { 'xmlns:ofd': OFD_NS, DocType: 'ofd', Version: '1.1' },
        children: [
          {
            name: 'ofd:DocBody',
            children: [
              { name: 'ofd:DocInfo', children: [{ name: 'ofd:DocID', children: ['long-1'] }] },
              { name: 'ofd:DocRoot', children: ['Doc_0/Document.xml'] },
            ],
          },
        ],
      }),
    },
    {
      name: 'Doc_0/Document.xml',
      data: buildXmlDocument({
        name: 'ofd:Document',
        attrs: { 'xmlns:ofd': OFD_NS },
        children: [
          {
            name: 'ofd:CommonData',
            children: [
              { name: 'ofd:MaxUnitID', children: ['10'] },
              {
                name: 'ofd:PageArea',
                children: [
                  {
                    name: 'ofd:PhysicalBox',
                    children: [`0 0 ${LONG_PAGE_MM.width} ${LONG_PAGE_MM.height}`],
                  },
                ],
              },
            ],
          },
          {
            name: 'ofd:Pages',
            children: [{ name: 'ofd:Page', attrs: { ID: 1, BaseLoc: 'Pages/Page_0/Content.xml' } }],
          },
        ],
      }),
    },
    { name: 'Doc_0/Pages/Page_0/Content.xml', data: buildXmlDocument(page()) },
  ]).bytes;
}

describe('画布像素预算契约', () => {
  it('默认 limits 不限制画布像素', () => {
    expect(DEFAULT_RESOURCE_LIMITS.maxCanvasPixels).toBe(0);
  });

  it('窄长页面在 UI 允许的像素数下可渲染，不被引擎拒绝', async () => {
    const doc = await openTestDocument(buildLongPageOfd());
    try {
      const page = await doc.getPage(0);
      // 500%：UI 侧按 256MP 预算算出的尺寸约 4080×21773（≈88.8MP），旧引擎会拒绝。
      const dpi = 96 * 5;
      const viewport = page.getViewport({ dpi });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      expect(width * height).toBeGreaterThan(64_000_000);
      expect(width * height).toBeLessThanOrEqual(256_000_000);

      const canvas = createTestCanvas(width, height);
      await expect(
        page.render({ canvasContext: canvas.context, viewport: { width, height, dpi } }).promise,
      ).resolves.toBeUndefined();
    } finally {
      await doc.close();
    }
  });

  it('宿主显式设置 limits 时仍按该值拒绝', async () => {
    const doc = await OFDDocument.open({
      source: { kind: 'arraybuffer', data: buildLongPageOfd().slice().buffer as ArrayBuffer },
      limits: { maxCanvasPixels: 1_000_000 },
    });
    try {
      const page = await doc.getPage(0);
      const dpi = 96 * 5;
      const viewport = page.getViewport({ dpi });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      const canvas = createTestCanvas(width, height);
      const error = await page
        .render({ canvasContext: canvas.context, viewport: { width, height, dpi } })
        .promise.then(
          () => null,
          (reason: unknown) => reason as { code?: string },
        );
      expect(error?.code).toBe('OFD_CANVAS_TOO_LARGE');
    } finally {
      await doc.close();
    }
  });
});
