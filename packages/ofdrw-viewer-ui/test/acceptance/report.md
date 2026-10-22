# ofdrw-viewer-ui P0/MVP 验收报告（t11）

日期：2026-10-22
HEAD：9dee355 `fix(ui): 修复查找输入占位符对比度`（基于该提交构建 dist）
测试入口：`packages/ofdrw-viewer-ui/playwright.config.ts`
浏览器：系统 Chrome，headless；桌面 1440×900，移动 390×844，断点 1024/768/480。

## 命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm -C packages/ofdrw-viewer-ui build` | exit 0 |
| `pnpm -C packages/ofdrw-viewer-ui typecheck` | exit 0 |
| `pnpm -C packages/ofdrw-viewer-ui exec playwright test` | 25 passed，约 1.3 min（全量，含 axe） |

覆盖范围：真实 OFD 打开（桌面/移动/容器嵌入）、连续滚动、页码跳转、缩放重渲染、旋转、缩略图/大纲/书签、查找/选择复制、打印预览 DOM、单页 JPEG 与多页 ZIP、真实签章/缺失签名值降级、features 隐藏/禁用/依赖级联/动态切换、1000 页性能、axe 与键盘。

## 缺陷与修复

| 严重度 | 问题 | 状态 | 证据 |
| --- | --- | --- | --- |
| P0 | 用户滚动不更新页码/不渲染后续页（`viewer.ts` 无 scroll 监听） | 已修复 `407a69f`，滚动 E2E pass | `viewer.spec.ts` 连续滚动 |
| P0 | 小数页顶被浏览器截断导致 `goToPage(3/5)` 错一页 | 已修复 `005aa70`，书签/跳页 E2E pass | `navigation.spec.ts`、`layout.spec.ts` |
| P1 | findbar 初始可见并遮挡工具栏，签名/打印/导出点击被拦截 | 已修复 `03d5222`，初始隐藏与 Ctrl+F 打开 pass | `findbar.spec.ts`、`signature.spec.ts` |
| P2（serious a11y） | `.ofd-findbar__count` 无 role 却设置 `aria-label`，axe `aria-prohibited-attr` | 已修复 `ac955e4` | `a11y.spec.ts`，`artifacts/logs/a11y-final.log` |
| P2（serious a11y） | `.ofd-findbar__input` 占位符对比度 1.66:1，axe `color-contrast` | 已修复 `9dee355`，axe 全绿 | `a11y.spec.ts`，`artifacts/logs/a11y-final2.log` |

a11y 扫描结果（最终）：core / sidebar / findbar / 签章对话框均 0 个 serious/critical。

## 性能（1000 页）

来自 `artifacts/performance.json`（同一构建，headless Chromium）：

- 页数 1000，页壳 1000，首屏仅 2 个 canvas。
- viewer 打开 ~6.2–8.0 s，首屏渲染 ~6.3–8.2 s。
- `goToPage(500)` 状态更新 ~3 ms。
- 全文档查找 1000 处 ~23.8–26.0 s（无严格阈值，记录为瓶颈）。
- 1000 页缩略图仅渲染 14 个 canvas（窗口化生效），JS 堆约 20–21 MB → 45–62 MB。

## 已知告警/限制

- `W_FONT_MISSING`：helloworld/z/SESV4 缺 `SimSun/宋体`，属夹具资源缺失；`W_TEXT_LAYER_LIMIT`：dense-text 第 2 页文本节点上限；`W_BAD_NUMBER`：Page5 缺 `PublicRes.xml`。三者均不导致 console/page error。
- 无头环境不验证系统打印对话框与全屏 API 的真实交互；打印通过 stub `window.print` 验证 DOM/`afterprint`/清理，导出通过真实 download 事件验证字节/ZIP。
- 引擎首次整包探测会主动 abort 一次 GET，测试将 `ERR_ABORTED` 视为预期；实际内容由 Range 206 分段读取。
- Playwright 依赖已写入包 `devDependencies`（`@playwright/test`）；`globalSetup` 自动生成派生夹具，干净检出执行 `pnpm install` 后可直接运行。


## 复审 R2 修复（t21）

| 评审项 | 状态 | 证据 |
| --- | --- | --- |
| F2 打印/导出选项对话框 | 已修复 | `src/ui/index.ts`；打印/导出按钮打开对话框，支持范围/全部页、DPI、质量、背景、旋转、格式；`output.spec.ts` 工具栏点击/取消，`ui-integration.test.ts` 字段覆盖 |
| F3 getSignatures 守卫 | 已修复 | `viewer.ts` 入口 `assertFeature('signatures')`；`features.spec.ts` 断言同步抛 `OFD_FEATURE_DISABLED(feature=signatures)`，`focusSignature` 同样拒绝 |
| F4 公共 API | 已补/延期记录 | 新增 `getCurrentPage`、`getFindState`、`focusSignature`、`showDialog`/`closeDialog`；`goToDestination` 在 README 标注 P1 延期与替代方式 |
| F5 Playwright/夹具 | 已修复 | `@playwright/test` 入 devDependencies；`playwright.config.ts` globalSetup 自动生成夹具；删除派生夹具后 E2E 仍通过 |
| F7 全屏回退 | 已修复 | 原生 API 缺失/失败时 `position:fixed` 沉浸式回退并保持状态；`viewer.test.ts` 覆盖进入/退出与 warning |
| F8 features 矩阵 | 部分 | features E2E 参数化覆盖 18 键；React 18/视觉/读屏未执行，风险见下节 |

## 复审 R2 未覆盖风险（t21）

- **性能目标**：1000 页派生夹具（约 0.8MB）实测打开约 6.2s、全篇查找约 23.8s，
  仍高于设计 §12.6 的 2s/5s；50–200MB 夹具未生成。当前 E2E 的 30s/60s 仅为防严重
  回归上限，不能视为设计目标达成，需设计负责人书面豁免或在后续迭代优化抽取/分片。
- **手势缩放**：Ctrl/Command+滚轮、双指捏合、双击缩放未实现（工具栏/API 可用），
  需在设计/验收范围标注或后续补齐。
- **测试矩阵**：本轮未运行 React 18 双版本矩阵与关键界面视觉回归/读屏抽查；
  features E2E 已扩展到 18 个键的 API/状态，但未逐项覆盖全部控件与快捷键。
