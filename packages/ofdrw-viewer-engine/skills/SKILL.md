---
name: ofdrw-viewer-engine
description: Render OFD documents to Canvas with @ofdrw/ofdrw-viewer-engine. Use this skill whenever a task involves opening, previewing, rendering, or exporting .ofd pages in JavaScript/TypeScript, including browser pages, Web Workers/OffscreenCanvas, Node.js tools, Electron/Tauri, or WeChat Mini Programs. Covers page rendering, thumbnails, PNG/JPEG/WebP export, searchable text layers with pixel coordinates, outlines/metadata/attachments/signatures, DPI/canvas sizing, virtual container/encrypted-document injection, platform hooks (createCanvas, encodeImage, imageDecoders, loadInput, fontProvider), cancellation, and debugging warnings such as missing fonts or images. Also use for OFD 预览、OFD 转图片、文字层坐标, or when wiring a custom Canvas host. See the bundled API.md for exact signatures and defaults.
---

# OFD 页面渲染引擎（@ofdrw/ofdrw-viewer-engine）

把 OFD 包解析为页面模型，再绘制到宿主提供的 Canvas 2D 上下文。引擎只负责“页面内容 → Canvas”，不负责阅读器缩放/滚动、页面背景、打印、DRM 或签章密码学验签。

**先查参数**：完整签名、默认值、返回结构和错误码见 [API.md](./API.md)。本文件讲怎么接入、怎么调用，以及各环境的可运行示例。

## 什么时候用

- 在 Web、Worker、Node.js、Electron/Tauri 或微信小程序里显示 OFD 页面；
- 做页面缩略图、连续滚动阅读、按 DPI 高清渲染；
- 整页导出 PNG/JPEG/WebP；
- 读取带像素坐标的文字层，做搜索、选中或叠加高亮；
- 读取大纲、书签、元数据、权限、附件元数据、签章 XML 元数据。

不适用：批量转图片文件用 `ofdrw-viewer-cli`；只读文字用 `mineru`；完整阅读器 UI 用 `@ofdrw/ofdrw-viewer-ui`；签章验签/证书/加密文档解密不在引擎范围。

## 安装

```bash
npm install @ofdrw/ofdrw-viewer-engine
```

```ts
import { OFDDocument, OFDError, isOFDError, getPageViewport, WarningCollector } from '@ofdrw/ofdrw-viewer-engine';
```

CDN 直出：`dist/ofdrw-viewer-engine.min.js`（或未压缩的 `dist/ofdrw-viewer-engine.js`）是自包含 IIFE，挂到 `window.OFDRWViewer`，无需打包器；通过 `<script>` 引入后直接使用同名 API，详见 README 的 CDN 小节。

支持在浏览器（含 Web Worker）、Node.js（>= 22）、Electron/Tauri 的渲染进程或主进程、微信小程序中运行。核心不绑定 DOM/Node；宿主要能提供 Canvas 2D、图片解码、图片编码（导出时）和字体来源，具体注入方式见下一节。

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

浏览器主线程通常不需要任何平台钩子。`source` 也可以直接用 `url` 或 `arraybuffer`；`url` 依赖 `fetch` 和 HTTP Range，跨域时要允许请求头并暴露 `Content-Range`。

## 打开容器与加密文档

默认调用 `OFDDocument.open({ source })`，其中 `OFDOpenOptions.source` **必填**，engine 创建并拥有默认 ZIP 容器。需要复用容器、注入自定义明文容器或从解密结果打开时：

```ts
import { OFDDocument, openZipVirtualContainer } from '@ofdrw/ofdrw-viewer-engine';

const container = await openZipVirtualContainer(source);
try {
  const doc = await OFDDocument.open({ container }); // 纯容器重载：source 可省略
  try {
    // 正常使用 doc
  } finally {
    await doc.close(); // engine 不关闭借用容器
  }
} finally {
  await container.close();
}
```

- `OFDOpenFromContainerOptions`：`container` 必填、`source` 可选上下文；`containerFactory` 不允许。
- `OFDOpenOptions`：`source` 必填，可带 `container`（借用）或 `containerFactory`（engine 拥有），二者互斥。
- `openZipVirtualContainer` 返回 **raw package container**：明文包 `encrypted=false` 可直接注入；加密包 `encrypted=true` 的 `read()` 可能是密文，`OFDDocument.open` 会抛 `OFD_ENCRYPTED`。加密文档先用 [`@ofdrw/ofdrw-viewer-crypto`](../../ofdrw-viewer-crypto/skills/SKILL.md) 解出明文容器，再注入 engine。
- `VirtualContainer.read` 的 `signal` 只取消本次读取/等待；engine 合并 close signal，共享加载不会被单个调用方取消。
- 容器读取/所有权/错误码见 [API.md](./API.md)，业务背景见 [密码能力设计](../../../docs/ofdrw-viewer-crypto设计方案.md)。

## 环境适配

先判断宿主能提供什么，再决定注入哪些钩子。完整类型见 [API.md](./API.md)。

| 环境 | 必须注入 | 说明 |
| --- | --- | --- |
| 浏览器主线程 | 无 | 默认使用 `document.createElement('canvas')`、`createImageBitmap`/`Image`、`toBlob`/`convertToBlob` |
| Web Worker | 无，缺失 `OffscreenCanvas` 时注入 `createCanvas` | Worker 没有 `document`，默认走 `OffscreenCanvas` |
| Node.js | `createCanvas`、`imageDecoders`；导出时 `encodeImage`；读 `path`/`filePath` 字体时 `loadInput` | 推荐 `@napi-rs/canvas` 或 `canvas` |
| Electron / Tauri | 视进程而定 | 渲染进程按浏览器，主进程按 Node；通过 IPC/命令传 `ArrayBuffer` |
| 微信小程序 | `createCanvas`、`imageDecoders`、`loadInput`；`source` 用 `custom` | 没有 `document`/全局 `OffscreenCanvas`/系统字体 |

### Web Worker / OffscreenCanvas

```ts
const response = await fetch(url);
const doc = await OFDDocument.open({
  source: { kind: 'arraybuffer', data: await response.arrayBuffer() },
});

const page = await doc.getPage(0);
const viewport = page.getViewport({ dpi: 144 });
const canvas = new OffscreenCanvas(
  Math.ceil(viewport.width),
  Math.ceil(viewport.height),
);
const ctx = canvas.getContext('2d')!;
await page.render({ canvasContext: ctx, viewport }).promise;

const blob = await canvas.convertToBlob({ type: 'image/png' });
```

- 没有 `OffscreenCanvas` 时注入 `createCanvas`，或改在主线程渲染。
- Worker 通常有 `createImageBitmap`，但没有 `HTMLImageElement` 回退；老环境请注入 `imageDecoders`。
- `page.exportImage` 在 OffscreenCanvas 上通常走 `convertToBlob`，不需要额外 `encodeImage`。

### Node.js

Node 没有 `document`/`OffscreenCanvas`，也没有浏览器图片解码和 Canvas 编码。最小可用组合：

```ts
import { readFile } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  OFDDocument,
  type Canvas2DLike,
  type ImageDecoderPlugin,
} from '@ofdrw/ofdrw-viewer-engine';

const imageDecoders: ImageDecoderPlugin[] = (['png', 'jpeg', 'webp'] as const).map(
  (format) => ({
    format,
    async decode(bytes) {
      const image = await loadImage(Buffer.from(bytes));
      return { width: image.width, height: image.height, data: image, kind: 'source' };
    },
  }),
);

const doc = await OFDDocument.open({
  source: { kind: 'arraybuffer', data: await readFile('sample.ofd') },
  createCanvas: (width, height) => createCanvas(width, height) as unknown as Canvas2DLike,
  encodeImage: async (canvas, format, quality) => {
    const nodeCanvas = canvas as unknown as ReturnType<typeof createCanvas>;
    if (format === 'png') return nodeCanvas.toBuffer('image/png');
    if (format === 'jpeg') return nodeCanvas.toBuffer('image/jpeg', quality);
    return nodeCanvas.toBuffer('image/webp', quality);
  },
  imageDecoders,
  supplementaryFonts: [{ path: '/path/to/font.ttf' }],
  loadInput: async (input) => {
    if ('data' in input) return input.data;
    if ('url' in input) return new Uint8Array(await (await fetch(input.url)).arrayBuffer());
    return new Uint8Array(await readFile('path' in input ? input.path : input.filePath));
  },
  onWarning: (warning) => console.warn(warning.code, warning.message),
});
```

大文件不要整包读入内存；实现 `ByteSource` 并用 `{ kind: 'custom', source }`：

```ts
import { open } from 'node:fs/promises';

const handle = await open('sample.ofd', 'r');
const { size } = await handle.stat();
const source = {
  size,
  async read(offset: number, length: number): Promise<Uint8Array> {
    const buffer = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    return buffer.subarray(0, bytesRead);
  },
  close: () => handle.close(),
};
```

- `source.kind='node-file'` 只有类型，当前实现会抛 `OFD_RENDERER_UNSUPPORTED`；请用 `custom` 或 `arraybuffer`。
- PNG/JPEG/WebP 在 Node 没有浏览器原生解码；不注入 `imageDecoders` 会得到 `W_IMAGE_DECODE` 并跳过该图。
- GIF/JBIG2/TIFF 有内置纯 JS 解码器，会按需动态加载；宿主插件优先于内置。
- `@napi-rs/canvas` 与 `canvas` 二选一；引擎不依赖任何原生 Canvas 包。

### 微信小程序

小程序没有 `document`、全局 `OffscreenCanvas`，也没有可自动扫描的系统字体。用 `wx` API 注入文件读取、临时画布、图片解码和字体读取：

```ts
import {
  OFDDocument,
  type Canvas2DLike,
  type ImageDecoderPlugin,
} from '@ofdrw/ofdrw-viewer-engine';

const fs = wx.getFileSystemManager();
// 只用于 createImage()；尺寸不影响解码结果。
const imageCanvas = wx.createOffscreenCanvas({ type: '2d', width: 1, height: 1 });

/** 把小程序回调 API 包成 Promise；thisArg 保留 FileSystemManager/wx 的调用上下文。 */
function invoke<T>(fn: (options: any) => void, options: any, thisArg: any): Promise<T> {
  return new Promise((resolve, reject) => {
    fn.call(thisArg, { ...options, success: resolve, fail: reject });
  });
}

/** 用 FileSystemManager 的 fd + position 做随机读，供 custom ByteSource 使用。 */
async function createFileByteSource(filePath: string) {
  const { fd } = await invoke<{ fd: string }>(fs.open, { filePath, flag: 'r' }, fs);
  const { stats } = await invoke<{ stats: { size: number } }>(fs.fstat, { fd }, fs);

  return {
    size: stats.size,
    async read(offset: number, length: number): Promise<Uint8Array> {
      if (length <= 0 || offset >= stats.size) return new Uint8Array(0);
      const end = Math.min(offset + length, stats.size);
      const buffer = new ArrayBuffer(end - offset);
      let filled = 0;

      while (filled < buffer.byteLength) {
        const { bytesRead } = await invoke<{ bytesRead: number }>(
          fs.read,
          {
            fd,
            arrayBuffer: buffer,
            offset: filled,
            length: buffer.byteLength - filled,
            position: offset + filled,
          },
          fs,
        );
        if (bytesRead <= 0) break;
        filled += bytesRead;
      }
      return new Uint8Array(buffer, 0, filled);
    },
    close: () => invoke<void>(fs.close, { fd }, fs),
  };
}

/** 基于 canvas.createImage() 的解码插件；base64 Data URI 需要基础库 >= 2.11.0。 */
function createImageDecoder(format: string): ImageDecoderPlugin {
  return {
    format,
    decode(bytes) {
      return new Promise((resolve, reject) => {
        const image = imageCanvas.createImage();
        image.onload = () =>
          resolve({
            width: image.width,
            height: image.height,
            data: image,
            kind: 'source',
          });
        image.onerror = reject;

        const base64 = wx.arrayBufferToBase64(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        );
        image.src = `data:image/${format};base64,${base64}`;
      });
    },
  };
}

async function openOfd() {
  // 换成 wx.chooseMessageFile / wx.downloadFile 得到的临时路径。
  const filePath = `${wx.env.USER_DATA_PATH}/sample.ofd`;

  return OFDDocument.open({
    source: await createFileByteSource(filePath),
    createCanvas: (width, height) =>
      wx.createOffscreenCanvas({ type: '2d', width, height }) as unknown as Canvas2DLike,
    imageDecoders: (['png', 'jpeg', 'webp'] as const).map(createImageDecoder),
    supplementaryFonts: [
      { filePath: `${wx.env.USER_DATA_PATH}/fonts/fallback.ttf` },
    ],
    loadInput: async (input) => {
      if ('data' in input) return input.data;
      if ('url' in input) {
        const { data } = await invoke<{ data: ArrayBuffer }>(
          wx.request,
          { url: input.url, responseType: 'arraybuffer' },
          wx,
        );
        return new Uint8Array(data);
      }
      return new Uint8Array(
        await invoke<ArrayBuffer>(
          fs.readFile,
          { filePath: 'path' in input ? input.path : input.filePath },
          fs,
        ),
      );
    },
    onWarning: (warning) => console.warn(warning.code, warning.message),
  });
}
```

渲染到页面上的 `<canvas type="2d">`，再直接导出当前画布：

```ts
Page({
  data: { image: '' },

  async onReady() {
    const canvas = await new Promise<any>((resolve, reject) => {
      wx.createSelectorQuery()
        .select('#ofd-canvas')
        .fields({ node: true, size: true })
        .exec((res) => {
          const node = res[0]?.node;
          node ? resolve(node) : reject(new Error('未找到 #ofd-canvas'));
        });
    });

    const doc = await openOfd();
    try {
      const page = await doc.getPage(0);
      const viewport = page.getViewport({ dpi: 96 });

      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d')!;
      await page.render({ canvasContext: ctx, viewport }).promise;

      const { tempFilePath } = await invoke<{ tempFilePath: string }>(
        wx.canvasToTempFilePath,
        { canvas, fileType: 'png' },
        wx,
      );
      this.setData({ image: tempFilePath });
    } finally {
      await doc.close();
    }
  },
});
```

```xml
<canvas id="ofd-canvas" type="2d" style="width: 100%; height: 100%;" />
```

- `wx.canvasToTempFilePath` 只接受 `<canvas type="2d">` 组件实例，不接受 `OffscreenCanvas`。示例因此直接把页面渲染到组件 canvas，再导出；不要在小程序里直接调用 `page.exportImage`，它需要把离屏结果再画到组件 canvas 才能编码。
- `imageDecoders` 用 base64 Data URI 适合中小图；大图建议先 `fs.writeFile` 到临时文件，再设置 `image.src = tempFilePath`，避免 base64 膨胀。
- 字体没有系统扫描：用 `data` 或 `filePath` + `loadInput` 显式提供；缺字体只会 warning，不会中断渲染。
- `source.kind='wechat-file'` 只有类型，当前实现会抛 `OFD_RENDERER_UNSUPPORTED`；请用 `custom` `ByteSource`。
- 小程序不支持 `Path2D`、`DOMMatrix`、`ctx.filter`；引擎不依赖它们。`setLineDash`、`createRadialGradient`、`globalCompositeOperation` 需按基础库验证，不支持时降级并 warning。
- 主包有 2 MB 限制：字体和大型解码器放分包/CDN；`wx.createOffscreenCanvas` 需要基础库 >= 2.7.0。
- 小程序 API 依据：[OffscreenCanvas](https://developers.weixin.qq.com/miniprogram/dev/api/canvas/OffscreenCanvas.html)、[Image.src](https://developers.weixin.qq.com/miniprogram/dev/api/canvas/Image.html)、[wx.canvasToTempFilePath](https://developers.weixin.qq.com/miniprogram/dev/api/canvas/wx.canvasToTempFilePath.html)、[FileSystemManager.read](https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.read.html)。

### Electron / Tauri

- Electron 渲染进程按浏览器主线程处理；主进程按 Node.js 处理，并通过 IPC 传 `ArrayBuffer` 或渲染结果。
- Tauri WebView 内按浏览器处理，本地文件通过命令/协议读取成 `arraybuffer`，或用 `custom` `ByteSource` 桥接。
- 不要在 renderer 里直接 `require('node:fs')`；由 preload/主进程读取。

## 常用任务

### 页面列表与缩略图

先用 `getPageInfos` 拿页尺寸，不要为每页 `getPage`：

```ts
const infos = await doc.getPageInfos({ start: 0, count: 20 });
for (const info of infos) {
  console.log(info.index, info.widthMm, info.heightMm); // mm
}
```

### 翻页与取消

同一 canvas 的渲染是串行的；切换页面前先取消旧任务，避免堆积：

```ts
import type { RenderTask } from '@ofdrw/ofdrw-viewer-engine';

let task: RenderTask | undefined;

async function showPage(index: number) {
  task?.cancel();
  await task?.promise.catch(() => undefined);

  const page = await doc.getPage(index);
  const viewport = page.getViewport({ dpi: 144 });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d')!;

  task = page.render({ canvasContext: ctx, viewport });
  await task.promise;
}
```

`render` 返回 `RenderTask`，必须 `await task.promise`；`cancel()` 后 promise 以 `OFD_ABORTED` 拒绝。`close()` 会中止进行中的任务。

### 导出图片

```ts
const png = await page.exportImage({
  dpi: 300,
  format: 'png',
  background: null, // 透明 PNG
});

const jpg = await page.exportImage({
  format: 'jpeg',
  quality: 0.9,
  rotation: 90, // 仅改变导出方向
});

// png.data 是 Uint8Array；png.mime / png.width / png.height 可直接使用。
```

`exportImage` 使用文档级 `createCanvas` 和独立的离屏画布，不经过自定义 `renderer`。Node 等没有原生 Canvas 编码的环境必须注入 `encodeImage`。小程序没有可直接编码 `OffscreenCanvas` 的 API；`exportImage` 需要先把离屏结果画到组件 canvas，再调用 `wx.canvasToTempFilePath`，通常不如直接渲染到组件 canvas 后导出（见上一节）。

### 文字层

```ts
const text = await page.getTextContent({ dpi: 144 });

for (const item of text.items) {
  console.log(item.text, item.rect.x, item.rect.y, item.rect.width, item.rect.height);
}
```

`getTextContent` 的坐标单位是 px，原点在页面 PhysicalBox 左上角、y 向下；`dpi` 必须与同页图片一致，才能直接叠加。默认返回字符级 `chars`；大文档用 `maxTextItems`/`maxTextChars` 限制。

### 大纲、元数据、附件与签章

```ts
const [outline, meta, attachments, signatures] = await Promise.all([
  doc.getOutline(),
  doc.getMetadata(),
  doc.getAttachments(),
  doc.getSignatureEntries(),
]);

console.log(meta.pageCount, outline.length, attachments.length, signatures.length);
```

这些接口只返回元数据；附件内容用 `getAttachmentData(id)`，签章原始值用 `getSignedValue(id)`。引擎不做签章验签、证书解析或解密。

### 缺省字体与补充字体

```ts
const doc = await OFDDocument.open({
  source,
  // 文档字体完全缺省时的替代字体，优先级高于 supplementaryFonts。
  defaultFonts: [{ data: fallbackFontBytes, family: 'Noto Serif CJK SC' }],
  // 主字体存在但缺字时逐字形补缺。
  supplementaryFonts: [{ data: fontBytes }],
});
```

字体优先级：内嵌 FontFile → `fontProvider` → `defaultFonts` → `supplementaryFonts`；逐字形回退链为 provider 其余候选 → `defaultFonts` 其余 → `supplementaryFonts`。精确来源（内嵌/provider）命中时 `defaultFonts` 不参与主字体选择，但仍进入回退链。替代字体不可信任显式 GID（忽略 `CGTransform` 的 GID，走 cmap）。`data` 直接可用；`url` 默认走 fetch；`path`/`filePath` 需要 `loadInput`。CJK 字体由宿主提供，引擎不内置；缺字体/缺字只产生 warning，渲染继续。

## 错误与 warning

公共 API 失败抛 `OFDError`，用 `isOFDError` 和 `code` 分支：

```ts
try {
  const page = await doc.getPage(index);
  await page.render({ canvasContext: ctx, viewport }).promise;
} catch (error) {
  if (isOFDError(error)) {
    console.error(error.code, error.message, error.cause);
  }
  throw error;
}
```

常见 `code`：`OFD_INVALID_PACKAGE`、`OFD_PAGE_NOT_FOUND`、`OFD_CANVAS_SIZE_MISMATCH`、`OFD_CANVAS_TOO_LARGE`、`OFD_RENDERER_UNSUPPORTED`、`OFD_ABORTED`、`OFD_CLOSED`。完整列表和触发条件见 [API.md](./API.md)。

warning 不中断渲染，默认不打印；`onWarning` 按 `(code,pageIndex,objectId)` 去重。优先关注：

- `W_FONT_MISSING` / `W_GLYPH_MISSING`：缺字体或字形，文字可能回退/缺字；
- `W_IMAGE_DECODE`：图片解码失败，该图被跳过；
- `W_TEXT_ITEM_LIMIT` / `W_TEXT_CHAR_LIMIT`：文本达到上限，已截断。

需要收集 warning 做测试/诊断时用 `new WarningCollector()`，读取 `collector.warnings`。

## 单位、坐标与生命周期

- 页面/对象/页尺寸/大纲目标/签章戳记：**mm**；Viewport、画布、图片、文本层：**设备像素（px）**。
- `dpi` 是输出精度，不是阅读器缩放；阅读器缩放用 CSS/视口变换，不要为每次缩放重新按巨大 DPI 渲染。
- `getPageViewport(size, { dpi })` 是 `page.getViewport` 的纯函数版本；默认 `DEFAULT_DPI = 96`。
- 生命周期：`open → getPage/getPageInfos → getViewport/prepare/render/exportImage/getTextContent → close`。
- `close()` 后不可复用，所有调用以 `OFD_CLOSED` 拒绝；页面句柄也不能跨文档复用。
- 同一 canvas 的渲染串行；不同 canvas 可并行；同一页的 prepare/文本构建并发去重。
- `prepare()` 只准备 96 DPI 的 bundle；`render` 用其他 DPI 时会重新准备。

## 常见坑

- `page.render` 不会设置 canvas 宽高、不会清屏、不会填白底；透明区域保留 canvas 原内容。
- canvas 宽高必须 >= viewport；用 `Math.ceil` 分配，不要用 `Math.floor`，也不要传入比 canvas 更大的取整 viewport。
- `page.exportImage` 不经过自定义 `renderer`；自定义渲染器不能改变导出结果。
- `node-file`/`wechat-file` 只有类型，不要直接使用；用 `custom` `ByteSource`。
- Node 的 `imageDecoders` 只覆盖 PNG/JPEG/WebP 时，遇到 BMP 仍会失败；按实际图片格式补齐。
- 不要在主线程同步等待渲染；`render` 返回任务，必须 `await task.promise`。
- 同一页的 `getTextContent` 缓存不含 DPI，但包含 `includeChars`/`includeAnnotations`/`includeInvisible`/`layerOrder`/上限。
- 不要把 `limits` 设为 0 上线；不要忽略 `W_FONT_MISSING` 导致的文字缺字。
- 不要用引擎做签章验签、证书解析或加密文档解密；这些不在 v1 范围。
- 不要把本 skill 复制到 `~/.agents/skills/`；它随仓库维护，也不进入 npm 包。

## 参考

- 完整 API（签名、默认值、返回结构）：[API.md](./API.md)
