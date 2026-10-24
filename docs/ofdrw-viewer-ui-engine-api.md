# @ofdrw/ofdrw-viewer-ui 使用的引擎 API 设计

本文说明 `@ofdrw/ofdrw-viewer-ui` 当前依赖的 `@ofdrw/ofdrw-viewer-engine` 公共接口、职责边界、错误与返回约定、性能约束，以及已经确定的契约决策。具体签名、字段、默认值和完整类型表以 [引擎 API](../packages/ofdrw-viewer-engine/skills/API.md) 为准；UI 侧如何组织阅读器见 [UI 设计方案](./ofdrw-viewer-ui设计方案.md)。本文不复制引擎 API 的参数表。

## 职责与边界

### 引擎负责什么

- 打开 OFD 明文包，读取 ZIP 条目并解析 `OFD.xml`、`Document.xml`、`Page.xml`、`Signatures.xml`、`Signature.xml` 等结构。
- 返回页数、页尺寸、大纲、书签、文档属性、权限、附件索引和签章 XML 摘要。
- 按页返回文本内容；按需准备页面模型；在宿主提供的 canvas 上绘制页面。
- 按页导出 PNG/JPEG/WebP，支持导出方向和背景参数。

### 引擎不负责什么

- 不发起网络请求，不读取本地路径，不实现 HTTP Range、Cookie、鉴权、重试或下载进度。URL 和本地文件必须先由宿主或 UI 转成字节。
- 不解析 `SignedValue.dat` 的 ASN.1/CMS/SES 结构，不解析 X.509、证书链、CRL/OCSP 或时间戳，不判断签名有效性。
- 不把 `Seal.esl`、证书、印章名称或签名结果作为公开 API 返回；签章外观渲染可以内部读取资源，但签章语义归 crypto。
- 不实现阅读器布局、缩放、旋转、打印编排、权限强制或 UI 状态。

### 签章数据分工

```text
engine: Signatures.xml/Signature.xml 元数据 + SignedValue.dat 原始字节
   │
   ▼
crypto: SES v1/v4/v5、印章、证书链、签名值、完整性、时间戳解析
   │
   ▼
UI: 摘要、详情、页面覆盖层、验证面板；只展示结构化结果
```

引擎只返回原始字节，UI 不维护第二套 ASN.1 解析器；签章的数学与信任判断完全由 crypto 完成。`getSignedValue()` 返回的 `SignedValueFile` 含签名 ID、包内路径和字节，调用方拥有字节副本，引擎不解释内容。

## 打开、来源与容器

### 两种打开方式

`OFDDocument.open()` 接受两类参数：

- `OFDOpenOptions`：`source` 必填，使用默认 ZIP 容器或可选的 `containerFactory`；工厂返回的容器归引擎所有。
- `OFDOpenFromContainerOptions`：`container` 必填，`source` 只作为宿主上下文；引擎借用容器，不关闭。

`container` 与 `containerFactory` 互斥。未提供容器时，引擎创建并拥有默认 ZIP 容器，`close()` 时关闭；借用容器在 `doc.close()` 后只清引用，宿主负责关闭；工厂容器由引擎关闭。容器必须满足 `encrypted=false` 且 `read()` 返回明文；未解密包会得到 `OFD_ENCRYPTED`，应先交给 crypto 解密。

### 来源类型

引擎只接受三种 `OFDSource`：

- `{ kind: 'arraybuffer', data }`：内存字节；
- `{ kind: 'blob', blob }`：浏览器 `Blob`/`File`；
- `{ kind: 'custom', source }`：实现 `ByteSource` 的随机读取源。

URL 不是引擎来源。UI 的 `ViewerSource` 接受 URL 字符串、`{ url, headers }`、`ArrayBuffer`、`Uint8Array` 和 `Blob/File`；URL 在 UI 内转为 `HttpByteSource`，再以 `custom` 来源交给引擎。这样 engine 不依赖 `fetch`，crypto 与 engine 可以共享同一个字节源，避免重复探测和下载。

### 生命周期与取消

- 打开成功前派发 `document:open:start`，成功后 `document:open:end`；失败为 `document:open:error`，调用方取消为 `document:open:abort(cause='caller')`。
- 打开参数校验失败（缺来源、容器冲突等）不派发事件。
- `document.close()` 幂等；先派发 `document:close:start`，中止进行中的渲染、导出、取页、准备、文本和签章读取，再关闭自有容器并释放缓存，最后派发 `document:close:end`。
- 取消、关闭后的错误语义和共享构建约定见下文“通用约定”。

UI 的控制器在打开新文档前关闭旧文档，并缓存页信息、大纲、书签、元数据、权限和签章摘要；页面句柄按页缓存，避免重复 `getPage()`。

## 通用约定

- **坐标与单位**：页面尺寸、目标 `dest`、签章 `Boundary/Clip` 为毫米；viewport、canvas 和导出图片为设备像素；文本层为 px，原点在页面 `PhysicalBox` 左上角、y 向下；附件大小为 byte；日期保留 OFD 原文。各节只写该 API 的特殊差异。
- **缓存与失效**：页信息、大纲、书签、元数据、权限和签章摘要按文档缓存到 `close()`；页面模型默认缓存 8 页、文本布局默认缓存 4 页，按预算回收；同一页同一 DPI 的 prepare/render 复用结果；关闭后全部失效，页面句柄不跨文档复用。UI 自身的页/缩略图缓存见 [UI 设计方案](./ofdrw-viewer-ui设计方案.md)。
- **取消与关闭**：异步入口接受 `AbortSignal`；调用方取消抛 `OFD_ABORTED`，关闭后调用抛 `OFD_CLOSED`；`close()` 幂等并等待活动操作结束；单个调用方取消只结束本次等待，不会中止仍被其他方等待的共享页面加载/文本构建。
- **空值与同步/异步**：无内容的列表返回空数组；未声明的可选资源返回 `undefined`；非法参数/索引、资源超限、包损坏抛错。`open()`/`getPage()` 返回 Promise，`page.render()` 返回 `RenderTask`；事件和 warning 同步派发，事件派发前快照监听器。
- **签名与字段**：字段、默认值和完整签名以 [引擎 API](../packages/ofdrw-viewer-engine/skills/API.md) 为准，打开/关闭时序见 [引擎生命周期与事件设计](./OFD渲染引擎生命周期与事件设计.md)；签章原始字节和验证语义见 [crypto API](../packages/ofdrw-viewer-crypto/skills/API.md)。

## 页尺寸与页面句柄

### `getPageInfos`

UI 打开文档后先调用 `getPageInfos()`，一次拿到全部页尺寸，用于建立滚动页盒和总高度。该接口：

- 返回连续的 `PageInfo`，含 `index`、`widthMm`、`heightMm`，可选 `xMm`/`yMm` 和尺寸来源；
- 复用与 `page.getSize()` 相同的“页 → 模板页 → `CommonData/PageArea` → A4”回退链；
- 不构建显示列表、不解码字体/图片、不创建 canvas；
- 结果按页缓存到关闭；单页缺失或损坏只 warning，并回退到可用尺寸；
- `start`/`count` 越界返回空数组；取消抛 `OFD_ABORTED`，关闭抛 `OFD_CLOSED`。

`PageInfo` 的单位和坐标约定见“通用约定”。UI 的页盒、页间距和总高度都由它计算，不从 canvas 像素反推。

### `getPage` 与 `OFDPage`

`getPage(index, options?)` 使用 0-based 页索引，`options.signal` 可取消读取；非法索引抛 `OFD_PAGE_NOT_FOUND`。页面句柄提供：

- `getSize()`：毫米尺寸；
- `getViewport({ dpi })`：设备像素宽高，纯计算；
- `render()`、`exportImage()`、`prepare()`、`getTextContent()`；
- 页面事件订阅。

`document.pageCount` 在打开成功后固定，等于文档页树声明的页数；`getViewport()` 默认 96 DPI，非有限或非正 DPI 回退 96，宽高保留 0.001 px 精度，不加载字体/图片。UI 只在需要渲染、导出、文本抽取或准备时取页面；打开文档和建立页盒阶段不逐页取页面。页尺寸已由 `getPageInfos()` 缓存，缩放和布局不重新读 XML。

## 渲染与图片导出

### `page.render`

UI 负责创建 canvas、按目标 DPI 计算像素尺寸、设置 canvas 宽高和上下文；引擎只绘制页面内容。绘制参数包含 `canvasContext`、`viewport` 和可选 `signal`。

引擎的约束：

- 不设置 canvas 尺寸、不清屏、不填背景；canvas 和 context 必须有效，canvas 像素不得小于 viewport。
- 以页面矩阵覆盖上下文的预置 CTM；页面内容之外的阅读器背景、阴影和 UI 由 CSS/宿主负责。
- 同一 canvas 的渲染串行排队，不同 canvas 可并行；同一页已有相同 DPI 的准备结果时复用。
- 入口校验失败同步返回已拒绝的任务（`id=0`），不派发事件；通过后同步派发 `page:render:start`，结束、失败、取消分别派发 `page:render:end`、`error`、`abort`。
- `signal` 与 `RenderTask.cancel()` 合并；取消以 `OFD_ABORTED` 拒绝，`cause` 保留取消原因。

UI 的渲染调度器按可见页调度顺序、页代次和并发上限调用 `page.render()`；取消后丢弃旧代次结果，不把 `OFD_ABORTED` 当作页面失败。

### `page.exportImage`

打印和图片导出使用独立的离屏画布，不经过宿主主 canvas，也不包含阅读器缩放。调用方可指定：

- `dpi`：默认 96，非有限或非正数回退 96；
- `format`：`png`、`jpeg`、`webp`，默认 PNG；
- `quality`：JPEG/WebP 默认 0.92，夹取到 0..1，PNG 忽略；
- `rotation`：0/90/180/270，默认 0，只改导出方向，90/270 交换输出宽高；非法值回退 0 并产生 `W_BAD_NUMBER`；
- `background`：默认白底，PNG 可用 `null` 得到透明，JPEG/WebP 的 `null` 按白底；
- `signal`：取消后以 `OFD_ABORTED` 拒绝。

返回 `PageImageResult`，包含编码后的字节、MIME、输出宽高和实际 DPI。输出像素超过 `maxCanvasPixels` 抛 `OFD_CANVAS_TOO_LARGE`；画布尺寸不符抛 `OFD_CANVAS_SIZE_MISMATCH`；编码器缺失或编码失败抛 `OFD_RENDERER_UNSUPPORTED`。

引擎不会因为文档权限声明 `export=false` 而拒绝导出；UI 在调用前检查权限并禁用入口，但这只是产品层约束，不是 DRM。

### `page.prepare`

`prepare()` 预取页面模型、字体和图片，固定以 96 DPI 准备并缓存，不创建 canvas、不绘制；重复调用复用已有准备，取消只影响本次等待。UI 的控制器提供 `preparePage()`，但当前主阅读流程不主动调用它；可见页渲染仍是主要路径。

## 文本、导航与文档数据

### `getTextContent`

文本层 API 返回页面可读文本的 `px` 坐标；原点和单位见“通用约定”。关键约定：

- `dpi` 默认 96，非法值回退 96；文本布局按 mm 缓存，缓存键不含 DPI，因此 96/144/300 DPI 共用布局，只做线性换算。
- 默认返回字符级 `chars`，默认不包含注释 Appearance 和不可见文字；可由 `includeChars`、`includeAnnotations`、`includeInvisible` 调整。
- `maxTextItems` 默认 20,000，`maxTextChars` 默认 500,000；超限截断并发 `W_TEXT_ITEM_LIMIT`/`W_TEXT_CHAR_LIMIT`，不抛错。
- 空页返回空数组；缺字体、缺字形产生 warning 并跳过对应文本项。
- 不调用 Canvas 文字 API，可在 Worker/Node 运行；同一页并发共享构建。
- 取消 `OFD_ABORTED`，关闭 `OFD_CLOSED`；缺 text driver 的宿主页面为 `OFD_RENDERER_UNSUPPORTED`。

UI 只对可见页和相邻预取页构建透明文本层；按 96 DPI 坐标定位，用 CSS 缩放和容器旋转，不重复抽取文本。

### 大纲与书签

`getOutline()` 和 `getBookmarks()` 在打开阶段解析并缓存，不加载页面内容：

- 大纲保持 XML 层级和顺序，深度上限 64；无效目标保留节点、省略 `dest` 并产生 `W_OUTLINE_TARGET`；无大纲返回空数组。
- 书签保持 XML 顺序；缺少名称或目标无效时跳过/保留并按规则产生 `W_BOOKMARK_TARGET`；无书签返回空数组。
- `dest` 的页索引为 0-based；坐标单位见“通用约定”，UI 负责合法性校验、当前页高亮、树展开和跳转，不修改目标数据。

### 元数据、权限与附件

- `getMetadata()` 返回 OFD 版本、页数和 DocInfo；日期保留原文，不推断时区；无 DocInfo 仍有版本和页数。
- 元数据新增 5 个可选字段，全部在 `open()` 阶段解析，`getMetadata()` 只读内存缓存、不额外读取包内条目；缺失时省略 key，不放入 `undefined`：
  - `docUsage`：文档用途（DocInfo/DocUsage）。
  - `docType`：`OFD.xml` 的 `OFD@DocType`（例如 `OFD`/`Render`/`None`）。
  - `documentHeader`（`DocumentHeader`）：`docId`、`version`、`maxUnitId`、`pageArea`、`publicRes`/`documentRes`/`templatePageRes`（`readonly string[]`，包内路径列表）、`defaultCs`、`docUsage`。
  - `packageInfo`（`OfdPackageInfo`）：`docRoot`、`docBodyCount`，可选 `maxUnitId`。
  - `commonData`（`CommonDataSummary`）：`pageArea`、`defaultColorSpaceId`、`documentVersion`、`dataDir`。
  - 几何字段统一用 `Box`（mm），与 `PageInfo` 一致；非法数值/路径省略并产生 `W_METADATA_FIELD`，不阻断打开。
- `getPermissions()` 只读 `Document.xml/Permissions`：布尔权限缺省允许，`print.copies=0` 表示不允许打印，负数按不限，非法字段回退并产生 `W_PERMISSION_FIELD`。引擎不做 DRM 强制。
- 附件接口：`getAttachments()` 读 `Attachments.xml` 索引（无索引返回 `[]`，不 warning），`getAttachmentByName()`/`getAttachmentsByFormat()` 复用该缓存做查询，`getAttachmentSize()` 只返回 XML 声明的 byte 大小而不读内容，`saveAttachment(id, sink, opts)` 以回调式分块交出字节（引擎内部整块读取后按 `chunkSize` 切分，不是流式 I/O；chunk 为 `subarray` 视图，保留须拷贝），`getAttachmentData(id)` 返回整块字节（保留给旧调用方）。
- `AttachmentInfo` 除 `id`/`name` 外，可选 `format`、`size`（byte）、`creationDate`、`modDate`、`visible`、`usage`，以及新增的 `contentType`（MIME）、`description`、`submissionDate`、`isEncrypted`。
- 单附件大小上限取 `limits.maxAttachmentBytes`，未配置时回退 `maxEntryBytes`；声明大小或实际字节超限抛 `OFD_LIMIT_EXCEEDED` 且不返回部分数据，UI 需按普通读取失败处理。
- 附件不可用（无索引/ID 不存在/缺 `FileLoc`/文件缺失）时 `saveAttachment` 上报 `W_ATTACHMENT_RESOURCE` 并返回 `0`，`getAttachmentData`/`getAttachmentSize` 返回 `undefined`；`sink` 抛错原样上抛，已写字节不回滚。

UI 的消费方式：

- `getDocumentInfo()` 一次性并发聚合 `getMetadata()`/`getPermissions()`/`getAttachments()`/`getSignatureEntries()`/`getOutline()`/`getBookmarks()`，结果不写入 `ViewerState`；属性对话框与附件侧栏从该快照读取新字段与附件列表。
- 附件侧栏只在引擎实现 `saveAttachment()` 且文档确有附件时出现；下载用 `saveAttachment()` 分块收集，大附件（声明大小超过 500 MB / 524288000 byte）不读内容，改为提示下载整个 OFD 原文件（走 UI 的 `readSourceBytes()`，与 `export` 门控一致）。
- UI 不解析附件内容，附件从不进入 DOM，未知格式只提供下载。

### 签章数据

`getSignatureEntries()` 只读取 `Signatures.xml` / `Signature.xml` 元数据，返回 `id`、`type`、`baseLoc`、`references`、`stamps`、`hasSignedValue` 等字段；不读取印章图片、不解析签名值、不验签。无签章索引返回空数组；索引或单条 XML 损坏时产生 warning 并跳过，重复 ID 先到先得。

`getSignedValue(signatureId)` 返回 `SignedValueFile | undefined`：

- 未声明签章值、ID 不存在或未声明路径时返回 `undefined`，不 warning；
- 已声明但读取失败产生 `W_SIGNATURE_RESOURCE` 并返回 `undefined`；
- 资源限制、包损坏等不可降级错误原样抛出；返回字节归调用方，引擎不保留引用。

UI 将字节交给 crypto；只有 `Seal.esl`、没有 `SignedValue.dat` 时，UI 只能显示“签章信息不完整”，不回退读取引擎内部资源。

## 事件与操作归属

引擎事件通过 `document.events`（`OFDEventBus`）和文档/页面订阅方法暴露。当前共有 14 个事件：`document:open:start/end/error/abort`、`document:close:start/end`、`page:load:start/end/error/abort`、`page:render:start/end/error/abort`。事件名、载荷字段和完整时序以 [引擎 API 事件订阅](../packages/ofdrw-viewer-engine/skills/API.md#315-documentevents-与事件订阅) 和 [引擎生命周期与事件设计](./OFD渲染引擎生命周期与事件设计.md) 为准。

UI 需要遵守的归属规则：

- 文档事件需要在 `OFDDocument.open()` 前注入 `eventBus` 才能观察打开过程；UI 在打开参数中注入总线，因此能接收 `document:open:start` 并在 150 ms 后显示全屏 loading。
- 页面事件按 `pageIndex` 过滤；`page:load:*` 发生在页面句柄创建前，通常从文档总线观察。
- 事件同步派发，派发前快照监听器；单个监听器异常被隔离，未配置 `onListenerError` 时静默。`sequence` 单调递增，`operationId` 在同一文档内唯一。
- `page:render:start` 在 `render()` 返回前派发，`end` 在 `task.promise` resolve 前派发，`abort` 区分调用方取消和关闭；UI 用 `operationId` 和渲染用途关联主页面/缩略图，避免缩略图事件关闭主页面 loading。
- 入口校验失败不派发事件；`open` 和 `page.render` 的预取消仍派发 `start → abort`，`getPage` 的预取消不派发事件。

## 错误、warning 与返回约定

### 错误

引擎错误统一为 `OFDError`，`code` 用于分支，`message` 用于诊断，`cause` 保留原始错误。UI 直接相关的错误：

| 错误码 | 触发场景 | UI 处理 |
| --- | --- | --- |
| `OFD_INVALID_PACKAGE` | 非 OFD/ZIP、缺 XML、来源为空或非法 | 打开失败/错误卡 |
| `OFD_ENCRYPTED` | 未解密容器或加密包直接打开 | 交给 crypto 或报密码能力不可用 |
| `OFD_PAGE_NOT_FOUND` | 页索引越界 | 页面/导出参数错误 |
| `OFD_CANVAS_TOO_LARGE` | canvas 像素超过引擎上限 | 页面渲染或导出失败 |
| `OFD_LIMIT_EXCEEDED` | 包/条目/解压/图片等超限 | 打开或读取失败 |
| `OFD_ABORTED` | 渲染/读取/导出取消 | 静默取消，不显示错误 |
| `OFD_CLOSED` | 关闭后继续读写 | 视为生命周期错误 |
| `OFD_NOT_OPENED` | 文档从未成功打开时请求文档级信息（区别于已打开后被关闭的 `OFD_CLOSED`） | UI `getDocumentInfo()` 抛出；视为未打开状态，不显示错误卡 |
| `OFD_RENDERER_UNSUPPORTED` | 缺少渲染器/编码器或格式不支持 | 功能不可用或输出失败 |

完整错误码与抛出位置见 [引擎 API 错误](../packages/ofdrw-viewer-engine/skills/API.md#9-错误)。UI 需要区分以下三类 code：

- Promise 的异常码：`open()`/`getPage()`/`render()` 等保留底层 `OFDError`（如 `OFD_INVALID_PACKAGE`、`OFD_ABORTED`）；`open()` 只把 `OFD_ENCRYPTED` 映射为 `OFD_CRYPTO_UNSUPPORTED`（crypto 关闭）或 `OFD_CRYPTO_FAILED`（crypto 启用），其他错误不包装。UI 自身服务抛 `OFDViewerError`，真实 code 见 `errors.ts`，包括 `OFD_EXPORT_FAILED`、`OFD_PRINT_FAILED`、`OFD_SIGNATURE_PARSE_FAILED` 和 `OFD_CRYPTO_*`；这些才是 catch 可分支的异常码。
- RenderQueue 任务错误的事件码：`onTaskError` 直接上报固定 `OFD_RENDER_FAILED`，不因底层错误有 code 而改写，底层错误放在 `cause`。
- `toErrorInfo()` 路径（打开失败、页面错误卡）：优先取底层字符串 `cause.code`；底层没有字符串 code 时，打开失败用兜底 `OFD_OPEN_FAILED`，页面错误卡用兜底 `OFD_RENDER_FAILED`。`OFD_OPEN_FAILED`/`OFD_RENDER_FAILED` 不属于 `ViewerErrorCode`，不是 Promise reject code，不能当作异常码捕获。若希望 RenderQueue 事件也统一保留底层 code，应先改 RenderQueue 并补测试，不能先写成文档行为。

### warning

warning 不中断操作，通过打开参数 `onWarning` 同步回调；同一 `(code, pageIndex, objectId)` 去重。UI 将其转换为 `warning` 事件，不写成页面错误。常见来源包括缺字体/字形、图片解码、XML/字段降级、大纲/书签目标无效、文本截断、权限字段非法和签章资源读取失败。

`onWarning` 在产生 warning 的调用栈内同步执行，不在事件总线的监听器隔离范围内：宿主回调抛错会沿 warning 调用栈传播，可能使当前打开/读取失败，UI 不隔离该异常。若要保证隔离，必须在 UI 的 warning 转发处 try/catch 并另行记录。

### 空值与抛错

- 无大纲、无书签、无签章索引：返回空数组，不报错。
- 合法但无内容的页范围：返回空数组。
- 无附件索引：`getAttachments()` 返回 `[]`，`getAttachmentData(id)` 返回 `undefined`，都不产生 warning。
- 附件索引已声明但 ID 不存在、条目缺少 `FileLoc`、附件文件缺失或读取失败：`getAttachmentData(id)` 返回 `undefined`、`saveAttachment()` 返回 `0`，并产生 `W_ATTACHMENT_RESOURCE`；资源超限、包损坏等不可降级错误仍抛 `OFDError`，不能降级为 `undefined`。
- 声明大小超过引擎单附件上限（`limits.maxAttachmentBytes`，未配置回退 `maxEntryBytes`，默认 64 MiB）时 `getAttachmentData`/`saveAttachment`/`getAttachmentSize` 均抛 `OFD_LIMIT_EXCEEDED`（`getAttachmentSize` 只查元数据也不例外）；UI 在大附件阈值（500 MB = 524288000 byte）处已提前拦截，此错误通常只出现在宿主自行调用附件接口的路径。
- 未声明或缺失的签章值返回 `undefined`；已声明但读取失败产生 `W_SIGNATURE_RESOURCE`。
- 非法页索引、非法参数、资源超限、关闭后调用：抛 `OFDError`。
- 取消：抛 `OFD_ABORTED`，不是正常空结果。

## 性能与缓存

- `getPageInfos()` 对 1000 页文档的引擎基线是冷启动小于 300 ms、缓存命中小于 50 ms（本地 ZIP、参考机）；结果缓存到关闭。
- 页面模型默认缓存 8 页，文本布局默认缓存 4 页，XML/字体/图片/字形各有独立字节或条目预算；`limits`/`cache` 为浅合并，生产环境不应随意调低。
- 页面渲染成本由 UI 的 DPI 和 canvas 像素决定；引擎只校验 canvas 是否超过 `maxCanvasPixels`，不负责 UI 的并发和缓存。
- 同一 canvas 串行、跨 canvas 并行；UI 额外限制桌面并发 2、移动并发 1，并只保留可见页和相邻预取页。
- 文本按 mm 布局缓存，DPI 变化不重复布局；UI 的查找按时间片扫描，避免长任务阻塞滚动。

UI 侧的页信息、文本、渲染、导出和签章读取断言由 `test/integration`、`test/e2e` 覆盖；跨模块测试矩阵见 [测试方案](./测试方案.md)。

## 当前契约缺口

- 引擎没有 `renderRegion`/瓦片渲染接口；大页面缩放仍按整页 canvas 渲染，UI 不依赖瓦片或局部重绘，改用 DPI 上限和页面缓存控制内存。
- 引擎没有“下载某个附件或打包导出附件”的接口：单附件只能经 `saveAttachment()`（分块回调）/`getAttachmentData()`（整块）取出字节，ZIP 打包由 UI 复用自身的 `createStoreZip()`（fflate store 模式，不新增依赖）；“下载整个 OFD 原文件”走 UI 的 `readSourceBytes()`，不经过引擎。
- `getPageInfos()` 一次返回全部页尺寸；当前没有分页/流式页信息接口，1000 页依赖该批量结果建立页盒。