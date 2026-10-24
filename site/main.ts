/**
 * OFD 阅读器在线演示入口。
 *
 * 页面只有 `<ofd-viewer>` 与悬浮在底部的演示控件，阅读器铺满整个视口；
 * 文档解析与页面渲染全部在浏览器本地完成，不上传文件。
 */
import '../packages/ofdrw-viewer-ui/src/style.css';
import './style.css';
import '../packages/ofdrw-viewer-ui/src/component/ofd-viewer-element';
import { getVersions } from '../packages/ofdrw-viewer-ui/src/index';
import type { ViewerFontOptions } from '../packages/ofdrw-viewer-ui/src/index';
import type { OFDViewerElement } from '../packages/ofdrw-viewer-ui/src/component/ofd-viewer-element';

/** 内置示例文档；`name` 对应 `public/samples` 下的文件名。 */
const SAMPLES = [
  { name: 'ofd-viewer-ui-showcase.ofd', label: '功能展示' },
  { name: 'doc1File.ofd', label: '示例文档' },
  { name: 'dense-text-perf.ofd', label: '密集文本' },
] as const;

/**
 * 拼接站点内静态资源 URL。
 *
 * 使用 `import.meta.env.BASE_URL` 前缀，保证部署到 GitHub Pages 子路径（如 `/ofdrw-viewer/`）
 * 时仍能取到 `public/` 下的文件；本地开发时 Base 为 `/`。
 *
 * @param path 相对 `public/` 目录的路径，例如 `fonts/wqy-microhei.woff2`
 * @returns 去掉多余斜杠后的站点绝对路径
 */
function siteAsset(path: string): string {
  return `${import.meta.env.BASE_URL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * 站点字体别名组：把 OFD 常见的「宋体」「黑体」声明与本站兜底字体的真实名关联。
 *
 * - 衬线组：宋体/SimSun 等 → 本地思源宋体（真实名 Noto Serif CJK SC）与 CDN 回落字体；
 * - 无衬线组：黑体/SimHei/微软雅黑 → 本地文泉驿微米黑（真实名 WenQuanYi Micro Hei）。
 *
 * UI 的 `fonts.aliases` 是追加语义（引擎内置别名组 + 本数组），因此不会丢失内置的
 * 仿宋/楷体/等线等映射；引擎会把同名归一化名扩散到同组内所有名称。
 */
const SITE_FONT_ALIASES: readonly (readonly string[])[] = [
  ['宋体', 'simsun', 'nsimsun', '新宋体', 'notoserifcjksc', 'notoserifsc', 'sourcehanserifsc', '思源宋体'],
  [
    '黑体',
    'simhei',
    'heiti',
    '微软雅黑',
    'microsoftyahei',
    'wenquanyimicrohei',
    'wenquanyimicroheimono',
    '文泉驿微米黑',
  ],
];

/**
 * 本地兜底字体的文件名（含内容哈希）。
 *
 * 文件名内嵌 `sha256` 前 8 位：字体内容一变文件名就变，浏览器可长期强缓存旧版本而不必
 * 担心读到过期字体。改动字体后须同步更新此处，`scripts/build-site-fonts.py` 会打印新名字。
 */
const LOCAL_SERIF_FILE = 'fonts/source-han-serif-sc.8d948a48.woff2';
/** 本地无衬线兜底字体文件名；哈希规则同上。 */
const LOCAL_SANS_FILE = 'fonts/wqy-microhei.cdece858.woff2';

/**
 * 站点内置字体：随站点分发的两个本地字体，不依赖任何外部 CDN。
 *
 * - `default`：思源宋体子集（OFL，约 10.6 MiB），覆盖 CJK 基本区全部汉字，负责「宋体」类声明；
 * - `supplementary`：文泉驿微米黑子集（Apache-2.0，约 1.07 MiB），负责「黑体」类声明，
 *   同时作为思源宋体缺字时的逐字形补充。
 *
 * 两个文件都同时覆盖基本拉丁与常用标点，因此不再需要额外的西文补字来源。
 */
const SITE_FONTS: ViewerFontOptions = {
  default: [{ url: siteAsset(LOCAL_SERIF_FILE), family: 'Noto Serif CJK SC' }],
  supplementary: [{ url: siteAsset(LOCAL_SANS_FILE), family: 'WenQuanYi Micro Hei' }],
  aliases: SITE_FONT_ALIASES,
};

/** 字体档位：auto 使用 SITE_FONTS，off 不配置字体（便于对比缺字现象）。 */
type FontPreset = 'auto' | 'off';

/** 页面首次加载时默认打开的示例。 */
const DEFAULT_SAMPLE = SAMPLES[0].name;

/** 状态提示自动隐藏的定时器。 */
let toastTimer: number | undefined;

/** 演示控件在鼠标移出后自动隐藏的延时，单位毫秒。 */
const DOCK_HIDE_DELAY = 400;

/** `?dock=on` 时演示控件的常显时长，单位毫秒；超时后自动淡出，提示底部有操作入口。 */
const DOCK_SHOW_DURATION = 3000;

/** 演示控件的显示策略：on 显示一段时间后自动隐藏，并支持悬停唤出；off 彻底隐藏。 */
type DockMode = 'on' | 'off';

/** 演示控件自动隐藏的待执行定时器。 */
let dockHideTimer: number | undefined;

/**
 * 按 id 查询必需元素，缺失时直接抛错以暴露页面结构问题。
 *
 * @param id 元素 id
 * @returns 查询到的元素
 */
function required<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`演示页缺少 #${id} 元素`);
  return element as unknown as T;
}

/**
 * 当前 `<ofd-viewer>` 元素。
 *
 * 切换字体档位会重建元素（`fonts` 只在实例创建时读取），所以这里是可变引用。
 */
let viewer = required<OFDViewerElement>('viewer');
const dockEl = required<HTMLElement>('dock');
const dockZoneEl = required<HTMLElement>('dock-hover-zone');
const statusEl = required<HTMLElement>('status');
const versionEl = required<HTMLElement>('version');
const fileInput = required<HTMLInputElement>('file');
const sampleSelect = required<HTMLSelectElement>('sample');
const themeSelect = required<HTMLSelectElement>('theme');
const localeSelect = required<HTMLSelectElement>('locale');
const fontSelect = required<HTMLSelectElement>('fonts');

/**
 * 显示状态提示。
 *
 * @param message 提示文案
 * @param duration 自动隐藏延时，单位毫秒；传 0 表示保持显示
 */
function setStatus(message: string, duration = 2500): void {
  window.clearTimeout(toastTimer);
  statusEl.textContent = message;
  statusEl.dataset.visible = 'true';
  if (duration > 0) {
    toastTimer = window.setTimeout(() => {
      statusEl.dataset.visible = 'false';
    }, duration);
  }
}

/**
 * 展示字体读取失败（`W_FONT_MISSING`）等字体相关 warning。
 *
 * 字体读取失败不阻断文档打开，只提示一次，避免逐页 warning 反复覆盖状态栏。
 *
 * @param event `ofd-warning` 事件
 */
function reportFontWarning(event: Event): void {
  const detail = (event as CustomEvent<{ code?: string; message?: string }>).detail;
  if (!detail?.code?.startsWith('W_FONT')) return;
  setStatus(`字体加载失败：${detail.message ?? '未知原因'}（文档其余内容不受影响）`, 6000);
}

/**
 * 同步地址栏的 `file` 查询参数，便于复制链接分享当前文档。
 *
 * 相对路径由阅读器按当前页面地址解析，站点不再自己拼绝对 URL。
 *
 * @param file 要写入的站点内相对路径或完整 URL；传 null 表示移除参数
 */
function updateQuery(file: string | null): void {
  try {
    const url = new URL(window.location.href);
    if (file) url.searchParams.set('file', file);
    else url.searchParams.delete('file');
    window.history.replaceState(null, '', url);
  } catch {
    // 非 http(s) 环境（如 file://）可能禁止修改历史记录，忽略即可。
  }
}

/**
 * 读取演示控件的显示策略。
 *
 * 地址参数 `?dock=` 优先；不传参数时默认值为 on。取值不区分大小写，
 * 同时接受 1/0/true/false 等常见写法；无法识别的值时按默认的 on 处理。
 *
 * @returns 显示策略：on 显示一段时间后自动隐藏，off 彻底隐藏
 */
function readDockMode(): DockMode {
  const raw = new URLSearchParams(window.location.search).get('dock');
  if (raw === null) return 'on';
  const normalized = raw.trim().toLowerCase();
  if (['off', '0', 'false', 'hidden', 'none'].includes(normalized)) return 'off';
  return 'on';
}

/**
 * 立即显示演示控件，并取消待执行的隐藏。
 */
function showDock(): void {
  window.clearTimeout(dockHideTimer);
  dockEl.dataset.visible = 'true';
}

/**
 * 延时隐藏演示控件；控件内有键盘焦点时保持显示，避免焦点落在隐形控件上。
 *
 * @param delay 隐藏前的等待时间，单位毫秒；默认使用鼠标移出后的短延时
 */
function scheduleHideDock(delay: number = DOCK_HIDE_DELAY): void {
  window.clearTimeout(dockHideTimer);
  dockHideTimer = window.setTimeout(() => {
    if (dockEl.matches(':focus-within')) return;
    dockEl.dataset.visible = 'false';
  }, delay);
}

/**
 * 按显示策略初始化演示控件，并绑定悬停、触摸与键盘的唤出行为。
 *
 * @param mode 显示策略：on 显示一段时间后自动隐藏，off 视为不存在
 */
function setupDock(mode: DockMode): void {
  if (mode === 'off') {
    // dock 及其感应区从文档中整体移除，不占布局、不可聚焦、不进无障碍树；
    // 恢复入口在地址参数里（去掉 dock 参数或 ?dock=on）。
    dockEl.remove();
    dockZoneEl.remove();
    return;
  }

  dockEl.dataset.autohide = 'on';
  dockZoneEl.setAttribute('aria-hidden', 'false');
  dockEl.addEventListener('mouseenter', showDock);
  dockEl.addEventListener('mouseleave', () => scheduleHideDock());
  dockEl.addEventListener('focusin', showDock);
  dockEl.addEventListener('focusout', () => scheduleHideDock());

  // 鼠标移入底部感应区即唤出，移出后延时淡出。
  dockZoneEl.addEventListener('mouseenter', showDock);
  dockZoneEl.addEventListener('mouseleave', () => scheduleHideDock());
  // 触摸设备没有悬停：轻触底部先唤出，再操作控件；在控件上触摸时保持可见，
  // 离开控件后重新计时淡出。
  dockZoneEl.addEventListener('touchstart', showDock, { passive: true });
  dockEl.addEventListener('touchstart', showDock, { passive: true });
  dockEl.addEventListener('touchend', () => scheduleHideDock());

  // dock=on：进入页面先完整显示 3 秒，让访客知道底部有这些入口，随后自动隐藏；
  // 期间若鼠标已在控件上或已触发悬停，showDock 会清除该定时器。
  showDock();
  scheduleHideDock(DOCK_SHOW_DURATION);
}

/**
 * 读取字体档位。
 *
 * 地址参数 `?fonts=` 优先，其次为控件当前值；只有 `off` 关闭字体，其余按 auto。
 *
 * @param raw 参数值或控件值
 * @returns 字体档位
 */
function readFontPreset(raw: string | null): FontPreset {
  return raw !== null && raw.trim().toLowerCase() === 'off' ? 'off' : 'auto';
}

/**
 * 按档位重建阅读器并应用字体配置。
 *
 * `fonts` 只在实例创建时读取：先用一个占位节点插在 `<ofd-viewer>` 前，移除元素触发
 * 断开销毁，设置 property 后再把新元素插回占位节点处，由组件按当前属性重新创建实例。
 * 占位节点用于保留页面顺序（dock 感应区与控件依赖 `#viewer` 的位置）。
 *
 * @param preset 字体档位
 * @returns 重建后的 `<ofd-viewer>` 元素
 */
function applyFontPreset(preset: FontPreset): OFDViewerElement {
  const placeholder = document.createComment('ofd-viewer');
  viewer.replaceWith(placeholder);
  const next = document.createElement('ofd-viewer') as OFDViewerElement;
  for (const { name, value } of Array.from(viewer.attributes)) next.setAttribute(name, value);
  next.fonts = preset === 'off' ? undefined : SITE_FONTS;
  placeholder.replaceWith(next);
  fontSelect.value = preset;
  next.addEventListener('ofd-warning', reportFontWarning);
  return next;
}

/**
 * 按主题设置与系统偏好切换页面外壳配色。
 *
 * @param theme 阅读器主题：auto / light / dark
 */
function applyShellTheme(theme: string): void {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = theme === 'dark' || (theme === 'auto' && prefersDark);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

/**
 * 打开内置示例，并同步示例下拉框与地址栏。
 *
 * 相对路径直接交给阅读器，由 UI 按当前页面地址解析；打开失败由 `ofd-error` 事件统一提示。
 *
 * @param name `SAMPLES` 中的文件名
 */
function openSample(name: string): void {
  const sample = SAMPLES.find((item) => item.name === name);
  if (!sample) return;
  currentFile = null;
  sampleSelect.value = sample.name;
  updateQuery(`samples/${sample.name}`);
  setStatus(`正在打开：${sample.label}`, 0);
  viewer.source = `samples/${sample.name}`;
}

// 文档打开：展示总页数，提示会在数秒后自动消失。
viewer.addEventListener('ofd-document-open', (event) => {
  const detail = (event as CustomEvent<{ pageCount?: number }>).detail;
  setStatus(
    typeof detail?.pageCount === 'number' ? `已打开，共 ${detail.pageCount} 页` : '文档已打开',
  );
});

// 打开失败：展示核心错误信息，保留更长时间便于阅读。
viewer.addEventListener('ofd-error', (event) => {
  const detail = (event as CustomEvent<{ message?: string }>).detail;
  setStatus(`打开失败：${detail?.message ?? '未知错误'}`, 6000);
});

// 字体缺失/读取失败：只提示，不阻断文档显示。元素会随字体档位重建，监听绑定在
// `applyFontPreset()` 中按新元素重新挂载。
viewer.addEventListener('ofd-warning', reportFontWarning);

/**
 * 当前打开的本地文件。
 *
 * 字体档位切换会重建 `<ofd-viewer>` 元素，重开后需据此恢复用户选择的本地文档；
 * 演示页不持久化文件内容，仅在同一次页面会话内保留引用。
 */
let currentFile: File | null = null;

// 本地文件：浏览器端读取，不上传；清空 input 便于重复选择同一文件。
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  currentFile = file;
  sampleSelect.value = '';
  updateQuery(null);
  setStatus(`正在打开：${file.name}`, 0);
  viewer.source = file;
  fileInput.value = '';
});

// 示例切换：空值代表当前是本地文件或自定义链接，无需处理。
sampleSelect.addEventListener('change', () => {
  if (sampleSelect.value) openSample(sampleSelect.value);
});

// 主题切换：同时作用于阅读器与页面外壳。
themeSelect.addEventListener('change', () => {
  viewer.setAttribute('theme', themeSelect.value);
  applyShellTheme(themeSelect.value);
});

// 语言切换：只影响阅读器内置文案。
localeSelect.addEventListener('change', () => {
  viewer.setAttribute('locale', localeSelect.value);
});

// 字体档位：切换后会重建阅读器并按新档位打开当前文档。
fontSelect.addEventListener('change', () => {
  const preset = readFontPreset(fontSelect.value);
  viewer = applyFontPreset(preset);
  openCurrent();
});

// 系统主题变化时，仅在“跟随系统”模式下同步外壳配色。
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (themeSelect.value === 'auto') applyShellTheme('auto');
});

/**
 * 按当前选择重新打开文档。
 *
 * 阅读器重建后没有文档，优先恢复示例下拉框中的示例，其次是地址栏
 * `?file=`/`?base64=`（由阅读器自行解析）。
 */
function openCurrent(): void {
  if (sampleSelect.value) {
    openSample(sampleSelect.value);
    return;
  }
  // 本地文件优先：字体档位切换重建元素后由此恢复，否则文档会丢失。
  if (currentFile) {
    viewer.source = currentFile;
    return;
  }
  const params = new URLSearchParams(window.location.search);
  if (params.has('file') || params.has('base64')) void viewer.open();
}

/**
 * 页面初始化：填充版本号、应用外壳主题、字体档位并打开初始文档。
 *
 * 若地址栏已有 `?file=` 或 `?base64=`，不设置 `source`，由阅读器自行读取查询参数；
 * 否则打开默认示例。这样站点不再重复实现 URL 解析与来源规范化。
 */
function main(): void {
  const versions = getVersions();
  versionEl.textContent = `UI ${versions.ui} · engine ${versions.engine} · crypto ${versions.crypto}`;
  versionEl.title = '阅读器各组成包的版本';
  applyShellTheme(themeSelect.value);

  setupDock(readDockMode());
  viewer = applyFontPreset(readFontPreset(new URLSearchParams(window.location.search).get('fonts')));

  const params = new URLSearchParams(window.location.search);
  if (params.has('file') || params.has('base64')) {
    sampleSelect.value = '';
    return;
  }
  openSample(DEFAULT_SAMPLE);
}

try {
  main();
} catch (reason) {
  setStatus(`初始化失败：${reason instanceof Error ? reason.message : String(reason)}`, 6000);
}