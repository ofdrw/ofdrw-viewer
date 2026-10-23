/**
 * React 19 示例入口。
 *
 * 主题样式必须由宿主显式引入；随后挂载示例页面。
 */
import { createRoot } from 'react-dom/client';
import '@ofdrw/ofdrw-viewer-ui/style.css';
import './style.css';
import App from './App';

const container = document.getElementById('root');
if (!container) throw new Error('未找到 #root 挂载节点');

// 不使用 StrictMode：避免开发环境重复执行 effect 导致样例被读取/打开两次。
createRoot(container).render(<App />);