/**
 * GB/T 33190—2016 条款样例的 OFD 包骨架构造器。
 *
 * 只构造标准条款样例所需的包结构：文档根、页面、公共资源（内嵌字型与多媒体），
 * 页面内容由调用方以 `XmlElement` 描述后注入。结构依据：
 *
 * - 7.5 文档根节点（`Document.xml` 的 `CommonData`/`Pages`/`PublicRes`）；
 * - 7.9 资源（表 18 `Res/BaseLoc`，表 19 `MultiMedia` 的 `Type`/`Format`/`MediaFile`）；
 * - 8.5 图元对象与第 10 ~ 14 章的图形、图像、文字、视频与动作。
 */

import { createZip, type ZipEntryInput } from '../fixtures/zip-builder';
import { serializeXmlDocument, type XmlElement } from './gb-standard-xml';

/** OFD 命名空间（GB/T 33190—2016 附录 A）。 */
const OFD_NAMESPACE = 'http://www.ofdspec.org/2016';

/** 页尺寸，单位 mm。 */
export interface PageSizeMm {
  /** 页宽，单位 mm。 */
  width: number;
  /** 页高，单位 mm。 */
  height: number;
}

/** 内嵌字型规格（表 44）。 */
export interface EmbeddedFontSpec {
  /** 资源 ID，`ST_ID`。 */
  id: number;
  /** 字型名，写入 `FontName`。 */
  familyName: string;
  /** 内嵌字型文件名（相对 `BaseLoc`），应为 OpenType 格式。 */
  fileName: string;
  /** 字型文件二进制。 */
  data: Uint8Array;
}

/** 多媒体资源规格（表 19）。 */
export interface MultiMediaSpec {
  /** 资源 ID，`ST_RefID`。 */
  id: number;
  /** 多媒体类型：`Image`、`Audio` 或 `Video`。 */
  type: 'Image' | 'Audio' | 'Video';
  /** 资源格式，例如 `PNG`、`MP4`。 */
  format: string;
  /** 包内文件路径（相对 `BaseLoc`）。 */
  fileName: string;
  /** 媒体文件二进制。 */
  data: Uint8Array;
}

/** 页面描述：页号、页面内容树与可选的页面级动作。 */
export interface PageSpec {
  /** 页面资源文件（`PageRes`）的相对路径，相对 `Doc_0/`；缺省不写。 */
  resFile?: string;
  /** 页面内容层列表；每层一个 `Layer` 节点。 */
  layers: readonly { id: number; children: readonly XmlElement[] }[];
  /** 页面级动作（`Actions`），事件应为 `PO`。 */
  actions?: XmlElement;
}

/** 文档骨架选项。 */
export interface OfdDocOptions {
  /** 文档标识，写入 `DocInfo/DocID`。 */
  docId: string;
  /** 文档标题，写入 `DocInfo/Title`。 */
  title: string;
  /** 页尺寸，单位 mm。 */
  page: PageSizeMm;
  /** 内嵌字型；缺省不写 `Fonts`。 */
  font?: EmbeddedFontSpec;
  /** 公共资源中的多媒体列表。 */
  multiMedias?: readonly MultiMediaSpec[];
  /** 页面列表，按顺序写入 `Pages`。 */
  pages: readonly PageSpec[];
}

/**
 * 构造 `OFD.xml`。
 *
 * @param options 文档骨架选项。
 * @returns 根元素描述。
 */
function buildOfdXml(options: OfdDocOptions): XmlElement {
  return {
    name: 'ofd:OFD',
    attrs: { 'xmlns:ofd': OFD_NAMESPACE, DocType: 'ofd', Version: '1.1' },
    children: [
      {
        name: 'ofd:DocBody',
        children: [
          {
            name: 'ofd:DocInfo',
            children: [
              { name: 'ofd:DocID', children: [options.docId] },
              { name: 'ofd:Title', children: [options.title] },
              { name: 'ofd:Creator', children: ['ofdrw-viewer 标准条款样例生成器'] },
            ],
          },
          { name: 'ofd:DocRoot', children: ['Doc_0/Document.xml'] },
        ],
      },
    ],
  };
}

/**
 * 构造公共资源文件 `PublicRes.xml`（表 18）。
 *
 * @param options 文档骨架选项。
 * @returns 根元素描述；无字型与多媒体时仍返回空的 `Res`。
 */
function buildPublicRes(options: OfdDocOptions): XmlElement {
  const children: XmlElement[] = [];
  if (options.font) {
    children.push({
      name: 'ofd:Fonts',
      children: [
        {
          name: 'ofd:Font',
          attrs: {
            ID: options.font.id,
            FontName: options.font.familyName,
            FamilyName: options.font.familyName,
            Charset: 'unicode',
          },
          children: [{ name: 'ofd:FontFile', children: [options.font.fileName] }],
        },
      ],
    });
  }
  if (options.multiMedias && options.multiMedias.length > 0) {
    children.push({
      name: 'ofd:MultiMedias',
      children: options.multiMedias.map((media) => ({
        name: 'ofd:MultiMedia',
        attrs: { ID: media.id, Type: media.type, Format: media.format },
        children: [{ name: 'ofd:MediaFile', children: [media.fileName] }],
      })),
    });
  }
  return {
    name: 'ofd:Res',
    attrs: { 'xmlns:ofd': OFD_NAMESPACE, BaseLoc: 'Res' },
    children,
  };
}

/**
 * 构造页面内容文件。
 *
 * @param options 文档骨架选项。
 * @param page 页面描述。
 * @returns 根元素描述。
 */
function buildPageContent(options: OfdDocOptions, page: PageSpec): XmlElement {
  const children: XmlElement[] = [
    {
      name: 'ofd:Area',
      children: [
        { name: 'ofd:PhysicalBox', children: [`0 0 ${options.page.width} ${options.page.height}`] },
      ],
    },
  ];
  if (page.resFile) {
    children.push({ name: 'ofd:PageRes', children: [page.resFile] });
  }
  children.push({
    name: 'ofd:Content',
    children: page.layers.map((layer) => ({
      name: 'ofd:Layer',
      attrs: { ID: layer.id },
      children: [...layer.children],
    })),
  });
  if (page.actions) children.push(page.actions);
  return { name: 'ofd:Page', attrs: { 'xmlns:ofd': OFD_NAMESPACE }, children };
}

/**
 * 构造页面对象所需的 `Res` 文件（页资源）。
 *
 * @param multiMedias 页级多媒体列表。
 * @returns 根元素描述。
 */
export function buildPageRes(multiMedias: readonly MultiMediaSpec[]): XmlElement {
  return {
    name: 'ofd:Res',
    attrs: { 'xmlns:ofd': OFD_NAMESPACE, BaseLoc: 'Res' },
    children: [
      {
        name: 'ofd:MultiMedias',
        children: multiMedias.map((media) => ({
          name: 'ofd:MultiMedia',
          attrs: { ID: media.id, Type: media.type, Format: media.format },
          children: [{ name: 'ofd:MediaFile', children: [media.fileName] }],
        })),
      },
    ],
  };
}

/**
 * 构造完整 OFD 包。
 *
 * 包结构：
 *
 * ```
 * OFD.xml
 * Doc_0/Document.xml
 * Doc_0/PublicRes.xml
 * Doc_0/Res/font.ttf
 * Doc_0/Res/*.mp4 | *.png
 * Doc_0/Pages/Page_N/Content.xml
 * ```
 *
 * @param options 文档骨架选项。
 * @returns ZIP 字节。
 */
export function buildOfdPackage(options: OfdDocOptions): Uint8Array {
  const entries: ZipEntryInput[] = [];

  entries.push({ name: 'OFD.xml', data: serializeXmlDocument(buildOfdXml(options)) });

  const documentChildren: XmlElement[] = [
    {
      name: 'ofd:CommonData',
      children: [
        { name: 'ofd:MaxUnitID', children: ['9999'] },
        {
          name: 'ofd:PageArea',
          children: [
            { name: 'ofd:PhysicalBox', children: [`0 0 ${options.page.width} ${options.page.height}`] },
          ],
        },
        { name: 'ofd:PublicRes', children: ['PublicRes.xml'] },
      ],
    },
    {
      name: 'ofd:Pages',
      children: options.pages.map((page, index) => ({
        name: 'ofd:Page',
        attrs: { ID: index + 1, BaseLoc: `Pages/Page_${index}/Content.xml` },
      })),
    },
  ];

  entries.push({
    name: 'Doc_0/Document.xml',
    data: serializeXmlDocument({
      name: 'ofd:Document',
      attrs: { 'xmlns:ofd': OFD_NAMESPACE },
      children: documentChildren,
    }),
  });

  entries.push({ name: 'Doc_0/PublicRes.xml', data: serializeXmlDocument(buildPublicRes(options)) });

  if (options.font) {
    entries.push({ name: `Doc_0/Res/${options.font.fileName}`, data: options.font.data });
  }
  for (const media of options.multiMedias ?? []) {
    entries.push({ name: `Doc_0/Res/${media.fileName}`, data: media.data });
  }
  for (const page of options.pages) {
    if (page.resFile) {
      entries.push({ name: `Doc_0/${page.resFile}`, data: serializeXmlDocument(buildPageRes([])) });
    }
  }

  options.pages.forEach((page, index) => {
    entries.push({
      name: `Doc_0/Pages/Page_${index}/Content.xml`,
      data: serializeXmlDocument(buildPageContent(options, page)),
    });
  });

  return createZip(entries).bytes;
}
/**
 * 读取 PNG 的像素宽高（IHDR 块固定位于文件头部）。
 *
 * @param data PNG 字节。
 * @returns 宽高，单位 px。
 */
export function readPngSize(data: Uint8Array): { width: number; height: number } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
