# ofdrw-viewer-engine 公开 API

> 版本：v1.0（契约 r8）  
> 更新：2026-10-22  
> 状态：v1 稳定接口；`page.getTextContent` 属于 v1.1，本文不收录  
> 适用包：`ofdrw-viewer-engine`（唯一包名）  
> 公共入口：`packages/ofdrw-viewer-engine/src/index.ts`  
> 设计依据：`docs/OFD渲染引擎设计方案.md` §15  
> 内部契约：`docs/CONTRACTS.md`（模块间接口，不是调用方文档）  
> 文本层设计：`docs/text-content-api.md`（v1.1，未实现）  
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

**不在本文档范围**：阅读器 UI、缩放/旋转/打印筛选、签章密码学验证、Node/微信宿主适配器、`page.getTextContent()`（v1.1）。

---

## 1. 快速开始

### 1.1 Web（默认 H5 渲染器）

```ts
import { OFDDocument } from 'ofdrw-viewer-engine';

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
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

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
import { OFDDocument } from 'ofdrw-viewer-engine';

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
| `document.close()` | `Promise<void>` | 关闭并释放缓存/句柄，幂等 |
| `page.getSize()` | `PageSize` | 页尺寸，单位 mm |
| `page.getViewport(options?)` | `Viewport` | 指定 DPI 的设备像素尺寸 |
| `page.render(params)` | `RenderTask` | 绘制到宿主 canvas context |
| `page.exportImage(options?)` | `Promise<PageImageResult>` | 整页离屏编码导出 |
| `RenderTask.promise` | `Promise<void>` | 渲染完成/失败/取消 |
| `RenderTask.cancel()` | `void` | 请求取消，可重复调用 |
| `H5Canvas2DRenderer` | class | 默认 Canvas 2D 渲染器，可显式构造 |
| `getPageViewport(size, options?)` | `Viewport` | 纯函数，同 `page.getViewport` |
| `getPageTransform(area, dpi?)` | `Matrix` | mm→设备像素变换 |
| `OFDError` / `isOFDError` / `toOFDError` | class/function | 统一错误 |
| `WARNING_CODES` / `WarningCollector` | const/class | warning 码与去重收集 |
| `DEFAULT_RESOURCE_LIMITS` / `DEFAULT_CACHE_OPTIONS` | const | 默认限制/缓存预算 |

---

## 3. `OFDDocument`

### 3.1 `OFDDocument.open(options: OFDOpenOptions): Promise<OFDDocument>`

打开一个 OFD 包。打开阶段只读取 `OFD.xml`、`Document.xml`、页树和资源索引；页面内容、字体、图片按需加载。

| 参数 | 类型 | 默认 | 说明与约束 |
| --- | --- | --- | --- |
| `source` | `OFDSource` | 必填 | 文档字节来源，见 §3.2 |
| `documentIndex` | `number` | `0` | 多文档包时的文档索引；按带 `DocRoot` 的 `DocBody` 顺序计数；必须为非负整数，越界抛 `OFD_INVALID_PACKAGE` |
| `limits` | `Partial<ResourceLimits>` | `DEFAULT_RESOURCE_LIMITS` | 资源限制覆盖；浅合并；单位见 §11 |
| `cache` | `Partial<CacheOptions>` | `DEFAULT_CACHE_OPTIONS` | 缓存预算覆盖；浅合并；单位见 §11 |
| `supplementaryFonts` | `FontInput[]` | 无 | 宿主补充字体；引擎不内置 CJK 字体；按需用于缺字/缺字体回退 |
| `fontProvider` | `FontProvider` | 无 | 宿主按需提供字体；优先于 `supplementaryFonts` 的匹配流程见 §8.1 |
| `imageDecoders` | `ImageDecoderPlugin[]` | 无 | JBIG2/TIFF 等插件；PNG/JPEG/GIF 内置路径优先 |
| `onWarning` | `(warning: OFDWarning) => void` | 无（不打印） | 非致命 warning 回调；同一 `(code,pageIndex,objectId)` 去重；回调抛错不影响渲染 |
| `strictImageCtm` | `boolean` | `true` | 图片缺 CTM 时：`true` 按 identity 1×1；`false` 铺满 Boundary |
| `layerOrder` | `'document' \| 'type'` | `'type'` | `type` 按设计方案图层顺序；`document` 严格 XML 顺序 |
| `createCanvas` | `(width,height)=>Canvas2DLike` | 浏览器默认 | 临时画布工厂，单位像素；默认 H5 渲染器、矢量签章嵌套 OFD、`exportImage` 使用；显式 `renderer` 不覆盖 `exportImage` |
| `encodeImage` | `EncodeImage` | 浏览器 Canvas 原生 | 图片编码钩子；Node/自定义 canvas 必须注入；未注入且 Canvas 无 `convertToBlob/toBlob` 时 `exportImage` 抛 `OFD_RENDERER_UNSUPPORTED` |
| `renderer` | `Renderer` | 内部 `H5Canvas2DRenderer` | 页面绘制扩展点；只接管 `page.render`，`exportImage` 仍用文档级 `createCanvas` |

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

### 3.4 `document.getPage(pageIndex: number): Promise<OFDPage>`

| 参数 | 类型 | 约束 |
| --- | --- | --- |
| `pageIndex` | `number` | 从 0 开始的整数；`0 <= pageIndex < pageCount` |

返回页句柄；页尺寸已按“页 → 模板 → CommonData → A4”回退链解析。越界抛 `OFD_PAGE_NOT_FOUND`；文档已关闭抛 `OFD_CLOSED`；页面 XML/资源损坏抛对应 `OFD_*`。

### 3.5 `document.close(): Promise<void>`

关闭文档，释放 ZIP/XML/字体/图片缓存与图像句柄；可重复调用。进行中的渲染/导出会先被中止，并等待其结束；`close()` 不向调用方抛错。

约束：`close()` 后再调用 `getPage`/`render`/`exportImage` 以 `OFD_CLOSED` 拒绝；`close()` 不应与尚未 `await` 的 `render` 竞争同一 canvas 的后续绘制。

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

- **不设置 canvas 宽高、不清屏、不填背景**；这些由宿主负责。
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
| `background` | `string \| null` | `'#ffffff'` | CSS 颜色；PNG 传 `null` 得透明；JPEG/WebP 的 `null` 按白底 |
| `signal` | `AbortSignal` | 无 | 中止后 `OFD_ABORTED`；不返回部分结果 |

返回：

```ts
interface PageImageResult {
  data: Uint8Array;      // 编码后的图片字节，归调用方所有
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;         // 设备像素
  height: number;        // 设备像素
  dpi: number;           // 实际输出 DPI
}
```

约束：

- 需要文档级 `createCanvas`；Node/自定义 Canvas 还需要 `encodeImage`。
- 像素超限 `OFD_CANVAS_TOO_LARGE`；画布尺寸不符 `OFD_CANVAS_SIZE_MISMATCH`；缺画布/编码器/格式不支持/编码失败 `OFD_RENDERER_UNSUPPORTED`；取消 `OFD_ABORTED`；关闭 `OFD_CLOSED`。
- 不包含阅读器缩放/旋转/裁剪/多页拼接；区域导出、多页导出不在 v1。
- 导出结果不自动释放；`data` 归调用方，编码中间 canvas 由 engine 释放。

### 4.6 `RenderTask`

| 成员 | 类型 | 说明 |
| --- | --- | --- |
| `promise` | `Promise<void>` | 完成 resolve；取消/失败 reject `OFDError` |
| `cancel()` | `void` | 请求取消；可重复调用；不抛错 |

`cancel()` 后 `promise` 以 `OFD_ABORTED` 拒绝；取消是协作式的，已进入的同步绘制会在下一个对象/边界退出。

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
- `fontProvider` 返回多个候选时按顺序尝试；`null` 表示无匹配。
- `FontInput.family` 用于诊断/别名匹配；真实字体名以字体文件为准。
- 字体解析失败抛 `OFD_FONT_PARSE` 的场景限于引擎必须加载的字体；可降级时只 warning。

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
| `W_FONT_MISSING` | 缺少字体，使用回退/替代字体 |
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
| `W_ANNOT_EMPTY` | 注释外观为空/索引缺失 |
| `W_JBIG2_DECODE` | JBIG2 解码失败/超限，跳过 |

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

约束：`limits`/`cache` 为浅合并；设 0 表示不限制（仅测试建议）；超限通常抛 `OFD_LIMIT_EXCEEDED` 或降级 warning。

---

## 12. 单位、坐标与生命周期

- 页面/对象空间：**mm**；页面原点由 `PhysicalBox` 归一化。
- Viewport/画布/图片：**设备像素**；颜色 RGBA 0..255。
- 矩阵：2×3 列主序 `[a,b,c,d,e,f]`，`x' = a·x + c·y + e`，`y' = b·x + d·y + f`。
- 生命周期：`open → getPage → getViewport → render/exportImage → close`；`close` 后不可复用。
- 并发：同一 canvas 渲染串行；不同 canvas 可并行；`close` 中止进行中的渲染/导出。
- 背景/清屏/画布尺寸由宿主负责；`page.render` 不填白底。
- v1 不含：径向渐变（warning 降级）、ICC/BlendMode 完整支持、加密文档、签名密码学验证、Node/微信宿主适配器、文本内容 API（v1.1）。

---

## 13. 公开类型附录（与 `src/index.ts` 同步）

> 以下每个名字都必须出现在本节；`test/smoke/public-api-doc.test.ts` 会校验。类型只列用途/关键字段，完整字段以源码为准。

### 13.1 API 类与函数

| 名称 | 说明 |
| --- | --- |
| `OFDDocument` | 文档入口；`open/getPage/close` |
| `OFDPage` | 页面入口；`getSize/getViewport/render/exportImage` |
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
| `OFDOpenOptions` | `open` 参数 |
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

---

## 14. 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1.0-r8 | 2026-10-22 | 初版公开 API 文档：document/page/render/exportImage、平台注入、错误/warning、限制/缓存、类型附录；建立与 `src/index.ts` 的同步检查 |
| v1.0-r7 | 2026-10-22 | 增加 `OFDOpenOptions.createCanvas`（矢量签章/导出） |
| v1.0-r8 | 2026-10-22 | 增加 `page.exportImage` 与 `encodeImage` |

> 修订本文档时，必须同步更新本节与顶部版本/日期，并运行 §0 的同步检查。