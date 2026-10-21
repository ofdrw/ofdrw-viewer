/**
 * 最小合成 OFD 包生成器（测试 fixture 专用）。
 *
 * 生成 OFD.xml / Document.xml / Pages/Page_N/Content.xml / Res.xml 的最小结构，
 * 供容器、模型、渲染管线在没有业务原件时做快速冒烟。包内条目使用 deflate，
 * 页数、页尺寸、字体均可配置。
 *
 * 注意：这是“结构可解析”的夹具，不追求覆盖完整 OFD 规范。
 */

import { buildXmlDocument, type XmlElementSpec } from './xml';
import { createZip, type ZipBuildResult, type ZipEntryInput } from './zip-builder';

/** OFD 命名空间（GB/T 33190—2016）。 */
export const OFD_NAMESPACE = 'http://www.ofdspec.org/2016';

/** 合成字体条目。 */
export interface FixtureFont {
  /** 资源 ID（正整数）。 */
  id: number;
  /** 字体文件在包内的名字（如 `Font_1.ttf`）。 */
  fileName: string;
  /** 字体二进制。 */
  data: Uint8Array;
  /** FontName 属性。 */
  fontName?: string;
  /** FamilyName 属性。 */
  familyName?: string;
}

/** 最小 OFD 生成选项。 */
export interface MinimalOfdOptions {
  /** 页数，默认 1。 */
  pageCount?: number;
  /** 页宽，单位 mm（默认 A4 210）。 */
  widthMm?: number;
  /** 页高，单位 mm（默认 A4 297）。 */
  heightMm?: number;
  /** 文档标题。 */
  title?: string;
  /** 内嵌字体；提供时每页生成一个 TextObject。 */
  fonts?: readonly FixtureFont[];
  /** 每页是否生成一个矩形 PathObject，默认 true。 */
  withPath?: boolean;
  /** 每页 TextCode 文本，默认 `你好 OFD`。 */
  text?: string;
}

/** 合成结果。 */
export interface MinimalOfdResult extends ZipBuildResult {
  /** 包内条目路径（按写入顺序）。 */
  entries: string[];
  /** 页数。 */
  pageCount: number;
  /** 页宽，单位 mm。 */
  widthMm: number;
  /** 页高，单位 mm。 */
  heightMm: number;
}

/**
 * 构造最小 OFD 包。
 *
 * @param options 页数/尺寸/字体等选项。
 * @returns ZIP 字节、条目列表与页参数。
 */
export function buildMinimalOfd(options: MinimalOfdOptions = {}): MinimalOfdResult {
  const pageCount = Math.max(1, options.pageCount ?? 1);
  const widthMm = options.widthMm ?? 210;
  const heightMm = options.heightMm ?? 297;
  const title = options.title ?? 'Fixture OFD';
  const fonts = options.fonts ?? [];
  const withPath = options.withPath ?? true;
  const text = options.text ?? '你好 OFD';

  const entries: ZipEntryInput[] = [];

  entries.push({
    name: 'OFD.xml',
    data: buildXmlDocument({
      name: 'ofd:OFD',
      attrs: { 'xmlns:ofd': OFD_NAMESPACE, DocType: 'ofd', Version: '1.1' },
      children: [
        {
          name: 'ofd:DocBody',
          children: [
            {
              name: 'ofd:DocInfo',
              children: [
                { name: 'ofd:DocID', children: ['fixture-doc-1'] },
                { name: 'ofd:Title', children: [title] },
              ],
            },
            { name: 'ofd:DocRoot', children: ['Doc_0/Document.xml'] },
          ],
        },
      ],
    }),
  });

  const pageElements: XmlElementSpec[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    const pageId = index + 1;
    pageElements.push({
      name: 'ofd:Page',
      attrs: { ID: pageId, BaseLoc: `Pages/Page_${index}/Content.xml` },
    });
  }
  const commonChildren: XmlElementSpec[] = [
    { name: 'ofd:MaxUnitID', children: [String(100 + pageCount)] },
    {
      name: 'ofd:PageArea',
      children: [
        { name: 'ofd:PhysicalBox', children: [`0 0 ${widthMm} ${heightMm}`] },
      ],
    },
  ];
  if (fonts.length > 0) {
    commonChildren.push({ name: 'ofd:PublicRes', children: ['Res/Res.xml'] });
  }
  entries.push({
    name: 'Doc_0/Document.xml',
    data: buildXmlDocument({
      name: 'ofd:Document',
      attrs: { 'xmlns:ofd': OFD_NAMESPACE },
      children: [
        { name: 'ofd:CommonData', children: commonChildren },
        { name: 'ofd:Pages', children: pageElements },
      ],
    }),
  });

  if (fonts.length > 0) {
    entries.push({
      name: 'Doc_0/Res/Res.xml',
      data: buildXmlDocument({
        name: 'ofd:Res',
        attrs: { 'xmlns:ofd': OFD_NAMESPACE },
        children: [
          {
            name: 'ofd:Fonts',
            children: fonts.map((font) => ({
              name: 'ofd:Font',
              attrs: {
                ID: font.id,
                FontName: font.fontName ?? `FixtureFont${font.id}`,
                FamilyName: font.familyName ?? 'Fixture',
                Charset: 'unicode',
              },
              children: [{ name: 'ofd:FontFile', children: [font.fileName] }],
            })),
          },
        ],
      }),
    });
    for (const font of fonts) {
      entries.push({ name: `Doc_0/Res/${font.fileName}`, data: font.data });
    }
  }

  for (let index = 0; index < pageCount; index += 1) {
    const pageChildren: (XmlElementSpec | string)[] = [];
    if (withPath) {
      pageChildren.push({
        name: 'ofd:PathObject',
        attrs: {
          ID: 10 + index,
          Boundary: `20 20 ${Math.min(100, widthMm - 40).toFixed(2)} 50`,
          Fill: 'true',
          Stroke: 'false',
          AbbreviatedData: 'M 0 0 L 100 0 L 100 50 L 0 50 Z',
        },
        children: [{ name: 'ofd:FillColor', attrs: { Value: '255 0 0' } }],
      });
    }
    if (fonts.length > 0) {
      const font = fonts[0]!;
      pageChildren.push({
        name: 'ofd:TextObject',
        attrs: {
          ID: 50 + index,
          Boundary: `20 90 ${Math.min(150, widthMm - 40).toFixed(2)} 20`,
          Font: font.id,
          Size: 10,
        },
        children: [
          {
            name: 'ofd:TextCode',
            attrs: { X: 0, Y: 10 },
            children: [text],
          },
        ],
      });
    }
    entries.push({
      name: `Doc_0/Pages/Page_${index}/Content.xml`,
      data: buildXmlDocument({
        name: 'ofd:Page',
        attrs: { 'xmlns:ofd': OFD_NAMESPACE },
        children: [
          {
            name: 'ofd:Area',
            children: [
              { name: 'ofd:PhysicalBox', children: [`0 0 ${widthMm} ${heightMm}`] },
            ],
          },
          {
            name: 'ofd:Content',
            children: [{ name: 'ofd:Layer', attrs: { ID: 1 }, children: pageChildren }],
          },
        ],
      }),
    });
  }

  const built = createZip(entries);
  return {
    ...built,
    entries: entries.map((entry) => entry.name),
    pageCount,
    widthMm,
    heightMm,
  };
}