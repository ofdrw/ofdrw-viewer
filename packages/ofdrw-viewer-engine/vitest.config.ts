import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const entry = fileURLToPath(new URL('./src/index.ts', import.meta.url));

/**
 * 引擎测试配置。
 *
 * 测试根目录为仓库根，以同时覆盖：
 * - T1 架构 smoke：`test/smoke/`；
 * - 各开发任务单测：`packages/ofdrw-viewer-engine/test/<module>/`；
 * - QA 黄金图/回归：`packages/ofdrw-viewer-engine/test/golden|e2e|acceptance/`。
 *
 * 源码统一通过包名 `ofdrw-viewer-engine` 别名引入。
 */
export default defineConfig({
  root: repoRoot,
  resolve: {
    alias: {
      'ofdrw-viewer-engine': entry,
    },
  },
  test: {
    environment: 'node',
    include: [
      'test/**/*.test.ts',
      'packages/ofdrw-viewer-engine/test/**/*.test.ts',
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 性能门禁（test/performance）依赖独占 CPU；文件串行避免 --maxWorkers 并发造成假超时，
    // 不降低任何阈值，也不跳过真实性能用例。
    fileParallelism: false,
  },
  cacheDir: fileURLToPath(new URL('./node_modules/.vite', import.meta.url)),
});