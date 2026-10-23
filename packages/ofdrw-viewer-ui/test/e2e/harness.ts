/**
 * E2E 宿主页：按查询参数创建真实阅读器，并把实例与事件序列暴露给测试。
 *
 * 这里只做测试编排，不复制阅读器逻辑；所有行为均走公共入口。
 */
import { OFDViewer } from '../../dist/index.js';

interface HarnessEvent {
  readonly type: string;
  readonly at: number;
  readonly detail: unknown;
}

interface HarnessState {
  readonly viewer: OFDViewer;
  readonly events: HarnessEvent[];
  readonly errors: string[];
  readonly consoleWarnings: string[];
  readonly openStartedAt: number;
  openSettledAt: number | null;
  /** 向阅读器注入的引擎事件总线派发合成事件；仅测试夹具使用。 */
  emitEngineEvent(type: string, payload: Record<string, unknown>): void;
  /** 在页面渲染前登记用途；仅测试夹具使用。 */
  trackPageRender(pageIndex: number, purpose: 'main' | 'thumbnail'): { drop(): void };
}

declare global {
  interface Window {
    __harness?: HarnessState;
    __events?: HarnessEvent[];
    __errors?: string[];
    __viewer?: OFDViewer;
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

window.__harness = {
  viewer,
  events,
  errors,
  consoleWarnings,
  openStartedAt: performance.now(),
  openSettledAt: null,
  emitEngineEvent,
  trackPageRender,
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
