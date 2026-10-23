# 密码能力测试夹具

本目录是 `@ofdrw/ofdrw-viewer-crypto`、engine、UI、CLI 共用的**受保护 OFD 回归夹具**，使用 ofdrw 2.4.0 生成后固化提交。

> **安全声明：本目录下所有证书与私钥均为公开的测试材料，仅用于自动化测试、演示和格式验证；严禁用于生产、真实签章或任何需要保密性的场景。**
>
> 私钥没有口令保护，证书主题均带 `ofdrw-viewer test`，有效期固定在 2025-01-01～2040-01-01（根证书 2020-01-01～2045-01-01）。任何看到本仓库的人都可以使用这些私钥，因此它们**不构成任何身份或信任保证**。

## 1. 目录内容

```text
crypto/
├── plain.ofd                         # 明文基准（ofdrw hello.ofd 原样复制）
├── password-encrypted.ofd            # 口令加密
├── cert-encrypted.ofd                # SM2 证书加密
├── signed-sesv4.ofd                  # SESv4 签章 + GM/T 0033 时间戳
├── signed-sesv5.ofd                  # SESv5 签章 + GM/T 0033 时间戳
├── integrity.ofd                     # OFDEntries + GB/T 35275 防夹带完整性
├── combined-signed-integrity.ofd     # 签名 + 完整性
├── combined-password-encrypted.ofd   # 签名 + 完整性 + 口令加密
├── negative-tampered-content.ofd     # 负例：引用文件内容被篡改
├── negative-tampered-signedvalue.ofd # 负例：SignedValue.dat 被篡改
├── negative-tampered-signature.ofd   # 负例：Signature.xml 被篡改
├── negative-extra-file.ofd           # 负例：包内新增未登记文件（夹带）
├── certs/                            # 测试根/签名/加密/制章/TSA 证书与私钥
├── manifest.json                     # 路径、大小、SHA-256、凭据、预期结果
├── manifest.sha256                   # 供 sha256sum/shasum 校验
└── README.md
```

所有 `.ofd` 均在 20MB 总量以内；单个文件远小于 5MB（当前总计约 135KB）。

## 2. 凭据

| 用途 | 用户名 | 凭据 | 对应文件 |
|---|---|---|---|
| 口令加密 | `fixture-password-user` | `FixturePass123` | — |
| 证书加密 | `fixture-cert-user` | SM2 私钥 | `certs/encrypt.key.pem` / `.der` |
| 签名/完整性 | — | SM2 私钥 | `certs/signer.key.pem` / `.der` |
| 制章 | — | SM2 私钥 | `certs/seal.key.pem` / `.der` |
| 时间戳 | — | SM2 私钥 | `certs/tsa.key.pem` / `.der` |

信任根：`certs/root-ca.crt.pem`（DER 为 `root-ca.crt.der`）。

## 3. 测试证书

| 文件前缀 | 主题 | 用途 | KeyUsage / EKU |
|---|---|---|---|
| `root-ca` | `CN=OFDRW Viewer Crypto Fixtures Root CA` | 根 CA | keyCertSign/cRLSign/digitalSignature，CA=true |
| `signer` | `CN=OFDRW Viewer Crypto Fixtures Signer` | 签章、完整性签名 | digitalSignature/nonRepudiation，clientAuth |
| `encrypt` | `CN=OFDRW Viewer Crypto Fixtures Encrypt` | 证书加密 | keyEncipherment/dataEncipherment，emailProtection |
| `seal` | `CN=OFDRW Viewer Crypto Fixtures Seal Maker` | 制章者 | digitalSignature/nonRepudiation，clientAuth |
| `tsa` | `CN=OFDRW Viewer Crypto Fixtures TSA` | 时间戳 | digitalSignature/nonRepudiation，timeStamping（critical） |

每个前缀均提供：

- 证书：`<name>.crt.pem`、`<name>.crt.der`
- 私钥：`<name>.key.pem`（PKCS#8）、`<name>.key.der`（PKCS#8 DER）

## 4. 各 case 预期

| 文件 | 类型 | 预期 |
|---|---|---|
| `plain.ofd` | 明文 | ofdrw `OFDReader` 可打开；作为解密基准 |
| `password-encrypted.ofd` | 口令加密 | 用上表口令可解密，内容与 `plain.ofd` 一致 |
| `cert-encrypted.ofd` | 证书加密 | 用 `certs/encrypt.key.pem` 可解密，内容与 `plain.ofd` 一致 |
| `signed-sesv4.ofd` | SESv4 签章 | `OFDValidator` + `SESV4ValidateContainer` 通过；时间戳解析成功 |
| `signed-sesv5.ofd` | SESv5 签章 | `OFDValidator` + `SESV5ValidateContainer` 通过；时间戳解析成功（ofdrw 2.4.0 可正常生成，无需替代） |
| `integrity.ofd` | 完整性 | `OFDIntegrityVerifier` 通过；无夹带、FileList 完整 |
| `combined-signed-integrity.ofd` | 签名+完整性 | 两个校验均通过 |
| `combined-password-encrypted.ofd` | 签名+完整性+加密 | 口令解密后，两个校验均通过 |
| `negative-tampered-content.ofd` | 负例 | 签名/Reference 校验必须失败 |
| `negative-tampered-signedvalue.ofd` | 负例 | 签章值校验必须失败 |
| `negative-tampered-signature.ofd` | 负例 | `dataHash`/Reference 校验必须失败 |
| `negative-extra-file.ofd` | 负例 | 完整性/夹带检查必须失败 |

### 信任根与 `unknown`

- 配置 `certs/root-ca.crt.pem` 为信任根时，`signed-sesv4.ofd` / `signed-sesv5.ofd` 的签名者证书链可判定为 **valid**（根 -> 叶，证书在有效期内）。
- **不配置任何信任根**时，UI/校验器应判定为 **unknown**，而不是 `invalid`。`manifest.json` 中 `expected.trustRootConfigured = "valid"`、`expected.trustRootMissing = "unknown"` 明确记录这一约定。
- 该夹具不包含 CRL/OCSP，吊销状态未覆盖。

### 时间戳

`SESv4/SESv5` 的 `SignedValue.dat` 带 GM/T 0033 时间戳令牌；按项目设计**只解析、不验证 TSA 签名**。UI 应展示时间戳时间/TSA/策略/序列号，并标注“已解析，未验证”。

## 5. 校验

SHA-256 以 `manifest.sha256` 为准：

```bash
cd packages/ofdrw-viewer-crypto/test/fixtures/crypto
sha256sum -c manifest.sha256
```

- 原生成/校验脚本已随 `scripts/` 目录移除；夹具字节已固化提交。
- 加密 FEK/IV、签章签名值、时间戳、`Encryptions.xml` 的加密时间均含随机/当前时间，因此**重新生成会改变 `.ofd` 字节和 SHA-256**；`manifest.json` / `manifest.sha256` 需同步重写。
- 如果只是消费夹具（测试/UI/CLI），直接引用本目录文件即可。

## 6. manifest 结构

```json
{
  "schemaVersion": 1,
  "ofdrwVersion": "2.4.0",
  "password": { "userName": "...", "password": "..." },
  "certificateUser": { "userName": "...", "privateKey": "certs/encrypt.key.pem" },
  "trust": {
    "root": "certs/root-ca.crt.pem",
    "signer": "certs/signer.crt.pem",
    "configured": "valid",
    "notConfigured": "unknown"
  },
  "cases": [
    {
      "id": "signed-sesv4",
      "path": "signed-sesv4.ofd",
      "type": "signed",
      "size": 9457,
      "sha256": "...",
      "credentials": null,
      "expected": {
        "signature": "valid",
        "timestamp": "parsed-only",
        "trustRootConfigured": "valid",
        "trustRootMissing": "unknown"
      }
    }
  ],
  "certs": [
    { "path": "certs/root-ca.crt.pem", "kind": "crt", "format": "pem", "sha256": "..." }
  ]
}
```

`manifest.sha256` 覆盖 `cases` 与 `certs` 中的所有文件，不覆盖 `manifest.json` 与 `README.md`。

## 7. 版本与许可

- 夹具基于 ofdrw 2.4.0（Apache License 2.0），只在测试构建中使用。
- 夹具与测试证书随本仓库发布，遵循仓库根许可证（MIT）；测试证书/私钥不构成任何生产信任材料。
- 基准 `plain.ofd` 来自 ofdrw 测试资源 `ofdrw-crypto/src/test/resources/hello.ofd`（Apache License 2.0）。

## 8. 相关文档

- 夹具校验：`sha256sum -c manifest.sha256`（见本目录）
- 夹具设计：[`docs/ofdrw-viewer-crypto设计方案.md`](../../../../../docs/ofdrw-viewer-crypto设计方案.md)