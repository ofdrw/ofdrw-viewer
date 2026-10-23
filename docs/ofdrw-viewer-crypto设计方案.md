# @ofdrw/ofdrw-viewer-crypto 与引擎/UI/CLI 密码能力总体设计方案

| 项 | 内容 |
|---|---|
| 状态 | **R1 设计冻结（v2.0-r1）** |
| 日期 | 2026-10-23 |
| 适用版本 | engine/ui/cli 当前 v0.1.0，新增 `@ofdrw/ofdrw-viewer-crypto` v0.1.0 |
| 依据 | `docs/密码学PoC验证报告.md`（R0）、`references/ofdrw` 2.4.0、`src_material/GMT 0033-2014`、现有 `docs/CONTRACTS.md`、`packages/ofdrw-viewer-crypto/test/fixtures/crypto` |
| 契约效力 | 本文件与 `docs/CONTRACTS.md` 第 13 章共同冻结；实现、测试、验收以两者为准 |

> 本设计不保留未决项。所有需要选择的分支均给出本期决定；未实现的兼容分支以明确错误码和不支持状态呈现。

## 0. 结论与关键裁决

1. **engine 只负责读取明文容器**：新增公共 `VirtualContainer`，默认实现为 ZIP 容器；加密 OFD 由 crypto 解成内存明文容器后注入。engine 不依赖 crypto，也不解析任何密码结构。
2. **crypto 是唯一密码实现**：SM2/SM3/SM4、KDF、ASN.1/X.509/SES/CMS/时间戳解析、证书链和信任根校验都在 `@ofdrw/ofdrw-viewer-crypto`；UI/CLI 只做交互与适配。
3. **解密不落盘**：`openDecryptingContainer()` 先解包到内存，按 `Encryptions.xml → DecyptSeed → FEK → entriesmap → 逐文件 SM4` 解出明文，再实现 `VirtualContainer`；关闭时清空字节。
4. **验证结果分层**：数学签名、Reference、证书链、印章、完整性、时间戳分别返回状态；`timestamp` 固定为 `parsed-not-verified`，不参与整体有效性，也不显示为“时间戳有效”。
5. **信任根未配置 = `unknown`**：不是 `invalid`；配置根证书后重新验证可变为 `valid`。CRL/OCSP 本期不实现，报告 `revocation: 'not-checked'`，不得声称吊销状态有效。
6. **SES v1/v4/v5 都解析**：v1 使用独立结构分支；无法识别的版本返回 `CRYPTO_UNSUPPORTED_SES_VERSION`，不能按 v4/v5 下标误读。
7. **多加密层**：最多 4 层，必须每层减少密文元数据；检测到同一层循环或超过上限时失败，不允许无限递归。
8. **`EncryptCaseId` 不可依赖**：按 `UserName + UserCert 是否存在` 匹配凭据；字段缺失/null 是正常情况。
9. **明文透传**：`openDecryptingContainer()` 对无 `Encryptions.xml` 的包返回原明文容器，`plaintext=true`，不报“未加密”错误；`inspect()` 明确 `encrypted=false`。
10. **CLI 不提供独立 decrypt**：`info` 只查询，`verify` 一次性校验，既有转图片命令通过凭据参数直接解密后渲染。

### 0.1 与 R0 报告不一致处的裁决

| 议题 | R0 报告 | R1 裁决 | 理由 |
|---|---|---|---|
| SES v1 | JS PoC 未覆盖，建议本期可只支持 v4/v5 | **本期支持 v1 解析与验签** | 设计任务契约明确要求 v1/v4/v5；v1 字段位置不同，必须独立分支，不能以“旧文档”为由静默误判 |
| 加密私钥口令 | PoC 只验证未加密 PKCS#8/SEC1 | 支持未加密 PKCS#8/SEC1；加密 PKCS#8 仅支持 PBES2 + PBKDF2(HMAC-SHA1/SHA256) + AES-CBC，其他算法明确报不支持 | UI 要求私钥+口令；给出可执行子集，不留下模糊项 |
| 过期证书样例 | 建议提交过期证书样例 | 二进制夹具不新增过期证书；过期/未生效状态由测试内确定性生成证书覆盖 | 避免提交易被误认为生产信任材料的过期私钥；测试仍覆盖状态分支 |
| 多加密层 | 代码阅读支持但未实测 | 本期实现并纳入测试，上限 4 层、循环检测 | 恶意文档/外部工具可能产生多层；不实现会漏解或死循环 |
| `EncryptCaseId` | 可能为 null | 完全按 UserInfo 凭据类型匹配，字段只作诊断 | ofdrw 生成器不写该字段，不能作为主分支 |

## 1. 包、依赖与目录

### 1.1 包定位

新增 workspace 包：

```text
packages/ofdrw-viewer-crypto/
  package.json                 # name: @ofdrw/ofdrw-viewer-crypto
  tsconfig.json
  tsup.config.ts
  src/
    index.ts                   # 唯一公共入口
    types.ts                   # 公共类型聚合
    errors.ts                  # CryptoError、错误码
    warnings.ts                # CryptoWarning、warning 码
    source.ts                  # CryptoSource 读取适配
    inspect.ts                 # inspect()
    credentials/
      parse-private-key.ts
      match-user.ts
    decrypt/
      open-container.ts        # openDecryptingContainer()
      encryptions-xml.ts
      decrypt-seed.ts
      entries-map.ts
      kdf.ts
      sm4-cbc.ts
      sm2-cipher.ts
      plain-container.ts
      decrypted-container.ts
    asn1/
      der.ts
      oid.ts
      x509.ts
      cms.ts
      ses.ts
    cert/
      chain.ts
      trust-store.ts
    verify/
      verify-ofd.ts
      signature.ts
      reference.ts
      integrity.ts
      timestamp.ts
      status.ts
    parse/
      signed-value.ts
      seal.ts
      timestamp.ts
    xml/
      signature-xml.ts
      entries-xml.ts
  test/
    unit/
    integration/
    fixtures/crypto/           # 已提交的 12 case 夹具
  skills/
    SKILL.md
    API.md
  README.md
```

- 包名只允许 `@ofdrw/ofdrw-viewer-crypto`，目录名固定 `packages/ofdrw-viewer-crypto`。
- `src/index.ts` 是唯一公共入口；内部模块不得从包根导出。
- `package.json` 使用 `type: module`，`main`/`module`/`types` 指向 `dist`，`files: ["dist"]`；不声明 `sideEffects: false` 以外的秘密入口。

### 1.2 依赖方向（硬约束）

```text
@ofdrw/ofdrw-viewer-engine
          ↑
@ofdrw/ofdrw-viewer-crypto
          ↑
@ofdrw/ofdrw-viewer-ui      @ofdrw/ofdrw-viewer-cli
```

- **engine 不得依赖 crypto**；不得 import `@ofdrw/ofdrw-viewer-crypto`，不得出现 SM2/SM3/SM4/ASN.1 验签代码。
- **crypto 不得依赖 ui/cli**；不得 import DOM、`node:*`、`fs`、`path`、`@napi-rs/canvas`。
- UI/CLI 可以依赖 engine + crypto；UI 的旧 ASN.1 展示代码迁移到 crypto 后不得再保留第二套验签实现。
- crypto 只通过 engine 的 `VirtualContainer`、`OFDDocument` 公共类型/API 与 engine 交互；不得访问 engine 的 `container/zip-reader` 内部模块。
- `pnpm` workspace 依赖使用 `workspace:^0.1.0`（UI/CLI 现有 engine 依赖保持 `workspace:*` 或统一 `^0.1.0`，以仓库当前约定为准）。

### 1.3 npm 依赖

| 依赖 | 版本 | 用途 | 浏览器/Node |
|---|---|---|---|
| `@ofdrw/ofdrw-viewer-engine` | `workspace:^0.1.0` | `VirtualContainer`、`OFDDocument`、`OFDError`、类型 | 同 engine |
| `sm-crypto` | `^0.5.7` | SM2 签名/验签/加解密、SM3、SM4、KDF 基础原语 | 纯 JS，Node ≥22 与浏览器均可；PoC 已验证 |
| `fflate` | `^0.8.3` | 纯 JS ZIP 解包/重打包/CRC | 纯 JS，无 Node API |
| `asn1js` | `^4.0.0` | BER/DER/CMS 结构解析（SES、SignedData、TSTInfo） | 纯 JS |
| `@peculiar/asn1-schema` | `^2.11.0` | ASN.1 schema 辅助 | 纯 JS |
| `@peculiar/asn1-x509` | `^2.11.0` | X.509 证书/DN/扩展解析 | 纯 JS |
| `saxes` | `^6.0.0` | `Encryptions.xml`/`Signature.xml`/`OFDEntries.xml` 严格 XML 解析 | 纯 JS，浏览器有 saxes 兼容构建 |

- 不新增 `node-forge`、`crypto-js`、`sm-crypto-v2` 等第二套密码库；SM 算法只经 `sm-crypto` 封装层调用。
- 不在 crypto 源码中使用 `Buffer`、`process`、`fs`、`path`；字节统一 `Uint8Array`，十六进制/Base64 用显式工具。
- UI 现有 `asn1js`/`@peculiar/*` 依赖在迁移完成后删除其直接使用；迁移期允许保留依赖但不能形成第二套验签路径。

### 1.4 浏览器/Node 兼容策略

- 代码目标 ES2022，`moduleResolution: Bundler`，严格 TS，`verbatimModuleSyntax`/`isolatedModules` 与 engine 一致。
- 不依赖 Node WebCrypto 之外的宿主 API；PBES2 私钥解密使用 `globalThis.crypto.subtle`（Node 22/浏览器均可用），不可用时抛 `CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION`。
- 浏览器 bundle 必须能用 esbuild 打成 IIFE，并在 Chromium 验证：SM2 解密、SM3 摘要、SM4-CBC、口令 KDF、SESv4/v5 验签、时间戳解析。
- Node 22 必须在无 `--experimental-*` 条件下运行全部单测/集成测试；Node 26 作为兼容复跑，不作为主门禁。
- `CryptoSource` 的 `byte-source` 接收 engine 公共 `ByteSource`：Node/CLI 用 `NodeFileByteSource` 基于 `fs.promises.open` 随机读取，不把整包读入内存；crypto 不 import `node:*`，也不关闭调用方字节源。浏览器优先 `blob`/`arraybuffer`，远程地址走 `url`；`blob`/`url` 依赖标准 `Blob`/`fetch`，Node 22 均提供。

## 2. Engine 虚拟容器（冻结）

### 2.1 公共接口

新增文件 `packages/ofdrw-viewer-engine/src/platform/virtual-container.ts`，并从 `src/index.ts` 导出：

```ts
/** 包内文件元数据；路径均为规范化包内路径，size 单位为 byte。 */
export interface VirtualFileMeta {
  /** 规范化包内路径：无前导 `/`、使用 `/`、无 `..`。 */
  readonly path: string;
  /** 解压/明文字节数，单位 byte。 */
  readonly size: number;
  /** 原始 ZIP 压缩后大小，单位 byte；合成容器可省略。 */
  readonly compressedSize?: number;
  /** ZIP 压缩方式；合成容器可省略。 */
  readonly compression?: 'stored' | 'deflate';
  /** 文件来源，供诊断；合成容器填 `decrypted`/`generated`。 */
  readonly origin?: 'package' | 'decrypted' | 'generated';
}

/** 容器读取选项；maxBytes 单位 byte。 */
export interface VirtualReadOptions {
  /** 本次读取的最大字节数；缺省使用容器打开时的上限。 */
  readonly maxBytes?: number;
  /** 取消信号；中止时抛 `OFD_ABORTED`。 */
  readonly signal?: AbortSignal;
  /** 校验/读取 warning 回调，不中断读取。 */
  readonly onWarning?: (warning: OFDWarning) => void;
  /** 是否校验 CRC/摘要，默认 true。 */
  readonly verifyChecksum?: boolean;
}

/** engine 的统一只读虚拟容器。 */
export interface VirtualContainer {
  /** 原始包字节数，单位 byte；加密包为加密源大小，解密容器保留原值。 */
  readonly packageSize: number;
  /**
   * 容器角色：`false` 为明文容器；`true` 为 raw package container。
   *
   * raw 容器的 `read()` 返回包内存仓原始字节（加密包可能是密文），只能用于
   * 检查/交给 crypto 解密；只有 `encrypted=false` 的明文容器可注入 engine。
   * crypto 解密容器固定为 false。
   */
  readonly encrypted: boolean;
  /** 文件元数据，按 path 升序；不含目录项。 */
  list(): readonly VirtualFileMeta[];
  /** 路径是否存在；路径先规范化。 */
  has(path: string): boolean;
  /** 读取元数据；不存在/非法路径返回 undefined。 */
  stat(path: string): VirtualFileMeta | undefined;
  /**
   * 按路径读取条目。
   *
   * 明文容器返回明文字节；raw 容器返回存仓原始字节，可能是密文。返回值归
   * 调用方所有。`options.signal` 取消时抛 `OFD_ABORTED`；engine 高层读取路径
   * 会合并宿主 signal 并透传，单个等待方取消不得中止其他调用方的共享加载。
   *
   * @param path 包内路径，先规范化后查找。
   * @param options 读取选项。
   * @returns 条目字节；明文容器为明文，raw 容器可能为密文。
   */
  read(path: string, options?: VirtualReadOptions): Promise<Uint8Array>;
  /** 幂等关闭；关闭后 read/list 抛 `OFD_CLOSED`。 */
  close(): Promise<void>;
}

/** 由宿主提供的容器工厂；source 的所有权转交给工厂，container.close 负责释放。 */
export type VirtualContainerFactory = (
  source: OFDSource,
) => Promise<VirtualContainer>;
```

语义冻结：

- `list()` 只返回文件，不含目录项；按 `path` 升序，路径规范化规则与 engine 现有 `normalizePackagePath` 一致。
- `packageSize` 是**原始包字节数**，不是解压后总和；解密容器必须保留加密源字节数，`DocumentMetadata.packageSize` 读取该值。
- 容器有两种角色：**raw package container**（`encrypted=true`，`read()` 返回存仓原始字节，加密包可能为密文，只能用于检查/解密）和**明文容器**（`encrypted=false`，`read()` 返回明文，可注入 engine）。
- 明文容器不得返回任何 `.dat` 密文或加密元数据；返回数组归调用方，调用方不得依赖容器内部缓存可变性。
- `has/stat` 对不存在/非法路径返回 false/undefined；不得抛路径穿越错误。
- `read()` 缺失条目抛 `OFD_ENTRY_NOT_FOUND`；超限抛 `OFD_LIMIT_EXCEEDED`；closed 抛 `OFD_CLOSED`；取消抛 `OFD_ABORTED`；未知压缩抛 `OFD_UNSUPPORTED_COMPRESSION`。
- `close()` 幂等、不抛错；关闭后 `list/read` 抛 `OFD_CLOSED`，`has/stat` 返回 false/undefined。
- `encrypted` 仅表达“容器内含未解密的 OFD 加密元数据”；默认 ZIP 容器以是否存在 `Encryptions.xml` 判断。crypto 解密容器固定 `false`。`OFDDocument.open` 对 `encrypted=true` 的注入容器抛 `OFD_ENCRYPTED`，提示先解密。

### 2.2 `OFDOpenOptions` 注入与所有权

`OFDOpenBaseOptions` 是 engine 既有公共基础选项（`documentIndex`/`limits`/字体/图片解码/渲染器/缓存/warning 等），完整定义见 [引擎设计 15 节](./OFD渲染引擎设计方案.md#151-设计)；本节只冻结 source/container 注入差异。

```ts
export interface OFDOpenOptions extends OFDOpenBaseOptions {
  /** 默认 ZIP 路径/容器工厂的字节来源；必填，保持既有调用类型兼容。 */
  source: OFDSource;
  /** 已构造好的明文容器；与 containerFactory 互斥。 */
  container?: VirtualContainer;
  /** 由 engine 调用并拥有的容器工厂；与 container 互斥，source 作为工厂输入。 */
  containerFactory?: VirtualContainerFactory;
}

/** 纯容器打开：直接注入已构造好的明文容器，不需要 source。 */
export interface OFDOpenFromContainerOptions extends OFDOpenBaseOptions {
  /** 宿主借用的明文容器；必须 encrypted=false 且 read() 返回明文。 */
  container: VirtualContainer;
  /** 可选宿主上下文；engine 不打开、不关闭。 */
  source?: OFDSource;
  /** 纯容器模式不使用工厂；需要工厂时改用 OFDOpenOptions。 */
  containerFactory?: never;
}

static open(options: OFDOpenOptions | OFDOpenFromContainerOptions): Promise<OFDDocument>;
```

规则：

1. `OFDOpenOptions` 的 `source` **必填**；`container`/`containerFactory` 可选，且二者只能出现一个，同时出现抛 `OFD_INVALID_PACKAGE`。纯容器调用使用 `OFDOpenFromContainerOptions`，其 `container` 必填、`source` 仅作上下文。
2. 无 `container`/`containerFactory` 时 engine 打开 `source` 并创建默认 ZIP 容器，行为与当前版本完全一致。
3. `containerFactory` 需要 `source`；工厂返回容器的所有权归 engine，`OFDDocument.close()`/打开失败时由 engine 调用 `container.close()`；source 由工厂/容器负责释放。
4. `container` 实例是**宿主借用**：engine 不关闭它；宿主必须在 `doc.close()` 后自行 `await container.close()`。宿主可在多个文档间复用同一容器（但并发读取由容器负责）。
5. `OFDOpenOptions` 中 `container` 与 `source` 同时出现时，engine 不打开 `source`，只使用容器的 `packageSize`/文件；source 仅作为宿主上下文，engine 不负责关闭。
6. 注入容器已关闭、`encrypted=true` 或缺少 `OFD.xml`/`Document.xml` 时分别抛 `OFD_CLOSED`/`OFD_ENCRYPTED`/`OFD_INVALID_PACKAGE`。
7. 默认 ZIP 容器由 engine 创建并拥有；`OFDDocument.close()` 先中止/等待渲染，再关闭容器，再释放字体/图片/渲染器。
8. `close()` 幂等；借用容器只清空 engine 引用，不调用其 `close()`。

### 2.3 默认 ZIP 容器

`packages/ofdrw-viewer-engine/src/container/zip-container.ts` 实现 `VirtualContainer`；公开构造器从 `api/container.ts` 导出：

```ts
export interface OpenZipVirtualContainerOptions {
  /** 资源限制覆盖；仅 ZIP 相关字段生效，未提供字段使用默认值，大小单位 byte。 */
  limits?: Partial<ResourceLimits>;
}

export function openZipVirtualContainer(
  source: OFDSource,
  options?: OpenZipVirtualContainerOptions,
): Promise<VirtualContainer>;
```

- 包装现有 `ByteSource` + `ZipReader`，不改变 ZIP 解析/安全规则；返回 **raw package container**，不是自动解密容器。
- 构造器拥有 `source`：成功后由 `container.close()` 释放；构造失败时关闭已打开的字节源。
- `packageSize = source.size`；
- `list()` 从 `ZipReader.listEntries()` 生成 `VirtualFileMeta`，按 path 升序；
- `has/stat` 使用 `ZipReader.getEntry()`；
- `read()` 使用 `ZipReader.readEntry(path, { maxBytes, onWarning, verifyCrc: verifyChecksum })`；返回存仓原始字节，加密包可能是密文；
- `close()` 关闭 `ZipReader` 并关闭 `ByteSource`；
- `encrypted` 在打开后检查 `hasEntry('Encryptions.xml')`；若为 true，`read()` 只用于检查/交给 crypto 解密，`OFDDocument.open` 在解析 XML 前抛 `OFD_ENCRYPTED`；明文包 `encrypted=false` 可直接注入 engine。

### 2.4 所有引擎读取路径必须经容器

以下路径全部从 `this.zip.readEntry(...)` 改为 `this.container.read(...)`，不得保留旁路：

| 读取对象 | 现有入口/方法 | 新调用 |
|---|---|---|
| `OFD.xml`、`Document.xml` | `readXmlEntry(zip, ...)` | `readXmlEntry(container, ...)` |
| 注释索引、资源 XML、页面 Content.xml | `readXmlEntry` / `loadPageInfo` / `loadTemplateArea` / `readXml` | `container.read` |
| 字体字节 | `loadFontBytes` | `container.read` |
| 图片资源 | `decodeImage` | `container.read` |
| 签名索引、`Signature.xml`、`Seal.esl`、`SignedValue.dat` | `loadSignatureBundle`/`readSignatureFile` | `container.read` |
| 附件 | `getAttachmentData` | `container.read` |
| 嵌套矢量章 OFD | 通过 `OFDDocument.open({ source: { kind:'arraybuffer', data } })` | 继续走默认 ZIP 容器；父文档的 `createCanvas` 继承规则不变 |
| 其他资源/缩略图/导出 | 任何 `zip.readEntry`/`ZipReader` 使用点 | `container.read` |

- `DocumentInit` 用 `container: VirtualContainer` 替换 `source/zip`；`OFDDocument` 只持有容器和可选 source 引用。
- `readXmlEntry` 等辅助函数的参数从 `ZipReader` 改为 `VirtualContainer`；`toZipLimits` 保留给默认容器构造。
- 打开前用 `container.has('OFD.xml')`/`stat` 做快速检查；错误仍映射 `OFD_INVALID_PACKAGE`。
- `metadata.packageSize` 改为 `container.packageSize`；无 source 的注入容器不再读 `source.size`。
- 现有 `getSignatureEntries`/`getSignedValue`/附件/字体/图片公开 API 的返回类型和行为不变。

### 2.5 资源限制、warning、错误与向后兼容

- 默认 ZIP 容器继续使用 `ResourceLimits` 的 package/entry/total/ratio 限制；crypto 容器使用同一 `VirtualReadOptions.maxBytes` 语义。
- 容器读取 `onWarning` 直接转发 engine 的 `WarningCollector`；不新增 engine warning 码。
- `OFD_ENCRYPTED` 是 engine 唯一新增的**行为路径**（已有错误码，不新增）；普通明文包行为、错误码、`packageSize`、页面渲染结果均不变。
- 现有 `OFDSource` 调用、`OFDOpenOptions.createCanvas/loadInput/encodeImage/renderer` 等全部保留；新字段可选，属于兼容增量。
- engine 的 import-boundary smoke 增加断言：`api/*` 不 import crypto；`container/*` 不 import crypto；crypto 不出现在 engine `package.json`。

## 3. Crypto 公共 API 与数据类型（冻结）

### 3.1 源、凭据、私钥、证书与限制

```ts
import type { ByteSource } from '@ofdrw/ofdrw-viewer-engine';

/**
 * crypto 支持的输入。
 *
 * Node/CLI 优先 `byte-source`：宿主提供随机访问字节源，crypto 按需读取 ZIP
 * 条目，不整包读入内存；`arraybuffer`/`blob`/`url` 保持兼容。
 */
export type CryptoSource =
  | {
      /** 内存字节；视图归调用方所有。 */
      readonly kind: 'arraybuffer';
      readonly data: ArrayBuffer | Uint8Array;
    }
  | {
      /** 浏览器 Blob/File；engine 按区间读取。 */
      readonly kind: 'blob';
      readonly blob: Blob;
    }
  | {
      /** 远程地址；`fetch` 流式读取整包，受 `maxSourceBytes` 限制。 */
      readonly kind: 'url';
      readonly url: string;
      readonly headers?: Record<string, string>;
    }
  | {
      /**
       * 宿主提供的随机访问源，必须实现 engine 公共 `ByteSource`。
       *
       * 调用方拥有并负责关闭（若实现有 close）；crypto 只读，不关闭它。
       */
      readonly kind: 'byte-source';
      readonly source: ByteSource;
    };

`ByteSource` 来自 `@ofdrw/ofdrw-viewer-engine` 公共导出，只要求 `size`（非负安全整数，单位 byte）与 `read(offset, length)`；crypto 不要求也不转发 `close`。

`byte-source` 语义：

- 宿主提供、调用方拥有：crypto 通过隔离视图读取，绝不对调用方字节源调用 `close`；CLI 在成功、失败、取消/SIGINT 后自行关闭 `NodeFileByteSource`。
- 按需读取：crypto 先按 `source.size` 做 `maxSourceBytes` 预检（不读取内容），再经 `openZipVirtualContainer({ kind:'custom' })` 读取 ZIP 中央目录和实际需要的条目，不整包 `readFile`。
- 所有权：`inspect`/`verifyOfd` 关闭内部打开的容器；`openDecryptingContainer` 对明文包返回 **source-backed** 容器，所有权转移给调用方；对加密包最终返回内存容器，并在返回前关闭内部源容器。
- 取消：`CryptoOptions.signal` 传到每次 `ByteSource.read`，取消抛 `CRYPTO_ABORTED`；字节源结构非法或 `read()` 返回非 `Uint8Array` 抛 `CRYPTO_SOURCE_UNSUPPORTED`，底层读取异常/包结构损坏按 `CRYPTO_INVALID_PACKAGE`，`size` 超限抛 `CRYPTO_LIMIT_EXCEEDED`。
- 浏览器不使用该分支：`arraybuffer`、`blob`、`url` 保持兼容；`url` 仍由 crypto 流式读取整包（受 `maxSourceBytes` 限制），不是随机访问。
- `byte-source` 不等于 engine `OFDSource.kind='node-file'`；crypto 不 import `node:fs`，Node 文件适配由宿主/CLI 完成。

/** SM2 私钥输入；pem/der 二选一。 */
export interface Sm2PrivateKeyInput {
  /** PKCS#8 PEM / SEC1 PEM；可含加密 PKCS#8 头。 */
  readonly pem?: string;
  /** PKCS#8 DER（未加密）；与 pem 互斥。 */
  readonly der?: Uint8Array;
  /** 加密 PKCS#8 口令；未加密 key 传了该值只产生 warning。 */
  readonly passphrase?: string;
}

export interface PasswordCredential {
  readonly kind: 'password';
  /** 对应 DecyptSeed/UserInfo@UserName；省略时仅在唯一匹配用户时自动选择。 */
  readonly userName?: string;
  readonly password: string;
}

export interface PrivateKeyCredential {
  readonly kind: 'private-key';
  /** 对应 UserInfo@UserName；省略时仅在唯一匹配用户时自动选择。 */
  readonly userName?: string;
  readonly privateKey: Sm2PrivateKeyInput;
}

export type CryptoCredential = PasswordCredential | PrivateKeyCredential;

/** X.509 证书 DER 字节；crypto 公共证书接口只接收该类型。 */
export type CertificateDer = Uint8Array;

/** 证书转换选项；字节类字段单位均为 byte。 */
export interface CertificatesToDerOptions {
  /** 原始输入与单张 DER 上限，单位 byte。 */
  readonly maxBytes?: number;
  /** 输出证书张数上限，单位张。 */
  readonly maxCertificates?: number;
}

/**
 * 入口转换：PEM/Base64/DER/CER（单张或拼接/多证书）→ 逐张 DER。
 *
 * crypto 核心不做格式探测，证书接口只接收 DER；UI/CLI 必须在调用
 * loadCertificates/loadCertificate 或 verifyOfd 前先经过本工具。
 *
 * @param input 原始输入（ArrayBuffer/Uint8Array 或 PEM/Base64 文本）。
 * @param options 大小与数量上限；`maxBytes` 单位 byte。
 * @returns 按输入顺序排列的每张证书 DER（调用方拥有所有权）。
 */
export function certificatesToDer(
  input: ArrayBuffer | Uint8Array | string,
  options?: CertificatesToDerOptions,
): readonly CertificateDer[];

/** 加密/验证资源上限；字节类字段单位均为 byte。 */
export interface CryptoLimits {
  /** 输入包上限，默认 256 MiB。 */
  maxSourceBytes: number;
  /** ZIP 条目数上限，默认 20,000。 */
  maxEntries: number;
  /** 单条目明文上限，默认 64 MiB。 */
  maxEntryBytes: number;
  /** 单层解压总量上限，默认 512 MiB。 */
  maxTotalDecryptedBytes: number;
  /** 最大压缩比，默认 200。 */
  maxCompressionRatio: number;
  /** 最大嵌套加密层数，默认 4。 */
  maxDecryptLayers: number;
  /** 单个 ASN.1 结构上限，默认 16 MiB。 */
  maxAsn1Bytes: number;
  /** ASN.1 最大嵌套深度，默认 64。 */
  maxAsn1Depth: number;
  /** 单次验证解析的证书总数上限，默认 32。 */
  maxCertificates: number;
  /** 信任根数量上限，默认 32。 */
  maxTrustRoots: number;
}

export const DEFAULT_CRYPTO_LIMITS: Readonly<CryptoLimits>;

/** 所有 crypto 公共入口共享的选项。 */
export interface CryptoOptions {
  readonly limits?: Partial<CryptoLimits>;
  readonly signal?: AbortSignal;
  readonly onWarning?: (warning: CryptoWarning) => void;
  /** SM2 签名 userId，默认标准值 `1234567812345678`；不从证书推导。 */
  readonly sm2UserId?: string;
  /** 校验证书有效期使用的当前时间，默认 `new Date()`；测试可注入。 */
  readonly now?: Date;
}
```

`DEFAULT_CRYPTO_LIMITS` 固定为：

```ts
{
  maxSourceBytes: 256 * 1024 * 1024,
  maxEntries: 20_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalDecryptedBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxDecryptLayers: 4,
  maxAsn1Bytes: 16 * 1024 * 1024,
  maxAsn1Depth: 64,
  maxCertificates: 32,
  maxTrustRoots: 32,
}
```

私钥解析规则：

- 未加密 PKCS#8 PEM/DER、SEC1 PEM 均支持；DER 只接受 PKCS#8。
- 加密 PKCS#8 PEM 仅支持 `PBES2 + PBKDF2(HMAC-SHA1/HMAC-SHA256) + AES-128/192/256-CBC`；PBKDF2 迭代次数 1..10,000,000，salt 8..64 byte，IV 16 byte。
- 其他 PBES2 算法（含 SM4-CBC PBES2）返回 `CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION`，不得静默尝试错误口令。
- 私钥必须落在 SM2 曲线 `sm2p256v1`；非 SM2/非 EC 返回 `CRYPTO_PRIVATE_KEY_INVALID`。
- 解析后的私钥字节只在本次调用内存中存在；不进入 result/report/warning/error message。

### 3.2 加密检测：`inspect`

```ts
export interface EncryptionUserInfo {
  readonly userName: string;
  /** 由 UserInfo 下是否存在 UserCert 判定，不依赖 EncryptCaseId。 */
  readonly method: 'password' | 'certificate' | 'unknown';
  /** 证书摘要；仅 method=certificate 时存在。 */
  readonly certificate?: CertificateSummary;
}

export interface EncryptionLayerInfo {
  /** 从 0 开始的层号。 */
  readonly layer: number;
  readonly id: string;
  readonly encryptDate?: string;
  readonly encryptScope?: string;
  readonly decryptSeedPath: string;
  readonly entriesMapPath: string;
  readonly users: readonly EncryptionUserInfo[];
}

export interface SignatureEntrySummary {
  readonly id: string;
  readonly type: string;
  readonly baseLoc: string;
  readonly signedValuePath?: string;
}

export interface OfdInspection {
  readonly encrypted: boolean;
  /** 原始包字节数，单位 byte。 */
  readonly packageSize: number;
  readonly entryCount: number;
  readonly ofdVersion?: string;
  /** 从外到内的加密层；明文为空数组。 */
  readonly layers: readonly EncryptionLayerInfo[];
  /** 全部层的用户去重视图。 */
  readonly users: readonly EncryptionUserInfo[];
  readonly signatures: readonly SignatureEntrySummary[];
  readonly integrityPresent: boolean;
  readonly warnings: readonly CryptoWarning[];
}

/**
 * 只读检测，不解密、不验证、不产出明文。
 *
 * @param source 输入包。
 * @param options 限制/取消/warning。
 * @returns 加密层、用户、签名摘要、完整性存在性。
 */
export function inspect(
  source: CryptoSource,
  options?: CryptoOptions,
): Promise<OfdInspection>;
```

`inspect` 规则：

- 无 `Encryptions.xml`：`encrypted=false`、`layers=[]`、`users=[]`；即使有 `OFDEntries.xml` 也只标记 `integrityPresent`。
- `Encryptions.xml` 中每个 `EncryptInfo` 产生一个 `EncryptionLayerInfo`；`DecryptSeedLoc`/`EntriesMapLoc` 缺省分别为 `/decryptseed.dat`、`/entriesmap.dat`，相对路径按包根解析。
- 解析 `decryptseed.dat` 的 `UserInfo`；有 `UserCert` 即 `method='certificate'`，无则 `'password'`；`EncryptCaseId` 忽略。
- 用户去重键为 `(userName, method, 证书指纹)`；重复用户名保留但报告 warning `W_CRYPTO_DUPLICATE_USER`。
- `ofdVersion` 从明文 `OFD.xml` 或解密前可读的 `OFD.xml` 读取；不可读则省略，不报错。
- `signatures` 从 `Signatures.xml` 只读摘要，不解析 `SignedValue.dat`；`integrityPresent` 以同时存在 `OFDEntries.xml` 与 `signedvalue.dat` 为准。
- 所有结构解析失败抛 `CryptoError`（码见 3.7）；不得返回半真半假的数据。
- 所有来源统一经 `openCryptoContainer`；`byte-source` 按需读取，`inspect` 在返回前关闭内部容器，但不关闭调用方字节源。

### 3.3 解密容器工厂：`openDecryptingContainer`

```ts
export interface DecryptionLayerSummary {
  readonly layer: number;
  readonly id: string;
  readonly user?: EncryptionUserInfo;
  /** 本层解密并还原的文件数。 */
  readonly decryptedEntries: number;
  /** 本层删除的加密元数据路径。 */
  readonly removedMetadata: readonly string[];
  /** entriesmap 的形态：加密/明文。 */
  readonly entriesMapMode: 'encrypted' | 'plaintext';
}

export interface DecryptingContainerResult {
  /** 明文容器；由 crypto 创建，所有权转移给调用方，调用方负责 close。 */
  readonly container: VirtualContainer;
  readonly inspection: OfdInspection;
  readonly plaintext: boolean;
  readonly layers: readonly DecryptionLayerSummary[];
  readonly warnings: readonly CryptoWarning[];
}

export interface OpenDecryptingContainerOptions extends CryptoOptions {
  readonly source: CryptoSource;
  /** 明文包可省略；加密包至少需要一个匹配凭据。 */
  readonly credentials?: CryptoCredential | readonly CryptoCredential[];
}

/**
 * 解出明文 VirtualContainer。
 *
 * @param options 源、凭据、限制/取消/warning。
 * @returns 明文容器与解密摘要；明文包原样透传。
 */
export function openDecryptingContainer(
  options: OpenDecryptingContainerOptions,
): Promise<DecryptingContainerResult>;
```

错误约定：

- 加密包但没有凭据 → `CRYPTO_CREDENTIALS_REQUIRED`。
- 凭据与 UserInfo 无匹配 → `CRYPTO_USER_NOT_FOUND`；多个候选且未指定 userName → `CRYPTO_USER_AMBIGUOUS`。
- 口令错误 → `CRYPTO_WRONG_PASSWORD`；私钥不匹配/无法解密 FEK → `CRYPTO_PRIVATE_KEY_MISMATCH`。
- entriesmap 无法解析/映射冲突/未列出 `.dat` → `CRYPTO_ENTRY_MAP_INVALID`。
- 层数超限 → `CRYPTO_DECRYPT_LAYER_LIMIT`；循环 → `CRYPTO_LAYER_LOOP`。
- 明文包 + 提供了凭据：忽略凭据并产生 warning `W_CRYPTO_CREDENTIAL_IGNORED`，返回 `plaintext=true`。

### 3.4 验证入口：`verifyOfd`

```ts
export interface VerifyOfdOptions extends CryptoOptions {
  /** 与 container 二选一；加密源会自动调用 openDecryptingContainer。 */
  readonly source?: CryptoSource;
  /** 已解密的容器；encrypted=true 时拒绝，要求先用 openDecryptingContainer。 */
  readonly container?: VirtualContainer;
  readonly credentials?: CryptoCredential | readonly CryptoCredential[];
  /** 信任根；空数组/省略 = 未配置，链状态 unknown。 */
  readonly roots?: readonly CertificateDer[];
  /** 只验证指定签名 ID；省略验证全部。 */
  readonly signatureIds?: readonly string[];
}

/**
 * 一次性验证完整性与文档签名；加密源内部解密，不单独暴露 decrypt。
 *
 * @param options 源/容器、凭据、根证书、限制。
 * @returns 分层验证报告。
 */
export function verifyOfd(options: VerifyOfdOptions): Promise<VerificationReport>;
```

约束：

- `source` 与 `container` 必须且只能提供一个；同时提供或都省略 → `CRYPTO_INVALID_ARGUMENT`。
- `container.encrypted=true` → `CRYPTO_CREDENTIALS_REQUIRED`（提示先 `openDecryptingContainer`），不在 verify 内二次解密任意容器。
- 加密 `source` 且无凭据 → `CRYPTO_CREDENTIALS_REQUIRED`；内部调用 `openDecryptingContainer` 并关闭临时明文容器（只读过程中不关闭）。
- 验证顺序不影响结果：先解析完整性，再逐个签名；每个子项独立捕获错误并记录 `issues`，最终由 5.7 聚合。
- 不打开 Canvas/字体/渲染器；只使用 `VirtualContainer.list/read` 和轻量 XML/ASN.1 解析。

### 3.5 解析 API

```ts
export interface ParseOptions {
  /** 输入字节上限，默认 maxAsn1Bytes，单位 byte。 */
  readonly maxBytes?: number;
  /** ASN.1 嵌套深度上限，默认 64。 */
  readonly maxDepth?: number;
}

export interface SealPictureInfo {
  readonly type: string;                 // 例如 PNG/GIF/SVG
  readonly widthMm: number;              // 显示宽度，单位 mm
  readonly heightMm: number;             // 显示高度，单位 mm
  readonly dataLength: number;           // 图片数据长度，单位 byte
  readonly data: Uint8Array;             // 原始图片字节，调用方只读
}

export interface ParsedSeal {
  readonly version: 'v1' | 'v4' | 'v5' | 'unknown';
  readonly esId?: string;
  readonly name?: string;
  readonly typeCode?: number;
  readonly createDate?: string;
  readonly validStart?: string;
  readonly validEnd?: string;
  readonly makerCertificate?: CertificateSummary;
  /** 签章者证书列表摘要（CertListType=1 时可得）。 */
  readonly certificates?: readonly CertificateSummary[];
  /** 签章者证书杂凑值（CertListType=2 时可得，小写十六进制）。 */
  readonly certificateDigests?: readonly string[];
  /** 印章图片信息；无图片节点时省略。 */
  readonly picture?: SealPictureInfo;
  /** 是否包含制章人签名（仅结构判断，不代表验签通过）。 */
  readonly hasSignature: boolean;
  /** 时间戳解析结果（只解析不验证）。 */
  readonly timestamp: TimestampParseResult;
  /** 解析期 warning，例如 W_CRYPTO_SEAL_PICTURE_INVALID；不影响印章签名结论。 */
  readonly warnings: readonly VerificationIssue[];
  /** 原始结构字节长度；不向调用方暴露私钥/证书 PEM。 */
  readonly byteLength: number;
}

export interface ParsedSignedValue {
  readonly version: 'v1' | 'v4' | 'v5' | 'unknown';
  readonly certificate?: CertificateSummary;
  readonly signatureAlgorithm?: string;
  readonly signedAt?: string;
  readonly dataHash: string;             // 小写十六进制；非空
  readonly seal?: ParsedSeal;
  readonly timestamp: TimestampParseResult;
  readonly byteLength: number;
}

/** 只解析电子印章；不验签、不查链。 */
export function parseSeal(data: Uint8Array, options?: ParseOptions): ParsedSeal;

/** 只解析 SignedValue.dat；不验签、不查链。 */
export function parseSignedValue(data: Uint8Array, options?: ParseOptions): ParsedSignedValue;

/** 只解析时间戳；不验证 TSA 签名，固定 parsed-not-verified。 */
export function parseTimestamp(data: Uint8Array, options?: ParseOptions): TimestampParseResult;
```

`parseSeal`/`parseSignedValue` 对错误输入抛 `CRYPTO_ASN1_INVALID`/`CRYPTO_UNSUPPORTED_SES_VERSION`；不会把解析成功表述为验证通过。`parseTimestamp` 的 `parse-error` 不抛异常，便于 UI 展示“不可解析”。`ParsedSeal.warnings` 只承载图片缺失/损坏等解析期问题，不改变 `hasSignature`；图片问题使用 `W_CRYPTO_SEAL_PICTURE_INVALID`。

内部 X.509 解析结果 `X509Certificate` 保留 `subjectDer`/`issuerDer` 原始 Name DER TLV，用于按 DER 构建/匹配证书链；公开展示用 `CertificateSummary` 不包含这两个原始字节。两者都不得在错误/日志中输出私钥或 PEM。

### 3.6 VerificationReport 及子结果

```ts
export type VerificationStatus =
  | 'valid'
  | 'invalid'
  | 'unknown'
  | 'not-applicable'
  | 'unsupported';

export type ChainStatus =
  | 'valid'
  | 'invalid'
  | 'expired'
  | 'not-yet-valid'
  | 'untrusted'
  | 'incomplete'
  | 'unsupported'
  | 'not-present'
  | 'unknown';

export type TimestampStatus = 'parsed-not-verified' | 'not-present' | 'parse-error';

export interface CertificateSummary {
  readonly subject: string;
  readonly issuer: string;
  readonly serialNumber: string;
  readonly notBefore: string;   // ISO 8601
  readonly notAfter: string;    // ISO 8601
  readonly fingerprintSha256: string;
  readonly publicKeyAlgorithm?: string;
  readonly signatureAlgorithm?: string;
  readonly keyUsage?: readonly string[];
  readonly isCA: boolean;
}

export interface VerificationIssue {
  readonly code: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
  readonly path?: string;
}

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

export interface ReferenceFailure {
  readonly fileRef: string;
  readonly reason: 'missing' | 'mismatch' | 'unsupported';
}

export interface ReferenceCheckResult {
  readonly status: VerificationStatus;
  readonly total: number;
  readonly checked: number;
  readonly failures: readonly ReferenceFailure[];
}

export interface SignatureMathResult {
  readonly status: VerificationStatus;
  readonly algorithm?: string;
  readonly sm2UserId: string;
}

export interface SealVerification {
  readonly status: VerificationStatus;
  readonly version: 'v1' | 'v4' | 'v5' | 'unknown';
  readonly esId?: string;
  readonly name?: string;
  readonly eslPath?: string;
  /** Seal.esl 与 TBS_Sign 内嵌 SESeal 的 DER 字节一致；仅解析/比较，不等于验签。 */
  readonly matchesSignedValue: boolean;
  readonly math: SignatureMathResult;
  readonly certificate: CertificateChainVerification;
  /** 印章时间戳解析（只解析不验证，不参与 overall）。 */
  readonly timestamp: TimestampParseResult;
  readonly issues: readonly VerificationIssue[];
}

export interface TimestampParseResult {
  readonly status: TimestampStatus;
  readonly tokenPresent: boolean;
  readonly tokenLength: number;
  readonly version?: number;
  readonly policy?: string;
  readonly serialNumber?: string;
  readonly genTime?: string;          // ISO 8601
  readonly hashAlgorithm?: string;
  readonly messageImprint?: string;   // 小写 hex
  readonly nonce?: string;            // 小写十六进制，可选
  readonly tsa?: CertificateSummary;
  /** 仅比较 messageImprint 与签章签名值；不验证 TSA 签名。 */
  readonly messageImprintMatchesSignature?: boolean;
  readonly parseError?: VerificationIssue;
  /** 固定文案，UI 必须原样展示。 */
  readonly note: '已解析，未验证';
}

export interface SignatureVerification {
  readonly id: string;
  readonly type: string;
  readonly version: 'v1' | 'v4' | 'v5' | 'unknown';
  readonly baseLoc: string;
  readonly signedValuePath?: string;
  readonly status: VerificationStatus;
  readonly signature: SignatureMathResult;
  readonly dataHash: {
    readonly expected?: string;
    readonly actual?: string;
    readonly status: VerificationStatus;
  };
  readonly references: ReferenceCheckResult;
  readonly certificate: CertificateChainVerification;
  readonly seal?: SealVerification;
  readonly timestamp: TimestampParseResult;
  readonly issues: readonly VerificationIssue[];
}

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

export interface VerificationReport {
  readonly overall: VerificationStatus;
  readonly package: PackageVerificationInfo;
  readonly decryption?: DecryptionReportInfo;
  /** 无 OFDEntries/signedvalue 时为 null，不伪造 valid。 */
  readonly integrity: IntegrityVerification | null;
  readonly signatures: readonly SignatureVerification[];
  readonly rootsConfigured: boolean;
  readonly warnings: readonly CryptoWarning[];
  readonly startedAt: string;   // ISO 8601
  readonly durationMs: number;
}
```

`overall` 聚合固定规则（5.7 详述）：

- 任一项 `invalid` → `invalid`；
- 无 `invalid`，但任一项 `unknown`（含未配置根）→ `unknown`；
- 没有任何 integrity/signature → `not-applicable`；
- 仅有 `unsupported` → `unsupported`；
- 其余全部 `valid` → `valid`。
- `timestamp` 永不参与 `overall`；`seal`/`chain` 参与各自 signature 的 status。
- `integrity === null` 表示包内没有同时存在 `OFDEntries.xml` 与 `signedvalue.dat`，即**未受保护**；不得把它写成“完整性通过”，是否保护看 `package.integrityPresent`。
- 未配置信任根（`roots` 省略/空）时，`rootsConfigured=false`；无明确错误时链状态 `unknown`，不得返回 `valid`。配置了根但缺 issuer/中间证书为 `incomplete`，终点不是配置根为 `untrusted`。
- 时间戳状态固定 `parsed-not-verified`/`not-present`/`parse-error`；`note` 固定“已解析，未验证”，任何 UI/CLI 不得显示“时间戳有效/可信时间”。

### 3.7 CryptoError、warning 与错误分类

```ts
export type CryptoErrorCode =
  // 输入/API
  | 'CRYPTO_INVALID_ARGUMENT'
  | 'CRYPTO_CREDENTIALS_REQUIRED'
  | 'CRYPTO_SOURCE_UNSUPPORTED'
  | 'CRYPTO_LIMIT_EXCEEDED'
  | 'CRYPTO_ABORTED'
  // 包/加密结构
  | 'CRYPTO_INVALID_PACKAGE'
  | 'CRYPTO_NOT_ENCRYPTED'
  | 'CRYPTO_UNSUPPORTED_ENCRYPTION'
  | 'CRYPTO_ENTRY_MAP_INVALID'
  | 'CRYPTO_DECRYPT_FAILED'
  | 'CRYPTO_DECRYPT_LAYER_LIMIT'
  | 'CRYPTO_LAYER_LOOP'
  // 凭据
  | 'CRYPTO_USER_NOT_FOUND'
  | 'CRYPTO_USER_AMBIGUOUS'
  | 'CRYPTO_WRONG_PASSWORD'
  | 'CRYPTO_PRIVATE_KEY_INVALID'
  | 'CRYPTO_PRIVATE_KEY_PASSPHRASE_REQUIRED'
  | 'CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION'
  | 'CRYPTO_PRIVATE_KEY_MISMATCH'
  // ASN.1/验证
  | 'CRYPTO_ASN1_INVALID'
  | 'CRYPTO_UNSUPPORTED_SES_VERSION'
  | 'CRYPTO_UNSUPPORTED_ALGORITHM'
  | 'CRYPTO_CERTIFICATE_INVALID'
  | 'CRYPTO_TRUST_ROOT_INVALID'
  | 'CRYPTO_INTEGRITY_INVALID'
  | 'CRYPTO_SIGNATURE_INVALID'
  | 'CRYPTO_TIMESTAMP_PARSE';

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;
  readonly cause?: unknown;
}

export function isCryptoError(value: unknown): value is CryptoError;
```

错误分类与调用方处理：

| 分类 | 码 | UI/CLI 处理 |
|---|---|---|
| 参数/生命周期 | `CRYPTO_INVALID_ARGUMENT`、`CRYPTO_ABORTED`、`CRYPTO_LIMIT_EXCEEDED` | 不重试；显示/退出 1 或 130 |
| 凭据 | `CRYPTO_CREDENTIALS_REQUIRED`、`CRYPTO_USER_*`、`CRYPTO_WRONG_PASSWORD`、`CRYPTO_PRIVATE_KEY_*` | 弹窗重试；CLI 退出 4 |
| 包/解密 | `CRYPTO_INVALID_PACKAGE`、`CRYPTO_UNSUPPORTED_ENCRYPTION`、`CRYPTO_ENTRY_MAP_INVALID`、`CRYPTO_DECRYPT_FAILED`、`CRYPTO_DECRYPT_LAYER_*`、`CRYPTO_LAYER_LOOP` | 不可重试；CLI 退出 2/4 |
| ASN.1/校验 | `CRYPTO_ASN1_INVALID`、`CRYPTO_UNSUPPORTED_SES_VERSION`、`CRYPTO_UNSUPPORTED_ALGORITHM`、`CRYPTO_CERTIFICATE_INVALID`、`CRYPTO_TRUST_ROOT_INVALID` | 验证报告子项；必要时 CLI 退出 5 |
| 结果 | `..._INTEGRITY_INVALID`、`..._SIGNATURE_INVALID`、`..._TIMESTAMP_PARSE` | 通常不抛，写入 report issues；若入口无法产出报告才抛 |

`CryptoWarning` 码冻结：

```ts
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
```

安全约束：

- `CryptoError.message` 不包含口令、私钥、PEM 内容、`EncryptedWK` 原文；只包含路径/用户名/算法等诊断信息。
- `CryptoError.cause` 不得包装含密钥的原始对象；ASN.1 异常只保留类型/偏移。
- `VerificationReport`/`OfdInspection`/`CryptoWarning`/日志不出现口令或私钥；口令/私钥仅作为调用栈内的局部变量。
- 不把 `ArrayBuffer`/`Uint8Array` 密钥写入 `console`、`onWarning`、`onError`、DOM 属性或 localStorage。
## 4. 解密算法与流程（冻结）

### 4.1 入口与总体流水线

```text
CryptoSource
  → openCryptoContainer
       ├─ arraybuffer / blob / byte-source
       │    → openZipVirtualContainer（按需读取中央目录与条目）
       └─ url → fetch 流式读取整包（maxSourceBytes）
  → 读取 Encryptions.xml
       ├─ 不存在：source-backed 明文容器（encrypted=false）→ 返回
       └─ 存在：LazyEntryStore 按需读取 decryptseed/entriesmap/待解条目
            → DecryptSeedLoc（默认 /decryptseed.dat）→ UserInfo 列表
            → 凭据匹配（UserName + UserCert 类型）
            → 恢复 FEK/IV（口令 KDF 或 SM2 私钥）
            → EntriesMapLoc（默认 /entriesmap.dat）→ Entry(Path,EPath)
            → 每项 SM4-CBC/PKCS#7 解密并映射为明文路径
            → 删除加密元数据，得到本层明文条目
            → 若仍有 Encryptions.xml：进入下一层
  → MemoryVirtualContainer（encrypted=false；加密包）
```

- 加密解密在内存中完成，不使用临时目录/临时文件；`source-backed` 明文容器不复制包体，关闭时只释放内部 ZIP 容器。
- `arraybuffer`/`blob`/`byte-source` 只读取 ZIP 所需的中央目录与条目；`url` 为兼容既有语义整包流式读取。任何来源都不写临时明文文件。
- ZIP 路径必须使用严格规范化：`\`→`/`、去前导 `/`、拒绝 `..`、拒绝空段、拒绝大小写碰撞（同一包内路径视为大小写敏感，但警告重复 key）。
- 不信任 `entriesmap.dat` 自报的路径；解密前校验映射路径是否穿越、是否重复、是否覆盖元数据。
- 任何一步失败都不返回部分明文容器，避免 UI 展示半解密文档。

### 4.2 `Encryptions.xml`

解析 `ofd:Encryptions` 下每个 `ofd:EncryptInfo`：

- `@ID`：层 ID；缺失时用序号 `layer-<n>`。
- `Provider`：仅诊断，不参与算法选择。
- `EncryptDate`/`EncryptScope`：展示/诊断；`EncryptScope` 不用于跳过条目，实际范围由 entriesmap 决定。
- `DecryptSeedLoc`：默认 `/decryptseed.dat`；按包根规范化；支持相对路径。
- `EntriesMapLoc`：默认 `/entriesmap.dat`；按包根规范化。

安全上限：`EncryptInfo` 数量 ≤ `maxDecryptLayers`（默认 4）；超过即 `CRYPTO_DECRYPT_LAYER_LIMIT`，不尝试继续。

### 4.3 `DecyptSeed` 与 `UserInfo`

解析 `ofd:DecyptSeed`（注意 ofdrw 实际 XML 元素拼写为 `DecyptSeed`，不能改成 `DecryptSeed`）：

- 每个 `UserInfo@UserName` 对应一个候选用户。
- 有 `UserCert` 子元素 → `method='certificate'`；无 → `method='password'`；不使用 `EncryptCaseId`。
- `IVValue`、`EncryptedWK` 先按 Base64 严格解码；Base64 非法/长度非法 → `CRYPTO_INVALID_PACKAGE`。
- 一个 `DecyptSeed` 可以有多个 `UserInfo`；同一用户可重复但必须对应同一证书指纹，否则 warning `W_CRYPTO_DUPLICATE_USER`。
- `UserInfo` 可以跨 `EncryptInfo` 出现；实际匹配只在当前层进行。

### 4.4 凭据匹配

对每层：

1. 若调用方指定 `userName`：只保留同名 `UserInfo`；无 → `CRYPTO_USER_NOT_FOUND`。
2. 未指定 `userName`：
   - 只有一个与凭据类型兼容的 `UserInfo` → 使用；
   - 多个 → `CRYPTO_USER_AMBIGUOUS`，要求调用方明确用户名；
   - 零个 → `CRYPTO_USER_NOT_FOUND`。
3. 类型兼容：
   - `PasswordCredential` 只匹配无 `UserCert` 的 `UserInfo`；
   - `PrivateKeyCredential` 只匹配有 `UserCert` 的 `UserInfo`。
4. 多凭据输入按顺序尝试；只有“凭据与 UserInfo 匹配但 FEK 解不开”才继续下一个；若全部失败：
   - 单候选口令失败 → `CRYPTO_WRONG_PASSWORD`；
   - 单候选私钥失败 → `CRYPTO_PRIVATE_KEY_MISMATCH`；
   - 多候选全部失败 → `CRYPTO_DECRYPT_FAILED`（内部码，归入 `CRYPTO_INVALID_PACKAGE` 分类展示，不泄露哪个用户名/口令错误）。
5. 用户不存在与口令错误必须分开：前者 `USER_NOT_FOUND`，后者 `WRONG_PASSWORD`；不要在 message 中回显口令。

### 4.5 口令 KDF 与 FEK 解包

- 口令按 UTF-8 编码为字节，**不做 Unicode 归一化**；空口令拒绝（`CRYPTO_CREDENTIALS_REQUIRED`）。
- `KEK = KDF(SM3, passwordBytes, 16)`，遵循 GB/T 32918.3：

```text
ct = 1, 2, ...（32 位无符号大端）
block = SM3(Z || I2OSP(ct, 4))
KDF(Z, klen) = (block_1 || block_2 || ...) 截断到 klen 字节
klen = 16
```

- 计数器从 1 开始，`I2OSP` 固定 4 byte 大端；拼接顺序不可反；`klen=16` 只需一个 block，但仍按标准实现以便复用。
- 若派生结果全 0，按 GB/T 32918.3 重新取下一 block（实现上循环最多 2 次；仍全 0 则 `CRYPTO_CREDENTIALS_REQUIRED`）。
- `FEK = SM4-CBC-Decrypt(EncryptedWK, key=KEK, iv=IVValue, padding=PKCS#7)`；输出必须正好 16 byte；否则 `CRYPTO_WRONG_PASSWORD`（不泄露 padding 细节）。
- FEK 只用于本层；多层每层独立恢复，禁止复用上一层 FEK。

### 4.6 SM2Cipher 与私钥恢复 FEK

`UserCert` 用户的 `EncryptedWK` 是 DER：

```text
SM2Cipher ::= SEQUENCE {
  X          INTEGER,
  Y          INTEGER,
  HASH       OCTET STRING SIZE(32),   -- C3
  CIPHERTEXT OCTET STRING             -- C2
}
```

- DER 解析必须按长度边界读取，整数去前导零但保留正值；X/Y 必须落在 `sm2p256v1` 曲线；C3 必须 32 byte；C2 非空且受 `maxAsn1Bytes` 限制。
- 转 C1C3C2：`C1 = 0x04 || X(32) || Y(32)`，再拼 `C3 || C2`；**不使用首字节判断是否已有 04**，只按结构补/去前缀（R8）。
- 使用 `sm-crypto` 的 C1C3C2 模式（mode 1）解密，私钥为 32-byte 标量；输出 16-byte FEK。
- 私钥匹配失败（点不在曲线、解密 MAC/哈希失败、输出非 16 byte）统一 `CRYPTO_PRIVATE_KEY_MISMATCH`；不得把底层异常原文直接透出。
- SM2 签名验签使用标准 userId `1234567812345678`（可通过 `CryptoOptions.sm2UserId` 覆盖）；SM2 加解密不依赖 userId，不得把 userId 混入 C1C3C2 计算。

### 4.7 `entriesmap.dat` 与 SM4 文件解密

- 先尝试用本层 FEK/IV 做 SM4-CBC 解密：
  - 若 PKCS#7 合法且结果可被严格 XML 解析 → `entriesMapMode='encrypted'`；
  - 否则把原始字节按 UTF-8 XML 解析 → `entriesMapMode='plaintext'`，warning `W_CRYPTO_ENTRIES_MAP_PLAINTEXT`；
  - 两者都失败 → `CRYPTO_ENTRY_MAP_INVALID`。
- 解析 `Entries/Entry`：
  - `Path`：明文目标路径（可能带前导 `/`），规范化后作为输出路径；
  - `EPath`：密文条目实际路径；必须存在于 ZIP；
  - 二者均不可为空；`Path` 不得穿越/重复/覆盖 `Encryptions.xml`/`decryptseed.dat`/`entriesmap.dat`。
- 每个 `EPath` 读取后 SM4-CBC 解密：
  - 密文长度必须是 16 的倍数且 ≥16；
  - PKCS#7 去掉 1..16 个相同填充字节，非法 → `CRYPTO_ENTRY_MAP_INVALID`（该条目失败即整层失败）；
  - 输出路径使用 `Path`，不按 `EPath` 推导（R16）。
- 未列入 entriesmap 的条目：
  - 加密元数据（`Encryptions.xml`、`decryptseed.dat`、`entriesmap.dat`、`*.dat`）删除；
  - 非 `.dat` 且非元数据的条目按原字节复制，warning `W_CRYPTO_ENTRY_MAP_INVALID`（兼容外部工具生成的混合包）；
  - 未列出的 `.dat` 一律整层失败，不能把密文当明文交给 engine。
- `Path`/`EPath` 大小写、Unicode 规范化原样保留；输出容器按规范化路径排序，重复路径直接失败。
- `entriesmap.dat` 本身若被加密，必须先解出 XML 才能继续；不得把其密文写入结果。

### 4.8 多重加密与循环

- 每层输出一个新的内存条目表；若仍有 `Encryptions.xml`，继续下一层。
- 层数计数从 1 开始，超过 `maxDecryptLayers` → `CRYPTO_DECRYPT_LAYER_LIMIT`。
- 循环检测键 = `(Encryptions.xml 字节的 SHA-256, decryptseed.dat 字节的 SHA-256, entriesmap.dat 密文字节 SHA-256)`；重复键 → `CRYPTO_LAYER_LOOP`。
- 每层必须至少删除一个加密元数据条目；否则该层未取得进展，按循环/无效处理（`CRYPTO_LAYER_LOOP`）。
- 多层凭据可以不同；调用方传 credential 数组，按 4.4 每层独立匹配。任一必需层无法匹配 → 整个操作失败，不返回部分结果。
- 成功解开超过 1 层时产生 warning `W_CRYPTO_MULTI_LAYER`，不改变成功结果。
- 不允许在解密过程中递归调用 `openDecryptingContainer`；使用单一循环，避免栈/资源失控。

### 4.9 明文透传、`packageSize` 与元数据隔离

- 无 `Encryptions.xml`：直接返回 **source-backed** 的原始 ZIP 容器（`encrypted=false`、`read()` 为明文），不逐条复制、不整包读取；`plaintext=true`、`layers=[]`；容器所有权转移给调用方，调用方负责 `close()`。
- 加密包：逐层解密后构造 `MemoryVirtualContainer`，删除加密元数据，`plaintext=false`；内部源容器在返回前关闭，不泄漏文件句柄。
- `packageSize` 始终等于原始 `CryptoSource` 字节数；source-backed 与内存容器都不改变该值，解密后不得变成解压总量。
- 输出容器的 `list()` 不包含：`Encryptions.xml`、`decryptseed.dat`、`entriesmap.dat`、任何加密 `.dat`；`stat/has` 对这些路径返回 false。
- 输出容器 `encrypted=false`；`OFDDocument.open({ container })` 可直接读取 `OFD.xml` 并渲染。
- 若解密后仍缺 `OFD.xml`/`Document.xml`，由 engine 报 `OFD_INVALID_PACKAGE`；crypto 不伪造 OFD 结构。

### 4.10 解密错误矩阵（固定）

| 条件 | 错误/行为 |
|---|---|
| 明文包 + 无凭据 | 成功，`plaintext=true` |
| 明文包 + 凭据 | 成功，warning `W_CRYPTO_CREDENTIAL_IGNORED` |
| 加密包 + 无凭据 | `CRYPTO_CREDENTIALS_REQUIRED` |
| 用户名不存在 | `CRYPTO_USER_NOT_FOUND` |
| 用户名匹配多个且未指定 | `CRYPTO_USER_AMBIGUOUS` |
| 口令错误/KEK 解包失败 | `CRYPTO_WRONG_PASSWORD` |
| 私钥无法解 FEK | `CRYPTO_PRIVATE_KEY_MISMATCH` |
| 私钥加密格式不支持 | `CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION` |
| entriesmap 缺失/非法/映射冲突 | `CRYPTO_ENTRY_MAP_INVALID` |
| 层数 > 4 | `CRYPTO_DECRYPT_LAYER_LIMIT` |
| 层循环/无进展 | `CRYPTO_LAYER_LOOP` |
| 取消 | `CRYPTO_ABORTED` |
| 输入/解压超限 | `CRYPTO_LIMIT_EXCEEDED` |

## 5. 验证算法与流程（冻结）

### 5.1 总流程

```text
明文 container
  → 读取 Signatures.xml（如存在）
  → 完整性：OFDEntries.xml + signedvalue.dat
  → 对每个 Signature.xml：
       Reference CheckValue（SM3）
       → SignedValue.dat 解析（SES v1/v4/v5）
       → dataHash 校验
       → TBS_Sign SM2 验签
       → Seal.esl 与内嵌 SESeal 比较
       → 证书链/有效期/信任根
       → 时间戳仅解析
  → 聚合 overall
```

- 所有 XML/ASN.1 都从明文容器读取；不解密、不渲染。
- `Signatures.xml` 不存在不等于失败：`signatures=[]`，由 `integrity` 决定是否 `not-applicable`/`valid`。
- 每个签名/完整性独立捕获异常；单个签名损坏不影响其他签名报告，但 `overall` 会按 5.7 变为 invalid/unknown。
- `Signature.xml` 的原始字节用于 `dataHash` 与 Reference，不允许重新序列化后计算。

### 5.2 `Signature.xml` 与 Reference CheckValue

- 路径：`Signatures.xml` 的 `Signature@BaseLoc` 相对于 `Signatures.xml` 所在目录解析；`Signature` 下的 `SignedValue@BaseLoc`、`Seal@BaseLoc` 相对于 `Signature.xml` 目录解析。
- Reference：`Reference@FileRef` 支持绝对包路径和相对路径；规范化后从容器读取。
- 算法：
  - `CheckMethod` 接受 `SM3`（不区分大小写）和 OID `1.2.156.10197.1.401`；
  - 其他值 → `W_CRYPTO_REFERENCE_UNSUPPORTED`，该 Reference 记 `unsupported`，签名整体 `invalid`（无法证明未篡改）；
  - `CheckValue = SM3(fileBytes)`；ofdrw 实际写 **Base64**（如 `dZe//wtYxOnhT0xdDVP9Jrlt5CDVtz8znMua33hcEbE=`），必须按 Base64 解码后比较 32 byte 摘要；同时兼容 64 字符十六进制历史样例。空值、Base64/hex 非法或长度不符 → failure。
- 引用文件缺失 → `reason='missing'`；摘要不符 → `reason='mismatch'`。
- Reference 数量与 `checked` 必须精确：`checked = total - failures - unsupported`；不能只检查第一个。
- `dataHash`：计算 `SM3(Signature.xml 原始字节)`，与 `TBS_Sign.dataHash` 比较；不一致直接 `dataHash.status='invalid'`，不进入签名成功分支。
- `Signature.xml` 自身被篡改通常会导致 `dataHash` 不匹配；即使外层 `TBS` 签名值仍能验证，整体也 invalid。

### 5.3 SES v1/v4/v5 解析与 TBS_Sign 验签

版本识别顺序：

1. 解析 `SES_Signature` 顶层 SEQUENCE 元素数与首元素 `TBS_Sign.version`；
2. 按版本选择字段布局，不按“顶层元素数”单独硬编码：
   - **v1**：`SEQUENCE { TBS_Sign, signature BIT STRING }`；证书与签名算法在 `TBS_Sign` 内，`signature` 在顶层；
   - **v4/v5**：`SEQUENCE { TBS_Sign, cert OCTET STRING, signatureAlgID AlgorithmIdentifier, signature BIT STRING, [0] timeStamp OPTIONAL }`；
   - `TBS_Sign` 含 `version/eseal/timeInfo/dataHash/propertyInfo`（v4/v5 `cert`/`signatureAlgID` 在顶层，v1 在 TBS 内）。
3. 字段编码按版本读取：v1 的 `timeInfo`/`dataHash` 接受 `BIT STRING` 或 `OCTET STRING`（兼容 ofdrw `TBS_Sign` 构造器），v4/v5 的 `timeInfo` 为 `GeneralizedTime`、`dataHash` 为 `BIT STRING`；时间仅用于展示/报告，不参与签名计算的二次序列化。
4. `signature` 必须是 BIT STRING；去掉 unused bits 后作为 SM2 签名 DER。
5. `propertyInfo` 路径必须指向当前 `Signature.xml`（规范化比较）；不一致记 `invalid`（防替换）。
6. 验签：
   - 算法 OID 必须为 SM3withSM2（`1.2.156.10197.1.501`）；其他 → `unsupported`；
   - 签名为 DER `SEQUENCE { INTEGER r, INTEGER s }`；
   - 对 **TBS_Sign 的 DER 原始字节** 做 SM3withSM2 验签，userId 默认标准值，可由 `sm2UserId` 覆盖；
   - 签名值长度/整数范围非法 → `CRYPTO_ASN1_INVALID`/invalid。
7. `version` 不在 1/4/5，或结构不符合任一布局 → `CRYPTO_UNSUPPORTED_SES_VERSION`，`SignatureVerification.status='unsupported'`，不猜测字段。

`Seal.esl`：

- 从 `Signature.xml` 的 `Seal@BaseLoc` 读取；与 `TBS_Sign.eseal` 的 DER 字节做**逐字节比较**；
- 不一致 → `SealVerification.status='invalid'`，`matchesSignedValue=false`；
- `Seal.esl` 自身用制章者证书验签（v1/v4/v5 各自的 `SES_SignInfo`/`signedValue` 位置），证书链按 5.4；制章者证书缺失 → `incomplete`/`unknown`，不伪造有效；
- 印章图片/矢量内容只解析展示，不参与验签；解析失败仅 warning，不影响印章签名结论。

### 5.4 证书链、信任根、有效期与 KeyUsage

- 输入：`roots?: CertificateDer[]`；每个 root 必须是 DER 编码的合法 X.509，否则 `CRYPTO_TRUST_ROOT_INVALID`（整个 verify 入口失败）。PEM/Base64/CER 必须先经 `certificatesToDer` 在入口转换。
- 链构建：
  1. 从签名者/制章者证书开始；
  2. 从 `SES_Signature`/`SESeal` 内嵌证书 + 完整性 `SignedData.certificates` + roots 中寻找 issuer 匹配的 CA；
  3. 验证子证书签名（SM3withSM2）；
  4. 直到遇到与 roots 中某证书**DER 字节完全相等**的证书，作为 trust anchor；
  5. 最多 8 跳，检测 issuer/subject 循环；
  6. 中间 CA 必须 `BasicConstraints.cA=true`，`pathLenConstraint` 满足；KeyUsage（若存在）必须含 `keyCertSign`。
- 状态（`ChainStatus`）：
  - `not-present`：无签名者证书；
  - `valid`：链到配置根、全部证书在 `now` 有效期、KeyUsage 满足；
  - `expired` / `not-yet-valid`：任一证书有效期不满足；
  - `untrusted`：链能建但终点不在 roots；
  - `incomplete`：缺 issuer/中间证书；
  - `unsupported`：证书签名算法不是 SM3withSM2 或结构不支持；
  - `unknown`：**未配置 roots**（`roots` 省略/空）且证书结构/有效期/签名等已通过，仅信任锚无法判定；未配置 roots 不会掩盖已发现的 `expired`/`not-yet-valid`/`invalid`/`incomplete`；
  - `invalid`：签名校验失败/KeyUsage 明确不满足/其他结构错误。
- 有效期使用 `CryptoOptions.now`（默认当前时间），ISO 8601 输出带时区；边界按 `notBefore <= now <= notAfter`。
- 信任根配置后必须重新做完整验证；不得缓存“上次 valid”覆盖新根。未配置根时产生 warning `W_CRYPTO_TRUST_UNKNOWN`，链状态 unknown。
- CRL/OCSP 固定 `revocation:'not-checked'`；不把“未吊销”写成有效结论。
- 签名者 KeyUsage：若扩展存在，必须含 `digitalSignature` 或 `nonRepudiation`；不存在时按 X.509 语义允许，但产生 warning `W_CRYPTO_KEY_USAGE_MISSING`（加入 warning 码清单）。
- 证书 subject/issuer 只做展示，不用字符串匹配决定链；以 DER/公钥/签名关系为准。

### 5.5 防夹带完整性（GB/T 35275）

- 定位：
  - `OFDEntries.xml` 与 `signedvalue.dat` 默认在包根；也接受 `/OFDEntries.xml`、`/signedvalue.dat` 规范化匹配。
  - 只有同时存在才视为 `integrityPresent=true`；缺一个 → `IntegrityVerification=null` 或 `not-present`，不伪造 valid。
- 解析 `signedvalue.dat`：
  - `ContentInfo` 的 contentType 允许 GB/T 35275 SignedData（`1.2.156.10197.6.1.4.2.2`）与 PKCS#7 SignedData（`1.2.840.113549.1.7.2`）；内层 `data` 的 OID 为 `1.2.156.10197.6.1.4.2.1`，只作结构校验；
  - 解析 `SignedData.version/digestAlgorithms/encapContentInfo/certificates/signerInfos`；
  - `digestAlgorithms` 必须含 SM3（`1.2.156.10197.1.401`）；`SignerInfo.digestAlgorithm` 必须为 SM3；签名算法接受 `1.2.156.10197.1.301.1`（SM2 签名）与 `1.2.156.10197.1.501`（SM3withSM2），两者都按“对摘要做 SM2 签名”验证；
  - `eContent` 为 OCTET STRING；标准 ofdrw 生成器内容为 `SM3(OFDEntries.xml)` 32 byte；
  - `authenticatedAttributes` 可选：检测 `contentType`、`messageDigest`、`signingTime`（PKCS#9）；
  - 无 authAttrs：直接对 `eContent` 做 SM3withSM2 验签；
  - 有 authAttrs：对 DER `SET OF Attribute` 原始字节验签，并校验 `messageDigest == SM3(eContent)`；`contentType` 必须匹配 SignedData；两级都通过才 valid。
- 文件清单：
  - `OFDEntries.xml` 的 `FileList/File@FileLoc`（以及 ofdrw 兼容的 `Entries/Entry@Path`）规范化；
  - 实际文件 = 容器 `list()` 去掉 `OFDEntries.xml`、`signedvalue.dat`（以及可选的签名索引元数据？签名文件仍在清单中时不能豁免）；
  - `missingFiles` = 清单有、实际无；
  - `extraFiles` = 实际有、清单无；额外文件是**防夹带失败**，不能 warning 了事；
  - 两侧都为空才 `status='valid'`（在签名/链也 valid 的前提下）。
- 防夹带签名证书链：使用 5.4；未配置根 → `unknown`，但 `signature.status` 仍可 `valid`，`IntegrityVerification.status='unknown'`。
- `OFDEntries.xml` 自身被篡改会导致摘要/签名失败；`signedvalue.dat` 被替换会导致签名/链失败；两者都必须 invalid，不能只看 FileList。

### 5.6 时间戳：仅解析，不验证

时间戳位置：`SES_Signature` 的 `[0] timeStamp`（BIT STRING）或 `SES_SealInfo` 内时间戳字段；按外层 ContentInfo 解出 TSTInfo。

解析字段（GMT 0033-2014 / RFC 3161 TSTInfo）：

```text
version INTEGER
policy OID
messageImprint { hashAlgorithm, hashedMessage }
serialNumber INTEGER
genTime GeneralizedTime (UTC)
accuracy { seconds, millis, micros } OPTIONAL
ordering BOOLEAN DEFAULT FALSE
nonce INTEGER OPTIONAL
tsa [0] GeneralName OPTIONAL
extensions [1] OPTIONAL
```

- 外层 ContentInfo OID 接受 GM/T 0010 与 PKCS#7；不硬编码单一 OID（R11）。
- 校验 `messageImprint.hashedMessage == SM3(SES 签名值)`，仅作为结构一致性提示；**不验证 TSA SignedData 签名、不验证 ESSCertID、不验证策略链、不验证 TSA 证书有效性**。
- 状态固定：
  - 无时间戳：`not-present`；
  - 可解析：`parsed-not-verified`，即使 imprint 不匹配也仍是 `parsed-not-verified`，另给 `messageImprintMatchesSignature=false` 和 warning `W_CRYPTO_TIMESTAMP_IMPRINT_MISMATCH`；
  - 解析失败：`parse-error` + `parseError`，warning `W_CRYPTO_TIMESTAMP_PARSE`；
- `note` 固定为 `已解析，未验证`；UI 不得显示“时间戳有效/可信时间”。
- 时间戳不参与 `overall`，不影响证书有效期判断（不能用时间戳时间替代当前时间）。

### 5.7 状态聚合

对每个签名：

- `signature.status`：TBS 签名数学结果（valid/invalid/unsupported）。
- `references.status`：全部 Reference 通过才 valid；任一 missing/mismatch → invalid；任一 unsupported → unsupported。
- `certificate.status`：5.4 结果。
- `seal.status`：印章签名 + 印章链 + 与 SignedValue 匹配；无印章节点 → `not-applicable`。
- 单个 `SignatureVerification.status`：任一项 invalid → invalid；否则任一项 unknown → unknown；否则任一项 unsupported → unsupported；否则 valid。
- `ChainStatus` 映射：`valid` → valid；`unknown` → unknown；`unsupported` → unsupported；`expired`/`not-yet-valid`/`untrusted`/`incomplete`/`invalid`/`not-present` → invalid（缺证书/过期/不可信不能当作“未配置根”）。
- `IntegrityVerification.status`：签名/清单/链任一 invalid → invalid；否则 unknown → unknown；否则 unsupported → unsupported；否则 valid。
- `overall`：按 3.6 聚合；无签名/完整性 → `not-applicable`。
- `signature` 存在但证书缺失（`not-present`）→ invalid；`timestamp` 无 TSA 证书不影响 overall。
- 时间戳状态不向 `overall` 提升；UI 单独展示。
## 6. UI 交互设计（冻结）

### 6.1 新增选项与公共方法

`packages/ofdrw-viewer-ui/src/options.ts` 追加可选字段，旧调用完全兼容：

```ts
/** 根证书来源；对齐 FontInput 的 data/url/path/filePath 四态。 */
export type CertificateSource =
  | { readonly data: ArrayBuffer | Uint8Array; readonly name?: string }
  | { readonly url: string; readonly headers?: Record<string, string>; readonly name?: string }
  | { readonly path: string; readonly name?: string }
  | { readonly filePath: string; readonly name?: string };

/**
 * 宿主证书加载器；path/filePath 由宿主平台实现，Web 默认不支持。
 * 返回原始字节（可含 PEM/Base64/多证书），由 UI 经 certificatesToDer 转为 DER。
 */
export type CertificateInputLoader = (
  source: CertificateSource,
) => Uint8Array | ArrayBuffer | null | Promise<Uint8Array | ArrayBuffer | null>;

export interface CryptoViewerOptions extends CryptoOptions {
  /** 是否启用密码能力；默认 true。 */
  readonly enabled?: boolean;
  /** 预置凭据；提供时不弹内置登录框。 */
  readonly credentials?: CryptoCredential | readonly CryptoCredential[];
  /** 无预置凭据时是否弹登录框；默认 true。 */
  readonly autoPrompt?: boolean;
  /** 初始信任根；默认 []，即 unknown。 */
  readonly rootCertificates?: readonly CertificateSource[];
  /** path/filePath/url 根证书字节加载器。 */
  readonly certificateLoader?: CertificateInputLoader;
  /** 打开成功后是否自动验证；默认 true。 */
  readonly autoVerify?: boolean;
  /** 验证完成回调；不得在其中记录凭据。 */
  readonly onVerification?: (report: VerificationReport) => void;
  /** 自定义凭据获取；返回 null 表示取消。 */
  readonly onCredentialRequired?: (
    inspection: OfdInspection,
  ) => Promise<CryptoCredential | null>;
}

export interface OFDViewerOptions {
  // ...既有字段...
  readonly crypto?: CryptoViewerOptions;
}
```

`OFDViewer` 新增方法/事件：

```ts
/** 重新验证当前文档；无文档时以 OFD_NOT_OPENED 拒绝。 */
verify(options?: {
  readonly signatureIds?: readonly string[];
  readonly signal?: AbortSignal;
}): Promise<VerificationReport>;

/** 当前文档最近一次验证报告；未验证/已关闭时 undefined。 */
getVerificationReport(): VerificationReport | undefined;

/** 设置/替换信任根并重新验证；返回解析后的证书摘要。 */
setRootCertificates(
  roots: readonly CertificateSource[],
): Promise<readonly CertificateSummary[]>;

getRootCertificates(): readonly CertificateSummary[];

/** 验证完成事件。 */
on('verificationcompleted', (report: VerificationReport) => void): () => void;
```

新增 `ViewerFeature`：`'verification'`，默认 enabled；关闭时工具栏入口隐藏/禁用，调用 `verify()` 抛 `OFD_FEATURE_DISABLED`。`crypto.enabled=false` 时加密文档打开失败为 `OFD_CRYPTO_UNSUPPORTED`，明文文档仍按原行为。

新增 UI 错误码：

```ts
type ViewerErrorCode =
  | ...既有...
  | 'OFD_CRYPTO_CREDENTIAL_REQUIRED'
  | 'OFD_CRYPTO_CANCELLED'
  | 'OFD_CRYPTO_UNSUPPORTED'
  | 'OFD_CRYPTO_FAILED';
```

### 6.2 打开加密文档的流程

```text
viewer.open(source)
  → inspect(source)
      ├─ 明文：OFDDocument.open({ source, ... })
      └─ 加密且 crypto.enabled：
           ├─ crypto.credentials 预置 → openDecryptingContainer
           ├─ autoPrompt=false 且无预置 → reject OFD_CRYPTO_CREDENTIAL_REQUIRED
           ├─ onCredentialRequired 定制 → 等待宿主返回凭据/取消
           └─ 内置登录弹窗 → 收集凭据
                → openDecryptingContainer
                   ├─ 失败：保持弹窗，显示错误，允许重试/取消
                   └─ 成功：OFDDocument.open({ container: result.container, ... })
                         → autoVerify ? verifyOfd({ container, roots }) : 等待工具栏
  → documentopen / verificationcompleted
```

- 检测阶段是只读的；`inspect` 失败按 `OFD_CRYPTO_FAILED`（cause 为 CryptoError）上报。
- 登录弹窗不关闭源文档；若当前已有文档且用户取消，保留旧文档并回到 `ready`，不进入 `error`。
- 首次打开取消：状态 `closed/idle`，`open()` 以 `OFD_CRYPTO_CANCELLED` 拒绝；`onError` 不记录凭据。
- 解密容器在 `doc.close()` 后由 UI 关闭；engine 借用容器，不负责关闭（见 2.2）。
- `autoVerify=false` 时打开成功但不自动验证；工具栏面板显示“未验证”，点击后验证。
- 验证失败不影响文档打开；只影响验证面板/事件。

### 6.3 登录弹窗

内置弹窗字段：

| 区域 | 字段 | 规则 |
|---|---|---|
| 用户 | 用户名 | 来自 `inspection.users`；单选/可编辑；默认唯一用户；多用户必须选择 |
| 口令 | 口令 | `type=password`；UTF-8；不显示明文；空值禁用提交 |
| 私钥 | 私钥文件 | `.pem/.der/.key/.pk8`；`FileReader` 读成 `Uint8Array`；不把内容放入状态 |
| 私钥 | 口令 | 可选；仅加密 PKCS#8 使用；`type=password` |
| 操作 | 重试/取消 | 失败保留用户选择；错误显示在 `aria-live` 区域；Esc 取消 |

- 用户切换时清空口令/私钥/口令口令，防止把 A 的凭据用于 B。
- 提交期间禁用按钮并显示 loading；取消应中止 `inspect`/`openDecryptingContainer` 的 `AbortSignal`。
- 错误文案映射：`WRONG_PASSWORD` →“口令错误或用户不匹配”；`PRIVATE_KEY_*` →“私钥无法用于该用户”；不输出底层密文/密钥。
- 弹窗关闭时把口令/私钥字符串/数组置空，移除文件引用；不写 localStorage/sessionStorage/cookie。
- 主机 `onCredentialRequired` 返回凭据时，UI 不落盘；返回 null 等同取消。
- 无障碍：`role=dialog`、`aria-modal=true`、`aria-labelledby`/`aria-describedby`；焦点落在用户选择；Tab 焦点陷阱；Esc=取消；错误用 `role=alert`；不只用颜色区分错误。

### 6.4 工具栏验证面板

- 工具栏新增“验证”按钮（盾牌/勾选图标 + 文本），位置在签章按钮附近；`features.verification=false` 时按 featureDisplay 隐藏/禁用。
- 打开面板后显示：
  - 顶部 overall 徽标：`valid`/`invalid`/`unknown`/`not-applicable`/`unsupported`，颜色 + 文字 + 图标，不能只靠颜色；
  - 包信息：加密层/是否解密、页数、签名数、完整性是否存在；
  - 完整性卡片：签名状态、FileList 数量、缺失/额外文件、证书链、根证书状态；
  - 每个签名卡片：ID/类型/SES 版本、dataHash、Reference 通过数、数学签名、证书链、印章、时间戳；
  - 时间戳行固定显示 `parsed-not-verified` +“已解析，未验证”+ genTime/TSA/policy/serial（缺失显示“无”）；
  - 根证书区：当前根摘要；未配置时明确“未配置根证书，证书链状态 unknown”，提供“配置根证书”；
  - “重新验证”按钮；验证中禁用并显示进度；`AbortSignal` 取消。
- 面板状态来源 `viewer.verify()`/`getVerificationReport()`；打开文档后 `autoVerify` 自动填充。
- 验证失败不弹阻塞错误；在面板卡片内列出 `issues`，`onError` 只在入口异常时触发。
- 根证书变更后清空旧报告并重新验证；不把旧 valid 与新根混用。
- 面板用语义化标题/列表/表格；`aria-live=polite` 播报 overall 变化；焦点不因自动验证移动。

### 6.5 印章点击浮层

- 复用现有签章覆盖层（`StampAnnot.Boundary/Clip`）与 `signatureclick` 事件；覆盖层仍是可聚焦 `button`，`aria-label` 包含印章名/签名者/页。
- 点击流程：
  1. 若当前报告无该 signatureId，先 `verify({ signatureIds:[id] })`；
  2. 打开锚定在印章位置的 popover（键盘/触摸可用），展示该签名的 overall、数学签名、Reference、证书链、印章、时间戳；
  3. 提供“查看完整验证面板”按钮；popover 关闭后焦点回到印章按钮。
- 无验证能力（feature 关闭/crypto.enabled=false）时点击仍可打开原有签章详情，但固定显示“未验证”，不得复用旧 valid 报告。
- 印章图片/矢量章渲染仍由 engine 提供；crypto 只消费 `Seal.esl`/`SignedValue` 字节做验证，不改变页面绘制。
- 多个印章重叠时按现有 z-order/点击命中规则；不新增隐式热点。

### 6.6 根证书配置

- 来源：构造选项 `crypto.rootCertificates` + `setRootCertificates()` + 验证面板“配置根证书”。
- 支持 `data`（File/ArrayBuffer）、`url`、`path`、`filePath` 四态；解析规则对齐 `FontInput`：
  - `data` 直接使用；
  - `url` 默认 `fetch`（带 `headers`），失败 → `W_CRYPTO_CERT_SOURCE_UNSUPPORTED`；
  - `path`/`filePath` 必须由宿主 `certificateLoader` 提供；Web 默认不支持，给 warning，不阻塞文档；
  - loader 返回 `null` → 跳过该根并 warning；抛错 → 包装 `OFD_CRYPTO_FAILED`。
- 文件选择接受 `.pem/.der/.cer`；读取到的原始字节统一经 `certificatesToDer` 转换为 DER，再传给只接收 DER 的 crypto 证书接口。PEM 可包含多证书，DER/CER 可为单证书或拼接 DER；同一文件重复导入按 DER 指纹去重。
- **边界约定：crypto 公共证书接口只收 DER，格式转换只发生在 UI/CLI 入口工具。**
- 解析失败/非 X.509 → 该根忽略 + warning；全部根失败时 `rootsConfigured=false`，链状态 unknown。
- 根证书只用于验证信任锚，不自动成为文档签名证书；不写入文档、不上传网络。
- 配置根后重新验证；UI 显示根 subject/指纹/有效期；不显示私钥。
- 未配置根：`rootsConfigured=false`，签名链 `unknown`；配置正确根后应变为 `valid`（fixture `certs/root-ca.crt.pem`）。
- 无障碍：文件输入有 label；错误/成功状态 `role=status`；根列表可键盘删除；不因颜色变化隐藏状态。

### 6.7 UI 安全与生命周期

- `DocumentState` 不新增口令/私钥字段；`source`/`metadata`/`signaturesSummary` 保持非敏感。
- 事件 `verificationcompleted` 只传报告；报告无凭据/私钥/PEM。
- `destroy()` 关闭验证服务、取消进行中的验证、清空根证书缓存、关闭解密容器；不保留密码引用。
- 打印/导出/查找等既有功能使用 engine 的明文容器，不感知加密；导出文件名不带凭据。
- 日志/console 不打印 `CryptoSource` 原始字节、ASN.1 私钥、`EncryptedWK`；错误 `cause` 只在内部使用。
- UI 只调用 crypto 公共 API；UI 不再保留 `SignedValue`/`Seal` 的 ASN.1 解析器，展示数据来自 crypto 的 `parseSignedValue`/`parseSeal` 与 `VerificationReport`；不得直接 import `sm-crypto`/`asn1js` 做解析或验签。

## 7. CLI 设计（冻结）

### 7.1 命令语法

保留现有“无子命令 = 转图片”的行为：

```text
ofdrw-viewer-cli <input.ofd> [既有转图片选项] [加密凭据选项]

ofdrw-viewer-cli info <input.ofd> [--json]

ofdrw-viewer-cli verify <input.ofd> [加密凭据选项] [--root <file>]... [--sm2-user-id <id>] [--json]
```

加密凭据选项（`verify` 与转图片共用）：

```text
--user <name>              指定 UserInfo@UserName
--password <password>      口令（仅 password 用户）
--key <path>               SM2 私钥文件（PEM/DER/PKCS#8）
--key-passphrase <text>    加密 PKCS#8 口令（可选）
```

- `info` **不接受** `--user/--password/--key/--key-passphrase/--root`；出现即用法错误（1），明确“info 只查询，不解密/不验证”。
- `verify` 的 `--root` 可重复；CLI 读取文件原始字节后经 `certificatesToDer` 转为 DER，再传给只接收 DER 的 `verifyOfd`。支持 PEM/DER/CER（PEM 可多证书）；无 root = unknown。
- 不提供 `decrypt` 子命令；`ofdrw-viewer-cli decrypt ...` 固定用法错误（1），提示“请使用 verify 或带凭据的转图片命令”。
- 子命令识别：第一个位置参数严格等于 `info` 或 `verify` 时进入子命令；文件名恰好为 `info`/`verify` 时用 `./info` 规避，文档明确。
- 凭据不打印；`--password`/`--key-passphrase` 的 shell 历史/进程列表风险在帮助中提示；CLI 自身不记录 argv。

### 7.2 `info`（只查询）

语义：读取包结构/加密用户/签名摘要，不解密、不验签、不读私钥。

文本输出示例：

```text
文件: /abs/input.ofd
大小: 17210 B
OFD 版本: 1.0
加密: 是（1 层）
用户: fixture-password-user (password)
签名: 1
完整性: 有
```

`info --json` 固定结构：

```ts
interface CliInfoJson {
  readonly command: 'info';
  readonly input: string;            // 绝对路径
  readonly packageSize: number;      // byte
  readonly ofdVersion?: string;
  readonly encrypted: boolean;
  readonly layers: readonly EncryptionLayerInfo[];
  readonly users: readonly EncryptionUserInfo[];
  readonly signatureCount: number;
  readonly integrityPresent: boolean;
  readonly warnings: readonly CryptoWarning[];
}
```

- 加密包也退出 0（查询成功），即使没有凭据；不输出 `EncryptedWK`/口令/私钥。
- 包结构非法/无法读取 → 退出 2；`info` 不因“未配置根/未验签”失败。
- `info` 不得调用 `openDecryptingContainer`/`verifyOfd`；实现只允许 `inspect`。
- 明文包 `encrypted=false`、`layers/users=[]`。

### 7.3 `verify`（一次性完整性+签名）

语义：若输入加密，先用凭据解密（内部临时容器），再一次性执行完整性 + 全部签名 + 链/印章/时间戳解析。不提供独立解密命令。

文本输出：

```text
验证结果: valid | invalid | unknown | unsupported | not-applicable
完整性: valid (FileList 12, 缺失 0, 额外 0)
签名 1: valid (SESv4, 引用 5/5, 证书链 valid)
  时间戳: parsed-not-verified（已解析，未验证）(2026-10-22T17:48:26Z)
根证书: 已配置 1 / 链 unknown
```

`verify --json` 固定结构：

```ts
interface CliVerifyJson {
  readonly command: 'verify';
  readonly input: string;            // 绝对路径
  readonly report: VerificationReport;
}
```

- `--json` 即使结果为 invalid/unknown 也输出完整 JSON，然后按 7.5 返回非 0。
- 无签名/无完整性 → `overall=not-applicable`，退出 5。
- 根未配置 → 链 `unknown`，`overall=unknown`，退出 5；这是预期安全状态，不是 bug。
- 口令错误/用户不匹配/私钥错误 → 退出 4，不输出密码/私钥。
- 验证器内部错误（如畸形 ASN.1）按 3.7 生成 report 子项；若入口无法产出 report，退出 2/4。

### 7.4 既有转图片命令支持加密文档

```text
ofdrw-viewer-cli encrypted.ofd -o out --user fixture-password-user --password FixturePass123
ofdrw-viewer-cli encrypted.ofd -o out --user fixture-cert-user --key certs/encrypt.key.pem
```

- 流程：`inspect` → 若加密，`openDecryptingContainer` → `OFDDocument.open({ container })` → 既有页面导出。
- 未提供凭据/凭据错误：不进入渲染，退出 4；不输出任何页。
- 明文文档行为/输出命名/页码/DPI/文本导出/字体参数完全不变。
- `--root` 不参与渲染，转图片不接受该参数（避免误以为渲染会验签）；需要验证时使用 `verify`。
- 转换失败的错误码映射：包/解密 4；文档结构 2；页级 3；SIGINT 130；usage 1。

### 7.5 输出、退出码与错误边界

| 退出码 | 语义 | 适用 |
|---|---|---|
| 0 | 成功 | 转图片全部成功；info 查询成功；verify `overall=valid` |
| 1 | 用法/参数错误 | 未知参数、`decrypt`、info 带凭据、缺少输入 |
| 2 | 文档级失败 | 非 OFD、包损坏、无法打开、转图片文档级失败 |
| 3 | 页级失败 | 转图片至少一页失败且至少一页成功（既有语义） |
| 4 | 加密/凭据失败 | 缺少凭据、用户名不存在、口令/私钥错误、解密失败、层循环 |
| 5 | 验证未通过 | verify 的 invalid/unknown/unsupported/not-applicable |
| 130 | 用户中断 | SIGINT/AbortSignal |

- `info` 成功固定 0；`verify` 只有 `overall=valid` 才 0，`unknown` 也 5。
- 所有输出不包含口令、私钥、PEM、`EncryptedWK`；错误消息不含凭据。
- `--json` 输出写 stdout；进度/错误写 stderr；不混合。
- 无独立 `decrypt`；`verify`/转图片内部的解密不是公开命令，不产生明文文件。

## 8. 样例、测试与验收

### 8.1 已提交夹具清单

路径：`packages/ofdrw-viewer-crypto/test/fixtures/crypto/`；SHA-256 以 `manifest.sha256` 校验为准。

| case | 文件 | 大小（byte） | 预期 |
|---|---|---:|---|
| plain | `plain.ofd` | 5,226 | 明文可打开；解密基准 |
| password-encrypted | `password-encrypted.ofd` | 17,210 | 口令解密后与 plain 内容一致 |
| cert-encrypted | `cert-encrypted.ofd` | 17,850 | `certs/encrypt.key.pem` 解密后一致 |
| signed-sesv4 | `signed-sesv4.ofd` | 9,444 | SESv4 签名 valid；时间戳 parsed-only；配根 valid / 无根 unknown |
| signed-sesv5 | `signed-sesv5.ofd` | 9,447 | SESv5 签名 valid；时间戳 parsed-only；配根 valid / 无根 unknown |
| integrity | `integrity.ofd` | 6,310 | 完整性 valid；无夹带 |
| combined-signed-integrity | `combined-signed-integrity.ofd` | 10,570 | 签名+完整性 valid |
| combined-password-encrypted | `combined-password-encrypted.ofd` | 27,956 | 解密后签名+完整性 valid |
| negative-tampered-content | `negative-tampered-content.ofd` | 9,113 | 签名 invalid |
| negative-tampered-signedvalue | `negative-tampered-signedvalue.ofd` | 9,112 | 签名 invalid |
| negative-tampered-signature | `negative-tampered-signature.ofd` | 9,112 | 签名 invalid |
| negative-extra-file | `negative-extra-file.ofd` | 6,270 | 完整性 invalid（夹带） |

- 测试证书/私钥：`certs/{root-ca,signer,encrypt,seal,tsa}.crt.pem/.crt.der/.key.pem/.key.der`，共 20 文件；root/signer/encrypt 必须覆盖。
- 凭据：password `fixture-password-user` / `FixturePass123`；cert `fixture-cert-user` + `certs/encrypt.key.pem`。
- 信任：`certs/root-ca.crt.pem`；未配置根 = unknown；`manifest.json.trust` 明确。
- 公开策略：全部为测试材料，README/manifest 标注 `testOnly`；禁止用于生产；私钥不设口令，任何拿到仓库的人可用。
- manifest：`schemaVersion=1`、`cases` 12、`certs` 20、`manifest.sha256` 32 行；所有路径存在且 SHA-256 匹配；单文件 <5MB、总计 <20MB（当前 137,620B）。

### 8.2 校验

```bash
# 校验已提交夹具的 SHA-256
(cd packages/ofdrw-viewer-crypto/test/fixtures/crypto && sha256sum -c manifest.sha256)
```

- 原生成/校验脚本已随 `scripts/` 目录移除；夹具字节与 `manifest.sha256` 已固化提交。
- 重新生成需使用 ofdrw 2.4.0 公开 API，并同步更新 manifest，测试不得硬编码随机哈希。
- 过期/未生效证书不在二进制夹具中，由单元测试在内存中生成确定性证书覆盖；不提交过期私钥。
- 双层加密/循环/超大包等极端输入由测试内合成 ZIP，不新增静态大文件。

### 8.3 测试策略与门禁

| 层 | 覆盖 | 门禁 |
|---|---|---|
| crypto unit | KDF 向量、SM4-CBC/PKCS#7（含坏填充）、SM2Cipher DER/C1C3C2、PKCS#8/SEC1/PBES2、SES v1/v4/v5、Reference CheckMethod、authAttrs、时间戳 TSTInfo、链状态、FileList 夹带、错误码/limits | 100% 通过；无跳过（除明确平台条件） |
| crypto integration | 12 夹具逐项对照 manifest；错误口令/用户不存在/不匹配私钥；无根 unknown、配根 valid；组合解密后验签/完整性；负例必须失败 | `verify-fixtures.sh` 退出 0；所有 expected 匹配 |
| engine | VirtualContainer 单测、默认 ZIP 行为、借用/拥有容器关闭、OFD_ENCRYPTED、所有读取路径经容器、既有测试全绿 | engine 既有测试 + 新增测试通过；import boundary 通过 |
| UI | 加密打开（口令/私钥）、错误重试、取消、工具栏面板、印章点击浮层、根证书 data/url/path/filePath、未知→有效、无障碍、无秘密 | Playwright e2e 全通过；无跳过；截图/断言可复跑 |
| CLI | info 文本/JSON、verify 文本/JSON 与退出码、加密转图片、错误口令、无凭据、无根 unknown、`decrypt` 拒绝 | CLI 单测/acceptance 全通过；退出码逐项断言 |
| browser | esbuild IIFE + Chromium：SM 算法、解密、验签、时间戳解析 | 无 Node 内建依赖；浏览器断言全通过 |
| 文档 | 本文 + CONTRACTS + 各 README/skills/设计/CLI/测试/验收 | 文档链接可解析、grep 门禁通过、无未决项 |

安全测试：

- 口令/私钥/PEM/`EncryptedWK` 不出现在 stdout/stderr、异常 message、`onWarning`、DOM 文本、localStorage；用 grep/对象快照断言。
- 路径穿越、重复条目、ZIP bomb、超大 ASN.1、深层嵌套、错误 Base64、空 IV、坏 PKCS#7 均有失败用例。
- 解密不产生临时文件；关闭后明文容器不可读。
- 取消/关闭与验证并发不产生未处理 rejection。

### 8.4 验收门槛

1. `pnpm typecheck` 全 workspace 通过。
2. engine 既有测试全通过；新增 VirtualContainer 测试全通过；import boundary 证明 engine 不依赖 crypto。
3. crypto 单元/集成全通过，12 fixture expected 与 manifest 一致；`verify-fixtures.sh` 退出 0。
4. UI e2e 覆盖 6.2–6.6 全部交互，全部通过；无凭据/密码泄露。
5. CLI `info`/`verify`/加密转图片 acceptance 全通过；退出码 0/1/2/4/5/130 断言。
6. 浏览器 bundle 与 Node 22 全通过。
7. 所有文档同步完成，根 README 有模块入口，CONTRACTS 有本模块章节。

## 9. 文档同步计划

### 9.1 新包 README（参照 engine README 章节结构）

`packages/ofdrw-viewer-crypto/README.md` 固定章节：

1. 标题 + npm/license/Node badges；
2. `## ✨ 功能概述`：inspect/解密/验证/时间戳只解析；
3. `## 📦 安装`：`npm install @ofdrw/ofdrw-viewer-crypto`；
4. `## ⚡ 快速开始`：`inspect` → `openDecryptingContainer` → `OFDDocument.open({container})` → `verifyOfd`；
5. `### 支持的平台`：浏览器/Node 22/小程序限制；
6. `## 📚 文档`：engine/UI/CLI/设计/CONTRACTS；
7. `## 🤖 Agent Skill 与 API 参考`：`skills/SKILL.md`、`skills/API.md`；
8. `## 🛠️ 开发`：typecheck/test/build；
9. `## 📄 许可证`：MIT。

同结构新增 `packages/ofdrw-viewer-crypto/skills/SKILL.md` 与 `skills/API.md`。

### 9.2 根 README

- 顶部 badge 增加 crypto；
- “快速开始”增加 `@ofdrw/ofdrw-viewer-crypto` 模块链接和一句用途；
- 保留 engine/CLI/UI 现有入口；**根 README** 必须能从首页找到 crypto。

### 9.3 全量文档同步清单

| 文件 | 更新点 |
|---|---|
| `docs/ofdrw-viewer-crypto设计方案.md` | 本文件；冻结 API/流程/状态/门禁 |
| `docs/CONTRACTS.md` | 新增第 13 章：依赖方向、VirtualContainer、crypto API、错误码、冻结规则 |
| `docs/密码学PoC验证报告.md` | 增加“R1 设计/实现映射”链接；R0 结论不变；SES v1、加密 PKCS#8、过期证书裁决指向本文 §0.1 |
| `packages/ofdrw-viewer-crypto/README.md` | 新建，按 9.1 |
| `packages/ofdrw-viewer-crypto/skills/SKILL.md` | 新建：解密/验证/根证书/错误处理示例 |
| `packages/ofdrw-viewer-crypto/skills/API.md` | 新建：完整 API/类型/错误码 |
| `packages/ofdrw-viewer-engine/README.md` | 新增 VirtualContainer 注入、`OFD_ENCRYPTED`、crypto 链接；默认行为不变 |
| `packages/ofdrw-viewer-engine/skills/API.md` | 导出 `VirtualContainer`/`VirtualFileMeta`/`VirtualReadOptions`/`VirtualContainerFactory`/`OFDOpenOptions` 新字段 |
| `packages/ofdrw-viewer-engine/skills/SKILL.md` | 增加“加密文档用 crypto 解密后注入容器”示例 |
| `docs/OFD渲染引擎设计方案.md` | 新增容器抽象/注入/生命周期/OFD_ENCRYPTED 章节 |
| `packages/ofdrw-viewer-ui/README.md` | 新增 `crypto` 选项、打开流程、验证面板、印章点击、根证书配置、错误码 |
| `docs/ofdrw-viewer-ui设计方案.md` | 增加密码能力 UI 交互/无障碍/安全边界 |
| `docs/ofdrw-viewer-ui-engine-api.md` | 明确 engine 只提供 `VirtualContainer`/签名原始字节，不验签；crypto 消费 |
| `packages/ofdrw-viewer-cli/README.md` | `info`/`verify`、加密转图片参数、退出码、无 decrypt |
| `packages/ofdrw-viewer-cli/skills/SKILL.md` | 命令示例/JSON/退出码/凭据安全 |
| `docs/CLI设计方案.md` | 增加子命令、参数、JSON、退出码 4/5、无独立 decrypt |
| `docs/测试方案.md` | 增加 crypto/UI/CLI/engine 容器测试矩阵与门禁 |
| `docs/验收计划.md` | 增加密码能力 acceptance、fixture/根证书/未知状态验收 |
| `docs/验收报告.md`、`docs/回归报告.md` | QA 完成后记录实测证据；不由本设计虚构 |
| `README.md`（根 README） | 模块链接/badge/快速开始 |
| `docs/CONTRACTS.md` | 见上；另更新变更记录 v2.0-r1 |

文档冻结规则：本设计与 `CONTRACTS` 第 13 章先冻结；实现中新增公共字段/错误码必须由 architect 更新两处并通知，不得只改 README。

## 10. PoC 风险闭环

| R0 风险 | R1 处理 |
|---|---|
| R1 自定义 SM2 userId | 默认标准值；`CryptoOptions.sm2UserId` 可覆盖；文档说明不能从证书推导 |
| R2 证书链/有效期 | 自实现链构建/有效期/KeyUsage/BasicConstraints；未配根 unknown；CRL/OCSP 不检查 |
| R3 时间戳只解析 | 固定 `parsed-not-verified`；不参与 overall；UI 固定文案 |
| R4 SES v1 未实现 | 本期实现 v1 独立解析/验签分支与测试 |
| R5 `EncryptCaseId` 缺失 | 按用户名 + UserCert 类型匹配；字段只诊断 |
| R6 entriesmap 明文 | 先 SM4，失败回退 XML；warning |
| R7 多加密层/循环 | 循环 + 最多 4 层 + 指纹循环检测 + 进展检查 |
| R8 C1C3C2 04 前缀 | DER 结构补/去 C1，长度固定，不看首字节 |
| R9 SM4 字符串语义 | 全部 API 接受 `Uint8Array`，禁止传 hex 明文串 |
| R10 CheckMethod 变化 | 接受 `SM3` 与 OID，未知则 unsupported/invalid |
| R11 时间戳外层 OID | 接受 GM/T 0010 与 PKCS#7 |
| R12 DER 健壮性 | `asn1js`/`@peculiar` + 严格长度/深度/字节上限；畸形明确报错 |
| R13 PKCS#9 证书数组 bug | 不复用有 bug 的生成器；解析用标准库/自实现，测试覆盖 authAttrs |
| R14 历史证书过期 | 过期状态单独报告；夹具新证书；过期由测试内生成 |
| R15 大文件性能 | 大小/条目/解压总量上限；分块摘要/读取；不一次性复制无上限 |
| R16 ZIP 路径/重名 | 规范化 + `Path/EPath` 严格映射 + 重复/穿越失败 |
| R17 运行时差异 | CI 固定 Node 22；Node 26 兼容复跑 |
| R18 测试私钥提交 | 仅测试证书/私钥，README/manifest `testOnly`；生产密钥禁止入库 |

## 11. 交付与验收映射

| 验收点 | 本设计位置 |
|---|---|
| 包定位/依赖/目录/API/错误/安全/测试/文档 | §1、§3.7、§8、§9 |
| VirtualContainer/list/has/read/close/size、注入、默认 ZIP、生命周期、兼容 | §2 |
| crypto API：inspect/openDecryptingContainer/verifyOfd/parse* | §3 |
| 解密：Encryptions→DecyptSeed→KDF/SM2→SM4→entriesmap→明文；多层/错误/透传 | §4 |
| 验证：Reference/SES v1-v5/TBS/链/根/完整性 | §5.1–5.5 |
| 时间戳仅解析、状态命名、UI 展示 | §5.6、§6.4 |
| UI 检测/弹窗/重试/取消/面板/印章/根证书/无障碍 | §6 |
| CLI info/verify/转图片/JSON/退出码/无 decrypt | §7 |
| 样例清单/生成/manifest/测试证书策略 | §8 |
| 新包 README/根 README/全量文档 | §9 |
| 与 PoC 一致/裁决 | §0.1、§10 |

本设计完成后，engine/crypto/UI/CLI 的实现、测试与验收可直接按本文件与 `CONTRACTS` 第 13 章并行开展。
