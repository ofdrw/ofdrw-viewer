# V-CLI 独立验证

本目录独立验证 `@ofdrw/ofdrw-viewer-cli` 的 `info`/`verify` 子命令、加密文档转图片、JSON/退出码与旧用法兼容。测试只观察 CLI 源码入口 `main` 或构建后的 `dist/bin.js`/SEA，不改动 `src/`；夹具复用 `packages/ofdrw-viewer-crypto/test/fixtures/crypto`。

## 1. 文件

| 文件 | 用途 | 用例数 |
| --- | --- | ---: |
| `support.ts` | 夹具定位、临时目录、`main` 输出捕获、PNG/文本 JSON 校验；本地中文字体目录 | — |
| `cli-contract.test.ts` | 帮助/版本、旧 `convert` 用法、未知参数/子命令、子命令参数隔离、凭据冲突、`decrypt` 拒绝、源码 API 边界 | 13 |
| `cli-info-verify.test.ts` | `info` 文本/JSON 与 `inspect` oracle 对照；`verify` valid/unknown/invalid、JSON/文本一致、加密文档凭据、退出码与敏感信息 | 15 |
| `cli-convert.test.ts` | 旧用法 PNG/`--text`/页码；口令与私钥解密转图；错误/缺失凭据；JPEG；无独立 decrypt | 11 |
| `node/byte-source.verify.test.ts` | Node 文件随机访问：info/verify/加密 convert 读取计数、arraybuffer 一致性、错误/取消/句柄关闭 | 6 |
| `cli-info-document.verify.test.ts` | info 文档元数据：与 engine getMetadata/getPageInfos 对照、富元数据/控制字符/长值、加密无凭据、错误码与取消 | 11 |
| `cert-der-root.verify.test.ts` | 证书 DER 化前置转换：PEM/CER/DER/Base64/多证书/CRLF/BOM、错误码与 unknown 语义 | 8 |
| `test/acceptance/verification.acceptance.ts` | 构建后的普通 CLI 与 SEA 黑盒验收：帮助、`info`/`verify`、加密转换、错误凭据 | 9 |

本目录源码级用例共 **64** 个；另有 **9** 个构建产物/SEA 验收用例，总计 **73** 个独立用例。`pnpm test` 收集前 64 个，`pnpm test:acceptance` 收集后 9 个（该命令会先构建普通 CLI 与 SEA）。

## 2. 覆盖矩阵（按验收契约）

| 验收项 | 独立断言 |
| --- | --- |
| 旧 `<input.ofd> [options]` 兼容；帮助/未知参数/未知子命令/退出码 | `cli-contract.test.ts`：默认输入/输出目录/格式/DPI/页码/`--text`/字体参数；`--help`、`--version`、`-h`、`-V`；未知选项、多输入、`info`/`verify` 缺输入、`frobnicate` 处理；所有用法错误 1 + 用法提示 |
| `info` 只查询、不解密不验证；文本/JSON 字段；加密用户与不可读 | `cli-info-verify.test.ts`：明文/加密/签名/完整性/非法包；JSON 与 crypto `inspect` 的 packageSize/version/encrypted/layers/users/signatureCount/integrityPresent/warnings 对照；加密文本显示 `加密: 是（1 层）`、用户与 `method`，且不回显 `拿来主义`/`鲁迅` 正文；篡改签名包仍退出 0，仅报 `signatureCount` |
| `verify` 有效/篡改/无根 unknown/配根 valid；JSON/文本；退出码 | `cli-info-verify.test.ts` + acceptance：PEM/DER 根、重复根、错误根、无根 warning；`valid`→0，`unknown`/`invalid`/`not-applicable`→5；引用内容篡改、夹带文件、自定义 SM2 userId、加密口令验证；文本与 JSON 的 overall/签名状态/时间戳一致；与 crypto `verifyOfd` oracle 对照 |
| 加密文档转图片：口令/私钥成功；错误凭据；不泄漏密钥 | `cli-convert.test.ts` + acceptance：`--user/--password`、`--user/--key`（PEM/DER）→ PNG + `--text` JSON；`--pages`/`--format jpeg` 保持；缺凭据/错口令/错私钥→4 且不产页；输出中无口令、`BEGIN PRIVATE KEY`、`EncryptedWK` |
| 无独立 decrypt；CLI 复用 crypto、不重复密码逻辑 | `cli-contract.test.ts`：`decrypt` 固定 1；静态断言 `info.ts` 只 import `inspect`、`verify.ts` 只 import `verifyOfd`、`convert.ts` import `openDecryptingContainer`，CLI 源码无 `sm-crypto`/自实现 SM3/SM4/`EncryptedWK`；运行期所有验证/解密均由这些入口完成 |
| 构建后 CLI/SEA 验收；测试证据 | `test/acceptance/verification.acceptance.ts`：真实 `dist/bin.js` 的帮助、info/verify、加密转换；SEA 的 info/verify 与口令解密转图；`pnpm test:acceptance` 全量 5 文件 82 用例通过（含既有 SEA 无 Node 用例） |

## 3. 运行

在仓库根目录：

```bash
pnpm -C packages/ofdrw-viewer-cli typecheck
pnpm -C packages/ofdrw-viewer-cli test
pnpm -C packages/ofdrw-viewer-cli build
pnpm -C packages/ofdrw-viewer-cli test:acceptance
```

只跑独立源码级用例：

```bash
pnpm -C packages/ofdrw-viewer-cli exec vitest run test/verification --passWithNoTests
```

只跑新增构建产物/SEA 用例（需先 `build` + `build:sea`，或直接运行完整 `test:acceptance`）：

```bash
pnpm -C packages/ofdrw-viewer-cli exec vitest run \
  --config test/acceptance/vitest.config.ts test/acceptance/verification.acceptance.ts
```

## 4. 本次观测

- `typecheck`：退出 0。
- `pnpm test`：20 个文件、298 个用例通过；本目录 6 个文件、64 个用例通过。
- `build`：退出 0。
- `test:acceptance`：5 个文件、82 个用例通过；新增验收 9 个，SEA 的 `info`/`verify` 与口令解密转图均通过。
- 加密夹具的正文使用中文；`--text` 导出在没有可用字体时会产生 `W_FONT_MISSING`/`W_GLYPH_MISSING` 并写出空数组，这是既有 CLI 的降级语义。独立文本用例显式传入仓库 `test/.fixtures/fonts/DroidSansFallbackFull.ttf` 的单字体目录，确认能导出非空五字段记录，不把缺字体误判为 CLI 失败。

## 5. 边界与判定

- `info` 不因加密包无凭据失败：退出 0，只输出摘要；不调用解密、不读取 `SignedValue`/不验签（篡改签名包仍成功）。
- `verify` 的 `unknown` 是“未配置信任根”的合法结果，不按 `invalid` 或用法错误处理；退出码为 5。
- 加密文档转图片在没有凭据/凭据错误时不创建图片；输出目录可能存在但为空，这是 CLI 现有错误路径行为，不影响“不产出页”的断言。
- 时间戳只在 `verify` 中解析展示，固定 `parsed-not-verified`；文本不出现“验证通过”。
