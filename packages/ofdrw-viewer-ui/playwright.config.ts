import { defineConfig } from 'playwright/test';

/**
 * ofdrw-viewer-ui 真实浏览器验收配置。
 *
 * - 使用系统 Chrome（`channel: 'chrome'`），避免 E2E 依赖浏览器下载；
 * - Vite 只作为本地静态/Bare import 解析服务，不参与产品构建；
 * - 失败时保留 trace、截图、视频与控制台信息，产物写入 test/acceptance/artifacts。
 */
export default defineConfig({
  testDir: './test/e2e',
  outputDir: './test/acceptance/artifacts/playwright',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: './test/acceptance/artifacts/report', open: 'never' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:4179',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    acceptDownloads: true,
    launchOptions: {
      // 本机 headless Chrome 在默认 GPU 路径下不产生动画帧；关闭 GPU 与软件光栅化后 rAF 正常。
      args: ['--disable-gpu', '--disable-software-rasterizer'],
    },
  },
  webServer: {
    command: 'vite --config test/e2e/vite.config.mjs --port 4179 --strictPort',
    url: 'http://127.0.0.1:4179/packages/ofdrw-viewer-ui/test/e2e/index.html',
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGKILL', timeout: 500 },
  },
});
