# V-DEC 独立验证证据

本目录是 `t12` 的独立验收材料，只新增测试与证据，不修改 `src/`。
任务描述中的 `inspectOfd` 在当前公共 API 中名为 `inspect`（与 t6 交付说明一致）。

## 文件

| 文件 | 内容 |
| --- | --- |
| `decrypt.verify.test.ts` | 口令/证书/组合/明文检测与解密；engine 打开、页数、元数据、页尺寸、`prepare()`、资源读取 |
| `errors.verify.test.ts` | 错误凭据/损坏密文/资源上限/取消/敏感信息/重试/并发/生命周期 |
| `entries.verify.test.ts` | 用 Node 内置 crypto 独立构造 SM4 entriesmap；密文/明文映射、路径规范、元数据过滤、多 EncryptInfo 层 |
| `browser.verify.test.ts` | `// @vitest-environment jsdom` 下的检测、Blob、证书、engine 打开与页面准备 |
| `support.ts` | fixture/摘要/错误/ZIP 重写工具 |
| `java/JavaDecryptOracle.java` | ofdrw 2.4.0 `OFDDecryptor` 独立基准程序 |
| `java-expected.json` | 上述程序生成的逐条目大小/SHA-256 基准（测试直接读取，无需 CI 安装 Java） |

## 结论

- 口令、证书（PEM/DER PKCS#8）、组合样例解密后的条目路径/大小/SHA-256 与 Java 基准完全一致。
- 组合样例解密后保留 1 个签名与完整性清单；加密元数据 `Encryptions.xml`、`decryptseed.dat`、`entriesmap.dat` 不进入明文容器。
- 明文包原样透传，包大小保持 5226 byte；口令/证书包解密后保留原始密文包大小。
- engine 打开口令解密容器：2 页、OFD 1.0、210×297 mm、`prepare()` 成功；直接打开原始加密源返回 `OFD_ENCRYPTED`。
- 错误码可区分且消息/堆栈不含口令、私钥 PEM 或加密 PKCS#8 口令；错误后重试及并发读取不损坏状态。
- 自建多层包验证 `maxDecryptLayers`、明文 entriesmap warning、路径规范化与重复/保留路径拒绝。

## 复现命令

```bash
pnpm -C packages/ofdrw-viewer-crypto typecheck
pnpm -C packages/ofdrw-viewer-crypto exec vitest run \
  test/verification/decrypt test/decrypt test/container --passWithNoTests
```

2026-10-23 结果：typecheck 通过；9 个测试文件、72 个测试全部通过，其中本目录 34 个测试。

## Java 基准复现

`java/JavaDecryptOracle.java` 使用与仓库 fixture 相同的 ofdrw 2.4.0，对
`plain.ofd`、`password-encrypted.ofd`、`cert-encrypted.ofd`、
`combined-signed-integrity.ofd`、`combined-password-encrypted.ofd` 解密/读取
ZIP，输出每个条目的路径、大小和 SHA-256；`java-expected.json` 是它的输出。
运行时需要 JDK 21、ofdrw 2.4.0 的 Maven classpath，以及
fixture 密码/证书私钥（见 `test/fixtures/crypto/README.md`）。基准生成后以静态
JSON 提交，避免测试环境依赖 Java。

## jsdom 说明

jsdom 30 的 `TextEncoder`/`DecompressionStream` 来自 Node 主 realm，输出
`Uint8Array` 与 jsdom 模块 realm 不同，会触发跨 realm 的 `instanceof` 检查
失败。真实浏览器只有一个 realm；`browser.verify.test.ts` 用同 realm 的
`TextEncoder` 并关闭 `DecompressionStream`（走 engine 的 fflate 回退）模拟
单 realm 浏览器，从而验证公共 API 在浏览器形态下的路径。
