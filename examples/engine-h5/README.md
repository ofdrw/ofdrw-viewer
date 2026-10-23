# engine-h5：纯静态 OFD 渲染示例

一个**无打包、无包管理**的浏览器示例：纯 HTML + 原生 ES Module + CSS，通过预置的
`global.js`（IIFE）使用 `@ofdrw/ofdrw-viewer-engine`，用 Canvas 显示 OFD 的当前页。

## 目录

```
examples/engine-h5/
├── index.html                     # 页面结构 + global.js 引入
├── app.js                         # 打开文档、翻页、DPI、渲染与错误处理
├── style.css                      # 布局、控件、画布样式
├── global.js                      # 引擎 IIFE 产物，挂载 globalThis.OFDRWViewer
├── README.md
└── samples/
    ├── doc1File.ofd               # 默认样例，11 页，内嵌字体
    └── dense-text-perf.ofd        # 第二样例，2 页，内嵌字体
```

样例来源：

| 文件 | 来源 | 页数 | 说明 |
| --- | --- | --- | --- |
| `samples/doc1File.ofd` | `ofd_pdf_match/doc1File.ofd` | 11 页 | 内嵌字体，页面加载后自动打开 |
| `samples/dense-text-perf.ofd` | `ofd_pdf_match/dense-text-perf.ofd` | 2 页 | 内嵌字体，文字密集，用于切换样例 |

两个样例都内嵌了字体，正常渲染时预期不产生 warning（状态区 warning 数为 0）。

## 运行

在**仓库根目录**执行零依赖静态服务器：

```bash
node scripts/serve-examples.mjs
# 或 pnpm demo:h5
```

然后访问：

<http://127.0.0.1:5180/examples/engine-h5/>

服务器以仓库根目录为站点根；端口被占用时可以换一个：

```bash
node scripts/serve-examples.mjs 8080
# 访问 http://127.0.0.1:8080/examples/engine-h5/
```

注意事项：

- **不要用 `file://` 直接打开**：样例通过 `fetch` 读取，`file://` 下会被浏览器拦截。
- 本示例不需要 `pnpm install`、没有构建步骤，也不要为它创建 `package.json`。
- `global.js` 已随示例预置，页面不访问 CDN；离线环境也能运行。

页面加载后会自动打开 `samples/doc1File.ofd`，也可以选择本地 `.ofd` 文件或点击样例按钮切换。

## 引擎产物：global.js

`index.html` 用普通脚本引入引擎：

```html
<script src="./global.js"></script>
<script type="module" src="./app.js"></script>
```

`global.js` 是引擎的 IIFE 浏览器包，挂载到 `globalThis.OFDRWViewer`，已内联
`fontkit`、`saxes`、`fflate` 和图片解码器，不需要 import map 或模块加载器。`app.js`
从这里取公共 API：

```js
const { OFDDocument, isOFDError } = globalThis.OFDRWViewer;
```

产物来自 `packages/ofdrw-viewer-engine/dist/global.js`，由引擎的
`node scripts/build-cdn.mjs` 生成（同目录还有压缩版 `min.js`，适合放 CDN）。
更新引擎后重新构建并替换本目录的 `global.js` 即可。

## 功能与实现要点

- **打开文档**：文件选择（`<input type="file">`）或内置样例按钮；样例用相对页面路径
  `fetch('samples/...')` 读取。打开新文档时，等新字节读取成功后才关闭旧文档，
  读取失败不会丢掉当前文档。
- **单页渲染**：`doc.getPage(index)` → `page.getViewport({ dpi })` →
  设置 `canvas.width/height`（`Math.ceil`）→ `page.render(...).promise`。
- **翻页**：上一页 / 下一页 / 页码输入 + 跳转；页码越界会夹到 `1..pageCount`。
- **DPI**：96 / 144 / 216；切换后立即按当前页重渲。
- **并发保护**：打开和渲染共用一个忙碌标记与操作序号，期间禁用文件选择、样例按钮、
  翻页、跳转和 DPI 控件；过期的异步结果不会覆盖新状态。
- **生命周期**：`pagehide` 时调用 `doc.close()`；关闭后不可复用。
- **状态区**：文件名、页数、当前页、画布设备像素尺寸（px）、整页渲染耗时（ms）、输出 DPI。
- **错误与 warning**：错误面板用 `isOFDError()` 区分 `OFDError` 与普通异常；前者展示
  `code` 与 `message`，后者展示错误名与消息。warning 单独列表展示，最多渲染 100 条，
  超出只继续计数。
- **画布与背景**：引擎不设置画布尺寸、不清屏、不填背景；本示例在每次渲染前重置
  canvas 宽高来清屏，白色纸面与阴影由 CSS 提供。画布 CSS 使用 `width: 100%; max-width: 100%;
  height: auto`，216 DPI 也不会撑破布局。

核心渲染代码（`app.js`）：

```js
const page = await doc.getPage(index);
const viewport = page.getViewport({ dpi });
canvas.width = Math.ceil(viewport.width);
canvas.height = Math.ceil(viewport.height);
await page.render({
  canvasContext: canvas.getContext('2d'),
  viewport,
}).promise;
```

## 验证

```bash
node --check examples/engine-h5/app.js
```

示例没有 `package.json`、没有 `node_modules`、没有构建配置。