---
name: ofdrw-viewer-engine
description: Render OFD documents to Canvas with @ofdrw/ofdrw-viewer-engine. Use this skill whenever a task involves opening, previewing, rendering, or exporting .ofd pages in JavaScript/TypeScript, including browser pages, Web Workers/OffscreenCanvas, Node.js tools, Electron/Tauri, or WeChat Mini Programs. Covers page rendering, content filtering by layer/template/annotation type, thumbnails, PNG/JPEG/WebP export, searchable text layers with pixel coordinates, outlines/metadata/attachments/signatures, document metadata extensions (docType, documentHeader, packageInfo, commonData), attachment queries by name/format/size with chunked saveAttachment, DPI/canvas sizing, virtual container/encrypted-document injection, host-provided document sources (arraybuffer/blob/custom ByteSource, engine does not fetch URLs or read files), platform hooks (createCanvas, encodeImage, imageDecoders, custom ByteSource, FontProvider), cancellation, and debugging warnings such as missing fonts or images. Also use for OFD 预览、按内容层过滤、OFD 转图片、文字层坐标、engine 不联网/来源委托, or when wiring a custom Canvas host. See the bundled API.md for exact signatures and defaults.
---

# OFD 页面渲染引擎（@ofdrw/ofdrw-viewer-engine）

把 OFD 包解析为页面模型，再绘制到宿主提供的 Canvas 2D 上下文。引擎只负责“页面内容 → Canvas”，不负责阅读器缩放/滚动、页面背景、打印、DRM 或签章验签。

完整签名、默认值、返回结构与错误码见 [API.md](./API.md)。本文件讲接入、环境适配和常见任务。

适用于 Web、Worker、Node.js、Electron/Tauri、微信小程序的页面显示、缩略图、导出、文字层与文档元数据读取。不适用：批量转图片交给 [ofdrw-viewer-cli](../../ofdrw-viewer-cli/skills/SKILL.md)；完整阅读器 UI 用 `@ofdrw/ofdrw-viewer-ui`；签章验签、证书与加密文档解密不在引擎范围。

## 安装

```bash
npm install @ofdrw/ofdrw-viewer-engine
```

```ts
import { OFDDocument, OFDError, isOFDError, getPageViewport, WarningCollector } from '@ofdrw/ofdrw-viewer-engine';
```

CDN 直出：`dist/ofdrw-viewer-engine.min.js`（或未压缩的 `dist/ofdrw-viewer-engine.js`）是自包含 IIFE，挂到 `window.OFDRWViewer`，无需打包器；通过 `<script>` 引入后直接使用同名 API。

排查问题时先查引擎版本，反馈缺陷时一并提供：

```ts
import { getVersion } from '@ofdrw/ofdrw-viewer-engine';

console.log(getVersion()); // 例如 0.1.0
```

`VERSION` 常量与 `getVersion()` 返回相同值；两者内置于产物，不依赖 `package.json`，浏览器、Node.js 与小程序可用。

支持浏览器（含 Web Worker）、Node.js（>= 22）、Electron/Tauri 的渲染进程或主进程、微信小程序。核心不绑定 DOM/Node；宿主需提供 Canvas 2D、图片解码、图片编码（导出时）和字体来源。

## 5 分钟跑通（浏览器）

```ts
import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';

// file 来自 <input type="file"> 或拖拽得到的 File。
const doc = await OFDDocument.open({
  source: { kind: 'blob', blob: file }, // File 也是 Blob
  onWarning: (w) => console.warn(w.code, w.message),
});

try {
  const page = await doc.getPage(0);
  const viewport = page.getViewport({ dpi: 144 });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d')!;

  // 引擎不设置画布尺寸、不清屏、不填背景；重置宽高会清空画布，背景交给 CSS。
  await page.render({ canvasContext: ctx, viewport }).promise;
} finally {
  await doc.close();
}
```

浏览器主线程通常不需要任何平台钩子。**engine 不联网、不读本地文件**：`source` 只接受 `arraybuffer`/`blob` 或宿主实现的 `custom ByteSource`；URL 与本地路径要先由宿主读成字节，浏览器 `File`/`Blob` 可直接作为 `blob` 来源，也可读成 `arraybuffer`。

## 网络与文件获取委托（engine 侧）

engine 不调用 `fetch`、不读文件，也不内置任何网络或路径策略；URL、本地文件先由宿主读成 `ArrayBuffer`/`Blob`，或实现随机读的 `ByteSource` 后以 `custom` 传入。字体同理：engine 只接受宿主读好的 `{ data }`，需要按需加载时由宿主实现 `FontProvider.match()` 并返回 `{ data }`。因此取消、鉴权、Cookie、代理、重试、进度与 Range 都由宿主掌握，engine 只消费字节；完整对照表见[下一节](#来源与字体由宿主提供engine-不联网)，设计细节见[《网络获取委托设计》](../../../docs/网络获取委托设计.md)。

浏览器把 URL 读成 `arraybuffer`：

```ts
const response = await fetch(url, {
  headers: { Authorization: `Bearer ${token}` },
  signal, // 取消由宿主传给 fetch
});
if (!response.ok) throw new Error(`HTTP ${response.status}`);

const doc = await OFDDocument.open({
  source: { kind: 'arraybuffer', data: await response.arrayBuffer() },
});
```

Node.js 用 `fs.open` 实现 `custom ByteSource`（按需随机读，`close()` 幂等）：

```ts
import { open } from 'node:fs/promises';
import { OFDDocument, type ByteSource } from '@ofdrw/ofdrw-viewer-engine';

const handle = await open('/path/to/file.ofd', 'r');
const { size } = await handle.stat();
let closed = false;

const byteSource: ByteSource = {
  size, // 总字节数，单位 byte
  async read(offset, length) {
    const buffer = new Uint8Array(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead); // 越界截断
  },
  async close() {
    if (closed) return; // 幂等：engine 关闭容器时与宿主主动关闭都可能调用
    closed = true;
    await handle.close();
  },
};

const doc = await OFDDocument.open({
  source: { kind: 'custom', source: byteSource },
});
// doc.close() 时 engine 会关闭容器并调用 byteSource.close()。
```

字体只传宿主读好的字节，或用 `FontProvider.match()` 按需返回字节：

```ts
import { readFile } from 'node:fs/promises';
import type { FontInput, FontProvider } from '@ofdrw/ofdrw-viewer-engine';

// 一次性读好：defaultFonts / supplementaryFonts 只接受 { data }
const font: FontInput = {
  data: new Uint8Array(await readFile('/fonts/NotoSansSC-Regular.otf')),
  family: 'Noto Sans SC',
};

// 按需读取：match() 内由宿主读文件或网络，engine 只收 { data }
const FONT_FILES: Record<string, string> = {
  'Noto Sans SC': '/fonts/NotoSansSC-Regular.otf',
};
const fontProvider: FontProvider = {
  async match(request) {
    const path = request.familyName ? FONT_FILES[request.familyName] : undefined;
    if (!path) return null;
    return { data: new Uint8Array(await readFile(path)), family: request.familyName };
  },
};
```

> 取消、鉴权、Cookie、代理、重试、下载进度与 Range 都由宿主负责；engine 不接触 `fetch` 或文件句柄，只通过 `ByteSource.read()` 取字节。

## 来源与字体由宿主提供（engine 不联网）

engine 只消费“已经可读的字节 / 随机读源”，网络与文件读取全部由宿主负责。这样鉴权、Cookie、代理、重试、Range、取消和下载进度都在宿主手里，engine 不做平台分支。

### 文档来源

| 场景 | 宿主做法 | 传给 engine |
| --- | --- | --- |
| 浏览器 URL | `fetch(url, { headers, signal })` → `arrayBuffer()` | `{ kind: 'arraybuffer', data }` |
| 浏览器大文件/需要 Range | 宿主实现 HTTP `ByteSource`（按需 `read` + 取消 + 鉴权） | `{ kind: 'custom', source }` |
| Node / Electron 主进程 | `fs.readFile`，或 `fs.open` + 随机读 | `{ kind: 'arraybuffer', data }` 或 `{ kind: 'custom', source }` |
| 微信小程序 | `wx.downloadFile` 得到临时路径 → `wx.getFileSystemManager().readFile/read` | `{ kind: 'arraybuffer', data }` 或 `{ kind: 'custom', source }` |

```ts
// 浏览器：先下载再打开
const response = await fetch(url, { headers: { Authorization: token } });
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const doc = await OFDDocument.open({
  source: { kind: 'arraybuffer', data: await response.arrayBuffer() },
});

// 大文件：只实现随机读，engine 按需取 ZIP 区间
const source: ByteSource = {
  size: totalBytes,
  async read(offset, length) {
    const end = Math.min(offset + length, totalBytes);
    return new Uint8Array(await (await fetch(url, { headers: { Range: `bytes=${offset}-${end - 1}` } })).arrayBuffer());
  },
};
```

`ByteSource` 的完整字段（含可选 `ready()`/`close()`）见 [API.md §8.3](./API.md#83-bytesource)。

### 字体来源

engine 不内置任何字体，也不会去下载字体。内嵌 `FontFile` 仍会解析；缺字体时按 `fontProvider` → `defaultFonts` → `supplementaryFonts` 的顺序找替代，全部失败才跳过对应文字并上报 `W_FONT_MISSING`。

```ts
// 一次性准备：宿主读成字节
const doc = await OFDDocument.open({
  source: { kind: 'arraybuffer', data: bytes },
  defaultFonts: [{ data: await readFile('NotoSansSC-Regular.otf') }],
  supplementaryFonts: [{ data: await readFile('SourceHanSerif.otf'), family: 'Source Han Serif SC' }],
});

// 按需准备：在 match() 内读网络/本地文件，engine 只收字节
const fontProvider: FontProvider = {
  async match(request) {
    const url = pickFontUrl(request); // 由宿主决定字体映射
    if (!url) return null;
    return { data: await (await fetch(url)).arrayBuffer(), family: request.familyName };
  },
};
```

优先使用 `FontProvider` 处理按需字体，避免一次性把大量字体读进内存。字体解析失败只 warning，不会中断打开。

### 取消、鉴权与进度

- 打开与取页都接受 `AbortSignal`；取消以 `OFD_ABORTED` 拒绝并派发 `document:open:abort`/`page:load:abort`。
- 鉴权头、Cookie、代理、重试、Range 与进度全部由宿主在读取字节/实现 `ByteSource` 时完成。
- 大文件不要整包读入内存；用 `custom ByteSource` 按需读取，并让 `read()` 响应取消。

### 排障

1. 先给 `onWarning` 打印 `code/message/pageIndex`，区分“缺字体/缺图/格式降级”。
2. 空白或缺失：检查画布宽高是否 `>= Math.ceil(viewport)`、`document:open:end` 是否已到、`await task.promise` 是否被忽略。
3. 文字丢失：确认 `defaultFonts`/`supplementaryFonts` 的 `data` 非空、格式可解析，或 `FontProvider.match()` 返回了字体字节。
4. 图片缺失：Node/小程序检查 `imageDecoders` 是否覆盖实际格式；浏览器检查该格式是否可原生解码。
5. 导出失败：Node/小程序必须注入 `createCanvas` 与 `encodeImage`；导出的画布尺寸必须与请求完全一致。

## 打开容器与加密文档

engine 不解密。加密文档先用 [@ofdrw/ofdrw-viewer-crypto](../../ofdrw-viewer-crypto/skills/SKILL.md) 解密，再把明文容器或明文字节交给引擎：

```ts
import { OFDDocument, type VirtualContainer } from '@ofdrw/ofdrw-viewer-engine';

// container 由宿主按 crypto SKILL 的流程解密得到（encrypted=false）；
// 解密 API 与参数以 crypto 包文档为准，engine 不关心其内部实现。
declare const container: VirtualContainer;

// engine 借用容器：不关闭它；doc.close() 后由宿主关闭
const doc = await OFDDocument.open({ container });
try {
  const page = await doc.getPage(0);
  // ...渲染
} finally {
  await doc.close();
  await container.close();
}
```

- 明文容器必须 `encrypted=false` 且 `read()` 返回明文；`encrypted=true` 会被拒绝（`OFD_ENCRYPTED`）。
- `container` 是宿主借用语义，engine 不关闭；`containerFactory` 返回的容器归 engine 所有。
- 只想检查容器结构（条目列表、加密标记）时，可先 `openZipVirtualContainer(source)` 拿到原始包容器，再交给解密流程。
- 不要用引擎做密码学验签或证书解析；签章相关 API 只返回 XML 元数据与原始字节。

## 环境适配

核心不绑定 DOM 与 Node.js。各环境只需提供 Canvas、图片解码/编码与字体：

| 环境 | 必需注入 |
| --- | --- |
| 浏览器主线程 | 无（默认工厂可用） |
| Web Worker | `createCanvas`（`OffscreenCanvas`）+ `encodeImage`（导出时） |
| Node.js | `createCanvas` + `imageDecoders` + `encodeImage`；字体按需提供 |
| 微信小程序 | `createCanvas` + 图片解码插件；字体按需提供（`exportImage` 另需编码器） |
| Electron / Tauri | 渲染进程同浏览器；主进程需 `@napi-rs/canvas` 一类实现 |

### Web Worker / OffscreenCanvas

Worker 里没有 `document`，用 `OffscreenCanvas` 作为画布工厂；渲染完成后把像素或编码结果传回主线程。

```ts
import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';

const doc = await OFDDocument.open({
  source: { kind: 'arraybuffer', data: bytes },
  createCanvas: (width, height) => new OffscreenCanvas(width, height),
  encodeImage: async (canvas, format, quality) => {
    const blob = await (canvas as OffscreenCanvas).convertToBlob({ type: `image/${format}`, quality });
    return new Uint8Array(await blob.arrayBuffer());
  },
});

const page = await doc.getPage(0);
const viewport = page.getViewport({ dpi: 144 });
const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
self.postMessage({ image: canvas.transferToImageBitmap() });
```

### Node.js

Node 没有 DOM、`OffscreenCanvas` 与浏览器图片解码/编码，必须注入画布、图片解码器和编码器；字体同样由宿主读取：

```ts
import { readFile } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { OFDDocument, type Canvas2DLike, type ImageDecoderPlugin } from '@ofdrw/ofdrw-viewer-engine';

const imageDecoders = (['png', 'jpeg', 'webp'] as const).map((format): ImageDecoderPlugin => ({
  format,
  async decode(bytes) {
    const image = await loadImage(Buffer.from(bytes));
    return { width: image.width, height: image.height, data: image, kind: 'source' };
  },
}));

const doc = await OFDDocument.open({
  source: { kind: 'arraybuffer', data: await readFile('sample.ofd') },
  createCanvas: (width, height) => createCanvas(width, height) as unknown as Canvas2DLike,
  imageDecoders,
  defaultFonts: [{ data: await readFile('/fonts/NotoSansSC-Regular.otf') }],
  encodeImage: async (canvas, format, quality) => {
    const nodeCanvas = canvas as unknown as ReturnType<typeof createCanvas>;
    if (format === 'png') return nodeCanvas.toBuffer('image/png');
    if (format === 'jpeg') return nodeCanvas.toBuffer('image/jpeg', quality);
    return nodeCanvas.toBuffer('image/webp', quality);
  },
});
```

- 大文件不要整包读入：用 `node:fs/promises` 的 `open` + `handle.read` 实现 `custom ByteSource`，按需读取 ZIP 区间（接口见 [API.md §8.3](./API.md#83-bytesource)）。
- PNG/JPEG/WebP/BMP 没有浏览器原生解码，不注入 `imageDecoders` 会得到 `W_IMAGE_DECODE` 并跳过该图；GIF/JBIG2/TIFF 有内置纯 JS 解码器，按需动态加载，宿主插件优先。
- 导出画布与 `createCanvas` 返回的宽高必须完全一致；编码器必须返回非空字节。

### 微信小程序

小程序没有 `document`、全局 `OffscreenCanvas`，也没有可自动扫描的系统字体。用 `wx.createOffscreenCanvas` 提供临时画布，用 `wx.getFileSystemManager()` 读取 OFD/字体字节，用 `canvas.createImage()` 注入图片解码：

```ts
import { OFDDocument, type Canvas2DLike, type ImageDecoderPlugin } from '@ofdrw/ofdrw-viewer-engine';

const fs = wx.getFileSystemManager();
const imageCanvas = wx.createOffscreenCanvas({ type: '2d', width: 1, height: 1 });

const readFile = (filePath: string) =>
  new Promise<ArrayBuffer>((resolve, reject) =>
    fs.readFile({ filePath, success: (res) => resolve(res.data as ArrayBuffer), fail: reject }),
  );

function imageDecoder(format: string): ImageDecoderPlugin {
  return {
    format,
    decode: (bytes) =>
      new Promise((resolve, reject) => {
        const image = imageCanvas.createImage();
        image.onload = () =>
          resolve({ width: image.width, height: image.height, data: image, kind: 'source' });
        image.onerror = reject;
        const base64 = wx.arrayBufferToBase64(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        );
        image.src = `data:image/${format};base64,${base64}`;
      }),
  };
}

const doc = await OFDDocument.open({
  source: { kind: 'arraybuffer', data: await readFile(`${wx.env.USER_DATA_PATH}/sample.ofd`) },
  createCanvas: (width, height) =>
    wx.createOffscreenCanvas({ type: '2d', width, height }) as unknown as Canvas2DLike,
  imageDecoders: (['png', 'jpeg', 'webp'] as const).map(imageDecoder),
  supplementaryFonts: [{ data: await readFile(`${wx.env.USER_DATA_PATH}/fonts/fallback.ttf`) }],
});
```

渲染到页面 `<canvas type="2d">`，再用 `wx.canvasToTempFilePath({ canvas, fileType: 'png' })` 导出：

```ts
// canvas 为 <canvas type="2d"> 节点。
const page = await doc.getPage(0);
const viewport = page.getViewport({ dpi: 96 });
canvas.width = Math.ceil(viewport.width);
canvas.height = Math.ceil(viewport.height);
await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
```

- `wx.canvasToTempFilePath` 只接受 `<canvas type="2d">` 组件实例，不接受 `OffscreenCanvas`；小程序通常直接渲染到组件 canvas 再截图，不要直接调用 `page.exportImage`（它需要离屏画布的可编码入口）。
- 大文件用 `fs.open`/`fs.fstat`/`fs.read` 实现 `custom ByteSource`（`fs.read` 的 `offset` 是缓冲区偏移，`position` 才是文件偏移），避免整包读入内存。
- base64 Data URI 适合中小图（需要基础库 >= 2.11.0）；大图先写临时文件，再设 `image.src = tempFilePath`。
- 字体没有系统扫描：用 `data` 显式提供或实现 `FontProvider.match()`；缺字体只 warning，不中断渲染。
- engine 不读微信文件：没有 `wechat-file` 来源；用 `arraybuffer` 或 `custom ByteSource`。`wx.createOffscreenCanvas` 需基础库 >= 2.7.0。

### Electron / Tauri

- Electron 渲染进程等同浏览器主线程，无需额外钩子；主进程用 Node 方案（`@napi-rs/canvas` 或原生 canvas 实现）。
- Tauri 的 WebView 等同浏览器；Rust 侧渲染需由宿主提供 Canvas 桥接与图片编码。
- 所有文件/网络读取仍在宿主侧完成，engine 只收字节。

## 常用任务

### 页面列表与缩略图

```ts
const infos = await doc.getPageInfos({ start: 0, count: 20 }); // 只读尺寸，不解码内容
for (const info of infos) {
  const page = await doc.getPage(info.index);
  const viewport = page.getViewport({ dpi: 36 });
  // 按 viewport 分配缩略图画布后 page.render(...)
}
```

### 翻页与取消

```ts
const task = page.render({ canvasContext: ctx, viewport, signal });
cancelButton.onclick = () => task.cancel(); // promise 以 OFD_ABORTED 拒绝
await task.promise;
```

同一 canvas 的渲染自动串行，快速翻页无需自己加锁；不同 canvas 可并行。

### 导出图片

```ts
const png = await page.exportImage({ dpi: 144 });                 // PNG，白底
const jpeg = await page.exportImage({ format: 'jpeg', quality: 0.9 });
const transparent = await page.exportImage({ format: 'png', background: null });
await upload(png.data); // Uint8Array
```

`exportImage` 复用文档 `renderer` 绘制导出画布，自定义 `renderer` 会影响导出；Node/小程序仍需注入 `createCanvas` 与 `encodeImage`。

### 按内容层过滤（contentFilter）

`page.render`、`page.exportImage`、`page.getTextContent` 都接受可选的 `contentFilter`，用于只绘制/收集指定内容。语义是**白名单**：

- 不传：全部绘制。
- 传了：只画参数里出现且启用的内容；未出现的层、注释、签章都不画。
- 每次调用独立；导出/文本层不会自动继承上一次 `render` 的过滤。

```ts
// 只看正文和签章
await page.render({
  canvasContext,
  viewport,
  contentFilter: {
    layers: { body: true },
    signatures: true,
  },
}).promise;

// 只看背景模板
await page.render({
  canvasContext,
  viewport,
  contentFilter: {
    layers: { background: { templates: true } },
  },
}).promise;

// 只看正文页面内容 + 印章类注释
const text = await page.getTextContent({
  contentFilter: {
    layers: { body: { page: true } },
    annotationTypes: ['Stamp'],
  },
});
```

- 每层值：`true` 画整层，`false` 不画，`{ page: true }` 只画页面自身内容，`{ templates: true }` 只画模板内容，`{}` 不画。
- 模板按 `Template/@ZOrder` 归入背景/正文/前景，模板内部图层类型不参与过滤；Custom 层没有模板。
- 注释：`annotations: true` 画全部；`annotationTypes` 出现时只画列出的类型，空数组不画；`annotations: false` 不画并忽略类型。
- 注释类型可用 `KNOWN_ANNOTATION_TYPES` 的常见值，也可传自定义 `Annot/@Type` 字符串；匹配区分大小写。
- 导出/文本层要与画面一致时，显式传同一个 `contentFilter`。
- 切换过滤只重绘，不重新 prepare/解码；文本缓存会按过滤签名区分。

完整字段、默认值和示例见 [API.md §4.10](./API.md)。

### 文字层

```ts
const text = await page.getTextContent({ dpi: 144, includeChars: true });
for (const item of text.items) {
  console.log(item.text, item.rect.x, item.rect.y, item.size);
}
```

默认只包含参与绘制且样式有效的文字；需要不可见文字时传 `includeInvisible: true`。坐标单位 px，原点为页面左上角、y 向下。

### 大纲、元数据、附件与签章

```ts
const outline = await doc.getOutline();
const bookmarks = await doc.getBookmarks();
const metadata = await doc.getMetadata();
const permissions = await doc.getPermissions();
const attachments = await doc.getAttachments();
const bytes = await doc.getAttachmentData(attachments[0]?.id ?? '');
const signatures = await doc.getSignatureEntries();
const raw = await doc.getSignedValue(signatures[0]?.id ?? '');
```

`getOutline`/`getBookmarks`/`getMetadata`/`getPermissions`/`getAttachments`/`getSignatureEntries` 只读元数据或索引；`getAttachmentData`/`getSignedValue` 返回原始字节，但不解析内容、不验签。

### 文档元数据与包结构

`getMetadata()` 在 `open()` 阶段随 OFD.xml/Document.xml 一起解析并缓存，调用时只读内存、不额外读包内条目。除版本/页数/DocInfo 外，还可选带包级结构字段，解析不到时省略 key：

```ts
const meta = await doc.getMetadata();
console.log(meta.docType);          // OFD@DocType，例如 'OFD'
console.log(meta.docUsage);         // DocInfo/DocUsage
console.log(meta.packageInfo);      // { docRoot, docBodyCount, maxUnitId? }
console.log(meta.documentHeader);   // Document.xml 头部声明
console.log(meta.commonData);       // CommonData 摘要
```

| 字段 | 类型 | 内容 |
| --- | --- | --- |
| `docUsage` | `string?` | 文档用途 |
| `docType` | `string?` | `OFD.xml` 的 `OFD@DocType` |
| `documentHeader` | `DocumentHeader?` | `docId`/`version`/`maxUnitId`/`pageArea`/`publicRes`/`documentRes`/`templatePageRes`/`defaultCs`/`docUsage` |
| `packageInfo` | `OfdPackageInfo?` | `docRoot`、`docBodyCount`，可选 `maxUnitId` |
| `commonData` | `CommonDataSummary?` | `pageArea`、`defaultColorSpaceId`、`documentVersion`、`dataDir` |

- `publicRes`/`documentRes`/`templatePageRes` 是 `readonly string[]`（OFD 允许同名多路径声明），已规范化为包内路径。
- 几何字段（`pageArea` 的 `physicalBox`/`applicationBox`/`bleedBox`）单位 **mm**，与 `PageInfo` 一致。
- 非法数值/路径省略并上报 `W_METADATA_FIELD`，不阻断打开。

### 附件查询与分块保存

除 `getAttachments()`/`getAttachmentData()` 外，还有按名/按格式查询、只查大小和回调式分块保存：

```ts
const list = await doc.getAttachments();                       // AttachmentInfo[]，保持 XML 顺序
const byName = await doc.getAttachmentByName('发票.xml');      // 未找到为 undefined
const pdfs = await doc.getAttachmentsByFormat('pdf');          // 大小写不敏感
const size = await doc.getAttachmentSize(list[0]?.id ?? '');   // 声明大小，byte；未声明为 undefined

const written = await doc.saveAttachment(list[0]?.id ?? '', (chunk) => {
  sink.write(chunk.slice()); // 引擎可能复用缓冲，保留必须拷贝
}, { chunkSize: 64 * 1024 });
console.log(written); // 写入字节总数，byte
```

- `getAttachmentByName`：按 `name` 精确匹配（大小写敏感），重名返回第一个并上报 `W_DUPLICATE_RESOURCE`。
- `getAttachmentsByFormat`：两侧 trim 后小写比较，只匹配声明了 `format` 的条目，空串返回 `[]`。
- `getAttachmentSize`：只读 `Attachments.xml` 的声明大小（byte），不读内容；ID 不存在上报 `W_ATTACHMENT_RESOURCE` 并返回 `undefined`；**声明大小超过上限时同样抛 `OFD_LIMIT_EXCEEDED`**。
- `saveAttachment`：chunk 顺序等于包内字节顺序，`chunkSize` 默认 65536 byte（非法值回退默认值）。它**不是流式 I/O**——容器只提供整块读取，引擎先把附件读入内存，再按 `chunkSize` 切分回调；`chunk` 是缓冲的 `subarray` 视图，跨回调保留必须自行拷贝。`sink` 抛错原样上抛、引擎停止读取、已写字节不回滚。
- 附件不可用（无 `Attachments.xml`/ID 不存在/缺 `FileLoc`/文件缺失）时上报 `W_ATTACHMENT_RESOURCE`：`saveAttachment` 返回 `0`，`getAttachmentData`/`getAttachmentSize` 返回 `undefined`。
- 单附件上限取 `limits.maxAttachmentBytes`，未配置（或非法）回退 `maxEntryBytes`（默认 64 MiB）；声明大小或实际大小超限一律抛 `OFD_LIMIT_EXCEEDED`，不返回部分数据，三个读取接口口径一致。
- 取消抛 `OFD_ABORTED`，关闭后抛 `OFD_CLOSED`。

完整签名与字段表见 [API.md](./API.md) 的 `getMetadata`（§3.8）与 `getAttachments`/附件查询与分块保存（§3.12、§3.12.1）小节。

### 缺省字体与补充字体

- `defaultFonts`：文档缺字体时的默认替代，优先级高于 `supplementaryFonts`；只接受 `{ data }`。
- `supplementaryFonts`：补充/回退字体，按字体名/别名评分参与回退。
- `fontProvider`：按需读取字体的唯一入口；`match()` 内可读网络/本地文件，返回 `{ data }` 或 `null`。
- 字体解析失败只上报 `W_FONT_MISSING`，不中断打开或渲染；需要精确控制字体映射时优先用 `FontProvider`。

## 错误与 warning

```ts
import { OFDError, isOFDError } from '@ofdrw/ofdrw-viewer-engine';

try {
  await page.render({ canvasContext: ctx, viewport }).promise;
} catch (error) {
  if (isOFDError(error)) {
    console.error(error.code, error.message, error.cause);
  }
}
```

常见错误码：`OFD_INVALID_PACKAGE`、`OFD_ENCRYPTED`、`OFD_PAGE_NOT_FOUND`、`OFD_CANVAS_SIZE_MISMATCH`、`OFD_CANVAS_TOO_LARGE`、`OFD_RENDERER_UNSUPPORTED`、`OFD_ABORTED`、`OFD_CLOSED`、`OFD_LIMIT_EXCEEDED`。完整表见 [API.md §9](./API.md#9-错误)。

常见 warning：

- `W_FONT_MISSING` / `W_GLYPH_MISSING`：字体缺失或缺字形，文字被替代/跳过；
- `W_IMAGE_DECODE` / `W_JBIG2_DECODE`：图片解码失败，该图跳过；
- `W_UNSUPPORTED_PAINT` / `W_UNSUPPORTED_CLIP` / `W_BLEND_MODE` / `W_RADIAL_UNSUPPORTED` / `W_GOURAUD_APPROX`：绘制降级；
- `W_TEXT_ITEM_LIMIT` / `W_TEXT_CHAR_LIMIT`：文本层达到上限被截断；
- `W_ATTACHMENT_*` / `W_SIGNATURE_RESOURCE` / `W_METADATA_FIELD` / `W_PERMISSION_FIELD`：可选元数据读取失败或字段非法。

warning 不中断渲染，同一 `(code, pageIndex, objectId)` 只上报一次；`onWarning` 未提供时静默。完整码表见 [API.md §10](./API.md#10-warning)。

## 单位、坐标与生命周期

- 页面几何（`getSize`、`PageInfo`、大纲/书签目标、签章戳记）单位 **mm**；文本层单位 **px**。
- `viewport`/画布/导出图片单位 **设备像素**；DPI 只决定 mm→px 比例，不是阅读器缩放。
- 矩阵为 2×3 列主序 `[a,b,c,d,e,f]`，`x' = a·x + c·y + e`，`y' = b·x + d·y + f`。
- 生命周期：`open → getPage → getViewport → render → close`；`close()` 后不可复用，页面句柄不能跨文档使用。
- 同一 canvas 的渲染串行；同一页的 `prepare`/文本构建并发去重；`close()` 会中止进行中的任务。
- 画布宽高、清屏和背景由宿主负责：`Math.ceil(viewport.width/height)` 分配，背景用 CSS 或自行 `fillRect`。

## 常见坑

- `page.render` 不会设置 canvas 宽高、不会清屏、不会填白底；透明区域保留 canvas 原内容。
- canvas 宽高必须 `>= viewport`；用 `Math.ceil` 分配，不要用 `Math.floor`，也不要传入比 canvas 更大的取整 viewport。
- engine 不联网、不读本地文件：没有 `url`/`node-file`/`wechat-file` 来源；先由宿主读成 `arraybuffer`/`blob`，或传 `custom ByteSource`。
- Node 的 `imageDecoders` 未覆盖实际格式时图片会缺失；按文档中的图片格式补齐插件。
- 不要在主线程同步等待渲染；`render` 返回任务，必须 `await task.promise`。
- 同一页的 `getTextContent` 缓存不含 DPI，但包含 `includeChars`/`includeAnnotations`/`includeInvisible`/`layerOrder`/上限/`contentFilter` 签名。
- `contentFilter` 是白名单：只写要显示的内容。写 `{ layers: { background: false } }` 不是“隐藏背景、其余照画”，而是只指定了一个不画的层，结果接近空白页；要隐藏某层，把其余要画的内容都显式写上。
- `exportImage`/`getTextContent` 不会自动继承上一次 `render` 的 `contentFilter`；需要一致时传同一个对象。
- 不要把 `limits` 设为 0 上线；不要忽略 `W_FONT_MISSING` 导致的文字缺字。
- `saveAttachment` 不是流式读取：附件先整块读入内存再按 `chunkSize` 回调，大附件请调大单附件上限或改用 `getAttachmentSize` 先判断；回调里的 `chunk` 是缓冲视图，越权保留会读到被覆盖的数据。
- `getAttachmentSize` 只查元数据，但声明大小超上限同样抛 `OFD_LIMIT_EXCEEDED`，不要把它当成“永不抛错”的探测接口。
- 不要用引擎做签章验签、证书解析或加密文档解密；这些不在引擎范围。

## 参考

- 完整 API（签名、默认值、字段表、错误码/warning）：[API.md](./API.md)
- 公开 API 与行为变更：[CHANGELOG.md](../CHANGELOG.md)