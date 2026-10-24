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
- `test/acceptance/fixtures/thousand.ofd`、`signature-missing-value.ofd`、`broken-page.ofd`：由脚本生成，已被 `.gitignore` 忽略。
- `test/acceptance/fixtures/external-font.ofd`、`external-font-backup.ofd`：`ofd_pdf_match/draw_param_ref.ofd`（5 页中文发票）与 `AddWatermarkAnnot.ofd`（2 页《拿来主义》）的原样副本。两者只声明 `FontName`/`FamilyName`（宋体/楷体/Courier New），**没有 FontFile**，用于 `fonts.spec.ts` 验证 UI 字体配置：不配置时文字缺失并报 `W_FONT_MISSING`，配置后文字可见；`site/public/samples/*.ofd` 内嵌 SimSun，不能用于外部字体验证。

重新生成派生夹具（通常由 Playwright `globalSetup` 自动执行）：

```bash
node test/acceptance/generate-fixtures.mjs
```

### 字体夹具（`test/.fixtures/fonts/`，gitignore）

`fonts.spec.ts` 用 `page.route` 把线上 CDN 形态的字体 URL 映射到本地副本，保证离线可重复；本地兜底字体则直接由 Vite 静态服务提供。首次运行前手动下载（体积大，不提交）：

```bash
mkdir -p test/.fixtures/fonts
cd test/.fixtures/fonts
# fontsource（SIL OFL 1.1）；与站点 FONT_CDN/FONT_VERSION 同版本
for pkg in noto-serif-sc noto-sans-sc; do
  for slice in chinese-simplified-400 latin-400; do
    curl -O "https://cdn.jsdelivr.net/npm/@fontsource/$pkg@5.3.1/files/$pkg-$slice-normal.woff2"
  done
done
# 文泉驿微米黑 0.2.0-beta（Apache-2.0）；与站点 public/fonts/wqy-microhei.ttc 同源文件
curl -L -o wqy.tar.gz https://sourceforge.net/projects/wqy/files/wqy-microhei/0.2.0-beta/wqy-microhei-0.2.0-beta.tar.gz/download
tar xzf wqy.tar.gz && mv wqy-microhei/wqy-microhei.ttc . && rm -rf wqy-microhei wqy.tar.gz
```

字体文件缺失时 `fonts.spec.ts` 全部用例 `skip` 并提示，不会伪造通过。

## 字体端到端验证（`test/e2e/fonts.spec.ts`）

夹具 `external-font.ofd` 只声明字体名、没有 FontFile；用例覆盖：

| 用例 | 断言（实测数据） |
| --- | --- |
| 未配置字体 | `W_FONT_MISSING` ≥3 次、无字体请求；第 2 页 canvas 覆盖像素 < 2 万、DOM 节点 < 300 |
| 配置字体 | 覆盖像素 > 4 万、DOM 节点 > 400、无 `W_FONT_*`；每个来源只请求一次 |
| 前后对比 | 同一页覆盖像素翻倍、DOM 节点 4 倍以上 |
| CDN 中断 | 5 页文档 ready、只有字体 warning、只有字体请求失败 |
| Web Component | `font-default` 变更后实例重建，覆盖像素翻倍，元素仍在 DOM |
| 站点同构配置 | 本地文泉驿 + 3 个 CDN 补充 + 别名：5 个来源各请求一次，文字可见 |
| 远端全部中断 | 本地兜底仍显示文字，4 个远端来源各报一次 `W_FONT_MISSING` |

注意：`page.route` 的路由正则必须精确到字体路径——页面自身的导航请求 URL 里也带着字体 URL（`fonts` 查询参数），宽泛的域名正则会把 index.html 导航一起拦下，页面根本不加载。字体 URL 需带查询串，否则 Vite 对重复 URL 返回 304 会绕过路由。

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
