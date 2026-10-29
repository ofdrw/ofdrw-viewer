# @ofdrw/ofdrw-viewer-ui 设计方案

本文描述 `@ofdrw/ofdrw-viewer-ui` 当前实现的阅读器设计。构造选项、方法签名、事件载荷和类型定义以 [UI API](../packages/ofdrw-viewer-ui/skills/API.md) 为准；UI 依赖的引擎接口以 [UI 使用的引擎 API](./ofdrw-viewer-ui-engine-api.md) 和 [引擎 API](../packages/ofdrw-viewer-engine/skills/API.md) 为准；跨模块硬约束见 [CONTRACTS](./CONTRACTS.md)。

## 目标与边界

### 产品定位

`@ofdrw/ofdrw-viewer-ui` 是框架无关的 Web OFD 阅读器：核心 `OFDViewer` 负责文档生命周期、连续滚动阅读、缩放旋转、文本层、查找、打印导出和签章展示；`<ofd-viewer>`、React、Vue 只做薄适配。一个实例同一时间只打开一个文档，通过 `open()` 切换。

当前提供的能力：

- 连续滚动阅读，页码定位，缩放、旋转、全屏，侧栏和 URL hash 导航；
- 缩略图、大纲、书签、签章列表；
- 透明文本层、选区复制、全文查找与匹配高亮；
- 打印为浏览器分页图片，导出 PNG/JPEG/WebP 或当前 OFD 原文件，多页图片打包 ZIP；
- 加密 OFD 的凭据输入、解密打开、签章与完整性验证展示、根证书配置；
- `?file=` / `?base64=` 查询参数预览。

### 不承担的能力

- 不解析 OFD、不绘制页面、不导出 PDF；这些由引擎或宿主完成。
- 不实现 ASN.1、SM2/SM3/SM4、证书链、签名值或时间戳验证；UI 只调用 `@ofdrw/ofdrw-viewer-crypto` 并展示结果。
- 不做 OCR、批注写入、表单填写、OFD 编辑、服务端登录或文档上传。
- 当前不提供附件面板、图层/可选内容、演示模式；打印和图片导出输出页面图片，另提供原 OFD 文件下载。
- 不把“文档声明了权限”当成 DRM：UI 按权限禁用打印/导出入口，但无法阻止宿主直接调用引擎。

### 设计参考

阅读器的页面 DOM 分层、CSS 缩放、可见页渲染队列、文本层、查找和侧栏组织参考 pdf.js viewer 的成熟模式，但不 fork、不引入 pdf.js 运行时，也不复制其视觉皮肤。OFD 的页面模型、毫米单位、书签、签章和国密能力按本项目引擎与 crypto 的接口重新实现。

## 总体架构

### 分层

| 层 | 主要模块 | 职责 |
| --- | --- | --- |
| 入口与外壳 | `src/index.ts`、`src/ui/` | 安装工具栏、侧栏、查找栏、对话框和 Toast，注册文本/导航/签章/打印/导出扩展 |
| 阅读器核心 | `src/viewer.ts` | 文档生命周期、状态、导航、缩放、旋转、全屏、事件和功能守卫 |
| 文档适配 | `src/document-controller.ts` | 来源规范化、引擎打开/关闭、页信息和侧栏数据缓存 |
| 页面与调度 | `src/page-layout.ts`、`src/page-view.ts`、`src/render-queue.ts` | 页盒计算、单页 DOM/canvas、调度顺序与取消 |
| 业务能力 | `src/text/`、`src/views/`、`src/print/`、`src/export/`、`src/crypto/`、`src/signature/` | 文本与查找、导航面板、打印导出、密码能力、签章详情 |
| 适配器 | `src/component/`、`src/react/`、`src/vue/` | 属性/事件/生命周期桥接，不复制阅读逻辑 |

### 状态与事件

对外状态是只读快照 `ViewerState`，分为文档、视图和 UI 三组；页面级渲染状态（代次、任务、canvas）不进入全局快照。所有变更由核心完成，UI 组件只读状态并触发事件。事件总线隔离通过 `on()`/`once()` 注册的监听器异常，监听器抛错只产生 `W_UI_LISTENER` warning；构造选项 `onWarning` 是直接回调，不在总线隔离范围内，见“错误与诊断”。

### 打开数据流

1. 解析来源：显式 `open(source)` > 构造 `source` > 页面查询参数 `?file=` / `?base64=`；`file` 优先于 `base64`，冲突时产生 `W_QUERY_SOURCE`。
2. 来源只规范化一次：URL 字符串或 `{ url, headers }` 转为 `HttpByteSource`，再以 `{ kind: 'custom' }` 交给引擎；ArrayBuffer、Uint8Array、Blob/File 转为引擎的 `arraybuffer`/`blob` 来源。URL 的来源信息同时保留，供标题和导出命名。
3. `crypto.prepareOpen()` 判断明文或加密。明文路径把同一字节源交给引擎；加密路径由 crypto 检查并解密为容器，engine 只接收明文容器。
4. `OFDDocument.open()`；旧文档在打开新文档前关闭，旧渲染任务和旧来源被取消。
5. 读取 `pageCount` 和全部 `PageInfo`，建立页壳和总高度。
6. 应用初始页、初始缩放和旋转，滚动到目标页，计算功能可用性。
7. 派发 `documentopen`，结束文档级 loading；随后派发 `pagesloaded`，再渲染可见页。`pagesloaded` 不是 loading 的结束条件。
8. 异步读取元数据、大纲、书签和签章摘要；失败只产生 warning，不阻断阅读。
9. 如启用自动验证且文档包含签章或完整性保护，再启动 crypto 验证。

### 网络来源与 URI 预览

URL 字符串和 `{ url, headers }` 由 UI 的 `HttpByteSource` 读取：先探测长度（HEAD，必要时 `Range: bytes=0-0`），再按需发送 Range 请求；服务器忽略 Range、返回内容编码或总长不一致时回退为整包下载。字节源支持取消和幂等 `close()`，跨域部署要求服务端允许 CORS、`Range` 并暴露 `Content-Range`。`requestInit.headers` 与来源 headers 合并，来源 headers 优先；当前只转发 headers，不转发其他 `fetch` 选项。

`?file=` 接受以当前页面为 base 解析的 http(s) 地址，拒绝其他协议；`?base64=` 支持纯 Base64、URL-safe、缺 padding 和 `data:...;base64,...`，解码后默认上限 64 MiB。两者同时出现时 `file` 优先并产生 `W_QUERY_SOURCE`。非法或超限参数以 `OFD_INVALID_OPTION` 拒绝。`HttpByteSource`、`HttpByteSourceOptions`、`readPreviewSourceFromLocation` 和 `DEFAULT_MAX_BASE64_BYTES` 从公共入口导出，宿主可复用同一读取/解析逻辑。

## 公共 API 设计

### 构造与关键默认值

`new OFDViewer(options)` 在构造时创建阅读器 DOM 并异步打开 `options.source`；`viewer.ready` 等待首次打开。容器接受选择器或元素，根节点 `.ofd-viewer` 作为容器子节点创建，宿主必须给容器确定高度。完整选项、容器规则和移动端差异见 [UI API 构造选项](../packages/ofdrw-viewer-ui/skills/API.md#构造选项)。

| 选项 | 当前默认/边界 |
| --- | --- |
| `initialPage` | `1`，按 1-based 处理并夹取到有效页范围 |
| `initialScale` | `auto`（适合宽度）；数字倍率限制在 `0.1..25` |
| `rotation` | `0`，只接受 0/90/180/270 |
| `theme` / `locale` | `auto` / `zh-CN` |
| `maxCanvasPixels` | 桌面 `256_000_000`、移动 `32_000_000` 像素 |
| `pageCachePixelBudget` | `512_000_000` 像素（已渲染页 canvas 总预算） |
| `supersample` | `'auto'`（按页面面积分档 2 / 1.5 / 1）；可选 `'off'` / `'high'` / `'max'` / `1..4` |
| `pageCacheSize` | 桌面 `10`，移动 `4` |
| `renderConcurrency` | 桌面 `2`，移动 `1` |
| `thumbnailCacheSize` | 默认 `100`；当前缩略图实现固定使用 100，见“当前缺口” |
| `updateHash` | `false` |
| `crypto.enabled` | 默认启用；`false` 时只允许明文文档 |

### 生命周期与状态读取

- `open(source?)` 打开或切换文档；`close()` 关闭文档、取消任务并清空页面，但保留实例和容器；`destroy()` 再解绑事件并移除 DOM，实例不可复用。
- `getState()` 返回当前只读快照；`getPageCount()`、`getPageNumber()`（`getCurrentPage()` 为其别名）、`getPageInfos()`、`getPermissions()` 提供页码、页尺寸和权限读取；`getDocument()` 暴露引擎文档，属于高级用法。
- 打开失败会进入错误态并派发 `error`；用户取消打开回到关闭态。加密凭据被取消时，若旧文档仍可读，则保留旧文档并抛出 `OFD_CRYPTO_CANCELLED`。
- 销毁后调用方法抛 `OFD_DESTROYED`；未打开文档时依赖文档的方法抛 `OFD_NOT_OPENED`。

### 导航、缩放与阅读控制

- 页码：`goToPage(pageNumber, { smooth?, durationMs? })`、`nextPage()`、`previousPage()`、`firstPage()`、`lastPage()`；页码 1-based，边界不循环。`smooth` 使用 rAF 补间，时长钳在 150–360ms，可被用户滚动/缩放/新跳转立即打断；系统要求减少动效时退化为直接定位。
- 缩放：`setScale()`、`setZoomMode('auto'|'page-actual'|'page-fit'|'page-width')`、`zoomIn()`、`zoomOut()`、`resetZoom()`；实际倍率限制在 10%–2500%。
- 旋转：`setRotation(value)` 接受数字并规范到 0/90/180/270，`rotateClockwise()`、`rotateCounterClockwise()` 每次旋转 90°；旋转是阅读器行为，引擎始终输出未旋转页面。
- 侧栏：`openSidebar(view)`、`closeSidebar()`、`toggleSidebar()`；视图为缩略图、大纲、书签、签章。
- 对话框：`showDialog(options)`、`closeDialog()` 控制内置对话框；未挂载内置 UI 时 `showDialog` 抛 `OFD_UNSUPPORTED`。
- 全屏：`setFullscreen(boolean)`、`toggleFullscreen()`；优先 Fullscreen API，失败时使用固定定位的沉浸式回退并产生 `W_FULLSCREEN_FALLBACK`。
- 完整方法签名见 [UI API 公共方法](../packages/ofdrw-viewer-ui/skills/API.md#公共方法)。

### 文本、查找与输出

- 文本和选区：`getSelectedText()`、`copySelection()`、`clearSelection()`。
- 查找：`find(query, options?)`、`findNext()`、`findPrevious()`、`clearFind()`、`getFindState()`；默认不区分大小写、非全词、高亮全部、从当前页开始。
- 打印：`print(options?)`；导出：`exportImage(options?)`、`exportImages(options?)`、`exportOfd(options?)`。
- 签章：`getSignatures()`、`getSignatureDetail(id)`、`showSignature(id)`、`focusSignature(id)`、`verify(options?)`、`getVerificationReport()`、`openVerificationPanel()`、`setRootCertificates()`、`getRootCertificates()`。

### 事件

事件按生命周期、导航/缩放、侧栏、查找、选区、打印/导出、诊断、功能状态和验证分组。事件名、载荷和订阅方式见 [UI API 事件](../packages/ofdrw-viewer-ui/skills/API.md#事件)，设计文档不重复维护第二份表。

需要遵守的时序约束：

- `documentopen` 在页壳、初始滚动和功能可用性就绪后派发，是文档 loading 的正常结束点；
- `pagesloaded` 在 `documentopen` 之后、初始可见页渲染之前派发；需要等待画面完成时监听 `pagerendered`；
- `statechange` 是视图状态快照变化通知，不是渲染完成通知；
- `warning` / `error` 分别承载可恢复诊断与失败；两者都不替代 Promise 的 reject；
- 功能关闭时调用受守卫方法抛 `OFD_FEATURE_DISABLED`，不静默 no-op。

### 错误与诊断

`error` 事件载荷是 `ViewerErrorInfo`，其 `code` 是诊断码，不等同于 Promise reject 的异常码。来源按实现分两类：

- RenderQueue 任务错误：`onTaskError` 直接上报固定 `OFD_RENDER_FAILED`，事件 code 不随底层 code 改变，底层错误放在 `cause`。
- `toErrorInfo()` 路径（打开失败、页面错误卡）：优先复用底层字符串 `cause.code`；底层没有字符串 code 时才用兜底 `OFD_OPEN_FAILED`（打开）或 `OFD_RENDER_FAILED`（页面错误卡）。

`OFD_OPEN_FAILED`/`OFD_RENDER_FAILED` 不属于 `ViewerErrorCode`，不会作为 `open()` 或渲染 Promise 的 reject code，不要用它们做异常分支。若希望 RenderQueue 事件也统一显示底层 code，必须先改 RenderQueue 并补测试，当前文档不把该行为写成已实现。

`open()` 的 reject 保留底层错误；唯一例外是 `OFD_ENCRYPTED`：crypto 关闭时映射为 `OFD_CRYPTO_UNSUPPORTED`，crypto 启用但无法解密时映射为 `OFD_CRYPTO_FAILED`。crypto 的凭据/验证错误原样 reject（如 `OFD_CRYPTO_CREDENTIAL_REQUIRED`、`OFD_CRYPTO_CANCELLED`、`OFD_CRYPTO_FAILED`）；打印/导出分别抛 `OFD_PRINT_FAILED`/`OFD_EXPORT_FAILED`，功能守卫失败抛 `OFD_FEATURE_DISABLED` 并携带 `feature`。引擎错误（如 `OFD_INVALID_PACKAGE`、`OFD_ABORTED`）也可能直接 reject，不会先包装成 `OFDViewerError`。

UI 对 `error` 事件与错误卡只展示 `code`/`message`，需要定位时读 `cause`；不要复制错误码表，也不要用诊断码做异常分支。`ViewerErrorCode` 的完整注册表见 [CONTRACTS §8.5 UI 与 CLI 错误](./CONTRACTS.md#85-ui-与-cli-错误)。

`onWarning` 是同步直接回调，不在事件总线隔离范围内：宿主回调抛错会沿 warning 调用栈传播，可能使当前打开/读取失败，后续 `warning` 事件也不会继续派发。当前 UI 的 warning 转发没有这层 try/catch；若要由阅读器保证隔离，需要在 UI 的 warning 转发处捕获并另行记录，宿主在自己的 `onWarning` 中 try/catch 只能保护宿主侧。通过 `on()`/`once()` 注册的事件监听器异常由总线隔离为 `W_UI_LISTENER` warning。

### 功能开关

功能键共 19 个：`toolbar`、`sidebar`、`thumbnails`、`outline`、`bookmarks`、`pageNavigation`、`pageNumberInput`、`zoom`、`rotate`、`fullscreen`、`textLayer`、`selection`、`find`、`print`、`export`、`signatures`、`verification`、`documentProperties`、`keyboardShortcuts`。

有效状态由宿主配置、文档权限、环境/引擎能力和功能依赖合并：`thumbnails`、`outline`、`bookmarks` 依赖 `sidebar`；`selection`、`find` 依赖 `textLayer`。状态包含 `enabled`、`visible` 和原因 `host`/`document`/`unsupported`/`dependency`。`getFeatureState()`、`getFeatureStates()`、`isFeatureEnabled()` 读取有效状态；`featureDisplay` 控制关闭项隐藏还是禁用；`setFeatures()` 运行时生效，并关闭依赖它的面板/任务。

`crypto.enabled=false` 时 `verification` 变为 unsupported，`verify()` 等调用先被功能守卫拦截；加密文档打开会得到 `OFD_CRYPTO_UNSUPPORTED`。宿主的 `features` 不能覆盖被文档或环境判定为 unsupported 的能力。

### 框架适配

`<ofd-viewer>` 使用 light DOM，保持打印、选区、全屏和读屏行为；观察 `src`、`page`、`scale`、`rotation`、`theme`、`locale`、`sidebar`、`font-default`、`font-supplementary`、`supersample` 属性，复杂来源和 `features` 走 property。其中 `font-*` 与 `supersample` 只在创建实例时生效，变更后按新值重建。React 通过 `forwardRef` 暴露命令句柄，Vue 通过 props/emits/expose 桥接。三者共用同一核心，组件卸载调用 `destroy()`。

适配器的完整属性、事件和句柄见 [UI API Web Component](../packages/ofdrw-viewer-ui/skills/API.md#web-component)、[React](../packages/ofdrw-viewer-ui/skills/API.md#react) 和 [Vue](../packages/ofdrw-viewer-ui/skills/API.md#vue)。核心按 SPA 设计，不承诺 SSR 渲染。宿主需要自定义工具栏或面板时，可通过公共入口的 `registerViewerExtension()` 注册扩展；内置 UI 自身也通过同一扩展机制安装，扩展失败/卸载会在实例销毁时清理。

## 布局与阅读核心

### 容器与外壳

阅读器根节点是 `.ofd-viewer`，壳层为工具栏、主体、查找栏、对话框层和 Toast 层。主体在桌面断点使用内联侧栏，较窄断点改为覆盖或抽屉；断点由根节点 `data-viewport` 驱动，核心用 `ResizeObserver` 和窗口尺寸更新。根节点使用网格行布局并占满容器；容器没有高度时页面区域不可见，这是宿主必须满足的布局约束。

### 视觉与主题

宿主必须显式引入 `@ofdrw/ofdrw-viewer-ui/style.css`。样式以 `.ofd-viewer` 前缀隔离，颜色、字体、间距、圆角、阴影、层级和触摸目标由 CSS 变量控制；常见变量包括 `--ofd-bg`、`--ofd-text`、`--ofd-accent`、`--ofd-border`、`--ofd-page-gap`、`--ofd-page-margin`、`--ofd-toolbar-height`、`--ofd-sidebar-width` 和 `--ofd-radius`，宿主可在容器或根节点覆盖。主题值写入 `data-theme`：`light`/`dark` 显式生效，`auto` 通过 `prefers-color-scheme` 解析并跟随系统切换；同时提供高对比度和减少动效的媒体查询样式。

### 动效

弹出层统一使用克制的入场动画：时长 `180ms`、`ease-out`，只做打开，不做退出动画（关闭、替换和隐藏仍即时）。宿主可覆盖 `--ofd-motion-duration`，取值应保持在 `160–200ms`。

- 模态对话框：`.ofd-dialog__backdrop` 淡入，`.ofd-dialog` 以 6px 上移 + 淡入出现；打印、导出、文档属性、验证面板、凭据弹窗和签章详情共用 `.ofd-dialog` 路径。
- 印章浮层：首次挂载时淡入 + 4px 上移，`transform-origin: top left`；动画在定位测量完成后才启用，不改变锚点对齐与点击命中，浮层内部字段更新不会重播。
- 更多菜单：`scale(0.96) → 1` + 淡入，向下展开时原点在右上、向上展开时在右下；脚本仍用布局尺寸（而非动画后的视觉矩形）计算夹紧位置，键盘导航和关闭行为不变。
- 查找栏：透明度 + 4px 轻移，同时保留水平居中；侧栏 overlay/drawer 保留抽屉滑入并淡入，遮罩同步淡入。
- Toast：入场淡入 + 6px 上滑；自动关闭计时从创建时开始，动画不延长展示时间。
- `prefers-reduced-motion: reduce` 下显式关闭上述动画并保留最终静态位置；浮层 portal 到 `.ofd-viewer` 之外时同样生效。

内置文案默认简体中文，`zh-CN` 和 `en-US` 可用；`setLocale()` 更新根节点 `lang`、状态和翻译器，未注册语言回落到 `zh-CN`，状态中仍保留传入的 locale。面板空态、加载/错误提示、页码和可访问性文案都走同一翻译层，不在组件内硬编码第二套文案。

### 页面排版

- 页面尺寸来自引擎 `PageInfo` 的毫米值，CSS 尺寸按 `96 DPI` 换算：`px = mm × 96 / 25.4`，再乘以当前缩放。
- 页间距固定 `8 px`，页面区域首尾留白 `24 px`；页盒按顺序累加得到总高度和页偏移。
- 混合页尺寸逐页使用自己的宽高；旋转 90°/270° 时交换外框宽高，纸面内容仍按未旋转尺寸渲染后再旋转。
- `1000` 页 A4 在 1 倍缩放下的内容高度约为 112 万 CSS 像素；页壳只创建 DOM 和静态页框，不预分配 canvas。

### 可见页与渲染调度

滚动位置经 `requestAnimationFrame` 合并后计算当前页和可见范围；渲染范围在可见页上下各扩一页作为预取。渲染队列按调度顺序执行：`0` 为可见页，`1` 为相邻预取，`2` 为缩略图/后台任务。桌面并发 2、移动并发 1；同一 canvas 的绘制由引擎串行，跨页可并行。

渲染任务带页代次；缩放、旋转、打开新文档或关闭时递增代次并取消旧任务，迟到的结果直接丢弃。取消产生的 `AbortError`/`OFD_ABORTED` 不作为页面错误。已渲染页记录在 LRU 顺序中，超过 `pageCacheSize` 时只释放不在当前可见范围内的 canvas；可见页即使超过预算也保留。

首次绘制前显示页骨架；已有画面重渲染时保留旧 canvas，直到新 canvas 完成再替换，避免闪白。单页失败显示页内错误卡和重试按钮，不影响其他页；重试递增代次。队列空闲时用 `requestIdleCallback`（超时回退）安排后台任务。

### 缩放、旋转与手势

- 缩放立即更新页盒 CSS 尺寸和 `--scale-factor`，取消旧任务并对可见页按新 DPI 重新渲染；没有额外的缩放防抖延迟。
- 设备像素比参与渲染 DPI：`96 × scale × devicePixelRatio`。canvas 受 `maxCanvasPixels` 和单边 `32767` 限制；超限时最多按 0.75 系数降低 8 次 DPI，仍超限则产生 `W_CANVAS_LIMIT` 并按最后一次计算结果继续。
- 画布分辨率有下限：后备尺寸不低于页面 100% CSS 尺寸的 `min(devicePixelRatio, 2)` 倍，即有效渲染倍率为 `max(scale, min(1, 2 / dpr))`。低于该倍率时不再重绘 canvas、也不改变 canvas 尺寸，仅由 CSS 缩小显示，避免小图按低分辨率重绘后出现色块；该下限只由 DPR 决定，窗口尺寸变化不会改变它。缩略图使用独立 DPI，不受此下限约束。
- 缩放保持滚动锚点：工具栏/API 以页顶加页内比例恢复；滚轮、捏合、双击以指针下的页面坐标为锚点。
- Ctrl/Cmd + 滚轮按 1.1/0.9 步进；触摸双指捏合按两指距离比例缩放；双击在适合宽度和 100% 之间切换。`zoom` 关闭时不拦截浏览器默认行为。
- 旋转由页面容器 CSS transform 完成，canvas、文字层、签章层同步旋转；旋转后恢复页和页内锚点。

### URL 导航与全屏

`updateHash` 默认关闭，避免嵌入场景污染宿主地址。启用后把页码、缩放、旋转、侧栏写入 `#page=…&zoom=…&rotation=…&sidebar=…`，使用 `replaceState` 更新当前地址项，并监听 `hashchange`/`popstate` 恢复；非法字段忽略，不抛错。`?file=`/`?base64=` 只读取查询串，不与 hash 状态互相覆盖。

原生全屏失败或环境不支持时，根节点增加固定定位的沉浸式回退类，并派发 `W_FULLSCREEN_FALLBACK`。Esc 不是统一的“只关闭浮层”语义，实际行为取决于焦点位置和 `keyboardShortcuts`：

- 焦点在对话框、覆盖式侧栏、查找栏输入框或更多菜单内：FocusTrap 或组件自身的 keydown 在捕获/目标阶段停止传播，Esc 交给对应浮层处理（可关闭时只关闭该浮层），不触发阅读器 `close()`，回退全屏的 document 监听也收不到该键；原生全屏是否退出由浏览器决定。
- 焦点在主区域或工具栏普通控件：根节点快捷键执行 `close()` 关闭文档。回退全屏下 document 监听还会继续处理：没有侧栏时同一次按键可同时关闭文档并退出回退全屏；内联侧栏没有 FocusTrap，根节点监听会先关闭侧栏并 `preventDefault`，文档仍会关闭，但回退全屏保留。
- 焦点在页码输入框：输入框先恢复页码并失焦，`defaultPrevented` 阻止根快捷键关闭文档；若侧栏打开，根节点监听仍可能关闭侧栏；回退全屏不会因该键退出。
- 焦点在阅读器外：只有 document 上的回退监听生效，Esc 退出回退全屏，不关闭文档。

`keyboardShortcuts=false` 时根快捷键不再关闭文档，但侧栏监听和回退全屏的 document 监听仍各自生效。

### 加载、错误与空态

文档级 loading 在打开开始后延迟 150 ms 显示，显示后至少保留 300 ms，淡出 150 ms；打开成功由 `documentopen` 结束。打开失败立即切换为错误卡，提供重试和关闭。页面级 loading 同样延迟 150 ms 显示，最短 200 ms，淡出 120 ms；页面失败显示错误卡，取消则静默隐藏。

空文档、无缩略图、无大纲、无书签、无签章时显示对应空态。加载与错误展示尊重 `prefers-reduced-motion`。加载动画不新增公开事件，也不改变既有事件载荷。

### 可访问性与键盘

工具栏、侧栏和页框使用语义化按钮、`aria-label`、`aria-current` 和 live region；对话框/查找栏使用焦点约束，关闭时把焦点还给触发元素。键盘快捷键在 `keyboardShortcuts` 开启时生效：方向键/PageUp/PageDown 翻页，Home/End 首末页，`+`/`-`/`0` 缩放，Ctrl/Cmd+F 查找，Ctrl/Cmd+P 打印。Esc 在浮层内只关闭对应浮层，在主区域/工具栏会关闭文档，回退全屏下还可能退出全屏，具体按“URL 导航与全屏”的焦点规则处理。全局翻页/缩放快捷键不拦截输入框和可编辑区域；页码输入框和查找输入框对 Enter/Esc 有各自处理。页面骨架、Toast 和诊断文本提供读屏文案，动画遵循 `prefers-reduced-motion`。

## 缩略图、大纲与书签

缩略图面板先为全部页创建静态按钮和页框，再只为当前滚动窗口（窗口大小 5）创建 canvas；缓存上限当前固定为 100。可见项优先用 `IntersectionObserver` 观察，缺少该 API 时退化为滚动位置扫描。缩略图渲染使用独立任务和代次，不能触发主页面 loading；点击缩略图跳转到对应页并同步当前页高亮。

大纲沿用引擎返回的 XML 层级和顺序，默认展开第一层，支持展开/收起、方向键树导航、当前页高亮和跳转。书签按名称和 `dest` 列表展示。无效目标由引擎产生 warning 并省略 `dest`；UI 保留节点但不执行跳转。导航面板不解析 HTML，不自行修复目标坐标。

## 文本层、查找与选择

文本层只给可见页及上下各一页构建。每页按 96 DPI 的文本坐标生成绝对定位的透明 `span`，页面容器通过 `--scale-factor` 缩放；旋转由容器统一 transform，不重新计算文字坐标。span 使用 `textContent` 写入，不使用 `innerHTML`；单页节点上限 5000。文本缺失、引擎不支持 `getTextContent` 或节点超限时，文本层降级，但页面仍可阅读。

选区从阅读器根节点内的文本节点收集，复制使用浏览器选区/剪贴板；复制失败映射为 `OFD_CLIPBOARD_FAILED`。查找逐页调用文本 API，按时间片（默认 8 ms、每片最多 8 页）让出事件循环；单页命中上限 1000、全篇上限 10000，文本缓存 16 页。查询变化、关闭文档或关闭 `find` 会取消旧搜索并递增代次。当前匹配居中滚动并高亮，`findNext`/`findPrevious` 循环。

## 打印与导出

打印只生成页面图片，不生成 PDF，也不调用服务端。流程为：解析页码范围 → 逐页调用引擎 `exportImage` 生成 PNG → 写入按毫米定尺寸的打印节点 → 等待图片解码 → 注入 `@page` 样式并调用 `window.print()` → 在 `afterprint` 或取消时清理 DOM 和 Object URL。统一页尺寸使用单个 `@page`；混合尺寸按尺寸分组使用命名页，不支持命名页的浏览器回退到 `size: auto`。打印旋转通过容器宽高交换和 CSS 旋转实现，不修改引擎输出的像素。

导出支持当前页、全部页、闭区间和页码数组；PNG/JPEG/WebP，质量默认 0.92，PNG 可透明，JPEG/WebP 强制白底。单页直接下载；多页逐页生成后以 store 模式打包 ZIP。支持自定义单页 `filename` 和 ZIP `zipFilename`。DPI 可显式指定在 `(0, 600]` 内并取整，`auto` 按任务页数分档：不超过 50 页 200 DPI，51–200 页 150 DPI，超过 200 页 96 DPI。文件名优先使用来源 basename，其次文档标题，最后 `document`；单页默认 `{docName}-p{page}`，多页 ZIP 内保留页码，ZIP 名为 `{docName}-images.zip`。

另有“导出 OFD 原文件”：复用 `export` 功能开关与文档导出权限，读取打开时的原始来源字节（URL 按原请求头重新读取，ArrayBuffer/Blob/随机读源直接读取），不渲染、不解密、不重新打包；加密文档导出原始加密包。公开的 `readSourceBytes()` 使用同一门控，便于宿主自行保存原文件。默认文件名为 `{docName}.ofd`，自定义名自动补 `.ofd`；读取失败、随机读源实际长度与声明 `size` 不一致（短读）、空文件或宿主不支持均映射为 `OFD_EXPORT_FAILED`，取消保留 `AbortError`。

打印/导出开始前检查 `print`/`export` 功能和文档权限；多页导出中单页失败会记录页号并继续其余页，全部失败抛 `OFD_EXPORT_FAILED`，打印失败则整体映射为 `OFD_PRINT_FAILED`；取消统一转为 `AbortError`。大任务按顺序渲染，避免同时持有大量 canvas；图片仍会占用内存，内置进度对话框提供取消入口。

## 签章与密码能力

### 数据来源与职责

引擎只返回 `Signatures.xml` / `Signature.xml` 的元数据和 `SignedValue.dat` 原始字节，不解析 ASN.1、证书或签名值，也不把 `Seal.esl` 作为公开签章资源。UI 的 `SignatureService` 通过 crypto 的 `parseSignedValue` 解析签章详情；UI 的 `CryptoService` 在 `verify()` 中调用 `verifyOfd` 完成验证；`parseSeal` 由 `parseSignedValue` 内部调用，UI 不直接调用它。证书链、信任根、签名数学、防夹带完整性和时间戳解析全部由 crypto 负责。

没有 `SignedValue.dat` 时只显示“签章信息不完整”，不回退读取 `Seal.esl`；`parseSignedValue` 返回的印章结构可读只代表 `Seal.esl` 能解析，不代表验签通过。

### 打开与验证

`crypto.prepareOpen()` 对明文直接进入引擎打开，对加密文档执行检查和解密。凭据来源有明确优先级：预置 `credentials`（单个或数组）优先，直接尝试解密，不调用 `onCredentialRequired`、也不显示内置弹窗；无预置凭据且 `autoPrompt=false` 时立即抛 `OFD_CRYPTO_CREDENTIAL_REQUIRED`，同样跳过 handler 和内置弹窗；只有 `autoPrompt=true`（默认值）时才进入交互，若配置了 `onCredentialRequired` 就先调用它，返回 `null` 变为 `OFD_CRYPTO_CANCELLED`且不再降级到内置弹窗，handler 抛错变为 `OFD_CRYPTO_FAILED`，只有未配置 handler 时才显示内置凭据弹窗。凭据只在当前打开/验证调用内存在，不写入日志、DOM 属性或存储。

验证入口受 `verification` 功能守卫。自动验证要求 crypto 启用、`autoVerify` 开启、`verification` 功能可用，且文档存在签章或完整性保护；否则等待用户从工具栏触发。根证书变更、关闭验证功能或开始新验证时立即失效旧报告并关闭依赖旧报告的浮层；在途验证用代次和 `AbortController` 取消，旧结果不得回写。

### 结果展示与安全语义

UI 直接消费 crypto 的 `VerificationReport`：

- `overall` 为 `valid`、`invalid`、`unknown`、`not-applicable` 或 `unsupported`，同时用颜色、文字和图标表达，不能只靠颜色；它只汇总签名数学、dataHash、Reference、防夹带完整性和印章结构/数学。
- 完整性、Reference、证书链、签名数学和印章分别展示；`unknown`、`not-applicable` 不得显示成 `valid`。
- 证书链独立成“根证书链验证”栏，展示链状态、是否配置信任根、签名者证书/信任锚/链成员摘要与问题；链 `untrusted`/`expired`/`incomplete`/`unknown` 不得改写 `overall`。签章者旁只按链 `valid` 显示“可信”，其余为“可信状态未知”，并使用文字+颜色双编码。
- 验证面板不显示验证时间/耗时；签名卡片显示 crypto 的 `signingTime`（缺失为“未提供”），带时区 ISO 时间换算 UTC+8，无时区字面量保留原值。
- 签章者证书与信任根证书可下载为 `.der`，文件名按 CN/序列号清洗，Blob URL 下载后释放；不输出 PEM 或私钥。
- 侧栏签章列表为卡片式按钮，无 ▣/✎ 图标装饰，保留名称/类型/时间/签章者/页码/状态，支持键盘、焦点与 `aria-current`；页面印章浮层的“查看签章详情”与侧栏项复用同一 `showSignature()` 详情面板。
- 未配置信任根时证书链状态为 `unknown`，提示“未配置与签章链匹配的信任根，证书链无法建立信任”，配置根后重新验证才可能变为 `valid`。
- 时间戳只解析，状态为 `parsed-not-verified`、`not-present` 或 `parse-error`，文案明确“已解析，未验证”/“无”/“不可解析”，不显示“时间戳有效”或“可信时间”。
- 不检查 CRL/OCSP，报告中的吊销状态为 `not-checked`；不得声称吊销状态有效。
- 报告和详情中的证书、印章图片和诊断信息不包含凭据、私钥或 PEM；印章图片只以 Blob URL 临时渲染。

根证书支持 `data`、`url`、`path`、`filePath` 四种来源：`data` 直接使用，`url` 由浏览器读取，路径来源必须由宿主 `certificateLoader` 读取；最终统一转换为 DER。`url`/`data` 加载失败只产生 warning，路径加载器本身抛错则包装为 `OFD_CRYPTO_FAILED`。`crypto.signal` 当前只用于根证书 URL 读取和证书加载，不替代 `verify()` 自己的取消信号。

## 大规模文档

实现以 1000 页为设计规模，关键措施是：

- 打开时一次读取页尺寸并创建页壳，不逐页打开页面；canvas 只给可见页和预取页分配。
- 可见页渲染优先，离屏页取消；页面缓存只在超过预算时释放不可见 canvas。
- 文本层只构建可见页及相邻页；查找按时间片分页扫描，并限制单页/全篇命中数。
- 缩略图只为滚动窗口创建 canvas；大纲、书签和元数据来自文档级缓存，不加载页面内容。
- 打印/导出按任务顺序逐页处理，自动降低大任务的 DPI，并提供进度与取消。

当前没有可复跑的正式性能阈值门禁；e2e 性能用例记录 1000 页打开、跳页、缩放、查找、缩略图和堆内存采样，供回归比较，不作为发布阻断条件。

## 引擎契约与当前缺口

### 当前使用的契约

UI 依赖引擎提供：明文/容器打开、`pageCount`、`getPageInfos`、`getPage`、`getSize`/`getViewport`、`render` 及渲染事件、`exportImage`、`prepare`、`getTextContent`、`getOutline`、`getBookmarks`、`getMetadata`、`getPermissions`、`getSignatureEntries` 和 `getSignedValue`。具体字段、单位、默认值和错误码见 [UI 使用的引擎 API](./ofdrw-viewer-ui-engine-api.md) 与 [引擎 API](../packages/ofdrw-viewer-engine/skills/API.md)。

边界要求：

- 引擎不联网、不读本地文件；URL/鉴权/Range 由 UI 的 `HttpByteSource` 负责，引擎只消费 `arraybuffer`/`blob`/`custom` 字节源。
- 引擎不解析 ASN.1、X.509 或签名值，不公开 `Seal.esl`；加密解密和验签由 crypto 负责。
- 引擎权限是只读声明；UI 按钮禁用不等于 DRM 强制。
- 引擎不提供区域/瓦片渲染，也不负责阅读器交互旋转和布局。

### 当前缺口与产品边界

- `thumbnailCacheSize` 虽在构造选项中解析，当前缩略图实现固定使用 100，尚未按该选项调整缓存。
- `signatureclick` 事件在类型和适配器事件表中保留，但当前签章覆盖层点击不派发该事件；详情通过 `showSignature()` / `getSignatureDetail()` 获取。
- `PageRange` 的公开类型不接受字符串，但打印/导出运行时为自定义工具栏兼容 `"1-3,5"` 一类范围文本；宿主按类型使用时仍应传 `PageRange`。
- Esc 同时承担关闭文档、关闭侧栏和退出回退全屏：主区域/工具栏按 Esc 会关闭文档；回退全屏无侧栏时同一次按键还可能退出全屏，内联侧栏打开时则可能同时关闭文档和侧栏但保留全屏。现有回归用例只断言侧栏/全屏状态，没有断言文档是否仍打开；若产品期望“只关闭浮层”，需要调整快捷键/fallback 监听并补断言文档仍打开的回归测试，当前实现没有统一的只关浮层策略。

## 包结构、构建与框架适配

### 目录与依赖

包位于 `packages/ofdrw-viewer-ui`，源码按 `a11y/`、`component/`、`crypto/`、`export/`、`i18n/`、`print/`、`react/`、`signature/`、`source/`、`text/`、`theme/`、`ui/`、`views/`、`vue/` 组织。运行时依赖 `@ofdrw/ofdrw-viewer-engine`、`@ofdrw/ofdrw-viewer-crypto` 和 `fflate`；React/Vue 是可选 peer，核心入口和 `./element` 不 import 框架。

### 构建与导出

`tsup` 输出 ESM、CJS、`.d.ts` 和独立 `style.css`，目标语法 `es2020`；引擎、crypto、React/Vue 和 `fflate` 保持 external，不打包进核心。`package.json` 暴露 `./`、`./react`、`./vue`、`./element`、`./component`（element 的别名）和 `./style.css`。

### 框架适配边界

- Web Component：light DOM，属性映射基础标量和侧栏，复杂 `source`/`features`/`crypto` 通过 property；组件事件名使用 `ofd-` 前缀。
- React：`forwardRef` + `useImperativeHandle`，props 变化同步到实例，`source` 变化调用 `open()` 而不重建实例；卸载调用 `destroy()`。
- Vue：props 同步和 emits 映射，暴露核心方法子集；不另写布局或渲染。

三者共用同一实例 API，适配器不新增第二套语义；`source` 从有到无时回落到查询参数。核心和适配器都不承诺 SSR 水合。

## 浏览器兼容与信创

构建目标是 ES2020。运行时依赖现代浏览器的 DOM、Canvas 2D、`AbortController`、`ResizeObserver`、Pointer Events 和 Fullscreen API；缺少 Fullscreen API 时使用沉浸式回退，缺少 `IntersectionObserver` 时缩略图改用滚动扫描，`requestIdleCallback` 缺失时用定时器回退。

当前不附带 polyfill，也不承诺旧版 IE 或早期 WebView。桌面 Chromium/Edge、Android Chromium、iOS Safari 和信创 Chromium 的具体最低版本以实际验收环境为准；触摸缩放、打印分页和混合页尺寸打印需要在目标内核上回归。浏览器验收使用桌面视口 1440×900、移动视口 390×844，并覆盖 1024/768/480 断点；信创内核没有独立 CI 矩阵，发布前应在目标环境执行同一套打开、滚动、缩放、打印用例。跨域 URL 来源要求服务端允许 CORS、`Range` 并暴露 `Content-Range`；字体、图片和证书的读取同样受浏览器安全策略约束。

## 安全、隐私与许可

- 网络请求只由 UI 发起：文档 URL、请求头和根证书 URL 会暴露给目标服务器；`?base64=` 会把文档内容放进页面地址，可能进入浏览器地址记录、服务器日志和 Referer，敏感文档应避免使用。
- `HttpByteSource` 只转发配置的 headers，不转发 `credentials` 等其他 fetch 选项；跨域 Cookie/鉴权由宿主和服务端 CORS 方案决定。当前没有内建重试、代理或下载进度 UI。
- 凭据、私钥和根证书私钥材料不写入日志、DOM 属性或持久化存储；验证报告只包含展示所需的证书和诊断信息。UI 不提供遥测或上传。
- 打开失败、验签失败和证书不受信必须显示为失败或未知，不能用“有签章”代替“文档有效”。
- 本包采用 MIT 许可证；运行时直接依赖的 MIT/ISC/BSD-3-Clause 组件及其版权声明由 `THIRD_PARTY_NOTICES` 统一提供，发布时随包保留。

## 测试入口

- 单元/集成测试：`pnpm -C packages/ofdrw-viewer-ui test`（Vitest，jsdom；覆盖源码别名，不依赖构建产物）。
- 类型检查：`pnpm -C packages/ofdrw-viewer-ui typecheck`。
- 单元与集成测试：`pnpm -C packages/ofdrw-viewer-ui test`，覆盖打开、翻页、缩放、旋转、布局、查找、输出、签章、验证、加载态、可访问性与文本层选区。
- 浏览器验收：仓库不保留 Playwright 测试。需要真实浏览器确认的交互（点击、拖选、双击缩放等）在本地临时用 Playwright 验证，取得证据后删除测试文件，结论写入提交说明或设计文档。约束见 [测试方案 §1.4](./测试方案.md)。
- 跨模块测试矩阵和验收口径见 [测试方案](./测试方案.md)，不在本文重复。