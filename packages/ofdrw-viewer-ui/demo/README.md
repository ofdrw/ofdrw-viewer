# ofdrw-viewer-ui demo

演示独立 HTML / Web Component 接入；React 与 Vue 入口使用同一份核心实例，示例见下方。

## 运行

在仓库根目录执行：

```bash
pnpm -C packages/ofdrw-viewer-ui build
npx vite packages/ofdrw-viewer-ui/demo
```

打开 Vite 输出的地址，选择本地 `.ofd` 文件；也可以使用
`?src=/path/to/file.ofd` 让阅读器通过 URL 打开（需要静态服务器允许跨目录访问）。

## React

```tsx
import { useRef } from 'react';
import { OFDViewer, type OFDViewerHandle } from '@ofdrw/ofdrw-viewer-ui/react';
import '@ofdrw/ofdrw-viewer-ui/style.css';

export function Demo() {
  const ref = useRef<OFDViewerHandle>(null);
  return (
    <div style={{ height: 640 }}>
      <OFDViewer
        ref={ref}
        source="/sample.ofd"
        features={{ print: false }}
        onPageChange={(detail) => console.log(detail.pageNumber)}
      />
    </div>
  );
}
```

## Vue

```vue
<script setup lang="ts">
import { OFDViewer } from '@ofdrw/ofdrw-viewer-ui/vue';
import '@ofdrw/ofdrw-viewer-ui/style.css';

const features = { find: false };
</script>

<template>
  <div style="height: 640px">
    <OFDViewer
      source="/sample.ofd"
      :features="features"
      @page-change="(detail) => console.log(detail.pageNumber)"
    />
  </div>
</template>
```

## 说明

- 样式必须由宿主显式引入 `@ofdrw/ofdrw-viewer-ui/style.css`；wrapper 不自动注入。
- `source`/`features` 变化只调用核心方法，不会重建实例；卸载时销毁实例。
- 高频滚动/canvas 状态留在核心内部，React/Vue 组件不保存这些状态。