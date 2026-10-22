# @ofdrw/ofdrw-viewer-ui

框架无关的 OFD 阅读器 UI，包含 P0/MVP 能力：

- 连续滚动阅读、页码/缩放/旋转、侧栏、主题与中英文界面；
- 透明文本层、文本选择与复制、全文查找与高亮；
- 缩略图、大纲、书签导航；
- 签章摘要、详情与页面覆盖层（**只展示，不验签**）；
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

### 事件

`on(event, handler)` 返回取消订阅函数，`once`/`off` 同样可用。事件包括
`documentopen`、`pagechanging`、`pagerendered`、`scalechanging`、`rotationchanging`、
`findstart`/`findmatches`/`findcurrent`、`selectionchange`、`signatureclick`、
`printstart`/`printprogress`/`printend`、`exportprogress`、`warning`/`error`、
`featureschange`、`statechange` 等。

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

## 已知边界

- 签章信息只解析并展示 SignedValue，不验签、不校验证书链/有效期/CRL/OCSP。
- 打印调用浏览器打印对话框，不生成 PDF；图片导出不合并为 PDF。
- 不提供局部/瓦片渲染；不修改 `@ofdrw/ofdrw-viewer-engine`。

## 许可证

MIT