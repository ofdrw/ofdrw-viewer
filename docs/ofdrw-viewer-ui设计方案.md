# @ofdrw/ofdrw-viewer-ui 设计方案

| 项 | 内容 |
|---|---|
| 状态 | 已实现；v2 密码能力增量已同步；加载动画需求已补充（待实现） |
| 版本 | 0.2-r2 |
| 日期 | 2026-10-23 |
| 目标包 | `packages/ofdrw-viewer-ui`，包名 `ofdrw-viewer-ui` |
| 依赖 | `@ofdrw/ofdrw-viewer-engine`、`@ofdrw/ofdrw-viewer-crypto`、[v1.1 文本内容 API 设计](./text-content-api.md)、[OFD 渲染引擎设计方案](./OFD渲染引擎设计方案.md)、[OFD 渲染引擎生命周期与事件设计](./OFD渲染引擎生命周期与事件设计.md)、[密码能力总体设计](./ofdrw-viewer-crypto设计方案.md) |
| 参考实现 | pdf.js 6.x viewer（`viewer.html` / `viewer.css` / `app.js` / component 层） |
| 明确不做 | OFD 渲染、PDF 导出、OCR、在线批注编辑；密码学算法/ASN.1/验签由 crypto 包实现，UI 不重复实现 |

## 0. 结论摘要

1. **不 fork pdf.js viewer**。pdf.js 的 `PDFViewer` 与 `PDFDocumentProxy` / `PDFPageProxy` 强耦合（视口、文字、注释、可选内容都走 pdf.js 内部对象），替换后端的工作量和风险都高于重写 UI 层。复用它的**布局、交互、渲染队列、文字层、查找、历史记录和快捷键模式**，代码按 OFD 引擎重写。
2. **UI 采用“框架无关核心 + 可选薄适配”**。核心 `OFDViewer` 是一个不依赖框架的类；`<ofd-viewer>`、React、Vue 只做属性/事件/生命周期桥接，不把核心逻辑放进组件，也不按框架重写阅读器。
3. **MVP 范围**：基础阅读、缩略图、大纲/书签、查找与文本选择/复制、打印/导出图片、签章信息；v2 增加加密打开、验证面板、印章点击验证与根证书配置（时间戳只解析）。
4. **大规模页按 1000 页设计**：批量页尺寸 + 虚拟滚动 + 可见页渲染 + LRU 缓存；缩放时**重新渲染**保证清晰，不做 CSS 放大糊图；1000 页以内不需要瓦片/局部渲染。
5. **文本层是一层透明文字覆盖**，坐标来自引擎 `OFDPage.getTextContent`；该 API 已按 [v1.1 文本内容 API 设计](./text-content-api.md) 实现，查找/选择/复制按本文 §9 接入。
6. **签章与密码能力（v2 增量）**：engine 只返回 `Signature.xml` 元数据和 `SignedValue.dat`/`Seal.esl` 原始字节；UI 统一调用 `@ofdrw/ofdrw-viewer-crypto` 的 `parseSignedValue`/`parseSeal`/`verifyOfd`，不再维护第二套 ASN.1 解析器。验证面板和印章浮层展示签名数学结果、Reference、证书链、防夹带完整性和印章结果；**时间戳只解析、不验证**，无根证书时链状态为 `unknown`，绝不把“有签章”表述为“文档有效”。
7. **打印/导出**：支持当前页、页码范围、全部页；打印用图片 + `@page`，导出支持 PNG/JPEG/WebP，多页导出打包 ZIP；1000 页大任务采用自适应 DPI 和进度/取消。
8. **框架集成**：核心不依赖 React/Vue；提供 React 18/19、Vue 3 的薄 wrapper；按纯 SPA 设计，不做 SSR；单包 + 子路径导出；默认内置 UI，同时提供 `features.toolbar=false` + 命令/事件，允许宿主自绘工具栏。详见 §14.6。
9. **加载动画由引擎事件驱动**：文档全屏 loading 在页壳布局完成后撤；页面首次渲染用骨架，重渲染保留旧画面；缩略图只对渲染窗口显示骨架；不新增公开 UI 事件。详见 §6.9。

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
- 不实现密码学算法/ASN.1/证书链/验签；这些由 `@ofdrw/ofdrw-viewer-crypto` 实现，UI 只做交互、状态展示与宿主凭据/根证书适配。时间戳仅展示解析结果，不验证 TSA 签名、ESSCertID 或策略链；不做 OCSP/CRL。
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
│  ├─ SignatureService（签章摘要/详情/覆盖层）                   │
│  ├─ CryptoService（inspect/凭据/解密容器/验证面板/根证书）     │
│  ├─ EventBus / Theme / I18n / Keyboard / History / A11y       │
├──────────────────────────────────────────────────────────────┤
│ @ofdrw/ofdrw-viewer-crypto（inspect/decrypt/verify/parseSeal） │
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
| `SignatureService` | 签章摘要、详情、页面覆盖层、印章点击；消费 crypto 报告并校准缓存 | 不实现 ASN.1/验签 |
| `CryptoService` | `inspect`、凭据弹窗/预置凭据、解密容器、验证面板、根证书、报告状态机 | 不渲染页面/不绘制 Canvas |
| `EventBus` | 类型化事件、订阅/退订、错误隔离 | 不做全局单例 |
| `Theme` | light/dark/auto、CSS 变量、高对比 | 不硬编码颜色 |
| `I18n` | 文案字典、`Intl` 日期/数字 | 不引重型 i18n 运行时 |
| `Keyboard` | 快捷键、输入框保护、焦点管理 | 不劫持浏览器保留键 |

### 3.3 状态模型

```text
DocumentState:
  source, pageCount, pageInfos[], metadata?, signaturesSummary[],
  inspection?, verificationReport?, cryptoStatus: disabled|plaintext|encrypted|error,
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
open(source)  // 取消上一次打开
  → normalizeViewerSourceDetailed(source)：URL → HttpByteSource → { kind: 'custom' }，保留 origin；字节/Blob 原样
  → crypto.prepareOpen(OFDSource)   // 内部映射为 CryptoSource；URL 共用同一个 HttpByteSource
      ├─ 明文 → engine.open({ source })
      └─ 加密 → 凭据 → crypto.openDecryptingContainer() → engine.open({ container })
  → autoVerify ? crypto.verifyOfd() → VerificationReport → UI 面板/浮层
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
| `source` | `ArrayBuffer \| Uint8Array \| Blob \| string \| { url, headers? }` | 必填 | 本地文件、Blob、公开 URL；URL 支持可选 headers（企业系统预留）。URL 由 UI 的 `HttpByteSource` 读取，engine 只收字节 |
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
| `crypto` | `CryptoViewerOptions` | 默认启用 | 凭据、根证书、验证面板/自动验证；`enabled=false` 仅允许明文文档 |

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
| `getSignatures()` | 签章摘要列表（详情解析由 crypto 包完成） |
| `getSignatureDetail(id)` | 按需解析详情（crypto 提供结构化字段） |
| `showSignature(id)` / `focusSignature(id)` | 打开详情/滚动到页面位置 |
| `verify(options?)` / `getVerificationReport()` | 重新验证/读取最近报告；`verification` 功能关闭时抛 `OFD_FEATURE_DISABLED` |
| `openVerificationPanel()` | 打开工具栏验证面板 |
| `setRootCertificates(roots)` / `getRootCertificates()` | 替换/读取信任根并触发重新验证；四态来源见 §11.5 |
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
| `verificationcompleted` | 一次验证完成（成功） | `VerificationReport` |
| `statechange` | 任意视图状态变化 | `ViewerState` |

> 加载动画不新增公开事件，也不改变 `documentopen` / `pagerendered` / `pagesloaded` 的载荷；`pagesloaded` 不作为 loading 的结束条件。当前实现中 `pagesloaded` 在 `renderVisible` 前派发，名称保留、派发时机本次不变。

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
| `--ofd-loading-skeleton` | 骨架底色 | `rgba(0,0,0,.06)` | `rgba(255,255,255,.08)` |
| `--ofd-loading-skeleton-strong` | 骨架脉冲高光 | `rgba(0,0,0,.12)` | `rgba(255,255,255,.16)` |
| `--ofd-loading-spinner` | spinner 主色 | `var(--ofd-accent)` | `var(--ofd-accent)` |

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
| `verification` | `true` | 工具栏验证入口、验证面板、印章点击验证 | 依赖 crypto；关闭后 `verify()` 拒绝、旧报告失效 |
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
- 加载态：
  - 首次渲染：页面中心低对比骨架脉冲 + 20 px spinner；`page:render:start` 后 150 ms 仍未完成才显示。
  - 重渲染：保留旧 canvas，叠加半透明遮罩 + 20 px spinner，避免缩放/旋转闪白。
  - 加载层阻断该页点击和文本选择，但不阻断主滚动容器。
- 错误态：页内错误占位 + “重试”按钮，不阻断其他页；取消/关闭不显示错误。
- 缩略图加载态：只对渲染窗口内、尚无 canvas 的项显示骨架；不单独放 spinner。
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
- 加载骨架用低对比度脉冲（约 1.6 s），spinner 约 0.9 s 线性旋转；只动画 `opacity` / `transform` / `background-position`。
- 文档全屏 loading：延迟 150 ms 显示、最短 300 ms、淡出 150 ms；页面 loading：延迟 150 ms、最短 200 ms、淡出 120 ms。
- `prefers-reduced-motion: reduce` 时关闭脉冲、旋转和淡出，保留静态骨架/静态圆环和文字。

---

## 6. 阅读核心

### 6.1 打开流程

1. `viewer.open()` 取消上一次打开（abort 在途请求），并**只规范化一次** `source`：URL → `HttpByteSource` → `{ kind: 'custom' }`，同时保留 origin 供标题/导出命名；ArrayBuffer/Uint8Array/Blob 原样转成 engine 来源。
2. `crypto.prepareOpen(OFDSource, signal)`：明文直接进入下一步；加密则 inspect/解密得到容器。crypto 与 engine 共用同一个 URL 字节源，不重复下载。
3. `OFDDocument.open({ source | container, signal })`；`document:open:start` 后 150 ms 仍未完成才显示全屏 loading；取消/切换文档/`close()` 都会中止打开。
4. 取 `pageCount`；调用 `getPageInfos()` 拿全部页尺寸（P0 新 API）。
5. `PageLayout` 建立 1000 个页壳（仅 DOM 壳，不含 canvas），计算总高度。
6. 初始页（默认第 1 页，或 hash/选项）；计算可见页。
7. 页壳布局完成（UI `documentopen`）后隐藏全屏 loading，页面骨架接管；再渲染可见页。`pagesloaded` 不作为 loading 结束条件。
8. 异步加载缩略图/大纲/书签摘要；签章摘要按需。
9. 若 `getPageInfos` 不可用：先 `getPage(0..N)` 取前若干页，剩余按 A4 估算并后台补齐；**这会滚动跳动，仅作为降级，不作为 1000 页正式方案**。

字节源生命周期：明文路径的 `HttpByteSource` 随 engine 容器关闭；加密路径由 UI 的 `activeHttpSource` 持有，在切换/失败/关闭时调用幂等 `close()`。`HttpByteSource`/`HttpByteSourceOptions` 从 UI 公共入口导出。

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
- 加载视觉：`page:render:start` 后 150 ms 仍未终止才显示；首次无 canvas 用骨架 + spinner，重渲染保留旧 canvas + 半透明遮罩。
- 事件归属：主页面和缩略图共用 `page.render()`，UI 在调用前登记 `purpose`，再用 `operationId` 区分；缩略图事件不能触发主页面 loading。
- 同一页多个主页面操作以最新 `operationId` 为准；旧操作晚到的 `abort` 不得关闭新操作的 loading。

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

加载动画由引擎事件驱动；事件归属、过滤和时序见 [引擎生命周期文档 §6](./OFD渲染引擎生命周期与事件设计.md)。本节定义 UI 视觉、动效、无障碍和验收。

#### 6.9.1 状态总表

| 层级 | 状态 | 进入条件 | 视觉 | 退出 |
|---|---|---|---|---|
| 文档 | `idle` | 初始/关闭后 | 空态 | `open()` |
| 文档 | `opening` | `document:open:start` | 150 ms 后显示全屏 loading | `documentopen` / error / abort |
| 文档 | `ready` | 页壳布局完成 | 全屏撤下，页面骨架接管 | 关闭 |
| 文档 | `error` | `document:open:error` | 全屏错误卡 + 重试/关闭 | 重试/关闭 |
| 文档 | `closed` | 取消/关闭 | 空态 | 重新打开 |
| 页面 | `empty` | 页壳创建 | 空白纸面 | 入队 |
| 页面 | `queued` | 进入渲染队列 | 不显示 loading | `page:render:start` |
| 页面 | `rendering` | `page:render:start` | 150 ms 后骨架/遮罩 + spinner | end/error/abort |
| 页面 | `rendered` | `page:render:end` | canvas | 淘汰/重渲染 |
| 页面 | `error` | `page:render:error` | 页内错误卡 + 重试 | 重试/重渲染 |
| 缩略图 | `idle` | 窗口外 | 静态页码占位 | 进入窗口 |
| 缩略图 | `queued` | 窗口内、无 canvas | 低对比骨架 + 页码 | 开始渲染 |
| 缩略图 | `rendering` | 开始 `page.render` | 骨架保持 | 成功/失败/取消 |
| 缩略图 | `rendered` | 渲染成功 | canvas | 淘汰 |
| 缩略图 | `failed` | 渲染失败 | 灰色占位 + 页码 | 点击重试 |

#### 6.9.2 文档全屏 loading

- 触发：`document:open:start` 后启动 150 ms 计时；150 ms 内完成（UI `documentopen`）则不显示，避免小文件闪屏。
- 显示后最短 300 ms，淡出 150 ms；结束点是 **UI `documentopen`**，不是引擎 `document:open:end`。取消或错误立即隐藏，不受最短展示限制。
- 全屏遮罩阻断阅读器交互，仅保留取消按钮；失败时保留重试/关闭。
- 内容：文档名/文件名（`File.name`、URL basename，缺失时“文档”）、不确定进度环、“正在打开文档…”和“取消”按钮。
- 不显示百分比；引擎没有字节进度，不做假进度。
- 取消：调用本次 `open()` 的 `AbortController.abort()`；按钮变“正在取消…”并禁用；取消后回空态，不弹错误 toast；如果引擎文档已经打开但 UI 未完成布局，必须调用 `document.close()` 清理。
- 错误：`document:open:error` 立即切换为全屏错误卡，显示 `OFD_*` 错误码和可读消息；提供“重试”和“关闭”。错误不等待 150 ms。`getPageInfos()` 或页壳布局失败也走同一全屏错误卡，不能停留在半成品页壳。
- 关闭：`document:close:start` 立即停止计时器并隐藏全屏，避免关闭后残留 loading。
- 无障碍：容器 `role="status"`、`aria-live="polite"`、`aria-busy="true"`；错误卡 `role="alert"`；取消按钮可键盘聚焦，但不自动抢焦点。

#### 6.9.3 页面 loading

- 触发：主页面 `page:render:start` 后启动 150 ms 计时；150 ms 内 end/error/abort 则不显示。
- 首次渲染（无 canvas）：页面中心低对比骨架脉冲 + 20 px spinner；骨架保持页面宽高比，避免布局跳动。
- 重渲染（有旧 canvas）：保留旧画面，叠加半透明遮罩 + 20 px spinner；完成后再替换 canvas，避免缩放/旋转闪白。
- 显示后最短 200 ms，淡出 120 ms；遮罩阻断该页点击和文本选择，但不阻断主滚动容器。
- 同一页多个主页面操作以最新 `operationId` 为准；旧操作晚到的 `abort` 不得关闭新操作的 loading。
- `page:render:end`：清除计时器，满足最短展示后隐藏；`PageView.completeRender()`；UI `pagerendered` 仍等 `task.promise` resolve。
- `page:render:error`：清除计时器，隐藏 loading，显示页内错误卡 + 重试；派发 UI `error`。
- `page:render:abort`：清除计时器，静默隐藏 loading；取消/关闭不显示错误。
- 缩略图渲染的 `page:render:*` 不得触发主页面 loading；主页面渲染也不更新缩略图项。

#### 6.9.4 缩略图骨架

- 只对渲染窗口内、尚无 canvas 的项显示骨架；窗口外 `idle` 项只显示静态页码，避免 1000 项同时动画。
- 状态：`idle`（静态页码）、`queued`（骨架）、`rendering`（骨架保留）、`rendered`（canvas）、`failed`（灰色占位 + 页码）。
- 缩略图不单独放 spinner；骨架是布局占位，不是模态 loading，立即显示，不做 150 ms 延迟。
- 失败不自动无限重试；用户点击该项重试。
- 骨架 `aria-hidden="true"`，按钮的页码 `aria-label` 保持可读。
- 缩略图事件与主页面事件按 `operationId` 分离；缩略图队列暂停/恢复不与主页面 loading 联动。

#### 6.9.5 视觉变量与文案

新增/复用 CSS 变量：

| 变量 | 用途 |
|---|---|
| `--ofd-loading-skeleton` | 骨架底色 |
| `--ofd-loading-skeleton-strong` | 骨架脉冲高光 |
| `--ofd-loading-spinner` | spinner 主色，默认 `var(--ofd-accent)` |
| `--ofd-page-overlay` | 页面遮罩，复用现有变量 |
| `--ofd-scrim` | 文档全屏遮罩，复用现有变量 |

新增文案键（zh-CN / en-US 同步）：

| 键 | zh-CN 示例 |
|---|---|
| `loading.document` | 正在打开文档… |
| `loading.cancel` | 取消 |
| `loading.cancelling` | 正在取消… |
| `loading.page` | 正在渲染页面… |
| `loading.pageNumber` | 第 {page} 页正在渲染… |

错误文案继续使用引擎 `OFDError.message`；UI 只补标题/按钮，不复制错误码表。

#### 6.9.6 动效与无障碍

- 骨架脉冲约 1.6 s；spinner 约 0.9 s 线性旋转；只动画 `opacity`、`transform`、`background-position`。
- `prefers-reduced-motion: reduce` 时关闭脉冲、旋转和淡出，保留静态骨架/圆环和文字。
- 全屏 `role="status"` + `aria-live="polite"` + `aria-busy="true"`；错误 `role="alert"`。
- 页面只在 `.ofd-page` 上设置 `aria-busy="true"`；不逐页创建 `aria-live`，避免 1000 页朗读轰炸。当前页如需播报，去抖 ≥ 500 ms。
- 骨架和 spinner 不得作为唯一状态表达；必须有文字或 `aria-busy`。
- 加载层对比度按 WCAG 2.1 AA；骨架是非文本装饰，不参与对比度门槛，但 spinner 和文案必须可辨识。

#### 6.9.7 验收用例

- 打开小文件 <150 ms：不出现全屏 loading，直接进入页壳。
- 打开慢文件 >150 ms：全屏 loading 出现；点击取消后回空态，无错误 toast，已打开文档被关闭。
- 打开失败：全屏错误卡出现，错误码/消息可见，重试可再次打开。
- 页面渲染 <150 ms：不出现页面 loading。
- 页面首次渲染 >150 ms：骨架 + spinner 出现；完成后淡出。
- 缩放/旋转重渲染：旧画面保留，遮罩 + spinner 出现，完成后替换，不闪白。
- 页面渲染失败：页内错误卡 + 重试；取消/关闭无错误卡。
- 缩略图：仅窗口内项播放骨架；1000 页不出现批量动画；失败项灰色占位，点击可重试。
- 主页面渲染时缩略图不出现主页面遮罩；缩略图渲染时主页面不出现遮罩。
- `prefers-reduced-motion` 下无脉冲/旋转/淡出。
- axe 扫描阅读器加载态/错误态 0 serious/critical。
- 不新增公开 UI 事件；`documentopen` / `pagerendered` / `pagesloaded` 载荷不变。

#### 6.9.8 实现落点

| 文件 | 职责 |
|---|---|
| `src/viewer.ts` | 创建 `OFDEventBus`、传 `eventBus`/`signal`；全屏 loading；`pendingStarts` 与 `operationId` 映射；取消清理 |
| `src/page-view.ts` | 页面骨架/遮罩、150 ms 计时、最短展示、错误卡片、latest operation |
| `src/views/thumbnails.ts` | 缩略图 `data-state`、窗口内骨架、失败占位、重试 |
| `src/style.css` | 新增 token、骨架/spinner keyframes、`prefers-reduced-motion` |
| `src/i18n/locales/zh-CN.ts` / `en-US.ts` | 新增 `loading.*` 文案键 |

#### 6.9.9 本期不做

- 不做字节/百分比进度；引擎事件不提供。
- 不做 phase/缓存命中/队列等待文案。
- 不新增公开 loading 事件或 `loading` 配置；颜色/尺寸走 CSS 变量。
- 不做大纲、书签、签章侧栏的加载动画；本期只覆盖主阅读区 + 缩略图。
- 不改 `pagesloaded` 的现有派发时机；加载动画不以它作为结束条件。

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
- 加载态：渲染窗口内、尚无 canvas 的项用低对比骨架 + 页码；窗口外只显示静态页码，不播放动画；缩略图不单独放 spinner。
- 状态：`data-state="idle|queued|rendering|rendered|failed"`；`queued`/`rendering` 显示骨架，`rendered` 显示 canvas，`failed` 灰色占位 + 页码。
- 失败：灰色占位 + 页码，不重试轰炸；用户点击可重试。
- 缩略图渲染的 `page:render:*` 事件只更新缩略图项，不能触发主页面 loading。
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
- **当前实现状态**：`packages/ofdrw-viewer-engine/src/api/page.ts` 已导出 `getTextContent(options)`，复用内部 `layoutText`/`preparePage`，支持分页/缓存/取消/上限；契约见 [v1.1 文本内容 API 设计](./text-content-api.md)。
- 因此文本层/查找/选择/复制可直接基于该 API 实现；仍需处理旋转/缩放下的选区几何与超限降级（见下文）。
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

## 11. 签章与密码能力（v2 增量）

### 11.1 目标与边界

- 展示文档中的签章、页面位置、印章名称/类型、签署时间、证书摘要，以及验证报告中的数学签名、Reference、证书链、防夹带完整性、印章和时间戳状态。
- **UI 不实现密码学**：SES v1/v4/v5 解析、SignedValue/Seal 解析、SM2/SM3/SM4、证书链/信任根/有效期、防夹带完整性和时间戳解析全部调用 `@ofdrw/ofdrw-viewer-crypto`。
- **时间戳只解析不验证**：状态固定 `parsed-not-verified`/`not-present`/`parse-error`，文案“已解析，未验证”/“无”/“不可解析”，不得显示“时间戳有效/可信时间”。
- **无根证书 = unknown**：不是 invalid，也不得显示 valid；配置根后重新验证才可能变为 valid。
- 不检查 CRL/OCSP，报告 `revocation: 'not-checked'`；不得声称吊销状态有效。

### 11.2 打开、解密与验证流程

```text
viewer.open(source)
  → 取消旧打开；单次 normalize：URL → HttpByteSource → { kind: 'custom' }
  → crypto.prepareOpen(OFDSource)（URL 映射为 CryptoSource.byte-source，共用同一字节源）
      ├─ 明文 → OFDDocument.open({ source, signal, ... })
      └─ 加密且 crypto.enabled=true
           ├─ crypto.credentials 预置 → openDecryptingContainer
           ├─ autoPrompt=false 且无预置 → OFD_CRYPTO_CREDENTIAL_REQUIRED
           ├─ onCredentialRequired → 宿主返回凭据/null
           └─ 内置登录弹窗 → 凭据 → openDecryptingContainer
                ├─ 失败：弹窗保留、显示错误、可重试/取消
                └─ 成功：OFDDocument.open({ container })
                      → autoVerify ? verifyOfd({ container, roots }) : 等待工具栏
  → documentopen / verificationcompleted
```

- `inspect` 失败按 `OFD_CRYPTO_FAILED` 上报并保留 cause；取消为 `OFD_CRYPTO_CANCELLED`。
- `crypto.enabled=false` 时加密文档打开失败为 `OFD_CRYPTO_UNSUPPORTED`；明文文档仍按原行为。
- 解密容器由 crypto 创建；engine 只借用，`doc.close()` 后由 UI 关闭容器。凭据只在本次打开/验证调用内存中存在，不写入日志、DOM 属性或 localStorage。
- 根证书变更、`verification` 功能关闭或重新验证开始时，立即失效旧报告并关闭依赖旧报告的印章浮层；在途 verify 用代次 + `AbortController` 取消，旧结果不得回写。

### 11.3 验证结果模型

UI 直接消费 crypto `VerificationReport`：

| 字段 | UI 展示 |
|---|---|
| `overall` | `valid`/`invalid`/`unknown`/`not-applicable`/`unsupported`，颜色+文字+图标，不能只靠颜色区分 |
| `integrity` | `valid`/`invalid`/`unknown`/`unsupported`；`null` 显示“未受保护”，`package.integrityPresent=false` |
| `signatures[].status` | 单签名聚合状态；含 `references`/`certificate`/`seal`/`math` 子状态 |
| `signatures[].certificate.status` | `valid`/`expired`/`not-yet-valid`/`untrusted`/`incomplete`/`unsupported`/`not-present`/`unknown`/`invalid` |
| `signatures[].seal` | 印章签名、链、与 SignedValue 匹配；无印章节点为 `not-applicable` |
| `signatures[].timestamp` | `parsed-not-verified`/`not-present`/`parse-error`，不参与 overall |
| `rootsConfigured` | false 时提示“未配置信任根，链状态未知”，不显示为成功 |
| `warnings` | 可折叠的诊断信息，不得包含凭据/私钥/PEM |

- 成功解析 `parseSeal` 只表示结构可读；`hasSignature` 不代表验签通过。`ParsedSeal.warnings`（如 `W_CRYPTO_SEAL_PICTURE_INVALID`）单独提示，不能把图片损坏当成签名失败或成功。
- Reference 失败、证书过期/不受信/缺中间证书、签名数学失败等必须在面板和详情中明确区分；不得把 `unknown`/`not-applicable` 显示为 `valid`。

### 11.4 工具栏验证面板与印章浮层

- **工具栏入口**：`verification` 功能默认启用；关闭时入口隐藏/禁用，`viewer.verify()` 抛 `OFD_FEATURE_DISABLED`，已打开面板收起、旧报告失效。
- **验证面板**：显示整体状态、完整性、签名列表、根证书状态、时间戳和 warning；正在验证时显示 loading 并禁用重复提交；失败显示可重试错误，不保留旧 valid。
- **印章点击**：点击签章覆盖层/侧栏项打开浮层，展示签章类型、印章、签署时间、证书链、Reference、完整性、时间戳和验签状态；无报告/验证功能关闭时只展示解析详情并标注“未验证”，不读取本地旧报告。
- **重新验证**：面板按钮/`viewer.verify({ signatureIds?, signal? })` 重新调用 `verifyOfd`；成功发 `verificationcompleted`，UI 用新报告替换全部旧详情/标题。
- **根证书**：面板展示根证书列表与来源；`setRootCertificates()` 替换根后自动重新验证；全部根解析失败返回 `[]` 并提示“未配置/根证书无效”，链状态为 unknown。

### 11.5 根证书四态与安全语义

| 输入 | 处理 |
|---|---|
| `data` | 直接作为证书字节（PEM/DER/CER） |
| `url` | 浏览器 `fetch` 读取；失败 warning，不伪造成有效 |
| `path`/`filePath` | 必须由宿主 `certificateLoader` 读取；loader 抛错映射 `OFD_CRYPTO_FAILED` |

- 未配置根：`rootsConfigured=false`，链 `unknown`；这是正常的“无法判断信任”，不是“无签章”。
- 正确根：链可追到 SHA-256 指纹一致的根，签名/有效期/KeyUsage 通过 → `valid`。
- 错误根：链无法连到配置根时通常是 `incomplete`；链可建但终点不在 roots → `untrusted`。
- 配置根但缺 issuer/中间证书 → `incomplete`；不得当成 `unknown` 或 `valid`。
- 所有根都解析失败：忽略并 warning，最终按未配置根处理（`rootsConfigured=false`），不抛“全部根无效”的未捕获异常。
- 不允许把根证书内容/私钥写日志；证书摘要只展示 subject/issuer/serial/fingerprint。

### 11.6 无障碍、键盘与测试

- 验证面板使用 `role="status"`/`aria-live="polite"` 播报状态与错误，不抢焦点；状态徽标有 `aria-hidden` 图标 + 可读文字，色盲用户可辨识。
- 印章覆盖层可键盘聚焦/激活；浮层使用对话框语义（标题、关闭、焦点陷阱、Esc 关闭、关闭后焦点返回触发元素）。
- 凭据弹窗字段使用显式 `label[for]`，错误 `role="alert"`，关闭/取消清空秘密，焦点不进入日志。
- Playwright/axe 覆盖：加密打开、错误重试、取消、验证面板四态、时间戳 `parsed-not-verified`、印章键盘浮层、根证书四态、移动/桌面视口；axe 扫描面板/对话框 0 serious/critical。

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

### 13.2 必须新增（已实现）

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
- 引擎**不引入** `asn1js`/`asn1.js`/`@peculiar/*`；ASN.1/X.509/验签全部由 `@ofdrw/ofdrw-viewer-crypto` 按需加载，UI 只消费结构化结果/报告。
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
```

### 14.2 依赖

| 依赖 | 用途 | 引入方式 |
|---|---|---|
| `@ofdrw/ofdrw-viewer-engine` | OFD 打开/渲染/导出 | workspace 依赖 |
| `@ofdrw/ofdrw-viewer-crypto` | 解密/ASN.1/X.509/签名/完整性/时间戳解析 | workspace 依赖；由 `CryptoService` 统一封装 |
| `fflate` | 多页导出 ZIP | 按需 import |
| `react` / `react-dom` | React wrapper | 可选 peer，`>=18`；核心不 import |
| `vue` | Vue wrapper | 可选 peer，`>=3.3`；核心不 import |

- 核心入口不引入 React/Vue；只有 `./react`、`./vue` 子路径 import 对应框架。
- 不引入 pdf.js 运行时；只参考模式。
- 不依赖 Node 内置模块（`Buffer`、`fs`）；crypto 的浏览器构建已验证无 Node 内建依赖。
- 不再直接依赖 `asn1js`/`@peculiar/*`；统一由 crypto 提供严格 DER/X.509/SES 解析。

### 14.3 构建

- `tsup` 输出 ESM + CJS + `.d.ts`；CSS 单独文件，`exports` 提供 `./style.css`。
- `sideEffects` 标注 CSS；避免把整个 UI 树摇掉。
- 目标 `es2020`；不输出可选链之外的过新语法（可选链/空值合并自身在 ES2020，目标浏览器支持）。
- 按需 import crypto 的验证/印章解析入口，形成独立 chunk；首屏不加载。
- crypto 已提供构建产物；UI 不额外配置 ASN.1 schema 装饰器/元数据。
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
- 发布前检查：许可证、NOTICE、README、API 文档、在线演示站、类型声明、CSS 导出、子路径 `exports` 解析。

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

- URL 来源需要服务端允许 CORS；**UI 的 `HttpByteSource`** 默认用 Range 请求，服务端需支持 `Range`/`Content-Range`（并暴露 `Content-Range` 响应头）；不支持时回退全量下载。engine 不参与网络获取。
- 鉴权头通过来源 `{ url, headers }` 或 `requestInit.headers` 提供，来源 `headers` 优先；`requestInit.credentials` 不转发。token 刷新/重试由宿主负责。
- 公开 URL 不需要认证；企业系统可传 `headers`（预留），但 MVP 不实现登录/刷新 token。
- 本地文件用 `<input type=file>`/拖拽；拖拽需 `preventDefault` 并校验扩展名/MIME。
- 不在 URL 中放敏感 token；如必须，使用宿主提供的 `headers`。
- 取消：切换文档/`close()`/显式中止会关闭 `HttpByteSource` 并 abort 在途请求；进度由 `HttpByteSource.onProgress` 在整包读取时提供，UI 不额外暴露字节级进度。

### 15.4 CSP

- 文本层/页面定位需要内联 `style`；若宿主 CSP 禁止 `style-src 'unsafe-inline'`，需通过 CSSOM 设置样式或使用 nonce。设计默认允许内联样式；文档需说明。
- 不使用 `eval`/`new Function`；crypto 的 ASN.1 解析不执行内容，UI 不拼接不可信 HTML。
- 图标内联 SVG；不使用远程字体/图片。

---

## 16. 安全、隐私与许可

- **不夸大验证**：未验证/未配置根时明确“未验证/未知”；不得把“有签章”表述为“文档有效”，也不得把 `unknown` 当 `valid`。
- **证书信息**：只本地展示；不上传；详情缓存只在内存，`close()` 清理。
- **密码能力**：ASN.1/X.509/验签交给 crypto 包；UI 不维护第二套解析器。crypto 对输入大小/深度/节点数限制；UI 捕获 `CryptoError` 并降级展示，不把异常原文/私钥写日志。
- **文本层**：用 `textContent` 创建节点，不拼 `innerHTML`；避免 XSS。
- **URL**：不把用户输入直接插入 `innerHTML`；文件名清洗；下载 URL 用 `URL.createObjectURL` 并 revoke。
- **剪贴板**：只在用户手势内调用；失败回退。
- **许可**：
  - pdf.js Apache-2.0：不复制源码；如复用，保留许可/NOTICE。
  - crypto 的第三方依赖（`sm-crypto`、`asn1js`、`@peculiar/*`、`fflate`）按其许可证汇总 NOTICE。
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
| M4 | 文本层、选择/复制、查找 | 已实现 text API |
| M5 | 打印、导出（含 ZIP） | M1 |
| M6 | 签章摘要/详情/覆盖层 | engine 原始字节 + crypto |
| M7 | 响应式、主题、a11y、信创兼容、E2E、文档、发布 | 全部 |

### 17.2 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 文本层几何/超限 | 选区错位或文本截断 | 按 `TextContent` 视口坐标/旋转映射；超限 warning + 截断提示，不伪造文本层 |
| 签章/加密格式变体 | 详情字段缺失/解析失败 | crypto 统一容错/warning/结构化报告；用 ofdrw-gm 夹具覆盖 v1/v4/v5 |
| 1000 页性能不达标 | 滚动卡顿/内存高 | 虚拟滚动、可见优先、LRU、canvas 上限；压测后调队列/缓存 |
| 大页高倍缩放超 canvas 上限 | 模糊/失败 | 降 DPI + CSS 放大 + warning；未来 renderRegion |
| 混合页尺寸打印 | 分页/缩放不正确 | 命名 `@page` 分组；旧内核回退 auto |
| 信创浏览器 API 缺失 | 功能降级 | 特性检测 + 回退；目标版本实测 |
| 旋转下选区错位 | 复制体验差 | 回归测试；提供“复制本页文本” |
| 1000 页全量查找慢 | UI 卡顿 | 分片、缓存、进度、取消；默认从当前页开始 |
| 用户误以为已验证 | 合规/信任风险 | 明确未知/未验证；无根 unknown，时间戳只解析；文案统一 |
| pdf.js 许可 | 合规 | 不复制源码；如需复用保留 NOTICE |

### 17.3 已确认与待确认

已确认：

- 文本/空间信息按 [v1.1 文本内容 API 设计](./text-content-api.md) 实现；`getTextContent` 已导出并接入 UI 文本层。
- 框架：React 18/19 + Vue 3；纯 SPA，不做 SSR。
- UI：默认内置；具体功能统一用 `features` 开关（§4.7），`features.toolbar=false` 时宿主自绘工具栏；MVP 不做 slot 深度定制。
- 包：单包 + 子路径导出（`/react`、`/vue`、`/element`、`/style.css`）。
- 密码能力：`@ofdrw/ofdrw-viewer-crypto` 内置严格 ASN.1/X.509/SM 实现，UI 通过 `CryptoService` 统一调用；engine 不解析电子签章，UI 不再维护第二套 ASN.1 依赖。
- 签章资源：`Seal.esl` 不进入 engine 公开 API；crypto 的 `parseSeal`/`verifyOfd` 解析 `Seal.esl`/`TBS_Sign.eseal`。只保留 `getSignedValue(id)`，不再暴露 `kind`；`SignedValue.dat` 缺失时返回 `undefined`，不回退 `Seal.esl`。

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
| 未验证 | 未取得可用的验证报告，或用户关闭/未启用验证；不得据此声称文档有效 |
| parsed-not-verified | 时间戳结构已解析，但未验证 TSA 签名/证书链/策略；固定文案“已解析，未验证” |

### 18.3 参考文件

- [引擎 API 与功能说明](./ofdrw-viewer-ui-engine-api.md)
- [OFD 渲染引擎设计方案](./OFD渲染引擎设计方案.md)
- [密码能力总体设计](./ofdrw-viewer-crypto设计方案.md)
- [跨模块契约](./CONTRACTS.md)
- [crypto API](../packages/ofdrw-viewer-crypto/skills/API.md)
- [crypto README](../packages/ofdrw-viewer-crypto/README.md)
- [v1.1 文本内容 API 设计](./text-content-api.md)
- [引擎页面 API](../packages/ofdrw-viewer-engine/src/api/page.ts)
- [引擎签章外观解析](../packages/ofdrw-viewer-engine/src/model/seal.ts)
- [ofdrw-gm SES v1](../references/ofdrw/ofdrw-gm/src/main/java/org/ofdrw/gm/ses/v1/SESeal.java)
- [ofdrw-gm SES v4](../references/ofdrw/ofdrw-gm/src/main/java/org/ofdrw/gm/ses/v4/SESeal.java)
- [ofdrw-gm SES v5](../references/ofdrw/ofdrw-gm/src/main/java/org/ofdrw/gm/ses/v5/SESeal.java)
- [GM/T 0031-2014 规范 PDF](../references/ofdrw/ofdrw-gm/doc/GMT_0031-2014_安全电子签章密码技术规范.pdf)

---

**评审重点**：§9.1 文本 API 现状、§11 密码能力 UI 边界、§12 1000 页策略、§13 引擎 P0 缺口、§17.3 待确认项。