# OFD 阅读器 · Vue 3 接入示例

这是一个**普通 npm + Vite 工程**，演示如何在 Vue 3 中以最小成本接入
`@ofdrw/ofdrw-viewer-ui/vue`：使用适配器组件、显式引入主题样式、用 `shallowRef`
保存文档来源，并监听少量必要事件。

阅读器自带的工具栏、侧栏、缩放、查找等功能保持默认开启，示例没有传 `features`。

## 环境要求

- Node.js 22+（`@ofdrw/ofdrw-viewer-ui` 的 `engines` 要求 `node >=22`）
- 支持 Canvas 2D 的现代浏览器
- npm（示例按普通 npm 工程使用，依赖声明均为 npm 版本号，不使用 workspace 协议）

## 快速开始

```bash
cd examples/viewer-ui-vue
npm install
npm run dev
```

开发服务器固定监听 <http://localhost:5181>（`strictPort`，端口被占用时直接报错，
不会静默换端口）。

> `@ofdrw/ofdrw-viewer-ui@0.1.0` 尚未发布到 npm 时，直接 `npm install` 会解析失败；
> 请先按文末“包发布前本地验证”的方式用本地 tarball 安装并启动。

页面加载后会自动打开内置样例 `/samples/doc1File.ofd`。顶部工具条提供：

- **选择 OFD 文件**：读取本地文件并替换当前文档；
- **重新打开样例**：重新拉取并打开 `doc1File.ofd`；
- **密集文本样例**：打开 `dense-text-perf.ofd`；
- 当前文件名、页码/总页数、阅读器状态与错误提示。

## 构建与预览

```bash
npm run build     # 产物输出到 dist/
npm run preview   # 以静态产物启动预览，端口同样为 5181
```

## 内置样例

样例从仓库根目录的 `ofd_pdf_match/` 复制到 `public/samples/`，均内嵌字体，避免
依赖系统字体导致中文渲染空白：

| 文件 | 页数 | 用途 |
| --- | --- | --- |
| `doc1File.ofd` | 11 | 默认样例，页面加载后自动打开 |
| `dense-text-perf.ofd` | 2 | 密集文本场景，可通过工具条按钮打开 |

访问路径分别为 `/samples/doc1File.ofd` 与 `/samples/dense-text-perf.ofd`。

## 接入要点

1. **样式**：主题样式必须由宿主显式引入，且先于应用自身样式：

   ```js
   import '@ofdrw/ofdrw-viewer-ui/style.css';
   ```

2. **来源**：`source` 是必填 prop，支持 `ArrayBuffer` / `Uint8Array` / `Blob` /
   `File` / URL 字符串 / `{ url, headers }`。示例把样例 fetch 成 `ArrayBuffer`，
   用 `shallowRef` 保存，避免二进制内容被 Vue 深度响应式代理：

   ```js
   const source = shallowRef(null);
   source.value = await file.arrayBuffer();
   ```

3. **切换文档**：直接给 `source` 赋新值即可，适配器内部会调用阅读器的 `open()`；
   示例不会手动创建核心实例。每次重新打开样例都会重新 fetch，产生新的
   `ArrayBuffer`，因此即使文件相同也会触发切换。

4. **事件**：Vue 适配器使用 kebab-case 事件名，示例监听：

   | 事件 | 载荷 | 用途 |
   | --- | --- | --- |
   | `ready` | 无 | 首次打开完成，清除错误并更新状态 |
   | `document-open` | `{ pageCount }` | 更新总页数、清除错误 |
   | `page-change` | `{ pageNumber, previous }` | 更新当前页码（1-based） |
   | `error` | `{ code, message, cause? }` | 显示打开/渲染错误 |

   未使用的功能不注册监听，也不虚构事件名。

5. **高度**：阅读器根元素需要确定高度。示例用 `100vh` 的纵向 flex 布局，
   `viewer-wrap` 通过 `flex: 1; min-height: 0` 占满剩余空间。

## 包发布前本地验证

示例的 `package.json` 只引用 npm 版本号（`^0.1.0`），**没有** `workspace:` /
`file:` / `link:`。在 `@ofdrw/ofdrw-viewer-ui@0.1.0` 发布到 npm 之前，可按下面的
方式用本地构建产物验证，整个过程不会修改示例的依赖声明：

```bash
# 1. 在仓库根目录构建三个包并打包成 tarball
pnpm -C packages/ofdrw-viewer-engine build
pnpm -C packages/ofdrw-viewer-crypto build
pnpm -C packages/ofdrw-viewer-ui build

mkdir -p /tmp/ofdrw-viewer-packs
pnpm -C packages/ofdrw-viewer-engine pack --pack-destination /tmp/ofdrw-viewer-packs
pnpm -C packages/ofdrw-viewer-crypto pack --pack-destination /tmp/ofdrw-viewer-packs
pnpm -C packages/ofdrw-viewer-ui pack --pack-destination /tmp/ofdrw-viewer-packs

# 2. 用 tarball 覆盖安装（不写入 package.json / lockfile）
cd examples/viewer-ui-vue
npm install --no-save --no-package-lock /tmp/ofdrw-viewer-packs/*.tgz
npm run dev
```

验证完成后恢复正式依赖：

```bash
rm -rf node_modules package-lock.json
npm install
```

发布完成后，直接在示例目录执行 `npm install && npm run dev` 即可，无需任何本地
路径替换。

## 目录结构

```text
examples/viewer-ui-vue/
├── index.html
├── package.json
├── vite.config.js
├── README.md
├── public/
│   └── samples/
│       ├── doc1File.ofd
│       └── dense-text-perf.ofd
└── src/
    ├── main.js
    ├── App.vue
    └── style.css
```