# OFDRW-Viewer

[![在线体验](https://img.shields.io/badge/%E5%9C%A8%E7%BA%BF%E4%BD%93%E9%AA%8C-GitHub%20Pages-2563eb)](https://ofdrw.github.io/ofdrw-viewer/) [![engine](https://img.shields.io/npm/v/@ofdrw/ofdrw-viewer-engine?label=engine)](https://www.npmjs.com/package/@ofdrw/ofdrw-viewer-engine) [![GB/T 33190-2016](https://img.shields.io/badge/GB%2FT%2033190--2016-%E7%AC%A6%E5%90%88-1f6feb)](https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=3AF6682D939116B6F5EED53D01A9DB5D) [![支持平台](https://img.shields.io/badge/%E6%94%AF%E6%8C%81%E5%B9%B3%E5%8F%B0-Browser%20%7C%20Node.js%20%7C%20%E5%B0%8F%E7%A8%8B%E5%BA%8F-2ea44f)](packages/ofdrw-viewer-engine/README.md) [![license](https://img.shields.io/github/license/ofdrw/ofdrw-viewer?label=license)](LICENSE) [![node](https://img.shields.io/badge/node-%3E%3D22-339933)](https://nodejs.org/)

## ✨ 功能概述

按照 GB/T 33190-2016《电子文件存储与交换格式 版式文档》标准实现的跨平台 OFD 可视化工具链，包含跨平台 OFD页面渲染引擎、密码能力包、图片转换工具和 Web 阅读器。覆盖页面渲染、CLI工具和可视化阅读器、文档解密、文档验证，帮助开发者快速构建可视化的 OFD 应用。

![渲染能力展示](docs/img/ofd-render-showcase.gif)


## 🧩 应用生态

### 📖 OFD Web阅读器

 [**ofdrw/ofdrw-viewer-ui**](packages/ofdrw-viewer-ui/README.md) **HTML5 OFD阅读器**，功能完备的产品级别的HTML5 OFD阅读器，支持可视化浏览、书签、缩略图、解密、验证等阅读器功能，可以用于快速接入实现OFD在线预览；

[**👉 在线体验**： *https://ofdrw.github.io/ofdrw-viewer/index.html*](https://ofdrw.github.io/ofdrw-viewer/index.html)

![ofdrw/ofdrw-viewer-ui 演示](docs/img/ofdrw-viewer-ui-showcase.gif)


[👉 *进入了解 ofdrw-viewer-ui*🔗](packages/ofdrw-viewer-ui/README.md)

### 🛠️ CLI图片转换工具

[**ofdrw/ofdrw-viewer-cli**](packages/ofdrw-viewer-cli/README.md) **多平台终端图片转换命令**，CLI命令把 OFD 转换为图片格式（PNG/JPEG/WebP），并支持可导出文字位置，适用于终端环境OFD图片转换、智能体协作；

![ofdrw-viewer-cli 演示](packages/ofdrw-viewer-cli/docs/img/demo.gif)

[👉 *进入了解 ofdrw-viewer-cli*🔗](packages/ofdrw-viewer-cli/README.md)

### 🎨 OFD渲染引擎库

[**ofdrw/ofdrw-viewer-engine**](packages/ofdrw-viewer-engine/README.md) **OFD 渲染引擎库**，通过 API 控制 OFD 页面绘制、文档信息获取，支持浏览器、Node.js 和小程序等多平台；

```ts
import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';

const doc = await OFDDocument.open({ source: { kind: 'blob', blob: file } });
const page = await doc.getPage(0);
const viewport = page.getViewport({ dpi: 144 });   // 默认 96 DPI

canvas.width = Math.ceil(viewport.width);
canvas.height = Math.ceil(viewport.height);
await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;

await doc.close();
```

[👉 *进入了解 ofdrw-viewer-engine*🔗](packages/ofdrw-viewer-engine/README.md)



### 🔐 OFD密码工具库

[**ofdrw/ofdrw-viewer-crypto**](packages/ofdrw-viewer-crypto/README.md) **OFD 密码能力包**，检测/解密加密文档，解析电子印章与时间戳，提供 SM2/SM3/SM4 签名验证、证书链/信任根校验与防夹带完整性检查；

[👉 *进入了解 ofdrw-viewer-crypto*🔗](packages/ofdrw-viewer-crypto/README.md)

## 🤖 智能体集成

ofdrw-viewer 提供了系列智能体协作指南（SKILL），若你是智能体，请按照以下指南完成接入与调用：

- 🤖 [**ofdrw-viewer-cli** · SKILL](packages/ofdrw-viewer-cli/skills/SKILL.md) — 在终端把 OFD 逐页转换为 PNG/JPEG/WebP 图片，可同时导出带坐标的文字，也能查询文档结构与加密信息、验证签名和完整性。
- 🔐 [**ofdrw-viewer-crypto** · SKILL](packages/ofdrw-viewer-crypto/skills/SKILL.md) — 检测并解密加密 OFD，解析电子印章与时间戳，校验签名、证书链以及文档是否被夹带篡改。
- 🎨 [**ofdrw-viewer-engine** · SKILL](packages/ofdrw-viewer-engine/skills/SKILL.md) — 将 OFD 页面渲染到 Canvas，支持缩略图、图片导出、带坐标的文字层与文档信息读取，适用于浏览器、Node.js、小程序等环境。
- 📖 [**ofdrw-viewer-ui** · SKILL](packages/ofdrw-viewer-ui/skills/SKILL.md) — 在网页中嵌入完整的 OFD 阅读器，具备滚动缩放、缩略图与大纲、文本搜索、打印导出、加密文档打开与签章验证等能力。

## 🛠️ OFD 生成与编辑

若您需要生成、编辑 OFD，请使用 [https://github.com/ofdrw/ofdrw](https://github.com/ofdrw/ofdrw)。

## ⚖️ 免责声明 / Disclaimer

使用本项目前请阅读：[免责声明（中英双语）](DISCLAIMER.md)。

Please read before using this project: [Disclaimer (Chinese & English)](DISCLAIMER.md).

## 📄 许可证

本项目采用 [MIT License](LICENSE) 开源。
Copyright (c) 2026 Quan Guanyu
