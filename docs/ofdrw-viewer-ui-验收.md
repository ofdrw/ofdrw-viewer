# ofdrw-viewer-ui P0/MVP 最终验收报告

- 验收日期：2026-10-23
- 验收对象：`@ofdrw/ofdrw-viewer-ui` 0.1.0
- 验收 HEAD：`2382820` `fix(ui): 修复输出对话框提交与全屏退出`
- 结论：**通过（MVP 门禁）**。P0 功能、构建、单元/集成、真实浏览器 E2E 与 axe 均通过；性能目标与少数测试矩阵项按 P1 延期，见“已知限制与延期”。
- 说明：`packages/ofdrw-viewer-ui/test/acceptance/report.md` 是 t11 阶段历史快照（HEAD 9dee355）；本报告是最终验收依据，已按当前 HEAD 的事实更新性能、手势与延期项。

## 1. 验收环境

| 项目 | 值 |
| --- | --- |
| Node.js | v26.10.0 |
| pnpm | 11.24.0 |
| TypeScript | 5.9.3（包 devDependencies） |
| Vitest | 5.0.5 |
| Playwright | 1.64.1（`@playwright/test`，包 devDependencies） |
| 浏览器 | 系统 Google Chrome 145.0.7632.116，headless |
| 视口 | 桌面 1440×900；移动 390×844；断点 1024/768/480；容器宽度 600 |
| 测试夹具 | 仓库 `ofd_pdf_match` 真实 OFD；派生 1000 页 `thousand.ofd`（0.8MB）与缺失签名值夹具由 globalSetup 生成 |

## 2. 命令与结果

以下命令均在仓库根目录执行，时间 2026-10-23：

| 命令 | 结果 |
| --- | --- |
| `pnpm -C packages/ofdrw-viewer-ui typecheck` | exit 0，`tsc -p tsconfig.json --noEmit` 无错误 |
| `pnpm -C packages/ofdrw-viewer-ui test` | exit 0，**38 test files / 254 tests passed** |
| `pnpm -C packages/ofdrw-viewer-ui build` | exit 0，tsup ESM/CJS/DTS 全部成功；产出 `dist/index.*`、`react.*`、`vue.*`、`element.*`、`style.css` |
| `pnpm -C packages/ofdrw-viewer-ui exec playwright test` | exit 0，**33 passed / 0 failed**，约 3.6 min |

补充证据：

- `test/acceptance/artifacts/playwright/.last-run.json`：`{"status":"passed","failedTests":[]}`
- `test/acceptance/artifacts/report/index.html`：Playwright HTML 报告
- `test/acceptance/artifacts/performance.json`：最新 1000 页指标
- `test/acceptance/artifacts/logs/`：历史定向运行与失败诊断日志
- 构建产物：`packages/ofdrw-viewer-ui/dist/`（index.js 353B、index.cjs 1.9K、index.d.ts 5.6K、style.css 33K）

## 3. MVP 清单逐项验收

| 能力 | 结论 | 证据 |
| --- | --- | --- |
| 打开本地文件/URL、打开失败处理 | 通过 | `open.spec.ts`（桌面/移动）、`test/integration/core.test.ts`；source 支持 File/Blob/ArrayBuffer/Uint8Array/URL/`{url,headers}` |
| 连续滚动、当前页同步、下一页渲染 | 通过 | `viewer.spec.ts` 连续滚动；`407a69f` 修复 |
| 页码跳转、缩放、旋转、全屏 | 通过 | `viewer.spec.ts` 跳页/缩放/旋转；`a11y.spec.ts` 全屏 fallback Escape；Ctrl/Command+滚轮、双指捏合、双击缩放见 `reading.spec.ts` |
| 缩略图、大纲、书签 | 通过 | `navigation.spec.ts`、`test/integration/navigation.test.ts`；千页仅渲染窗口内 14 个缩略图 canvas |
| 查找、选区与复制 | 通过 | `viewer.spec.ts` 查找/选择复制；`findbar.spec.ts` 初始隐藏与 Ctrl+F；`test/integration/text.test.ts` |
| 打印（当前页/全部页/自定义范围、DPI、背景、旋转） | 通过 | `output.spec.ts` 打印 DOM/@page/清理；选项对话框含 Enter 提交、取消不输出 |
| 单页/多页图片导出（PNG/JPEG/WebP、ZIP） | 通过 | `output.spec.ts` JPEG 字节与 ZIP 条目；导出对话框覆盖格式/质量/背景/旋转；API `exportImage`/`exportImages` |
| 签章列表、覆盖层、详情（不验签） | 通过 | `signature.spec.ts` 真实 V4、缺失 SignedValue 降级；`test/integration/signature.test.ts` |
| features 开关（18 键）、依赖级联、API 门控 | 通过 | `features.spec.ts` 18 键参数化、隐藏/禁用/动态恢复、textLayer→find/selection、getSignatures/focusSignature 守卫 |
| 1000 页虚拟滚动与窗口化 | 通过 | `performance.spec.ts`：1000 页壳、首屏 2 canvas、跳页 3ms、缩略图 14 canvas |
| Web Component / React / Vue 薄适配 | 通过 | `test/unit/wrappers/*`、`test/integration/wrappers.test.tsx`；三入口独立构建 |
| 包 exports 与子路径 | 通过 | package.json：`.`、`./react`、`./vue`、`./element`、`./component`、`./style.css`、`./package.json`；ESM/CJS/types 均可解析 |
| 移动视口与断点 | 通过 | `open.spec.ts` 390×844；`layout.spec.ts` 1024/768/480、容器宽度、抽屉/遮罩/焦点陷阱 |

## 4. 1000 页性能（2026-10-23 本次运行）

来源：`test/acceptance/artifacts/performance.json`（headless Chrome，同一构建）。

| 指标 | 实测 | §12.6 目标 | 结论 |
| --- | --- | --- | --- |
| 打开（含 1000 页壳与首屏） | 5590 ms（本次）；t20 为 5107 ms；历史 4.8–6.2s | ≤2000 ms | 未达，P1 延期 |
| 首屏渲染 | 5623 ms | — | 记录 |
| 跳转到第 500 页状态更新 | 3 ms | ≤500 ms | 通过 |
| 缩放 | 82 ms | ≤500 ms | 通过 |
| 全篇查找 1000 处 | 20897 ms（本次）；t20 为 18904 ms；历史 17–28s | ≤5000 ms | 未达，P1 延期 |
| 首屏 canvas 数 | 2 | 仅可见页 | 通过 |
| 缩略图 canvas 数 | 14 / 1000 页 | 窗口化 | 通过 |
| JS 堆 | ≈20.7 MB → 56.5 MB | 无硬门禁 | 记录 |

限制：夹具仅 **0.8MB**，不是设计要求的 50–200MB；未在目标信创真机/目标硬件复测。因此上述数字只代表当前开发环境与派生夹具，不能外推为 50–200MB 文档的验收结论。

**处置**：按用户决定，F1 性能目标延期到 P1，非 MVP 门禁；`performance.spec.ts` 不再使用 30s/60s 作为验收阈值，只记录指标并打印未达目标警告（`targetMet=false`、`deferred=true`）。重新评估条件：目标信创机型 + 50–200MB 夹具可用后，优化文本抽取/分片/缓存/并行，再以 §12.6 的 2s/5s 复核。

## 5. 可访问性（axe）

`a11y.spec.ts` 使用 axe-core 4.10.2，规则集 WCAG 2.0/2.1 A+AA，扫描：

- core 阅读页
- 侧栏（缩略图/大纲/书签/签章）
- 查找栏
- 打印选项对话框（含自定义范围输入）
- 导出选项对话框（含格式/质量/背景等控件）
- 签章详情对话框

结果：**serious/critical 均为 0**，测试断言 `serious/critical axe violations === []` 通过；t20 复验同样为全 0。键盘验证通过：PageDown/PageUp、Home/End、Ctrl+F、Escape；输入框内方向键不误翻页；沉浸式全屏 fallback 下 Escape 与侧栏关闭不冲突。

说明：本轮为自动化 axe 与键盘验证，未做真实读屏软件（NVDA/VoiceOver）人工抽查。

## 6. 边界与约束

| 约束 | 结论 | 证据 |
| --- | --- | --- |
| 不实现 `page.renderRegion` 局部/瓦片渲染 | 确认 | `boundaries.spec.ts` 对 dist 静态断言无 `renderRegion`，运行时 `typeof viewer.renderRegion === 'undefined'`，原型链不存在 |
| 不读取/公开依赖 `Seal.esl` | 确认 | 核心 bundle 静态断言无 `Seal.esl`；`src/signature` 仅注释声明不读取 |
| 核心入口不直接依赖 React/Vue | 确认 | `boundaries.spec.ts` 对 dist 核心（排除 react/vue 适配文件）断言无 `from 'react'`/`from 'vue'`；`src/index.ts`、`viewer.ts` 无框架 import |
| 未修改 `packages/ofdrw-viewer-engine/**` | 确认 | `git diff -- packages/ofdrw-viewer-engine` 为空；该目录只有其他并行成员的未跟踪文件，未进入本验收提交 |
| 不验签 | 确认 | 签章仅解析/展示 SignedValue、证书 subject/issuer/serial/算法；不校验证书链/有效期/CRL/OCSP、不输出“有效”结论 |
| 纯 SPA，不承诺 SSR | 确认 | README 明示；构建目标为浏览器 DOM/Canvas |

## 7. 已知限制与 P1 延期

1. **F1 性能**：1000 页派生夹具 0.8MB 下 open≈5.1–5.6s、find≈18.9–20.9s，未达 2s/5s；50–200MB 夹具、目标信创硬件与真实业务文档未测。P1 延期，非 MVP 门禁。
2. **F4 `goToDestination`**：公共 API 尚未暴露 `DocumentDestination` 跳转；替代方式为 `getPageInfos()` + `goToPage(pageIndex + 1)`，页内坐标/缩放锚点由调用方处理。P1。
3. **F8 测试矩阵**：本轮 features E2E 覆盖 18 个键的 API/有效状态参数化，但未逐项覆盖所有控件与快捷键；React 18 双版本矩阵、关键界面视觉回归、真实读屏抽查未执行。已记录为未覆盖风险。
4. **F6 手势**：Ctrl/Command+滚轮、双指捏合、双击缩放已实现并有 `reading.spec.ts` 覆盖；但 120–150ms 渲染防抖/节流优化未做（t24 low 备注）。
5. **签章**：只展示，不验签；不读取 `Seal.esl`；缺 SignedValue.dat 时降级为“签章信息不完整”。
6. **打印/全屏**：打印调用浏览器 `window.print`，不生成 PDF；headless 通过 stub 验证 DOM/清理，未验证真实系统打印对话框。全屏 native 分支未在 headless 实测，fallback 分支已有 E2E。
7. **信创真机**：未在目标信创操作系统/浏览器/硬件组合上运行；当前结论基于 Linux + 系统 Chrome。
8. **渲染范围**：不实现局部/瓦片渲染（`page.renderRegion`），不属于 MVP。

## 8. 交付物与里程碑提交

交付物：

- 包：[packages/ofdrw-viewer-ui](../packages/ofdrw-viewer-ui)（README、src、dist、demo）
- 验收测试：[test/e2e](../packages/ofdrw-viewer-ui/test/e2e)、[test/integration](../packages/ofdrw-viewer-ui/test/integration)、[test/unit](../packages/ofdrw-viewer-ui/test/unit)、[test/acceptance](../packages/ofdrw-viewer-ui/test/acceptance)
- 证据：[performance.json](../packages/ofdrw-viewer-ui/test/acceptance/artifacts/performance.json)、[.last-run.json](../packages/ofdrw-viewer-ui/test/acceptance/artifacts/playwright/.last-run.json)、[HTML 报告](../packages/ofdrw-viewer-ui/test/acceptance/artifacts/report/index.html)
- 本报告：[docs/ofdrw-viewer-ui-验收.md](./ofdrw-viewer-ui-验收.md)

里程碑提交（未 push）：

| 提交 | 说明 |
| --- | --- |
| `2382820` | fix(ui): 修复输出对话框提交与全屏退出（当前 HEAD） |
| `87e4520` | feat(ui): 支持缩放手势并记录性能延期 |
| `999290f` | test(ui): 稳定滚动端到端用例 |
| `60bb120` | fix(ui): 修复评审问题 |
| `2d47302` | test(ui): 增加端到端与可访问性验收 |
| `9dee355` | fix(ui): 修复查找输入占位符对比度 |
| `c960326` | chore(ui): 完成 MVP 集成 |

## 9. 最终结论

`@ofdrw/ofdrw-viewer-ui` 的 P0/MVP 在 HEAD `2382820` 上通过最终验收：typecheck、254 项单元/集成测试、构建、33 项真实浏览器 E2E 与 axe 全部通过；MVP 功能清单逐项有测试证据；无 `page.renderRegion`、无 `Seal.esl` 公开依赖、核心无 React/Vue 直接依赖、未修改引擎。F1 性能、F4 `goToDestination`、F8 部分矩阵与 F6 防抖优化作为 P1/已知风险记录，不影响 MVP 交付。
