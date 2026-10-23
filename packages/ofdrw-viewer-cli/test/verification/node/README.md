# V-NODE：CLI 随机访问文件源

- `byte-source.verify.test.ts`：通过真实 CLI 源码入口运行 `info`/`verify`/加密 `convert`，用 `NodeFileByteSource` 读取计数证明单次请求小于包大小、info 对大包只读少量区间；同时覆盖错误凭据、损坏包、注入取消（SIGINT 路径）与句柄关闭。
- 运行：`pnpm -C packages/ofdrw-viewer-cli exec vitest run test/verification/node`
