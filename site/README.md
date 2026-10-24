# 在线演示站

`ofdrw-viewer-ui` 的静态演示站，部署在 GitHub Pages 上，访问链接：

**<https://ofdrw.github.io/ofdrw-viewer/>**

页面只使用 `<ofd-viewer>` Web Component，支持打开本地 `.ofd` 文件、内置样例、主题与语言切换，并在状态栏显示 UI / engine / crypto 版本号。所有文档都在浏览器本地解析与渲染，不会上传。

站点不再自己解析文档 URL：直接用 UI 的查询参数预览能力。

- `?file=`：完整 http(s) URL，或相对当前页面的路径（如 `?file=samples/doc1File.ofd`）；相对路径由 UI 按页面地址解析，部署到子路径也无需额外处理。
- `?base64=`：纯 Base64 或 `data:application/ofd;base64,...` 形式的内联文档。
- 两者同时存在时 `file` 优先；切换示例或本地文件时，站点会把 `?file=` 同步到地址栏，便于复制分享。

示例：

```text
https://ofdrw.github.io/ofdrw-viewer/?file=samples/doc1File.ofd
https://ofdrw.github.io/ofdrw-viewer/?file=https%3A%2F%2Fexample.com%2Fdemo.ofd
```

本目录是独立的 pnpm workspace 包 `@ofdrw/ofdrw-viewer-site`，不属于 UI 包：它直接引用
`packages/ofdrw-viewer-ui/src` 源码构建，不经过 UI 包的 `dist`。

## 底部演示控件的隐藏

页面底部的悬浮控件（打开本地 OFD、示例、主题、语言、版本号、GitHub）默认**自动隐藏**：

- 进入页面时（未使用 `?dock=off`）先完整显示 **2 秒**再淡出，提示底部有这些入口；
- 鼠标靠近视口底部（进入 72px 高的感应区）或悬停在控件上时淡入，移出后延时 400ms 淡出；
- 手机等触摸设备轻触底部唤出，操作控件期间保持可见；
- 用键盘 Tab 聚焦到控件内时保持可见。

需要彻底隐藏（适合嵌入 iframe、截图、只读分享等场景），使用地址参数：

```text
https://ofdrw.github.io/ofdrw-viewer/?dock=off&file=samples/doc1File.ofd
```

- `?dock=off`（等价写法：`ui=0`、`dock=0`、`dock=hidden`）：控件完全隐藏，仅保留阅读器内置工具栏。
- `?dock=on` / `?dock=auto`：恢复自动隐藏，同时清除已记住的隐藏偏好。
- 隐藏选择会写入 `sessionStorage`，之后去掉参数刷新仍然保持隐藏，关闭浏览器标签页后清除；
  带 `dock` 参数打开时会同步写回地址栏，便于复制分享。
- 状态提示（toast）不受该参数影响。

## 本地开发

演示站直接引用 UI 源码，而源码依赖 engine/crypto 的 `dist`，因此首次运行前需要按拓扑顺序构建依赖包：

```bash
# 在仓库根目录
pnpm install
pnpm --filter @ofdrw/ofdrw-viewer-engine build
pnpm --filter @ofdrw/ofdrw-viewer-crypto build
pnpm --filter @ofdrw/ofdrw-viewer-ui build

pnpm -C site dev
```

打开 <http://127.0.0.1:5183/> 即可。修改 `site/` 或 `packages/ofdrw-viewer-ui/src/` 下的代码会热更新。

## 构建产物

```bash
pnpm -C site build
```

产物输出到仓库根目录 `site-dist/`（已在 `.gitignore` 中忽略），可直接交给任意静态服务器托管：

```bash
python3 -m http.server 8080 -d site-dist
```

> `vite preview` 会对 Range 请求的响应一并压缩，导致浏览器打开 `.ofd` 时报
> `ERR_CONTENT_DECODING_FAILED`；预览构建产物请使用静态服务器，开发调试用 `pnpm -C site dev`。

部署到子路径时需要注入 `BASE_PATH`，例如 GitHub Pages 项目站点：

```bash
BASE_PATH=/ofdrw-viewer/ pnpm -C site build
```

## 目录结构

```
site/
├── index.html        # 页面骨架：阅读器、底部演示控件与状态提示
├── main.ts           # 交互逻辑：打开文件/样例、主题/语言、版本与控件自动隐藏
├── style.css         # 页面外壳样式（不覆盖阅读器内部样式）
├── vite.config.ts    # base、端口与构建输出
├── vite-env.d.ts     # Vite 环境类型
├── package.json      # 独立 workspace 包与本地脚本
└── public/
    ├── .nojekyll     # 兼容非 Actions 的传统 Pages 部署
    └── samples/      # 内置示例 OFD
```