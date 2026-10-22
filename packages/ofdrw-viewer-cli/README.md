# ofdrw-viewer-cli

[![npm version](https://img.shields.io/npm/v/@ofdrw/ofdrw-viewer-cli)](https://www.npmjs.com/package/@ofdrw/ofdrw-viewer-cli)
[![GitHub release](https://img.shields.io/github/v/release/ofdrw/ofdrw-viewer)](https://github.com/ofdrw/ofdrw-viewer/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/ofdrw/ofdrw-viewer/blob/main/LICENSE)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-green)](https://nodejs.org/)

把单个本地 OFD 文件逐页导出为 PNG、JPEG 或 WebP 图片；需要文字坐标时，用 `--text` 让每页额外产出一个空间文本 JSON。图片与 JSON 使用同一页、同一 DPI、同一坐标系，可直接叠加。

![ofdrw-viewer-cli 演示](https://raw.githubusercontent.com/ofdrw/ofdrw-viewer/main/packages/ofdrw-viewer-cli/demo/demo.gif)

## 📦 安装

全局安装即可使用 `ofdrw-viewer-cli` 命令：

```bash
npm install -g @ofdrw/ofdrw-viewer-cli
```

没有 Node 环境时，从 [Releases](https://github.com/ofdrw/ofdrw-viewer/releases) 下载对应平台压缩包：Linux/macOS 为 `.tar.gz`，Windows 为 `.zip`。解压后直接运行其中的可执行文件，无需安装 Node；运行前请用同目录的 `SHA256SUMS` 校验文件。

## ⚡ 用法

### 导出全部页

```bash
ofdrw-viewer-cli input.ofd
```

默认把全部页导出为 PNG（96 DPI），输出到当前目录的 `<输入 stem>/`（如 `input/`），文件名为 `input-p001.png`、`input-p002.png` 等，页号至少补足 3 位。

### 指定页、格式与 DPI

```bash
ofdrw-viewer-cli input.ofd -o out --pages 1-3 --format jpeg --dpi 300
```

`--pages` 使用 1 起闭区间，`1-3` 表示第 1 到第 3 页（含两端）；`--format` 支持 `png`、`jpeg`、`webp`。`--dpi` 同时影响图片分辨率和文本 JSON 的坐标缩放。

### 导出空间文本

```bash
ofdrw-viewer-cli input.ofd --text
```

每页在图片之外生成一个同 stem 的 JSON（如 `input-p001.json`），内容是扁平数组，每项含 `text`、`x`、`y`、`w`、`h`。坐标单位为 px，原点在页面左上角，与同页图片使用相同 DPI。

### 补充字体目录

```bash
ofdrw-viewer-cli input.ofd -o out --font-dir ./fonts
```

`--font-dir` 会递归扫描目录中的 `.ttf`、`.otf`、`.ttc`、`.otc`（扩展名大小写不敏感），按路径排序后作为补充字体交给引擎；CLI 通过 `OFDOpenOptions.loadInput` 注入 Node `node:fs` 读取器，**真正读取字体字节并解析实际 family**。TTC/OTC 会展开其中的全部字体面参与匹配，不只看第 0 个。

- 字体目录不存在、不是目录或不可读取时，命令以用法错误（退出码 1）失败。
- 不会自动扫描系统字体、不会下载字体；缺字仍会输出 `W_FONT_MISSING`/`W_GLYPH_MISSING` warning。
- 字体匹配失败只 warning，不中断导出；建议先用小样本确认字体目录覆盖目标文档。

## 📖 完整说明

运行 `ofdrw-viewer-cli --help` 查看参数与默认值；参数、输出、JSON、退出码、错误和 SEA 的完整说明见 [SKILL.md](https://github.com/ofdrw/ofdrw-viewer/blob/main/packages/ofdrw-viewer-cli/skills/ofdrw-viewer-cli/SKILL.md)。

## 🛠️ 开发

在仓库根目录构建并运行测试：

```bash
pnpm cli:build
pnpm cli:test
```

## 📄 许可证

本项目采用 [MIT License](https://github.com/ofdrw/ofdrw-viewer/blob/main/LICENSE) 开源。Copyright (c) 2026 Quan Guanyu
