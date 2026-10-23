# OFD 接入示例

四个最小示例，按使用场景选择：

| 示例 | 说明 | 运行 |
| --- | --- | --- |
| [engine-h5](engine-h5/) | 纯静态页面，预置引擎 `ofdrw-viewer-engine.min.js`，无包管理 | `pnpm demo:h5` → <http://127.0.0.1:5180/examples/engine-h5/> |
| [engine-node](engine-node/) | Node.js，逐页导出 PNG | `cd examples/engine-node && npm install && npm run dev` |
| [viewer-ui-vue](viewer-ui-vue/) | Vue 3 + 完整阅读器 UI | `pnpm demo:vue` → <http://127.0.0.1:5181/> |
| [viewer-ui-react](viewer-ui-react/) | React 19 + 完整阅读器 UI | `pnpm demo:react` → <http://127.0.0.1:5182/> |

## engine-h5

唯一不需要 `npm install` 的示例。`ofdrw-viewer-engine.min.js` 是引擎的 IIFE 压缩产物，
通过普通 `<script>` 引入：

```html
<script src="./ofdrw-viewer-engine.min.js"></script>
<script type="module" src="./app.js"></script>
```

页面自动打开 `samples/doc1File.ofd`，支持选择本地文件与上一页/下一页。

## 三个 npm 示例

`engine-node`、`viewer-ui-vue`、`viewer-ui-react` 都是独立 npm 工程，依赖按正式发布版本声明：

```json
"@ofdrw/ofdrw-viewer-engine": "^0.1.0"
"@ofdrw/ofdrw-viewer-ui": "^0.1.0"
```

包尚未发布时，把依赖临时改为 `file:../../packages/...` 即可本地运行，详见各示例 README；
调试结束改回 npm 版本号。

## 样例

每个示例自带 `samples/`（Vite 示例为 `public/samples/`），均来自仓库根目录 `ofd_pdf_match/`：

- `doc1File.ofd`：11 页，内嵌字体；
- `dense-text-perf.ofd`：2 页密集文本，内嵌字体。