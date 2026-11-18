/**
 * 侧栏通用图标（内联 SVG，24×24 视图框）。
 *
 * 与工具栏 `icons.ts` 分开：这里只服务侧栏内容（附件、签章列表、详情状态），
 * 几何定义按名称缓存为模板，列表批量渲染时直接克隆，避免逐项重建路径。
 * 所有图标 `aria-hidden`，语义由相邻文字或元素的 `aria-label`/`title` 承担。
 */

import { createIcon } from './icons';
import type { IconName } from './icons';
import { replaceChildren } from '../compat';

/**
 * 图标名称。
 *
 * - 文件类型：`file` 及常见办公/图片/音视频/代码格式；
 * - 动作：`download`，`export` 复用工具栏的导出图标；
 * - 状态：签章验证结果（颜色与形状由 CSS 的 `data-status` 决定）。
 */
export type GlyphName =
  | 'file'
  | 'file-pdf'
  | 'file-doc'
  | 'file-sheet'
  | 'file-slide'
  | 'file-image'
  | 'file-text'
  | 'file-archive'
  | 'file-media'
  | 'file-audio'
  | 'file-video'
  | 'file-code'
  | 'file-xml'
  | 'download'
  | 'export'
  | 'status-valid'
  | 'status-invalid'
  | 'status-unknown'
  | 'status-unsupported'
  | 'status-not-applicable'
  | 'status-pending';

/** 图标几何定义。 */
interface GlyphSpec {
  /** 复用工具栏图标几何。 */
  readonly base?: IconName;
  /** 路径 `d`。 */
  readonly paths?: readonly string[];
  /** 折线 points。 */
  readonly polylines?: readonly string[];
}

/** 折角文件轮廓：右上角留出 6×6 折角。 */
const SHEET = 'M6 2h7l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z';
/** 折角。 */
const FOLD = 'M13 2v5h5';

const SPECS: Readonly<Record<GlyphName, GlyphSpec>> = Object.freeze({
  file: { paths: [SHEET, FOLD] },
  // 折角下方写出格式缩写，小尺寸下仍可区分。
  'file-pdf': { paths: [SHEET, FOLD, 'M7.6 13h1.2v5', 'M7.6 13v3h1.2a1 1 0 0 0 0-2H7.6'] },
  'file-doc': { paths: [SHEET, FOLD, 'M8 13h7', 'M8 15.5h7', 'M8 18h4.5'] },
  'file-sheet': { paths: [SHEET, FOLD, 'M3.5 12.5h15', 'M3.5 16.5h15', 'M10 12.5V20'] },
  // 演示文稿：投影屏幕（仅上下边框 + 走势折线），与表格的网格线区分。
  'file-slide': {
    paths: [SHEET, FOLD, 'M5 12.2h12', 'M5 18.4h12', 'M9 18.4v1.4', 'M13 18.4v1.4'],
    polylines: ['6.4 16.9 9.2 14.9 11 16.1 13.6 14.3'],
  },
  'file-image': { paths: [SHEET, FOLD, 'M4.5 20l3.4-3.9 2.2 2.2 2.4-2.4 3 3.3'] },
  'file-text': { paths: [SHEET, FOLD, 'M8 13h8', 'M8 16h8', 'M8 19h5'] },
  'file-archive': { paths: [SHEET, FOLD, 'M10 2v2h2V2', 'M10 6v2h2V6', 'M10 10v2h2v-2'] },
  // 媒体通用：折角下方放映三角。
  'file-media': { paths: [SHEET, FOLD, 'M8.5 13.2l5.4 3.2-5.4 3.2z'] },
  // 视频：播放器窗口 + 播放三角。
  'file-video': {
    paths: [
      SHEET,
      FOLD,
      'M4 13h12a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z',
      'M9.2 15.2l3.6 2.3-3.6 2.3z',
    ],
  },
  // 音频：折角下方声波柱。
  'file-audio': {
    paths: [
      SHEET,
      FOLD,
      'M4.5 16v2',
      'M7 14v6',
      'M9.5 12.5v9',
      'M12 15v4',
      'M14.5 13.5v7',
      'M17 16v2',
    ],
  },
  // 代码：折角下方尖括号。
  'file-code': {
    paths: [SHEET, FOLD, 'M9.2 14l-2.4 2.6 2.4 2.6', 'M12.8 14l2.4 2.6-2.4 2.6'],
  },
  // 标记语言：折角下方成对标签，标签间用短斜杠点明 XML 的闭合关系。
  'file-xml': {
    paths: ['M6 2h7l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z', FOLD,
      'M8.6 13.4l-1.8 2.4 1.8 2.4', 'M15.4 13.4l1.8 2.4-1.8 2.4'],
    polylines: ['13 13.6 11 17.6'],
  },
  download: {
    paths: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'],
    polylines: ['7 10 12 15 17 10'],
  },
  export: { base: 'export' },
  'status-valid': { base: 'shield' },
  'status-invalid': { base: 'close' },
  'status-unknown': { base: 'info' },
  // 不支持：圆 + 斜杠。
  'status-unsupported': {
    paths: ['M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18z', 'M5.6 5.6l12.8 12.8'],
  },
  // 不适用：圆 + 横杠。
  'status-not-applicable': { paths: ['M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18z', 'M8 12h8'] },
  // 待验证：时钟。
  'status-pending': {
    paths: ['M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18z'],
    polylines: ['12 7.5 12 12 15 14'],
  },
});

/** 已构建的图标模板；同一文档内几何一致，克隆即可重复使用。 */
const templates = new WeakMap<Document, Map<GlyphName, SVGSVGElement>>();

/**
 * 创建图标元素。
 *
 * @param name 图标名称。
 * @param doc 宿主文档。
 * @returns `aria-hidden` 的 SVG 元素。
 */
export function createGlyph(name: GlyphName, doc: Document): SVGSVGElement {
  let cache = templates.get(doc);
  if (!cache) {
    cache = new Map();
    templates.set(doc, cache);
  }
  let template = cache.get(name);
  if (!template) {
    template = buildGlyph(name, doc);
    cache.set(name, template);
  }
  return template.cloneNode(true) as SVGSVGElement;
}

/**
 * 构建图标模板。
 *
 * @param name 图标名称。
 * @param doc 宿主文档。
 * @returns 未挂载的 SVG 元素。
 */
function buildGlyph(name: GlyphName, doc: Document): SVGSVGElement {
  const spec = SPECS[name];
  if (spec.base) return createIcon(spec.base);
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [attribute, value] of [
    ['class', 'ofd-icon'],
    ['viewBox', '0 0 24 24'],
    ['width', '16'],
    ['height', '16'],
    ['fill', 'none'],
    ['stroke', 'currentColor'],
    ['stroke-width', '2'],
    ['stroke-linecap', 'round'],
    ['stroke-linejoin', 'round'],
    ['aria-hidden', 'true'],
    ['focusable', 'false'],
  ] as const) {
    svg.setAttribute(attribute, value);
  }
  for (const d of spec.paths ?? []) {
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  for (const points of spec.polylines ?? []) {
    const polyline = doc.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('points', points);
    svg.appendChild(polyline);
  }
  return svg;
}

/**
 * 把按钮内容替换为「图标 + 可选文字」。
 *
 * @param button 目标按钮。
 * @param name 图标名称。
 * @param label 图标后的文字；省略时不渲染文字。
 * @param doc 宿主文档。
 */
export function setButtonGlyph(
  button: HTMLButtonElement,
  name: GlyphName,
  label: string | undefined,
  doc: Document,
): void {
  const nodes: Node[] = [createGlyph(name, doc)];
  if (label) nodes.push(createButtonLabel(label, doc));
  replaceChildren(button, ...nodes);
}

/**
 * 创建按钮内的文字标签。
 *
 * @param label 文字。
 * @param doc 宿主文档。
 * @returns `.ofd-button__label` 元素。
 */
export function createButtonLabel(label: string, doc: Document): HTMLSpanElement {
  const text = doc.createElement('span');
  text.className = 'ofd-button__label';
  text.textContent = label;
  return text;
}
