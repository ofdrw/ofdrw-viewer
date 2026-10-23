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
  crypto: {
    ...(password ? { credentials: { kind: 'password' as const, password, ...(userName ? { userName } : {}) } } : {}),
    ...(rootCertificate ? { rootCertificates: [{ url: rootCertificate }] } : {}),
    ...(autoPrompt ? { autoPrompt: true } : {}),
    autoVerify,
  },
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

window.__harness = {
  viewer,
  events,
  errors,
  consoleWarnings,
  openStartedAt: performance.now(),
  openSettledAt: null,
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
