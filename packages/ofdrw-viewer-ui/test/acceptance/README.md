# ofdrw-viewer-ui 验收测试

本目录承载 P0/MVP 的 Playwright 端到端、性能与可访问性验收，测试对象是 `dist/` 构建产物和真实 OFD 夹具，不使用业务 mock。

## 运行

```bash
# 仓库根目录
pnpm -C packages/ofdrw-viewer-ui build
pnpm -C packages/ofdrw-viewer-ui exec playwright test
```

Playwright 配置见包根 `playwright.config.ts`，测试页为 `test/e2e/index.html`，Vite 仅作为本地静态服务与裸模块解析器；OFD 夹具由 `test/e2e/vite.config.mjs` 中的 Range 中间件按字节分段返回，以贴近引擎的 URL 读取路径。

## 夹具

`test/e2e/support.ts` 使用仓库现有真实文件：

- `ofd_pdf_match/helloworld.ofd`：1 页，缺字体，仅做打开冒烟。
- `ofd_pdf_match/dense-text-perf.ofd`：2 页密集文本，用于滚动/查找/复制。
- `ofd_pdf_match/z.ofd`：4 页 + 大纲。
- `ofd_pdf_match/Page5.ofd`：5 页 + 书签（该夹具缺 `PublicRes.xml`，引擎会给出 `W_BAD_NUMBER` 警告，不影响页数）。
- `ofd_pdf_match/SESV4SignDoc.ofd`：1 页真实 V4 签章。
- `test/acceptance/fixtures/thousand.ofd`、`signature-missing-value.ofd`：由脚本生成，已被 `.gitignore` 忽略。

重新生成派生夹具（通常由 Playwright `globalSetup` 自动执行）：

```bash
node test/acceptance/generate-fixtures.mjs
```

## 环境前提

- 本机 Chrome（当前配置 `channel: 'chrome'`），无浏览器下载依赖。
- Playwright 运行器由包 `devDependencies` 的 `@playwright/test` 提供；`playwright.config.ts` 的 `globalSetup` 会自动生成 `thousand.ofd` 与 `signature-missing-value.ofd`，干净检出无需手工预生成夹具。首次运行仍需 `pnpm install` 与系统 Chrome（配置使用 `channel: 'chrome'`）。
- 无头 Chrome 需要 `--disable-gpu --disable-software-rasterizer`，否则 rAF 不触发；该参数已写入配置。
- ffmpeg 二进制缺失时 `video: 'off'`，失败仍保留 screenshot/trace/console 日志。
- 1320/桌面主视口 1440×900；移动 390×844；另测 1024/768/480 断点与容器宽度驱动。

## 产物

- `test/acceptance/artifacts/performance.json`：1000 页打开、跳页、缩放、查找、缩略图与堆内存采样。
- `test/acceptance/artifacts/logs/`：失败用例控制台日志。
- `test/acceptance/artifacts/playwright/`：Playwright trace、截图与 HTML 报告。
- `test/acceptance/report.md`：本轮验收结论与缺陷清单。
