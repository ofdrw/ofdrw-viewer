import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite 配置：启用 React 插件，并固定开发/预览端口为 5182。
 *
 * `strictPort: true` 确保端口被占用时直接失败，而不是静默换端口，避免验证时
 * 打开错误的页面。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5182,
    strictPort: true,
  },
  preview: {
    port: 5182,
    strictPort: true,
  },
});