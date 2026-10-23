---
name: ofdrw-viewer-ui
description: Embed the framework-agnostic OFD reader UI from @ofdrw/ofdrw-viewer-ui in web apps. Use this skill whenever a task involves a complete OFD reading interface, including continuous scrolling, zoom/rotation, thumbnails, outline/bookmarks, text selection and search, printing, PNG/JPEG/WebP export, encrypted-document credentials, signature overlays and verification panels, or the Web Component/React/Vue adapters. Covers installation, style import, container sizing, OFDViewer options/methods/events, feature gates, crypto configuration, framework wrappers, and known boundaries. Also covers URL loading in the UI layer: HttpByteSource, HTTP Range/CORS, request headers, cancellation, shared byte sources (engine does not fetch), and host-controlled font bytes. Use for OFD 阅读器、OFD 在线预览、Vue/React OFD 组件、URL 跨域/Range 排障, or when embedding @ofdrw/ofdrw-viewer-ui.
---

# OFD 阅读器 UI（@ofdrw/ofdrw-viewer-ui）

把 `@ofdrw/ofdrw-viewer-ui` 嵌入 Web 应用，得到完整的 OFD 阅读器。核心是 `OFDViewer` 类；`<ofd-viewer>`、React、Vue 都是对同一实例的薄封装。UI 消费 engine 的页面渲染与 crypto 的验签报告，不维护第二套 ASN.1/验签实现。

阅读器运行在**纯 SPA** 环境；当前不承诺 SSR/服务端水合。不提供局部/瓦片渲染。

当前能力：

- 连续滚动阅读、页码/缩放/旋转、侧栏、主题与中英文界面；
- 透明文本层、文本选择与复制、全文查找与高亮；
- 缩略图、大纲、书签导航；
- 加密文档打开（口令 / SM2 私钥）、工具栏验证面板、签章点击验证与根证书配置；
- 签章摘要、详情与页面覆盖层；签名、证书链、防夹带完整性和时间戳结果分层展示；
- 浏览器打印、单页/多页图片导出（PNG/JPEG/WebP，多页 ZIP）；
- `<ofd-viewer>` Web Component、React 18/19、Vue 3.3+ 薄适配。

## 什么时候用

- 在 Web 应用中嵌入完整 OFD 阅读器，而不是只画一页；
- 需要连续滚动、页码、缩放/旋转、缩略图、大纲与书签导航；
- 需要透明文本层、文本选择/复制、全文查找与高亮；
- 需要打开加密 OFD（口令或 SM2 私钥），展示签章覆盖层与验证面板；
- 需要浏览器打印、单页/多页图片导出；
- 需要 `<ofd-viewer>` Web Component 或 React/Vue 薄适配。

不适用：只需要把页面渲染到 Canvas 用 `@ofdrw/ofdrw-viewer-engine`；批量转图片文件用 `ofdrw-viewer-cli`；只读文字用 `mineru`。

## 安装

```bash
pnpm add @ofdrw/ofdrw-viewer-ui
# 或 npm install @ofdrw/ofdrw-viewer-ui
```

从源码开发或在本仓库内构建：

```bash
pnpm install
pnpm -C packages/ofdrw-viewer-engine build   # 类型检查依赖 engine/dist/index.d.ts
pnpm -C packages/ofdrw-viewer-ui build
```

- 运行时需要 DOM、ES2020、Canvas 2D；打印依赖 `window.print`，剪贴板优先使用 `navigator.clipboard`，不可用时回退 `execCommand('copy')`。
- React/Vue 是可选 peer 依赖；只使用纯 HTML/Web Component 时不会加载框架代码。
- 包未声明 `sideEffects: false`，公共入口与各能力模块顶层的 `registerViewerExtension` 注册不会被消费方 bundler 当作纯模块摇掉。

## 样式与容器

主题样式必须由宿主显式引入，wrapper 不会自动注入：

```ts
import '@ofdrw/ofdrw-viewer-ui/style.css';
```

阅读器根元素需要确定高度，例如：

```html
<div id="viewer" style="height: 640px"></div>
```

## 5 分钟跑通

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
  features: {
    print: false,
    find: true,
    toolbar: true,
  },
  featureDisplay: 'hide',
  onWarning: (warning) => console.warn(warning.code, warning.message),
  onError: (error) => console.error(error.code, error.message),
});

await viewer.ready;

viewer.on('pagechanging', ({ pageNumber }) => {
  console.log('当前页', pageNumber);
});

viewer.goToPage(2);
viewer.setZoomMode('page-width');
viewer.setRotation(90);
viewer.openSidebar('thumbnails');

// 销毁：解绑 DOM/事件并释放渲染资源。
viewer.destroy();
```

### 文档来源

`source` 支持以下形态；切换文档直接调用 `await viewer.open(newSource)`：

| 形态 | 说明 |
| --- | --- |
| `File` / `Blob` | 本地文件或拖拽得到的文件；UI 以 `blob` 交给 engine |
| `ArrayBuffer` / `Uint8Array` | 已读入内存的字节；UI 以 `arraybuffer` 交给 engine |
| `string` | 公开 URL；**UI 内部创建 `HttpByteSource`** 按 Range 读取，engine 只收字节 |
| `{ url, headers? }` | URL 加自定义请求头，适合鉴权资源；构造方式同上 |

`requestInit` 只对 URL 来源生效，且**只使用 `headers`**：先合并 `requestInit.headers`，再由来源对象的 `headers` 覆盖（来源优先）。`requestInit.credentials` 不转发，fetch 使用默认 `same-origin` 凭据策略。

### 网络来源与字节源

URL 不再交给 engine：UI 的 `normalizeViewerSourceDetailed()` 只规范化一次，把 URL 转成 `{ kind: 'custom', source: HttpByteSource }`，crypto 与 engine 共用同一实例，避免重复探测/下载。`HttpByteSource` 与 `HttpByteSourceOptions` 从公共入口导出，供宿主在 UI 之外复用同一套 HTTP Range 适配（例如直接交给 engine）：

```ts
import { HttpByteSource, type HttpByteSourceOptions } from '@ofdrw/ofdrw-viewer-ui';

const options: HttpByteSourceOptions = {
  headers: { Authorization: 'Bearer <token>' }, // 与 requestInit.headers 合并时来源优先
  signal: abortController.signal,
  allowFullDownload: true,
  onProgress: (loaded, total) => console.log(loaded, total), // byte
};
const httpSource = new HttpByteSource('/api/doc.ofd', options);
await httpSource.ready(); // 大小探测完成；失败时抛 OFDError
const head = await httpSource.read(0, 4);

// OFDViewer 的 source 仍传 URL/字节（不能直接传 ByteSource）；
// 传 URL 时 UI 会按同样规则在内部创建 HttpByteSource。
const viewer = new OFDViewer({ container: '#viewer', source: '/api/doc.ofd' });
```

| 能力 | 说明 |
| --- | --- |
| 构造 | `new HttpByteSource(url, options?)`；`size` 探测完成前为 0 |
| 读取 | `ready()` 缓存探测结果；`read(offset, length)` 按需发 Range，越界截断 |
| 关闭 | `close()` 幂等、中止在途请求；关闭后 `read()` 抛 `OFD_CLOSED` |
| Range | 先 `HEAD` 探测大小，必要时 `Range: bytes=0-0`；读取按需发 Range，不缓存整包 |
| 回退 | 服务器忽略 Range（200）、响应启用 `Content-Encoding` 或总长不一致时整包下载并缓存；`allowFullDownload=false` 时改为报错 |
| CORS | 跨域需要服务端允许 `Range`，并暴露 `Content-Range`（`Access-Control-Expose-Headers: Content-Range`） |
| 取消 | `signal` 与 `close()` 合并生效；`viewer.open()` 切换/关闭会取消旧打开并关闭对应字节源 |
| 进度 | `onProgress` 仅在整包回退/整包来源时可用；UI 公共 API 不额外暴露字节级进度，加载态以 `documentopen`/`document:open:*` 事件为准 |
| 共享 | 明文路径 engine 拥有 `custom` 源并在 `doc.close()` 关闭；加密路径由 UI 持有并关闭，crypto 只借用（不转发 close） |
| 鉴权 | 用来源 `headers` 或 `requestInit.headers`；token 刷新/重试由宿主负责 |

- `HttpByteSource` 只负责 URL → `ByteSource`；ZIP 解析、解密、渲染仍在 engine/crypto。
- URL 打开失败（HTTP 非 2xx、Range 不符、CORS）属于 UI/网络层错误，不再由 engine 报“网络读取失败”。
- **字体**：engine 不再读取字体 URL/路径。UI 当前不提供字体配置；宿主若需要补充字体，把字体读成 `{ data }` 传给 engine，或实现 `FontProvider` 后由宿主直接使用 engine（不在 UI 选项内）。

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

- 标签固定为 `ofd-viewer`，采用 light DOM，不创建 Shadow DOM。
- 基础属性：`src`、`page`、`scale`、`rotation`、`theme`、`locale`、`sidebar`。
- 复杂配置用 property：`reader.features = { ... }` / `reader.setFeatures({ ... })`；`src` 变化会重新打开文档。
- 事件名为 `ofd-*`（如 `ofd-document-open`、`ofd-page-change`、`ofd-error`），`event.detail` 为对应载荷；`reader.viewer` 是底层只读实例。
- 断开连接会销毁实例，重新连接会按当前属性重建。

### React

```tsx
import { useRef } from 'react';
import {
  OFDViewer,
  type OFDViewerHandle,
} from '@ofdrw/ofdrw-viewer-ui/react';
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

`source`/`features` 等 prop 变化只调用核心方法，不会重建实例；卸载时销毁。ref 暴露 `getInstance`、`open`、`goToPage`、`setScale`、`setRotation`、`setFeatures`、`find`、`print`、`exportImage` 等薄方法。

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

Vue 组件使用 `defineComponent` + `shallowRef`/`markRaw`，实例不会进入响应式代理；事件使用 kebab-case。通过模板 ref 可调用 `getInstance`、`goToPage`、`setScale`、`setRotation`、`setFeatures`、`find`、`print`、`exportImage` 等 expose 方法。

### 子路径导出

| 子路径 | 内容 |
| --- | --- |
| `@ofdrw/ofdrw-viewer-ui` | 框架无关核心与公共类型 |
| `@ofdrw/ofdrw-viewer-ui/react` | React wrapper |
| `@ofdrw/ofdrw-viewer-ui/vue` | Vue wrapper |
| `@ofdrw/ofdrw-viewer-ui/element` | `<ofd-viewer>` Web Component |
| `@ofdrw/ofdrw-viewer-ui/component` | `element` 的兼容别名 |
| `@ofdrw/ofdrw-viewer-ui/style.css` | 主题样式 |

公共入口会安装内置 UI 外壳，并 side-effect 注册文本/查找、导航、签章、打印、导出能力；直接 `import '@ofdrw/ofdrw-viewer-ui'` 即可获得完整阅读器。框架适配器入口也会导入公共入口，因此扩展同样生效。

## 配置参数

### 构造选项

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `container` | `HTMLElement / string` | 必填 | 挂载点；字符串按 CSS 选择器解析，元素必须已存在 |
| `source` | `ViewerSource` | 必填 | 文档来源，见上一节 |
| `initialPage` | `number` | `1` | 1-based 页码；小于 1 或非法值按 1 处理 |
| `initialScale` | `number / ZoomMode` | `'auto'` | 数字为倍率（0.1–25）；`auto`/`page-width` 适合宽度，`page-fit` 适合页面，`page-actual` 为 100% |
| `rotation` | `0 / 90 / 180 / 270` | `0` | 顺时针初始旋转角度 |
| `sidebar` | `thumbnails / outline / bookmarks / signatures / null` | `null` | 初始侧栏；`null` 表示关闭 |
| `features` | `Partial<Record<ViewerFeature, boolean>>` | 全部开启 | 功能开关补丁，见“功能开关” |
| `featureDisplay` | `'hide' / 'disable' / { 功能键: 'hide' / 'disable' }` | `'hide'` | 被关闭功能的展示方式，见“功能展示” |
| `theme` | `'light' / 'dark' / 'auto'` | `'auto'` | `auto` 跟随 `prefers-color-scheme` |
| `locale` | `string` | `'zh-CN'` | 内置 `zh-CN`/`en-US`；`zh`/`en` 等别名会归一，未注册语言回落 `zh-CN` |
| `maxCanvasPixels` | `number` | `32_000_000` | 单页 canvas 像素上限；超限会降低渲染 DPI 并产生 `W_CANVAS_LIMIT` |
| `pageCacheSize` | `number` | 桌面 10 / 移动 4 | 已渲染页 canvas 缓存数量 |
| `thumbnailCacheSize` | `number` | `100` | 缩略图缓存数量 |
| `renderConcurrency` | `number` | 桌面 2 / 移动 1 | 同时渲染的页数 |
| `updateHash` | `boolean` | `false` | 把页码/缩放/旋转/侧栏写入 URL hash，并响应 `hashchange`/`popstate` |
| `requestInit` | `RequestInit` | 无 | URL 来源的额外请求参数；**只使用 `headers`**，与来源合并（来源优先），`credentials` 不转发 |
| `onWarning` | `(warning: ViewerWarning) => void` | 无 | 非阻断诊断；包含 `code`、`message`、`pageIndex`（0-based） |
| `onError` | `(error: ViewerErrorInfo) => void` | 无 | 打开/渲染失败；在 warning 字段之外包含 `cause` |
| `crypto` | `CryptoViewerOptions` | 默认启用 | 加密文档与验签配置，见“加密文档与签名验证” |

`container`、`source` 是仅有的必填项；其余省略时使用默认值。`updateHash` 默认关闭，避免嵌入场景污染宿主地址；缓存/并发越大越流畅，但内存占用更高，移动端默认值更小。运行时可修改的配置见“运行时修改”。

一个包含常用配置的完整示例：

```ts
const viewer = new OFDViewer({
  container: '#viewer',
  source: {
    url: '/api/doc.ofd',
    headers: { Authorization: 'Bearer <token>' },
  },
  initialPage: 3,
  initialScale: 'page-fit',
  rotation: 90,
  sidebar: 'outline',
  theme: 'dark',
  locale: 'en-US',
  features: { print: false, export: false },
  featureDisplay: { print: 'disable', export: 'disable' },
  maxCanvasPixels: 24_000_000,
  pageCacheSize: 6,
  renderConcurrency: 2,
  updateHash: true,
  onWarning: ({ code, message }) => console.warn(code, message),
  onError: ({ code, message, cause }) => console.error(code, message, cause),
});

await viewer.ready;
```

### 功能开关

`features` 是补丁对象，只需写要关闭的功能；未出现的键默认 `true`，非法键/值会被忽略。

| 功能键 | 作用 | 依赖 |
| --- | --- | --- |
| `toolbar` | 顶部工具栏 | — |
| `sidebar` | 侧栏容器 | — |
| `thumbnails` | 缩略图 | `sidebar` |
| `outline` | 大纲 | `sidebar` |
| `bookmarks` | 书签 | `sidebar` |
| `pageNavigation` | 翻页/跳页 | — |
| `pageNumberInput` | 页码输入框 | — |
| `zoom` | 缩放按钮、快捷键与手势 | — |
| `rotate` | 旋转 | — |
| `fullscreen` | 全屏 | — |
| `textLayer` | 透明文本层 | — |
| `selection` | 文本选择与复制 | `textLayer` |
| `find` | 全文查找与高亮 | `textLayer` |
| `print` | 打印 | — |
| `export` | 单页/多页图片导出 | — |
| `signatures` | 签章列表、覆盖层与详情 | — |
| `verification` | 验证面板与验签；需同时启用 crypto | — |
| `documentProperties` | 文档属性 | — |
| `keyboardShortcuts` | 键盘快捷键 | — |

有效状态还会受文档权限、环境能力与依赖影响；`features: true` 不能绕过文档或引擎限制。`getFeatureState()` 返回 `{ enabled, visible, reason }`，`reason` 为 `host`、`document`、`unsupported` 或 `dependency`。表中的“依赖”指会级联关闭功能键的硬依赖；关闭 `toolbar`/`sidebar` 时，其内部控件即使自身开启也不可见。

功能关闭时，对应方法抛 `OFD_FEATURE_DISABLED`；可用 `isFeatureDisabledError(error, 'print')` 判断。依赖不满足时也会级联关闭，例如关闭 `textLayer` 会同时关闭 `selection` 和 `find`。

### 功能展示

`featureDisplay` 只决定被关闭功能的控件如何展示，不改变功能是否可用：

- `'hide'`（默认）：隐藏对应控件；
- `'disable'`：保留控件但禁用，并显示带原因的提示；
- 对象形式按功能覆盖，未覆盖的键回落到 `'hide'`：

```ts
featureDisplay: {
  print: 'disable',
  export: 'disable',
  signatures: 'hide',
},
```

### 运行时修改

`setFeatures(patch)` 合并功能补丁；`setFeatureDisplay(display)` 替换展示配置。`setFeatureDisplay('disable')` 可全局切换，传对象时只覆盖写出的功能。其余常用配置方法：

```ts
viewer.setFeatures({ print: false }, { display: 'disable' });
viewer.setFeatures({ print: true }); // 重新启用
viewer.setFeatureDisplay({ export: 'disable' });

viewer.setTheme('dark');
viewer.setLocale('en-US');

await viewer.open(nextSource);
viewer.goToPage(3, { smooth: true });
viewer.setScale(1.5);              // 0.1–25
viewer.setZoomMode('page-fit');
viewer.setRotation(90);
viewer.openSidebar('outline');
await viewer.setRootCertificates([{ url: '/roots.pem' }]);
```

这些方法同样受功能开关约束；功能被禁用时抛 `OFD_FEATURE_DISABLED`。`setRootCertificates()` 会替换信任根并重新验证当前文档。

## 加密文档与签名验证

加密文档默认走内置凭据弹窗；也可预置口令或 SM2 私钥。验证能力由 `@ofdrw/ofdrw-viewer-crypto` 提供，UI 不再维护第二套 ASN.1/验签实现：

```ts
const viewer = new OFDViewer({
  container: '#viewer',
  source: encryptedFile,
  crypto: {
    enabled: true, // 默认 true
    credentials: [
      // 二选一；password 或 SM2 私钥（PEM/PKCS#8）
      { kind: 'password', userName: 'alice', password: '***' },
      // { kind: 'private-key', userName: 'alice', privateKey: { pem: '-----BEGIN PRIVATE KEY-----...' } },
    ],
    autoPrompt: true,
    autoVerify: true,
    rootCertificates: [
      // data 是 PEM/DER/CER/Base64 字节；也可用 { url } / { path } / { filePath }
      { data: new TextEncoder().encode(rootPem) },
    ],
    certificateLoader: async (input) => {
      // path/filePath 由宿主读取；Web 默认不支持 path/filePath
      return null;
    },
    onVerification: (report) => console.log(report.overall),
  },
});

await viewer.ready;
```

### crypto 选项

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | 是否启用密码能力；`false` 时加密文档以 `OFD_CRYPTO_UNSUPPORTED` 拒绝 |
| `credentials` | `CryptoCredential / CryptoCredential[]` | 无 | 预置凭据；提供后不弹内置登录框 |
| `autoPrompt` | `boolean` | `true` | 无预置凭据时是否弹内置登录框；`false` 时以 `OFD_CRYPTO_CREDENTIAL_REQUIRED` 拒绝 |
| `rootCertificates` | `CertificateSource[]` | `[]` | 初始信任根；空数组时证书链为 `unknown` |
| `certificateLoader` | `(source) => bytes / null / Promise` | 无 | 读取 `path`/`filePath` 根证书的原始字节 |
| `autoVerify` | `boolean` | `true` | 打开成功后自动验证一次；`false` 时手动调用 `verify()` |
| `onVerification` | `(report) => void` | 无 | 验证完成回调；回调抛错只产生 warning |
| `onCredentialRequired` | `(inspection) => Promise<CryptoCredential / null>` | 无 | 接管凭据弹窗；仅在 `autoPrompt=true` 且无预置凭据时调用，返回 `null` 取消 |
| `limits` | `Partial<CryptoLimits>` | crypto 默认值 | 资源上限；字段见下方说明 |
| `signal` | `AbortSignal` | 无 | 取消密码能力操作；中止时抛 `CRYPTO_ABORTED` |
| `onWarning` | `(warning) => void` | 无 | crypto 层 warning；与 `OFDViewerOptions.onWarning` 分开 |
| `sm2UserId` | `string` | `'1234567812345678'` | SM2 签名 userId，不从证书推导 |
| `now` | `Date` | `new Date()` | 校验证书有效期使用的当前时间，测试可注入 |

`limits` 可覆盖 `maxSourceBytes`、`maxEntries`、`maxEntryBytes`、`maxTotalDecryptedBytes`、`maxCompressionRatio`、`maxDecryptLayers`、`maxAsn1Bytes`、`maxAsn1Depth`、`maxCertificates`、`maxTrustRoots`（字节类字段单位为 byte）；默认值见 [crypto API](../../ofdrw-viewer-crypto/skills/API.md)。例如 `limits: { maxSourceBytes: 128 * 1024 * 1024 }` 可把输入包上限定为 128 MB。

### 凭据

| 形态 | 字段 | 说明 |
| --- | --- | --- |
| 口令 | `{ kind: 'password', userName?, password }` | `password` 必填；`userName` 省略时仅在唯一用户时自动匹配 |
| SM2 私钥 | `{ kind: 'private-key', userName?, privateKey: { pem?, der?, passphrase? } }` | `pem`/`der` 二选一；`passphrase` 用于加密 PKCS#8 |

`credentials` 可传单个对象或数组；多个用户时建议显式写 `userName`。凭据只保留在调用栈/内存中，不写入日志、DOM、URL 或浏览器存储。

### 根证书

| 形态 | 读取方式 | 说明 |
| --- | --- | --- |
| `{ data, name? }` | 直接使用 | `ArrayBuffer`/`Uint8Array`；支持 PEM/DER/CER/Base64，可含多张证书 |
| `{ url, headers?, name? }` | 浏览器 `fetch` | HTTP 失败或解析失败只产生 warning 并跳过 |
| `{ path, name? }` / `{ filePath, name? }` | `certificateLoader` | 没有 loader 时 warning 并跳过；loader 抛错时以 `OFD_CRYPTO_FAILED` 失败 |

`certificateLoader(source)` 返回 `Uint8Array`、`ArrayBuffer` 或它们的 Promise；返回 `null` 表示跳过并 warning。返回值是原始字节（PEM/DER/CER/Base64，可含多张），UI 统一调用 crypto 转成 DER，loader 不要自行解析证书。Electron/Node 宿主可用 `fs.readFile` 读取 `path`/`filePath`；浏览器宿主通常只用 `data`/`url`。

### 验证行为

- **凭据流程**：预置 `credentials` 时不弹窗；`autoPrompt=false` 且无预置凭据时直接以 `OFD_CRYPTO_CREDENTIAL_REQUIRED` 拒绝，不会调用 `onCredentialRequired`。需要自定义弹窗时保持 `autoPrompt=true`，由 `onCredentialRequired` 接管（返回 `null` 取消，取消为 `OFD_CRYPTO_CANCELLED`）。错误重试、取消与秘密清理由内置弹窗负责，不在日志/DOM 中输出明文凭据。
- **crypto 三态边界**：明文文档始终可打开；加密文档在 `crypto.enabled=true` 时用凭据解密后交给 engine；`crypto.enabled=false` 时加密文档以 `OFD_CRYPTO_UNSUPPORTED` 拒绝，不会把密文当明文渲染。`inspect` 失败统一上报 `OFD_CRYPTO_FAILED`（保留 cause）。
- **验证面板**：工具栏“验证”打开/关闭面板，也可调用 `openVerificationPanel()`；`verify()` 重新执行一次完整性+签名验证，`getVerificationReport()` 读取最近报告。`features.verification=false` 时入口隐藏、面板收起、旧报告失效，`verify()` 抛 `OFD_FEATURE_DISABLED`。面板有可读状态文字（颜色不是唯一信息），并带 `aria-live="polite"` 播报。
- **印章点击**：点击签章覆盖层/侧栏项会打开验证浮层；验证中/失败/未配置根时也可查看未验证的解析详情，不会显示旧的 `valid`。
- **根证书**：`rootCertificates` 支持 `data`/`url`/`path`/`filePath`；`url` 用 fetch，`path`/`filePath` 必须由 `certificateLoader` 读取。正确根 → `valid`；未配置根 → 链 `unknown`；错误根/配置根但缺中间证书 → `incomplete`（链可建但锚不是配置根时为 `untrusted`）；全部根解析失败视为未配置（`rootsConfigured=false`），不伪造成 `valid`。`setRootCertificates()` 会替换根并重新验证。
- **时间戳**：状态固定为 `parsed-not-verified` / `not-present` / `parse-error`，界面文案分别为“已解析，未验证”/“无”/“不可解析”；**任何情况下都不声称 TSA 签名或时间戳已通过验证**。
- **完整性**：`report.integrity === null` 表示没有 `OFDEntries.xml` + `signedvalue.dat` 的防夹带保护，不是“完整性通过”；以 `report.package.integrityPresent === false` 判断未保护。

## 公共读取与控制 API

- `getCurrentPage()`：`getPageNumber()` 的别名，返回 1-based 页码。
- `getFindState()`：读取 `query`、`current`、`total`、`searching` 等查找状态。
- `getSignatures()` / `getSignatureDetail(id)` / `showSignature(id)` / `focusSignature(id)`：读取或定位签章；`features.signatures=false` 时同步抛 `OFD_FEATURE_DISABLED`（`feature='signatures'`）。
- `verify({ signatureIds?, signal? })` / `getVerificationReport()`：重新验证/读取最近报告；未打开文档时拒绝，`features.verification=false` 时 `verify()` 抛 `OFD_FEATURE_DISABLED`（`feature='verification'`）。
- `openVerificationPanel()`：打开工具栏验证面板；`setRootCertificates(roots)` / `getRootCertificates()`：替换/读取信任根并触发重新验证（全部无效返回空数组，不抛异常）。
- `showDialog(options)` / `closeDialog(restoreFocus?)`：控制内置 UI 对话框；未挂载内置 UI 时抛 `OFD_UNSUPPORTED`。
- `getVersions()` / `VERSION`：读取阅读器 UI、渲染引擎与密码能力包的版本；工具栏“更多 → 关于”也会可视化展示，并提供“开源软件许可”链接查看第三方许可文本，便于用户反馈问题时截图。
- 打印/导出按钮会打开选项对话框，可选择当前页/全部页/自定义范围、DPI、旋转、打印背景，以及导出格式、质量、背景；确认后分别调用 `print(options)` / `exportImages(options)` 或 `exportImage(options)`。

**P1 延期**：`goToDestination(DocumentDestination)` 尚未暴露。当前替代方式是读取 `getPageInfos()` 后用 `goToPage(pageIndex + 1)` 跳转；页内坐标/缩放锚点由调用方处理。该差异属于本迭代已知范围，后续补齐时保持向后兼容。

### 查找选项

`find(query, options)`：

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `caseSensitive` | `boolean` | `false` | 是否区分大小写 |
| `wholeWord` | `boolean` | `false` | 是否全词匹配（仅对拉丁文有效） |
| `highlightAll` | `boolean` | `true` | 是否高亮全部匹配 |
| `fromCurrentPage` | `boolean` | `true` | 是否从当前页开始查找 |

### 打印与导出选项

`print(options)`：

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `pages` | `PageRange` | `'current'` | 打印范围 |
| `dpi` | `number / 'auto'` | `'auto'` | 输出 DPI；`auto` 按页数分档，最大 600 |
| `includeBackground` | `boolean` | `false` | 是否打印页面背景；默认白底 |
| `rotation` | `0 / 90 / 180 / 270 / 'current'` | `'current'` | 打印方向；`current` 沿用当前阅读旋转 |
| `signal` | `AbortSignal` | 无 | 取消打印 |

`exportImage(options)` / `exportImages(options)`：

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `page` | `number` | 当前页 | 单页导出的页码，1-based |
| `pages` | `PageRange` | `'current'` | 多页导出范围 |
| `format` | `'png' / 'jpeg' / 'webp'` | `'png'` | 图片格式；WebP 不支持时可能回退 PNG |
| `dpi` | `number / 'auto'` | `'auto'` | 输出 DPI；`auto` 按页数分档，最大 600 |
| `quality` | `number` | `0.92` | JPEG/WebP 质量，0–1；PNG 忽略 |
| `background` | `string / null` | PNG 白底 | PNG 传 `null` 得到透明背景；JPEG/WebP 强制白底 |
| `rotation` | `0 / 90 / 180 / 270` | `0` | 导出旋转 |
| `filename` | `string` | 自动生成 | 文件名前缀（不含扩展名）；单页直接使用，多页加 `-pN` |
| `zipFilename` | `string` | 自动生成 | 多页 ZIP 文件名（不含扩展名） |
| `signal` | `AbortSignal` | 无 | 取消导出 |

`PageRange` 支持 `'current'`、`'all'`、`{ from, to }`（闭区间）和页码数组；选项对话框文本还支持 `1-3,5` 这类写法。`auto` DPI 按本次页数分档：≤50 页 200、51–200 页 150、>200 页 96。

## 事件

`on(event, handler)` 返回取消订阅函数，`once`/`off` 同样可用。事件包括 `documentopen`、`pagechanging`、`pagerendered`、`scalechanging`、`rotationchanging`、`findstart`/`findmatches`/`findcurrent`、`selectionchange`、`signatureclick`、`printstart`/`printprogress`/`printend`、`exportprogress`、`warning`/`error`、`verificationcompleted`、`featureschange`、`statechange` 等。

## 已知边界

- 签名验证覆盖 SM2/SM3/SM4、SES v1/v4/v5、Reference、证书链/信任根/有效期和 GB/T 35275 防夹带完整性；不检查 CRL/OCSP，`revocation` 固定 `not-checked`。
- 时间戳只解析、不验证 TSA 签名/ESSCertID/策略链；不参与整体 `overall`。
- `crypto.enabled=false` 时只保证明文文档阅读；加密文档以 `OFD_CRYPTO_UNSUPPORTED` 拒绝，不提供降级渲染。
- 打印调用浏览器打印对话框，不生成 PDF；图片导出不合并为 PDF。
- 不提供局部/瓦片渲染。
- **网络获取在 UI 层**：URL 由 UI 的 `HttpByteSource` 读取（Range + 整包回退），engine 只消费字节；跨域需要 CORS 与 `Content-Range` 暴露头。取消/关闭由 UI 管理，鉴权头由宿主提供。
- **字体在宿主机**：engine 不再读取字体 URL/路径；UI 无字体配置项，需要补充字体时由宿主直接使用 engine（`{ data }` 或 `FontProvider`）。
- 缩放入口：工具栏/API/下拉，以及 Ctrl/Command+滚轮与触控板双指缩放（以指针为锚点）、触摸屏双指捏合（以两指中点为锚点）、双击在适合宽度与 100% 间切换；`zoom` 功能关闭时手势不拦截默认行为。
- 性能目标（设计 §12.6）为 **P1/延期，非 MVP 门禁**：1000 页、约 0.8MB 派生夹具多轮实测打开约 4.7–7.4s、全篇查找约 20.3–30.0s，未达到 2s/5s 目标；按用户决定暂不优化性能、先补手势。50–200MB 夹具与目标信创机型复测尚未提供，不宣称达标。`test/e2e/performance.spec.ts` 只记录指标并在未达标时显式标注，不使用注水阈值。

## 参考

- [UI 设计方案](../../../docs/ofdrw-viewer-ui设计方案.md)
- [引擎 API 说明](../../../docs/ofdrw-viewer-ui-engine-api.md)
- [密码能力总体设计方案](../../../docs/ofdrw-viewer-crypto设计方案.md)
- [跨模块契约](../../../docs/CONTRACTS.md)
- [密码能力包](../../ofdrw-viewer-crypto/README.md)
- [渲染引擎 SKILL](../../ofdrw-viewer-engine/skills/SKILL.md)
