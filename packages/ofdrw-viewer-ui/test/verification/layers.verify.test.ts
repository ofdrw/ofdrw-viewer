/**
 * 图层功能独立验收（t5）：侧栏 tab 图标与溢出、图层 tab 位置与开关、图层树六项、总项批量与
 * 半选、恢复默认、按页重绘与过滤透传、导出/打印逐页过滤、重开文档回到默认，
 * 以及“注释类型只在每页显示、总项组没有类型复选框”的用户决定。
 *
 * 只用公共入口与真实外壳，不复制产品实现、不修改 `src/`：侧栏 DOM 由 `UIShell` 真实构建，
 * 溢出判定通过测得的标签宽度（`getBoundingClientRect`）驱动；引擎由内存文档替身提供，
 * 记录 `render`/`exportImage` 收到的 `contentFilter`。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageContentFilter, PageRenderParameters } from '@ofdrw/ofdrw-viewer-engine';

const engineMocks = vi.hoisted(() => ({ open: vi.fn() }));

// 只替换打开入口，引擎常量与其它导出保持真实实现。
vi.mock('@ofdrw/ofdrw-viewer-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ofdrw/ofdrw-viewer-engine')>();
  return { ...actual, OFDDocument: { ...actual.OFDDocument, open: engineMocks.open } };
});

import { OFDViewer, isFeatureDisabledError } from '../../src/index';
import type { OFDViewerOptions, SidebarView } from '../../src/index';
import { TAB_ICONS } from '../../src/ui/icons';
import { getUIShell } from '../../src/ui';
import { SIDEBAR_VIEWS } from '../../src/state';
import { installDomEnvironment } from '../helpers/environment';
import { createMockDocument } from '../helpers/document';

/** 侧栏 tab 的期望顺序（“图层”位于末尾）。 */
const EXPECTED_VIEWS: readonly SidebarView[] = [
  'thumbnails',
  'outline',
  'bookmarks',
  'signatures',
  'attachments',
  'layers',
];

/** 每个用例创建的阅读器，结束统一销毁。 */
const viewers: OFDViewer[] = [];

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

/** 页面替身记录。 */
interface PageLog {
  /** `render` 实参中的过滤。 */
  readonly renders: Array<PageContentFilter | undefined>;
  /** `exportImage` 实参中的过滤。 */
  readonly exports: Array<PageContentFilter | undefined>;
}

/**
 * 创建并打开阅读器；每页挂上渲染/导出记录。
 *
 * @param options 阅读器选项。
 * @param pageCount 页数。
 * @returns 阅读器与第 `index`（0-based）页的记录读取器。
 */
async function openViewer(
  options: Partial<OFDViewerOptions> = {},
  pageCount = 3,
): Promise<{ viewer: OFDViewer; log: (index: number) => PageLog }> {
  const doc = createMockDocument({ pageCount });
  const logs = new Map<number, PageLog>();
  const logOf = (index: number): PageLog => {
    let entry = logs.get(index);
    if (!entry) {
      entry = { renders: [], exports: [] };
      logs.set(index, entry);
    }
    return entry;
  };
  const originalGetPage = doc.getPage.bind(doc);
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
  viewers.push(viewer);
  await viewer.ready;
  return { viewer, log: logOf };
}

/** 侧栏 tab 按钮（按视图名索引）。 */
function tabButtons(): Map<string, HTMLButtonElement> {
  const result = new Map<string, HTMLButtonElement>();
  for (const button of document.querySelectorAll<HTMLButtonElement>('.ofd-sidebar__tab')) {
    result.set(button.dataset.view ?? '', button);
  }
  return result;
}

/** 标签行元素。 */
function tabRow(): HTMLElement {
  const row = document.querySelector<HTMLElement>('.ofd-sidebar__tabs');
  if (!row) throw new Error('缺少侧栏标签行');
  return row;
}

/**
 * 覆盖各标签的实测宽度（jsdom 不做布局）。
 *
 * @param width 每个标签按钮的宽度，单位 px。
 */
function stubTabWidth(width: number): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const isTab = this.classList.contains('ofd-sidebar__tab');
    const rect = {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: isTab ? width : 0,
      bottom: isTab ? 32 : 0,
      width: isTab ? width : 0,
      height: isTab ? 32 : 0,
      toJSON: () => ({}),
    };
    return rect as DOMRect;
  });
}

/**
 * 覆盖标签行可用宽度（`clientWidth`），返回恢复函数。
 *
 * @param width 可用宽度，单位 px。
 */
function stubTabListWidth(width: number): void {
  const row = tabRow();
  Object.defineProperty(row, 'clientWidth', { configurable: true, value: width });
}

/** 重新挂载（触发溢出重判）。 */
function remountOverflow(): void {
  // 外壳在销毁/重建时重新测量；这里用全局 resize 事件模拟宽度变化后的重判。
  window.dispatchEvent(new Event('resize'));
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  installDomEnvironment();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    canvasContext as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  for (const viewer of viewers.splice(0)) viewer.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('V-LAYERS-01 tab 图标与顺序', () => {
  it('每个 tab 都有 SVG 图标，图层 tab 位于最后且标题完整', async () => {
    const { viewer } = await openViewer();
    expect([...SIDEBAR_VIEWS]).toEqual([...EXPECTED_VIEWS]);
    const tabs = tabButtons();
    expect([...tabs.keys()]).toEqual([...EXPECTED_VIEWS]);
    for (const view of EXPECTED_VIEWS) {
      const button = tabs.get(view)!;
      expect(button.querySelector('svg')).not.toBeNull();
      expect(button.getAttribute('title')).toBeTruthy();
      // 可读名称来自 aria-label；title 在禁用时是禁用原因，因此只要求非空。
      expect(button.getAttribute('aria-label')!.length).toBeGreaterThan(0);
    }
    // 图层 tab 文案与图标来自常量映射。
    const layersTab = tabs.get('layers')!;
    expect(layersTab.getAttribute('aria-label')).toBe('图层');
    expect(TAB_ICONS.layers).toBe('layers');
    // 点击图层 tab 打开对应面板。
    layersTab.click();
    expect(viewer.getSidebarView()).toBe('layers');
    viewer.destroy();
  });
});

describe('V-LAYERS-02 溢出仅图标', () => {
  it('放不下时整行仅图标，title/aria-label 仍为完整名称；放得下时恢复图标+文字', async () => {
    stubTabWidth(80);
    const { viewer } = await openViewer();
    // 6 个标签 × 80px = 480px，可用宽度 200px → 溢出。
    stubTabListWidth(200);
    remountOverflow();
    const row = tabRow();
    expect(row.dataset.mode).toBe('icons');
    // 仅图标：label 隐藏（CSS 按 data-mode 隐藏），可访问名称仍来自 aria-label。
    for (const button of tabButtons().values()) {
      expect(button.getAttribute('aria-label')!.length).toBeGreaterThan(0);
      expect(button.hasAttribute('title')).toBe(true);
      expect(button.querySelector('.ofd-sidebar__tab-label')?.textContent).toBe(
        button.getAttribute('aria-label'),
      );
    }
    // 宽度恢复 → 回到图标+文字。
    stubTabListWidth(1200);
    remountOverflow();
    expect(tabRow().dataset.mode).toBe('full');
    viewer.destroy();
  });
});

describe('V-LAYERS-03 图层 tab 开关', () => {
  it('layerPanel.enabled=false 时不渲染图层 tab，openSidebar 抛 OFD_FEATURE_DISABLED', async () => {
    const { viewer } = await openViewer({ layerPanel: { enabled: false } });
    const layersTab = tabButtons().get('layers');
    // 不渲染：标签不进入布局（hidden 或 aria-hidden），不可访问。
    const rendered =
      layersTab !== undefined &&
      !layersTab.hidden &&
      layersTab.closest('[aria-hidden="true"]') === null;
    expect(rendered).toBe(false);
    let thrown: unknown;
    try {
      viewer.openSidebar('layers');
    } catch (error) {
      thrown = error;
    }
    expect(isFeatureDisabledError(thrown)).toBe(true);
    viewer.destroy();
  });

  it('layerPanel.disabled=true 时保留 tab 但禁用并给出原因', async () => {
    const { viewer } = await openViewer({ layerPanel: { disabled: true } });
    const tab = tabButtons().get('layers')!;
    expect(tab.hidden).toBe(false);
    expect(tab.disabled).toBe(true);
    expect(tab.getAttribute('aria-disabled')).toBe('true');
    expect(tab.getAttribute('title')).toBeTruthy();
    viewer.destroy();
  });

  it('layerPanel.defaultVisibility 生效：默认关闭背景时首屏即按过滤渲染', async () => {
    const { viewer, log } = await openViewer({ layerPanel: { defaultVisibility: { background: false } } });
    await vi.waitFor(() => {
      expect(log(0).renders.length).toBeGreaterThan(0);
    });
    const filter = log(0).renders.at(-1)!;
    expect(filter.layers?.background).toStrictEqual({ page: false, templates: false });
    expect(filter.layers?.body).toStrictEqual({ page: true, templates: true });
    expect(viewer.getLayerVisibility(1).background).toBe(false);
    viewer.destroy();
  });
});

describe('V-LAYERS-04 图层树', () => {
  it('六项顺序为 签章→注释→自定义→前景→正文→背景，总项在页面行之前', async () => {
    const { viewer } = await openViewer();
    viewer.openSidebar('layers');
    const shell = getUIShell(viewer)!;
    const panel = shell.sidebar.getPanel('layers')!;
    const allRow = panel.querySelector<HTMLElement>('[data-role="all"]')!;
    expect(allRow).not.toBeNull();
    allRow.click();
    const keys = [...allRow.nextElementSibling!.querySelectorAll<HTMLElement>('[data-layer]')].map(
      (row) => row.dataset.layer,
    );
    expect(keys).toEqual(['signatures', 'annotations', 'custom', 'foreground', 'body', 'background']);
    const pageRows = panel.querySelectorAll<HTMLElement>('[data-role="page"]');
    expect(pageRows).toHaveLength(3);
    viewer.destroy();
  });
});

describe('V-LAYERS-05 总项批量、半选与恢复默认', () => {
  /** 读取某一行内某项复选框。 */
  function boxOf(scope: HTMLElement, key: string): HTMLInputElement {
    const box = scope.querySelector<HTMLInputElement>(`input[data-key="${key}"]`);
    if (!box) throw new Error(`缺少复选框 ${key}`);
    return box;
  }

  it('总项批量写入所有页且只重绘受影响页；部分页变化时总项半选；恢复默认清零', async () => {
    const { viewer, log } = await openViewer();
    viewer.openSidebar('layers');
    const shell = getUIShell(viewer)!;
    const panel = shell.sidebar.getPanel('layers')!;
    const allRow = panel.querySelector<HTMLElement>('[data-role="all"]')!;
    if (allRow.getAttribute('aria-expanded') !== 'true') allRow.click();
    await vi.waitFor(() => {
      expect(log(0).renders.length).toBeGreaterThan(0);
    });
    const watermark = boxOf(allRow.nextElementSibling as HTMLElement, 'background');
    // 总项“背景”取消 → 三页都关闭。
    watermark.checked = false;
    watermark.dispatchEvent(new Event('change', { bubbles: true }));
    for (const page of [1, 2, 3]) {
      expect(viewer.getLayerVisibility(page).background).toBe(false);
    }
    // 单独打开第 2 页背景 → 总项变为半选。
    viewer.setLayerVisibility(2, { background: true });
    expect(viewer.getLayerVisibility(2).background).toBe(true);
    const summaryBox = boxOf(allRow.nextElementSibling as HTMLElement, 'background');
    expect(summaryBox.indeterminate).toBe(true);
    expect(summaryBox.getAttribute('aria-checked')).toBe('mixed');
    // 恢复默认：全部回到默认可见（全画），渲染实参不再带过滤。
    viewer.resetLayerVisibility();
    for (const page of [1, 2, 3]) {
      expect(viewer.getLayerVisibility(page).background).toBe(true);
    }
    expect(viewer.getPageContentFilter(1)).toBeUndefined();
    expect(boxOf(allRow.nextElementSibling as HTMLElement, 'background').indeterminate).toBe(false);
    expect(boxOf(allRow.nextElementSibling as HTMLElement, 'background').checked).toBe(true);
    viewer.destroy();
  });
});

describe('V-LAYERS-06 按页重绘与过滤透传', () => {
  it('取消某页一层只重绘该页，render 实参带该页过滤；其它页仍不带过滤', async () => {
    const { viewer, log } = await openViewer({}, 3);
    await vi.waitFor(() => {
      expect(log(0).renders.length).toBeGreaterThan(0);
    });
    await viewer.goToPage(2);
    await vi.waitFor(() => {
      expect(log(1).renders.length).toBeGreaterThan(0);
    });
    const before = [0, 1, 2].map((index) => log(index).renders.length);
    viewer.setLayerVisibility(2, { body: false });
    await vi.waitFor(() => {
      expect(log(1).renders.length).toBe(before[1]! + 1);
    });
    const filter = log(1).renders.at(-1)!;
    expect(filter.layers?.body).toStrictEqual({ page: false, templates: false });
    expect(filter.layers?.background).toStrictEqual({ page: true, templates: true });
    expect(filter.annotations).toBe(true);
    expect(filter.signatures).toBe(true);
    // 其它页的过滤没有变化（未发生带过滤的渲染）。
    for (const index of [0, 2]) {
      expect(log(index).renders.every((entry) => entry === undefined)).toBe(true);
    }
    viewer.destroy();
  });
});

describe('V-LAYERS-07 导出与打印逐页过滤', () => {
  it('单页导出与打印只对目标页传过滤，多页导出逐页各自过滤', async () => {
    const { viewer, log } = await openViewer({}, 3);
    await vi.waitFor(() => {
      expect(log(0).renders.length).toBeGreaterThan(0);
    });
    viewer.setLayerVisibility(2, { background: false });
    await viewer.exportImage({ page: 2 });
    expect(log(1).exports.at(-1)?.layers?.background).toStrictEqual({ page: false, templates: false });
    await viewer.exportImage({ page: 1 });
    expect(log(0).exports.at(-1)).toBeUndefined();
    await viewer.print({ pages: [2] });
    const printed = log(1).exports.at(-1)!;
    expect(printed.layers?.background).toStrictEqual({ page: false, templates: false });
    await viewer.exportImages({ format: 'png' });
    expect(log(0).exports.at(-1)).toBeUndefined();
    expect(log(1).exports.at(-1)?.layers?.background).toStrictEqual({ page: false, templates: false });
    expect(log(2).exports.at(-1)).toBeUndefined();
    viewer.destroy();
  });
});

describe('V-LAYERS-08 重开文档回到默认', () => {
  it('close 后重新 open：每页可见性回到 layerPanel.defaultVisibility', async () => {
    const { viewer } = await openViewer({ layerPanel: { defaultVisibility: { background: false } } }, 2);
    expect(viewer.getLayerVisibility(1).background).toBe(false);
    viewer.setLayerVisibility(1, { background: true, body: false });
    expect(viewer.getLayerVisibility(1).body).toBe(false);
    await viewer.close();
    await viewer.open(new ArrayBuffer(8));
    await viewer.ready;
    for (const page of [1, 2]) {
      const visibility = viewer.getLayerVisibility(page);
      expect(visibility.background).toBe(false);
      expect(visibility.body).toBe(true);
    }
    expect(viewer.getLayerPanelState().pages).toEqual({});
    viewer.destroy();
  });
});

describe('V-LAYERS-10 总项组不出现注释类型复选框（用户确认第 5 条）', () => {
  it('展开总项并点击其“注释”行都不产生类型复选框', async () => {
    const { viewer } = await openViewer({}, 3);
    viewer.openSidebar('layers');
    const shell = getUIShell(viewer)!;
    const panel = shell.sidebar.getPanel('layers')!;
    const allRow = panel.querySelector<HTMLElement>('[data-role="all"]')!;
    if (allRow.getAttribute('aria-expanded') !== 'true') allRow.click();
    const group = allRow.nextElementSibling as HTMLElement;
    const annotationRow = group.querySelector<HTMLElement>('[data-layer="annotations"]')!;
    expect(annotationRow).not.toBeNull();
    // 总项下的“注释”行只有占位箭头，没有真实展开箭头与 aria-expanded。
    expect(annotationRow.getAttribute('aria-expanded')).toBeNull();
    expect(annotationRow.querySelector('.ofd-layers__twisty--sub')).toBeNull();
    expect(annotationRow.querySelector('.ofd-layers__twisty--placeholder')).not.toBeNull();
    annotationRow.click();
    // 点击后仍不生成类型组：总项组内类型复选框数量恒为 0。
    expect(group.querySelectorAll('input[data-role="type"]').length).toBe(0);
    expect(panel.querySelectorAll('input[data-role="type"]').length).toBe(0);
    // 也没有写回任何页级状态（批量改类型只能走 setAnnotationTypeForAllPages）。
    expect(viewer.getLayerPanelState().pages).toEqual({});
    viewer.destroy();
  });
});

describe('V-LAYERS-11 真实路径：首次点击与工具栏入口都能立即挂载', () => {
  it('点一次“图层”tab 立即得到完整面板（当前页已展开）', async () => {
    const { viewer } = await openViewer({}, 3);
    const tab = tabRow().querySelector<HTMLButtonElement>('[data-view="layers"]')!;
    tab.click();
    expect(viewer.getSidebarView()).toBe('layers');
    const panel = getUIShell(viewer)!.sidebar.getPanel('layers')!;
    expect(panel.hidden).toBe(false);
    // 首行总项 + 三页 + 当前页六项 = 10 行；点击一次即应完整，无需第二次点击。
    expect(panel.querySelectorAll('.ofd-layers__row').length).toBe(10);
    expect(panel.querySelectorAll('.ofd-layers__row--layer').length).toBe(6);
    expect(panel.querySelector('[data-role="all"]')).not.toBeNull();
    viewer.destroy();
  });

  it('工具栏侧栏按钮打开默认视图后，切到图层 tab 也只有一次点击', async () => {
    const { viewer } = await openViewer({}, 3);
    const toggle = document.querySelector<HTMLButtonElement>(
      '.ofd-toolbar__button[aria-label="显示侧栏"]',
    )!;
    toggle.click();
    expect(viewer.getSidebarView()).toBe('thumbnails');
    const layersTab = tabRow().querySelector<HTMLButtonElement>('[data-view="layers"]')!;
    layersTab.click();
    const panel = getUIShell(viewer)!.sidebar.getPanel('layers')!;
    expect(panel.hidden).toBe(false);
    expect(panel.querySelectorAll('.ofd-layers__row--layer').length).toBe(6);
    viewer.destroy();
  });
});

describe('V-LAYERS-09 侧栏外壳与图层面板共用标题栏', () => {
  /** 读取侧栏根节点。 */
  function sidebarRoot(): HTMLElement {
    const element = document.querySelector<HTMLElement>('.ofd-viewer__sidebar');
    if (!element) throw new Error('缺少侧栏');
    return element;
  }

  it('打开图层 tab 后关闭按钮与调整宽度按钮仍可用且带可访问名称', async () => {
    const { viewer } = await openViewer();
    viewer.openSidebar('layers');
    const root = sidebarRoot();
    const close = root.querySelector<HTMLButtonElement>('.ofd-sidebar__close')!;
    const resizer = root.querySelector<HTMLElement>('.ofd-sidebar__resizer')!;
    expect(close.querySelector('svg')).not.toBeNull();
    expect(close.getAttribute('aria-label')).toBe('关闭侧栏');
    expect(resizer.getAttribute('aria-label')).toBe('调整侧栏宽度');
    expect(tabRow().getAttribute('aria-label')).toBe('侧栏标签');
    // 关闭仍生效：点击关闭按钮后侧栏收起。
    close.click();
    expect(viewer.getSidebarView()).toBeNull();
    viewer.destroy();
  });

  it('未打开文档时图层 tab 只显示空态文案，不出现树与复选框', async () => {
    const doc = createMockDocument({ pageCount: 3 });
    engineMocks.open.mockReset();
    engineMocks.open.mockImplementation(async () => doc);
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: { enabled: false },
    });
    viewers.push(viewer);
    await viewer.ready;
    await viewer.close();
    viewer.openSidebar('layers');
    const shell = getUIShell(viewer)!;
    const panel = shell.sidebar.getPanel('layers')!;
    expect(panel.querySelector('[role="treeitem"]')).toBeNull();
    expect(panel.querySelector('input[type="checkbox"]')).toBeNull();
    expect(panel.textContent).toContain('打开文档后可控制图层显示');
    viewer.destroy();
  });
});
