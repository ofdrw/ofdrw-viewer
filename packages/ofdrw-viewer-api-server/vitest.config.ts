import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));

/**
 * api-server 包测试配置。
 *
 * 测试根为包根，收集 test 目录下的 `*.test.ts`；源码通过相对路径引入，
 * 不依赖构建产物。
 */
export default defineConfig({
  root: packageRoot,
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  cacheDir: fileURLToPath(new URL('./node_modules/.vite', import.meta.url)),
});