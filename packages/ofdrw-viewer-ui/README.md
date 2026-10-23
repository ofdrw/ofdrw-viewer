# @ofdrw/ofdrw-viewer-ui

框架无关的 OFD 阅读器 UI，包含 P0/MVP 能力：

- 连续滚动阅读、页码/缩放/旋转、侧栏、主题与中英文界面；
- 透明文本层、文本选择与复制、全文查找与高亮；
- 缩略图、大纲、书签导航；
- 加密文档打开（口令 / SM2 私钥）、工具栏验证面板、签章点击验证与根证书配置；
- 签章摘要、详情与页面覆盖层；签名、证书链、防夹带完整性和时间戳结果分层展示；
- 浏览器打印、单页/多页图片导出（PNG/JPEG/WebP，多页 ZIP）；
- `<ofd-viewer>` Web Component、React 18/19、Vue 3.3+ 薄适配。

阅读器运行在 **纯 SPA** 环境；当前不承诺 SSR/服务端水合。不提供局部/瓦片渲染。

## 安装

```bash
pnpm add @ofdrw/ofdrw-viewer-ui
```

从源码开发 / 本仓库内构建：

```bash
pnpm install
pnpm -C packages/ofdrw-viewer-engine build   # 类型检查依赖 engine/dist/index.d.ts
pnpm -C packages/ofdrw-viewer-ui build
```

- 运行时需要 DOM、ES2020、Canvas 2D；打印依赖 `window.print`，剪贴板优先使用
  `navigator.clipboard`，不可用时回退 `execCommand('copy')`。
- React/Vue 是可选 peer 依赖；只使用纯 HTML/Web Component 时不会加载框架代码。
- 包未声明 `sideEffects: false`，公共入口与各能力模块顶层的
  `registerViewerExtension` 注册不会被消费方 bundler 当作纯模块摇掉。

## 样式

主题样式必须由宿主显式引入，wrapper 不会自动注入：

```ts
import '@ofdrw/ofdrw-viewer-ui/style.css';
```

阅读器根元素需要确定高度，例如：

```html
<div id="viewer" style="height: 640px"></div>
```

## 基础用法

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

`source` 支持 `File`/`Blob`、`ArrayBuffer`/`Uint8Array`、公开 URL 字符串，以及
`{ url, headers? }` 对象。切换文档直接调用 `await viewer.open(newSource)`。

## 加密文档与签名验证

加密文档默认走内置凭据弹窗；也可预置口令或 SM2 私钥。验证能力由
`@ofdrw/ofdrw-viewer-crypto` 提供，UI 不再维护第二套 ASN.1/验签实现：

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
      // data 是 PEM/DER/CER 字节；也可用 { url } / { path } / { filePath }
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

- **凭据**：只支持口令或 SM2 私钥；预置 `credentials` 时不弹窗，`autoPrompt=false`
  且无预置凭据时以 `OFD_CRYPTO_CREDENTIAL_REQUIRED` 拒绝；`onCredentialRequired`
  可由宿主接管弹窗（返回 `null` 取消）。取消为 `OFD_CRYPTO_CANCELLED`。错误重试、
  取消与秘密清理由内置弹窗负责，不在日志/DOM 中输出明文凭据。
- **crypto 三态边界**：明文文档始终可打开；加密文档在 `crypto.enabled=true` 时
  用凭据解密后交给 engine；`crypto.enabled=false` 时加密文档以
  `OFD_CRYPTO_UNSUPPORTED` 拒绝，不会把密文当明文渲染。`inspect` 失败统一上报
  `OFD_CRYPTO_FAILED`（保留 cause）。
- **验证面板**：工具栏“验证”打开/关闭面板，也可调用 `openVerificationPanel()`；
  `verify()` 重新执行一次完整性+签名验证，`getVerificationReport()` 读取最近报告。
  `features.verification=false` 时入口隐藏、面板收起、旧报告失效，`verify()` 抛
  `OFD_FEATURE_DISABLED`。面板有可读状态文字（颜色不是唯一信息），并带
  `aria-live="polite"` 播报。
- **印章点击**：点击签章覆盖层/侧栏项会打开验证浮层；验证中/失败/未配置根时也
  可查看未验证的解析详情，不会显示旧的 `valid`。
- **根证书**：`rootCertificates` 支持 `data`/`url`/`path`/`filePath`；`url` 用
  fetch，`path`/`filePath` 必须由 `certificateLoader` 读取。正确根 → `valid`；
  未配置根 → 链 `unknown`；错误根/配置根但缺中间证书 → `incomplete`（链可建
  但锚不是配置根时为 `untrusted`）；全部根解析失败视为未配置（`rootsConfigured=false`），不伪造成
  `valid`。`setRootCertificates()` 会替换根并重新验证。
- **时间戳**：状态固定为 `parsed-not-verified` / `not-present` / `parse-error`，
  界面文案分别为“已解析，未验证”/“无”/“不可解析”；**任何情况下都不声称
  TSA 签名或时间戳已通过验证**。
- **完整性**：`report.integrity === null` 表示没有 `OFDEntries.xml` +
  `signedvalue.dat` 的防夹带保护，不是“完整性通过”；以
  `report.package.integrityPresent === false` 判断未保护。

### 功能开关

`features` 覆盖工具栏、侧栏、文本层、选区、查找、打印、导出、签章等能力。关闭后
相关控件默认隐藏；`featureDisplay: 'disable'` 会保留控件但禁用，并带原因提示。也可
在运行时合并：

```ts
viewer.setFeatures({ signatures: false });
viewer.getFeatureState('print'); // { enabled, visible, reason, ... }
viewer.setFeatureDisplay('disable');
```

功能关闭时，对应命令抛出带 `feature` 字段的 `OFD_FEATURE_DISABLED` 错误（
`isFeatureDisabledError(error, 'print')` 可判断）。

### 公共读取与控制 API

- `getCurrentPage()`：`getPageNumber()` 的别名，返回 1-based 页码。
- `getFindState()`：读取 `query`、`current`、`total`、`searching` 等查找状态。
- `getSignatures()` / `getSignatureDetail(id)` / `showSignature(id)` /
  `focusSignature(id)`：读取或定位签章；`features.signatures=false` 时同步抛
  `OFD_FEATURE_DISABLED`（`feature='signatures'`）。
- `verify({ signatureIds?, signal? })` / `getVerificationReport()`：重新验证/读取
  最近报告；未打开文档时拒绝，`features.verification=false` 时 `verify()` 抛
  `OFD_FEATURE_DISABLED`（`feature='verification'`）。
- `openVerificationPanel()`：打开工具栏验证面板；`setRootCertificates(roots)` /
  `getRootCertificates()`：替换/读取信任根并触发重新验证（全部无效返回空数组，
  不抛异常）。
- `showDialog(options)` / `closeDialog(restoreFocus?)`：控制内置 UI 对话框；未挂载
  内置 UI 时抛 `OFD_UNSUPPORTED`。
- 打印/导出按钮会打开选项对话框，可选择当前页/全部页/自定义范围、DPI、旋转、
  打印背景，以及导出格式、质量、背景；确认后分别调用 `print(options)` /
  `exportImages(options)` 或 `exportImage(options)`。

**P1 延期**：`goToDestination(DocumentDestination)` 尚未暴露。当前替代方式是读取
`getPageInfos()` 后用 `goToPage(pageIndex + 1)` 跳转；页内坐标/缩放锚点由调用方
处理。该差异属于本迭代已知范围，后续补齐时保持向后兼容。

### 事件

`on(event, handler)` 返回取消订阅函数，`once`/`off` 同样可用。事件包括
`documentopen`、`pagechanging`、`pagerendered`、`scalechanging`、`rotationchanging`、
`findstart`/`findmatches`/`findcurrent`、`selectionchange`、`signatureclick`、
`printstart`/`printprogress`/`printend`、`exportprogress`、`warning`/`error`、
`verificationcompleted`、`featureschange`、`statechange` 等。

## Web Component

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
- 复杂配置用 property：`reader.features = { ... }` / `reader.setFeatures({ ... })`；
  `src` 变化会重新打开文档。
- 事件名为 `ofd-*`（如 `ofd-document-open`、`ofd-page-change`、`ofd-error`），
  `event.detail` 为对应载荷；`reader.viewer` 是底层只读实例。
- 断开连接会销毁实例，重新连接会按当前属性重建。

## React

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

`source`/`features` 等 prop 变化只调用核心方法，不会重建实例；卸载时销毁。ref 暴露
`getInstance`、`open`、`goToPage`、`setScale`、`setRotation`、`setFeatures`、`find`、
`print`、`exportImage` 等薄方法。

## Vue

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

Vue 组件使用 `defineComponent` + `shallowRef`/`markRaw`，实例不会进入响应式代理；
事件使用 kebab-case。通过模板 ref 可调用 `getInstance`、`goToPage`、`setScale`、
`setRotation`、`setFeatures`、`find`、`print`、`exportImage` 等 expose 方法。

## 子路径导出

| 子路径 | 内容 |
| --- | --- |
| `@ofdrw/ofdrw-viewer-ui` | 框架无关核心与公共类型 |
| `@ofdrw/ofdrw-viewer-ui/react` | React wrapper |
| `@ofdrw/ofdrw-viewer-ui/vue` | Vue wrapper |
| `@ofdrw/ofdrw-viewer-ui/element` | `<ofd-viewer>` Web Component |
| `@ofdrw/ofdrw-viewer-ui/component` | `element` 的兼容别名 |
| `@ofdrw/ofdrw-viewer-ui/style.css` | 主题样式 |

公共入口会安装内置 UI 外壳，并 side-effect 注册文本/查找、导航、签章、打印、导出
能力；直接 `import '@ofdrw/ofdrw-viewer-ui'` 即可获得完整阅读器。框架适配器入口也
会导入公共入口，因此扩展同样生效。

## Demo

构建后使用 Vite 运行 `demo/`：

```bash
pnpm -C packages/ofdrw-viewer-ui build
npx vite packages/ofdrw-viewer-ui/demo
```

## 文档

- [UI 设计方案](../../docs/ofdrw-viewer-ui设计方案.md)
- [引擎 API 说明](../../docs/ofdrw-viewer-ui-engine-api.md)
- [密码能力总体设计方案](../../docs/ofdrw-viewer-crypto设计方案.md)
- [跨模块契约](../../docs/CONTRACTS.md)
- [密码能力包](../ofdrw-viewer-crypto/README.md)

## 已知边界

- 签名验证覆盖 SM2/SM3/SM4、SES v1/v4/v5、Reference、证书链/信任根/有效期和
  GB/T 35275 防夹带完整性；不检查 CRL/OCSP，`revocation` 固定 `not-checked`。
- 时间戳只解析、不验证 TSA 签名/ESSCertID/策略链；不参与整体 `overall`。
- `crypto.enabled=false` 时只保证明文文档阅读；加密文档以
  `OFD_CRYPTO_UNSUPPORTED` 拒绝，不提供降级渲染。
- 打印调用浏览器打印对话框，不生成 PDF；图片导出不合并为 PDF。
- 不提供局部/瓦片渲染；不修改 `@ofdrw/ofdrw-viewer-engine`。
- 缩放入口：工具栏/API/下拉，以及 Ctrl/Command+滚轮与触控板双指缩放（以指针为锚点）、
  触摸屏双指捏合（以两指中点为锚点）、双击在适合宽度与 100% 间切换；`zoom` 功能
  关闭时手势不拦截默认行为。
- 性能目标（设计 §12.6）为 **P1/延期，非 MVP 门禁**：1000 页、约 0.8MB 派生夹具
  多轮实测打开约 4.7–7.4s、全篇查找约 20.3–30.0s，未达到 2s/5s 目标；按用户决定
  暂不优化性能、先补手势。50–200MB 夹具与目标信创机型复测尚未提供，不宣称达标。
  `test/e2e/performance.spec.ts` 只记录指标并在未达标时显式标注，不使用注水阈值。

## 许可证

MIT