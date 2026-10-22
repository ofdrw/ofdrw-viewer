/**
 * demo 入口：只演示 `<ofd-viewer>` 的桥接用法。
 *
 * 先运行 `pnpm -C packages/ofdrw-viewer-ui build`，再启动任意静态服务器或
 * `npx vite packages/ofdrw-viewer-ui/demo`。
 */
import '../dist/element.js';
import type { OFDViewerElement } from '../src/component/ofd-viewer-element';
import type { ViewerFeatures } from '../src/component/support';

const viewer = document.querySelector<OFDViewerElement>('#viewer');
const status = document.querySelector<HTMLElement>('#status');
const fileInput = document.querySelector<HTMLInputElement>('#file');
const themeSelect = document.querySelector<HTMLSelectElement>('#theme');
const localeSelect = document.querySelector<HTMLSelectElement>('#locale');
const featureInputs = {
  print: document.querySelector<HTMLInputElement>('#feature-print'),
  find: document.querySelector<HTMLInputElement>('#feature-find'),
  toolbar: document.querySelector<HTMLInputElement>('#feature-toolbar'),
} as const;

if (!viewer || !status) throw new Error('demo 结构缺失');

/**
 * 更新状态提示。
 *
 * @param message 文案。
 */
function setStatus(message: string): void {
  status.textContent = message;
}

/**
 * 读取当前功能勾选状态。
 *
 * @returns 功能补丁。
 */
function readFeatures(): ViewerFeatures {
  return {
    print: featureInputs.print?.checked ?? true,
    find: featureInputs.find?.checked ?? true,
    toolbar: featureInputs.toolbar?.checked ?? true,
  };
}

fileInput?.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  viewer.source = file;
  setStatus(`正在打开：${file.name}`);
});

themeSelect?.addEventListener('change', () => {
  viewer.setAttribute('theme', themeSelect.value);
});

localeSelect?.addEventListener('change', () => {
  viewer.setAttribute('locale', localeSelect.value);
});

for (const input of Object.values(featureInputs)) {
  input?.addEventListener('change', () => {
    viewer.features = readFeatures();
  });
}

viewer.addEventListener('ofd-document-open', (event) => {
  const detail = (event as CustomEvent<{ pageCount: number }>).detail;
  setStatus(`已打开，共 ${detail.pageCount} 页`);
});

viewer.addEventListener('ofd-page-change', (event) => {
  const detail = (event as CustomEvent<{ pageNumber: number }>).detail;
  setStatus(`第 ${detail.pageNumber} 页`);
});

viewer.addEventListener('ofd-error', (event) => {
  const detail = (event as CustomEvent<{ message?: string }>).detail;
  setStatus(`打开失败：${detail.message ?? '未知错误'}`);
});

// 支持 ?src=/path/to/file.ofd，便于本地服务器快速验证。
const src = new URLSearchParams(location.search).get('src');
if (src) {
  viewer.setAttribute('src', src);
  setStatus(`正在打开：${src}`);
}