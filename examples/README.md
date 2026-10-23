# OFD 接入示例

四个最小可跑通的接入示例，分别演示浏览器渲染引擎、Node 渲染、Vue 阅读器和 React 阅读器。

| 目录 | 形态 | 说明 | 默认端口 |
| --- | --- | --- | --- |
| [`engine-h5`](engine-h5/) | 纯静态 HTML + 预置 `global.js`，无 package.json | 直接用 `@ofdrw/ofdrw-viewer-engine` 打开文件/样例并逐页渲染到 Canvas | 5180 |
| [`engine-node`](engine-node/) | Node ESM 项目 | 用 `@napi-rs/canvas` 提供 Canvas，把 OFD 每一页导出为 PNG | 无 |
| [`viewer-ui-vue`](viewer-ui-vue/) | Vite + Vue 3 | 挂载 `@ofdrw/ofdrw-viewer-ui/vue`，使用完整阅读器 UI | 5181 |
| [`viewer-ui-react`](viewer-ui-react/) | Vite + React 19 | 挂载 `@ofdrw/ofdrw-viewer-ui/react`，使用完整阅读器 UI | 5182 |

## engine-h5（无包管理）

在仓库根目录执行：

```bash
node scripts/serve-examples.mjs
# 或 pnpm demo:h5
```

然后打开 <http://127.0.0.1:5180/examples/engine-h5/>。引擎以 IIFE 形式预置在
`examples/engine-h5/global.js`，通过普通 `<script>` 引入，不需要 `npm install`、不访问 CDN。

## engine-node

```bash
cd examples/engine-node
npm install
npm run dev
# 自定义：node render.mjs 输入.ofd 输出目录 144
```

默认把 `samples/doc1File.ofd`（11 页）导出到 `out/`。

## viewer-ui-vue / viewer-ui-react

```bash
cd examples/viewer-ui-vue   # 或 examples/viewer-ui-react
npm install
npm run dev
```

## 样例文件

每个示例自带 `samples/`（Vite 示例为 `public/samples/`），默认样例来自仓库根目录
`ofd_pdf_match/`：

- `doc1File.ofd`：11 页，内嵌字体，渲染无字体缺失警告；
- `dense-text-perf.ofd`：2 页密集文本，内嵌字体。

## 关于 npm 引用

`engine-node`、`viewer-ui-vue`、`viewer-ui-react` 的 `package.json` 按正式发布后的方式
引用 npm 包（`^0.1.0`）。这些包尚未发布到 npm 时，本地调试可以临时把依赖改为本地路径：

```json
"@ofdrw/ofdrw-viewer-engine": "file:../../packages/ofdrw-viewer-engine"
```

或把它们临时加入根 `pnpm-workspace.yaml` 后用 `workspace:*` 安装。调试完成后请改回
npm 引用，不要提交本地路径。

`engine-h5` 不使用包管理；需要联调当前仓库代码时，重新构建并替换它预置的
`global.js`：

```bash
pnpm -C packages/ofdrw-viewer-engine build
cp packages/ofdrw-viewer-engine/dist/global.js examples/engine-h5/global.js
```