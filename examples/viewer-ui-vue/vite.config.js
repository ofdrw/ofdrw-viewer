import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * 示例工程的 Vite 配置。
 *
 * 开发与预览端口固定为 5181，并开启 strictPort，避免端口占用时静默换端口导致
 * 访问地址与文档不一致。
 */
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5181,
    strictPort: true,
  },
  preview: {
    port: 5181,
    strictPort: true,
  },
});