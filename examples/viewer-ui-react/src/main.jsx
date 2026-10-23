/**
 * React 示例入口。
 *
 * 阅读器主题样式由宿主显式引入；根容器高度由 index.html 中的全局样式设为 100%。
 */
import { createRoot } from 'react-dom/client';
import '@ofdrw/ofdrw-viewer-ui/style.css';
import App from './App';

const container = document.getElementById('root');
if (!container) throw new Error('未找到 #root 挂载节点');

// 不使用 StrictMode：避免开发环境 effect 执行两次导致样例重复读取。
createRoot(container).render(<App />);