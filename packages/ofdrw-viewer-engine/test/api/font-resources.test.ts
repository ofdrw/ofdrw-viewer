/**
 * 文档字体资源清单 API：`getFontResources()`（设计 §3.6、REQ-001~004）。
 *
 * 断言只读取 DocumentRes/PublicRes 声明的字体资源：不加载页面、不解析字体，
 * 不改变既有渲染行为；可选字段缺失时省略，顺序按资源 ID 字符串升序。
 */

import { describe, expect, it } from 'vitest';
import { isOFDError } from '../../src/errors';
import type { XmlElementSpec } from '../fixtures/xml';
import { buildFixtureOfd, openTestDocument } from './helpers';

/** 取错误码。 */
function errorCode(error: unknown): string | undefined {
  return isOFDError(error) ? error.code : undefined;
}

/**
 * 构造只声明字体资源的测试文档。
 *
 * @param fonts DocumentRes 中的字体节点列表。
 * @param publicFonts PublicRes 中的字体节点列表；省略时不写 PublicRes。
 * @returns OFD ZIP 字节。
 */
function buildFontOfd(
  fonts: XmlElementSpec[],
  publicFonts?: XmlElementSpec[],
): Uint8Array {
  const page = { id: 1, widthMm: 100, heightMm: 100, objects: [] };
  const documentRes = [
    { path: 'Doc_0/DocumentRes.xml', children: [{ name: 'ofd:Fonts', children: fonts }] },
  ];
  const publicRes =
    publicFonts === undefined
      ? undefined
      : [
          {
            path: 'Doc_0/PublicRes.xml',
            children: [{ name: 'ofd:Fonts', children: publicFonts }],
          },
        ];
  return buildFixtureOfd({
    pages: [page],
    documentRes,
    ...(publicRes ? { publicRes } : {}),
  });
}

describe('document.getFontResources', () => {
  it('T-E1 字段映射：名称、family、字符集、字重、内嵌文件与 documentLevel', async () => {
    const doc = await openTestDocument(
      buildFontOfd([
        {
          name: 'ofd:Font',
          attrs: {
            ID: 1,
            FontName: '宋体',
            FamilyName: 'SimSun',
            Charset: 'unicode',
            Serif: 'true',
            Bold: 'false',
            Italic: 'false',
            FixedWidth: 'false',
          },
        },
        {
          name: 'ofd:Font',
          attrs: {
            ID: 2,
            FontName: '黑体',
            Charset: 'prc',
            Bold: 'true',
          },
          // FontFile 是 ofd:Font 的子元素，不是属性；相对 Document.xml 所在目录解析。
          children: [{ name: 'ofd:FontFile', children: ['Res/simhei.ttf'] }],
        },
      ]),
    );
    try {
      const fonts = await doc.getFontResources();
      expect(fonts).toEqual([
        {
          id: '1',
          fontName: '宋体',
          familyName: 'SimSun',
          charset: 'unicode',
          serif: true,
          bold: false,
          italic: false,
          fixedSize: false,
          documentLevel: true,
        },
        {
          id: '2',
          fontName: '黑体',
          charset: 'prc',
          serif: false,
          bold: true,
          italic: false,
          fixedSize: false,
          fontFile: 'Doc_0/Res/simhei.ttf',
          documentLevel: true,
        },
      ]);
      // 可选字段缺失时省略字段本身，而不是写成 undefined。
      expect('familyName' in fonts[1]!).toBe(false);
      expect('fontFile' in fonts[0]!).toBe(false);
      expect(fonts.every((font) => font.documentLevel)).toBe(true);
    } finally {
      await doc.close();
    }
  });

  it('T-E2a 没有字体声明时返回空数组', async () => {
    const doc = await openTestDocument(
      buildFixtureOfd({ pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [] }] }),
    );
    try {
      await expect(doc.getFontResources()).resolves.toEqual([]);
    } finally {
      await doc.close();
    }
  });

  it('T-E2b 可重复调用：每次返回新数组，且只读已解析声明', async () => {
    const doc = await openTestDocument(
      buildFontOfd([{ name: 'ofd:Font', attrs: { ID: 1, FontName: 'Missing' } }]),
    );
    try {
      const first = await doc.getFontResources();
      const second = await doc.getFontResources();
      expect(second).toEqual(first);
      // 新数组：修改返回值不影响后续调用。
      expect(second).not.toBe(first);
      expect(first.map((font) => font.fontName)).toEqual(['Missing']);
    } finally {
      await doc.close();
    }
  });

  it('按资源 ID 字符串升序排列，与 PublicRes/DocumentRes 书写次序无关', async () => {
    const doc = await openTestDocument(
      buildFontOfd(
        [
          { name: 'ofd:Font', attrs: { ID: 2, FontName: 'Second' } },
          { name: 'ofd:Font', attrs: { ID: 10, FontName: 'Tenth' } },
        ],
        [{ name: 'ofd:Font', attrs: { ID: 1, FontName: 'First' } }],
      ),
    );
    try {
      const fonts = await doc.getFontResources();
      // 字符串序：'10' < '2'，且 PublicRes 的 '1' 最前。
      expect(fonts.map((font) => font.id)).toEqual(['1', '10', '2']);
    } finally {
      await doc.close();
    }
  });

  it('T-E3 已中止的信号以 OFD_ABORTED 拒绝', async () => {
    const doc = await openTestDocument(
      buildFontOfd([{ name: 'ofd:Font', attrs: { ID: 1, FontName: 'Missing' } }]),
    );
    try {
      const controller = new AbortController();
      controller.abort();
      const error = await doc
        .getFontResources({ signal: controller.signal })
        .then(() => undefined)
        .catch((caught: unknown) => caught);
      expect(errorCode(error)).toBe('OFD_ABORTED');
    } finally {
      await doc.close();
    }
  });

  it('T-E4 文档关闭后以 OFD_CLOSED 拒绝', async () => {
    const doc = await openTestDocument(
      buildFontOfd([{ name: 'ofd:Font', attrs: { ID: 1, FontName: 'Missing' } }]),
    );
    await doc.close();
    await expect(doc.getFontResources()).rejects.toMatchObject({ code: 'OFD_CLOSED' });
  });
});
