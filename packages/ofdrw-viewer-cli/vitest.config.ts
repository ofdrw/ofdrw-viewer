import { defineConfig } from 'vitest/config';

/**
 * CLI 单元测试配置。
 *
 * 测试根为本包目录，只收集 test 目录下的 `*.test.ts`；
 * 源码通过相对路径 import，不依赖打包产物。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
  cacheDir: 'node_modules/.vite',
});