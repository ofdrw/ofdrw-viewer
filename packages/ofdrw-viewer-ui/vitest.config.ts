import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const engineEntry = fileURLToPath(
  new URL('../ofdrw-viewer-engine/src/index.ts', import.meta.url),
);
const packageEntry = fileURLToPath(new URL('./src/index.ts', import.meta.url));

/**
 * `ofdrw-viewer-ui` 测试配置。
 *
 * 测试根为仓库根，统一覆盖：
 * - 包内单测/集成测试：`packages/ofdrw-viewer-ui/test/`；
 * - 跨包集成测试：根目录 `test/ui/`。
 *
 * Playwright E2E（`test/e2e/`）不走 vitest，由独立脚本执行。
 * 源码统一通过包名别名引入，避免测试依赖尚未构建的 `dist`。
 */
export default defineConfig({
  root: repoRoot,
  resolve: {
    alias: {
      '@ofdrw/ofdrw-viewer-engine': engineEntry,
      '@ofdrw/ofdrw-viewer-ui': packageEntry,
    },
  },
  test: {
    environment: 'jsdom',
    include: [
      'packages/ofdrw-viewer-ui/test/**/*.test.ts',
      'packages/ofdrw-viewer-ui/test/**/*.test.tsx',
      'test/ui/**/*.test.ts',
      'test/ui/**/*.test.tsx',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'packages/ofdrw-viewer-ui/test/e2e/**',
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    restoreMocks: true,
  },
});