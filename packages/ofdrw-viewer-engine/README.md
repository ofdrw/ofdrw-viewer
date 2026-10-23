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

### CDN（浏览器 `<script>`）

构建会额外产出两个**完全自包含**的 IIFE 包，适合直接通过 CDN 或 `<script>` 引入，无需模块打包器：

| 文件 | 说明 | 体积（gzip） |
| --- | --- | --- |
| `dist/ofdrw-viewer-engine.js` | 未压缩，便于调试 | 约 1.5 MB（354 KB） |
| `dist/ofdrw-viewer-engine.min.js` | 压缩并带 sourcemap | 约 710 KB（260 KB） |

```html
<script src="https://cdn.jsdelivr.net/npm/@ofdrw/ofdrw-viewer-engine@0.1.0/dist/ofdrw-viewer-engine.min.js"></script>
<script>
  const { OFDDocument } = window.OFDRWViewer;

  async function renderFirstPage(file, canvas) {
    const doc = await OFDDocument.open({ source: { kind: 'blob', blob: file } });
    try {
      const page = await doc.getPage(0);
      const viewport = page.getViewport({ dpi: 144 });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    } finally {
      await doc.close();
    }
  }
</script>
```

- 全局变量为 `window.OFDRWViewer`，导出与包入口一致；
- fontkit/saxes/fflate 与内置 GIF/JBIG2/TIFF 解码器均已内联，运行时不再请求其他 JS；
- 目标语法为 ES2017，适用于现代浏览器；`ofdrw-viewer-engine.min.js.map` 也会一并发布；
- 单独构建 CDN 产物：`pnpm -C packages/ofdrw-viewer-engine build:cdn`。

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

⚠️ 注意事项： 引擎**不内置 CJK 字体**，字体由宿主提供；未提供时只缺字，不会中断渲染。可用 `defaultFonts` 指定缺省替代字体（见下文），或用 `supplementaryFonts` 补齐缺字，详见[SKILL.md：缺省字体与补充字体](skills/SKILL.md#缺省字体与补充字体)。

### 缺省字体 defaultFonts

文档声明的字体既没有内嵌 `FontFile`、`fontProvider` 也匹配不到时，文字会整段空白并产生 `W_FONT_MISSING`。`defaultFonts` 用于为这类文档指定最终的替代字体，让文字至少可读。

字段签名（`OFDOpenBaseOptions`）：`readonly defaultFonts?: readonly FontInput[]`；每个元素支持 `data`/`url`/`path`/`filePath`，可带 `family`。engine 自身不扫描系统字体，字体来源需由宿主显式提供。

**固定优先级**（不按跨层评分反超）：

```text
主字体：内嵌 FontFile → FontProvider → defaultFonts → supplementaryFonts
逐字形回退：主字体 → provider 其余候选 → defaultFonts 其余 → supplementaryFonts
```

- `defaultFonts` 是"缺省替代"，`supplementaryFonts` 是"逐字形补缺"；两者都传时由 `defaultFonts` 优先成为主字体。
- **精确来源优先**：内嵌字体或 `fontProvider` 命中时，`defaultFonts` 不参与主字体选择；但仍保留在逐字形回退链中，内嵌字体缺某个字形时可用默认字体补字。
- 多个来源（含 TTC/OTC 展开出的每个字体面）按 FontName/FamilyName/别名评分选择主字体，不是简单取第一个。
- **替代字体不可信任显式 GID**：`CGTransform` 给出的 GID 会被忽略，始终按 Unicode 码点走 cmap；文档的 `DeltaX/DeltaY` 仍优先。
- 单个来源读取或解析失败只产生 warning，继续尝试下一个来源；每个来源同样受 `limits.maxFontBytes`（默认 64 MiB/字体）限制。
- **不传 `defaultFonts` 时行为与之前版本完全一致**（不加载、无额外开销）；全部来源都失败时仍产生 `W_FONT_MISSING` 并跳过文字对象。

三种 `FontInput` 来源示例：

```ts
// Node.js / Electron 主进程：本地文件（path/filePath 需配合 loadInput）
import { readFile } from 'node:fs/promises';

await OFDDocument.open({
  source: { kind: 'arraybuffer', data: await readFile('sample.ofd') },
  defaultFonts: [
    { path: '/opt/fonts/SourceHanSerifSC.otf', family: 'Source Han Serif SC' },
  ],
  loadInput: async (input) => {
    if ('data' in input) return input.data;
    if ('url' in input) return new Uint8Array(await (await fetch(input.url)).arrayBuffer());
    return new Uint8Array(await readFile('path' in input ? input.path : input.filePath));
  },
});
```

```ts
// Web：同源字体 URL，默认走 fetch
await OFDDocument.open({
  source: { kind: 'blob', blob: file },
  defaultFonts: [{ url: '/assets/fonts/noto-serif-sc.otf', family: 'Noto Serif CJK SC' }],
});
```

```ts
// 微信小程序 / 内存字体包：直接传字节
await OFDDocument.open({
  source,
  defaultFonts: [{ data: fontBytes, family: 'Noto Serif CJK SC' }],
});
```

设计背景、评分规则与 CLI 系统字体策略见 [渲染字体缺省方案设计](../../docs/渲染字体缺省方案设计.md)。

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
- 完整类型、限制、所有权与错误码见 [公开 API](skills/API.md) 和 [引擎设计](../../docs/OFD渲染引擎设计方案.md#1514-虚拟容器与加密文档v20-r1)。

### 支持的平台

各平台如何接入：

- [**H5浏览器**：5 分钟跑通](skills/SKILL.md#5-分钟跑通浏览器)
- [**Node.js**](skills/SKILL.md#nodejs)
- [**Electron / Tauri**](skills/SKILL.md#electron--tauri)。
- [**微信小程序**](skills/SKILL.md#微信小程序)。

各环境所需钩子的对照见 [环境适配](skills/SKILL.md#环境适配)，接口签名与默认值见 [公开 API](skills/API.md)。


## 📚 文档

- [引擎设计](../../docs/OFD渲染引擎设计方案.md)
- [文字位置 API](../../docs/text-content-api.md)
- [UI 引擎 API](../../docs/ofdrw-viewer-ui-engine-api.md)
- [H5 示例（预置 global.js，无需包管理）](../../examples/engine-h5/README.md)
- [Node.js 示例（逐页导出 PNG）](../../examples/engine-node/README.md)
- [CLI 工具](../ofdrw-viewer-cli/README.md)
- [UI 包](../ofdrw-viewer-ui/README.md)
- [密码能力包](../ofdrw-viewer-crypto/README.md)
- [项目主页](../../README.md)

## 🤖 Agent Skill 与 API 参考

- [Agent Skill（SKILL.md）](skills/SKILL.md)
- [公开 API 参考](skills/API.md)

## 🛠️ 开发

```bash
pnpm -C packages/ofdrw-viewer-engine typecheck
pnpm -C packages/ofdrw-viewer-engine test
pnpm -C packages/ofdrw-viewer-engine build
```

## 📄 许可证

本项目采用 [MIT](../../LICENSE) 许可证，Copyright (c) 2026 Quan Guanyu。