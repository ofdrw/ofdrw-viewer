/**
 * P2 独立验收：权限、附件与导出旋转。
 *
 * renderRegion 已由用户决定不实现；本文件仅确认公开面不导出，不验收区域渲染。
 */

import { createCanvas } from '@napi-rs/canvas';
import type { Canvas } from '@napi-rs/canvas';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import * as api from '@ofdrw/ofdrw-viewer-engine';
import type {
  AttachmentInfo,
  DocumentPermissions,
  PageImageExportOptions,
} from '@ofdrw/ofdrw-viewer-engine';
import type { Canvas2DLike } from '../../src/renderer/types';
import type { OFDWarning } from '../../src/warnings';
import { buildXmlDocument } from '../fixtures/xml';
import type { XmlElementSpec } from '../fixtures/xml';
import type { ZipEntryInput } from '../fixtures/zip-builder';
import { buildFixtureOfd, openTestDocument } from '../api/helpers';

/** 最小单页。 */
function onePage() {
  return [{ id: 1, widthMm: 100, heightMm: 100, objects: [] }];
}

/** 附件索引条目。 */
function attachment(attrs: Record<string, string>, fileLoc?: string): XmlElementSpec {
  return {
    name: 'ofd:Attachment',
    attrs,
    ...(fileLoc ? { children: [{ name: 'ofd:FileLoc', children: [fileLoc] }] } : {}),
  };
}

/** 附件包；declare=false 时不写 Attachments 节点。 */
function attachmentOfd(options: {
  attachments?: XmlElementSpec[];
  entries?: ZipEntryInput[];
  declare?: boolean;
}): Uint8Array {
  const entries: ZipEntryInput[] = [...(options.entries ?? [])];
  if (options.attachments) {
    entries.push({
      name: 'Doc_0/Attachments.xml',
      data: buildXmlDocument({
        name: 'ofd:Attachments',
        attrs: { 'xmlns:ofd': 'http://www.ofdspec.org/2016' },
        children: options.attachments,
      }),
    });
  }
  return buildFixtureOfd({
    pages: onePage(),
    documentChildren: options.declare === false ? [] : [{ name: 'ofd:Attachments', children: ['Attachments.xml'] }],
    extraEntries: entries,
  });
}

/** 100×50mm 页面，左上角 10mm 红色方块。 */
function redPage(count = 1): Uint8Array {
  const red: XmlElementSpec = {
    name: 'ofd:PathObject',
    attrs: { ID: 1, Boundary: '0 0 10 10', Fill: 'true', Stroke: 'false' },
    children: [
      { name: 'ofd:AbbreviatedData', children: ['M 0 0 L 10 0 L 10 10 L 0 10 Z'] },
      { name: 'ofd:FillColor', attrs: { Value: '255 0 0' } },
    ],
  };
  return buildFixtureOfd({ pages: [{ id: 1, widthMm: 100, heightMm: 50, objects: Array.from({ length: count }, () => red) }] });
}

/** Node canvas 编码钩子。 */
function nodeCanvas(width: number, height: number): Canvas2DLike {
  return createCanvas(width, height) as unknown as Canvas2DLike;
}

/** 读取 PNG 像素。 */
function pixel(png: PNG, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.data[i] ?? 0, png.data[i + 1] ?? 0, png.data[i + 2] ?? 0, png.data[i + 3] ?? 0];
}

describe('P2 独立验收', () => {
  it('getPermissions：缺省六项 true，非法字段 warning 回退，print/validPeriod 保留', async () => {
    const plain = await openTestDocument(buildFixtureOfd({ pages: onePage() }));
    try {
      const expected: DocumentPermissions = {
        edit: true,
        annot: true,
        export: true,
        signature: true,
        watermark: true,
        printScreen: true,
      };
      expect(await plain.getPermissions()).toEqual(expected);
    } finally {
      await plain.close();
    }

    const warnings: OFDWarning[] = [];
    const doc = await openTestDocument(
      buildFixtureOfd({
        pages: onePage(),
        documentChildren: [{
          name: 'ofd:Permissions',
          children: [
            { name: 'ofd:Edit', children: ['bad'] },
            { name: 'ofd:Print', attrs: { Printable: 'false', Copies: '3' } },
            { name: 'ofd:ValidPeriod', attrs: { StartDate: '2026-01-01', EndDate: '2026-12-31' } },
          ],
        }],
      }),
      { onWarning: (warning) => warnings.push(warning) },
    );
    try {
      expect(await doc.getPermissions()).toMatchObject({
        edit: true,
        print: { printable: false, copies: 3 },
        validPeriod: { start: '2026-01-01', end: '2026-12-31' },
      });
      expect(warnings.some((warning) => warning.code === 'W_PERMISSION_FIELD')).toBe(true);
    } finally {
      await doc.close();
    }
  });

  it('附件：空声明/多附件元信息/原始字节/缺失文件 warning', async () => {
    const empty = await openTestDocument(attachmentOfd({ declare: false }));
    try {
      expect(await empty.getAttachments()).toEqual([]);
      expect(await empty.getAttachmentData('1')).toBeUndefined();
    } finally {
      await empty.close();
    }

    const raw = Uint8Array.from([0x00, 0xff, 0x3c, 0x62, 0x61, 0x64, 0x3e]);
    const warnings: OFDWarning[] = [];
    const doc = await openTestDocument(
      attachmentOfd({
        attachments: [
          attachment({ ID: '1', Name: ' raw.bin ', Format: 'BIN', Size: '1.5', Visible: 'false', Usage: 'annotation' }, 'Res/raw.bin'),
          attachment({ ID: '2', Name: 'missing.bin' }, 'Res/missing.bin'),
        ],
        entries: [{ name: 'Doc_0/Res/raw.bin', data: raw }],
      }),
      { onWarning: (warning) => warnings.push(warning) },
    );
    try {
      const infos: readonly AttachmentInfo[] = await doc.getAttachments();
      expect(infos[0]).toMatchObject({ id: '1', name: 'raw.bin', size: 1536, visible: false, usage: 'annotation' });
      expect(Array.from((await doc.getAttachmentData('1')) ?? [])).toEqual(Array.from(raw));
      expect(await doc.getAttachmentData('2')).toBeUndefined();
      expect(warnings.some((warning) => warning.code === 'W_ATTACHMENT_RESOURCE')).toBe(true);
    } finally {
      await doc.close();
    }
  });

  it('exportImage.rotation：0/90/180/270 尺寸与红块方向', async () => {
    const doc = await openTestDocument(redPage(), {
      createCanvas: nodeCanvas,
      encodeImage: async (canvas: Canvas2DLike) => {
        const node = canvas as Canvas;
        return new Uint8Array(node.toBuffer('image/png'));
      },
    });
    try {
      const page = await doc.getPage(0);
      const cases: ReadonlyArray<{ rotation: PageImageExportOptions['rotation']; width: number; height: number; red: [number, number] }> = [
        { rotation: 0, width: 378, height: 189, red: [10, 10] },
        { rotation: 90, width: 189, height: 378, red: [188, 0] },
        { rotation: 180, width: 378, height: 189, red: [377, 188] },
        { rotation: 270, width: 189, height: 378, red: [0, 377] },
      ];
      for (const item of cases) {
        const result = await page.exportImage({ rotation: item.rotation });
        expect([result.width, result.height]).toEqual([item.width, item.height]);
        const png = PNG.sync.read(Buffer.from(result.data));
        expect(pixel(png, ...item.red)).toEqual([255, 0, 0, 255]);
        expect(pixel(png, 0, 0)[3]).toBe(255);
      }
    } finally {
      await doc.close();
    }
  });

  it('renderRegion 未实现且不导出；P2 公开方法存在', async () => {
    const doc = await openTestDocument(buildFixtureOfd({ pages: onePage() }));
    try {
      const page = await doc.getPage(0);
      expect((doc as unknown as Record<string, unknown>).renderRegion).toBeUndefined();
      expect((page as unknown as Record<string, unknown>).renderRegion).toBeUndefined();
      expect((api as unknown as Record<string, unknown>).renderRegion).toBeUndefined();
      expect(typeof doc.getPermissions).toBe('function');
      expect(typeof doc.getAttachments).toBe('function');
      expect(typeof doc.getAttachmentData).toBe('function');
      expect(typeof page.exportImage).toBe('function');
    } finally {
      await doc.close();
    }
  });
});
