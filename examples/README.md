# OFD 接入示例

四个**独立示例**，不属于根仓库 workspace，也不使用 pnpm。每个示例只通过 npm 依赖引用
`@ofdrw/ofdrw-viewer-*`，像普通使用者一样运行。

| 示例 | 说明 | 运行 |
| --- | --- | --- |
| [engine-h5](engine-h5/) | 单个 HTML 文件，引擎内联 | 双击 `index.html`（`file://`） |
| [engine-node](engine-node/) | Node.js，逐页导出 PNG | `cd examples/engine-node && npm install && npm run dev` |
| [viewer-ui-vue](viewer-ui-vue/) | Vue 3 + 完整阅读器 UI | `cd examples/viewer-ui-vue && npm install && npm run dev` → 5181 |
| [viewer-ui-react](viewer-ui-react/) | React 19 + 完整阅读器 UI | `cd examples/viewer-ui-react && npm install && npm run dev` → 5182 |

## 依赖关系

三个 npm 工程的 `package.json` 只引用发布版本：

```json
"@ofdrw/ofdrw-viewer-engine": "^0.1.0"
"@ofdrw/ofdrw-viewer-ui": "^0.1.0"
```

包尚未发布时，临时改为 `file:../../packages/...` 即可本地安装，详见各示例 README；
调试结束改回 npm 版本号。

`engine-h5` 没有 `package.json`，也没有服务端：引擎以 IIFE 压缩包的形式内联在
`index.html` 里，双击即可打开。

## 样例

每个示例自带 `samples/`（Vite 示例为 `public/samples/`），均来自仓库根目录 `ofd_pdf_match/`：

- `doc1File.ofd`：11 页，内嵌字体；
- `dense-text-perf.ofd`：2 页密集文本，内嵌字体。