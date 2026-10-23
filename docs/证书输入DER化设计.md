# 证书输入 DER 化设计（D-CERT）

- 状态：设计定稿（t64）；实现见 t65，独立验证见 t66。
- 范围：证书输入契约、前置转换工具、UI/CLI 迁移与测试矩阵；私钥 `Sm2PrivateKeyInput` 不在本次范围，仍为 PEM/DER 二态。
- 结论：crypto 公共证书接口只接收 DER 字节；PEM/CER/Base64/多证书识别全部前移到 `certificatesToDer`；**不保留** `CertificateInput` 兼容层。
## 1. 核心接口：只收 DER

```ts
/** 单张 X.509 证书的完整 DER；归调用方所有，crypto 不修改。 */
export type CertificateDer = Uint8Array;

/** 证书加载选项；字节类字段单位均为 byte。 */
export interface CertificateLoadOptions {
  /** 单张 DER 上限，默认 `DEFAULT_CRYPTO_LIMITS.maxAsn1Bytes`。 */
  readonly maxBytes?: number;
  /** 证书总数上限，默认 `DEFAULT_CRYPTO_LIMITS.maxCertificates`。 */
  readonly maxCertificates?: number;
  /** 取消信号。 */
  readonly signal?: AbortSignal;
  /** warning 回调。 */
  readonly onWarning?: CryptoWarningHandler;
  /** 非法项跳过并 warning；默认 false。 */
  readonly skipInvalid?: boolean;
  /** 解析失败错误码，默认 `CRYPTO_CERTIFICATE_INVALID`。 */
  readonly invalidCode?: CryptoErrorCode;
}

/**
 * 加载并解析多张证书 DER。
 * @param inputs 每项为一张证书的完整 DER（一个顶层 SEQUENCE，无尾随字节）
 * @param options 加载选项；maxBytes 单位 byte
 * @returns 按输入顺序去重后的证书
 * @throws CryptoError `CRYPTO_CERTIFICATE_INVALID`/`CRYPTO_LIMIT_EXCEEDED`/`CRYPTO_ABORTED`/`CRYPTO_INVALID_ARGUMENT`
 */
export async function loadCertificates(inputs: readonly CertificateDer[], options?: CertificateLoadOptions): Promise<readonly X509Certificate[]>;

/** 加载并解析单张证书 DER。 */
export async function loadCertificate(input: CertificateDer, options?: CertificateLoadOptions): Promise<X509Certificate>;

/** 证书解析同样 DER-only；其余选项不变。 */
export function parseCertificates(input: CertificateDer, options?: CertificateParseOptions): readonly X509Certificate[];
export function parseCertificate(input: CertificateDer, options?: CertificateParseOptions): X509Certificate;

export interface VerifyOfdOptions extends CryptoOptions {
  /** 信任根；每项一张证书 DER；空数组/省略 = 未配置，链状态 unknown。 */
  readonly roots?: readonly CertificateDer[];
}
```

- 删除 `CertificateInput` 及 `data/pem/der` 三态；不新增兼容别名或重载。
- 每个数组元素必须是单张证书；多证书拼接 DER 先由工具拆分。核心遇非 SEQUENCE、截断、尾随字节一律 `CRYPTO_CERTIFICATE_INVALID`。
- 运行时兜底：非 `Uint8Array`（string/ArrayBuffer/三态对象）→ `CRYPTO_INVALID_ARGUMENT`；`Uint8Array` 但内容不是证书（如 PEM 字节）→ `CRYPTO_CERTIFICATE_INVALID`。类型层已禁止，运行时拒绝防止 JS 调用绕过。
- 保留 `loadCertificates` 现有语义：SHA-256 指纹去重、`maxBytes`/`maxCertificates`、`signal`、`onWarning`、`skipInvalid`；`roots` 非法仍由 verify 入口报 `CRYPTO_TRUST_ROOT_INVALID`；所有权上 crypto 不修改输入、不跨调用持有，调用期间调用方不得变更同一 `Uint8Array`。

## 2. 前置转换工具 `certificatesToDer`

位置：`packages/ofdrw-viewer-crypto/src/cert/convert.ts`，经 `cert/index.ts` 与包根导出；同步纯函数，无 I/O、无 `node:*`。UI/CLI 已依赖 crypto，直接复用，避免各自实现 PEM/Base64 解析；不新增子路径导出。

```ts
/** 证书转换选项；字节类字段单位均为 byte。 */
export interface CertificatesToDerOptions {
  /** 原始输入与单张输出 DER 上限，默认 `maxAsn1Bytes`。 */
  readonly maxBytes?: number;
  /** 输出证书张数上限，默认 `maxCertificates`。 */
  readonly maxCertificates?: number;
}

/**
 * 把证书输入转换为逐张 DER。
 *
 * 支持 DER/CER 字节、DER 拼接、PEM（单/多证书、CRLF、块外文字）、Base64 文本；
 * 只做格式识别、字节拆分与 X.509 最小合法性校验，不建信任链、不输出摘要/指纹、
 * 不判定 valid/untrusted/unknown。
 *
 * @param input 原始输入：ArrayBuffer/Uint8Array 或 PEM/Base64 字符串
 * @param options 大小与数量上限；maxBytes 单位 byte
 * @returns 按输入顺序排列的每张证书 DER；每项为独立副本，归调用方所有
 * @throws CryptoError `CRYPTO_CERTIFICATE_INVALID`/`CRYPTO_LIMIT_EXCEEDED`/`CRYPTO_INVALID_ARGUMENT`
 */
export function certificatesToDer(input: ArrayBuffer | Uint8Array | string, options?: CertificatesToDerOptions): readonly Uint8Array[];
```

识别规则（顺序固定）：
1. `string`：去 BOM；含 `-----BEGIN` → PEM；否则按严格 Base64（忽略 ASCII 空白）解码后按 DER 处理。
2. 字节：含 PEM armor → PEM；首个非空白字节 `0x30` → DER/拼接；否则按 Base64 文本。若按 DER 解析失败且内容为可打印文本，再回退 Base64 解析一次，避免 Base64 以 `0` 开头时误判。
3. PEM：接受 `CERTIFICATE`、`X509 CERTIFICATE`、`TRUSTED CERTIFICATE`；混合块忽略非证书块，只有非证书块时报错；`TRUSTED CERTIFICATE` 只取首个证书 TLV，尾部信任数据忽略；块内 Base64 非法即失败。
4. DER/CER：CER 按 DER 处理；按长度边界读取 1..N 个完整顶层 `SEQUENCE`，每个必须通过 X.509 解析；截断/非 SEQUENCE/尾随垃圾 → 失败；顺序与输入一致，工具不按指纹去重。
5. 上限：原始输入字节、每张输出 DER 均 ≤ `maxBytes`；输出张数 ≤ `maxCertificates`；选项非正整数 → `CRYPTO_INVALID_ARGUMENT`。
6. 空输入（0 字节、空串、仅空白、空 PEM）、非证书 PEM、非法 Base64/DER → `CRYPTO_CERTIFICATE_INVALID`；超限 → `CRYPTO_LIMIT_EXCEEDED`；错误消息只给格式/位置/上限，不回显证书内容。

| 场景 | 错误码 |
| --- | --- |
| 入参类型/选项非法 | `CRYPTO_INVALID_ARGUMENT` |
| 空输入、非法 PEM/Base64/DER、非证书 PEM | `CRYPTO_CERTIFICATE_INVALID` |
| 超过 `maxBytes`/`maxCertificates` | `CRYPTO_LIMIT_EXCEEDED` |

## 3. 分层与调用点
```text
UI CertificateSource(data/url/path/filePath)        CLI `--root` 文件
        │ 读取原始 bytes                                    │ readFile bytes
        └──────────────► certificatesToDer ────────────────┘
                              │ readonly Uint8Array[]（逐张 DER）
                              └─► loadCertificates（根摘要）→ verifyOfd({ roots: ders })
```

- 工具只做“字节/文本 → DER 列表”，不做信任链、摘要、指纹与状态判定；crypto 内核只解析 DER，`parseCertificates` 不再识别 PEM/Base64；工具结果仍会被内核完整重解析，内核不信任外部预校验。
- UI：`CertificateSource` 四态不变；`CertificateInputLoader` **签名不变**（返回 `Uint8Array|ArrayBuffer|null`，可返回 PEM 多证书内容），仅更新 JSDoc 为“原始字节，不预转换”。`resolveRootInput` 改为 `resolveRootDers`：读取 data/url/loader 字节后调 `certificatesToDer`；`loadRoots` 用 `loadCertificates(ders)` 生成摘要，`TrustRootItem.certificate: CertificateInput` 改为 `ders: readonly CertificateDer[]`；`verify` 时 `roots: rootItems.flatMap(item => item.ders)`。坏源仍按现有 `W_CRYPTO_CERT_SOURCE_UNSUPPORTED` 警告并跳过，loader 抛错仍上抛 `OFD_CRYPTO_FAILED`。
- CLI：`readTrustRoots(paths): Promise<readonly CertificateDer[]>`，每个文件 `readFile → certificatesToDer → 追加`，多文件/多证书扁平化；删除根证书的 `looksLikePem` 分支。私钥仍用 `Sm2PrivateKeyInput` 二态，`looksLikePem` 仅供私钥分支使用。`verify` 的 roots 类型改为 DER 数组；`info`/`convert` 不涉及根证书，无需行为变更。错误码映射不变（`CERTIFICATE_INVALID`→5、`LIMIT_EXCEEDED`→2、`INVALID_ARGUMENT`→1）。
- 无新增依赖方向：UI/CLI 仍单向依赖 crypto。

## 4. 迁移影响

| 位置 | 变更 |
| --- | --- |
| `types/certificate.ts`、`types/index.ts`、`verify/types.ts` | 删除 `CertificateInput`，新增并导出 `CertificateDer`；`CertificateSummary` 不变；`roots?: readonly CertificateDer[]` |
| `cert/loader.ts` | 入参改 DER；删除 `data/pem/der` 分支、`countInputSources`、`readInputBytes`；保留上限/取消/warning/skipInvalid/去重 |
| `cert/parse.ts` | 入参改 `CertificateDer`；删除 PEM/Base64 分支，仅按单证书 DER 解析 |
| `cert/convert.ts` | 新增 `certificatesToDer` 与 `CertificatesToDerOptions` |
| `cert/index.ts`、`src/index.ts` | 导出转换工具与 `CertificateDer`；更新注释 |
| UI `options.ts`、`crypto/service.ts` | 转换前移、`resolveRootDers`、`TrustRootItem.ders`、roots 扁平化；`CertificateInputLoader` 签名不变 |
| CLI `credentials.ts`、`verify.ts` | `readTrustRoots` 返回 DER；删除根证书 PEM 判断；roots 类型改为 DER 数组，行为/退出码不变 |
| 测试 | crypto 新增 `test/cert/convert.test.ts`，改写 `loader.test.ts`/`ui-adapter.test.ts`；UI/CLI 根证书集成测试改用多格式样例 |
| 文档 | 本文件；t65 同步 `ofdrw-viewer-crypto设计方案.md`、`CONTRACTS.md`、crypto/CLI README 与 skills |
**不保留兼容层（结论）**：

- 不保留 `CertificateInput`、`data/pem/der` 双入口、字符串入参重载或 deprecated 别名；两套输入模型会让“PEM 是否已被转换”无法静态判断，长期造成接口分叉。
- 当前为 `0.1.0` 未发布版本，允许一次性破坏式迁移；工作区内所有调用方、类型、测试、文档在同一改动内更新；门禁：源码/类型/测试中 `rg "CertificateInput"` 命中为 0（本设计文档仅记录历史概念），`@ts-expect-error` 断言 PEM/字符串/三态对象无法传给核心接口。

## 5. 测试矩阵

| 层 | 用例 | 期望 |
| --- | --- | --- |
| 工具 | PEM 单证书（`root-ca.crt.pem`）；PEM 多证书（root+signer） | 1/2 项；单证书字节等于 `root-ca.crt.der`，多证书顺序与块顺序一致 |
| 工具 | PEM 用 CRLF / 块外说明文字 / BOM；`TRUSTED CERTIFICATE` | 与 LF 输入逐字节一致；只输出首个证书 DER |
| 工具 | CER 文件；DER 拼接（root‖signer）；Base64 单行/折行/含空白 | CER 同 DER；拼接出 2 项且逐字节等于 fixture；Base64 与 DER fixture 一致 |
| 工具 | 空输入：0 字节/空串/仅空白/空 PEM | `CRYPTO_CERTIFICATE_INVALID` |
| 工具 | 无效 PEM：缺 END、坏 Base64、只含 `PRIVATE KEY` | `CRYPTO_CERTIFICATE_INVALID` |
| 工具 | 非法 DER：截断/非 SEQUENCE/尾随垃圾 | `CRYPTO_CERTIFICATE_INVALID` |
| 工具 | `maxBytes` 小于输入；`maxCertificates=1` 传两证书；入参为 number、选项 0/负/非整数 | 前两项 `CRYPTO_LIMIT_EXCEEDED`；后两项 `CRYPTO_INVALID_ARGUMENT` |
| 工具 | 返回数组元素互不共享缓冲区 | 修改其一不影响其他及再解析 |
| 核心 | `loadCertificates([pemBytes])` / `verifyOfd({roots:[pemBytes]})` | 分别为 `CRYPTO_CERTIFICATE_INVALID` / `CRYPTO_TRUST_ROOT_INVALID`；类型层 `@ts-expect-error` |
| 核心 | 旧 PEM/DER 用例经工具转换后 `loadCertificates` | serial/fingerprint/summaries 与旧 loader 完全一致 |
| UI | data/url/path/filePath 返回 PEM 单/多证书；坏根 | 摘要与验证结果同旧；多证书成多条；坏根 warning 且其余继续 |
| CLI | `--root` 传 PEM/DER/CER/PEM bundle/Base64；坏根；无根；多根 | 输出同旧；坏根 exit 5；无根 unknown；重复根去重 |
| 回归 | 12 个夹具、`cert-openssl.verify.test.ts`、JA 验证 | 无回归 |

## 6. 非目标
- 不改私钥输入、口令/解密、印章/签名/时间戳语义。
- 不在 crypto 核心新增扩展名（`.pem/.cer`）或 MIME/URL 识别；文件类型判断属于宿主 UI/CLI；工具不负责根证书信任配置、链校验、有效期判断与 `unknown` 判定。
