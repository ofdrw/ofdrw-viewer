import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));
const entry = fileURLToPath(new URL('./src/index.ts', import.meta.url));

/**
 * crypto 包测试配置。
 *
 * 测试根目录为包根，源码统一通过包名 `@ofdrw/ofdrw-viewer-crypto` 别名引入，
 * 保证测试覆盖的是公共 barrel，而不是绕过公共入口直接访问内部模块。
 */
export default defineConfig({
  root: packageRoot,
  resolve: {
    alias: {
      '@ofdrw/ofdrw-viewer-crypto': entry,
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  cacheDir: fileURLToPath(new URL('./node_modules/.vite', import.meta.url)),
});