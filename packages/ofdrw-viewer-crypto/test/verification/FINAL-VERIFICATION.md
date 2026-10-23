# t34 V-FINAL 当前字节 consolidated 复验

> 执行者：qa-engineer；范围：engine / crypto / UI / CLI 密码能力与既有回归。
> 本报告只记录独立验证证据，不修改实现；结论绑定本文件所列当前源码哈希。
> 日期：2026-10-23；Node v26.10.0、pnpm 11.24.0、Chrome 145.0.7632.116、JDK 21.0.10。

## 1. 字节与工作区

- 开始 HEAD：`3bc37fc8f6b5d3bc7d0f3f6aac97c628b4c71707`；结束时 HEAD：
  `7f1246dc93f2ff1e057e8d7a01f49780a063f4aa`（验证期间其他任务提交了 a11y 测试修复，
  `src/` 未变化；UI Playwright 已在变更后重跑）。
- 开始时 `git status --short`：124 行；结束时包含其他任务并行产生的 docs/README/test 改动。
- 关键源码目录哈希（`src/` 全部文件按路径排序后聚合 SHA-256）：

| 包 | 开始/结束哈希 |
| --- | --- |
| engine | `a696e187efcf92d4806fdaf20f4580c474719cfc5fe96bf098df7376df97de79` |
| crypto | `7a984fc1aa4070eecc879a139566a2ba5847f2c01e1e3215f50e03abcc9eb303` |
| ui | `eb0d2505dc5366fbef928cf6bc15fb2d1fa73b06e91b97ff623c98756fdbba18` |
| cli | `32214a10631f6cefd233c5c058ebcf8367f925e915ad02d353f1da9a02636d11` |

前后逐包比对一致；验证期间只新增/变更测试与文档，没有修改 `src/`。统一夹具
`manifest.sha256` 前后一致：`71d80c1527cf2985bc22323a0469cc47ee30efcbeee58d2c716d2dc7fcf4885e`。

## 2. 命令结果

| 命令 | 结果 |
| --- | --- |
| engine typecheck / build | exit 0；ESM/CJS/DTS 构建成功 |
| crypto typecheck / build | exit 0；ESM/CJS/DTS 构建成功 |
| UI typecheck / build | exit 0；ESM/CJS/DTS 构建成功 |
| CLI typecheck / build | exit 0；tsc 产物生成 |
| engine full test | 122 文件 / 876 用例通过；`e2e/run-all.e2e.test.ts` 1 跳过（默认 `GOLDEN_RUN_ALL=1` 才启用，非门禁） |
| crypto full test | 35 文件 / 373 用例通过 |
| UI full test | 40 文件 / 285 用例通过 |
| CLI full test | 15 文件 / 258 用例通过 |
| engine V-ENG（verification/container/api/smoke） | 38 文件 / 250 用例通过 |
| crypto V-CORE（core/cert） | 16 文件 / 154 用例通过 |
| crypto V-DEC（decrypt/container） | 9 文件 / 90 用例通过 |
| crypto V-SIGN（sign/seal/integrity/timestamp/verify） | 10 文件 / 129 用例通过 |
| UI V-UI（verification） | 2 文件 / 7 用例通过 |
| CLI V-CLI（verification） | 3 文件 / 38 用例通过 |
| CLI acceptance（构建 CLI+SEA） | 5 文件 / 81 用例通过 |
| UI Playwright 全量 | 47 用例通过；AXE core/sidebar/verification-panel/findbar/print/export/dialog 均为 `[]` |
| Java 夹具校验 | `verify-fixtures.sh` exit 0；cases=12，trustedRoot=valid，trustRootMissing=unknown |

## 3. 12 个受保护夹具

统一夹具目录：`packages/ofdrw-viewer-crypto/test/fixtures/crypto/`。用当前构建产物、公开
`inspect` / `openDecryptingContainer` / `verifyOfd` 对 12 个 case 做独立探针：

| case | inspect/解密 | verify（正确根） | 结果 |
| --- | --- | --- | --- |
| plain | 非加密、无签名 | not-applicable、integrity=null | 通过 |
| password-encrypted | 口令解密 5 条明文 | not-applicable | 通过 |
| cert-encrypted | SM2 私钥解密 5 条明文 | not-applicable | 通过 |
| signed-sesv4 | 加密=false | valid；时间戳 parsed-not-verified；无根 unknown | 通过 |
| signed-sesv5 | 加密=false | valid；时间戳 parsed-not-verified；无根 unknown | 通过 |
| integrity | 完整性保护 | valid；integrity=valid、无缺失/夹带 | 通过 |
| combined-signed-integrity | 加密=false | valid；签名+完整性均 valid | 通过 |
| combined-password-encrypted | 口令解密 11 条明文 | valid；签名+完整性均 valid | 通过 |
| negative-tampered-content | — | invalid | 通过（负例失败符合预期） |
| negative-tampered-signedvalue | — | invalid | 通过（负例失败符合预期） |
| negative-tampered-signature | — | invalid | 通过（负例失败符合预期） |
| negative-extra-file | — | invalid；extraFiles=['evil.txt'] | 通过（负例失败符合预期） |

CLI 独立探针：`info` 对 12/12 退出 0；`verify` 对 signed v4/v5、integrity、两个 combined
退出 0（valid），对 plain/password/cert（无签名）及 4 个负例退出 5（not-applicable/invalid）；
所有输出未出现口令、PEM 或 `EncryptedWK`。

UI 关键路径由真实 Chrome Playwright 覆盖：口令/私钥/错误重试/取消、验证面板无根 unknown→
PEM/DER/CER valid、印章键盘浮层、时间戳“已解析，未验证”、feature 关闭旧报告失效、凭据字段
可访问名称；全量 47/47 通过，无 console/page error。

## 4. stale 任务映射

| stale 任务 | 当前证据 |
| --- | --- |
| t10 V-ENG | engine V-ENG 38/250；full 122/876（1 个可选 e2e skip）；source hash 未变 |
| t11 V-CORE | crypto V-CORE 16/154；full 35/373；OpenSSL/browser build-import 通过；source hash 未变 |
| t12 V-DEC | crypto V-DEC 9/90；Java `java-expected.json` 逐条目 SHA-256；12 夹具解密探针通过 |
| t13 V-SIGN | crypto V-SIGN 10/129；Java `java-expected.json`；12 夹具签名/完整性/时间戳/unknown/negative 探针通过 |
| t15 V-CLI | CLI V-CLI 3/38；CLI acceptance 5/81（含 SEA）；12 夹具 info/verify 探针通过 |
| t27 crypto review | t27 原 verdict pass；其 crypto 基础结论由 V-CORE/V-DEC/V-SIGN+full test 重新覆盖；t27 的 2 条 low 建议（warning 回调异常隔离、sm2Decrypt 04-first 固定回归）未作为本轮门禁，仍建议后续维护处理 |

## 5. 失败、跳过、环境限制

- 失败：无。
- 跳过：engine `test/e2e/run-all.e2e.test.ts` 1 个（设计上仅在 `GOLDEN_RUN_ALL=1` 时运行，不属于密码能力门禁）。
- t27 遗留 2 条 low 建议，未发现 blocker/high；不影响本轮 verdict。
- UI Playwright 的 performance 用例记录 open/find 超过目标，但项目将其定义为 P1 延期、非 MVP 门禁，
  不作为 t34 失败；其余 47 个用例通过。
- 验证期间其他任务提交了 a11y 测试修复并改动文档，`src/` 哈希未变；发现后已用当前测试重跑全量
  Playwright（47/47），本报告绑定当前源码哈希。浏览器已关闭，4179/5178/5179 无监听，Playwright
  临时产物已清理。

## 6. 结论

engine/crypto/UI/CLI 当前字节的 typecheck、build、全量测试、独立验证套件、CLI SEA、12 个受保护
夹具与 UI 关键路径均通过；源码哈希前后一致。未发现需要阻塞最终验收的回归。
