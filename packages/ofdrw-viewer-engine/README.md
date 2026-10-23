# @ofdrw/ofdrw-viewer-engine

[![npm version](https://img.shields.io/npm/v/@ofdrw/ofdrw-viewer-engine.svg)](https://www.npmjs.com/package/@ofdrw/ofdrw-viewer-engine)
[![GitHub release](https://img.shields.io/github/v/release/ofdrw/ofdrw-viewer)](https://github.com/ofdrw/ofdrw-viewer/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../../LICENSE)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://nodejs.org/)

## ✨ 功能概述

**ofdrw-viewer-engine** 是符合 GB/T 33190-2016 的跨平台 OFD 渲染引擎，覆盖文字、图形、图像、注解等图元对象的绘制，以及底纹填充、字体字形解析与仿射变换等图形操作；通过稳定的可视化 API 封装上述实现，使调用方可在浏览器、Node.js、Electron 与微信小程序中获得语义一致的渲染结果。

![OFD 渲染效果](../../docs/img/ofd-render-showcase.gif)

## 📦 安装

### npm 安装

若您的代码采用npm管理您可以直接使用，下面命令安装依赖：

```bash
npm install @ofdrw/ofdrw-viewer-engine
```

### CDN 安装

若您处于浏览器H5开发环境，我们建议您采用cdn 或 release预发布的离线安装，并使用标签引用：

```html
<script src="https://cdn.jsdelivr.net/npm/@ofdrw/ofdrw-viewer-engine@0.1.0/dist/ofdrw-viewer-engine.min.js"></script>
```

脚本加载成功后，引擎注册全局变量 `window.OFDRWViewer`。


## 🔎 查询版本

```ts
import { VERSION, getVersion } from '@ofdrw/ofdrw-viewer-engine';

console.log(VERSION); // 例如 0.1.0
console.log(getVersion()); // 与 VERSION 相同
```

版本号以常量形式内置于产物，浏览器与 Node.js 都能直接读取，便于日志与故障排查；`VERSION` 与
`getVersion()` 返回同值，后者适合在需要函数形式时调用。


## 🚀 快速开始 Quick Start

以浏览器为例，准备一个 OFD 文件和一个 `<canvas>`，就能画出第一页：

```ts
import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';

// file 来自 <input type="file"> 或拖拽；canvas 是页面上的画布元素
const doc = await OFDDocument.open({ source: { kind: 'blob', blob: file } });

const page = await doc.getPage(0);
const viewport = page.getViewport(); // 默认 96 DPI
canvas.width = Math.ceil(viewport.width);
canvas.height = Math.ceil(viewport.height);
await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;

await doc.close();
```

- 想要更清晰的画面，给 `getViewport({ dpi: 144 })` 传入 `dpi` 即可。
- 引擎不设置画布尺寸、不清屏、不填背景；背景交给 CSS。
- 实际项目建议用 `try/finally` 包裹渲染逻辑，确保 `doc.close()` 一定执行。

更多用法 见 [SKILL.md 常用任务](skills/SKILL.md#常用任务)，[ofdrw-viewer-engine API 文档](skills/API.md) 。


若您需要在浏览器、Node.js、Electron/Tauri 与微信小程序运行环境使用引擎，可以参考 [SKILL.md 环境适配](skills/SKILL.md#环境适配)，也可以参考我们为您准备 [示例项目](../../examples/README.md)：

- [HTML5 示例](../../examples/engine-h5/)
- [Node.js 示例](../../examples/engine-node/)


## 常见问题

**页面中有文字丢失空白？**


由于**引擎不内置任何字体**，字体由宿主提供，若您文档中的字体无法找到,将尝试会尝试您提供的默认字体，若都无法找到则会跳过这文字的绘制，详见 [SKILL.md 缺省字体与补充字体](skills/SKILL.md#缺省字体与补充字体) 与 [字体缺省方案设计](../../docs/渲染字体缺省方案设计.md)。



**加密文档如何处理？**


加密文档需先用 [@ofdrw/ofdrw-viewer-crypto](../ofdrw-viewer-crypto/README.md) 解密，再把明文容器交给引擎；详见 [SKILL.md 打开容器与加密文档](skills/SKILL.md#打开容器与加密文档)。


## 🤖 智能体 SKILL

智能体加载 SKILL 后，可以按既定流程完成 OFD 页面渲染、导出图片、读取文字坐标与元数据，并按运行环境完成 Canvas、图片解码与字体来源注入。

入口：[SKILL.md](skills/SKILL.md) · [API.md](skills/API.md)

## 📄 许可证

本项目采用 [MIT](../../LICENSE) 许可证，Copyright (c) 2026 Quan Guanyu。
