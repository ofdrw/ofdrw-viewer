# @ofdrw/ofdrw-viewer-engine 公开 API

本文件是 `@ofdrw/ofdrw-viewer-engine` 的完整调用面参考：签名、参数默认值、返回结构、单位、错误码与 warning。接入步骤、平台示例和排障流程见同目录 [SKILL.md](./SKILL.md)。

公共 API 以 `src/index.ts` 的导出面为准，与 `dist/index.d.ts` 保持一致；本文附录逐个列出全部导出名。

---

## 1. 调用约定

- 包根只导出本文附录列出的类、函数、常量与类型；`container`、`model`、`render` 等内部模块不从包根暴露。
- 公开异步 API 在调用方取消时以 `OFDError`（`code='OFD_ABORTED'`）拒绝，文档关闭后以 `code='OFD_CLOSED'` 拒绝。
- `OFDDocument.open()` 成功后才能取页；`close()` 可重复调用，关闭后文档对象不可复用。
- 页面几何用 **mm**，输出画布/图片用 **设备像素**，文本层用 **px**；完整约定见 §12。
- 平台注入（Canvas、图片编码、字体、字节源、容器）见 §8；错误码见 §9，warning 码见 §10。

---

## 2. API 总览

| 入口 | 类型 | 用途 |
| --- | --- | --- |
| `OFDDocument.open(options)` | `Promise<OFDDocument>` | 打开 OFD 包，只读页树/资源索引 |
| `document.pageCount` | `number` | 页数，打开后固定 |
| `document.getPage(index)` | `Promise<OFDPage>` | 取页并解析页尺寸 |
| `document.getPageInfos(options)` | `Promise<readonly PageInfo[]>` | 批量读页尺寸，不构建显示内容 |
| `document.getOutline()` | `Promise<readonly OutlineNode[]>` | 大纲树 |
| `document.getBookmarks()` | `Promise<readonly BookmarkItem[]>` | 书签 |
| `document.getMetadata()` | `Promise<DocumentMetadata>` | 文档属性 |
| `document.getSignatureEntries()` | `Promise<readonly SignatureEntryInfo[]>` | 签章 XML 元数据 |
| `document.getSignedValue(id)` | `Promise<SignedValueFile \| undefined>` | 签章值原始字节 |
| `document.getPermissions()` | `Promise<DocumentPermissions>` | 权限声明（只读） |
| `document.getAttachments()` | `Promise<readonly AttachmentInfo[]>` | 附件元信息 |
| `document.getAttachmentData(id)` | `Promise<Uint8Array \| undefined>` | 附件原始字节 |
| `document.close()` | `Promise<void>` | 中止活动操作并释放资源 |
| `document.events` | `OFDEventBus` | 文档/页面事件总线 |
| `page.index` | `number` | 页索引，从 0 开始 |
| `page.getSize()` | `PageSize` | 页尺寸，mm |
| `page.getViewport(options)` | `Viewport` | 指定 DPI 的像素尺寸 |
| `page.render(params)` | `RenderTask` | 渲染到宿主 Canvas |
| `page.exportImage(options)` | `Promise<PageImageResult>` | 整页导出 PNG/JPEG/WebP |
| `page.prepare(options)` | `Promise<void>` | 预取页面模型/字体/图片 |
| `page.getTextContent(options)` | `Promise<TextContent>` | 像素坐标文本层 |
| `getVersion()` / `VERSION` | `string` | 引擎版本号 |
| `openZipVirtualContainer(source, options)` | `Promise<VirtualContainer>` | 构造默认 ZIP 容器 |
| `getPageViewport(size, options)` | `Viewport` | 纯函数：mm → px |
| `getPageTransform(area, dpi)` | `Matrix` | 纯函数：mm → 设备矩阵 |
| `OFDError` / `isOFDError` / `toOFDError` | 错误类型与工具 | 错误分类 |
| `WarningCollector` / `WARNING_CODES` | warning 工具 | 收集与去重 |

---

## 3. `OFDDocument`

打开的文档对象。页树、元数据、权限在 `open()` 阶段解析并缓存；页面内容、字体、图片按需加载。

### 3.1 `OFDDocument.open(options: OFDOpenOptions | OFDOpenFromContainerOptions): Promise<OFDDocument>`

```ts
static open(options: OFDOpenOptions): Promise<OFDDocument>;
static open(options: OFDOpenFromContainerOptions): Promise<OFDDocument>;
```

`OFDOpenOptions` 字段（`OFDOpenFromContainerOptions` 另见下方容器规则）：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `source` | `OFDSource` | `OFDOpenOptions` 类型必填；纯容器模式改用 `OFDOpenFromContainerOptions`（`source` 可选上下文） | 文档来源，见 §3.2 |
| `container` | `VirtualContainer` | — | 宿主已构造的明文容器；engine 借用，不关闭 |
| `containerFactory` | `VirtualContainerFactory` | — | engine 调用并拥有返回容器；与 `container` 互斥 |
| `documentIndex` | `number` | `0` | 多文档包的文档索引；非整数/负数或越界抛 `OFD_INVALID_PACKAGE` |
| `limits` | `Partial<ResourceLimits>` | 见 §11.1 | 资源限制浅合并 |
| `cache` | `Partial<CacheOptions>` | 见 §11.2 | 缓存预算浅合并 |
| `defaultFonts` | `readonly FontInput[]` | — | 缺字体时的默认替代字体，优先级高于 `supplementaryFonts` |
| `supplementaryFonts` | `FontInput[]` | — | 补充字体，按需参与缺字/缺字体回退 |
| `fontProvider` | `FontProvider` | — | 按需字体来源；`match()` 是唯一读取入口 |
| `imageDecoders` | `ImageDecoderPlugin[]` | `[]` | 宿主图片解码插件；同格式优先于内置解码器 |
| `onWarning` | `(warning: OFDWarning) => void` | 静默 | warning 回调；去重与异常语义见 §10 |
| `strictImageCtm` | `boolean` | `true` | 图片缺 CTM 时按 identity 单位矩形绘制 |
| `layerOrder` | `'document' \| 'type'` | `'type'` | 页面内容绘制顺序；`document` 为严格 XML 顺序 |
| `createCanvas` | `(width, height) => Canvas2DLike` | 浏览器 `document`/`OffscreenCanvas` | 临时画布工厂；Node/小程序必须注入 |
| `encodeImage` | `EncodeImage` | 浏览器 `convertToBlob`/`toBlob` | `exportImage` 编码钩子；Node/小程序必须注入 |
| `renderer` | `Renderer` | 内部 `H5Canvas2DRenderer` | 自定义渲染器接管页面内容绘制，`exportImage` 也经同一实例绘制导出画布 |
| `eventBus` | `OFDEventBus` | engine 新建 | 需在 `open` 完成前监听打开事件时注入；一个总线只对应一个文档 |
| `signal` | `AbortSignal` | — | 打开取消；中止后以 `OFD_ABORTED` 拒绝 |

容器规则：

- 不传 `container`/`containerFactory` 时 `source` 必填，engine 创建并拥有默认 ZIP 容器，`close()` 时关闭。
- `container` 为宿主借用：engine 只读取、不关闭；容器必须 `encrypted=false` 且 `read()` 返回明文。用 `OFDOpenFromContainerOptions` 时 `source` 可选，仅作为宿主上下文。
- `containerFactory` 与 `container` 互斥，`source` 作为工厂输入；返回容器归 engine 所有。
- `container.encrypted=true`（未解密包）抛 `OFD_ENCRYPTED`；先交由 `@ofdrw/ofdrw-viewer-crypto` 解密再注入明文容器。
- 参数校验失败（缺来源、`container` 与 `containerFactory` 同时出现）不派发任何事件。

事件：`document:open:start` 在容器打开前同步派发；成功派发 `document:open:end`，失败派发 `document:open:error`，`signal` 取消派发 `document:open:abort(cause='caller')`。

常见错误：`OFD_INVALID_PACKAGE`（包结构/来源非法）、`OFD_ENCRYPTED`、`OFD_XML_PARSE`、`OFD_UNSUPPORTED_COMPRESSION`、`OFD_LIMIT_EXCEEDED`、`OFD_ABORTED`。

### 3.2 `OFDSource`

```ts
type OFDSource =
  | { kind: 'arraybuffer'; data: ArrayBuffer | Uint8Array }
  | { kind: 'blob'; blob: Blob }
  | { kind: 'custom'; source: ByteSource };
```

| `kind` | 宿主准备 | engine 行为 |
| --- | --- | --- |
| `arraybuffer` | `fetch`、`fs.readFile`、`wx` 读文件等得到 `ArrayBuffer`/`Uint8Array` | 包装为内存字节源；空字节抛 `OFD_INVALID_PACKAGE` |
| `blob` | 浏览器 `File`/`Blob`；Node 22+ 自带 `Blob` | 按需读取；空 Blob 抛 `OFD_INVALID_PACKAGE` |
| `custom` | 实现 `ByteSource.read()`（HTTP Range、随机读文件等） | 直接使用；容器接管源，关闭时调用可选 `close()` |

engine 不联网、不读本地文件：URL 与本地路径要先由宿主读成字节；浏览器 `File`/`Blob` 可直接作为 `blob` 来源，也可读成 `arraybuffer`。鉴权、Cookie、代理、重试、Range、进度与文件读取全部在宿主。大文件优先实现 `custom ByteSource`，避免整包读入内存。

兼容：运行期传入已删除的 `kind: 'url'` 抛 `OFD_INVALID_PACKAGE`；`kind: 'node-file'`/`'wechat-file'` 抛 `OFD_RENDERER_UNSUPPORTED`。迁移为下面任一形式：

```ts
// 浏览器：URL → 字节
const doc = await OFDDocument.open({
  source: { kind: 'arraybuffer', data: await (await fetch(url)).arrayBuffer() },
});

// Node/小程序：本地/临时文件 → 字节
const doc2 = await OFDDocument.open({
  source: { kind: 'arraybuffer', data: await readFile(path) },
});
```

需要直接操作 ZIP 容器时，`openZipVirtualContainer(source: OFDSource, options?: OpenZipVirtualContainerOptions): Promise<VirtualContainer>` 可直接构造默认 ZIP 容器：返回的是 raw package container（`encrypted` 反映压缩包是否加密，`read()` 对加密包返回存仓字节），归调用方所有，用完需 `close()`；`options.limits` 只应用 ZIP 相关字段。

### 3.3 `document.pageCount: number`

页数，`open()` 成功后固定，等于文档页树声明的页数。

### 3.4 `document.getPage(pageIndex: number, options?: { signal?: AbortSignal }): Promise<OFDPage>`

- `pageIndex` 从 0 开始；非整数、负数或 `>= pageCount` 抛 `OFD_PAGE_NOT_FOUND`。
- 只影响本次等待的取消：`signal` 取消抛 `OFD_ABORTED`；共享的页面加载不会被单个调用方取消。
- 校验失败不派发事件；通过后派发 `page:load:start`，成功派发 `page:load:end`，取消/失败派发 `page:load:abort`/`page:load:error`。
- 页尺寸已按页 → 模板页 → `CommonData/PageArea` → A4（210×297 mm）回退链解析；最终回退 A4 时上报 `W_BAD_NUMBER`。

### 3.5 `document.getPageInfos(options?: PageInfoOptions): Promise<readonly PageInfo[]>`

`PageInfoOptions`：`start`（默认 0）、`count`（默认剩余全部，0 表示空）、`signal`。

- 返回连续页、按索引升序；不构建显示列表，不解码字体/图片。
- 越界：`start < 0`、`start >= pageCount` 或 `count <= 0` 返回空数组。
- 页尺寸与 `getPage(index).getSize()` 使用同一回退链；结果按页缓存到 `close()`。
- 单页内容缺失/损坏时 warning 并回退尺寸，不中断整批；取消抛 `OFD_ABORTED`，关闭抛 `OFD_CLOSED`。
- 性能基线（本地 ZIP、参考机）：1000 页冷启动 < 300 ms，全部命中缓存 < 50 ms。

`PageInfo`：`index`、`widthMm`、`heightMm`；可选 `xMm`/`yMm`（`PhysicalBox` 原点）与 `source: 'page' | 'template' | 'default'`。

### 3.6 `document.getOutline(options?: { signal?: AbortSignal }): Promise<readonly OutlineNode[]>`

- 打开阶段已解析并缓存，不加载页面内容；无大纲返回 `[]`。
- 节点保持 XML 顺序与层级；`dest` 坐标单位 mm。
- 深度上限 64 层；超限截断子节点并上报 `W_OUTLINE_TARGET`。
- 目标无效/书签引用不存在：保留节点、省略 `dest` 并上报 `W_OUTLINE_TARGET`。
- `OutlineNode`：`title`、`children`（XML 顺序）、可选 `expanded` 与 `dest`。

### 3.7 `document.getBookmarks(options?: { signal?: AbortSignal }): Promise<readonly BookmarkItem[]>`

- 打开阶段已解析并缓存；无书签返回 `[]`。
- 缺少 `Name` 的书签跳过并上报 `W_BOOKMARK_TARGET`；目标无效时保留书签、省略 `dest` 并上报 `W_BOOKMARK_TARGET`。
- `BookmarkItem`：`name` 与可选 `dest`；`DocumentDestination` 含 `type`（`XYZ`/`Fit`/`FitH`/`FitV`/`FitR`）、`pageIndex` 与按类型可选的 mm 边界/缩放字段。

### 3.8 `document.getMetadata(options?: { signal?: AbortSignal }): Promise<DocumentMetadata>`

- 打开阶段解析 OFD.xml/DocInfo 并缓存；无 DocInfo 时仍返回 `version`、`pageCount`（以及可得的 `packageSize`）。
- 日期字段保留 OFD 原文，不做时区推断；非法日期上报 `W_METADATA_FIELD` 并省略该字段。
- `DocumentMetadata` 必含 `version`、`pageCount`；可选 `packageSize`、`title`、`author`、`subject`、`abstract`、`creationDate`、`modDate`、`creator`、`creatorVersion`、`keywords`、`docId`、`customData`。

### 3.9 `document.getSignatureEntries(options?: { signal?: AbortSignal }): Promise<readonly SignatureEntryInfo[]>`

- 只读取 `Signatures.xml` / `Signature.xml` 元数据；不读取印章图片字节、不解析签章值内容、不验签。
- 返回顺序与 `Signatures.xml` 一致；无签章索引返回 `[]`；结果缓存到 `close()`。
- 索引读取/解析失败：上报警告并返回 `[]`；单个 `Signature.xml` 损坏：warning 后跳过该条。
- 重复 `ID` 先到先得并上报 `W_DUPLICATE_RESOURCE`；`StampAnnot` 的 `PageRef` 未匹配页面时保留 `pageId`、省略 `pageIndex` 并上报 `W_BAD_PATH`。
- `SignatureEntryInfo`：`id`、`type`、`baseLoc`、`references`、`stamps`、`hasSignedValue`；可选 `provider`、`signatureDateTime`、`signedValuePath`，只在 XML 声明时出现。
- `SignatureStampInfo`：`pageId`、`boundary`（mm），可选 `id`、`pageIndex`、`clip`。

### 3.10 `document.getSignedValue(signatureId: string, options?: { signal?: AbortSignal }): Promise<SignedValueFile | undefined>`

- 返回签章值条目的原始字节；engine 不解释内容、不验签。
- `signatureId` 按资源 ID 规则规范化后匹配。
- 未声明签章值、签章 ID 不存在或未声明路径：返回 `undefined`，不 warning。
- 已声明但读取失败：上报 `W_SIGNATURE_RESOURCE` 并返回 `undefined`；资源限制/包损坏错误原样抛出。
- 每次调用重新读取，不缓存大文件；返回字节归调用方所有。

### 3.11 `document.getPermissions(options?: { signal?: AbortSignal }): Promise<DocumentPermissions>`

- 只返回 `Document.xml` 中声明的权限，不执行 DRM 强制。
- 缺省字段按 OFD 规范回退：`edit`/`annot`/`export`/`signature`/`watermark`/`printScreen` 默认 `true`；无 `Print` 时视为可打印且份数不限；无 `ValidPeriod` 时不限制有效期。
- `Print.Copies`：`0` 表示不允许打印，正整数为份数；负数按不限处理且不 warning；非整数或超出安全整数范围按不限处理并上报 `W_PERMISSION_FIELD`。
- `DocumentPermissions`：`edit`、`annot`、`export`、`signature`、`watermark`、`printScreen` 六个布尔项，可选 `print.printable/copies` 与 `validPeriod.start/end`；日期保留原文。

### 3.12 `document.getAttachments(options?: { signal?: AbortSignal }): Promise<readonly AttachmentInfo[]>`

- 首次调用按需解析 `Attachments.xml` 并缓存到 `close()`；只读索引，不读附件内容。
- 无 `Attachments.xml` 返回 `[]`；索引读取/解析失败 warning 后返回 `[]`。
- `Attachment@ID`、`Name` 必填，缺失时跳过该条并上报 `W_ATTACHMENT_FIELD`；重复 `ID` 保留先出现者并上报 `W_DUPLICATE_RESOURCE`。
- `Visible` 缺省 `true`，`Usage` 缺省 `none`；`Size` 按 XML 的 KB × 1024 换算为 byte，非法时省略并上报 `W_ATTACHMENT_FIELD`。
- `AttachmentInfo`：`id`、`name`，可选 `format`、`size`（byte）、`creationDate`、`modDate`、`visible`、`usage`；条目保持 XML 顺序。

### 3.13 `document.getAttachmentData(attachmentId: string, options?: { signal?: AbortSignal }): Promise<Uint8Array | undefined>`

- 返回附件原始字节，不解析内容；`attachmentId` 按资源 ID 规则规范化后匹配。
- 无 `Attachments.xml`（未声明附件索引）：返回 `undefined`，不 warning。
- 索引存在但 ID 不存在、条目缺少可用 `FileLoc`、附件文件缺失/读取失败：上报 `W_ATTACHMENT_RESOURCE` 并返回 `undefined`。
- `OFD_LIMIT_EXCEEDED`/`OFD_INVALID_PACKAGE` 等不可降级错误原样抛出。
- 每次调用按需读取，不缓存附件内容；返回字节归调用方所有。

### 3.14 `document.close(): Promise<void>`

- 幂等；第二次调用直接返回，不派发事件。
- 顺序：派发 `document:close:start` → 中止进行中的渲染/导出/取页/准备/文本/附件/签章读取 → 等待活动操作 settle → 关闭自有容器（借用容器只清引用）→ 释放渲染器、字体、图片与缓存 → 派发 `document:close:end`。
- `close:end` 是该文档最后一帧事件，之后总线静默；`close()` 不向调用方抛错。
- 关闭后任何读写操作以 `OFD_CLOSED` 拒绝；页面句柄不能跨文档复用。

### 3.15 `document.events` 与事件订阅

`document.events` 是 `OFDEventBus`（未注入时由 engine 创建）。订阅方式：

```ts
document.on(type, handler);              // 返回退订函数
document.once(type, handler);            // 返回退订函数
document.off(type, handler);             // 同一回调的多次注册全部移除
document.addEventListener(type, handler, { once, signal });
document.removeEventListener(type, handler);
document.events.removeAllListeners(type?);
document.events.listenerCount(type);
```

- 派发同步；派发前快照监听器，派发中新增的监听器不参与本次事件。
- 单个监听器异常被隔离；未提供 `onListenerError` 时静默。
- `once` 在调用前移除；`addEventListener` 的 `signal` 已中止时不注册，注册后中止自动移除。
- `sequence` 从 1 开始单调递增；`operationId` 在同一文档内唯一。
- 共 14 个事件：`document:open:start/end/error/abort`、`document:close:start/end`、`page:load:start/end/error/abort`、`page:render:start/end/error/abort`。
- 入口校验失败（参数非法、页码越界、文档已关闭）不进入操作生命周期，不派发任何事件；`getPage` 的预取消也在 `start` 前返回（无事件），`open`/`page.render` 的预取消仍会派发 `start → abort`。载荷字段见 §13.9。

---

## 4. `OFDPage`

由 `OFDDocument.getPage()` 返回的页面句柄；宿主不应直接构造。页面监听器是文档总线按 `pageIndex` 过滤的视图。

### 4.1 `page.index: number`

页索引，从 0 开始。

### 4.2 `page.getSize(): PageSize`

返回 `{ width, height }`，单位 mm，与 `getPageInfos()` 同一回退链结果。

### 4.3 `page.getViewport(options?: ViewportOptions): Viewport`

- `options.dpi` 默认 96；非有限或 `<= 0` 回退 96。
- 返回 `{ width, height, dpi }`，宽高单位为设备像素；像素尺寸保留 3 位小数（0.001 px），去掉 mm→px 浮点尾差，不做整数取整。
- 纯计算，不加载字体/图片；画布分配由宿主导航：`Math.ceil(viewport.width/height)`。
- 纯函数 `getPageViewport()` 不校验 DPI（见 §7.1），页面方法会校验并回退。

### 4.4 `page.render(params: PageRenderParameters): RenderTask`

`PageRenderParameters`：`canvasContext`（必填）、`viewport`（必填）、`signal`（可选）、`contentFilter`（可选，见 §4.10）。

- `canvasContext`/`canvas` 必须有效，canvas 宽高必须为有限数值且 `>= viewport.width/height`（浮点误差容差约 1e-6 px）；context 无效抛 `OFD_RENDERER_UNSUPPORTED`，canvas 小于 viewport 抛 `OFD_CANVAS_SIZE_MISMATCH`。
- `viewport` 宽高/DPI 必须为有限正数，否则 `OFD_CANVAS_SIZE_MISMATCH`；宽×高超过 `maxCanvasPixels`（默认 64,000,000）抛 `OFD_CANVAS_TOO_LARGE`。
- 只绘制页面内容：不设置 canvas 尺寸、不清屏、不填背景、不绘制阅读器 UI；以 `M_page` 覆盖上下文的预置 CTM。
- 同一 canvas 的渲染串行排队（前一个失败不影响后续任务）；不同 canvas 可并行。
- 使用 `viewport.dpi` 准备页面；同一页已有该 DPI 的准备结果时复用（`prepare()` 固定准备 96 DPI），否则重新准备。
- `params.signal` 与 `RenderTask.cancel()` 合并；取消后 `task.promise` 以 `OFD_ABORTED` 拒绝并派发 `page:render:abort`。
- 入口校验失败：同步返回已拒绝的任务（`task.id === 0`），不派发事件。通过后 `render()` 返回前同步派发 `page:render:start`；预取消的 `signal` 仍按 `start → abort` 派发。
- 自定义 `renderer` 接管本方法及 `exportImage` 的页面绘制；不提供局部/瓦片渲染能力。
- `contentFilter` 只影响本次绘制：不传全部绘制，传了按白名单只绘制指定层/模板/注释/签章，详见 §4.10。

### 4.5 `page.exportImage(options?: PageImageExportOptions): Promise<PageImageResult>`

`PageImageExportOptions` 字段与默认值：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `dpi` | `number` | `96` | 非有限或 `<= 0` 回退 96 |
| `format` | `'png' \| 'jpeg' \| 'webp'` | `'png'` | 未知格式抛 `OFD_RENDERER_UNSUPPORTED` |
| `quality` | `number` | `0.92` | JPEG/WebP 有效，夹取到 0..1（非有限值回退 0.92）；PNG 固定 1 |
| `rotation` | `0 \| 90 \| 180 \| 270` | `0` | 只改导出方向；90/270 输出宽高互换；非法值回退 0 并上报 `W_BAD_NUMBER`（`objectId='exportImage.rotation'`） |
| `background` | `string \| null` | `'#ffffff'` | PNG 可传 `null` 透明；JPEG/WebP 的 `null` 按白底；非法 CSS 颜色按白底 |
| `contentFilter` | `PageContentFilter` | — | 只导出指定内容；不传全画；不继承上一次 `render` 的过滤（见 §4.10） |
| `signal` | `AbortSignal` | — | 取消后以 `OFD_ABORTED` 拒绝 |

- 整页导出，不包含阅读器缩放；使用独立的离屏画布，不经过宿主主 Canvas；页面内容仍由文档级 `renderer` 绘制，因此自定义 renderer 会影响导出。
- 画布由文档级 `createCanvas` 创建（未注入时用浏览器默认工厂）；编码优先 `encodeImage`，其次浏览器 `convertToBlob`/`toBlob`。
- 输出尺寸按旋转后的画布计算，超过 `maxCanvasPixels` 抛 `OFD_CANVAS_TOO_LARGE`；画布尺寸与请求不符抛 `OFD_CANVAS_SIZE_MISMATCH`。
- 编码失败、缺少编码器、返回空/非 `Uint8Array` 结果：统一 `OFD_RENDERER_UNSUPPORTED`，原始错误放入 `cause`。
- `PageImageResult`：`data`（归调用方）、`mime`、`width`、`height`（输出设备像素）、`dpi`（实际使用值）。
- 导出期间 `close()` 会中止并等待本次导出，最终以 `OFD_CLOSED` 结束。

### 4.6 `page.prepare(options?: PagePrepareOptions): Promise<void>`

- 预取页面模型、字体与图片，不创建 canvas、不绘制；`options.signal` 只取消本次等待。
- 固定以 96 DPI 准备并缓存 bundle；`render` 使用其他 DPI 时会重新准备。
- 已准备或正在准备时复用；`close()` 中止共享准备流程。
- 页码越界抛 `OFD_PAGE_NOT_FOUND`，取消抛 `OFD_ABORTED`，关闭抛 `OFD_CLOSED`。

### 4.7 `page.getTextContent(options?: TextContentOptions): Promise<TextContent>`

`TextContentOptions` 默认值：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `dpi` | `number` | `96` | 输出 px 的换算 DPI；非有限或 `<= 0` 回退 96 |
| `includeChars` | `boolean` | `true` | 是否返回字符级 `chars` |
| `includeAnnotations` | `boolean` | `false` | 是否包含注释 Appearance 文本 |
| `includeInvisible` | `boolean` | `false` | 是否包含不可见文字（`visible=false` 或 `alpha=0`） |
| `layerOrder` | `'document' \| 'type'` | 打开时的 `layerOrder` | 文本项顺序与图层展开顺序 |
| `maxTextItems` | `number` | `20,000` | 非负整数；`0` 表示不限 |
| `maxTextChars` | `number` | `500,000` | 非负整数；`0` 表示不限 |
| `contentFilter` | `PageContentFilter` | — | 只收集指定内容的文字；不传全画；过滤变化会改变文本缓存键（见 §4.10） |
| `signal` | `AbortSignal` | — | 取消后以 `OFD_ABORTED` 拒绝 |

- 返回 `px` 坐标文本层，原点为页面 `PhysicalBox` 左上角、y 向下；`TextContent.unit` 固定 `'px'`。mm 布局按页缓存，按 `dpi/25.4` 换算，缓存键不含 DPI。
- `TextItem`：`order/objectId?/templateId?/annotationId?/blockId?/layer/layerType/zOrder?/visible/alpha/text/font/size/transform/origin/rect/quad/advance/charCount/chars?`；`text` 过滤 XML 排版 CR/LF 后按 `TextCode` 顺序拼接（普通空格保留），`transform` 为布局局部 mm → 页面 px。
- `TextChar`：`text/codePoint/glyphId?/faceKey?/fallback/origin/advance/rect/quad/approximate`；缺字时省略 `glyphId`/`faceKey`、`advance=0`、`rect` 宽高为 0、`quad` 四点为 `origin`。
- `TextFontInfo`：`resourceId/family/postscriptName?/weightClass?/italic`；`TextPoint`/`TextRect` 单位 px，`TextQuad` 顺序为左上、右上、右下、左下。
- 文本项按绘制顺序排列；默认只收集参与绘制且样式有效的文字：需要 style、非零 Boundary、`fill` 或 `stroke`、`size > 0`、`visible` 且 `alpha > 0`（后两项由 `includeInvisible` 放宽）。默认排除 Pattern tile、`ClipArea.text` 与注释 Appearance，`includeAnnotations=true` 才加入注释文字。
- 空页返回 `items: []`、`itemCount: 0`、`charCount: 0`，不报错；上限非法（负数/非整数）回退默认值，`0` 表示不限。
- `TextItem.visible` 表示对象自身是否可见且 `alpha > 0`；`alpha` 为对象自身 0..1，不含父组透明度。
- `includeInvisible=true` 时不可见文字也会出现，`visible=false` 可用于区分。
- 超出 `maxTextItems` 停止加入后续文本项并上报 `W_TEXT_ITEM_LIMIT`；下一个文本项会超过 `maxTextChars` 时整项不加入并上报 `W_TEXT_CHAR_LIMIT`；`TextContent.truncated` 标记截断维度。
- 缺字体上报 `W_FONT_MISSING` 并跳过对应文本项；缺字形上报 `W_GLYPH_MISSING`。
- 不调用 Canvas 文字 API；纯逻辑布局，可在 Worker/Node 中运行。
- `TextContent`：`pageIndex`、`dpi`、`unit`、`pageWidth`、`pageHeight`、`items`、`itemCount`、`charCount`、`truncated`；`charCount` 统计所有文本项字符（即使 `includeChars=false`）。
- 同一页的并发请求共享构建；最后一个等待方取消时才中止无人等待的构建。
- `contentFilter` 与 `page.render` 使用同一白名单语义；被隐藏的层/模板/注释不会进入文本层。

### 4.8 `RenderTask`

| 成员 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `number` | 本次渲染的 `operationId`；入口校验失败时为 0 |
| `promise` | `Promise<void>` | 完成时 resolve；失败/取消时以 `OFDError` 拒绝 |
| `cancel()` | `void` | 请求取消；可重复调用，无额外副作用 |

取消错误码为 `OFD_ABORTED`，`cause` 保留调用方 `signal.reason`。

### 4.9 页面事件订阅

`page.on/once/off/addEventListener/removeEventListener` 只转发 `page:*` 事件，并按 `pageIndex` 过滤；`page:load:*` 发生在页面句柄创建前，通常要通过 `document.on` 观察。订阅实现挂在文档总线上，页面离开文档后视图失效。

- `page:render:start`：入口校验通过、`render()` 返回前同步派发，含 `dpi/width/height`。
- `page:render:end`：绘制完成、`task.promise` resolve 前派发。
- `page:render:error`：真实失败，含 `error/durationMs`。
- `page:render:abort`：调用方取消（`cause='caller'`）或文档关闭（`cause='close'`）。

### 4.10 `PageContentFilter`（内容过滤）

`page.render`、`page.exportImage`、`page.getTextContent` 都接受可选的 `contentFilter`，用于只绘制/收集指定内容。语义是**白名单**：

- 不传（或传 `undefined`/`null`）：全部绘制，与旧版本行为一致。
- 传了：只绘制出现且启用的项；未出现的层、模板、注释、签章一律不绘制。
- `contentFilter: {}`：空白页（没有指定任何内容）。
- 与“全画”等价的配置（四层都 `true`、`annotations: true`、`signatures: true`、无注释类型白名单）归一化为全画。
- 每次调用独立；引擎不保存“当前过滤”，导出/文本层不会自动继承上一次 `render` 的过滤。

```ts
export type KnownAnnotationType = 'Link' | 'Path' | 'Highlight' | 'Stamp' | 'Watermark';
export type AnnotationType = KnownAnnotationType | (string & {});

export interface DrawLayerOptions {
  /** 是否绘制该层中页面自身的内容，缺省 false。 */
  page?: boolean;
  /** 是否绘制该层中的模板内容，缺省 false；Custom 层忽略。 */
  templates?: boolean;
}

export interface PageContentFilter {
  /** 各内容层；出现即参与白名单，未出现的层不绘制。 */
  layers?: {
    background?: boolean | DrawLayerOptions;
    body?: boolean | DrawLayerOptions;
    foreground?: boolean | DrawLayerOptions;
    custom?: boolean | DrawLayerOptions;
  };
  /** 是否绘制注释，缺省 false；false 时忽略 annotationTypes。 */
  annotations?: boolean;
  /** 只绘制这些注释类型；出现时视为开启注释；空数组表示不画注释。 */
  annotationTypes?: readonly AnnotationType[];
  /** 是否绘制签章，缺省 false。 */
  signatures?: boolean;
}
```

层值规则：

| 值 | 含义 |
| --- | --- |
| `true` | 等价于 `{ page: true, templates: true }`，绘制整层 |
| `false` | 不绘制该层 |
| `{ page: true }` | 只绘制该层页面自身内容 |
| `{ templates: true }` | 只绘制该层模板内容（模板按 `Template/@ZOrder` 归入背景/正文/前景） |
| `{}` | 不绘制该层 |

- 模板内部 `Layer/@Type` 不参与过滤，模板整体按 `Template/@ZOrder` 归属；Custom 层没有模板归属，`templates` 被忽略。
- 注释：`annotations: true` 绘制全部；`annotationTypes` 出现时只绘制列出的类型（即使 `annotations` 未显式 true）；`annotations: false` 时不绘制并忽略 `annotationTypes`；`annotationTypes: []` 不绘制任何注释。
- 层值只接受布尔值或对象；其他值（如 `null`、字符串、数字）按“未指定”处理，即不绘制该层。对象里只有 `page: true`/`templates: true` 生效，其他字段值与类型忽略。
- 注释类型匹配 `Annotation.type` 原值，区分大小写。`KnownAnnotationType` 为 `Link/Path/Highlight/Stamp/Watermark`；`AnnotationType = KnownAnnotationType | (string & {})`，支持宿主自定义 `Annot/@Type`。`KNOWN_ANNOTATION_TYPES` 可用于生成多选项。
- 签章与注释独立；`signatures` 缺省 false。
- `annotationTypes` 只接受数组：非数组按“未指定”处理；数组内的非字符串项忽略，字符串 `trim` 后去重并保持首次出现顺序。白名单模式下注释缺失 `type` 视为不匹配。
- 过滤是绘制期判定：切换过滤不需要重新 prepare、不重新解码字体/图片；`getTextContent` 的文本缓存键包含过滤签名（不传/等价全画为 `all`，`{}` 为 `none`）。
- 非法输入按“未指定”处理（对应内容不绘制），不抛错，不新增 warning。

示例：

```ts
// 只看正文和签章
await page.render({
  canvasContext,
  viewport,
  contentFilter: { layers: { body: true }, signatures: true },
}).promise;

// 只看背景模板
await page.exportImage({
  dpi: 144,
  contentFilter: { layers: { background: { templates: true } } },
});

// 只看正文页面内容 + 印章类注释
await page.getTextContent({
  contentFilter: { layers: { body: { page: true } }, annotationTypes: ['Stamp'] },
});
```

---

## 5. 图片导出编码

### 5.1 `EncodeImage`

```ts
type EncodeImage = (
  canvas: CanvasImageEncodeSource,
  format: PageImageFormat,
  quality: number,
) => Promise<Uint8Array>;
```

- `canvas` 是已绘制整页的导出画布，设备像素。
- `format` 为 `'png' | 'jpeg' | 'webp'`；`quality` 为 0..1（PNG 固定 1，JPEG/WebP 缺省 0.92）。
- 必须返回非空 `Uint8Array`；空数组、非 `Uint8Array` 或抛错统一映射为 `OFD_RENDERER_UNSUPPORTED`，原始错误放入 `cause`。
- Node/小程序未注入且画布无 `convertToBlob`/`toBlob` 时，导出失败并提示注入 `encodeImage`。

### 5.2 `CanvasImageEncodeSource`

`Canvas2DLike` 的可选编码扩展：`convertToBlob?(options?: { type?, quality? }): Promise<Blob>` 与 `toBlob?(callback, type?, quality?): void`。engine 优先使用 `convertToBlob`，其次 `toBlob`；返回 `null`/空 Blob 视为编码失败。

---

## 6. 渲染器扩展点

### 6.1 `H5Canvas2DRenderer`

默认渲染器，构造参数 `H5Canvas2DRendererOptions`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `createCanvas` | 浏览器 `document`，其次 `OffscreenCanvas` | 创建临时画布；Node/小程序必须显式传入 |
| `enableHWA` | `false` | 硬件加速语义；默认对应 `willReadFrequently: true` |

`new H5Canvas2DRenderer(options?)` 可直接作为 `OFDOpenOptions.renderer` 注入；每个文档应使用独立实例，`close()` 后不再复用。`render` 与 `exportImage` 共用该实例。

### 6.2 `Renderer`

自定义渲染器只需实现以下接口（完整签名以 `src/renderer/types.ts` 为准）：

- 页面：`beginPage(context, viewport)`（不设置画布尺寸、不清屏）、`endPage()`、`close()`。
- 状态：`save/restore`、`setTransform(m)`、`transform(m)`、`translate`、`multiplyAlpha(alpha)`、`clear()`。
- 路径：`beginPath`、`moveTo`、`lineTo`、`quadraticCurveTo`、`cubicCurveTo`、`rect`、`closePath`、`clip(rule)`。
- 绘制：`fill(style, paint, rule)`、`stroke(style, paint)`；paint 已由内部绑定。
- 图片：`createImage(decoded): ImageHandle`、`drawImage(image, transform, alpha, smoothing, mask?, blendMode?)`。
- 合成组：`beginGroup(options)`、`endGroup()`；`alpha` 在 `endGroup` 时整体应用一次。

渲染器只接收最终样式、路径、图像、矩阵与 group，不认识 OFD 模型结构；`render` 与 `exportImage` 都用该实例绘制页面内容。

### 6.3 `Canvas2DLike` / `CanvasRenderingContext2DLike`

宿主 Canvas 的最小接口：`width/height/getContext('2d', options?)`；上下文只需引擎会用到的方法与属性：`canvas`（只读）/`save/restore/setTransform/transform/translate/rotate/scale/beginPath/closePath/moveTo/lineTo/quadraticCurveTo/bezierCurveTo/rect/clip/fill/stroke/fillRect/clearRect/drawImage/createLinearGradient/createRadialGradient/createPattern/setLineDash/getLineDash/globalAlpha/globalCompositeOperation/fillStyle/strokeStyle/lineWidth/lineCap/lineJoin/miterLimit/imageSmoothingEnabled`。`createImageData`/`putImageData` 可选：缺失时 Gouraud/网格渐变降级为平均色并上报 `W_GOURAUD_APPROX`；若解码结果是 RGBA 像素图像（`kind='imagedata'`），`createImage` 会以 `OFD_RENDERER_UNSUPPORTED` 拒绝。

---

## 7. 视口与变换

### 7.1 `getPageViewport(size: PageSize, options?: ViewportOptions): Viewport`

纯函数：`width = size.width * dpi / 25.4`，`height = size.height * dpi / 25.4`，`dpi` 默认 96。像素尺寸保留 3 位小数（`0.001 px`），不取整。该函数不校验 DPI，调用方需传入有限正数；页面方法 `page.getViewport()` 会校验并回退 96。

示例：A4（210×297 mm）@96 DPI → `{ width: 793.701, height: 1122.52, dpi: 96 }`；228.6×228.6 mm @96 → `864 × 864`。

### 7.2 `getPageTransform(area: Box, dpi: number = DEFAULT_DPI): Matrix`

`M_page = S(dpi / 25.4) × T(-PhysicalBox.x, -PhysicalBox.y)`，返回 2×3 列主序矩阵 `[scale, 0, 0, scale, tx, ty]`；`area` 单位 mm。

### 7.3 常量

- `DEFAULT_DPI = 96`：默认输出 DPI。
- `MM_PER_INCH = 25.4`：每英寸毫米数。
- `VERSION: string` 与 `getVersion(): string`：引擎版本号，内置于产物，不依赖 `package.json`。

---

## 8. 平台注入接口

### 8.1 字体

```ts
interface FontInput {
  readonly data: ArrayBuffer | Uint8Array;
  readonly family?: string;
}

interface FontMatchRequest {
  fontName: string;
  familyName?: string;
  charset: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  fixedSize: boolean;
}

interface FontProvider {
  match(request: FontMatchRequest): Promise<FontInput | FontInput[] | null>;
}
```

- engine 不内置任何 CJK 字体，也不读取字体 URL/路径；字体字节必须由宿主提供。
- 来源优先级：内嵌 `FontFile` → `fontProvider` → `defaultFonts` → `supplementaryFonts`；主字体按字体名/别名评分选择，其余候选按顺序作为字形回退。
- `FontProvider.match()` 是按需读取字体的唯一入口：需要网络/文件时在 `match()` 内读取并返回 `{ data }`，返回 `null` 表示无匹配。
- `defaultFonts`/`supplementaryFonts` 只接受已读好的 `data`；按字体名/别名评分选择，TTC/OTC 会展开为多个字体面。
- 字体解析失败、超限、来源缺失或 `data` 非法：上报 `W_FONT_MISSING` 并跳过该字体，不中断打开或渲染；`OFD_FONT_PARSE` 是底层字体解析错误，公共调用路径会将其降级为 warning。
- 单个字体字节受 `limits.maxFontBytes`（默认 64 MiB）约束；字体二进制缓存受 `cache.fontBytes` 约束。

### 8.2 图片解码

```ts
interface ImageDecoderPlugin {
  format: string;
  decode(data: Uint8Array): Promise<DecodedImage>;
}

interface ImageDecoder {
  decode(data: Uint8Array, hint?: { format?: string }): Promise<DecodedImage>;
}
```

- 解码顺序：宿主 `imageDecoders` 中格式匹配的插件 → 内置解码器（GIF 首帧、JBIG2、TIFF，按需动态加载）→ 浏览器原生解码（PNG/JPEG/WebP/BMP，`createImageBitmap` 优先，回退 `HTMLImageElement`）。
- Node/小程序没有浏览器原生解码能力时，PNG/JPEG/WebP/BMP 也需要注入插件；GIF/JBIG2/TIFF 可直接使用内置解码器。
- 解码失败、缺少解码器、像素超限：上报 `W_IMAGE_DECODE` 并跳过该图；内置 JBIG2/TIFF 解码器还会上报 `W_JBIG2_DECODE`。渲染继续。
- 单图像素上限 `limits.maxImagePixels`（默认 100,000,000）；解码结果宽高必须为正。
- `DecodedImage`：`{ width, height, data, kind? }`，`data` 为 RGBA8 像素缓冲或宿主可绘制对象。

### 8.3 `ByteSource`

```ts
interface ByteSource {
  readonly size: number;                    // 总字节数，byte；异步探测完成前可为 0
  read(offset: number, length: number): Promise<Uint8Array>;
  ready?(): Promise<void>;                  // 等待异步探测完成
  close?(): Promise<void> | void;           // 释放资源，应幂等
}
```

- 按需读取任意 `[offset, offset + length)` 区间；读取失败应抛 `OFDError`。
- `size` 必须准确；ZIP 容器打开时会等待 `ready()`，`size <= 0` 抛 `OFD_INVALID_PACKAGE`。
- 网络鉴权、Range、重试、取消与进度由宿主实现；engine 只调用接口。
- 生命周期：`custom` 来源交给容器接管，`doc.close()`/`container.close()` 会调用可选 `close()`；`close()` 可重复调用。

### 8.4 画布与编码钩子

- `createCanvas(width, height)`：返回宿主画布（`Canvas2DLike`）。默认 H5 渲染器、矢量印章渲染与 `exportImage` 共用；Node/小程序必须注入。导出的画布宽高必须与请求完全一致，否则 `OFD_CANVAS_SIZE_MISMATCH`。
- `encodeImage(canvas, format, quality)`：见 §5.1；未注入时浏览器使用 `convertToBlob`/`toBlob`。

---

## 9. 错误

所有公开 API 失败抛 `OFDError`（`name='OFDError'`），`code` 用于程序分支，`message` 用于诊断，`cause` 保留原始错误。

```ts
class OFDError extends Error {
  readonly code: OFDErrorCode;
  readonly cause?: unknown;
  constructor(code: OFDErrorCode, message: string, options?: OFDErrorOptions);
}

function isOFDError(value: unknown): value is OFDError;
function toOFDError(error: unknown, code: OFDErrorCode, message: string): OFDError;
```

| `code` | 触发场景 |
| --- | --- |
| `OFD_INVALID_PACKAGE` | 非 OFD/ZIP、缺 `OFD.xml`/`Document.xml`、`DocRoot`/`documentIndex` 非法、来源为空或使用已删除的 `url` 来源 |
| `OFD_ENTRY_NOT_FOUND` | ZIP 内条目缺失（页面/资源/字体/图片） |
| `OFD_UNSUPPORTED_COMPRESSION` | ZIP 压缩方法不支持 |
| `OFD_ENCRYPTED` | ZIP 加密条目、容器标记为加密或文档加密 |
| `OFD_XML_PARSE` | XML 格式错误且无法降级 |
| `OFD_PAGE_NOT_FOUND` | 页码越界 |
| `OFD_CANVAS_TOO_LARGE` | canvas 像素超过 `maxCanvasPixels`（render/export） |
| `OFD_CANVAS_SIZE_MISMATCH` | canvas/viewport 非法或 canvas 小于 viewport |
| `OFD_RENDERER_UNSUPPORTED` | 自定义 renderer 不支持、缺画布/编码器、格式不支持、编码失败/空结果 |
| `OFD_ABORTED` | `RenderTask.cancel()`/`AbortSignal` 中止 |
| `OFD_CLOSED` | 文档已关闭后继续调用 |
| `OFD_LIMIT_EXCEEDED` | 包/条目/解压/图片/递归等资源限制 |
| `OFD_FONT_PARSE` | 底层字体解析错误；公共流程通常降级为 `W_FONT_MISSING` |
| `OFD_IMAGE_DECODE` | 图片解码失败；多数渲染路径降级为 `W_IMAGE_DECODE`，不可降级场景抛出 |

`toOFDError` 只包装非 `OFDError`；已是 `OFDError` 时原样返回。

---

## 10. Warning

```ts
interface OFDWarning {
  code: WarningCode | string;
  message: string;
  pageIndex?: number;    // 从 0 开始
  objectId?: ResourceId;
  resourceId?: ResourceId;
}
```

- warning 不中断渲染；同一 `(code, pageIndex, objectId)` 只上报一次（文档级与页级相同 code+上下文也会去重）。
- `onWarning` 在产生 warning 的调用栈内同步执行，未提供时不打印；回调异常不会被隔离，可能中断当前操作或被包装为操作错误，宿主应自行 `try/catch`。
- `WarningCollector` 供宿主/测试收集 warning：`new WarningCollector(handler?)`、`warn(code, message, context?)`、`warnings`（去重后按首次出现顺序）、`clear()`。
- `WARNING_CODES` 是冻结数组，包含下列 20 个基础码；`WarningCode` 为对应联合类型。

| `code` | 含义 |
| --- | --- |
| `W_FONT_MISSING` | 缺少字体，或字体来源不可用/加载失败（如未提供 `data`、解析失败、超限）；使用回退/替代字体 |
| `W_GLYPH_MISSING` | 字体缺字形，跳过或使用 .notdef |
| `W_IMAGE_DECODE` | 图片无法解码/读取，跳过该图 |
| `W_UNSUPPORTED_PAINT` | 不支持/无法实现的填充，降级 |
| `W_UNSUPPORTED_CLIP` | 不支持/退化的裁剪，降级 |
| `W_BAD_NUMBER` | 数值/属性非法，使用默认/跳过 |
| `W_BAD_PATH` | 路径数据非法，跳过该段/对象 |
| `W_DUPLICATE_RESOURCE` | 资源 ID 重复，先到先得 |
| `W_COMPOSITE_DEPTH` | 复合对象递归超限，截断 |
| `W_PATTERN_LIMIT` | 底纹 tile/大小超限，降级 |
| `W_ZERO_BOUNDARY` | Boundary 为零/退化 |
| `W_PHYSICALBOX_ORIGIN` | PhysicalBox 原点非零，已归一化 |
| `W_IMAGE_NO_CTM` | 图片缺 CTM（配合 `strictImageCtm`） |
| `W_NEGATIVE_BOUNDARY` | Boundary 为负，已归一化 |
| `W_LAYER_ORDER` | 图层顺序非法，回退 |
| `W_BLEND_MODE` | 混合模式不支持，降级 |
| `W_RADIAL_UNSUPPORTED` | 径向渐变未实现，降级为平均色 |
| `W_GOURAUD_APPROX` | Gouraud/网格渐变近似 |
| `W_ANNOT_EMPTY` | 注释索引读取/解析失败，本页注释被跳过 |
| `W_JBIG2_DECODE` | JBIG2/TIFF 解码失败/超限，跳过 |

以下扩展码通过 `OFDWarning.code: string` 上报，不在冻结的 `WARNING_CODES` 中：

| `code` | 含义 |
| --- | --- |
| `W_OUTLINE_TARGET` | 大纲层级超限/目标无效/书签引用不存在，保留节点但省略 `dest` |
| `W_BOOKMARK_TARGET` | 书签目标无效，保留书签但省略 `dest` |
| `W_METADATA_FIELD` | DocInfo 日期非法或自定义字段缺名，跳过该字段 |
| `W_SIGNATURE_RESOURCE` | 声明了签章值但读取失败，`getSignedValue` 返回 `undefined` |
| `W_TEXT_ITEM_LIMIT` | 文本项达到 `maxTextItems`，停止加入后续项 |
| `W_TEXT_CHAR_LIMIT` | 下一个文本项会超过 `maxTextChars`，整项不加入 |
| `W_PERMISSION_FIELD` | Permissions 布尔字段非法，或 `Print.Copies` 为非整数/超出安全整数范围；按默认允许或不限回退（负数份数不 warning） |
| `W_ATTACHMENT_FIELD` | 附件 ID/Name/Visible/Size/FileLoc 等字段非法；按规则跳过或回退 |
| `W_ATTACHMENT_RESOURCE` | 附件索引加载失败、附件不存在、FileLoc 缺失或附件文件读取失败 |

---

## 11. 资源限制与缓存

### 11.1 `ResourceLimits`

| 字段 | 默认 | 单位 | 说明 |
| --- | --- | --- | --- |
| `maxPackageBytes` | 256 MiB | byte | 压缩包总大小 |
| `maxEntries` | 20,000 | 个 | ZIP 条目数 |
| `maxEntryBytes` | 64 MiB | byte | 单条目解压后大小 |
| `maxTotalUncompressedBytes` | 512 MiB | byte | 总解压大小 |
| `maxCompressionRatio` | 200 | 倍 | 单条目最大压缩比 |
| `maxXmlBytes` | 32 MiB | byte | 单个 XML 大小 |
| `maxFontBytes` | 64 MiB | byte | 单个字体大小 |
| `maxImagePixels` | 100,000,000 | 像素 | 单图解码像素 |
| `maxCanvasPixels` | 64,000,000 | 像素 | canvas 像素（render/export） |
| `maxRecursionDepth` | 16 | 层 | 复合对象/资源递归 |

### 11.2 `CacheOptions`

| 字段 | 默认 | 单位 | 说明 |
| --- | --- | --- | --- |
| `xmlBytes` | 16 MiB | byte | 解压后 XML 缓存 |
| `fontBytes` | 64 MiB | byte | 字体二进制缓存 |
| `imageBytes` | 64 MiB | byte | 解码图片缓存 |
| `glyphCount` | 20,000 | 条 | 字形轮廓缓存 |
| `pageModels` | 8 | 页 | 页面模型缓存 |
| `textPages` | 4 | 页 | 文本层 mm 布局缓存（`getTextContent`） |

约束：`limits`/`cache` 为浅合并，未提供字段使用默认值；超限通常抛 `OFD_LIMIT_EXCEEDED` 或降级 warning。生产环境不要随意调低或置零，部分字段的 0 会回退默认值而不是表示不限。

---

## 12. 单位、坐标与生命周期

- 页面/对象空间：**mm**；页面原点由 `PhysicalBox` 归一化。`PageInfo`、大纲/书签目标、签章戳记边界均为 **mm**。
- Viewport/画布/图片：**设备像素**；颜色 RGBA 0..255。
- 文本层：**px**，由 mm 布局按 `dpi/25.4` 换算；`TextContent.unit` 固定 `'px'`，y 向下。
- 附件：`AttachmentInfo.size` 为 **byte**；XML 的 `Size` 以 KB 声明，引擎按 ×1024 换算。
- 日期/签章时间：保留 OFD 原文，不做时区推断。
- 矩阵：2×3 列主序 `[a,b,c,d,e,f]`，`x' = a·x + c·y + e`，`y' = b·x + d·y + f`。
- 生命周期：`open → getPage/getPageInfos/getOutline/getBookmarks/getMetadata/getPermissions/getAttachments/getSignatureEntries → getViewport/prepare/render/exportImage/getTextContent → close`；`close` 后不可复用。
- 并发：同一 canvas 渲染串行；不同 canvas 可并行；同一页的 prepare/文本构建并发去重；`close` 中止进行中的渲染/导出/准备/文本任务。
- 画布尺寸与清屏由宿主处理，背景由 CSS 或宿主决定；`page.render` 不填白底。
- 当前边界：径向渐变降级、ICC/BlendMode 非完整支持、不提供局部/瓦片渲染、不做加密文档解密与签章密码学验证、不内置宿主适配器。

---

## 13. 公开类型附录

以下每个名字都出现在本节，与 `src/index.ts` 的当前导出一一对应。类型只列用途/关键字段，完整字段以源码为准。

### 13.1 类、函数与常量

| 名称 | 说明 |
| --- | --- |
| `OFDDocument` | 文档入口；`open/getPage/getPageInfos/getOutline/getBookmarks/getMetadata/getSignatureEntries/getSignedValue/getPermissions/getAttachments/getAttachmentData/close` |
| `OFDPage` | 页面入口；`getSize/getViewport/prepare/getTextContent/render/exportImage` |
| `RenderTask` | 渲染句柄；`id/promise/cancel` |
| `OFDEventBus` | 事件总线实现 |
| `H5Canvas2DRenderer` | 默认 Canvas 2D 渲染器 |
| `OFDError` | 统一错误类 |
| `isOFDError` | 类型守卫 |
| `toOFDError` | 包装为 `OFDError` |
| `WarningCollector` | warning 去重收集器 |
| `WARNING_CODES` | 冻结的基础 warning 码数组 |
| `getPageViewport` | mm 页尺寸 → 设备像素 |
| `getPageTransform` | mm → 设备矩阵 |
| `openZipVirtualContainer` | 构造默认 ZIP 虚拟容器 |
| `getVersion` | 返回引擎版本号（与 `VERSION` 相同） |
| `VERSION` | 引擎版本号常量 |
| `DEFAULT_DPI` | 96 |
| `MM_PER_INCH` | 25.4 |
| `DEFAULT_RESOURCE_LIMITS` | 默认资源限制常量 |
| `DEFAULT_CACHE_OPTIONS` | 默认缓存常量 |
| `KNOWN_ANNOTATION_TYPES` | 常见注释类型常量：`Link/Path/Highlight/Stamp/Watermark` |

### 13.2 API 类型与常量

| 名称 | 说明 |
| --- | --- |
| `OFDOpenOptions` | `open` 参数（默认 ZIP/容器工厂，`source` 必填） |
| `OFDOpenFromContainerOptions` | `open` 参数（纯容器，`container` 必填、`source` 可选上下文） |
| `OFDSource` | 文档来源联合类型 |
| `OFDDocumentInfo` | 文档最小视图（`version/pageCount/pageIds`；当前公共方法不返回） |
| `OFDPageSize` | `PageSize` 别名 |
| `OFDViewport` | `Viewport` 别名 |
| `PageSize` | `{width,height}`，mm |
| `Viewport` | `{width,height,dpi}`，px |
| `ViewportOptions` | `{dpi?}` |
| `PageRenderParameters` | `render` 参数 |
| `PageImageExportOptions` | `exportImage` 参数 |
| `PageImageResult` | `exportImage` 结果 |
| `PageContentFilter` | 页级内容过滤白名单；`render`/`exportImage`/`getTextContent` 的 `contentFilter` |
| `DrawLayerOptions` | 单个内容层的 `page`/`templates` 开关 |
| `KnownAnnotationType` | 常见注释类型字面量联合 |
| `AnnotationType` | 注释类型；常见类型 + 自定义字符串 |
| `PageImageFormat` | `'png'\|'jpeg'\|'webp'` |
| `PageImageMime` | 对应 MIME 联合 |
| `EncodeImage` | 编码钩子类型 |
| `CanvasImageEncodeSource` | 带可选编码入口的 canvas |
| `FontInput` | 宿主字体来源（`data`/`family`） |
| `ResourceLimits` | 资源限制 |
| `CacheOptions` | 缓存预算 |

### 13.3 平台接口

| 名称 | 说明 |
| --- | --- |
| `ByteSource` | 宿主提供的随机字节源（支持可选 `ready`/`close`） |
| `FontProvider` | 字体匹配接口（按需读取的唯一入口） |
| `FontMatchRequest` | 字体匹配请求 |
| `ImageDecoder` | 宿主图片解码器 |
| `ImageDecoderPlugin` | 图片解码插件 |

### 13.4 渲染器类型

| 名称 | 说明 |
| --- | --- |
| `Renderer` | 底层绘制接口 |
| `H5Canvas2DRendererOptions` | H5 渲染器选项 |
| `Canvas2DLike` | 最小画布 |
| `CanvasRenderingContext2DLike` | 最小 2D 上下文 |
| `CanvasGradientLike` | 渐变最小接口 |
| `CanvasPatternLike` | pattern 最小接口 |
| `CompositeMode` | 合成模式联合 |
| `GroupOptions` | 独立组参数 |

### 13.5 通用绘制/图像类型

| 名称 | 说明 |
| --- | --- |
| `Matrix` | 2×3 仿射矩阵 |
| `Point` | 二维点 |
| `Box` | 轴对齐矩形，mm |
| `Rgba` | RGBA 0..255 |
| `DrawStyle` | 线宽/端点/连接/虚线 |
| `FillRule` | `nonzero`/`evenodd` |
| `LineCap` | `Butt`/`Round`/`Square` |
| `LineJoin` | `Miter`/`Round`/`Bevel` |
| `PathCommand` | 路径命令联合 |
| `GradientStop` | 渐变停靠点 |
| `GradientMapType` | `Direct`/`Repeat`/`Reflect` |
| `GradientExtend` | 0..3 延伸方式 |
| `GradientSpec` | 渐变联合 |
| `AxialGradientSpec` | 轴向渐变 |
| `RadialGradientSpec` | 径向渐变（降级近似） |
| `MeshShadingPoint` | 网格渐变点 |
| `MeshShadingSpec` | 网格渐变描述 |
| `PatternReflect` | 底纹反射方式 |
| `PatternSpec` | 底纹描述 |
| `PatternPaint` | 底纹 Paint |
| `PaintSpec` | Paint 联合 |
| `ResolvedPaint` | 已解析 Paint |
| `ImageDataLike` | RGBA8 像素缓冲 |
| `ImageHandle` | 渲染器图像句柄 |
| `CanvasImageSourceLike` | 宿主可绘制图像对象 |
| `DecodedImage` | 解码后图片 |
| `DisplayList` | 显示列表 |
| `DrawCommand` | 显示列表命令 |
| `ResourceId` | 资源 ID 字符串 |

### 13.6 错误与 warning 类型

| 名称 | 说明 |
| --- | --- |
| `OFDErrorCode` | 错误码联合（§9 表） |
| `OFDErrorOptions` | `OFDError` 构造附加项（`cause`） |
| `OFDWarning` | 单条 warning 结构 |
| `WarningCode` | 冻结 warning 码联合（§10 表） |
| `WarningContext` | warning 上下文（页/对象/资源） |
| `WarningEmitter` | warning 上报接口 |
| `WarningHandler` | warning 回调类型 |

### 13.7 阅读器数据接口类型

| 名称 | 说明 |
| --- | --- |
| `OFDDocumentApi` | 文档数据接口形状（与 `OFDDocument` 声明合并） |
| `OFDPageApi` | 页面数据接口形状（与 `OFDPage` 声明合并） |
| `PageInfoOptions` | `getPageInfos` 参数（`start/count/signal`） |
| `PageInfo` | 页尺寸/页区域，mm |
| `DocumentPermissions` | 权限声明（只读，不做 DRM 强制） |
| `AttachmentInfo` | 附件元信息（`size` 单位 byte） |
| `DestinationType` | 大纲/书签目标类型 |
| `DocumentDestination` | 跳转目标，mm/zoom |
| `OutlineNode` | 大纲节点与子节点 |
| `BookmarkItem` | 书签条目 |
| `SignatureProvider` | 签章 Provider 元数据 |
| `SignatureReferenceInfo` | 签章保护范围引用 |
| `SignatureStampInfo` | 签章戳记位置，mm |
| `SignatureEntryInfo` | 签章 XML 条目元数据 |
| `SignedValueFile` | 签章值原始字节（`signatureId/path/data/byteLength`） |
| `DocumentMetadata` | 文档属性 |
| `PagePrepareOptions` | `page.prepare` 参数 |
| `TextContent` | 页面文本层，px |
| `TextContentOptions` | `getTextContent` 参数 |
| `TextItem` | 单个 TextObject 的文本项 |
| `TextChar` | 单个 Unicode 码点的字符项 |
| `TextFontInfo` | 文本项字体元信息 |
| `TextUnit` | 文本坐标单位（`px`） |
| `TextLayer` | 文本项所在层 |
| `TextPoint` | 二维点，px |
| `TextQuad` | 字符单元四边形，px |
| `TextRect` | 轴对齐矩形，px |

### 13.8 虚拟容器

| 名称 | 说明 |
| --- | --- |
| `VirtualContainer` | 只读虚拟容器；`packageSize/encrypted/list/has/stat/read/close`。`encrypted=false` 为明文容器（可注入 engine）；`encrypted=true` 为原始包容器，`read` 返回存仓字节，只能用于检查/解密 |
| `VirtualFileMeta` | 包内文件元数据（`path/size/compressedSize/compression/origin`） |
| `VirtualReadOptions` | `read` 选项（`maxBytes/signal/onWarning/verifyChecksum`，校验默认 `true`） |
| `VirtualContainerFactory` | `(source: OFDSource) => Promise<VirtualContainer>`，容器归 engine 所有 |
| `OpenZipVirtualContainerOptions` | 默认 ZIP 容器构造选项（`limits`，仅 ZIP 相关字段生效） |

### 13.9 事件系统类型与类

| 名称 | 说明 |
| --- | --- |
| `OFDEventBusOptions` | 总线选项（`onListenerError`） |
| `OFDEventName` | 14 个事件名的联合 |
| `OFDEventMap` | 事件名 → 载荷的映射 |
| `OFDEventHandler` | 指定事件名的监听器类型 |
| `OFDEventBase` | 公共字段（`type/timestamp/sequence`） |
| `OFDOperationEventBase` | 带 `operationId` 的事件基类 |
| `OFDPageOperationEventBase` | 带 `pageIndex` 的页面操作事件基类 |
| `OFDPageEventName` | 页面事件名联合（`page:load:*`/`page:render:*`） |
| `OFDPageEventMap` | 页面事件名 → 载荷的映射 |
| `OFDAddEventListenerOptions` | `addEventListener` 选项（`once`/`signal`） |
| `OFDAbortCause` | 取消来源：`'caller'` / `'close'` |
| `DocumentOpenStartEvent` | `document:open:start`：`sourceKind/documentIndex/viaContainer` |
| `DocumentOpenEndEvent` | `document:open:end`：`pageCount/version/packageSize/durationMs` |
| `DocumentOpenErrorEvent` | `document:open:error`：`error/durationMs` |
| `DocumentOpenAbortEvent` | `document:open:abort`：`cause:'caller'/reason?/durationMs` |
| `DocumentCloseStartEvent` | `document:close:start`：`operationId` |
| `DocumentCloseEndEvent` | `document:close:end`：`durationMs/abortedOperations` |
| `PageLoadStartEvent` | `page:load:start`：`pageIndex` |
| `PageLoadEndEvent` | `page:load:end`：`pageIndex/widthMm/heightMm/durationMs` |
| `PageLoadErrorEvent` | `page:load:error`：`pageIndex/error/durationMs` |
| `PageLoadAbortEvent` | `page:load:abort`：`pageIndex/cause/reason?/durationMs` |
| `PageRenderStartEvent` | `page:render:start`：`pageIndex/dpi/width/height` |
| `PageRenderEndEvent` | `page:render:end`：`pageIndex/durationMs` |
| `PageRenderErrorEvent` | `page:render:error`：`pageIndex/error/durationMs` |
| `PageRenderAbortEvent` | `page:render:abort`：`pageIndex/cause/reason?/durationMs` |