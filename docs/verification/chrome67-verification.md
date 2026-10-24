# Chrome 67 兼容性独立验证报告（t6）

> 说明：文内截图证据为验证时的临时产物（`test/.artifacts/t6/`），已随临时文件清理，未入库；需要时可按第 4 节命令重跑。
> F1 的修复已另行提交（`fix(ui): 修正 Chrome 67 打印命名页探测假阳性`），尚未经第二轮独立复验。

- 验证人：verifier（独立验证，不改实现）
- 验证基线：本团队提交 `3a4b27b`（feat(compat): 补齐 Chrome 67 适配的构建、卡口与文档）；验证时工作区 HEAD 为 `ce8d781`，另含并发任务的未提交改动（CLI、engine api/model、UI 缩放等，非本团队）
- 目标内核：Chromium **67.0.3396.0**（snapshot r550416，`.cache/chrome67/r550416/chrome-linux/chrome`）
- 现代内核：Google Chrome **145.0.7632.116**
- 主机：16 vCPU，验证时 load average 约 1.1–3.0；Node 26 / pnpm / vitest 5.0.5
- 结论：**不通过（FAIL）**。存在 1 个阻塞项 F1（混合尺寸打印在 Chrome 67 上不会降级），移动端旧内核渲染只得到部分证据；其余构建、测试、卡口与桌面端旧内核冒烟通过。

## 1. 验收结果

| # | 验收项 | 结果 | 摘要 |
| --- | --- | --- | --- |
| 1 | `pnpm build` / typecheck | 通过 | exit 0 / exit 0 |
| 2 | engine / crypto / ui 测试 | 通过 | engine 963/963、crypto 456/456、ui 477/477（ui 首轮 476/477 为时序抖动，单文件复跑与全量复跑均通过） |
| 3 | `check-compat` + 故意违规样例 | 通过 | 41 文件、188 处已覆盖 API、195 处 BigInt；样例 exit 1、临时文件已删 |
| 4 | ESM/CJS/CDN 语法扫描 | 通过 | 41 个产物 esbuild `--target=chrome67` 全部成功 |
| 5 | CSS 兼容审计 | 通过（有口径偏差 R1） | 30 条 flex gap 均保留 `gap` 但有 40 条属性回退规则；`:is/:where/inset` 0；10 处 `min()` 均有前置回退 |
| 6 | 现代 Chrome 冒烟（UI + site，1440×900 / 390×844） | 部分通过 | 首轮 26/26 通过；末次复跑受工作区产物被并发删除影响未完成（见 R3） |
| 7 | Chromium 67 冒烟（1440×900 / 390×844） | 部分通过 | 桌面 10/10；移动端最新 5/8（结构、compat、翻页、缩放通过；首屏 `rendered` 与文本层未出现） |
| 8 | 公共 API 对比 | 通过 | 基线 183 个导出全部仍可导入；工作区入口仅 engine 新增副作用 import + 并发 contentFilter 导出 |
| 9 | README 徽章（新口径）+ 宿主接入章节 | 通过 | 三处纯图片徽章、写明 Chrome 67、无链接；`docs/chrome67-compat.md` §9 存在 |
| 10 | 混合尺寸打印降级 | **不通过** | **F1**：Chrome 67 的 `CSS.supports('page', ...)` 返回 true，但命名页尺寸不生效，降级分支永不触发 |

附加：compat 子路径装配 13/13 通过；UI 主入口在 jsdom 中 7/7 通过；打印单测 17/17 通过（但 mock 了 `CSS.supports`，未覆盖真实内核，见 F1）。

## 2. 阻塞问题 F1：混合尺寸打印在 Chrome 67 上不会降级

**现象**：Chrome 67 对 `CSS.supports('page', 'ofd-size-0')` 返回 **true**（`auto`、`foo` 也返回 true，`1` 返回 false），而实际打印时命名页尺寸被忽略。

**真实内核证据**：

1. Chromium 67 CDP 读取：`pageSupport=true`（桌面与窄屏两次运行一致）。
2. 最小页面（`@page { size:auto }` + `@page small { size:100mm 100mm }` + `@page large { size:200mm 300mm }`，两个 `page:` 命名的块）用 `Page.printToPDF({ preferCSSPageSize: true })`：
   - Chromium 67：2 页 MediaBox 均为 `0 0 612 792`（Letter，命名尺寸未应用）。
   - Chrome 145：`0 0 282.95999 282.95999`、`0 0 567.12 850.07996`（100mm、200×300mm 正确应用）。
3. 代码路径：`packages/ofdrw-viewer-ui/src/print/print-document.ts:237` 的 `supportsNamedPages()` 仅用 `CSS.supports('page', 'ofd-size-0')`；`:265` 的 `buildPrintCss()` 在其为 true 时生成命名页规则并**不**生成 `object-fit: contain` 降级样式。
4. 单测 `test/unit/print/print-service.test.ts:356-402` 通过 `vi.spyOn(window.CSS, 'supports').mockReturnValue(false)` 强制走降级分支，因此测试全绿但无法发现真实 Chrome 67 的误判。

**影响**：混合尺寸文档在 Chrome 67 打印时走“命名页”分支，命名页规则被忽略，所有页落到默认 Letter 纸型；同时缺少等比适配，存在裁切/变形风险。验收项 10 不成立。

**修复要求（需实现方处理）**：
- 不要仅依赖 `CSS.supports('page', ...)` 判断命名页能力。可采用可靠的版本/能力门控（例如 Chrome 主版本 ≥85 才启用命名页），或在混合尺寸时始终使用“最大页尺寸统一纸型 + `object-fit: contain`”降级；并在真实 Chromium 67 上增加打印回归用例（不能只 mock）。
- 同步更正 `docs/chrome67-compat.md` 附录 A-8（当前写“未实测”，实测为 true 但行为不支持）与 §9.7（仍写徽章链接到文档，与本次“纯图片无链接”口径不一致）。

## 3. 其他风险与口径偏差

- **R1 flex gap 字面口径偏差**：验收文字为“flex 容器无 gap”，实际 CSS 仍保留 30 条 `gap`（28 条 UI + 2 条 site），由 `[data-ofd-flex-gap='none']` 下的 margin 回退覆盖（40 条回退规则）。真实 Chromium 67 读到的回退边距为：桌面工具栏 4px、窄屏 2px，`data-ofd-flex-gap=none` 存在。这是 t1 已批准的“保留 gap + 属性回退”方案，但与字面“无 gap”不一致，按非阻塞偏差记录。
- **R2 移动端旧内核渲染**：最新快照 390×844 为 5/8：`pages=10`、`data-viewport=narrow`、compat 全部安装、页码切到 2、缩放 375→396.84 均通过；但 `data-page-state=rendered` 在 30s 内始终为 0，截图接近空白（4972 B），文本层 0 span。13:08 曾在旧 `site-dist` 上取得 10/10；13:10 重建站点后复跑不再通过。无法确认是产品缺陷还是旧 headless 在该 bundle/窄屏下的环境问题，**未验证为通过**。
- **R3 工作区并发干扰**：验证过程中 `site-dist/` 与 `docs/verification/` 被外部过程删除，导致若干次冒烟出现 404/空白；最终改用 `test/.artifacts/t6/site-snapshot` 快照 + 4320 端口完成桌面证据。该现象非本团队改动，但说明当前工作区不适合并行构建/冒烟。
- **R4 性能非阻塞观测**：`text-perf` 单次通过：open 42.6ms、firstDraw 757.8ms、turnDraw 681.1ms、secondDraw 351.2ms、heapDelta 45.8MiB（阈值 800/1000/600ms、150MiB），主机 load 1.12。CI 已排除 performance；t2 的 A/B（删 compat 后 992–1192ms）作为对照记录，不纳入门禁。
- **R5 BigInt 非阻塞**：产物中 195 处 BigInt 字面量，Chrome 67 原生支持；`check-compat` 默认仅统计不阻塞。UI/site 无 BigInt 阻塞项。
- **R6 公共 API 归类**：工作区 `packages/ofdrw-viewer-engine/src/index.ts` 相对 HEAD 新增 `import './compat'`（本团队，无根导出）及 `KNOWN_ANNOTATION_TYPES`、`AnnotationType`、`DrawLayerOptions`、`KnownAnnotationType`、`PageContentFilter`（并发 contentFilter 任务，不计入本次验收）。UI 的 `exportOfd` 已在基线提交中，不是本次工作区新增。基线 183 个导出（engine 144、crypto 13、ui 26）全部仍可 `tsc` 解析到。

## 4. 关键命令与证据

| 命令 | 退出码 | 证据 |
| --- | --- | --- |
| `pnpm build` | 0 | 三包 dist、`compat.js/.cjs/.d.ts` 生成 |
| `pnpm -r --if-present run typecheck` | 0 | 无类型错误 |
| engine vitest（963 tests / 120 files） | 0 | `test/.artifacts/t6/engine-test.log`（注：日志混入 1 个 `test/.artifacts/...showcase.e2e`，与 t2 CI 口径 963/963 计数一致） |
| `pnpm -C packages/ofdrw-viewer-crypto test` | 0 | 44 files / 456 tests |
| `pnpm -C packages/ofdrw-viewer-ui test` | 0（复跑） | 60 files / 477 tests；首轮 476/477 为 `loading-events` 时序抖动 |
| `node scripts/check-compat.mjs` | 0 | 4 集合、41 JS、188 处覆盖（globalThis 85、Blob 36、allSettled 18、flatMap 10、queueMicrotask 3、replaceChildren 36）、195 BigInt |
| `node scripts/check-compat.mjs --require-dist --json` | 0 | 同上 |
| `node scripts/check-compat.mjs --scan <bad.js>` | 1 | `syntax/optional-chaining`、`syntax/nullish-coalescing`、`api/global-this`、`api/replace-children`，共 4 处阻塞；临时文件已删除 |
| esbuild 41 个 `.js/.cjs`（`--target=chrome67`） | 0 | 41 扫描、0 失败 |
| `node test/.artifacts/t6/compat-load.mjs` | 0 | 13/13；engine/crypto/UI `./compat` 可加载，marker/API 生效 |
| `node test/.artifacts/t6/ui-entry-jsdom.mjs` | 0 | 7/7；主入口自动安装 replaceChildren 等 |
| `node test/.artifacts/t6/css-postcss.mjs` | 0 | 30 flex gap 全有回退、40 回退规则、`:is/:where/inset` 0、10 `min()` 全有前置回退 |
| `pnpm -C packages/ofdrw-viewer-ui exec vitest run test/unit/print/print-service.test.ts` | 0 | 17/17；降级用例 mock `CSS.supports=false` |
| `pnpm -C packages/ofdrw-viewer-engine exec vitest run test/performance/text-perf.test.ts` | 0 | firstDraw 757.8ms（非阻塞） |
| Chrome 67 桌面冒烟（CDP，1440×900，快照站点） | 0 | 10/10：打开 10 页、compat、flex 回退 4px、翻页到 2、缩放 1425→1587.39、文本 67 span、无页面错误 |
| Chrome 67 移动冒烟（CDP，390×844，快照站点） | 1 | 5/8：compat、flex 回退 2px、翻页、缩放通过；rendered=0/截图空白/文本层 0 |
| printToPDF 命名页探针（Chromium 67 / Chrome 145） | 0 | 67：两页均 612×792；145：282.96×282.96、567.12×850.08 |
| 徽章检查脚本 | 0 | 根 README:3、engine README:8、ui README:3 均为 `![Chrome >= 67](...)`，无外层链接 |
| `tsc` 导入基线全部导出（分三包） | 0 | engine 144 / crypto 13 / ui 26 全部可解析 |

## 5. 未验证 / 无法验证项

- Chrome 67 上混合尺寸打印的**真实纸张与裁切**：无 GUI 打印预览；仅用 `printToPDF` 证明命名页尺寸不生效（F1），实际纸型选择未测。
- 移动端 Chromium 67 首屏渲染与文本层：最新快照未通过（R2），不能写成通过。
- Safari/Firefox、Electron/Tauri、微信小程序：不在本次范围，未验证。
- React/Vue 适配器在 Chrome 67 运行：未跑，仅静态扫描。
- Chrome 67 的 `-webkit-backdrop-filter` 视觉降级：探针 `backdropSupport=false`，仅记录，未做像素对比。

## 6. 截图

`docs/verification/screenshots/`：
- `chrome67-1440x900-open.png`、`chrome67-1440x900-page2-zoom.png`、`chrome67-1440x900-selection.png`：Chromium 67.0.3396.0 桌面端。
- `modern-*.png`：Chrome 145 的 UI harness 与 site，1440×900 / 390×844（首轮 26/26 冒烟截图；末次复跑受 R3 影响未完成）。
- 移动端 Chromium 67 截图因空白未保留，避免把未渲染画面当作通过证据。

## 7. 清理

- 违规样例、临时 Chrome profile、调试脚本已删除；Chrome 进程由脚本 `SIGKILL` 回收。
- 验证用快照站点位于 `test/.artifacts/t6/site-snapshot`，4320 端口服务在报告提交后关闭。
- 未执行 `git push`，未修改 `packages/`、`site/`、`scripts/` 实现代码。