# @ofdrw/ofdrw-viewer-engine

[![npm version](https://img.shields.io/npm/v/@ofdrw/ofdrw-viewer-engine.svg)](https://www.npmjs.com/package/@ofdrw/ofdrw-viewer-engine)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](../../LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://nodejs.org/)

## ✨ 功能概述

标准 OFD 可视化渲染引擎。按 OFD 规范完整还原页面中的文字、图形、图像与版面，把每一页渲染到 Canvas。

以一套简单易用的 API 支撑 OFD 应用开发：不需要处理包结构、资源加载和绘制细节，打开、按页渲染、缩放、导出图片和读取文档信息都在同一套接口里完成；浏览器、Node.js 和小程序均可运行。

## 📦 安装

```bash
npm install @ofdrw/ofdrw-viewer-engine
```

## ⚡ 快速开始

**浏览器环境**接入您需要准备好一个OFD文件和一个`<canvas></canvas>` 如下所示：

```ts
import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';

async function renderFirstPage(file: File, canvas: HTMLCanvasElement) {
  const doc = await OFDDocument.open({ source: { kind: 'blob', blob: file } });
  try {
    const page = await doc.getPage(0); // 第 1 页
    const viewport = page.getViewport({ dpi: 144 });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d')!;
    await page.render({ canvasContext: ctx, viewport }).promise;
  } finally {
    await doc.close();
  }
}
```

⚠️ 注意事项： 引擎**不内置 CJK 字体**，字体由宿主提供；未提供时只缺字，不会中断渲染，您需要在渲染前提供所需字体，详见[SKILL.md：补充字体](skills/SKILL.md#补充字体)。

### 打开容器与加密文档

默认的 `OFDDocument.open({ source })` 保持不变：`OFDOpenOptions.source` **必填**，engine 创建并拥有默认 ZIP 容器。需要注入已构造容器时，使用容器重载：

```ts
import { OFDDocument, openZipVirtualContainer } from '@ofdrw/ofdrw-viewer-engine';

const container = await openZipVirtualContainer({ kind: 'blob', blob: file });
try {
  // 纯容器打开：container 必填，source 可省略；engine 只借用容器。
  const doc = await OFDDocument.open({ container });
  try {
    console.log(doc.pageCount);
  } finally {
    await doc.close(); // 不关闭借用容器，只清空 engine 引用
  }
} finally {
  await container.close(); // 容器所有权仍归宿主
}
```

- `OFDOpenFromContainerOptions`：`container` 必填、`source` 可选上下文；engine 不打开/不关闭 source。
- `OFDOpenOptions`：`source` 必填；可选 `container`（借用）或 `containerFactory`（engine 拥有，二者互斥）。
- **raw / 明文容器**：`openZipVirtualContainer` 返回 raw package container；`encrypted=false` 的明文包可直接注入，`encrypted=true` 的加密包 `read()` 可能是密文，`OFDDocument.open` 会抛 `OFD_ENCRYPTED`；先用 [`@ofdrw/ofdrw-viewer-crypto`](../ofdrw-viewer-crypto/README.md) 解密，再注入返回的明文容器。
- **取消**：`VirtualContainer.read` 支持 `signal`；engine 高层读取合并宿主/close signal，单个等待方取消只影响本次等待，不中止其他调用方的共享加载。
- 完整类型、限制、所有权与错误码见 [公开 API](skills/公开API.md) 和 [引擎设计](../../docs/OFD渲染引擎设计方案.md#1514-虚拟容器与加密文档v20-r1)。

### 支持的平台

各平台如何接入：

- [**H5浏览器**：5 分钟跑通](skills/SKILL.md#5-分钟跑通浏览器)
- [**Node.js**](skills/SKILL.md#nodejs)
- [**Electron / Tauri**](skills/SKILL.md#electron--tauri)。
- [**微信小程序**](skills/SKILL.md#微信小程序)。

各环境所需钩子的对照见 [环境适配](skills/SKILL.md#环境适配)，接口签名与默认值见 [公开 API](skills/公开API.md)。


## 📚 文档

- [引擎设计](../../docs/OFD渲染引擎设计方案.md)
- [文字位置 API](../../docs/text-content-api.md)
- [UI 引擎 API](../../docs/ofdrw-viewer-ui-engine-api.md)
- [Web 示例](../../examples/web/README.md)
- [CLI 工具](../ofdrw-viewer-cli/README.md)
- [UI 包](../ofdrw-viewer-ui/README.md)
- [密码能力包](../ofdrw-viewer-crypto/README.md)
- [项目主页](../../README.md)

## 🤖 Agent Skill 与 API 参考

- [Agent Skill（SKILL.md）](skills/SKILL.md)
- [公开 API 参考](skills/公开API.md)

## 🛠️ 开发

```bash
pnpm -C packages/ofdrw-viewer-engine typecheck
pnpm -C packages/ofdrw-viewer-engine test
pnpm -C packages/ofdrw-viewer-engine build
```

## 📄 许可证

本项目采用 [MIT](../../LICENSE) 许可证，Copyright (c) 2026 Quan Guanyu。