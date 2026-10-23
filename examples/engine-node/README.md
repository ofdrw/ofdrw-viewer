# Node.js 渲染示例（engine-node）

用 [`@ofdrw/ofdrw-viewer-engine`](../../packages/ofdrw-viewer-engine/README.md) 解析 OFD，
用 [`@napi-rs/canvas`](https://www.npmjs.com/package/@napi-rs/canvas) 提供 Canvas、图片解码
和 PNG 编码，在 Node.js 里把每一页渲染并导出为 PNG 文件。

这是一个独立的 npm 项目（ESM），不依赖仓库里的其他构建脚本。

## 环境要求

- Node.js >= 22

## 安装

```bash
cd examples/engine-node
npm install
```

`npm install` 会根据 `package.json` 安装 npm 上发布的
`@ofdrw/ofdrw-viewer-engine` 与 `@napi-rs/canvas`。

## 运行

```bash
# 默认：渲染 samples/doc1File.ofd，导出到 out/，144 DPI
npm run dev

# 等价于 npm run dev
npm start

# 直接调用脚本
node render.mjs
```

## 参数

```text
node render.mjs [input.ofd] [outDir] [dpi] [--font <字体路径>]
```

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `input.ofd` | `samples/doc1File.ofd` | 输入 OFD 文件；默认值基于脚本位置定位，不依赖当前工作目录 |
| `outDir` | `out` | 输出目录，相对当前工作目录；不存在时自动创建 |
| `dpi` | `144` | 输出精度，单位 DPI，必须大于 0 |
| `--font` | 无 | 额外补充的中文字体文件（TTF/OTF/TTC），用于缺字回退 |

示例：

```bash
# 300 DPI 渲染另一个样例
node render.mjs samples/dense-text-perf.ofd out 300

# 为缺少中文字体的文档补充字体
node render.mjs samples/dense-text-perf.ofd out 144 --font /path/to/NotoSansSC-Regular.otf
```

脚本按页调用 `page.exportImage({ dpi })`，输出文件名为 `page-1.png`、`page-2.png`……
终端会打印每页的像素尺寸和文件路径。渲染结束后统一 `doc.close()` 释放资源。

## 字体说明

引擎**不内置 CJK 字体**，字体由宿主提供：文档内嵌的 FontFile 会优先使用，缺失时可通过
`--font` 注入一个补充字体（内部对应 `OFDOpenOptions.supplementaryFonts`，并用
`OFDOpenOptions.loadInput` 读取本地字体文件）。缺少字体或字形只会产生 warning，不会中断
渲染，但文字可能缺字或回退，因此处理含中文的外部文档时建议显式传入字体。

本示例自带的两个样例都内嵌了字体，无需额外指定 `--font`。

## 输出

```text
out/
├── page-1.png
├── page-2.png
└── ...
```

输出固定为 PNG（白底），文件名从 1 开始编号。

## 样例来源

`samples/` 下的文件复制自仓库根目录的 `ofd_pdf_match/`：

- `doc1File.ofd`：11 页，内嵌字体，渲染时 0 warning，作为默认输入；
- `dense-text-perf.ofd`：2 页，密集文本，内嵌字体，渲染时 0 warning。

这样选择是为了避免使用缺少中文字体的旧样例，导致导出的图片几乎空白。

## 依赖与发布前本地引用

`package.json` 的依赖只写 npm 版本号（`^0.1.0`、`^1.0.13`），不使用
`workspace:`、`file:` 或 `link:` 协议，保证示例可以脱离 monorepo 直接 `npm install`。

需要在发布前验证仓库内**未发布**的引擎改动时，先构建引擎，再从本示例目录临时安装本地目录：

```bash
# 在仓库根目录
pnpm -C packages/ofdrw-viewer-engine build

# 在 examples/engine-node 下，仅覆盖 node_modules，不改 package.json
npm install --no-save ../../packages/ofdrw-viewer-engine
```

验证完成后删除 `node_modules` 重新 `npm install` 即可恢复。不要把 `file:`/`workspace:`/
`link:` 引用提交进 `package.json`。