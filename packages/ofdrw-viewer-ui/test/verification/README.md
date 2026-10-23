# UI 密码能力独立验收

本目录由 `qa-engineer`（t14/t42）独立编写，只使用真实浏览器、真实 `@ofdrw/ofdrw-viewer-crypto` 夹具与公共 UI API；不复制产品实现，也不修改 `src/`。

## 覆盖矩阵

| 验收项 | 证据 |
|---|---|
| 加密打开：可访问凭据弹窗、口令/私钥、重试、取消恢复、无秘密 | `test/e2e/verification.spec.ts`：口令错误重试后成功；PEM/DER 私钥打开；Esc 取消保留原文档并可恢复；页面/URL/storage/状态/日志不含口令或 PEM；输入字段 label 显式关联，axe 扫描凭据弹窗无 serious/critical；多用户 select/key/passphrase 的 label 关联由独立探针验证 |
| 验证入口与面板：完整性/签名/链/时间戳、空/加载/错误、重复验证 | `test/e2e/verification.spec.ts`：工具栏入口；无根 unknown；PEM/DER/CER 根；错误根 warning；空态、pending 加载态、取消错误 `role=alert`、re-verify；时间戳固定“已解析，未验证” |
| 印章点击：验证后弹层、键盘、侧栏/面板一致 | `test/e2e/verification.spec.ts`：侧栏徽标“验证有效”；覆盖层 `aria-label`；Enter/Space 打开浮层；Escape 关闭并返回焦点；完整面板字段一致 |
| 根证书：PEM/DER/CER、unknown→valid、错误证书 warning、适配层 | E2E 文件上传覆盖三种编码；`test/verification/adapters.verify.test.tsx` 覆盖 Web Component/React/Vue 的 `setRootCertificates`/`getRootCertificates`/`openVerificationPanel`/`verify`；`test/verification/cert-der-root.verify.test.ts` 覆盖 data/url/path/filePath 四态经真实 `certificatesToDer` 转 DER 后只把 DER 交给 `verifyOfd` |
| 移除 ASN.1 解析与依赖 | `test/verification/asn1-boundary.verify.test.ts`：无 `asn1js`/`@peculiar`/`sm-crypto` 依赖与 import；旧 `asn1.ts`/`asn1-parser.ts` 等不存在；详情走 crypto `parseSignedValue` |
| Playwright 覆盖与清理 | 新增 `test/e2e/verification.spec.ts`；Playwright 自动关闭 Chrome；临时日志已清理 |

## 复现命令

在仓库根目录执行：

```bash
pnpm -C packages/ofdrw-viewer-ui typecheck
pnpm -C packages/ofdrw-viewer-ui test
pnpm -C packages/ofdrw-viewer-ui exec playwright test
```

定向运行：

```bash
pnpm -C packages/ofdrw-viewer-ui exec vitest run test/verification
pnpm -C packages/ofdrw-viewer-ui exec playwright test test/e2e/verification.spec.ts
```

## 当前结果（2026-10-23，t42 复验）

- `typecheck`：通过。
- `test`：39 个文件、257 个用例通过；其中本目录新增 7 个（静态 4 + 适配层 3）。
- `build`：ESM/CJS/DTS 全部成功。
- `playwright test`：46/46 通过（全量，包含既有 37 个用例与本任务新增 9 个）。
- 可访问性：t14 发现的凭据输入未命名缺陷已由 t41 修复；password/file/passphrase 与多用户 select 均通过显式 label 关联，独立 axe 扫描两个凭据弹窗均为 0 serious/critical 违规，`凭据弹窗：口令与私钥字段必须具有程序化可访问名称` E2E 通过。

### 历史记录（t14）

- 首次验收发现 `crypto-credential-password`、`crypto-credential-key`、`crypto-credential-passphrase` 未命名，axe `label` critical；已提交 t41 修复。
- 一次全量运行曾偶发既有 `a11y.spec.ts` 的 `findbar` 颜色对比度失败；单独运行 3/3 通过，t42 全量重跑未复现。

## 关键观测

- 加密口令/证书文档打开后均完成首屏 `pagerendered`，`pageCount=2`；取消加密打开后原明文文档保持 `ready`。
- 无根时报告 `overall=unknown`；配置 `root-ca.crt.pem`、DER 或 `.cer`（DER 内容）后变为 `valid`；删除后回到 `unknown`；非法 PEM 只产生 `W_CRYPTO_CERT_SOURCE_UNSUPPORTED`。
- 时间戳只显示 `parsed-not-verified` / “已解析，未验证”，面板不出现“时间戳验证通过/有效”。
- 口令、私钥 PEM 内容、错误口令均未出现在 URL、DOM 属性、localStorage/sessionStorage/cookie、阅读器状态或日志中。
- 验证面板取消错误由真实 `verify({ signal })` 路径触发，`role=alert`，恢复后可重试验证。

## t66 V-CERT（2026-10-23）

- `test/verification/cert-der-root.verify.test.ts`：data/url/path/filePath 与构造
  `rootCertificates` 均把 PEM/DER/多证书原始字节交给真实 `certificatesToDer`，
  断言 `TrustRootItem.ders` 与 `verifyOfd` 收到的 `roots` 都是逐张 DER；非法 PEM、
  URL 非 2xx、缺 loader、loader 抛错、私钥 PEM 的 warning/OFD_CRYPTO_FAILED 语义不变。
- 定向 11/11 通过；全包 41 文件 / 296 用例通过；typecheck、build 通过。
- 本文件只替换 `inspect`/`verifyOfd`：jsdom 与 crypto 模块的 `Uint8Array` realm 不同，
  真实 `verifyOfd` 在 jsdom 下会把容器条目误判为非 Uint8Array（浏览器/Node 无此问题）；
  证书转换链路仍使用真实实现，真实验签由 crypto V-CERT、CLI 与浏览器 E2E 覆盖。
