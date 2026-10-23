# V-NODE：crypto 随机访问文件源

- `byte-source.verify.test.ts`：用 `CountingByteSource` 包裹真实 OFD；大包只读取 ZIP 所需区间，inspect/open/verify 与 arraybuffer 逐字段一致，加密包、错误凭据、取消、超限和调用方所有权均覆盖。
- 运行：`pnpm -C packages/ofdrw-viewer-crypto exec vitest run test/verification/node`
