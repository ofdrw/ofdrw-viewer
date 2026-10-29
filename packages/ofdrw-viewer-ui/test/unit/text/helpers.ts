/**
 * 文本模块测试夹具：构造 TextContent、页视图与最小阅读器宿主。
 *
 * 夹具只实现文本模块消费的接口，不依赖真实 OFD 文件与 Canvas；真实集成测试另见
 * `text-integration.test.ts`。
 */

import type {
  PageInfo,
  TextChar,
  TextContent,
  TextItem,
  TextQuad,
} from '@ofdrw/ofdrw-viewer-engine';
import type { PageView } from '../../../src/page-view';
import {
  createDefaultFeatureStates,
  mergeViewerFeatures,
  resolveFeatureStates,
} from '../../../src/features';
import type { ViewerFeature, ViewerFeatureStates, ViewerFeatures } from '../../../src/features';
import {
  createInitialViewerState,
  type DocumentStatus,
  type Rotation,
  type ViewerState,
  type VisiblePageRange,
} from '../../../src/state';
import type { ViewerEventMap, ViewerEventHandler, ViewerEventName } from '../../../src/types';
import type {
  TextViewerHost,
  ViewerTextLayerServiceLike,
} from '../../../src/text/viewer-bridge';
import type { CharRef, TextRow } from '../../../src/text/geometry';
import {
  buildTextRows,
  cssScaleForDpi,
  MM_PER_INCH,
  rowIdOfRef,
} from '../../../src/text/geometry';

/** 生成单个字符的文本内容。 */
export function makeChar(
  text: string,
  x: number,
  y: number,
  advance: number,
  size: number,
  angleRad = 0,
): TextChar {
  const quad = rotatedQuad(x, y, advance, size, angleRad);
  return {
    text,
    codePoint: text.codePointAt(0) ?? 0,
    fallback: false,
    origin: { x, y },
    advance,
    rect: quadBoundsOf(quad),
    quad,
    approximate: false,
  };
}

/** 生成基于基线的字符四边形（局部 y 向上为 -size）。 */
export function rotatedQuad(
  x: number,
  y: number,
  advance: number,
  size: number,
  angleRad: number,
): TextQuad {
  const points: Array<[number, number]> = [
    [0, -size],
    [advance, -size],
    [advance, 0],
    [0, 0],
  ];
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return points.map(([px, py]) => ({
    x: x + px * cos - py * sin,
    y: y + px * sin + py * cos,
  })) as unknown as TextQuad;
}

/** 四边形轴对齐包围盒。 */
function quadBoundsOf(quad: TextQuad): { x: number; y: number; width: number; height: number } {
  const xs = quad.map((point) => point.x);
  const ys = quad.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
}

/** 估算单字符推进量：全角字符按字号，拉丁字符按半字号。 */
function charAdvance(char: string, size: number): number {
  return /[\u2e80-\u9fff\uff00-\uffef]/u.test(char) ? size : size * 0.5;
}

/** 文本项选项。 */
export interface TextItemOptions {
  /** 文本内容；默认 `Hello`。 */
  readonly text?: string;
  /** 起点 x，单位 px。 */
  readonly x?: number;
  /** 基线 y，单位 px。 */
  readonly y?: number;
  /** 字号，单位 px。 */
  readonly size?: number;
  /** 字形旋转角，单位弧度。 */
  readonly angleRad?: number;
  /** 自定义字符；省略时按文本逐码点生成。 */
  readonly chars?: readonly TextChar[];
  /** 自定义 transform；省略时按 dpi 生成水平矩阵。 */
  readonly transform?: TextItem['transform'];
  /** 绘制顺序。 */
  readonly order?: number;
}

/** 生成 TextItem。 */
export function makeItem(options: TextItemOptions = {}): TextItem {
  const text = options.text ?? 'Hello';
  const size = options.size ?? 16;
  const angleRad = options.angleRad ?? 0;
  const x = options.x ?? 10;
  const y = options.y ?? 100;
  const chars: TextChar[] =
    options.chars !== undefined
      ? [...options.chars]
      : buildChars(text, x, y, size, angleRad);
  const advance = chars.reduce((sum, char) => sum + char.advance, 0);
  const quad = rotatedQuad(x, y, advance, size, angleRad);
  return {
    order: options.order ?? 0,
    layer: 'page',
    layerType: 'Body',
    visible: true,
    alpha: 1,
    text,
    font: { resourceId: 'f1', family: 'sans-serif', italic: false },
    size,
    transform: options.transform ?? ([96 / MM_PER_INCH, 0, 0, 96 / MM_PER_INCH, 0, 0] as TextItem['transform']),
    origin: { x, y },
    rect: quadBoundsOf(quad),
    quad,
    advance,
    charCount: Array.from(text).length,
    chars,
  };
}

/** 按码点生成字符列表。 */
function buildChars(
  text: string,
  x: number,
  y: number,
  size: number,
  angleRad: number,
): TextChar[] {
  const result: TextChar[] = [];
  let cursor = x;
  for (const codePoint of Array.from(text)) {
    const advance = charAdvance(codePoint, size);
    result.push(makeChar(codePoint, cursor, y, advance, size, angleRad));
    cursor += advance * Math.cos(angleRad);
  }
  return result;
}

/** 文本内容选项。 */
export interface TextContentOptions {
  /** 输出 DPI；默认 96。 */
  readonly dpi?: number;
  /** 页宽，mm；默认 210。 */
  readonly widthMm?: number;
  /** 页高，mm；默认 297。 */
  readonly heightMm?: number;
}

/** 生成 TextContent。 */
export function makeContent(
  items: readonly TextItem[],
  options: TextContentOptions = {},
): TextContent {
  const dpi = options.dpi ?? 96;
  const widthMm = options.widthMm ?? 210;
  const heightMm = options.heightMm ?? 297;
  const pageWidth = (widthMm / MM_PER_INCH) * dpi;
  const pageHeight = (heightMm / MM_PER_INCH) * dpi;
  return {
    pageIndex: 0,
    dpi,
    unit: 'px',
    pageWidth,
    pageHeight,
    items: [...items],
    itemCount: items.length,
    charCount: items.reduce((sum, item) => sum + item.charCount, 0),
    truncated: { items: false, chars: false },
  };
}

/** 生成一行一个 item 的简单页内容。 */
export function contentWithLines(
  lines: readonly string[],
  options: TextContentOptions & { readonly size?: number; readonly lineHeight?: number } = {},
): TextContent {
  const size = options.size ?? 16;
  const lineHeight = options.lineHeight ?? size * 1.6;
  const items = lines.map((text, index) =>
    makeItem({ text, x: 10, y: 100 + index * lineHeight, size, order: index }),
  );
  return makeContent(items, options);
}

/** 假页视图；只实现文本模块读取的字段。 */
export function makePageView(pageNumber: number, doc: Document = document): PageView {
  const element = doc.createElement('div');
  element.className = 'ofd-page';
  element.dataset.pageNumber = String(pageNumber);
  const surface = doc.createElement('div');
  surface.className = 'ofd-page__surface';
  surface.style.transform = 'translate(-50%, -50%) rotate(0deg)';
  const textLayer = doc.createElement('div');
  textLayer.className = 'ofd-page__text-layer';
  surface.appendChild(textLayer);
  element.appendChild(surface);
  doc.body.appendChild(element);
  return {
    element,
    surface,
    textLayer,
    pageNumber,
    pageIndex: pageNumber - 1,
    isDestroyed: false,
    // 默认按 A4、1 倍布局，与假宿主的页信息一致；用例可覆写以模拟其他倍率。
    surfaceWidth: (210 / MM_PER_INCH) * 96,
    surfaceHeight: (297 / MM_PER_INCH) * 96,
    layoutScale: 1,
    setTextLayerVisible(visible: boolean): void {
      textLayer.hidden = !visible;
    },
  } as unknown as PageView;
}

/** 假宿主选项。 */
export interface FakeHostOptions {
  /** 总页数；默认 3。 */
  readonly pageCount?: number;
  /** 当前页，1-based；默认 1。 */
  readonly pageNumber?: number;
  /** 可见页范围；默认 0..pageCount-1。 */
  readonly visiblePageRange?: VisiblePageRange;
  /** 缩放；默认 1。 */
  readonly scale?: number;
  /** 旋转；默认 0。 */
  readonly rotation?: Rotation;
  /** 功能补丁。 */
  readonly features?: ViewerFeatures;
  /** 文档状态；默认 ready。 */
  readonly status?: DocumentStatus;
  /** 每页文本内容或异步提供器。 */
  readonly contents?: ReadonlyMap<number, TextProvider>;
  /** 页视图；省略时按页数自动创建。 */
  readonly pageViews?: ReadonlyMap<number, PageView>;
  /** 文档根节点；省略时使用 body。 */
  readonly root?: HTMLElement;
}

/** 文本内容提供器；可读取取消信号。 */
export type TextProvider = TextContent | ((options?: { signal?: AbortSignal }) => Promise<TextContent>);

/** 假宿主；实现 TextViewerHost，并暴露可观测的事件/状态写入。 */
export interface FakeHost extends TextViewerHost {
  /** 当前状态。 */
  state: ViewerState;
  /** 已触发事件。 */
  readonly events: Array<{ name: string; payload: unknown }>;
  /** 已上报 warning。 */
  readonly warnings: Array<{ code: string; message: string; pageIndex?: number }>;
  /** commit 次数。 */
  commits: number;
  /** goToPage 调用记录。 */
  readonly goToPageCalls: number[];
  /** 按页记录 getTextContent 调用次数。 */
  readonly textCalls: number[];
  /** 更新视图状态并触发 statechange。 */
  setView(patch: Partial<ViewerState['view']>, notify?: boolean): void;
  /** 更新功能开关。 */
  setFeatures(patch: ViewerFeatures): void;
  /** 触发核心事件。 */
  emit<K extends ViewerEventName>(event: K, payload: ViewerEventMap[K]): void;
  /** 核心写入口：合并视图状态（不自动 commit）。 */
  patchView(patch: Partial<ViewerState['view']>): void;
  /** 核心写入口：提交状态并触发 statechange。 */
  commit(): void;
  /** 核心写入口：warning。 */
  warn(code: string, message: string, pageIndex?: number): void;
}

/** 创建假宿主。 */
export function makeFakeHost(options: FakeHostOptions = {}): FakeHost {
  const pageCount = options.pageCount ?? 3;
  const states: ViewerFeatureStates = resolveFeatureStates(
    options.features ?? {},
    {},
    'hide',
  );
  const pageInfos: PageInfo[] = Array.from({ length: pageCount }, (_, index) => ({
    index,
    widthMm: 210,
    heightMm: 297,
  }));
  const doc = document;
  const initial = createInitialViewerState({
    pageNumber: options.pageNumber ?? 1,
    scale: options.scale ?? 1,
    rotation: options.rotation ?? 0,
    features: states,
  });
  const state: ViewerState = {
    ...initial,
    document: {
      ...initial.document,
      pageCount,
      pageInfos,
      status: options.status ?? 'ready',
    },
    view: {
      ...initial.view,
      visiblePageRange: options.visiblePageRange ?? { start: 0, end: pageCount - 1 },
    },
  };

  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const events: Array<{ name: string; payload: unknown }> = [];
  const warnings: Array<{ code: string; message: string; pageIndex?: number }> = [];
  const goToPageCalls: number[] = [];
  const textCalls: number[] = [];
  const views = new Map<number, PageView>();
  for (let page = 1; page <= pageCount; page += 1) {
    views.set(
      page,
      options.pageViews?.get(page) ?? makePageView(page, doc),
    );
  }
  const contents = options.contents ?? new Map();
  const root = options.root ?? doc.body;

  const host: FakeHost = {
    state,
    events,
    warnings,
    commits: 0,
    goToPageCalls,
    textCalls,

    getState: () => host.state,
    on<K extends ViewerEventName>(
      event: K,
      handler: ViewerEventHandler<K>,
    ): () => void {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler as (payload: unknown) => void);
      return () => set?.delete(handler as (payload: unknown) => void);
    },
    getPageCount: () => host.state.document.pageCount,
    getPageNumber: () => host.state.view.pageNumber,
    getPageInfo: (pageNumber: number) => host.state.document.pageInfos[pageNumber - 1],
    async getPage(pageNumber: number) {
      const entry = contents.get(pageNumber);
      if (!entry) throw new Error(`page ${pageNumber} missing`);
      return {
        index: pageNumber - 1,
        getSize: () => ({ width: 210, height: 297 }),
        getViewport: (opts: { dpi?: number } = {}) => {
          const dpi = opts.dpi ?? 96;
          return {
            width: (210 / MM_PER_INCH) * dpi,
            height: (297 / MM_PER_INCH) * dpi,
            dpi,
          };
        },
        render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
        getTextContent: async (opts: { signal?: AbortSignal } = {}) => {
          textCalls.push(pageNumber);
          if (typeof entry === 'function') return entry(opts);
          void opts;
          return entry;
        },
      } as never;
    },
    getPageView: (pageNumber: number) => views.get(pageNumber),
    getPageViews: () => [...views.values()].sort((a, b) => a.pageNumber - b.pageNumber),
    getScale: () => host.state.view.scale,
    getRotation: () => host.state.view.rotation,
    isFeatureEnabled: (feature: ViewerFeature) =>
      host.state.ui.features[feature]?.enabled ?? true,
    getFeatureStates: () => host.state.ui.features,
    goToPage(pageNumber: number, opts: { smooth?: boolean } = {}): void {
      void opts;
      goToPageCalls.push(pageNumber);
      host.setView({ pageNumber }, true);
    },
    getRoot: () => root,

    setView(patch, notify = true) {
      host.state = { ...host.state, view: { ...host.state.view, ...patch } };
      if (notify) host.emit('statechange', host.state);
    },
    setFeatures(patch) {
      const next = mergeViewerFeatures({}, patch);
      const resolved = resolveFeatureStates(next, {}, 'hide');
      host.state = {
        ...host.state,
        ui: { ...host.state.ui, features: resolved },
      };
      host.emit('featureschange', resolved);
      host.emit('statechange', host.state);
    },
    emit(event, payload) {
      events.push({ name: event, payload });
      const set = handlers.get(event);
      if (!set) return;
      for (const handler of [...set]) handler(payload);
    },
    patchView(patch) {
      host.state = { ...host.state, view: { ...host.state.view, ...patch } };
    },
    commit() {
      host.commits += 1;
      host.emit('statechange', host.state);
    },
    warn(code, message, pageIndex) {
      warnings.push(pageIndex === undefined ? { code, message } : { code, message, pageIndex });
    },
  };

  // 让功能状态与初始补丁一致：未知功能保持默认开启。
  const defaultStates = createDefaultFeatureStates();
  host.state = {
    ...host.state,
    ui: {
      ...host.state.ui,
      features: { ...defaultStates, ...states },
    },
  };
  return host;
}

/** 构造可见页范围。 */
export function range(start: number, end: number): VisiblePageRange {
  return { start, end };
}

/** 文本层查询替身的页缓存。 */
interface QueryPageState {
  /** item 列表。 */
  readonly items: TextContent['items'];
  /** 行划分。 */
  readonly rows: readonly TextRow[];
  /** 主轴方向，单位弧度。 */
  readonly axisRowRad: number;
  /** 引擎 px → 96 DPI CSS px 的换算系数。 */
  readonly scale: number;
}

/**
 * 构造文本层查询替身（`getCharQuads` / `getRowIdOf` / `getAxisRowRad`）。
 *
 * 与 `TextLayerService` 共用 `buildTextRows()` 与 `rowIdOfRef()`，语义一致；供需要
 * 同步读取选区模型的用例使用，真实服务的查询行为另由 text-layer 用例覆盖。
 *
 * @param contents 按页提供的文本内容（页码 1-based）。
 * @returns 文本层查询服务替身。
 */
export function makeTextLayerQuery(
  contents: ReadonlyMap<number, TextContent>,
): ViewerTextLayerServiceLike {
  const cache = new Map<number, QueryPageState | null>();
  const stateOf = (pageNumber: number): QueryPageState | null => {
    if (!cache.has(pageNumber)) {
      const content = contents.get(pageNumber);
      if (!content) {
        cache.set(pageNumber, null);
      } else {
        const layout = buildTextRows(content);
        cache.set(pageNumber, {
          items: content.items ?? [],
          rows: layout.rows,
          axisRowRad: layout.axisRowRad,
          scale: cssScaleForDpi(content.dpi),
        });
      }
    }
    return cache.get(pageNumber) ?? null;
  };
  return {
    refresh: () => undefined,
    destroy: () => undefined,
    getAxisRowRad(pageNumber: number): number | null {
      return stateOf(pageNumber)?.axisRowRad ?? null;
    },
    getRowIdOf(pageNumber: number, ref: CharRef): string | null {
      const state = stateOf(pageNumber);
      return state ? rowIdOfRef(state.rows, ref) : null;
    },
    getCharQuads(pageNumber: number, refs: readonly CharRef[]) {
      const state = stateOf(pageNumber);
      return refs.map((ref) => {
        const char = state?.items[ref.itemIndex]?.chars?.[ref.charIndex];
        if (!state || !char) return null;
        return char.quad.map((point) => ({
          x: point.x * state.scale,
          y: point.y * state.scale,
        })) as unknown as TextQuad;
      });
    },
  };
}