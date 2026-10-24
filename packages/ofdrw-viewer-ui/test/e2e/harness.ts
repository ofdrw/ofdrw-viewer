/**
 * E2E 宿主页：按查询参数创建真实阅读器，并把实例与事件序列暴露给测试。
 *
 * 这里只做测试编排，不复制阅读器逻辑；所有行为均走公共入口。
 *
 * dist 入口追加按页面加载唯一的查询串：Playwright 会复用已启动的 Vite 开发
 * 服务器，而 `dist/**` 不在文件监听范围，固定 URL 会让服务器一直返回上一次
 * 构建的模块图，导致 E2E 实际测试旧产物。
 */
const distModuleUrl = new URL('../../dist/index.js', import.meta.url);
distModuleUrl.searchParams.set('v', String(Math.trunc(performance.timeOrigin)));
const { OFDViewer } = (await import(
  /* @vite-ignore */ distModuleUrl.href
)) as typeof import('../../dist/index.js');

/** 阅读器实例类型；动态导入后需从构造器推导。 */
type OFDViewerInstance = InstanceType<typeof OFDViewer>;

interface HarnessEvent {
  readonly type: string;
  readonly at: number;
  readonly detail: unknown;
}

interface RenderTaskLike {
  /** 引擎操作 id；仅用于透传。 */
  readonly id?: number;
  /** 渲染完成 Promise。 */
  readonly promise: Promise<unknown>;
  /** 取消渲染。 */
  cancel(): void;
}

interface EnginePageLike {
  render(options: unknown): RenderTaskLike;
}

interface HarnessState {
  readonly viewer: OFDViewerInstance;
  readonly events: HarnessEvent[];
  readonly errors: string[];
  readonly consoleWarnings: string[];
  readonly openStartedAt: number;
  openSettledAt: number | null;
  /** 向阅读器注入的引擎事件总线派发合成事件；仅测试夹具使用。 */
  emitEngineEvent(type: string, payload: Record<string, unknown>): void;
  /** 在页面渲染前登记用途；仅测试夹具使用。 */
  trackPageRender(pageIndex: number, purpose: 'main' | 'thumbnail'): { drop(): void };
  /** 延迟一页真实 page.render 的完成 Promise；仅用于像素回归。 */
  delayPageRender(pageIndex: number, delayMs: number): Promise<void>;
  /** 取消最近一次被延迟的真实渲染；仅用于 abort 回归。 */
  cancelDelayedPageRender(): void;
}

declare global {
  interface Window {
    __harness?: HarnessState;
    __events?: HarnessEvent[];
    __errors?: string[];
    __viewer?: OFDViewerInstance;
  }
}

const params = new URLSearchParams(location.search);
const src = params.get('src');
if (!src) throw new Error('缺少 src 参数');

const host = document.querySelector<HTMLElement>('#host');
const container = document.querySelector<HTMLElement>('#viewer');
if (!host || !container) throw new Error('宿主结构缺失');

const hostWidth = Number(params.get('w') ?? '0');
if (hostWidth > 0) {
  host.style.width = `${hostWidth}px`;
  host.style.flex = '0 0 auto';
}

let features: Record<string, boolean> = {};
const rawFeatures = params.get('features');
if (rawFeatures) features = JSON.parse(rawFeatures) as Record<string, boolean>;
const rawDisplay = params.get('display');
const featureDisplay =
  rawDisplay === 'disable' || rawDisplay === 'hide' ? rawDisplay : undefined;
const scale = params.get('scale');
const initialScale = scale === 'auto' ? 'auto' : Number(scale ?? '1');
const page = Number(params.get('page') ?? '1');
const rotation = Number(params.get('rotation') ?? '0');
const sidebar = params.get('sidebar');
const password = params.get('password');
const userName = params.get('userName') ?? undefined;
const rootCertificate = params.get('root');
const autoPrompt = params.get('prompt') === '1';
const autoVerify = params.get('autoVerify') !== '0';
const cryptoEnabled = params.get('crypto') !== '0';
const rawFonts = params.get('fonts');

/** 测试用字体来源。 */
interface HarnessFontSource {
  readonly url: string;
  readonly family?: string;
}

/**
 * 解析字体配置参数。
 *
 * 每个来源形如 `default=http://…`、`supplementary=http://…`（逗号分隔同类来源），
 * 可追加 `|family=<字体族名>` 验证宿主声明；空值（`fonts=`）表示不配置字体，
 * 行为与未引入 `fonts` 时一致。
 *
 * @param raw `fonts` 查询参数。
 * @returns 阅读器字体配置；未提供或为空时 undefined。
 */
function parseFonts(raw: string | null): { default?: HarnessFontSource[]; supplementary?: HarnessFontSource[] } | undefined {
  if (!raw) return undefined;
  const groups: { default: HarnessFontSource[]; supplementary: HarnessFontSource[] } = {
    default: [],
    supplementary: [],
  };
  for (const item of raw.split(',')) {
    const [kind, ...rest] = item.split('=');
    const [urlPart, ...modifiers] = rest.join('=').trim().split('|');
    const url = urlPart?.trim() ?? '';
    if (!url) continue;
    const family = modifiers
      .map((modifier) => /^family=(.*)$/.exec(modifier))
      .find((match) => match !== null)?.[1];
    const source: HarnessFontSource = family ? { url, family } : { url };
    if (kind === 'default') groups.default.push(source);
    else if (kind === 'supplementary') groups.supplementary.push(source);
  }
  if (groups.default.length === 0 && groups.supplementary.length === 0) return undefined;
  return {
    ...(groups.default.length > 0 ? { default: groups.default } : {}),
    ...(groups.supplementary.length > 0 ? { supplementary: groups.supplementary } : {}),
  };
}

const fonts = parseFonts(rawFonts);
const rawAliases = params.get('aliases');
/** 宿主追加别名组：`a+b;c+d` 形式。 */
const fontAliases =
  rawAliases && fonts
    ? rawAliases
        .split(';')
        .map((group) => group.split('+').map((name) => name.trim()).filter(Boolean))
        .filter((group) => group.length > 0)
    : undefined;
const fontOptions =
  fonts === undefined
    ? undefined
    : {
        ...fonts,
        ...(fontAliases && fontAliases.length > 0 ? { aliases: fontAliases } : {}),
      };

const events: HarnessEvent[] = [];
const errors: string[] = [];
const consoleWarnings: string[] = [];

const viewer = new OFDViewer({
  container,
  source: src,
  initialScale,
  initialPage: page,
  rotation: rotation === 90 || rotation === 180 || rotation === 270 ? rotation : 0,
  theme: params.get('theme') === 'dark' ? 'dark' : 'light',
  locale: params.get('locale') === 'en-US' ? 'en-US' : 'zh-CN',
  features,
  ...(featureDisplay ? { featureDisplay } : {}),
  ...(fontOptions === undefined ? {} : { fonts: fontOptions }),
  crypto: cryptoEnabled
    ? {
        ...(password ? { credentials: { kind: 'password' as const, password, ...(userName ? { userName } : {}) } } : {}),
        ...(rootCertificate ? { rootCertificates: [{ url: rootCertificate }] } : {}),
        ...(autoPrompt ? { autoPrompt: true } : {}),
        autoVerify,
      }
    : { enabled: false },
  onWarning: (warning) => {
    consoleWarnings.push(`${warning.code}: ${warning.message}`);
  },
});

const tracked = [
  'documentopen',
  'pagechanging',
  'pagerendered',
  'scalechanging',
  'rotationchanging',
  'findstart',
  'findmatches',
  'findcurrent',
  'selectionchange',
  'signatureclick',
  'verificationcompleted',
  'printstart',
  'printprogress',
  'printend',
  'exportprogress',
  'featureschange',
  'statechange',
  'warning',
  'error',
] as const;
for (const type of tracked) {
  viewer.on(type, (detail) => {
    events.push({ type, at: performance.now(), detail });
  });
}

window.addEventListener('error', (event) => {
  errors.push(event.message || String(event.error));
});
window.addEventListener('unhandledrejection', (event) => {
  errors.push(String(event.reason));
});

const engineEvents = (
  viewer as unknown as {
    engineEvents: { emit(type: string, event: Record<string, unknown>): void } | null;
  }
).engineEvents;
let syntheticSequence = 10_000;

/**
 * 向阅读器持有的引擎事件总线派发合成事件。
 *
 * @param type 事件名。
 * @param payload 事件专属载荷。
 */
function emitEngineEvent(type: string, payload: Record<string, unknown>): void {
  if (!engineEvents) throw new Error('当前阅读器没有引擎事件总线');
  syntheticSequence += 1;
  engineEvents.emit(type, {
    type,
    timestamp: performance.now(),
    sequence: syntheticSequence,
    ...payload,
  });
}

/**
 * 登记一次即将由测试触发的页面渲染用途。
 *
 * @param pageIndex 页索引，0-based。
 * @param purpose 渲染用途。
 * @returns 可回滚的登记句柄。
 */
function trackPageRender(
  pageIndex: number,
  purpose: 'main' | 'thumbnail',
): { drop(): void } {
  const tracker = viewer as unknown as {
    trackPageRenderStart?: (index: number, kind: 'main' | 'thumbnail') => { drop(): void };
  };
  if (!tracker.trackPageRenderStart) throw new Error('阅读器未提供渲染归属登记');
  return tracker.trackPageRenderStart(pageIndex, purpose);
}

let delayedRenderPageIndex: number | null = null;

/**
 * 延迟指定页真实 page.render 的完成 Promise，用于在渲染期间采样旧 canvas。
 *
 * @param pageIndex 页索引，0-based。
 * @param delayMs 延迟完成时长，单位毫秒。
 */
async function delayPageRender(pageIndex: number, delayMs: number): Promise<void> {
  const controller = (
    viewer as unknown as {
      controller: { getPage(index: number): Promise<EnginePageLike> };
    }
  ).controller;
  const page = await controller.getPage(pageIndex);
  const original = page.render.bind(page);
  delayedRenderPageIndex = pageIndex;
  page.render = (options: unknown) => {
    const task = original(options);
    const promise = task.promise.then(
      (value) =>
        new Promise<unknown>((resolve) => {
          setTimeout(() => resolve(value), delayMs);
        }),
    );
    return { id: task.id, promise, cancel: () => task.cancel() };
  };
}

/** 取消最近一次被延迟的真实渲染；走阅读器渲染队列，等价于 UI abort。 */
function cancelDelayedPageRender(): void {
  if (delayedRenderPageIndex === null) return;
  const queue = (viewer as unknown as { queue: { cancel(key: string): void } }).queue;
  queue.cancel(`page:${delayedRenderPageIndex}`);
}

window.__harness = {
  viewer,
  events,
  errors,
  consoleWarnings,
  openStartedAt: performance.now(),
  openSettledAt: null,
  emitEngineEvent,
  trackPageRender,
  delayPageRender,
  cancelDelayedPageRender,
};
window.__events = events;
window.__errors = errors;
window.__viewer = viewer;

if (sidebar) {
  viewer.openSidebar(sidebar as 'thumbnails' | 'outline' | 'bookmarks' | 'signatures');
}

viewer.ready.then(
  () => {
    window.__harness!.openSettledAt = performance.now();
    document.documentElement.dataset.e2eReady = 'true';
  },
  (error: unknown) => {
    window.__errors!.push(String(error));
    document.documentElement.dataset.e2eReady = 'error';
  },
);
