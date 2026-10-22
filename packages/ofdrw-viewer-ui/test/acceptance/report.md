# ofdrw-viewer-ui P0/MVP 验收报告（当前 HEAD）

- 最终验收日期：2026-10-23
- HEAD：`2382820` `fix(ui): 修复输出对话框提交与全屏退出`
- 最终验收报告：[docs/ofdrw-viewer-ui-验收.md](../../../../docs/ofdrw-viewer-ui-验收.md)
- 说明：本文替代 2026-10-22 HEAD `9dee355` 的 t11 历史快照；旧版“手势未实现/30–60s 阈值”描述已失效。

## 命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm -C packages/ofdrw-viewer-ui typecheck` | exit 0 |
| `pnpm -C packages/ofdrw-viewer-ui test` | 38 文件 / 254 用例通过 |
| `pnpm -C packages/ofdrw-viewer-ui build` | exit 0，ESM/CJS/DTS + style.css |
| `pnpm -C packages/ofdrw-viewer-ui exec playwright test` | **33 passed / 0 failed**，约 3.6 min |

证据：`artifacts/performance.json`、`artifacts/playwright/.last-run.json`（`status=passed`）、`artifacts/report/index.html`、`artifacts/logs/`。

## 覆盖范围

真实 OFD 打开（桌面 1440×900/移动 390×844/容器嵌入）、连续滚动、页码跳转、缩放/旋转/全屏、Ctrl+滚轮/双指捏合/双击缩放、缩略图/大纲/书签、查找/选择复制、打印与导出（含选项对话框/Enter/取消）、真实签章与缺失 SignedValue 降级、features 18 键矩阵、1000 页性能、axe 与键盘。

## 可访问性

`a11y.spec.ts` 使用 axe-core 4.10.2 扫描 core、sidebar、findbar、打印选项对话框、导出选项对话框、签章详情：**serious/critical 均为 0**。键盘 PageDown/PageUp、Home/End、Ctrl+F、Escape 通过；全屏 fallback 下 Escape 与侧栏关闭不冲突。

## 性能（1000 页，本次 HEAD）

来源：`artifacts/performance.json`。

- 夹具：`thousand.ofd`，1000 页，**0.8MB**（设计目标 50–200MB，未覆盖）。
- 打开：**5590ms**（t20：5107ms；历史 4.8–6.2s），目标 ≤2000ms，未达。
- 首屏：5623ms。
- `goToPage(500)`：3ms，目标 ≤500ms，通过。
- 缩放：82ms，目标 ≤500ms，通过。
- 全篇查找：**20897ms / 1000 命中**（t20：18904ms；历史 17–28s），目标 ≤5000ms，未达。
- 首屏 2 个 canvas；缩略图 14 个 canvas；JS 堆约 20.7MB → 56.5MB。

**处置**：F1 性能按用户决定延期为 P1、非 MVP 门禁；`performance.spec.ts` 已不再用 30s/60s 作为验收阈值，只记录指标并输出 `targetMet=false`、`deferred=true`。目标信创机型 + 50–200MB 夹具可用后，再按 §12.6 的 2s/5s 复核。

## 已知限制/延期

- F1：0.8MB 夹具实测 open≈5.1–5.6s、find≈18.9–20.9s；50–200MB、信创真机未测，P1 延期。
- F4：`goToDestination` P1 延期；替代为 `getPageInfos()` + `goToPage(pageIndex + 1)`。
- F6：Ctrl/Command+滚轮、双指捏合、双击缩放已实现并有 `reading.spec.ts`；120–150ms 渲染防抖未做。
- F8：features E2E 仅 18 键 API/状态矩阵；React 18 双版本、视觉回归、真实读屏抽查未执行。
- 签章只展示不验签；不读取 `Seal.esl`。
- 打印不生成 PDF；headless 通过 stub 验证，真实系统打印对话框未测。
- 不实现局部/瓦片渲染（`page.renderRegion`），不属于 MVP；未修改 `packages/ofdrw-viewer-engine/**`。
- 纯 SPA，不承诺 SSR。

## 历史修复

- `407a69f` 连续滚动状态；`005aa70` 小数页顶跳页；`03d5222` findbar 初始显隐；`ac955e4`/`9dee355` axe 修复。
- `60bb120` 输出对话框/公共 API/全屏回退等 R2 修复；`87e4520` 手势缩放与性能延期记录；`2382820` 输出对话框 Enter、axe 标签与 fallback Escape。
