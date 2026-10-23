import { useEffect, useState } from 'react';
import { OFDViewer } from '@ofdrw/ofdrw-viewer-ui/react';

/**
 * 页面是否通过 `?file=` / `?base64=` 提供来源。
 *
 * 有查询参数时不再自动加载内置样例、也不给 `source` prop，避免显式 source
 * 覆盖 URI 参数；没有参数时沿用原来的样例/本地文件流程。
 */
const hasQuerySource =
  typeof window !== 'undefined' &&
  (new URLSearchParams(window.location.search).has('file') ||
    new URLSearchParams(window.location.search).has('base64'));

/**
 * React 19 最小接入示例：挂载阅读器，打开内置样例、本地 OFD 文件或 URI 参数。
 *
 * @returns {JSX.Element} 页面组件。
 */
export default function App() {
  /** 文档来源；ArrayBuffer 引用变化会触发阅读器打开新文档。 */
  const [source, setSource] = useState(null);
  /** 加载失败时的提示。 */
  const [error, setError] = useState('');

  // 首次加载内置样例；URI 参数模式由阅读器自己解析。
  useEffect(() => {
    if (hasQuerySource) return;
    fetch('samples/doc1File.ofd')
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then(setSource)
      .catch((reason) => setError(`样例加载失败：${reason.message}`));
  }, []);

  /**
   * 读取本地选择的 OFD 文件并替换当前文档。
   *
   * @param {import('react').ChangeEvent<HTMLInputElement>} event 文件输入框事件。
   */
  async function openFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError('');
    try {
      setSource(await file.arrayBuffer());
    } catch (reason) {
      setError(`文件读取失败：${reason.message}`);
    }
  }

  return (
    <div className="app">
      <header>
        <strong>OFD 阅读器</strong>
        <label className="open">
          打开 OFD
          <input type="file" accept=".ofd,application/ofd" onChange={openFile} />
        </label>
      </header>

      {error && <p className="error">{error}</p>}

      <main>
        {hasQuerySource ? (
          <OFDViewer className="viewer" />
        ) : source ? (
          <OFDViewer className="viewer" source={source} />
        ) : (
          <p className="loading">正在加载样例…</p>
        )}
      </main>
    </div>
  );
}