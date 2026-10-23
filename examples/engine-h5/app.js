/**
 * OFD 单页渲染示例：打开文档、上一页/下一页，把当前页画到 Canvas。
 *
 * 引擎由同目录的 ofdrw-viewer-engine.min.js 以 IIFE 形式预置，暴露在
 * globalThis.OFDRWViewer。
 */
const { OFDDocument } = globalThis.OFDRWViewer ?? {};
if (!OFDDocument) {
  throw new Error('未加载引擎：请确认 examples/engine-h5/ofdrw-viewer-engine.min.js 可访问');
}

/** 页面元素。 */
const canvas = document.querySelector('#canvas');
const ctx = canvas.getContext('2d');
const fileInput = document.querySelector('#file-input');
const prevButton = document.querySelector('#prev');
const nextButton = document.querySelector('#next');
const pageLabel = document.querySelector('#page-label');
const hint = document.querySelector('#hint');

/** 当前文档；未打开时为 null。 */
let doc = null;
/** 当前页索引，从 0 开始。 */
let pageIndex = 0;
/** 是否正在打开或渲染，防止连续点击产生并发。 */
let busy = false;

/**
 * 显示提示文字。
 *
 * @param {string} text 提示内容；空字符串表示隐藏。
 * @returns {void}
 */
function setHint(text) {
  hint.textContent = text;
}

/**
 * 按当前 pageIndex 渲染一页。
 *
 * 引擎只负责画内容；画布尺寸、清屏和背景由示例自己处理。
 *
 * @returns {Promise<void>} 渲染完成或失败后 resolve。
 */
async function showPage() {
  if (!doc || busy) return;
  busy = true;
  setHint('渲染中…');
  prevButton.disabled = true;
  nextButton.disabled = true;

  try {
    const page = await doc.getPage(pageIndex);
    const viewport = page.getViewport({ dpi: 96 });

    // 先改尺寸再取 context，顺带清空上一页内容。
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: ctx, viewport }).promise;

    pageLabel.textContent = `${pageIndex + 1} / ${doc.pageCount}`;
    prevButton.disabled = pageIndex === 0;
    nextButton.disabled = pageIndex + 1 >= doc.pageCount;
    setHint('');
  } catch (error) {
    setHint(`渲染失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    busy = false;
  }
}

/**
 * 打开新的 OFD 字节内容，成功后关闭旧文档并显示第一页。
 *
 * @param {ArrayBuffer} data OFD 文件字节。
 * @returns {Promise<void>} 打开并渲染完成后 resolve。
 */
async function open(data) {
  if (busy) return;
  busy = true;
  setHint('正在打开…');

  try {
    const nextDoc = await OFDDocument.open({ source: { kind: 'arraybuffer', data } });
    await doc?.close();
    doc = nextDoc;
    pageIndex = 0;
    busy = false;
    await showPage();
  } catch (error) {
    busy = false;
    setHint(`打开失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 加载内置样例，首次打开和刷新页面时使用。 */
async function openSample() {
  const response = await fetch('samples/doc1File.ofd');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  await open(await response.arrayBuffer());
}

prevButton.addEventListener('click', () => {
  if (pageIndex > 0) {
    pageIndex -= 1;
    void showPage();
  }
});

nextButton.addEventListener('click', () => {
  if (doc && pageIndex + 1 < doc.pageCount) {
    pageIndex += 1;
    void showPage();
  }
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  // 清空后再次选择同一个文件也能触发 change。
  fileInput.value = '';
  await open(await file.arrayBuffer());
});

// 页面加载后自动打开 11 页的内置样例。
openSample().catch((error) => {
  setHint(`样例加载失败：${error instanceof Error ? error.message : String(error)}`);
});

// 关闭页面时释放文档资源。
window.addEventListener('pagehide', () => {
  void doc?.close();
  doc = null;
});