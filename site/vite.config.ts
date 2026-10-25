import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * 在线演示站构建配置。
 *
 * 站点入口位于本目录，直接引用 `packages/ofdrw-viewer-ui/src` 源码，保证部署产物与仓库最新代码一致。
 * `base` 通过 `BASE_PATH` 环境变量注入：GitHub Pages 项目站点需要
 * `/仓库名/` 前缀，用户站点或本地预览使用 `/`。
 * 构建目标为 Chrome 67：Vite 会在 renderChunk 阶段对最终 chunk 跑 esbuild 降级，
 * 从而同时覆盖 UI 源码、engine/crypto 的 dist 与 external 依赖。
 */
const siteRoot = fileURLToPath(new URL('.', import.meta.url));
/** 仓库根目录；仅在本地开发时用于提供 `ofd_pdf_match/` 下的真实样本。 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  root: siteRoot,
  base: process.env.BASE_PATH || '/',
  build: {
    outDir: fileURLToPath(new URL('../site-dist', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome67',
    sourcemap: false,
  },
  server: {
    // 默认 5183；端口被占用时可用 `PORT=<端口> pnpm dev` 临时改用其它端口。
    port: Number(process.env.PORT) || 5183,
    strictPort: true,
    // 本地开发直接打开仓库内的真实 OFD 样本（如 ofd_pdf_match/拿来主义_page6.ofd）；
    // 只放宽到本机回环地址，构建产物不包含这些文件。
    fs: { allow: [siteRoot, repoRoot] },
  },
  preview: {
    port: 5183,
    strictPort: true,
  },
});