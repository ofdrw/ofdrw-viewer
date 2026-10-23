# @ofdrw/ofdrw-viewer-ui

[![npm version](https://img.shields.io/npm/v/@ofdrw/ofdrw-viewer-ui)](https://www.npmjs.com/package/@ofdrw/ofdrw-viewer-ui) [![GitHub release](https://img.shields.io/github/v/release/ofdrw/ofdrw-viewer)](https://github.com/ofdrw/ofdrw-viewer/releases) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE)
[![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)](../../examples/viewer-ui-react/) [![Vue](https://img.shields.io/badge/Vue.js-35495E?logo=vuedotjs&logoColor=4FC08D)](../../examples/viewer-ui-vue/) [![Web Component](https://img.shields.io/badge/Web%20Component-20232A?logo=webcomponentsdotorg&logoColor=white)](skills/SKILL.md#web-component)

## ✨ 功能概述

**ofdrw-viewer-ui** 是一款产品级的 Web OFD 阅读器组件，内置连续滚动、缩放/旋转、缩略图、大纲、书签、全文查找、文本选择、打印与图片导出等功能。组件基于 ofdrw-viewer-engine 实现高质量的 OFD 页面绘制，同时提供 Web Component 与 React、Vue API适配，可直接嵌入现有应用在线预览 OFD 文件，并自适应桌面、平板与手机。也支持用 `?file=` / `?base64=` 查询参数直接打开文档。

> **网络获取由 UI 负责，engine 只消费字节。** URL 来源在 UI 内部转换为 `HttpByteSource`（HTTP Range、整包回退、取消），解密与渲染共用同一字节源；engine 不再联网或读取本地文件。部署时需服务端允许 CORS 与 `Range`，并暴露 `Content-Range`。

![OFD Web 阅读器演示](../../docs/img/ofdrw-viewer-ui-showcase.gif)

## 🚀 在线体验

[**👉 打开在线演示**](https://ofdrw.github.io/ofdrw-viewer/)：你可以快速了解ofdrw-viewer-ui阅读器OFD页面绘制效果和功能。

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
  source: file, // 可选；File / Blob / ArrayBuffer / Uint8Array / URL / { url, headers? }
});

await viewer.ready;
```

URL 来源由 UI 下载：内部创建 `HttpByteSource` 按 Range 读取，engine 只收字节。服务端需允许 CORS 并暴露 `Content-Range`；鉴权头用来源 `headers` 或 `requestInit.headers`（来源优先，`credentials` 不转发）。`HttpByteSource`/`HttpByteSourceOptions` 也从公共入口导出，供宿主复用同一套 HTTP 读取逻辑，详见 [SKILL.md 网络来源与字节源](skills/SKILL.md#网络来源与字节源)。

### 通过 URI 参数预览

不传 `source` 时，阅读器在打开时读取当前页面的 `?file=` 或 `?base64=`，适合做一个“贴链接即可预览”的页面。优先级为：`open(source)` > 构造 `source` > `?file=` > `?base64=`；两者同时出现时 `file` 优先并产生 `W_QUERY_SOURCE` warning。

```text
# 绝对地址：值用 encodeURIComponent 编码
https://viewer.example.com/?file=https%3A%2F%2Ffiles.example.com%2Fofd%2Fdemo.ofd

# 同源相对路由：以当前页面为 base 解析
https://viewer.example.com/app/?file=%2Fapi%2Fofd%2F123.ofd

# 含中文/空格的路径（/api/ofd/发票 2026.ofd）
https://viewer.example.com/?file=%2Fapi%2Fofd%2F%E5%8F%91%E7%A5%A8%202026.ofd
```

`file` 只接受 `http(s)`，`file://` 不支持；本地文件请用 `File`/`Blob`。`base64` 支持纯值或 `data:application/ofd;base64,...`、URL-safe、缺 padding，默认上限 64 MiB，非法或超限抛 `OFD_INVALID_OPTION`。**base64 会进入浏览器历史、服务器日志和 Referer，敏感文档不建议使用。**

```js
const target = new URL('/api/ofd/发票 2026.ofd', location.href).href;
const previewUrl = `${location.origin}${location.pathname}?file=${encodeURIComponent(target)}`;
```

完整规则、参数表与安全提醒见 [API.md 通过 URI 参数预览](skills/API.md#通过-uri-参数预览)。

完整选项、方法、事件与使用边界见 [API.md](skills/API.md)。

各平台演示代码：

- [Web Component 示例](skills/SKILL.md#web-component)
- [React 示例](skills/SKILL.md#react)
- [Vue 示例](skills/SKILL.md#vue)

可直接运行的示例项目：

- [React 示例项目](../../examples/viewer-ui-react/)：Vite + React 19
- [Vue 示例项目](../../examples/viewer-ui-vue/)：Vite + Vue 3

## 🤖 智能体 SKILL

本包提供智能体协作指南（SKILL），若你是智能体，请按照以下指南完成阅读器接入与调用：

- 📖 [**ofdrw-viewer-ui** · SKILL](skills/SKILL.md) — 在网页中嵌入完整的 OFD 阅读器，具备滚动缩放、缩略图与大纲、文本搜索、打印导出、加密文档打开与签章验证等能力。

## 📄 许可证

本项目采用 [MIT](../../LICENSE) 许可证，Copyright (c) 2026 Quan Guanyu。
