# viewer-ui-vue：Vue 3 最小接入

用 Vite + Vue 3 挂载 `@ofdrw/ofdrw-viewer-ui/vue`，阅读器自带工具栏、侧栏、缩放、查找等功能。

## 运行

```bash
cd examples/viewer-ui-vue
npm install
npm run dev
```

访问 <http://127.0.0.1:5181/>。页面自动打开 `public/samples/doc1File.ofd`（11 页），也可以
选择本地 OFD 文件。

## 关键代码

```vue
<script setup>
import { shallowRef } from 'vue';
import { OFDViewer } from '@ofdrw/ofdrw-viewer-ui/vue';

// 二进制内容必须用 shallowRef，避免被 Vue 深度代理。
const source = shallowRef(null);
source.value = await (await fetch('samples/doc1File.ofd')).arrayBuffer();
</script>

<template>
  <OFDViewer :source="source" />
</template>
```

`source` 换成新的 ArrayBuffer 就会打开新文档；阅读器容器需要有确定高度，示例在
`App.vue` 中用 `height: 100%` 占满视口。

## npm 包未发布时

`package.json` 按正式发布后的方式引用 `@ofdrw/ofdrw-viewer-ui@^0.1.0`。发布前本地调试，
把依赖临时改成：

```json
"@ofdrw/ofdrw-viewer-ui": "file:../../packages/ofdrw-viewer-ui"
```

阅读器依赖的 engine 由 UI 包自身解析。调试结束改回 npm 版本号，不要提交本地路径。