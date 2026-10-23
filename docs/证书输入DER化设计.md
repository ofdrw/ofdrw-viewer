# 证书输入 DER 化设计

crypto 的公共证书接口只接收 DER 字节。PEM、CER、Base64、多证书文本和宿主路径/URL 都在进入 crypto 内核之前转换成逐张证书 DER；内核不识别扩展名、文本块或文件来源。

本文描述当前证书输入契约、转换工具、UI/CLI 分层和验证方式。精确函数签名见 [crypto API](../packages/ofdrw-viewer-crypto/skills/API.md)。

## 1. 定位与核心契约

### 1.1 核心类型

```ts
/** 单张 X.509 证书的完整 DER；归调用方所有。 */
export type CertificateDer = Uint8Array;
```

`CertificateDer` 满足以下约束：

- 对 `parseCertificate`、`loadCertificate` 的输入，以及 `loadCertificates`/`VerifyOfdOptions.roots` 的数组每项，内容必须是一张完整 X.509 证书的 DER，顶层为 `SEQUENCE`，不是 PEM 文本、Base64 文本或带额外包装的字节。
- `parseCertificates` 接受由多张证书 DER 直接拼接的字节，按 TLV 边界逐张解析。
- 字节归调用方所有；crypto 不修改，也不跨调用持有；调用期间调用方不得修改同一个 `Uint8Array`。
- `parseCertificate` 要求恰好一张证书，尾随字节视为非法；`loadCertificate` 接收单张 DER，`loadCertificates` 接收 DER 数组、每项必须是一张证书。
- `VerifyOfdOptions.roots` 只接受 `CertificateDer[]`；根证书的读取、PEM 解码和路径/URL 访问不属于 crypto。

### 1.2 边界

| 输入形态 | 进入 crypto 前 | crypto 内核 |
| --- | --- | --- |
| DER/CER | 可直接作为 `CertificateDer` | 解析 X.509 |
| 拼接 DER | 可直接传给 `parseCertificates`，或由 `certificatesToDer` 拆成逐张 | 每项一张证书 |
| PEM（单/多证书） | 由 `certificatesToDer` 解码 | 只接收 DER |
| Base64 文本 | 由 `certificatesToDer` 解码 | 只接收 DER |
| URL | 由宿主读取字节后交给 `certificatesToDer` | 不访问网络 |
| `path`/`filePath` | 由宿主加载器读取后交给 `certificatesToDer` | 不访问文件系统 |
| 私钥 | 不属于证书输入；使用 `Sm2PrivateKeyInput` 的 PEM/DER 形态 | 单独解析 |

### 1.3 设计理由

- **边界稳定**：ASN.1/X.509 解析器只处理 DER，减少文本编码、换行、BOM 和多证书拼接分支对内核的污染。
- **宿主可控**：URL/path 的读取、鉴权、缓存和错误文案由 UI/CLI/宿主决定，crypto 不感知平台。
- **可验证**：转换工具是纯函数，输入输出确定，便于测试 DER/CER/PEM/Base64 的边界和多证书顺序。
- **单一输入类型**：公共证书类型只有 `CertificateDer`；调用方必须显式完成文本到 DER 的转换，避免两套输入路径产生不同校验结果。

## 2. `certificatesToDer`

### 2.1 职责

`certificatesToDer` 把原始输入转换为逐张证书 DER，只做格式识别、字节拆分和 X.509 最小合法性校验：

- 不建立信任链，不判断 `valid`/`untrusted`/`unknown`。
- 不输出指纹、摘要或证书摘要对象；需要摘要时调用 `toCertificateSummary`。
- 不去重；去重由 `loadCertificates` 按 SHA-256 指纹完成。
- 不读取 URL、路径或文件；输入只有字节或文本。

### 2.2 输入识别

支持：

- DER/CER 字节（`ArrayBuffer`/`Uint8Array`）。
- 多张 DER 直接拼接的字节。
- PEM 文本：单/多证书、CRLF/LF、块外说明文字；允许 `CERTIFICATE`、`X509 CERTIFICATE`、`TRUSTED CERTIFICATE` 块。
- Base64 文本：可带空白；解码后按 DER 拼接解析。
- 文本输入允许 UTF-8 BOM；BOM 在识别前裁掉。

识别顺序：

```text
字节/文本
  │
  ├── 含 "-----BEGIN " ──> PEM 块解析
  │
  ├── 字节且首个非空白字节为 0x30 ──> 尝试 DER；失败且可打印时回退 Base64
  │
  └── 其他 ──> Base64 解码后按 DER 解析
```

`TRUSTED CERTIFICATE` 可能带有 OpenSSL 信任附加信息；转换只取首个证书 TLV，忽略附加信息。PEM 中没有证书块、Base64 非法、DER 顶层不是 `SEQUENCE` 或 X.509 结构非法，均报 `CRYPTO_CERTIFICATE_INVALID`。

### 2.3 输出、顺序与所有权

- 输出按输入顺序排列；PEM 多块按块出现顺序，DER 拼接按 TLV 顺序。
- 每项是独立副本，归调用方所有；调用方可以在后续调用中安全持有。
- 转换器不合并重复证书；同一证书出现两次就输出两次。需要去重时使用 `loadCertificates`，它按 `fingerprintSha256` 保留首次出现。
- 输出数量上限默认 `maxCertificates`（32）；超过时报 `CRYPTO_LIMIT_EXCEEDED`。
- 输入总字节和单张证书 DER 都受 `maxBytes` 限制，默认 `maxAsn1Bytes`（16 MiB）。

### 2.4 选项与错误

| 选项 | 默认 | 作用 |
| --- | --- | --- |
| `maxBytes` | `DEFAULT_CRYPTO_LIMITS.maxAsn1Bytes` | 输入总字节与单张证书 DER 上限，byte |
| `maxCertificates` | `DEFAULT_CRYPTO_LIMITS.maxCertificates` | 输出证书张数上限，张 |

- `maxBytes`/`maxCertificates` 非正整数：`CRYPTO_INVALID_ARGUMENT`。
- 输入为空、PEM 无证书块、Base64/DER/X.509 非法：`CRYPTO_CERTIFICATE_INVALID`。
- 输入或输出超限：`CRYPTO_LIMIT_EXCEEDED`。
- 输入类型不是 `ArrayBuffer`/`Uint8Array`/`string`：`CRYPTO_INVALID_ARGUMENT`。

### 2.5 与 DER 校验的关系

`certificatesToDer` 不是“只看外层长度”的拆分器：每个输出都会经过 `parseDer` 与 `parseX509Certificate` 的最小结构校验，确保顶层是 `SEQUENCE`、X.509 字段可解析。它不校验证书链、有效期或 KeyUsage；这些属于 `verifyOfd` 的验证阶段。

## 3. 分层与调用点

### 3.1 crypto 内核

```text
CertificateDer
   ├── parseCertificate / parseCertificates  ──> X509Certificate
   ├── loadCertificate / loadCertificates    ──> 去重、解析、warning
   └── VerifyOfdOptions.roots                ──> 证书链验证
```

- `parseCertificate`/`parseCertificates` 直接解析 DER；不做格式探测。
- `loadCertificates` 对 DER 数组逐项解析，按 SHA-256 指纹去重；`skipInvalid` 为 false（默认）时非法项抛错，为 true 时跳过并产生 `W_CRYPTO_CERT_SOURCE_UNSUPPORTED`。
- `loadCertificates` 的 `invalidCode` 可把解析失败映射为调用方错误码；默认 `CRYPTO_CERTIFICATE_INVALID`，`verifyOfd` 加载根证书时使用 `CRYPTO_TRUST_ROOT_INVALID`。
- `verifyOfd` 的 `roots` 是 DER 数组，内部经 `loadCertificates` 解析；根证书数量受 `maxTrustRoots` 与 `maxCertificates` 的较小值约束。

### 3.2 UI 层

UI 保留面向用户的四态 `CertificateSource`：

| 形态 | 读取方式 |
| --- | --- |
| `data` | 直接使用 `ArrayBuffer`/`Uint8Array` |
| `url` | 浏览器 `fetch` 读取，带可选 `headers` |
| `path` | 交给宿主 `certificateLoader` 读取 |
| `filePath` | 交给宿主 `certificateLoader` 读取 |

调用链：

```text
CertificateSource
   ├── data ───────────────┐
   ├── url ── fetch ───────┤
   └── path/filePath ── certificateLoader
                           │
                           ▼
                 certificatesToDer(bytes)
                           │
                           ▼
                 loadCertificates(ders)
                           │
                           ▼
                 CertificateSummary[] / roots
```

- UI 的 `CertificateInputLoader`（选项名 `certificateLoader`）只返回原始字节（可含 PEM/Base64/多证书），不得自行解析证书；转换统一调用 `certificatesToDer`。
- UI 内部 `resolveRootDers` 按 `data`/`url`/`path`/`filePath` 四态读取原始字节并转换；`TrustRootItem.ders` 保存该来源转换后的逐张 DER，验证时传给 crypto；`TrustRootItem.input` 保留原始来源，供展示和重载。
- `data`/`url` 读取或转换失败只产生 `W_CRYPTO_CERT_SOURCE_UNSUPPORTED` warning，继续处理其余根证书；`path`/`filePath` 的 loader 异常向上抛出，由 `setRoots`/`addRoots` 包装为 `OFD_CRYPTO_FAILED`。
- UI 对转换后的证书再调用 `loadCertificates`，按指纹去重并生成摘要；重复根证书只保留首次出现。
- UI 不把 URL、路径或 PEM 文本传给 crypto 的证书解析函数；crypto 只看到 DER。
- 具体根证书面板和错误文案见 [`ofdrw-viewer-ui设计方案.md`](./ofdrw-viewer-ui设计方案.md)。

### 3.3 CLI 层

`readTrustRoots()` 对每个 `--root` 文件：

1. 读取原始字节；文件不存在/不可读映射为 CLI 错误。
2. 调用 `certificatesToDer(bytes)`，支持 PEM/DER/CER/Base64 和多证书。
3. 把逐张 DER 拼入根数组。
4. 传给 `verifyOfd` 的 `roots`。

CLI 不自行解析 PEM，不在 CLI 侧去重；转换错误保留 `CryptoError` 语义，由 CLI 映射为退出码和输出。根证书文件与私钥文件的读取都走 CLI 文件层，不进入 crypto 的 `certificatesToDer` 之外的路径逻辑。

## 4. 错误、限制与安全

### 4.1 错误分层

| 层 | 错误/信号 | 语义 |
| --- | --- | --- |
| `certificatesToDer` | `CRYPTO_CERTIFICATE_INVALID` | PEM/Base64/DER/X.509 结构非法、输入为空 |
| `certificatesToDer` | `CRYPTO_LIMIT_EXCEEDED` | 输入字节或输出张数超限 |
| `certificatesToDer` | `CRYPTO_INVALID_ARGUMENT` | 选项非法或输入类型不支持 |
| `loadCertificates` | 默认 `CRYPTO_CERTIFICATE_INVALID`，可由 `invalidCode` 覆盖 | 单张 DER 解析失败 |
| `loadCertificates` 跳过模式 | `W_CRYPTO_CERT_SOURCE_UNSUPPORTED` | 非法项跳过，保留 warning |
| `verifyOfd` 根加载 | `CRYPTO_TRUST_ROOT_INVALID` | 根证书非法且未跳过 |
| UI 根来源 | `W_CRYPTO_CERT_SOURCE_UNSUPPORTED` / `OFD_CRYPTO_FAILED` | 不可读/不可转换/loader 失败 |
| CLI 根文件 | `CLI_ROOT_FILE_NOT_FOUND` / `CLI_ROOT_FILE_UNREADABLE` | 文件读取失败；内容错误由 crypto 错误映射 |

### 4.2 限制

- 输入总字节与单张 DER 默认上限 16 MiB；证书张数默认 32。
- `loadCertificates` 的 `maxCertificates` 在解析前检查；达到上限后不再解析后续项。
- 根证书数量同时受 `maxTrustRoots`（32）与 `maxCertificates`（32）约束。
- 证书链长度、有效期、KeyUsage、BasicConstraints 由验证阶段限制；转换阶段只做结构校验。

### 4.3 安全

- 证书是公开数据，转换器不需要清除输入；但调用方字节可能在调用后被修改，crypto 不在调用间持有引用。
- 转换器不执行网络/文件 I/O；URL 和路径的鉴权、TLS、CORS、临时文件清理由宿主负责。
- 错误消息可以包含证书路径/来源描述，但不应包含私钥、口令或无关的敏感文件内容。
- `TRUSTED CERTIFICATE` 的附加信任信息不会被解释为信任根；是否信任由 `verifyOfd` 的根配置和证书链校验决定。
- 不要用文件扩展名判断格式；识别基于内容（PEM 标记、DER 首字节、Base64 解码）。

## 5. 非目标与验证

### 5.1 非目标

- 不把 DER 转回 PEM，不生成证书、CSR 或私钥。
- 不校验证书链、有效期、KeyUsage、BasicConstraints 或吊销状态；这些在 `verifyOfd` 中完成。
- 不读取 URL、路径、文件系统或小程序临时文件。
- 不在 `certificatesToDer` 中去重；去重是加载阶段的行为。
- 不把 `Sm2PrivateKeyInput` 的 PEM/DER 解析混入证书转换；私钥有自己的解析器和错误码。

### 5.2 验证

- `packages/ofdrw-viewer-crypto/test/cert/convert.test.ts` 覆盖 DER/CER、拼接 DER、PEM 单/多证书、Base64、BOM、顺序、独立副本、大小/数量上限和错误码。
- `test/cert/parse.test.ts` 与 `test/cert/loader.test.ts` 覆盖单张/多张 DER 解析、去重、`skipInvalid`、`invalidCode` 与 warning。
- `test/cert/ui-adapter.test.ts` 覆盖 UI 四态来源的读取和转换分层。
- UI 的 `test/verification/cert-der-root.verify.test.ts` 覆盖根证书 DER 化后的验证链路；CLI 的 `test/verification/cert-der-root.verify.test.ts` 覆盖 `--root` 文件转换。
- 验收要求：PEM/Base64/CER 输入均能得到与 DER 输入相同的证书摘要；多证书顺序与输入一致；非法输入不进入链验证；根证书只以 DER 传给 `verifyOfd`。

### 5.3 与其他文档的关系

- crypto 的密码算法与验证编排见 [`ofdrw-viewer-crypto设计方案.md`](./ofdrw-viewer-crypto设计方案.md)。
- UI/CLI 的根证书交互与命令参数分别见 [`ofdrw-viewer-ui设计方案.md`](./ofdrw-viewer-ui设计方案.md) 与 [`CLI设计方案.md`](./CLI设计方案.md)。
- 精确类型、默认值和导出名以 [crypto API](../packages/ofdrw-viewer-crypto/skills/API.md) 为准。