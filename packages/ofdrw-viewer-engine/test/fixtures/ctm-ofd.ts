/**
 * 带对象 CTM 的合成 OFD 测试文档生成器（测试 fixture 专用）。
 *
 * 按 GB/T 33190—2016 的坐标变换链构造最小文档：
 *
 * - §8.1.4：`Boundary` 确定图元在页面中的绘制位置，图元内部数据以 Boundary 左上角为原点；
 * - §8.1.5 a）：图元数据先经 `CTM` 变换到对象空间；
 * - §8.1.5 b）：对象空间数据再经外接矩形（Boundary）变换到页面空间。
 *
 * 因此 CTM 作用范围是对象空间内部数据，Boundary 圈定对象空间在页面上的落位；
 * 同一 Boundary、不同 CTM 的文字应绘制在同一页面区域内，不应因 CTM 的平移/旋转/缩放
 * 而改变可见性。
 */

import { buildXmlDocument, type XmlElementSpec } from './xml';
import { createZip, type ZipEntryInput } from './zip-builder';
import { OFD_NAMESPACE } from './ofd-builder';

/** 页尺寸，单位 mm。 */
export interface PageSizeMm {
  /** 页宽，单位 mm。 */
  width: number;
  /** 页高，单位 mm。 */
  height: number;
}

/** 文字对象规格。 */
export interface CtmTextSpec {
  /** 图元 ID（正整数）。 */
  id: number;
  /** 外接矩形 `x y w h`，单位 mm；采用当前空间（页面）坐标系。 */
  boundary: [number, number, number, number];
  /** 对象变换矩阵 `a b c d e f`；缺省表示单位矩阵。 */
  ctm?: [number, number, number, number, number, number];
  /** 字号，单位 mm。 */
  size: number;
  /** 文字内容（只支持 ASCII，便于用固定字体断言）。 */
  text: string;
  /** 首个 TextCode 的 X 坐标，对象空间单位 mm；缺省 0。 */
  codeX?: number;
  /** 首个 TextCode 的 Y 坐标（基线），对象空间单位 mm；缺省为字号。 */
  codeY?: number;
  /** 填充色 `r g b`，缺省黑色。 */
  fillColor?: [number, number, number];
  /** 是否勾边，缺省 false。 */
  stroke?: boolean;
  /** 附着在该文字对象上的裁剪区；缺省不裁剪。 */
  clips?: readonly CtmClipSpec[];
}

/** Boundary 参考框规格：用细虚线描边标出对象外接矩形，便于人工比对。 */
export interface BoundaryGuideSpec {
  /** 参考框 ID（正整数）。 */
  id: number;
  /** 外接矩形 `x y w h`，单位 mm；采用页面坐标系。 */
  boundary: [number, number, number, number];
}

/** 裁剪区规格：附着到某个文字对象的 `Clips`。 */
export interface CtmClipSpec {
  /** 裁剪路径在对象空间中的矩形 `x y w h`，单位 mm。 */
  rect: [number, number, number, number];
  /** 裁剪区自身的 `CTM`；缺省不写。 */
  ctm?: [number, number, number, number, number, number];
  /** `TransFlag`；缺省 false。 */
  transFlag?: boolean;
}

/** 合成文档选项。 */
export interface CtmOfdOptions {
  /** 页尺寸，单位 mm；缺省 A4 纵向。 */
  page?: PageSizeMm;
  /** 页面文字对象。 */
  texts?: readonly CtmTextSpec[];
  /** Boundary 参考框；绘制在文字之下，用灰色细线标出对象外接矩形。 */
  guides?: readonly BoundaryGuideSpec[];
  /** 内嵌字体文件名字（包内路径），缺省 `Res/font.ttf`。 */
  fontFile?: string;
  /** 内嵌字体二进制。 */
  fontData: Uint8Array;
  /** 字体 FamilyName，缺省 `CtmFixture`。 */
  familyName?: string;
}

/**
 * 构造带对象 CTM 的最小 OFD 包。
 *
 * @param options 页尺寸、文字对象与内嵌字体。
 * @returns ZIP 字节。
 */
export function buildCtmOfd(options: CtmOfdOptions): Uint8Array {
  const page = options.page ?? { width: 210, height: 297 };
  const fontFile = options.fontFile ?? 'Res/font.ttf';
  const familyName = options.familyName ?? 'CtmFixture';
  const texts = options.texts ?? [];
  const fontId = 1;

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
                { name: 'ofd:DocID', children: ['ctm-fixture-doc'] },
                { name: 'ofd:Title', children: ['CTM Fixture'] },
              ],
            },
            { name: 'ofd:DocRoot', children: ['Doc_0/Document.xml'] },
          ],
        },
      ],
    }),
  });

  entries.push({
    name: 'Doc_0/Document.xml',
    data: buildXmlDocument({
      name: 'ofd:Document',
      attrs: { 'xmlns:ofd': OFD_NAMESPACE },
      children: [
        {
          name: 'ofd:CommonData',
          children: [
            { name: 'ofd:MaxUnitID', children: ['9999'] },
            {
              name: 'ofd:PageArea',
              children: [{ name: 'ofd:PhysicalBox', children: [`0 0 ${page.width} ${page.height}`] }],
            },
            { name: 'ofd:PublicRes', children: ['PublicRes.xml'] },
          ],
        },
        {
          name: 'ofd:Pages',
          children: [{ name: 'ofd:Page', attrs: { ID: 1, BaseLoc: 'Pages/Page_0/Content.xml' } }],
        },
      ],
    }),
  });

  entries.push({
    name: 'Doc_0/PublicRes.xml',
    data: buildXmlDocument({
      name: 'ofd:Res',
      attrs: { 'xmlns:ofd': OFD_NAMESPACE, BaseLoc: 'Res' },
      children: [
        {
          name: 'ofd:Fonts',
          children: [
            {
              name: 'ofd:Font',
              attrs: { ID: fontId, FontName: familyName, FamilyName: familyName, Charset: 'unicode' },
              children: [{ name: 'ofd:FontFile', children: ['font.ttf'] }],
            },
          ],
        },
      ],
    }),
  });
  entries.push({ name: `Doc_0/${fontFile}`, data: options.fontData });

  entries.push({
    name: 'Doc_0/Pages/Page_0/Content.xml',
    data: buildXmlDocument({
      name: 'ofd:Page',
      attrs: { 'xmlns:ofd': OFD_NAMESPACE },
      children: [
        {
          name: 'ofd:Area',
          children: [{ name: 'ofd:PhysicalBox', children: [`0 0 ${page.width} ${page.height}`] }],
        },
        {
          name: 'ofd:Content',
          children: [
            {
              name: 'ofd:Layer',
              attrs: { ID: 1 },
              children: [
                ...(options.guides ?? []).map((guide) => buildBoundaryGuide(guide)),
                ...texts.map((text) => buildTextObject(text, fontId)),
              ],
            },
          ],
        },
      ],
    }),
  });

  return createZip(entries).bytes;
}

/**
 * 构造单个 TextObject 元素。
 *
 * @param text 文字规格。
 * @param fontId 字体资源 ID。
 * @returns XML 元素描述。
 */
function buildTextObject(text: CtmTextSpec, fontId: number): XmlElementSpec {
  const attrs: Record<string, string | number> = {
    ID: text.id,
    Boundary: text.boundary.join(' '),
    Font: fontId,
    Size: text.size,
    Fill: 'true',
    Stroke: text.stroke === true ? 'true' : 'false',
  };
  if (text.ctm) attrs.CTM = text.ctm.join(' ');

  const codeAttrs: Record<string, string | number> = {
    X: text.codeX ?? 0,
    Y: text.codeY ?? text.size,
  };
  const children: XmlElementSpec[] = [
    { name: 'ofd:FillColor', attrs: { Value: (text.fillColor ?? [0, 0, 0]).join(' ') } },
    { name: 'ofd:TextCode', attrs: codeAttrs, children: [text.text] },
  ];
  if (text.clips && text.clips.length > 0) {
    children.push({
      name: 'ofd:Clips',
      children: text.clips.map((clip) => buildClip(clip)),
    });
  }

  return { name: 'ofd:TextObject', attrs, children };
}

/**
 * 构造单个 Clip 元素；裁剪区是一个矩形路径。
 *
 * @param clip 裁剪区规格。
 * @returns XML 元素描述。
 */
function buildClip(clip: CtmClipSpec): XmlElementSpec {
  const [x, y, w, h] = clip.rect;
  const data = `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} C`;
  const areaAttrs: Record<string, string | number> = {};
  if (clip.ctm) areaAttrs.CTM = clip.ctm.join(' ');
  const clipAttrs: Record<string, string | number> = {};
  if (clip.transFlag !== undefined) clipAttrs.TransFlag = clip.transFlag ? 'true' : 'false';
  return {
    name: 'ofd:Clip',
    attrs: clipAttrs,
    children: [
      {
        name: 'ofd:Area',
        ...(Object.keys(areaAttrs).length > 0 ? { attrs: areaAttrs } : {}),
        children: [
          {
            name: 'ofd:Path',
            attrs: {
              ID: 9000 + Math.round(x * 100 + y),
              Boundary: `${x} ${y} ${w} ${h}`,
              Fill: 'true',
              Stroke: 'false',
            },
            children: [{ name: 'ofd:AbbreviatedData', children: [data] }],
          },
        ],
      },
    ],
  };
}

/**
 * 构造 Boundary 参考框；用灰色细线描边虚线矩形，不填充。
 *
 * @param guide 参考框规格。
 * @returns XML 元素描述。
 */
function buildBoundaryGuide(guide: BoundaryGuideSpec): XmlElementSpec {
  const [x, y, w, h] = guide.boundary;
  const data = `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} C`;
  return {
    name: 'ofd:PathObject',
    attrs: {
      ID: guide.id,
      Boundary: `${x} ${y} ${w} ${h}`,
      Fill: 'false',
      Stroke: 'true',
      LineWidth: 0.15,
      DashPattern: '1.2 0.8',
    },
    children: [
      { name: 'ofd:StrokeColor', attrs: { Value: '150 150 150' } },
      { name: 'ofd:AbbreviatedData', children: [data] },
    ],
  };
}