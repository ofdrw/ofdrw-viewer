# @ofdrw/ofdrw-viewer-engine 公开 API

> 使用说明与示例：`SKILL.md`（同目录）
> 版本：v1.1（契约 r12）
> 更新：2026-10-23
> 状态：v1 稳定接口；P0/P1/P2、r11 字体加载器与 r12 页面级事件系统已收录；`page.renderRegion` 暂不实现/不导出
> 适用包：`@ofdrw/ofdrw-viewer-engine`（npm 作用域 `@ofdrw`）
> 公共入口：`packages/ofdrw-viewer-engine/src/index.ts`
> 设计依据：`docs/OFD渲染引擎设计方案.md` §15
> 内部契约：`docs/CONTRACTS.md`（模块间接口，不是调用方文档）
> 文本层设计：`docs/text-content-api.md`（v1.1，已实现）
> 回归口径：`docs/测试方案.md`、`docs/回归报告.md`

本文档面向**调用方/其它模块**，说明每个公开类、函数、参数、返回值、约束与常见错误。内部模块（`container/model/resource/style/render`）不直接从包根导出，不属于本文档的调用面。

---

## 0. 同步与更新规则

公开 API 的唯一权威来源是 `src/index.ts` 的导出面。任何公共导出、签名、默认值、错误语义变化，必须按以下顺序同步：

1. 修改 `src/index.ts` 及其类型/实现；
2. 更新 `docs/CONTRACTS.md`（若涉及跨模块契约）与 `docs/OFD渲染引擎设计方案.md` §15；
3. 更新本文档对应章节、附录导出表、版本号与「变更记录」；
4. 运行 `pnpm -C packages/ofdrw-viewer-engine run typecheck`、`pnpm -C packages/ofdrw-viewer-engine exec vitest run test/smoke`、`pnpm -C packages/ofdrw-viewer-engine run build`；
5. 提交信息必须同时包含代码与文档，禁止只改代码不改文档。

同步检查：`test/smoke/public-api-doc.test.ts` 会读取 `src/index.ts` 的全部导出名，并断言每个名字都出现在本文档附录中；新增导出未补文档时 smoke 失败。

**不在本文档范围**：阅读器 UI 布局/交互、缩放/旋转/打印筛选、签章密码学验证（ASN.1/证书/验签）、Node/微信宿主适配器；`page.renderRegion` 按用户决定暂不实现/无排期。

---

## 1. 快速开始

### 1.1 Web（默认 H5 渲染器）

```ts
import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';

const doc = await OFDDocument.open({
  source: { kind: 'arraybuffer', data: await file.arrayBuffer() },
  onWarning: (w) => console.warn(w.code, w.message),
});

try {
  const page = await doc.getPage(0);
  const viewport = page.getViewport({ dpi: 144 });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d')!;

  await page.render({ canvasContext: ctx, viewport }).promise;
} finally {
  await doc.close();
}
```

### 1.2 导出图片（Web）

```ts
const page = await doc.getPage(0);
const png = await page.exportImage({ dpi: 144 });
// png.data 是 Uint8Array，可直接下载/上传
const jpeg = await page.exportImage({ format: 'jpeg', quality: 0.9 });
const transparent = await page.exportImage({ format: 'png', background: null });
```

### 1.3 Node / 自定义 Canvas

```ts
import { createCanvas } from '@napi-rs/canvas'; // 宿主依赖，engine 不内置
import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';

const doc = await OFDDocument.open({
  source: { kind: 'node-file', path: 'sample.ofd' }, // 本版本仅保留类型；见 §3.1
  createCanvas: (w, h) => createCanvas(w, h),
  encodeImage: async (canvas, format, quality) => {
    // 宿主自行编码；返回非空 Uint8Array
    return canvas.toBuffer(format === 'jpeg' ? 'image/jpeg' : 'image/png');
  },
});
```

Node/小程序没有浏览器 `document`/`OffscreenCanvas` 时必须注入 `createCanvas`；使用 `page.exportImage` 时还必须注入 `encodeImage`。

---

## 2. API 总览

| 入口 | 类型 | 用途 |
| --- | --- | --- |
| `OFDDocument.open(options)` | `Promise<OFDDocument>` | 打开 OFD 包，只读页树/资源索引 |
| `document.pageCount` | `number` | 页数，打开后固定 |
| `document.getPage(index)` | `Promise<OFDPage>` | 按需加载指定页 |
| `document.getPageInfos(options?)` | `Promise<readonly PageInfo[]>` | 批量页尺寸/页区域（P0） |
| `document.getOutline(options?)` | `Promise<readonly OutlineNode[]>` | 大纲树（P0） |
| `document.getBookmarks(options?)` | `Promise<readonly BookmarkItem[]>` | 书签列表（P0） |
| `document.getMetadata(options?)` | `Promise<DocumentMetadata>` | 文档属性（P1） |
| `document.getSignatureEntries(options?)` | `Promise<readonly SignatureEntryInfo[]>` | 签章 XML 元数据（P0） |
| `document.getSignedValue(id, options?)` | `Promise<SignedValueFile \| undefined>` | SignedValue.dat 原始字节（P0） |
| `document.getPermissions(options?)` | `Promise<DocumentPermissions>` | 权限声明，只读不强制（P2） |
| `document.getAttachments(options?)` | `Promise<readonly AttachmentInfo[]>` | 附件元信息（P2） |
| `document.getAttachmentData(id, options?)` | `Promise<Uint8Array \| undefined>` | 附件原始字节（P2） |
| `document.close()` | `Promise<void>` | 关闭并释放缓存/句柄，幂等 |
| `page.getSize()` | `PageSize` | 页尺寸，单位 mm |
| `page.getViewport(options?)` | `Viewport` | 指定 DPI 的设备像素尺寸 |
| `page.prepare(options?)` | `Promise<void>` | 预取页面资源，不绘制（P1） |
| `page.getTextContent(options?)` | `Promise<TextContent>` | 阅读器文本层，px（P0） |
| `page.render(params)` | `RenderTask` | 绘制到宿主 canvas context |
| `page.exportImage(options?)` | `Promise<PageImageResult>` | 整页离屏编码导出，可旋转 |
| `page.renderRegion(...)` | — | **暂不实现/无排期，未导出** |
| `RenderTask.promise` | `Promise<void>` | 渲染完成/失败/取消 |
| `RenderTask.cancel()` | `void` | 请求取消，可重复调用 |
| `RenderTask.id` | `number` | 渲染操作 ID，与 `page:render:*` 事件 `operationId` 相同 |
| `OFDEventBus` | class | 同步派发的页面级事件总线；可注入 `OFDOpenOptions.eventBus` |
| `document.events` | `OFDEventBus` | 文档生命周期事件总线 |
| `document.on/once/off/addEventListener/removeEventListener` | subscribe | 订阅文档与页面事件 |
| `page.on/once/off/addEventListener/removeEventListener` | subscribe | 按 `pageIndex` 过滤的页面事件 |
| `H5Canvas2DRenderer` | class | 默认 Canvas 2D 渲染器，可显式构造 |
| `getPageViewport(size, options?)` | `Viewport` | 纯函数，同 `page.getViewport` |
| `getPageTransform(area, dpi?)` | `Matrix` | mm→设备像素变换 |
| `OFDError` / `isOFDError` / `toOFDError` | class/function | 统一错误 |
| `WARNING_CODES` / `WarningCollector` | const/class | warning 码与去重收集 |
| `DEFAULT_RESOURCE_LIMITS` / `DEFAULT_CACHE_OPTIONS` | const | 默认限制/缓存预算 |

---

## 3. `OFDDocument`

### 3.1 `OFDDocument.open(options: OFDOpenOptions | OFDOpenFromContainerOptions): Promise<OFDDocument>`

打开一个 OFD 包。打开阶段只读取 `OFD.xml`、`Document.xml`、页树和资源索引；页面内容、字体、图片按需加载。

| 参数 | 类型 | 默认 | 说明与约束 |
| --- | --- | --- | --- |
| `source` | `OFDSource` | `OFDOpenOptions` 必填 | 文档字节来源，见 §3.2；纯容器打开用 `OFDOpenFromContainerOptions` 时可省略，engine 不打开它 |
| `container` | `VirtualContainer` | 无 | 宿主借用的明文容器；与 `containerFactory` 互斥，engine 不关闭；`encrypted=true` 抛 `OFD_ENCRYPTED` |
| `containerFactory` | `VirtualContainerFactory` | 无 | engine 调用并拥有返回容器；与 `container` 互斥且需要 `source`；打开失败/`close()` 时关闭 |
| `documentIndex` | `number` | `0` | 多文档包时的文档索引；按带 `DocRoot` 的 `DocBody` 顺序计数；必须为非负整数，越界抛 `OFD_INVALID_PACKAGE` |
| `limits` | `Partial<ResourceLimits>` | `DEFAULT_RESOURCE_LIMITS` | 资源限制覆盖；浅合并；单位见 §11 |
| `cache` | `Partial<CacheOptions>` | `DEFAULT_CACHE_OPTIONS` | 缓存预算覆盖；浅合并；单位见 §11 |
| `defaultFonts` | `readonly FontInput[]` | 无 | 用户默认字体：文档字体缺省时的替代来源，优先级高于 `supplementaryFonts`；仅作替代，显式 GID 不可信（走 cmap）；不传时不加载；`path`/`filePath` 需配合 `loadInput` |
| `supplementaryFonts` | `FontInput[]` | 无 | 宿主补充字体；引擎不内置 CJK 字体；按需用于缺字/缺字体回退；`path`/`filePath` 需配合 `loadInput` |
| `loadInput` | `FontInputLoader` | 无 | 字体来源字节加载器；不传时 Web 默认 `url` fetch、`data` 直读，`path`/`filePath` 不支持；Node CLI 注入 `node:fs` |
| `fontProvider` | `FontProvider` | 无 | 宿主按需提供字体；优先于 `defaultFonts`/`supplementaryFonts` 的匹配流程见 §8.1 |
| `imageDecoders` | `ImageDecoderPlugin[]` | 无 | JBIG2/TIFF 等插件；PNG/JPEG/GIF 内置路径优先 |
| `onWarning` | `(warning: OFDWarning) => void` | 无（不打印） | 非致命 warning 回调；同一 `(code,pageIndex,objectId)` 去重；回调抛错不影响渲染 |
| `strictImageCtm` | `boolean` | `true` | 图片缺 CTM 时：`true` 按 identity 1×1；`false` 铺满 Boundary |
| `layerOrder` | `'document' \| 'type'` | `'type'` | `type` 按设计方案图层顺序；`document` 严格 XML 顺序 |
| `createCanvas` | `(width,height)=>Canvas2DLike` | 浏览器默认 | 临时画布工厂，单位像素；默认 H5 渲染器、矢量签章嵌套 OFD、`exportImage` 使用；显式 `renderer` 不覆盖 `exportImage` |
| `encodeImage` | `EncodeImage` | 浏览器 Canvas 原生 | 图片编码钩子；Node/自定义 canvas 必须注入；未注入且 Canvas 无 `convertToBlob/toBlob` 时 `exportImage` 抛 `OFD_RENDERER_UNSUPPORTED` |
| `renderer` | `Renderer` | 内部 `H5Canvas2DRenderer` | 页面绘制扩展点；只接管 `page.render`，`exportImage` 仍用文档级 `createCanvas` |
| `eventBus` | `OFDEventBus` | engine 创建 | 打开阶段与后续文档生命周期使用的事件总线；注入后 `document.events` 为同一对象；一个总线只对应一个文档 |
| `signal` | `AbortSignal` | 无 | 打开取消信号；中止时 `open()` 以 `OFD_ABORTED` 拒绝并派发 `document:open:abort(cause='caller')` |

`open` 有两个重载：`OFDOpenOptions` 要求 `source`（默认 ZIP/工厂），`OFDOpenFromContainerOptions` 要求 `container`、`source` 仅作宿主上下文。两者共享 `limits/cache/fonts/renderer` 等基础选项：

```ts
static open(options: OFDOpenOptions | OFDOpenFromContainerOptions): Promise<OFDDocument>;
```

`openZipVirtualContainer` 可直接构造默认 ZIP 容器（供检查/解密或注入明文包）：

```ts
interface OpenZipVirtualContainerOptions {
  /** 仅 ZIP 相关资源限制覆盖；大小单位 byte。 */
  limits?: Partial<ResourceLimits>;
}

function openZipVirtualContainer(
  source: OFDSource,
  options?: OpenZipVirtualContainerOptions,
): Promise<VirtualContainer>;
```

返回 **raw package container**，不是自动解密容器：`encrypted=false` 的明文包可注入 engine；`encrypted=true` 时 `read()` 返回存仓原始字节，加密包可能为密文，只能用于检查/交给 crypto 解密。构造器拥有 source，`close()` 释放；构造失败会关闭已打开来源。

返回值：已打开的 `OFDDocument`。失败时抛 `OFDError`（见 §9）。

约束：

- 打开成功后才可 `getPage`；`close()` 后所有调用以 `OFD_CLOSED` 拒绝。
- 打开阶段不解压整包；不加载页面字体/图片。
- `documentIndex` 只对多文档包有意义；单文档包必须为 0。
- `onWarning` 中的 warning 不改变渲染结果，调用方不得用 warning 代替错误处理。

### 3.2 `OFDSource`

| `kind` | 字段 | 说明 |
| --- | --- | --- |
| `arraybuffer` | `data: ArrayBuffer \| Uint8Array` | 内存字节；Web/Node 均可用 |
| `blob` | `blob: Blob` | 浏览器 `Blob`/`File`；Node 需宿主提供 Blob 兼容实现 |
| `url` | `url: string; headers?: Record<string,string>` | HTTP(S) Range 读取；依赖 `fetch`；`headers` 透传；需服务端支持 Range，否则可能全量读取 |
| `node-file` | `path: string` | 类型保留；本版本未提供 Node 文件适配，Node 宿主请用 `custom` 或 `arraybuffer` |
| `wechat-file` | `filePath: string` | 类型保留；本版本未提供微信适配 |
| `custom` | `source: ByteSource` | 宿主实现随机读取；最通用的平台入口，见 §8.4 |

约束：`source` 缺失/为空抛 `OFD_INVALID_PACKAGE`；URL 请求失败、非 2xx、Range 不满足按 `OFD_INVALID_PACKAGE`/`OFD_ENTRY_NOT_FOUND` 处理。

### 3.3 `document.pageCount: number`

打开后立即固定的页数；只读。用于 `getPage` 边界检查。

### 3.4 `document.getPage(pageIndex: number, options?: { signal?: AbortSignal }): Promise<OFDPage>`

| 参数 | 类型 | 约束 |
| --- | --- | --- |
| `pageIndex` | `number` | 从 0 开始的整数；`0 <= pageIndex < pageCount` |
| `options.signal` | `AbortSignal` | 只取消本次等待；中止后 Promise 以 `OFD_ABORTED` 拒绝并派发 `page:load:abort(cause='caller')` |

返回页句柄；页尺寸已按“页 → 模板 → CommonData → A4”回退链解析。越界抛 `OFD_PAGE_NOT_FOUND`；文档已关闭抛 `OFD_CLOSED`；页面 XML/资源损坏抛对应 `OFD_*`。

### 3.5 `document.getPageInfos(options?: PageInfoOptions): Promise<readonly PageInfo[]>`

批量读取连续页的尺寸/页区域，供阅读器建立页壳、虚拟滚动和缩略图布局。只扫描页树与 `Page.xml` 页头，**不调用 `preparePage`、不解码字体/图片、不构建 display list、不创建 canvas**。

```ts
interface PageInfoOptions {
  /** 起始页索引，0-based；默认 0。 */
  start?: number;
  /** 返回页数；默认剩余全部；0 表示空。 */
  count?: number;
  /** 取消信号。 */
  signal?: AbortSignal;
}

interface PageInfo {
  index: number;                 // 页索引，0-based
  widthMm: number;               // 页宽，mm
  heightMm: number;              // 页高，mm
  xMm?: number;                  // PhysicalBox 原点 x，mm；非零时给出
  yMm?: number;                  // PhysicalBox 原点 y，mm；非零时给出
  source?: 'page' | 'template' | 'default'; // 页尺寸来源（P1）
}
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `start` | `0` | 非整数截断；负数或大于等于页数返回空数组 |
| `count` | 剩余全部 | 非有限/负数按 0；超出剩余页数时截断 |
| `signal` | 无 | 中止后 `OFD_ABORTED`；`close` 优先 `OFD_CLOSED` |

- 返回按 `index` 升序的连续页；与 `getPage(index).getSize()` 使用同一条 `Page → Template → CommonData.PageArea → A4` 回退链，单位 mm。
- 结果按页缓存到 `close()`；相同页重复请求不重复读 XML。1000 页冷启动目标 ≤300 ms、缓存命中 ≤50 ms（参考机/本地 ZIP）。
- **页尺寸 warning**：缺失 Area/PhysicalBox 不单独 warning；回退到模板或 `CommonData` 成功时不提示；只有最终回退 A4 才 warning。显式声明但宽/高非正的 Area 仍 warning 后进入回退链；不影响其他页。没有页时返回空数组，不抛错。
- 错误：取消 `OFD_ABORTED`、关闭 `OFD_CLOSED`；不因单页损坏抛 `OFD_XML_PARSE`。

### 3.6 `document.getOutline(options?: { signal?: AbortSignal }): Promise<readonly OutlineNode[]>`

读取 `Document.xml` 的大纲树；打开阶段已解析并缓存，不加载页面内容。无大纲返回空数组。

```ts
type DestinationType = 'XYZ' | 'Fit' | 'FitH' | 'FitV' | 'FitR';

interface DocumentDestination {
  type: DestinationType;         // OFD Dest@Type
  pageIndex: number;             // 目标页，0-based
  leftMm?: number;               // 目标区域左边界，mm
  topMm?: number;                // 目标区域上边界，mm
  rightMm?: number;              // 目标区域右边界，mm
  bottomMm?: number;             // 目标区域下边界，mm
  zoom?: number;                 // XYZ 缩放倍率；1=100%
}

interface OutlineNode {
  title: string;                 // 标题
  expanded?: boolean;            // OFD Expanded；缺省由 UI 决定
  children: readonly OutlineNode[]; // 保持 XML 顺序
  dest?: DocumentDestination;    // 无效/缺失目标时省略
}
```

- 保持 XML 顺序与层级；`Goto Bookmark` 在打开阶段解析到书签目标。
- 无效 PageID/未知 Dest Type/非法坐标：保留节点与子节点，省略 `dest` 并 warning，不抛错。
- 错误：取消 `OFD_ABORTED`、关闭 `OFD_CLOSED`。

### 3.7 `document.getBookmarks(options?: { signal?: AbortSignal }): Promise<readonly BookmarkItem[]>`

读取 `Document.xml` 的书签列表；保持 XML 顺序，不做去重/排序。无书签返回空数组。

```ts
interface BookmarkItem {
  name: string;                  // Bookmark@Name
  dest?: DocumentDestination;    // 无效/缺失目标时省略
}
```

- 同名书签全部保留；无效目标保留书签、省略 `dest` 并 warning。
- 错误：取消 `OFD_ABORTED`、关闭 `OFD_CLOSED`。

### 3.8 `document.getMetadata(options?: { signal?: AbortSignal }): Promise<DocumentMetadata>`

读取 `OFD.xml` 的 `DocBody/DocInfo`；`version/pageCount` 来自已打开文档。无 `DocInfo` 时仍返回版本与页数，不报错。

```ts
interface DocumentMetadata {
  version: string;               // OFD 版本，例如 '1.0'
  pageCount: number;
  packageSize?: number;          // 源文件字节数，byte
  title?: string;                // DocInfo/Title
  author?: string;               // DocInfo/Author
  subject?: string;              // DocInfo/Subject
  abstract?: string;             // DocInfo/Abstract
  creationDate?: string;         // 原文，不转换时区
  modDate?: string;              // 原文，不转换时区
  creator?: string;              // DocInfo/Creator
  creatorVersion?: string;       // DocInfo/CreatorVersion
  keywords?: readonly string[];  // DocInfo/Keywords
  docId?: string;                // DocInfo/DocID
  customData?: Readonly<Record<string, string>>; // 自定义元数据
}
```

- 缺失字段省略；非法日期等字段 warning 后跳过，不中断打开/读取。
- 错误：取消 `OFD_ABORTED`、关闭 `OFD_CLOSED`。

### 3.9 `document.getSignatureEntries(options?: { signal?: AbortSignal }): Promise<readonly SignatureEntryInfo[]>`

读取 `Signatures.xml` 索引与逐条 `Signature.xml`，返回签章 XML 元数据和页面戳记。**只读 XML**：不读取 `SignedValue.dat` 内容、不读取 `Seal.esl`、不解析 ASN.1/DER/X.509/CMS、不验签。无签章或索引损坏返回空数组。

```ts
interface SignatureProvider {
  name?: string;                 // Provider@ProviderName
  company?: string;              // Provider@Company
  version?: string;              // Provider@Version
}

interface SignatureReferenceInfo {
  fileRef: string;               // Reference@FileRef
}

interface SignatureStampInfo {
  id?: string;                   // StampAnnot@ID
  pageId: string;                // StampAnnot@PageRef（页 ID）
  pageIndex?: number;            // 页索引，0-based；未匹配时省略
  boundary: Box;                 // 戳记边界，mm
  clip?: Box;                    // 裁剪区域，mm
}

interface SignatureEntryInfo {
  id: string;                    // Signature@ID
  type: string;                  // Signature@Type，例如 Seal/Sign
  baseLoc: string;               // Signature.xml 包内路径
  provider?: SignatureProvider;
  signatureDateTime?: string;    // 原文，不转换时区
  references: readonly SignatureReferenceInfo[];
  stamps: readonly SignatureStampInfo[]; // 保持 XML 顺序
  signedValuePath?: string;      // SignedValue.dat 包内路径；未声明时省略
  hasSignedValue: boolean;       // 只表示是否声明路径，不表示文件存在
}
```

- 保持 `Signatures.xml` 顺序；重复 ID 先到先得并 warning；坏 `Signature.xml` 跳过该条并 warning，其他条正常。
- `PageRef` 未匹配：保留 `pageId`、省略 `pageIndex` 并 warning；非法 Boundary 跳过该戳记并 warning。
- `boundary/clip` 使用 mm；`pageIndex` 从 0 开始。
- 错误：取消 `OFD_ABORTED`、关闭 `OFD_CLOSED`；索引/条目损坏按 warning + 跳过/空数组处理，不抛 ASN.1/证书错误。

### 3.10 `document.getSignedValue(signatureId: string, options?: { signal?: AbortSignal }): Promise<SignedValueFile | undefined>`

按 `SignatureEntryInfo.signedValuePath` 返回 `SignedValue.dat` **原始字节**；不解析内容、不读取 `Seal.esl`、不缓存大文件。

```ts
interface SignedValueFile {
  signatureId: string;           // 所属签章 ID
  path: string;                  // SignedValue.dat 包内路径
  data: Uint8Array;              // 原始字节，归调用方
  byteLength: number;            // byte
}
```

- 未声明 SignedValue 或签章 ID 不存在：返回 `undefined`，不 warning。
- 声明但文件缺失/读取失败：warning `W_SIGNATURE_RESOURCE`，返回 `undefined`，不抛 `OFD_ENTRY_NOT_FOUND`。
- `OFD_LIMIT_EXCEEDED`/`OFD_INVALID_PACKAGE` 原样抛出；取消 `OFD_ABORTED`、关闭 `OFD_CLOSED`。
- 每次调用重新读取，不做长期缓存；UI 解析后自行缓存结构化详情。

### 3.11 `document.getPermissions(options?: { signal?: AbortSignal }): Promise<DocumentPermissions>`

读取 `Document.xml/Permissions` 的权限声明。**只读声明，不做 DRM/权限强制**：引擎不会因 `export:false` 拒绝 `exportImage`，也不会因 `print:false` 阻止宿主打印；是否禁用由 UI 自行决定。

```ts
interface DocumentPermissions {
  edit: boolean;                 // 是否允许编辑，默认 true
  annot: boolean;                // 是否允许添加/修改标注，默认 true
  export: boolean;               // 是否允许导出，默认 true
  signature: boolean;            // 是否允许数字签名，默认 true
  watermark: boolean;            // 是否允许添加水印，默认 true
  printScreen: boolean;          // 是否允许截屏，默认 true
  print?: {
    printable: boolean;          // 是否允许打印；未声明 Print 时默认 true
    copies?: number;             // 允许份数；省略=不限；0=不允许打印
  };
  validPeriod?: {
    start?: string;              // 开始日期原文，不转换时区
    end?: string;                // 结束日期原文
  };
}
```

- 无 `Permissions` 节点：六项布尔均为 `true`，`print`/`validPeriod` 省略（表示可打印且不限、无有效期限制）。
- 缺失字段按默认允许；非法布尔/份数 warning `W_PERMISSION_FIELD` 后回退默认（份数不限）。
- `print.copies` 为 0 表示不允许打印；正整数为份数；负值/非法值按不限处理。
- 日期保留 XML 原文；不判断当前时间是否在有效期内。
- 错误：取消 `OFD_ABORTED`、关闭 `OFD_CLOSED`。

### 3.12 `document.getAttachments(options?: { signal?: AbortSignal }): Promise<readonly AttachmentInfo[]>`

读取 `Attachments.xml` 的附件元信息；首次调用按需解析并缓存到 `close()`。**不读取附件内容、不解析附件格式**。无 `Attachments.xml` 返回空数组。

```ts
interface AttachmentInfo {
  id: string;                    // Attachment@ID，已规范化
  name: string;                  // Attachment@Name
  format?: string;               // Attachment@Format；未声明时省略
  size?: number;                 // 附件大小，byte；XML 的 Size 以 KB 声明，引擎换算后给出
  creationDate?: string;         // 原文，不转换时区
  modDate?: string;              // 原文
  visible?: boolean;             // Attachment@Visible；缺省 true
  usage?: string;                // Attachment@Usage；缺省 'none'
}
```

- 保持 XML 顺序；重复 ID 保留先出现者并 warning `W_DUPLICATE_RESOURCE`。
- 缺 `ID`/`Name` 的条目跳过并 warning `W_ATTACHMENT_FIELD`；`FileLoc` 路径非法时 warning 后该附件仍可列出，但取数据会失败。
- `Size` 为 XML 的 KB 值 × 1024 后四舍五入为 byte；非法/负数/超范围 warning `W_ATTACHMENT_FIELD` 并省略。
- 不暴露 `FileLoc`（包内路径属于实现细节）。
- 错误：取消 `OFD_ABORTED`、关闭 `OFD_CLOSED`；索引读取/解析失败 warning `W_ATTACHMENT_RESOURCE` 后返回空数组。

### 3.13 `document.getAttachmentData(attachmentId: string, options?: { signal?: AbortSignal }): Promise<Uint8Array | undefined>`

按附件 ID 返回附件条目**原始字节**；不解析内容、不校验格式/签名。ID 按资源 ID 规则匹配。

- 未声明 `Attachments.xml`、附件 ID 不存在或未声明可用 `FileLoc`：返回 `undefined`。
- 声明但文件缺失/读取失败：warning `W_ATTACHMENT_RESOURCE`，返回 `undefined`；不抛 `OFD_ENTRY_NOT_FOUND`。
- `OFD_LIMIT_EXCEEDED`/`OFD_INVALID_PACKAGE` 等包级错误原样抛出；取消 `OFD_ABORTED`、关闭 `OFD_CLOSED`。
- 返回的 `Uint8Array` 归调用方；每次调用重新读取，不做长期字节缓存。
- 附件内容可能是任意格式（PDF/图片/压缩包等），引擎不解析、不执行、不验证。

### 3.14 `document.close(): Promise<void>`

关闭文档，释放 ZIP/XML/字体/图片缓存与图像句柄；可重复调用。进行中的渲染/导出会先被中止，并等待其结束；`close()` 不向调用方抛错。

约束：`close()` 后再调用 `getPage`/`render`/`exportImage` 以 `OFD_CLOSED` 拒绝；`close()` 不应与尚未 `await` 的 `render` 竞争同一 canvas 的后续绘制。

### 3.15 `document.events` 与事件订阅

`document.events` 是本文档使用的事件总线：`OFDOpenOptions.eventBus` 注入时与注入对象相同，否则由 engine 创建。总线提供 `on/once/off/emit/removeAllListeners/listenerCount` 与 `addEventListener/removeEventListener`（支持 `{ once, signal }`）。

- 派发同步；派发前快照监听器集合，派发中新增的监听器不参与本次事件。
- 单个监听器抛错被隔离，不影响其他监听器与渲染结果；可通过 `OFDEventBusOptions.onListenerError` 上报。
- 事件名为 `<对象>:<操作>:<后缀>`，共 14 个：`document:open:*`/`document:close:*`/`page:load:*`/`page:render:*`。
- 公共字段：`type`、`timestamp`（Unix 毫秒）、`sequence`（总线派发序号，从 1 递增）；操作事件含 `operationId`（文档内从 1 递增），页面事件另含从 0 开始的 `pageIndex`。
- 事件对象是只读契约：引擎不在派发后复用/修改字段。
- 入口校验失败（文档已关闭、页索引越界、viewport/Canvas 非法、signal 已中止）不派发任何事件，Promise 直接拒绝。
- `document:close:end` 之后不再派发事件；已注册监听器保留但不再被调用。

`document` 上提供同名便捷方法：`on/once/off/addEventListener/removeEventListener`，语义与总线一致。

---

## 4. `OFDPage`

### 4.1 `page.index: number`

页索引，从 0 开始，只读。

### 4.2 `page.getSize(): PageSize`

返回 `{ width, height }`，单位 **mm**；纯计算，不加载字体/图片。

### 4.3 `page.getViewport(options?: ViewportOptions): Viewport`

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `options.dpi` | `number` | `96` | 输出精度 DPI；必须有限且 >0，否则回退 96 |

返回 `{ width, height, dpi }`，`width/height` 单位 **设备像素**，固定保留 **3 位小数（0.001px）**（t61 起），去除浮点尾差，不做整数取整。例如 228.6mm@96 → `864`，A4@96 → `793.701 × 1122.52`。

约束：

- 纯计算，不触发内容加载；可用于设置 canvas 尺寸。
- 宿主分配 canvas 时建议 `Math.ceil(viewport.width/height)`；`page.render` 会校验画布至少覆盖 viewport。
- `dpi` 是输出精度，不是阅读器缩放；页面旋转/阅读器缩放不在 engine。

### 4.4 `page.render(params: PageRenderParameters): RenderTask`

| 参数 | 类型 | 约束 |
| --- | --- | --- |
| `canvasContext` | `CanvasRenderingContext2DLike` | 宿主 2D 上下文；engine 会以 `M_page` 覆盖其预置 CTM |
| `viewport` | `Viewport` | 必须与 `getViewport` 一致；仅用于尺寸校验/渲染比例 |
| `signal` | `AbortSignal`（可选） | 中止后 `task.promise` 以 `OFD_ABORTED` 拒绝 |

返回 `RenderTask`；渲染是异步准备 + 同步绘制。行为与约束：

- **不设置 canvas 宽高、不清屏、不填背景**；需要清屏或底色时由宿主自行处理（Web 端通常直接用 CSS 背景）。
- 画布像素尺寸小于 viewport 时抛 `OFD_CANVAS_SIZE_MISMATCH`；超过 `maxCanvasPixels` 抛 `OFD_CANVAS_TOO_LARGE`。
- 同一 canvas 的渲染串行；不同 canvas 可并行。同一文档的多个页面可各自渲染。
- 文字全部走轮廓/路径，不使用 Canvas `fillText`/`strokeText`/`measureText`。
- 字体/图片/坏对象通常只 warning 并降级；结构性错误才 reject。
- `page.render` 自身不返回图片；需要编码图片用 `page.exportImage`。

### 4.5 `page.exportImage(options?: PageImageExportOptions): Promise<PageImageResult>`

整页离屏导出；复用 `page.render` 的页面内容管线，不经过自定义 `Renderer`。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `dpi` | `number` | `96` | 有限且 >0；非法回退 96 |
| `format` | `'png'\|'jpeg'\|'webp'` | `'png'` | 输出格式 |
| `quality` | `number` | `0.92` | JPEG/WebP 质量，裁剪到 0..1；PNG 忽略（按 1） |
| `rotation` | `0 \| 90 \| 180 \| 270` | `0` | 仅导出方向，顺时针；90/270 输出宽高互换；非法值 warning `W_BAD_NUMBER` 后回退 0 |
| `background` | `string \| null` | `'#ffffff'` | CSS 颜色；PNG 传 `null` 得透明；JPEG/WebP 的 `null` 按白底 |
| `signal` | `AbortSignal` | 无 | 中止后 `OFD_ABORTED`；不返回部分结果 |

返回：

```ts
interface PageImageResult {
  data: Uint8Array;      // 编码后的图片字节，归调用方所有
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;         // 设备像素；rotation=90/270 时为旋转后宽
  height: number;        // 设备像素；rotation=90/270 时为旋转后高
  dpi: number;           // 实际输出 DPI
}
```

约束：

- 需要文档级 `createCanvas`；Node/自定义 Canvas 还需要 `encodeImage`。
- 像素超限 `OFD_CANVAS_TOO_LARGE`（按旋转后输出尺寸判断）；画布尺寸不符 `OFD_CANVAS_SIZE_MISMATCH`；缺画布/编码器/格式不支持/编码失败 `OFD_RENDERER_UNSUPPORTED`；取消 `OFD_ABORTED`；关闭 `OFD_CLOSED`。
- `rotation` 只影响导出图片方向，不改变页面模型、`page.render` 或其他页面状态；90/270 时 `width/height` 与默认方向互换，内容按顺时针旋转。
- 非法 `rotation`（非 0/90/180/270）只 warning `W_BAD_NUMBER` 并回退 0，不中断导出；`W_BAD_NUMBER.objectId = 'exportImage.rotation'`。
- 不包含阅读器缩放/裁剪/多页拼接；区域导出、多页导出不在 v1。
- 导出结果不自动释放；`data` 归调用方，编码中间 canvas 由 engine 释放。

### 4.6 `page.prepare(options?: PagePrepareOptions): Promise<void>`

预取页面模型、字体、图片和模板资源，填充页面缓存；**不创建 canvas、不绘制**。供阅读器滚动预取。

```ts
interface PagePrepareOptions {
  /** 取消信号；中止后以 OFD_ABORTED 拒绝。 */
  signal?: AbortSignal;
}
```

- 幂等：已准备或正在准备时复用同一 bundle；并发调用只准备一次。
- 使用 96 DPI 准备；`page.render` 的 DPI 匹配时复用，渲染结果不因 prepare 改变。
- 调用方 `signal` 只影响本次等待，不取消共享准备；`close` 中止共享准备并清理缓存。
- 手工构造、无准备驱动的 `OFDPage` 抛 `OFD_RENDERER_UNSUPPORTED`；取消 `OFD_ABORTED`、关闭 `OFD_CLOSED`。

### 4.7 `page.getTextContent(options?: TextContentOptions): Promise<TextContent>`

读取页面阅读器文本层。复用 `layoutText` 与页面绘制顺序，**不调用 Canvas 文字 API**，不改变页面渲染结果。所有几何单位 px，原点为 `PhysicalBox` 左上角，y 向下。

```ts
interface TextContentOptions {
  dpi?: number;                  // 输出 DPI，默认 96；非有限/<=0 回退 96
  includeChars?: boolean;        // 是否返回 chars，默认 true
  includeAnnotations?: boolean;  // 是否包含注释 Appearance 文字，默认 false
  includeInvisible?: boolean;    // 是否包含不可见文字，默认 false
  layerOrder?: 'document' | 'type'; // 缺省沿用打开文档的 layerOrder
  signal?: AbortSignal;          // 中止后 OFD_ABORTED
  maxTextItems?: number;         // 默认 20,000；0=不限
  maxTextChars?: number;         // 默认 500,000；0=不限
}

interface TextContent {
  pageIndex: number;             // 0-based
  dpi: number;                   // 实际输出 DPI
  unit: 'px';                    // 固定 px
  pageWidth: number;             // 页面宽，px
  pageHeight: number;            // 页面高，px
  items: TextItem[];             // 按绘制顺序
  itemCount: number;
  charCount: number;             // 即使 includeChars=false 也统计
  truncated: { items: boolean; chars: boolean };
}

interface TextPoint { x: number; y: number; }              // px
interface TextRect { x: number; y: number; width: number; height: number; } // px
type TextQuad = readonly [TextPoint, TextPoint, TextPoint, TextPoint]; // 左上/右上/右下/左下

interface TextFontInfo {
  resourceId: string;            // TextObject.font
  family: string;
  postscriptName?: string;
  weightClass?: number;          // OS/2 weightClass
  italic: boolean;
}

type TextLayer = 'template' | 'page' | 'annotation';

interface TextItem {
  order: number;                 // 绘制顺序，0-based
  objectId?: string;
  templateId?: string;
  annotationId?: string;
  blockId?: string;
  layer: TextLayer;
  layerType: 'Background' | 'Body' | 'Foreground' | 'Custom';
  zOrder?: 'Background' | 'Body' | 'Foreground';
  visible: boolean;
  alpha: number;                 // 0..1，仅对象自身
  text: string;                  // TextCode 顺序拼接
  font: TextFontInfo;
  size: number;                  // 字号，px
  transform: Matrix;             // 布局局部 mm → 页面 px
  origin: TextPoint;             // 首字符 baseline，px
  rect: TextRect;                // 轴对齐包围盒，px
  quad: TextQuad;                // 外接四边形，px
  advance: number;               // 阅读方向总推进，px
  charCount: number;
  chars?: TextChar[];            // includeChars=false 时省略
}

interface TextChar {
  text: string;
  codePoint: number;
  glyphId?: number;
  faceKey?: string;
  fallback: boolean;
  origin: TextPoint;             // px
  advance: number;               // px；缺字为 0
  rect: TextRect;                // px；缺字宽高为 0
  quad: TextQuad;                // px；缺字四点为 origin
  approximate: boolean;          // 多字形 run 的近似映射
}
```

- 一个 `TextItem` 对应一个 `TextObject`，`text` 按 `TextCode` 顺序拼接；`TextChar` 按 Unicode 码点给出字符级几何。
- 只遍历页面/模板/复合/注释的可见文字；默认排除 Pattern tile、ClipArea.text 和注释 Appearance；`includeAnnotations=true` 才加入注释文字。
- 默认要求样式、非零 Boundary、fill/stroke、size>0、visible/alpha；`includeInvisible=true` 只放宽 visible/alpha，`TextItem.visible` 仍反映对象自身。
- 空页返回 `items: []`、`itemCount: 0`、`charCount: 0`，不报错。
- 达到 `maxTextItems` 停止加入后续 item；下一个 item 会超过 `maxTextChars` 时整项不加入；`truncated` 为二值状态，对应 warning `W_TEXT_ITEM_LIMIT`/`W_TEXT_CHAR_LIMIT`，不抛错。非法上限回退默认；0 表示不限。
- mm 布局按页缓存（`CacheOptions.textPages`，默认 4 页），缓存键不含 `dpi`；96/144/300 DPI 复用同一布局，只做输出换算。`close()` 中止并清空。
- 手工构造、无文本驱动的 `OFDPage` 抛 `OFD_RENDERER_UNSUPPORTED`；关闭 `OFD_CLOSED`、取消 `OFD_ABORTED`。页面不存在由 `getPage` 提前以 `OFD_PAGE_NOT_FOUND` 拒绝。
- 不解析 ASN.1/证书，不触及签章；文本层与公开签章 API 相互独立。

### 4.8 `RenderTask`

| 成员 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `number` | 本次渲染的操作 ID；与 `page:render:*` 事件 `operationId` 相同；入口校验失败时为 `0` |
| `promise` | `Promise<void>` | 完成 resolve；取消/失败 reject `OFDError` |
| `cancel()` | `void` | 请求取消；可重复调用；不抛错 |

`cancel()` 后 `promise` 以 `OFD_ABORTED` 拒绝；取消是协作式的，已进入的同步绘制会在下一个对象/边界退出。

### 4.9 `page.renderRegion`（暂不实现/无排期）

按用户决定，v1 **不实现**局部/瓦片渲染 API；`OFDPage` 上没有 `renderRegion` 方法，`src/index.ts` 也不导出 `PageRenderRegionParameters` 或相关类型。当前调用属于宿主类型错误/运行时错误，engine 不提供兼容桩。

以下仅为未来设计草案（**非公开契约、不导出、不可调用**），不是 v1 签名：

```ts
// 规划草案：v1 不导出，以下类型/方法均不存在于 src/index.ts / OFDPage
interface PageRenderRegionParameters {
  xMm: number;                   // 区域左上角 x，mm
  yMm: number;                   // 区域左上角 y，mm
  widthMm: number;               // 区域宽，mm
  heightMm: number;              // 区域高，mm
  dpi: number;                   // 输出 DPI
  canvasContext: CanvasRenderingContext2DLike; // 尺寸由宿主设置，单位 px
  signal?: AbortSignal;
}

renderRegion(params: PageRenderRegionParameters): RenderTask;
```

- 原因：1000 页 A4 @4x 约 14.3MP，低于默认 32MP 画布上限；先降 DPI + CSS 放大可满足当前阅读器。
- 未来若排期，必须保持与整页渲染相同的图层/对象顺序，仅改变 CTM 与 clip，并重新走契约评审。

### 4.10 `page.on/once/off/addEventListener/removeEventListener`

页面监听器是文档总线的按 `pageIndex` 过滤视图：只接收 `pageIndex` 与当前页一致的 `page:load:*`/`page:render:*` 事件；文档关闭时由引擎自动清理。

- `page:render:start` 在入口校验通过、`render()` 返回前同步派发；宿主可据此建立 `operationId → 用途（主页面/缩略图）` 映射。
- `page:render:end`/`error`/`abort` 在 `task.promise` resolve/reject 前派发，三者互斥且必有一个。
- 取消来源区分 `cause='caller'`（`task.cancel()`/宿主 signal）与 `cause='close'`（文档关闭）。
- 同一 Canvas 的渲染串行执行，但 `start` 仍在各自 `render()` 调用栈内立即派发。

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

- `canvas`：已绘制整页的离屏画布，`width/height` 为设备像素；
- `format`：`png`/`jpeg`/`webp`；
- `quality`：0..1；PNG 固定 1；
- 返回非空 `Uint8Array`；空/非 `Uint8Array`/抛错统一映射为 `OFD_RENDERER_UNSUPPORTED`，原始错误放 `cause`。

### 5.2 `CanvasImageEncodeSource`

`Canvas2DLike` 的可选编码扩展：

| 成员 | 说明 |
| --- | --- |
| `convertToBlob?(options?)` | 浏览器 OffscreenCanvas 优先入口，返回 `Blob` |
| `toBlob?(callback,type?,quality?)` | 传统 canvas 入口；回调 `null` 表示失败 |

engine 不使用 `toDataURL`；未注入 `encodeImage` 时按 `convertToBlob → toBlob` 尝试。

---

## 6. 渲染器扩展点

### 6.1 `H5Canvas2DRenderer`

```ts
new H5Canvas2DRenderer(options?: H5Canvas2DRendererOptions)
```

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `createCanvas` | `(w,h)=>Canvas2DLike` | 浏览器 `document` | 临时画布工厂，单位像素；Node/小程序必须传 |
| `enableHWA` | `boolean` | `false` | 硬件加速语义；默认 `willReadFrequently: true` |

通常不需要显式构造：`OFDDocument.open` 未传 `renderer` 时内部创建。需要替换渲染器时，把实例传给 `OFDOpenOptions.renderer`。

### 6.2 `Renderer`

底层绘制接口；只接收最终样式、路径、图像、矩阵与 group，不认识 OFD 对象模型。完整方法签名见 `src/renderer/types.ts`，关键约束：

- `beginPage(context, viewport)` 不设置 canvas 尺寸、不清屏；画布生命周期归宿主。
- `beginGroup(options)` 的 `matrix` 是 group 坐标 → 当前设备坐标的绝对矩阵，不叠加父 CTM；`endGroup()` 必须恢复目标/变换/alpha/clip/composite。
- `drawImage(..., blendMode?: 'multiply')` 仅签章白底使用；普通图片/注释不传。
- 文字由 engine 转成路径后调用 `fill/stroke`，渲染器不需要文字 API。
- 自定义 `Renderer` 只接管 `page.render`；`page.exportImage` 仍使用文档级 `createCanvas`，不会调用自定义 renderer 的临时画布能力。

### 6.3 `Canvas2DLike` / `CanvasRenderingContext2DLike`

引擎使用的最小 Canvas 子集：变换、路径、clip、fill/stroke、drawImage、渐变、pattern、虚线、合成属性。`CanvasRenderingContext2DLike` 不要求 `fillText`、`strokeText`、`measureText`、`filter`、`Path2D`、`DOMMatrix`。Gouraud 软件光栅化需要可选的 `createImageData`/`putImageData`；缺失时降级并上报 `W_GOURAUD_APPROX`。

---

## 7. 视口与变换

### 7.1 `getPageViewport(size: PageSize, options?: ViewportOptions): Viewport`

`page.getViewport` 的纯函数版本；`size` 单位 mm，返回设备像素；`dpi` 默认 96；`width/height` 保留 3 位小数。

### 7.2 `getPageTransform(area: Box, dpi = 96): Matrix`

返回 `M_page = S(dpi/25.4) × T(-area.x, -area.y)`；`area` 为页面 `PhysicalBox`，单位 mm。用于宿主自定义绘制/调试，不是普通调用方必需。

### 7.3 常量

| 常量 | 值 | 单位 |
| --- | --- | --- |
| `DEFAULT_DPI` | `96` | dpi |
| `MM_PER_INCH` | `25.4` | mm/inch |

---

## 8. 平台注入接口

### 8.1 字体

```ts
type FontInput =
  | { data: ArrayBuffer | Uint8Array; family?: string }
  | { url: string; family?: string }
  | { path: string; family?: string }
  | { filePath: string; family?: string };

/** 从宿主字体来源读取字节；url/path/filePath 由宿主平台实现。 */
type FontInputLoader = (
  input: FontInput,
) => Uint8Array | ArrayBuffer | null | Promise<Uint8Array | ArrayBuffer | null>;

interface FontMatchRequest {
  fontName: string;
  familyName?: string;
  charset: string;     // unicode | prc | big5 | symbol
  bold: boolean;
  italic: boolean;
  serif: boolean;
  fixedSize: boolean;
}

interface FontProvider {
  match(request: FontMatchRequest): Promise<FontInput | FontInput[] | null>;
}
```

约束：

- engine 不内置 CJK 字体；缺字/缺字体只 warning，不中断。
- 主字体优先级：内嵌 `FontFile` → `fontProvider` → `defaultFonts` → `supplementaryFonts`；逐字形回退链为 provider 其余候选 → defaultFonts 其余 → supplementaryFonts。精确来源命中时 `defaultFonts` 不参与主字体选择，但仍进入回退链。
- `defaultFonts` 是替代来源，显式 GID 一律不可信（忽略 `CGTransform` 的 GID，走 cmap）；不传时不读取、不产生额外开销。
- `fontProvider` 返回多个候选时按顺序尝试；`null` 表示无匹配。
- `FontInput.family` 用于诊断/别名匹配；真实字体名以字体文件为准。
- 字体解析失败抛 `OFD_FONT_PARSE` 的场景限于引擎必须加载的字体；可降级时只 warning。
- **`OFDOpenOptions.loadInput` 可选（r11 兼容增量）**：不传时保持 Web 默认行为——`data` 直接使用，`url` 走 `fetch`，`path`/`filePath` 不支持并产生字体 warning；传了则所有非 `data` 来源都交给 loader。
- loader 返回 `null` 表示该来源不可用；抛错/读取失败由字体层降级并上报 `W_FONT_MISSING`，不中断文档打开。
- Node CLI 注入基于 `node:fs` 的 loader（`path`/`filePath` 用 `readFile`，`url` 仍用 fetch）；`--font-dir` 扫描到的字体以 `path` 来源传入，真正读取字节并解析实际 family。
- `--font-dir` 递归扫描 `.ttf/.otf/.ttc/.otc`（大小写不敏感）；TTC/OTC 展开全部字体面，按 fontkit 实测 family 参与匹配；默认自动扫描白名单系统字体（CJK 优先，最多 6 个 / 96 MiB，不跟随目录符号链接），`--no-system-fonts` 可关闭；`--font-dir` 作为追加来源；不下载字体。
- 浏览器/读者宿主如需本地字体，仍推荐 `data`（`ArrayBuffer`/`Uint8Array`）或 `url`；不要让 engine 直接依赖 Node API。

### 8.2 图片解码插件

```ts
interface ImageDecoderPlugin {
  format: string; // 小写，如 jbig2/tiff
  decode(data: Uint8Array): Promise<DecodedImage>;
}

interface ImageDecoder {
  decode(data: Uint8Array, hint?: { format?: string }): Promise<DecodedImage>;
}
```

- PNG/JPEG 走宿主/内置解码；GIF 首帧内置；JBIG2/TIFF 需插件或宿主解码器。
- `DecodedImage`：`{ width, height, data, kind?: 'imagedata'|'source' }`，宽高单位像素。
- 插件抛错/返回空数据由引擎转 warning `W_IMAGE_DECODE` 并继续（负样本除外，由测试口径处理）。

### 8.3 `ByteSource`

```ts
interface ByteSource {
  readonly size: number; // byte
  read(offset: number, length: number): Promise<Uint8Array>; // byte
}
```

实现随机读取；越界可截断或抛错。用于 `OFDSource.kind='custom'`、HTTP Range/Node 文件/微信文件适配。

### 8.4 画布与编码钩子

见 §3.1 的 `createCanvas`/`encodeImage`。约束：单位像素；`createCanvas` 返回的画布必须支持 `getContext('2d')`；`encodeImage` 必须返回非空字节。

---

## 9. 错误

所有公共 API 失败抛 `OFDError`；`code` 用于程序分支，`message` 用于诊断，`cause` 保留原始异常。

```ts
class OFDError extends Error {
  readonly code: OFDErrorCode;
  override readonly cause?: unknown;
}
function isOFDError(value: unknown): value is OFDError;
function toOFDError(error: unknown, code: OFDErrorCode, message: string): OFDError;
```

| `code` | 触发场景 |
| --- | --- |
| `OFD_INVALID_PACKAGE` | 非 OFD/ZIP、缺 `OFD.xml`/`Document.xml`、`DocRoot`/`documentIndex` 非法、URL 读取失败 |
| `OFD_ENTRY_NOT_FOUND` | ZIP 内条目缺失（页面/资源/字体/图片） |
| `OFD_UNSUPPORTED_COMPRESSION` | ZIP 压缩方法不支持/加密条目 |
| `OFD_ENCRYPTED` | 加密文档 |
| `OFD_XML_PARSE` | XML 格式错误且无法降级 |
| `OFD_PAGE_NOT_FOUND` | 页码越界 |
| `OFD_CANVAS_TOO_LARGE` | canvas 像素超过 `maxCanvasPixels`（render/export） |
| `OFD_CANVAS_SIZE_MISMATCH` | canvas 小于 viewport |
| `OFD_RENDERER_UNSUPPORTED` | 自定义 renderer 不支持、缺画布/编码器、格式不支持、编码失败/空结果 |
| `OFD_ABORTED` | `RenderTask.cancel()`/`AbortSignal` 中止 |
| `OFD_CLOSED` | 文档已关闭后继续调用 |
| `OFD_LIMIT_EXCEEDED` | 包/条目/解压/图片/递归等资源限制 |
| `OFD_FONT_PARSE` | 必须加载的字体无法解析 |
| `OFD_IMAGE_DECODE` | 必须解码的图片失败（可降级时通常 warning） |

`toOFDError` 只包装非 `OFDError`；已是 `OFDError` 时原样返回。

---

## 10. Warning

```ts
interface OFDWarning {
  code: WarningCode | string;
  message: string;
  pageIndex?: number; // 从 0 开始
  objectId?: ResourceId;
  resourceId?: ResourceId;
}
```

- warning 不中断渲染；同一 `(code,pageIndex,objectId)` 只上报一次（跨文档级/页级相同 code+message 也去重）。
- `onWarning` 未提供时不打印；回调抛错不影响引擎。
- `WarningCollector` 供宿主/测试收集 warning；`WARNING_CODES` 为冻结码表。

| `code` | 含义 |
| --- | --- |
| `W_FONT_MISSING` | 缺少字体，或字体来源不可用/加载失败（含 `path`/`filePath` 无 loader）；使用回退/替代字体 |
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
| `W_RADIAL_UNSUPPORTED` | v1 不支持径向渐变，降级 |
| `W_GOURAUD_APPROX` | Gouraud/网格渐变近似 |
| `W_ANNOT_EMPTY` | 注释外观为空；模型解码阶段提示一次，渲染跳过不重复 |
| `W_JBIG2_DECODE` | JBIG2 解码失败/超限，跳过 |

P0/P1/P2 UI API 还会产生以下扩展码（`OFDWarning.code` 类型允许 `string`；宿主按字符串处理，`WARNING_CODES` 冻结表暂未列入这些新增码）：

| `code` | 含义 |
| --- | --- |
| `W_OUTLINE_TARGET` | 大纲层级超限/目标无效/书签引用不存在，保留节点但省略 `dest` |
| `W_BOOKMARK_TARGET` | 书签目标无效，保留书签但省略 `dest` |
| `W_METADATA_FIELD` | DocInfo 日期非法或自定义字段缺名，跳过该字段 |
| `W_SIGNATURE_RESOURCE` | 声明了 SignedValue.dat 但读取失败，`getSignedValue` 返回 `undefined` |
| `W_TEXT_ITEM_LIMIT` | 文本项达到 `maxTextItems`，停止加入后续项 |
| `W_TEXT_CHAR_LIMIT` | 下一个文本项会超过 `maxTextChars`，整项不加入 |
| `W_PERMISSION_FIELD` | Permissions 布尔/份数字段非法，按默认允许回退 |
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
| `textPages` | 4 | 页 | 文本层 mm 布局缓存（`getTextContent`）；r9 新增，可选 |

约束：`limits`/`cache` 为浅合并；设 0 表示不限制（仅测试建议）；超限通常抛 `OFD_LIMIT_EXCEEDED` 或降级 warning。

---

## 12. 单位、坐标与生命周期

- 页面/对象空间：**mm**；页面原点由 `PhysicalBox` 归一化。PageInfo、大纲/书签目标、签章戳记边界均为 **mm**。
- Viewport/画布/图片：**设备像素**；颜色 RGBA 0..255。
- 文本层：**px**，由 mm 布局按 `dpi/25.4` 换算；`TextContent.unit` 固定 `'px'`。
- 附件：`AttachmentInfo.size` 为 **byte**；XML 的 `Size` 以 KB 声明，引擎按 ×1024 换算。
- 日期/签章时间：保留 OFD 原文，不做时区推断。
- 矩阵：2×3 列主序 `[a,b,c,d,e,f]`，`x' = a·x + c·y + e`，`y' = b·x + d·y + f`。
- 生命周期：`open → getPage/getPageInfos/getPermissions/getAttachments → getViewport/prepare/render/exportImage/getTextContent → close`；`close` 后不可复用。
- 并发：同一 canvas 渲染串行；不同 canvas 可并行；同一页的 prepare/文本构建并发去重；`close` 中止进行中的渲染/导出/准备/文本任务。
- 画布尺寸与清屏由宿主处理，背景由 CSS 或宿主决定；`page.render` 不填白底。
- v1 不含：径向渐变（warning 降级）、ICC/BlendMode 完整支持、加密文档、签名密码学验证、Node/微信宿主适配器；`page.renderRegion` 暂不实现/无排期。权限/附件/`exportImage.rotation` 已实现（r10）。

---

## 13. 公开类型附录（与 `src/index.ts` 同步）

> 以下每个名字都必须出现在本节；`test/smoke/public-api-doc.test.ts` 会校验。类型只列用途/关键字段，完整字段以源码为准。

### 13.1 API 类与函数

| 名称 | 说明 |
| --- | --- |
| `OFDDocument` | 文档入口；`open/getPage/getPageInfos/getOutline/getBookmarks/getMetadata/getSignatureEntries/getSignedValue/getPermissions/getAttachments/getAttachmentData/close` |
| `OFDPage` | 页面入口；`getSize/getViewport/prepare/getTextContent/render/exportImage` |
| `RenderTask` | 渲染句柄；`promise/cancel` |
| `H5Canvas2DRenderer` | 默认 Canvas 2D 渲染器 |
| `OFDError` | 统一错误类 |
| `isOFDError` | 类型守卫 |
| `toOFDError` | 包装为 `OFDError` |
| `getPageViewport` | mm 页尺寸 → 设备像素 |
| `getPageTransform` | mm → 设备矩阵 |
| `WarningCollector` | warning 去重收集器 |

### 13.2 API 类型与常量

| 名称 | 说明 |
| --- | --- |
| `OFDOpenOptions` | `open` 参数（默认 ZIP/容器工厂，`source` 必填） |
| `OFDOpenFromContainerOptions` | `open` 参数（纯容器，`container` 必填、`source` 可选上下文） |
| `OFDSource` | 文档来源联合类型 |
| `OFDDocumentInfo` | 文档最小视图（当前公共方法未返回，预留） |
| `OFDPageSize` | `PageSize` 别名 |
| `OFDViewport` | `Viewport` 别名 |
| `PageSize` | `{width,height}`，mm |
| `Viewport` | `{width,height,dpi}`，px |
| `ViewportOptions` | `{dpi?}` |
| `PageRenderParameters` | `render` 参数 |
| `PageImageExportOptions` | `exportImage` 参数 |
| `PageImageResult` | `exportImage` 结果 |
| `PageImageFormat` | `'png'\|'jpeg'\|'webp'` |
| `PageImageMime` | 对应 MIME 联合 |
| `EncodeImage` | 编码钩子类型 |
| `CanvasImageEncodeSource` | 带可选编码入口的 canvas |
| `ResourceLimits` | 资源限制 |
| `CacheOptions` | 缓存预算 |
| `DEFAULT_RESOURCE_LIMITS` | 默认资源限制常量 |
| `DEFAULT_CACHE_OPTIONS` | 默认缓存常量 |
| `DEFAULT_DPI` | 96 |
| `MM_PER_INCH` | 25.4 |

### 13.3 平台接口

| 名称 | 说明 |
| --- | --- |
| `ByteSource` | 随机字节源 |
| `FontInput` | 宿主字体来源 |
| `FontInputLoader` | 字体来源字节加载器（`OFDOpenOptions.loadInput`） |
| `FontProvider` | 字体匹配接口 |
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
| `RadialGradientSpec` | 径向渐变（v1 降级） |
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

### 13.7 阅读器 UI API 类型

| 名称 | 说明 |
| --- | --- |
| `OFDDocumentApi` | 文档 UI API 形状（与 `OFDDocument` 声明合并） |
| `OFDPageApi` | 页面 UI API 形状（与 `OFDPage` 声明合并） |
| `PageInfoOptions` | `getPageInfos` 参数（start/count/signal） |
| `PageInfo` | 页尺寸/页区域，mm |
| `DocumentPermissions` | 权限声明（只读，不做 DRM 强制） |
| `AttachmentInfo` | 附件元信息（size 单位 byte） |
| `DestinationType` | 大纲/书签目标类型 |
| `DocumentDestination` | 跳转目标，mm/zoom |
| `OutlineNode` | 大纲节点与子节点 |
| `BookmarkItem` | 书签条目 |
| `SignatureProvider` | 签章 Provider 元数据 |
| `SignatureReferenceInfo` | 签章保护范围引用 |
| `SignatureStampInfo` | 签章戳记位置，mm |
| `SignatureEntryInfo` | 签章 XML 条目元数据 |
| `SignedValueFile` | SignedValue.dat 原始字节 |
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

### 13.8 虚拟容器（v2.0-r1）

| 名称 | 说明 |
| --- | --- |
| `VirtualContainer` | 只读虚拟容器；`packageSize/encrypted/list/has/stat/read/close`。`encrypted=false` 为明文容器（可注入 engine）；`encrypted=true` 为 raw 容器，`read` 返回存仓原始字节，只能用于检查/解密 |
| `VirtualFileMeta` | 包内文件元数据（path/size/compressedSize/compression/origin） |
| `VirtualReadOptions` | `read` 选项（maxBytes/signal/onWarning/verifyChecksum） |
| `VirtualContainerFactory` | `(source: OFDSource) => Promise<VirtualContainer>`，容器归 engine 所有 |
| `openZipVirtualContainer` | 默认 ZIP 容器构造器（raw 容器；加密包 `encrypted=true`，`read` 返回存仓字节，解密后再注入 engine），复用 `ByteSource`/`ZipReader` 限制与 warning |
| `OpenZipVirtualContainerOptions` | 默认 ZIP 容器构造选项（`limits`） |

### 13.9 事件系统类型与类（v1.1-r12）

| 名称 | 说明 |
| --- | --- |
| `OFDEventBus` | 事件总线实现；`on/once/off/emit/removeAllListeners/listenerCount` 与 `addEventListener/removeEventListener` |
| `OFDEventBusOptions` | 总线选项（`onListenerError`） |
| `OFDEventName` / `OFDEventMap` | 14 个事件名与对应载荷的映射 |
| `OFDEventHandler` | 指定事件名的监听器类型 |
| `OFDEventBase` / `OFDOperationEventBase` / `OFDPageOperationEventBase` | 公共字段（`type/timestamp/sequence`、`operationId`、`pageIndex`） |
| `OFDPageEventName` / `OFDPageEventMap` | 页面事件名与载荷子集 |
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

---

## 14. 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1.1-r12 | 2026-10-23 | 新增页面级事件系统：`OFDEventBus`、`document.events` 与 `document/page` 的 `on/once/off/addEventListener/removeEventListener`；`OFDOpenOptions.eventBus/signal`、`getPage(index,{signal})`、`RenderTask.id`；14 个事件与载荷类型；入口校验失败不派发事件，`close:end` 后静默 |
| v2.0-r1 | 2026-10-23 | 新增 `VirtualContainer`/`VirtualFileMeta`/`VirtualReadOptions`/`VirtualContainerFactory`/`openZipVirtualContainer`/`OpenZipVirtualContainerOptions`；`OFDOpenOptions.source` 保持必填，新增 `OFDOpenFromContainerOptions`（`container` 必填、`source` 可选上下文）与 `OFDDocument.open` 重载；新增 `container`（借用）与 `containerFactory`（engine 拥有）；明确 raw/明文容器边界与 `AbortSignal` 透传；默认 ZIP 行为不变 |
| v1.0-r11 | 2026-10-22 | 新增可选 `OFDOpenOptions.loadInput` / `FontInputLoader`：不传时 Web 默认 `url` fetch、`path`/`filePath` 不支持；Node CLI `--font-dir` 注入 `node:fs` loader，真正读取并展开 TTF/OTF/TTC/OTC，按实际 family 匹配；999.ofd `W_FONT_MISSING` 归零。兼容旧版，无行为变化 |
| v1.0-r10 | 2026-10-22 | 同步 P2：`getPermissions`（只读声明，不做 DRM）、`getAttachments`/`getAttachmentData`（原始字节，不解析内容）、`exportImage.rotation`（仅导出方向，90/270 宽高互换）；登记 `W_PERMISSION_FIELD`/`W_ATTACHMENT_FIELD`/`W_ATTACHMENT_RESOURCE`；`page.renderRegion` 暂不实现/无排期且不导出 |
| v1.0-r9 | 2026-10-22 | 同步 P0/P1 阅读器 UI API：getPageInfos/getOutline/getBookmarks/getMetadata/getSignatureEntries/getSignedValue/page.prepare/page.getTextContent；新增 PageInfo/Outline/Bookmark/签章/SignedValue/Metadata/TextContent 类型与 `CacheOptions.textPages`；明确不解析 ASN.1/不暴露 Seal.esl/P2 延后 |
| v1.0-r8 | 2026-10-22 | 初版公开 API 文档：document/page/render/exportImage、平台注入、错误/warning、限制/缓存、类型附录；建立与 `src/index.ts` 的同步检查 |
| v1.0-r7 | 2026-10-22 | 增加 `OFDOpenOptions.createCanvas`（矢量签章/导出） |
| v1.0-r8 | 2026-10-22 | 增加 `page.exportImage` 与 `encodeImage` |

> 修订本文档时，必须同步更新本节与顶部版本/日期，并运行 §0 的同步检查。
