# @ofdrw/ofdrw-viewer-crypto 公开 API

> 使用说明与示例：[SKILL.md](./SKILL.md)
> 版本：0.1.0（与 `docs/ofdrw-viewer-crypto设计方案.md`、`docs/CONTRACTS.md` 第 13 章同步）
> 公共入口：`packages/ofdrw-viewer-crypto/src/index.ts`
> 设计依据：`docs/ofdrw-viewer-crypto设计方案.md` §3
> 内部契约：`docs/CONTRACTS.md` 第 13 章
> 回归口径：`packages/ofdrw-viewer-crypto/test/`

本文档面向调用方，说明公开函数、类型、默认值、返回状态与错误边界。内部目录（`decrypt/`、`sign/`、`seal/`、`integrity/`、`timestamp/`、`verify/` 的实现文件、`container/`、`source/`）不从包根导出，不属于本文档的调用面。

---

## 0. 同步与变更规则

公开 API 的唯一权威来源是 `src/index.ts` 的导出面。新增/修改公共导出、签名、默认值、错误语义时，必须同步更新：

1. `src/index.ts` 及对应类型/实现；
2. `docs/CONTRACTS.md` 第 13 章与设计方案 §3（若涉及跨模块契约）；
3. 本文档、`README.md`、`skills/SKILL.md`；
4. 运行 `pnpm -C packages/ofdrw-viewer-crypto typecheck`、`test`、`build`。

冻结的公共类型名、错误码、warning 码不得在实现任务中随意增删/改名；UI/CLI 依赖这些语义做重试、退出码和展示。

---

## 1. 快速开始

### 1.1 只查询

```ts
import { inspect } from '@ofdrw/ofdrw-viewer-crypto';

const info = await inspect({ kind: 'arraybuffer', data: bytes });
console.log(info.encrypted, info.users, info.signatures);
```

### 1.2 解密并交给 engine

```ts
import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';
import { openDecryptingContainer } from '@ofdrw/ofdrw-viewer-crypto';

const result = await openDecryptingContainer({
  source: { kind: 'arraybuffer', data: bytes },
  credentials: { kind: 'password', userName: 'alice', password: 'secret' },
});
try {
  const doc = await OFDDocument.open({ container: result.container });
  try {
    // 渲染/读取页面
  } finally {
    await doc.close();
  }
} finally {
  await result.container.close();
}
```

### 1.3 一次性验证

```ts
import { certificatesToDer, verifyOfd } from '@ofdrw/ofdrw-viewer-crypto';

const roots = certificatesToDer(rootPem); // PEM/DER/CER/Base64 → 逐张 DER
const report = await verifyOfd({
  source: { kind: 'arraybuffer', data: bytes },
  roots,
});
console.log(report.overall, report.integrity?.status, report.signatures);
```

### 1.4 版本查询

```ts
import { VERSION, getVersion } from '@ofdrw/ofdrw-viewer-crypto';

console.log(VERSION); // 例如 0.1.0
console.log(getVersion()); // 与 VERSION 相同
```

版本号内置于产物，不读取 `package.json`；用于日志、CLI `version` 输出与故障排查。

---

## 2. 公共输入类型

### 2.1 `CryptoSource`

```ts
export type CryptoSource =
  | { readonly kind: 'arraybuffer'; readonly data: ArrayBuffer | Uint8Array }
  | { readonly kind: 'blob'; readonly blob: Blob }
  | { readonly kind: 'url'; readonly url: string;
      readonly headers?: Record<string, string> }
  | { readonly kind: 'byte-source'; readonly source: ByteSource };
```

| `kind` | 字段 | 说明 |
| --- | --- | --- |
| `arraybuffer` | `data` | 内存字节；不复制输入视图，调用方不得在调用期间修改 |
| `blob` | `blob` | 浏览器 `Blob`/`File`；Node 22 需全局 `Blob` |
| `url` | `url`、`headers` | `fetch` 读取；按 `maxSourceBytes` 流式累计，缺 `Content-Length` 时依赖 reader |
| `byte-source` | `source` | engine `ByteSource` 随机读；Node/CLI 处理本地文件首选；**调用方拥有并关闭**，crypto 只读、不 close |

`ByteSource` 由 engine 导出（`import type { ByteSource } from '@ofdrw/ofdrw-viewer-engine'`），要求 `size` 为非负安全整数（单位 byte）、`read(offset, length)` 返回 `Uint8Array`。

`readCryptoSource(source, { maxBytes, signal })` 是把输入源整体读成字节的公共工具：

- 支持 `arraybuffer`/`blob`/`url`/`byte-source`；
- `url` 没有 `Content-Length` 时按响应体 reader 分块计数，超限立即 `cancel` 并抛 `CRYPTO_LIMIT_EXCEEDED`；无法流式读取且缺少可信 `Content-Length` 时拒绝；
- `byte-source` 按 `source.size` 预检上限后分块读取（每块 1 MiB），不调用调用方 `close`；
- 先检查取消信号；读取中取消抛 `CRYPTO_ABORTED`；
- 不 import `node:*`，Node 文件由调用方读成 `arraybuffer` 或提供 `byte-source`。

业务入口（`inspect`/`openDecryptingContainer`/`verifyOfd`）优先使用按需容器，不整包调用 `readCryptoSource`；`byte-source` 的所有权与关闭规则见 [12 节](#12-与-engine-的-virtualcontainer-集成)。

### 2.2 凭据

```ts
export interface Sm2PrivateKeyInput {
  readonly pem?: string;
  readonly der?: Uint8Array;
  readonly passphrase?: string;
}

export interface PasswordCredential {
  readonly kind: 'password';
  readonly userName?: string;
  readonly password: string;
}

export interface PrivateKeyCredential {
  readonly kind: 'private-key';
  readonly userName?: string;
  readonly privateKey: Sm2PrivateKeyInput;
}

export type CryptoCredential = PasswordCredential | PrivateKeyCredential;
```

- `pem`/`der` 二选一；PEM 支持 PKCS#8、SEC1，DER 只接受 PKCS#8；
- `passphrase` 仅用于加密 PKCS#8；
- `userName` 省略时仅在唯一匹配用户时自动选择；
- 私钥必须位于 `sm2p256v1` 曲线；
- 加密 PKCS#8 支持 `PBES2 + PBKDF2(HMAC-SHA1/SHA256) + AES-128/192/256-CBC`；
- 凭据只在本次调用内使用，不进入报告/warning/错误消息。

### 2.3 证书输入

```ts
/** X.509 证书 DER 字节；公共证书接口只接收该类型。 */
export type CertificateDer = Uint8Array;
```

- `parseCertificate`、`parseCertificates`、`loadCertificate`、`loadCertificates` 与 `VerifyOfdOptions.roots` 都只接收 DER；crypto 核心不识别 PEM/Base64/CER，也不读取 URL/path/filePath。
- PEM（单/多证书）、CER、拼接 DER、Base64 必须先经 [`certificatesToDer`](#71-入口格式转换-certificatestoder) 转为逐张 DER；该工具由 UI/CLI 在入口调用，crypto 不做隐式转换。
- `loadCertificates` 的数组每项为恰好一张证书；`parseCertificates` 可直接接收拼接的多张 DER。
- DER 字节归调用方所有；crypto 不修改，也不跨调用持有，调用期间调用方不得变更同一 `Uint8Array`。

### 2.4 `CryptoOptions` 与 `ParseOptions`

```ts
export interface CryptoOptions {
  readonly limits?: Partial<CryptoLimits>;
  readonly signal?: AbortSignal;
  readonly onWarning?: CryptoWarningHandler;
  readonly sm2UserId?: string;
  readonly now?: Date;
}

export interface ParseOptions {
  readonly maxBytes?: number;
  readonly maxDepth?: number;
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `limits` | `DEFAULT_CRYPTO_LIMITS` | 浅合并的 `CryptoLimits` |
| `signal` | 无 | 中止抛 `CRYPTO_ABORTED` |
| `onWarning` | 无（不打印） | warning 回调；不改变结果 |
| `sm2UserId` | `'1234567812345678'` | SM2 签名 userId；不从证书推导 |
| `now` | `new Date()` | 证书有效期判断时间 |
| `ParseOptions.maxBytes` | `limits.maxAsn1Bytes` | 输入字节上限，单位 byte |
| `ParseOptions.maxDepth` | `limits.maxAsn1Depth` | ASN.1 嵌套深度上限 |

### 2.5 `CryptoLimits`

```ts
export interface CryptoLimits {
  readonly maxSourceBytes: number;
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxTotalDecryptedBytes: number;
  readonly maxCompressionRatio: number;
  readonly maxDecryptLayers: number;
  readonly maxAsn1Bytes: number;
  readonly maxAsn1Depth: number;
  readonly maxCertificates: number;
  readonly maxTrustRoots: number;
}
```

| 字段 | 默认 | 单位/含义 |
| --- | --- | --- |
| `maxSourceBytes` | `256 * 1024 * 1024` | byte，输入包/URL 响应上限 |
| `maxEntries` | `20_000` | 个，ZIP 条目数 |
| `maxEntryBytes` | `64 * 1024 * 1024` | byte，单条目明文上限 |
| `maxTotalDecryptedBytes` | `512 * 1024 * 1024` | byte，单层解压总量 |
| `maxCompressionRatio` | `200` | 解压总量 / 输入字节数 |
| `maxDecryptLayers` | `4` | 层，嵌套加密上限 |
| `maxAsn1Bytes` | `16 * 1024 * 1024` | byte，单 ASN.1 结构 |
| `maxAsn1Depth` | `64` | 层，ASN.1 嵌套深度 |
| `maxCertificates` | `32` | 张，单次验证证书总数 |
| `maxTrustRoots` | `32` | 张，信任根数量 |

### 2.6 状态枚举

```ts
export type VerificationStatus =
  'valid' | 'invalid' | 'unknown' | 'not-applicable' | 'unsupported';

export type ChainStatus =
  'valid' | 'invalid' | 'expired' | 'not-yet-valid' | 'untrusted' |
  'incomplete' | 'unsupported' | 'not-present' | 'unknown';

export type TimestampStatus = 'parsed-not-verified' | 'not-present' | 'parse-error';

export interface VerificationIssue {
  readonly code: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
  readonly path?: string;
}
```

`VerificationIssue` 是报告子项，不是抛出的 `CryptoError`。`message` 不含口令/私钥。

---

## 3. `inspect`

```ts
export function inspect(
  source: CryptoSource,
  options?: CryptoOptions,
): Promise<OfdInspection>;
```

### 3.1 返回结构

```ts
export interface OfdInspection {
  readonly encrypted: boolean;
  readonly packageSize: number;
  readonly entryCount: number;
  readonly ofdVersion?: string;
  readonly layers: readonly EncryptionLayerInfo[];
  readonly users: readonly EncryptionUserInfo[];
  readonly signatures: readonly SignatureEntrySummary[];
  readonly integrityPresent: boolean;
  readonly warnings: readonly CryptoWarning[];
}

export interface EncryptionLayerInfo {
  readonly layer: number;
  readonly id: string;
  readonly encryptDate?: string;
  readonly encryptScope?: string;
  readonly decryptSeedPath: string;
  readonly entriesMapPath: string;
  readonly users: readonly EncryptionUserInfo[];
}

export interface EncryptionUserInfo {
  readonly userName: string;
  readonly method: 'password' | 'certificate' | 'unknown';
  readonly certificate?: CertificateSummary;
}

export interface SignatureEntrySummary {
  readonly id: string;
  readonly type: string;
  readonly baseLoc: string;
  readonly signedValuePath?: string;
}
```

### 3.2 规则

- 无 `Encryptions.xml`：`encrypted=false`、`layers=[]`、`users=[]`；只有完整性元数据时 `integrityPresent` 仍可为 `true`；
- 每个 `EncryptInfo` 对应一个 `EncryptionLayerInfo`；缺省的 `DecryptSeedLoc`/`EntriesMapLoc` 按包根解析；
- `UserInfo` 有 `UserCert` → `method='certificate'`，无 → `'password'`；`EncryptCaseId` 不参与判定；
- 用户去重键：`(userName, method, 证书指纹)`；重复用户先产生 `W_CRYPTO_DUPLICATE_USER`，再保留一条；
- `signatures` 从可见的 `Signatures.xml` 读取摘要；非根清单的 `BaseLoc` 相对清单目录解析；不可读清单跳过，取消/超限仍抛出；
- `ofdVersion` 从可读的 `OFD.xml` 读取，不可读则省略；
- `integrityPresent`：同时存在 `OFDEntries.xml` 与 `signedvalue.dat`；
- 结构非法、超限、取消分别抛 `CRYPTO_INVALID_PACKAGE`/`CRYPTO_LIMIT_EXCEEDED`/`CRYPTO_ABORTED`。

`inspect` 不返回明文，不验证签名，不解密条目。

---

## 4. `openDecryptingContainer`

```ts
export function openDecryptingContainer(
  options: OpenDecryptingContainerOptions,
): Promise<DecryptingContainerResult>;

export interface OpenDecryptingContainerOptions extends CryptoOptions {
  readonly source: CryptoSource;
  readonly credentials?: CryptoCredential | readonly CryptoCredential[];
}
```

### 4.1 返回结构

```ts
export interface DecryptingContainerResult {
  readonly container: VirtualContainer;
  readonly inspection: OfdInspection;
  readonly plaintext: boolean;
  readonly layers: readonly DecryptionLayerSummary[];
  readonly warnings: readonly CryptoWarning[];
}

export interface DecryptionLayerSummary {
  readonly layer: number;
  readonly id: string;
  readonly user?: EncryptionUserInfo;
  readonly decryptedEntries: number;
  readonly removedMetadata: readonly string[];
  readonly entriesMapMode: 'encrypted' | 'plaintext';
}
```

`container` 是 engine 的 `VirtualContainer`：

- `encrypted === false`，`read()` 返回明文；
- `packageSize` 保留原始包大小；
- 所有权转移给调用方，**调用方必须 `close()`**；
- engine `OFDDocument.open({ container })` 只借用，不关闭。

### 4.2 行为与错误

| 场景 | 行为/错误 |
| --- | --- |
| 明文包 | 原样返回容器，`plaintext=true`、`layers=[]`；提供凭据 → `W_CRYPTO_CREDENTIAL_IGNORED` |
| 加密包无凭据 | `CRYPTO_CREDENTIALS_REQUIRED` |
| 用户名不匹配 | `CRYPTO_USER_NOT_FOUND` |
| 多候选且未指定用户名 | `CRYPTO_USER_AMBIGUOUS` |
| 口令错误 | `CRYPTO_WRONG_PASSWORD` |
| 私钥不匹配/无法解 FEK | `CRYPTO_PRIVATE_KEY_MISMATCH` |
| entriesmap 非法/缺失条目/未列 `.dat` | `CRYPTO_ENTRY_MAP_INVALID` |
| 超过 `maxDecryptLayers` | `CRYPTO_DECRYPT_LAYER_LIMIT` |
| 层循环/未取得进展 | `CRYPTO_LAYER_LOOP` |
| 取消 | `CRYPTO_ABORTED`；已构造的容器会关闭，不返回 |

支持多重加密：每层可包含多个 `EncryptInfo`，解密后若出现下一层 `Encryptions.xml` 会继续；最终清理 `Encryptions.xml`/`decryptseed.dat`/`entriesmap.dat` 并检查残留。

---

## 5. `verifyOfd`

```ts
export function verifyOfd(options: VerifyOfdOptions): Promise<VerificationReport>;

export interface VerifyOfdOptions extends CryptoOptions {
  readonly source?: CryptoSource;
  readonly container?: VirtualContainer;
  readonly credentials?: CryptoCredential | readonly CryptoCredential[];
  readonly roots?: readonly CertificateDer[];
  readonly signatureIds?: readonly string[];
}
```

### 5.1 参数约束

| 参数 | 约束 |
| --- | --- |
| `source` / `container` | 必须且只能提供一个，否则 `CRYPTO_INVALID_ARGUMENT` |
| `container` | 必须 `encrypted=false`；否则 `CRYPTO_CREDENTIALS_REQUIRED` |
| `credentials` | 仅加密 `source` 使用；明文 source 提供时 warning 后忽略 |
| `roots` | 省略/空数组 = 未配置；每项为一张证书 DER（`CertificateDer`）；非法 → `CRYPTO_TRUST_ROOT_INVALID`。PEM/Base64/CER 必须先用 `certificatesToDer` 转换 |
| `signatureIds` | 字符串数组；只验证匹配的签名 ID，不存在的 ID 不报错 |
| `signal` | 中止抛 `CRYPTO_ABORTED` |

加密 `source` 内部解密；验证结束后关闭内部临时容器。宿主的 `container` 不关闭。

### 5.2 `VerificationReport`

```ts
export interface VerificationReport {
  readonly overall: VerificationStatus;
  readonly package: PackageVerificationInfo;
  readonly decryption?: DecryptionReportInfo;
  readonly integrity: IntegrityVerification | null;
  readonly signatures: readonly SignatureVerification[];
  readonly rootsConfigured: boolean;
  readonly warnings: readonly CryptoWarning[];
  readonly startedAt: string;
  readonly durationMs: number;
}

export interface PackageVerificationInfo {
  readonly ofdVersion?: string;
  readonly encrypted: boolean;
  readonly decrypted: boolean;
  readonly packageSize: number;
  readonly entryCount: number;
  readonly signatureCount: number;
  readonly integrityPresent: boolean;
}

export interface DecryptionReportInfo {
  readonly layers: readonly DecryptionLayerSummary[];
  readonly plaintext: boolean;
}
```

- `package.encrypted` 表示原始包是否加密；`package.decrypted` 表示本次是否内部解密；
- `package.integrityPresent = integrity !== null`；
- `startedAt` 为 ISO 8601，`durationMs` 单位毫秒。

### 5.3 完整性 `IntegrityVerification`

```ts
export interface IntegrityVerification {
  readonly status: VerificationStatus;
  readonly entriesPath: string;
  readonly signedValuePath: string;
  readonly fileListCount: number;
  readonly actualFileCount: number;
  readonly missingFiles: readonly string[];
  readonly extraFiles: readonly string[];
  readonly authenticatedAttributes: boolean;
  readonly signature: SignatureMathResult;
  readonly certificate: CertificateChainVerification;
  readonly issues: readonly VerificationIssue[];
}
```

- 只有 `OFDEntries.xml` 与 `signedvalue.dat` 同时存在才产生对象；否则 `report.integrity === null`；
- `missingFiles`：清单有、包内无；`extraFiles`：包内有、清单未登记（夹带）；
- `status=valid` 要求签名数学验证、证书链、清单/摘要全部通过；
- 无根证书时链状态 `unknown`，整体不能为 `valid`；
- 未受保护不等于有效，调用方必须用 `package.integrityPresent` 区分。

### 5.4 单签名 `SignatureVerification`

```ts
export interface SignatureVerification {
  readonly id: string;
  readonly type: string;
  readonly version: SesVersion;
  readonly baseLoc: string;
  readonly signedValuePath?: string;
  readonly status: VerificationStatus;
  readonly signature: SignatureMathResult;
  readonly dataHash: DataHashVerification;
  readonly references: ReferenceCheckResult;
  readonly certificate: CertificateChainVerification;
  readonly seal?: SealVerification;
  readonly timestamp: TimestampParseResult;
  readonly issues: readonly VerificationIssue[];
}
```

| 子项 | 含义 |
| --- | --- |
| `version` | `v1`/`v4`/`v5`/`unknown` |
| `signature` | 对 `TBS_Sign` 原始 DER 的 SM3withSM2 结果；`sm2UserId` 记录实际值 |
| `dataHash` | `SM3(Signature.xml 原始字节)` 与 `TBS_Sign.dataHash` 比对 |
| `references` | `Reference@FileRef` 的 SM3 CheckValue：`missing`/`mismatch`/`unsupported` |
| `certificate` | 签名者证书链；状态见 5.5 |
| `seal` | 有 Seal 节点时的印章验证；无则省略 |
| `timestamp` | 只解析，不参与 `overall` |
| `issues` | 该签名的 error/warning 列表 |

子结果结构：

```ts
interface SignatureMathResult {
  readonly status: VerificationStatus;
  readonly algorithm?: string;   // 签名算法名称/OID
  readonly sm2UserId: string;    // 实际验签使用的 userId
}

interface DataHashVerification {
  readonly expected?: string;   // SignedValue.dataHash，小写 hex
  readonly actual?: string;     // SM3(Signature.xml)
  readonly status: VerificationStatus;
}

interface ReferenceCheckResult {
  readonly status: VerificationStatus;
  readonly total: number;
  readonly checked: number;
  readonly failures: readonly ReferenceFailure[];
}

interface ReferenceFailure {
  readonly fileRef: string;
  readonly reason: 'missing' | 'mismatch' | 'unsupported';
}
```

### 5.5 证书链 `CertificateChainVerification`

```ts
export interface CertificateChainVerification {
  readonly status: ChainStatus;
  readonly trustRootConfigured: boolean;
  readonly signer?: CertificateSummary;
  readonly trustAnchor?: CertificateSummary;
  readonly chain: readonly CertificateSummary[];
  readonly currentTime: string;
  readonly revocation: 'not-checked';
  readonly issues: readonly VerificationIssue[];
}
```

| `status` | 含义 |
| --- | --- |
| `valid` | 追到配置根，签名/有效期/KeyUsage 均满足 |
| `expired` / `not-yet-valid` | 链中任一证书超过 `now` |
| `untrusted` | 链可建但终点不在 roots |
| `incomplete` | 缺 issuer/中间证书（配置根后） |
| `invalid` | 证书签名/KeyUsage/结构失败 |
| `not-present` | 无签名者证书 |
| `unsupported` | 不支持的证书签名算法/结构 |
| `unknown` | 未配置 roots，且未发现明确错误 |

- 未配置 roots 时，`incomplete` 也按 `unknown` 聚合，不会误判为 invalid；
- 不检查 CRL/OCSP；
- 根证书按证书 SHA-256 指纹匹配（等价于 DER 内容一致），不用 subject 字符串匹配；
- 中间 CA 必须有 `BasicConstraints.cA=true`，KeyUsage 存在时含 `keyCertSign`；
- 叶证书 KeyUsage 存在时需含 `digitalSignature` 或 `nonRepudiation`；缺失只产生 `W_CRYPTO_KEY_USAGE_MISSING`。

### 5.6 印章 `SealVerification`

```ts
export interface SealVerification {
  readonly status: VerificationStatus;
  readonly version: SesVersion;
  readonly esId?: string;
  readonly name?: string;
  readonly eslPath?: string;
  readonly matchesSignedValue: boolean;
  readonly math: SignatureMathResult;
  readonly certificate: CertificateChainVerification;
  readonly timestamp: TimestampParseResult;
  readonly issues: readonly VerificationIssue[];
}
```

`matchesSignedValue` 只表示 `Seal.esl` 与 `TBS_Sign.eseal` DER 逐字节一致；印章有效性还取决于 `math` 与 `certificate`。

### 5.7 状态聚合

单个签名：

- 任一项 `invalid` → `invalid`；
- 否则任一项 `unknown` → `unknown`；
- 否则任一项 `unsupported` → `unsupported`；
- 否则 `valid`。

链状态到验证状态：`valid→valid`，`unknown→unknown`，`unsupported→unsupported`，其余（`expired`/`not-yet-valid`/`untrusted`/`incomplete`/`invalid`/`not-present`）→ `invalid`；未配置 roots 时 `incomplete` 保持 `unknown`。

整体 `overall`：

- 无完整性且无签名 → `not-applicable`；
- 任一项 `invalid` → `invalid`；
- 否则任一项 `unknown` → `unknown`；
- 否则任一项 `unsupported` → `unsupported`；
- 否则 `valid`。

时间戳状态**不参与** `overall`。验证失败不抛异常，写入 `issues`/`status`。

---

## 6. 解析 API

### 6.1 `parseSeal`

```ts
export function parseSeal(
  data: Uint8Array,
  options?: ParseOptions & { readonly maxCertificates?: number },
): ParsedSeal;
```

`options.maxCertificates` 是证书数量上限（单位张，默认 `maxCertificates` = 32）。该选项类型未从包根导出，直接传对象字面量即可。

支持：

- v1（GM/T 0031-2014）：`SEQUENCE { SES_SealInfo, SES_SignInfo }`；
- v4/v5（GB/T 38540-2020 / GM/T 0031-2025）：`SEQUENCE { SES_SealInfo, cert, signAlgID, signedValue, [0] timestamp }`。

```ts
export interface ParsedSeal {
  readonly version: SesVersion;
  readonly esId?: string;
  readonly name?: string;
  readonly typeCode?: number;
  readonly createDate?: string;
  readonly validStart?: string;
  readonly validEnd?: string;
  readonly makerCertificate?: CertificateSummary;
  readonly certificates?: readonly CertificateSummary[];
  readonly certificateDigests?: readonly string[];
  readonly picture?: SealPictureInfo;
  readonly hasSignature: boolean;
  readonly timestamp: TimestampParseResult;
  readonly warnings: readonly VerificationIssue[];
  readonly byteLength: number;
}
```

`SealPictureInfo`：`type`、`widthMm`、`heightMm`、`dataLength`（byte）、`data`（`Uint8Array`）。`version='unknown'` 仅用于报告兼容，解析失败会抛错。

错误：`CRYPTO_ASN1_INVALID`、`CRYPTO_UNSUPPORTED_SES_VERSION`、`CRYPTO_CERTIFICATE_INVALID`、`CRYPTO_LIMIT_EXCEEDED`。解析成功**不代表验签通过**。

### 6.2 `parseSignedValue`

```ts
export function parseSignedValue(
  data: Uint8Array,
  options?: ParseOptions,
): ParsedSignedValue;
```

```ts
export interface ParsedSignedValue {
  readonly version: SesVersion;
  readonly certificate?: CertificateSummary;
  readonly signatureAlgorithm?: string;
  readonly signedAt?: string;
  readonly dataHash: string; // 小写十六进制
  readonly seal?: ParsedSeal;
  readonly timestamp: TimestampParseResult;
  readonly byteLength: number;
}
```

- v1 的 `signedAt` 是 `timeInfo` 自由文本；v4/v5 为 ISO 8601；
- `seal` 是内嵌 SESeal 的公开解析；
- 不验签、不查链；`dataHash` 非空。

### 6.3 `parseTimestamp`

```ts
export function parseTimestamp(
  data: Uint8Array,
  options?: TimestampParseOptions,
): TimestampParseResult;

export interface TimestampParseOptions extends ParseOptions {
  readonly signatureValue?: Uint8Array;
}
```

```ts
export interface TimestampParseResult {
  readonly status: 'parsed-not-verified' | 'not-present' | 'parse-error';
  readonly tokenPresent: boolean;
  readonly tokenLength: number;
  readonly version?: number;
  readonly policy?: string;
  readonly serialNumber?: string;
  readonly genTime?: string;
  readonly hashAlgorithm?: string;
  readonly messageImprint?: string;
  readonly nonce?: string;
  readonly tsa?: CertificateSummary;
  readonly messageImprintMatchesSignature?: boolean;
  readonly parseError?: VerificationIssue;
  readonly note: '已解析，未验证';
}
```

- 接受 RFC 3161 `TimeStampToken`/`TimeStampResp` 与 GM/T 0033 签章时间戳；
- 空输入 → `not-present`；
- 解析失败不抛异常，返回 `parse-error` 与 `parseError`；
- 可解析时固定 `parsed-not-verified`，`note` 固定；
- 不验证 TSA 签名、ESSCertID、策略链、TSA 证书有效期；
- `signatureValue` 只用于计算 `SM3(signatureValue)` 与 `messageImprint` 的结构一致性。

### 6.4 `parseSignaturesXml` / `parseSignatureXml`

```ts
export function parseSignaturesXml(data: Uint8Array, options?: ParseOptions): SignaturesXml;
export function parseSignatureXml(data: Uint8Array, options?: ParseOptions): SignatureXml;
```

`SignaturesXml`：

```ts
interface SignatureRecord {
  readonly id?: string;
  readonly type?: string;
  readonly baseLoc: string; // 缺失/空时为空字符串
}
interface SignaturesXml {
  readonly signatures: readonly SignatureRecord[];
  readonly maxSignId?: string;
}
```

`SignatureXml`：

```ts
interface SignatureXml {
  readonly signedValueLoc: string;
  readonly sealLoc?: string;
  readonly signatureMethod?: string;
  readonly signatureDateTime?: string;
  readonly provider?: { providerName?: string; company?: string; version?: string };
  readonly checkMethod?: string;
  readonly references: readonly SignatureReferenceXml[];
  readonly stampAnnots: readonly StampAnnotInfo[];
  readonly raw: Uint8Array;
}
interface SignatureReferenceXml {
  readonly fileRef: string;
  readonly checkValue: string;
}
interface StampAnnotInfo {
  readonly id?: string;
  readonly boundary?: string;
  readonly pageRef?: string;
}
```

只做结构解析；`Signatures.xml` 单条记录缺/空 `BaseLoc` 保留空字符串，由验证层记 `SIGNATURE_BASELOC_INVALID`，不会中断其他签名。

### 6.5 `parseOfdEntriesXml`

```ts
export function parseOfdEntriesXml(
  data: Uint8Array,
  options?: ParseOptions,
): OfdEntriesInfo;

export interface OfdEntriesInfo {
  readonly id?: string;
  readonly creatorName?: string;
  readonly version?: string;
  readonly creationDate?: string;
  readonly signedValueLoc?: string;
  readonly files: readonly string[];
  readonly raw: Uint8Array;
}
```

兼容 `FileList/File@FileLoc` 与 ofdrw 2.x `Entries/Entry@Path`；`files` 为规范化包内路径（无前导 `/`）。

---

## 7. 证书 API

### 7.1 入口格式转换 `certificatesToDer`

公共证书接口只收 DER；PEM/Base64/CER 与多证书拆分统一由本工具完成。

```ts
export interface CertificatesToDerOptions {
  /** 原始输入与单张输出 DER 上限，默认 maxAsn1Bytes，单位 byte。 */
  readonly maxBytes?: number;
  /** 输出证书张数上限，默认 maxCertificates，单位张。 */
  readonly maxCertificates?: number;
}

export function certificatesToDer(
  input: ArrayBuffer | Uint8Array | string,
  options?: CertificatesToDerOptions,
): readonly CertificateDer[];
```

| 输入/行为 | 说明 |
| --- | --- |
| PEM | 接受 `CERTIFICATE`、`X509 CERTIFICATE`、`TRUSTED CERTIFICATE`；支持单/多证书、CRLF、BOM 与块外文字；`TRUSTED CERTIFICATE` 只取首个证书 TLV |
| DER/CER | 按 DER 处理，支持多张证书直接拼接；每张必须是完整 X.509 `SEQUENCE` |
| Base64 | 字符串或可打印字节；忽略 ASCII 空白，单行/折行均可 |
| 输出 | 按输入顺序返回逐张 DER；每项为独立副本，调用方拥有所有权；工具不按指纹去重 |
| 上限 | 原始输入与每张输出 DER 均不超过 `maxBytes`；输出张数不超过 `maxCertificates` |
| 职责边界 | 只做格式识别、拆分与 X.509 最小合法性校验；不建信任链、不输出摘要、不判定 `valid/untrusted/unknown` |

错误码：

| 场景 | 错误码 |
| --- | --- |
| 入参类型不是 ArrayBuffer/Uint8Array/string，或 `maxBytes`/`maxCertificates` 非正整数 | `CRYPTO_INVALID_ARGUMENT` |
| 空输入、非法 PEM/Base64/DER、PEM 中没有证书块 | `CRYPTO_CERTIFICATE_INVALID` |
| 原始输入或输出证书超过 `maxBytes`，或张数超过 `maxCertificates` | `CRYPTO_LIMIT_EXCEEDED` |

### 7.2 DER 解析与加载

```ts
export function parseX509Certificate(
  der: Uint8Array,
  options?: DerParseOptions,
): X509Certificate;

export function parseCertificates(
  input: CertificateDer,
  options?: CertificateParseOptions,
): readonly X509Certificate[];

export function parseCertificate(
  input: CertificateDer,
  options?: CertificateParseOptions,
): X509Certificate;

export function loadCertificates(
  inputs: readonly CertificateDer[],
  options?: CertificateLoadOptions,
): Promise<readonly X509Certificate[]>;

export function loadCertificate(
  input: CertificateDer,
  options?: CertificateLoadOptions,
): Promise<X509Certificate>;
```

- `parseCertificates` 可接收拼接的多张证书 DER；`parseCertificate` 要求恰好一张，尾随字节视为非法。
- `loadCertificates` 的数组每项必须是一张证书 DER；PEM/Base64/CER/多证书先经 `certificatesToDer` 拆分。
- 核心对非 DER 的运行时拒绝：字符串、ArrayBuffer 或其他非 `Uint8Array` 对象 → `CRYPTO_INVALID_ARGUMENT`；PEM 字节等非法内容 → `CRYPTO_CERTIFICATE_INVALID`。

`CertificateParseOptions` 继承 `DerParseOptions`，额外 `maxCertificates`。`CertificateLoadOptions`：

```ts
interface CertificateLoadOptions {
  readonly maxBytes?: number;       // 默认 maxAsn1Bytes，单位 byte
  readonly maxCertificates?: number; // 默认 maxCertificates
  readonly signal?: AbortSignal;
  readonly onWarning?: CryptoWarningHandler;
  readonly skipInvalid?: boolean;   // 默认 false：抛错；true：warning 后跳过
  readonly invalidCode?: CryptoErrorCode; // 默认 CRYPTO_CERTIFICATE_INVALID
}
```

### 7.3 摘要与所有权

```ts
export function checkCertificateValidity(
  certificate: X509Certificate,
  now?: Date,
): CertificateValidity;

export function toCertificateSummary(certificate: X509Certificate): CertificateSummary;
```

`CertificateSummary` 字段：`subject`、`issuer`、`serialNumber`、`notBefore`、`notAfter`（ISO 8601）、`fingerprintSha256`、`publicKeyAlgorithm?`、`signatureAlgorithm?`、`keyUsage?`、`isCA`。

`X509Certificate` 保留完整 DER、TBS、DN 属性（含 `subjectDer`/`issuerDer` 原始 Name DER，供链匹配）、有效期、公钥/签名算法、KeyUsage、EKU、SKI/AKI、扩展与 SHA-256 指纹；调用方可用 `toCertificateSummary` 得到不含原文的展示对象。DER 输入与 `certificatesToDer` 输出均归调用方所有，crypto 不修改、不跨调用持有。

---

## 8. SM 基础 API

### 8.1 SM3

```ts
export function sm3Digest(data: Uint8Array): Uint8Array; // 32 byte
export function sm3Hex(data: Uint8Array): string;        // 64 字符小写 hex
export function sm3OfText(text: string): Uint8Array;     // UTF-8
```

### 8.2 SM4-CBC

```ts
export const SM4_BLOCK_SIZE = 16;

export interface Sm4CbcOptions {
  readonly padding?: 'pkcs7' | 'none'; // 默认 pkcs7
}

export function sm4EncryptCbc(
  plaintext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  options?: Sm4CbcOptions,
): Uint8Array;

export function sm4DecryptCbc(
  ciphertext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  options?: Sm4CbcOptions,
): Uint8Array;
```

- `key`/`iv` 必须各 16 byte；
- 解密默认严格校验 PKCS#7，不静默接受非法填充；
- `padding:'none'` 时密文长度必须是 16 的倍数。

### 8.3 SM2

```ts
export interface Sm2SignOptions {
  readonly userId?: string; // 默认 DEFAULT_SM2_USER_ID
}

export interface Sm2DecryptOptions {
  readonly c1Prefix?: 'auto' | 'present' | 'absent'; // 默认 auto
}

export const DEFAULT_SM2_USER_ID = '1234567812345678';

export function normalizeSm2PrivateKey(privateKey: Uint8Array | string): string;
export function normalizeSm2PublicKey(publicKey: Uint8Array | string): string;
export function sm2GetPublicKey(privateKey: Uint8Array | string): Uint8Array;
export function sm2Sign(
  message: Uint8Array,
  privateKey: Uint8Array | string,
  options?: Sm2SignOptions,
): Uint8Array;
export function sm2Verify(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array | string,
  options?: Sm2SignOptions,
): boolean;
export function sm2Encrypt(plaintext: Uint8Array, publicKey: Uint8Array | string): Uint8Array;
export function sm2Decrypt(
  ciphertext: Uint8Array,
  privateKey: Uint8Array | string,
  options?: Sm2DecryptOptions,
): Uint8Array;
export function isValidSm2PublicKey(publicKey: Uint8Array): boolean;
```

- 签名输出 DER `SEQUENCE { r, s }`；验签对原始消息字节，不做二次序列化；
- `sm2Encrypt` 输出 C1C3C2（X||Y||C3||C2），**不含** `04` 前缀；`sm2Decrypt.c1Prefix` 控制输入前缀；
- 空明文不支持；
- 私钥/公钥会校验长度、标量与曲线；`sm2Verify` 对格式/内容错误返回 `false`，公钥/消息参数非法才抛错。

### 8.4 KDF

```ts
export function derivePasswordKey(password: string): Uint8Array; // OFD 口令 KDF（SM3）
export function kdfSm3(z: Uint8Array, klen: number): Uint8Array; // GB/T 32918.3，klen 单位 byte
```

### 8.5 私钥解析

```ts
export interface Sm2PrivateKey {
  readonly format: 'pkcs8' | 'sec1';
  readonly privateKey: Uint8Array; // 32 byte
  readonly publicKey: Uint8Array;  // 65 byte 04||X||Y
  readonly embeddedPublicKey?: Uint8Array;
}

export interface Sm2PrivateKeyParseOptions extends ParseOptions {
  readonly onWarning?: CryptoWarningHandler;
}

export function parseSm2PrivateKey(
  input: Sm2PrivateKeyInput,
  options?: Sm2PrivateKeyParseOptions,
): Sm2PrivateKey;
```

同步解析支持未加密 PKCS#8/SEC1；加密 PKCS#8 的 PBES2 解密由 `openDecryptingContainer` 的凭据流程完成（异步、需要 WebCrypto）。`parseSm2PrivateKey` 对加密 PKCS#8 抛 `CRYPTO_PRIVATE_KEY_PASSPHRASE_REQUIRED` 或 `CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION`。

---

## 9. ASN.1 / DER / OID

### 9.1 DER

```ts
export class DerNode {
  readonly tag: DerTag;
  readonly raw: Uint8Array;
  readonly value: Uint8Array;
  // 以及 children/offset/构造/读取辅助方法
}

export function parseDer(bytes: Uint8Array, options?: DerParseOptions): DerNode;
export function parseDerAll(bytes: Uint8Array, options?: DerParseOptions): readonly DerNode[];

export function decodeOid(value: Uint8Array, offset?: number): string;
export function encodeDerLength(length: number): Uint8Array;
export function encodeDerTlv(tag: DerTag, value: Uint8Array): Uint8Array;
export function derSequence(...items: readonly Uint8Array[]): Uint8Array;
export function derSet(...items: readonly Uint8Array[]): Uint8Array;
export function derInteger(value: bigint | Uint8Array): Uint8Array;
export function derOctetString(value: Uint8Array): Uint8Array;
export function derBitString(value: Uint8Array, unusedBits?: number): Uint8Array;
export function derOid(oid: string): Uint8Array;
export function derNull(): Uint8Array;
export function derBoolean(value: boolean): Uint8Array;
export function derUtf8String(text: string): Uint8Array;
export function derContext(number: number, value: Uint8Array, constructed?: boolean): Uint8Array;
export function derUtcTime(date: Date): Uint8Array;
export function derGeneralizedTime(date: Date): Uint8Array;
export function compareBytes(a: Uint8Array, b: Uint8Array): number;
```

`DerParseOptions`：`maxBytes`（默认 `maxAsn1Bytes`）、`maxDepth`（默认 `maxAsn1Depth`）。严格 DER：拒绝 BER 不定长、非最小长度/OID 编码；`node.raw` 保留原始 TLV，验签必须使用原始字节。

### 9.2 SM2Cipher

```ts
export interface Sm2Cipher {
  // C1/C3/C2 字段，见类型定义
}

export function parseSm2Cipher(der: Uint8Array, options?: DerParseOptions): Sm2Cipher;
export function encodeSm2Cipher(cipher: Sm2Cipher): Uint8Array;
export function sm2CipherToC1C3C2(cipher: Sm2Cipher): Uint8Array;
export function c1c3c2ToSm2Cipher(
  bytes: Uint8Array,
  options?: C1C3C2ParseOptions,
): Sm2Cipher;
```

### 9.3 OID

导出常用 OID 常量（运行时字符串）：

`OID_SM3`、`OID_SM3_WITH_SM2`、`OID_SM2_SIGN`、`OID_SM2_CURVE`、`OID_EC_PUBLIC_KEY`、`OID_SM4`、`OID_SM4_CBC`、`OID_GM_DATA`、`OID_GM_SIGNED_DATA`、`OID_PKCS7_DATA`、`OID_PKCS7_SIGNED_DATA`、`OID_CT_TST_INFO`、`OID_PKCS9_CONTENT_TYPE`、`OID_PKCS9_MESSAGE_DIGEST`、`OID_PKCS9_SIGNING_TIME`、`OID_PBES2`、`OID_PBKDF2`、`OID_HMAC_WITH_SHA1`、`OID_HMAC_WITH_SHA256`、`OID_AES_128_CBC`、`OID_AES_192_CBC`、`OID_AES_256_CBC`、`OID_BASIC_CONSTRAINTS`、`OID_KEY_USAGE`、`OID_SUBJECT_KEY_IDENTIFIER`、`OID_AUTHORITY_KEY_IDENTIFIER`、`OID_EXTENDED_KEY_USAGE`、`OID_SUBJECT_ALT_NAME`、`OID_COMMON_NAME`、`OID_COUNTRY_NAME`、`OID_LOCALITY_NAME`、`OID_STATE_OR_PROVINCE_NAME`、`OID_ORGANIZATION_NAME`、`OID_ORGANIZATIONAL_UNIT_NAME`、`OID_EMAIL_ADDRESS`、`OID_DOMAIN_COMPONENT`。

```ts
export function oidName(oid: string): string;
export function dnLabel(oid: string): string;
export function isSm2SignatureAlgorithm(oid: string): boolean;
export function isSignedDataContentType(oid: string): boolean;
```

### 9.4 曲线

```ts
export const SM2_CURVE: Readonly<Sm2CurveParams>; // p/a/b/n/gx/gy，无符号大整数
export function isSm2PointOnCurve(x: bigint, y: bigint): boolean;
export function isSm2PrivateKeyScalar(d: bigint): boolean;
```

---

## 10. 字节、编码与 warning 工具

```ts
export function toUint8Array(value: ArrayBuffer | Uint8Array): Uint8Array;
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array;
export function copyBytes(bytes: Uint8Array): Uint8Array;
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean;
export function toHex(bytes: Uint8Array): string;
export function fromHex(hex: string): Uint8Array;
export function toBase64(bytes: Uint8Array): string;
export function tryFromBase64(text: string): Uint8Array | null;
export function fromBase64(text: string): Uint8Array;
export function utf8Encode(text: string): Uint8Array;
export function utf8Decode(bytes: Uint8Array): string;
export function zeroize(bytes: Uint8Array): void;
export function leftPadBytes(bytes: Uint8Array, length: number): Uint8Array;
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean;
export function sha256(data: Uint8Array): Uint8Array;
export function sha256Hex(data: Uint8Array): string;
export function looksLikePem(text: string): boolean;
export function parsePemBlocks(text: string): PemBlock[];
export function throwIfAborted(signal?: AbortSignal): void;
export function requireString(value: unknown, name: string): string;
export function requirePositiveInteger(value: unknown, name: string, max?: number): number;
export function requireWithinBytes(length: number, maxBytes: number, what: string): void;
export function resolveCryptoLimits(partial?: Partial<CryptoLimits>): CryptoLimits;
export function resolveCryptoOptions(options?: CryptoOptions): ResolvedCryptoOptions;
export function resolveParseOptions(options?: ParseOptions, limits?: CryptoLimits): {
  maxBytes: number;
  maxDepth: number;
};
export function resolveSm2UserId(userId?: string): string;
export function readCryptoSource(
  source: CryptoSource,
  options?: ReadCryptoSourceOptions,
): Promise<Uint8Array>;

export interface WarningCollector {
  readonly warnings: readonly CryptoWarning[];
  emit(warning: CryptoWarning): void;
  clear(): void;
}
export function createWarningCollector(
  handler?: CryptoWarningHandler,
): WarningCollector;
```

warning 工具按 `code` 去重；`CryptoWarning` 含 `code`、`message`、可选 `path`。

---

## 11. 错误

### 11.1 `CryptoError`

```ts
export class CryptoError extends Error {
  readonly code: CryptoErrorCode;
  readonly cause?: unknown;
}

export function isCryptoError(value: unknown): value is CryptoError;
export function toCryptoError(
  error: unknown,
  code?: CryptoErrorCode,
  message?: string,
): CryptoError;
```

`message` 只包含路径/用户名/算法/OID 等诊断信息；不包含口令、私钥、PEM 或密钥字节。

### 11.2 错误码表

| 码 | 典型场景 |
| --- | --- |
| `CRYPTO_INVALID_ARGUMENT` | 参数形状/数量/类型非法 |
| `CRYPTO_CREDENTIALS_REQUIRED` | 加密包无凭据；`verifyOfd` 收到加密容器 |
| `CRYPTO_SOURCE_UNSUPPORTED` | 输入源类型/环境不支持；URL 读取失败 |
| `CRYPTO_LIMIT_EXCEEDED` | 包/条目/ASN.1/证书/层数超过上限 |
| `CRYPTO_ABORTED` | `AbortSignal` 中止 |
| `CRYPTO_INVALID_PACKAGE` | ZIP/XML/OFD 包结构非法 |
| `CRYPTO_NOT_ENCRYPTED` | 保留的“需要加密包但输入不是”码；当前 `openDecryptingContainer` 对明文包走透传 |
| `CRYPTO_UNSUPPORTED_ENCRYPTION` | 加密算法/结构不支持 |
| `CRYPTO_ENTRY_MAP_INVALID` | entriesmap 映射/条目/解密失败 |
| `CRYPTO_DECRYPT_FAILED` | 多凭据全部失败或解密失败 |
| `CRYPTO_DECRYPT_LAYER_LIMIT` | 超过 `maxDecryptLayers` |
| `CRYPTO_LAYER_LOOP` | 加密层循环/未取得进展 |
| `CRYPTO_USER_NOT_FOUND` | 凭据找不到用户 |
| `CRYPTO_USER_AMBIGUOUS` | 多候选且未指定用户名 |
| `CRYPTO_WRONG_PASSWORD` | 口令错误 |
| `CRYPTO_PRIVATE_KEY_INVALID` | 私钥结构/曲线/Base64 非法 |
| `CRYPTO_PRIVATE_KEY_PASSPHRASE_REQUIRED` | 加密 PKCS#8 缺少口令 |
| `CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION` | PBES2 算法不支持或 WebCrypto 不可用 |
| `CRYPTO_PRIVATE_KEY_MISMATCH` | 私钥与用户证书不匹配/无法解 FEK |
| `CRYPTO_ASN1_INVALID` | ASN.1/DER 结构非法 |
| `CRYPTO_UNSUPPORTED_SES_VERSION` | SES/eSeal 版本不是 v1/v4/v5 |
| `CRYPTO_UNSUPPORTED_ALGORITHM` | 签名/摘要/证书算法不支持 |
| `CRYPTO_CERTIFICATE_INVALID` | 证书 DER 解析或入口格式转换失败（非法 PEM/Base64/DER、非 X.509） |
| `CRYPTO_TRUST_ROOT_INVALID` | 信任根输入非法 |
| `CRYPTO_INTEGRITY_INVALID` | 完整性无法产出报告 |
| `CRYPTO_SIGNATURE_INVALID` | 签名入口无法产出报告 |
| `CRYPTO_TIMESTAMP_PARSE` | 时间戳解析入口错误（通常报告内处理） |

`CRYPTO_INTEGRITY_INVALID`/`CRYPTO_SIGNATURE_INVALID`/`CRYPTO_TIMESTAMP_PARSE` 通常不会从 `verifyOfd` 抛出，而是写入报告 issue；不要依赖捕获它们判断验证失败。

### 11.3 warning 码表

| 码 | 触发场景 |
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

---

## 12. 与 engine 的 `VirtualContainer` 集成

`openDecryptingContainer` 返回 engine 公共接口：

```ts
interface VirtualContainer {
  readonly packageSize: number;
  readonly encrypted: boolean; // crypto 结果固定 false
  list(): readonly VirtualFileMeta[];
  has(path: string): boolean;
  stat(path: string): VirtualFileMeta | undefined;
  read(path: string, options?: VirtualReadOptions): Promise<Uint8Array>;
  close(): Promise<void>;
}
```

规则：

- `read()` 返回明文；`packageSize` 保留原始加密源大小；
- `list()` 按 path 升序、不含目录；
- `close()` 幂等；关闭后 `read`/`list` 抛 engine `OFD_CLOSED`；
- `OFDDocument.open({ container })` 中 engine **借用**容器，不关闭；调用方在 `doc.close()` 后自行关闭；
- `OFDDocument.open` 遇到 `container.encrypted=true` 抛 `OFD_ENCRYPTED`，必须先用 crypto 解密。

`CryptoSource.kind='byte-source'` 的所有权：

- `ByteSource` 归调用方所有，crypto 创建隔离视图时只转发 `size`/`read`/`ready`，**不转发 `close`**；
- `inspect`/`verifyOfd` 关闭自己打开的容器，但不会关闭调用方 `ByteSource`；
- `openDecryptingContainer` 对明文包返回 source-backed 容器，关闭该容器也不会关闭原 `ByteSource`；
- 调用方应在读取/验证/解密结束后自行关闭文件句柄或字节源。

---

## 13. 导出索引

### 13.1 核心函数

`inspect`、`openDecryptingContainer`、`verifyOfd`、`parseSeal`、`parseSignedValue`、`parseTimestamp`、`parseSignaturesXml`、`parseSignatureXml`、`parseOfdEntriesXml`。

### 13.2 证书

`certificatesToDer`、`parseX509Certificate`、`parseCertificate`、`parseCertificates`、`loadCertificate`、`loadCertificates`、`checkCertificateValidity`、`toCertificateSummary`。

### 13.3 SM

`SM4_BLOCK_SIZE`、`sm4EncryptCbc`、`sm4DecryptCbc`、`sm3Digest`、`sm3Hex`、`sm3OfText`、`kdfSm3`、`derivePasswordKey`、`DEFAULT_SM2_USER_ID`、`normalizeSm2PrivateKey`、`normalizeSm2PublicKey`、`sm2GetPublicKey`、`sm2Sign`、`sm2Verify`、`sm2Encrypt`、`sm2Decrypt`、`isValidSm2PublicKey`、`SM2_CURVE`、`isSm2PointOnCurve`、`isSm2PrivateKeyScalar`、`parseSm2PrivateKey`。

### 13.4 ASN.1 / DER / OID

`DER_TAG`、`DerNode`、`parseDer`、`parseDerAll`、`decodeOid`、`encodeDerLength`、`encodeDerTlv`、`derSequence`、`derSet`、`derInteger`、`derOctetString`、`derBitString`、`derOid`、`derNull`、`derBoolean`、`derUtf8String`、`derContext`、`derUtcTime`、`derGeneralizedTime`、`compareBytes`、`parseSm2Cipher`、`encodeSm2Cipher`、`sm2CipherToC1C3C2`、`c1c3c2ToSm2Cipher`、`oidName`、`dnLabel`、`isSm2SignatureAlgorithm`、`isSignedDataContentType`。

### 13.5 工具、错误、warning

`CryptoError`、`isCryptoError`、`toCryptoError`、`CRYPTO_ERROR_CODES`、`CRYPTO_WARNING_CODES`、`DEFAULT_CRYPTO_LIMITS`、`createWarningCollector`、`VERSION`、`getVersion`、`toUint8Array`、`concatBytes`、`copyBytes`、`bytesEqual`、`constantTimeEqual`、`toHex`、`fromHex`、`toBase64`、`tryFromBase64`、`fromBase64`、`utf8Encode`、`utf8Decode`、`zeroize`、`leftPadBytes`、`sha256`、`sha256Hex`、`looksLikePem`、`parsePemBlocks`、`throwIfAborted`、`requireString`、`requirePositiveInteger`、`requireWithinBytes`、`resolveCryptoLimits`、`resolveCryptoOptions`、`resolveParseOptions`、`resolveSm2UserId`、`readCryptoSource`。

### 13.6 OID 常量

`OID_SM3`、`OID_SM3_WITH_SM2`、`OID_SM2_SIGN`、`OID_SM2_CURVE`、`OID_EC_PUBLIC_KEY`、`OID_SM4`、`OID_SM4_CBC`、`OID_GM_DATA`、`OID_GM_SIGNED_DATA`、`OID_PKCS7_DATA`、`OID_PKCS7_SIGNED_DATA`、`OID_CT_TST_INFO`、`OID_PKCS9_CONTENT_TYPE`、`OID_PKCS9_MESSAGE_DIGEST`、`OID_PKCS9_SIGNING_TIME`、`OID_PBES2`、`OID_PBKDF2`、`OID_HMAC_WITH_SHA1`、`OID_HMAC_WITH_SHA256`、`OID_AES_128_CBC`、`OID_AES_192_CBC`、`OID_AES_256_CBC`、`OID_BASIC_CONSTRAINTS`、`OID_KEY_USAGE`、`OID_SUBJECT_KEY_IDENTIFIER`、`OID_AUTHORITY_KEY_IDENTIFIER`、`OID_EXTENDED_KEY_USAGE`、`OID_SUBJECT_ALT_NAME`、`OID_COMMON_NAME`、`OID_COUNTRY_NAME`、`OID_LOCALITY_NAME`、`OID_STATE_OR_PROVINCE_NAME`、`OID_ORGANIZATION_NAME`、`OID_ORGANIZATIONAL_UNIT_NAME`、`OID_EMAIL_ADDRESS`、`OID_DOMAIN_COMPONENT`。

### 13.7 公共类型索引

`CryptoSource`、`ByteSource`、`CryptoCredential`、`PasswordCredential`、`PrivateKeyCredential`、`Sm2PrivateKeyInput`、`CertificateDer`、`CertificatesToDerOptions`、`CertificateSummary`、`CertificateKeyUsage`、`CertificateValidity`、`CryptoOptions`、`ParseOptions`、`CryptoLimits`、`CryptoWarning`、`CryptoWarningCode`、`CryptoWarningHandler`、`CryptoErrorCode`、`CryptoErrorOptions`、`OfdInspection`、`EncryptionLayerInfo`、`EncryptionUserInfo`、`SignatureEntrySummary`、`DecryptingContainerResult`、`DecryptionLayerSummary`、`OpenDecryptingContainerOptions`、`VerificationReport`、`PackageVerificationInfo`、`DecryptionReportInfo`、`IntegrityVerification`、`SignatureVerification`、`SealVerification`、`CertificateChainVerification`、`DataHashVerification`、`ReferenceCheckResult`、`ReferenceFailure`、`ReferenceFailureReason`、`SignatureMathResult`、`VerifyOfdOptions`、`TimestampParseResult`、`TimestampParseOptions`、`TimestampStatus`、`ParsedSeal`、`SealPictureInfo`、`ParsedSignedValue`、`SesVersion`、`PemBlock`、`SignaturesXml`、`SignatureRecord`、`SignatureXml`、`SignatureReferenceXml`、`StampAnnotInfo`、`OfdEntriesInfo`、`X509Certificate`、`X509Extension`、`DistinguishedNameAttribute`、`CertificateParseOptions`、`CertificateLoadOptions`、`DerNode`、`DerTag`、`DerClass`、`DerBitString`、`DerParseOptions`、`Sm2Cipher`、`C1C3C2ParseOptions`、`Sm2CurveParams`、`Sm2PrivateKey`、`Sm2PrivateKeyParseOptions`、`Sm2SignOptions`、`Sm2DecryptOptions`、`Sm4CbcOptions`、`Sm4Padding`、`VerificationStatus`、`ChainStatus`、`VerificationIssue`、`VerificationIssueSeverity`、`WarningCollector`、`ReadCryptoSourceOptions`、`ResolvedCryptoOptions`。

---

## 14. 变更记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 0.1.0 | 2026-10-23 | 新增 `VERSION` 常量与 `getVersion()`，供 CLI/UI 与宿主在故障排查时读取密码能力包版本；版本内置于产物，不依赖 `package.json` |
| 0.1.0 | 2026-10-23 | 首次公开 API 文档：inspect/解密/verify/parse、SM/ASN.1/证书、错误与 warning、VirtualContainer 集成 |
| 0.1.0 | 2026-10-23 | 证书输入统一为 DER：新增 `CertificateDer`/`certificatesToDer`；roots/load/parse 只收 DER |
| 0.1.0 | 2026-10-23 | 补充 `byte-source` 输入与所有权规则；同步 `parseSeal` 选项写法（`SealParseOptions` 未从包根导出）；更新导出索引 |
