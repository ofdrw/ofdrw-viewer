# @ofdrw/ofdrw-viewer-crypto

[![npm version](https://img.shields.io/npm/v/@ofdrw/ofdrw-viewer-crypto.svg)](https://www.npmjs.com/package/@ofdrw/ofdrw-viewer-crypto)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](../../LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://nodejs.org/)

## ✨ 功能概述

`@ofdrw/ofdrw-viewer-crypto` 为 OFD 文档提供纯 JavaScript 的密码能力：

- **加密检测**：`inspect` 只读解析 `Encryptions.xml`/`decryptseed.dat`/`Signatures.xml`，返回加密层、用户、签名摘要与完整性存在性，不解密、不验证、不产出明文；
- **解密容器**：`openDecryptingContainer` 支持口令、SM2 私钥（PKCS#8/SEC1，含 PBES2 口令保护）和多重加密，返回只暴露明文的 engine `VirtualContainer`，可直接注入 `OFDDocument.open({ container })`；
- **签名与印章验证**：`verifyOfd` 一次性完成 SES v1/v4/v5 签名、`SignedValue.dat`/`Seal.esl`、Reference CheckValue、证书链/有效期/信任根，以及 GB/T 35275 防夹带完整性；
- **电子印章与时间戳解析**：`parseSeal`/`parseSignedValue` 只解析结构；时间戳只解析、不验证，固定标注“已解析，未验证”；
- **SM 基础能力**：SM2 签名/验签/加解密、SM3、SM4-CBC、KDF 与严格 ASN.1/X.509 解析。

> 本包负责“密码学验证”，不负责页面渲染、Canvas、字体/图片解码、DOM 或 CLI 参数解析。渲染仍由 `@ofdrw/ofdrw-viewer-engine` 完成。

## 📦 安装

```bash
npm install @ofdrw/ofdrw-viewer-crypto
```

需要 Node.js >= 22；浏览器环境需要 ES2022、`fetch`/`Blob`（仅在对应输入类型下使用）和 `crypto.subtle`（仅解密加密 PKCS#8 私钥时需要）。Node 文件优先使用 `byte-source` 随机读取，避免整包读入内存。

## ⚡ 快速开始

### 1. 先查询加密信息

```ts
import { inspect } from '@ofdrw/ofdrw-viewer-crypto';

const inspection = await inspect(
  { kind: 'blob', blob: file }, // 也可用 arraybuffer / url；Node 文件优先 byte-source
  { onWarning: (w) => console.warn(w.code, w.message) },
);

console.log('是否加密:', inspection.encrypted);
console.log('加密层:', inspection.layers);
console.log('用户:', inspection.users);
console.log('签名条目:', inspection.signatures);
```

`inspect` 不会解密，也不读取 `SignedValue.dat`/`Seal.esl`。加密包也可以得到明文可见的 `Signatures.xml` 摘要；`integrityPresent` 只表示 `OFDEntries.xml` 与 `signedvalue.dat` 是否同时存在。

### 2. 解密并注入 engine

```ts
import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';
import {
  openDecryptingContainer,
  type CryptoCredential,
} from '@ofdrw/ofdrw-viewer-crypto';

const credentials: CryptoCredential[] = [
  { kind: 'password', userName: 'alice', password: 'secret' },
  // 证书加密时改用：
  // { kind: 'private-key', userName: 'alice', privateKey: { pem: privateKeyPem } },
];

const result = await openDecryptingContainer({
  source: { kind: 'blob', blob: file },
  credentials, // 明文包可省略；提供时只产生 W_CRYPTO_CREDENTIAL_IGNORED
  onWarning: (w) => console.warn(w.code, w.message),
});

try {
  // result.container.encrypted === false，read() 返回明文
  const doc = await OFDDocument.open({ container: result.container });
  try {
    const page = await doc.getPage(0);
    console.log(page.getSize());
  } finally {
    await doc.close(); // engine 只借用容器，不关闭它
  }
} finally {
  await result.container.close(); // 容器所有权归调用方
}
```

`result.layers` 给出每层命中的用户、解密文件数和清理的元数据，可用于展示“解密成功/多层加密”。任何时候都必须关闭返回的容器。

### 3. 一次性验证完整性与签名

```ts
import { verifyOfd } from '@ofdrw/ofdrw-viewer-crypto';

const report = await verifyOfd({
  // Node 文件可改用 { kind: 'byte-source', source }，避免整包读取
  source: { kind: 'arraybuffer', data: await file.arrayBuffer() },
  credentials,
  roots: [{ pem: rootCertPem }], // 可选；不配置时证书链为 unknown
  signatureIds: undefined,       // 可选：只验证指定签名 ID
  onWarning: (w) => console.warn(w.code, w.message),
});

console.log('overall:', report.overall);
console.log('integrity:', report.integrity?.status ?? 'not-protected');
for (const signature of report.signatures) {
  console.log(signature.id, signature.status, signature.timestamp.note);
}
```

`verifyOfd` 对 `source`/`container` 二选一：

- 传 `source` 时，如果包是加密的，函数内部自动调用 `openDecryptingContainer`，验证结束后关闭临时明文容器；
- 传 `container` 时必须是已解密的容器（`encrypted === false`）；加密容器抛 `CRYPTO_CREDENTIALS_REQUIRED`，请先自行解密；
- 验证失败（签名无效、完整性失败、证书链不可信等）写入 `report`，不抛异常；入口参数、根证书非法、包结构/凭据/取消错误才抛 `CryptoError`。

### 4. 解析印章与时间戳

```ts
import { parseSeal, parseSignedValue, parseTimestamp } from '@ofdrw/ofdrw-viewer-crypto';

const seal = parseSeal(sealEslBytes);
console.log(seal.version, seal.name, seal.makerCertificate?.subject);

const signedValue = parseSignedValue(signedValueBytes);
console.log(signedValue.version, signedValue.dataHash, signedValue.seal?.esId);

const timestamp = parseTimestamp(timestampTokenBytes);
console.log(timestamp.status, timestamp.genTime, timestamp.note);
// status 只可能是 parsed-not-verified / not-present / parse-error
```

`parseSeal`/`parseSignedValue` 的解析成功**不代表验签通过**；时间戳的 `parsed-not-verified` 也不代表 TSA 可信。

### 5. Node 文件与随机访问源

Node/CLI 处理本地 OFD 时，优先把已有随机读取实现包成 `byte-source`，让 crypto 通过 engine 的 ZIP 容器按需读取条目，而不是 `readFile` 整包：

```ts
import type { ByteSource } from '@ofdrw/ofdrw-viewer-engine';
import {
  inspect,
  type CryptoSource,
} from '@ofdrw/ofdrw-viewer-crypto';

// 宿主/CLI 提供：基于 fs.promises.open 的随机读实现（例如 CLI 内部的
// NodeFileByteSource）；crypto 本身不 import node:*。
const fileSource: ByteSource = await openRandomFileSource(path);
const source: CryptoSource = { kind: 'byte-source', source: fileSource };

try {
  const inspection = await inspect(source);
  console.log(inspection.encrypted, inspection.signatures.length);
} finally {
  await closeRandomFileSource(fileSource); // 调用方拥有并关闭 ByteSource
}
```

`byte-source` 的所有权与读取语义：

- `source` 必须是 engine 公共 `ByteSource`：`size` 为非负整数（单位 byte），`read(offset, length)` 返回 `Uint8Array`。crypto 通过隔离视图读取，**始终不调用调用方的 `close`**。
- crypto 先按 `source.size` 检查 `maxSourceBytes`（不读取内容），再按 ZIP 中央目录与所需条目读取；不会为了 `inspect`/`verifyOfd` 整包读取。
- `inspect`/`verifyOfd` 关闭自己打开的容器；`openDecryptingContainer` 对明文包返回 **source-backed** 容器（所有权转给调用方），对加密包返回内存容器并在返回前关闭内部源容器。调用方仍需在结束后关闭自己的字节源。
- `signal` 会传递到每次读取，取消抛 `CRYPTO_ABORTED`；字节源结构非法或 `read()` 返回非 `Uint8Array` 抛 `CRYPTO_SOURCE_UNSUPPORTED`，底层读取异常/包结构损坏按 `CRYPTO_INVALID_PACKAGE`，`size` 超限抛 `CRYPTO_LIMIT_EXCEEDED`。
- 浏览器继续使用 `arraybuffer`/`blob`/`url`；`url` 由 crypto 流式读取整包（受 `maxSourceBytes` 限制），不是随机访问。
- `byte-source` 不是 engine 的 `OFDSource.kind='node-file'`；CLI 的 `NodeFileByteSource` 用 `fs.promises.open` 随机读，并由 CLI 在成功/失败/取消/SIGINT 后关闭。

### 支持的平台

| 环境 | 支持情况 | 注意事项 |
| --- | --- | --- |
| 现代浏览器 | 支持 | 纯 JS、无 DOM 依赖；`blob`/`url` 走标准 `Blob`/`fetch`；加密 PKCS#8 需要 `crypto.subtle` |
| Node.js >= 22 | 支持 | 不 import `node:*`；文件优先用 `byte-source`（CLI 的 `NodeFileByteSource` 随机读）；`arraybuffer` 兼容；URL 源依赖全局 `fetch` |
| Web Worker | 支持 | 与浏览器相同；不要传入 DOM 对象 |
| 微信小程序 | 未作为验收目标 | 无标准 `Blob`/`fetch`/`WebCrypto` 时请使用 `arraybuffer`，并避免加密 PKCS#8；宿主需自行读取文件 |

## 🔐 加密与解密凭据

### 凭据类型

| 类型 | 字段 | 用于 |
| --- | --- | --- |
| 口令 | `{ kind: 'password', userName?, password }` | `UserInfo` 无 `UserCert` 的口令加密用户 |
| SM2 私钥 | `{ kind: 'private-key', userName?, privateKey }` | `UserInfo` 有 `UserCert` 的证书加密用户 |
| 多个凭据 | `CryptoCredential[]` | 按顺序尝试；多用户包可覆盖多个候选 |

`userName` 可省略，但仅在**唯一匹配用户**时自动选择；多个候选会抛 `CRYPTO_USER_AMBIGUOUS`，建议 UI/CLI 显式传入。

私钥支持：

- 未加密 PKCS#8 PEM/DER；
- 未加密 SEC1 PEM（`EC PRIVATE KEY`）；
- 加密 PKCS#8 PEM，仅支持 `PBES2 + PBKDF2(HMAC-SHA1/HMAC-SHA256) + AES-128/192/256-CBC`；其他 PBES2 算法抛 `CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION`；
- 私钥必须落在 SM2 `sm2p256v1` 曲线。

```ts
const credential: CryptoCredential = {
  kind: 'private-key',
  userName: 'alice',
  privateKey: {
    pem: privateKeyPem,
    passphrase: keyPassphrase, // 仅加密 PKCS#8 需要
  },
};
```

未加密私钥传 `passphrase` 只会产生 `W_CRYPTO_CREDENTIAL_IGNORED`，不会导致失败。口令/私钥只作为调用栈局部变量使用，不进入结果、warning 或错误消息。

### 错误凭据

- 口令错误：`CRYPTO_WRONG_PASSWORD`；
- 私钥与用户证书不匹配：`CRYPTO_PRIVATE_KEY_MISMATCH`；
- 找不到匹配用户：`CRYPTO_USER_NOT_FOUND`；
- 加密包缺少凭据：`CRYPTO_CREDENTIALS_REQUIRED`；
- 多个凭据全部失败：单凭据保留具体错误，多凭据统一 `CRYPTO_DECRYPT_FAILED`（仍可结合 `cause`/日志定位，但不会回显密码）。

## 🧮 SM2 / SM3 / SM4 能力

以下 API 适合生成测试数据、实现低层协议或与 Java/其他系统互操作；一般 OFD 解密/验签只需使用 `inspect`/`openDecryptingContainer`/`verifyOfd`。

| API | 说明 |
| --- | --- |
| `sm3Digest(data)` / `sm3Hex(data)` | SM3 摘要，返回 `Uint8Array` / 小写十六进制 |
| `sm3OfText(text)` | UTF-8 文本的 SM3 |
| `sm4EncryptCbc` / `sm4DecryptCbc` | SM4-CBC，默认严格 PKCS#7；key/IV 各 16 byte |
| `sm2Sign` / `sm2Verify` | SM3withSM2，DER 签名；默认 userId `1234567812345678` |
| `sm2Encrypt` / `sm2Decrypt` | SM2 C1C3C2 加解密；默认输出不含 `04` 前缀 |
| `sm2GetPublicKey` | 由私钥推导未压缩公钥 |
| `derivePasswordKey` | OFD 口令 KDF（SM3） |
| `kdfSm3` | GB/T 32918.3 KDF |
| `parseSm2PrivateKey` | PKCS#8/SEC1 私钥结构解析 |

SM2 `userId` 默认是标准值，**不从证书推导**；需要自定义时在 `CryptoOptions.sm2UserId` 或 `sm2Sign/sm2Verify` 的 `options.userId` 中显式传入。

## 🖋️ 电子印章、签名、完整性与时间戳

`verifyOfd` 会按以下顺序产出报告：

1. **签名列表**：读取 `Signatures.xml`，逐个解析 `Signature.xml`、`SignedValue.dat`；
2. **Reference**：对每个引用文件计算 SM3，比较 `CheckValue`（优先 Base64，兼容历史十六进制）；
3. **SES 签名**：支持 SES v1（GM/T 0031-2014）和 v4/v5（GB/T 38540-2020 / GM/T 0031-2025），对 `TBS_Sign` 原始 DER 做 SM3withSM2 验签；
4. **印章**：`Seal.esl` 与 `TBS_Sign.eseal` 做逐字节比较，并用制章者证书验证印章签名；
5. **证书链**：签名者/制章者证书 → 中间 CA → 配置的信任根；检查 SM3withSM2 证书签名、有效期、BasicConstraints、KeyUsage 与 pathLenConstraint；
6. **防夹带完整性**：`OFDEntries.xml` 的 FileList 与包内实际文件比对，并验证 `signedvalue.dat` 的 GB/T 35275 SignedData；
7. **时间戳**：只解析字段、比较 messageImprint 与签章签名值的结构一致性，不验证 TSA 签名。

### 状态语义

| 字段 | 取值 | 含义 |
| --- | --- | --- |
| `overall` | `valid` / `invalid` / `unknown` / `unsupported` / `not-applicable` | 整体结论；时间戳不参与 |
| `signature.status` | 同上 | 单个签名汇总 |
| `signature.signature.status` | 同上 | TBS 签名数学验签 |
| `signature.references.status` | 同上 | 引用文件 CheckValue |
| `signature.certificate.status` | `valid` / `invalid` / `expired` / `not-yet-valid` / `untrusted` / `incomplete` / `unsupported` / `not-present` / `unknown` | 证书链 |
| `signature.seal?.matchesSignedValue` | `boolean` | Seal.esl 与 SignedValue 内嵌印章字节一致；不等于验签通过 |
| `integrity.status` | `valid` / `invalid` / `unknown` / `unsupported` | 防夹带完整性；无保护时整个 `integrity` 为 `null` |
| `timestamp.status` | `parsed-not-verified` / `not-present` / `parse-error` | 时间戳只解析 |

`integrity === null` 表示“没有同时提供 `OFDEntries.xml` + `signedvalue.dat`”，不是“完整性有效”。此时用 `report.package.integrityPresent === false` 判断未受保护。

### 时间戳的安全边界

- 固定 `status: 'parsed-not-verified'`，文案固定 `note: '已解析，未验证'`；
- **不验证** TSA SignedData 签名、ESSCertID、策略链、TSA 证书有效期；
- `messageImprintMatchesSignature` 只表示摘要与签章签名值结构匹配，不是“时间可信”；
- 时间戳不参与 `overall`，也不得用来替代证书有效期判断的当前时间。

## 🏛️ 根证书配置

`verifyOfd` 的 `roots` 是**自包含证书输入**，不是 URL/path：

```ts
const report = await verifyOfd({
  source,
  roots: [
    { pem: rootPem },             // PEM 文本，可含多张
    { der: rootDerBytes },        // DER/CER 字节
    { data: rootPemBytes },       // 原始字节（PEM 或 DER）
  ],
});
```

- `CertificateInput` 的 `data`/`pem`/`der` 必须且只能提供一个；
- 根证书非法 → `CRYPTO_TRUST_ROOT_INVALID`；
- `roots` 省略或空数组 → **不配置信任根**；证书链状态为 `unknown` 并产生 `W_CRYPTO_TRUST_UNKNOWN`，不会判为 `valid`；
- 配置根后，链必须能追到 SHA-256 指纹一致的根（即证书内容一致）；缺少中间证书为 `incomplete`，终点不是根为 `untrusted`；
- 有效期使用 `now`（默认 `new Date()`），边界为 `notBefore <= now <= notAfter`；
- 不检查 CRL/OCSP，`certificate.revocation` 固定为 `'not-checked'`。

UI/CLI 若需要 `url`/`path`/`filePath` 根证书来源，应先由宿主读取成字节，再转换成上述三态；crypto 不 import `node:fs`。

## ⚠️ 错误码与 warning

### CryptoError

所有密码/结构/参数失败抛 `CryptoError`：

```ts
import { CryptoError, isCryptoError } from '@ofdrw/ofdrw-viewer-crypto';

try {
  await openDecryptingContainer({ source, credentials });
} catch (error) {
  if (isCryptoError(error)) console.error(error.code, error.message);
  throw error;
}
```

| 分类 | 错误码 |
| --- | --- |
| 参数/生命周期 | `CRYPTO_INVALID_ARGUMENT`、`CRYPTO_ABORTED`、`CRYPTO_LIMIT_EXCEEDED`、`CRYPTO_SOURCE_UNSUPPORTED` |
| 凭据 | `CRYPTO_CREDENTIALS_REQUIRED`、`CRYPTO_USER_NOT_FOUND`、`CRYPTO_USER_AMBIGUOUS`、`CRYPTO_WRONG_PASSWORD`、`CRYPTO_PRIVATE_KEY_INVALID`、`CRYPTO_PRIVATE_KEY_PASSPHRASE_REQUIRED`、`CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION`、`CRYPTO_PRIVATE_KEY_MISMATCH` |
| 包/解密 | `CRYPTO_INVALID_PACKAGE`、`CRYPTO_NOT_ENCRYPTED`、`CRYPTO_UNSUPPORTED_ENCRYPTION`、`CRYPTO_ENTRY_MAP_INVALID`、`CRYPTO_DECRYPT_FAILED`、`CRYPTO_DECRYPT_LAYER_LIMIT`、`CRYPTO_LAYER_LOOP` |
| 验证/解析 | `CRYPTO_ASN1_INVALID`、`CRYPTO_UNSUPPORTED_SES_VERSION`、`CRYPTO_UNSUPPORTED_ALGORITHM`、`CRYPTO_CERTIFICATE_INVALID`、`CRYPTO_TRUST_ROOT_INVALID`、`CRYPTO_INTEGRITY_INVALID`、`CRYPTO_SIGNATURE_INVALID`、`CRYPTO_TIMESTAMP_PARSE` |

验证失败通常不抛错，而是写入 `VerificationReport` 的 `issues`/`status`；`CRYPTO_INTEGRITY_INVALID`/`CRYPTO_SIGNATURE_INVALID` 只在无法产出报告或解析入口错误时抛出。

### warning

warning 不中断流程，通过 `onWarning` 接收；同一 warning 由 `WarningCollector` 去重。

| warning 码 | 场景 |
| --- | --- |
| `W_CRYPTO_DUPLICATE_USER` | 多个 `UserInfo` 的 `(userName, method, 证书指纹)` 重复 |
| `W_CRYPTO_CREDENTIAL_IGNORED` | 明文包提供凭据，或未加密私钥传 passphrase |
| `W_CRYPTO_ENTRIES_MAP_PLAINTEXT` | `entriesmap.dat` 为明文 XML |
| `W_CRYPTO_ENTRY_MAP_INVALID` | entriesmap 存在可容忍的异常项 |
| `W_CRYPTO_KEY_USAGE_MISSING` | 证书缺少 KeyUsage 扩展 |
| `W_CRYPTO_MULTI_LAYER` | 解密层数大于 1 |
| `W_CRYPTO_TIMESTAMP_PARSE` | 时间戳不可解析 |
| `W_CRYPTO_TIMESTAMP_IMPRINT_MISMATCH` | 时间戳 messageImprint 与签章签名值不匹配 |
| `W_CRYPTO_UNKNOWN_SES_VERSION` | 未知 SES 版本/OFD 签名索引不可解析 |
| `W_CRYPTO_REFERENCE_UNSUPPORTED` | Reference CheckMethod 不是 SM3 |
| `W_CRYPTO_SEAL_PICTURE_INVALID` | 印章图片缺失/损坏，印章签名仍可继续 |
| `W_CRYPTO_TRUST_UNKNOWN` | 未配置信任根，证书链无法判定 |
| `W_CRYPTO_CERT_SOURCE_UNSUPPORTED` | `skipInvalid` 时证书输入读取/解析失败被跳过 |

`CryptoError`/warning/report 的消息不会包含口令、私钥、PEM、`EncryptedWK` 或密钥字节。

## 🌐 浏览器与 Node.js 注意事项

- **无 DOM/无 Node 运行时依赖**：源码不 import `node:*`/`fs`/`path`，可直接被浏览器 bundler 打包；Node 文件优先由宿主/CLI 提供 `byte-source`，浏览器用 `blob`/`arraybuffer`。
- **WebCrypto**：只有加密 PKCS#8（PBES2）需要 `globalThis.crypto.subtle`；不可用时抛 `CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION`，不会静默尝试错误口令。
- **Blob/URL**：`blob` 通过 engine 的 `BlobSource` 按区间 `slice().arrayBuffer()`，不整包读取；`url` 使用 `fetch`，在响应体读取过程中按 `maxSourceBytes` 流式累计，超限立即取消。没有 `Content-Length` 也不会先整包缓冲。
- **取消**：所有长流程接受 `AbortSignal`；`byte-source` 每次读取都会检查；取消抛 `CRYPTO_ABORTED`。`openDecryptingContainer` 在取消/关闭竞态下不会返回未关闭的明文容器。
- **内存**：明文包的 `openDecryptingContainer` 返回 source-backed 容器，不复制包体；加密包会构造完整明文条目到内存；`byte-source` 的 `inspect`/`verify` 不整包读取。默认 `maxSourceBytes` 为 256 MiB，大文件请在调整限制前评估内存。
- **Node `fetch`**：Node 22 提供全局 `fetch`/`Blob`；若宿主删除全局实现，请使用 `byte-source`/`arraybuffer`，不要依赖 `url`。
- **小程序**：无标准 `Blob`/`fetch`/`WebCrypto`；未列入本包验收目标，建议只用 `arraybuffer` 且避免加密 PKCS#8。

## 🛡️ 安全边界

- **时间戳仅解析**：TSA 签名、证书、策略、有效期均不验证；`parsed-not-verified` 不能宣传为“时间戳有效”。
- **无根证书 = unknown**：未配置 `roots` 时绝不会返回 `valid`；`unknown` 不是“已通过”。
- **完整性未保护 ≠ 有效**：`integrity === null` 只表示没有完整性元数据；`package.integrityPresent` 才表示是否存在保护。
- **不检查吊销**：`revocation: 'not-checked'`；不把“未发现吊销”表述为“证书有效”。
- **验证范围**：只证明密码学结构/签名/引用/清单一致，不判断文档业务内容是否合规。
- **敏感材料**：口令/私钥/PEM 仅作为调用栈局部变量；不写入报告、warning、错误消息、DOM/localStorage。解密流程中恢复 FEK 使用的私钥标量在用完后清零。
- **容器与字节源所有权**：`openDecryptingContainer` 返回的容器由调用方 `close()`；`verifyOfd({ container })` 不关闭宿主容器，内部解密生成的容器由 `verifyOfd` 关闭；`byte-source` 始终由调用方拥有和关闭，crypto 不关闭它。
- **不做 DRM**：本包不是访问控制/DRM 方案；解密后的明文容器内容仍可被宿主读取。

## 📚 API 表

### 输入来源

| `CryptoSource.kind` | 读取方式 | 所有权 |
| --- | --- | --- |
| `byte-source` | 宿主 `ByteSource` 随机读；Node/CLI 首选 | 调用方拥有并关闭；crypto 只读、不 close |
| `arraybuffer` | 内存字节 | 调用方提供视图 |
| `blob` | engine `BlobSource` 按区间读 | 调用方提供 Blob/File |
| `url` | `fetch` 流式读整包，受 `maxSourceBytes` | crypto 内部临时字节 |

`inspect`/`verifyOfd` 关闭内部容器，但不会关闭调用方 `ByteSource`；`openDecryptingContainer` 的明文结果容器所有权转给调用方。

### 函数

| API | 返回 | 用途 |
| --- | --- | --- |
| `inspect(source, options?)` | `Promise<OfdInspection>` | 只读查询加密层/用户/签名摘要/完整性存在性 |
| `openDecryptingContainer(options)` | `Promise<DecryptingContainerResult>` | 口令/私钥解密，返回明文 `VirtualContainer` |
| `verifyOfd(options)` | `Promise<VerificationReport>` | 一次性验证完整性与全部/指定签名 |
| `parseSeal(data, options?)` | `ParsedSeal` | 解析 `Seal.esl`（不验签） |
| `parseSignedValue(data, options?)` | `ParsedSignedValue` | 解析 `SignedValue.dat`（不验签） |
| `parseTimestamp(data, options?)` | `TimestampParseResult` | 解析 RFC 3161/GM/T 0033 时间戳（不验证） |
| `parseSignaturesXml` / `parseSignatureXml` | `SignaturesXml` / `SignatureXml` | 解析签名索引/单签名 XML |
| `parseOfdEntriesXml` | `OfdEntriesInfo` | 解析防夹带完整性清单 |
| `parseCertificates` / `parseCertificate` | `X509Certificate[]` / `X509Certificate` | 解析 PEM/DER/Base64 证书 |
| `loadCertificates` / `loadCertificate` | `Promise<X509Certificate[]>` / `Promise<X509Certificate>` | 加载 `CertificateInput`，去重/限额/取消 |
| `parseSm2PrivateKey` | `Sm2PrivateKey` | 解析 PKCS#8/SEC1 私钥 |
| `sm2Sign` / `sm2Verify` | `Uint8Array` / `boolean` | SM3withSM2 签名/验签 |
| `sm3Digest` / `sm4EncryptCbc` | `Uint8Array` | SM3/SM4 基础能力 |
| `CryptoError` / `isCryptoError` | class / type guard | 统一错误处理 |
| `DEFAULT_CRYPTO_LIMITS` / `CRYPTO_ERROR_CODES` / `CRYPTO_WARNING_CODES` | 常量 | 限制与码表 |

完整签名、字段、默认值、报告结构、错误触发条件与全部导出见 [`skills/公开API.md`](skills/公开API.md)。

## 📚 文档

- [密码能力设计方案](../../docs/ofdrw-viewer-crypto设计方案.md)
- [模块契约（CONTRACTS 第 13 章）](../../docs/CONTRACTS.md)
- [密码学 PoC 验证报告](../../docs/密码学PoC验证报告.md)
- [测试夹具说明](test/fixtures/crypto/README.md)
- [Engine](../ofdrw-viewer-engine/README.md)
- [UI 阅读器](../ofdrw-viewer-ui/README.md)
- [CLI 工具](../ofdrw-viewer-cli/README.md)
- [项目主页](../../README.md)

## 🤖 Agent Skill 与 API 参考

- [Agent Skill（SKILL.md）](skills/SKILL.md)
- [公开 API 参考](skills/公开API.md)

## 🛠️ 开发

```bash
pnpm -C packages/ofdrw-viewer-crypto typecheck
pnpm -C packages/ofdrw-viewer-crypto test
pnpm -C packages/ofdrw-viewer-crypto build
```

受保护样例与测试证书位于 [`test/fixtures/crypto/`](test/fixtures/crypto/README.md)，全部为 test-only 材料。

## 📄 许可证

本项目采用 [MIT](../../LICENSE) 许可证，Copyright (c) 2026 Quan Guanyu。
