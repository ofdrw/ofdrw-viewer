# OFD Viewer React 接入示例

在**普通 npm + Vite** 项目中，用 `@ofdrw/ofdrw-viewer-ui/react` 接入 OFD 阅读器的最小示例。

- React 19（`react` / `react-dom`）
- Vite 8 + `@vitejs/plugin-react`
- 独立 `package.json`，依赖均为 npm 版本号，不使用 `workspace:` / `file:` / `link:`

## 功能

- 页面加载后自动打开内置样例 `/samples/doc1File.ofd`（11 页，内嵌字体）。
- 顶部工具条：选择本地 OFD 文件、重新打开默认样例、打开第二份样例
  `dense-text-perf.ofd`（2 页，内嵌字体）、显示文档名与当前页码、显示错误/警告。
- 主体 `<OFDViewer>` 占满剩余高度；阅读器自带的工具栏、侧栏、缩放、查找等能力
  保持默认开启。
- 切换文档时只更新 React `source` state，由适配器内部调用核心 `open()`，不手动创建
  核心实例。

## 目录结构

```text
examples/viewer-ui-react/
├── index.html
├── package.json
├── vite.config.js
├── public/
│   └── samples/
│       ├── doc1File.ofd
│       └── dense-text-perf.ofd
└── src/
    ├── main.jsx      # 挂载入口，显式引入主题样式
    ├── App.jsx       # 工具条 + OFDViewer
    └── style.css     # 100vh flex 布局
```

## 运行

要求 Node.js >= 22（与 `@ofdrw/ofdrw-viewer-ui` 的 `engines` 一致）。

```bash
cd examples/viewer-ui-react
npm install
npm run dev
```

打开 <http://localhost:5182>。端口通过 `vite --port 5182 --strictPort` 固定，被占用时
会直接报错而不是切换到其他端口。

## 构建与预览

```bash
npm run build     # 产物输出到 dist/
npm run preview   # 以 5182 端口预览构建产物
```

## 内置样例

| 文件 | 页数 | 说明 |
| --- | --- | --- |
| `public/samples/doc1File.ofd` | 11 | 默认样例，内嵌字体 |
| `public/samples/dense-text-perf.ofd` | 2 | 密集文本样例，内嵌字体 |

两份样例均复制自仓库根目录的 `ofd_pdf_match/`（本地渲染对照素材，文件名保持不变），
原文件为 `ofd_pdf_match/doc1File.ofd` 与 `ofd_pdf_match/dense-text-perf.ofd`。二者都
内嵌字体，正常打开时预期为 0 条字体缺失 warning。`ofd_pdf_match/` 不纳入版本管理，
分发/迁移示例时请一并携带这两个样例文件。

页面通过 `fetch` 把样例读取成 `ArrayBuffer` 后交给 `source`：这样每次“重新打开样例”
都会得到新的 `ArrayBuffer` 引用，适配器会再次调用核心 `open()`；若直接传相同的 URL
字符串，React 侧引用不变，不会重复打开同一文档。

## 接入要点

```jsx
import { OFDViewer } from '@ofdrw/ofdrw-viewer-ui/react';
import '@ofdrw/ofdrw-viewer-ui/style.css';

<OFDViewer
  source={source}                       // File / Blob / ArrayBuffer / URL 等
  onReady={() => {}}
  onDocumentOpen={({ pageCount }) => {}}
  onPageChange={({ pageNumber }) => {}} // camelCase，不是 page-change
  onWarning={({ code, message }) => {}}
  onError={({ code, message }) => {}}
/>;
```

1. **样式必须显式引入**：`import '@ofdrw/ofdrw-viewer-ui/style.css'`，wrapper 不会
   自动注入。
2. **事件名是 camelCase**：`onReady`、`onPageChange`、`onWarning`、`onError` 等；
   kebab-case（如 `page-change`）是 Vue 适配器的写法。
3. **切换文档**：直接给 `source` 赋新值（`File` / `ArrayBuffer` 等），适配器内部调用
   `open()`，不要手动 `new` 核心 `OFDViewer`。
4. **高度**：组件默认 `width/height: 100%`，父容器必须有确定高度。本示例使用
   `.app { height: 100vh; display: flex; flex-direction: column }` +
   `.viewer-area { flex: 1; min-height: 0 }`。
5. 可选：通过 `useRef` 获取 `OFDViewerHandle` 调用 `goToPage`、`setScale`、`find`、
   `print` 等命令；本示例只做最小接入，未使用 ref。

## 包发布前本地验证

`package.json` 中的依赖是 npm 版本号。若 `@ofdrw/ofdrw-viewer-ui@0.1.0` 尚未发布到
registry，可用 workspace 构建出的 tgz 做临时验证；`--no-save` 不会改写
`package.json`。

1. 构建并打包三个 workspace 包（UI 依赖 engine 与 crypto）：

   ```bash
   pnpm -C packages/ofdrw-viewer-engine build
   pnpm -C packages/ofdrw-viewer-crypto build
   pnpm -C packages/ofdrw-viewer-ui build

   pnpm -C packages/ofdrw-viewer-engine pack
   pnpm -C packages/ofdrw-viewer-crypto pack
   pnpm -C packages/ofdrw-viewer-ui pack
   ```

2. 在示例目录安装三个 tgz（不写入 `package.json`）：

   ```bash
   cd examples/viewer-ui-react
   npm install --no-save \
     ../../packages/ofdrw-viewer-engine/ofdrw-ofdrw-viewer-engine-0.1.0.tgz \
     ../../packages/ofdrw-viewer-crypto/ofdrw-ofdrw-viewer-crypto-0.1.0.tgz \
     ../../packages/ofdrw-viewer-ui/ofdrw-ofdrw-viewer-ui-0.1.0.tgz
   ```

   其余依赖（React、Vite、fflate 等）仍从 registry 安装。

3. 启动并逐项确认：

   ```bash
   npm run dev
   ```

   - 默认自动打开 `doc1File.ofd`，总页数为 11，工具条显示“阅读器已就绪”；
   - 点击“打开 dense-text-perf.ofd”，总页数变为 2；
   - 点击“重新打开样例”可重新加载默认样例；
   - 选择本地 `.ofd` 文件可替换文档，页码随滚动更新；
   - 无字体缺失 warning；错误会显示在工具条右侧。

4. 验证结束后恢复为 registry 依赖（`--no-save` 仍会在 `package-lock.json` 中记录
   tgz 地址）：

   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```

## 常见问题

- **页面空白或高度为 0**：检查父容器是否有确定高度；本示例的 `.viewer-area` 必须
  同时设置 `flex: 1` 与 `min-height: 0`。
- **没有阅读器工具栏/样式**：确认已显式引入 `@ofdrw/ofdrw-viewer-ui/style.css`。
- **切换文档无效**：确保给 `source` 赋的是新的引用（新的 `ArrayBuffer`/`File`），
  而不是原地修改同一个对象。
- **打开失败**：查看工具条错误信息（包含诊断码与消息），或通过 `onError` 回调接入
  宿主日志。