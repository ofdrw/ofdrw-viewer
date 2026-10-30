/**
 * verifier 独立验证用例：注释类型扩展（设计方案 §I / §H.7）。
 *
 * 与实现者自带的用例相互独立：这里不复用 `layer-visibility.test.ts` 的内部挂钩，
 * 而是自有内存文档替身 + 记录器，逐条验证：
 * - 默认态签名仍为 `all`、打开文档不因类型额外重绘；
 * - 部分勾选写入白名单、零勾选/总开关关闭固定写 `annotations:false` 且不写
 *   `annotationTypes`，并与引擎 `resolveContentFilter().key` 对拍；
 * - 类型表在总开关关闭后保留、重开恢复；`defaultVisibility` 布尔与对象写法等价；
 * - 探测懒加载与降级、类型列表顺序；
 * - 文本层/查找/缩略图/导出/打印同步（关键路径）；
 * - 性能观察：1000 页文档探测成本（只打印数字，不断言）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PageContentFilter,
  PageRenderParameters,
  TextContentOptions,
} from '@ofdrw/ofdrw-viewer-engine';

/**
 * 引擎真实的 `resolveContentFilter`（用于 key 对拍）。
 *
 * 引擎包入口未导出该函数（与 `test/unit/layers/content-filter.test.ts` 相同做法），
 * 这里直接读取引擎源码模块。
 */
function engineResolve(filter?: PageContentFilter): { key: string } {
  return resolveContentFilter(filter);
}

const engineMocks = vi.hoisted(() => ({ open: vi.fn() }));

// 只替换打开入口，引擎常量与纯函数保持真实实现（`resolveContentFilter` 用于对拍）。
vi.mock('@ofdrw/ofdrw-viewer-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ofdrw/ofdrw-viewer-engine')>();
  return { ...actual, OFDDocument: { ...actual.OFDDocument, open: engineMocks.open } };
});

import { resolveContentFilter } from '../../../ofdrw-viewer-engine/src/render/content-filter';
import { OFDViewer } from '../../src/index';
import type { OFDViewerOptions } from '../../src/index';
import {
  contentFilterKey,
  resolveLayerPanelOptions,
  toPageContentFilter,
} from '../../src/layers/content-filter';
import { createTranslator } from '../../src/i18n';
import { layerPanelHost } from '../../src/views/layers';
import { installDomEnvironment } from '../helpers/environment';
import { createMockDocument } from '../helpers/document';

/** 常见五类（引擎常量顺序）。 */
const KNOWN = ['Link', 'Path', 'Highlight', 'Stamp', 'Watermark'] as const;

/** 一页的调用记录。 */
interface PageLog {
  /** `render` 实参里的过滤。 */
  readonly renders: Array<PageContentFilter | undefined>;
  /** `getTextContent` 实参。 */
  readonly texts: TextContentOptions[];
  /** `exportImage` 实参里的过滤。 */
  readonly exports: Array<PageContentFilter | undefined>;
}

/** 一次性加载的文档替身。 */
interface Harness {
  readonly viewer: OFDViewer;
  /** 第 `index`（0-based）页的记录。 */
  readonly log: (index: number) => PageLog;
  /** 全部页合计的 `render` 次数。 */
  readonly totalRenders: () => number;
  /** 统计 `getTextContent` 总次数。 */
  readonly totalTexts: () => number;
  /** 当前页（1-based）的渲染次数。 */
  readonly currentRenders: () => number;
}

/** canvas 2D 上下文替身（jsdom 无 Canvas）。 */
const canvasContext = {
  clearRect: vi.fn(),
  fillRect: vi.fn(),
  drawImage: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  scale: vi.fn(),
  translate: vi.fn(),
  setTransform: vi.fn(),
  beginPath: vi.fn(),
  closePath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  fill: vi.fn(),
};

/** 探测请求判定：`annotationTypes` 白名单且只含探测候选之一时，模拟该类型在本页有文字。 */
type ProbeAnswer = (options: TextContentOptions) => boolean;

/** 构造页面上的一个注释文字项。 */
function annotationItem(type: string): Record<string, unknown> {
  return {
    order: 99,
    layer: 'annotation',
    layerType: 'Body',
    annotationId: `annot-${type}`,
    visible: true,
    alpha: 1,
    text: type,
    font: { resourceId: 'f1', family: 'sans-serif', italic: false },
    size: 12,
    transform: [1, 0, 0, 1, 0, 0],
    origin: { x: 10, y: 10 },
    rect: { x: 10, y: 10, width: 40, height: 12 },
    quad: [
      { x: 10, y: 10 },
      { x: 50, y: 10 },
      { x: 50, y: 22 },
      { x: 10, y: 22 },
    ],
    advance: 40,
    charCount: type.length,
  };
}

/**
 * 创建带调用记录的阅读器。
 *
 * @param options 阅读器选项。
 * @param pageCount 页数。
 * @param probe 探测应答；返回 true 表示该类型在本页存在。
 * @returns 阅读器与记录读取器。
 */
async function openHarness(
  options: Partial<OFDViewerOptions>,
  pageCount: number,
  probe: ProbeAnswer = () => false,
): Promise<Harness> {
  const doc = createMockDocument({ pageCount });
  const logs = new Map<number, PageLog>();
  const logOf = (index: number): PageLog => {
    let entry = logs.get(index);
    if (!entry) {
      entry = { renders: [], texts: [], exports: [] };
      logs.set(index, entry);
    }
    return entry;
  };
  const originalGetPage = doc.getPage.bind(doc);
  // 探测与渲染共用的页面对象；挂上记录后再返回给阅读器。
  doc.getPage = (async (index: number) => {
    const page = (await originalGetPage(index)) as unknown as Record<string, unknown>;
    const log = logOf(index);
    if (!Object.prototype.hasOwnProperty.call(page, '__hooked')) {
      Object.defineProperty(page, '__hooked', { value: true, enumerable: false });
      const render = page['render'] as (params: PageRenderParameters) => unknown;
      page['render'] = (params: PageRenderParameters) => {
        log.renders.push(params.contentFilter);
        return render.call(page, params);
      };
      const text = page['getTextContent'] as (opts?: TextContentOptions) => Promise<unknown>;
      page['getTextContent'] = async (opts: TextContentOptions = {}) => {
        log.texts.push(opts);
        const content = (await text.call(page, opts)) as {
          items?: Array<Record<string, unknown>>;
          itemCount?: number;
          charCount?: number;
        };
        if (opts.includeAnnotations !== true || !probe(opts)) return content;
        const items = content.items ?? [];
        const types = opts.contentFilter?.annotationTypes ?? [];
        return {
          ...content,
          items: [...items, annotationItem(String(types[0]))],
          itemCount: (content.itemCount ?? items.length) + 1,
          charCount: (content.charCount ?? 0) + 1,
        };
      };
      const exportImage = page['exportImage'] as (opts?: unknown) => Promise<unknown>;
      page['exportImage'] = (opts?: unknown) => {
        log.exports.push((opts as { contentFilter?: PageContentFilter } | undefined)?.contentFilter);
        return exportImage.call(page, opts);
      };
    }
    return page;
  }) as unknown as typeof doc.getPage;
  engineMocks.open.mockReset();
  engineMocks.open.mockImplementation(async () => doc);
  const viewer = new OFDViewer({
    container: document.body,
    source: new ArrayBuffer(8),
    crypto: { enabled: false },
    ...options,
  });
  await viewer.ready;
  return {
    viewer,
    log: logOf,
    totalRenders: () => [...logs.values()].reduce((sum, entry) => sum + entry.renders.length, 0),
    totalTexts: () => [...logs.values()].reduce((sum, entry) => sum + entry.texts.length, 0),
    currentRenders: () => logs.get(viewer.getState().view.pageNumber - 1)?.renders.length ?? 0,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  installDomEnvironment();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    canvasContext as unknown as CanvasRenderingContext2D,
  );
  engineMocks.open.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('verifier · 注释类型（§I）', () => {
  it('V1 默认态：签名 all、渲染实参不带 contentFilter、打开文档不因类型额外重绘', async () => {
    const harness = await openHarness({}, 3);
    await vi.waitFor(() => {
      expect(harness.currentRenders()).toBeGreaterThan(0);
    });
    // 等待首轮文本层构建完成，再比较重绘次数（防止后续异步重建干扰基线）。
    await vi.waitFor(() => {
      expect(harness.log(0).texts.some((opts) => opts.includeAnnotations !== true)).toBe(true);
    });
    const renders = harness.totalRenders();
    const texts = harness.totalTexts();
    for (let index = 0; index < 3; index += 1) {
      const log = harness.log(index);
      expect(log.renders.every((filter) => filter === undefined)).toBe(true);
      expect(log.texts.every((opts) => opts.includeAnnotations !== true)).toBe(true);
      expect(harness.viewer.getLayerFilterKey(index + 1)).toBe('all');
      expect(harness.viewer.getPageContentFilter(index + 1)).toBeUndefined();
      // 页容器与画布都带上渲染 key，且以 `:all`（图层签名）结尾。
      const pageRows = [...document.querySelectorAll<HTMLElement>('.ofd-page')];
      const renderKeys = pageRows
        .map((row) => row.dataset.renderKey ?? '')
        .filter((key) => key.length > 0);
      expect(renderKeys.some((key) => key.endsWith(':all'))).toBe(true);
      expect(renderKeys.every((key) => key.endsWith(':all'))).toBe(true);
    }
    // 探测前不读取注释类型：没有任何“只看某类型”的文本请求。
    expect(harness.totalTexts()).toBe(texts);
    expect(harness.totalRenders()).toBe(renders);
    harness.viewer.destroy();
  });

  it('V2 取消第 2 页 Watermark：annotations:true + 白名单只含其余类型，且与引擎 key 对拍', async () => {
    const harness = await openHarness({}, 3);
    await vi.waitFor(() => {
      expect(harness.currentRenders()).toBeGreaterThan(0);
    });
    // 先把第 2 页渲染出来，建立基线。
    await harness.viewer.goToPage(2);
    await vi.waitFor(() => {
      expect(harness.log(1).renders.length).toBeGreaterThan(0);
    });
    const before = [0, 1, 2].map((index) => harness.log(index).renders.length);
    harness.viewer.setLayerVisibility(2, { annotations: { types: { Watermark: false } } });
    await vi.waitFor(() => {
      expect(harness.log(1).renders.length).toBe(before[1]! + 1);
    });
    const filter = harness.log(1).renders.at(-1)!;
    expect(filter).toBeDefined();
    expect(filter.annotations).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(filter, 'annotationTypes')).toBe(true);
    // 白名单按“只排除显式取消的类型”生成；未列出的候选类型保持可见（§I.4.2）。
    expect(filter.annotationTypes).toEqual(
      expect.arrayContaining(['Link', 'Path', 'Highlight', 'Stamp']),
    );
    expect(filter.annotationTypes).not.toContain('Watermark');
    // 其它页的过滤不变（第 3 页可能因窗口预取首渲染，但绝不能被带上白名单）。
    for (const index of [0, 2]) {
      expect(
        harness.log(index).renders.every((entry) => entry === undefined),
      ).toBe(true);
    }
    // 与引擎对拍（引擎真实实现）。
    const engineKey = engineResolve(filter).key;
    expect(engineKey).toBe(
      harness.viewer.getLayerFilterKey(2),
    );
    expect(engineKey).toBe(
      contentFilterKey(
        { annotations: { types: { Watermark: false } } },
        harness.viewer.getAnnotationTypes(2),
      ),
    );
    // 白名单以候选全集为基准，只排除显式取消的 Watermark；开头仍是勾选的常见类型。
    expect(engineKey).toContain('annotations=1;types=Link,Path,Highlight,Stamp,Signature');
    expect(engineKey).not.toContain('Watermark');
    harness.viewer.destroy();
  });

  it('V3 零勾选与关闭总开关：均为 annotations:false 且不含 annotationTypes，引擎 key 完全相同', async () => {
    const harness = await openHarness({}, 2);
    await vi.waitFor(() => {
      expect(harness.log(0).renders.length).toBeGreaterThan(0);
    });
    const viewer = harness.viewer;
    // 先勾掉一个类型，观察它被写进类型表；再全部勾掉 → 零勾选。
    viewer.setAnnotationTypeForPage(0, 'Watermark', false);
    expect(viewer.getLayerVisibility(1).annotations).toEqual({
      enabled: true,
      types: { Watermark: false },
    });
    for (const type of KNOWN) viewer.setAnnotationTypeForPage(0, type, false);
    // 总开关仍是“开”，只是类型全取消（零勾选）。
    expect(viewer.getLayerVisibility(1).annotations.enabled).toBe(true);
    const zero = viewer.getPageContentFilter(1)!;
    expect(zero.annotations).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(zero, 'annotationTypes')).toBe(false);
    expect(engineResolve(zero).key).toContain('annotations=0;types=;');

    viewer.setLayerVisibility(1, { annotations: { enabled: true, types: {} } });
    viewer.setLayerVisibility(1, { annotations: false });
    const off = viewer.getPageContentFilter(1)!;
    expect(off.annotations).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(off, 'annotationTypes')).toBe(false);
    // 零勾选与“关闭总开关”在引擎层完全一致，不存在 annotations:1;types= 的第三种形态。
    expect(engineResolve(zero).key).toBe(engineResolve(off).key);
    expect(viewer.getLayerFilterKey(1)).toBe(contentFilterKey({ annotations: false }));
    // 明确禁止：annotations:true + annotationTypes:[]
    expect(JSON.stringify(zero)).not.toContain('annotationTypes');
    harness.viewer.destroy();
  });

  it('V4 总开关关闭后重新打开：恢复之前的类型勾选（类型表保留）并回到正确签名', async () => {
    const harness = await openHarness({}, 2);
    const viewer = harness.viewer;
    viewer.setLayerVisibility(1, { annotations: { types: { Stamp: false, Link: false } } });
    expect(viewer.getLayerFilterKey(1)).toContain('types=Path,Highlight,Watermark');
    viewer.setLayerVisibility(1, { annotations: false });
    expect(viewer.getLayerVisibility(1).annotations).toEqual({
      enabled: false,
      types: { Stamp: false, Link: false },
    });
    viewer.setLayerVisibility(1, { annotations: true });
    expect(viewer.getLayerVisibility(1).annotations).toEqual({
      enabled: true,
      types: { Stamp: false, Link: false },
    });
    // 重新打开后白名单回到“之前取消的两个类型之外”，第一页签名与关闭前一致。
    expect(viewer.getPageContentFilter(1)!.annotationTypes).toEqual(
      expect.arrayContaining(['Path', 'Highlight', 'Watermark']),
    );
    expect(viewer.getPageContentFilter(1)!.annotationTypes).not.toContain('Link');
    expect(viewer.getPageContentFilter(1)!.annotationTypes).not.toContain('Stamp');
    expect(viewer.getLayerFilterKey(1)).toContain('types=Path,Highlight,Watermark');
    // 勾回最初取消的类型 → 全勾 → 不写白名单，签名回到 all。
    viewer.setAnnotationTypeForPage(0, 'Stamp', true);
    viewer.setAnnotationTypeForPage(0, 'Link', true);
    expect(viewer.getLayerVisibility(1).annotations).toEqual({ enabled: true, types: {} });
    expect(viewer.getPageContentFilter(1)).toBeUndefined();
    expect(viewer.getLayerFilterKey(1)).toBe('all');
    harness.viewer.destroy();
  });

  it('V5 defaultVisibility 布尔写法与 { enabled } 对象写法等价（含类型表）', () => {
    const booleanForm = resolveLayerPanelOptions({ defaultVisibility: { annotations: false } });
    const objectForm = resolveLayerPanelOptions({
      defaultVisibility: { annotations: { enabled: false } },
    });
    expect(booleanForm.defaultVisibility).toEqual(objectForm.defaultVisibility);
    expect(resolveLayerPanelOptions({}).defaultVisibility.annotations).toEqual({
      enabled: true,
      types: {},
    });
    expect(resolveLayerPanelOptions({ defaultVisibility: { annotations: true } })).toEqual(
      resolveLayerPanelOptions({ defaultVisibility: { annotations: { enabled: true } } }),
    );
    // 类型表：布尔 true 与 {types:{}} 等价；关闭时类型表保留。
    expect(resolveLayerPanelOptions({ defaultVisibility: { annotations: { types: {} } } })).toEqual(
      resolveLayerPanelOptions({ defaultVisibility: { annotations: true } }),
    );
    expect(
      resolveLayerPanelOptions({
        defaultVisibility: { annotations: { enabled: false, types: { Link: false } } },
      }).defaultVisibility.annotations,
    ).toEqual({ enabled: false, types: { Link: false } });
    // 签名层面等价：布尔 false 与对象的过滤与 key 一致。
    expect(toPageContentFilter({ annotations: false }, [...KNOWN])).toStrictEqual(
      toPageContentFilter({ annotations: { enabled: false } }, [...KNOWN]),
    );
    expect(contentFilterKey({ annotations: false }, [...KNOWN])).toBe(
      contentFilterKey({ annotations: { enabled: false } }, [...KNOWN]),
    );
  });

  it('V5b defaultVisibility 布尔写法与对象写法在打开文档后行为一致', async () => {
    const a = await openHarness({ layerPanel: { defaultVisibility: { annotations: false } } }, 2);
    const b = await openHarness(
      { layerPanel: { defaultVisibility: { annotations: { enabled: false } } } },
      2,
    );
    expect(a.viewer.getLayerVisibility(1)).toEqual(b.viewer.getLayerVisibility(1));
    expect(a.viewer.getPageContentFilter(1)).toStrictEqual(b.viewer.getPageContentFilter(1));
    a.viewer.destroy();
    b.viewer.destroy();
  });

  it('V6 类型只在每页显示：总项不汇总类型三态，逐页写入与批量写入都正确', async () => {
    const harness = await openHarness({}, 3);
    const viewer = harness.viewer;
    viewer.setAnnotationTypeForPage(0, 'Stamp', false);
    // 总项不再有类型复选框，`LayerSummary` 也不再提供跨页类型三态（用户决定，§I.5）。
    expect('annotationTypes' in viewer.readLayerSummary()).toBe(false);
    expect(viewer.getLayerVisibility(1).annotations.types).toEqual({ Stamp: false });
    expect(viewer.getLayerVisibility(2).annotations.types).toEqual({});
    viewer.setAnnotationTypeForAllPages('Stamp', false);
    for (let index = 0; index < 3; index += 1) {
      expect(viewer.getLayerVisibility(index + 1).annotations.types).toEqual({ Stamp: false });
    }
    viewer.setAnnotationTypeForAllPages('Stamp', true);
    for (let index = 0; index < 3; index += 1) {
      expect(viewer.getLayerVisibility(index + 1).annotations.types).toEqual({});
    }
    // 批量关闭再开启：只产生一次写入（一次 statechange）。
    let commits = 0;
    viewer.on('statechange', () => {
      commits += 1;
    });
    viewer.setAnnotationTypeForAllPages('Watermark', false);
    expect(commits).toBe(1);
    viewer.setAnnotationTypeForAllPages('Watermark', true);
    expect(commits).toBe(2);
    harness.viewer.destroy();
  });

  it('V7 类型列表 = 固定五类（常量顺序）+ 本页追加类型（sort 码元序、区分大小写、同名去重）', async () => {
    // 只在第 1 页出现 Signature / Check / anchor；第 2 页没有任何注释文字。
    let probingPage = 1;
    const harness = await openHarness({}, 2, (options) => {
      const type = options.contentFilter?.annotationTypes?.[0];
      if (probingPage !== 1) return false;
      return type === 'Signature' || type === 'anchor' || type === 'Check';
    });
    const viewer = harness.viewer;
    expect(viewer.getAnnotationTypes(1)).toEqual([...KNOWN]);
    await viewer.ensureAnnotationTypesLoaded([1]);
    const pageOneTypes = viewer.getAnnotationTypes(1);
    expect(pageOneTypes.slice(0, KNOWN.length)).toEqual([...KNOWN]);
    const extras = pageOneTypes.slice(KNOWN.length);
    expect(extras.length).toBeGreaterThan(0);
    // 追加类型：sort() 默认比较（UTF-16 码元序、区分大小写），大写在前。
    expect(extras).toEqual([...extras].sort());
    for (const type of extras) expect(KNOWN as readonly string[]).not.toContain(type);
    probingPage = 2;
    await viewer.goToPage(2);
    await viewer.ensureAnnotationTypesLoaded([2]);
    expect(viewer.getAnnotationTypes(2)).toEqual([...KNOWN]);
    harness.viewer.destroy();
  });

  it('V8 探测降级：getTextContent 抛错只列五类、不告警、不派发多余 statechange；每页只探测一次', async () => {
    const harness = await openHarness({}, 2, (options) => {
      if (options.dpi === 4) throw new Error('probe failed');
      return false;
    });
    const viewer = harness.viewer;
    await vi.waitFor(() => {
      expect(harness.log(0).renders.length).toBeGreaterThan(0);
    });
    const warnings: unknown[] = [];
    viewer.on('warning', (payload) => warnings.push(payload));
    let commits = 0;
    viewer.on('statechange', () => {
      commits += 1;
    });
    await viewer.ensureAnnotationTypesLoaded([1]);
    expect(viewer.getAnnotationTypes(1)).toEqual([...KNOWN]);
    expect(warnings).toEqual([]);
    expect(commits).toBe(0);
    const calls = harness.log(0).texts.length;
    await viewer.ensureAnnotationTypesLoaded([1]);
    expect(harness.log(0).texts.length).toBe(calls);
    harness.viewer.destroy();
  });

  it('V9 探测补齐：新类型只补快照不重绘', async () => {
    const harness = await openHarness({}, 2, (options) => (
      options.contentFilter?.annotationTypes?.[0] === 'Signature'
    ));
    const viewer = harness.viewer;
    await vi.waitFor(() => {
      expect(harness.log(0).renders.length).toBeGreaterThan(0);
    });
    const renders = harness.totalRenders();
    await viewer.ensureAnnotationTypesLoaded([1]);
    expect(viewer.getAnnotationTypes(1)).toContain('Signature');
    expect(harness.totalRenders()).toBe(renders);
    harness.viewer.destroy();
  });

  it('V10 文本层/查找/缩略图/导出/打印在该页过滤变化后同步（复跑关键路径）', async () => {
    const harness = await openHarness({}, 3);
    const viewer = harness.viewer;
    await vi.waitFor(() => {
      expect(harness.log(0).renders.length).toBeGreaterThan(0);
      expect(harness.log(0).texts.length).toBeGreaterThan(0);
    });
    const otherRenders = harness.log(2).renders.length;
    viewer.setLayerVisibility(2, { annotations: { types: { Watermark: false } } });
    await vi.waitFor(() => {
      expect(harness.log(1).texts.at(-1)?.contentFilter).toBeDefined();
    });
    const filter = viewer.getPageContentFilter(2)!;
    expect(filter.annotationTypes).toEqual(
      expect.arrayContaining(['Link', 'Path', 'Highlight', 'Stamp']),
    );
    expect(filter.annotationTypes).not.toContain('Watermark');
    // 文本层与主画布读到同一过滤（同一份值）。
    expect(harness.log(1).texts.at(-1)?.contentFilter).toStrictEqual(filter);
    // 查找：搜索结束后目标页文本抽取携带同一过滤。
    await viewer.find('测试');
    await vi.waitFor(() => {
      expect(viewer.getFindState().searching).toBe(false);
    });
    expect(
      harness.log(1).texts.some((opts) => JSON.stringify(opts.contentFilter) === JSON.stringify(filter)),
    ).toBe(true);
    // 缩略图：按该页过滤渲染。
    await viewer.exportImage({ page: 2 });
    expect(harness.log(1).exports.at(-1)).toStrictEqual(filter);
    await viewer.print({ pages: [2] });
    expect(harness.log(1).exports.at(-1)).toStrictEqual(filter);
    // 其它页仍按全画。
    expect(viewer.getPageContentFilter(3)).toBeUndefined();
    expect(harness.log(2).renders.length).toBe(otherRenders);
    viewer.destroy();
  });

  it('V12 汇总口径与过滤一致；单页取消类型不影响其它页的签名', async () => {
    const harness = await openHarness({}, 3);
    const viewer = harness.viewer;
    await vi.waitFor(() => {
      expect(harness.log(0).renders.length).toBeGreaterThan(0);
    });
    const otherKeys = [2, 3].map((page) => viewer.getLayerFilterKey(page));
    // 部分勾选：该页仍有效可见（annotations:true + 白名单），面板汇总口径一致。
    viewer.setAnnotationTypeForPage(0, 'Watermark', false);
    expect(viewer.getPageContentFilter(1)?.annotations).toBe(true);
    let summary = viewer.readLayerSummary();
    expect(summary.allKeysOn.annotations).toBe(true);
    expect(summary.allKeysOff.annotations).toBe(false);
    const host = layerPanelHost(viewer, () => createTranslator('zh-CN'));
    expect(host.readAllState().allKeysOn.annotations).toBe(true);
    // reviewer 报告的“其它页变成 annotations=0”不应出现。
    expect([2, 3].map((page) => viewer.getLayerFilterKey(page))).toEqual(otherKeys);
    // 取消该页全部五类 → 该页关闭；其它页不受影响，面板汇总变为混合。
    for (const type of KNOWN) viewer.setAnnotationTypeForPage(0, type, false);
    expect(viewer.getPageContentFilter(1)?.annotations).toBe(false);
    expect(viewer.getPageContentFilter(1)).not.toHaveProperty('annotationTypes');
    summary = viewer.readLayerSummary();
    expect(summary.allKeysOn.annotations).toBe(false);
    expect(summary.allKeysOff.annotations).toBe(false);
    expect(host.readAllState().state).toBe('mixed');
    expect([2, 3].map((page) => viewer.getLayerFilterKey(page))).toEqual(otherKeys);
    viewer.destroy();
  });

  it('V11 1000 页探测成本观察（展开某页类型组 / 全量探测）：只记录数字，不做性能断言', async () => {
    const harness = await openHarness({}, 1000);
    const viewer = harness.viewer;
    await vi.waitFor(() => {
      expect(harness.log(0).renders.length).toBeGreaterThan(0);
    });
    const before = harness.totalTexts();
    const started = performance.now();
    // 单页展开时的探测范围（实现：`views/layers.ts` 的 `ensureLoaded(pageIndex)` = 该页 ∪ 当前页）。
    await viewer.ensureAnnotationTypesLoaded([viewer.getState().view.pageNumber]);
    const singleMs = performance.now() - started;
    const singleCalls = harness.totalTexts() - before;
    const startedAll = performance.now();
    await viewer.ensureAnnotationTypesLoaded(
      Array.from({ length: 1000 }, (_, index) => index + 1),
    );
    const allMs = performance.now() - startedAll;
    const allCalls = harness.totalTexts() - before - singleCalls;
    // 只报数字，不做断言（性能需要在真实引擎上评估）。
    expect(singleCalls).toBeGreaterThan(0);
    expect(allCalls).toBeGreaterThan(0);
    // eslint-disable-next-line no-console -- 性能观察结果需要出现在测试输出里
    console.info(
      `[perf] 注释类型探测：单页 ${singleCalls} 次 getTextContent / ${singleMs.toFixed(1)} ms；` +
        `全部 1000 页 ${allCalls} 次 / ${allMs.toFixed(1)} ms`,
    );
    viewer.destroy();
  });
});
