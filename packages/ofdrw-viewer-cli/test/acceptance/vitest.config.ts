import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 图片 CLI 黑盒验收测试配置。
 *
 * 只收集 test/acceptance 目录下的 acceptance 测试文件，因此默认 `pnpm test`
 * 不会运行这些较慢的真实进程与 SEA 用例。
 */
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    environment: 'node',
    include: ['test/acceptance/**/*.acceptance.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // SEA 构建耗时较长，且用例会复用同一构建产物，串行执行更稳定。
    fileParallelism: false,
  },
  cacheDir: 'node_modules/.vite',
});