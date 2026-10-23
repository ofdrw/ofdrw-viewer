/**
 * Vue 示例入口。
 *
 * 阅读器主题样式由宿主显式引入；根容器高度由 index.html 中的全局样式设为 100%。
 */
import { createApp } from 'vue';
import '@ofdrw/ofdrw-viewer-ui/style.css';
import App from './App.vue';

createApp(App).mount('#app');