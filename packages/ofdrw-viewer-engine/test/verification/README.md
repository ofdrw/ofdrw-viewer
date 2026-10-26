# V-ENG 虚拟容器抽象独立验证

本目录是 `t10 V-ENG` 的独立验收测试，只通过包根公共 API 驱动
`@ofdrw/ofdrw-viewer-engine`，不依赖实现者自测结论；除测试文件外不修改任何实现。

## 文件

| 文件 | 覆盖点 |
| --- | --- |
| `default-regression.verify.test.ts` | 默认 `OFDDocument.open({source})` 的页数/元数据/页尺寸/渲染/签名读取；`source`、借用容器、工厂三种入口快照逐像素一致 |
| `lifecycle-errors.verify.test.ts` | source/容器所有权、打开失败、重复关闭、关闭抛错、`documentIndex`、`packageSize`、限流/缺失条目/容器异常/warning |
| `support.ts` | 独立测试工具：内存/包装容器、可关闭字节源、原始 ZIP 解析、画布摘要、综合夹具；不含实现断言 |

容器注入路径与架构隔离分别由 `test/api/container-injection.test.ts` 和根
`test/smoke/import-boundaries.test.ts` 覆盖，本目录不再重复。

## 验证命令与结果

```bash
# 1) 类型检查
pnpm -C packages/ofdrw-viewer-engine typecheck
# → 通过，无输出错误

# 2) 契约验证（本目录 + 实现者单测 + 既有 api/container/smoke 回归）
pnpm -C packages/ofdrw-viewer-engine exec vitest run test/verification test/container test/api test/smoke --passWithNoTests
# → 38 files / 305 tests 全部通过（2026-10-26）

# 3) 既有 engine 单元回归（排除 golden/e2e）
pnpm -C packages/ofdrw-viewer-engine exec vitest run \
  test/api test/common test/container test/font test/gouraud test/image test/model \
  test/pipeline test/render test/renderer test/resource test/smoke test/style \
  test/text-content test/text-layout test/verification test/xml
# → 全部通过
```

## 关键断言

- **默认行为回归**：`hello.ofd` 的页数/版本/DocID/包大小/页尺寸与独立 ZIP+XML 解析一致；同一页重复渲染像素摘要一致。
- **签名回归**：`SESV4SignDoc.ofd` 的签名条目、`SignedValue.dat` 与原始 ZIP 条目逐字节一致；渲染读取 `Seal.esl`/`SignedValue.dat`，墨水像素 > 1000。
- **打开入口等价**：`source`、`container`（借用）、`containerFactory` 三种入口在 `hello.ofd`、`文字横向-数科.ofd`、`SESV4SignDoc.ofd` 上的元数据、页尺寸、附件、签名、SignedValue、逐页像素摘要完全一致。
- **生命周期**：默认 source 重复 `close` 只释放一次；打开失败释放自有 source；借用容器永不被 engine 关闭；工厂容器由 engine 关闭且只关闭一次；容器/source 的 `close()` 抛错不阻塞 `doc.close()`。
- **错误与限流**：`OFD_ENCRYPTED`/`OFD_INVALID_PACKAGE`/`OFD_LIMIT_EXCEEDED`/`OFD_CLOSED`/`OFD_ABORTED` 与缺失必需条目/容器内部异常/超限路径匹配；附件与 SignedValue 读取失败只发 `W_ATTACHMENT_RESOURCE`/`W_SIGNATURE_RESOURCE` 并返回 `undefined`；真实 ZIP CRC 错误以 `W_BAD_NUMBER` 透传且不阻断打开。

## 说明

- “改造前一致”的基线由仓库中**未修改的既有 engine 测试**定义：本目录只保留独立回归，
  既有 `test/api`、`test/container`、`test/smoke` 等断言原样通过，
  且默认 source 路径与显式字节源容器路径逐像素/逐字段一致。
- 真实样本来自仓库既有 `ofd_pdf_match/`；缺失时相应用例 `skipIf`，不会伪造通过。