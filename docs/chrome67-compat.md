# Chrome 67 兼容规格（engine / crypto / ui / site）

> 状态：待评审（本文件是后续实现任务的唯一事实源）
> 核对日期：2026-10-24
> 核对基线：工作区 `HEAD 09f5cbe` + 未提交改动（`git status` 有 56 个文件改动；行号以核对时工作区为准）
> 适用范围：`packages/ofdrw-viewer-engine`、`packages/ofdrw-viewer-crypto`、`packages/ofdrw-viewer-ui`、`site`
> 不涉及：`packages/ofdrw-viewer-cli`（Node.js ≥ 22，无浏览器运行时）、`examples/`（不在 pnpm workspace 内）

本文档只描述目标、差距、方案与验收，不修改任何 `packages/`/`site/` 源码。与本文数字冲突的任务简报、旧设计文档，以本文的“实测”列为准；发现新证据时先更新本文，再改实现。

标记约定：

- **[已验证]**：本仓库代码、构建产物或命令可直接复核，附核对方法。
- **[待验证]**：结论依赖 Chrome 67 实机行为，当前环境没有 67 内核；必须按 §6.3 获取并记录，未实测前不得写成“已通过”。
- **[降级]**：Chrome 67 上行为与现代 Chrome 不同，但业务可接受，只记录、不修（或只做兜底）。

---

## 1. 范围与目标

### 1.1 目标

1. 三个包（engine、crypto、ui）与 `site` 的**源码语法目标**降到 Chrome 67 可解析的范围，构建产物不再包含 Chrome 67 无法解析的语法。
2. 对 Chrome 67 缺失、且仓库实际调用的 **Web API** 提供集中、幂等、可诊断的兼容层；无法 polyfill 的语义差异登记为降级项。
3. 重写 Chrome 67 不支持、且会影响布局/交互的 **CSS**；只影响观感的特性登记为降级项。
4. 建立可重复的**兼容卡口**（源码扫描、产物语法扫描、CSS 扫描、构建目标断言）与**验证流程**（单测、现代 Chrome 回归、Chrome 67 冒烟、不可获取时的记录规范）。
5. **公共 API 保持不变**：不改导出名、参数、返回类型、事件名；新增的 `./compat` 子路径是附加能力，不替代原有入口。
6. CLI 不进入本次改造；`examples/` 不在 workspace 内，另行说明，不纳入卡口。

### 1.2 非目标

- 不承诺 IE、早期 WebView、iOS Safari 旧版本；不承诺 Chrome 66 及更低版本。
- 不承诺 React/Vue **框架自身**在 Chrome 67 上可运行；只承诺本仓库的适配器代码与产物语法可被 67 解析。React 18/19、Vue 3.3+ 的最低浏览器版本由框架决定（**[待验证]**，见附录 A-15）。
- 不把 UI 的 SSR/水合纳入范围。
- 不引入全量 polyfill（core-js）或 CSS 预处理器；只补仓库实际使用、且 67 缺失的 API/语法。
- 不为 Chrome 67 单独维护第二套公共 API 或第二套组件实现。

### 1.3 包与入口矩阵

| 包 | 浏览器入口 | 现有子路径 | 构建方式 |
| --- | --- | --- | --- |
| engine | `dist/index.js`（ESM）/`dist/index.cjs` | 仅 `.` | tsup + CDN 脚本 |
| engine CDN | `dist/ofdrw-viewer-engine.js`（IIFE，全局 `OFDRWViewer`） | 无 | esbuild IIFE |
| crypto | `dist/index.js` / `dist/index.cjs` | 仅 `.` | tsup + CDN 脚本 |
| crypto CDN | `dist/ofdrw-viewer-crypto.js`（IIFE，全局 `OFDRWViewerCrypto`） | 无 | esbuild IIFE |
| ui | `dist/index.js` / `.cjs` | `.`、`./react`、`./vue`、`./element`、`./component`、`./style.css`、`./package.json` | tsup 多入口 + CSS 复制 |
| site | `site-dist/assets/*.js` + `*.css` | 无（private） | Vite build |

补充事实：

- `packages/ofdrw-viewer-ui/package.json` **没有** `sideEffects` 字段（默认视为有副作用），不是 `false`；engine、crypto 为 `"sideEffects": false`。[已验证：读取三个 package.json]
- UI 的 `./component` 是 `./element` 的别名，两者指向同一份 `dist/element.*`（`packages/ofdrw-viewer-ui/package.json:31-35`）。
- `site` 直接引用 UI 源码（`site/main.ts:7-11`），构建时会把 UI 源码、engine/crypto 的 **dist**、以及 external 依赖一起打包；因此 engine/crypto 的 tsup 目标与 site 的 Vite 目标必须同时改（§4）。

### 1.4 与现有文档的冲突（实现完成后必须同步）

| 文档 | 现有表述 | 本文结论 |
| --- | --- | --- |
| `docs/ofdrw-viewer-ui设计方案.md:296` | tsup 目标 `es2020` | 改为 `chrome67` |
| `docs/ofdrw-viewer-ui设计方案.md:308` | “当前不附带 polyfill”，运行时依赖现代 API | 附带最小 compat；Fullscreen 仍走沉浸式回退；新增 Chrome 67 最低目标 |
| `docs/ofdrw-viewer-crypto设计方案.md:74` | 浏览器构建目标 ES2022 | tsup/CDN 改为 `chrome67`；源码可用 ES2022 语法，但产物按 67 降级 |
| `docs/测试方案.md:21,46,74,404-405` | 只覆盖系统 Chrome；CI 不跑 Playwright；无旧内核矩阵 | 增加 Chrome 67 冒烟与“不可获取记录”规范；CI 增加静态兼容卡口，不强制跑 67 浏览器 |
| `packages/ofdrw-viewer-ui/skills/SKILL.md:39` | 运行时需要 DOM、ES2020 | 浏览器最低 Chrome 67；仍需要 DOM/Canvas 2D |
| `packages/ofdrw-viewer-crypto/skills/SKILL.md:29` | 浏览器需 ES2022 | 浏览器最低 Chrome 67（产物语法已降级）；源码仍可用 BigInt 字面量 |
| `packages/ofdrw-viewer-ui/tsup.config.ts:13` | 注释“目标语法 ES2020” | 注释改为 Chrome 67 |
| `packages/ofdrw-viewer-crypto/scripts/build-cdn.mjs:88` | 注释“ES2020 是能表达 BigInt 的最低目标” | 改为“chrome67 支持 BigInt，同时降级可选链/空值合并” |

同步这些文档不属于本规格任务的验收；列为实现阶段 P6 的交付物。

---

## 2. 差距表

### 2.1 运行时 API 差距（以仓库 `src` 实际调用为准）

计数命令见附录 B-1；所有行号均为 2026-10-24 工作区快照。

| # | API / 特性 | Chrome 最低 | 仓库用量与位置 | 影响面 | 处理方式 |
| --- | --- | --- | --- | --- | --- |
| A1 | `Element.prototype.replaceChildren` | 86 | **36 处 / 16 文件**，全部在 ui：`viewer.ts:1804`、`page-view.ts:616,617`、`signature/service.ts:254,308,739,748,993`、`ui/icons.ts:180`、`ui/dialog.ts:69,169,189`、`ui/sidebar.ts:290,298`、`ui/findbar.ts:211,221`、`ui/toolbar.ts:245,253,527`、`ui/toast.ts:91,117`、`views/thumbnails.ts:145,191`、`views/outline.ts:69,124`、`views/bookmarks.ts:64,119`、`text/text-layer.ts:229,354,407,475,493`、`crypto/panel.ts:103,403`、`crypto/credentials-dialog.ts:244`、`crypto/seal-image.ts:76` | 换页、文本层重建、侧栏/对话框/工具条刷新直接抛 `TypeError`，阅读器基本不可用 | compat 补 `Element`/`Document`/`DocumentFragment` 版本 |
| A2 | `Blob.prototype.arrayBuffer` / `File.prototype.arrayBuffer` | 76 | **7 处**：engine `api/document.ts:3643`、`container/byte-source.ts:69`；crypto `util/source.ts:57`；ui `source/read-source.ts:55,74`、`crypto/panel.ts:526`、`crypto/credentials-dialog.ts:362` | blob 来源打开、图片导出（`toBlob` 后读字节）、打印、证书/私钥文件输入全部失败 | compat 补 `Blob.prototype.arrayBuffer`（`File` 继承 `Blob`，一并覆盖） |
| A3 | `Promise.allSettled` | 76 | **4 处**：engine `api/document.ts:1823`、`render/prepare.ts:206,755`；ui `viewer.ts:2468` | 打开/渲染准备阶段 `TypeError`，文档无法完成加载 | compat 补 `Promise.allSettled` |
| A4 | `Object.fromEntries` | 73 | **4 处 / 2 文件**（全部 ui）：`features.ts:77`（**模块顶层**）、`features.ts:124,142`、`feature-gate.ts:191` | `features.ts:77` 在模块求值时就执行；缺失会让整个 UI 入口加载失败 | compat 必须**先于** UI 模块求值安装（§3.3） |
| A5 | `globalThis` | 71 | **15 处引用（13 处代码 + 2 处注释）**：engine `api/document.ts:3137`、`image/tiff.ts:721`、`renderer/canvas2d.ts:6`（注释）、`283,293,1730`、`container/zip-reader.ts:731`；crypto `credentials/pkcs8.ts:169`；ui `render-queue.ts:130`、`ui/viewport.ts:86,181`、`source/http-byte-source.ts:71,73`、`72`（注释）、`source/query-source.ts:159` | 调用处 `ReferenceError`；浏览器主线程、Worker 都可能触发 | compat 定义 `globalThis` |
| A6 | `queueMicrotask` | 71（MDN 兼容表；BCD 原始 JSON 未检索到独立条目，见附录 A-9） | **3 处**：ui `text/selection.ts:131`、`text/text-layer.ts:267`、`views/nav.ts:105` | 选区变更、文本层刷新、导航跳转抛 `ReferenceError` | compat 用 `Promise.resolve().then()` 补齐 |
| A7 | `Array.prototype.flatMap` | 69 | **4 处**：engine `render/prepare.ts:377,425`；ui `crypto/service.ts:233,386` | 渲染准备/证书链处理中断 | compat 补 `flatMap` |
| A8 | `String.prototype.replaceAll` | 85 | **1 处**：ui `crypto/panel.ts:108`（恢复焦点时转义双引号） | 打开签章面板后恢复焦点时抛 `TypeError` | compat 补 `replaceAll`（或改写为 `split/join`，二选一，优先 compat） |
| A9 | 无前缀 Fullscreen API：`requestFullscreen`、`fullscreenElement`、`fullscreenEnabled`、`exitFullscreen`、`fullscreenchange` | 71（`webkit` 前缀 15） | **7 处 API 调用/读取 + 2 处事件监听（合计 9）**：`viewer.ts:1290,1300`（request）、`379,1299,1304`（element）、`1291`（enabled）、`1305`（exit）、`532,1108`（change）；`toolbar.ts:159`、`more-menu.ts:290` 与 i18n `en-US.ts:55`、`zh-CN.ts:54` 是文案键，不是 API | 原生全屏不可用 | **不做全局 polyfill**：保留现有沉浸式回退（`viewer.ts:1292-1296`），只修 `.ofd-viewer--fullscreen-fallback` 的 `inset`（§5.5）。可选 P2 加 `webkit` 前缀桥接，见 §7-R6 |
| A10 | `AbortSignal.prototype.reason` | 98 | **engine 21 处、ui 2 处读取**（engine `api/document.ts`、`api/render-task.ts`；ui `export/image.ts:93,95`）；另有多处 `controller.abort(reason)` 传参 | 67 上 `signal.reason === undefined`，`abort()` 的参数被忽略；取消仍生效，但错误 `cause`/取消原因丢失 | **不可 polyfill**：只登记降级；验证取消流程不依赖 `reason` 的具体值（§6.4-T7） |
| A11 | 原生 `Error.cause` | 93 | 0 处原生用法；三个包各自在 `errors.ts` 中给自定义错误赋值 `cause`（engine `errors.ts:52`、crypto `errors.ts:108`、ui `errors.ts:68`） | 无影响 | 不改 |
| A12 | `navigator.clipboard.writeText` | 66（仅安全上下文） | ui `viewer.ts:1483`、`text/selection.ts:94`；已有 `execCommand('copy')` 回退（`selection.ts:84,100,319,321,337`） | 非安全上下文或权限拒绝时回退到 `execCommand` | 环境约束，不补 polyfill；冒烟记录协议（`http://127.0.0.1` 属可信上下文） |

已确认**安全、无需处理**的 API（避免过度补丁）：

- BigInt 字面量、`DataView.getBigUint64`：Chrome 67 已支持；crypto 源码含 **40 处 BigInt 字面量（分布在 31 行、5 个文件）**（`sm/curve.ts`、`sm/private-key.ts`、`asn1/der.ts`、`asn1/x509.ts`、`credentials/pkcs8.ts`）。
- `AbortController`（66）、`Promise.prototype.finally`（63）、`ResizeObserver`（64）、`IntersectionObserver`（51）、`requestIdleCallback`（47）、`Element.scrollTo`/`scrollIntoView`（61）、`focus-within`（CSS 60）、`position: sticky`（56）、`contain`（52）、`overscroll-behavior`（63）、`scroll-behavior`（61）、空格分隔 `rgb()/hsl()`（65）、`TextDecoder`/`TextEncoder`、`fetch`/`Response`。
- `Response.prototype.arrayBuffer`：5 处（crypto `util/source.ts:105`；ui `source/read-source.ts:48`、`source/http-byte-source.ts:141,318`、`crypto/service.ts:857`），Chrome 42+ 支持，**不计入 Blob 缺口**。
- `CanvasPattern.setTransform`：engine 已有探测与手动平铺回退（`renderer/canvas2d.ts:358,423-445,1102`），67 上走回退。
- `DecompressionStream`：engine 已有探测 + `fflate` 回退（`container/zip-reader.ts:718-810`），67 上走 `fflate`。
- `OffscreenCanvas`：67 缺失；engine 仅在 Worker 无 `document` 时尝试 `OffscreenCanvas`，否则要求宿主注入 `createCanvas`（`renderer/canvas2d.ts:292-304`）。这是**环境约束**，不是 polyfill 目标；文档需写清宿主要求。
- `matchMedia`、`MediaQueryList.addListener`：theme-controller 已检测 `addEventListener` 并回退 `addListener`（`theme/theme-controller.ts:110-114`）。
- `reportError` 的 6 处是 viewer 自身方法名，不是全局 `reportError`。
- 未使用：`structuredClone`、`Object.hasOwn`、`Array.prototype.at`、`Promise.any`、`crypto.randomUUID`、`WeakRef`、`FinalizationRegistry`、`CompressionStream`、`TextDecoderStream`、`AbortSignal.timeout/any`、`URLPattern`。

### 2.2 不能靠 polyfill/构建目标消除的语义差异

| # | 差异 | Chrome 67 行为 | 影响 | 处理 |
| --- | --- | --- | --- | --- |
| S1 | `AbortSignal.reason` | `undefined`；`abort(reason)` 忽略参数 | 取消仍有 `AbortError`，但原因/`cause` 丢失；事件里的 `reason` 字段为空 | [降级] 测试只断言“已取消”，不断言具体 reason；不伪造 reason（伪造会与原生语义冲突） |
| S2 | 无前缀 Fullscreen | 只有 `webkit*` 前缀（且需用户手势） | `setFullscreen` 走沉浸式回退并 `warn('W_FULLSCREEN_FALLBACK')` | [降级] 修 `inset` 保证回退可见；原生全屏可选 P2 |
| S3 | `@page` 命名页 / `page` 属性 | `page` 属性 Chrome 85；命名页规则被忽略；67 的 `CSS.supports('page','x')` 返回 true 但实际不生效 | 混合页尺寸打印退化为单一纸张 | [降级] 双门控：Chromium 主版本 ≥85 且 `CSS.supports` 为 true 才启用命名页，否则统一纸型 + 等比适配，见 §5.8 |
| S4 | `prefers-color-scheme` | 76 才有；`matchMedia` 恒 false | `theme="auto"` 恒解析为 light | [降级] 显式 `theme="dark"` 仍可用；文档说明 |
| S5 | `prefers-reduced-motion` / `prefers-contrast` | 74/96 才有；媒体查询恒 false | 动效照常播放；高对比主题不生效 | [降级] 不影响功能 |
| S6 | `color-scheme` | 81 才有 | 深色主题下原生滚动条/表单控件仍是浅色 | [降级] UI 已给主要控件自定义背景；记录视觉差异 |
| S7 | `accent-color` / `scrollbar-width` / `text-underline-offset` | 93/121/87 | 复选框/滑杆颜色、滚动条宽度、下划线偏移回默认 | [降级] 不改 |
| S8 | `-webkit-backdrop-filter` | 标准属性 76；前缀在 67 是否可用 **[待验证]** | 站点 `.dock` 无毛玻璃，但背景半透明仍可读 | [降级] 同时写 `-webkit-backdrop-filter` 与标准属性，实测记录 |
| S9 | `navigator.clipboard` | 66 起，但仅安全上下文 + 权限 | 失败时已有 `execCommand` 回退 | 环境约束 |

### 2.3 CSS 差距（以 `packages/ofdrw-viewer-ui/src/style.css`、`site/style.css` 为准）

计数命令见附录 B-2。注意：UI 的 `dist/style.css` 是**原样复制**（`packages/ofdrw-viewer-ui/tsup.config.ts:45-48`），不经过 PostCSS/Lightning CSS，所以 CSS 必须在源码里修；site 的 Vite 构建只会降级 `inset` 这类它认识的属性（§3.5），不能依赖。

| # | 特性 | Chrome 最低 | 数量与位置 | 影响面 | 处理方式 |
| --- | --- | --- | --- | --- | --- |
| C1 | flex/inline-flex 的 `gap` | 84 | UI CSS **30 条声明 / 29 个容器**（含 1 条窄视口覆盖）；TS 内联 **2 处 flex**；site **3 条声明 / 2 个容器**；合计 **35 条 / 33 个容器** | 67 接受 `gap` 属性但 flex 布局忽略 → 工具条、按钮、对话框、签章面板全部无间距/粘连 | JS 探测 + `data-ofd-flex-gap="none"` + margin 回退，见 §5.1 |
| C2 | grid 的 `gap` | 57 | UI CSS **16 条**；TS 内联 **1 处**；合计 17 条 | 67 已支持，无需处理 | 保持原样；卡口需区分 grid/flex |
| C3 | `:where()` | 88 | UI **18 处 / 15 条规则**（1380,1399,1433,1445,1590,1696,1843,1847,1852,1856,1860,1865,1899,1957,1964） | 整条规则被丢弃 → 移动/窄屏布局、溢出菜单标记、对话框按钮等样式丢失 | 展开为普通选择器列表；**必须审计特异性变化**，见 §5.3 |
| C4 | `:is()` | 88 | UI **3 处 / 3 条规则**（1486,1529,1983） | 整条规则被丢弃 → overlay/drawer 侧栏内边距/宽度样式丢失 | 按参数展开为逗号选择器；特异性不变，见 §5.3 |
| C5 | `min()` | 79 | UI **11 处 / 11 条规则**（939,956,1010,1127,1325,1446,1622,1717,2034,2084,2359）；site **1 处**（172） | 声明在解析期无效 → 对话框宽度、侧栏宽度、弹层尺寸回退为默认/溢出 | 等价改写优先（width+max-width）；无法等价时“旧值声明 + min() 声明”双写；自定义属性用 `@supports` 门控，见 §5.4 |
| C6 | `max()` / `env()` | 79 / 69 | 均在 site：`.dock` 的 `bottom: max(14px, env(safe-area-inset-bottom))`（70）与窄屏覆盖（204） | 67 两条声明都无效 → 固定底栏的 `bottom` 变为 auto，位置错乱 | `bottom: 14px;`（窄屏 `10px`）前置，再写 `max(...)`，见 §5.4 |
| C7 | `:focus-visible` | 86 | UI **16 处 / 14 条规则**（295,507,718,723,864,1358,1362,1508,1524,1686,1692,1752,1765,1769）；site **2 处 / 1 条规则**（136,138） | 整条规则被丢弃 → 键盘焦点没有可见轮廓，可访问性回退 | `:focus` 基础规则 + `:focus:not(:focus-visible)` 抑制规则，见 §5.6 |
| C8 | `inset` | 87 | UI CSS **1 处**（1702，全屏回退层）；UI TS 内联 **3 处**（`page-view.ts:167,175,184`）；site **2 处**（59,110） | `.ofd-viewer--fullscreen-fallback` 失去四边定位 → 沉浸式全屏不可用；页面 canvas/text/signature 层失去定位 → 文本层与签章层错位/塌陷 | 改 `top/right/bottom/left`，见 §5.5 |
| C9 | `color-scheme` | 81 | UI **3 条声明 / 3 条规则**（78,158,201）+ 2 条 `prefers-color-scheme` 媒体查询（161,225）；site **2 条**（9,31） | 67 忽略；原生控件/滚动条不跟随深色 | [降级] 保留现代声明；见 S4/S6 |
| C10 | `prefers-reduced-motion` | 74 | UI **2 条媒体查询**（1086,1146；1085 是注释）；site **1 条**（217） | 动效仍播放 | [降级] |
| C11 | `prefers-contrast` | 96 | UI **1 条**（205） | 忽略 | [降级] |
| C12 | `accent-color` | 93 | UI **4 条**（1578,1749,1761,1766） | 复选框/滑杆回到默认蓝 | [降级] |
| C13 | `scrollbar-width` | 121 | UI **3 条**（248,1273,1472） | 滚动条宽度回默认；相关容器宽度略有差异 | [降级]；回归时确认不裁切 |
| C14 | `text-underline-offset` | 87 | UI **1 条**（1939） | 下划线偏移忽略 | [降级] |
| C15 | `backdrop-filter` | 76 | site **1 条**（84，`.dock`） | 无毛玻璃 | [降级] + `-webkit-` 尝试（S8） |
| C16 | `appearance: textfield` | 84 | UI **1 条**（1297，页码输入框） | 67 忽略该声明；数字输入框的上下箭头已由 `::-webkit-inner-spin-button` 规则（1300-1303）隐藏 | 不改；记录为已兜底 |
| C17 | `@page` 命名页/`page` 属性 | `page` 85；`@page size` 15 | 动态生成于 `ui/src/print/print-document.ts:233-273` | 混合页尺寸打印退化 | 见 S3 与 §5.8 |

已确认安全、无需改的 CSS：grid `gap`（57）、`:focus-within`（60）、`position: sticky`（56）、`contain`（52）、`overscroll-behavior`（63）、空格分隔颜色（65）、`rgb(15 23 42 / 12%)`（site 17/18/39/40/83）、`@media (hover)`、`::-webkit-*` 伪元素。源码中没有 `:has()`（仅注释）、`clamp()`、`aspect-ratio`、`@container`、`@layer`、`color-mix()`、逻辑属性。

### 2.4 构建产物语法现状（为什么产物在 67 会直接语法错误）

| 产物 | 当前 target | 核对时残留（`?.` / `??`） | 其它证据 | 结论 |
| --- | --- | --- | --- | --- |
| `engine/dist/index.js` | es2022 | **204 / 295** | 直接以 `<script type=module>` 或未转译的打包器加载会在 67 解析失败 | 必须改 `chrome67` |
| `engine/dist/ofdrw-viewer-engine.js`（CDN） | es2017 | **0 / 0** | 但仍有 `Promise.allSettled` 3、`globalThis` 6、`.arrayBuffer(` 2 → 语法能过，运行时仍缺 API | 语法目标改 `chrome67`；API 由 compat 补 |
| `crypto/dist/index.js` | es2022 | **92 / 78** | — | 必须改 `chrome67` |
| `crypto/dist/ofdrw-viewer-crypto.js`（CDN） | es2020 | **92 / 78** | `es2020` 保留可选链/空值合并，67 直接语法错误 | **必须改 `chrome67`** |
| `ui/dist/chunk-*.js` | es2020 | **341 / 282** | `replaceChildren` 36、`fromEntries` 4、`queueMicrotask` 3、`replaceAll` 1、`arrayBuffer` 8 | 必须改 `chrome67` + compat |
| `ui/dist/element.js` / `react.js` / `vue.js` | es2020 | 10/1、22/7、21/8 | 子入口同样会在 67 解析失败 | 多入口统一 `chrome67` |
| `site-dist/assets/index-*.js` | es2020 | **645 / 673** | 含 engine/crypto dist、external 依赖与 UI 源码；`allSettled` 4、`replaceChildren` 36、`fromEntries` 4、`globalThis` 12、`arrayBuffer` 9 | 必须改 Vite target；依赖语法由 Vite 的 `renderChunk` esbuild 统一降级（已在 Vite 8 源码确认，见 §4.4） |

> 产物数字来自 2026-10-24 03:37 的旧 dist；源码 10:34 仍有改动，重建后具体数字会变化。验收标准不是“保持某个数字”，而是**扫描结果为 0**（§6.1）。

### 2.5 external 依赖的语法风险

engine/crypto 的 tsup 产物把依赖保持 external；这些依赖的已发布代码含有 Chrome 67 不支持的语法：

| 依赖 | 含 `?.`/`??` 的 JS 文件数 / 次数 | 使用方 |
| --- | --- | --- |
| `fontkit@2.0.4` | 1 文件 / 11 次（`src/aat/AATFeatureMap.js`） | engine（静态 `import { create } from 'fontkit'`，`src/font/face.ts:8`） |
| `saxes@6.0.0` | 1 / 2 | engine、crypto |
| `asn1js@4.0.0` | 1 / 31 | crypto |
| `@peculiar/asn1-schema@2.11.0` | 6 / 18 | crypto |
| `fflate@0.8.3`、`sm-crypto@0.5.7`、`@peculiar/asn1-x509@2.11.0` | 0 | — |

影响与边界：

- **CDN 包**由 esbuild 把依赖一起打包，`target: 'chrome67'` 会转译依赖语法 → 67 可用。
- **ESM/CJS 包**不转译 external 依赖。宿主若直接把这些 dist 以原生 ESM 加载到 67，会在 `fontkit` 处先语法错误。宿主使用 Vite/Rollup 等构建时，Vite 8 会对最终 chunk 统一跑 esbuild 转译（§4.4）；webpack 等若把 `node_modules` 排除在 babel-loader 之外，则宿主需自行把依赖纳入转译，或用 CDN 包。
- 本次**不**把依赖改为 bundled（会改变包体积/去重/发布形态），只把该约束写进接入文档与验收：Chrome 67 的“保证路径”是 CDN 包或宿主转译后的 bundle。

### 2.6 与任务简报的数量偏差（以本表为准）

| 项 | 简报 | 实测 | 说明 |
| --- | --- | --- | --- |
| `replaceChildren` | 36 | **36 / 16 文件** | 一致 |
| Blob/File `.arrayBuffer()` | 6 | **7** | 简报可能把某处 `Response.arrayBuffer` 计入，或漏了 `read-source.ts:74`；Response 共 5 处，Chrome 42+ 不计 |
| `Promise.allSettled` | 3 | **4** | 漏了 `ui/viewer.ts:2468` |
| `Object.fromEntries` | 4 | **4** | 一致；其中 1 处是模块顶层（决定 compat 加载顺序） |
| `globalThis` | 15 | **15（13 代码 + 2 注释）** | 一致；注释在 `canvas2d.ts:6`、`http-byte-source.ts:72` |
| `queueMicrotask` | 3 | **3** | 一致 |
| `flatMap` | 4 | **4** | 一致 |
| `replaceAll` | 1 | **1** | 一致 |
| `requestFullscreen` | 2 | **2** | 另有 element/enabled/exit/change 共 7 处相关 API |
| `gap` | 41 | **52 条声明**（35 flex + 17 grid；含 TS 内联与 site） | CSS 46 条 + TS 3 条 + site 3 条；简报只数了 CSS 的一部分 |
| `color-scheme` | 3 | **5 条声明位置**（UI 3 条规则 + site 2）+ 2 条 `prefers-color-scheme` 媒体查询 | 简报是 UI-only 口径 |
| `focus-visible` | 15 | **16 处 / 14 规则 + site 2 处 / 1 规则** | 简报漏 site |
| `min()` | 11 | **11 UI + 1 site** | 简报是 UI-only 口径 |
| `inset` | 1 | **6**（UI CSS 1 + UI 内联 3 + site 2） | 内联 `inset` 同样必须在源码修 |
| `prefers-reduced-motion` | 2 | **3 条媒体查询**（UI 2 + site 1；另有 1 条注释） | — |
| `sideEffects` 三包均 false | 是 | **engine/crypto 为 false；UI 无该字段（默认 true）** | 不能把 UI 改成数组，否则会误删入口副作用 |
| crypto BigInt 字面量 | 15 | **40 处（31 行）** | `target/lib` 降到 ES2019 会直接编译失败，证明 crypto tsconfig 必须 ≥ES2020 |
| crypto CDN 目标 | es2020（简报正确） | es2020 | 注意 `docs/ofdrw-viewer-crypto设计方案.md:74` 写的是“ES2022”，与脚本不一致 |

---

## 3. 兼容层交付方式

### 3.1 三选一决策

| 方案 | 做法 | 优点 | 致命问题 | 结论 |
| --- | --- | --- | --- | --- |
| A. 内联主入口 | 把补丁代码直接写在 `src/index.ts` 顶部 | 不改 exports/sideEffects | UI 有 4 个入口（`.`/react/vue/element），补丁要复制 4 份；`Object.fromEntries` 在 `features.ts:77` 的**模块顶层**执行，而 `features.ts` 可能先于 `index.ts` 顶部代码被求值（import 提升）；宿主/Worker 无法提前安装 | 拒绝 |
| B. 独立 `src/compat.ts` + 各入口首行 `import './compat'` + `./compat` 子路径 | 补丁集中、默认自动安装、可显式提前 import | 保证求值顺序；单份实现；子路径可给宿主/Worker 提前调用；公共 API 不变 | 会修改宿主全局（见 §7-R1），需要 sideEffects 配合 | **采用** |
| C. legacy 子入口 | 产出 `dist/legacy.js` 等第二套入口 | 宿主可选择 | 需要为 `.`/react/vue/element 各维护 legacy 变体；公共入口默认仍不支持 67；产物与类型双份；违反“公共 API 不变”的最小改动原则 | 拒绝 |

补充：**不采用**“只改源码调用点、不做全局补丁”的路线。它虽然避免污染宿主全局，但要改 36+7+4+4+15+3+4+1 处调用，且 `features.ts:77` 顶层表达式仍需改写；集中 compat 更可审计、可测试，且对公共 API 零改动。代价是宿主全局被补丁，按 §7-R1 管理。

### 3.2 compat 模块契约

每个包新增 `src/compat.ts`，并导出：

```ts
/** 安装当前包所需的 Chrome 67 兼容补丁；幂等，可在任意环境重复调用。 */
export function installCompat(): void;
```

模块顶层**自动调用一次** `installCompat()`（副作用），同时提供命名导出供测试/宿主重复调用（幂等）。安装顺序：先补 `globalThis`，再补其余 API，最后设置能力标记。所有补丁必须：

1. 只在原生缺失时定义；用 `Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false })`。
2. 不在模块顶层访问 `window`/`document`/`Element`；用 `typeof X !== 'undefined'` 守卫，保证 Node/Worker 导入不抛错。
3. 用 `Symbol.for('ofdrw.viewer.compat.v1')` 在全局对象上写一个**不可枚举**的安装标记（仅诊断/测试用，不作为公共 API）；重复调用直接返回。
4. 不吞异常、不改变原生实现；补丁内部错误按原生语义抛出（如 `queueMicrotask` 回调非函数抛 `TypeError`）。

各包补丁清单：

| 包 | 必须补 | 说明 |
| --- | --- | --- |
| engine | `globalThis`、`Blob.prototype.arrayBuffer`、`Promise.allSettled`、`Array.prototype.flatMap` | engine 不使用 `replaceChildren`/`fromEntries`/`queueMicrotask`（源码 0 处；fflate 自带 `typeof queueMicrotask` 守卫） |
| crypto | `globalThis`、`Blob.prototype.arrayBuffer` | crypto 的其余现代 API 使用为 0；BigInt 是语法不是 API |
| ui | `globalThis`、`Blob.prototype.arrayBuffer`、`Promise.allSettled`、`Object.fromEntries`、`queueMicrotask`、`Array.prototype.flatMap`、`String.prototype.replaceAll`、`Element/Document/DocumentFragment.prototype.replaceChildren` | 覆盖 §2.1 的 A1–A8；Fullscreen 与 `AbortSignal.reason` 不补（§2.2） |

实现要点（供实现任务直接照做）：

- `globalThis`：`const g = typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : Function('return this')();`；`Function` 构造在 CSP 下可能被禁，但仅当三者都不存在时才走到；Node/浏览器均有 `globalThis`。
- `Blob.prototype.arrayBuffer`：优先 `FileReader.readAsArrayBuffer`；无 `FileReader` 时用 `new Response(blob).arrayBuffer()`；两者都没有时返回 `Promise.reject(new Error(...))`。保留 `this`，不修改 `slice`。
- `Promise.allSettled`：对 iterable 逐项 `Promise.resolve().then`，结果 `{status:'fulfilled',value}` / `{status:'rejected',reason}`；输入不可迭代时按原生抛 `TypeError`。
- `Object.fromEntries`：接受 iterable of `[key,value]`；用 `Object.defineProperty` 写入，避免 `__proto__` 污染；`null/undefined` 抛 `TypeError`。
- `queueMicrotask`：非函数抛 `TypeError`；用 `Promise.resolve().then(callback)`（回调异常成为未处理拒绝，与原生一致）。
- `flatMap`：`this` 为 `null/undefined` 抛 `TypeError`；`callback` 非函数抛 `TypeError`；深度固定 1；透传 `(value,index,array)`。
- `replaceAll`：字符串 search 或带 `g` 标志的正则；正则缺 `g` 抛 `TypeError`；字符串 search 必须转义正则元字符后再复用 `String.prototype.replace`，以保留替换串中 `$&`/`$1` 等 GetSubstitution 语义。
- `replaceChildren`：在 `Element`/`Document`/`DocumentFragment` 上定义；先清空，再按参数顺序 `append`（字符串/数字转 `Text`，`DocumentFragment` 展开为子节点）；`null`/`undefined` 的行为按现代 Chrome 实测对齐（**[待验证]**），不要自创 `TypeError` 规则。
- 能力标记：`<html data-ofd-flex-gap="none">` 由 UI compat 在 `document.documentElement` 上同步设置（探测逻辑见 §5.1）；`site` 复用 UI compat，无需重复探测。打印文档与 UI 同属一个 `document`，属性可见。

UI 的 compat 还负责：

- 探测 flex `gap` 是否真正生效：创建 `div`（`position:absolute; visibility:hidden; display:flex; gap:4px`）与两个固定宽子元素，测量第二个子元素的 `offsetLeft` 是否比无 gap 时大 4px。Chrome 67 会接受 `gap` 但不生效 → 返回 false；现代 Chrome 返回 true。**不要**用 `CSS.supports('gap','4px')`（67 会返回 true）。
- 探测结果写入 `document.documentElement.dataset.ofdFlexGap = supported ? 'yes' : 'none'`；仅在 `document` 存在时执行；重复调用幂等。

### 3.3 加载顺序与副作用

- `src/index.ts` 的**第一条 import** 必须是 `import './compat';`（类型导入可放后面）。engine/crypto 只有 `.` 一个入口；UI 的 `src/index.ts`、`src/react/index.ts`、`src/vue/index.ts`、`src/component/ofd-viewer-element.ts` 四个入口都要加，且必须是第一条。
- 原因：`ui/src/features.ts:77` 的 `DEFAULT_FEATURES = Object.freeze(Object.fromEntries(...))` 是**模块顶层**执行；`features.ts` 被 `feature-gate.ts`、`ui-shell` 等传递导入。ESM 按 import 声明顺序深度优先求值，compat 放第一条才能保证补丁先装。
- 构建后检查（强约束）：在 Node（UI 用 jsdom）中删除目标 API 后 `import()` 各入口 dist，断言 compat 已把它们装回；对 UI 还要断言 `features.ts` 的顶层 `Object.fromEntries` 没有在补丁前执行（导入不抛错即证明）。这比检查“第一行 import”可靠：tsup 在 `splitting: false` 时可能把 compat 内联进入口，在 `splitting: true` 时可能先加载共享 chunk。textual 检查（入口文件前几行出现 compat 引用）只作辅助。验收命令见 §6.2-G3。
- `site/main.ts` 目前直接 import UI 源码：`import '../packages/ofdrw-viewer-ui/src/style.css'; import './style.css'; import '../packages/ofdrw-viewer-ui/src/component/ofd-viewer-element';`，由 UI 入口的 compat 自动安装；site 不重复安装。

### 3.4 三包 `package.json` 改动清单（精确）

#### engine（`packages/ofdrw-viewer-engine/package.json`）

```jsonc
{
  "sideEffects": ["./dist/compat.js", "./dist/compat.cjs"],
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "require": "./dist/index.cjs" },
    "./compat": {
      "types": "./dist/compat.d.ts",
      "import": "./dist/compat.js",
      "require": "./dist/compat.cjs"
    }
  }
}
```

`tsup.config.ts` 的 `entry` 从 `['src/index.ts']` 改为 `['src/index.ts', 'src/compat.ts']`；`main/module/types` 不变；`files: ["dist"]` 已覆盖新产物。

#### crypto（`packages/ofdrw-viewer-crypto/package.json`）

与 engine 完全同构：

```jsonc
{
  "sideEffects": ["./dist/compat.js", "./dist/compat.cjs"],
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "require": "./dist/index.cjs" },
    "./compat": {
      "types": "./dist/compat.d.ts",
      "import": "./dist/compat.js",
      "require": "./dist/compat.cjs"
    }
  }
}
```

`tsup.config.ts` 的 `entry` 同样加 `src/compat.ts`。

#### ui（`packages/ofdrw-viewer-ui/package.json`）

```jsonc
{
  // 不新增 "sideEffects" 字段：当前默认 true，入口本身就有
  // text/index、views/nav、views/signatures、print/index、export/index 等副作用；
  // 若改成数组，必须同时列出所有副作用模块，风险高，本次不改。
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "require": "./dist/index.cjs" },
    "./react": { "types": "./dist/react.d.ts", "import": "./dist/react.js", "require": "./dist/react.cjs" },
    "./vue": { "types": "./dist/vue.d.ts", "import": "./dist/vue.js", "require": "./dist/vue.cjs" },
    "./element": { "types": "./dist/element.d.ts", "import": "./dist/element.js", "require": "./dist/element.cjs" },
    "./component": { "types": "./dist/element.d.ts", "import": "./dist/element.js", "require": "./dist/element.cjs" },
    "./compat": {
      "types": "./dist/compat.d.ts",
      "import": "./dist/compat.js",
      "require": "./dist/compat.cjs"
    },
    "./style.css": "./dist/style.css",
    "./package.json": "./package.json"
  }
}
```

`tsup.config.ts` 的 `entry` 增加 `compat: 'src/compat.ts'`（与 index/react/vue/element 并列）；`onSuccess` 继续复制 `src/style.css`。`./component` 仍指向 element，不新增文件。

> 为什么 engine/crypto 必须把 `sideEffects` 从 `false` 改成数组：入口里的 `import './compat'` 是纯副作用导入；当包被标记为 `sideEffects: false` 时，打包器可把整个 compat 模块 tree-shake 掉，补丁不会执行。数组形式显式声明“只有 compat 有副作用”，其余仍可 tree-shake。UI 没有该字段（true），不会丢，保持现状。

### 3.5 为什么只改 esbuild target 不够

四条独立证据（均可复现）：

1. **target 只降语法，不注入 API。** engine CDN 已是 `target: 'es2017'`，`?.`/`??` 为 0，但产物仍有 `Promise.allSettled` 3 处、`globalThis` 6 处、`.arrayBuffer(` 2 处（附录 B-3）。Chrome 67 能解析，却在运行时 `TypeError`/`ReferenceError`。
2. **esbuild 的 CSS target 只处理它认识的降级。** 用本仓库 esbuild 对 `inset/min()/gap/:where/:focus-visible` 做 `target: 'chrome67'` 实验：`inset` 被降成 `top/right/bottom/left`，`min()`、flex `gap`、`:where()`、`:focus-visible` **原样保留**（附录 B-4）。所以 CSS 必须源码重写。
3. **tsconfig 的 `target` 不控制 emit。** 三个包 `noEmit: true`，实际 emit 由 tsup/esbuild 的 target 决定；把 tsconfig 降到 ES2017 既不能改变产物，还可能让 crypto 的 40 处 BigInt 字面量类型检查失败。
4. **target 不能改变运行时语义。** `AbortSignal.reason`（98）、命名页打印（85）、`prefers-*` 媒体查询、无前缀全屏都不受构建目标影响，必须代码/样式层处理或登记降级。

另一个容易忽略的点：external 依赖（§2.5）不受我们的 tsup target 影响；只改 target 仍可能因 `fontkit`/`asn1js` 的 `?.` 在 67 失败。CDN 包因打包全部依赖而安全。

### 3.6 环境约束（不是 polyfill 能解决的）

- **Worker/OffscreenCanvas**：67 无 `OffscreenCanvas`；engine 在 Worker 中需要宿主注入 `createCanvas`，否则抛 `OFD_RENDERER_UNSUPPORTED`（`canvas2d.ts:292-304`）。这是引擎既有契约，接入文档需写明。
- **安全上下文**：`navigator.clipboard` 仅安全上下文；`http://127.0.0.1`/`localhost` 可用于冒烟，`file://` 行为 [待验证]。
- **CSP**：compat 不使用 `eval`/`new Function`（`globalThis` 兜底分支除外，正常环境不会走）。
- **跨域**：URL 来源、字体、根证书仍受 CORS/Range/`Content-Range` 约束，与 67 无关。

---

## 4. 构建目标矩阵

### 4.1 现状（核对时）

| 位置 | 当前值 | 作用 |
| --- | --- | --- |
| `packages/ofdrw-viewer-engine/tsup.config.ts:16` | `target: 'es2022'` | ESM/CJS 产物 |
| `packages/ofdrw-viewer-engine/scripts/build-cdn.mjs:84` | `target: 'es2017'` | CDN IIFE |
| `packages/ofdrw-viewer-crypto/tsup.config.ts:16` | `target: 'es2022'` | ESM/CJS 产物 |
| `packages/ofdrw-viewer-crypto/scripts/build-cdn.mjs:89` | `target: 'es2020'` | CDN IIFE；注释（88 行）说明“BigInt 最低 ES2020” |
| `packages/ofdrw-viewer-ui/tsup.config.ts:29` | `target: 'es2020'` | 四个 JS 入口 + chunks |
| `site/vite.config.ts:19` | `build.target: 'es2020'` | 站点 JS/CSS |
| `packages/ofdrw-viewer-engine/tsconfig.json:3-4` | `ES2022 / lib ES2022` | 只做类型检查（`noEmit`） |
| `packages/ofdrw-viewer-crypto/tsconfig.json:3-4` | `ES2022 / lib ES2022, DOM` | 只做类型检查；40 处 BigInt 字面量要求 ≥ES2020 |
| `packages/ofdrw-viewer-ui/tsconfig.json:3-4` | `ES2020 / lib ES2022, DOM` | 只做类型检查 |
| `site/tsconfig.json:2` | extends UI | 只做类型检查 |
| `packages/ofdrw-viewer-cli/tsconfig.json:3` | `ES2022` | Node-only，不改 |

### 4.2 目标（实现任务按此改）

| 位置 | 目标值 | 理由 |
| --- | --- | --- |
| engine `tsup.config.ts:16` | **`chrome67`** | dist 直接给 67 用时不再含 `?.`/`??`/类字段等；esbuild 已验证 `chrome67` 保留 `0n`（附录 B-5） |
| engine `scripts/build-cdn.mjs:84` | **`chrome67`** | 与 dist 统一口径；es2017 语法虽可用，但会把 67 已支持的 object spread/async generator 等不必要地降级，且不能阻止未来源码引入 67 不支持的语法 |
| crypto `tsup.config.ts:16` | **`chrome67`** | 同上 |
| crypto `scripts/build-cdn.mjs:89` | **`chrome67`** | **必须**：es2020 产物保留 92 处 `?.`/78 处 `??`，67 直接语法错误；`chrome67` 仍支持 BigInt 字面量 |
| ui `tsup.config.ts:29` | **`chrome67`** | 4 个入口统一；67 可解析 |
| site `vite.config.ts:19` | **`chrome67`** | Vite 在 `renderChunk` 对最终 chunk 跑 esbuild（已在 Vite 8.3.5 `dist/node/chunks/node.js:7445` 的 `vite:esbuild-transpile` 确认），因此依赖与 engine/crypto dist 会一起降级 |
| 各包 `tsconfig` | **保持不变** | `noEmit` 下不影响产物；crypto 必须 ≥ES2020（40 处 BigInt 字面量，降到 ES2019 会编译失败）；UI/engine 保持现类型环境，避免误收窄 `lib` |
| CLI `tsconfig` | **不变** | Node-only |

补充：

- `esbuild` 的 `target: 'chrome67'` 是合法值；本仓库 esbuild 实测可把 `?.`、`??`、`||=`、类字段/私有字段降级，并保留 `1n`（附录 B-5）。
- 不建议用 `es2015`/`es2017` 代替 `chrome67`：会额外降级 67 已支持的语法，增加 helper 与体积，且与“最低 67”的语义不一致。
- `tsup` 的 `target` 同时作用于 dts？否，dts 由 rollup-plugin-dts 生成，类型语法不受影响。

### 4.3 crypto tsconfig 必须 ≥ES2020 的证据

- crypto 源码含 **40 处 BigInt 字面量（31 行）**：`sm/curve.ts`（10）、`sm/private-key.ts`（3）、`asn1/der.ts`（23）、`asn1/x509.ts`（1）、`credentials/pkcs8.ts`（3）。
- 核对命令：附录 B-6；若把 `target` 或 `lib` 降到 ES2019 以下，`pnpm -C packages/ofdrw-viewer-crypto typecheck` 会报 “BigInt literals are not available when targeting lower than ES2020”。
- 结论：**只改构建目标，不改 crypto 的 tsconfig target/lib**；esbuild 对 `chrome67` 保留 BigInt 字面量，Chrome 67 原生支持 BigInt（BCD `javascript.builtins.BigInt`：67）。

### 4.4 产物验收

构建后必须同时满足：

1. `pnpm build` 成功；engine/crypto 的 CDN 自检脚本（`build-cdn.mjs` 内置的 VM 校验）通过。
2. `pnpm check-compat:dist`（新增）通过：扫描 `packages/*/dist/**/*.{js,cjs}` 与 `site-dist/assets/*.js`，无 `?.`、`??`、`||=`、`&&=`、`??=`、类字段、`#private`、静态块、数字分隔符、`export * as` 等 67 不支持的语法；扫描 CSS 无 §5 列为“必须修”的残留。
3. 产物中的 compat 入口仍存在且先于业务模块求值：`dist/compat.js` 存在；按 §6.2-G3 的运行时探针（删除目标 API 后导入入口）通过。
4. external 依赖的语法不纳入本仓库产物扫描（它们不在 dist 内）；但 §2.5 的接入约束必须在发布说明中保留。

### 4.5 CDN 构建脚本需要同步的注释/自检

- `crypto/scripts/build-cdn.mjs:88` 的注释“ES2020 是能表达 BigInt 的最低目标”需要改成“chrome67 仍支持 BigInt；用 chrome67 是为了同时降级可选链/空值合并/类字段”。
- engine/crypto 的 CDN 自检沙箱目前没有 `Element`/`document`（`createSandbox()`）；compat 必须能在这种环境安装（只补 `Blob`/`Promise`/`globalThis`/`flatMap`），不得访问 DOM。自检应增加一条：执行产物后 `typeof Blob.prototype.arrayBuffer === 'function'` 且 `typeof Promise.allSettled === 'function'`（Node 26 原生已有，等于验证“不破坏原生”）。
- `ui` 没有 CDN 脚本；UI 的 `dist/style.css` 复制逻辑不变。

---

## 5. CSS 策略

总原则：

1. **只对“67 会丢布局/丢交互”的特性做回退**；纯观感差异登记为降级。
2. 现代声明保留，回退声明放在其**前面**（利用旧内核解析期丢弃未知值），或放在能力属性限定下；不要用会误伤现代内核的无条件覆盖。
3. 每块回退加注释标记：`/* chrome67: flex-gap fallback */`、`/* chrome67: focus fallback */` 等，便于回滚与卡口定位。
4. 不引入预处理器、不引入 `@supports selector()`（Chrome 83 才有，67 无法用于门控）。
5. 回退后必须在 1440×900、390×844、1023/767/479 断点与现代 Chrome 对照。

### 5.1 flex gap：为什么用 margin 回退而不是改 grid

| 方案 | 问题 |
| --- | --- |
| 把 flex 容器改成 grid | 这 29 个容器依赖 flex 的 `flex-grow`/`flex-shrink`/`align-items`/`justify-content`/`flex-wrap` 与内在尺寸；改 grid 要重做断点与溢出菜单，风险远大于收益 |
| 无条件把 `gap` 换成子项 margin | 现代内核会同时受 gap 与 margin 影响（双倍间距），必须删掉 gap；换行容器的行间距无法用 `> * + *` 精确表达；边缘间距会改变 |
| JS 探测 + 能力属性 + margin（采用） | 现代内核完全走原 gap；67 才加 margin；代价是需要一次同步探测与每个容器的回退规则 |

探测与属性：

- 由 UI compat 执行（§3.2），在 `document.documentElement` 上设置 `data-ofd-flex-gap="none"`（不支持）或 `"yes"`（支持）。
- 探测必须在首屏渲染前完成：compat 在入口第一条 import 中同步执行；`document.documentElement` 此时已存在（`<script type=module>` 默认 defer，DOM 已解析）。
- site 复用 UI compat；如果 site 未加载 UI 而单独使用（当前不会），需在 site 自己的入口补一次同样探测。

回退规则模板：

```css
/* 现代：保留 gap */
.ofd-viewer__toolbar {
  display: flex;
  gap: 4px;
}

/* chrome67: flex-gap fallback（仅在 67 生效） */
[data-ofd-flex-gap='none'] .ofd-viewer__toolbar > * + * {
  margin-left: 4px;
}
```

- **row 且不换行**：`> * + * { margin-left: <column-gap> }`。
- **column**：`> * + * { margin-top: <row-gap> }`。
- **wrap / 双轴**（UI：`.ofd-signature-summary-item__meta` 535 `4px 8px`、`.ofd-viewer__loading-actions` 1062 `8px`、`.ofd-credential-form__modes` 2059 `16px`、`.ofd-verification-header` 2089 `8px`；site：`.dock` 74 `6px 10px` 与窄屏 201 `6px`）：用半间距 + 容器负 margin：

```css
[data-ofd-flex-gap='none'] .ofd-credential-form__modes {
  margin: -8px;
}
[data-ofd-flex-gap='none'] .ofd-credential-form__modes > * {
  margin: 8px;
}
```

  该写法对 row/column/wrap 都成立；容器边缘会外扩半个 gap（1–8px），需在回归中确认不被 `overflow:hidden` 裁切；若有裁切，改为只加 `margin-right` + `margin-bottom`（右侧/底部多出 gap，可接受）。
- 不要用 `:where()` 写回退（67 不支持）；不要用 `@supports (gap: 1px)` 判断 flex gap（67 会误判为支持）。

逐项清单（UI CSS，29 个容器 / 30 条声明）：

| 行 | 选择器 | gap | 方向/说明 | 回退 |
| --- | --- | --- | --- | --- |
| 234 | `.ofd-viewer__toolbar` | 4px | row，nowrap | `> * + * { margin-left:4px }` |
| 252 | `.ofd-toolbar__group` | 2px | inline-flex row | 同上，2px |
| 454 | `.ofd-outline__item` | 4px | row | 同上，4px |
| 519 | `.ofd-signature-summary-item__title` | 6px | row | 同上，6px |
| 535 | `.ofd-signature-summary-item__meta` | 4px 8px | **wrap** | 半间距容器负 margin（row 4 / col 8） |
| 749 | `.ofd-page__loading` | 8px | column | `> * + * { margin-top:8px }` |
| 828 | `.ofd-page__error` | 8px | column | 同上 |
| 891 | `.ofd-viewer__findbar` | 6px | row | `margin-left:6px` |
| 1007 | `.ofd-viewer__loading-panel` | 12px | column | `margin-top:12px` |
| 1062 | `.ofd-viewer__loading-actions` | 8px | **wrap** | 半间距 4px |
| 1258 | `.ofd-button` | 4px | inline-flex row | `margin-left:4px` |
| 1283 | `.ofd-toolbar__page-number` | 2px | inline-flex row | 同上，2px |
| 1317 | `.ofd-more-menu` | 2px | column | `margin-top:2px` |
| 1553 | `.ofd-findbar__options` | 2px | row | `margin-left:2px` |
| 1559 | `.ofd-findbar__option` | 2px | inline-flex row | 同上 |
| 1619 | `.ofd-dialog` | 12px | column | `margin-top:12px` |
| 1630 | `.ofd-dialog__header` | 8px | row | `margin-left:8px` |
| 1651 | `.ofd-dialog__body` | 8px | column | `margin-top:8px` |
| 1667 | `.ofd-dialog__footer` | 8px | row | `margin-left:8px` |
| 1712 | `.ofd-output-form` | 10px | column | `margin-top:10px` |
| 1721 | `.ofd-output-field` | 4px | column | `margin-top:4px` |
| 1732 | `.ofd-output-check` | 6px | row | `margin-left:6px` |
| 1814 | `.ofd-toast` | 8px | row | `margin-left:8px` |
| 1820 | `.ofd-toast__message` | 6px | column | `margin-top:6px` |
| 2059 | `.ofd-credential-form__modes` | 16px | **wrap** | 半间距 8px |
| 2066 | `.ofd-credential-form__mode` | 6px | inline-flex row | `margin-left:6px` |
| 2089 | `.ofd-verification-header` | 8px | **wrap** | 半间距 4px |
| 2326 | `.ofd-verification-root` | 8px | column | `margin-top:8px` |
| 2369 | `.ofd-signature-popover__header` | 8px | row | `margin-left:8px` |
| 1869 | `.ofd-viewer[data-viewport='narrow'] .ofd-viewer__toolbar` | 2px | 覆盖 234 的窄屏值 | 回退规则同样加窄屏覆盖（`margin-left:2px`），或让 234 的回退用变量并在 1869 改变量 |

TS 内联（必须处理，内联样式无法被 CSS 回退覆盖）：

| 位置 | 写法 | 处理 |
| --- | --- | --- |
| `ui/src/signature/service.ts:1084` | `display:flex; gap:'8px'` | 抽成 CSS 类（如 `.ofd-signature-detail__status`），用本节回退；不要保留内联 gap |
| `ui/src/signature/service.ts:1328` | `display:flex; flexDirection:'column'; gap:'12px'` | 抽成 CSS 类，column 回退用 `margin-top` |
| `ui/src/signature/service.ts:1353` | `display:grid; gap:'4px 10px'` | grid gap 67 支持，保留内联即可 |

site（3 条 / 2 容器）：

| 行 | 选择器 | gap | 处理 |
| --- | --- | --- | --- |
| 74 | `.dock` | `6px 10px` + `flex-wrap: wrap` | 半间距（row 6 / col 10），容器负 margin 分别为 -3px/-5px |
| 119 | `.field` | 5px，inline-flex | `> * + * { margin-left:5px }` |
| 201 | `@media (max-width:720px) .dock` | 覆盖为 `6px` | 半间距 3px；与 74 的规则合并/覆盖，避免同时生效 |

### 5.2 grid gap：保持

17 条 grid gap（UI 16 + TS 1）在 Chrome 57 已支持，包括 `gap: 4px 12px` 这类双值。**不写回退、不改 grid 布局**；卡口必须能区分 `display:grid` 与 flex，避免误报。

### 5.3 `:where()` / `:is()` 展开与优先级

#### 特异性规则

- `:where()` 的特异性为 **0**；展开成普通选择器后，参数里的每个属性选择器各贡献 `(0,1,0)`。例如：
  - `.ofd-viewer:where([data-viewport='mobile']) .ofd-x`：原特异性 `(0,2,0)`；展开为 `.ofd-viewer[data-viewport='mobile'] .ofd-x` 后是 `(0,3,0)`。
  - `.ofd-dialog__action:where(.is-secondary)`：原 `(0,1,0)`；展开后 `(0,2,0)`。
- `:is()` 的特异性取参数列表中的**最大值**；本仓库 3 处参数都是属性选择器 `(0,1,0)`，展开为逗号列表后特异性不变。` :is()` 是“宽容选择器列表”，逗号列表是“任一无效则整条无效”；本仓库参数都合法，无差异。

#### 展开方法

- `:is()`：把每个参数与其余部分组合成完整选择器，用逗号连接。示例（1486）：
  ```css
  .ofd-viewer__sidebar[data-mode='overlay'] .ofd-sidebar__panel,
  .ofd-viewer__sidebar[data-mode='drawer'] .ofd-sidebar__panel { /* ... */ }
  ```
- `:where()`：同样逐参数展开为逗号列表；由于特异性升高，**必须逐条审计**是否改变了与其他规则的胜负关系。15 条规则分三类：
  1. 溢出菜单标记（1380、1399）：`.ofd-more-menu__item[data-menu-visibility='overflow']`、`[data-overflow='compact']`；原 `:where` 是为了零特异性让状态属性覆盖基础样式；展开后 `(0,1,0)`，需要确认不会被更早/更晚的 `.ofd-more-menu__item` 规则盖住。
  2. 侧栏基础（1433）与 mobile/narrow 覆盖（1445、1590、1696、1843、1847、1852、1856、1860、1865）：这些规则大多以 `.ofd-viewer[data-viewport='mobile'|'narrow'] ...` 出现，展开后特异性 +1 个属性；它们位于文件后部，通常会赢，但必须确认不会压过 `[data-sidebar-open]`/`[data-mode]` 的状态规则。
  3. 组件局部（1899 `.ofd-dialog__action`、1957 `.ofd-findbar__option`、1964 `.ofd-sidebar__close`）：展开后 +1 属性；确认与 `:hover`/`:focus`/`[aria-pressed]` 等规则的先后关系。
- 不允许“保留 `:where` 再补一份展开副本”的双写：现代内核会同时应用两份（一份零特异性、一份 +1），在与其他规则竞争时可能与 67 分叉；统一展开。

审计方法（必须在实现阶段执行）：

1. 对 15 条 `:where` 规则相关元素，在 1440×900、1023×800、767×800、479×800 四种宽度下，用现代 Chrome 读取 `getComputedStyle` 的受影响属性（display/width/height/padding/margin/position/inset/overflow/visibility）。
2. 对比展开前后（同一现代 Chrome、同一页面）的 computed style 与截图；再在 67 上对比展开后的结果与现代 Chrome 展开后的结果。
3. 若发现 cascade 翻转：优先调整规则顺序/提高选择器精度以显式表达意图，而不是恢复 `:where`。

### 5.4 `min()` / `max()` / `env()` 回退

原则：优先**等价改写**，避免依赖 `@supports`；自定义属性必须用 `@supports` 门控（旧内核里含 `min()` 的自定义属性是 IACVT，消费处 `var()` 会变 invalid，无法用“前面的声明”兜底）。

| 行 | 现声明 | 建议 |
| --- | --- | --- |
| 939 | `width: min(480px, calc(100% - 32px))` | `width: calc(100% - 32px); max-width: 480px;`（等价） |
| 956 | `max-width: min(360px, calc(100% - 24px))` | 旧值 `max-width: calc(100% - 24px)`；再写 `max-width: min(...)`。旧内核失去 360px 上限，桌面端 toast 可能变宽，属可接受视觉差异；如需严格，改成 `width: fit-content; max-width: min(...)` 并接受旧内核不具备上限 |
| 1010 | `width: min(360px, 100%)` | `width: 100%; max-width: 360px;`（等价；确认 loading panel 的父容器宽度） |
| 1127 / 1446 | `--ofd-sidebar-width: min(80vw, 280px)` | 基值 `--ofd-sidebar-width: 280px;` 后，用 `@supports (width: min(1px, 2px)) { ... --ofd-sidebar-width: min(80vw,280px) }`。**该 @supports 在 67 的求值 [待验证]**；若 67 误判为 true，需改为 JS compat 在窄屏设置固定 px 值（备选方案） |
| 1325 | `max-width: min(80vw, 18rem)` | 旧值 `max-width: 80vw;` 再写 `min(...)`；丢失 18rem 上限，桌面菜单可能更宽，回归确认 |
| 1622 | `width: min(520px, calc(100% - 32px))` | `width: calc(100% - 32px); max-width: 520px;` |
| 1717 | `min-width: min(320px, 70vw)` | `min-width: 320px;`（旧值）；窄屏加 `@media (max-width: 480px) { min-width: 0; }`，避免 320px 在 390px 视口溢出；现代保留 `min()` |
| 2034 | `min-width: min(360px, 72vw)` | 同上，360px + 窄屏 `min-width:0` |
| 2084 | `max-height: min(70vh, 640px)` | 旧值 `max-height: 70vh;` 再写 `min(...)`；丢失 640px 上限，超高视口下面板更高，回归确认 |
| 2359 | `width: min(320px, 76vw)` | `width: 76vw; max-width: 320px;`（等价） |
| site 172 | `max-width: min(560px, calc(100vw - 32px))` | 旧值 `max-width: calc(100vw - 32px);` 再写 `min(...)`；桌面 toast 可能超过 560px，接受或加 `width: fit-content` |

`max()`/`env()`（site）：

```css
.dock {
  bottom: 14px; /* Chrome 67 */
  bottom: max(14px, env(safe-area-inset-bottom));
}
@media (max-width: 720px) {
  .dock {
    bottom: 10px;
    bottom: max(10px, env(safe-area-inset-bottom));
  }
}
```

注意：`.dock` 的 `width: max-content` 是 Chrome 46+，可用；`max-width: calc(100vw - 24px)` 可用。

### 5.5 `inset` 回退

`inset` 在 Chrome 87 才有；67 会把整条声明丢弃。必须改为四边：

| 位置 | 现写法 | 改为 |
| --- | --- | --- |
| `ui/src/style.css:1702` `.ofd-viewer--fullscreen-fallback` | `inset: 0;` | `top: 0; right: 0; bottom: 0; left: 0;` |
| `ui/src/page-view.ts:167` canvasWrapper | `inset: '0'` | `top/right/bottom/left: '0'` |
| `ui/src/page-view.ts:175` textLayer | 同上 | 同上 |
| `ui/src/page-view.ts:184` signatureLayer | 同上 | 同上 |
| `site/style.css:59` `ofd-viewer` | `inset: 0;` | 四边 |
| `site/style.css:110` `.file-button input[type='file']` | `inset: 0;` | 四边 |

重要性：`.ofd-viewer--fullscreen-fallback` 失去 `inset` 后是一个没有定位的 `position:fixed` 元素，67 上沉浸式全屏（无原生 Fullscreen 时的唯一全屏路径）**不可用**；页面三层的 `inset` 丢失会导致 canvas/文本/签章层无法铺满页面，属于功能缺陷，不是观感差异。

### 5.6 `:focus-visible`：`:focus` 回退 + 抑制规则

为什么不能用 `@supports selector(:focus-visible)`：`@supports selector()` 需要 Chrome 83；67 会丢弃整条 `@supports` 规则，无法作为回退门控。

方案：

1. 为每条 `:focus-visible` 规则增加同选择器的 `:focus` 基础规则（放在 `:focus-visible` 规则之前，声明相同或更保守）。67 命中 `:focus`；现代内核两条都命中，后者覆盖前者，效果一致。
2. 在样式末尾加一条**仅现代生效**的鼠标焦点抑制规则：

```css
/* chrome67: focus fallback — 67 丢弃整条含未知伪类的规则 */
.ofd-viewer :focus:not(:focus-visible) {
  outline: none !important;
}
```

   67 不支持 `:focus-visible`，整条规则被丢弃；现代内核在鼠标点击（非键盘）时抑制 outline。副作用：Chrome 对文本框的 `:focus-visible` 启发式是“始终可见”，该抑制规则会让鼠标点击文本框时也不显示 outline；这是可接受的视觉差异，需在回归中记录。
3. 14 条 UI 规则（295,507,718,723,864,1358,1362,1508,1524,1686,1692,1752,1765,1769）与 site 1 条（136,138）都要成对补齐；卡口检查每个 `:focus-visible` 选择器都能找到对应的 `:focus` 前置规则。

备选（不采用，P2 可评估）：JS focus-visible polyfill（监听 pointerdown/keydown，给元素加 `data-focus-visible`）；代码量与事件泄漏风险更高。

### 5.7 color-scheme / prefers-* / 其它观感特性

这些**不改**，只登记为降级（§2.2 S4–S8、§2.3 C9–C16）：

- `color-scheme`：保留 `light`/`dark` 声明；67 忽略。`theme="auto"` 在 67 恒为 light（`theme-controller` 的 `matchMedia('(prefers-color-scheme: dark)')` 恒 false）。显式 `theme="dark"` 仍通过 `[data-theme='dark']` 生效，需在 67 上截图确认主要区域（工具栏、侧栏、对话框、签章面板）没有浅色穿透。
- `prefers-reduced-motion`：动效仍播放；无功能影响。若宿主对动效有硬性要求，应在宿主层处理，不新增 UI 公共选项。
- `prefers-contrast`、`accent-color`、`scrollbar-width`、`text-underline-offset`：忽略；回归时确认滚动条宽度变化不导致工具条/侧栏裁切。
- `backdrop-filter`：site `.dock` 增加 `-webkit-backdrop-filter: blur(12px);` 再写标准属性；67 是否支持前缀 [待验证]，不支持时 dock 仍是半透明背景（已有 `background: var(--dock-bg)`），可读性可接受。
- `appearance: textfield`：保留；页码输入框的箭头已由 `::-webkit-inner-spin-button` 隐藏，67 上无需额外处理。

### 5.8 打印 CSS（命名页降级）

现状（`ui/src/print/print-document.ts:233-273`）：

- 统一尺寸：`@page { size: <w>mm <h>mm; margin: 0 }`；Chrome 15+ 支持。
- 混合尺寸：`@page { size: auto }` + 每个尺寸组 `@page ofd-size-N { size: ... }` + 页面节点 `page: ofd-size-N`；`page` 属性 Chrome 85，67 忽略 → 所有页按 `size:auto`（打印机默认）输出，页面节点的 mm 宽高仍在，可能被裁切或缩放错位。

实现要求：

1. 用双门控判断命名页能力：Chromium 主版本 ≥85（解析 UA 的 `Chrome`/`HeadlessChrome`/`CriOS`）且 `CSS.supports('page', 'ofd-size-0')` 为 true。Chrome 67 的 `CSS.supports` 返回 true 但命名页实际不生效（`Page.printToPDF` 两页均 612×792），不能单凭 `CSS.supports` 判断；非 Chromium 系一律按不支持处理。
2. 不支持时走**统一纸型降级**：取所有页的最大宽/高（或第一页），生成单一 `@page { size: <w>mm <h>mm }`；每个 `.ofd-print-page` 用 `max-width/max-height: 100%` 与 `object-fit: contain`（图片已有 `object-fit: contain`，见 style.css 1225-1230）适配，保证不裁切关键内容。
3. 打印按钮/流程不新增公共选项；`OFDViewer.print()` 的签名与事件不变。
4. Chrome 67 实测命名页尺寸不生效（见 `docs/verification/chrome67-verification.md` 的 F1），因此 67 必须走降级；验收以“纸张尺寸正确、每页完整、无横向裁切”为准，允许混合尺寸降级为统一纸型。

### 5.9 CSS 回归验收

- 断点：1440×900、1023×800、767×800、479×800、390×844（对应现有 layout.spec 的 desktop/compact/mobile/narrow）。
- 主题：light、dark、auto（67 上 auto 预期 light）。
- 状态：侧栏 inline/overlay/drawer、工具栏溢出菜单、查找栏、签章面板、验证面板、凭据对话框、加载/错误/空态、toast。
- 打印：单页、统一多页、混合尺寸（67 降级）、旋转页。
- 对比方式：现代 Chrome 截图 + 67 截图；67 不可得时按 §6.3 记录“未验证”，不得声称通过。

---

## 6. 测试与验收方案

### 6.1 分层

| 层 | 目的 | 环境 | 是否 CI 阻塞 |
| --- | --- | --- | --- |
| L1 静态卡口 | 防止回退：源码禁用 API、产物语法、CSS 特性、构建目标 | Node 26 | 是 |
| L2 单元/集成 | compat 幂等与语义、现有 engine/crypto/ui 单测 | Node/jsdom | 是 |
| L3 现代 Chrome E2E | 功能/布局/打印/签章回归 | Playwright + 系统 Chrome 145 | 否（沿用现状，本地/专用环境） |
| L4 Chrome 67 冒烟 | 真实旧内核打开/交互/截图/console | Chromium 67 | 否；环境不可得时记录“未验证” |
| L5 人工验收 | 视觉差异、打印纸型、降级项确认 | 人 | 发布检查单 |

### 6.2 命令清单

现有命令（不改）：

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test                         # engine vitest
pnpm test:smoke
pnpm test:golden
pnpm -C packages/ofdrw-viewer-engine run test:audit
pnpm -C packages/ofdrw-viewer-crypto test
pnpm -C packages/ofdrw-viewer-ui test
pnpm -C packages/ofdrw-viewer-ui exec playwright test test/e2e/layout.spec.ts
pnpm -C packages/ofdrw-viewer-ui exec playwright test test/e2e/output.spec.ts
pnpm -C packages/ofdrw-viewer-ui exec playwright test test/e2e/signature.spec.ts
pnpm -C packages/ofdrw-viewer-ui exec playwright test   # 全量，较慢
pnpm -C site build
pnpm -C site preview
```

新增命令（实现阶段 P1 建立）：

```bash
pnpm check-compat          # 构建目标 + 源码 API + CSS + 内联样式
pnpm check-compat:dist     # 产物语法 + 产物 CSS（需先 pnpm build）
```

验收命令（本规格任务可复现的核对）：

```bash
# G1：现状计数（应输出本文表格中的数量）
python3 scripts/compat/report-counts.py

# G2：产物语法扫描（现状应非 0；实现后应为 0）
pnpm check-compat:dist

# G3：compat 求值顺序（由 check-compat:dist 的运行时探针执行）
pnpm check-compat:dist
# 辅助：查看入口前几行是否引用 compat（不作为唯一判据）
grep -n "compat" packages/ofdrw-viewer-engine/dist/index.js | head -3

# G4：crypto BigInt 目标回归
pnpm -C packages/ofdrw-viewer-crypto typecheck
```

### 6.3 旧内核获取方式

**目标**：在 Linux x64 上获得一个可启动、UA 为 Chrome 67 的浏览器；优先 Chromium 67 快照，其次容器镜像。

#### 方案 A：Chromium 快照（推荐，已验证下载可用）

```bash
mkdir -p .cache/chrome67 && cd .cache/chrome67
curl -fL --retry 3 -o chrome-linux.zip \
  https://commondatastorage.googleapis.com/chromium-browser-snapshots/Linux_x64/555668/chrome-linux.zip
unzip -q -o chrome-linux.zip
./chrome-linux/chrome --version
```

事实（[已验证] 2026-10-24）：

- 修订号 **r555668** 的快照存在，zip 约 102 MB，构建时间 2018-05-03；`REVISIONS` 内容含 `chromium_revision: 555668`。
- Puppeteer **1.4.0** 的 `package.json` 中 `puppeteer.chromium_revision = 555668`（npm 发布时间 2018-05-09）；Puppeteer 1.3.0=r549031（2018-04-07）、1.5.0=r564778（2018-06-06，已是 Chrome 68 线）。
- 因此 r555668 是 Chrome 67 分支的构建；**具体 `--version`/UA 补丁号 [待验证]**（需下载后实际启动确认，预期 `67.0.3396.x`）。
- Chrome 67 稳定补丁版本：`67.0.3396.62`（2018-05-29）、`.79`、`.87`（2018-06-12）、`.99`（2018-06-25），来源 ChromiumDash；Google 官方旧版 `.deb` 下载链接是否仍可用 [待验证]。
- 启动依赖：若 `chrome --version` 报缺库，用 `ldd chrome-linux/chrome | grep 'not found'` 记录缺库并安装（libnss3/libatk/libgbm 等）；无法安装时按“不可获取”记录。

#### 方案 B：容器镜像（标签已验证存在）

```bash
docker run --rm -v "$PWD:/work" -w /work cypress/browsers:chrome67 google-chrome --version
# 需要访问宿主机服务时：
docker run --rm --add-host=host.docker.internal:host-gateway -v "$PWD:/work" -w /work \
  cypress/browsers:chrome67 google-chrome --headless --no-sandbox --disable-gpu \
  --dump-dom http://host.docker.internal:5183/
```

事实（[已验证] 2026-10-24）：Docker Hub `cypress/browsers:chrome67` 标签存在（HTTP 200，最后更新 2020-02-07）；镜像内 Chrome 的具体版本 [待验证]。本机 Docker 29.3.0 可用。

#### 方案 C：Puppeteer 1.4.0（不推荐，仅备选）

```bash
mkdir -p .cache/puppeteer14 && cd .cache/puppeteer14
npm init -y && npm i puppeteer@1.4.0
node -e "const p=require('puppeteer'); (async()=>{const b=await p.launch({args:['--no-sandbox']}); const pg=await b.newPage(); console.log(await b.version()); await pg.goto('http://127.0.0.1:5183/'); console.log(await pg.title()); await b.close();})()"
```

风险：Puppeteer 1.x 的安装脚本/依赖在 Node 26 下可能失败（[待验证]）；优先用方案 A 的快照 + 直接 headless。

#### 方案 D：Playwright 1.64.1 直接驱动旧 Chrome（预期不可行，需实测记录）

现有 `packages/ofdrw-viewer-ui/playwright.config.ts` 用 `channel: 'chrome'`（系统 Chrome 145）。尝试：

```bash
CHROME67=.cache/chrome67/chrome-linux/chrome
pnpm -C packages/ofdrw-viewer-ui exec playwright test test/e2e/layout.spec.ts \
  --project=chrome67 2>&1 | tee .cache/chrome67/playwright-attempt.log
# 需先在配置里临时加 project：use.launchOptions.executablePath=CHROME67
```

预期：Playwright 1.64 使用现代 CDP，Chrome 67 的协议/特性不匹配，启动或导航失败；**结论 [待验证]**，失败按“不可获取”记录，不修改正式 Playwright 配置去支持 67。

#### 不可获取时的记录规范

若以上方案都无法启动 67：

1. 在 `docs/compat/verification/YYYY-MM-DD-chrome67.md`（新建，随实现提交）记录：
   - 目标版本/修订号、下载 URL 与 SHA256（`sha256sum chrome-linux.zip`）；
   - 尝试日期、OS/内核、Node/pnpm/Playwright/Docker 版本；
   - 每条命令的退出码与关键错误（`ldd` 缺库、容器启动错误、协议错误）；
   - 已尝试的方案 A–D 与失败阶段；
   - 结论只能是 `environment-unavailable`，**不得写“通过/已验证”**。
2. 在本文附录 A 对应条目标注“未验证（环境缺失）”，不要删除条目。
3. CI/release 检查单增加一项：“Chrome 67 冒烟：已执行并附证据 / 环境不可得并已记录”；未勾选不得发布。
4. 不把浏览器二进制提交仓库；统一放 `.cache/chrome67/`（`.gitignore` 已忽略 `/.cache/`）。

### 6.4 Chrome 67 冒烟用例（可在获取环境后执行）

服务：

```bash
pnpm build
pnpm -C site build
pnpm -C site preview --port 5183   # 或 python3 -m http.server 5183 --directory site-dist
```

用例（每条记录通过/失败/截图/console 错误）：

| ID | 场景 | 判据 |
| --- | --- | --- |
| T1 | 打开 `http://127.0.0.1:5183/?file=/samples/doc1File.ofd` | 页面渲染出 canvas；无 `ReferenceError/TypeError`；工具栏/页码/缩放可见 |
| T2 | 换页、缩放、旋转 | 页码/画布更新；文本层不错位（`page-view` 的 inset 修复） |
| T3 | 侧栏：缩略图/大纲/书签 | 列表出现；overlay/drawer 模式布局正确（`:is` 展开） |
| T4 | 查找与选区 | 查找结果高亮；拖选后复制可用（`execCommand` 回退） |
| T5 | 签章面板 | 打开/关闭、焦点恢复（`replaceAll`）、详情布局（flex gap 回退） |
| T6 | 导出 PNG/JPEG、打印 | 导出成功下载；打印预览纸张与页数正确（混合尺寸按 §5.8 降级） |
| T7 | 取消（快速换文档/关闭） | 操作被取消且无未捕获异常；不断言 `reason` 文本 |
| T8 | 全屏 | 走沉浸式回退（`W_FULLSCREEN_FALLBACK`）；回退层铺满视口（inset 修复） |
| T9 | 主题 light/dark/auto | dark 显式生效；auto 预期 light（记录） |
| T10 | 移动视口 390×844 | 布局切到 narrow；无水平滚动条；dock（site）位置正确（max/env 回退） |

无 CDP 框架时的最小自动化：

```bash
CHROME=.cache/chrome67/chrome-linux/chrome
"$CHROME" --headless --no-sandbox --disable-gpu --allow-file-access-from-files \
  --window-size=1440,900 --virtual-time-budget=15000 \
  --dump-dom "http://127.0.0.1:5183/?file=/samples/doc1File.ofd" \
  > .cache/chrome67/dom-1440.html 2> .cache/chrome67/console-1440.log
# 断言：DOM 中存在 canvas、.ofd-viewer、页码；console 无 ReferenceError/TypeError
grep -E "ReferenceError|TypeError" .cache/chrome67/console-1440.log && exit 1
"$CHROME" --headless --no-sandbox --disable-gpu --window-size=1440,900 \
  --screenshot=.cache/chrome67/site-1440.png "http://127.0.0.1:5183/?file=/samples/doc1File.ofd"
```

说明：Chrome 67 的 `--headless` 是老 headless，支持 `--dump-dom`/`--screenshot`/`--virtual-time-budget`；若 `--dump-dom` 在异步渲染完成前结束，用 `--virtual-time-budget` 延长并保留 DOM 供人工核对。需要交互（换页/查找/签章）时，用 Puppeteer 1.4 或 `chrome-remote-interface`（现代 Node 包，协议方法 `Runtime.evaluate`/`Page.navigate`/`Page.captureScreenshot` 在 67 存在）[待验证]。

### 6.5 现代 Chrome 回归（每次实现改动后）

| 场景 | 命令/参数 | 判据 |
| --- | --- | --- |
| 桌面 1440×900 | `playwright test test/e2e/layout.spec.ts` | desktop 断点、侧栏 inline、mask 显示、窗口 resize 正确 |
| 移动 390×844 | 同上（用例已覆盖） | narrow 断点、drawer、无水平溢出 |
| 断点 1023/767/479 | 同上 | compact/mobile/narrow 切换正确 |
| 打印 | `playwright test test/e2e/output.spec.ts` | 打印页数、纸张尺寸、缩放、旋转、下载 |
| 签章面板 | `playwright test test/e2e/signature.spec.ts` | 面板打开/关闭、焦点、布局、验签状态 |
| 全量 | `playwright test` | 无新增失败 |
| 站点 | `pnpm -C site build` + 手工打开 preview | 控制台无 404/语法错误；主题/语言/文件打开正常 |

Playwright 配置固定 `viewport: 1440×900`、`channel: 'chrome'`（系统 Chrome 145.0.7632.116）、`workers: 1`；现有用例已在 `layout.spec.ts` 覆盖 1440×900、390×844、1023/768/767/480/479 断点，不需要新增 Playwright project 来跑现代 Chrome 回归。

### 6.6 通过标准与豁免

实现任务“完成”的最低标准：

1. `pnpm check-compat` 与 `pnpm check-compat:dist` 退出 0。
2. `pnpm build`、`pnpm typecheck`、engine/crypto/ui 单测全部通过（沿用 CI 的口径）。
3. 现代 Chrome 的 layout/output/signature 三个 spec 通过（本地或专用环境）。
4. Chrome 67：T1–T10 全部执行；通过项附截图/日志；失败项必须修复或降级并写入本文；环境不可得时按 §6.3 记录，**不得伪造通过**。
5. 降级项（§2.2）在文档中逐条确认，不在代码里假装支持。

豁免：

- CI 不阻塞 Chrome 67 浏览器测试（环境不可保证）；但静态卡口必须阻塞。
- 打印的纸型差异若由打印机驱动导致，记录为环境差异，不算产品失败；混合尺寸在 67 的“统一纸型”属预期降级。

### 6.7 CI 接入

`.github/workflows/ci.yml` 现有步骤：install → `pnpm build` → typecheck → engine 单测（排除 golden/e2e/acceptance/performance）→ crypto → ui → cli → `pnpm -C site build`。新增：

```yaml
- run: pnpm check-compat
- run: pnpm check-compat:dist
```

放在 `pnpm build` 之后、测试之前；`pages.yml` 的构建会自动使用新目标，不需要额外步骤。`release.yml` 增加同样的两条卡口（发布前必须过）。

`check-compat` 的实现契约（供实现任务）：

| 脚本 | 输入 | 规则 | 退出码 |
| --- | --- | --- | --- |
| `scripts/compat/check-targets.mjs` | 配置文件文本 | engine/crypto/ui tsup target、engine/crypto CDN target、site Vite target 必须为 `chrome67` | 0/1 |
| `scripts/compat/check-api.mjs` | `packages/*/src/**/*.ts` | 使用 TypeScript 编译器 API 解析；禁止未覆盖 API（`structuredClone`、`Object.hasOwn`、`Array.prototype.at`、`Promise.any`、`crypto.randomUUID`、`WeakRef`、`FinalizationRegistry`、`AbortSignal.timeout/any`、`CompressionStream`、`TextDecoderStream`）；统计并输出已覆盖 API 数量（A1–A8），不因已覆盖数量失败 | 0/1 |
| `scripts/compat/check-syntax.mjs` | `packages/*/dist/**/*.{js,cjs}`、`site-dist/assets/*.js` | TypeScript 词法/AST 扫描：`QuestionDotToken`、`QuestionQuestionToken`、`\|\|=`/`&&=`/`??=`、类字段、`PrivateIdentifier`、静态块、数字分隔符、`export * as`、import attributes；忽略字符串/注释 | 0/1 |
| `scripts/compat/check-css.mjs` | `ui/src/style.css`、`site/style.css` | 解析规则/声明：flex/inline-flex 的 `gap` 必须在同文件存在 `[data-ofd-flex-gap='none']` 对应的 margin 回退；`:where()`/`:is()` 为 0；`inset:` 为 0；flex 的 `min()/max()/env()` 必须有前置同属性回退或 `@supports` 门控；`:focus-visible` 必须有对应 `:focus` 规则；grid gap 允许 | 0/1 |
| `scripts/compat/check-inline-style.mjs` | `packages/*/src/**/*.ts` | 扫描 `Object.assign(el.style, {...})`/`style.xxx =`：禁止 `inset`；flex `gap` 不允许内联（grid `gap` 允许） | 0/1 |
| `scripts/compat/check-runtime.mjs` | `packages/*/dist/*.js` | engine/crypto：Node 中删除 `Promise.allSettled`/`Blob.arrayBuffer` 后 `import()`，断言补回；UI：jsdom 中删除 `Object.fromEntries`/`replaceChildren`/`queueMicrotask` 后 `import()` 四个入口，断言补回且不抛错（验证 compat 先于 `features.ts` 顶层求值） | 0/1 |
| `scripts/compat/report-counts.py` | 源码/产物 | 输出本文表格的计数，供人工核对；不作为阻塞 | 0 |

依赖：`postcss` 需要作为根 `devDependency` 新增（CSS 解析）；TypeScript 已是根 devDependency。卡口脚本不引入浏览器。

---

## 7. 风险与缓解

| ID | 风险 | 概率/影响 | 缓解 | 阶段 |
| --- | --- | --- | --- | --- |
| R1 | 全局 polyfill 污染宿主环境，或与宿主已有 polyfill 冲突 | 中/中 | 只在缺失时定义、非枚举、幂等、`Symbol.for` 标记；不覆盖原生；发布说明写明“会自动安装最小补丁”；宿主可提前 `import '@ofdrw/.../compat'` 控制时机 | P1 |
| R2 | `sideEffects` 改动导致 tree-shaking 行为变化，或 compat 被误删 | 中/高 | engine/crypto 用数组只标记 compat；CI 检查 `dist/compat.js` 存在且入口首行引用；UI 不动 sideEffects | P1 |
| R3 | `:where()` 展开导致 cascade 翻转，移动端/状态样式错乱 | 中/高 | 15 条逐条审计；四断点 computed style 对比；必要时显式调整选择器而非恢复 `:where` | P3 |
| R4 | flex gap 探测误判（67 接受 `gap` 属性但不生效） | 中/中 | 用真实布局测量而不是 `CSS.supports`；在 67 与现代 Chrome 各跑一次探测；探测失败时保守地按“不支持”处理 | P4 |
| R5 | margin 回退在换行容器上产生边缘位移/裁切 | 高/低 | 半间距 + 负 margin；4 个 wrap 容器逐个截图；必要时改 `margin-right/bottom` 方案 | P4 |
| R6 | Fullscreen 回退仍不可用（inset 修复遗漏/层级问题） | 中/高 | 必须修 `inset`；67 上 T8 验证；可选 P2 加 `webkit` 前缀桥接（需额外测试） | P3/P5 |
| R7 | 混合尺寸打印在 67 退化后裁切内容 | 中/中 | 检测 `page` 支持；降级为统一纸型 + `object-fit: contain`；T6 人工核对 | P5 |
| R8 | external 依赖语法导致 67 ESM 失败 | 高/中 | CDN 包为“保证路径”；接入文档说明宿主需转译依赖；不改 bundled 策略 | P2/P6 |
| R9 | 旧内核不可获取，67 验证长期缺失 | 中/高 | 方案 A–D + 记录规范；发布检查单禁止未记录就发布；不伪造通过 | P5 |
| R10 | 构建目标改动引入产物回归（treeshake/helper 变化） | 中/中 | 改后跑全量单测 + golden + e2e；对比产物大小与 sourcemap；逐包提交便于回滚 | P1 |
| R11 | `AbortSignal.reason` 丢失导致依赖 reason 的宿主逻辑异常 | 低/中 | 文档明确降级；引擎错误仍带 `OFD_ABORTED`；测试只断言取消状态 | P2 |
| R12 | CSS 回退规则与后续 UI 改版冲突（新加 flex gap 未补回退） | 中/中 | `check-css` 卡口强制成对；PR 模板提示 | P6 |
| R13 | 打印/全屏/主题降级被误认为缺陷 | 中/低 | 本文 §2.2 列表 + 发布说明；验收单列“降级确认” | P6 |

---

## 8. 分阶段计划与回滚

每个阶段独立提交，便于单独回滚；提交信息带 `compat(chrome67):` 前缀。

### P0 规格与卡口（本任务）

- 交付本文档；确定目标矩阵、compat 契约、CSS 策略、验收命令。
- 回滚：删除本文档即可，不影响代码。

### P1 构建目标 + compat 骨架

- 改 engine/crypto/ui tsup target、engine/crypto CDN target、site Vite target（§4.2）。
- 新增三包 `src/compat.ts` + 入口首行 import + exports/sideEffects（§3.4）。
- tsup entry 增加 compat；UI 四入口统一。
- 新增 `scripts/compat/*` 与根 scripts；CI 接入。
- 验收：`pnpm build && pnpm check-compat && pnpm check-compat:dist`，单测通过。
- 回滚：还原 5 处 target、package.json exports/sideEffects、tsup entry，删除 compat 文件与入口 import、删除卡口脚本/CI 步骤；`pnpm build && pnpm test`。

### P2 API 覆盖验证

- 逐项验证 A1–A8 在 67 缺失时由 compat 补齐；补 compat 单测（删除全局后安装、幂等、边界）。
- 处理 `AbortSignal.reason` 降级（不改代码，补测试断言）。
- 验收：engine/crypto/ui 单测；CDN 自检；`check-compat:dist` 语法为 0。
- 回滚：仅回滚 compat 单测/实现；若 compat 有缺陷，可先禁用入口 import（但 sideEffects 保持），恢复原行为。

### P3 CSS 功能修复（inset / min / env / focus / :where / :is）

- 先修 `inset`（全屏回退与页面层，功能缺陷）。
- 再修 `min()/max()/env()`、`:focus-visible`、`:where`/`:is`。
- 验收：现代 Chrome 四断点 + 打印 + 签章；67 T2/T3/T5/T8。
- 回滚：按注释块逐块还原；每类一个 commit（inset / min-max / focus / where-is）。

### P4 flex gap 探测与回退

- UI compat 探测 + `data-ofd-flex-gap`；29 个 CSS 容器 + 2 个 TS 内联 + site 2 个容器回退。
- 验收：现代 Chrome 无“双倍间距”；67 无“零间距”；wrap 容器截图。
- 回滚：删除能力属性设置 + 所有 `[data-ofd-flex-gap='none']` 块；恢复 TS 内联 gap。

### P5 打印/全屏/主题降级验证 + 旧内核冒烟

- 打印命名页检测与统一纸型降级；67 环境获取（方案 A 优先）；执行 T1–T10；记录证据。
- 验收：§6.4 全部用例有结论；不可获取按 §6.3 记录。
- 回滚：打印降级逻辑可单独还原到原混合尺寸实现；67 验证记录不回滚（文档保留）。

### P6 文档同步、卡口收紧、发布

- 同步 §1.4 列出的文档；更新接入说明（CDN 保证路径、ESM 依赖转译、Worker 约束、降级项）。
- 将 `check-compat` 设为 release 必过；发布检查单加入 67 结论。
- 回滚：文档单独提交，可单独还原；卡口步骤可临时移除但需 Captain 批准。

> 实现说明（P0）：上述分脚本设计在实现阶段合并为根级单脚本 `scripts/check-compat.mjs`（零依赖，内置 `--self-test` 违规样例），覆盖产物语法、缺失 API 覆盖与白名单；CSS 规则由样式回归与现代 Chrome 用例覆盖。命令口径保持 `pnpm check-compat` / `pnpm check-compat:dist`，详见 §9.6。

---

## 9. 宿主接入

本章面向**使用方**（在浏览器、Web Worker、Electron/Tauri 中集成 engine / crypto / ui 的宿主），说明构建目标、polyfill、降级项与已知限制。包内兼容实现与卡口的细节见 §3、§4、§6.7 与 §9.6。

### 9.1 浏览器支持与最低版本

| 包 | 浏览器最低版本 | 说明 |
| --- | --- | --- |
| `@ofdrw/ofdrw-viewer-engine` | **Chrome 67** | 需要 DOM/Canvas 2D，或宿主注入 `createCanvas`；不联网、不读本地文件 |
| `@ofdrw/ofdrw-viewer-crypto` | **Chrome 67** | 源码保留 BigInt 字面量（Chrome 67 原生支持）；产物语法已降到 chrome67 |
| `@ofdrw/ofdrw-viewer-ui` | **Chrome 67** | 需要 DOM/Canvas 2D/Web Component；React/Vue 适配器代码随包降级，框架自身支持范围见 §9.5 |

- 不承诺 Chrome 66 及更低版本，不承诺 IE/早期 WebView。
- **Safari / Firefox 未做旧版本验证**，不要在接入文档或徽章中写未经验证的版本号；如需支持，请先用真实内核跑 §6.4 的 T1–T10。
- 浏览器版本下限由 `/.browserslistrc` 声明（`chrome 67`），构建目标与兼容卡口都以它为准。

### 9.2 构建目标：宿主 build.target 必须为 chrome67

三个包的 `dist` 已按 `chrome67` 产出，**包自身产物不含** `?.`、`??`、私有字段、静态块等 Chrome 67 无法解析的语法。但宿主打包时仍需满足以下条件：

1. **宿主的构建目标必须是 `chrome67`（或更保守的 ES2017）**，不能沿用默认的 `esnext`/`es2020`：
   - Vite：`build.target: 'chrome67'`（站点 `site/vite.config.ts` 即此值）。
   - esbuild：`target: ['chrome67']`。
   - Webpack/Rspack：`target: ['web', 'es2017']` 或通过 Babel/SWC 的 `targets: { chrome: '67' }` 转译。
   - 宿主自己的业务代码如果使用 `?.`/`??`，也必须由宿主构建目标降级；本仓库的兼容层只补运行时 API，不补语法。
2. **external 依赖必须被宿主转译**。engine 的 `fontkit`、`saxes`、`fflate`，crypto 的 `@peculiar/asn1-schema`/`asn1js` 等保持 external（不进入本仓库 `dist`），它们可能含 `?.`/`??`。宿主需让这些依赖经过同一套转译（Vite 的 `optimizeDeps.esbuildOptions.target` / `build.commonjsOptions`，或 esbuild 的 `target`），否则 Chrome 67 仍会在解析依赖时失败。
3. **零构建接入**优先使用已打包依赖的 IIFE 产物：
   - engine：`dist/ofdrw-viewer-engine.js` / `.min.js`，全局 `OFDRWViewer`；
   - crypto：`dist/ofdrw-viewer-crypto.js` / `.min.js`，全局 `OFDRWViewerCrypto`；
   - ui 没有 CDN/IIFE 产物；需要零构建时使用 site 的构建产物，或由宿主以 `chrome67` 目标自行打包。
   IIFE 产物由 esbuild 以 `chrome67` 打包，依赖已内联，不受宿主 external 依赖语法影响。
4. **ESM 产物**（`dist/index.js`、`dist/react.js` 等）可以直接被 `<script type="module">` 或宿主打包器消费；Chrome 67 支持 ESM 与动态 `import()`。若宿主使用 `import()` 懒加载 UI，请确保入口模块仍先求值 `compat`（见 §9.3）。

### 9.3 Polyfill：内置什么、何时安装

**结论：三个包内置“最小 compat”，不是全量 polyfill，不依赖宿主导入 core-js。**

- 各包入口（`src/index.ts` 及 UI 的 `react`/`vue`/`element` 入口）的第一条 import 是 `import './compat'`，模块求值时自动安装一次；安装逻辑只做特性检测，原生已有则完全不覆盖。
- 每个包额外提供 `./compat` 子路径，供宿主/Worker 提前安装：
  ```ts
  // Worker 或需要严格控制时机的宿主
  import '@ofdrw/ofdrw-viewer-engine/compat';
  import '@ofdrw/ofdrw-viewer-crypto/compat';
  import '@ofdrw/ofdrw-viewer-ui/compat';
  // 之后动态加载入口
  const { OFDViewer } = await import('@ofdrw/ofdrw-viewer-ui');
  ```
- **加载顺序不可省**：UI 的 `features.ts` 在模块顶层构建默认功能表（原实现直接调用 `Object.fromEntries`，§2.1-A4；当前实现改为调用 compat 导出的 helper）。无论调用点如何改写，入口首行 `import './compat'` 都必须保留：它保证补丁先于业务模块求值，也保证其他仍直接调用原生 API 的位置可用。宿主不要手动把 `compat` 拆到异步 chunk 之后。
- **副作用声明**：engine/crypto 的 `sideEffects` 从 `false` 改为显式数组（`./src/compat.ts`、`./dist/compat.*`、`./dist/chunk-*`），防止打包器 tree-shake 掉补丁；UI 维持“有副作用”的默认行为。
- **补丁范围**（按包实际使用）：`globalThis`、`Blob/File.prototype.arrayBuffer`、`Promise.allSettled`、`Array.prototype.flatMap`（engine/crypto）；UI 另含 `Object.fromEntries`、`Element/Document/DocumentFragment.replaceChildren`、`String.prototype.replaceAll`、`queueMicrotask`。完整清单与逐项契约见 §2.1、§3.2。
- **幂等与共存**：补丁用 `Symbol.for(...)` 标记、`Object.defineProperty` 非枚举定义，重复导入无副作用；宿主已有的 polyfill 不会被覆盖（只补缺失）。补丁不访问 DOM，可在 Node、Web Worker、VM 沙箱中安装。
- **CSP**：compat 不使用 `eval`/`new Function`（仅 `globalThis` 兜底的极端分支除外，正常浏览器/Node 不触发）。

### 9.4 降级项清单

以下是 Chrome 67 上**功能可用但行为与现代浏览器不同**的项目，接入方需按业务接受或自行兜底。实现不改公共 API，也不伪造原生语义。

| ID | 项目 | Chrome 67 行为 | 宿主可见影响 | 处理方式 |
| --- | --- | --- | --- | --- |
| D1 | `AbortSignal.reason` | 缺失/`undefined`，`abort(reason)` 参数被忽略 | 取消仍以 `OFD_ABORTED` 抛出，但 `reason`/`cause` 为空 | 只判断“已取消”，不要依赖 reason 文案（§2.2-S1） |
| D2 | 无前缀 Fullscreen API | 只有 `webkit*` 前缀，且需用户手势 | `setFullscreen()` 走沉浸式回退并告警 `W_FULLSCREEN_FALLBACK` | 保留回退层；如需原生全屏由宿主自行加前缀桥接 |
| D3 | `@page` 命名页 / `page` 属性 | 不支持（Chrome 85+） | 混合页尺寸打印退化为统一纸型 + 等比适配 | 打印前用“Chromium ≥85 且 CSS.supports”双门控判断；见 §5.8 |
| D4 | `prefers-color-scheme` | 恒 false（Chrome 76+） | `theme="auto"` 解析为 light | 显式传 `theme="dark"`；不要依赖系统深色 |
| D5 | `prefers-reduced-motion` / `prefers-contrast` | 恒 false | 动效照常播放；高对比主题不生效 | 不影响核心功能，接入方可自行覆盖 |
| D6 | `color-scheme` | 不支持（Chrome 81+） | 深色主题下原生滚动条/表单控件仍为浅色 | 记录视觉差异，不阻断功能 |
| D7 | `accent-color` / `scrollbar-width` / `text-underline-offset` | 不支持 | 控件默认色、滚动条宽度、下划线偏移回默认 | 接受默认观感 |
| D8 | `-webkit-backdrop-filter` | 前缀是否生效 [待验证] | 站点 `.dock` 毛玻璃可能退化为半透明 | 已同时写前缀与标准属性；可读性不受影响 |
| D9 | `navigator.clipboard` | 仅安全上下文 + 权限 | 失败时回退 `document.execCommand('copy')` | 生产环境使用 HTTPS；`http://127.0.0.1` 可用于冒烟 |
| D10 | flex `gap` | Chrome 67 支持 `gap` 属性但不用于 flex 布局 | 若不加回退会出现 0 间距 | 运行时布局探测 + `[data-ofd-flex-gap='none']` margin 回退（§5.1）；宿主不要关闭该属性 |
| D11 | 原生拖拽/滚动条细节 | 行为与现代 Chrome 略有差异 | 观感差异 | 记录，不视为缺陷 |

### 9.5 已知不支持项

以下项目在 Chrome 67 上**不可用或超出本仓库承诺**，接入方必须规避或由宿主提供替代能力：

| ID | 项目 | 现状 | 接入建议 |
| --- | --- | --- | --- |
| N1 | React 18/19、Vue 3.3+ **框架自身**在 Chrome 67 运行 | **[待验证]**；本仓库只保证适配器代码与产物语法可被 67 解析 | 若必须支持 67，先在目标内核验证框架；不要把“包兼容 67”误写成“框架兼容 67” |
| N2 | `OffscreenCanvas` / Worker 内直接创建 canvas | Chrome 67 无 `OffscreenCanvas`；engine 在 Worker 中要求宿主注入 `createCanvas`，否则抛 `OFD_RENDERER_UNSUPPORTED` | Worker 场景由宿主传入 `createCanvas`；或退回主线程渲染 |
| N3 | `DecompressionStream` | Chrome 67 无；engine 检测失败后走内置 `fflate` 回退 | 无需宿主处理；回退路径已随包打包 |
| N4 | `CanvasPattern.setTransform` | Chrome 67 无；engine 已有探测与手动平铺回退 | 无需宿主处理；复杂图案可能有细微差异 |
| N5 | 原生全屏 | 无前缀 API 不可用 | 使用沉浸式回退（D2） |
| N6 | `structuredClone`、`Object.hasOwn`、`Promise.any`、`WeakRef`、`FinalizationRegistry`、`AbortSignal.timeout/any`、`Array.prototype.at/findLast`、`CompressionStream` 等更新 API | 未使用、未提供 polyfill | 宿主业务代码不要在这些包里依赖；兼容卡口会拦截未覆盖调用 |
| N7 | `file://` 下的 `navigator.clipboard`/`fetch` | 行为 [待验证] | 开发调试建议用 `http://127.0.0.1`；打开本地文件用 `--allow-file-access-from-files` |
| N8 | SSR / 水合 | 不在范围 | UI 只在浏览器环境使用；Node 侧只使用 engine/crypto 的字节 API |

### 9.6 兼容卡口、配置与 CI

**唯一阻塞卡口**是根级单脚本 [`scripts/check-compat.mjs`](../scripts/check-compat.mjs)（零依赖，Node.js 内置模块）：

```bash
pnpm check-compat          # 扫描 engine/crypto/ui 的 dist 与 site-dist/assets
pnpm check-compat:dist     # 同上，但产物缺失直接失败（CI 使用）
pnpm check-compat:self-test  # 内置违规样例必须失败、合规样例必须通过
node scripts/check-compat.mjs --fixture bad   # 内置违规样例：退出 1
node scripts/check-compat.mjs --fixture good  # 内置合规样例：退出 0
node scripts/check-compat.mjs --help
```

- **语法规则（阻塞）**：`?.`、`??`、`||=`/`&&=`/`??=`、`#私有字段`、`static {}`、数字分隔符、`export * as`。`0n`（BigInt 字面量）只统计不阻塞：Chrome 67 原生支持，crypto 必须保留（§2.1、§4.3）。
- **API 规则**：`replaceChildren`、`replaceAll`、`Object.fromEntries`、`queueMicrotask`、`flatMap`、`Promise.allSettled`、`Blob/File.arrayBuffer` 在产物内找不到对应 compat 补丁定义时阻塞；`structuredClone`、`Object.hasOwn`、`Promise.any`、`WeakRef`、`AbortSignal.timeout/any` 等未覆盖 API 永远阻塞。`Response.arrayBuffer` 自 Chrome 42 起可用，不误报。
- **白名单**：默认放行 `dist/compat*.js` 等补丁入口内部的调用；额外放行可用 `--allow <glob>`，或提交 `scripts/compat-whitelist.json`：
  ```json
  {
    "files": [
      { "glob": "packages/ofdrw-viewer-*/dist/chunk-*.js", "rules": ["api/*"], "reason": "compat 分块" }
    ]
  }
  ```
  白名单只放行 API 规则，语法规则仍会检查。
- **无产物时**：打印缺失目录并提示先 `pnpm build` / `pnpm -C site build`，默认退出 0（避免本地误报）；`--require-dist` 或 `pnpm check-compat:dist` 会退出 2，CI 使用后者。
- **CI**：`.github/workflows/ci.yml` 在全部构建（含 `pnpm -C site build`）之后追加“Chrome 67 兼容卡口”步骤，依次运行 self-test 与 `pnpm check-compat:dist`；不改变原有构建/测试顺序、Node 与 pnpm 版本固定。
- **`.browserslistrc`**：根目录声明 `chrome 67`，作为构建目标、文档与未来 lint 工具的统一事实源。
- **为什么没有接入 eslint-plugin-compat / stylelint+doiuse**：npm registry 可访问，但本仓库当前没有 ESLint/Stylelint 工具链；引入会新增数百个传递依赖并改写 lockfile。更关键的是 `eslint-plugin-compat` 只做静态 API 黑名单，无法识别本仓库“运行时 compat 已覆盖”的事实，会把 A1–A8 全部误报为错误；`doiuse` 是 PostCSS 插件而非 stylelint 插件，需额外引入 `stylelint-no-unsupported-browser-features` 或自写脚本，与 `check-compat.mjs` 的 CSS/API 能力重复。因此本阶段**不接入 lint 插件**，以 `check-compat` 为唯一阻塞卡口；CSS 兼容由样式重写 + 现代 Chrome 回归 + 67 冒烟用例覆盖（§5、§6）。若后续接入，ESLint 需设置 `settings: { browsers: ['chrome 67'] }`，doiuse 需设置 `browsers: ['chrome 67']`，并与根 `.browserslistrc` 保持一致。

### 9.7 版本徽章

根 README、engine README、ui README 均增加了 `Chrome >= 67` 徽章；徽章为纯图片、不包裹链接。徽章只写已验证的最低版本 Chrome 67；**不写 Safari/Firefox 版本**，除非附录 A 对应项已实测通过并回填结论。

---

## 附录 A：待验证清单

| ID | 事项 | 为什么未验证 | 验证方法 |
| --- | --- | --- | --- |
| A-1 | r555668 的 `--version`/UA 是否确为 `67.0.3396.x` | 未下载启动 | 按 §6.3 方案 A 启动并记录 `chrome --version`、`navigator.userAgent` |
| A-2 | Google 旧版 Chrome 67 `.deb` 是否仍可下载 | 未逐 URL 验证 | 尝试 `dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/` 对应版本；失败则记录 |
| A-3 | `cypress/browsers:chrome67` 内 Chrome 具体版本 | 仅验证标签存在，未拉镜像 | `docker run ... google-chrome --version` |
| A-4 | Puppeteer 1.4.0 在 Node 26 下能否安装/启动 | 未安装 | 按 §6.3 方案 C；失败记录 |
| A-5 | Playwright 1.64.1 能否驱动 Chrome 67 | 无 67 二进制；预期不能 | 临时 `executablePath` 跑 layout.spec；记录失败阶段 |
| A-6 | Chrome 67 是否支持 `-webkit-backdrop-filter` | BCD 未给前缀数据 | 67 上读取 `CSS.supports('-webkit-backdrop-filter','blur(1px)')` 与截图 |
| A-7 | Chrome 67 对 `@supports (width: min(1px,2px))` 的求值 | 未实测 | 67 上打开测试页读 `CSS.supports('width','min(1px,2px)')`；据此决定自定义属性方案 |
| A-8 | Chrome 67 的 `CSS.supports('page','ofd-size-0')` | 已实测：返回 true，但命名页尺寸不生效（printToPDF 两页均 612×792） | 结论已回填；打印探测改为 UA ≥85 双门控，见 §5.8 |
| A-9 | `queueMicrotask` BCD 原始 JSON 条目 | BCD 仓库聚合文件未检出（MDN 页面给 Chrome 71） | 复核 MDN/Bcd；不阻塞实现 |
| A-10 | Chrome 67 的 `MediaQueryList.addEventListener` | BCD 未给出 | 67 上 `typeof matchMedia('(min-width:1px)').addEventListener`；已有 `addListener` 回退 |
| A-11 | Chrome 67 Worker 中 `FileReader`/`Response(blob).arrayBuffer` 可用性 | 未实测 | Worker 内跑 compat 单测；决定 Blob polyfill 主路径 |
| A-12 | 67 上 `file://` 打开页面时 `navigator.clipboard`/fetch 行为 | 未实测 | 用 `--allow-file-access-from-files` 打开本地页；记录 |
| A-13 | 67 上混合尺寸打印实际纸张/裁切 | 未实测 | T6；记录纸张尺寸与截图 |
| A-14 | `color-scheme` 缺失对滚动条/表单控件的具体视觉影响 | 未实测 | 67 上 dark/light 截图对比 |
| A-15 | React 18/19、Vue 3.3+ 运行时是否能在 67 工作 | 属框架支持范围，未测 | 用 examples 在 67 上跑；结论只用于接入说明，不改变本仓库承诺 |
| A-16 | 67 上 `AbortSignal.reason` 缺失导致的宿主可见差异 | 未实测 | T7；检查 warning/error 文案是否含 `undefined` |
| A-17 | site `.dock` 的 `backdrop-filter` 降级可读性 | 未实测 | 67 截图 |
| A-18 | 67 上打印 `@page size` 是否被打印对话框遵守 | 未实测 | T6 |

## 附录 B：复现命令

以下命令均在仓库根目录执行；Python 3.12、Node 26 可用。

### B-1 API 计数

```bash
python3 - <<'PY'
import pathlib, re
roots = ['packages/ofdrw-viewer-engine/src', 'packages/ofdrw-viewer-crypto/src', 'packages/ofdrw-viewer-ui/src']
checks = {
  'replaceChildren': r'\.replaceChildren\(',
  'blobArrayBuffer': r'\.arrayBuffer\(\)',
  'allSettled': r'Promise\.allSettled\(',
  'fromEntries': r'Object\.fromEntries\(',
  'globalThis': r'\bglobalThis\b',
  'queueMicrotask': r'\bqueueMicrotask\b',
  'flatMap': r'\.flatMap\(',
  'replaceAll': r'\.replaceAll\(',
  'fullscreen': r'(requestFullscreen|fullscreenElement|fullscreenEnabled|exitFullscreen|fullscreenchange)',
  'reasonRead': r'\b(signal|taskSignal|workSignal|closeSignal|external|externalSignal|abort)\.reason\b',
  'bigint': r'\b\d+n\b',
}
for name, pat in checks.items():
    print('##', name)
    for root in roots:
        hits = []
        for p in pathlib.Path(root).rglob('*.ts'):
            for i, line in enumerate(p.read_text(errors='ignore').splitlines(), 1):
                if re.search(pat, line):
                    hits.append(f'{p}:{i}')
        print(f'  {root}: {len(hits)}')
        for h in hits:
            print('   ', h)
PY
```

### B-2 CSS 计数

```bash
python3 - <<'PY'
import re, pathlib
for f in ['packages/ofdrw-viewer-ui/src/style.css', 'site/style.css']:
    lines = pathlib.Path(f).read_text().splitlines()
    print('==', f, len(lines), 'lines')
    for name, pat in {
      'color-scheme': r'color-scheme\s*:', 'prefers-color-scheme': r'prefers-color-scheme',
      'prefers-contrast': r'prefers-contrast', 'prefers-reduced-motion': r'prefers-reduced-motion',
      'focus-visible': r'focus-visible', 'inset': r'(?<![\w-])inset\s*:',
      'accent-color': r'accent-color\s*:', 'scrollbar-width': r'scrollbar-width\s*:',
      'text-underline-offset': r'text-underline-offset\s*:', ':where': r':where\(',
      ':is': r':is\(', 'min(': r'(?<![\w-])min\(', 'max(': r'(?<![\w-])max\(',
      'gap': r'(?<![\w-])gap\s*:', 'env(': r'env\(', 'backdrop-filter': r'backdrop-filter\s*:',
    }.items():
        hits = [i for i, l in enumerate(lines, 1) if re.search(pat, l)]
        print(f'  {name}: {len(hits)} {hits}')
PY
```

### B-3 产物语法/API 残留

```bash
python3 - <<'PY'
import pathlib
files = list(pathlib.Path('packages').glob('ofdrw-viewer-*/dist/**/*.js'))
files += list(pathlib.Path('site-dist/assets').glob('*.js')) if pathlib.Path('site-dist').exists() else []
for p in files:
    t = p.read_text(errors='ignore')
    print(p, '?.', t.count('?.'), '??', t.count('??'),
          'allSettled', t.count('allSettled'), 'replaceChildren', t.count('replaceChildren'),
          'fromEntries', t.count('fromEntries'), 'globalThis', t.count('globalThis'),
          'arrayBuffer', t.count('.arrayBuffer('), 'requestFullscreen', t.count('requestFullscreen'))
PY
```

### B-4 esbuild CSS 目标实验

```bash
printf '.a{inset:0;width:min(10px,20px);display:flex;gap:4px;color-scheme:dark}\n.b:where(.c,.d){display:flex}\n.e:focus-visible{outline:1px solid}\n' \
  | ./node_modules/.bin/esbuild --loader=css --target=chrome67 --minify
# 期望：inset 被降为 top/right/bottom/left；min()/gap/:where/:focus-visible 原样保留
```

### B-5 esbuild JS 目标实验

```bash
printf 'const a={b:1}; const x=a?.b; const y=1n; export {x,y};\n' \
  | ./node_modules/.bin/esbuild --loader=ts --target=chrome67 --format=esm
# 期望：?. 降级，1n 保留
```

### B-6 crypto BigInt 与目标

```bash
grep -rnE '\b[0-9]+n\b' packages/ofdrw-viewer-crypto/src | wc -l   # 期望 31
pnpm -C packages/ofdrw-viewer-crypto typecheck
```

### B-7 旧内核下载可用性

```bash
curl -sS -I https://commondatastorage.googleapis.com/chromium-browser-snapshots/Linux_x64/555668/chrome-linux.zip | head -5
curl -sS https://commondatastorage.googleapis.com/chromium-browser-snapshots/Linux_x64/555668/REVISIONS
```

## 附录 C：引用与术语

- MDN Browser Compat Data（版本判定来源）：<https://github.com/mdn/browser-compat-data>
- Chromium Snapshots：<https://commondatastorage.googleapis.com/chromium-browser-snapshots/>
- ChromiumDash（Chrome 67 稳定版本）：<https://chromiumdash.appspot.com/>
- Vite 8.3.5 `vite:esbuild-transpile`：`node_modules/.pnpm/vite@8.3.5*/node_modules/vite/dist/node/chunks/node.js:7445`
- `IACVT`：Invalid At Computed Value Time，自定义属性含不支持函数时的计算值失效行为。
- “现代 Chrome”：本机系统 Chrome 145.0.7632.116（Playwright `channel: 'chrome'`）。
- “Chrome 67”：2018-05 稳定内核，桌面 Linux x64；本次目标版本线 `67.0.3396.x`。