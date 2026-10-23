---
name: ofdrw-viewer-crypto
description: Add OFD encryption inspection, decryption, electronic-seal/signature verification, anti-smuggling integrity and timestamp parsing to JavaScript/TypeScript. Use this skill whenever a task involves encrypted OFD files, password or SM2 private-key credentials, `@ofdrw/ofdrw-viewer-crypto`, `inspect`, `openDecryptingContainer`, `verifyOfd`, SES v1/v4/v5 signatures, `SignedValue.dat`/`Seal.esl`, trust roots, certificate chains, integrity `OFDEntries.xml`/`signedvalue.dat`, or OFD timestamp display. Covers Node 22/browser/worker setup, byte-source random access, engine `VirtualContainer` handoff, error/warning handling, and the security rules “timestamp parsed not verified”, “no roots = unknown” and “integrity null = not protected”. See the bundled API.md for exact signatures and report fields.
---

# OFD 密码能力（@ofdrw/ofdrw-viewer-crypto）

本包把 OFD 的加密元数据、签章结构和完整性清单解析为可用的 TypeScript 对象，并生成可注入 engine 的**明文** `VirtualContainer`。它不做页面渲染，也不提供独立 CLI `decrypt` 命令。

**先查参数**：完整签名、返回值、默认值与错误码见 [API.md](./API.md)。本文件讲接入流程、凭据、根证书、平台差异和常见坑。

## 什么时候用

- 打开加密 OFD：先 `inspect` 判断是否加密，再 `openDecryptingContainer` 解密；
- 把解密结果交给 engine：`OFDDocument.open({ container: result.container })`；
- 查询签名/印章/完整性并展示验证面板；
- 配置根证书，校验证书链与有效期；
- 解析 `Seal.esl`、`SignedValue.dat`、时间戳令牌；
- 需要 SM2/SM3/SM4 基础能力或 OFD 低层 ASN.1/X.509 解析。

不适用：OFD 渲染/转图片（用 engine/CLI）、签名 UI 布局（用 UI 包）、TSA 时间戳可信验证、CRL/OCSP 吊销查询、DRM。

## 安装与导入

```bash
npm install @ofdrw/ofdrw-viewer-crypto
```

```ts
import {
  CryptoError,
  isCryptoError,
  inspect,
  openDecryptingContainer,
  verifyOfd,
  certificatesToDer,
  parseSeal,
  parseSignedValue,
  parseTimestamp,
  type CryptoCredential,
} from '@ofdrw/ofdrw-viewer-crypto';
```

Node.js >= 22；浏览器需 ES2022。源码不 import `node:*`；Node 文件优先包成 `byte-source`（见下文），否则先读成 `arraybuffer`。

排查问题时先查询密码能力包版本，反馈缺陷时请一并提供：

```ts
import { getVersion } from '@ofdrw/ofdrw-viewer-crypto';

console.log(getVersion()); // 例如 0.1.0
```

`VERSION` 常量与 `getVersion()` 返回相同值；两者都内置于产物，不依赖 `package.json`。

CDN 直出（IIFE 插件，复用页面已加载的 engine）：

```html
<script src="https://cdn.jsdelivr.net/npm/@ofdrw/ofdrw-viewer-engine@0.1.0/dist/ofdrw-viewer-engine.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@ofdrw/ofdrw-viewer-crypto@0.1.0/dist/ofdrw-viewer-crypto.min.js"></script>
<script>
  const { inspect } = window.OFDRWViewerCrypto;
  inspect({ kind: 'blob', blob: file }).then((r) => console.log(r.encrypted));
</script>
```

产物为 `dist/ofdrw-viewer-crypto.js`（约 424 KB，gzip 87 KB）与 `.min.js`（约 199 KB，gzip 61 KB）；单独构建：`pnpm -C packages/ofdrw-viewer-crypto build:cdn`（需先构建 engine）。

## Node.js / 浏览器 / 小程序

### Node.js 随机读取（byte-source）

`source.kind='byte-source'` 直接复用 engine 的 `ByteSource`（`size` + `read(offset, length)`），crypto 按 ZIP 中央目录与所需条目读取，不整包读入内存。crypto 不 import `node:*`，文件句柄由宿主提供并关闭：

```ts
import { open } from 'node:fs/promises';
import type { ByteSource } from '@ofdrw/ofdrw-viewer-engine';
import { inspect } from '@ofdrw/ofdrw-viewer-crypto';

const handle = await open('encrypted.ofd', 'r');
const { size } = await handle.stat();
const source: ByteSource = {
  size,
  async read(offset, length) {
    const buffer = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    return buffer.subarray(0, bytesRead);
  },
};

try {
  const info = await inspect({ kind: 'byte-source', source });
  console.log(info.encrypted, info.signatures.length);
} finally {
  await handle.close(); // crypto 不关闭宿主 ByteSource
}
```

所有权与读取语义：

- `source.size` 为非负整数（单位 byte）；`read()` 必须返回 `Uint8Array`，结构非法抛 `CRYPTO_SOURCE_UNSUPPORTED`；
- crypto 先按 `source.size` 检查 `maxSourceBytes`（不读内容），再按需要读取；
- `inspect`/`verifyOfd` 关闭自己打开的容器，但**始终不关闭调用方的 ByteSource**；
- `openDecryptingContainer` 对明文包返回 source-backed 容器（所有权转给调用方），对加密包返回内存容器并在返回前关闭内部源容器；调用方仍需关闭自己的字节源；
- `signal` 会传递到每次读取，取消抛 `CRYPTO_ABORTED`；底层读取异常/包结构损坏按 `CRYPTO_INVALID_PACKAGE`。

### 浏览器与 Worker

```ts
const inspection = await inspect({ kind: 'blob', blob: file });
```

- `File` 就是 `Blob`，可直接用 `{ kind: 'blob', blob: file }`；
- `url` 由 crypto 用 `fetch` 流式读取整包（受 `maxSourceBytes` 限制），不是随机访问；
- 浏览器主线程/Worker 都不需要 DOM 钩子；不要向 crypto 传 DOM 对象；
- 只有 PBES2 加密私钥需要 `globalThis.crypto.subtle`；
- 有 `AbortSignal` 时一路传到 `inspect`/`openDecryptingContainer`/`verifyOfd`。

### 微信小程序

未作为本包验收目标。无标准 `Blob`/`fetch`/`WebCrypto` 时请使用 `{ kind: 'arraybuffer', data }`，并避免加密 PKCS#8；宿主自行读取文件后再传入。

## 5 分钟跑通（加密 OFD）

```ts
import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';
import { openDecryptingContainer } from '@ofdrw/ofdrw-viewer-crypto';

const result = await openDecryptingContainer({
  source: { kind: 'blob', blob: file },
  credentials: { kind: 'password', userName: 'alice', password: 'secret' },
  onWarning: (w) => console.warn(w.code, w.message),
});

try {
  const doc = await OFDDocument.open({ container: result.container });
  try {
    const page = await doc.getPage(0);
    console.log(page.getSize());
  } finally {
    await doc.close(); // engine 只借用容器，不关闭
  }
} finally {
  await result.container.close(); // 调用方拥有并关闭容器
}
```

关键点：

- `result.container.encrypted === false`，`read()` 返回明文；
- 明文包也会返回容器（`result.plaintext === true`），此时凭据可省略；提供凭据只产生 `W_CRYPTO_CREDENTIAL_IGNORED`；
- `result.container` 由调用方拥有，成功、失败、取消后都要关闭；
- 不要在 `doc.close()` 之前关闭容器。

## 查询加密信息

```ts
import { inspect } from '@ofdrw/ofdrw-viewer-crypto';

const info = await inspect(
  { kind: 'blob', blob: file },
  { signal, onWarning: (w) => console.warn(w.code, w.message) },
);

console.log(info.encrypted, info.ofdVersion, info.packageSize);
console.log(info.layers);          // EncryptionLayerInfo[]
console.log(info.users);           // 去重后的 EncryptionUserInfo[]
console.log(info.signatures);      // Signatures.xml 摘要，不含 SignedValue
console.log(info.integrityPresent); // OFDEntries.xml + signedvalue.dat 同时存在
```

`inspect`：

- 只读，不解密、不验签、不读取 `SignedValue.dat`/`Seal.esl`；
- 加密包也会读取明文可见的 `Signatures.xml`；不可读的清单跳过，取消/超限仍抛错；
- `integrityPresent` 仅表示完整性元数据存在，不表示完整性有效；
- 重复用户先产生 `W_CRYPTO_DUPLICATE_USER`，再按 `(userName, method, 证书指纹)` 去重；
- 返回 `warnings` 数组，同时通过 `onWarning` 推送。

## 选择凭据

| 包内用户 | 凭据 |
| --- | --- |
| `UserInfo` 无 `UserCert` | `{ kind: 'password', userName?, password }` |
| `UserInfo` 有 `UserCert` | `{ kind: 'private-key', userName?, privateKey: { pem/der, passphrase? } }` |

```ts
const credentials: CryptoCredential[] = [
  { kind: 'password', userName: 'alice', password: 'secret' },
  {
    kind: 'private-key',
    userName: 'bob',
    privateKey: { pem: privateKeyPem, passphrase: keyPassphrase },
  },
];
```

- `userName` 省略时只在唯一候选用户时自动匹配；多候选请显式传，否则 `CRYPTO_USER_AMBIGUOUS`；
- 多凭据按顺序尝试；单凭据保留 `CRYPTO_WRONG_PASSWORD` / `CRYPTO_PRIVATE_KEY_MISMATCH`，多凭据全失败统一 `CRYPTO_DECRYPT_FAILED`；
- 私钥支持未加密 PKCS#8 PEM/DER、SEC1 PEM、PBES2 加密 PKCS#8（`HMAC-SHA1/SHA256` + `AES-128/192/256-CBC`）；其他 PBES2 算法抛 `CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION`；
- 加密 PKCS#8 需要 `globalThis.crypto.subtle`；不可用时明确报不支持；
- 未加密私钥传 `passphrase` 只 warning，不失败；
- 私钥必须落在 SM2 `sm2p256v1` 曲线；
- 口令/私钥只在调用栈中存在，不要写日志、DOM 或 localStorage。

常见凭据错误：

| 码 | 处理 |
| --- | --- |
| `CRYPTO_CREDENTIALS_REQUIRED` | 加密包未给凭据，或 `verifyOfd` 收到加密容器 |
| `CRYPTO_USER_NOT_FOUND` / `CRYPTO_USER_AMBIGUOUS` | 用户名不匹配/候选不唯一 |
| `CRYPTO_WRONG_PASSWORD` / `CRYPTO_PRIVATE_KEY_MISMATCH` | 凭据错误，可提示重试 |
| `CRYPTO_PRIVATE_KEY_PASSPHRASE_REQUIRED` | 加密 PKCS#8 缺少口令 |
| `CRYPTO_PRIVATE_KEY_INVALID` | 私钥结构/曲线/Base64 非法 |

## 解密容器与 engine 集成

```ts
const result = await openDecryptingContainer({
  source,
  credentials,
  signal,
  onWarning: (w) => console.warn(w.code, w.message),
});
const doc = await OFDDocument.open({ container: result.container });
try {
  // 渲染/读取页面
} finally {
  await doc.close();             // 不关闭借用容器
  await result.container.close(); // 调用方关闭
}
```

- `result.inspection` 是原始包的检测结果；`result.layers` 是逐层解密摘要（命中用户、解密文件数、清理的元数据、entriesmap 形态）；
- 明文包返回 **source-backed** 容器，不复制包体；加密包在内存中构造完整明文条目；
- 加密包解密完成后会移除 `Encryptions.xml`/`decryptseed.dat`/`entriesmap.dat` 等加密元数据；
- `container.close()` 幂等；关闭后 `read`/`list` 抛 engine `OFD_CLOSED`；
- 取消时抛 `CRYPTO_ABORTED`，不会返回半解密容器；
- 超过 `maxDecryptLayers`（默认 4）抛 `CRYPTO_DECRYPT_LAYER_LIMIT`，层循环抛 `CRYPTO_LAYER_LOOP`。

## 一次性验证

```ts
import { certificatesToDer, verifyOfd } from '@ofdrw/ofdrw-viewer-crypto';

const report = await verifyOfd({
  source,                 // 或 container（必须已解密）
  credentials,
  roots: certificatesToDer(rootPem), // PEM/DER/CER/Base64 → 逐张 DER
  signatureIds: ['sig-1'],
  now: new Date(),
  signal,
  onWarning: (w) => console.warn(w.code, w.message),
});

console.log(report.overall);
console.log(report.package.integrityPresent);
console.log(report.integrity?.status ?? 'not-protected');
for (const sig of report.signatures) {
  console.log(sig.id, sig.status, sig.signature.status, sig.certificate.status);
  console.log(sig.seal?.matchesSignedValue, sig.timestamp.status);
}
```

`verifyOfd` 依次处理：

1. 读取 `Signatures.xml`，逐个解析 `Signature.xml`、`SignedValue.dat`；
2. 对每个 Reference 计算 SM3，比较 `CheckValue`（优先 Base64，兼容历史十六进制）；
3. 对 SES v1/v4/v5 的 `TBS_Sign` 原始 DER 做 SM3withSM2 验签；
4. `Seal.esl` 与 `TBS_Sign.eseal` 逐字节比较，并用制章者证书验证印章签名；
5. 构建签名者/制章者 → 中间 CA → 配置的信任根，检查证书签名、有效期、BasicConstraints、KeyUsage 与 pathLenConstraint；
6. 将 `OFDEntries.xml` 的 FileList 与包内实际文件比对，并验证 `signedvalue.dat` 的 GB/T 35275 SignedData；
7. 解析时间戳字段并比较 messageImprint，**不验证** TSA 签名与证书。

### source 与 container

- `source` 与 `container` 必须且只能提供一个，否则 `CRYPTO_INVALID_ARGUMENT`；
- 加密 `source`：`verifyOfd` 内部调用 `openDecryptingContainer`，验证后关闭临时容器；
- `container.encrypted === true`：立即 `CRYPTO_CREDENTIALS_REQUIRED`，要求先用 `openDecryptingContainer`；
- 宿主的 `container` 归宿主所有，`verifyOfd` 不关闭；
- `signatureIds` 只验证匹配的 ID，不存在的 ID 不报错。

### 验证失败不抛异常

`verifyOfd` 把签名/完整性/证书链问题写进 `report.overall`、子项 `status` 与 `issues`。只有入口参数、根证书、凭据、包结构、限额、取消等错误才抛 `CryptoError`。不要只捕获异常而忽略 `report`。

### 状态语义

| 字段 | 取值 | 含义 |
| --- | --- | --- |
| `overall` | `valid` / `invalid` / `unknown` / `unsupported` / `not-applicable` | 整体结论；时间戳不参与 |
| `signature.status` | 同上 | 单个签名汇总 |
| `signature.signature.status` | 同上 | TBS 签名数学验签 |
| `signature.references.status` | 同上 | 引用文件 CheckValue；无法校验按 `invalid` |
| `signature.certificate.status` | `valid` / `invalid` / `expired` / `not-yet-valid` / `untrusted` / `incomplete` / `unsupported` / `not-present` / `unknown` | 证书链 |
| `signature.seal?.matchesSignedValue` | `boolean` | Seal.esl 与 SignedValue 内嵌印章字节一致；不等于验签通过 |
| `integrity.status` | `valid` / `invalid` / `unknown` / `unsupported` | 防夹带完整性 |
| `timestamp.status` | `parsed-not-verified` / `not-present` / `parse-error` | 时间戳只解析 |

聚合优先级：`invalid` > `unknown` > `unsupported` > `valid`；全部子项 `not-applicable` 时为 `not-applicable`。未配置信任根时，证书链的 `incomplete` 不会把签名升级为 `invalid`，而是保持 `unknown`。

### 完整性

- `report.integrity === null` 表示“没有同时提供 `OFDEntries.xml` + `signedvalue.dat`”，即未受保护，不是“完整性有效”；
- 此时用 `report.package.integrityPresent === false` 判断未受保护；
- 完整性验证会比对 FileList 与包内实际文件，并验证 `signedvalue.dat` 的 GB/T 35275 SignedData；
- `missingFiles`/`extraFiles` 分别表示清单登记但包内缺失、以及包内未登记的夹带文件。

### 时间戳

- 固定 `status: 'parsed-not-verified'`，文案固定 `note: '已解析，未验证'`；
- **不验证** TSA SignedData 签名、ESSCertID、策略链、TSA 证书有效期；
- `messageImprintMatchesSignature` 只表示摘要与签章签名值结构匹配，不是“时间可信”；
- 时间戳不参与 `overall`，也不得用来替代证书有效期判断的当前时间。

## 根证书

公共证书接口只接收 DER（`CertificateDer = Uint8Array`）。PEM/CER/DER/Base64 与多证书先经 `certificatesToDer` 转换：

```ts
import { certificatesToDer, verifyOfd } from '@ofdrw/ofdrw-viewer-crypto';

const roots = [
  ...certificatesToDer(rootPem),       // PEM 文本，可含多张
  ...certificatesToDer(rootDerBytes),  // DER/CER 或拼接 DER
];
const report = await verifyOfd({ source, roots });
```

- `roots` 每项为一张证书 DER；核心不解析 PEM/Base64/CER，也不读取 URL/path/filePath；
- UI/CLI 的 `data/url/path/filePath` 根证书来源由宿主读成**原始字节**，再调用 `certificatesToDer` 转为 DER；
- 非法根证书：`CRYPTO_TRUST_ROOT_INVALID`；
- **未配置 roots**：证书链 `unknown`，产生 `W_CRYPTO_TRUST_UNKNOWN`，绝不会是 `valid`；
- 配置 roots 后：`valid` 必须能追到 SHA-256 指纹一致的根；缺中间证书 `incomplete`，终点不是根 `untrusted`；
- 有效期由 `now`（默认当前时间）判断，边界为 `notBefore <= now <= notAfter`；不检查 CRL/OCSP，`revocation` 固定 `'not-checked'`。

## 解析印章与签名值

```ts
const seal = parseSeal(sealEslBytes, { maxBytes, maxDepth, maxCertificates });
const signed = parseSignedValue(signedValueBytes, { maxBytes, maxDepth });
const ts = parseTimestamp(tokenBytes, { signatureValue: sesSignatureBytes });
```

- `parseSeal`/`parseSignedValue` 支持 SES v1/v4/v5，只解析、**不验签、不查链**；
- `parseSeal` 的图片损坏/缺失只产生 warning，不影响印章结构；
- `parseSignedValue` 的 `dataHash` 是 `TBS_Sign` 声明的 `Signature.xml` SM3（小写十六进制，仅解析不比对），`seal` 是内嵌 SESeal 的公开解析；
- `parseTimestamp` 从不抛解析异常：不可解析返回 `status: 'parse-error'`，无令牌返回 `not-present`；
- 时间戳可解析时固定 `status: 'parsed-not-verified'`、`note: '已解析，未验证'`；
- 校验签名请用 `verifyOfd`，不要用 `parseSeal`/`parseSignedValue` 的返回值自行推断“有效”。

## SM 基础能力

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

## 错误与 warning

所有密码/结构/参数失败抛 `CryptoError`：

```ts
try {
  await openDecryptingContainer({ source, credentials });
} catch (error) {
  if (isCryptoError(error)) console.error(error.code, error.message);
  throw error;
}
```

常见处理：

| 码 | 处理 |
| --- | --- |
| `CRYPTO_WRONG_PASSWORD` / `CRYPTO_PRIVATE_KEY_MISMATCH` | 凭据错误，提示重新输入 |
| `CRYPTO_ABORTED` | 用户取消/关闭竞态 |
| `CRYPTO_INVALID_PACKAGE` / `CRYPTO_ENTRY_MAP_INVALID` / `CRYPTO_LAYER_LOOP` | 包结构损坏，不要盲目重试 |
| `CRYPTO_LIMIT_EXCEEDED` | 超限；检查 `limits` 或拒绝输入 |
| `CRYPTO_UNSUPPORTED_ENCRYPTION` / `CRYPTO_UNSUPPORTED_SES_VERSION` | 算法/结构不支持 |
| `CRYPTO_TRUST_ROOT_INVALID` | 根证书输入非法 |
| `CRYPTO_ASN1_INVALID` | ASN.1/DER 结构非法 |

warning 不中断流程，通过 `onWarning` 接收并按 `code` 去重：

| warning 码 | 场景 |
| --- | --- |
| `W_CRYPTO_DUPLICATE_USER` | 重复用户（去重前） |
| `W_CRYPTO_CREDENTIAL_IGNORED` | 明文包凭据被忽略；未加密私钥 passphrase 被忽略 |
| `W_CRYPTO_ENTRIES_MAP_PLAINTEXT` | entriesmap 是明文 XML |
| `W_CRYPTO_ENTRY_MAP_INVALID` | entriesmap 有可容忍异常 |
| `W_CRYPTO_KEY_USAGE_MISSING` | 证书缺 KeyUsage |
| `W_CRYPTO_MULTI_LAYER` | 解密层数 > 1 |
| `W_CRYPTO_TIMESTAMP_PARSE` | 时间戳解析失败 |
| `W_CRYPTO_TIMESTAMP_IMPRINT_MISMATCH` | messageImprint 与签名值不匹配 |
| `W_CRYPTO_UNKNOWN_SES_VERSION` | 未知 SES 版本/签名索引不可解析 |
| `W_CRYPTO_REFERENCE_UNSUPPORTED` | Reference CheckMethod 非 SM3 |
| `W_CRYPTO_SEAL_PICTURE_INVALID` | 印章图片缺失/损坏 |
| `W_CRYPTO_TRUST_UNKNOWN` | 未配置信任根，链无法判定 |
| `W_CRYPTO_CERT_SOURCE_UNSUPPORTED` | `skipInvalid=true` 时非法证书输入被跳过 |

`CryptoError`/warning/report 的消息不会包含口令、私钥、PEM、`EncryptedWK` 或密钥字节。完整码表见 [API.md](./API.md)。

## 安全边界（必须遵守）

1. **时间戳只解析，不验证**；不得显示“时间戳有效/可信时间”。
2. **无根证书 = unknown**；不得把 `unknown` 当 `valid`/`invalid`，也不得省略 warning。
3. **完整性未保护 ≠ 有效**；`integrity === null` 只表示没有 `OFDEntries.xml`+`signedvalue.dat`。
4. **不检查吊销**；不要把“未发现吊销”写成“证书有效”。
5. **验证的是密码学一致性**，不保证文档业务内容真实、合法或未泄露。
6. **不记录敏感材料**：口令、私钥、PEM、`EncryptedWK` 不进入日志/报告/DOM/localStorage。
7. **容器所有权**：`openDecryptingContainer` 返回的容器调用方关闭；`verifyOfd` 内部创建的容器自己关闭，宿主容器不关闭；`ByteSource` 始终由调用方关闭。
8. **不做 DRM**：解密后明文对宿主可见；需要访问控制应在宿主层实现。

## 常见坑

- 把 `verifyOfd` 的 `overall=valid` 当作“文档内容可信”：它只证明签名/完整性/链的密码学结果。
- 没有配置 `roots` 却显示“验证通过”：应为 `unknown`，并展示未配置根证书。
- 看到 `integrity=null` 就显示“完整性通过”：应显示“未受保护”。
- 在 `doc.close()` 之前关闭 `result.container`：engine 读取会与容器生命周期冲突。
- 用 `container.encrypted=true` 直接调用 `verifyOfd`：应先 `openDecryptingContainer`。
- 把 PEM 直接塞进 `roots`：必须先 `certificatesToDer`。
- 在浏览器把 Node `Buffer` 当输入：统一使用 `Uint8Array`/`ArrayBuffer`。
- 把 `parseTimestamp` 的 `parsed-not-verified` 显示成“已验签”：文案必须原样显示“已解析，未验证”。
- 为省事把 `maxSourceBytes` 设为 `0` 或无限：资源上限用于防御 ZIP bomb，应按业务评估后调整。

## 参考

- [API.md](./API.md)
- [包 README](../README.md)
- [设计方案](../../../docs/ofdrw-viewer-crypto设计方案.md)
- [CONTRACTS 第 13 章](../../../docs/CONTRACTS.md)
- [测试夹具](../test/fixtures/crypto/README.md)
