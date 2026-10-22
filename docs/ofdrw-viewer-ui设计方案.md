# @ofdrw/ofdrw-viewer-ui 设计方案

| 项 | 内容 |
|---|---|
| 状态 | 设计稿，待评审 |
| 版本 | 0.1 |
| 日期 | 2026-10-22 |
| 目标包 | `packages/ofdrw-viewer-ui`，包名 `ofdrw-viewer-ui` |
| 依赖 | `@ofdrw/ofdrw-viewer-engine`、[v1.1 文本内容 API 设计](./text-content-api.md)、[OFD 渲染引擎设计方案](./OFD渲染引擎设计方案.md) |
| 参考实现 | pdf.js 6.x viewer（`viewer.html` / `viewer.css` / `app.js` / component 层） |
| 明确不做 | OFD 渲染、电子签章验签、PDF 导出、OCR、在线批注编辑 |

## 0. 结论摘要

1. **不 fork pdf.js viewer**。pdf.js 的 `PDFViewer` 与 `PDFDocumentProxy` / `PDFPageProxy` 强耦合（视口、文字、注释、可选内容都走 pdf.js 内部对象），替换后端的工作量和风险都高于重写 UI 层。复用它的**布局、交互、渲染队列、文字层、查找、历史记录和快捷键模式**，代码按 OFD 引擎重写。
2. **UI 采用“框架无关核心 + 可选薄适配”**。核心 `OFDViewer` 是一个不依赖框架的类；`<ofd-viewer>`、React、Vue 只做属性/事件/生命周期桥接，不把核心逻辑放进组件，也不按框架重写阅读器。
3. **MVP 范围**：基础阅读、缩略图、大纲/书签、查找与文本选择/复制、打印/导出图片、签章信息（不验签）。
4. **大规模页按 1000 页设计**：批量页尺寸 + 虚拟滚动 + 可见页渲染 + LRU 缓存；缩放时**重新渲染**保证清晰，不做 CSS 放大糊图；1000 页以内不需要瓦片/局部渲染。
5. **文本层是一层透明文字覆盖**，坐标来自引擎 `getTextContent`。但截至 2026-10-22，当前 `main` 工作树的 `OFDPage` 只有 `getSize` / `getViewport` / `render` / `exportImage`，`getTextContent` 只存在于 v1.1 设计文档，**尚未实现**。这是 MVP 的前置依赖，详见 §9 和 §13。
6. **签章信息**：引擎只从 OFD 容器返回 `Signature.xml` 元数据和 `SignedValue.dat` 的**原始字节**，不解析电子签章，也不把 `Seal.esl` 作为公开资源；UI 侧用 ASN.1 库解析 `SignedValue.dat`，从 `TBS_Sign.eseal` 取印章信息，展示签章时间、签署人、证书主题、印章属性等；**不做证书链、签名值、时间戳验证**，UI 明确标注“未验证”。
7. **打印/导出**：支持当前页、页码范围、全部页；打印用图片 + `@page`，导出支持 PNG/JPEG/WebP，多页导出打包 ZIP；1000 页大任务采用自适应 DPI 和进度/取消。
8. **框架集成**：核心不依赖 React/Vue；提供 React 18/19、Vue 3 的薄 wrapper；按纯 SPA 设计，不做 SSR；单包 + 子路径导出；默认内置 UI，同时提供 `features.toolbar=false` + 命令/事件，允许宿主自绘工具栏。详见 §14.6。

---

## 1. 背景与目标

### 1.1 背景

`@ofdrw/ofdrw-viewer-engine` 已经提供平台无关的 OFD 页面渲染能力：打开文档、页尺寸、视口、Canvas 渲染、取消、图片导出。缺的是一层面向最终用户的阅读器 UI，能力要对齐 pdf.js demo 的日常阅读体验，同时适配 OFD 的数据模型和国内浏览器环境。

### 1.2 产品目标

- **像 pdf.js 一样好用**：工具栏、侧栏、连续滚动、页码跳转、缩放、旋转、全屏、查找、缩略图、大纲、打印、下载。
- **OFD 特有能力**：书签、签章信息、OFD 页面尺寸/毫米单位、国产化浏览器兼容。
- **大规模文档**：1000 页以内可流畅打开、滚动、跳页、缩放。
- **可嵌入**：既能作为类库嵌进业务系统，也能用 Web Component 一行接入。
- **可主题化**：布局和交互参考 pdf.js，颜色、字体、圆角、阴影全部走自有 CSS 变量，不复制 pdf.js 的视觉皮肤。

### 1.3 非目标

- 不实现 OFD 解析/渲染（由引擎负责）。
- 不做电子签章验签、证书链校验、时间戳验证、OCSP/CRL。
- 不做 PDF 导出、OFD 编辑、批注写入、表单填写、OCR。
- 不做服务端、登录、权限管理、文档上传。
- MVP 不做附件面板、图层/可选内容、演示模式、PDF 式密码输入。

### 1.4 成功标准

| 维度 | 标准 |
|---|---|
| 功能 | MVP 清单全部可用；空态/错误态/加载态完整 |
| 性能 | 1000 页文档首屏可交互 ≤ 2 s；页切换 ≤ 300 ms；缩放重渲染 ≤ 500 ms（可见页） |
| 兼容 | 桌面 Chrome/Edge、Android Chrome、iOS Safari 15+、信创 Chromium 主流版本 |
| 可访问性 | 键盘可完成全部核心操作；WCAG 2.1 AA 对比度；文本层可被读屏读取 |
| 稳定 | 单页渲染失败、签章解析失败、缩略图失败都不阻断整篇阅读 |

---

## 2. pdf.js 调研结论

### 2.1 pdf.js 的分层

| 层 | 代表文件 | 对本项目的意义 |
|---|---|---|
| 应用层 | `viewer.html`、`viewer.css`、`viewer.js`、`app.js` | 工具栏、侧栏、查找栏、页码、缩放、旋转、打印、快捷键、历史记录、响应式的参考 |
| 组件层 | `pdf_viewer.js`、`pdf_page_view.js`、`pdf_rendering_queue.js`、`pdf_find_controller.js`、`pdf_link_service.js`、`pdf_history.js`、缩略图/大纲/附件 viewer | 页面容器、文字层、渲染队列、查找控制器、历史记录、侧栏视图的职责划分 |
| 渲染层 | `pdfjs-lib` | 不适用；由 OFD 引擎替代 |

### 2.2 可复用的模式

- **页面 DOM 分层**：`.page > .canvasWrapper > canvas`、`.textLayer`、`.annotationLayer`、`.drawLayer`。OFD 没有 PDF 的注释编辑层，MVP 用 `.textLayer` + `.signatureLayer` 即可。
- **缩放用 CSS 变量驱动**：pdf.js 用 `--scale-factor` 让页面、文字层、注释层同步缩放；我们沿用这个思路，但 canvas 按目标 DPI 重渲染。
- **渲染队列优先级**：可见页最高，预取下一页/上一页次之，缩略图最低；离屏任务可取消。OFD 引擎同一 canvas 串行，跨 canvas 可并行，但受 CPU 限制。
- **大文档阈值**：pdf.js 在页数很大时延迟页面初始化、暂停预取、强制分页模式。我们的上限是 1000 页，策略可以更简单，但仍要保留“只渲染可见页”的核心。
- **查找控制器**：查询归一化、逐页取文字、匹配高亮、当前匹配滚动、结果计数、大小写/全词选项。OFD 没有 pdf.js 的 `getTextContent` 现成实现，需要引擎补齐。
- **历史记录/URL**：`#page=3&zoom=page-width` 形式，前进/后退恢复页码、缩放、旋转。
- **快捷键**：Ctrl+F、Ctrl+G、Ctrl +/-/0、Ctrl+P、方向键/PageUp/PageDown/Home/End、Esc 关闭查找/对话框。
- **可访问性**：工具栏 `role="toolbar"`、按钮 `aria-label`、页码输入 `aria-live`、查找结果 live region、文字层可读。

### 2.3 不复用的部分

- `PDFViewer`、`PDFPageView`、`PDFFindController`、`PDFLinkService`、`PDFHistory` 都直接依赖 pdf.js 的文档/页面代理和事件总线，不能直接套到 OFD 上。
- pdf.js 的注释层、表单层、可选内容层、附件/图层侧栏不适用。
- pdf.js 6.x 的浏览器基线和现代 API 使用较多，不能假设信创浏览器都支持；只借鉴交互，不照搬实现。

### 2.4 许可

pdf.js 为 Apache-2.0。若后续直接复用少量代码/样式，必须在仓库保留 Apache-2.0 许可头和 NOTICE；本设计默认**只借鉴布局与交互模式，不复制源码**。发布前由项目负责人确认项目整体许可证和第三方 NOTICE。

---

## 3. 总体架构

### 3.1 分层

```text
┌──────────────────────────────────────────────────────────────┐
│ 宿主应用 / <ofd-viewer> Web Component                        │
├──────────────────────────────────────────────────────────────┤
│ OFDViewer（公共 API、生命周期、事件、状态）                   │
│  ├─ Toolbar / Sidebar / FindBar / Dialog / Toast             │
│  ├─ DocumentController（打开/关闭/页信息/错误）               │
│  ├─ PageLayout（页偏移、总高、当前页）                        │
│  ├─ PageView × N（canvas + textLayer + signatureLayer）       │
│  ├─ RenderQueue（可见/预取/缩略图，取消与代际）               │
│  ├─ ThumbnailViewer / OutlineView / BookmarkView              │
│  ├─ FindController / TextLayerBuilder / SelectionManager      │
│  ├─ PrintService / ExportService                              │
│  ├─ SignatureService（摘要 + 按需 ASN.1 详情）                │
│  ├─ EventBus / Theme / I18n / Keyboard / History / A11y       │
├──────────────────────────────────────────────────────────────┤
│ @ofdrw/ofdrw-viewer-engine（OFDDocument / OFDPage / RenderTask） │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 模块职责

| 模块 | 职责 | 不做什么 |
|---|---|---|
| `OFDViewer` | 组装、公共 API、状态机、事件转发、销毁 | 不直接画页面 |
| `DocumentController` | 打开/关闭文档、页数、页信息、warning/error 汇聚 | 不排版 |
| `PageLayout` | 页尺寸→CSS 尺寸、页间 gap、累计偏移、总高度、当前页计算 | 不渲染 |
| `PageView` | 单页 DOM、canvas 生命周期、文字层、签章覆盖层、加载/错误态 | 不决定何时渲染 |
| `RenderQueue` | 任务优先级、并发、取消、代际号、可见性驱动 | 不解析 OFD |
| `ThumbnailViewer` | 缩略图列表、懒加载、缓存、当前页高亮 | 不参与主视图排版 |
| `OutlineView` / `BookmarkView` | 树/列表、展开、当前项、跳转 | 不解析 XML |
| `FindController` | 查询、逐页匹配、结果、当前项、取消 | 不直接改 DOM |
| `TextLayerBuilder` | 根据 `TextContent` 生成 span、定位、缩放、旋转 | 不做 OCR |
| `SelectionManager` | 选区文本、复制、清空、与查找高亮协作 | 不修改文档 |
| `PrintService` | 打印范围、逐页图片、`@page`、进度/取消 | 不生成 PDF |
| `ExportService` | 单页/多页导出、ZIP、下载 | 不改变页面内容 |
| `SignatureService` | 签章摘要、按需解析 ASN.1、缓存、错误降级 | 不验签 |
| `EventBus` | 类型化事件、订阅/退订、错误隔离 | 不做全局单例 |
| `Theme` | light/dark/auto、CSS 变量、高对比 | 不硬编码颜色 |
| `I18n` | 文案字典、`Intl` 日期/数字 | 不引重型 i18n 运行时 |
| `Keyboard` | 快捷键、输入框保护、焦点管理 | 不劫持浏览器保留键 |

### 3.3 状态模型

```text
DocumentState:
  source, pageCount, pageInfos[], metadata?, signaturesSummary[],
  outline?, bookmarks?, status: idle|opening|ready|error|closed

ViewState:
  pageNumber, scale, zoomMode, rotation, sidebarView, fullscreen,
  scrollTop, visiblePageRange, selectedText, findState

UIState:
  theme, locale, toolbarCollapsed, dialog, toast, warnings[],
  features: Record<ViewerFeature, FeatureState>
```

- 所有状态变更通过 `OFDViewer` 内部方法完成，UI 组件只读状态并触发事件。
- 对外发 `statechange`，宿主可做受控 UI；内部不依赖任何框架。
- 页面渲染状态属于 `PageView`，不放进全局状态，避免 1000 页时大对象常驻。

### 3.4 数据流

```text
open(source)
  → engine.open → pageCount
  → engine.getPageInfos()（P0 新 API）
  → PageLayout 建立页壳
  → 计算可见页 → RenderQueue
  → page.getViewport({dpi}) → canvas 尺寸
  → page.render() → pagerendered
  → 可见页 getTextContent() → TextLayerBuilder
  → 侧栏/查找/签章按需取数据
```

---

## 4. 公共 API 设计

### 4.1 构造选项

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `container` | `HTMLElement \| string` | 必填 | 挂载点；字符串按 CSS 选择器解析 |
| `source` | `ArrayBuffer \| Uint8Array \| Blob \| string \| { url, headers? }` | 必填 | 本地文件、Blob、公开 URL；URL 支持可选 headers（企业系统预留） |
| `initialPage` | `number` | `1` | 1-based |
| `initialScale` | `number \| 'auto' \| 'page-actual' \| 'page-fit' \| 'page-width'` | `'auto'` | 数字为缩放倍数 |
| `rotation` | `0 \| 90 \| 180 \| 270` | `0` | 初始旋转 |
| `sidebar` | `'thumbnails' \| 'outline' \| 'bookmarks' \| 'signatures' \| null` | `null` | 初始侧栏 |
| `features` | `Partial<Record<ViewerFeature, boolean>>` | `{}` | 细粒度功能开关；`false` 表示不可用，默认隐藏对应控件 |
| `featureDisplay` | `'hide' \| 'disable' \| Partial<Record<ViewerFeature, 'hide' \| 'disable'>>` | `'hide'` | 被关闭功能的展示方式：全局，或按功能单独指定；默认隐藏 |
| `theme` | `'light' \| 'dark' \| 'auto'` | `'auto'` | 跟随 `prefers-color-scheme` |
| `locale` | `string` | `'zh-CN'` | 目前内置 zh-CN/en-US，可扩展 |
| `maxCanvasPixels` | `number` | `32_000_000` | 单页 canvas 像素上限 |
| `pageCacheSize` | `number` | `10`（桌面）/ `4`（移动） | 已渲染页 canvas 缓存 |
| `thumbnailCacheSize` | `number` | `100` | 缩略图缓存 |
| `renderConcurrency` | `number` | `1`（移动）/ `2`（桌面） | 同时渲染页数 |
| `updateHash` | `boolean` | `false` | 是否把页码/缩放写入 URL hash |
| `requestInit` | `RequestInit` | 无 | URL 来源的额外请求参数（credentials 默认 `same-origin`） |
| `onWarning` | `(warning) => void` | 无 | 引擎/UI warning |
| `onError` | `(error) => void` | 无 | 打开/渲染等错误 |

### 4.2 实例方法

| 方法 | 说明 |
|---|---|
| `open(source)` | 打开/切换文档；会先关闭旧文档 |
| `close()` | 关闭文档、取消任务、清缓存，但保留容器/事件 |
| `destroy()` | 关闭 + 解绑 DOM/事件，实例不可再用 |
| `getState()` | 返回只读 `ViewerState` 快照；含 `features` 的有效状态 |
| `setFeatures(patch)` | 运行时合并功能开关；立即更新 UI/快捷键，必要时关闭弹窗、取消任务 |
| `getFeatureState(feature)` | 返回单个功能的有效状态（enabled/visible/reason） |
| `isFeatureEnabled(feature)` | 便捷判断；等价于 `getFeatureState(feature).enabled` |
| `getDocument()` | 返回引擎 `OFDDocument`（高级用法，谨慎） |
| `getPageCount()` / `getCurrentPage()` | 页码信息 |
| `goToPage(pageNumber, options?)` | 1-based；`options.smooth` |
| `nextPage()` / `previousPage()` | 边界不循环 |
| `goToDestination(dest)` | 大纲/书签/内部链接用 |
| `setScale(scale)` | 数字或模式；触发重渲染 |
| `setZoomMode(mode)` | `auto/page-actual/page-fit/page-width` |
| `zoomIn()` / `zoomOut()` / `resetZoom()` | 预设档位 |
| `setRotation(deg)` / `rotateClockwise()` | 0/90/180/270 |
| `openSidebar(view)` / `closeSidebar()` / `toggleSidebar()` | 侧栏 |
| `find(query, options?)` | 开始查找；`options` 含 `caseSensitive`、`wholeWord`、`highlightAll` |
| `findNext()` / `findPrevious()` / `clearFind()` | |
| `getFindState()` | 查询、当前序号、总数、是否搜索中 |
| `getSelectedText()` / `copySelection()` / `clearSelection()` | 选区 |
| `print(options?)` | 打开打印流程 |
| `exportImage(options?)` / `exportImages(options?)` | 单页/多页导出 |
| `getSignatures()` | 签章摘要列表（不解析 ASN.1） |
| `getSignatureDetail(id)` | 按需解析详情 |
| `showSignature(id)` / `focusSignature(id)` | 打开详情/滚动到页面位置 |
| `setTheme(theme)` / `setLocale(locale)` | |
| `setFullscreen(boolean)` | Fullscreen API + 回退 |
| `showDialog(name)` / `closeDialog()` | 高级 UI 控制 |

> 功能关闭时，相关方法抛 `OFD_FEATURE_DISABLED`（含 `feature` 字段），不做静默 no-op；详见 §4.7。

### 4.3 事件

| 事件 | 时机 | 载荷 |
|---|---|---|
| `documentopen` | 文档打开、页数已知 | `{ pageCount }` |
| `documentclose` | 关闭完成 | `{}` |
| `pagechanging` | 当前页变化 | `{ pageNumber, previous }` |
| `pagerendered` | 单页渲染完成 | `{ pageNumber, scale, rotation }` |
| `pagesloaded` | 初始可见页加载完 | `{ pageCount }` |
| `scalechanging` | 缩放变化 | `{ scale, zoomMode, previous }` |
| `rotationchanging` | 旋转变化 | `{ rotation, previous }` |
| `sidebarviewchanged` | 侧栏切换 | `{ view }` |
| `findstart` / `findmatches` / `findcurrent` | 查找生命周期 | `{ query, total, current }` |
| `selectionchange` | 选区变化 | `{ text, isEmpty }` |
| `signatureclick` | 点击签章覆盖层 | `{ id, pageNumber }` |
| `printstart` / `printprogress` / `printend` | 打印 | `{ current, total }` |
| `exportprogress` | 导出 | `{ current, total }` |
| `warning` / `error` | 诊断 | `{ code, message, pageIndex? }` |
| `featureschange` | 功能开关或有效能力变化 | `Record<ViewerFeature, FeatureState>` |
| `statechange` | 任意视图状态变化 | `ViewerState` |

### 4.4 Web Component 薄壳

- 标签：`<ofd-viewer>`。
- 属性：`src`、`page`、`scale`、`rotation`、`theme`、`locale`、`sidebar` 等基础标量。
- 复杂配置用 property：`viewer.features = { print: false, find: false }`，或调用 `setFeatures()`；不要用 JSON 塞 attribute。
- 属性变化映射到 `OFDViewer` 方法；`src` 变化重新 `open`。
- 事件：`ofd-document-open`、`ofd-page-change`、`ofd-error` 等，`detail` 为对应载荷。
- 提供 `viewer` 只读属性，拿到底层实例。
- 采用 **light DOM**（不默认 Shadow DOM）：打印、选区、全屏、读屏在 light DOM 下问题最少；样式用 `.ofd-viewer` 前缀 + CSS 变量隔离。若后续需要 Shadow DOM，再提供 `shadow` 选项并处理 `::part`。
- 组件只做桥接，不复制核心逻辑；无框架依赖。

### 4.5 主题变量

| 变量 | 用途 | light 示例 | dark 示例 |
|---|---|---|---|
| `--ofd-bg` | 应用背景 | `#f3f4f6` | `#1b1b1f` |
| `--ofd-toolbar-bg` | 工具栏 | `#ffffff` | `#26262b` |
| `--ofd-sidebar-bg` | 侧栏 | `#f7f7f8` | `#202024` |
| `--ofd-page-bg` | 页面纸面 | `#ffffff` | `#2b2b30` |
| `--ofd-text` | 主文字 | `#1f2328` | `#e6e6e9` |
| `--ofd-text-secondary` | 次要文字 | `#5b616b` | `#a9adb5` |
| `--ofd-border` | 边框 | `#d8dbe0` | `#3a3a42` |
| `--ofd-accent` | 强调/焦点 | `#0b66d0` | `#6aa9ff` |
| `--ofd-page-shadow` | 页面阴影 | `0 1px 3px rgba(0,0,0,.18)` | `0 1px 4px rgba(0,0,0,.5)` |
| `--ofd-find-highlight` | 查找全部高亮 | `rgba(255, 213, 0, .35)` | `rgba(255, 213, 0, .28)` |
| `--ofd-find-current` | 当前匹配 | `rgba(255, 140, 0, .55)` | `rgba(255, 170, 40, .55)` |
| `--ofd-selection` | 文本选区 | `rgba(11, 102, 208, .25)` | `rgba(106, 169, 255, .3)` |
| `--ofd-signature-outline` | 签章框 | `rgba(11, 102, 208, .65)` | `rgba(106, 169, 255, .7)` |
| `--ofd-danger` | 错误 | `#b3261e` | `#ff8a80` |

- `data-theme="light|dark"` 切换；`auto` 用 `matchMedia('(prefers-color-scheme: dark)')`。
- 不依赖 `light-dark()`、`:has()` 等新语法；用 class/属性选择器。
- 高对比模式：`prefers-contrast: more` 时加深边框/文字，关闭阴影。
- 打印样式单独一套，强制白底、隐藏工具栏/侧栏/查找栏。

### 4.6 国际化与可访问性

- 文案字典 `zh-CN`、`en-US`；日期用 `Intl.DateTimeFormat`，数字用 `Intl.NumberFormat`。
- 所有按钮有 `aria-label`/`title`；图标按钮必须有可读名称。
- 工具栏 `role="toolbar"`，分组 `role="group"`；页码输入 `aria-label="页码"`。
- 查找输入 `role="searchbox"`，结果计数 `aria-live="polite"`。
- 对话框焦点陷阱、Esc 关闭、关闭后焦点回到触发按钮。
- 页面容器 `role="document"`，`aria-label="第 N 页，共 M 页"`；canvas `aria-hidden="true"`；文字层承载可读文本。
- 键盘可达：Tab 顺序、方向键翻页/树导航、Home/End、PageUp/PageDown、`+/-/0`、Ctrl+F、Ctrl+P。
- 触摸目标 ≥ 44×44 px；不依赖 hover 才显示的操作。

### 4.7 功能开关（features）

用统一 `features` 配置控制“某个具体功能是否可以使用”，不要给每个控件散落一个 `enableXxx`。默认全部开启，未实现/引擎不支持的项自动降级。

```ts
type ViewerFeature =
  | 'toolbar' | 'sidebar' | 'thumbnails' | 'outline' | 'bookmarks'
  | 'pageNavigation' | 'pageNumberInput' | 'zoom' | 'rotate' | 'fullscreen'
  | 'textLayer' | 'selection' | 'find' | 'print' | 'export' | 'signatures'
  | 'documentProperties' | 'keyboardShortcuts';

type FeatureReason = 'host' | 'document' | 'unsupported' | 'dependency';

interface FeatureState {
  enabled: boolean;
  visible: boolean;
  reason?: FeatureReason;
}

type ViewerFeatures = Partial<Record<ViewerFeature, boolean>>;
type FeatureDisplay =
  | 'hide'
  | 'disable'
  | Partial<Record<ViewerFeature, 'hide' | 'disable'>>;
```

| 功能键 | 默认 | 控制的 UI/能力 | 依赖/说明 |
|---|---|---|---|
| `toolbar` | `true` | 内置工具栏 | `false` 时不渲染工具栏，主区域占满；宿主可自绘 |
| `sidebar` | `true` | 侧栏容器/切换按钮 | `false` 时关闭并隐藏整个侧栏 |
| `thumbnails` | `true` | 缩略图标签/列表 | 依赖 `sidebar`；无缩略图能力时隐藏 |
| `outline` | `true` | 大纲标签/树 | 依赖 `sidebar` 和引擎 `getOutline` |
| `bookmarks` | `true` | 书签标签/列表 | 依赖 `sidebar` 和引擎 `getBookmarks` |
| `pageNavigation` | `true` | 上一页/下一页、PageUp/PageDown/Home/End | 关闭后 `goToPage`/`nextPage`/`previousPage` 拒绝 |
| `pageNumberInput` | `true` | 页码输入框 | 关闭后仍可用其他导航方式 |
| `zoom` | `true` | 缩放按钮/菜单、滚轮/捏合、`setScale` | 关闭后所有缩放入口禁用 |
| `rotate` | `true` | 旋转按钮、`setRotation` | 关闭后不改变旋转 |
| `fullscreen` | `true` | 全屏按钮/API | 环境不支持时自动降级为禁用 |
| `textLayer` | `true` | 透明文字层 | 关闭后 `find`/`selection` 自动不可用 |
| `selection` | `true` | 文本选择/复制 | 依赖 `textLayer`；关闭后 `user-select:none` |
| `find` | `true` | 查找栏、Ctrl+F、`find*` | 依赖 `textLayer` 和引擎 `getTextContent` |
| `print` | `true` | 打印按钮/对话框 | 还受文档权限和引擎导出能力限制 |
| `export` | `true` | 导出图片按钮/对话框 | 还受文档权限和引擎导出能力限制 |
| `signatures` | `true` | 签章标签、页面覆盖层、详情 | 依赖引擎 `getSignatureEntries`/`getSignedValue` |
| `documentProperties` | `true` | 文档属性对话框 | P1；无 `getMetadata` 时隐藏 |
| `keyboardShortcuts` | `true` | 全局快捷键 | `false` 时仍可用按钮；Ctrl+F/P 等不响应 |

规则：

1. **单一配置源**：`features` 是唯一开关；不再提供 `enableTextLayer`/`enableFind` 等散装选项。旧选项若需要兼容，只在 wrapper 层做映射，不进入核心。
2. **`false` 的含义**：该功能不可用。`featureDisplay` 可为全局 `'hide'|'disable'`，也可按功能给对象；未指定时默认 `'hide'`，即隐藏控件。`'disable'` 显示但禁用，并用 tooltip 说明原因。两种方式下 API 都拒绝调用。
3. **有效状态**：`FeatureState = { enabled, visible, reason? }`；`reason` 为 `'host' | 'document' | 'unsupported' | 'dependency'`。`visible` 只描述内置 UI；自定义工具栏应看 `enabled`。
4. **优先级**：宿主 `features=false` → 文档权限不允许 → 引擎/环境不支持 → 依赖不满足。宿主**不能**用 `features=true` 强行开启文档权限禁止的打印/导出，也不能绕过引擎缺失的 API。
5. **依赖联动**：`textLayer=false` 时 `find`/`selection` 自动 `enabled=false`、`reason='dependency'`；`sidebar=false` 时三个侧栏标签自动不可见；`toolbar=false` 不影响其他功能，只隐藏内置工具栏。
6. **运行时更新**：`setFeatures(patch)` 合并配置，立即重建工具栏/侧栏、更新快捷键；关闭被禁用功能的弹窗；正在执行的查找/打印/导出若被禁用则取消。更新后发 `featureschange`。
7. **API 守卫**：功能关闭时，相关实例方法抛 `OFD_FEATURE_DISABLED`（带 `feature` 字段），不做静默 no-op；内部流程（如引擎事件）不受影响。
8. **可访问性**：`'disable'` 时按钮用 `disabled`/`aria-disabled`，不能用“看起来可点但没反应”；隐藏时同步从 Tab 顺序移除。

示例：

```ts
new OFDViewer({
  container,
  source,
  features: {
    print: false,
    export: false,
    signatures: false,
    find: false,
    textLayer: false,
  },
  featureDisplay: {
    print: 'disable',
    export: 'disable',
    signatures: 'disable',
  },
});
```

上面配置会让打印/导出/签章控件显示为禁用、查找控件隐藏，文字层不渲染；即使宿主直接调用 `print()`/`find()`，也会得到 `OFD_FEATURE_DISABLED`。

---

## 5. 布局与视觉

### 5.1 整体结构

```text
.ofd-viewer[data-theme]
  .ofd-viewer__toolbar
  .ofd-viewer__body
    .ofd-viewer__sidebar
      .ofd-sidebar__tabs
      .ofd-sidebar__panel
    .ofd-viewer__main
      .ofd-page[data-page-number]
        .ofd-page__canvas-wrapper > canvas
        .ofd-page__text-layer
        .ofd-page__signature-layer
        .ofd-page__loading / .ofd-page__error
    .ofd-viewer__findbar
  .ofd-viewer__dialog-layer
  .ofd-viewer__toast-layer
```

- 根容器 `display: grid; grid-template-rows: auto 1fr; height: 100%; min-height: 0;`
- 工具栏高度 32 px（与 pdf.js 一致），移动端 44 px。
- 侧栏宽 200 px（pdf.js 默认），可拖拽 180–320 px；移动端为抽屉。
- 主区域 `overflow: auto; overscroll-behavior: contain;`，页面居中，页间 gap 8 px。
- 查找栏浮在主区域顶部中间，不占布局高度。
- 无永久状态栏；页码/缩放/当前页在工具栏；warning 用 toast/详情对话框。

### 5.2 工具栏

从左到右：

1. 侧栏切换（缩略图/大纲/书签/签章）
2. 上一页 / 下一页
3. 页码输入 `/ 总页数`
4. 缩小 / 放大
5. 缩放模式下拉（自动、实际大小、适合页面、适合宽度、百分比）
6. 旋转
7. 查找
8. 打印
9. 导出图片
10. 签章信息
11. 全屏
12. 更多（下载原文件、文档属性，P1）

交互细节：

- 页码输入支持回车跳转、失焦校验、非法值恢复当前页。
- 缩放下拉与 +/- 同步；达到最小/最大档位时按钮禁用。
- 旋转按 90° 步进；旋转后保持当前页和视口锚点。
- 打印/导出在打开对话框前检查 `getFeatureState('print').enabled` / `getFeatureState('export').enabled`（已合并宿主配置、文档权限、引擎能力）。
- 移动端：只保留侧栏、页码、缩放、更多；其余进“更多”菜单。
- 按钮状态用 `aria-pressed`（侧栏/查找/全屏）和 `disabled`。

### 5.3 页面视觉

- 纸面：`background: var(--ofd-page-bg)`；阴影 `var(--ofd-page-shadow)`；圆角 2 px（可选 0，贴合 pdf.js 的硬边）。
- 页面外边距：桌面 16–24 px，移动 8 px；连续滚动时页间 8 px。
- 加载态：页面中心骨架/进度环，避免闪烁。
- 错误态：页内错误占位 + “重试”按钮，不阻断其他页。
- 当前页不明显加边框（避免干扰阅读）；侧栏缩略图/大纲高亮当前项。
- 缩略图/书签/签章侧栏宽度 200 px；缩略图卡片宽 140 px，页码在下方。
- 打印时隐藏所有 chrome，页面无阴影、无外边距。

### 5.4 响应式

| 断点 | 行为 |
|---|---|
| `>= 1024px` | 侧栏常驻（打开时挤压主区域），工具栏完整 |
| `768–1023px` | 侧栏覆盖主区域（带遮罩），工具栏精简 |
| `< 768px` | 侧栏抽屉；工具栏底部/顶部浮动；查找栏贴底；页码输入缩小 |
| `< 480px` | 工具栏只保留核心按钮 + 更多菜单；缩放用双指/菜单 |

实现约定：

- **布局切换只用 CSS 媒体查询**，不维护 mobile/desktop 两套 DOM，也不在断点变化时重建阅读器。断点以设计表为准；同一实例只切换根节点状态和控件布局。
- 嵌入式场景以 **viewer 容器宽度**为准，而不是窗口宽度：`ResizeObserver` 在根节点写 `data-viewport="desktop|compact|mobile"`，CSS 按该属性切换；窗口级 `@media` 作为全屏/兜底。`@container` 仅在目标浏览器确认支持后作为增强，不作为唯一手段。
- JS 只用 `matchMedia`/`ResizeObserver` 监听模式变化，用于行为差异（`renderConcurrency`、`pageCacheSize`、是否预取、抽屉焦点/遮罩）；**不做 UA 判断**。`(pointer: coarse)` 只用于触控目标和手势增强，不等同于移动端布局。
- 断点变化保留 `pageNumber`、`scale`、`rotation` 和滚动锚点；侧栏在 inline ↔ overlay/drawer 之间切换时同步遮罩、焦点陷阱和 `aria-expanded`，不重新 `open()`。
- 移动端手势：双指捏合缩放、双击放大/还原、单指滚动；**默认不做左右滑动翻页**，避免与文本选择冲突；如需要，提供 `enableSwipe` 且仅在页面边缘区域生效。
- iOS Safari：全屏 API 不可用时退化为“隐藏 chrome 的沉浸模式”；打印能力有限，提示“下载图片后打印”。

### 5.5 动效

- 页面切换/缩放以即时为主，不做大幅动画；`prefers-reduced-motion: reduce` 时关闭过渡。
- 侧栏滑入 150–200 ms；查找栏淡入 100 ms；对话框 150 ms。
- 加载骨架用低对比度脉冲，避免闪烁。

---

## 6. 阅读核心

### 6.1 打开流程

1. 规范化 `source`：ArrayBuffer/Uint8Array/Blob/URL 转为引擎 `OFDSource`。
2. `OFDDocument.open`；显示全屏 loading；支持取消/关闭。
3. 取 `pageCount`；调用 `getPageInfos()` 拿全部页尺寸（P0 新 API）。
4. `PageLayout` 建立 1000 个页壳（仅 DOM 壳，不含 canvas），计算总高度。
5. 初始页（默认第 1 页，或 hash/选项）；计算可见页。
6. 渲染可见页；`pagesloaded` 后隐藏 loading。
7. 异步加载缩略图/大纲/书签摘要；签章摘要按需。
8. 若 `getPageInfos` 不可用：先 `getPage(0..N)` 取前若干页，剩余按 A4 估算并后台补齐；**这会滚动跳动，仅作为降级，不作为 1000 页正式方案**。

### 6.2 页面布局

- 页 CSS 尺寸：`width = widthMm * 96 / 25.4 * scale`，`height = heightMm * 96 / 25.4 * scale`；旋转 90/270 时交换。
- `PageLayout` 维护 `offsets[i]`、`totalHeight`；页间 gap 固定 8 px。
- 混合页尺寸：每页使用自己的尺寸；总高度按实际累加；滚动锚点用“页号 + 页内相对偏移”。
- 1000 页总高度约 1000 × 1123 px ≈ 1.12M px（A4@1x），远低于浏览器滚动高度上限；放大到 3x 仍可接受。
- 当前页判断：用 `IntersectionObserver` 或滚动位置二分查找 `offsets`；选择滚动位置更可靠，避免快速滚动时 observer 滞后。

### 6.3 页面生命周期

```text
empty → queued → preparing → rendering → rendered → evicted
                  ↑ cancel/代际失效
```

- 每个 `PageView` 持有 `generation`；缩放/旋转/跳页/关闭时递增，旧任务结果丢弃。
- 离屏页取消渲染；已渲染页进入 LRU；被淘汰时释放 canvas（`canvas.width = 0`）并移除 DOM 引用。
- 同一页重复进入可见区时，若缓存命中直接复用；否则重新入队。
- 单页失败：标记 error，显示重试；不影响其他页；重试递增 generation。

### 6.4 渲染队列

| 优先级 | 任务 | 说明 |
|---|---|---|
| 0 | 当前可见页 | 先渲染视口中心页，再上下 |
| 1 | 相邻页预取 | 当前页 ±1，空闲时 |
| 2 | 缩略图 | 侧栏可见缩略图 |
| 3 | 其余 | 不主动渲染 |

- 并发：桌面 2、移动 1；同一 canvas 串行（引擎已保证）。
- 调度：`requestAnimationFrame` 批处理 + `requestIdleCallback`（有 timeout 回退）；快速滚动时只保留最后一组可见页，取消旧任务。
- 取消：`RenderTask.cancel()`；取消后 `OFD_ABORTED` 不视为错误。
- 预取：如果引擎提供 `page.prepare`，滚动停止 150 ms 后预取下一页模型/字体；否则只预渲染，成本较高，移动端关闭。

### 6.5 缩放

- 支持模式：`auto`（适合宽度，pdf.js 默认）、`page-actual`（100%）、`page-fit`、`page-width`、百分比（25%–500%，UI 档位可含 10%–2500%）。
- 缩放流程：
  1. 立即更新页 CSS 尺寸和 `--scale-factor`；旧 canvas 用 CSS 拉伸，避免空白。
  2. 防抖 120–150 ms 后，对可见页按新 DPI 重渲染。
  3. 渲染完成替换 canvas；保持滚动锚点（当前页 + 页内相对位置）。
  4. 取消所有旧 generation 任务。
- 渲染 DPI：`dpi = 96 * scale * devicePixelRatio`；canvas 像素尺寸取 `page.getViewport({dpi})`。
- canvas 上限：
  - `width * height <= maxCanvasPixels`（默认 32MP）；
  - `width/height <= 32767`；
  - 超限时降低输出 DPI（保持 CSS 尺寸），并 warning；不直接失败。
- 文字层不随缩放重新抽取：按 96 DPI 坐标构建，CSS 用 `--scale-factor` 缩放；旋转由页面容器统一 transform。
- 缩放后当前页保持：记录 `anchorPage`、`anchorRatio`（页内滚动位置 / 页高），重排后恢复。
- 手势（F6）：Ctrl/Cmd+滚轮与触控板 `ctrlKey=true` 的 wheel 以指针为锚点按 1.1/0.9 步进；触摸屏双指捏合以两指中点为锚点；双击在适合宽度与 100% 之间切换。手势统一复用 `applyScale`/`setScale` 与渲染队列，`zoom` 功能关闭时不拦截默认行为。

### 6.6 旋转

- 旋转是**阅读器行为**，引擎始终输出未旋转页面。
- 页面容器 `transform: rotate(deg)`，同时交换布局宽高（90/270）。
- canvas、文字层、签章覆盖层一起旋转；文字层坐标不重算。
- 旋转后恢复当前页和页内锚点；缩略图也应用旋转（CSS），但导出/打印按选项处理。
- 旋转 90/270 时，页面外框宽高互换，避免布局空洞。
- 文本选择在旋转下依赖浏览器对 CSS transform 的处理；需在 Chrome/Edge/信创浏览器做回归；若某浏览器选区错位，降级为“按页复制文本”按钮。

### 6.7 页码与历史

- 页码 1-based 显示，内部 0-based。
- 当前页变化时更新工具栏、侧栏高亮、URL hash（若 `updateHash`）。
- `goToPage` 支持 `smooth`；大跳转直接定位，避免长距离平滑滚动。
- 历史记录：`page`、`scale`、`rotation`、`sidebar`；浏览器前进/后退恢复；默认关闭，避免嵌入场景污染宿主 URL。
- hash 格式：`#page=3&zoom=page-width&rotation=90`；解析失败回退默认。

### 6.8 全屏

- 优先 `Element.requestFullscreen()`；失败（iOS Safari/权限）时使用 `position: fixed; inset: 0; z-index` 的沉浸模式。
- 全屏时保留工具栏（自动隐藏，鼠标移动/触摸显示），Esc 退出。
- 退出全屏恢复之前的滚动位置和侧栏状态。

### 6.9 加载/错误/空态

| 状态 | UI |
|---|---|
| 打开中 | 全屏骨架 + 文档名/进度；可取消 |
| 首页渲染中 | 页面骨架；工具栏可用（页码/缩放），打印/导出禁用 |
| 单页失败 | 页内错误卡片 + 重试；warning toast |
| 文档打开失败 | 全屏错误 + 重试/关闭；显示 `OFD_*` 错误码 |
| 无签章/无大纲/无书签 | 侧栏空态文案 |
| 无文本层 | 查找禁用并提示“该文档没有可提取文字” |
| 文档关闭 | 清空 DOM、缓存、事件；容器保留 |

---

## 7. 缩略图

### 7.1 布局

- 侧栏“缩略图”标签；列表纵向滚动；每项：缩略图 canvas + 页码。
- 缩略图宽 = 侧栏宽 - 24 px（约 140 px）；高度按页比例；统一最大高度，避免超长页撑爆。
- 当前页高亮边框/背景；键盘上下移动，Enter 跳转。

### 7.2 渲染

- 只为可见 ±5 项创建 canvas；IntersectionObserver 驱动。
- 目标宽度 `thumbWidthPx`；DPI = `thumbWidthPx / pageWidthMm * 25.4`，clamp 到 24–96；设备像素比可乘 1–2。
- 用 `page.render`（或 `exportImage`，但 render 更省编码开销）绘制；`RenderTask.cancel` 取消离屏任务。
- 缓存：`Map<pageIndex, {canvas, url?}>`，LRU 100；淘汰时释放 canvas。
- 失败：灰色占位 + 页码，不重试轰炸；用户点击可重试。
- 旋转：缩略图容器应用当前旋转；90/270 时交换宽高。
- 1000 页：只渲染可见项；不预生成全部。

### 7.3 与主视图联动

- 点击缩略图 → `goToPage`；滚动主视图时当前缩略图滚入可视区（`scrollIntoView({block:'nearest'})`）。
- 缩放不影响缩略图尺寸（缩略图固定宽度）。
- 侧栏关闭时暂停缩略图队列；重新打开时恢复可见项。

---

## 8. 大纲与书签

### 8.1 数据模型

引擎新增：

| API | 返回 |
|---|---|
| `document.getOutline()` | `OutlineNode[]` |
| `document.getBookmarks()` | `BookmarkItem[]` |

`OutlineNode`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | `string` | 节点标题 |
| `expanded` | `boolean?` | OFD `Expanded` |
| `children` | `OutlineNode[]` | 子节点，保持 XML 顺序 |
| `dest` | `DocumentDestination?` | 跳转目标；缺失/无效时为空 |

`BookmarkItem`：`{ name, dest? }`。

`DocumentDestination`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | `'XYZ' \| 'Fit' \| 'FitH' \| 'FitV' \| 'FitR'` | OFD `Dest@Type` |
| `pageIndex` | `number` | 0-based；由 `PageID` 映射 |
| `leftMm` / `topMm` / `rightMm` / `bottomMm` | `number?` | 目标区域，mm |
| `zoom` | `number?` | `XYZ` 的缩放比例 |

### 8.2 解析规则

- `Document/Outlines/OutlineElem` 递归；`Title`、`Count`、`Expanded`、`Actions/Action/Goto/Dest`。
- `Document/Bookmarks/Bookmark`：`Name`、`Dest`。
- `Goto` 的目标可能是 `Dest` 或 `Bookmark` 名称；引擎负责解析到 `DocumentDestination`。
- `PageID` → 页索引用前序页表；找不到时 `pageIndex` 缺失 + warning，不抛错。
- 未知 `Dest@Type`、非法坐标、负页码：跳过该 dest + warning，节点仍显示但不可跳转。
- 空大纲/空书签返回空数组，不报错。

### 8.3 交互

- 侧栏“大纲”标签：树形，默认展开第一层；展开/收起用箭头；当前页对应节点高亮（取 pageIndex ≤ 当前页的最后一个匹配）。
- 侧栏“书签”标签：扁平列表；书签可重名；按 XML 顺序。
- 点击节点：
  - `XYZ`：若 `zoom` 合法且与当前差异大，`setScale(zoom)`；滚动到 `topMm`（无 top 则页首）。
  - `Fit`：适合页面；`FitH`：适合宽度 + top；`FitV`：适合高度 + left；`FitR`：按矩形适配。
  - 坐标 mm → px：`px = mm * 96 / 25.4 * scale`。
- 目标页尚未布局：先 `goToPage`，再在 `pagerendered`/布局完成后滚到精确位置。
- 空态：“本文档没有大纲/书签”。
- 可访问性：`role="tree"`/`treeitem`，方向键展开/折叠/移动，Enter 跳转。

### 8.4 1000 页

- 大纲/书签通常远小于页数；一次解析即可。
- 若某文档大纲巨大（>5000 节点），侧栏虚拟列表；MVP 可先限制渲染节点数并提示。

---

## 9. 文本层、查找、选择与复制

### 9.1 前置依赖与当前事实

- 设计采用**透明文字层**：canvas 负责视觉，DOM 文字层负责选择、复制、读屏、查找高亮。
- 文字层数据来自引擎 `OFDPage.getTextContent(options)`，契约见 [v1.1 文本内容 API 设计](./text-content-api.md)。
- **当前实现状态**：`packages/ofdrw-viewer-engine/src/api/page.ts` 只有 `getSize`、`getViewport`、`render`、`exportImage`；`getTextContent` 只存在于 `docs/text-content-api.md`，并明确标注“不属于 v1 公共契约、尚未实现”。`src/render/text.ts` 提供内部 `layoutText`，但未导出为页面 API。
- 因此：**文本层/查找/选择/复制是 MVP 的前置阻塞项**。若已有另一分支/未合并实现，按同一契约对齐；否则引擎需先落 T13.2（`getTextContent` + 类型 + 缓存/取消/上限）。
- 如果 MVP 必须在不改引擎的情况下先交付，只能降级为“无文本层”的纯 Canvas 阅读器（无查找/选择），与已确认的 MVP 冲突，不建议。

### 9.2 文本层 DOM

```text
.ofd-page__text-layer[data-dpi="96"]
  span.ofd-text-item[style="left/top/font-size/transform"]
    （必要时）span.ofd-text-char
```

- 每个 `TextItem` 一个 span；当 `TextItem.chars` 中 `advance`/`font` 差异明显、或需要字符级高亮时，拆成字符 span。
- 定位：使用 `TextItem.transform`/`origin`/`quad`；span 绝对定位，`transform-origin: 0 0`；`font-size` 取 `TextItem.size`（px）。
- 文字透明：`color: transparent;` 但保留 `::selection` 背景；`caret-color: transparent`；`user-select: text`。
- 缩放：文本层坐标按 96 DPI 构建；页面容器设置 `--scale-factor`，文本层 `transform: scale(var(--scale-factor))`，与 canvas 同步。
- 旋转：文本层随页面容器旋转；坐标不重算。
- DOM 上限：单页可见文字节点 ≤ 5000；超过时合并为 item span/分段，并 warning。
- 可访问性：文本层不设 `aria-hidden`；canvas `aria-hidden="true"`；页面容器有页标签。

### 9.3 选择与复制

- 原生 Selection：跨 span 选择；`getSelectedText()` 读取 `window.getSelection().toString()`。
- 复制：优先 `navigator.clipboard.writeText`；不支持时 `document.execCommand('copy')` 临时 textarea 回退。
- 清理：复制后保留选区；`clearSelection()` 清除。
- 跨页选择：默认允许（DOM 连续），但 1000 页时只保留可见页文本层，跨页选择可能受限；提供“复制本页文本”/“复制全部文本”（按需抽取）作为补充。
- 复制文本规范化：合并多余空白、保留段落换行；中文不插空格；英文单词间保留空格。
- 旋转/缩放后选区可能错位：以浏览器原生行为为准；回归测试覆盖。

### 9.4 查找

- 打开：Ctrl+F / 工具栏按钮；查找栏聚焦输入框。
- 选项：区分大小写、全词匹配（仅拉丁文有效）、高亮全部。
- 查询归一化：`trim`、连续空白折叠、可选 `toLocaleLowerCase`；不做中文分词。
- 匹配：
  - 先当前页，再向后，再向前（可配置“从当前页开始”）；
  - 逐页 `getTextContent`，拼接 `TextItem.text`，记录每个字符到 item/char 的映射；
  - 命中用字符区间表示；渲染为覆盖层 `.ofd-find-highlight` 盒子（基于 `TextChar.quad`/`TextItem.quad`），不依赖 `Range`，避免缩放/旋转下错位；
  - 当前命中用不同颜色并 `scrollIntoView({block:'center'})`；
  - 结果上限：单页 1000、全篇 10000；超限 warning，不无界分配。
- 性能：
  - 文本抽取分页缓存（引擎 `CacheOptions.textPages`，默认 4）；
  - 搜索用 `requestIdleCallback` 分片，每片 8–16 ms；显示“正在搜索 123/1000”；
  - 查询变化/关闭时取消 token；旧结果丢弃；
  - 1000 页全量搜索是重操作，首次可能数秒；UI 必须可取消、可继续阅读。
- 结果计数：`current/total`；无结果时显示“无结果”；输入为空清空高亮。
- 查找与选择：查找高亮是覆盖层，不进入 DOM 选区；复制不受高亮影响。

### 9.5 文本缺失/降级

- `getTextContent` 返回空：该页无可提取文字（扫描件/纯图片），查找跳过；提示“该页没有可提取文字”。
- 字体缺失/fallback：`TextChar.approximate=true` 时仍可选中，但高亮框可能略宽/略窄；UI 不特别提示，开发文档记录。
- Pattern/Clip 内文字、注释内文字默认不进入文本层（v1.1 边界）；如需，后续扩展 `includeAnnotations`。
- OCR 不在范围。

---

## 10. 打印与导出

### 10.1 能力范围

- 打印：当前页、页码范围、全部页；每页按原比例；支持当前旋转；白底。
- 导出图片：当前页、页码范围、全部页；PNG/JPEG/WebP；DPI 96/150/200/300（或自动）；质量；透明背景（PNG）；旋转；多页 ZIP。
- 不生成 PDF；不调用服务端。

### 10.2 打印流程

1. 打开打印对话框：范围、质量（自动/96/150/200）、是否包含背景、旋转（当前/0）。
2. 计算页列表；`page.exportImage({ dpi, format:'png', background:'#fff', signal })` 逐页生成。
3. 每页生成 `<img>`，放入 `.ofd-print-page`；`width/height` 按 mm；旋转 90/270 时交换容器宽高并 CSS 旋转图片。
4. 等待所有图片 `decode()`/`load`；显示进度，可取消。
5. 注入打印样式，`window.print()`；`afterprint` 清理 DOM、Object URL、取消未完成任务。
6. 大任务：顺序渲染，避免同时持有 1000 个 canvas；图片仍会占用内存，需自适应 DPI + 提示。

### 10.3 `@page` 与混合尺寸

- 统一尺寸（最常见）：`@page { size: <w>mm <h>mm; margin: 0; }`。
- 混合尺寸：按尺寸分组，使用命名页：
  - `@page ofd-size-0 { size: 210mm 297mm; margin: 0; }`
  - `.ofd-print-page[data-size="0"] { page: ofd-size-0; }`
  - Chrome/Edge 支持命名页；信创旧内核若不支持，回退 `@page { size: auto; margin: 0; }` + 页面元素固定 mm 尺寸，接受可能的缩放。
- 图片 `object-fit: contain`，不裁切；页面 `break-after: page`。
- 打印旋转：页面容器宽高交换，图片 `transform: rotate(90deg)` 并平移到正位；用 `transform-origin: center`。

### 10.4 自适应 DPI

| 页数 | 默认 DPI | 说明 |
|---|---|---|
| ≤ 50 | 200 | 清晰优先 |
| 51–200 | 150 | 平衡 |
| > 200 | 96 | 控制内存/时间；提示“页数较多，已降低打印精度” |

- 用户可在对话框改回更高 DPI；若总像素超过阈值（如 2G 像素），警告并建议缩小范围。
- 150 DPI 是 pdf.js 的默认打印精度；本项目默认按页数自适应。

### 10.5 导出图片

- 单页：`exportImage` → Blob → `<a download>`；文件名 `{docName}-p{page}.{ext}`。
- 多页：逐页导出，按 `{docName}-p{page}.{ext}` 存入 ZIP；用 `fflate`（MIT）打包，PNG/JPEG 已压缩，ZIP 用 store 模式；显示进度、可取消。
- 格式：PNG（默认，支持透明）、JPEG（质量 0.92）、WebP（质量 0.92；旧浏览器不支持时回退 PNG）。
- 旋转：引擎导出未旋转；UI 用离屏 canvas 旋转（90/180/270），或打印时 CSS 旋转。导出走 canvas 旋转，保证像素正确。
- 背景：PNG 可选透明；JPEG/WebP 强制白底。
- 文件名清洗：去掉 `/\:*?"<>|` 和控制字符；重复页追加序号。
- 内存：多页 ZIP 在内存中累积 Blob；1000 页大图可能很大；限制单次导出总像素/页数，超出提示分批次。

### 10.6 取消与错误

- 每个导出/打印任务有 `AbortController`；取消后停止后续页，清理已生成 URL/节点。
- 单页失败：记录页号，继续其余页；结束后汇总“N 页失败”，提供重试。
- 弹窗/下载被拦截：给出可点击的下载链接/提示。
- 打印被浏览器取消：`afterprint` 仍清理；不报错。

---

## 11. 签章信息（不验签）

### 11.1 目标与边界

- 展示“这份 OFD 里有哪些签章、盖在哪、印章是谁的、什么时候签的、证书主题是什么”。
- **不做**：签名值验证、证书链验证、证书有效期合法性判断、CRL/OCSP、时间戳验证、签章完整性判断。
- UI 状态统一为“未验证”，不使用“有效/无效/验签通过”等措辞。

### 11.2 数据来源

| 文件 | 内容 | 用途 |
|---|---|---|
| `Signs/Signatures.xml` | `Signature@ID/@Type/@BaseLoc` 索引 | 签章列表、类型 |
| `Signature.xml` | `SignedInfo/Provider`、`SignatureDateTime`、`References/Reference@FileRef`、`StampAnnot@PageRef/@Boundary/@Clip`、`SignedValue/BaseLoc` | 摘要、时间、保护范围、页面位置 |
| `SignedValue.dat` | `SES_Signature`（v1/v4/v5），`TBS_Sign.eseal` 内含印章信息 | **唯一公开的签章资源**：签章时间、签章者证书、签名算法、印章信息、时间戳 |
| `Seal.esl` | `SESeal`（v1/v4/v5） | **不读取**；仅引擎渲染外观时可能内部使用，不进入公开 API |
| 证书 DER | X.509 | 主题、颁发者、序列号、有效期 |

### 11.3 ASN.1 结构

#### 11.3.1 印章信息：`SignedValue.dat` 的 `TBS_Sign.eseal`

UI **不读取 `Seal.esl`**。印章信息统一从 `SignedValue.dat` 的 `TBS_Sign.eseal` 获取，其结构为 `SES_SealInfo`：

`SES_SealInfo`：

| 字段 | 说明 |
|---|---|
| `header` | `id="ES"`、`version`（1/4/5）、`vid`（厂商 ID） |
| `esID` | 印章编码（IA5String） |
| `property` | `SES_ESPropertyInfo` |
| `picture` | `SES_ESPictrueInfo`（图片类型/数据/宽高） |
| `extDatas` | 厂商扩展，可选 |

`SES_ESPropertyInfo`：

| 字段 | 说明 |
|---|---|
| `type` | 1=单位印章，2=个人印章；其他值原样展示 |
| `name` | 印章名称（UTF8String） |
| `certListType` | 1=证书列表，2=证书杂凑值列表（v4/v5） |
| `certList` | `CertInfoList`（OCTET STRING 证书序列）或 `CertDigestList` |
| `createDate` | 制章日期（v1 UTCTime；v4/v5 GeneralizedTime） |
| `validStart` / `validEnd` | 印章有效期 |

#### 11.3.2 `SignedValue.dat`（SES_Signature）

| 版本 | 外层字段 | 说明 |
|---|---|---|
| v1 | `toSign`, `signature` | `toSign` 内含 `cert`/`signatureAlgorithm`；外层只有签名 BIT STRING |
| v4 | `toSign`, `cert`, `signatureAlgID`, `signature`, `timeStamp[0]?` | `toSign` 为 `TBS_Sign` |
| v5 | `toSign`, `cert`, `signatureAlgID`, `signatureValue`, `timeStamp[0]?` | 与 v4 类似 |

`TBS_Sign`：

| 版本 | 字段 |
|---|---|
| v1 | `version`, `eseal`, `timeInfo`(BIT STRING), `dataHash`(BIT STRING), `propertyInfo`(IA5String), `cert`(OCTET STRING), `signatureAlgorithm`(OID) |
| v4/v5 | `version`, `eseal`, `timeInfo`(GeneralizedTime), `dataHash`(BIT STRING), `propertyInfo`(IA5String), `extDatas[0]?` |

要点：

- `SignedValue.dat` 是 **SES_Signature**，不是 PKCS#7/CMS SignedData；不需要 CMS 解析器。
- `TBS_Sign.eseal` 就是 `SES_SealInfo`，印章名称/类型/图片等从这里取；**不再读取 `Seal.esl`，也没有回退逻辑**。
- 签章者证书在 v4/v5 外层 `cert`；v1 在 `TBS_Sign.cert`。
- `timeInfo` 是签章时间：v4/v5 直接是 GeneralizedTime；v1 是 BIT STRING，可能是 ASCII 时间或时间戳 token，需容错。
- `timeStamp[0]` 是可选时间戳，**只显示“含时间戳”，不解析/不验证**。

#### 11.3.3 X.509 证书

- `cert` 是 OCTET STRING，内容为 DER 证书。
- 解析 `TBSCertificate` 的 `serialNumber`、`issuer`、`validity`、`subject`、`subjectPublicKeyInfo`。
- 主题 DN 属性：`CN`、`O`、`OU`、`C`、`ST`、`L`、`emailAddress`、`serialNumber`；按常见顺序格式化为字符串。
- 证书只读展示；不做链、有效期判断、吊销检查。

### 11.4 ASN.1 库选型

| 方案 | 版本/许可 | 体积（未压缩） | 浏览器 | 结论 |
|---|---|---|---|---|
| `asn1.js` | 5.4.1 / MIT | ~49 KB | CJS；依赖 `Buffer`，浏览器需 polyfill | 可用但不首选 |
| `asn1js` | 4.0.0 / BSD-3 | ~179 KB | 纯 ESM，基于 ArrayBuffer，无 Node polyfill | **首选解析器** |
| `@peculiar/asn1-schema` | 2.11.0 / MIT | ~110 KB | ESM，类型化 schema | 可选，提升可维护性 |
| `@peculiar/asn1-x509` | 2.11.0 / MIT | ~171 KB | ESM，X.509 类型 | 可选，解析证书 |
| `@peculiar/x509` | 2.2.0 / MIT | ~593 KB | ESM，功能全但重 | 不采用 |
| `pkijs` | 3.4.3 / BSD-3 | ~1.96 MB | 功能全但过重 | 不采用 |

推荐组合：

- `asn1js`（DER/BER 解析）+ 自定义 SES schema（v1/v4/v5）。
- 证书解析用 `@peculiar/asn1-x509` + `@peculiar/asn1-schema`，避免手写 X.509 全量 schema。
- 整个签章解析器**动态 import**，只在用户打开“签章”面板/详情时加载；不进入首屏包。
- 如果团队坚持使用 `asn1.js`：需要引入 `buffer` polyfill（Vite `resolve.alias` / `optimizeDeps`，tsup 打包时注入），并为其补 `.d.ts`；功能等价，但信创浏览器/包体风险更高。
- 许可：`asn1js` BSD-3、`@peculiar/*` MIT，均可用于商业项目；发布时保留 NOTICE。

### 11.5 引擎 API 与 UI 侧类型

引擎只负责“从 OFD 容器取对象信息和原始字节”，**不解析电子签章**。完整契约见 [引擎 API 与功能说明](./ofdrw-viewer-ui-engine-api.md)。

| API | 说明 | 优先级 |
|---|---|---|
| `document.getSignatureEntries(options?)` | 只读 `Signatures.xml`/`Signature.xml`，返回签章条目、页面位置、`SignedValue` 路径；**不读、不解析** `SignedValue.dat` | P0 |
| `document.getSignedValue(id, options?)` | 返回 `SignedValue.dat` 原始字节；**不解析 ASN.1**；未声明/缺失时返回 `undefined` | P0 |

`SignatureEntryInfo`（引擎返回）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 签章 ID |
| `type` | `'Seal' \| 'Sign' \| string` | 盖章/签名 |
| `baseLoc` | `string` | `Signature.xml` 包内路径 |
| `provider` | `{ name?, company?, version? }?` | `Signature.xml` 的 Provider |
| `signatureDateTime` | `string?` | `SignatureDateTime` 原文 |
| `references` | `{ fileRef: string }[]` | 保护范围 `Reference@FileRef` |
| `stamps` | `SignatureStampInfo[]` | 页面位置，可多个 |
| `signedValuePath` | `string?` | `SignedValue.dat` 包内路径 |
| `hasSignedValue` | `boolean` | 是否声明了 `SignedValue.dat` |

`SignatureStampInfo`：`{ id?, pageId, pageIndex?, boundary: Box, clip?: Box }`；`Box` 为 `{ x, y, width, height }`，单位 mm。

注意：`SignedValue.dat` 内含 `TBS_Sign.eseal`，印章信息从该文件解析；**不读取 `Seal.esl`，也没有 `Seal.esl` 回退**。`hasSignedValue` 只表示“是否声明了路径”；`SignedValue.dat` 缺失时条目仍显示，详情标注“信息不完整”。

以下类型由 **UI 包**在拿到 `SignatureEntryInfo` + `SignedValue.dat` 原始字节后构造，不是引擎返回值：

`SignatureDetail`：

| 字段 | 说明 |
|---|---|
| `entry` | 对应的 `SignatureEntryInfo` |
| `seal?` | 印章信息（UI 解析 `SignedValue.dat` 的 `TBS_Sign.eseal`） |
| `signer?` | 签章者/签名信息（UI 解析 `SignedValue.dat`） |
| `validation` | 固定 `{ status: 'not-verified', note }` |
| `warnings?` | 解析降级信息（非致命） |

`SealInfo`：

| 字段 | 说明 |
|---|---|
| `version` | `'v1' \| 'v4' \| 'v5' \| 'unknown'` |
| `esId?` | 印章编码 |
| `name?` | 印章名称 |
| `typeCode?` | 原始整数 |
| `typeLabel?` | `单位印章` / `个人印章` / `未知` |
| `createDate?` | 制章日期 |
| `validStart?` / `validEnd?` | 有效期 |
| `certificate?` | 印章属性 `certList` 中可解析的证书（不保证存在） |
| `image?` | `{ format, widthMm, heightMm }`（不暴露原始字节） |

`SignerInfo`：

| 字段 | 说明 |
|---|---|
| `certificate?` | 签章者证书 |
| `signedAt?` | 签章时间 |
| `signedAtSource?` | `timeInfo` / `signatureDateTime` / `timestamp-token` |
| `algorithm?` | `{ oid, name? }` |
| `dataHash?` | 原文摘要（hex，可选展示） |
| `propertyInfo?` | 签章属性信息（路径/自定义） |
| `timestampPresent?` | 是否含时间戳 |

`CertificateInfo`：

| 字段 | 说明 |
|---|---|
| `subject` / `issuer` | 格式化 DN |
| `serialNumber` | 十六进制/十进制字符串 |
| `notBefore` / `notAfter` | ISO 8601 |
| `subjectAttributes` | `{ cn?, o?, ou?, c?, st?, l?, email?, serialNumber? }` |
| `signatureAlgorithm?` / `publicKeyAlgorithm?` | OID + 友好名 |

### 11.6 解析流程（引擎取数 + UI 解析）

1. 打开文档时调用 `getSignatureEntries()`：只读 `Signatures.xml` 索引和 `Signature.xml` 元数据；**不读** `SignedValue.dat`。
2. 用户打开签章侧栏/点击覆盖层时，UI 按 `hasSignedValue` 调 `getSignedValue(id)`；`hasSignedValue=false` 时只展示条目，详情标注“缺少签名值文件”。
3. UI 解析 `SignedValue.dat`：按外层字段数/TBS 首字段判版本；解析 `TBS_Sign`；取签章时间、`eseal`、`cert`、算法、签名值、时间戳标记。
4. UI 从 `TBS_Sign.eseal`（`SES_SealInfo`）取印章名称/类型/编码/制章日期/有效期/图片，**不读取 `Seal.esl`，也没有回退**。
5. UI 解析 X.509 证书主题/颁发者/序列号/有效期；v4/v5 证书在外层 `cert`，v1 在 `TBS_Sign.cert`。
6. UI 构造 `SignatureDetail`；字段缺失/解析失败只 warning，仍展示已有字段；引擎不参与 ASN.1 语义。
7. UI 缓存详情（按签名 ID + 文件内容哈希）；`destroy()` 清理；引擎不缓存原始字节或只做有界缓存。

### 11.7 UI

- 侧栏“签章”标签：
  - 按页分组/排序；每项：图标（盖章/签名）、印章名称或“未命名签章”、签章时间、签章者 CN、页码；右侧灰色徽标“未验证”。
  - 点击项：滚动到对应页并高亮覆盖层；再次点击/详情按钮打开详情。
  - 空态：“本文档未发现签章”。
- 页面覆盖层 `.ofd-page__signature-layer`：
  - 每个 `StampAnnot` 一个绝对定位框（mm→px），边框 `--ofd-signature-outline`，hover 显示 tooltip。
  - 点击打开详情；键盘可聚焦（`tabindex=0`，Enter/Space）。
  - 覆盖层默认 `pointer-events:none`，仅签章框 `pointer-events:auto`，不阻断文字选择。
- 详情对话框/侧栏分区：
  1. **基本信息**：签章类型、签章 ID、签章时间、签章提供者、保护范围。
  2. **印章信息**：印章名称、类型、编码、制章日期、有效期、印章属性中的证书（若有）。
  3. **签章者**：证书主题（CN 优先）、颁发者、序列号、有效期、签名算法、时间戳有无。
  4. **页面位置**：页号、Boundary/Clip（mm）。
  5. **技术细节**（折叠）：ASN.1 版本、OID、dataHash、propertyInfo、解析 warning。
  6. **声明**： “本面板仅展示签章信息，未进行签名验证/证书链校验。”
- 颜色：未验证用中性灰，不用绿色勾；不要显示“有效”。
- 解析失败：显示“签章信息不完整”，列出可用字段和 warning；不阻断阅读。
- 移动端：详情用底部抽屉，签章列表全屏。

### 11.8 错误与限制

- `SignedValue.dat` 缺失、损坏、非标准版本：摘要仍显示；详情部分字段为空 + warning；缺失时不回退读取 `Seal.esl`。
- 文档只有 `Seal.esl`、没有 `SignedValue.dat`：无法提供签章时间/签章者/印章详情；条目仍显示，详情标注“缺少签名值文件”。这是当前简化方案的明确取舍。
- 非标“非标签章”：v1 的 `TBS_Sign` 结构可能不完整；保留能解析的字段，签章者/印章信息可能缺失。
- 证书主题含非 UTF8/BMPString：按 ASN.1 字符串类型解码；失败显示“无法解析”。
- 时间字段格式异常：保留原文 + warning；不猜测。
- 安全限制：单文件解析上限（如 16 MB）、DER 深度 ≤ 32、节点数 ≤ 100k、匹配数上限；解析在 try/catch 中，禁止 `eval`；不联网。
- 不做验签；如未来要做，必须是独立可选 API，且不能复用本面板的“未验证”状态冒充“已验证”。

---

## 12. 大规模文档（1000 页）

### 12.1 设计目标

- 打开 1000 页、单页 A4、总包 50–200 MB 的 OFD，首屏可用 ≤ 2 s（参考硬件）。
- 连续滚动 1000 页不卡顿；快速拖动滚动条不触发全量渲染。
- 缩放时可见页重渲染清晰；不要求一次性渲染全部页。
- 内存可控：桌面 ≤ 300 MB，移动 ≤ 120 MB（不含文档字节）。

### 12.2 关键措施

| 措施 | 说明 |
|---|---|
| 批量页尺寸 | `getPageInfos()` 一次拿全部页 mm 尺寸；不加载页面模型 |
| 虚拟滚动 | 1000 个页壳（精确尺寸），只为可见 ±1 页创建 canvas |
| 可见优先队列 | 当前视口优先，预取相邻页，缩略图最低 |
| 取消/代际 | 快速滚动/缩放取消旧任务，避免“渲染追赶” |
| LRU canvas | 桌面 10 页、移动 4 页；淘汰释放 canvas |
| 文本层按需 | 只给可见页建文字层；查找时按需抽取 |
| 缩略图懒加载 | 只渲染可见 ±5 项 |
| 缩放重渲染 | 防抖后按新 DPI 渲染可见页；旧 canvas CSS 拉伸过渡 |
| canvas 上限 | 32MP / 32767 px；超限降 DPI + warning |
| 空闲调度 | `requestIdleCallback` 预取/缩略图；无则 `setTimeout` |
| 关闭清理 | `document.close()`、取消任务、释放 canvas/URL/缓存 |

### 12.3 不需要瓦片/局部渲染

- 1000 页、A4、最大 4x 缩放下，单页 canvas 约 `(210mm*4*96/25.4) × (297mm*4*96/25.4) ≈ 3175×4490 ≈ 14.3MP`，低于 32MP；不需要瓦片。
- 极端大页（A0/A1）或高倍缩放（>4x）可能超过 32MP：降低输出 DPI、CSS 放大，或提示“当前缩放超出清晰渲染上限”。
- 如果未来上限提高到 10000 页或要求 8x 无损，再引入 `renderRegion`/瓦片；MVP 不做。

### 12.4 渲染调度细节

- 滚动时每帧只更新可见页集合；滚动停止 100 ms 后开始渲染，避免滚动中抢 CPU。
- 当前页优先；预取下一页/上一页各 1 页；移动端关闭预取。
- 同一页缩放/旋转/重试时，旧任务取消；`generation` 不匹配的结果丢弃。
- 渲染任务之间让出主线程：`await new Promise(r => requestAnimationFrame(r))` 或 `scheduler.postTask`（可用时）。
- 页面加载失败不自动无限重试；最多 1 次自动重试，之后手动。

### 12.5 滚动锚点

- 缩放/旋转/窗口 resize 前记录 `anchorPage` + `anchorOffsetRatio`（页内滚动偏移 / 页高）。
- 重排后按新 offsets 恢复 `scrollTop = offsets[anchorPage] + anchorOffsetRatio * pageHeight`。
- 页码跳转/大纲跳转也走同一锚点逻辑，避免“跳过去又漂移”。

### 12.6 性能指标（P1，延期，非 MVP 门禁）

> **状态（2026-10）：按用户决定暂缓性能优化、先补手势（F6），本节目标不再作为 MVP 验收门禁。**
>
> 1000 页、约 0.8 MB 的派生夹具多轮实测：打开（`open` 到首屏可交互）≈ 4716–7403 ms、全篇查找 ≈ 20260–30024 ms（最新一次复跑为 7403 ms / 30024 ms，随机器负载波动），均未达到下列 2.0 s / 5 s 目标；50–200 MB 真实夹具与目标信创机型复测尚未提供，因此不宣称性能达标。后续如需恢复性能工作，按 P1 重新排期并据实复测。

| 指标 | 目标（桌面参考机） |
|---|---|
| 打开到首页可交互（1000 页/100 MB） | ≤ 2.0 s |
| `getPageInfos`（1000 页） | ≤ 300 ms（缓存后 ≤ 50 ms） |
| 页切换（缓存命中） | ≤ 100 ms |
| 页切换（未缓存，A4@1x） | ≤ 500 ms |
| 缩放重渲染（可见 3 页） | ≤ 500 ms |
| 连续滚动帧率 | ≥ 50 fps（渲染中允许短时下降） |
| 全篇查找（1000 页，首次） | ≤ 5 s，可取消/有进度 |
| 内存（桌面/移动） | ≤ 300 MB / ≤ 120 MB |

指标需在目标信创机型上复测；不达标时优先优化文本抽取、缩略图队列和 canvas 缓存。

---

## 13. 引擎契约与缺口

### 13.1 现有能力

| 能力 | API | 状态 |
|---|---|---|
| 打开文档 | `OFDDocument.open(options)` | 已有 |
| 页数 | `document.pageCount` | 已有 |
| 页句柄 | `document.getPage(index)` | 已有 |
| 页尺寸 mm | `page.getSize()` | 已有（逐页） |
| 视口 px | `page.getViewport({dpi})` | 已有 |
| 渲染 | `page.render({canvasContext, viewport, signal})` | 已有 |
| 取消 | `RenderTask.cancel()` | 已有 |
| 导出图片 | `page.exportImage(options)` | 已有 |
| 关闭 | `document.close()` | 已有 |
| warning/error | `OFDWarning` / `OFDError` | 已有 |

### 13.2 必须新增（MVP 阻塞）

| API | 契约要点 | 优先级 |
|---|---|---|
| `document.getPageInfos(options?)` | 返回 `PageInfo[]`：`{ index, widthMm, heightMm, xMm?, yMm? }`；只读 Page.xml/Area，不加载完整页面模型；支持 `signal`、分批/缓存；缺失页 warning 后跳过 | **P0** |
| `page.getTextContent(options?)` | 按 [v1.1 文本内容 API 设计](./text-content-api.md)：px 坐标、`TextItem`/`TextChar`/`TextQuad`、`dpi`、`includeChars`、`includeAnnotations`、`signal`、上限、缓存 | **P0** |
| `document.getOutline(options?)` | `OutlineNode[]`；解析 `Document/Outlines`；`Dest`→`DocumentDestination`；无效目标 warning | **P0** |
| `document.getBookmarks(options?)` | `BookmarkItem[]`；解析 `Document/Bookmarks` | **P0** |
| `document.getSignatureEntries(options?)` | 只读 `Signatures.xml`/`Signature.xml`；返回 `SignatureEntryInfo[]`（ID/Type/Provider/时间/戳记/`SignedValue` 路径）；不读 `SignedValue.dat`、不解析 ASN.1 | **P0** |
| `document.getSignedValue(id, options?)` | 按需返回 `SignedValue.dat` 原始字节；不解析；未声明返回 `undefined` 不 warning，声明但缺失返回 `undefined` + warning；缓存/取消 | **P0** |

### 13.3 建议新增（体验/性能）

| API | 说明 | 优先级 |
|---|---|---|
| `page.prepare({ signal })` | 预取页面模型/字体/图片，分离准备与绘制，供滚动预取 | P1 |
| `document.getMetadata()` | `DocInfo`（Title/Author/Subject/CreationDate/ModDate/Creator/Keywords/DocID）+ OFD 版本/页数/包大小 | P1 |
| `page.render` 进度回调 | 大页面渲染进度/耗时；可选 | P2 |
| `exportImage({ rotation })` | 导出时直接旋转；不做则 UI 用离屏 canvas | P2 |
| `document.getPermissions()` | OFD `Permissions`（打印/复制等），用于禁用按钮 | P2 |
| `document.getAttachments()` / `getAttachmentData()` | 附件面板；MVP 未选 | P2 |
| `page.renderRegion({ x,y,width,height,dpi })` | 局部/瓦片渲染；1000 页 MVP 不需要 | P2（未来） |

### 13.4 API 设计约束

- 页索引 0-based，页码 1-based 只在 UI。
- 尺寸/坐标单位明确：`PageInfo`、`Boundary`、`Dest` 用 mm；`getTextContent` 用 px；`getViewport` 用 px。
- 所有 IO 型 API 异步、可取消、可缓存；错误用 `OFDError`，warning 不中断。
- 新增 API 不破坏现有 v1 契约；文本 API 按 v1.1 增量发布。
- `getPageInfos` 不得为了取尺寸而完整 `preparePage`/解码图片/字体；否则 1000 页打开会退化。
- 引擎**不引入** `asn1js`/`asn1.js`/`@peculiar/*`；ASN.1/X.509 解析全部在 UI 包内动态加载，只在打开签章详情时进入。
- 新增 warning 码建议（字符串允许扩展）：
  - 引擎：`W_TEXT_ITEM_LIMIT` / `W_TEXT_CHAR_LIMIT`（v1.1 已定义）、`W_SIGNATURE_ENTRY`、`W_SIGNATURE_RESOURCE`、`W_OUTLINE_TARGET`、`W_PAGE_INFO_MISSING`
  - UI：`W_SIGNATURE_ASN1`、`W_SIGNATURE_CERT`、`W_SIGNATURE_EMPTY`

### 13.5 与现有引擎代码的衔接

- `packages/ofdrw-viewer-engine/src/model/seal.ts` 已有 `findSealStructure`/`decodeSealImage`，用于**渲染签章外观**；不要把它扩展成公开的签章信息解析器。公开 API 只返回 `SignedValue.dat` 字节。
- `packages/ofdrw-viewer-engine/src/model/asn1.ts` 是最小 DER 读取器，仅服务现有外观提取；**不要继续手写扩展**，也不要让引擎承担 X.509/SES 语义。
- `packages/ofdrw-viewer-engine/src/model/signature.ts` 已解码 `Signatures.xml`/`Signature.xml` 和 `SignatureBundle`，但未公开；在其上加 `getSignatureEntries`/`getSignedValue`，只结构化 XML 和读字节，不解析 ASN.1。
- `docs/text-content-api.md` 已给出完整文本契约，直接按它落实现；UI 不另造一套文本模型。

---

## 14. 包结构、构建与依赖

### 14.1 目录

```text
packages/ofdrw-viewer-ui/
  package.json
  tsconfig.json
  tsup.config.ts
  src/
    index.ts
    viewer.ts
    document-controller.ts
    page-layout.ts
    page-view.ts
    render-queue.ts
    event-bus.ts
    state.ts
    types.ts
    options.ts
    errors.ts
    i18n/
      index.ts
      zh-CN.ts
      en-US.ts
    theme/
      tokens.css
      viewer.css
      print.css
    ui/
      toolbar.ts
      sidebar.ts
      findbar.ts
      dialog.ts
      toast.ts
      icons.ts
    views/
      thumbnails.ts
      outline.ts
      bookmarks.ts
      signatures.ts
    text/
      text-layer.ts
      find-controller.ts
      selection.ts
    print/
      print-service.ts
    export/
      export-service.ts
    signature/
      signature-service.ts
      signature-summary.ts
      signature-detail.ts
      asn1/
        ses-schema.ts
        x509.ts
        oids.ts
        limits.ts
    component/
      ofd-viewer-element.ts
    react/
      index.ts
      OFDViewer.tsx
    vue/
      index.ts
      OFDViewer.ts
  test/
  demo/
```

### 14.2 依赖

| 依赖 | 用途 | 引入方式 |
|---|---|---|
| `@ofdrw/ofdrw-viewer-engine` | OFD 打开/渲染/导出 | workspace 依赖 |
| `asn1js` | ASN.1 DER/BER 解析 | 动态 import，签章详情专用 |
| `@peculiar/asn1-schema` | 类型化 schema | 动态 import |
| `@peculiar/asn1-x509` | X.509 证书解析 | 动态 import |
| `fflate` | 多页导出 ZIP | 按需 import |
| `react` / `react-dom` | React wrapper | 可选 peer，`>=18`；核心不 import |
| `vue` | Vue wrapper | 可选 peer，`>=3.3`；核心不 import |

- 核心入口不引入 React/Vue；只有 `./react`、`./vue` 子路径 import 对应框架。
- 不引入 pdf.js 运行时；只参考模式。
- 不依赖 Node 内置模块（`Buffer`、`fs`）；`asn1js` 满足。
- 已定 `asn1js` + `@peculiar/*`；不再为 `asn1.js` 加 `buffer` polyfill。

### 14.3 构建

- `tsup` 输出 ESM + CJS + `.d.ts`；CSS 单独文件，`exports` 提供 `./style.css`。
- `sideEffects` 标注 CSS；避免把整个 UI 树摇掉。
- 目标 `es2020`；不输出可选链之外的过新语法（可选链/空值合并自身在 ES2020，目标浏览器支持）。
- 动态 import 签章 ASN.1 解析器，形成独立 chunk；首屏不加载。
- 若使用 `@peculiar/asn1-schema` 的装饰器 schema，`tsconfig` 需开启 `experimentalDecorators`；也可改用手写 schema 函数，避免装饰器/元数据依赖。
- 类型导出：`OFDViewer`、选项/事件/状态类型；内部模块不导出。
- 提供 `exports`：
  - `.` → 核心 JS + types
  - `./react` → React wrapper
  - `./vue` → Vue wrapper
  - `./element` → Web Component（`./component` 可保留为别名）
  - `./style.css` → 主题样式
- React/Vue 作为 external，不打包进核心；只有对应子路径 import 对应框架。
- 核心入口、`./element` 不得 import React/Vue。

### 14.4 包名与发布

- 包名：`@ofdrw/ofdrw-viewer-ui`；目录保持 `packages/ofdrw-viewer-ui`。
- **单包 + 子路径导出**：核心、React、Vue、Web Component 同版本发布；暂不拆独立包。
- 版本：从 `0.1.0` 开始；与引擎版本解耦，但 peer/workspace 约束引擎 `^0.1.0`。
- `react`/`react-dom` `>=18`、`vue` `>=3.3` 作为可选 `peerDependencies`，用 `peerDependenciesMeta` 标记 optional；不安装不影响核心/纯 HTML。
- 发布范围：npm 公开包，`publishConfig.access = public`；各子包已移除 `private` 标记。
- 发布前检查：许可证、NOTICE、README、API 文档、demo、类型声明、CSS 导出、子路径 `exports` 解析。

### 14.5 测试

- 单元（vitest）：布局计算、缩放模式、页码/锚点、查找匹配、文本层定位、ZIP 文件名、签章字段映射。
- 组件/集成（Playwright）：打开本地 OFD、翻页、缩放、旋转、缩略图、大纲、查找、选择复制、打印 DOM、导出下载、签章详情。
- 框架 wrapper：React Testing Library + Vue Test Utils，覆盖挂载/卸载、source 切换、事件映射、ref 方法、StrictMode 双挂载、`shallowRef/markRaw`；React 18/19、Vue 3.3+ 各跑一遍。
- 三端一致性：独立 HTML、React、Vue 打开同一夹具，页码/缩放/查找/打印行为一致；`features.toolbar=false` 时主区域布局正确。
- 功能开关：逐个开关验证控件隐藏/禁用、快捷键不响应、方法抛 `OFD_FEATURE_DISABLED`；`textLayer=false` 时 find/selection 联动；运行时 `setFeatures` 关闭已打开弹窗/进行中任务。
- 视觉回归：桌面/移动关键界面截图；不要求与 pdf.js 像素一致，但布局/间距/工具栏顺序一致。
- 按纯 SPA 设计，不跑 SSR/水合矩阵；仅保留“模块顶层不访问 DOM”的低成本约束。
- 性能：生成 1000 页 OFD 的脚本/夹具；记录首屏、页切换、缩放、查找、内存。
- 可访问性：axe 扫描 + 键盘走查 + 读屏抽查。
- 签章夹具：`references/ofdrw/ofdrw-gm/src/test/resources/` 的 `UserV1.esl`、`UserV4.esl`、`UserV5.esl`、`SignedValueV4.dat`、`SignedValueV5.dat`、`Signature.xml`；覆盖 v1/v4/v5、损坏、缺证书、非标章。
- 兼容：Chrome/Edge 最新、Android Chrome、iOS Safari 15+、信创 Chromium 目标版本。

### 14.6 框架集成（React 18/19 + Vue 3）

结论：**核心不依赖框架，React/Vue 只做薄 wrapper；独立 HTML、Web Component、React、Vue 共用同一份阅读器实现。**

```text
@ofdrw/ofdrw-viewer-ui（核心，无框架依赖）
  ├─ 独立 viewer.html（宿主，不是另一套实现）
  ├─ <ofd-viewer> Web Component（可选，light DOM）
  ├─ @ofdrw/ofdrw-viewer-ui/react（薄适配）
  └─ @ofdrw/ofdrw-viewer-ui/vue（薄适配）
```

#### 14.6.1 共同契约

- wrapper 不复制 UI，不另写布局/渲染/查找/打印；只做挂载、props 同步、事件映射、ref 暴露。
- 粗粒度受控：`source`、`page`（可选）、`scale`（可选）、`theme`、`locale`、`features`；滚动、选区、查找当前项、渲染队列仍由核心内部管理。
- `features` 是对象 prop：变化时调 `setFeatures(patch)`，不重建实例；`featureschange` 只更新宿主 UI，不回写成新对象，避免事件回环。
- 细粒度操作走核心方法：`goToPage`、`setScale`、`findNext`、`print`、`exportImage`、`getFeatureState`、`getState` 等。
- 事件以核心 `CustomEvent`/回调为准，wrapper 只改命名风格（React `onPageChange`，Vue `@page-change`）；不新增第二套语义。
- `source` 变化调用 `open()`，不重建实例；旧打开任务要取消，避免旧文档事件覆盖新状态。
- wrapper 卸载调用 `destroy()`；核心 `destroy()` 必须幂等。

#### 14.6.2 React wrapper

- `forwardRef` + `useImperativeHandle` 暴露 `OFDViewerHandle`（方法子集 + `getInstance()`）。
- `useEffect` 只创建一次 viewer；回调 props 用 ref 保存，避免回调 identity 变化导致重建。
- `source` 单独 effect 调 `open()`；`page`/`scale`/`theme`/`features` 等用受控同步，内部加 `isSyncing` 防止事件回环。
- React StrictMode 双挂载：创建/销毁/取消都要能重入；不要在 render 阶段访问 DOM。
- 不在每次 `pagechange` 时重建组件；宿主需要页码 UI 时只更新小状态，不把 canvas/滚动状态放进 React state。
- 纯 SPA，不承诺 SSR；但核心模块顶层不访问 `window`/`document`，成本很低，保留。

#### 14.6.3 Vue wrapper

- `defineComponent` + `props`/`emits`/`expose`；`page` 可选 `v-model:page`。
- 实例用 `shallowRef` + `markRaw`，**不要**放进 `reactive()`；否则内部 DOM/Map/大对象被代理。
- `onMounted` 创建，`onBeforeUnmount` 销毁；`watch` 监听 `source`/`page`/`scale`/`theme`/`features`，同样防止事件回环。
- `expose` 方法子集 + `getInstance()`；事件名用 kebab-case。
- KeepAlive 下组件被缓存时核心仍持有 DOM/渲染任务；MVP 不自动暂停，宿主避免缓存大量 viewer。

#### 14.6.4 自定义 UI 与样式

- 默认使用内置工具栏/侧栏/查找栏；主题通过 `--ofd-*` 变量和 `theme` 控制。
- 需要宿主自绘工具栏时设 `features.toolbar=false`：核心不渲染工具栏，主区域占满；宿主用 `getState().features` + 事件渲染自己的 React/Vue 工具栏，再调核心方法。
- MVP 不做 slot 深度定制；不把 React/Vue 节点塞进核心 DOM。后续确有需求再设计 `toolbarContainer`/slot 边界。
- 样式走 light DOM + `.ofd-viewer` 前缀；CSS 单独入口 `@ofdrw/ofdrw-viewer-ui/style.css`，由宿主显式引入，wrapper 不自动注入。
- 不默认 Shadow DOM：打印、文本选择、全屏、全局主题在 light DOM 下问题最少；未来如需隔离再提供 `shadow` 选项。
- 宿主容器避免 `transform`/`overflow: hidden` 破坏全屏与滚动；wrapper 只负责最外层尺寸。

#### 14.6.5 包与版本

- 单包 + 子路径：`@ofdrw/ofdrw-viewer-ui`、`/react`、`/vue`、`/element`、`/style.css`；同版本发布。
- React/Vue 为可选 peer，核心不 import；构建时 external。
- 先不拆独立包；等 wrapper 发版节奏或 peer 约束明显分叉，再拆。

#### 14.6.6 明确不做

- 不做 React/Vue 各一套 UI 实现。
- 不做完全受控组件（滚动/渲染/选区全部交给框架状态）。
- MVP 不做 headless controller、slot 深度定制、默认 Shadow DOM。
- 不承诺 SSR/水合；纯 SPA 是明确边界。

---

## 15. 浏览器兼容与信创

### 15.1 基线建议

| 环境 | 目标 |
|---|---|
| 桌面 Chrome/Edge | 最近 2 个稳定版 |
| 移动 Android Chrome | Android 10+，Chrome 最近 2 个稳定版 |
| iOS Safari | 15+ |
| 信创 Chromium | 内核 86/94/102 等主流版本（需实测） |

- 不把 pdf.js 6.x 的浏览器基线当作本项目基线；只借鉴 UI。
- 目标语法 ES2020；构建产物不包含未降级的可选链之后的新语法（按目标浏览器确认）。
- 不使用 `light-dark()`、`:has()`、CSS `subgrid`、`@container` 等新特性作为必需能力。
- 必需 API：`ResizeObserver`、`IntersectionObserver`、`PointerEvent`、`AbortController`、`Promise.finally`、`Map/Set`、`requestAnimationFrame`；这些在 Chromium 86+ 均可用。
- 可选 API（需回退）：
  - `navigator.clipboard` → `execCommand('copy')`
  - `Element.requestFullscreen` → 沉浸模式
  - `createImageBitmap` → 普通 canvas
  - `OffscreenCanvas` → 不依赖
  - `requestIdleCallback` → `setTimeout`
  - `Intl.Segmenter` → 不用（中文不依赖分词）
  - Web Components → 可选，不影响核心类库
  - `structuredClone` → 手动浅拷贝/JSON（仅用于简单状态）

### 15.2 触摸与移动端

- 双指捏合缩放：监听 `touchstart/move`，计算两点距离，映射 scale；阻止页面默认缩放（在容器内）。
- 双击缩放：切换 1x / 适合宽度。
- 单指滚动交给浏览器；不做 preventDefault，保证惯性滚动。
- 文本选择：长按选择；签章覆盖层不阻断（仅框本身可点）。
- 移动端打印：`window.print()` 在 iOS 可能只打印当前可视区域；提供“导出图片”作为可靠替代。
- 地址栏/安全区：使用 `env(safe-area-inset-*)`；底部工具栏避开 Home 指示条。

### 15.3 CORS 与 URL

- URL 来源需要服务端允许 CORS；引擎默认用 Range 请求，服务端需支持 `Range`/`Content-Range`；不支持时回退全量下载（引擎已有策略）。
- 公开 URL 不需要认证；企业系统可传 `headers`（预留），但 MVP 不实现登录/刷新 token。
- 本地文件用 `<input type=file>`/拖拽；拖拽需 `preventDefault` 并校验扩展名/MIME。
- 不在 URL 中放敏感 token；如必须，使用宿主提供的 `headers`。

### 15.4 CSP

- 文本层/页面定位需要内联 `style`；若宿主 CSP 禁止 `style-src 'unsafe-inline'`，需通过 CSSOM 设置样式或使用 nonce。设计默认允许内联样式；文档需说明。
- 不使用 `eval`/`new Function`；ASN.1 解析不执行内容。
- 图标内联 SVG；不使用远程字体/图片。

---

## 16. 安全、隐私与许可

- **不验签**：签章面板明确“未验证”；不得把“有签章”表述为“文档有效”。
- **证书信息**：只本地展示；不上传；详情缓存只在内存，`close()` 清理。
- **ASN.1 解析**：限制输入大小/深度/节点数；捕获异常；不递归展开未知结构；不解析证书扩展中的任意 OCTET STRING。
- **文本层**：用 `textContent` 创建节点，不拼 `innerHTML`；避免 XSS。
- **URL**：不把用户输入直接插入 `innerHTML`；文件名清洗；下载 URL 用 `URL.createObjectURL` 并 revoke。
- **剪贴板**：只在用户手势内调用；失败回退。
- **许可**：
  - pdf.js Apache-2.0：不复制源码；如复用，保留许可/NOTICE。
  - `asn1js` BSD-3、`@peculiar/*` MIT、`fflate` MIT；发布时汇总 NOTICE。
  - 项目自身许可证待确认；根仓库当前无 LICENSE 文件，发布前补齐。

---

## 17. 里程碑与风险

### 17.1 里程碑

| 阶段 | 内容 | 依赖 |
|---|---|---|
| M0 | 引擎 P0 API：`getPageInfos`、`getTextContent`、`getOutline`、`getBookmarks`、`getSignatureEntries`、`getSignedValue` | 引擎排期 |
| M1 | 包骨架、`OFDViewer`、打开/渲染首页、工具栏、页码、缩放/旋转/全屏 | M0 的 `getPageInfos` |
| M2 | 连续滚动、虚拟页壳、渲染队列、LRU、1000 页性能 | M1 |
| M3 | 缩略图、大纲、书签 | M0 outline/bookmarks |
| M4 | 文本层、选择/复制、查找 | M0 text |
| M5 | 打印、导出（含 ZIP） | M1 |
| M6 | 签章摘要/详情/覆盖层 | M0 signature + ASN.1 |
| M7 | 响应式、主题、a11y、信创兼容、E2E、文档、发布 | 全部 |

### 17.2 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 文本 API 未实现 | 查找/选择/复制无法交付 | 列为 M0 阻塞；先落 v1.1；不伪造文本层 |
| 签章 ASN.1 变体多/非标 | 详情字段缺失/解析失败 | 容错解析、warning、保留摘要；用 ofdrw-gm 夹具覆盖 v1/v4/v5 |
| 1000 页性能不达标 | 滚动卡顿/内存高 | 虚拟滚动、可见优先、LRU、canvas 上限；压测后调队列/缓存 |
| 大页高倍缩放超 canvas 上限 | 模糊/失败 | 降 DPI + CSS 放大 + warning；未来 renderRegion |
| 混合页尺寸打印 | 分页/缩放不正确 | 命名 `@page` 分组；旧内核回退 auto |
| 信创浏览器 API 缺失 | 功能降级 | 特性检测 + 回退；目标版本实测 |
| 旋转下选区错位 | 复制体验差 | 回归测试；提供“复制本页文本” |
| 1000 页全量查找慢 | UI 卡顿 | 分片、缓存、进度、取消；默认从当前页开始 |
| 用户误以为已验签 | 合规/信任风险 | UI 明确“未验证”；文档/文案统一 |
| pdf.js 许可 | 合规 | 不复制源码；如需复用保留 NOTICE |

### 17.3 已确认与待确认

已确认：

- 文本/空间信息按 [v1.1 文本内容 API 设计](./text-content-api.md) 落实现；当前 `main` 未实现，作为 M0 阻塞。
- 框架：React 18/19 + Vue 3；纯 SPA，不做 SSR。
- UI：默认内置；具体功能统一用 `features` 开关（§4.7），`features.toolbar=false` 时宿主自绘工具栏；MVP 不做 slot 深度定制。
- 包：单包 + 子路径导出（`/react`、`/vue`、`/element`、`/style.css`）。
- ASN.1：`asn1js` + `@peculiar/asn1-schema` / `@peculiar/asn1-x509`，UI 侧动态加载；引擎不解析电子签章。
- 签章资源：`Seal.esl` 不进入公开 API；`SignedValue.dat` 的 `TBS_Sign.eseal` 已含印章信息。只保留 `getSignedValue(id)`，不再暴露 `kind`；`SignedValue.dat` 缺失时返回 `undefined`，不回退 `Seal.esl`。

待确认：

1. **发布范围**：已确认 `@ofdrw/ofdrw-viewer-ui` 以 npm 公开包发布；`publishConfig.access = public`。
2. **信创最低内核**：需要支持到 Chromium 86/94/102 中的哪一档？是否要兼容 Windows 7 上的旧版 Chrome？
3. **打印默认精度**：接受“按页数自适应 200/150/96 DPI”吗？还是固定 150 DPI？
4. **签章详情范围**：已确认展示签署时间、签署人、证书主题；是否还要展示印章属性 `certList` 中的证书（若有）、保护范围、dataHash/propertyInfo 等技术字段（默认折叠）？
5. **文档属性**：MVP 是否需要“文档属性”对话框（Title/Author/CreationDate 等）？当前列为 P1。

---

## 18. 附录

### 18.1 pdf.js 功能映射

| pdf.js | 本项目 | 说明 |
|---|---|---|
| `PDFViewer` | `OFDViewer` | 重写，不依赖 PDF 代理 |
| `PDFPageView` | `PageView` | canvas + 文字层 + 签章层 |
| `PDFRenderingQueue` | `RenderQueue` | 可见/预取/缩略图优先级 |
| `PDFFindController` | `FindController` | 文本 API 换成 OFD `getTextContent` |
| `PDFThumbnailViewer` | `ThumbnailViewer` | 低 DPI 渲染 |
| `PDFOutlineViewer` | `OutlineView` + `BookmarkView` | OFD 有独立书签 |
| `PDFAttachmentViewer` | 不做 | MVP 不含附件 |
| `PDFPrintService` | `PrintService` | 图片 + `@page`，不生成 PDF |
| `PDFHistory` | `History` | 可选 hash |
| `PDFLinkService` | `DestResolver` | 大纲/书签/未来链接 |
| `TextLayerBuilder` | `TextLayerBuilder` | 透明文字层 |
| `AnnotationLayer` | `SignatureLayer` | 只做签章交互，不编辑注释 |
| `Toolbar` | `Toolbar` | 顺序/交互参考，样式自有 |
| `SecondaryToolbar` | 不做/更多菜单 | 简化 |

### 18.2 术语

| 术语 | 含义 |
|---|---|
| 引擎 | `@ofdrw/ofdrw-viewer-engine` |
| UI 包 | `@ofdrw/ofdrw-viewer-ui` |
| 页壳 | 只含尺寸/占位、不含 canvas 的页面 DOM |
| 代际 | 页面渲染任务版本号；旧代际结果丢弃 |
| DPI | 每英寸点数；引擎 `getViewport({dpi})` 使用 |
| mm→px | `px = mm * 96 / 25.4`（CSS px，96 DPI） |
| 未验证 | 仅展示签章信息，未做密码学验证 |

### 18.3 参考文件

- [引擎 API 与功能说明](./ofdrw-viewer-ui-engine-api.md)
- [OFD 渲染引擎设计方案](./OFD渲染引擎设计方案.md)
- [v1.1 文本内容 API 设计](./text-content-api.md)
- [引擎公共契约](./CONTRACTS.md)
- [引擎页面 API](../packages/ofdrw-viewer-engine/src/api/page.ts)
- [引擎签章外观解析](../packages/ofdrw-viewer-engine/src/model/seal.ts)
- [引擎最小 DER 读取器](../packages/ofdrw-viewer-engine/src/model/asn1.ts)
- [ofdrw-gm SES v1](../references/ofdrw/ofdrw-gm/src/main/java/org/ofdrw/gm/ses/v1/SESeal.java)
- [ofdrw-gm SES v4](../references/ofdrw/ofdrw-gm/src/main/java/org/ofdrw/gm/ses/v4/SESeal.java)
- [ofdrw-gm SES v5](../references/ofdrw/ofdrw-gm/src/main/java/org/ofdrw/gm/ses/v5/SESeal.java)
- [GM/T 0031-2014 规范 PDF](../references/ofdrw/ofdrw-gm/doc/GMT_0031-2014_安全电子签章密码技术规范.pdf)

---

**评审重点**：§9.1 文本 API 现状、§11.4 ASN.1 选型、§12 1000 页策略、§13 引擎 P0 缺口、§17.3 待确认项。