import { fileURLToPath } from 'node:url';

/**
 * Vite 配置：直接别名到 engine 源码，避免依赖尚未 link 的 workspace 包。
 *
 * - 端口默认 5178，可用环境变量 `WEB_PORT` 覆盖；
 * - `base: './'` 让 `vite preview` 或任意静态服务器在根路径/子路径都能打开；
 * - dev server 只监听 127.0.0.1，测试结束由调用方关闭。
 */

/** 仓库根目录；engine 源码位于其 packages/ 下。 */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
/** engine 公共入口源码。 */
const engineEntry = fileURLToPath(
  new URL('../../packages/ofdrw-viewer-engine/src/index.ts', import.meta.url),
);
/** 默认端口；可用 WEB_PORT 覆盖，非法值回退 5178。 */
const port = Number(process.env.WEB_PORT) || 5178;

/** @type {import('vite').UserConfig} */
export default {
  base: './',
  resolve: {
    alias: {
      '@ofdrw/ofdrw-viewer-engine': engineEntry,
    },
  },
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    fs: {
      // engine 源码与 workspace 依赖位于 examples/web 之外，显式允许仓库根。
      allow: [repoRoot],
    },
  },
  preview: {
    host: '127.0.0.1',
    port,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
};