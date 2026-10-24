# t13：SES 签章、签名/完整性验证与时间戳独立验证

本目录是 `@ofdrw/ofdrw-viewer-crypto` 的**独立验证证据**，不包含产品实现改动。验证对象是公开
`verifyOfd`、`parseSignedValue`、`parseSeal`、`parseTimestamp`，以及 `test/fixtures/crypto` 中由
ofdrw 2.4.0 生成的样例。

独立性约定：

- 测试不从 `src/` 引入内部函数，也不复用 `test/verify/builders.ts`；只使用包公开 barrel 与给定 fixtures。
- Java 侧使用 **ofdrw 2.4.0 的 `OFDValidator`、`SESV4/SESV5ValidateContainer`、`OFDIntegrityVerifier`**
  作为第三方基线；基线结果固化在 [`java-expected.json`](./java-expected.json)。
- v1 样例没有提交到 fixtures，测试用公开 DER/SM 原语在 [`support.ts`](./support.ts) 中独立构造，
  仅用于字段解析与完整 `verifyOfd` 路径；v4/v5 字段与 Java 解析结果逐项对照。

## 1. 覆盖范围

| 验收点 | 测试位置 | 关键断言 |
|---|---|---|
| SES v4/v5 SignedValue、Seal.esl 字段 | [`parse.test.ts`](./parse.test.ts) | 版本、esId/name/type/有效期、制章者证书、签章者证书、图片 PNG/尺寸、byteLength；与 `java-expected.json` 的 `seals`/`signedValues` 对照 |
| SES v1 | `parse.test.ts` | 独立构造 v1 `SES_Signature`/`SESeal`，解析字段且 `verifyOfd` 判定 `valid` |
| 有效签名 + 信任根 | [`verify.test.ts`](./verify.test.ts) | v4/v5 `overall=valid`，签名/Ref/dataHash/Seal/证书链均 valid，Java `OFDValidator` 也通过 |
| 未配置信任根 | `verify.test.ts` | 证书链 `unknown`，但签名数学/引用通过时签名与 `overall` 仍 `valid`；不把“无法确定信任锚”判为失败 |
| 错误根证书 | `verify.test.ts` | 加密证书作根 → 证书链 `incomplete`，签名与 `overall` 仍 `valid` |
| 有效期链 | `verify.test.ts` | `now=2041` → `expired`；`now=2019` → `not-yet-valid`；未配置根时过期仍展示 `expired`，均不改变签名/`overall` 的 `valid` |
| 时间注入与环境无关 | `../cert/verify-time-injection.verify.test.ts`、`../cert/verify-time-compat.verify.test.ts` | 链状态只由注入 `now` 决定：有效起点/终点含端点均 `valid`，越界 `expired`/`not-yet-valid`；同一夹具在 2019/2026/2041 下分别得到 `not-yet-valid`/`valid`/`expired`；2041/2045/2050 等未来墙钟下结论稳定，不受夹具 2040 到期影响 |
| Reference 篡改 | `verify.test.ts` | `negative-tampered-content.ofd` → `mismatch`，路径为 `Doc_0/Pages/Page_0/Content.xml`，Java 失败 |
| SignedValue 篡改 | `verify.test.ts` | `negative-tampered-signedvalue.ofd` → 解析失败；另翻转签名值首字节（结构合法）→ 数学验签失败；均与 Java 失败一致 |
| Seal.esl 篡改 | `verify.test.ts` | 截断 Seal → `SEAL_PARSE_FAILED`、Seal 与 SignedValue 不一致、Reference mismatch；翻转制章人签名值（结构合法）→ Seal 数学验签失败；Java 均失败 |
| Signature.xml 篡改 | `verify.test.ts` | `dataHash invalid`、`SIGNATURE_DATA_HASH_MISMATCH`，Java 失败 |
| 防夹带完整性正向 | [`integrity.test.ts`](./integrity.test.ts) | `integrity.ofd` 清单 5/实际 5、无缺失/夹带，Java `OFDIntegrityVerifier` 通过 |
| 新增夹带文件 | `integrity.test.ts` | `negative-extra-file.ofd` → `extraFiles=['evil.txt']`、`INTEGRITY_EXTRA_FILE`，Java 失败 |
| 缺失登记文件 | `integrity.test.ts` | 删除 `Doc_0/PublicRes.xml` → `missingFiles` 精确，`INTEGRITY_FILE_MISSING` |
| OFDEntries 签名/eContent 篡改 | `integrity.test.ts` | 改合法 XML 文本 → `INTEGRITY_DIGEST_MISMATCH`；改坏 XML → `INTEGRITY_ENTRIES_INVALID`，后者与 Java 失败一致 |
| 无完整性保护 | `integrity.test.ts` | `integrity=null`、`package.integrityPresent=false`、无签名时 `overall=not-applicable`；不出现伪造 valid 或 `not-protected` 字符串 |
| 时间戳只解析 | `parse.test.ts` | `parsed-not-verified`、固定 `note='已解析，未验证'`；时间/TSA/序列号/messageImprint/nonce 均可解析；无“验证通过”措辞 |
| 报告完整性/序列化/聚合 | `verify.test.ts` / `integrity.test.ts` | 状态单值、证书链 `revocation=not-checked`、`JSON.parse(JSON.stringify(report))` 可往返；签名 valid + 完整性 invalid 时 overall=invalid；无签名无完整性时 not-applicable |
| 非法输入容错 | `verify.test.ts` / `parse.test.ts` | 损坏 Signature.xml、SignedValue、时间戳均返回报告/`parse-error`，不抛出未捕获异常；入口参数错误抛 typed `CryptoError` |
| 凭据不泄漏 | `verify.test.ts` | 加密 source 自动解密后，报告 JSON 不含口令；用户名为报告元数据 |

`integrity=null` 是已冻结的设计：只有 `OFDEntries.xml` 与 `signedvalue.dat` 同时存在才开始完整性校验；
缺一不能伪造 `valid`。因此本目录**不要求**也不断言 `not-protected` 字符串。

## 2. 运行验证

在仓库根目录执行：

```bash
pnpm -C packages/ofdrw-viewer-crypto typecheck
pnpm -C packages/ofdrw-viewer-crypto exec vitest run \
  test/verification/sign test/sign test/seal test/integrity test/timestamp test/verify \
  --passWithNoTests
```

当前结果：上述验证目录共 **43 个独立用例通过**，全量指定测试集也通过（命令输出作为任务证据）。

## 3. Java 基线复现

`java-expected.json` 由 ofdrw 2.4.0 + JDK 21 生成。复现步骤与输出说明见
[`java/README.md`](./java/README.md)。生成器会临时写入 `.cache/t13/`，不会修改 fixtures、实现或测试。

## 4. 结论

- v4/v5 数学验签、Reference、Seal 一致性、证书链、完整性校验与 Java ofdrw 基线逐例一致。
- 证书链状态独立展示：信任根缺失、错误根、过期与尚未生效都不会改变签名/完整性/`overall` 的密码学判定。
- 四类篡改（引用文件、SignedValue、Seal、Signature.xml）都能给出具体原因；防夹带新增/缺失/OFDEntries
  篡改均能检出。
- 时间戳保持“只解析、不验证”，不会产生任何“验证通过”语义。
