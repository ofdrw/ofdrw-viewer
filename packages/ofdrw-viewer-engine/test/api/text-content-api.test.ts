/**
 * T17g：OFDPage.getTextContent 接线、DPI/缓存/并发/取消/关闭/上限。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OFDWarning } from '../../src/warnings';
import type { TextContentOptions } from '../../src/api/ui-types';
import { createCanvas } from '@napi-rs/canvas';
import type { CanvasRenderingContext2DLike } from '../../src/renderer/types';
import { buildXmlDocument } from '../fixtures/xml';
import type { XmlElementSpec } from '../fixtures/xml';
import { OFD_NS, buildFixtureOfd, openTestDocument } from './helpers';
import { OFDPage } from '../../src/api/page';
import { isOFDError } from '../../src/errors';
import { findSystemCjkFont } from '../fixtures/fonts';

/** 取错误码。 */
function errorCode(error: unknown): string | undefined {
  return isOFDError(error) ? error.code : undefined;
}

/** 捕获 promise 拒绝。 */
async function rejectOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('promise 未按预期拒绝');
}

/** 构造文本对象。 */
function textObject(id: number, text: string, x = 10, y = 10): XmlElementSpec {
  return {
    name: 'ofd:TextObject',
    attrs: { ID: id, Boundary: `${x} ${y} 60 20`, Font: 1, Size: 10 },
    children: [
      {
        name: 'ofd:TextCode',
        attrs: { X: 0, Y: 10 },
        children: [text],
      },
    ],
  };
}

/** 构造带内嵌字体与文本对象的 100×100mm 页面。 */
function buildTextOfd(objects: XmlElementSpec[]): Uint8Array {
  const font = findSystemCjkFont();
  if (!font) throw new Error('测试环境缺少可用的 CJK 字体');
  return buildFixtureOfd({
    pages: [{ id: 1, widthMm: 100, heightMm: 100, objects }],
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
                  FontName: 'Droid Sans Fallback',
                  FamilyName: 'Droid Sans Fallback',
                  Charset: 'unicode',
                },
                children: [{ name: 'ofd:FontFile', children: ['Font_1.ttf'] }],
              },
            ],
          },
        ],
      },
    ],
    extraEntries: [{ name: 'Doc_0/Res/Font_1.ttf', data: new Uint8Array(readFileSync(font.path)) }],
  });
}

describe('OFDPage.getTextContent', () => {
  it('默认 dpi=96、空页返回空数组、结果使用公开 px 几何', async () => {
    const empty = await openTestDocument(
      buildFixtureOfd({ pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [] }] }),
    );
    try {
      const page = await empty.getPage(0);
      const content = await page.getTextContent();
      expect(content).toMatchObject({
        pageIndex: 0,
        dpi: 96,
        unit: 'px',
        itemCount: 0,
        charCount: 0,
        items: [],
        truncated: { items: false, chars: false },
      });
      expect(content.pageWidth).toBeCloseTo((100 * 96) / 25.4, 6);
      expect(content.pageHeight).toBeCloseTo((100 * 96) / 25.4, 6);
    } finally {
      await empty.close();
    }

    const doc = await openTestDocument(buildTextOfd([textObject(1, 'AB')]));
    try {
      const page = await doc.getPage(0);
      const content = await page.getTextContent({ dpi: 96, includeChars: true });
      expect(content.items).toHaveLength(1);
      const item = content.items[0]!;
      expect(item.text).toBe('AB');
      expect(item.charCount).toBe(2);
      expect(item.chars).toHaveLength(2);
      expect(item.layer).toBe('page');
      expect(item.size).toBeGreaterThan(0);
      expect(item.rect.width).toBeGreaterThan(0);
      expect(item.quad).toHaveLength(4);
      expect(item.font.resourceId).toBe('1');
      expect(item.chars?.[0]!.codePoint).toBe(0x41);
    } finally {
      await doc.close();
    }
  });

  it('dpi 只影响输出换算，mm 缓存复用；非法 dpi 回退 96', async () => {
    const doc = await openTestDocument(buildTextOfd([textObject(1, 'AB')]));
    try {
      const page = await doc.getPage(0);
      const at96 = await page.getTextContent({ dpi: 96, includeChars: false });
      const at144 = await page.getTextContent({ dpi: 144, includeChars: false });
      const at300 = await page.getTextContent({ dpi: 300, includeChars: false });
      const invalid = await page.getTextContent({ dpi: Number.NaN, includeChars: false });
      expect(at96.items[0]!.rect.width).toBeGreaterThan(0);
      expect(at144.items[0]!.rect.width / at96.items[0]!.rect.width).toBeCloseTo(1.5, 6);
      expect(at300.items[0]!.rect.width / at96.items[0]!.rect.width).toBeCloseTo(300 / 96, 6);
      expect(invalid.dpi).toBe(96);
      expect(invalid.items[0]!.rect.width).toBeCloseTo(at96.items[0]!.rect.width, 6);
      expect(at96.items[0]!.chars).toBeUndefined();
    } finally {
      await doc.close();
    }
  });

  it('includeChars/includeInvisible 生效且同一键并发只构建一次', async () => {
    const doc = await openTestDocument(
      buildTextOfd([
        textObject(1, 'AB'),
        { ...textObject(2, 'CD'), attrs: { ID: 2, Boundary: '10 30 60 20', Font: 1, Size: 10, Visible: 'false' } },
      ]),
    );
    try {
      const page = await doc.getPage(0);
      const [a, b] = await Promise.all([
        page.getTextContent({ includeChars: true }),
        page.getTextContent({ includeChars: true }),
      ]);
      expect(a.itemCount).toBe(1);
      expect(b.itemCount).toBe(1);
      expect(a.items[0]!.text).toBe('AB');
      expect(a.items[0]!.chars).toHaveLength(2);
      const withInvisible = await page.getTextContent({ includeInvisible: true, includeChars: false });
      expect(withInvisible.itemCount).toBe(2);
      expect(withInvisible.items.some((item) => item.text === 'CD')).toBe(true);
    } finally {
      await doc.close();
    }
  });

  it('上限截断并 warning，不抛错；maxTextChars 不返回半个 item', async () => {
    const warnings: OFDWarning[] = [];
    const doc = await openTestDocument(
      buildTextOfd([textObject(1, 'AB'), textObject(2, 'CD', 10, 30)]),
      { onWarning: (warning) => warnings.push(warning) },
    );
    try {
      const page = await doc.getPage(0);
      const items = await page.getTextContent({ maxTextItems: 1, includeChars: false });
      expect(items.itemCount).toBe(1);
      expect(items.truncated.items).toBe(true);
      expect(warnings.some((warning) => warning.code === 'W_TEXT_ITEM_LIMIT')).toBe(true);

      const chars = await page.getTextContent({ maxTextChars: 1, includeChars: false });
      expect(chars.itemCount).toBe(0);
      expect(chars.charCount).toBe(0);
      expect(chars.truncated.chars).toBe(true);
      expect(warnings.some((warning) => warning.code === 'W_TEXT_CHAR_LIMIT')).toBe(true);
    } finally {
      await doc.close();
    }
  });

  it('取消返回 OFD_ABORTED，close 返回 OFD_CLOSED 并清缓存', async () => {
    const doc = await openTestDocument(buildTextOfd([textObject(1, 'AB')]));
    let closed = false;
    try {
      const page = await doc.getPage(0);
      const controller = new AbortController();
      const pending = page.getTextContent({ signal: controller.signal, dpi: 144 });
      const remaining = page.getTextContent({ dpi: 144 });
      controller.abort();
      expect(errorCode(await rejectOf(pending))).toBe('OFD_ABORTED');
      // 同一键的另一个 waiter 不受影响。
      expect((await remaining).items).toHaveLength(1);

      const aborted = new AbortController();
      aborted.abort();
      expect(errorCode(await rejectOf(page.getTextContent({ signal: aborted.signal })))).toBe(
        'OFD_ABORTED',
      );
      await page.getTextContent({ dpi: 96 });
      await doc.close();
      closed = true;
      expect(errorCode(await rejectOf(page.getTextContent()))).toBe('OFD_CLOSED');
    } finally {
      if (!closed) await doc.close();
    }
  });

  it('手工 OFDPage 无 text driver 报 OFD_RENDERER_UNSUPPORTED', async () => {
    const page = new OFDPage(0, { width: 100, height: 100 }, async () => undefined);
    expect(errorCode(await rejectOf(page.getTextContent()))).toBe('OFD_RENDERER_UNSUPPORTED');
  });
});

/** 构造注释外观：Boundary 指定位置，内部一个文本对象。 */
function annotAppearance(type: string, id: number, text: string, boundary: string): XmlElementSpec {
  return {
    name: 'ofd:Annot',
    attrs: { ID: id, Type: type },
    children: [
      {
        name: 'ofd:Appearance',
        attrs: { Boundary: boundary },
        children: [
          {
            name: 'ofd:TextObject',
            attrs: { ID: id * 10, Boundary: '0 0 40 10', Font: 1, Size: 8 },
            children: [{ name: 'ofd:TextCode', attrs: { X: 0, Y: 5 }, children: [text] }],
          },
        ],
      },
    ],
  };
}

/**
 * 合成 100×100mm 页面：Body 层一段正文文字 + 两个注释外观（Highlight/Stamp）。
 *
 * 页面自身内容只有 Body 层文字；层过滤用 `layers.body` 与空配置对比。
 *
 * @returns OFD ZIP 字节。
 */
function buildAnnotatedTextOfd(): Uint8Array {
  const font = findSystemCjkFont();
  if (!font) throw new Error('测试环境缺少可用的 CJK 字体');
  const bodyText: XmlElementSpec = {
    name: 'ofd:TextObject',
    attrs: { ID: 2, Boundary: '10 10 60 20', Font: 1, Size: 10 },
    children: [{ name: 'ofd:TextCode', attrs: { X: 0, Y: 10 }, children: ['正文'] }],
  };
  const annotationRoot: XmlElementSpec = {
    name: 'ofd:PageAnnot',
    attrs: { 'xmlns:ofd': OFD_NS },
    children: [
      annotAppearance('Highlight', 201, '高亮', '10 70 40 10'),
      annotAppearance('Stamp', 202, '印章', '10 90 40 10'),
    ],
  };
  return buildFixtureOfd({
    // 页模型通过 helper 的 Page 元素生成；图层内容由内嵌字体所在文档级资源支撑。
    pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [bodyText] }],
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
                  FontName: 'Droid Sans Fallback',
                  FamilyName: 'Droid Sans Fallback',
                  Charset: 'unicode',
                },
                children: [{ name: 'ofd:FontFile', children: ['Font_1.ttf'] }],
              },
            ],
          },
        ],
      },
    ],
    annotations: {
      files: [{ pageId: 1, filePath: 'Annots/Page_1.xml' }],
      entries: [{ name: 'Doc_0/Annots/Page_1.xml', data: buildXmlDocument(annotationRoot) }],
    },
    extraEntries: [
      { name: 'Doc_0/Res/Font_1.ttf', data: new Uint8Array(readFileSync(font.path)) },
    ],
  });
}

/** 提取文本项文字列表。 */
function textsOf(content: { items: Array<{ text: string }> }): string[] {
  return content.items.map((item) => item.text);
}

describe('OFDPage.getTextContent contentFilter', () => {
  it('不传 contentFilter：页面文字与注释文字全收集（includeAnnotations 决定注释）', async () => {
    const doc = await openTestDocument(buildAnnotatedTextOfd());
    try {
      const page = await doc.getPage(0);
      expect(textsOf(await page.getTextContent())).toEqual(['正文']);
      expect(textsOf(await page.getTextContent({ includeAnnotations: true }))).toEqual([
        '正文',
        '高亮',
        '印章',
      ]);
    } finally {
      await doc.close();
    }
  });

  it('contentFilter 透传：被隐藏的层不进入文本层，{} 为空白', async () => {
    const doc = await openTestDocument(buildAnnotatedTextOfd());
    try {
      const page = await doc.getPage(0);
      expect(
        textsOf(await page.getTextContent({ contentFilter: { layers: { body: true } } })),
      ).toEqual(['正文']);
      expect(
        textsOf(await page.getTextContent({ contentFilter: { layers: { background: true } } })),
      ).toEqual([]);
      expect(textsOf(await page.getTextContent({ contentFilter: {} }))).toEqual([]);
    } finally {
      await doc.close();
    }
  });

  it('注释文字同样受类型白名单约束', async () => {
    const doc = await openTestDocument(buildAnnotatedTextOfd());
    try {
      const page = await doc.getPage(0);
      expect(
        textsOf(
          await page.getTextContent({
            includeAnnotations: true,
            contentFilter: { annotationTypes: ['Highlight'] },
          }),
        ),
      ).toEqual(['高亮']);
      expect(
        textsOf(
          await page.getTextContent({
            includeAnnotations: true,
            contentFilter: { annotationTypes: ['Highlight', 'Stamp'] },
          }),
        ),
      ).toEqual(['高亮', '印章']);
      // annotations:false 覆盖类型列表。
      expect(
        textsOf(
          await page.getTextContent({
            includeAnnotations: true,
            contentFilter: { annotations: false, annotationTypes: ['Highlight'] },
          }),
        ),
      ).toEqual([]);
      // 未打开 includeAnnotations 时，即使过滤允许注释也不收集。
      expect(
        textsOf(await page.getTextContent({ contentFilter: { annotationTypes: ['Highlight'] } })),
      ).toEqual([]);
    } finally {
      await doc.close();
    }
  });

  it('过滤变化使文本缓存失效：不同过滤得到各自的文本结果', async () => {
    const doc = await openTestDocument(buildAnnotatedTextOfd());
    try {
      const page = await doc.getPage(0);
      const all = await page.getTextContent({ includeAnnotations: true });
      const onlyBody = await page.getTextContent({
        includeAnnotations: true,
        contentFilter: { layers: { body: true } },
      });
      const blank = await page.getTextContent({
        includeAnnotations: true,
        contentFilter: {},
      });
      expect([textsOf(all), textsOf(onlyBody), textsOf(blank)]).toEqual([
        ['正文', '高亮', '印章'],
        ['正文'],
        [],
      ]);
      // 回到“全画”：与第一次结果一致。
      expect(textsOf(await page.getTextContent({ includeAnnotations: true }))).toEqual([
        '正文',
        '高亮',
        '印章',
      ]);
    } finally {
      await doc.close();
    }
  });

  it('不继承上一次 render 的过滤：render 传空白过滤后文本层仍全画', async () => {
    const doc = await openTestDocument(buildAnnotatedTextOfd());
    try {
      const page = await doc.getPage(0);
      const viewport = page.getViewport({ dpi: 96 });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      const canvas = createCanvas(width, height);
      await page.render({
        canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2DLike,
        viewport: { width, height, dpi: 96 },
        contentFilter: {},
      }).promise;
      expect(textsOf(await page.getTextContent())).toEqual(['正文']);
      expect(textsOf(await page.getTextContent({ includeAnnotations: true }))).toEqual([
        '正文',
        '高亮',
        '印章',
      ]);
    } finally {
      await doc.close();
    }
  });
});
