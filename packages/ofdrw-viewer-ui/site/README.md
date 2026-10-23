# 在线演示站

`ofdrw-viewer-ui` 的静态演示站，部署在 GitHub Pages 上，访问链接：

**<https://ofdrw.github.io/ofdrw-viewer/>**

页面只使用 `<ofd-viewer>` Web Component，支持打开本地 `.ofd` 文件、内置样例、主题与语言切换，并在状态栏显示 UI / engine / crypto 版本号。所有文档都在浏览器本地解析与渲染，不会上传。

## 本地开发

演示站直接引用 `../src` 源码，而源码依赖 engine/crypto 的 `dist`，因此首次运行前需要按拓扑顺序构建依赖包：

```bash
# 在仓库根目录
pnpm install
pnpm --filter @ofdrw/ofdrw-viewer-engine build
pnpm --filter @ofdrw/ofdrw-viewer-crypto build
pnpm --filter @ofdrw/ofdrw-viewer-ui build

pnpm --filter @ofdrw/ofdrw-viewer-ui dev:site
```

打开 <http://127.0.0.1:5183/> 即可。修改 `src/` 或 `site/` 下的代码会热更新。

## 构建产物

```bash
pnpm --filter @ofdrw/ofdrw-viewer-ui build:site
```

产物输出到 `packages/ofdrw-viewer-ui/site-dist/`（已在 `.gitignore` 中忽略），可直接交给任意静态服务器托管：

```bash
python3 -m http.server 8080 -d packages/ofdrw-viewer-ui/site-dist
```

部署到子路径时需要注入 `BASE_PATH`，例如 GitHub Pages 项目站点：

```bash
BASE_PATH=/ofdrw-viewer/ pnpm --filter @ofdrw/ofdrw-viewer-ui build:site
```

## 自动部署

[`.github/workflows/pages.yml`](../../../.github/workflows/pages.yml) 在 `main` 分支推送后自动构建并部署，也可在 Actions 页面手动触发。

首次部署前需要在仓库 **Settings → Pages → Build and deployment** 中把 **Source** 设为 **GitHub Actions**；否则 `deploy-pages` 步骤会因 Pages 未启用而失败。

工作流根据仓库名自动计算 `BASE_PATH`：

| 仓库类型 | 站点地址 | `BASE_PATH` |
| --- | --- | --- |
| 项目仓库 `ofdrw/ofdrw-viewer` | `https://ofdrw.github.io/ofdrw-viewer/` | `/ofdrw-viewer/` |
| 用户/组织站点 `ofdrw/ofdrw.github.io` | `https://ofdrw.github.io/` | `/` |

## 目录结构

```
site/
├── index.html        # 页面骨架：顶栏、阅读器、状态栏
├── main.ts           # 交互逻辑：打开文件/样例、主题/语言、页码与版本
├── style.css         # 页面外壳样式（不覆盖阅读器内部样式）
├── vite.config.ts    # base、端口与构建输出
├── vite-env.d.ts     # Vite 环境类型
└── public/
    ├── .nojekyll     # 兼容非 Actions 的传统 Pages 部署
    └── samples/      # 内置示例 OFD
```