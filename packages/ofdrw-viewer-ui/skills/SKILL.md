---
name: ofdrw-viewer-ui
description: Embed the framework-agnostic OFD reader UI from @ofdrw/ofdrw-viewer-ui in web apps. Use this skill whenever a task involves a complete OFD reading interface, including continuous scrolling, zoom/rotation, thumbnails, outline/bookmarks, text selection and search, printing, PNG/JPEG/WebP export, encrypted-document credentials, signature overlays and verification panels, or the Web Component/React/Vue adapters. Covers installation, style import, container sizing, OFDViewer options/methods/events, feature gates, crypto configuration, framework wrappers, and known boundaries. Also covers URL loading in the UI layer: HttpByteSource, HTTP Range/CORS, request headers, cancellation, shared byte sources (engine does not fetch), host-controlled font bytes, and URI parameter preview: ?file= URLs, ?base64= values, base64 预览, encoding, priority and security. Use for OFD 阅读器、OFD 在线预览、URI 参数预览、?file=、?base64=、base64 预览、Vue/React OFD 组件、URL 跨域/Range 排障, or when embedding @ofdrw/ofdrw-viewer-ui.
---

# OFD 阅读器 UI（@ofdrw/ofdrw-viewer-ui）

把 `@ofdrw/ofdrw-viewer-ui` 嵌入 Web 应用，得到完整的 OFD 阅读器。核心是 `OFDViewer` 类；`<ofd-viewer>`、React、Vue 都是对同一实例的薄封装。UI 负责阅读器外壳、交互和网络读取，消费渲染引擎的页面绘制与密码能力包的验证报告，不维护第二套 ASN.1/验签实现。

阅读器运行在**纯 SPA** 环境，不承诺 SSR/服务端水合，也不提供局部/瓦片渲染。完整选项、事件、方法、类型和默认值见 [API.md](./API.md)。

## 什么时候用

- 在 Web 应用中嵌入完整 OFD 阅读器，而不是只画一页；
- 需要连续滚动、页码、缩放/旋转、缩略图、大纲与书签导航；
- 需要透明文本层、文本选择/复制、全文查找与高亮；
- 需要打开加密 OFD（口令或 SM2 私钥），展示签章覆盖层与验证面板；
- 需要浏览器打印、单页/多页图片导出（PNG/JPEG/WebP，多页 ZIP）；
- 需要 `<ofd-viewer>` Web Component 或 React/Vue 薄适配；
- 需要用 `?file=` / `?base64=` 链接直接预览 OFD，而不改宿主代码。

不适用：只需要把页面渲染到 Canvas，直接用渲染引擎包；批量转换文件用命令行工具；只提取文字用文档解析工具。

## 安装

```bash
pnpm add @ofdrw/ofdrw-viewer-ui
# 或 npm install @ofdrw/ofdrw-viewer-ui
```

在本仓库内从源码构建：

```bash
pnpm install
pnpm -C packages/ofdrw-viewer-engine build
pnpm -C packages/ofdrw-viewer-ui build
```

- 运行时需要 DOM、ES2020、Canvas 2D；打印依赖 `window.print`。
- React/Vue 是可选 peer 依赖；只用纯 HTML/Web Component 时不会加载框架代码。
- 包未声明 `sideEffects: false`，公共入口和各能力模块的注册不会被 bundler 当作纯模块摇掉。

## 样式与容器

主题样式必须由宿主显式引入，wrapper 不会自动注入：

```ts
import '@ofdrw/ofdrw-viewer-ui/style.css';
```

阅读器根元素需要确定高度，父容器也要有高度：

```html
<div id="viewer" style="height: 640px"></div>
```

挂载点必须自备确定高度，`OFDViewer` 不会修改宿主样式；它在挂载点内创建 `display: grid` 的 `.ofd-viewer` 根节点，并通过 `width/height: 100%` 撑满挂载点。`<ofd-viewer>` 自身是宿主：只有内联 `display`/`height`/`min-height` 未设置时，`connectedCallback` 才补 `display: block; height: 100%; min-height: 0`；父容器仍需提供高度，组件不会替父容器撑高。

## 5 分钟跑通

页面 URL 已带 `?file=` 或 `?base64=` 时可以省略 `source`，直接 `new OFDViewer({ container })`。

```ts
import { OFDViewer } from '@ofdrw/ofdrw-viewer-ui';
import '@ofdrw/ofdrw-viewer-ui/style.css';

const viewer = new OFDViewer({
  container: '#viewer',
  source: file, // File / Blob / ArrayBuffer / Uint8Array / URL / { url, headers? }
  initialPage: 1,
  initialScale: 'auto',
  theme: 'auto',
  locale: 'zh-CN',
  features: { print: false },
  onWarning: ({ code, message }) => console.warn(code, message),
  onError: ({ code, message }) => console.error(code, message),
});

await viewer.ready;

viewer.on('pagechanging', ({ pageNumber }) => {
  console.log('当前页', pageNumber);
});
viewer.goToPage(2);
viewer.setZoomMode('page-width');
viewer.openSidebar('thumbnails');

// 销毁：解绑 DOM/事件并释放渲染资源。
viewer.destroy();
```

`container` 是唯一必填选项；`source` 省略时按查询参数解析，两者都没有则 `ready` 以 `OFD_INVALID_OPTION` 拒绝。默认初始页为 1、初始缩放为 `auto`、主题为 `auto`、语言为 `zh-CN`。

## 网络与文件获取委托（UI 侧）

在浏览器中，UI 是 OFD 网络读取的唯一入口：URL 字符串与 `{ url, headers? }` 在打开时被规范化为一个 `HttpByteSource`，crypto 检测与 engine 渲染共用同一实例，只探测/读取一次；`File`/`Blob`/`ArrayBuffer`/`Uint8Array` 不经过网络，直接交给 engine。引擎包不再接受 URL，也不代替宿主读取字体文件；字体字节同样由宿主提供。设计背景与分层边界见 [网络获取委托设计](../../../docs/网络获取委托设计.md)，完整选项见 [API.md 构造选项](./API.md#ofdvieweroptions)。

### URL 来源与鉴权

```ts
const viewer = new OFDViewer({
  container: '#viewer',
  source: {
    url: '/api/ofd/123',
    headers: { Authorization: `Bearer ${token}` },
  },
});
await viewer.ready;
```

- `requestInit.headers` 先合并，来源对象 `headers` 覆盖同名键（来源优先）；`requestInit.credentials` 不转发，fetch 使用浏览器默认的 `same-origin` 凭据策略。
- 跨域时服务端需允许 `Range` 请求，并通过 `Access-Control-Expose-Headers` 暴露 `Content-Range`；`Authorization` 等自定义头也要在 CORS 允许列表中。
- 服务器忽略 Range 或响应启用 `Content-Encoding` 时，UI 会整包下载并缓存；`HttpByteSourceOptions.allowFullDownload` 设为 `false` 可禁用该回退。
- 探测/HTTP 状态/非法 `Content-Range` 抛 `OFD_INVALID_PACKAGE`；关闭后读取抛 `OFD_CLOSED`。鉴权 token 的刷新、重试与存储由宿主负责。

### 宿主自行读取：fetch → Blob/ArrayBuffer

```ts
const viewer = new OFDViewer({ container: '#viewer', source: '/sample.ofd' });
await viewer.ready;

const response = await fetch('/api/ofd/456', {
  headers: { Authorization: `Bearer ${token}` },
});
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const bytes = await response.arrayBuffer(); // 也可 await response.blob()
await viewer.open(bytes); // 字节已由宿主读取，UI 不再发起网络请求
```

需要宿主统一处理鉴权、重试或 CORS 时，先 `fetch` 再 `viewer.open(blob | arrayBuffer)`；后续切换文档同样接受 `File`/`Blob`。

### 直接使用 HttpByteSource

`HttpByteSource` 也作为公共 API 导出，便于宿主预读、探测或接入自定义加载流程：

```ts
import { HttpByteSource } from '@ofdrw/ofdrw-viewer-ui';

const source = new HttpByteSource('/api/ofd/789', {
  headers: { Authorization: `Bearer ${token}` },
  signal: abortController.signal,
});
await source.ready(); // HEAD/Range 探测；失败抛 OFD_INVALID_PACKAGE
const head = await source.read(0, 8); // 按需 Range 读取，越界截断
await source.close(); // 幂等；之后 read() 抛 OFD_CLOSED
```

`ByteSource` 不是 `OFDViewer.source` 的合法类型；要复用同一份字节，请直接传 URL（UI 内部复用同一实例）或传读取后的字节。构造参数与错误语义见 [API.md HttpByteSource](./API.md#httpbytesource)。

### 省略 source：?file= / ?base64=

`source` 可省略，此时读取页面查询参数预览：

```text
https://viewer.example.com/?file=https%3A%2F%2Ffiles.example.com%2Fdemo.ofd
https://viewer.example.com/?base64=UEsDBBQAAAAI
```

来源优先级为：`viewer.open(source)` 显式参数 > 构造选项 `source` > `?file=` > `?base64=`；`file` 与 `base64` 同时存在时用 `file`，并产生一条 `W_QUERY_SOURCE` warning。无任何来源时 `ready` 以 `OFD_INVALID_OPTION` 拒绝；`?file=` 只接受 `http(s)`，非法协议、空 URL、非法/超限 base64 同样抛 `OFD_INVALID_OPTION`。编码细节、安全提醒与链接生成见下文《通过 URI 参数预览》。

## 文档来源

`source` 支持 `File`/`Blob`、`ArrayBuffer`/`Uint8Array`、URL 字符串、`{ url, headers? }`。切换文档直接 `await viewer.open(nextSource)`；`await viewer.open()` 会重新按构造来源或当前查询参数打开。

- 空字节、空 Blob、空 URL 以 `OFD_INVALID_OPTION` 拒绝。
- URL 由 UI 在内部转换为 `HttpByteSource`；引擎只接收字节，不联网。
- `requestInit` 只对 URL 来源生效，且**只使用 `headers`**：先合并 `requestInit.headers`，再由来源对象的 `headers` 覆盖（来源优先）。`credentials` 不转发，fetch 使用浏览器默认的 `same-origin` 凭据策略。
- 鉴权 token 的刷新、重试与存储由宿主负责，阅读器不持久化凭据。

## 通过 URI 参数预览

不传 `source` 时，`open()` 读取当前页面的 `location.search`，识别 `?file=` 与 `?base64=`；只读查询串，不读取也不改写 `updateHash` 使用的 hash。来源优先级：

1. `viewer.open(source)` 的显式参数；
2. 构造选项 `options.source`；
3. `?file=`；
4. `?base64=`。

`file` 与 `base64` 同时存在时用 `file`，并产生一条 `W_QUERY_SOURCE` warning。

`?file=` 的值必须是目标地址经过 `encodeURIComponent` 后的结果；实现会先由 `URLSearchParams` 解码一次，再尝试一次 `decodeURIComponent`，非法百分号序列保留原值。支持绝对 `http(s)` 地址和相对当前页面的路径；解析后仅接受 `http:`/`https:`，`file:`、`javascript:`、`data:` 等协议一律以 `OFD_INVALID_OPTION` 拒绝。

```text
# 绝对地址（值本身已 encodeURIComponent）
https://viewer.example.com/?file=https%3A%2F%2Ffiles.example.com%2Fofd%2Fdemo.ofd

# 同源相对路由，以当前页面为 base
https://viewer.example.com/app/?file=%2Fapi%2Fofd%2F123.ofd

# 含中文与空格的路径（原路径 /api/ofd/发票 2026.ofd）
https://viewer.example.com/?file=%2Fapi%2Fofd%2F%E5%8F%91%E7%A5%A8%202026.ofd
```

```js
const target = new URL('/api/ofd/发票 2026.ofd', window.location.href).href;
const url = `${location.origin}${location.pathname}?file=${encodeURIComponent(target)}`;
```

`?base64=` 支持纯 base64 和 `data:application/ofd;base64,...`；data URI 必须带 `;base64` 标记与逗号。兼容 URL-safe 字符（`-`/`_`）、缺失的 padding、换行/空格，但仍建议对值做 `encodeURIComponent`，避免 `+`、`/`、`=` 被查询串解释。解码后默认上限 **64 MiB**（`DEFAULT_MAX_BASE64_BYTES`）；非法字符、空值、非法 data URI、超限抛 `OFD_INVALID_OPTION`，环境缺少 `atob` 抛 `OFD_UNSUPPORTED`。

```text
# 纯 base64（只是格式示例，必须替换为完整文件）
https://viewer.example.com/?base64=UEsDBBQAAAAI

# data URI（同样只是格式示例）
https://viewer.example.com/?base64=data%3Aapplication%2Fofd%3Bbase64%2CUEsDBBQAAAAI
```

```bash
B64=$(base64 -w0 demo.ofd)
node -e 'console.log("https://viewer.example.com/?base64=" + encodeURIComponent(process.argv[1]))' "$B64"
```

安全提醒：

- base64 会进入浏览器历史、服务器访问日志、Referer 和监控/APM；敏感文档不要用 `?base64=`，改用一次性 `source`、POST 或短时效下载链接。
- 不要把鉴权 token 拼进 URL；需要鉴权时用 `{ url, headers? }` 或 `requestInit.headers`。
- 超长 URL 可能被代理/浏览器截断；大文件优先用 `file=` 或直接传字节。
- 部署时服务端需允许 CORS 与 `Range`，并暴露 `Content-Range`。

完整参数表、解析函数 `readPreviewSourceFromLocation()` 与 `PreviewLocation`/`PreviewSourceOptions` 见 [API.md 通过 URI 参数预览](./API.md#通过-uri-参数预览)。

## 网络来源与字节源

URL 不交给引擎：UI 的 `HttpByteSource` 按 HTTP Range 读取，crypto 与 engine 共用同一实例，避免重复探测/下载。明文路径由 engine 拥有 `custom` 源并在关闭文档时释放；加密路径由 UI 持有并关闭。

```ts
import { HttpByteSource, type HttpByteSourceOptions } from '@ofdrw/ofdrw-viewer-ui';

const options: HttpByteSourceOptions = {
  headers: { Authorization: 'Bearer <token>' }, // 与 requestInit.headers 合并时来源优先
  signal: abortController.signal,
  allowFullDownload: true,
  onProgress: (loaded, total) => console.log(loaded, total), // 单位 byte
};
const httpSource = new HttpByteSource('/api/doc.ofd', options);
await httpSource.ready(); // 大小探测完成；失败时抛 OFDError
const head = await httpSource.read(0, 4);

// OFDViewer 的 source 仍传 URL/字节（不能直接传 ByteSource）；
// 传 URL 时 UI 会按同样规则在内部创建 HttpByteSource。
const viewer = new OFDViewer({ container: '#viewer', source: '/api/doc.ofd' });
```

- 探测：先 `HEAD`，必要时 `Range: bytes=0-0`；`ready()` 缓存结果，重复调用不重复请求。
- 读取：`read(offset, length)` 按需发 Range，越界截断；416 或越界返回空数组。
- 回退：服务器忽略 Range（200）、响应启用 `Content-Encoding` 或总长不一致时整包下载并缓存；`allowFullDownload=false` 时改为报错。
- 取消：`signal` 与 `close()` 合并生效；关闭后 `read()` 抛 `OFD_CLOSED`，`close()` 可重复调用。
- CORS：跨域需要服务端允许 `Range`，并暴露 `Content-Range`。
- 进度：`onProgress` 只在整包读取时可用；UI 不额外暴露字节级进度。
- 字体：引擎不读取字体 URL/路径，UI 也没有字体配置项；需要补充字体时由宿主直接向引擎提供字体字节。

完整构造参数、默认值与错误语义见 [API.md HttpByteSource](./API.md#httpbytesource)。

## 框架适配

### Web Component

```html
<link rel="stylesheet" href="/node_modules/@ofdrw/ofdrw-viewer-ui/dist/style.css" />
<ofd-viewer id="reader" src="/sample.ofd" theme="auto" locale="zh-CN"></ofd-viewer>

<script type="module">
  import '@ofdrw/ofdrw-viewer-ui/element';

  const reader = document.querySelector('#reader');
  reader.features = { print: false };
  reader.style.height = '640px';

  reader.addEventListener('ofd-page-change', (event) => {
    console.log(event.detail.pageNumber);
  });
</script>
```

标签默认是 `ofd-viewer`，采用 light DOM，不创建 Shadow DOM。基础属性为 `src`、`page`、`scale`、`rotation`、`theme`、`locale`、`sidebar`；复杂配置用 `features`、`crypto`、`source` property。省略 `src` 时仍会创建实例并读取查询参数；断开连接销毁实例，重新连接按当前属性重建。事件名为 `ofd-*`，`event.detail` 为对应载荷，`reader.viewer` 是底层只读实例。

完整属性/property/方法/事件见 [API.md Web Component](./API.md#web-component)。

### React

```tsx
import { useRef } from 'react';
import { OFDViewer, type OFDViewerHandle } from '@ofdrw/ofdrw-viewer-ui/react';
import '@ofdrw/ofdrw-viewer-ui/style.css';

export function Reader() {
  const ref = useRef<OFDViewerHandle>(null);
  return (
    <div style={{ height: 640 }}>
      <OFDViewer
        ref={ref}
        source="/sample.ofd"
        features={{ print: false }}
        onReady={() => ref.current?.goToPage(1)}
        onPageChange={({ pageNumber }) => console.log(pageNumber)}
      />
    </div>
  );
}
```

`source`/`features` 等 prop 变化只调用核心方法，不会重建实例；卸载时销毁。`page` 为 1-based 受控页码，`scale` 可传数字或缩放模式，`sidebar` 传 `null` 关闭。ref 暴露 `getInstance`、`open`、`goToPage`、`setScale`、`setRotation`、`setFeatures`、`find`、`print`、`exportImage`、`verify` 等薄方法。外层容器默认 `width/height: 100%`。

完整 props、事件回调和句柄见 [API.md React](./API.md#react)。

### Vue

```vue
<script setup lang="ts">
import { OFDViewer } from '@ofdrw/ofdrw-viewer-ui/vue';
import '@ofdrw/ofdrw-viewer-ui/style.css';

const features = { print: false };
</script>

<template>
  <div style="height: 640px">
    <OFDViewer
      source="/sample.ofd"
      :features="features"
      @page-change="({ pageNumber }) => console.log(pageNumber)"
    />
  </div>
</template>
```

组件只创建一个外层 `div`，实例用 `shallowRef`/`markRaw` 持有，不进入响应式代理。公共 props 覆盖 `options` 里的同名项；事件使用 kebab-case。模板 ref 可调用 `getInstance`、`goToPage`、`setScale`、`setRotation`、`setFeatures`、`find`、`print`、`exportImage`、`verify` 等 expose 方法。

完整 props、emits 与 expose 见 [API.md Vue](./API.md#vue)。

子路径与导出内容见 [子路径导出](./API.md#子路径)。

## 核心工作流

### 打开、切换与关闭

```ts
await viewer.open('/api/doc-b.ofd');
await viewer.open();  // 重新按 options.source 或 ?file=/?base64= 打开
await viewer.close(); // 保留外壳，状态回到 closed，可再次 open
viewer.destroy();     // 移除根节点；销毁后调用方法抛 OFD_DESTROYED
```

`open()` 会取消上一次未完成的打开并释放其来源；失败通过 `ready`/返回的 Promise 拒绝，同时触发 `error` 事件。

### 导航、缩放与旋转

```ts
viewer.goToPage(3, { smooth: true }); // 页码 1-based；越界夹取到有效页
viewer.nextPage();
viewer.setScale(1.5);                 // 夹取到 0.1–25
viewer.setZoomMode('page-fit');       // auto/page-actual/page-fit/page-width
viewer.zoomIn();
viewer.setRotation(270);              // 规范为 0/90/180/270
viewer.rotateClockwise();
```

页面滚动、可见页范围和渲染队列由阅读器维护；调用方只需要设置目标页/缩放/旋转。

### 功能开关与展示

```ts
viewer.setFeatures({ print: false }, { display: 'disable' });
viewer.setFeatures({ print: true });
viewer.setFeatureDisplay({ export: 'disable' });
```

`features` 是补丁对象，未出现的键默认开启；非法键/值被忽略。关闭 `textLayer` 会级联关闭 `selection` 和 `find`，关闭 `sidebar` 会级联关闭 `thumbnails`/`outline`/`bookmarks`。受功能守卫的方法在功能禁用时抛 `OFD_FEATURE_DISABLED`，可用 `isFeatureDisabledError(error, 'print')` 判断；`closeSidebar()` 等清理方法不设守卫。

`featureDisplay` 只决定被关闭功能的控件如何展示：`hide` 隐藏，`disable` 保留但禁用。`features: true` 不能绕过文档权限或引擎/环境限制；完整功能键、依赖与有效状态见 [API.md 功能开关](./API.md#功能开关)。

### 查找与选中

```ts
await viewer.find('发票', { caseSensitive: false, wholeWord: false });
await viewer.findNext();
await viewer.findPrevious();
viewer.clearFind();
console.log(viewer.getSelectedText());
await viewer.copySelection();
```

查找默认从当前页开始、高亮全部匹配；空查询会清除查找。`find`/`findNext`/`findPrevious`/`clearFind` 需要 `find` 功能，选中与复制需要 `selection` 和 `textLayer`。完整选项与事件见 [API.md 查找、打印与导出](./API.md#查找打印与导出)。

### 打印与图片导出

```ts
await viewer.print({ pages: 'current', dpi: 'auto', includeBackground: false });
const result = await viewer.exportImage({
  page: 1,
  format: 'png',
  dpi: 300,
  background: null, // PNG 透明；JPEG/WebP 强制白底
});
await viewer.exportImages({
  pages: 'all',
  format: 'jpeg',
  quality: 0.92,
  zipFilename: '发票',
});
```

默认打印当前页、`dpi: 'auto'`、沿用当前旋转；默认导出当前页、PNG、`quality: 0.92`。`auto` DPI 按本次页数分档：≤50 页 200、51–200 页 150、>200 页 96；显式 DPI 须为 `(0, 600]`，结果四舍五入。多页导出生成 ZIP；单页失败会降级为 warning，全部失败抛 `OFD_EXPORT_FAILED`。打印调用浏览器打印对话框，不生成 PDF；图片导出不合并为 PDF。

### 加密文档与签名验证

```ts
const viewer = new OFDViewer({
  container: '#viewer',
  source: encryptedFile,
  crypto: {
    enabled: true,
    credentials: [{ kind: 'password', userName: 'alice', password: '***' }],
  },
});

await viewer.ready;
const report = await viewer.verify();
console.log(report.overall);
```

- 预置 `credentials` 时不弹内置登录框；未预置时由 `autoPrompt`/`onCredentialRequired` 决定弹窗或拒绝。
- `crypto.enabled=false` 时只保证明文文档阅读：加密文档以 `OFD_CRYPTO_UNSUPPORTED` 拒绝；`verification` 功能为 unsupported，`verify()`/`openVerificationPanel()` 以 `OFD_FEATURE_DISABLED`（`feature='verification'`）拒绝，不把密文当明文渲染。
- 完整 crypto 选项、凭据/根证书形态、自动验证、报告字段与取消语义见 [API.md 验证行为与错误](./API.md#验证行为与错误)。

## 已知边界

- **纯 SPA**：不承诺 SSR/水合；不提供局部/瓦片渲染。
- **网络在 UI 层**：URL 由 `HttpByteSource` 读取（Range + 整包回退），跨域需要 CORS 与 `Content-Range` 暴露头；鉴权头由宿主提供。
- **字体在宿主机**：引擎不读取字体 URL/路径，UI 无字体配置项；需要补充字体时由宿主直接使用引擎。
- **URI 参数预览只读查询串**：`?file=` 仅接受 `http(s)`；`?base64=` 默认上限 64 MiB，且会进入历史/日志/Referer，敏感文档不应使用。
- **打印/导出范围**：打印调用浏览器对话框，不生成 PDF；图片导出不合并为 PDF。
- **加密边界**：`crypto.enabled=false` 时加密文档直接拒绝；吊销状态不检查，固定为未检查；时间戳只解析、不验证，不参与整体结论。
- **跳转目标**：`goToDestination` 尚未暴露；可读 `getPageInfos()` 后用 `goToPage(pageIndex + 1)` 跳转，页内坐标由调用方处理。
- **性能**：未对数千页大文档、超大文件或低端设备做硬性性能承诺；首屏与全篇查找耗时随页数增长，宿主应自行压测。
- **缩略图缓存**：`thumbnailCacheSize` 当前仅被解析，尚未接入缩略图缓存实现，实际缓存数量固定；需要严格控制内存时不要依赖该选项。

## 参考

- [API.md](./API.md)：完整构造选项、功能开关、事件、方法、类型与适配器参考。
- [渲染引擎 SKILL](../../ofdrw-viewer-engine/skills/SKILL.md)：页面渲染、文本层、字体与引擎类型。
- [密码能力 API](../../ofdrw-viewer-crypto/skills/API.md)：解密、验签、证书链与报告细节。