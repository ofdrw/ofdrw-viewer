# @ofdrw/ofdrw-viewer-crypto 公开 API

> 接入流程、平台差异、安全边界与示例见 [SKILL.md](./SKILL.md)。

## 1. 输入源、凭据与选项

### 1.1 `CryptoSource`

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
| `arraybuffer` | `data` | 内存字节；可能直接使用输入视图，调用期间调用方不得修改 |
| `blob` | `blob` | 浏览器 `Blob`/`File`；Node 22 需全局 `Blob` |
| `url` | `url`、`headers` | `fetch` 读取；按 `maxSourceBytes` 流式累计整包，缺 `Content-Length` 时依赖 reader |
| `byte-source` | `source` | engine `ByteSource` 随机读；Node 宿主处理本地文件首选；**调用方拥有并关闭**，crypto 只读、不 close |

`ByteSource` 由 engine 导出（`import type { ByteSource } from '@ofdrw/ofdrw-viewer-engine'`），要求 `size` 为非负安全整数（单位 byte）、`read(offset, length)` 返回 `Uint8Array`。crypto 创建隔离视图时只转发 `size`/`read`/`ready`，**不转发 `close`**。

`readCryptoSource(source, options?)` 把任意输入源整体读成 `Uint8Array`，业务入口不调用它读取整个包：

```ts
export interface ReadCryptoSourceOptions {
  readonly maxBytes?: number; // 默认 DEFAULT_CRYPTO_LIMITS.maxSourceBytes，单位 byte
  readonly signal?: AbortSignal;
}

export function readCryptoSource(
  source: CryptoSource,
  options?: ReadCryptoSourceOptions,
): Promise<Uint8Array>;
```

- `arraybuffer` 返回输入视图（不复制）；`blob` 调 `arrayBuffer()`；`url` 流式读取，无 `Content-Length` 时按 reader 分块计数，超限立即 `cancel` 并抛 `CRYPTO_LIMIT_EXCEEDED`；无法流式读取且缺少可信 `Content-Length` 时拒绝；
- `byte-source` 先按 `source.size` 预检上限，再按每块 1 MiB 读取，不调用调用方 `close`；
- 先检查取消信号；读取中取消抛 `CRYPTO_ABORTED`；
- 错误：`CRYPTO_SOURCE_UNSUPPORTED`、`CRYPTO_LIMIT_EXCEEDED`、`CRYPTO_ABORTED`、`CRYPTO_INVALID_ARGUMENT`。

### 1.2 凭据

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

- `pem`/`der` 必须且只能提供一个；PEM 支持 PKCS#8、SEC1，DER 支持 PKCS#8；
- `passphrase` 仅用于加密 PKCS#8（PEM/DER 均可）；未加密私钥传 `passphrase` 只产生 `W_CRYPTO_CREDENTIAL_IGNORED`；
- `userName` 省略时仅在凭据类型匹配的候选用户唯一时自动选择；
- 私钥必须位于 `sm2p256v1` 曲线；
- 加密 PKCS#8 支持 `PBES2 + PBKDF2(HMAC-SHA1/SHA256) + AES-128/192/256-CBC`；其他 PBES2 算法抛 `CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION`，缺少 `globalThis.crypto.subtle` 同样报不支持；
- 凭据只在本次调用内使用，不进入报告/warning/错误消息；
- 单凭据保留 `CRYPTO_USER_NOT_FOUND`/`CRYPTO_USER_AMBIGUOUS`/`CRYPTO_WRONG_PASSWORD`/`CRYPTO_PRIVATE_KEY_MISMATCH` 等可区分错误；多凭据逐个尝试，至少一个凭据命中用户但全部无法恢复文件密钥时抛 `CRYPTO_DECRYPT_FAILED`，私钥结构/算法/超限错误直接抛出。

### 1.3 证书输入

```ts
/** X.509 证书 DER 字节；公共证书接口只接收该类型。 */
export type CertificateDer = Uint8Array;
```

- `parseCertificate`、`parseCertificates`、`loadCertificate`、`loadCertificates` 与 `VerifyOfdOptions.roots` 都只接收 DER；核心不识别 PEM/Base64/CER，也不读取 URL/path/filePath；
- PEM（单/多证书）、CER、拼接 DER、Base64 必须先经 [`certificatesToDer`](#61-入口格式转换-certificatestoder) 转为逐张 DER；
- DER 字节归调用方所有；crypto 不修改，也不跨调用持有，调用期间调用方不得变更同一 `Uint8Array`。

### 1.4 `CryptoOptions` 与 `ParseOptions`

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
| `limits` | `DEFAULT_CRYPTO_LIMITS` | 浅合并的 `CryptoLimits`；字段必须为正整数 |
| `signal` | 无 | 中止抛 `CRYPTO_ABORTED` |
| `onWarning` | 无（不打印） | warning 回调；回调异常被吞掉，不改变结果 |
| `sm2UserId` | `'1234567812345678'` | SM2 签名 userId；UTF-8 长度 ≤ 8191 byte；不从证书推导 |
| `now` | `new Date()` | 证书有效期判断时间 |
| `ParseOptions.maxBytes` | `limits.maxAsn1Bytes` | 输入字节上限，单位 byte |
| `ParseOptions.maxDepth` | `limits.maxAsn1Depth` | ASN.1/XML 嵌套深度上限，单位层 |

### 1.5 `CryptoLimits`

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
| `maxAsn1Bytes` | `16 * 1024 * 1024` | byte，单 ASN.1/XML 结构 |
| `maxAsn1Depth` | `64` | 层，ASN.1/XML 嵌套深度 |
| `maxCertificates` | `32` | 张，单次验证证书总数 |
| `maxTrustRoots` | `32` | 张，信任根数量 |

### 1.6 状态、warning 与问题类型

```ts
export type VerificationStatus =
  'valid' | 'invalid' | 'unknown' | 'not-applicable' | 'unsupported';

export type ChainStatus =
  'valid' | 'invalid' | 'expired' | 'not-yet-valid' | 'untrusted' |
  'incomplete' | 'unsupported' | 'not-present' | 'unknown';

export type TimestampStatus = 'parsed-not-verified' | 'not-present' | 'parse-error';

/** SignatureVerification.signingTime 的来源。 */
export type SigningTimeSource = 'time-info' | 'timestamp' | 'signature-xml';

export type VerificationIssueSeverity = 'error' | 'warning';

export interface VerificationIssue {
  readonly code: string;
  readonly message: string;
  readonly severity: VerificationIssueSeverity;
  readonly path?: string;
}

export type CryptoWarningCode =
  | 'W_CRYPTO_DUPLICATE_USER'
  | 'W_CRYPTO_CREDENTIAL_IGNORED'
  | 'W_CRYPTO_ENTRIES_MAP_PLAINTEXT'
  | 'W_CRYPTO_ENTRY_MAP_INVALID'
  | 'W_CRYPTO_KEY_USAGE_MISSING'
  | 'W_CRYPTO_MULTI_LAYER'
  | 'W_CRYPTO_TIMESTAMP_PARSE'
  | 'W_CRYPTO_TIMESTAMP_IMPRINT_MISMATCH'
  | 'W_CRYPTO_UNKNOWN_SES_VERSION'
  | 'W_CRYPTO_REFERENCE_UNSUPPORTED'
  | 'W_CRYPTO_SEAL_PICTURE_INVALID'
  | 'W_CRYPTO_TRUST_UNKNOWN'
  | 'W_CRYPTO_CERT_SOURCE_UNSUPPORTED';

export interface CryptoWarning {
  readonly code: CryptoWarningCode;
  readonly message: string;
  readonly path?: string;
}

export type CryptoWarningHandler = (warning: CryptoWarning) => void;
```

`VerificationIssue` 是报告子项，不是抛出的 `CryptoError`；`message` 不含口令/私钥。warning 的 `message` 同样不含敏感材料。

## 2. `inspect`

```ts
export function inspect(
  source: CryptoSource,
  options?: CryptoOptions,
): Promise<OfdInspection>;
```

### 2.1 返回结构

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

### 2.2 规则

- 无 `Encryptions.xml`：`encrypted=false`、`layers=[]`、`users=[]`；只有完整性元数据时 `integrityPresent` 仍可为 `true`；
- 每个 `EncryptInfo` 对应一个 `EncryptionLayerInfo`，`layer` 从 0 开始；`id` 缺失时使用 `layer-${index+1}`（首个加密层为 `layer-1`）；缺省的 `DecryptSeedLoc`/`EntriesMapLoc` 按包根解析；缺 `decryptseed` 抛 `CRYPTO_INVALID_PACKAGE`；
- `UserInfo` 有 `UserCert` → `method='certificate'`，无 → `'password'`；`EncryptCaseId` 不参与判定；
- 同一用户名重复时最多产生一条 `W_CRYPTO_DUPLICATE_USER`（warning 按 `code/path/message` 去重），随后按 `(userName, method, 证书指纹)` 去重；同名不同证书仍保留多条用户记录；
- `signatures` 读取包内所有 `Signatures.xml`；非根清单的 `BaseLoc` 相对清单目录解析；`signedValuePath` 仅在签名目录旁的 `SignedValue.dat` 存在时给出；不可读清单跳过，但取消/超限仍抛出；条目缺 `ID`/`Type`/`BaseLoc` 或 `BaseLoc` 非法时抛 `CRYPTO_INVALID_PACKAGE`；
- `ofdVersion` 从可读的 `OFD.xml` 读取，不可读则省略；
- `integrityPresent`：同时存在 `OFDEntries.xml` 与 `signedvalue.dat`；
- `entryCount` 为文件条目数（不含目录），`packageSize` 为原始包字节数；
- 结构非法、超限、取消分别抛 `CRYPTO_INVALID_PACKAGE`/`CRYPTO_LIMIT_EXCEEDED`/`CRYPTO_ABORTED`。

`inspect` 不返回明文，不验证签名，不解密条目。

## 3. `openDecryptingContainer`

```ts
export interface OpenDecryptingContainerOptions extends CryptoOptions {
  readonly source: CryptoSource;
  readonly credentials?: CryptoCredential | readonly CryptoCredential[];
}

export function openDecryptingContainer(
  options: OpenDecryptingContainerOptions,
): Promise<DecryptingContainerResult>;
```

### 3.1 返回结构

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
- `packageSize` 保留原始包大小（单位 byte）；
- 所有权转移给调用方；拿到 `result` 后，无论后续渲染/读取成功、失败或取消，调用方都必须 `close()`；`openDecryptingContainer` 失败/取消时不返回容器；
- engine `OFDDocument.open({ container })` 只借用，不关闭。

`inspection` 混合原始包与明文视图：`encrypted`/`packageSize`/`layers`/`users` 来自原始包；`signatures`/`integrityPresent`/`entryCount`/`ofdVersion` 来自解密后的明文。`layers` 是逐层解密摘要（命中用户、解密文件数、删除的加密元数据路径、entriesmap 形态）。

### 3.2 行为与错误

| 场景 | 行为/错误 |
| --- | --- |
| 明文包 | 原样返回容器（`arraybuffer`/`blob`/`byte-source` 为 source-backed，`url` 为已读取字节的内存容器），`plaintext=true`、`layers=[]`；传入凭据 → `W_CRYPTO_CREDENTIAL_IGNORED` |
| 加密包无凭据 | `CRYPTO_CREDENTIALS_REQUIRED` |
| 用户名不匹配 | `CRYPTO_USER_NOT_FOUND` |
| 多候选且未指定用户名 | `CRYPTO_USER_AMBIGUOUS` |
| 口令错误 | `CRYPTO_WRONG_PASSWORD` |
| 私钥不匹配/无法解 FEK | `CRYPTO_PRIVATE_KEY_MISMATCH` |
| 多凭据至少命中用户但全部失败 | `CRYPTO_DECRYPT_FAILED` |
| entriesmap 非法/缺失条目/输出路径重复/未列 `.dat` | `CRYPTO_ENTRY_MAP_INVALID` |
| entriesmap 是明文 XML | `W_CRYPTO_ENTRIES_MAP_PLAINTEXT`，继续解密 |
| entriesmap 有可容忍异常 | `W_CRYPTO_ENTRY_MAP_INVALID`，继续解密 |
| 超过 `maxDecryptLayers` | `CRYPTO_DECRYPT_LAYER_LIMIT` |
| 层循环/未取得进展/解密后仍有 `Encryptions.xml` | `CRYPTO_LAYER_LOOP` |
| 解密后仍有加密元数据 | `CRYPTO_ENTRY_MAP_INVALID` |
| 解压总量超过 `maxTotalDecryptedBytes` | `CRYPTO_LIMIT_EXCEEDED` |
| 取消 | `CRYPTO_ABORTED`；已构造的容器关闭，不返回 |

支持多重加密：每层可包含多个 `EncryptInfo`，解密后若出现下一层 `Encryptions.xml` 会继续；最终清理 `Encryptions.xml`/`decryptseed.dat`/`entriesmap.dat` 等元数据并检查残留。层数 > 1 时产生 `W_CRYPTO_MULTI_LAYER`。明文包返回的 source-backed 容器关闭时不会关闭调用方 `ByteSource`（`url` 输入不涉及调用方字节源）；加密包的结果为内存容器，内部源容器在返回前关闭。

## 4. `verifyOfd`

```ts
export interface VerifyOfdOptions extends CryptoOptions {
  readonly source?: CryptoSource;
  readonly container?: VirtualContainer;
  readonly credentials?: CryptoCredential | readonly CryptoCredential[];
  readonly roots?: readonly CertificateDer[];
  readonly signatureIds?: readonly string[];
}

export function verifyOfd(options: VerifyOfdOptions): Promise<VerificationReport>;
```

### 4.1 参数约束

| 参数 | 约束 |
| --- | --- |
| `source` / `container` | 必须且只能提供一个，否则 `CRYPTO_INVALID_ARGUMENT` |
| `container` | 必须 `encrypted=false`；否则 `CRYPTO_CREDENTIALS_REQUIRED` |
| `credentials` | 仅加密 `source` 使用；明文 source 传入时产生 `W_CRYPTO_CREDENTIAL_IGNORED` 并忽略 |
| `roots` | 省略/空数组 = 未配置；每项为一张证书 DER；非法 → `CRYPTO_TRUST_ROOT_INVALID`。PEM/Base64/CER 必须先用 `certificatesToDer` 转换 |
| `signatureIds` | 字符串数组；只验证匹配的签名 ID，不存在的 ID 不报错 |
| `signal` | 中止抛 `CRYPTO_ABORTED` |

加密 `source` 内部调用 `openDecryptingContainer`，验证结束后关闭内部临时容器。宿主的 `container` 不关闭。根证书按 `maxTrustRoots`/`maxCertificates` 限制加载，并按 SHA-256 指纹去重。

### 4.2 `VerificationReport`

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

- `package.encrypted` 表示原始包是否加密；`package.decrypted` 表示本次是否内部解密；明文容器时 `decryption` 省略；
- `package.integrityPresent = integrity !== null`；清单不可解析时也可能为 `true`，有效性必须看 `integrity.status`；
- `rootsConfigured` 表示本次是否配置了非空 `roots`；
- `startedAt` 为 ISO 8601，`durationMs` 单位毫秒。

### 4.3 完整性 `IntegrityVerification`

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

- `report.integrity === null` 表示没有可校验的完整性对象：未检测到 `OFDEntries.xml`，或清单可解析但其签名值缺失/不可读；
- `OFDEntries.xml` 存在但不可解析、或 `SignedValueLoc` 路径非法时仍返回 `IntegrityVerification`，`status='invalid'` 并在 `issues` 说明原因；
- `inspect().integrityPresent` 只看两个文件是否同时存在；`report.package.integrityPresent = integrity !== null`，存在报告对象不等于有效；
- `missingFiles`：清单有、包内无；`extraFiles`：包内有、清单未登记（夹带）；`actualFileCount` 不含 `OFDEntries.xml` 与 `signedvalue.dat`；
- `status=valid` 要求 SignedData 签名数学验证与文件清单/摘要比对全部通过；证书链状态独立展示，不影响 `status`；
- 证书链 `expired`/`not-yet-valid`/`untrusted`/`incomplete`/`unknown`/`unsupported` 时，只要签名与清单通过，`integrity.status` 仍为 `valid`；无根证书时链为 `unknown`，但 `overall` 仍可为 `valid`；
- 未受保护不等于有效：用 `report.integrity === null` 判断未受保护，用 `integrity.status` 判断有效性，不要只看 `package.integrityPresent`。

### 4.4 单签名 `SignatureVerification`

签名清单优先使用 `OFD.xml` 的 `DocBody/Signatures` 声明路径，未声明时查找包内 `Signatures.xml`（支持非根目录）。

```ts
export interface SignatureVerification {
  readonly id: string;
  readonly type: string;
  readonly version: SesVersion;
  readonly baseLoc: string;
  readonly signedValuePath?: string;
  readonly status: VerificationStatus;
  readonly signingTime?: string;
  readonly signingTimeSource?: SigningTimeSource;
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
| `signingTime` / `signingTimeSource` | 签发时间展示值及来源；优先级 `timeInfo` > `timestamp.genTime` > `SignatureDateTime`，无值时省略 |
| `certificate` | 签名者证书链；状态见 4.5；参与展示但不参与 `status`/`overall` |
| `seal` | 有 Seal 节点时的印章验证；无则省略 |
| `timestamp` | 只解析，不参与 `overall` |
| `issues` | 该签名的 error/warning 列表 |

`signingTimeSource` 取值：`time-info`（`TBS_Sign.timeInfo`，v4/v5 为 ISO 8601，v1 原样文本）、`timestamp`（时间戳 `TSTInfo.genTime`，ISO 8601）、`signature-xml`（`SignatureDateTime` 原文）。`signingTime` 只是展示值，不代表可信时间；时间戳仍只解析、不验证。当前支持的 SES v1/v4/v5 中，v4/v5 的 `timeInfo` 为必需字段，v1 不含时间戳，因此实际只会产生 `time-info` 或 `signature-xml`；`timestamp` 分支保留给未来允许缺省 `timeInfo` 的结构变体，当前版本不可达。

子结果结构：

```ts
export interface SignatureMathResult {
  readonly status: VerificationStatus;
  readonly algorithm?: string;   // 签名算法名称/OID
  readonly sm2UserId: string;    // 实际验签使用的 userId
}

export interface DataHashVerification {
  readonly expected?: string;   // TBS_Sign.dataHash，小写 hex
  readonly actual?: string;     // SM3(Signature.xml)
  readonly status: VerificationStatus;
}

export interface ReferenceCheckResult {
  readonly status: VerificationStatus;
  readonly total: number;
  readonly checked: number;
  readonly failures: readonly ReferenceFailure[];
}

export type ReferenceFailureReason = 'missing' | 'mismatch' | 'unsupported';

export interface ReferenceFailure {
  readonly fileRef: string;
  readonly reason: ReferenceFailureReason;
}
```

### 4.5 证书链 `CertificateChainVerification`

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
| `incomplete` | 缺 issuer/中间证书；未配置 roots 时缺 issuer 不记 `incomplete`，链状态为 `unknown` |
| `invalid` | 证书签名/KeyUsage/结构失败 |
| `not-present` | 无签名者证书 |
| `unsupported` | 不支持的证书签名算法/结构 |
| `unknown` | 未配置 roots，且未发现明确错误 |

- 未配置 roots 时链状态通常为 `unknown`；`expired`/`not-yet-valid`/`invalid`/`unsupported` 等明细仍按实际报告；
- 证书链状态**不参与**签名、印章、完整性与 `overall` 的通过/失败判定；`untrusted`/`expired`/`not-yet-valid`/`incomplete`/`unknown`/`unsupported` 只作为独立明细展示。缺少签名者证书会直接导致签名数学验签失败，因此仍为 `invalid`；
- 不检查 CRL/OCSP，`revocation` 固定 `'not-checked'`；
- 信任锚按证书 SHA-256 指纹匹配（等价于 DER 内容一致）；中间证书按 subject/issuer DN 定位后仍须通过签名验证；
- 中间 CA 必须有 `BasicConstraints.cA=true`，KeyUsage 存在时含 `keyCertSign`；pathLenConstraint 不满足时链失败；
- 叶证书 KeyUsage 存在时需含 `digitalSignature` 或 `nonRepudiation`；缺失只产生 `W_CRYPTO_KEY_USAGE_MISSING`；
- 未配置 roots 且链状态为 `unknown`/`incomplete`/`untrusted` 时产生 `W_CRYPTO_TRUST_UNKNOWN`。

### 4.6 印章 `SealVerification`

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

`matchesSignedValue` 只表示 `Seal.esl` 与 `TBS_Sign.eseal` DER 逐字节一致；印章状态只由 `matchesSignedValue` 与印章签名数学 `math` 决定，制章者证书链 `certificate` 仅作为独立明细展示。印章解析 warning（图片缺失/损坏等）同时写入 `issues` 并产生 `W_CRYPTO_SEAL_PICTURE_INVALID`。

### 4.7 状态聚合

单个签名：

- 任一项 `invalid` → `invalid`；
- 否则任一项 `unknown` → `unknown`；
- 否则任一项 `unsupported` → `unsupported`；
- 否则 `valid`。

参与聚合的子项包括签名数学验证、`dataHash`、References、签名属性（`propertyInfo`）与（若存在）印章。References 为 `unsupported` 时按 `invalid` 聚合（无法证明未篡改）。证书链状态不参与聚合，只作为 `certificate` 明细展示；缺少签名者证书会让签名数学验签失败，仍按 `invalid` 处理。

印章状态由 `matchesSignedValue` 与印章签名数学决定，制章者证书链同样不参与。

整体 `overall`：

- 无完整性且无签名 → `not-applicable`；
- 任一项 `invalid` → `invalid`；
- 否则任一项 `unknown` → `unknown`；
- 否则任一项 `unsupported` → `unsupported`；
- 否则 `valid`。

证书链状态不参与 `overall`：未配置 roots、链过期、未生效、`untrusted`、`incomplete`、`unknown` 或 `unsupported` 时，只要签名数学、dataHash、References、防夹带完整性与印章结构/数学通过，`overall` 仍可为 `valid`；相关 warning 会保留。

时间戳状态**不参与** `overall`。验证失败不抛异常，写入 `issues`/`status`；`verifyOfd` 只在入口参数、根证书、凭据、包结构、限额、取消等错误时抛 `CryptoError`。

## 5. 解析 API

### 5.1 `parseSeal`

```ts
export function parseSeal(
  data: Uint8Array,
  options?: SealParseOptions,
): ParsedSeal;

export interface SealParseOptions extends ParseOptions {
  readonly maxCertificates?: number; // 单位张，默认 DEFAULT_CRYPTO_LIMITS.maxCertificates
}
```

`SealParseOptions` 未从包根导出，直接传对象字面量即可。

支持 v1（GM/T 0031-2014）与 v4/v5（GB/T 38540-2020 / GM/T 0031-2025）的 SESeal 布局。只解析结构，不验签、不查链。

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

export interface SealPictureInfo {
  readonly type: string;      // 例如 PNG/GIF/SVG
  readonly widthMm: number;   // 单位毫米
  readonly heightMm: number;  // 单位毫米
  readonly dataLength: number; // 单位 byte
  readonly data: Uint8Array;
}
```

- `parseSeal` 成功时 `version` 为 `v1`/`v4`/`v5`；`unknown` 只出现在验证报告，解析失败会抛 `CRYPTO_UNSUPPORTED_SES_VERSION`；
- 图片缺失/损坏只写入 `warnings`（`SEAL_PICTURE_MISSING`/`SEAL_PICTURE_INVALID`），不影响印章结构；
- 错误：`CRYPTO_ASN1_INVALID`、`CRYPTO_UNSUPPORTED_SES_VERSION`、`CRYPTO_CERTIFICATE_INVALID`、`CRYPTO_LIMIT_EXCEEDED`、`CRYPTO_INVALID_ARGUMENT`。解析成功**不代表验签通过**。

### 5.2 `parseSignedValue`

```ts
export function parseSignedValue(
  data: Uint8Array,
  options?: ParseOptions,
): ParsedSignedValue;

export interface ParsedSignedValue {
  readonly version: SesVersion;
  readonly certificate?: CertificateSummary;
  /** 签章者证书 DER；调用方拥有，可用于下载/展示。 */
  readonly certificateDer?: Uint8Array;
  readonly signatureAlgorithm?: string;
  readonly signedAt?: string;
  readonly dataHash: string; // 小写十六进制
  readonly seal?: ParsedSeal;
  readonly timestamp: TimestampParseResult;
  readonly byteLength: number;
}
```

- 支持 SES v1/v4/v5；v1 的 `signedAt` 是 `timeInfo` 自由文本，v4/v5 为 ISO 8601；
- `certificateDer` 是签章者证书的完整 X.509 DER：v1 取 `TBS_Sign.cert`，v4/v5 取顶层 `SES_Signature.cert`；不含 PEM、私钥或口令；返回独立副本，调用方拥有；
- `seal` 是内嵌 SESeal 的公开解析；
- 不验签、不查链；`dataHash` 非空，仅解析不比对；
- 错误：`CRYPTO_ASN1_INVALID`、`CRYPTO_UNSUPPORTED_SES_VERSION`、`CRYPTO_CERTIFICATE_INVALID`、`CRYPTO_LIMIT_EXCEEDED`。

### 5.3 `parseTimestamp`

```ts
export interface TimestampParseOptions extends ParseOptions {
  readonly signatureValue?: Uint8Array;
}

export function parseTimestamp(
  data: Uint8Array,
  options?: TimestampParseOptions,
): TimestampParseResult;

export interface TimestampParseResult {
  readonly status: 'parsed-not-verified' | 'not-present' | 'parse-error';
  readonly tokenPresent: boolean;
  readonly tokenLength: number; // 单位 byte
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
- 空输入 → `not-present`；解析失败不抛异常，返回 `parse-error` 与 `parseError`；
- 可解析时固定 `parsed-not-verified`，`note` 固定；
- 不验证 TSA 签名、ESSCertID、策略链、TSA 证书有效期；
- `signatureValue` 只用于计算 `SM3(signatureValue)` 与 `messageImprint` 的结构一致性；
- 输入超过 `maxBytes` 返回 `parse-error`；`options` 本身非法仍抛 `CRYPTO_INVALID_ARGUMENT`。

### 5.4 `parseSignaturesXml` / `parseSignatureXml`

```ts
export function parseSignaturesXml(data: Uint8Array, options?: ParseOptions): SignaturesXml;
export function parseSignatureXml(data: Uint8Array, options?: ParseOptions): SignatureXml;
```

```ts
export interface SignatureRecord {
  readonly id?: string;
  readonly type?: string;
  readonly baseLoc: string; // 缺失/空时为空字符串
}

export interface SignaturesXml {
  readonly signatures: readonly SignatureRecord[];
  readonly maxSignId?: string;
}

export interface SignatureReferenceXml {
  readonly fileRef: string;
  readonly checkValue: string;
}

export interface StampAnnotInfo {
  readonly id?: string;
  readonly boundary?: string;
  readonly pageRef?: string;
}

export interface SignatureXml {
  readonly signedValueLoc: string;
  readonly sealLoc?: string;
  readonly signatureMethod?: string;
  readonly signatureDateTime?: string; // yyyy-MM-dd HH:mm:ss
  readonly provider?: { providerName?: string; company?: string; version?: string };
  readonly checkMethod?: string;
  readonly references: readonly SignatureReferenceXml[];
  readonly stampAnnots: readonly StampAnnotInfo[];
  readonly raw: Uint8Array;
}
```

只做结构解析：`Signatures.xml` 单条记录缺/空 `BaseLoc` 保留空字符串，由验证层记 `SIGNATURE_BASELOC_INVALID`，不会中断其他签名。XML 非法、根元素不可识别或缺少必需字段时抛 `CRYPTO_INVALID_PACKAGE`。

### 5.5 `parseOfdEntriesXml`

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

兼容 `FileList/File@FileLoc` 与 ofdrw 2.x `Entries/Entry@Path`；`files` 为规范化包内路径（无前导 `/`）。XML 非法或根元素不可识别时抛 `CRYPTO_INVALID_PACKAGE`。

## 6. 证书 API

### 6.1 入口格式转换 `certificatesToDer`

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
| PEM | 接受 `CERTIFICATE`、`X509 CERTIFICATE`、`TRUSTED CERTIFICATE`；支持单/多证书、CRLF、BOM 与块外文字；有证书块时忽略其他 PEM 块；`TRUSTED CERTIFICATE` 只取首个证书 TLV |
| DER/CER | 按 DER 处理，支持多张证书直接拼接；每张必须是完整 X.509 `SEQUENCE` |
| Base64 | 字符串或可打印字节；忽略 ASCII 空白，单行/折行均可 |
| 输出 | 按输入顺序返回逐张 DER；每项为独立副本，调用方拥有所有权；不按指纹去重 |
| 上限 | 原始输入与每张输出 DER 均不超过 `maxBytes`；输出张数不超过 `maxCertificates` |
| 职责边界 | 只做格式识别、拆分与 X.509 最小合法性校验；不建信任链、不输出摘要、不判定 `valid/untrusted/unknown` |

错误码：

| 场景 | 错误码 |
| --- | --- |
| 入参类型不是 ArrayBuffer/Uint8Array/string，或 `maxBytes`/`maxCertificates` 非正整数 | `CRYPTO_INVALID_ARGUMENT` |
| 空输入、非法 PEM/Base64/DER、PEM 中没有证书块 | `CRYPTO_CERTIFICATE_INVALID` |
| 原始输入或输出证书超过 `maxBytes`，或张数超过 `maxCertificates` | `CRYPTO_LIMIT_EXCEEDED` |

### 6.2 X.509 解析

```ts
export interface DistinguishedNameAttribute {
  readonly oid: string;
  readonly label: string;
  readonly value: string;
}

export interface X509Extension {
  readonly oid: string;
  readonly critical: boolean;
  readonly value: Uint8Array;
  readonly raw: Uint8Array;
}

export interface X509Certificate {
  readonly der: Uint8Array;
  readonly tbsDer: Uint8Array;
  readonly version: number;              // 1..3
  readonly serialNumber: string;         // 小写十六进制
  readonly subject: string;
  readonly issuer: string;
  readonly subjectAttributes: readonly DistinguishedNameAttribute[];
  readonly issuerAttributes: readonly DistinguishedNameAttribute[];
  readonly subjectDer: Uint8Array;
  readonly issuerDer: Uint8Array;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly notBeforeISO: string;
  readonly notAfterISO: string;
  readonly publicKeyAlgorithm: string;
  readonly publicKeyAlgorithmName: string;
  readonly curveOid?: string;
  readonly publicKey: Uint8Array;        // 通常 65 byte，04||X||Y
  readonly signatureAlgorithm: string;
  readonly signatureAlgorithmName: string;
  readonly signature: Uint8Array;
  readonly isCA: boolean;
  readonly pathLenConstraint?: number;
  readonly keyUsage?: readonly CertificateKeyUsage[];
  readonly extendedKeyUsage?: readonly string[];
  readonly subjectKeyIdentifier?: string;
  readonly authorityKeyIdentifier?: string;
  readonly extensions: readonly X509Extension[];
  readonly fingerprintSha256: string;
}

export type CertificateValidity = 'valid' | 'expired' | 'not-yet-valid';

export function parseX509Certificate(
  der: Uint8Array,
  options?: DerParseOptions,
): X509Certificate;

export function checkCertificateValidity(
  certificate: X509Certificate,
  now?: Date,
): CertificateValidity;
```

- 只接收 DER；不接收 PEM，由 `certificatesToDer` 前置转换；
- 边界包含 `notBefore`/`notAfter`：`notBefore <= now <= notAfter` 为 `valid`；
- `now` 默认 `new Date()`，非法 Date 抛 `CRYPTO_INVALID_ARGUMENT`；
- 错误：`CRYPTO_ASN1_INVALID`、`CRYPTO_CERTIFICATE_INVALID`、`CRYPTO_LIMIT_EXCEEDED`。

### 6.3 解析与加载

```ts
export interface CertificateParseOptions extends DerParseOptions {
  readonly maxCertificates?: number; // 默认 maxCertificates，单位张
}

export function parseCertificates(
  input: CertificateDer,
  options?: CertificateParseOptions,
): readonly X509Certificate[];

export function parseCertificate(
  input: CertificateDer,
  options?: CertificateParseOptions,
): X509Certificate;

export interface CertificateLoadOptions {
  readonly maxBytes?: number;         // 默认 maxAsn1Bytes，单位 byte
  readonly maxCertificates?: number;  // 默认 maxCertificates
  readonly signal?: AbortSignal;
  readonly onWarning?: CryptoWarningHandler;
  readonly skipInvalid?: boolean;     // 默认 false：抛错；true：warning 后跳过
  readonly invalidCode?: CryptoErrorCode; // 默认 CRYPTO_CERTIFICATE_INVALID
}

export function loadCertificates(
  inputs: readonly CertificateDer[],
  options?: CertificateLoadOptions,
): Promise<readonly X509Certificate[]>;

export function loadCertificate(
  input: CertificateDer,
  options?: CertificateLoadOptions,
): Promise<X509Certificate>;
```

- `parseCertificates` 可接收拼接的多张证书 DER；`parseCertificate` 要求恰好一张，尾随字节视为非法；
- `loadCertificates` 的数组每项必须是一张证书 DER；按输入顺序返回，重复证书按 SHA-256 指纹去重；
- 核心对非 DER 的运行时拒绝：字符串、ArrayBuffer 或其他非 `Uint8Array` 对象 → `CRYPTO_INVALID_ARGUMENT`；PEM 字节等非法内容 → `CRYPTO_CERTIFICATE_INVALID`（或 `invalidCode`）；
- `skipInvalid=true` 时非法证书项被跳过并产生 `W_CRYPTO_CERT_SOURCE_UNSUPPORTED`；`loadCertificate` 没有可用证书时抛错；
- 错误：`CRYPTO_CERTIFICATE_INVALID`（或 `invalidCode`）、`CRYPTO_LIMIT_EXCEEDED`、`CRYPTO_ABORTED`、`CRYPTO_INVALID_ARGUMENT`。

### 6.4 证书摘要

```ts
export type CertificateKeyUsage =
  'digitalSignature' | 'nonRepudiation' | 'keyEncipherment' | 'dataEncipherment' |
  'keyAgreement' | 'keyCertSign' | 'cRLSign' | 'encipherOnly' | 'decipherOnly';

export interface CertificateSummary {
  readonly subject: string;
  readonly issuer: string;
  readonly serialNumber: string;       // 小写十六进制（无前导零）
  readonly notBefore: string;          // ISO 8601
  readonly notAfter: string;           // ISO 8601
  readonly fingerprintSha256: string;  // 小写十六进制
  readonly publicKeyAlgorithm?: string;
  readonly signatureAlgorithm?: string;
  readonly keyUsage?: readonly CertificateKeyUsage[];
  readonly isCA: boolean;
}

export function toCertificateSummary(certificate: X509Certificate): CertificateSummary;
```

摘要不含证书 PEM/公钥原文；时间统一 ISO 8601。

## 7. SM 基础 API

### 7.1 SM3

```ts
export function sm3Digest(data: Uint8Array): Uint8Array; // 32 byte
export function sm3Hex(data: Uint8Array): string;        // 64 字符小写 hex
export function sm3OfText(text: string): Uint8Array;     // UTF-8
```

### 7.2 SM4-CBC

```ts
export const SM4_BLOCK_SIZE = 16;

export type Sm4Padding = 'pkcs7' | 'none';

export interface Sm4CbcOptions {
  readonly padding?: Sm4Padding; // 默认 pkcs7
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
- 密文长度必须是 16 的倍数；解密默认严格校验 PKCS#7，不静默接受非法填充；`padding:'none'` 时不做去填充；
- 参数/密钥/IV 非法抛 `CRYPTO_INVALID_ARGUMENT`；密文长度/填充非法抛 `CRYPTO_DECRYPT_FAILED`。

### 7.3 SM2

```ts
export const DEFAULT_SM2_USER_ID = '1234567812345678';

export interface Sm2SignOptions {
  readonly userId?: string; // 默认 DEFAULT_SM2_USER_ID
}

export interface Sm2DecryptOptions {
  readonly c1Prefix?: 'auto' | 'present' | 'absent'; // 默认 auto
}

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
- `sm2Encrypt` 输出 C1C3C2（X||Y||C3||C2），**不含** `04` 前缀；`sm2Decrypt` 默认 `c1Prefix='auto'`，带/不带 `04` 前缀的密文都可解，需要固定格式时显式传 `'present'`/`'absent'`；
- 空明文不支持；私钥/公钥会校验长度、标量与曲线；
- `sm2Verify` 对签名格式/内容错误返回 `false`，公钥/消息参数非法才抛 `CRYPTO_INVALID_ARGUMENT`；
- `sm2Decrypt` 密文/私钥不匹配或 C3 校验失败抛 `CRYPTO_DECRYPT_FAILED`；
- `normalizeSm2PrivateKey` 返回 64 字符小写十六进制；`normalizeSm2PublicKey` 返回 130 字符 `04||X||Y` 十六进制。

### 7.4 KDF

```ts
export function kdfSm3(z: Uint8Array, klen: number): Uint8Array;
export function derivePasswordKey(password: string): Uint8Array;
```

- `kdfSm3` 按 GB/T 32918.3 派生，`klen` 单位 byte，范围 1..4096；派生结果全 0 时按标准重取一次，仍全 0 抛 `CRYPTO_CREDENTIALS_REQUIRED`；
- `derivePasswordKey` 是 OFD 口令 KDF，口令按 UTF-8 编码、不做 Unicode 归一化，返回 16 byte KEK；空口令抛 `CRYPTO_CREDENTIALS_REQUIRED`。

### 7.5 私钥解析

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

同步解析支持未加密 PKCS#8 PEM/DER 与 SEC1 PEM（SEC1 DER 不在同步入口支持）；加密 PKCS#8 的 PBES2 解密由 `openDecryptingContainer` 的凭据流程完成（异步、需要 WebCrypto）。`parseSm2PrivateKey` 对加密 PKCS#8 抛 `CRYPTO_PRIVATE_KEY_PASSPHRASE_REQUIRED` 或 `CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION`；未加密私钥传 `passphrase` 产生 `W_CRYPTO_CREDENTIAL_IGNORED`。错误还包括 `CRYPTO_PRIVATE_KEY_INVALID`、`CRYPTO_INVALID_ARGUMENT`。

## 8. ASN.1 / DER / OID

### 8.1 DER

```ts
export interface DerParseOptions {
  readonly maxBytes?: number;   // 默认 maxAsn1Bytes，单位 byte
  readonly maxDepth?: number;   // 默认 maxAsn1Depth，单位层
  readonly maxNodes?: number;   // 默认按 maxBytes 推导（1,024..65,536），单位个
}

export type DerClass = 0 | 1 | 2 | 3;

export interface DerTag {
  readonly cls: DerClass;
  readonly constructed: boolean;
  readonly number: number;
}

export const DER_TAG: Readonly<{
  BOOLEAN: 1; INTEGER: 2; BIT_STRING: 3; OCTET_STRING: 4; NULL: 5;
  OBJECT_IDENTIFIER: 6; UTF8_STRING: 12; SEQUENCE: 16; SET: 17;
  PRINTABLE_STRING: 19; TELETEX_STRING: 20; IA5_STRING: 22;
  UTC_TIME: 23; GENERALIZED_TIME: 24; BMP_STRING: 30;
}>;

export interface DerBitString {
  readonly unusedBits: number; // 0..7
  readonly bytes: Uint8Array;
}

export class DerNode {
  readonly tag: DerTag;
  readonly raw: Uint8Array;            // 完整 TLV
  readonly value: Uint8Array;          // value 部分
  readonly children: readonly DerNode[];
  readonly offset: number;             // 单位 byte
  readonly headerLength: number;       // 单位 byte
  readonly length: number;             // 单位 byte
  readonly depth: number;              // 根为 0
  isUniversal(number: number): boolean;
  isContext(number: number): boolean;
  findUniversal(number: number): DerNode | undefined;
  findContext(number: number): DerNode | undefined;
  requireUniversal(number: number, label: string): DerNode;
  requireSequence(label?: string): DerNode;
  asBoolean(): boolean;
  asInteger(): bigint;
  asUnsignedIntegerBytes(size?: number): Uint8Array;
  asOctets(): Uint8Array;
  asBitString(): DerBitString;
  asBitStringOctets(): Uint8Array;
  asOid(): string;
  asString(): string;
  asTime(): Date;
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

严格 DER：拒绝 BER 不定长、非最小长度/OID 编码；`node.raw` 保留原始 TLV，验签必须使用原始字节。`parseDer` 要求输入恰好被一个结构消费完；`parseDerAll` 解析连续多个 TLV。`resolveParseOptions` 只返回 `maxBytes`/`maxDepth`，`maxNodes` 需直接在 `DerParseOptions` 中传入。

### 8.2 SM2Cipher

```ts
export interface C1C3C2ParseOptions {
  readonly c1Prefix?: 'auto' | 'present' | 'absent'; // 默认 auto
}

export interface Sm2Cipher {
  readonly x: Uint8Array;   // 32 byte 大端
  readonly y: Uint8Array;   // 32 byte 大端
  readonly c3: Uint8Array;  // 32 byte
  readonly c2: Uint8Array;  // 长度 ≥ 1 byte
}

export function parseSm2Cipher(der: Uint8Array, options?: DerParseOptions): Sm2Cipher;
export function encodeSm2Cipher(cipher: Sm2Cipher): Uint8Array;
export function sm2CipherToC1C3C2(cipher: Sm2Cipher): Uint8Array;
export function c1c3c2ToSm2Cipher(
  bytes: Uint8Array,
  options?: C1C3C2ParseOptions,
): Sm2Cipher;
```

`sm2CipherToC1C3C2` 输出 `04||X||Y||C3||C2`；`c1c3c2ToSm2Cipher` 由调用方声明前缀，`auto` 只在恰好一个候选在曲线上时返回。结构/长度/曲线非法抛 `CRYPTO_ASN1_INVALID`。

### 8.3 OID

导出以下 OID 常量（运行时字符串）：

`OID_SM3`、`OID_SM3_WITH_SM2`、`OID_SM2_SIGN`、`OID_SM2_CURVE`、`OID_EC_PUBLIC_KEY`、`OID_SM4`、`OID_SM4_CBC`、`OID_GM_DATA`、`OID_GM_SIGNED_DATA`、`OID_PKCS7_DATA`、`OID_PKCS7_SIGNED_DATA`、`OID_CT_TST_INFO`、`OID_PKCS9_CONTENT_TYPE`、`OID_PKCS9_MESSAGE_DIGEST`、`OID_PKCS9_SIGNING_TIME`、`OID_PBES2`、`OID_PBKDF2`、`OID_HMAC_WITH_SHA1`、`OID_HMAC_WITH_SHA256`、`OID_AES_128_CBC`、`OID_AES_192_CBC`、`OID_AES_256_CBC`、`OID_BASIC_CONSTRAINTS`、`OID_KEY_USAGE`、`OID_SUBJECT_KEY_IDENTIFIER`、`OID_AUTHORITY_KEY_IDENTIFIER`、`OID_EXTENDED_KEY_USAGE`、`OID_SUBJECT_ALT_NAME`、`OID_COMMON_NAME`、`OID_COUNTRY_NAME`、`OID_LOCALITY_NAME`、`OID_STATE_OR_PROVINCE_NAME`、`OID_ORGANIZATION_NAME`、`OID_ORGANIZATIONAL_UNIT_NAME`、`OID_EMAIL_ADDRESS`、`OID_DOMAIN_COMPONENT`。

```ts
export function oidName(oid: string): string;
export function dnLabel(oid: string): string;
export function isSm2SignatureAlgorithm(oid: string): boolean;
export function isSignedDataContentType(oid: string): boolean;
```

`oidName` 对未知 OID 返回原点分字符串；`dnLabel` 对未知属性返回原点分 OID。

### 8.4 曲线

```ts
export interface Sm2CurveParams {
  readonly p: bigint;
  readonly a: bigint;
  readonly b: bigint;
  readonly n: bigint;
  readonly gx: bigint;
  readonly gy: bigint;
}

export const SM2_CURVE: Readonly<Sm2CurveParams>;
export function isSm2PointOnCurve(x: bigint, y: bigint): boolean;
export function isSm2PrivateKeyScalar(d: bigint): boolean;
```

`SM2_CURVE` 为 sm2p256v1 参数；标量合法范围为 `1 ≤ d ≤ n-2`。

## 9. 字节、编码与运行时工具

### 9.1 字节与编码

```ts
export function toUint8Array(value: ArrayBuffer | Uint8Array): Uint8Array;
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array;
export function copyBytes(bytes: Uint8Array): Uint8Array;
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean;
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean;
export function toHex(bytes: Uint8Array): string;
export function fromHex(hex: string): Uint8Array;
export function toBase64(bytes: Uint8Array): string;
export function tryFromBase64(text: string): Uint8Array | null;
export function fromBase64(text: string): Uint8Array;
export function utf8Encode(text: string): Uint8Array;
export function utf8Decode(bytes: Uint8Array): string;
export function zeroize(bytes: Uint8Array): void;
export function leftPadBytes(bytes: Uint8Array, length: number): Uint8Array;
export function sha256(data: Uint8Array): Uint8Array;    // 32 byte
export function sha256Hex(data: Uint8Array): string;     // 64 字符小写 hex
```

- `fromHex` 忽略空白，长度非偶数或含非法字符抛 `CRYPTO_INVALID_ARGUMENT`；
- `tryFromBase64` 忽略 ASCII 空白，要求长度为 4 的倍数、`=` 只在末尾，非法返回 `null`；`fromBase64` 非法抛 `CRYPTO_INVALID_ARGUMENT`；
- `bytesEqual`/`constantTimeEqual` 均为常量时间比较（长度不同立即返回 false）；
- `utf8Decode` 对非法序列替换为 U+FFFD，不抛错；`leftPadBytes` 超长抛 `CRYPTO_INVALID_ARGUMENT`。

### 9.2 PEM 与参数校验

```ts
export interface PemBlock {
  readonly type: string;
  readonly der: Uint8Array;
}

export function looksLikePem(text: string): boolean;
export function parsePemBlocks(text: string): PemBlock[];

export function throwIfAborted(signal?: AbortSignal): void;
export function requireString(value: unknown, name: string): string;
export function requirePositiveInteger(value: unknown, name: string, max?: number): number;
export function requireWithinBytes(length: number, maxBytes: number, what: string): void;
```

`parsePemBlocks` 在块内 Base64 非法时抛 `CRYPTO_ASN1_INVALID`；`throwIfAborted` 抛 `CRYPTO_ABORTED`；`requireString`/`requirePositiveInteger` 抛 `CRYPTO_INVALID_ARGUMENT`；`requireWithinBytes` 抛 `CRYPTO_LIMIT_EXCEEDED`。

### 9.3 选项解析

```ts
export interface ResolvedCryptoOptions {
  readonly limits: CryptoLimits;
  readonly signal?: AbortSignal;
  readonly onWarning?: CryptoWarningHandler;
  readonly sm2UserId: string;
  readonly now: Date;
}

export function resolveCryptoLimits(partial?: Partial<CryptoLimits>): CryptoLimits;
export function resolveCryptoOptions(options?: CryptoOptions): ResolvedCryptoOptions;
export function resolveParseOptions(options?: ParseOptions, limits?: CryptoLimits): {
  readonly maxBytes: number;
  readonly maxDepth: number;
};
export function resolveSm2UserId(userId?: string): string;
```

- `resolveCryptoLimits` 浅合并且要求所有字段为正整数，否则 `CRYPTO_INVALID_ARGUMENT`；
- `resolveCryptoOptions` 组合 limits/signal/onWarning/sm2UserId/now，`now` 非法时抛 `CRYPTO_INVALID_ARGUMENT`；
- `resolveSm2UserId` 省略时返回 `DEFAULT_SM2_USER_ID`，空值或 UTF-8 超过 8191 byte 抛 `CRYPTO_INVALID_ARGUMENT`。

### 9.4 warning 收集器

```ts
export interface WarningCollector {
  readonly warnings: readonly CryptoWarning[];
  emit(warning: CryptoWarning): void;
}

export function createWarningCollector(handler?: CryptoWarningHandler): WarningCollector;
```

按 `(code, path, message)` 去重；`handler` 异常被吞掉，不影响主流程。

## 10. 错误与 warning

### 10.1 `CryptoError`

```ts
export type CryptoErrorCode =
  | 'CRYPTO_INVALID_ARGUMENT' | 'CRYPTO_CREDENTIALS_REQUIRED' | 'CRYPTO_SOURCE_UNSUPPORTED'
  | 'CRYPTO_LIMIT_EXCEEDED' | 'CRYPTO_ABORTED' | 'CRYPTO_INVALID_PACKAGE'
  | 'CRYPTO_NOT_ENCRYPTED' | 'CRYPTO_UNSUPPORTED_ENCRYPTION' | 'CRYPTO_ENTRY_MAP_INVALID'
  | 'CRYPTO_DECRYPT_FAILED' | 'CRYPTO_DECRYPT_LAYER_LIMIT' | 'CRYPTO_LAYER_LOOP'
  | 'CRYPTO_USER_NOT_FOUND' | 'CRYPTO_USER_AMBIGUOUS' | 'CRYPTO_WRONG_PASSWORD'
  | 'CRYPTO_PRIVATE_KEY_INVALID' | 'CRYPTO_PRIVATE_KEY_PASSPHRASE_REQUIRED'
  | 'CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION' | 'CRYPTO_PRIVATE_KEY_MISMATCH'
  | 'CRYPTO_ASN1_INVALID' | 'CRYPTO_UNSUPPORTED_SES_VERSION' | 'CRYPTO_UNSUPPORTED_ALGORITHM'
  | 'CRYPTO_CERTIFICATE_INVALID' | 'CRYPTO_TRUST_ROOT_INVALID' | 'CRYPTO_INTEGRITY_INVALID'
  | 'CRYPTO_SIGNATURE_INVALID' | 'CRYPTO_TIMESTAMP_PARSE';

export interface CryptoErrorOptions {
  readonly cause?: unknown;
}

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;
  readonly cause?: unknown;
  constructor(code: CryptoErrorCode, message: string, options?: CryptoErrorOptions);
}

export function isCryptoError(value: unknown): value is CryptoError;
export function toCryptoError(
  error: unknown,
  code?: CryptoErrorCode,
  message?: string,
): CryptoError;
```

`message` 只包含路径/用户名/算法/OID 等诊断信息；不包含口令、私钥、PEM 或密钥字节。`toCryptoError` 对已是 `CryptoError` 的值原样返回，默认错误码 `CRYPTO_INVALID_ARGUMENT`。

### 10.2 错误码表

| 码 | 典型场景 |
| --- | --- |
| `CRYPTO_INVALID_ARGUMENT` | 参数形状/数量/类型/上限非法 |
| `CRYPTO_CREDENTIALS_REQUIRED` | 加密包无凭据；`verifyOfd` 收到加密容器 |
| `CRYPTO_SOURCE_UNSUPPORTED` | 输入源类型/环境不支持；URL 读取失败 |
| `CRYPTO_LIMIT_EXCEEDED` | 包/条目/ASN.1/证书/层数超过上限 |
| `CRYPTO_ABORTED` | `AbortSignal` 中止 |
| `CRYPTO_INVALID_PACKAGE` | ZIP/XML/OFD 包结构非法 |
| `CRYPTO_NOT_ENCRYPTED` | 保留的“需要加密包但输入不是”码；当前 `openDecryptingContainer` 对明文包走透传 |
| `CRYPTO_UNSUPPORTED_ENCRYPTION` | 加密算法/结构不支持（含 ZIP 条目级加密） |
| `CRYPTO_ENTRY_MAP_INVALID` | entriesmap 映射/条目/解密失败/元数据残留 |
| `CRYPTO_DECRYPT_FAILED` | 多凭据全部失败或 SM4/SM2 解密失败 |
| `CRYPTO_DECRYPT_LAYER_LIMIT` | 超过 `maxDecryptLayers` |
| `CRYPTO_LAYER_LOOP` | 加密层循环/未取得进展 |
| `CRYPTO_USER_NOT_FOUND` | 凭据找不到用户 |
| `CRYPTO_USER_AMBIGUOUS` | 多候选且未指定用户名 |
| `CRYPTO_WRONG_PASSWORD` | 口令错误 |
| `CRYPTO_PRIVATE_KEY_INVALID` | 私钥结构/曲线/Base64/口令错误导致解密结果非法 |
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

### 10.3 warning 码表

| 码 | 触发场景 |
| --- | --- |
| `W_CRYPTO_DUPLICATE_USER` | 重复用户名（同一用户名最多一条） |
| `W_CRYPTO_CREDENTIAL_IGNORED` | 明文包凭据被忽略；未加密私钥 passphrase 被忽略 |
| `W_CRYPTO_ENTRIES_MAP_PLAINTEXT` | entriesmap 是明文 XML |
| `W_CRYPTO_ENTRY_MAP_INVALID` | entriesmap 有可容忍异常 |
| `W_CRYPTO_KEY_USAGE_MISSING` | 证书缺 KeyUsage |
| `W_CRYPTO_MULTI_LAYER` | 解密层数 > 1 |
| `W_CRYPTO_TIMESTAMP_PARSE` | 时间戳解析失败 |
| `W_CRYPTO_TIMESTAMP_IMPRINT_MISMATCH` | messageImprint 与签名值不匹配 |
| `W_CRYPTO_UNKNOWN_SES_VERSION` | `OFD.xml` 解析失败，版本/签名索引不可判定 |
| `W_CRYPTO_REFERENCE_UNSUPPORTED` | References 为空或 CheckMethod 非 SM3 |
| `W_CRYPTO_SEAL_PICTURE_INVALID` | 印章图片缺失/损坏 |
| `W_CRYPTO_TRUST_UNKNOWN` | 未配置信任根，链无法判定 |
| `W_CRYPTO_CERT_SOURCE_UNSUPPORTED` | `skipInvalid=true` 时非法证书输入被跳过 |

```ts
export const CRYPTO_ERROR_CODES: readonly CryptoErrorCode[];
export const CRYPTO_WARNING_CODES: readonly CryptoWarningCode[];
export const VERSION: string;
export function getVersion(): string;
```

`VERSION` 与 `getVersion()` 返回相同值，内置于产物，不读取 `package.json`。

## 11. 与 engine 的 `VirtualContainer` 集成

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
- `openDecryptingContainer` 对明文包返回 source-backed 容器（`url` 输入为内存容器），关闭该容器也不会关闭原 `ByteSource`；
- 调用方应在读取/验证/解密结束后自行关闭文件句柄或字节源。


## 12. 导出索引

### 12.1 核心函数

`inspect`、`openDecryptingContainer`、`verifyOfd`、`parseSeal`、`parseSignedValue`、`parseTimestamp`、`parseSignaturesXml`、`parseSignatureXml`、`parseOfdEntriesXml`。

### 12.2 证书

`certificatesToDer`、`parseX509Certificate`、`parseCertificate`、`parseCertificates`、`loadCertificate`、`loadCertificates`、`checkCertificateValidity`、`toCertificateSummary`。

### 12.3 SM

`SM4_BLOCK_SIZE`、`sm4EncryptCbc`、`sm4DecryptCbc`、`sm3Digest`、`sm3Hex`、`sm3OfText`、`kdfSm3`、`derivePasswordKey`、`DEFAULT_SM2_USER_ID`、`normalizeSm2PrivateKey`、`normalizeSm2PublicKey`、`sm2GetPublicKey`、`sm2Sign`、`sm2Verify`、`sm2Encrypt`、`sm2Decrypt`、`isValidSm2PublicKey`、`SM2_CURVE`、`isSm2PointOnCurve`、`isSm2PrivateKeyScalar`、`parseSm2PrivateKey`。

### 12.4 ASN.1 / DER / OID

`DER_TAG`、`DerNode`、`parseDer`、`parseDerAll`、`decodeOid`、`encodeDerLength`、`encodeDerTlv`、`derSequence`、`derSet`、`derInteger`、`derOctetString`、`derBitString`、`derOid`、`derNull`、`derBoolean`、`derUtf8String`、`derContext`、`derUtcTime`、`derGeneralizedTime`、`compareBytes`、`parseSm2Cipher`、`encodeSm2Cipher`、`sm2CipherToC1C3C2`、`c1c3c2ToSm2Cipher`、`oidName`、`dnLabel`、`isSm2SignatureAlgorithm`、`isSignedDataContentType`。

### 12.5 工具、错误、warning

`CryptoError`、`isCryptoError`、`toCryptoError`、`CRYPTO_ERROR_CODES`、`CRYPTO_WARNING_CODES`、`DEFAULT_CRYPTO_LIMITS`、`createWarningCollector`、`VERSION`、`getVersion`、`toUint8Array`、`concatBytes`、`copyBytes`、`bytesEqual`、`constantTimeEqual`、`toHex`、`fromHex`、`toBase64`、`tryFromBase64`、`fromBase64`、`utf8Encode`、`utf8Decode`、`zeroize`、`leftPadBytes`、`sha256`、`sha256Hex`、`looksLikePem`、`parsePemBlocks`、`throwIfAborted`、`requireString`、`requirePositiveInteger`、`requireWithinBytes`、`resolveCryptoLimits`、`resolveCryptoOptions`、`resolveParseOptions`、`resolveSm2UserId`、`readCryptoSource`。

### 12.6 OID 常量

`OID_SM3`、`OID_SM3_WITH_SM2`、`OID_SM2_SIGN`、`OID_SM2_CURVE`、`OID_EC_PUBLIC_KEY`、`OID_SM4`、`OID_SM4_CBC`、`OID_GM_DATA`、`OID_GM_SIGNED_DATA`、`OID_PKCS7_DATA`、`OID_PKCS7_SIGNED_DATA`、`OID_CT_TST_INFO`、`OID_PKCS9_CONTENT_TYPE`、`OID_PKCS9_MESSAGE_DIGEST`、`OID_PKCS9_SIGNING_TIME`、`OID_PBES2`、`OID_PBKDF2`、`OID_HMAC_WITH_SHA1`、`OID_HMAC_WITH_SHA256`、`OID_AES_128_CBC`、`OID_AES_192_CBC`、`OID_AES_256_CBC`、`OID_BASIC_CONSTRAINTS`、`OID_KEY_USAGE`、`OID_SUBJECT_KEY_IDENTIFIER`、`OID_AUTHORITY_KEY_IDENTIFIER`、`OID_EXTENDED_KEY_USAGE`、`OID_SUBJECT_ALT_NAME`、`OID_COMMON_NAME`、`OID_COUNTRY_NAME`、`OID_LOCALITY_NAME`、`OID_STATE_OR_PROVINCE_NAME`、`OID_ORGANIZATION_NAME`、`OID_ORGANIZATIONAL_UNIT_NAME`、`OID_EMAIL_ADDRESS`、`OID_DOMAIN_COMPONENT`。

### 12.7 公共类型索引

`CryptoSource`、`ByteSource`、`CryptoCredential`、`PasswordCredential`、`PrivateKeyCredential`、`Sm2PrivateKeyInput`、`CertificateDer`、`CertificatesToDerOptions`、`CertificateSummary`、`CertificateKeyUsage`、`CertificateValidity`、`CryptoOptions`、`ParseOptions`、`CryptoLimits`、`CryptoWarning`、`CryptoWarningCode`、`CryptoWarningHandler`、`CryptoErrorCode`、`CryptoErrorOptions`、`OfdInspection`、`EncryptionLayerInfo`、`EncryptionUserInfo`、`SignatureEntrySummary`、`DecryptingContainerResult`、`DecryptionLayerSummary`、`OpenDecryptingContainerOptions`、`VerificationReport`、`PackageVerificationInfo`、`DecryptionReportInfo`、`IntegrityVerification`、`SignatureVerification`、`SealVerification`、`CertificateChainVerification`、`DataHashVerification`、`ReferenceCheckResult`、`ReferenceFailure`、`ReferenceFailureReason`、`SignatureMathResult`、`VerifyOfdOptions`、`TimestampParseResult`、`TimestampParseOptions`、`TimestampStatus`、`ParsedSeal`、`SealPictureInfo`、`ParsedSignedValue`、`SesVersion`、`PemBlock`、`SignaturesXml`、`SignatureRecord`、`SignatureXml`、`SignatureReferenceXml`、`StampAnnotInfo`、`OfdEntriesInfo`、`X509Certificate`、`X509Extension`、`DistinguishedNameAttribute`、`CertificateParseOptions`、`CertificateLoadOptions`、`DerNode`、`DerTag`、`DerClass`、`DerBitString`、`DerParseOptions`、`Sm2Cipher`、`C1C3C2ParseOptions`、`Sm2CurveParams`、`Sm2PrivateKey`、`Sm2PrivateKeyParseOptions`、`Sm2SignOptions`、`Sm2DecryptOptions`、`Sm4CbcOptions`、`Sm4Padding`、`VerificationStatus`、`ChainStatus`、`VerificationIssue`、`VerificationIssueSeverity`、`WarningCollector`、`ReadCryptoSourceOptions`、`ResolvedCryptoOptions`。
