/**
 * ofdrw-viewer-engine 最小 Web 验证页。
 *
 * 只验证公共 API：打开 OFD → getPage → getViewport → render → close；
 * 不做阅读器完整 UI，也不暴露 engine 内部模块。
 */

import {
  OFDDocument,
  isOFDError,
  type FontInput,
  type OFDPage,
  type OFDSource,
  type OFDWarning,
  type RenderTask,
} from 'ofdrw-viewer-engine';

/** 默认 DPI；与 engine 的默认值一致。 */
const DEFAULT_DPI = 96;
/** 单个文档最多注入的补充字体数，避免误选大量文件导致内存膨胀。 */
const MAX_SUPPLEMENTARY_FONTS = 8;
/** 内置示例在 public/samples 下的相对路径。 */
const SAMPLE_PATH = 'samples/hello.ofd';

/** 按 id 获取必需 DOM 元素；缺失时直接抛错，避免静默失效。 */
function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`页面缺少 #${id}`);
  return node as T;
}

const fileInput = element<HTMLInputElement>('file-input');
const dropZone = element<HTMLElement>('drop-zone');
const sampleButton = element<HTMLButtonElement>('sample-button');
const urlInput = element<HTMLInputElement>('url-input');
const urlButton = element<HTMLButtonElement>('url-button');
const dpiSelect = element<HTMLSelectElement>('dpi-select');
const prevButton = element<HTMLButtonElement>('prev-page');
const nextButton = element<HTMLButtonElement>('next-page');
const pageInput = element<HTMLInputElement>('page-input');
const pageTotal = element<HTMLElement>('page-total');
const renderButton = element<HTMLButtonElement>('render-button');
const cancelButton = element<HTMLButtonElement>('cancel-button');
const closeButton = element<HTMLButtonElement>('close-button');
const fontInput = element<HTMLInputElement>('font-input');
const fontClearButton = element<HTMLButtonElement>('font-clear');
const fontList = element<HTMLElement>('font-list');
const canvas = element<HTMLCanvasElement>('page-canvas');
const status = element<HTMLElement>('status');
const fileName = element<HTMLElement>('file-name');
const pageCount = element<HTMLElement>('page-count');
const pageIndicator = element<HTMLElement>('page-indicator');
const pageSize = element<HTMLElement>('page-size');
const viewportSize = element<HTMLElement>('viewport-size');
const renderTime = element<HTMLElement>('render-time');
const errorPanel = element<HTMLElement>('error-panel');
const errorCode = element<HTMLElement>('error-code');
const errorMessage = element<HTMLElement>('error-message');
const warningCount = element<HTMLElement>('warning-count');
const warningList = element<HTMLElement>('warning-list');
const clearWarningsButton = element<HTMLButtonElement>('clear-warnings');

/** 获取 2D 上下文；缺失时明确失败，避免后续空指针。 */
function require2dContext(target: HTMLCanvasElement): CanvasRenderingContext2D {
  const value = target.getContext('2d');
  if (!value) {
    status.textContent = '当前浏览器不支持 Canvas 2D';
    status.dataset.kind = 'error';
    throw new Error('当前浏览器不支持 Canvas 2D');
  }
  return value;
}

const context = require2dContext(canvas);

/** 当前文档；打开新文档前会关闭旧文档。 */
let documentHandle: OFDDocument | null = null;
/** 当前文档来源；补充字体变化后据此重载。 */
let currentSource: OFDSource | null = null;
/** 当前来源的显示名。 */
let currentLabel = '';
/** 当前页索引，从 0 开始。 */
let currentPage = 0;
/** 当前文档页数；0 表示未打开。 */
let totalPages = 0;
/** 正在进行的渲染任务；取消或翻页前先取消它。 */
let activeTask: RenderTask | null = null;
/** 打开代数；异步完成后据此丢弃过期结果。 */
let openGeneration = 0;
/** 渲染代数；异步完成后据此丢弃过期结果。 */
let renderToken = 0;
/** 已注入的补充字体。 */
const supplementaryFonts: FontInput[] = [];
/** warning 按 code 去重统计。 */
const warningStats = new Map<string, { count: number; samples: string[] }>();
/** warning 列表重绘是否已排队。 */
let warningRenderQueued = false;

/** 读取当前选择的 DPI；非法值回退默认值。 */
function currentDpi(): number {
  const value = Number(dpiSelect.value);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_DPI;
}

/** 更新状态栏文本与样式。 */
function setStatus(text: string, kind: 'info' | 'ok' | 'error' = 'info'): void {
  status.textContent = text;
  if (kind === 'info') delete status.dataset.kind;
  else status.dataset.kind = kind;
}

/** 显示错误面板；OFDError 展示 code，其他错误展示 ERROR。 */
function showError(error: unknown): void {
  const code = isOFDError(error) ? error.code : 'ERROR';
  const message = error instanceof Error ? error.message : String(error);
  errorCode.textContent = code;
  errorMessage.textContent = message;
  errorPanel.hidden = false;
  setStatus(`失败：${code}`, 'error');
}

/** 清空错误面板。 */
function clearError(): void {
  errorCode.textContent = '';
  errorMessage.textContent = '';
  errorPanel.hidden = true;
}

/** 判断错误是否为取消导致的 OFD_ABORTED。 */
function isAbortError(error: unknown): boolean {
  return isOFDError(error) && error.code === 'OFD_ABORTED';
}

/** 重置文档信息展示。 */
function resetInfo(): void {
  fileName.textContent = '-';
  fileName.title = '';
  pageCount.textContent = '-';
  pageIndicator.textContent = '-';
  pageSize.textContent = '-';
  viewportSize.textContent = '-';
  renderTime.textContent = '-';
  pageInput.value = '1';
  pageInput.disabled = true;
  pageTotal.textContent = '/ -';
  prevButton.disabled = true;
  nextButton.disabled = true;
  renderButton.disabled = true;
  cancelButton.disabled = true;
  closeButton.disabled = true;
}

/** 规范化 mm 尺寸显示。 */
function formatMm(width: number, height: number): string {
  return `${width.toFixed(2)} × ${height.toFixed(2)} mm`;
}

/** 更新页码控件与按钮可用状态。 */
function updatePager(): void {
  const valid = totalPages > 0;
  pageInput.disabled = !valid;
  pageInput.max = String(Math.max(1, totalPages));
  pageInput.value = String(valid ? currentPage + 1 : 1);
  pageTotal.textContent = `/ ${valid ? totalPages : '-'}`;
  pageIndicator.textContent = valid ? `${currentPage + 1} / ${totalPages}` : '-';
  prevButton.disabled = !valid || currentPage <= 0;
  nextButton.disabled = !valid || currentPage >= totalPages - 1;
  renderButton.disabled = !valid;
  closeButton.disabled = !valid;
}

/** 取消当前渲染并等待其 promise 落定，避免同 Canvas 任务堆积。 */
async function cancelActiveRender(): Promise<void> {
  const task = activeTask;
  activeTask = null;
  if (!task) return;
  task.cancel();
  await task.promise.catch(() => undefined);
}

/** 把 warning 按 code 聚合；保留最多 2 条消息样例。 */
function handleWarning(warning: OFDWarning): void {
  const entry = warningStats.get(warning.code) ?? { count: 0, samples: [] };
  entry.count += 1;
  if (entry.samples.length < 2) {
    const page = warning.pageIndex === undefined ? '' : `第 ${warning.pageIndex + 1} 页：`;
    entry.samples.push(`${page}${warning.message}`);
  }
  warningStats.set(warning.code, entry);
  scheduleWarningRender();
}

/** warning 面板合并到下一帧渲染，避免大量 warning 时频繁重排。 */
function scheduleWarningRender(): void {
  if (warningRenderQueued) return;
  warningRenderQueued = true;
  requestAnimationFrame(() => {
    warningRenderQueued = false;
    renderWarnings();
  });
}

/** 重绘 warning 面板。 */
function renderWarnings(): void {
  let total = 0;
  for (const entry of warningStats.values()) total += entry.count;
  warningCount.textContent = String(total);
  warningList.replaceChildren();
  if (warningStats.size === 0) {
    const empty = document.createElement('li');
    empty.className = 'muted';
    empty.textContent = '暂无 warning';
    warningList.append(empty);
    return;
  }
  for (const [code, entry] of [...warningStats.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const item = document.createElement('li');
    const title = document.createElement('div');
    const codeNode = document.createElement('code');
    codeNode.textContent = code;
    title.append(codeNode, document.createTextNode(` × ${entry.count}`));
    item.append(title);
    for (const sample of entry.samples) {
      const detail = document.createElement('div');
      detail.className = 'muted';
      detail.textContent = sample;
      item.append(detail);
    }
    warningList.append(item);
  }
}

/** 清空 warning 聚合。 */
function clearWarnings(): void {
  warningStats.clear();
  renderWarnings();
}

/** 重绘字体注入状态。 */
function renderFontState(): void {
  fontClearButton.disabled = supplementaryFonts.length === 0;
  if (supplementaryFonts.length === 0) {
    fontList.textContent = '未注入补充字体';
    return;
  }
  const names = supplementaryFonts.map((font) => font.family ?? '未命名字体');
  fontList.textContent = `已注入 ${names.length} 个：${names.join('、')}`;
}

/**
 * 打开一个 OFD 来源并渲染第一页。
 *
 * @param source 文档来源；File 走 blob、URL 走 url、内置示例走 blob。
 * @param label 文件显示名。
 */
async function openSource(source: OFDSource, label: string): Promise<void> {
  const generation = ++openGeneration;
  renderToken += 1;
  await cancelActiveRender();
  const previous = documentHandle;
  documentHandle = null;
  currentSource = source;
  currentLabel = label;
  if (previous) await previous.close().catch(() => undefined);

  resetInfo();
  clearError();
  clearWarnings();
  setStatus('正在打开文档…');
  fileInput.disabled = true;
  sampleButton.disabled = true;
  urlButton.disabled = true;

  try {
    const opened = await OFDDocument.open({
      source,
      onWarning: handleWarning,
      ...(supplementaryFonts.length > 0
        ? { supplementaryFonts: supplementaryFonts.map((font) => ({ ...font })) }
        : {}),
    });
    if (generation !== openGeneration) {
      await opened.close().catch(() => undefined);
      return;
    }
    documentHandle = opened;
    totalPages = opened.pageCount;
    currentPage = 0;
    fileName.textContent = label;
    fileName.title = source.kind === 'url' ? source.url : label;
    pageCount.textContent = String(totalPages);
    updatePager();
    cancelButton.disabled = false;
    await renderCurrentPage(generation);
  } catch (error) {
    if (generation === openGeneration && !isAbortError(error)) showError(error);
  } finally {
    if (generation === openGeneration) {
      fileInput.disabled = false;
      sampleButton.disabled = false;
      urlButton.disabled = false;
    }
  }
}

/**
 * 渲染当前页；会先取消同一 canvas 上未完成的任务。
 *
 * @param generation 打开代数；用于丢弃已关闭/已换文档的结果。
 */
async function renderCurrentPage(generation = openGeneration): Promise<void> {
  const handle = documentHandle;
  if (!handle) return;
  const token = ++renderToken;
  await cancelActiveRender();
  if (handle !== documentHandle || generation !== openGeneration) return;

  const dpi = currentDpi();
  setStatus(`正在渲染第 ${currentPage + 1} 页（${dpi} DPI）…`);

  let page: OFDPage;
  try {
    page = await handle.getPage(currentPage);
  } catch (error) {
    if (token === renderToken) {
      if (!isAbortError(error)) showError(error);
    }
    return;
  }
  if (token !== renderToken || handle !== documentHandle) return;

  const size = page.getSize();
  const viewport = page.getViewport({ dpi });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  pageSize.textContent = formatMm(size.width, size.height);
  viewportSize.textContent = `${canvas.width} × ${canvas.height} px @ ${dpi} DPI`;

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);

  const started = performance.now();
  cancelButton.disabled = false;
  const task = page.render({
    canvasContext: context,
    viewport,
  });
  activeTask = task;
  try {
    await task.promise;
    if (token !== renderToken) return;
    const elapsed = performance.now() - started;
    renderTime.textContent = `${elapsed.toFixed(1)} ms`;
    setStatus(`渲染完成 · 第 ${currentPage + 1} 页 · ${elapsed.toFixed(1)} ms`, 'ok');
    clearError();
  } catch (error) {
    if (token !== renderToken) return;
    if (isAbortError(error)) {
      setStatus('渲染已取消');
    } else {
      showError(error);
    }
  } finally {
    if (activeTask === task) activeTask = null;
    if (token === renderToken) cancelButton.disabled = true;
  }
}

/**
 * 切换页并渲染；越界时忽略。
 *
 * @param nextPage 目标页索引，从 0 开始。
 */
function goToPage(nextPage: number): void {
  if (!documentHandle || totalPages === 0) return;
  const clamped = Math.max(0, Math.min(totalPages - 1, nextPage));
  if (clamped === currentPage) {
    updatePager();
    return;
  }
  currentPage = clamped;
  updatePager();
  void renderCurrentPage();
}

/** 读取 File 列表中的第一个 OFD 并打开。 */
function openFile(file: File): void {
  if (!/\.ofd$/i.test(file.name)) {
    showError(new Error(`请选择 .ofd 文件：${file.name}`));
    return;
  }
  void openSource({ kind: 'blob', blob: file }, file.name);
}

/** 加载内置示例（用户显式点击，不自动播放）。 */
async function loadSample(): Promise<void> {
  try {
    setStatus('正在下载内置示例…');
    const response = await fetch(new URL(SAMPLE_PATH, document.baseURI));
    if (!response.ok) throw new Error(`内置示例下载失败：HTTP ${response.status}`);
    const blob = await response.blob();
    await openSource({ kind: 'blob', blob }, 'hello.ofd');
  } catch (error) {
    showError(error);
  }
}

/** 从 URL 输入加载；仅接受 http(s)。 */
async function loadUrl(): Promise<void> {
  const value = urlInput.value.trim();
  if (!value) {
    showError(new Error('请输入 OFD 的 URL'));
    return;
  }
  let url: URL;
  try {
    url = new URL(value, window.location.href);
  } catch {
    showError(new Error(`URL 非法：${value}`));
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    showError(new Error(`仅支持 http(s) URL：${url.protocol}`));
    return;
  }
  const name = decodeURIComponent(url.pathname.split('/').pop() || 'remote.ofd');
  await openSource({ kind: 'url', url: url.toString() }, name);
}

/** 重新打开当前来源，使补充字体生效。 */
async function reloadCurrent(): Promise<void> {
  if (!currentSource) {
    renderFontState();
    return;
  }
  await openSource(currentSource, currentLabel);
}

/** 读取选中的字体文件并注入；随后重载当前文档。 */
async function addFonts(files: File[]): Promise<void> {
  if (files.length === 0) return;
  const remaining = MAX_SUPPLEMENTARY_FONTS - supplementaryFonts.length;
  if (remaining <= 0) {
    showError(new Error(`最多注入 ${MAX_SUPPLEMENTARY_FONTS} 个补充字体`));
    return;
  }
  try {
    for (const file of files.slice(0, remaining)) {
      const data = await file.arrayBuffer();
      supplementaryFonts.push({
        data,
        family: file.name.replace(/\.(ttf|otf|ttc|otc)$/i, ''),
      });
    }
    renderFontState();
    await reloadCurrent();
  } catch (error) {
    showError(error);
  } finally {
    fontInput.value = '';
  }
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) openFile(file);
  fileInput.value = '';
});

dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('dragging');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragging');
  const file = event.dataTransfer?.files?.[0];
  if (file) openFile(file);
});

sampleButton.addEventListener('click', () => void loadSample());
urlButton.addEventListener('click', () => void loadUrl());
urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void loadUrl();
});

dpiSelect.addEventListener('change', () => void renderCurrentPage());
prevButton.addEventListener('click', () => goToPage(currentPage - 1));
nextButton.addEventListener('click', () => goToPage(currentPage + 1));
pageInput.addEventListener('change', () => {
  const value = Number(pageInput.value);
  if (!Number.isFinite(value)) {
    updatePager();
    return;
  }
  goToPage(Math.trunc(value) - 1);
});
renderButton.addEventListener('click', () => void renderCurrentPage());
cancelButton.addEventListener('click', () => {
  if (!activeTask) {
    setStatus('没有进行中的渲染');
    return;
  }
  setStatus('正在取消…');
  activeTask.cancel();
});
closeButton.addEventListener('click', () => {
  openGeneration += 1;
  renderToken += 1;
  void (async () => {
    await cancelActiveRender();
    const previous = documentHandle;
    documentHandle = null;
    totalPages = 0;
    currentSource = null;
    currentLabel = '';
    if (previous) await previous.close().catch(() => undefined);
    resetInfo();
    clearError();
    clearWarnings();
    context.setTransform(1, 0, 0, 1, 0, 0);
    canvas.width = 1;
    canvas.height = 1;
    setStatus('文档已关闭');
  })();
});

fontInput.addEventListener('change', () => {
  void addFonts(Array.from(fontInput.files ?? []));
});
fontClearButton.addEventListener('click', () => {
  supplementaryFonts.length = 0;
  renderFontState();
  void reloadCurrent();
});
clearWarningsButton.addEventListener('click', clearWarnings);

// 初始状态。
resetInfo();
renderFontState();
renderWarnings();
setStatus('等待加载 OFD 文件');