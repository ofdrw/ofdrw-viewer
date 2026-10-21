/**
 * T7 公共 API 测试夹具：Node canvas、合成 OFD 包与渲染辅助。
 *
 * 所有包均为内存合成，不依赖真实样本；图片用 @napi-rs/canvas 现场编码。
 */

import { createCanvas } from '@napi-rs/canvas';
import type { Canvas } from '@napi-rs/canvas';
import type { Canvas2DLike, CanvasRenderingContext2DLike, Renderer } from '../../src/renderer/types';
import { H5Canvas2DRenderer } from '../../src/renderer/canvas2d';
import { OFDDocument } from '../../src/api/document';
import type { OFDOpenOptions } from '../../src/api/types';
import type { OFDPage } from '../../src/api/page';
import { getPageViewport } from '../../src/api/viewport';
import type { Viewport } from '../../src/common/types';
import { nodeImageDecoders } from '../helpers/node-image-decoder';
import { buildXmlDocument } from '../fixtures/xml';
import type { XmlElementSpec } from '../fixtures/xml';
import { createZip } from '../fixtures/zip-builder';
import type { ZipEntryInput } from '../fixtures/zip-builder';

/** OFD 命名空间。 */
export const OFD_NS = 'http://www.ofdspec.org/2016';

/** 测试画布与像素读取。 */
export interface TestCanvas {
  /** 宿主 canvas（@napi-rs/canvas）。 */
  readonly canvas: Canvas;
  /** 2D 上下文。 */
  readonly context: CanvasRenderingContext2DLike;
  /**
   * 读取像素。
   *
   * @param x 横坐标，像素。
   * @param y 纵坐标，像素。
   * @returns RGBA 分量。
   */
  pixel(x: number, y: number): [number, number, number, number];
}

/**
 * 创建带白色背景的测试画布。
 *
 * @param width 宽度，像素。
 * @param height 高度，像素。
 * @returns 画布、上下文与像素读取函数。
 */
export function createTestCanvas(width: number, height: number): TestCanvas {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  return {
    canvas,
    context: context as unknown as CanvasRenderingContext2DLike,
    pixel: (x: number, y: number) => {
      const data = context.getImageData(x, y, 1, 1).data;
      return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0];
    },
  };
}

/**
 * 创建 Node 可用的 H5 渲染器。
 *
 * @returns 渲染器。
 */
export function createTestRenderer(): H5Canvas2DRenderer {
  return new H5Canvas2DRenderer({
    createCanvas: (width, height) => createCanvas(width, height) as unknown as Canvas2DLike,
  });
}

/**
 * 打开内存 OFD 包（默认注入 Node 图片解码器与 Node canvas 渲染器）。
 *
 * @param bytes OFD ZIP 字节。
 * @param overrides 打开参数覆盖。
 * @returns 文档实例。
 */
export async function openTestDocument(
  bytes: Uint8Array,
  overrides: Partial<OFDOpenOptions> = {},
): Promise<OFDDocument> {
  return OFDDocument.open({
    source: { kind: 'arraybuffer', data: bytes },
    renderer: createTestRenderer(),
    imageDecoders: [...nodeImageDecoders],
    ...overrides,
  });
}

/**
 * 按 viewport 创建画布并渲染页面。
 *
 * @param page 页面。
 * @param options DPI 与可选画布尺寸覆盖。
 * @returns 画布与 viewport。
 */
export async function renderPage(
  page: OFDPage,
  options: { dpi?: number; width?: number; height?: number } = {},
): Promise<{ canvas: TestCanvas; viewport: Viewport }> {
  const viewport = page.getViewport({ dpi: options.dpi ?? 96 });
  const width = options.width ?? Math.max(1, Math.ceil(viewport.width));
  const height = options.height ?? Math.max(1, Math.ceil(viewport.height));
  const canvas = createTestCanvas(width, height);
  await page.render({
    canvasContext: canvas.context,
    viewport: { width, height, dpi: viewport.dpi },
  }).promise;
  return { canvas, viewport };
}

/** 合成页定义。 */
export interface FixturePage {
  /** 页 ID，从 1 开始。 */
  id: number;
  /** Content/Layer 下的对象。 */
  objects: XmlElementSpec[];
  /** 页尺寸，mm；不传则不写 Area（用于回退测试）。 */
  widthMm?: number;
  heightMm?: number;
  /** 模板引用 ID 列表。 */
  templateIds?: number[];
  /** 页级资源路径（已解析为包内路径，如 `Doc_0/Pages/Page_1/Res.xml`）。 */
  pageRes?: string[];
}

/** 合成模板页定义。 */
export interface FixtureTemplatePage {
  /** 模板 ID。 */
  id: number;
  /** TemplatePage/BaseLoc（目录或 XML 文件）。 */
  baseLoc: string;
  /** 模板 Content/Layer 下的对象。 */
  objects?: XmlElementSpec[];
  /** 模板 Area 尺寸，mm；不传则不写 Area。 */
  widthMm?: number;
  heightMm?: number;
  /** 模板页资源路径。 */
  pageRes?: string[];
}

/** 合成注释页定义。 */
export interface FixtureAnnotations {
  /** 页 ID → 分页注释文件（包内路径）。 */
  files: Array<{ pageId: number; filePath: string }>;
  /** 额外压缩包条目。 */
  entries: ZipEntryInput[];
}

/** 合成包选项。 */
export interface FixtureOfdOptions {
  /** 页列表。 */
  pages: FixturePage[];
  /** CommonData/PageArea 尺寸，mm。 */
  commonPageArea?: { widthMm: number; heightMm: number };
  /** 文档级资源 XML：路径 → 资源 XML 子节点（`ofd:Res` 的 children）。 */
  publicRes?: Array<{ path: string; children: XmlElementSpec[] }>;
  /** DocumentRes XML。 */
  documentRes?: Array<{ path: string; children: XmlElementSpec[] }>;
  /** 模板页定义。 */
  templates?: FixtureTemplatePage[];
  /** 注释定义。 */
  annotations?: FixtureAnnotations;
  /** 额外条目（字体/图片等）。 */
  extraEntries?: ZipEntryInput[];
  /** DocRoot；默认 `Doc_0/Document.xml`。 */
  docRoot?: string;
}

/** 构造页面根 XML。 */
function pageXml(input: {
  objects: XmlElementSpec[];
  widthMm?: number;
  heightMm?: number;
  templateIds?: number[];
  pageRes?: string[];
}): XmlElementSpec {
  const children: XmlElementSpec[] = [];
  if (input.widthMm !== undefined && input.heightMm !== undefined) {
    children.push({
      name: 'ofd:Area',
      children: [
        {
          name: 'ofd:PhysicalBox',
          children: [`0 0 ${input.widthMm} ${input.heightMm}`],
        },
      ],
    });
  }
  for (const id of input.templateIds ?? []) {
    children.push({ name: 'ofd:Template', attrs: { TemplateID: id, ZOrder: 'Background' } });
  }
  for (const path of input.pageRes ?? []) {
    children.push({ name: 'ofd:PageRes', children: [path] });
  }
  children.push({
    name: 'ofd:Content',
    children: [{ name: 'ofd:Layer', attrs: { ID: 1 }, children: input.objects }],
  });
  return {
    name: 'ofd:Page',
    attrs: { 'xmlns:ofd': OFD_NS },
    children,
  };
}

/**
 * 合成一个最小 OFD 包。
 *
 * @param options 页、模板、资源与注释定义。
 * @returns ZIP 字节。
 */
export function buildFixtureOfd(options: FixtureOfdOptions): Uint8Array {
  // DocRoot 三种合法写法：Document.xml 文件路径、目录、空串（根目录）。
  const declaredRoot = (options.docRoot ?? 'Doc_0/Document.xml').replace(/\\/g, '/').replace(/\/+$/, '');
  const documentPath = declaredRoot === ''
    ? 'Document.xml'
    : /\.xml$/i.test(declaredRoot)
      ? declaredRoot
      : `${declaredRoot}/Document.xml`;
  const docDir = documentPath.includes('/')
    ? documentPath.slice(0, documentPath.lastIndexOf('/') + 1)
    : '';
  /** 把包内路径转换为相对 Document.xml 目录的路径。 */
  const relativeToDocument = (packagePath: string): string => {
    const normalized = packagePath.replace(/^\/+/, '');
    return normalized.startsWith(docDir) ? normalized.slice(docDir.length) : normalized;
  };
  const entries: ZipEntryInput[] = [];
  entries.push({
    name: 'OFD.xml',
    data: buildXmlDocument({
      name: 'ofd:OFD',
      attrs: { 'xmlns:ofd': OFD_NS, DocType: 'ofd', Version: '1.1' },
      children: [
        {
          name: 'ofd:DocBody',
          children: [
            { name: 'ofd:DocInfo', children: [{ name: 'ofd:DocID', children: ['fixture-api'] }] },
            { name: 'ofd:DocRoot', children: [declaredRoot] },
          ],
        },
      ],
    }),
  });

  const commonChildren: XmlElementSpec[] = [];
  if (options.commonPageArea) {
    commonChildren.push({
      name: 'ofd:PageArea',
      children: [
        {
          name: 'ofd:PhysicalBox',
          children: [
            `0 0 ${options.commonPageArea.widthMm} ${options.commonPageArea.heightMm}`,
          ],
        },
      ],
    });
  }
  for (const resource of options.publicRes ?? []) {
    commonChildren.push({
      name: 'ofd:PublicRes',
      children: [relativeToDocument(resource.path)],
    });
    entries.push({
      name: resource.path,
      data: buildXmlDocument({
        name: 'ofd:Res',
        attrs: { 'xmlns:ofd': OFD_NS },
        children: resource.children,
      }),
    });
  }
  for (const resource of options.documentRes ?? []) {
    commonChildren.push({
      name: 'ofd:DocumentRes',
      children: [relativeToDocument(resource.path)],
    });
    entries.push({
      name: resource.path,
      data: buildXmlDocument({
        name: 'ofd:Res',
        attrs: { 'xmlns:ofd': OFD_NS },
        children: resource.children,
      }),
    });
  }
  const templates = options.templates ?? [];
  for (const template of templates) {
    commonChildren.push({
      name: 'ofd:TemplatePage',
      attrs: { ID: template.id, BaseLoc: relativeToDocument(template.baseLoc) },
    });
    const contentPath = template.baseLoc.endsWith('.xml')
      ? template.baseLoc
      : `${template.baseLoc.replace(/\/+$/, '')}/Content.xml`;
    entries.push({
      name: contentPath,
      data: buildXmlDocument(
        pageXml({
          objects: template.objects ?? [],
          ...(template.widthMm !== undefined && template.heightMm !== undefined
            ? { widthMm: template.widthMm, heightMm: template.heightMm }
            : {}),
          ...(template.pageRes ? { pageRes: template.pageRes } : {}),
        }),
      ),
    });
  }
  let annotationsElement: XmlElementSpec | undefined;
  if (options.annotations) {
    annotationsElement = {
      name: 'ofd:Annotations',
      children: [relativeToDocument(`${docDir}Annotations.xml`)],
    };
    const annotationPages: XmlElementSpec[] = [];
    entries.push(...options.annotations.entries);
    for (const file of options.annotations.files) {
      annotationPages.push({
        name: 'ofd:Page',
        attrs: { PageID: file.pageId },
        children: [{ name: 'ofd:FileLoc', children: [file.filePath] }],
      });
    }
    entries.push({
      name: `${docDir}Annotations.xml`,
      data: buildXmlDocument({
        name: 'ofd:Annotations',
        attrs: { 'xmlns:ofd': OFD_NS },
        children: annotationPages,
      }),
    });
  }

  const pageElements: XmlElementSpec[] = [];
  for (const page of options.pages) {
    const pageDir = `${docDir}Pages/Page_${page.id}`;
    pageElements.push({
      name: 'ofd:Page',
      attrs: { ID: page.id, BaseLoc: `${relativeToDocument(pageDir)}/Content.xml` },
    });
    entries.push({
      name: `${pageDir}/Content.xml`,
      data: buildXmlDocument(
        pageXml({
          objects: page.objects,
          ...(page.widthMm !== undefined && page.heightMm !== undefined
            ? { widthMm: page.widthMm, heightMm: page.heightMm }
            : {}),
          ...(page.templateIds ? { templateIds: page.templateIds } : {}),
          ...(page.pageRes ? { pageRes: page.pageRes } : {}),
        }),
      ),
    });
  }

  entries.push({
    name: documentPath,
    data: buildXmlDocument({
      name: 'ofd:Document',
      attrs: { 'xmlns:ofd': OFD_NS, Version: '1.1' },
      children: [
        ...(commonChildren.length > 0 ? [{ name: 'ofd:CommonData', children: commonChildren }] : []),
        ...(annotationsElement ? [annotationsElement] : []),
        { name: 'ofd:Pages', children: pageElements },
      ],
    }),
  });
  entries.push(...(options.extraEntries ?? []));

  return createZip(entries).bytes;
}

/**
 * 生成 1×1 纯色 PNG。
 *
 * @param color CSS 颜色，默认 `#ff0000`。
 * @returns PNG 字节。
 */
export function createPng(color = '#ff0000'): Uint8Array {
  const canvas = createCanvas(1, 1);
  const context = canvas.getContext('2d');
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return new Uint8Array(canvas.toBuffer('image/png'));
}

/**
 * 合成带图片对象的单页 OFD（图片位于 PublicRes）。
 *
 * @param options `withCtm=false` 触发 W_IMAGE_NO_CTM；`png` 为图片字节。
 * @returns ZIP 字节。
 */
export function buildImageOfd(options: { withCtm?: boolean; png?: Uint8Array } = {}): Uint8Array {
  const withCtm = options.withCtm ?? true;
  const png = options.png ?? createPng();
  const imageEntry: ZipEntryInput = { name: 'Doc_0/Res/image.png', data: png };
  return buildFixtureOfd({
    pages: [
      {
        id: 1,
        widthMm: 100,
        heightMm: 100,
        objects: [
          {
            name: 'ofd:ImageObject',
            attrs: {
              ID: 11,
              Boundary: '10 10 10 10',
              ResourceID: '10',
              ...(withCtm ? { CTM: '10 0 0 10 0 0' } : {}),
            },
          },
        ],
      },
    ],
    publicRes: [
      {
        path: 'Doc_0/Res/Res.xml',
        children: [
          {
            name: 'ofd:MultiMedias',
            children: [
              {
                name: 'ofd:MultiMedia',
                attrs: { ID: 10, Type: 'Image', Format: 'PNG' },
                children: [{ name: 'ofd:MediaFile', children: ['image.png'] }],
              },
            ],
          },
        ],
      },
    ],
    extraEntries: [imageEntry],
  });
}

/**
 * 把渲染器包一层，记录 beginPage/endPage 调用序列与并发计数。
 *
 * @param inner 真实渲染器。
 * @returns 代理渲染器与统计对象。
 */
export function trackRenderer(inner: Renderer): {
  renderer: Renderer;
  stats: { begin: number; end: number; maxConcurrent: number };
} {
  const stats = { begin: 0, end: 0, maxConcurrent: 0 };
  let active = 0;
  const renderer = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'beginPage') {
        return (context: CanvasRenderingContext2DLike, viewport: Viewport): void => {
          active += 1;
          stats.begin += 1;
          stats.maxConcurrent = Math.max(stats.maxConcurrent, active);
          target.beginPage(context, viewport);
        };
      }
      if (property === 'endPage') {
        return (): void => {
          active = Math.max(0, active - 1);
          stats.end += 1;
          target.endPage();
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  return { renderer, stats };
}