# OFD 渲染引擎跨模块契约（v1.0，T1 冻结）

> 适用范围：`ofdrw-viewer-engine` v1（Web 优先）。
> 依据：`docs/OFD渲染引擎设计方案.md` v0.4 第 6/8/10/14/15/19 节。
> 冻结时间：T1 完成时。冻结后本文件与下列公共契约文件只读；变更必须先由架构负责人（architect）评估并同步 captain。

## 1. 冻结范围与变更规则

本文件冻结以下内容：

- pnpm workspace、包名、目录骨架、构建/测试命令；
- 各模块职责、依赖方向、文件所有权；
- 跨模块公共类型与函数签名；
- 错误码/warning 码；
- 并行开发规则与测试目录约定。

冻结文件（其他成员只读，不得直接修改）：

| 文件 | 内容 |
| --- | --- |
| `src/common/types.ts` | 矩阵/颜色/路径/样式/渐变/底纹/图片/Viewport 公共类型 |
| `src/common/display-list.ts` | `DrawCommand`、`DisplayList` |
| `src/model/types.ts` | OFD 文档/页/对象/资源/注释/模板/颜色空间模型 |
| `src/style/types.ts` | `ResolvedStyle` |
| `src/renderer/types.ts` | `Renderer`、`CanvasRenderingContext2DLike`、Canvas 工厂入参 |
| `src/platform/byte-source.ts` | `ByteSource` |
| `src/platform/image-decoder.ts` | `ImageDecoderPlugin`、`ImageDecoder` |
| `src/platform/font-provider.ts` | `FontInput`、`FontProvider` |
| `src/xml/types.ts` | `XmlNode`、`XmlParser` |
| `src/api/types.ts` | 打开参数、渲染参数、资源限制、缓存预算 |
| `src/errors.ts` | `OFDError`、`OFDErrorCode` |
| `src/warnings.ts` | `WarningCode`、`OFDWarning`、`WarningCollector` |
| `src/index.ts` | 公共导出面（T12 只可在不破坏既有导出的前提下追加） |

**变更流程**：开发中发现契约缺口 → 发消息给 architect，说明“缺什么/为什么/建议签名” → architect 修改冻结文件并更新本文件 → 重新跑 typecheck + smoke → 通知相关成员。不得自行改冻结文件，不得用 `as any`、二次解码、隐藏字段绕过契约。

## 2. 包、目录与命令

- 包名只允许 `ofdrw-viewer-engine`。禁止 `@ofdrw/engine`、`ofdrw-engine`、`ofdrw/engine` 等别名。
- workspace：`packages/*`、`examples/*`。
- T1 架构 smoke 测试位于仓库根 `test/smoke/`（任务契约路径）；各开发任务的单测位于 `packages/ofdrw-viewer-engine/test/<module>/`（如 `test/common`、`test/model`）；QA 黄金图/回归位于 `packages/ofdrw-viewer-engine/test/golden|e2e|acceptance/`。
- vitest 根为仓库根，`include` 同时覆盖 `test/**` 与 `packages/ofdrw-viewer-engine/test/**`；CLI 过滤 `test/smoke` 可命中两者。
- 测试通过包名 `ofdrw-viewer-engine` 引入源码（vitest alias 指向 `src/index.ts`）。
- 测试产物写入仓库根 `test/.artifacts/<task-id>/`（或对应包内 `test/.artifacts/`），不得提交。
- 根命令：

| 命令 | 语义 |
| --- | --- |
| `pnpm install` | 安装 workspace 依赖 |
| `pnpm typecheck` | 对所有包执行 `tsc --noEmit` |
| `pnpm test` | 运行引擎全部 vitest |
| `pnpm test:smoke` | 只跑 `test/smoke` |
| `pnpm test:golden` | 只跑 `test/golden`（无测试时通过） |
| `pnpm build` | 构建引擎 ESM+CJS+d.ts（及后续 examples） |
| `pnpm demo:web` | 启动 `examples/web` 的 Vite dev server（T13） |

- 引擎源码只能用 ES2022 + 严格 TS；`verbatimModuleSyntax`、`isolatedModules` 开启。类型导入必须 `import type`。
- 不在共享工作区启动长期服务；`demo:web` 仅由验收/演示按需启动，用完关闭。

## 3. 模块职责与所有权

按设计方案的 9 层职责展开为 12 个源码目录（common/container/xml/model/resource/style/font/image/render/renderer/platform/api），职责与所有权如下：

| 模块 | 职责 | 实现 owner | 主要文件 |
| --- | --- | --- | --- |
| `common/` | 矩阵、颜色、纯函数、DisplayList 数据结构；无 I/O | T2（`matrix.ts` 等）；T1 冻结类型 | `types.ts`、`matrix.ts`、`color.ts`、`display-list.ts`、`not-implemented.ts` |
| `container/` | ByteSource 适配、ZIP 随机读取、包内路径安全 | T2 | `byte-source.ts`、`zip-reader.ts`、`path.ts` |
| `xml/` | saxes 封装、DOM 化、属性/数字解析、warning | T2 | `parser.ts`、`numbers.ts` |
| `model/` | OFD.xml/Document.xml/Page/Content/Res/Annotations 解码、页树、资源 ID | T3 | `types.ts`、`decode.ts`、`page-tree.ts`、`resource-id.ts` |
| `resource/` | 资源索引、页级作用域合并、LRU 缓存 | T3 | `types.ts`、`store.ts`、`cache.ts` |
| `style/` | DrawParam 继承、颜色/线型结算、`PaintSpec` 生成 | T3 | `types.ts`、`draw-param.ts`、`resolve.ts` |
| `font/` | fontkit 封装、字体匹配、字形轮廓提取、轮廓缓存 | T4 | `types.ts`、`face.ts`、`glyph.ts` |
| `image/` | 图片格式识别、尺寸读取、JBIG2/TIFF 插件适配 | T6 | `format.ts`、`jbig2.ts`、`tiff.ts` |
| `render/` | 准备阶段与绘制管线、路径/裁剪/图片/底纹/文字/块/页编排 | T7（路径/裁剪/图片/底纹/块/DisplayList）、T10（prepare/page/object/annotation） | `path.ts`、`clip.ts`、`image.ts`、`paint.ts`、`block.ts`、`display-list.ts`、`prepare.ts`、`page.ts`、`object.ts`、`annotation.ts`、`text.ts`（T4）、`gouraud.ts`（T5） |
| `renderer/` | H5 Canvas2D 默认渲染器、RecordingRenderer、渲染器抽象 | T5 | `types.ts`、`canvas2d.ts`、`recording.ts` |
| `platform/` | 宿主注入接口：字节源、字体、图片解码 | T1 冻结接口；T4/T6 使用 | `byte-source.ts`、`font-provider.ts`、`image-decoder.ts` |
| `api/` | `OFDDocument`/`OFDPage`/`RenderTask`、打开/缓存/取消/错误映射 | T12 | `document.ts`、`page.ts`、`render-task.ts`、`source.ts`、`viewport.ts`、`types.ts` |
| `examples/web/` | 最小 Web 验证页 | T13 | `index.html`、`src/main.ts` 等 |

文件所有权规则：成员只修改自己任务 inScope 内的文件。`src/common/matrix.ts` 由 T2 实现与维护；T1 已提供基线实现，T2 可改实现但不得改签名。`render/text.ts` 归 T4；`render/gouraud.ts` 归 T5；`render/` 其余文件归 T7/T10。相邻文件如确需改动，先发消息给 owner 与 architect。

## 4. 依赖方向（硬约束）

```text
common           （无运行时模块依赖；仅允许对 model/style 的 type-only 前向引用）
  ↑
model  ← container/xml
  ↑
resource
  ↑
style
  ↑
render  ← font（render/text） / image（render/image） / renderer/types
  ↑
api

renderer ──→ common（只允许 common + 自身；不依赖 model/style/render/api）
platform ──→ common（接口独立，供 api/font/image 注入）
```

- `container`/`xml` 只依赖 `common`、`errors`、`warnings`。
- `model` 不产生对 `render`/`renderer`/`api` 的运行时依赖。
- `style` 不依赖 `render`/`renderer`/`api`；颜色解析只产出 `PaintSpec`，不得创建 Canvas 对象。
- `render` 不 import 具体渲染器实现，只能 import `renderer/types`。
- `renderer` 不 import `model`/`style`/`render`/`api`；渲染器只认 `common` 的 `DrawStyle`、`PaintSpec`、`Matrix`、`ImageHandle`。
- `api` 可以依赖下层全部模块，但下层不得反向依赖 `api`。
- 禁止运行时循环依赖。`common/types.ts` 对 `PageBlock`、`ResolvedStyle` 的引用，以及 `model/types.ts` 对 `DisplayList`、`ResolvedStyle` 的引用必须是 `import type`，已由 `test/smoke/import-boundaries.test.ts` 守护。
- 引擎核心（common/model/resource/style/render/font/image/xml/api）不得 import `node:*`、`fs`/`path` 等 Node 内置模块，不得引用 `document`/`window` 等 DOM 全局；平台差异只能通过 `platform/` 注入。`renderer` 默认工厂可以检测 `globalThis.document`，但不得直接 import Node/原生 canvas。

## 5. 公共 API（包根导出）

只有 `src/index.ts` 是包根公共入口。以下为稳定导出（T12 可追加，不破坏）：

```ts
// 类
OFDDocument.open(options: OFDOpenOptions): Promise<OFDDocument>
OFDDocument#pageCount: number
OFDDocument#getPage(index: number): Promise<OFDPage>
OFDDocument#close(): Promise<void>

OFDPage#index: number
OFDPage#getSize(): PageSize                 // mm
OFDPage#getViewport(options?: ViewportOptions): Viewport // px
OFDPage#render(params: PageRenderParameters): RenderTask
OFDPage#exportImage(options?: PageImageExportOptions): Promise<PageImageResult>

RenderTask#promise: Promise<void>
RenderTask#cancel(): void

H5Canvas2DRenderer(options?: H5Canvas2DRendererOptions)

// 纯函数
getPageViewport(size: PageSize, options?: ViewportOptions): Viewport
getPageTransform(area: Box, dpi?: number): Matrix

// 常量
MM_PER_INCH = 25.4
DEFAULT_DPI = 96
DEFAULT_RESOURCE_LIMITS
DEFAULT_CACHE_OPTIONS
WARNING_CODES

// 错误
OFDError、isOFDError、toOFDError
```

公共类型包括 `OFDOpenOptions`、`OFDSource`、`PageRenderParameters`、`PageImageExportOptions`、`PageImageResult`、`PageImageFormat`、`PageImageMime`、`CanvasImageEncodeSource`、`EncodeImage`、`ResourceLimits`、`CacheOptions`、`FontInput`、`FontProvider`、`ImageDecoderPlugin`、`Renderer`/`Canvas2DLike`/`CanvasRenderingContext2DLike`、`Viewport`、`Matrix`、`Box`、`DrawStyle`、`PaintSpec`、`ResolvedPaint`、`PatternSpec`、`PatternPaint`、`DisplayList`、`DrawCommand`、`OFDWarning`、`OFDErrorCode`、`WarningCode` 等。

**不导出** `CanvasFactory`（渲染器内部结构）。自定义画布的两个公共入口：

- 直接构造渲染器时传 `H5Canvas2DRendererOptions.createCanvas`；
- 使用默认 H5 渲染器或 `page.exportImage` 时传 `OFDOpenOptions.createCanvas`（v1.0-r7/r8，见 §5.1、§5.2）。

### 5.1 `OFDOpenOptions.createCanvas`（v1.0-r7，r8 扩展）

```ts
interface OFDOpenOptions {
  /** 临时画布工厂；供默认 H5、嵌套矢量章与 exportImage 使用；单位像素。 */
  createCanvas?: (width: number, height: number) => Canvas2DLike;
}
```

- **向后兼容**：字段可选；未提供时 `OFDDocument.open` 仍创建 `new H5Canvas2DRenderer()`，H5CanvasFactory 继续按 `globalThis.document.createElement('canvas')` → `OffscreenCanvas` 兜底；页面 render 行为与 r6 一致。
- **接线**：`OFDDocument.open` 未收到 `renderer` 时，把该函数作为 `H5Canvas2DRendererOptions.createCanvas` 传给内部 H5 渲染器；最终由 `H5CanvasFactory.create(width,height)` 使用，并统一写入像素宽高。`CanvasFactory` 仍不导出，宿主只接触 `Canvas2DLike`。
- **`exportImage` 复用（r8）**：`page.exportImage` 不经过 `Renderer`，而是直接用 `OFDOpenOptions.createCanvas` 创建整页离屏 canvas。显式 `renderer` 只接管 `page.render`；即使传了自定义 renderer，Node 宿主仍必须提供 `createCanvas`，否则导出走 document/OffscreenCanvas 兜底。
- **优先级**：页面 render 以显式 `renderer` 为准；`exportImage` 始终以 `createCanvas` 为准，不读取 `H5Canvas2DRendererOptions.createCanvas`。
- **矢量签章嵌套渲染**：t55 打开 `Seal.esl`/`SignedValue.dat` 内嵌 OFD 时，必须把同一 `createCanvas` 继续传给嵌套 `OFDDocument.open`；父/子文档共用宿主工厂，不另建 DOM/Node 工厂，也不把 Canvas 暴露给 engine 渲染层。
- **缺省回退**：浏览器/Worker 未注入时仍走 document/OffscreenCanvas；两者都不可用时由 H5CanvasFactory 抛既有 `OFD_RENDERER_UNSUPPORTED`，不新增错误码。

### 5.2 页面图片导出（v1.0-r8）

```ts
export type PageImageFormat = 'png' | 'jpeg' | 'webp';
export type PageImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface PageImageExportOptions {
  dpi?: number;                 // 默认 96；非有限/<=0 回退 96
  format?: PageImageFormat;     // 默认 png
  quality?: number;             // jpeg/webp 0..1，默认 0.92；png 忽略
  background?: string | null;   // 默认 #ffffff；png null 透明；jpeg/webp null 视为白
  signal?: AbortSignal;
}

export interface PageImageResult {
  data: Uint8Array;
  mime: PageImageMime;
  width: number;                // 设备像素
  height: number;               // 设备像素
  dpi: number;
}

export interface CanvasImageEncodeSource extends Canvas2DLike {
  convertToBlob?(options?: { type?: string; quality?: number }): Promise<Blob>;
  toBlob?(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
}

export type EncodeImage = (
  canvas: CanvasImageEncodeSource,
  format: PageImageFormat,
  quality: number,
) => Promise<Uint8Array>;

// OFDOpenOptions
encodeImage?: EncodeImage;      // 不传时浏览器默认 convertToBlob/toBlob；Node 宿主注入

// OFDPage
exportImage(options?: PageImageExportOptions): Promise<PageImageResult>;
```

- **整页**：使用 `page.getViewport({ dpi })` 的整个 viewport；`width = Math.ceil(viewport.width)`、`height = Math.ceil(viewport.height)`，输出完整页面内容，不含阅读器缩放/旋转/裁剪/UI。`width*height > limits.maxCanvasPixels` 时在创建画布前抛 `OFD_CANVAS_TOO_LARGE`。
- **画布**：用 `OFDOpenOptions.createCanvas(width,height)` 创建独立离屏 canvas；创建后写入并校验尺寸，不足/不符抛 `OFD_CANVAS_SIZE_MISMATCH`。不经过 `Renderer`；显式 `renderer` 只影响 `page.render`。Node/小程序必须注入 `createCanvas`（或依赖 document/OffscreenCanvas 兜底）；未注入且无兜底时抛 `OFD_RENDERER_UNSUPPORTED`。
- **背景**：默认 `#ffffff`；先在 identity 变换下填满背景，再调用 `page.render`（其 `M_page` 覆盖 CTM）。PNG 传 `background: null` 时先 `clearRect` 保证透明（复用画布也透明）；JPEG/WebP 不支持 alpha，`null` 按白底处理。非法 CSS 颜色按白底处理，不沿用旧 `fillStyle`。
- **格式/质量**：`format` 默认 `png`；`quality` 仅 JPEG/WebP 使用，0..1，默认 `0.92`；PNG 忽略质量。MIME 固定映射为 `image/png`/`image/jpeg`/`image/webp`。`encodeImage` 的 `quality` 参数：PNG 传 1，JPEG/WebP 传规范化后的值。
- **编码**：优先 `encodeImage(canvas,format,quality)`；未提供时浏览器默认优先 `canvas.convertToBlob({type,quality})`，否则 `canvas.toBlob(cb,type,quality)`；不使用 `toDataURL`。编码器返回必须是非空 `Uint8Array`。编码器缺失、格式不支持、抛错/空结果/类型错误统一抛 `OFD_RENDERER_UNSUPPORTED`，原始异常放 `cause`。engine 不新增编码运行时依赖。
- **取消**：开始、render 前后、encode 前后检查 `signal`；中止抛 `OFD_ABORTED`，不返回部分结果。`encodeImage` 无 signal 参数，已开始的编码不可中断，但结束后仍以取消状态拒绝。
- **close**：调用前文档已关闭抛 `OFD_CLOSED`；导出期间 close 与 render 竞争时按现有 close 语义以 `OFD_CLOSED` 拒绝，绝不返回编码结果。`close()` 可重复。
- **错误**：`page.render` 的尺寸/像素/资源限制/取消错误原样传播；编码阶段不新增错误码，不裸抛第三方异常。结果 `data` 归调用方，engine 不缓存。
- **导出面**：`PageImageExportOptions`、`PageImageResult`、`PageImageFormat`、`PageImageMime`、`CanvasImageEncodeSource`、`EncodeImage` 与 `OFDPage#exportImage` 属于 T15b 实现面；`src/index.ts` 由 T12/T15b 在不破坏既有导出的前提下追加。

## 6. 单元/分层签名索引

### 6.1 container

```ts
// byte-source.ts
class ArrayBufferSource/BlobSource/HttpRangeSource/NodeFileSource/WechatFileSource implements ByteSource

// zip-reader.ts
ZipReader.open(source: ByteSource, limits?: Partial<ZipLimits>): Promise<ZipReader>
#listEntries(): readonly ZipEntryMeta[]
#getEntry(path: string): ZipEntryMeta | undefined
#hasEntry(path: string): boolean
#readEntry(path, options?: ReadEntryOptions): Promise<Uint8Array>
#close(): void

// path.ts
normalizePackagePath(path: string): string
resolvePackagePath(baseDir: string, relative: string): string
assertSafePackagePath(path: string): void
dirnameOf(path: string): string
```

### 6.2 xml

```ts
parseXml(xml: string | Uint8Array, options?: XmlParseOptions): XmlNode
getAttr(node: XmlNode, name: string): string | undefined
getRequiredAttr(node: XmlNode, name: string): string
getChild(node: XmlNode, name: string): XmlNode | undefined
getChildren(node: XmlNode, name: string): XmlNode[]
getText(node: XmlNode): string
toNumber(raw, fallback, onBad?): number
toNumberArray(raw, fallback, onBad?): number[]
toBoolean(raw, fallback, onBad?): boolean
```

### 6.2.1 ST_Array 与 `g` 压缩组（TextCode.DeltaX/DeltaY）

OFD 的 `ST_Array` 是空白/逗号分隔的数值数组，支持 `g <count> <value>` 压缩组：

- 语义：`g N V` 表示把数值 `V` 重复展开 `N` 次；
- 示例：`0 g 3 5 2` → `0,5,5,5,2`；`g 3 3.1305` → `3.1305, 3.1305, 3.1305`；
- `N` 必须是正整数；展开后总长度上限 `100_000`（`MAX_EXPANDED_ARRAY_LENGTH`），超限按 `W_BAD_NUMBER` 处理并停止展开；
- 非法的 `g` 组（缺 count/value、count≤0、value 非数值）按 `W_BAD_NUMBER` 跳过，不得让整页失败；合法的 `g` 组不能当坏 token 丢弃；
- `g` 只作用于数值数组，不改变 XML 其他属性。

实现分层约定：

- `xml/numbers.ts` 的 `toNumberArray` 在 XML 解析层完成 `g` 展开（T2）；
- `TextCode.DeltaX/DeltaY` 的消费方必须**先展开为数值队列，再按字符位置消费**（T4）：
  - 字符位置按 Unicode 码点计数（`Array.from(text)`），不按 UTF-16 `string.length`；
  - `DeltaX[i]` 是从第 i 个字符推进到第 i+1 个字符的步进；最后一个值只描述最后一个字位，多余值忽略并 warning；
  - 数量不足时后面的字符回退字体 advance；缺失/全 0 时按字体 advance × `Size/upem` × `HScale`；
  - `DeltaY` 同理，竖排常用。

### 6.3 model / resource / style

```ts
// decode.ts（所有函数末位均有可选 DecodeOptions，见 §7.5）
decodeOfdRoot(root: XmlNode): OfdRootInfo
decodeDocument(root, filePath, options?): DocumentModel
decodePageContent(root, pageId, filePath, options?): PageModel
decodePageResources(root, filePath, options?): ResourceDefinitionSet
decodeAnnotations(root, pageIds, options?): Annotation[]
decodeAnnotationsIndex(root, baseDir, options?): DecodedAnnotationsIndex
attachPageTree(model: DocumentModel, tree: PageTree): DocumentModel
flattenPageTree(pagesRoot, baseDir, options?): PageTree

// resource
ResourceStore#getFont/getImage/getDrawParam/getComposite/getPattern(id): ... | undefined
ResourceStore#createPageScope(input: CreatePageScopeInput): PageResourceScope
LruCache<K,V>#get/set/delete/clear/stats

// style
createDefaultStyle(options?): ResolvedStyle
StyleResolver#resolveStyle(input: ResolveStyleInput): ResolvedStyle
flattenDrawParam(...): ...
resolvePaint(...): PaintSpec | undefined
```

### 6.4 render / renderer / font / image

```ts
// 准备阶段
preparePage(input: PreparePageInput): Promise<PreparedPageBundle>
drawPage(prepared: PreparedPageBundle, renderer, canvasContext, viewport, options?): void

// 准备阶段契约（T6b；loader 由 T12 注入）
interface PreparePageInput {
  page: PageModel;
  resources: PageResourceScope;
  loader: PreparePageLoader;
  strictImageCtm?: boolean;
  signal?: AbortSignal;
  onWarning?: WarningHandler;
}
interface PreparePageLoader {
  loadFontFaces(resources: readonly FontResource[]): Promise<ReadonlyMap<ResourceId, FontFaceSet>>;
  decodeImage(resource: ImageResource): Promise<DecodedImage>;
  loadTemplatePage(ref: TemplateRef): Promise<PageModel>;
  loadAnnotations(page: PageModel): Promise<readonly Annotation[]>;
}
interface PreparedPageBundle {
  page: PreparedPage;                         // styles + annotationBlocks
  templates: readonly PageModel[];            // 按 page.templates 顺序
  fonts: ReadonlyMap<ResourceId, FontFaceSet>;
  images: ReadonlyMap<ResourceId, DecodedImage>; // 主图/替换图/蒙版
  blocks: ReadonlyMap<string, IndependentBlock>;  // composite/pattern，key=资源 ID
}

// 绘制管线
parseAbbreviatedData(data: string): PathCommand[]
emitPathCommands(renderer: Renderer, commands: readonly PathCommand[]): void
replayDisplayList(renderer, list, resolveImage?): void   // 可选 resolver 物化 deferred ImageHandle
drawPathObject(context: PathDrawContext, object: PathObject, style: ResolvedStyle): void
applyClips(context: ClipContext, clips): void
computeImageTransform(object: ImageObject, strictImageCtm: boolean): Matrix
drawImageObject(context: ImageDrawContext, object: ImageObject, style: ResolvedStyle): void
// ImageDrawContext { renderer; image; mask?; substitutionImage?; substitutionMode?: 'auto'|'always'|'never'; dpi?; strictImageCtm?; smoothing?; onWarning? }
createPaintBinder(renderer, context?): PaintBinder
buildIndependentBlock(input: BuildBlockInput, buildDisplayList): IndependentBlock
drawIndependentBlock(context, block): void
buildAnnotationBlocks(annotations: readonly Annotation[], context: AnnotationBuildContext): IndependentBlock[]
drawAnnotationBlocks(renderer: Renderer, binder: PaintBinder, blocks: readonly IndependentBlock[]): void
layoutText(object: TextObject, faces: FontFaceSet): TextLayout
drawTextObject(context: TextDrawContext, object: TextObject, style: ResolvedStyle): void
rasterizeMeshShading(request: GouraudRasterRequest): ImageDataLike

// 渲染器
interface Renderer { beginPage/endPage/save/restore/setTransform/transform/translate/
  multiplyAlpha/clear/beginPath/moveTo/lineTo/quadraticCurveTo/cubicCurveTo/rect/
  closePath/clip/fill/stroke/createImage/drawImage/beginGroup/endGroup/close }

// 字体
createFontFace(data: Uint8Array, options?): FontFace
createFontFaces(data: Uint8Array, options?): FontFace[]
disposeFontFace(face): void
GlyphOutlineCache#get(face, glyphId): PathCommand[] | null
glyphToObjectPath(glyph, unitsPerEm, size, hScale): PathCommand[]

// 图片
detectImageFormat(data: Uint8Array, path?: string): ImageFormat
readImageSize(data: Uint8Array, format: ImageFormat): ImageHeaderSize | null
decodeJbig2/decodeTiff(...): Promise<...>
```

## 7. 已裁决的跨模块契约（T1 冻结）

### 7.1 坐标与矩阵

- 矩阵为列向量约定 `[a,b,c,d,e,f]`，点变换 `x' = a*x + c*y + e`，`y' = b*x + d*y + f`。
- 页面矩阵：`M_page = S(dpi/25.4) × T(-PhysicalBox.x, -PhysicalBox.y)`。
- 对象矩阵：`M_obj = M_page × M_parent × CTM`；文字/图片局部变换按设计方案 §10 顺序右乘。
- 注释放置：`M_annot = M_page × T(Appearance.Boundary.x, Appearance.Boundary.y)`。
- 页面/对象长度在模型中统一为 mm；OFD 的 `0.3528 mm` 单位在解码时换算，渲染层不再做单位猜测。
- 矩阵工具只在 `common/matrix.ts` 实现，任何模块不得复制一份。

### 7.2 文字：只走字形轮廓

- 渲染器 `Renderer` 不提供 `fillText`/`strokeText`/`measureText`。
- 文字必须由 `font/` 取字形轮廓，转成 `PathCommand[]`，再由 `render/text.ts` 发路径命令。
- 无 cmap 的剥离子集必须支持按 `CGTransform.Glyphs` 的显式 gid 取轮廓；不得依赖 `glyphForCodePoint`。
- 缺字体/缺字形分别上报 `W_FONT_MISSING`/`W_GLYPH_MISSING`，并按设计方案降级（不静默失败）。

### 7.3 底纹（Pattern）tile 流程

样式层不依赖 `render`/`model` 的具体实现，因此 `PatternSpec` 携带解析底纹所需的结构：

```ts
PatternSpec {
  patternId?: string;        // 底纹资源 ID
  width, height, xStep, yStep, reflect, relativeTo, ctm?;
  cell: PageBlock;           // CellContent
  styleRoot: ResolvedStyle;  // tile 内对象继承起点
  tile?: DisplayList;        // 绑定前可空
}
```

流程：

1. 样式层 `resolvePaint()` 填 `patternId` + `cell` + `styleRoot`；
2. 准备阶段按 `styleRoot` 结算 cell 内对象，构建 `IndependentBlock`（`source: 'pattern-cell'`，必须带 `displayList`），放入 `PreparedPageBundle.blocks`；
3. `createPaintBinder(renderer, { patterns: { resolvePatternTile(patternId) } })` 把 tile 绑定为 `PatternPaint`；
4. 渲染器只消费 `PatternPaint`，不解析 `Pattern` 资源 XML。

### 7.4 注释块

- `Annotation.appearance` 为 `PageBlock`；`boundary?: Box` 对应 `Appearance.Boundary`（mm）。
- 准备阶段把每个可见注释转成 `IndependentBlock`：
  - `source: 'annotation'`；
  - `boundary` = Appearance.Boundary；
  - `displayList` 必填，且不含放置平移；
  - `visible=false` 或空 Appearance 的注释不进入 `PreparedPage.annotationBlocks`，后者上报 `W_ANNOT_EMPTY`。
- 绘制：`save(); translate(boundary.x, boundary.y); drawIndependentBlock(...); restore()`。

### 7.5 DecodeOptions（末位可选参数）

所有 `decode*` 与 `flattenPageTree` 把 `options?: DecodeOptions` 放在参数末位，保持既有参数兼容：

```ts
interface DecodeOptions {
  onWarning?: (warning: OFDWarning) => void;
  colorSpaces?: ReadonlyMap<ResourceId, ColorSpaceDef>;
  defaultColorSpaceId?: ResourceId;
}
```

约定：

- 不得用隐藏字段、全局状态或二次解码绕过 options；
- warning 必须带稳定 code 与上下文（pageIndex/objectId/resourceId），由 `warnings.ts` 统一去重；
- 资源 XML 解码时填充 `ResourceIndex.colorSpaces`；颜色值解析优先用 `defaultColorSpace`（资源 ID），缺省才回退 RGB。

### 7.6 文档级模板与注释索引

```ts
interface TemplatePageDef { id: ResourceId; baseLoc: string; zOrder?: 'Background'|'Body'|'Foreground' }

interface CommonData {
  pageArea?: Box; publicRes?: string[]; documentRes?: string[]; defaultRes?: string;
  maxUnitId?: ResourceId;
  defaultColorSpaceId?: ResourceId;                 // CommonData/DefaultCS
  templatePages?: Record<ResourceId, TemplatePageDef>;
}

interface DocumentModel {
  // ... id/version/docRoot/ofdFile/pages/pageCount/commonData
  templatePages: Record<ResourceId, TemplatePageDef>; // 文档级模板索引
  annotationsFile?: string;                           // Annotations.xml 包内路径
  pageAnnotIndex: Record<ResourceId, string>;         // PageID → FileLoc
}
```

- T3 解码 Document.xml/CommonData 时建立 `templatePages`；`PageModel.templates` 仍为 `TemplateRef`（ID + loc），通过 `DocumentModel.templatePages` 解析。
- T3 在文档解码阶段只解析 `Annotations.xml` 索引，不加载页面注释内容；`PageModel.annotationFile` 由 `pageAnnotIndex[page.id]` 填充。
- T10 在 prepare 中调用 `loader.loadAnnotations(page)` 懒加载注释；T12 实现 loader（读取 `PageModel.annotationFile`）并返回文件顺序的 `Annotation[]`，T10 负责构建注释块。

### 7.7 资源颜色空间

```ts
interface ResourceIndex {
  fonts/images/drawParams/compositeGraphicUnits/patterns: ReadonlyMap<...>;
  colorSpaces: ReadonlyMap<ResourceId, ColorSpaceDef>;
  defaultColorSpace?: ResourceId;   // DefaultCS 资源 ID
}
```

颜色必须查表解析；禁止按 RGB 猜测颜色空间。

### 7.8 DisplayList 与命令

- `DisplayList` 是目标无关的绘制命令序列，`bounds` 为对象空间 mm。
- `DisplayListBuilder` 只记录命令；`build()` 返回快照，后续追加不影响已构建列表。
- 命令中的矩阵为 `Matrix`；填充/描边携带已结算 `DrawStyle` + `ResolvedPaint`。
- 渲染器实现负责把 `DrawCommand` 映射到 Canvas2D；不允许把 OFD 模型对象塞进 DisplayList。

### 7.9 图片与模板字段

- `ImageObject.substitution?: ResourceId`、`ImageObject.imageMask?: ResourceId`：对应 XML `Substitution`/`ImageMask`，两者均为 `ST_RefID`（GB/T 33190—2016 CT_ImageObject），不是布尔。
  - `substitution` 是高分辨率替换图资源 ID；T6a 通过 `ImageDrawContext.substitutionMode?: 'auto' | 'always' | 'never'`（默认 `auto`）与 `dpi?: number` 选择：auto 时 dpi>200 用替换图，否则主图；always/never 强制；
  - `imageMask` 是蒙版图片资源 ID；解码为 mask `ImageHandle` 后由 context 传给渲染器，H5 在内部 scratch 走 `destination-in`，engine 不接触 scratch；
  - 替换图/蒙版都按单位正方形 + CTM 绘制。
- `TemplateRef.zOrder?: 'Background' | 'Body' | 'Foreground'`：页面 `Template/@ZOrder` 优先于 `TemplatePage/@ZOrder`；页面引用缺省为 **Background**（GB/T 33190—2016 默认值，设计 10.4）。`Body` 仅为设计兼容扩展，只有显式出现时才使用；`PageModel.templates` 保持 ID + 可选 loc，loc 通过 `DocumentModel.templatePages` 解析。
- `CommonData.templatePages` 与 `DocumentModel.templatePages` 使用 `Record<ResourceId, TemplatePageDef>`，避免数组线性查找。

### 7.10 渲染器能力子集

`CanvasRenderingContext2DLike` 是 Canvas2D 的 14.1 子集，故意不含文字 API、不含 `filter`/`letterSpacing` 等新 API。实现时：

- `setTransform/transform/translate/multiplyAlpha` 要正确维护状态栈；
- `fill/stroke` 只接受 `ResolvedPaint`；
- `beginGroup/endGroup` 用离屏画布实现混合/裁切，结束再合成；
- 图片通过 `createImage/ drawImage` 走 `ImageHandle`；
- 不直接依赖 DOM；默认工厂用 `globalThis.document.createElement('canvas')`，Node 由 `createCanvas` 注入。
- `page.exportImage` 的整页离屏 canvas 同样由文档级 `OFDOpenOptions.createCanvas` 提供，不经过 `Renderer`；编码由 `OFDOpenOptions.encodeImage` 或浏览器 `convertToBlob`/`toBlob` 完成。
- `createImageData?(width,height)` / `putImageData?(data,dx,dy)` 是可选像素读写能力，供 Gouraud/LaGouraud 软件光栅化使用；缺失时 H5 渲染器降级为平均色并上报 `W_GOURAUD_APPROX`，最小 Canvas mock 不强制实现。
- **画布状态唯一入口**：engine/绘制管线只能通过 `Renderer` 方法（`setTransform/transform/translate/multiplyAlpha/save/restore/clip/...`）改变画布状态，禁止直接操作 `canvasContext` 的 CTM、`globalAlpha`、`globalCompositeOperation` 或 clip。`H5Canvas2DRenderer` 自行维护 CTM/alpha/clip 栈，用于 group AABB 求交、底纹像素密度和 shading 设备空间光栅化；`beginPage` 后由 renderer 统一接管并重置状态，`endPage` 恢复。

### 7.11 准备阶段运行时（T6b）

`PreparedPage` 保持 model 形状（`page/styles/annotationBlocks`）；所有运行时资源放入显式 `PreparedPageBundle`，不使用 WeakMap：

- `templates`：`loader.loadTemplatePage` 按 `page.templates` 顺序解码，供 drawPage 按图层类型合并；
- `fonts`：`loader.loadFontFaces` 并行加载，key 为 Font 资源 ID；
- `images`：`loader.decodeImage` 并行解码，key 为 Image 资源 ID（含主图/Substitution/ImageMask）；`ImageHandle` 在 drawPage 内按 Renderer 创建并缓存，prepare 不碰 Renderer；
- `blocks`：composite/pattern 的 `IndependentBlock`（displayList 必填），key 为资源 ID；注释块仍在 `page.annotationBlocks`；
- 递归收集 composite/pattern 内部字体/图片，深度 16、循环检测；单资源失败 warning 后跳过，不整页失败；
- `loader` 由 T12 用 document/font/image 服务实现，render 不解析 XML、不 import container。


### 7.12 显示列表中的图像与嵌套块

`DisplayList` 保持目标无关，不新增 `group` 命令；以下为 render 内部实现约定（不改变公共字段）：

- **图像 deferred 句柄**：prepare 构建 block 显示列表时还没有 Renderer，无法得到真实 `ImageHandle`。仅允许 render 内部的 block DisplayList 放入带有效 `width/height` 的 deferred 占位句柄，并通过 render 内部 `WeakMap<ImageHandle, DeferredImagePlan>` 关联主图/替换图/蒙版与 `ImageObject`；`DeferredImagePlan` 不进入 `common` 类型。任何公开回放/自定义渲染器路径必须先 resolver 物化，不能把占位句柄暴露出去。
- **回放期物化**：`replayDisplayList(renderer, list, resolveImage?)` 增加可选 resolver；遇到 `drawImage` 时对 `image` 与 `mask` 调用 resolver。resolver 在 `drawPage` 闭包内按 renderer 缓存 `renderer.createImage(DecodedImage)` 结果；Substitution 的 auto/always/never 与 dpi 在 resolver 中决定，不使用 prepare 阶段未知的 dpi。不得修改或按 renderer 重写原 DisplayList；用 resolver 保持 list 不可变。
- 占位句柄必须带有效像素宽高；没有 resolver 就到达 `renderer.drawImage` 视为实现错误（assert/warning），不得静默把假句柄交给渲染器。
- **嵌套 composite**：不允许用“逐子对象 `multiplyAlpha`”近似嵌套 composite 的组 alpha；重叠区域会叠加变深，isolated/blend/mask 也无法表达。规则：
  - 嵌套 composite 的 alpha=255 且无需 isolation/blend/mask 时，可 flatten 进父 DisplayList（结果等价）；
  - alpha<1、isolated、blend、mask 或子块自身需要 group 时，标记该 block 为“绘制期递归”，由 `drawIndependentBlock`/`drawObject` 在 draw 期递归并 `beginGroup`，组 alpha 只在 `endGroup` 乘一次；该 block 的父 DisplayList 复用降级为 best-effort，正确性优先；
  - 外层 block 的 alpha 仍按 §11.7 在 `drawIndependentBlock` 统一开 group，不能预先乘到父 list 的子命令上。

## 8. 错误码与 warning 码

### 8.1 错误码（`OFDErrorCode`）

| code | 触发 |
| --- | --- |
| `OFD_INVALID_PACKAGE` | ZIP/OFD 包结构非法、缺 OFD.xml |
| `OFD_ENTRY_NOT_FOUND` | 必需条目不存在 |
| `OFD_UNSUPPORTED_COMPRESSION` | 非 0/8 压缩方法或加密 |
| `OFD_ENCRYPTED` | 加密条目/文档 |
| `OFD_XML_PARSE` | XML 解析失败 |
| `OFD_PAGE_NOT_FOUND` | 页索引越界 |
| `OFD_CANVAS_TOO_LARGE` | render/exportImage 的 viewport 超过 `maxCanvasPixels` |
| `OFD_CANVAS_SIZE_MISMATCH` | 传入 canvas 尺寸与 viewport 不一致，或 exportImage 工厂返回尺寸不符 |
| `OFD_RENDERER_UNSUPPORTED` | 渲染器/导出缺少必需能力；exportImage 无画布/编码器、格式不支持或编码失败 |
| `OFD_ABORTED` | 渲染/打开/exportImage 被取消 |
| `OFD_CLOSED` | 文档已关闭后继续 render/exportImage |
| `OFD_LIMIT_EXCEEDED` | 资源限制超限 |
| `OFD_FONT_PARSE` | 字体解析失败 |
| `OFD_IMAGE_DECODE` | 图片解码失败 |

约定：公共 API 的 rejected promise 只抛 `OFDError`；第三方异常用 `toOFDError` 包装并保留 `cause`。

### 8.2 warning 码（`WarningCode`）

`W_FONT_MISSING`、`W_GLYPH_MISSING`、`W_IMAGE_DECODE`、`W_UNSUPPORTED_PAINT`、`W_UNSUPPORTED_CLIP`、`W_BAD_NUMBER`、`W_BAD_PATH`、`W_DUPLICATE_RESOURCE`、`W_COMPOSITE_DEPTH`、`W_PATTERN_LIMIT`、`W_ZERO_BOUNDARY`、`W_PHYSICALBOX_ORIGIN`、`W_IMAGE_NO_CTM`、`W_NEGATIVE_BOUNDARY`、`W_LAYER_ORDER`、`W_BLEND_MODE`、`W_RADIAL_UNSUPPORTED`、`W_GOURAUD_APPROX`、`W_ANNOT_EMPTY`、`W_JBIG2_DECODE`。

约定：warning 不中断渲染；同一 `(code,pageIndex,objectId)` 由 `WarningCollector` 去重；未安装 handler 时静默。

## 9. 并行开发规则

1. **只改自己 inScope**；需要跨文件修改先发消息给 owner 与 architect。
2. 冻结文件只读；新增公共字段/签名必须由 architect 更新并通知。
3. 不新增依赖（T1 已完成依赖表）；如确需，先报告 captain，由 captain 决策。
4. 不启动长期服务；Web 验证页按需启动，测试结束关闭。
5. 不执行 `git add/commit/push`；所有 git 操作由 captain 在里程碑统一执行。
6. 测试放自己的目录（开发：`packages/ofdrw-viewer-engine/test/<module>/`；QA：`test/golden|e2e|acceptance`）；不要修改他人的测试；产物放仓库根 `test/.artifacts/<task-id>/`。
7. 公共模块实现必须通过 `test/smoke/import-boundaries.test.ts`；新增 import 前先看依赖方向。
8. 错误码/warning 码是公共契约，新增需同步 `errors.ts`/`warnings.ts` 与本文件。
9. 跨模块联调以本文件与冻结类型为准；口头约定无效。
10. 完成时提交 `changedPaths`、真实 `commandsRun`、`acceptanceResults`；验证命令必须实际执行。

## 10. 测试目录与黄金图

- 架构 smoke：仓库根 `test/smoke/`（完整 AST 边界检查）与 `packages/ofdrw-viewer-engine/test/smoke/`（包内快速回归）双层守护。
- 单元测试：`packages/ofdrw-viewer-engine/test/<module>/`。
- 黄金图/回归：`packages/ofdrw-viewer-engine/test/golden|e2e|acceptance/`；fixture/基准图放对应 `test/fixtures/` 或 `test/.fixtures/`（不提交大文件时写脚本生成）。
- Node 端画布：`@napi-rs/canvas` + `pngjs` + `pixelmatch`，由 QA 建 harness；引擎核心不得直接依赖 Node canvas。
- 浏览器端：H5 `CanvasRenderingContext2DLike` 适配 `CanvasRenderingContext2D`；Web 验证页只做打开/翻页/缩放/渲染。
- 55 对真实回归样本位于仓库根 `ofd_pdf_match/`，只读；QA 生成 `docs/回归报告.md`。
- 像素阈值、忽略区域、字体回退策略由 QA 在 `docs/测试方案.md` 固化；引擎行为变更需同步基线。

## 11. M0 结论摘要

详见 `docs/M0-技术验证.md`。要点：

- 自研 ZIP 读取路径可行：`1.ofd` 28 条目，`Document.xml` 299→646 bytes，native `DecompressionStream('deflate-raw')` 与 fflate 字节一致。
- fontkit 2.0.4 可解析内嵌 TTF/CFF；无 cmap 剥离子集必须按显式 gid 取轮廓（样本 gid=11 有 11 条命令）。
- `@napi-rs/canvas` 1.0.13 可将字形轮廓绘成 PNG（320×240，3079 bytes，已人工确认“中”字形正确）。
- 55 个样本共 60 个字体条目，55 个可解析、5 个扩展名与内容不符（`Unknown font format`）；字体加载必须容错并上报 warning，不能假定扩展名可信。
- 样本无 TTC；TTC 选面留待 T4 用合成 fixture 覆盖。

## 12. 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1.0-r8 | T15a | 新增 `OFDPage.exportImage(options)` 与 `OFDOpenOptions.encodeImage(canvas,format,quality)`；整页 + dpi + 白底/PNG 透明；浏览器默认 convertToBlob/toBlob，Node 注入，不新增编码依赖；错误码复用 OFD_CANVAS_TOO_LARGE/OFD_CANVAS_SIZE_MISMATCH/OFD_RENDERER_UNSUPPORTED/OFD_ABORTED/OFD_CLOSED。 |
| v1.0-r7 | T14m | 新增可选 `OFDOpenOptions.createCanvas`（`Canvas2DLike`），用于默认 H5 渲染器与矢量签章嵌套 OFD 离屏渲染；未注入保持 document/OffscreenCanvas 兜底。r8 起也供 `exportImage` 使用。 |
| v1.0-r6 | T6c 复审 | 修正 §7.9 模板 `ZOrder` 口径：页面 `Template/@ZOrder` 优先，页面引用缺省 `Background`（标准/设计 10.4）；`Body` 仅显式使用 |
| v1.0-r5 | T6b | 明确 displayList deferred 图像句柄/replay resolver 与嵌套 composite group 规则；不新增公共字段，group 不进入 DisplayList |
| v1.0-r4 | T6b | 明确准备阶段运行时：`PreparePageLoader`（字体/图片/模板/注释）注入，`PreparedPageBundle` 携带 page/templates/fonts/images/blocks，`drawPage` 接收 bundle；`PreparedPage` 保持 model 形状，不用 WeakMap |
| v1.0-r3 | T2/T4 | 记录 ST_Array `g N V` 重复展开语义（`0 g 3 5 2` → `0,5,5,5,2`）与 DeltaX/DeltaY “先展开、再按码点消费”约定 |
| v1.0-r2 | T6a | 依据 GB/T 33190—2016 CT_ImageObject 与设计方案 8.2，纠正 `ImageObject.substitution/imageMask` 为可选 `ResourceId`（`ST_RefID`）；T6a 通过 `ImageDrawContext.substitutionMode/dpi` 实现 auto/always/never |
| v1.0-r1 | T1 | 按 T3 反馈补齐：`PatternSpec.cell/styleRoot/tile`、`IndependentBlock.boundary/displayList`、`CommonData.defaultColorSpaceId`、`DocumentModel.templatePages/pageAnnotIndex/annotationsFile`、`ResourceIndex.colorSpaces/defaultColorSpace`、`DecodeOptions` 末位参数、`decodeAnnotationsIndex`、`flattenPageTree` options；`ImageObject.substitution/imageMask` 定为 boolean；`TemplateRef.zOrder` 改为可选 |
| v1.0 | T1 | 初始冻结：工程骨架、模块接口、错误/warning 码、并行规则 |
