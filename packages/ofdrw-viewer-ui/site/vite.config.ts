import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * 在线演示站构建配置。
 *
 * 站点入口位于本目录，直接引用 `../src` 源码，保证部署产物与仓库最新代码一致。
 * `base` 通过 `BASE_PATH` 环境变量注入：GitHub Pages 项目站点需要
 * `/仓库名/` 前缀，用户站点或本地预览使用 `/`。
 */
const siteRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: siteRoot,
  base: process.env.BASE_PATH || '/',
  build: {
    outDir: fileURLToPath(new URL('../site-dist', import.meta.url)),
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
  },
  server: {
    port: 5183,
    strictPort: true,
  },
  preview: {
    port: 5183,
    strictPort: true,
  },
});