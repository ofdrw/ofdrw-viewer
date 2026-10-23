/**
 * 示例入口。
 *
 * 主题样式由宿主显式引入，必须在应用样式之前加载；阅读器根容器需要确定高度，
 * 具体布局见 `style.css` 与 `App.vue`。
 */
import { createApp } from 'vue';
import '@ofdrw/ofdrw-viewer-ui/style.css';
import './style.css';
import App from './App.vue';

createApp(App).mount('#app');