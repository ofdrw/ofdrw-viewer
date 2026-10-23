# @ofdrw/ofdrw-viewer-crypto

[![npm version](https://img.shields.io/npm/v/@ofdrw/ofdrw-viewer-crypto.svg)](https://www.npmjs.com/package/@ofdrw/ofdrw-viewer-crypto)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](../../LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://nodejs.org/)

## ✨ 功能概述

**ofdrw-viewer-crypto** 为 OFD 提供纯 JavaScript 的密码能力：读取加密信息、用口令或 SM2 私钥解密、把明文容器交给渲染引擎，并完成签名验证、证书链、防夹带完整性与时间戳解析。它不处理 Canvas、字体、图片或 DOM，渲染仍由 [@ofdrw/ofdrw-viewer-engine](../ofdrw-viewer-engine/README.md) 完成。

## 📦 安装

```bash
npm install @ofdrw/ofdrw-viewer-crypto
```

支持现代浏览器、Web Worker 与 Node.js >= 22。

## 🚀 快速开始 Quick Start

以下示例以 TypeScript / ES Module 环境演示：

```ts
import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';
import { openDecryptingContainer } from '@ofdrw/ofdrw-viewer-crypto';

const result = await openDecryptingContainer({
  source: { kind: 'blob', blob: file },
  credentials: { kind: 'password', userName: 'alice', password: 'secret' },
});

try {
  const doc = await OFDDocument.open({ container: result.container });
  try {
    const page = await doc.getPage(0);
    console.log(page.getSize());
  } finally {
    await doc.close(); // engine 只借用容器
  }
} finally {
  await result.container.close(); // 容器由调用方关闭
}
```

接入流程、凭据与安全边界见 [SKILL.md](skills/SKILL.md)，完整参数、错误码与报告字段见 [API.md](skills/API.md)。

各环境与场景示例：

- [浏览器 / Web Worker](skills/SKILL.md#浏览器与-worker)
- [Node.js](skills/SKILL.md#nodejs-随机读取byte-source)
- [微信小程序](skills/SKILL.md#微信小程序)
- [一次性验证](skills/SKILL.md#一次性验证)

## 🤖 智能体 SKILL

智能体读一下 [SKILL.md](skills/SKILL.md)，就能快速把 OFD 解密与验签接入现有流程，并了解凭据、证书和结果状态的处理方式。

## 📄 许可证

本项目采用 [MIT](../../LICENSE) 许可证，Copyright (c) 2026 Quan Guanyu。
