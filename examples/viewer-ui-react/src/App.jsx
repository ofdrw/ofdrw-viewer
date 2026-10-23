import { useCallback, useEffect, useState } from 'react';
import { OFDViewer } from '@ofdrw/ofdrw-viewer-ui/react';

/**
 * 内置样例清单。
 *
 * 文件位于 `public/samples/`，Vite 开发/构建时通过 `/samples/<文件名>` 提供。
 * 两份样例均内嵌字体：doc1File.ofd 共 11 页，dense-text-perf.ofd 共 2 页。
 *
 * @type {ReadonlyArray<{ path: string, label: string }>}
 */
const SAMPLES = [
  { path: 'samples/doc1File.ofd', label: 'doc1File.ofd' },
  { path: 'samples/dense-text-perf.ofd', label: 'dense-text-perf.ofd' },
];

/** 默认样例；页面加载后自动打开。 */
const DEFAULT_SAMPLE = SAMPLES[0];

/**
 * 把内置样例读取为 ArrayBuffer。
 *
 * 读取字节而不是直接传 URL 字符串，使“重新打开样例”每次都会产生新的 source
 * 引用；React 适配器据此再次调用核心 `open()`。URL 基于 `BASE_URL` 拼接，便于
 * 在配置了 `base` 的子路径部署中同样定位到 `public/samples/`。
 *
 * @param {{ path: string, label: string }} sample 样例描述。
 * @returns {Promise<ArrayBuffer>} OFD 文件字节内容。
 * @throws {Error} HTTP 状态非 2xx 时抛出。
 */
async function fetchSample(sample) {
  const response = await fetch(`${import.meta.env.BASE_URL}${sample.path}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.arrayBuffer();
}

/**
 * React 19 接入示例页面。
 *
 * 顶部工具条负责选择本地文件、重新打开内置样例，并展示文档名、页码和错误；
 * 主体把 `<OFDViewer>` 放在 `flex: 1` 的容器中，占满剩余高度。阅读器自带的
 * 工具栏、侧栏、缩放、查找等功能保持默认开启。
 *
 * @returns {JSX.Element} 页面组件。
 */
export default function App() {
  /** 当前文档来源；ArrayBuffer 引用变化会触发适配器调用 `open()`。 */
  const [source, setSource] = useState(null);
  /** 当前文档名称，仅用于工具条展示。 */
  const [documentName, setDocumentName] = useState(DEFAULT_SAMPLE.label);
  /** 当前页码，1-based。 */
  const [pageNumber, setPageNumber] = useState(1);
  /** 当前文档总页数，单位页。 */
  const [pageCount, setPageCount] = useState(0);
  /** 阅读器首次打开是否完成。 */
  const [ready, setReady] = useState(false);
  /** 打开/加载失败信息。 */
  const [errorText, setErrorText] = useState('');
  /** 阅读器诊断 warning。 */
  const [warningText, setWarningText] = useState('');

  /**
   * 打开指定内置样例。
   *
   * @param {{ path: string, label: string }} sample 样例描述。
   * @returns {Promise<void>} 读取完成并提交 source 后 resolve。
   */
  const openSample = useCallback(async (sample) => {
    setErrorText('');
    setWarningText('');
    try {
      const buffer = await fetchSample(sample);
      setDocumentName(sample.label);
      setPageNumber(1);
      setPageCount(0);
      setSource(buffer);
    } catch (error) {
      setErrorText(`样例加载失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  // 页面加载后自动打开默认样例。
  useEffect(() => {
    void openSample(DEFAULT_SAMPLE);
  }, [openSample]);

  /**
   * 读取用户选择的本地 OFD 文件并替换当前文档。
   *
   * @param {import('react').ChangeEvent<HTMLInputElement>} event 文件选择框 change 事件。
   * @returns {Promise<void>} 文件读取完成后 resolve。
   */
  async function handleFileChange(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = ''; // 清空后再次选择同一文件也能触发 change。
    if (!file) return;

    setErrorText('');
    setWarningText('');
    try {
      const buffer = await file.arrayBuffer();
      setDocumentName(file.name);
      setPageNumber(1);
      setPageCount(0);
      setSource(buffer);
    } catch (error) {
      setErrorText(`读取文件失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 同步阅读器状态快照中的页码与总页数。
   *
   * 工具栏触发的程序化跳页只更新内部视图状态，不一定再次发出 `pagechanging`，
   * 因此外层状态栏同时监听 `statechange`；React 对相同值的 setState 会自动跳过。
   *
   * @param {import('@ofdrw/ofdrw-viewer-ui').ViewerState} state 阅读器状态快照。
   * @returns {void}
   */
  function handleStateChange(state) {
    setPageNumber(state.view.pageNumber);
    setPageCount(state.document.pageCount);
  }

  // 错误优先展示；没有错误时再展示 warning 或就绪状态。
  let notice;
  if (errorText) {
    notice = (
      <span className="status status-error" role="alert">
        {errorText}
      </span>
    );
  } else if (warningText) {
    notice = (
      <span className="status status-warning" role="status">
        {warningText}
      </span>
    );
  } else {
    notice = (
      <span className={`status${ready ? ' status-ready' : ''}`} role="status">
        {ready ? '阅读器已就绪' : '阅读器初始化中…'}
      </span>
    );
  }

  return (
    <div className="app">
      <header className="toolbar">
        <label className="file-picker">
          打开 OFD 文件
          <input type="file" accept=".ofd,application/ofd" onChange={handleFileChange} />
        </label>
        <button
          type="button"
          className="button"
          onClick={() => void openSample(DEFAULT_SAMPLE)}
        >
          重新打开样例
        </button>
        <button
          type="button"
          className="button button-quiet"
          onClick={() => void openSample(SAMPLES[1])}
        >
          打开 dense-text-perf.ofd
        </button>
        <span className="document-name" title={documentName}>
          {documentName}
        </span>
        <span className="page-indicator">
          第 {pageNumber} / {pageCount || '-'} 页
        </span>
        {notice}
      </header>

      <main className="viewer-area">
        {source ? (
          <OFDViewer
            source={source}
            onReady={() => setReady(true)}
            onDocumentOpen={({ pageCount: count }) => setPageCount(count)}
            onPageChange={({ pageNumber: nextPage }) => setPageNumber(nextPage)}
            onStateChange={handleStateChange}
            onWarning={({ code, message }) => setWarningText(`${code}：${message}`)}
            onError={({ code, message }) => setErrorText(`${code}：${message}`)}
          />
        ) : (
          <div className="placeholder">
            {errorText ? '样例未能加载，点击“重新打开样例”重试。' : '正在读取样例…'}
          </div>
        )}
      </main>
    </div>
  );
}