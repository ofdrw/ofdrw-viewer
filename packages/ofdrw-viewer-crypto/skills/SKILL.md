---
name: ofdrw-viewer-crypto
description: Add OFD encryption inspection, decryption, electronic-seal/signature verification, anti-smuggling integrity and timestamp parsing to JavaScript/TypeScript. Use this skill whenever a task involves encrypted OFD files, password or SM2 private-key credentials, `@ofdrw/ofdrw-viewer-crypto`, `inspect`, `openDecryptingContainer`, `verifyOfd`, SES v1/v4/v5 signatures, `SignedValue.dat`/`Seal.esl`, trust roots, certificate chains, integrity `OFDEntries.xml`/`signedvalue.dat`, or OFD timestamp display. Covers Node 22/browser/worker setup, byte-source random access, engine `VirtualContainer` handoff, error/warning handling, and the security rules “timestamp parsed not verified”, “certificate chain is independent of overall” and “integrity null = not protected”.
---

# OFD 密码能力（@ofdrw/ofdrw-viewer-crypto）

本包把 OFD 的加密元数据、签章结构与完整性清单解析为 TypeScript 对象，并生成可注入 engine 的**明文**容器。它不做页面渲染，也不提供独立 CLI `decrypt` 命令。

## 定位与边界

用于：加密 OFD 的检测与解密、把明文容器交给 engine、查询并验证签名/印章/完整性、配置根证书与校验证书链、解析 `Seal.esl`/`SignedValue.dat`/时间戳，以及 SM2/SM3/SM4、ASN.1/X.509 基础能力。

不适用：OFD 渲染/转图片（用 engine 或 CLI）、签名 UI 布局（用 UI 包）、TSA 时间戳可信验证、CRL/OCSP 吊销查询、DRM。

## 安装与导入

```bash
npm install @ofdrw/ofdrw-viewer-crypto
```

```ts
import {
  CryptoError, isCryptoError, inspect, openDecryptingContainer, verifyOfd,
  certificatesToDer, type CryptoCredential,
} from '@ofdrw/ofdrw-viewer-crypto';
```

Node.js >= 22；浏览器需 ES2022。源码不 import `node:*`，Node 文件优先包成 `byte-source`（见下文），否则先读成 `arraybuffer`。浏览器需全局 `Blob`；只有 PBES2 加密私钥需要 `globalThis.crypto.subtle`。排查环境问题时可用 `getVersion()` 读取包版本（与 `VERSION` 相同，内置于产物）。

## 网络与文件获取委托（crypto 侧）

crypto **不实现网络策略**：不做 HEAD/Range 探测、不重试/退避、不定制重定向/代理/缓存策略（跟随运行环境默认 `fetch` 行为）、不刷新 token，也不提供下载进度；这些属于宿主或 `@ofdrw/ofdrw-viewer-ui`。crypto 只消费 `CryptoSource`，把包当作只读字节源解析/解密/验签。

| 来源 | crypto 的行为 |
| --- | --- |
| `{ kind: 'byte-source', source }` | 随机按需读取（ZIP 中央目录/条目）；Range、鉴权、进度、取消、重试策略全部由宿主实现；同一个 `ByteSource` 可被 `inspect`、`openDecryptingContainer`、`verifyOfd` 复用，避免重复下载 |
| `{ kind: 'url', url, headers? }` | 便捷入口：包内 `fetch` **整包**读取并拼接为内存字节（受 `maxSourceBytes` 限制）；支持 `headers`/`signal`，但没有 Range/进度/重试；只适合公开或简单鉴权的小文件 |
| `{ kind: 'blob', blob }` / `{ kind: 'arraybuffer', data }` | 已在内存/浏览器文件中的整包字节；无需额外生命周期 |

`CryptoSource.url` 是 crypto 自己的兼容入口，**不是 engine 的 URL 能力**：engine 的 `OFDSource.url` 已删除，`url` 只会在 crypto 内被读成字节。需要宿主统一管理鉴权、进度、Range、取消或重试时，用 `byte-source`（UI 正是把 URL → `HttpByteSource` → `{ kind: 'byte-source' }` 复用给 crypto 与 engine）。`url` 虽然能传 `headers`/`signal`，但没有进度回调，也不参与宿主的统一重试/刷新策略；这类场景不要用 `url` 代替 `byte-source`。详见 [网络获取委托设计](../../../docs/网络获取委托设计.md)、[engine SKILL](../../ofdrw-viewer-engine/skills/SKILL.md) 与 [UI SKILL](../../ofdrw-viewer-ui/skills/SKILL.md)。

### 同一个 ByteSource：先 inspect 再解密

```ts
import { OFDDocument, type ByteSource } from '@ofdrw/ofdrw-viewer-engine';
import {
  inspect,
  openDecryptingContainer,
  isCryptoError,
  type CryptoCredential,
  type CryptoSource,
} from '@ofdrw/ofdrw-viewer-crypto';

// source 由宿主创建并拥有（Node fs / HTTP Range / 小程序文件）；创建见下一节。
// 这里用 declare 表示由调用方注入，避免伪造本包不存在的工厂。
declare const source: ByteSource;
const cryptoSource: CryptoSource = { kind: 'byte-source', source };
const controller = new AbortController(); // 宿主取消时调用 controller.abort()
const credentials: CryptoCredential = {
  kind: 'password',
  userName: 'alice',
  password: 'secret',
};
// 证书用户改为：
// const credentials: CryptoCredential = {
//   kind: 'private-key',
//   userName: 'alice',
//   privateKey: { pem: pemText },
// };

try {
  const info = await inspect(cryptoSource, { signal: controller.signal });
  console.log(info.encrypted, info.signatures.length);

  const result = await openDecryptingContainer({
    source: cryptoSource, // 同一个 ByteSource，不重复下载
    credentials,
    signal: controller.signal,
    onWarning: (warning) => console.warn(warning.code, warning.message),
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
    await result.container.close(); // 先关容器
  }
} catch (error) {
  if (isCryptoError(error) && error.code === 'CRYPTO_ABORTED') {
    // 用户取消/关闭竞态：不要当作包损坏。
  }
  throw error;
} finally {
  await source.close?.(); // 最后关宿主源；crypto 始终不关闭它
}
```

关闭顺序很重要：`doc.close()` → `result.container.close()` → 宿主 `source.close()`。`crypto` 对 `byte-source` 只创建不转发 `close` 的隔离视图，`openDecryptingContainer` 失败/取消时也不会返回半解密容器；所以无论成功还是失败，宿主都应在自己的 `finally` 里关闭源。若 `source` 还有 `ready()`，crypto 会按需等待它完成。

### blob / arraybuffer 替代

```ts
const fromBlob: CryptoSource = { kind: 'blob', blob: file };
const fromBytes: CryptoSource = { kind: 'arraybuffer', data: bytes };
```

这两种都是整包输入，不产生额外句柄；浏览器/Worker 的环境约束见下一节《浏览器与 Worker》。

### 取消与来源错误

- 取消：`signal` 会传入 `inspect`/`openDecryptingContainer`/`verifyOfd`；中止时抛 `CRYPTO_ABORTED`，不是包损坏，也不应盲目重试。
- 来源非法：缺少 `read()`、`size` 不是非负安全整数、`read()` 返回非 `Uint8Array`、不支持的 `kind`、当前环境没有 `Blob`/`fetch`、URL 非 2xx 或读取失败，都会抛 `CRYPTO_SOURCE_UNSUPPORTED`；超过 `maxSourceBytes` 则抛 `CRYPTO_LIMIT_EXCEEDED`。
- `byte-source` 的 `read(offset, length)` 参数单位均为 byte；返回可以短于 `length`，但不能越界或返回非 `Uint8Array`。

## 运行环境与输入源

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

- `source.size` 为非负安全整数（单位 byte）；`read()` 必须返回 `Uint8Array`，结构非法抛 `CRYPTO_SOURCE_UNSUPPORTED`；
- crypto 先按 `source.size` 检查 `maxSourceBytes`（不读内容），再按需读取；取消抛 `CRYPTO_ABORTED`，底层读取异常/包损坏按 `CRYPTO_INVALID_PACKAGE`；
- `inspect`/`verifyOfd` 关闭自己打开的容器，但**始终不关闭调用方的 ByteSource**；`openDecryptingContainer` 对明文包返回 source-backed 容器，对加密包返回内存容器并在返回前关闭内部源容器；调用方仍需关闭自己的字节源。

### 浏览器与 Worker

```ts
const inspection = await inspect({ kind: 'blob', blob: file });
```

- `File` 就是 `Blob`，可直接用 `{ kind: 'blob', blob: file }`；
- `url` 由 crypto 用 `fetch` 流式读取整包（受 `maxSourceBytes` 限制），不是随机访问；`headers` 可携带鉴权头；
- 浏览器主线程/Worker 都不需要 DOM 钩子；不要向 crypto 传 DOM 对象；
- 只有 PBES2 加密私钥需要 `globalThis.crypto.subtle`；`AbortSignal` 会一路传到 `inspect`/`openDecryptingContainer`/`verifyOfd`。

### 微信小程序

微信小程序不在本包支持范围内；无标准 `Blob`/`fetch`/`WebCrypto` 时请使用 `{ kind: 'arraybuffer', data }`，并避免加密 PKCS#8；宿主自行读取文件后再传入。

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

- `result.container.encrypted === false`，`read()` 返回明文；
- 明文包也会返回容器（`result.plaintext === true`），此时凭据可省略；传入凭据只产生 `W_CRYPTO_CREDENTIAL_IGNORED`；
- 拿到 `result` 后，无论后续渲染/读取成功、失败或取消，都要关闭 `result.container`；`openDecryptingContainer` 失败/取消时不返回容器，不要在 `doc.close()` 之前关闭容器。

## 查询加密信息（inspect）

```ts
const info = await inspect({ kind: 'blob', blob: file }, { signal, onWarning });
```

- 只读：不解密、不验签、不读取 `SignedValue.dat`/`Seal.esl`；
- 返回 `encrypted`、`packageSize`、`entryCount`、`ofdVersion`、`layers`、去重后的 `users`、`signatures` 摘要与 `integrityPresent`（`OFDEntries.xml` + `signedvalue.dat` 同时存在）；
- 加密包也会尝试读取 `Signatures.xml`；不可读的清单跳过，取消/超限仍抛错；
- `integrityPresent` 仅表示完整性元数据存在，不表示完整性有效；
- 同一用户名重复时最多产生一条 `W_CRYPTO_DUPLICATE_USER`（warning 按 `code/path/message` 去重），随后按 `(userName, method, 证书指纹)` 去重；`warnings` 也通过 `onWarning` 推送。

## 选择凭据

| 包内用户 | 凭据 |
| --- | --- |
| `UserInfo` 无 `UserCert` | `{ kind: 'password', userName?, password }` |
| `UserInfo` 有 `UserCert` | `{ kind: 'private-key', userName?, privateKey: { pem 或 der, passphrase? } }` |

- `userName` 省略时只在唯一候选用户时自动匹配；多候选请显式传，否则 `CRYPTO_USER_AMBIGUOUS`；
- 单凭据保留 `CRYPTO_WRONG_PASSWORD` / `CRYPTO_PRIVATE_KEY_MISMATCH` 等可区分错误；多凭据逐个尝试，至少命中用户但全部无法恢复文件密钥时统一 `CRYPTO_DECRYPT_FAILED`（私钥结构/算法/超限错误仍直接抛出）；
- 私钥支持未加密 PKCS#8 PEM/DER、SEC1 PEM 与 PBES2 加密 PKCS#8；其他 PBES2 算法抛 `CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION`；加密私钥需要 `globalThis.crypto.subtle`，未加密私钥传 `passphrase` 只 warning。

常见凭据错误：`CRYPTO_CREDENTIALS_REQUIRED`（未给凭据/加密容器）、`CRYPTO_USER_NOT_FOUND`/`CRYPTO_USER_AMBIGUOUS`（用户名不匹配/候选不唯一）、`CRYPTO_WRONG_PASSWORD`/`CRYPTO_PRIVATE_KEY_MISMATCH`（凭据错误，可提示重试）、`CRYPTO_PRIVATE_KEY_PASSPHRASE_REQUIRED`（加密 PKCS#8 缺少口令）、`CRYPTO_PRIVATE_KEY_INVALID`（私钥结构/曲线/Base64 非法）。

## 解密容器与 engine 交接

```ts
const result = await openDecryptingContainer({ source, credentials, signal });
const doc = await OFDDocument.open({ container: result.container });
try { /* 渲染/读取页面 */ } finally {
  await doc.close();              // 不关闭借用容器
  await result.container.close(); // 调用方关闭
}
```

- `result.layers` 是逐层解密摘要（命中用户、解密文件数、清理的元数据、entriesmap 形态）；
- `result.inspection` 混合原始包与明文视图：`encrypted`/`packageSize`/`layers`/`users` 来自原始包，`signatures`/`integrityPresent`/`entryCount`/`ofdVersion` 来自解密后的明文；
- 明文包返回 source-backed 容器（`url` 输入为已读字节的内存容器），不复制包体；加密包在内存中构造完整明文条目，并移除 `Encryptions.xml`/`decryptseed.dat`/`entriesmap.dat` 等加密元数据；
- `container.close()` 幂等；关闭后 `read`/`list` 抛 engine `OFD_CLOSED`；
- 取消时抛 `CRYPTO_ABORTED`，不会返回半解密容器；超过 `maxDecryptLayers`（默认 4）抛 `CRYPTO_DECRYPT_LAYER_LIMIT`，层循环抛 `CRYPTO_LAYER_LOOP`；
- 容器交接语义见 [engine SKILL](../../ofdrw-viewer-engine/skills/SKILL.md)。

若经 `@ofdrw/ofdrw-viewer-ui` 接入，URL/网络获取与生命周期由 UI 统一管理，UI 会把字节源映射为 `{ kind: 'byte-source', source }` 再交给本包；直接调用 crypto 的宿主仍可使用 `CryptoSource.url`，自行控制 `fetch` 鉴权与取消。见上文《网络与文件获取委托（crypto 侧）》与 [UI SKILL](../../ofdrw-viewer-ui/skills/SKILL.md)。

## 一次性验证

```ts
import { certificatesToDer, verifyOfd } from '@ofdrw/ofdrw-viewer-crypto';

const report = await verifyOfd({
  source,                            // 或 container（必须已解密）
  credentials,
  roots: certificatesToDer(rootPem), // PEM/DER/CER/Base64 → 逐张 DER
  signatureIds: ['sig-1'],
  now: new Date(),
  signal,
  onWarning: (w) => console.warn(w.code, w.message),
});

console.log(report.overall, report.package.integrityPresent);
console.log(report.integrity?.status ?? 'not-protected');
for (const sig of report.signatures) {
  console.log(sig.status, sig.signature.status, sig.certificate.status, sig.timestamp.status);
}
```

`verifyOfd` 会：读取 `Signatures.xml` 与各 `Signature.xml`/`SignedValue.dat`；对 Reference 做 SM3 CheckValue 校验；对 SES v1/v4/v5 的 `TBS_Sign` 原始 DER 做 SM3withSM2 验签；逐字节比较 `Seal.esl` 与 `TBS_Sign.eseal` 并用制章者证书验章；构建到信任根的证书链；比对 `OFDEntries.xml` FileList 与包内文件并验证 `signedvalue.dat` 的 GB/T 35275 SignedData；解析时间戳并比较 messageImprint（不验证 TSA 签名）。

### source 与 container

- `source` 与 `container` 必须且只能提供一个，否则 `CRYPTO_INVALID_ARGUMENT`；
- 加密 `source`：内部调用 `openDecryptingContainer`，验证后关闭临时容器；宿主的 `container` 不关闭；
- `container.encrypted === true`：立即 `CRYPTO_CREDENTIALS_REQUIRED`，要求先解密；
- `signatureIds` 只验证匹配的 ID，不存在的 ID 不报错。

### 根证书

```ts
const roots = [...certificatesToDer(rootPem), ...certificatesToDer(rootDerBytes)];
```

- `roots` 每项为一张证书 DER（`Uint8Array`）；核心不解析 PEM/Base64/CER，也不读取 URL/path/filePath，宿主读成**原始字节**后统一经 `certificatesToDer` 转 DER；
- 非法根证书：`CRYPTO_TRUST_ROOT_INVALID`；
- **未配置 roots**：证书链不会判 `valid`，通常为 `unknown` 并产生 `W_CRYPTO_TRUST_UNKNOWN`；可确定的过期/结构错误仍展示为 `expired`/`invalid`。证书链状态不参与签名、印章、完整性与 `overall` 判定，因此签名数学与引用通过时 `overall` 仍可为 `valid`；
- 配置 roots 后：`valid` 必须锚定到 SHA-256 指纹一致的根；缺中间证书 `incomplete`、终点不是根 `untrusted`；这些链状态只作为独立明细展示，不改变签名/完整性/`overall`；
- 有效期由 `now`（默认当前时间）判断，边界为 `notBefore <= now <= notAfter`；不检查 CRL/OCSP，`revocation` 固定 `'not-checked'`。

### 状态语义

| 字段 | 取值/含义 |
| --- | --- |
| `overall` | `valid`/`invalid`/`unknown`/`unsupported`/`not-applicable`；整体结论，时间戳不参与 |
| `signature.status` | 同上的单个签名汇总 |
| `signature.signature.status` | 同上，TBS 签名数学验签 |
| `signature.references.status` | 同上，引用文件 CheckValue；无法校验按 `invalid` 聚合 |
| `signature.certificate.status` | `valid`/`invalid`/`expired`/`not-yet-valid`/`untrusted`/`incomplete`/`unsupported`/`not-present`/`unknown`；仅作独立明细展示 |
| `signature.signingTime` / `signingTimeSource` | 签发时间展示值与来源（`time-info`/`timestamp`/`signature-xml`）；只展示，不代表可信时间。当前 v1/v4/v5 实际只产生 `time-info` 或 `signature-xml`，`timestamp` 分支保留给未来结构变体 |
| `signature.seal?.matchesSignedValue` | `boolean`；Seal.esl 与 SignedValue 内嵌印章字节一致，不等于验签通过 |
| `integrity.status` | `valid`/`invalid`/`unknown`/`unsupported`，防夹带完整性 |
| `timestamp.status` | `parsed-not-verified`/`not-present`/`parse-error`，只解析 |

聚合优先级：`invalid` > `unknown` > `unsupported` > `valid`；无完整性且无签名时为 `not-applicable`。证书链状态不参与签名/印章/完整性/`overall` 聚合；未配置信任根、链过期、`untrusted`/`incomplete`/`unknown` 都不会把密码学校验通过的签名降级。缺少签名者证书会导致签名数学无法验证，仍为 `invalid`。

`verifyOfd` 把签名/完整性/印章问题写进 `report.overall`、子项 `status` 与 `issues`；证书链状态只写入 `certificate` 明细与 warning，不改变 `overall`。只有入口参数、根证书、凭据、包结构、限额、取消等错误才抛 `CryptoError`。不要只捕获异常而忽略 `report`。

完整性：`report.integrity === null` 表示没有可校验的完整性对象——未检测到 `OFDEntries.xml`，或清单可解析但其签名值缺失；不是“完整性有效”。`OFDEntries.xml` 存在但不可解析、或 `SignedValueLoc` 路径非法时仍返回 `status='invalid'` 的对象，不是 `null`。`missingFiles`/`extraFiles` 分别表示清单登记但包内缺失、以及包内未登记的夹带文件。

时间戳：固定 `status: 'parsed-not-verified'`、`note: '已解析，未验证'`；**不验证** TSA SignedData 签名、ESSCertID、策略链、TSA 证书有效期；`messageImprintMatchesSignature` 只表示摘要与签章签名值结构匹配，不是“时间可信”；时间戳不参与 `overall`，也不得替代证书有效期判断的当前时间。

## 解析印章与签名值

```ts
const seal = parseSeal(sealEslBytes, { maxBytes, maxDepth, maxCertificates });
const signed = parseSignedValue(signedValueBytes, { maxBytes, maxDepth });
const ts = parseTimestamp(tokenBytes, { signatureValue: sesSignatureBytes });
```

- `parseSeal`/`parseSignedValue` 支持 SES v1/v4/v5，只解析、**不验签、不查链**；
- `parseSeal` 的图片损坏/缺失只产生 warning，不影响印章结构；
- `parseSignedValue` 的 `dataHash` 是 `TBS_Sign` 声明的 `Signature.xml` SM3（小写十六进制，仅解析不比对），`seal` 是内嵌 SESeal 的公开解析，`certificateDer` 是签章者证书 DER（调用方拥有，可用于下载）；
- `parseTimestamp` 对不可解析内容返回 `parse-error`（参数本身非法仍抛错），无令牌返回 `not-present`，可解析时固定 `parsed-not-verified`；
- 校验签名请用 `verifyOfd`，不要用 `parseSeal`/`parseSignedValue` 的返回值自行推断“有效”。

## SM 与底层能力

以下底层能力适合生成测试数据、实现低层协议或与 Java/其他系统互操作；一般 OFD 解密/验签只需 `inspect`/`openDecryptingContainer`/`verifyOfd`。

- SM3：`sm3Digest`、`sm3Hex`、`sm3OfText`；
- SM4-CBC：`sm4EncryptCbc`、`sm4DecryptCbc`（默认严格 PKCS#7，key/IV 各 16 byte）；
- SM2：`sm2Sign`/`sm2Verify`（SM3withSM2，DER 签名）、`sm2Encrypt`（输出 C1C3C2，不含 `04` 前缀）/`sm2Decrypt`（默认 `auto`，带/不带 `04` 均可）、`sm2GetPublicKey`；
- KDF：`derivePasswordKey`（OFD 口令 KDF）、`kdfSm3`（GB/T 32918.3）；私钥解析：`parseSm2PrivateKey`；ASN.1/X.509：`parseDer`、`parseX509Certificate`、`certificatesToDer` 及 OID 常量。

SM2 `userId` 默认 `1234567812345678`，**不从证书推导**；需要自定义时在 `CryptoOptions.sm2UserId` 或 `sm2Sign`/`sm2Verify` 的 `options.userId` 中显式传入。

## 错误与 warning

除报告型失败（`verifyOfd` 的签名/完整性/证书链/时间戳结论）与 `parseTimestamp` 的 `parse-error` 外，密码/结构/参数错误抛 `CryptoError`，用 `isCryptoError` 判断后读取 `code`。常见处理：

| 码 | 处理 |
| --- | --- |
| `CRYPTO_WRONG_PASSWORD` / `CRYPTO_PRIVATE_KEY_MISMATCH` | 凭据错误，提示重新输入 |
| `CRYPTO_ABORTED` | 用户取消/关闭竞态 |
| `CRYPTO_INVALID_PACKAGE` / `CRYPTO_ENTRY_MAP_INVALID` / `CRYPTO_LAYER_LOOP` | 包结构损坏，不要盲目重试 |
| `CRYPTO_LIMIT_EXCEEDED` | 超限；检查 `limits` 或拒绝输入 |
| `CRYPTO_UNSUPPORTED_ENCRYPTION` / `CRYPTO_UNSUPPORTED_SES_VERSION` | 算法/结构不支持 |
| `CRYPTO_TRUST_ROOT_INVALID` / `CRYPTO_ASN1_INVALID` | 根证书或 ASN.1/DER 输入非法 |

warning 不中断流程，通过 `onWarning` 接收。常见 warning：`W_CRYPTO_DUPLICATE_USER`（重复用户）、`W_CRYPTO_CREDENTIAL_IGNORED`（凭据/passphrase 被忽略）、`W_CRYPTO_TRUST_UNKNOWN`（未配置信任根）、`W_CRYPTO_TIMESTAMP_PARSE`（时间戳解析失败）。`CryptoError`/warning/report 的消息不会包含口令、私钥、PEM、`EncryptedWK` 或密钥字节。

## 安全边界（必须遵守）

1. **时间戳只解析，不验证**；不得显示“时间戳有效/可信时间”。
2. **证书链状态独立展示**；未配置根时链通常为 `unknown`，不得把链状态当成签名/完整性/`overall` 的通过或失败依据，也不得省略 warning。缺少签名者证书仍会使签名 `invalid`。
3. **完整性未保护 ≠ 有效**；`integrity === null` 表示未检测到可校验的完整性对象（无清单或签名值缺失），不是有效证明。
4. **不检查吊销**；不要把“未发现吊销”写成“证书有效”。
5. **验证的是密码学一致性**，不保证文档业务内容真实、合法或未泄露。
6. **不记录敏感材料**：口令、私钥、PEM、`EncryptedWK` 不进入日志/报告/DOM/localStorage。
7. **容器所有权**：`openDecryptingContainer` 返回的容器调用方关闭；`verifyOfd` 内部创建的容器自己关闭，宿主容器不关闭；`ByteSource` 始终由调用方关闭。
8. **不做 DRM**：解密后明文对宿主可见；需要访问控制应在宿主层实现。

## 常见坑

- 把 `verifyOfd` 的 `overall=valid` 当作“文档内容可信”：它只证明签名/完整性/印章的密码学结果，不等于证书链可信。
- 把证书链 `unknown`/`untrusted`/`expired` 当作签名失败：链状态是独立明细，不影响签名/完整性/`overall`；应单独展示。
- 看到 `integrity=null` 就显示“完整性通过”：应显示“未受保护”。
- 在 `doc.close()` 之前关闭 `result.container`：engine 读取会与容器生命周期冲突。
- 用 `container.encrypted=true` 直接调用 `verifyOfd`：应先 `openDecryptingContainer`；把 PEM 直接塞进 `roots` 前必须先 `certificatesToDer`。
- 在浏览器把 Node `Buffer` 当输入：统一使用 `Uint8Array`/`ArrayBuffer`；把 `parseTimestamp` 的 `parsed-not-verified` 显示成“已验签”也是错误的，文案必须原样显示“已解析，未验证”。
- 为省事把 `maxSourceBytes` 设为 `0` 或无限：资源上限用于防御 ZIP bomb，应按业务评估后调整。

## 参考

- [API.md](./API.md)：完整签名、类型、默认值、错误码与报告字段
- [包 README](../README.md)
