/**
 * OFD 单页渲染示例（原生 ES Module，无构建）。
 *
 * 主流程：读取文件字节 → 关闭旧文档 → OFDDocument.open → getPage →
 * getViewport → page.render。引擎只负责把页面内容画到 Canvas；
 * 画布尺寸、清屏与页面背景由本示例和 CSS 负责。
 *
 * 引擎通过同目录的 `global.js` 以 IIFE 形式预置，暴露在
 * `globalThis.OFDRWViewer`，无需 import map 或打包器。
 */
const engine = globalThis.OFDRWViewer;
if (!engine) {
  throw new Error('未加载 global.js：请确认 examples/engine-h5/global.js 可访问');
}
/** 引擎公共 API；由 global.js 的 IIFE 产物挂载。 */
const { OFDDocument, isOFDError } = engine;

/** warning 列表最多展示的条数，避免异常文档生成过多 DOM 节点。 */
const MAX_WARNING_ITEMS = 100;

/** 默认样例：11 页、内嵌字体，页面加载后自动打开。 */
const DEFAULT_SAMPLE = { url: 'samples/doc1File.ofd', name: 'doc1File.ofd' };

/** 文件选择输入框。 */
const fileInput = document.querySelector('#file-input');
/** “选择 OFD 文件”的 label；input 被禁用时同步禁用它的样式。 */
const fileLabel = document.querySelector('#file-label');
/** 所有带 data-sample 的内置样例按钮。 */
const sampleButtons = Array.from(document.querySelectorAll('[data-sample]'));
/** 上一页按钮。 */
const prevButton = document.querySelector('#prev-button');
/** 下一页按钮。 */
const nextButton = document.querySelector('#next-button');
/** 页码输入框。 */
const pageInput = document.querySelector('#page-input');
/** 页码总量提示，例如 “/ 11 页”。 */
const pageTotal = document.querySelector('#page-total');
/** 跳转按钮。 */
const goButton = document.querySelector('#go-button');
/** DPI 选择框。 */
const dpiSelect = document.querySelector('#dpi-select');
/** 状态说明文字。 */
const statusNote = document.querySelector('#status-note');
/** 状态区：文件名。 */
const statusFile = document.querySelector('#status-file');
/** 状态区：页数。 */
const statusPages = document.querySelector('#status-pages');
/** 状态区：当前页。 */
const statusCurrent = document.querySelector('#status-current');
/** 状态区：画布像素尺寸。 */
const statusCanvas = document.querySelector('#status-canvas');
/** 状态区：渲染耗时。 */
const statusTime = document.querySelector('#status-time');
/** 状态区：输出 DPI。 */
const statusDpi = document.querySelector('#status-dpi');
/** 错误面板。 */
const errorPanel = document.querySelector('#error-panel');
/** 错误类型：OFDError 或非 OFD 错误。 */
const errorKind = document.querySelector('#error-kind');
/** 错误码（OFDError）或错误名（普通异常）。 */
const errorCode = document.querySelector('#error-code');
/** 错误描述。 */
const errorMessage = document.querySelector('#error-message');
/** warning 总数徽标。 */
const warningCountEl = document.querySelector('#warning-count');
/** warning 为空时的提示。 */
const warningEmpty = document.querySelector('#warning-empty');
/** warning 列表容器。 */
const warningList = document.querySelector('#warning-list');
/** 主渲染画布。 */
const canvas = document.querySelector('#ofd-canvas');
/** 画布为空时的占位提示。 */
const stageEmpty = document.querySelector('#stage-empty');

/** 当前文档句柄；未打开时为 null。 */
let doc = null;
/** 当前显示页的索引，从 0 开始。 */
let currentIndex = 0;
/** 当前文档在状态区展示的文件名。 */
let currentName = '';
/** 输出精度，单位：DPI（每英寸点数）。 */
let dpi = 96;
/** 是否正在执行打开/渲染等异步操作；为 true 时禁用相关控件。 */
let busy = false;
/** 操作序号：每次新操作自增，用于丢弃过期的异步结果。 */
let opToken = 0;
/** 页面是否正在卸载；卸载后不再应用异步结果或更新界面。 */
let disposed = false;
/** 最近一次成功渲染的画布宽度，单位：设备像素 px。 */
let renderedWidth = 0;
/** 最近一次成功渲染的画布高度，单位：设备像素 px。 */
let renderedHeight = 0;
/** 最近一次整页渲染耗时，单位：毫秒 ms；null 表示尚未渲染。 */
let renderTimeMs = null;
/** 最近一次渲染是否成功；决定状态区是否展示画布尺寸。 */
let rendered = false;
/** 当前文档累计收到的 warning 数（不受展示上限限制）。 */
let warningCount = 0;

/**
 * 更新状态说明文字。
 *
 * @param {string} text 要展示的说明。
 * @returns {void}
 */
function setNote(text) {
  statusNote.textContent = text;
}

/**
 * 刷新状态区的文件名、页数、当前页、画布尺寸、耗时与 DPI。
 *
 * @returns {void}
 */
function updateStatus() {
  const hasDoc = doc !== null;
  statusFile.textContent = currentName || '—';
  statusPages.textContent = hasDoc ? String(doc.pageCount) : '—';
  statusCurrent.textContent = hasDoc ? `${currentIndex + 1} / ${doc.pageCount}` : '—';
  statusCanvas.textContent = rendered ? `${renderedWidth} × ${renderedHeight} px` : '—';
  statusTime.textContent = renderTimeMs === null ? '—' : `${renderTimeMs} ms`;
  statusDpi.textContent = String(dpi);
  pageTotal.textContent = `/ ${hasDoc ? doc.pageCount : '—'} 页`;
  pageInput.value = hasDoc ? String(currentIndex + 1) : '';
}

/**
 * 根据忙碌状态与当前文档刷新所有控件的禁用态和页码上限。
 *
 * @returns {void}
 */
function updateControls() {
  const hasDoc = doc !== null;
  const pageCount = hasDoc ? doc.pageCount : 0;

  prevButton.disabled = busy || !hasDoc || currentIndex <= 0;
  nextButton.disabled = busy || !hasDoc || currentIndex >= pageCount - 1;
  pageInput.disabled = busy || !hasDoc;
  pageInput.max = String(Math.max(pageCount, 1));
  goButton.disabled = busy || !hasDoc;
  dpiSelect.disabled = busy;
  fileInput.disabled = busy;
  fileLabel.classList.toggle('is-disabled', busy);
  fileLabel.setAttribute('aria-disabled', String(busy));

  for (const button of sampleButtons) {
    button.disabled = busy;
  }
}

/**
 * 隐藏错误面板并清空内容。
 *
 * @returns {void}
 */
function clearError() {
  errorPanel.hidden = true;
  errorKind.textContent = '—';
  errorCode.textContent = '—';
  errorMessage.textContent = '—';
}

/**
 * 展示错误；对引擎错误显示 code，对普通异常显示错误名。
 *
 * @param {unknown} error 捕获到的异常。
 * @returns {void}
 */
function showError(error) {
  const engineError = isOFDError(error);
  const name = error instanceof Error ? error.name : 'UNKNOWN';
  let message = error instanceof Error ? error.message : String(error);

  if (engineError && error.cause instanceof Error) {
    message += `（cause: ${error.cause.message}）`;
  }

  errorKind.textContent = engineError ? 'OFDError' : '非 OFD 错误';
  errorCode.textContent = engineError ? error.code : name;
  errorMessage.textContent = message;
  errorPanel.hidden = false;
}

/**
 * 追加一条引擎 warning；超过展示上限后只继续计数。
 *
 * @param {{ code?: string, message?: string, pageIndex?: number, objectId?: string, resourceId?: string }} warning
 *   引擎通过 onWarning 上报的 warning。
 * @returns {void}
 */
function appendWarning(warning) {
  warningCount += 1;
  warningCountEl.textContent = String(warningCount);
  warningEmpty.hidden = true;

  if (warningCount > MAX_WARNING_ITEMS) {
    if (warningCount === MAX_WARNING_ITEMS + 1) {
      const more = document.createElement('li');
      more.className = 'warning-list__more';
      more.textContent = `warning 过多，仅展示前 ${MAX_WARNING_ITEMS} 条；总数仍在统计。`;
      warningList.append(more);
    }
    return;
  }

  const item = document.createElement('li');
  item.className = 'warning-item';

  const line = document.createElement('div');
  line.className = 'warning-item__line';

  const code = document.createElement('code');
  code.className = 'warning-item__code';
  code.textContent = warning.code ?? 'W_UNKNOWN';

  const meta = document.createElement('span');
  meta.className = 'warning-item__meta';
  const metaParts = [];
  if (Number.isInteger(warning.pageIndex)) {
    metaParts.push(`第 ${warning.pageIndex + 1} 页`);
  }
  if (typeof warning.objectId === 'string') {
    metaParts.push(`对象 ${warning.objectId}`);
  } else if (typeof warning.resourceId === 'string') {
    metaParts.push(`资源 ${warning.resourceId}`);
  }
  meta.textContent = metaParts.join(' · ');

  const message = document.createElement('p');
  message.className = 'warning-item__message';
  message.textContent = warning.message ?? '（无描述）';

  line.append(code, meta);
  item.append(line, message);
  warningList.append(item);
}

/**
 * 清空 warning 列表与计数，用于切换到新文档时重置展示。
 *
 * @returns {void}
 */
function clearWarnings() {
  warningCount = 0;
  warningCountEl.textContent = '0';
  warningList.replaceChildren();
  warningEmpty.hidden = false;
}

/**
 * 隐藏并清空主画布，重置与已渲染页面相关的状态。
 *
 * @returns {void}
 */
function resetCanvasView() {
  canvas.hidden = true;
  canvas.width = 0;
  canvas.height = 0;
  stageEmpty.hidden = false;
  rendered = false;
  renderedWidth = 0;
  renderedHeight = 0;
  renderTimeMs = null;
}

/**
 * 关闭当前文档并清空画布与状态；没有文档时只清空界面。
 * close() 本身幂等且不抛错，这里仍捕获异常以便界面提示。
 *
 * @returns {Promise<void>} 关闭结束。
 */
async function closeCurrentDocument() {
  const closingDoc = doc;
  doc = null;
  currentName = '';
  currentIndex = 0;
  resetCanvasView();
  updateStatus();
  updateControls();

  if (!closingDoc) return;

  try {
    await closingDoc.close();
  } catch (error) {
    showError(error);
  }
}

/**
 * 以独占方式执行一次异步操作：进入时禁用控件并清除旧错误，结束后恢复。
 *
 * @param {(token: number) => Promise<void>} action 实际操作；token 用于判断结果是否已过期。
 * @returns {Promise<void>} 操作结束；失败时错误已在界面展示。
 */
async function runExclusive(action) {
  const token = ++opToken;
  busy = true;
  clearError();
  updateControls();

  try {
    await action(token);
  } catch (error) {
    if (token === opToken && !disposed) {
      showError(error);
      setNote('操作失败');
    }
  } finally {
    if (token === opToken) {
      busy = false;
      updateControls();
    }
  }
}

/**
 * 把指定页渲染到主画布并更新状态。
 * 调用方必须已经通过 runExclusive 设置 busy 和 token。
 *
 * @param {number} index 目标页索引，从 0 开始。
 * @param {number} token 当前操作序号；异步返回后若已变化则放弃更新界面。
 * @returns {Promise<void>} 渲染完成；失败时抛错，由 runExclusive 统一展示。
 */
async function renderPageAt(index, token) {
  const activeDoc = doc;
  if (!activeDoc) return;

  const pageCount = activeDoc.pageCount;
  if (pageCount <= 0) throw new Error('文档不包含任何页面');

  const targetIndex = Math.min(Math.max(index, 0), pageCount - 1);
  setNote(`正在渲染第 ${targetIndex + 1} 页…`);

  /** 渲染起点，单位：毫秒 ms；从取页开始计到绘制完成。 */
  const startedAt = performance.now();
  const page = await activeDoc.getPage(targetIndex);
  if (token !== opToken || doc !== activeDoc || disposed) return;

  const viewport = page.getViewport({ dpi });
  // 重置 width/height 会清空画布；引擎不清屏、不填背景，白色纸面由 CSS 提供。
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);

  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前环境不支持 Canvas 2D 上下文');

  const task = page.render({ canvasContext: context, viewport });
  await task.promise;
  if (token !== opToken || doc !== activeDoc || disposed) return;

  renderTimeMs = Math.round(performance.now() - startedAt);
  currentIndex = targetIndex;
  rendered = true;
  renderedWidth = canvas.width;
  renderedHeight = canvas.height;
  canvas.hidden = false;
  stageEmpty.hidden = true;
  setNote('就绪');
  updateStatus();
  updateControls();
}

/**
 * 渲染指定页；没有文档或正在忙碌时忽略本次调用。
 *
 * @param {number} index 页索引，从 0 开始。
 * @returns {Promise<void>} 渲染结束。
 */
async function renderPage(index) {
  if (!doc || busy) return;
  await runExclusive((token) => renderPageAt(index, token));
}

/**
 * 以相对当前页面的路径读取内置样例。
 *
 * @param {string} url 相对当前页面的样例地址。
 * @returns {Promise<ArrayBuffer>} OFD 文件字节。
 */
async function fetchSample(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`加载样例失败：${url}（HTTP ${response.status}）`);
  }
  return response.arrayBuffer();
}

/**
 * 打开一个 OFD 文档：先读取字节，再关闭旧文档，最后渲染第 1 页。
 * 读取失败时保留旧文档；读取成功后才关闭旧文档。
 *
 * @param {string} name 状态区展示的文件名。
 * @param {() => Promise<ArrayBuffer>} loadData 返回 OFD 字节的加载函数。
 * @returns {Promise<void>} 打开并渲染结束；错误由 runExclusive 统一展示。
 */
async function openDocument(name, loadData) {
  await runExclusive(async (token) => {
    setNote(`正在读取 ${name}…`);
    const data = await loadData();
    if (token !== opToken || disposed) return;

    setNote('正在关闭旧文档…');
    await closeCurrentDocument();
    if (token !== opToken || disposed) return;

    clearWarnings();
    setNote(`正在打开 ${name}…`);
    const opened = await OFDDocument.open({
      source: { kind: 'arraybuffer', data },
      onWarning: appendWarning,
    });

    if (disposed) {
      await opened.close();
      return;
    }
    if (opened.pageCount <= 0) {
      await opened.close();
      throw new Error(`${name} 不包含任何页面`);
    }

    doc = opened;
    currentName = name;
    currentIndex = 0;
    rendered = false;
    renderedWidth = 0;
    renderedHeight = 0;
    renderTimeMs = null;
    canvas.width = 0;
    canvas.height = 0;
    canvas.hidden = true;
    stageEmpty.hidden = false;
    updateStatus();
    updateControls();

    await renderPageAt(0, token);
  });
}

/**
 * 读取页码输入框并跳转；非法值恢复为当前页，越界值夹到有效范围。
 *
 * @returns {void}
 */
function goToPage() {
  if (!doc || busy) return;

  const parsed = Number.parseInt(pageInput.value, 10);
  if (!Number.isFinite(parsed)) {
    updateStatus();
    return;
  }

  const target = Math.min(Math.max(parsed, 1), doc.pageCount) - 1;
  if (target === currentIndex) {
    updateStatus();
    return;
  }

  void renderPage(target);
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file || busy) return;

  // 清空 input，保证再次选择同一个文件也能触发 change。
  fileInput.value = '';
  void openDocument(file.name, () => file.arrayBuffer());
});

for (const button of sampleButtons) {
  button.addEventListener('click', () => {
    if (busy) return;

    const url = button.dataset.sample;
    const name = button.dataset.name || url;
    if (!url || !name) return;

    void openDocument(name, () => fetchSample(url));
  });
}

prevButton.addEventListener('click', () => {
  if (!doc || busy) return;
  void renderPage(currentIndex - 1);
});

nextButton.addEventListener('click', () => {
  if (!doc || busy) return;
  void renderPage(currentIndex + 1);
});

goButton.addEventListener('click', goToPage);

pageInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  goToPage();
});

dpiSelect.addEventListener('change', () => {
  const nextDpi = Number.parseInt(dpiSelect.value, 10);
  if (![96, 144, 216].includes(nextDpi)) return;

  dpi = nextDpi;
  updateStatus();
  if (doc && !busy) {
    void renderPage(currentIndex);
  }
});

// 页面卸载（含进入往返缓存）时关闭文档，释放 ZIP/字体/图片资源。
window.addEventListener('pagehide', () => {
  disposed = true;
  opToken += 1;
  busy = false;
  void closeCurrentDocument();
});

dpiSelect.value = String(dpi);
updateStatus();
updateControls();
// 默认打开内嵌字体的样例；失败时错误面板会显示原因。
void openDocument(DEFAULT_SAMPLE.name, () => fetchSample(DEFAULT_SAMPLE.url));