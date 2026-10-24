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
import type { OFDViewerElement } from '../packages/ofdrw-viewer-ui/src/component/ofd-viewer-element';

/** 内置示例文档；`name` 对应 `public/samples` 下的文件名。 */
const SAMPLES = [
  { name: 'ofd-viewer-ui-showcase.ofd', label: '功能展示' },
  { name: 'doc1File.ofd', label: '示例文档' },
  { name: 'dense-text-perf.ofd', label: '密集文本' },
] as const;

/** 页面首次加载时默认打开的示例。 */
const DEFAULT_SAMPLE = SAMPLES[0].name;

/** 状态提示自动隐藏的定时器。 */
let toastTimer: number | undefined;

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

const viewer = required<OFDViewerElement>('viewer');
const statusEl = required<HTMLElement>('status');
const versionEl = required<HTMLElement>('version');
const fileInput = required<HTMLInputElement>('file');
const sampleSelect = required<HTMLSelectElement>('sample');
const themeSelect = required<HTMLSelectElement>('theme');
const localeSelect = required<HTMLSelectElement>('locale');

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

// 本地文件：浏览器端读取，不上传；清空 input 便于重复选择同一文件。
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) return;
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

// 系统主题变化时，仅在“跟随系统”模式下同步外壳配色。
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (themeSelect.value === 'auto') applyShellTheme('auto');
});

/**
 * 页面初始化：填充版本号、应用外壳主题并打开初始文档。
 *
 * 若地址栏已有 `?file=` 或 `?base64=`，不设置 `source`，由阅读器自行读取查询参数；
 * 否则打开默认示例。这样站点不再重复实现 URL 解析与来源规范化。
 */
function main(): void {
  const versions = getVersions();
  versionEl.textContent = `UI ${versions.ui} · engine ${versions.engine} · crypto ${versions.crypto}`;
  versionEl.title = '阅读器各组成包的版本';
  applyShellTheme(themeSelect.value);

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