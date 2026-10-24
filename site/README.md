# 在线演示站

`ofdrw-viewer-ui` 的静态演示站，部署在 GitHub Pages 上，访问链接：

**<https://ofdrw.github.io/ofdrw-viewer/>**

页面只使用 `<ofd-viewer>` Web Component，支持打开本地 `.ofd` 文件、内置样例、主题、语言与字体档位切换，并在状态栏显示 UI / engine / crypto 版本号。所有文档都在浏览器本地解析与渲染，不会上传。

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

## 底部演示控件

页面底部的悬浮控件（打开本地 OFD、示例、主题、语言、版本号、GitHub）由地址参数 `dock` 控制，
**默认值为 `on`**：

| 取值 | 行为 |
| --- | --- |
| 不传参数 / `?dock=on` | 进入页面先完整显示 **3 秒**，随后自动淡出；之后鼠标靠近视口底部（72px 感应区）或悬停在控件上时淡入，移出后延时 400ms 淡出 |
| `?dock=off` | 彻底隐藏，仅保留阅读器内置工具栏（适合嵌入 iframe、截图、只读分享） |

其它说明：

- `dock` 取值不区分大小写，`1`/`true` 等同 `on`，`0`/`false`/`hidden`/`none` 等同 `off`，无法识别的值按默认 `on` 处理；
- 每次打开页面都重新按当前参数判断，不做记忆；切换示例或文件不会改变 `dock` 参数；
- 手机等触摸设备轻触底部可唤出控件，操作期间保持可见；用键盘 Tab 聚焦到控件内时同样保持可见；
- 状态提示（toast）不受该参数影响。

```text
https://ofdrw.github.io/ofdrw-viewer/?dock=off&file=samples/doc1File.ofd
```

## 内置中文字体（纯本地，不依赖 CDN）

OFD 文档普遍只声明 `FontName="宋体"`/`"黑体"` 而不内嵌字体，演示站通过 UI 的 `fonts` 选项
自带两份**随站点分发**的子集字体，断网、内网或任何 CDN 不可达的环境下都能显示中文：

| 字体 | 文件 | 体积 | 覆盖声明 | 授权 |
| --- | --- | --- | --- | --- |
| 思源宋体（Noto Serif CJK SC） | `public/fonts/source-han-serif-sc.woff2` | 11 109 788 B（约 10.6 MiB） | 宋体 / SimSun / 仿宋 / 楷体等衬线声明 | SIL Open Font License 1.1 |
| 文泉驿微米黑（WenQuanYi Micro Hei） | `public/fonts/wqy-microhei.woff2` | 1 118 044 B（约 1.07 MiB） | 黑体 / SimHei / 微软雅黑等无衬线声明 | Apache License 2.0 |

来源、子集范围（仅 CJK 基本区 `U+4E00–9FFF` + 标点/全角/基本拉丁/常用符号）与重新生成命令见
[`site/public/fonts/NOTICE.md`](./public/fonts/NOTICE.md)。构建时 `public/` 原样复制到
`site-dist/fonts/`；字体不进入任何 npm 包。

### 档位与加载优先级

| 档位 | 配置 | 说明 |
| --- | --- | --- |
| `auto`（默认） | 见下 | 仅本地双字体 |
| `off` | `fonts: undefined` | 不加载任何字体，用于对比缺字现象 |

`site/main.ts` 的 `SITE_FONTS`：

- `default`：本地 `source-han-serif-sc.woff2`（唯一来源）；
- `supplementary`：本地 `wqy-microhei.woff2`（唯一来源）；
- 两份字体都同时覆盖基本拉丁与常用标点，因此不需要额外的西文补字来源，也不回落到任何 CDN；
- `aliases`：追加两组别名——
  衬线组 `宋体/simsun/nsimsun/新宋体/notoserifcjksc/notoserifsc/sourcehanserifsc/思源宋体`，
  无衬线组 `黑体/simhei/heiti/微软雅黑/microsoftyahei/wenquanyimicrohei/文泉驿微米黑`。
  UI 的 `fonts.aliases` 是「引擎内置组 + 追加」语义，不会丢内置的仿宋/楷体等映射。

本地路径用 `import.meta.env.BASE_URL` 拼接（`siteAsset()`），部署到 GitHub Pages 子路径
（`BASE_PATH=/ofdrw-viewer/`）时仍能取到 `fonts/...`。

**降级**：本地文件 404 或读取失败只产生一次 `W_FONT_MISSING`（状态栏提示、控制台
`[ofd-viewer] warning W_FONT_MISSING ...`）；文档仍可打开，缺字体的文字对象被跳过。
由于不再配置 CDN 回落，此时中文将无法显示——这是「纯本地、可离线」的取舍。

切换档位会重建 `<ofd-viewer>` 并按新档位重新打开当前文档；地址参数 `?fonts=off` 可把初始档位设为 `off`。

### 替换与裁剪

- 只需要一种字体：删除对应 `.woff2` 并去掉 `SITE_FONTS` 中的条目（缺失文件只产生 warning）。
- 需要更小体积：缩小 `scripts/build-site-fonts.py` 的 `SUBSET_UNICODES`（例如只保留应用常用字），
  重新生成后同步 `NOTICE.md` 与 `site/test/site-fonts.test.ts` 中的体积断言。
- 重新生成：`python3 -m venv .venv-fonts && .venv-fonts/bin/pip install "fonttools[woff]" brotli`，
  然后 `FONTSUBSET=.venv-fonts/bin/pyftsubset python3 scripts/build-site-fonts.py`。

### 核验样本

`ofd_pdf_match/拿来主义_page6.ofd`：`PublicRes.xml` 只声明 `FontName="宋体"`、**没有 `FontFile`**。
字体档位 `off` 时两页必然整页空白（控制台 `W_FONT_MISSING`）；`auto` 时由本地思源宋体渲染正文。
黑体场景可用把 TextObject 字体改成黑体、删除内嵌字体的样本验证（本仓库任务记录中使用了以
`透明度文字.ofd` 为底的临时样本，不入库）。

样本不复制进 `site/public/samples`（避免站点体积），只用于本地核验。开发服务器已把仓库根目录加入
`server.fs.allow`，可直接打开：

```text
http://127.0.0.1:5183/?file=/@fs/<仓库绝对路径>/ofd_pdf_match/拿来主义_page6.ofd
```

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
├── main.ts           # 交互逻辑：打开文件/样例、主题/语言、版本与 dock 显隐
├── style.css         # 页面外壳样式（不覆盖阅读器内部样式）
├── vite.config.ts    # base、端口与构建输出
├── vite-env.d.ts     # Vite 环境类型
├── package.json      # 独立 workspace 包与本地脚本
└── public/
    ├── .nojekyll     # 兼容非 Actions 的传统 Pages 部署
    ├── fonts/        # 本地兜底字体（思源宋体 + 文泉驿微米黑子集）与 NOTICE.md
    └── samples/      # 内置示例 OFD
```