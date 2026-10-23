---
name: ofdrw-viewer-crypto
description: Add OFD encryption inspection, decryption, electronic-seal/signature verification, anti-smuggling integrity and timestamp parsing to JavaScript/TypeScript. Use this skill whenever a task involves encrypted OFD files, password or SM2 private-key credentials, `@ofdrw/ofdrw-viewer-crypto`, `inspect`, `openDecryptingContainer`, `verifyOfd`, SES v1/v4/v5 signatures, `SignedValue.dat`/`Seal.esl`, trust roots, certificate chains, integrity `OFDEntries.xml`/`signedvalue.dat`, or OFD timestamp display. Covers Node 22/browser setup, engine `VirtualContainer` handoff, error/warning handling, and the security rules “timestamp parsed not verified”, “no roots = unknown” and “integrity null = not protected”. See the bundled 公开API.md for exact signatures and report fields.
---

# OFD 密码能力（@ofdrw/ofdrw-viewer-crypto）

本包把 OFD 的加密元数据、签章结构和完整性清单解析为可用的 TypeScript 对象，并生成可注入 engine 的**明文** `VirtualContainer`。它不做页面渲染，也不提供独立 CLI `decrypt` 命令。

**先查参数**：完整签名、返回值、默认值与错误码见 [公开API.md](./公开API.md)。本文件讲接入流程、凭据、根证书和常见坑。

## 什么时候用

- 打开加密 OFD：先 `inspect` 判断是否加密，再 `openDecryptingContainer` 解密；
- 把解密结果交给 engine：`OFDDocument.open({ container: result.container })`；
- 查询签名/印章/完整性并展示验证面板；
- 配置根证书，校验证书链与有效期；
- 解析 `Seal.esl`、`SignedValue.dat`、时间戳令牌；
- 需要 SM2/SM3/SM4 基础能力或 OFD 低层结构解析。

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
  parseSeal,
  parseSignedValue,
  parseTimestamp,
  type CryptoCredential,
} from '@ofdrw/ofdrw-viewer-crypto';
```

Node.js >= 22；浏览器需 ES2022。源码不 import `node:*`，Node 文件请先读成 `arraybuffer`。

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
    await doc.close();
  }
} finally {
  await result.container.close();
}
```

关键点：

- `result.container.encrypted === false`，`read()` 返回明文；
- engine **借用** `container`，不会替你关闭；
- `result.container` 由调用方拥有，失败/成功都要关闭；
- 明文包也会返回容器（`plaintext: true`），此时凭据可省略；提供凭据会 warning `W_CRYPTO_CREDENTIAL_IGNORED`。

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
- 私钥支持未加密 PKCS#8 PEM/DER、SEC1 PEM、PBES2 加密 PKCS#8（HMAC-SHA1/SHA256 + AES-CBC）；其他 PBES2 算法抛 `CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION`；
- 未加密私钥传 `passphrase` 只 warning，不失败；
- 口令/私钥只在调用栈中存在，不要写日志、DOM 或 localStorage。

## 查询加密信息

```ts
const info = await inspect(source, { signal, onWarning });

console.log(info.encrypted, info.ofdVersion, info.packageSize);
console.log(info.layers);   // EncryptionLayerInfo[]
console.log(info.users);    // 去重后的 EncryptionUserInfo[]
console.log(info.signatures);
console.log(info.integrityPresent);
```

`inspect`：

- 只读，不解密、不验签、不读取 `SignedValue.dat`/`Seal.esl`；
- 加密包也会读取明文可见的 `Signatures.xml`；不可读的清单跳过，取消/超限仍抛错；
- `integrityPresent` 仅表示同时存在 `OFDEntries.xml` 与 `signedvalue.dat`；
- 重复用户先产生 `W_CRYPTO_DUPLICATE_USER`，再按 `(userName, method, 证书指纹)` 去重。

## 一次性验证

```ts
const report = await verifyOfd({
  source,                 // 或 container（必须已解密）
  credentials,
  roots: [{ pem: rootPem }],
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

### 源与容器

- `source` 与 `container` 必须且只能提供一个；
- 加密 `source` 且提供凭据：`verifyOfd` 内部调用 `openDecryptingContainer`，验证后关闭临时容器；
- `container.encrypted === true`：立即 `CRYPTO_CREDENTIALS_REQUIRED`，要求先用 `openDecryptingContainer`；
- `container` 属于宿主，`verifyOfd` 不关闭。

### 验证失败不抛异常

`verifyOfd` 把签名/完整性/证书链问题写进 `report`。只有入口参数、根证书、凭据、包结构、限额、取消等错误才抛 `CryptoError`。不要只捕获异常而忽略 `report.overall`。

## 根证书

```ts
roots: [
  { pem: rootPem },       // PEM 文本，可含多张
  { der: rootDerBytes },  // DER/CER
  { data: rootBytes },    // 原始字节
]
```

- 三态 `data`/`pem`/`der` 只能提供一个；
- 非法根证书：`CRYPTO_TRUST_ROOT_INVALID`；
- **未配置 roots**：证书链 `unknown`，产生 `W_CRYPTO_TRUST_UNKNOWN`，绝不会是 `valid`；
- 配置 roots 后：`valid` 必须能追到 SHA-256 指纹一致的根；缺中间证书 `incomplete`，终点不是根 `untrusted`；
- 有效期由 `now`（默认当前时间）判断；不检查 CRL/OCSP，`revocation` 固定 `'not-checked'`；
- UI 的 `url/path/filePath` 根证书来源要先由宿主读成字节，再传三态输入。

## 印章与时间戳解析

```ts
const seal = parseSeal(sealEslBytes);
const signed = parseSignedValue(signedValueBytes);
const ts = parseTimestamp(tokenBytes, { signatureValue: sesSignatureBytes });
```

- `parseSeal`/`parseSignedValue` 支持 SES v1/v4/v5，只解析、**不验签、不查链**；
- `parseSeal` 的图片损坏/缺失只产生 warning，不影响印章结构；
- `parseTimestamp` 从不抛解析异常：不可解析返回 `status: 'parse-error'`，无令牌返回 `not-present`；
- 时间戳可解析时固定 `status: 'parsed-not-verified'`、`note: '已解析，未验证'`；
- `messageImprintMatchesSignature` 只是结构一致性，不是“时间可信”。

## 引擎交接与生命周期

```ts
const result = await openDecryptingContainer(...);
const doc = await OFDDocument.open({ container: result.container });
try {
  // 渲染/读取页面
} finally {
  await doc.close();             // 不关闭借用容器
  await result.container.close(); // 调用方关闭
}
```

- 不要在 `doc.close()` 前关闭容器；
- `container.close()` 幂等；关闭后 `read`/`list` 抛 engine `OFD_CLOSED`；
- 取消时 `openDecryptingContainer` 抛 `CRYPTO_ABORTED`，不会返回半解密容器；
- 解密在内存中完成，大包注意 `maxSourceBytes`（默认 256 MiB）和内存。

## 错误处理

```ts
try {
  await openDecryptingContainer({ source, credentials });
} catch (error) {
  if (isCryptoError(error)) {
    switch (error.code) {
      case 'CRYPTO_CREDENTIALS_REQUIRED':
      case 'CRYPTO_WRONG_PASSWORD':
      case 'CRYPTO_PRIVATE_KEY_MISMATCH':
        // 提示重新输入/重试
        break;
      case 'CRYPTO_ABORTED':
        // 用户取消
        break;
      default:
        // 包损坏/不支持/限额
        break;
    }
  }
  throw error;
}
```

常见错误：

| 码 | 处理 |
| --- | --- |
| `CRYPTO_CREDENTIALS_REQUIRED` | 加密包未给凭据，或 `verifyOfd` 收到加密容器 |
| `CRYPTO_USER_NOT_FOUND` / `CRYPTO_USER_AMBIGUOUS` | 用户名不匹配/候选不唯一 |
| `CRYPTO_WRONG_PASSWORD` / `CRYPTO_PRIVATE_KEY_MISMATCH` | 凭据错误，可重试 |
| `CRYPTO_PRIVATE_KEY_PASSPHRASE_REQUIRED` | 加密 PKCS#8 缺少口令 |
| `CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION` | PBES2 算法不受支持或缺少 `crypto.subtle` |
| `CRYPTO_INVALID_PACKAGE` / `CRYPTO_ENTRY_MAP_INVALID` / `CRYPTO_LAYER_LOOP` | 包结构损坏，不要盲目重试 |
| `CRYPTO_LIMIT_EXCEEDED` | 超限；检查 limits 或拒绝输入 |
| `CRYPTO_ABORTED` | 用户取消/关闭竞态 |
| `CRYPTO_TRUST_ROOT_INVALID` | 根证书输入非法 |
| `CRYPTO_ASN1_INVALID` / `CRYPTO_UNSUPPORTED_SES_VERSION` | 签章/时间戳结构不支持 |

warning 码与触发场景见 [公开API.md](./公开API.md) 和 README。

## 浏览器 / Node 注意事项

- **Node**：`source: { kind: 'arraybuffer', data: await readFile(...) }`；不要期待本包读文件。
- **浏览器**：`File` 就是 `Blob`，可直接 `{ kind: 'blob', blob: file }`；URL 源受 `maxSourceBytes` 流式限制。
- **WebCrypto**：只有 PBES2 加密私钥需要 `globalThis.crypto.subtle`；缺失时明确报不支持。
- **取消**：把 `AbortSignal` 从 UI 一路传到 `inspect`/`open`/`verify`；取消后不要复用旧结果。
- **内存**：解密会产生完整明文容器；超大文档先评估限制，不要把上限设成 `0` 或无限。
- **小程序**：未作为验收目标；无标准 `Blob`/`fetch`/`WebCrypto` 时用 `arraybuffer`，避免加密 PKCS#8。

## 安全边界（必须遵守）

1. **时间戳只解析，不验证**；不得显示“时间戳有效/可信时间”。
2. **无根证书 = unknown**；不得把 `unknown` 当 `valid`/`invalid`，也不得省略 warning。
3. **完整性未保护 ≠ 有效**；`integrity === null` 只表示没有 `OFDEntries.xml`+`signedvalue.dat`。
4. **不检查吊销**；不要把“未发现吊销”写成“证书有效”。
5. **验证的是密码学一致性**，不保证文档业务内容真实、合法或未泄露。
6. **不记录敏感材料**：口令、私钥、PEM、`EncryptedWK` 不进入日志/报告/DOM/localStorage。
7. **容器所有权**：`openDecryptingContainer` 返回的容器调用方关闭；`verifyOfd` 内部创建的容器自己关闭，宿主容器不关闭。
8. **不做 DRM**：解密后明文对宿主可见；需要访问控制应在宿主层实现。

## 常见坑

- 把 `verifyOfd` 的 `overall=valid` 当作“文档内容可信”：它只证明签名/完整性/链的密码学结果。
- 没有配置 `roots` 却显示“验证通过”：应为 `unknown`，并展示未配置根证书。
- 看到 `integrity=null` 就显示“完整性通过”：应显示“未受保护”。
- 在 `doc.close()` 之前关闭 `result.container`：engine 读取会与容器生命周期冲突。
- 用 `container.encrypted=true` 直接调用 `verifyOfd`：应先 `openDecryptingContainer`。
- 在浏览器把 Node `Buffer` 当输入：统一使用 `Uint8Array`/`ArrayBuffer`。
- 把 `parseTimestamp` 的 `parsed-not-verified` 显示成“已验签”：文案必须原样显示“已解析，未验证”。

## 参考

- [公开 API](./公开API.md)
- [包 README](../README.md)
- [设计方案](../../../docs/ofdrw-viewer-crypto设计方案.md)
- [CONTRACTS 第 13 章](../../../docs/CONTRACTS.md)
- [测试夹具](../test/fixtures/crypto/README.md)