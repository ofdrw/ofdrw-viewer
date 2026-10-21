# JBIG2 解码器来源与许可

本目录的 `jbig2.ts`、`ccitt.ts`、`arithmetic_decoder.ts` 来自 PDF.js 的 JBIG2 解码器，
经 ofd.js（https://github.com/ofdrw/ofd.js，Apache-2.0）转引，原始版权归 Mozilla Foundation。
`util.ts`、`core_utils.ts` 仅保留解码所需的最小函数子集。

原始许可：Apache License, Version 2.0，见同目录 `LICENSE`。
修改说明：转为 TypeScript、移除 PDF 文档对象/浏览器兼容 shim、增加只解第一页、像素/位图上限、中间通用区域与通用细化区域支持、
保留原始版权头。未引入 WASM 或新的运行时依赖。
