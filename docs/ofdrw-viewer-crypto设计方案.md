# @ofdrw/ofdrw-viewer-crypto 密码能力设计

`@ofdrw/ofdrw-viewer-crypto` 是 OFD 查看器的密码能力包：它读取 OFD 包内的加密清单、签名清单与证书结构，完成加密包解密、电子签名验证、防夹带完整性验证、电子印章解析和 RFC 3161 时间戳解析。密码包不参与页面渲染、文件系统访问、界面交互和命令行解析；它不实现网络策略、Range、重试、缓存或代理，但 `CryptoSource.url` 变体会在包内通过全局 `fetch` 读取。

本文描述该包当前实现的设计边界与数据流。公开函数签名、字段定义、默认值、状态枚举与完整导出清单以 [`packages/ofdrw-viewer-crypto/skills/API.md`](../packages/ofdrw-viewer-crypto/skills/API.md) 为准；接入示例与平台差异见 [`packages/ofdrw-viewer-crypto/skills/SKILL.md`](../packages/ofdrw-viewer-crypto/skills/SKILL.md)。本文不重复抄录这些签名表。

## 1. 定位、包与依赖

### 1.1 能力范围

| 能力 | 当前实现 |
| --- | --- |
| 加密检测 | `inspect` 读取根 `Encryptions.xml` 及其各 `EncryptInfo` 指向的 `decryptseed.dat`，返回层、用户、签名条目和完整性文件是否存在；不解密条目 |
| 加密包打开 | `openDecryptingContainer` 按口令或 SM2 私钥恢复文件密钥，逐层解密并返回明文容器；明文包原样透传 |
| 完整性验证 | 校验 `OFDEntries.xml` 的 GB/T 35275 SignedData、文件清单缺失/夹带与证书链 |
| 文档签名验证 | 解析 SES v1/v4/v5，校验 `SignedValue.dat` 的 SM3withSM2 签名、`References` 摘要、封存信息和证书链 |
| 印章与时间戳 | 解析 `Seal.esl`；解析 RFC 3161/GM/T 0033 时间戳结构并核对 messageImprint，不验证 TSA 签名 |
| 证书与基础算法 | 证书 DER 转换、X.509 摘要解析、证书链校验；SM2/SM3/SM4、DER、ASN.1、XML 与编码工具 |

### 1.2 非目标

- 不实现 OFD 渲染、页面模型、字体加载与画布操作；这些属于 engine/UI。
- 不实现网络策略、Range、重试、缓存、代理、鉴权流程或小程序文件系统；`CryptoSource.url` 会通过全局 `fetch` 读取完整响应，调用方也可改用 `byte-source` 自行负责获取。
- 不实现用户界面、凭据弹窗、根证书文件选择或命令参数解析；UI/CLI 负责这些交互并调用本包。
- 不实现证书吊销检查（CRL/OCSP）、时间戳权威签名验证、OCSP 响应验证或密钥托管。
- 不提供加密、签名生成、印章生成或 OFD 重写能力；本包只做检测、解密和验证。
- OFD 包的加密/签名算法仅 SM2/SM3/SM4；私钥 PKCS#8 的 PBES2 解密另支持 AES-CBC 子集。遇到其他 OID/结构返回 `unsupported` 或对应错误，不猜测算法。

### 1.3 包结构

```text
packages/ofdrw-viewer-crypto/
├── src/
│   ├── index.ts                 # 唯一公共入口
│   ├── inspect.ts               # 加密包只读检测
│   ├── errors.ts                # CryptoError 与错误码
│   ├── version.ts
│   ├── asn1/                    # DER、OID、X.509、SM2Cipher 结构
│   ├── cert/                    # 证书转换、解析、加载、摘要
│   ├── container/               # 内存明文容器与包内路径
│   ├── credentials/             # 凭据归一化与 PKCS#8 私钥
│   ├── decrypt/                 # 加密清单、entriesmap、逐层解密
│   ├── integrity/               # 防夹带完整性解析与验证
│   ├── seal/                    # 电子印章解析
│   ├── sign/                    # SES、签名清单、References、签名验证
│   ├── sm/                      # SM2/SM3/SM4、KDF、私钥
│   ├── source/                  # CryptoSource 到 engine ZIP 容器
│   ├── timestamp/               # 时间戳结构解析
│   ├── types/                   # 公共类型、选项、限制、状态、warning
│   ├── util/                    # 字节、摘要、取消、warning、来源工具
│   └── verify/                  # 一次性验证编排与证书链
├── skills/                      # SKILL.md 与 API.md
└── test/                        # 单元/集成测试与测试夹具
```

`src/index.ts` 是唯一公共入口，包不提供子路径导出；内部模块之间可以互相引用，调用方只能从包根导入。

### 1.4 依赖方向

```text
UI / CLI / 宿主
      │  传入 CryptoSource、凭据、根证书 DER
      ▼
@ofdrw/ofdrw-viewer-crypto
      ├── @ofdrw/ofdrw-viewer-engine   VirtualContainer / ByteSource / OFDError
      ├── sm-crypto                    SM2 / SM3 / SM4 基础运算
      └── saxes                        XML 解析
```

反向依赖不允许出现：engine 不依赖 crypto，crypto 不依赖 UI/CLI。UI/CLI 只通过公开 API 组合能力，不读取 crypto 内部模块。

### 1.5 运行时与构建约束

- 包同时产出 ESM 与 CJS，构建目标为 ES2022，`platform: 'neutral'`，不注入 DOM 或 Node 专用 shim。
- 源码不导入 `node:*`、`fs`、`path`、`http` 等宿主模块；文件/流由调用方读取，`CryptoSource` 的 `arraybuffer`/`blob`/`byte-source` 由本包按需读取，`url` 由本包用全局 `fetch` 读取。
- 运行环境需要 `AbortController`、`TextEncoder`、`TextDecoder`、`crypto.subtle`（仅加密 PKCS#8 私钥需要）以及标准 `Uint8Array`。
- `Blob` 输入要求运行环境提供全局 `Blob`；`url` 输入要求全局 `fetch`；缺少对应能力时抛 `CRYPTO_SOURCE_UNSUPPORTED`。
- `package.json` 声明 Node `>=22`；浏览器和小程序宿主以实际提供的 Web API 为准，crypto 不探测宿主类型。

构建配置把 engine、`saxes`、`sm-crypto`、`asn1js`、`@peculiar/asn1-schema`、`@peculiar/asn1-x509`、`fflate` 列为 external，由宿主打包器解析；源码直接调用 engine、`saxes` 与 `sm-crypto` 的 SM 原语，ASN.1/DER 解析由本包 `asn1/` 层完成。

## 2. 与 engine 的容器边界

### 2.1 两类容器

engine 的 `VirtualContainer` 在密码流程中承担两种角色：

| 角色 | `encrypted` | `read()` 语义 | crypto 的用法 |
| --- | --- | --- | --- |
| raw package container | `true` | 返回 OFD 包内存仓原始字节，可能是密文 | 只用于检测、读取加密清单和解密输入；不得直接注入阅读器 |
| plaintext container | `false` | 返回明文字节 | 解密结果或明文包；可以注入 engine 的 `OFDDocument` |

`openZipVirtualContainer` 返回 raw package container。加密包的容器 `encrypted=true`；明文包虽然也由该函数打开，但 `encrypted=false`，可直接作为明文来源。engine 自身不做解密。

crypto 的内存容器 `MemoryVirtualContainer` 固定 `encrypted=false`，`packageSize` 保留原始加密包字节数，条目按规范化包内路径升序排列，`read()` 返回独立副本。

### 2.2 crypto 如何打开和消费容器

公开入口都从 `CryptoSource` 开始：

```text
CryptoSource
  ├── arraybuffer  ──┐
  ├── blob         ──┼──> engine.openZipVirtualContainer ──> raw container
  ├── byte-source  ──┘         （isolate：不转发 close）
  └── url          ─────> fetch 整包读取 ──> arraybuffer 容器
```

- `arraybuffer` 与 `blob` 走 engine 的 ZIP 容器，不复制整包；`blob` 在读取时由 engine 适配。
- `byte-source` 走 engine 的 `custom` 来源。crypto 创建只转发 `size`、`read`、`ready` 的隔离视图，**不转发 `close`**；容器关闭不会关闭调用方的字节源。
- `url` 先按 `maxSourceBytes` 流式读取整包，再以内存字节打开容器；crypto 不做 Range、鉴权重试或缓存。
- 打开容器前会检查 `byte-source.size` 上限；流式 URL 读取会在累计超限时立即取消 reader 并报错。
- 所有容器读取都受 `maxEntries`、`maxEntryBytes`、`maxTotalDecryptedBytes` 与 `maxCompressionRatio` 约束；超限映射为 `CRYPTO_LIMIT_EXCEEDED`。

### 2.3 所有权与关闭

| 对象 | 创建方 | 关闭责任 | 说明 |
| --- | --- | --- | --- |
| `CryptoSource` 的 `ByteSource` | 调用方 | 调用方 | crypto 使用隔离视图，绝不转发 `close` |
| `inspect` 打开的 raw container | crypto | crypto | 结束后在 `finally` 中关闭 |
| `openDecryptingContainer` 的原始容器 | crypto | crypto（明文分支移交给调用方） | 明文包返回原始容器；加密包关闭原始容器并返回内存容器 |
| `openDecryptingContainer` 的结果容器 | crypto | 调用方 | 调用方必须关闭；重复关闭幂等 |
| `verifyOfd` 打开的容器 | crypto | crypto | 验证结束后关闭；调用方传入的 `container` 不关闭 |
| `verifyOfd` 的临时解密容器 | crypto | crypto | 验证完成后关闭，不返回给调用方 |

容器关闭后，engine 的 `read()`/`list()` 抛 `OFD_CLOSED`，`has()`/`stat()` 返回 false/undefined。关闭失败不应覆盖解密或验证的主结论。

### 2.4 错误映射

engine 的容器错误在 crypto 边界统一转换为 `CryptoError`：

| engine 情况 | crypto 错误 |
| --- | --- |
| 输入源类型不受支持或无法打开 | `CRYPTO_SOURCE_UNSUPPORTED` 或 `CRYPTO_INVALID_PACKAGE` |
| ZIP 结构损坏、条目缺失 | `CRYPTO_INVALID_PACKAGE` |
| 条目数/条目大小/解压总量超限 | `CRYPTO_LIMIT_EXCEEDED` |
| 读取被取消 | `CRYPTO_ABORTED` |
| 容器已关闭 | `OFD_CLOSED` → `CRYPTO_INVALID_PACKAGE`（由 crypto 打开的来源） |

对调用方而言，通常只需区分 `CryptoError.code`。例外：`verifyOfd` 接收调用方注入的 `container` 时，入口会直接调用 `container.list()`；若该容器已关闭，engine 的 `OFD_CLOSED` 会原样抛出，而不是包装为 `CryptoError`。调用方应避免传入已关闭容器，或同时处理该 `OFDError`。除此之外，读取失败、超限和取消都在 `readEntry` 等边界转换为 `CryptoError`。

### 2.5 明文包透传

`openDecryptingContainer` 先检测根 `Encryptions.xml`：

- 不存在时按明文包处理，返回原始容器、`plaintext: true`、`layers: []`；传入凭据只产生 `W_CRYPTO_CREDENTIAL_IGNORED`，不执行解密。
- 存在时按加密包处理，必须提供至少一个凭据；成功后才构造内存明文容器。
- 明文包返回的原始容器仍由调用方关闭；crypto 不会因为“没解密”而替调用方关闭它。
- 解密失败或取消时不会返回半成品容器，也不会留下可读取的部分明文；`onWarning` 回调抛出的异常被吞掉，不影响本次解密结果。

## 3. 公共 API 与类型语义

### 3.1 输入源与选项

`CryptoSource` 有四种形态：内存字节（`arraybuffer`）、`Blob`、URL、engine `ByteSource`。四者都归调用方所有；crypto 只在调用期间读取，不跨调用缓存，也不修改调用方字节。

`CryptoOptions` 是所有核心入口共享的选项：

| 选项 | 语义 |
| --- | --- |
| `limits` | 与默认限制浅合并；每个字段必须是正整数，否则 `CRYPTO_INVALID_ARGUMENT` |
| `signal` | 取消信号；在读取、解析、解密和验证边界检查，取消抛 `CRYPTO_ABORTED` |
| `onWarning` | 接收不中断流程的 warning；回调异常被吞掉，不影响结果 |
| `sm2UserId` | SM2 签名用户 ID，默认标准值；只影响签名验证，不从证书推导 |
| `now` | 证书有效期判断时间；必须是有效 `Date`，默认当前时间 |

`ParseOptions` 只控制单次 ASN.1/XML 解析的 `maxBytes` 与 `maxDepth`，默认取 `CryptoLimits` 对应字段。精确类型定义见 API 文档。

### 3.2 三个核心入口

| 入口 | 输入 | 输出 | 关键语义 |
| --- | --- | --- | --- |
| `inspect` | `CryptoSource` | `OfdInspection` | 只读检测；打开并关闭内部容器；不解密、不验证签名 |
| `openDecryptingContainer` | `CryptoSource` + 可选凭据 | 明文容器、检测摘要、层摘要、warning | 明文透传或逐层解密；成功后才移交容器 |
| `verifyOfd` | `CryptoSource` 或已解密的 `VirtualContainer`（二者互斥且必须提供一个） | `VerificationReport` | 一次性完整性/签名/链/印章/时间戳编排；报告型失败不抛异常 |

三个入口的关系是：

```text
inspect ──> 是否需要凭据、层与用户信息
   │
   ├──> openDecryptingContainer ──> 明文 container ──> verifyOfd(container)
   │
   └──> verifyOfd(source) ──> 内部按需解密、验证、关闭临时容器
```

`inspect` 不返回容器，不应用于读取明文；`openDecryptingContainer` 不执行签名验证；`verifyOfd` 不把明文容器返回给调用方。

`inspect` 的 `integrityPresent` 只看根 `OFDEntries.xml` 与根 `signedvalue.dat` 是否同时存在；它不解析 SignedData，也不代表完整性验证通过。嵌套清单的存在不改变该字段。

`openDecryptingContainer` 返回的 `inspection` 在加密包成功时保留原始包的 `encrypted: true`、`layers` 与 `users`，但 `signatures` 与 `integrityPresent` 来自解密后的明文；明文包的 `inspection` 与原始包一致。调用方应结合 `plaintext` 和容器本身判断是否已解密。

### 3.3 解析与基础能力

除核心入口外，公开 API 还提供以下可独立使用的层：

- 签名结构：`parseSignatureXml`、`parseSignaturesXml`、`parseSignedValue`、`parseSeal`。
- 完整性结构：`parseOfdEntriesXml`。
- 时间戳：`parseTimestamp`。
- 证书：`parseCertificate`、`parseCertificates`、`loadCertificate`、`loadCertificates`、`certificatesToDer`、证书摘要转换。
- 基础算法：SM2 签名/验签与 SM2Cipher、SM3 摘要与 KDF、SM4-CBC、私钥解析。
- 编码与结构：DER/ASN.1、OID、Base64/PEM 工具、XML 解析、包内路径解析。

解析 API 的共同约定是：输入字节或文本归调用方所有；解析失败抛 `CryptoError`；结构化报告型 API（时间戳、验证报告）把“结构可解析但内容不合法”记录为状态/issue，而不是一律抛异常。

### 3.4 证书输入

crypto 公共证书接口接收 DER 字节（`CertificateDer = Uint8Array`）。`parseCertificate`、`loadCertificate`、`loadCertificates` 与 `VerifyOfdOptions.roots` 的每个证书项都要求恰好一张证书的 DER；`parseCertificates` 额外接受多张证书 DER 直接拼接的字节，按 TLV 边界逐张解析。它们都不识别 PEM/Base64 文本，也不读取 URL、路径或文件；CER 文件由宿主读成字节后按 DER 处理。

按文件来源处理时，PEM/Base64/CER 文件内容与多证书文本先经 `certificatesToDer` 读取并转换为逐张 DER；若调用方已拿到 DER/CER 字节，可直接作为 `CertificateDer`，直接拼接的多张 DER 可交给 `parseCertificates`，也可由 `certificatesToDer` 拆成逐张。转换细节、输入上限、去重和错误语义见 [`证书输入DER化设计.md`](./证书输入DER化设计.md)。crypto 内核不感知 UI 的证书来源形态，也不感知 CLI 的根证书路径。

### 3.5 资源限制

`CryptoLimits` 的默认值如下；字节类字段单位为 byte，计数/层数字段单位为个/层/张，`maxCompressionRatio` 为无量纲倍率：

| 字段 | 默认值 | 约束对象 |
| --- | ---: | --- |
| `maxSourceBytes` | 256 MiB | 输入包、Blob、URL 响应、字节源总大小 |
| `maxEntries` | 20,000 | ZIP 条目数 |
| `maxEntryBytes` | 64 MiB | 单条目明文 |
| `maxTotalDecryptedBytes` | 512 MiB | 单层解压总量 |
| `maxCompressionRatio` | 200 | 解压总量 / 输入字节数 |
| `maxDecryptLayers` | 4 | 嵌套加密层数 |
| `maxAsn1Bytes` | 16 MiB | 单个 ASN.1/XML 结构 |
| `maxAsn1Depth` | 64 | ASN.1/XML 嵌套深度 |
| `maxCertificates` | 32 | 单次验证解析的证书总数 |
| `maxTrustRoots` | 32 | 信任根数量 |

限制在入口解析选项时校验；读取和解析过程中一旦超限立即失败，不继续消费资源。

### 3.6 错误与 warning

`CryptoError` 是唯一公共错误类型，调用方用 `code` 分支，不应解析 `message`。错误码按语义分为：

- 参数与来源：`CRYPTO_INVALID_ARGUMENT`、`CRYPTO_SOURCE_UNSUPPORTED`、`CRYPTO_LIMIT_EXCEEDED`、`CRYPTO_ABORTED`。
- 包与加密结构：`CRYPTO_INVALID_PACKAGE`、`CRYPTO_NOT_ENCRYPTED`、`CRYPTO_UNSUPPORTED_ENCRYPTION`、`CRYPTO_ENTRY_MAP_INVALID`、`CRYPTO_DECRYPT_FAILED`、`CRYPTO_DECRYPT_LAYER_LIMIT`、`CRYPTO_LAYER_LOOP`。
- 凭据：`CRYPTO_CREDENTIALS_REQUIRED`、`CRYPTO_USER_NOT_FOUND`、`CRYPTO_USER_AMBIGUOUS`、`CRYPTO_WRONG_PASSWORD`、`CRYPTO_PRIVATE_KEY_INVALID`、`CRYPTO_PRIVATE_KEY_PASSPHRASE_REQUIRED`、`CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION`、`CRYPTO_PRIVATE_KEY_MISMATCH`。
- ASN.1/验证：`CRYPTO_ASN1_INVALID`、`CRYPTO_UNSUPPORTED_SES_VERSION`、`CRYPTO_UNSUPPORTED_ALGORITHM`、`CRYPTO_CERTIFICATE_INVALID`、`CRYPTO_TRUST_ROOT_INVALID`、`CRYPTO_INTEGRITY_INVALID`、`CRYPTO_SIGNATURE_INVALID`、`CRYPTO_TIMESTAMP_PARSE`。

warning 不中断流程，由 `onWarning` 接收，也可能同时保存在检测/验证结果的 `warnings` 数组中。warning 按 `(code, path, message)` 去重；常见类别包括重复用户、凭据被忽略、entriesmap 为明文、entriesmap 非法、证书缺少 KeyUsage、多层加密、时间戳结构/摘要异常、未知 SES 版本、不支持的 Reference、印章图片异常、信任根不可判定和根证书来源不支持。

安全约束：错误和 warning 的 `message` 只能包含路径、用户名、算法/OID 等诊断信息，不得包含口令、私钥、PEM、`EncryptedWK` 或任何密钥字节。报告型失败（如签名不匹配、证书过期、时间戳不可验证）优先写入 `status`/`issues`，不抛异常；参数、结构、凭据、资源、取消错误才抛 `CryptoError`。

## 4. 解密算法与流程

### 4.1 加密包结构

当前实现识别以下结构：

```text
包根/
├── Encryptions.xml
├── decryptseed.dat
├── entriesmap.dat
├── OFD.xml
├── OFDEntries.xml
├── Signatures.xml
└── ...（被加密或未加密的文档条目）
```

- `Encryptions.xml` 的根元素包含若干 `EncryptInfo`；没有 `EncryptInfo` 视为非法加密包。
- 每个 `EncryptInfo` 指向一个 `decryptseed.dat` 与一个 `entriesmap.dat`；未显式给出路径时，默认分别是根下 `/decryptseed.dat` 与 `/entriesmap.dat`。
- `EncryptInfo@ID` 缺失时，层摘要使用 `layer-<n>` 作为稳定标识。
- 加密清单、种子文件和映射文件本身不参与加密；它们是解密所需的元数据。

### 4.2 解密主流程

```text
openCryptoContainer(source)
        │
        ▼
检测根 Encryptions.xml ──不存在──> 明文包：直接返回原始容器
        │存在
        ▼
读取 decryptseed / 用户列表
        │
        ▼
选择凭据并恢复 FEK / IV
        │
        ▼
按 entriesmap 解密条目（SM4-CBC/PKCS#7）
        │
        ▼
删除本层加密元数据，检查是否还有下一层
        │
        ├──有──> 以解密结果继续下一层
        │
        └──无──> 构造 MemoryVirtualContainer（encrypted=false）
```

任何一步失败（凭据错误、结构非法、条目解密失败、超限、取消）都不会返回容器。实现不会把已解出的部分明文交给调用方，也不在失败时继续尝试后续层。

### 4.3 `Encryptions.xml` 与层

- 根 `Encryptions.xml` 决定是否存在加密。`inspect` 只读取根清单；解密循环按层读取当前清单。
- 每层至少有一个 `EncryptInfo`；同层多个 `EncryptInfo` 表示多个并行加密范围，逐个应用。
- 每层解密后会移除本层的 `Encryptions.xml`、`decryptseed.dat`、`entriesmap.dat` 等元数据，避免它们出现在最终明文容器中。
- 若解密后的条目中又出现新的 `Encryptions.xml`，继续下一层；层数超过 `maxDecryptLayers` 报 `CRYPTO_DECRYPT_LAYER_LIMIT`。
- 同一加密清单内容或同一组清单/种子/映射摘要重复出现时报 `CRYPTO_LAYER_LOOP`；循环检测基于内容摘要，不只看路径。
- 层数上限是 4；上限同时约束单层内 `EncryptInfo` 的处理，不能通过把多层塞进一个清单绕过。

### 4.4 `decryptseed.dat` 与用户

`decryptseed.dat` 的用户项包含用户名、加密方法、`EncryptedWK`、`IV` 等字段。实现按以下规则解释：

- 同时接受 `DecyptSeed` 与 `DecryptSeed` 两种拼写；这是兼容现有 OFD 生产文件的解析行为。
- 用户方法由是否存在 `UserCert` 判定，不依赖 `EncryptCaseId` 的取值；`UserCert` 存在时按证书/SM2 私钥路径处理，否则按口令路径处理。
- `EncryptedWK` 与 `IV` 必须是 Base64；解码失败按结构错误处理。
- `inspect` 汇总根清单中各 `EncryptInfo` 的用户，按用户信息去重，并在发现重复用户时产生 `W_CRYPTO_DUPLICATE_USER`；它不递归解密后续层。
- 用户名只用于选择用户，不参与密钥派生；匹配失败不会尝试“猜”用户名。

### 4.5 凭据匹配

凭据分为口令和私钥两类，调用方可以传入一个或多个：

| 场景 | 行为 |
| --- | --- |
| 明文包 + 任意凭据 | 忽略凭据，产生 `W_CRYPTO_CREDENTIAL_IGNORED` |
| 加密包 + 无凭据 | `CRYPTO_CREDENTIALS_REQUIRED` |
| 单凭据 + 用户名不存在 | `CRYPTO_USER_NOT_FOUND` |
| 单凭据 + 用户名匹配到多个用户 | `CRYPTO_USER_AMBIGUOUS` |
| 口令用户 + 口令错误 | `CRYPTO_WRONG_PASSWORD` |
| 私钥用户 + 私钥与用户证书不匹配 | `CRYPTO_PRIVATE_KEY_MISMATCH` |
| 多凭据 | 按顺序逐个尝试；没有凭据匹配用户时保留最后的 `CRYPTO_USER_NOT_FOUND`/`CRYPTO_USER_AMBIGUOUS`，至少命中一个用户但均无法恢复 FEK 时才报 `CRYPTO_DECRYPT_FAILED` |

未指定 `userName` 时，只有“同类型候选用户唯一”才自动匹配；存在多个同类候选时报 `CRYPTO_USER_AMBIGUOUS`，不会按顺序猜。私钥凭据支持 PEM（PKCS#8、SEC1）和 DER（PKCS#8）；私钥必须位于 `sm2p256v1` 曲线。

### 4.6 文件密钥恢复

口令路径：

```text
password (UTF-8)
   │  KDF: SM3 计数器分块，输出 16 byte
   ▼
KEK ──SM4-CBC/PKCS#7 解密 EncryptedWK──> FEK (16 byte)
   │
IV ─────────────────────────────────────> 条目 SM4-CBC 的 IV (16 byte)
```

- KDF 使用 SM3，输出长度必须在 1..4096 byte；当前恢复 FEK 使用 16 byte。
- KDF 结果全零时重试一次；仍全零则失败，避免弱密钥进入 SM4。
- 口令按 UTF-8 编码，不做 Unicode 规范化；空口令在参数校验阶段拒绝。
- `IV` 来自种子用户项，必须为 16 byte；口令路径的 `EncryptedWK` 解密失败映射为 `CRYPTO_WRONG_PASSWORD`，私钥路径映射为 `CRYPTO_PRIVATE_KEY_MISMATCH`，不泄漏明文。

私钥路径：

```text
UserCert (DER) ──> X.509 公钥
SM2 私钥 + EncryptedWK
   │  SM2Cipher 解密（C1C3C2）
   ▼
FEK (16 byte) + IV（种子项）
```

- `EncryptedWK` 按 SM2Cipher 结构解析；私钥曲线、用户证书和密文必须匹配，否则报 `CRYPTO_PRIVATE_KEY_MISMATCH`。
- 加密 PKCS#8 私钥支持 `PBES2 + PBKDF2(HMAC-SHA1/SHA256) + AES-128/192/256-CBC`；缺少 `crypto.subtle` 或遇到其他 PBES2 算法报不支持，不降级。
- 私钥、口令和 FEK 只在本次调用内存在，不写入报告、warning 或错误消息；私钥对象使用后尽量清零。

### 4.7 `entriesmap.dat` 与条目解密

`entriesmap.dat` 是 XML 映射表，列出 `EPath`（加密条目路径）与明文字典条目。实现按以下规则应用：

- 映射路径先规范化；重复输出路径、非法路径或映射到清单自身均视为 `CRYPTO_ENTRY_MAP_INVALID`。
- 每个映射条目用该层的 FEK/IV 执行 SM4-CBC 解密，严格校验 PKCS#7 填充；密文长度不是 16 的倍数或填充非法时统一报 `CRYPTO_ENTRY_MAP_INVALID`。
- 解密后的条目覆盖原始密文条目；未映射的非 `.dat` 条目保持原始字节。映射表中出现明文 XML 时产生 `W_CRYPTO_ENTRIES_MAP_PLAINTEXT` 并跳过解密。
- 未被映射但仍在包内的 `.dat` 条目不会被当作明文保留，也不会被自动猜测解密；该层直接以 `CRYPTO_ENTRY_MAP_INVALID` 失败，避免把密文交给 engine。非 `.dat` 的未映射条目按原字节复制并产生 `W_CRYPTO_ENTRY_MAP_INVALID`。
- 解密后的路径若与已有输出重复，拒绝该层，不静默覆盖。
- 本层处理完成后，清单、种子和映射文件从输出中移除；最终容器不包含这些元数据。

### 4.8 多层与循环

- 解密循环在每层结束后重新扫描输出条目，寻找新的 `Encryptions.xml`。
- 下一层清单必须来自解密输出，不能引用上一层已删除的元数据。
- 层摘要按从外到内排列；`warnings` 中每个额外层产生 `W_CRYPTO_MULTI_LAYER`。
- 内容摘要重复（清单、种子、映射组合）或层数超限会立即终止，不返回部分结果。
- 取消信号在每层开始、读取清单/种子/映射、每个条目解密和最终检测前检查；取消后抛 `CRYPTO_ABORTED`。

### 4.9 明文容器与元数据隔离

加密包解密成功后，输出是内存明文容器：

- `encrypted=false`，`packageSize` 保留原始加密包大小，`origin` 区分 `package` 与 `decrypted`。
- 所有条目均为明文；加密清单、种子、映射等元数据不出现在最终容器中。
- 条目按规范化路径排序；`read()` 返回副本，engine 修改返回值不会污染容器缓存。
- 签名清单中的相对 `BaseLoc` 在解密后仍可解析，文档签名验证不因解密而丢失路径上下文。

### 4.10 解密错误语义

| 情况 | 结果 |
| --- | --- |
| 根清单不存在 | 视为明文，不报错 |
| 根清单存在但无 `EncryptInfo` | `CRYPTO_INVALID_PACKAGE` |
| `decryptseed` 缺失/不可读 | `CRYPTO_INVALID_PACKAGE` |
| 用户不存在/歧义/口令错误/私钥不匹配 | 对应凭据错误 |
| 私钥结构或加密算法不支持 | `CRYPTO_PRIVATE_KEY_INVALID` / `CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION` |
| 条目映射非法 | `CRYPTO_ENTRY_MAP_INVALID` |
| 条目 SM4 解密/填充失败 | `CRYPTO_ENTRY_MAP_INVALID` |
| 层数超限/循环 | `CRYPTO_DECRYPT_LAYER_LIMIT` / `CRYPTO_LAYER_LOOP` |
| 取消 | `CRYPTO_ABORTED` |

## 5. 验证算法与流程

### 5.1 验证报告与聚合

`verifyOfd` 返回 `VerificationReport`，包含包信息、可选解密信息、完整性结果、签名数组、各子项的问题列表、warning、耗时和总体状态。设计上分为三层：

1. **单项结果**：完整性、每个签名、印章、时间戳各自有状态和 issues。
2. **签名聚合**：任一签名 `invalid` 则整体 `invalid`；否则按 `unknown`、`unsupported`、`valid` 的优先级聚合。
3. **总体聚合**：完整性或签名任一 `invalid` 为 `invalid`；否则 `unknown` 优先于 `unsupported`/`valid`；既无完整性又无签名时为 `not-applicable`。

时间戳不参与总体状态，因为当前只解析、不验证 TSA 签名。报告中的 `package.integrityPresent` 表示完整性结果非空；`rootsConfigured` 表示调用方是否传入非空根证书；`decryption` 只在 `source` 是加密包并由 `verifyOfd` 内部解密时出现，记录层摘要与 `plaintext`。

验证状态语义：

| 状态 | 含义 |
| --- | --- |
| `valid` | 已检查项全部通过 |
| `invalid` | 结构、摘要、签名、文件清单或印章校验明确失败 |
| `unknown` | 无法判定（例如签名算法或结构无法解释），不是失败 |
| `unsupported` | 算法、SES 版本或结构类型不受支持 |
| `not-applicable` | 没有完整性结果也没有签名，或子项本身不适用 |

证书链状态独立于上述聚合：`certificate.status`、`issues`、`trustRootConfigured` 始终完整保留，但不参与签名、印章、完整性与 `overall` 的通过/失败判定。

每个签名额外提供 `signingTime`/`signingTimeSource` 作为签发时间展示值，来源优先级为 `TBS_Sign.timeInfo` > 时间戳 `TSTInfo.genTime` > `Signature.xml/SignatureDateTime`；均无值时省略。`timeInfo` 与 `SignatureDateTime` 保留原文（v4/v5 的 `timeInfo` 为 ISO 8601，v1 可能为自由文本），该字段只用于展示，不代表可信时间。当前支持的 SES v1/v4/v5 中，v4/v5 的 `timeInfo` 为必需字段、v1 不含时间戳，因此实际只会产生 `time-info` 或 `signature-xml`；`timestamp` 分支保留给未来允许缺省 `timeInfo` 的结构变体，当前版本不可达。

### 5.2 完整性验证

完整性验证以 `OFDEntries.xml` 为入口：

- 根 `OFDEntries.xml` 优先；没有根清单时查找第一个嵌套 `*/OFDEntries.xml`。两者都不存在时完整性结果为 `null`。
- 清单的 `SignedValueLoc` 是签名值路径；缺省为根 `signedvalue.dat`。路径非法时直接构造 `invalid` 结果并记录 issue，不回退到默认路径。
- 清单存在但签名值文件缺失时返回 `null`，表示“未保护/不完整”，不伪造 `valid`。
- `SignedValue.dat` 按 GB/T 35275 SignedData 解析：支持无 authenticatedAttributes 的 eContent 摘要形态，也支持 PKCS#9 authenticatedAttributes 形态；eContent 可为原始摘要或 Base64 摘要文本。
- 验签使用 SignedData 中的内嵌证书；签名算法必须是 SM3withSM2 或 SM2 sign，摘要算法必须是 SM3。
- 文件清单与实际包内容比对：清单登记但缺失的文件记 `INTEGRITY_FILE_MISSING`；包内存在但未登记的夹带文件记 `INTEGRITY_EXTRA_FILE`；两类问题都会使完整性 `invalid`。
- 实际文件计数排除清单文件和签名值文件自身。
- 证书链状态独立记录、不参与完整性聚合：链状态为 `expired`、`not-yet-valid`、`untrusted`、`incomplete`、`invalid`、`not-present`、`unknown` 或 `unsupported` 时，只要 SignedData 签名数学、文件清单与摘要通过，完整性仍为 `valid`。缺少匹配证书会使签名验签失败，因此仍由签名结果判为 `invalid`。

### 5.3 签名发现与筛选

- 先从 `OFD.xml` 的 `DocBody/Signatures` 定位签名清单；缺失时回退到根 `Signatures.xml`。
- 每个 `Signature` 条目包含 ID、类型、`BaseLoc` 和约定的 `SignedValue` 路径；`BaseLoc` 可以是根路径或相对路径。
- 单个 `BaseLoc` 缺失或非法只影响该签名，不终止整个验证；该签名记录 `invalid` 并附 `SIGNATURE_BASELOC_INVALID`。
- `inspect` 的签名摘要同样逐条容错：缺失 `Type`/`BaseLoc` 时对应字段为空串，不以 `CRYPTO_INVALID_PACKAGE` 中断只读检测（否则打开文档会误报“解密失败”）；只有 `BaseLoc` 路径穿越等非法路径才作为包结构错误抛出。
- `VerifyOfdOptions.signatureIds` 非空时只验证指定 ID；未知 ID 不凭空构造签名，结果只包含实际存在的签名。
- 签名清单解析失败时构造一个合成的非法签名条目，使报告体现“存在签名但无法验证”，而不是静默返回空数组。

### 5.4 SES 签名结构

`SignedValue.dat` 是 SES 结构，当前支持 v1、v4、v5：

| 版本 | 顶层字段数 | TBS 字段数 | 说明 |
| --- | ---: | ---: | --- |
| v1 | 2 | 7 | 早期 SES；TBS 与签名值分离 |
| v4 | 4（另可带 `[0]` 时间戳） | 5 | TBS 内带印章、时间、dataHash、propertyInfo；顶层带证书、算法与签名 |
| v5 | 4（另可带 `[0]` 时间戳） | 5 | 与 v4 结构相同，以 `version=5` 区分 |

解析器保留 TBS 的原始 DER 字节，验签直接使用原始字节，不重新序列化；这是避免 ASN.1 重编码改变签名的关键约束。证书以 DER 形式嵌入；`SESeal` 与时间戳是可选字段。未知版本报 `CRYPTO_UNSUPPORTED_SES_VERSION`，不尝试按相近版本解析。`parseSignedValue` 额外返回签章者证书 DER（`certificateDer`，独立副本、调用方拥有），供 UI 下载或展示；该字段不含 PEM、私钥或口令。

### 5.5 签名值与 References

- 签名值使用 SM2 验签，签名对象是 TBS 原始字节；`sm2UserId` 由选项提供，默认标准值。
- `dataHash` 是 `Signature.xml` 的 SM3 摘要，用于确认签名清单未被替换。
- `References` 中每个引用包含文件路径和 `CheckValue`；`CheckValue` 支持 Base64 或 64 字符十六进制，表示目标文件的 SM3 摘要。
- 文件缺失、摘要不匹配、路径非法都记为该签名 `invalid`；References 为空、`CheckMethod` 非 SM3 或未知引用类型时，References 本身为 `unsupported`，同时产生 `W_CRYPTO_REFERENCE_UNSUPPORTED`，签名聚合按 `invalid` 处理，不能把该签名判为 `unsupported`。
- 签名验证失败不会抛异常；它写入签名状态和 issues，由报告聚合决定总体结果。
- 签名中的印章信息与 `Seal.esl` 交叉校验；印章图片缺失/损坏产生 `W_CRYPTO_SEAL_PICTURE_INVALID`，不单独把签名判为无效。

### 5.6 证书链

证书链验证使用调用方提供的根证书 DER，规则如下：

- 从签名者证书开始，按颁发者/主题匹配构建链；最多 8 张证书（含终端证书）。
- 证书签名算法只支持 SM3withSM2；其他算法 `unsupported`。
- 校验证书有效期：`now` 早于 `notBefore` 为 `not-yet-valid`，晚于 `notAfter` 为 `expired`。
- 校验证书 KeyUsage：签名用途缺失/不允许时记录 issue；缺少 KeyUsage 扩展产生 `W_CRYPTO_KEY_USAGE_MISSING`。
- CA 证书必须满足 BasicConstraints、KeyUsage `keyCertSign` 与路径长度约束；终端证书不能作为 CA 继续签发。
- 没有配置根证书时，链终点通常为 `unknown`，并产生 `W_CRYPTO_TRUST_UNKNOWN`；不会把“没有根”误报为 `untrusted`。
- 配置了根但缺少颁发者时为 `incomplete`；链止于不在根集合中的自签名证书时为 `untrusted`；根证书不满足 CA/KeyUsage 约束时为 `invalid`；根 DER 无法解析时 `verifyOfd` 直接抛 `CRYPTO_TRUST_ROOT_INVALID`；没有终端证书时 `not-present`。
- 不实现 CRL/OCSP：报告中的吊销状态为 `not-checked`，不能据此认为证书未吊销。

链状态语义：

| 状态 | 含义 |
| --- | --- |
| `valid` | 链到达配置的信任根，签名、有效期和 CA 约束通过 |
| `not-present` | 没有签名者证书 |
| `expired` | 链中证书已过期 |
| `not-yet-valid` | 链中证书尚未生效 |
| `invalid` | CA 约束、证书签名、路径长度或环检测失败 |
| `unsupported` | 证书签名算法不是 SM3withSM2 |
| `incomplete` | 配置根后缺少颁发者，或链长度超过 8 张 |
| `untrusted` | 链止于自签名证书，但该证书不在信任根集合 |
| `unknown` | 未配置信任根，无法判定终点 |

链状态只用于独立展示，**不参与**签名、印章、完整性与 `overall` 的通过/失败判定：`untrusted`/`expired`/`not-yet-valid`/`incomplete`/`unknown`/`unsupported` 都不会把密码学校验通过的结果降级；warning 仍保留。缺少签名者证书会导致签名数学无法验证，因此签名仍为 `invalid`。

### 5.7 印章

`parseSeal` 解析 `Seal.esl` 的 SES 印章结构，返回印章头、证书、图片和签名信息。印章图片是 `Seal.esl` 内嵌的 `SES_ESPictrueInfo.data` 字节；包内路径只用于定位 `Seal.esl`，不用于读取外部图片。印章解析失败或内嵌图片不可读时：

- 不影响文档签名本身的数学验证；
- 产生 `W_CRYPTO_SEAL_PICTURE_INVALID`；
- 在签名/报告的 issues 中保留可诊断信息，不泄漏图片二进制。

### 5.8 时间戳

`parseTimestamp` 接受 RFC 3161 `TimeStampToken`/`TimeStampResp` 以及 GM/T 0033 时间戳结构，返回：

| 状态 | 条件 |
| --- | --- |
| `not-present` | 输入为空或没有时间戳字段 |
| `parse-error` | 结构无法解析或关键字段缺失/非法 |
| `parsed-not-verified` | 结构解析成功；只核对 messageImprint，不验证 TSA 签名 |

解析器会比较时间戳的 messageImprint 与签名值的摘要；不一致产生 `W_CRYPTO_TIMESTAMP_IMPRINT_MISMATCH`，但不会把时间戳升级为 `valid`。时间戳状态不参与总体验签结果。

### 5.9 解析 API 的边界

- `parseSignatureXml`/`parseSignaturesXml` 只解析清单结构，不读取 `SignedValue`；文件存在性由调用方或验证编排检查。
- `parseSignedValue` 解析 SES 并保留 TBS 原始字节，不做证书链或 `References` 校验；返回签章者证书摘要与证书 DER（`certificateDer`）。
- `parseOfdEntriesXml` 解析清单及 `SignedValueLoc`，不验证 SignedData。
- `parseSeal` 只解析印章，不验证印章签名。
- `parseTimestamp` 只解析和比较 messageImprint，不验证 TSA 证书或签名。

这些解析函数是验证编排的构件；直接调用时，调用方需要自行组合完整性、证书链和签名校验。

## 6. UI/CLI 集成要求

crypto 不感知宿主平台，UI 与 CLI 只通过公开 API 组合能力。具体界面交互、命令参数和宿主 I/O 分别见 [`ofdrw-viewer-ui设计方案.md`](./ofdrw-viewer-ui设计方案.md)、[`CLI设计方案.md`](./CLI设计方案.md) 和 [`网络获取委托设计.md`](./网络获取委托设计.md)。

### 6.1 输入与结果

- 调用方把用户选择的 OFD 来源转换为 `CryptoSource`：`arraybuffer`/`blob`/`byte-source` 由本包按需读取，`url` 由本包通过全局 `fetch` 整包读取。需要 Range、鉴权、重试、缓存、代理或进度时，调用方应自行读取并传入 `byte-source`。
- 凭据以 `CryptoCredential` 传入；根证书先由调用方转换为逐张 `CertificateDer`；密码、私钥和证书来源的读取与错误文案由调用方负责。
- 调用方展示 `VerificationReport`、`OfdInspection`、`CryptoError.code` 与 `CryptoWarning`；不得在 UI/CLI 重新实现 SM 算法、SES 解析或证书链校验。
- 签名结果中的 `signingTime`/`signingTimeSource` 用于展示签发时间，`certificate` 明细用于独立展示证书链可信状态；需要下载签章者证书时使用 `parseSignedValue` 返回的 `certificateDer`。证书链状态不得改变签名/完整性/`overall` 的呈现结论。

### 6.2 生命周期与所有权

- `byte-source` 归调用方所有，crypto 只使用隔离视图，不转发 `close`；调用方负责关闭原始字节源。
- `inspect` 和 `verifyOfd` 内部打开的容器由 crypto 关闭；调用方注入 `verifyOfd` 的 `container` 不关闭。
- `openDecryptingContainer` 的明文分支把原始容器所有权移交给调用方；加密分支由 crypto 关闭原始容器并返回新的内存容器，调用方必须关闭结果容器。
- 取消使用 `AbortSignal`；取消后错误码为 `CRYPTO_ABORTED`，不得当作解密失败或签名无效。

### 6.3 公开调用面

- UI/CLI 只调用 `inspect`、`openDecryptingContainer`、`verifyOfd`、证书/签名/印章/时间戳解析函数与基础算法 API；不读取或依赖 `src/` 内部模块。
- 报告型失败不抛异常，调用方根据 `status` 与 `issues` 展示；入口参数、结构、凭据、限额、取消错误才按 `CryptoError.code` 处理。
- 验证报告中的时间戳不参与总体状态；时间戳只解析，调用方不得展示为“验证通过”。

## 7. 安全、限制与当前边界

### 7.1 安全规则

- **不落明文**：解密结果只存在内存容器；crypto 不写临时文件、不缓存明文到磁盘、不把明文放入日志。
- **最小暴露**：口令、私钥、FEK、`EncryptedWK` 不进入错误/warning/报告；错误消息只描述路径、用户名、算法/OID。
- **输入先限流**：所有来源先检查大小，ZIP/ASN.1/XML 解析受条目数、单条目、总量、压缩比、深度和证书数量限制。
- **路径规范化**：包内路径先统一分隔符并归一到包根；允许前导 `/`（按包根解析），拒绝盘符/UNC/URL scheme、`..` 越界和控制字符；entriesmap 与明文容器条目还会拒绝空路径与重复输出，避免路径穿越和覆盖。
- **不信任声明**：`EncryptCaseId` 不决定用户方法；算法从结构/OID 判断；未知算法不猜测。
- **原始字节验签**：SES 的 TBS 和 SignedData 的签名对象均使用原始 DER，不重新编码。
- **明确失败**：解密不返回部分容器；验证报告区分 `invalid`、`unknown`、`unsupported` 和 `not-applicable`，不把无法判定当成成功。

### 7.2 当前边界

| 边界 | 当前行为 |
| --- | --- |
| 密码算法 | OFD 加密/签名仅 SM2/SM3/SM4；私钥 PKCS#8 的 PBES2 子集另支持 AES-CBC，其他算法返回不支持 |
| 加密层数 | 最多 4 层；超过报 `CRYPTO_DECRYPT_LAYER_LIMIT` |
| 证书链长度 | 最多 8 张（含终端证书） |
| 根证书数量 | 最多 32 张 |
| 证书吊销 | 不做 CRL/OCSP，状态为 `not-checked` |
| 时间戳 | 只解析并核对 messageImprint，不验证 TSA 签名 |
| SES 版本 | 支持 v1/v4/v5；其他版本不支持 |
| 私钥加密 | PKCS#8 的 PBES2 子集：PBKDF2(HMAC-SHA1/SHA256) + AES-128/192/256-CBC |
| 印章 | 解析结构和内嵌图片；不生成、不签章 |
| 文档写入 | 不提供加密、签名、盖章或重写 OFD 的能力 |

### 7.3 兼容性

- 明文包可以直接调用 `verifyOfd`；加密包用 `source` 调用时会内部解密，用已解密容器调用时必须是 `encrypted=false`。
- `verifyOfd` 对 `container.encrypted=true` 抛 `CRYPTO_CREDENTIALS_REQUIRED`，提示调用方先解密；不会尝试用容器内的密文验证。
- `CryptoSource.url` 通过全局 `fetch` 整包读取；网络策略、鉴权、Range、重试、缓存和进度不属于 crypto，需要这些能力时使用 `byte-source`。
- `CertificateDer` 是公开证书边界；`Sm2PrivateKeyInput` 仍支持 PEM/DER 两种私钥形态，二者不要混淆。
- 未配置根证书时链状态通常为 `unknown`，这是“无法判定”，不是“证书无效”；调用方应提示配置根证书。

## 8. 验证与夹具

### 8.1 测试分层

crypto 的测试覆盖以下层次：

| 层次 | 关注点 |
| --- | --- |
| 基础算法 | SM2 签名/验签、SM2Cipher、SM3、SM4-CBC/PKCS#7、KDF、私钥解析 |
| 结构解析 | DER/ASN.1、X.509、SES v1/v4/v5、`Signatures.xml`、`OfdEntries.xml`、`Seal.esl`、时间戳 |
| 解密 | 口令/证书单层、多层、多用户、entriesmap 异常、私钥加密、容器关闭 |
| 完整性 | SignedData、文件缺失/夹带、证书链、无根/过期/未生效 |
| 验证编排 | 签名筛选、BaseLoc、References、印章、时间戳、总体聚合、证书链 |
| 来源适配 | `arraybuffer`/`blob`/`byte-source`/`url`、上限、取消、不关闭调用方字节源 |

### 8.2 测试夹具

`test/fixtures/crypto` 提供可复现的测试包：

| 夹具 | 用途 |
| --- | --- |
| `plain.ofd` | 明文包透传与明文验证基线 |
| `password-encrypted.ofd` | 口令加密单层 |
| `cert-encrypted.ofd` | 证书/SM2 私钥加密 |
| `combined-password-encrypted.ofd` | 加密包内同时含签名与完整性结构 |
| `combined-signed-integrity.ofd` | 签名 + 完整性组合 |
| `integrity.ofd` | 防夹带完整性验证 |
| `signed-sesv4.ofd` | SES v4 文档签名 |
| `signed-sesv5.ofd` | SES v5 文档签名 |
| `negative-extra-file.ofd` | 未登记夹带文件 |
| `negative-tampered-content.ofd` | 内容篡改导致摘要不匹配 |
| `negative-tampered-signature.ofd` | `Signature.xml` 篡改 |
| `negative-tampered-signedvalue.ofd` | SignedValue 篡改 |

夹具清单、证书和生成说明见 [`packages/ofdrw-viewer-crypto/test/fixtures/crypto/README.md`](../packages/ofdrw-viewer-crypto/test/fixtures/crypto/README.md)。

### 8.3 密码包特有断言

除常规单元断言外，以下行为必须有测试守护：

- 口令错误、私钥不匹配、用户歧义等错误可区分，且错误文本不回显口令/私钥。
- 明文包传入凭据只产生 warning，不执行解密；加密包无凭据报 `CRYPTO_CREDENTIALS_REQUIRED`。
- `byte-source` 的 `inspect`/`verify`/加密打开结果与 `arraybuffer` 逐字段一致；调用方字节源在容器关闭后仍可读。
- 多层解密逐层移除元数据；输出容器不包含 `Encryptions.xml`、`decryptseed.dat`、`entriesmap.dat`。
- 层循环和超限在返回容器前失败；取消后不返回部分明文。
- 完整性缺失/夹带/篡改分别得到 `null`/`invalid`，而不是 `valid`。
- 无根证书时链为 `unknown`，但签名数学与引用通过时签名/`overall` 仍为 `valid`；过期、未生效、不受信、不完整分别保留独立链状态，且不改变最终判定。
- `signingTime` 按 `timeInfo` > `timestamp.genTime` > `SignatureDateTime` 取值，无值时字段省略；当前 v1/v4/v5 实际只会产生 `time-info` 或 `signature-xml`，`timestamp` 分支为未来结构变体保留；签名者证书 DER 可下载且不含 PEM/私钥。
- SES v1/v4/v5 的 TBS 原始字节保持；不支持的版本和算法不误判为 `valid`。
- 时间戳只解析、不验证；messageImprint 不一致只产生 warning。
- 内存容器 `read()` 返回副本，关闭后读取抛 `OFD_CLOSED`，重复关闭幂等。

### 8.4 验收口径

- 运行 `pnpm --filter @ofdrw/ofdrw-viewer-crypto test`，全部测试通过。
- 测试目录 `test/{core,decrypt,integrity,seal,sign,timestamp,verify}` 以及 `test/{cert,container,verification}` 覆盖上述层次。
- 夹具只使用测试证书和测试密钥，不包含生产私钥；清单与校验值见 `test/fixtures/crypto/manifest.json`。
- 完整测试矩阵见 [`测试方案.md`](./测试方案.md)。