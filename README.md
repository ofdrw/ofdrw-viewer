# ofdrw-viewer

[![engine](https://img.shields.io/npm/v/@ofdrw/ofdrw-viewer-engine?label=engine)](https://www.npmjs.com/package/@ofdrw/ofdrw-viewer-engine) [![crypto](https://img.shields.io/npm/v/@ofdrw/ofdrw-viewer-crypto?label=crypto)](https://www.npmjs.com/package/@ofdrw/ofdrw-viewer-crypto) [![cli](https://img.shields.io/npm/v/@ofdrw/ofdrw-viewer-cli?label=cli)](https://www.npmjs.com/package/@ofdrw/ofdrw-viewer-cli) [![release](https://img.shields.io/github/v/release/ofdrw/ofdrw-viewer?label=release)](https://github.com/ofdrw/ofdrw-viewer/releases) [![license](https://img.shields.io/github/license/ofdrw/ofdrw-viewer?label=license)](LICENSE) [![node](https://img.shields.io/badge/node-%3E%3D22-339933)](https://nodejs.org/)

## ✨ 功能概述

按照 GB/T 33190-2016《电子文件存储与交换格式 版式文档》标准实现的一套跨平台 OFD 可视化工具链，包含跨平台 OFD 渲染引擎、密码能力包、图片转换工具和 Web 阅读器。覆盖页面渲染、电子印章解析、加密文档解密、防夹带完整性、签名验证、时间戳解析、CLI 工具和可视化 Web OFD 阅读器，帮助开发者快速构建 OFD 应用。

![渲染能力展示](docs/img/ofd-render-showcase.gif)

## 🧩 快速开始

🎨 [**ofdrw/ofdrw-viewer-engine**](packages/ofdrw-viewer-engine/README.md) **OFD 渲染引擎工具库**，通过 API 控制 OFD 页面绘制、文档信息获取，支持浏览器、Node.js 和小程序等多平台；


🔐 [**ofdrw/ofdrw-viewer-crypto**](packages/ofdrw-viewer-crypto/README.md) **OFD 密码能力包**，检测/解密加密文档，解析电子印章与时间戳，校验 SM2/SM3/SM4 签名、证书链/信任根与防夹带完整性；提供可注入 engine 的明文 `VirtualContainer`；


🔄 [**ofdrw/ofdrw-viewer-cli**](packages/ofdrw-viewer-cli/README.md) **图片转换工具**，CLI命令把 OFD 转换为图片格式（PNG/JPEG/WebP），并支持可导出文字位置，适用于终端环境OFD图片转换、智能体协作；


📖 [**ofdrw/ofdrw-viewer-ui**](packages/ofdrw-viewer-ui/README.md) **Web 阅读器**，功能完备的产品级别的在HTML OFD阅读器，可以快速接入实现OFD在线预览；支持加密文档打开、验证面板、印章点击验证与根证书配置。


## 📚 文档

- [密码能力总体设计方案](docs/ofdrw-viewer-crypto设计方案.md)
- [跨模块契约](docs/CONTRACTS.md)
- [测试方案](docs/测试方案.md) / [验收计划](docs/验收计划.md)
- [密码学 PoC 验证报告](docs/密码学PoC验证报告.md)


## 📄 许可证

本项目采用 [MIT License](LICENSE) 开源。
Copyright (c) 2026 Quan Guanyu
