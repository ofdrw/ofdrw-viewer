# @ofdrw/ofdrw-viewer-ui

[![npm version](https://img.shields.io/npm/v/@ofdrw/ofdrw-viewer-ui)](https://www.npmjs.com/package/@ofdrw/ofdrw-viewer-ui)
[![GitHub release](https://img.shields.io/github/v/release/ofdrw/ofdrw-viewer)](https://github.com/ofdrw/ofdrw-viewer/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE)

## ✨ 功能概述

**ofdrw-viewer-ui** 是框架无关的 OFD 阅读器 UI，内置连续滚动、缩放/旋转、缩略图、大纲、书签、全文查找、文本选择、打印与图片导出。提供 `<ofd-viewer>` Web Component 以及 React、Vue 薄适配，可直接嵌入现有应用。

![OFD Web 阅读器演示](../../docs/img/ofdrw-viewer-ui-showcase.gif)

## 🚀 在线体验

[**👉 打开在线演示**](https://ofdrw.github.io/ofdrw-viewer/)：无需安装，可直接选择本地 `.ofd` 文件或使用内置样例；文档在浏览器本地解析与渲染，不会上传。

## 📦 安装

```bash
npm install @ofdrw/ofdrw-viewer-ui
```

支持原生 HTML / Web Component、React 18/19 与 Vue 3.3+；三者共用同一套 `OFDViewer` 实例与 API，可按现有工程选择接入方式。

## 🚀 快速开始 Quick Start

以下示例以原生 HTML + ES Module 环境演示。样式必须由宿主显式引入，阅读器容器需要有确定高度：

```html
<div id="viewer" style="height: 640px"></div>
```

```ts
import { OFDViewer } from '@ofdrw/ofdrw-viewer-ui';
import '@ofdrw/ofdrw-viewer-ui/style.css';

const viewer = new OFDViewer({
  container: '#viewer',
  source: file, // File / Blob / ArrayBuffer / Uint8Array / URL / { url, headers? }
});

await viewer.ready;
```

完整选项、方法、事件与使用边界见 [SKILL.md](skills/SKILL.md)。

各平台演示代码：

- [Web Component 示例](skills/SKILL.md#web-component)
- [React 示例](skills/SKILL.md#react)
- [Vue 示例](skills/SKILL.md#vue)

## 🤖 智能体 SKILL

智能体读一下 [SKILL.md](skills/SKILL.md)，就能快速把 OFD 阅读器嵌入页面，并了解导航、缩放、查找、打印和导出等常用能力。

## 📄 许可证

本项目采用 [MIT](../../LICENSE) 许可证，Copyright (c) 2026 Quan Guanyu。
