# OFDRW-Viewer 可视化

[![engine](https://img.shields.io/npm/v/@ofdrw/ofdrw-viewer-engine?label=engine)](https://www.npmjs.com/package/@ofdrw/ofdrw-viewer-engine) [![crypto](https://img.shields.io/npm/v/@ofdrw/ofdrw-viewer-crypto?label=crypto)](https://www.npmjs.com/package/@ofdrw/ofdrw-viewer-crypto) [![cli](https://img.shields.io/npm/v/@ofdrw/ofdrw-viewer-cli?label=cli)](https://www.npmjs.com/package/@ofdrw/ofdrw-viewer-cli) [![release](https://img.shields.io/github/v/release/ofdrw/ofdrw-viewer?label=release)](https://github.com/ofdrw/ofdrw-viewer/releases) [![license](https://img.shields.io/github/license/ofdrw/ofdrw-viewer?label=license)](LICENSE) [![node](https://img.shields.io/badge/node-%3E%3D22-339933)](https://nodejs.org/)

## ✨ 功能概述

按照 GB/T 33190-2016《电子文件存储与交换格式 版式文档》标准实现的跨平台 OFD 可视化工具链，包含跨平台 OFD页面渲染引擎、密码能力包、图片转换工具和 Web 阅读器。覆盖页面渲染、CLI工具和可视化阅读器、文档解密、文档验证，帮助开发者快速构建可视化的 OFD 应用。

![渲染能力展示](docs/img/ofd-render-showcase.gif)

## 🧩 应用生态

### 📖 OFD Web阅读器

 [**ofdrw/ofdrw-viewer-ui**](packages/ofdrw-viewer-ui/README.md) **HTML5 OFD阅读器**，功能完备的产品级别的HTML5 OFD阅读器，支持可视化浏览、书签、缩略图、解密、验证等阅读器功能，可以用于快速接入实现OFD在线预览；

[👉 *进入了解 ofdrw-viewer-ui*🔗](packages/ofdrw-viewer-ui/README.md)

### 🛠️ CLI图片转换工具

[**ofdrw/ofdrw-viewer-cli**](packages/ofdrw-viewer-cli/README.md) **多平台终端图片转换命令**，CLI命令把 OFD 转换为图片格式（PNG/JPEG/WebP），并支持可导出文字位置，适用于终端环境OFD图片转换、智能体协作；

![ofdrw-viewer-cli 演示](packages/ofdrw-viewer-cli/docs/img/demo.gif)

[👉 *进入了解 ofdrw-viewer-cli*🔗](packages/ofdrw-viewer-cli/README.md)

### 🎨 OFD渲染引擎工具库

[**ofdrw/ofdrw-viewer-engine**](packages/ofdrw-viewer-engine/README.md) **OFD 渲染引擎工具库**，通过 API 控制 OFD 页面绘制、文档信息获取，支持浏览器、Node.js 和小程序等多平台；

[👉 *进入了解 ofdrw-viewer-engine*🔗](packages/ofdrw-viewer-engine/README.md)

### 🔐 OFD密码工具库

[**ofdrw/ofdrw-viewer-crypto**](packages/ofdrw-viewer-crypto/README.md) **OFD 密码能力包**，检测/解密加密文档，解析电子印章与时间戳，提供 SM2/SM3/SM4 签名验证、证书链/信任根校验与防夹带完整性检查；

[👉 *进入了解 ofdrw-viewer-crypto*🔗](packages/ofdrw-viewer-crypto/README.md)

## 📄 许可证

本项目采用 [MIT License](LICENSE) 开源。
Copyright (c) 2026 Quan Guanyu
