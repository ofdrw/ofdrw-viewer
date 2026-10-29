# OFD Viewer 跨包契约

## 1. 目的与范围

本文定义 `@ofdrw/ofdrw-viewer-engine`、`@ofdrw/ofdrw-viewer-crypto`、`@ofdrw/ofdrw-viewer-ui` 与 `@ofdrw/ofdrw-viewer-cli` 之间的稳定边界：包和目录归属、依赖方向、公共入口、跨模块不变式、错误与 warning 注册表、测试目录以及密码能力范围。

本文只记录当前实现中必须共同遵守的契约。公共 API 的完整签名、参数默认值和返回值以各包 `skills/API.md` 为准；fixture、黄金图、命令、CI 与测试矩阵以 `docs/测试方案.md` 为准；模块内部算法和时序以对应设计文档为准。实现与本文冲突时，先修实现或先修本文，不能靠口头约定绕过。

本文不用于介绍产品用法。CLI 用法见 `packages/ofdrw-viewer-cli/skills/SKILL.md`，阅读器接入见 `packages/ofdrw-viewer-ui/skills/SKILL.md`，引擎接入见 `packages/ofdrw-viewer-engine/skills/SKILL.md`。

## 2. 包、目录与命令

### 2.1 仓库布局

| 路径 | 角色 | 是否 workspace 包 |
| --- | --- | --- |
| `packages/ofdrw-viewer-engine` | 与平台无关的 OFD 解析、布局与渲染核心 | 是 |
| `packages/ofdrw-viewer-crypto` | 加密检测/解密、签章与完整性校验、证书/SM 基础能力 | 是 |
| `packages/ofdrw-viewer-ui` | 浏览器阅读器、文本层、打印/导出、签章展示、Web Component 与框架适配 | 是 |
| `packages/ofdrw-viewer-cli` | 本地文件转图片、`info`、`verify`、SEA 可执行文件 | 是 |
| `demo` | 演示站，消费已构建的包 | 是 |
| `examples` | 独立示例工程，各自安装依赖 | 否 |
| `ofd_pdf_match` | 回归样本与 PDF 参考 | 否，样本资产 |
| `test/smoke` | 跨包架构与公共 API 文档同步检查 | 根级测试目录 |
| `docs` | 跨包契约、设计方案、测试方案 | 文档 |

机器要求：Node.js `>=22`，仓库固定 `pnpm@11.24.0`。四个发布包版本同为 `0.1.4`；engine、crypto、UI 的 `VERSION` 常量与 CLI 的 `CLI_VERSION` 必须与各自 `package.json` 的 `version` 一致。UI 的 `getVersions()` 返回实际加载的 UI、engine、crypto 三个版本。

### 2.2 常用命令

命令均在仓库根执行。根脚本只覆盖声明过的入口，不能把某个包的脚本当成全仓脚本。

| 命令 | 实际行为 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 按锁文件安装 workspace 依赖 |
| `pnpm build` | 递归执行所有包的 `build` |
| `pnpm -r --if-present run typecheck` | 递归执行所有包的类型检查 |
| `pnpm test` | 执行 engine 的全部 vitest 用例；不等于四包全量测试 |
| `pnpm test:smoke` | 执行 engine 的 `test/smoke` |
| `pnpm test:golden` | 执行 engine 的 `test/golden`，无用例时通过 |
| `pnpm cli:typecheck` / `pnpm cli:test` / `pnpm cli:build` | 转发 CLI 的类型检查、单元测试、构建 |
| `pnpm cli:test:acceptance` | 构建普通 CLI 与 SEA 后跑黑盒验收 |
| `pnpm cli:build:sea` / `pnpm cli:package:sea` | 构建/打包 SEA 可执行文件 |

包级入口：

| 包 | 构建 | 测试 | 其他 |
| --- | --- | --- | --- |
| engine | `pnpm -C packages/ofdrw-viewer-engine build`（tsup + CDN） | `pnpm -C packages/ofdrw-viewer-engine test` | `test:golden`、`test:audit`、`typecheck` |
| crypto | `pnpm -C packages/ofdrw-viewer-crypto build`（tsup + CDN） | `pnpm -C packages/ofdrw-viewer-crypto test` | `typecheck` |
| UI | `pnpm -C packages/ofdrw-viewer-ui build` | `pnpm -C packages/ofdrw-viewer-ui test` | `typecheck` |
| CLI | `pnpm -C packages/ofdrw-viewer-cli build` | `pnpm -C packages/ofdrw-viewer-cli test` | `test:acceptance`、`build:sea`、`package:sea` |

构建产物入口：engine、crypto 只有包根 ESM/CJS/类型入口；UI 另有 `./react`、`./vue`、`./element`、`./component`、`./style.css`；CLI 只有 `bin`，不作为库导入。各包 `tsconfig` 均开启 `strict`、`isolatedModules`、`verbatimModuleSyntax`；engine、crypto、CLI 的编译目标为 ES2022，UI 为 ES2020。

## 3. 模块职责与所有权

### 3.1 包级职责

- **engine**：消费已经可读的字节，解析 OFD/ZIP/XML/资源，构建布局与 DisplayList，驱动 Canvas2D 渲染，导出页面图片与文本内容；不发起网络请求，不读取本地文件，不处理密码学。
- **crypto**：检测加密包、恢复明文容器、校验签名/完整性/证书链、解析时间戳、提供 SM2/SM3/SM4/ASN.1/证书基础函数；解密结果以 engine 的 `VirtualContainer` 交给 engine。
- **UI**：负责浏览器交互、页面编排、渲染队列、文本层、查找、打印、导出、签章展示与宿主来源适配；不实现 OFD 解析和密码算法。
- **CLI**：负责 Node 参数解析、本地文件读取、字体/根证书预读、批量转图、`info`/`verify` 输出与退出码；通过 engine/crypto 公共入口完成业务，不自行实现密码逻辑。

### 3.2 engine 模块

| 目录 | 职责 |
| --- | --- |
| `common` | 纯工具、单位/矩阵、颜色、DisplayList 类型、LRU 与断言 |
| `container` | `ByteSource` 适配、ZIP 读取、容器路径规范化 |
| `xml` | XML 解析、数字/单位解析 |
| `model` | 文档、页面树、资源、权限、签章与附件的结构化解码 |
| `resource` | 资源缓存与资源存储 |
| `style` | 默认样式、绘制参数、页面样式与 paint 解析 |
| `font` | 字体别名、face、字形、字体 provider |
| `image` | 图片格式识别与 GIF/JBIG2/TIFF 解码（含受限实现） |
| `render` | 页面/对象/路径/文本/图片/裁剪/注释/组合/网格的布局与绘制命令生成 |
| `renderer` | Canvas2D 渲染器、网格近似、录制与渲染器类型 |
| `platform` | `ByteSource`、`VirtualContainer`、`FontProvider`、`ImageDecoder` 等宿主注入接口 |
| `api` | 文档、页面、RenderTask、事件、来源/容器、viewport、缓存与公共类型 |

### 3.3 crypto 模块

| 目录 | 职责 |
| --- | --- |
| `asn1` | DER、OID、X.509 与 SM2Cipher 结构解析 |
| `cert` | 证书格式转换、加载、解析与摘要 |
| `container` | 内存明文容器与容器路径工具 |
| `credentials` | 口令/私钥凭据、PKCS#8 解码 |
| `decrypt` | `Encryptions.xml`、条目映射、多层解密 |
| `integrity` | OFDEntries 与 GB/T 35275 完整性校验 |
| `seal` | 印章数据解析 |
| `sign` | SES、Signature.xml、Reference 校验与签名验证 |
| `sm` | SM2/SM3/SM4、KDF、曲线与私钥 |
| `source` | `CryptoSource` 到容器/字节源的适配 |
| `timestamp` | GM/T 0033 时间戳解析 |
| `types` | 公共类型、限制、状态与 warning |
| `util` | 参数、字节、比较、哈希、PEM、来源与 warning 工具 |
| `verify` | 证书链与验证报告 |

包根另有 `inspect.ts`、`errors.ts`、`version.ts` 与统一导出 `index.ts`。

### 3.4 UI 模块

| 目录/文件 | 职责 |
| --- | --- |
| 根级 `viewer.ts`、`document-controller.ts`、`state.ts`、`history.ts` | 阅读器门面、文档生命周期、状态快照、浏览记录 |
| 根级 `options.ts`、`features.ts`、`feature-gate.ts` | 选项归一化、功能开关与可用性判定 |
| 根级 `page-layout.ts`、`page-view.ts`、`render-queue.ts` | 页面布局、页面视图、渲染队列 |
| 根级 `event-bus.ts`、`keyboard.ts`、`errors.ts`、`version.ts` | 事件、快捷键、错误与版本 |
| `ui` | 工具栏、侧栏、查找栏、对话框、菜单、提示与 shell |
| `views` | 缩略图、大纲、书签、导航、签章视图 |
| `text` | 文本层、几何、选择、查找 |
| `print` / `export` | 打印与图片/压缩包导出 |
| `signature` / `crypto` | 签章映射、验证服务、凭据弹窗、印章图 |
| `a11y` / `i18n` / `theme` | 无障碍、国际化、主题 |
| `source` | URL/查询参数来源、`HttpByteSource` |
| `component` / `react` / `vue` | Web Component、React、Vue 适配 |

### 3.5 CLI 模块

`src` 为扁平结构：`bin.ts`/`cli.ts` 入口与参数解析，`convert.ts`/`info.ts`/`verify.ts` 三个业务路径，`pages.ts`、`output.ts`、`fonts.ts`、`text.ts`、`canvas.ts`、`image-decoder.ts` 负责输出与资源，`credentials.ts`、`crypto-output.ts`、`safe-text.ts` 负责凭据/安全输出，`node-file-source.ts` 负责本地随机读，`sea.ts` 负责 SEA 资源准备，`errors.ts`/`log.ts` 负责错误与日志。

## 4. 依赖方向（硬约束）

1. engine 不得依赖 crypto、UI、CLI 或任何宿主应用；运行时依赖仅为纯 JS 库。
2. crypto 只依赖 engine 的包根公共入口，不得依赖 UI/CLI，不得导入 engine 的 `src/*` 内部路径。
3. UI 只依赖 engine、crypto 的包根公共入口，不得依赖 CLI；不得直接实现 SM2/SM3/SM4、ASN.1 或加解密。
4. CLI 只依赖 engine、crypto 的包根公共入口与 Node/原生 Canvas；不得依赖 UI；不得直接依赖 `sm-crypto` 或自实现密码算法。
5. UI 与 CLI 互不依赖；`demo` 只消费已发布的公共入口，不能反向成为库依赖。
6. 包外消费者只能导入包根（UI 可用其声明的子路径）；任何 `@ofdrw/*/src/...` 深导入都不属于公共契约。
7. engine 核心模块不得依赖 DOM、Node 内置模块或原生 Canvas；`container` 与 `platform` 是实现宿主适配的边界层，不得把宿主 I/O 扩散进 `model`/`render`/`api`。
8. engine 内部方向由根级 `test/smoke/import-boundaries.test.ts` 强制：`common`/`model`/`resource`/`style`/`render`/`renderer`/`font`/`image`/`xml`/`api` 不导入 DOM/Node/原生 Canvas；`renderer` 只依赖 `common`/`renderer`；`render` 只通过 `renderer/types` 使用渲染器；`common` 对 `model`/`style` 只允许 type-only 前向引用；`model` 不产生对 `render`/`renderer`/`api` 的运行时依赖。
9. UI 可以使用 DOM、Canvas、`fetch`、Web API；CLI 可以使用 Node 内置模块与 `@napi-rs/canvas`；这些能力不得下沉到 engine 或 crypto 的公共实现。
10. 依赖方向改变属于公共契约变化，必须同时更新本文件、对应 `skills/API.md` 和边界测试。

## 5. 公共 API 边界

### 5.1 engine

包根导出是唯一公共入口，完整签名见 [engine API](../packages/ofdrw-viewer-engine/skills/API.md)。

- 文档与渲染：`OFDDocument`、`OFDPage`、`RenderTask`、`OFDEventBus`、`H5Canvas2DRenderer`。
- 版本：`VERSION`、`getVersion()`。
- 错误：`OFDError`、`isOFDError`、`toOFDError` 及错误码类型。
- warning：`WarningCollector`、`OFDWarning`、`WarningCode`、`WARNING_CODES`。
- 资源限制与缓存：`DEFAULT_RESOURCE_LIMITS`、`DEFAULT_CACHE_OPTIONS` 及类型。
- 打开与来源：`OFDOpenOptions`、`OFDOpenFromContainerOptions`、`OFDSource`、`FontInput`。
- 宿主接口：`ByteSource`、`VirtualContainer`、`VirtualContainerFactory`、`ImageDecoder`、`FontProvider`；`openZipVirtualContainer`。
- UI 数据：`PageInfo`、`TextContent`、`TextItem`、`TextChar`、`DocumentMetadata`、`OutlineNode`、`BookmarkItem`、`DocumentPermissions` 等。
- 元数据扩展：`DocumentMetadata` 新增可选 `docUsage`、`docType`、`documentHeader`（`DocumentHeader`）、`packageInfo`（`OfdPackageInfo`）、`commonData`（`CommonDataSummary`）；子类型与 `DocumentPageArea` 一并导出。全部 optional，缺失即省略，均在 `open()` 阶段解析。
- 附件扩展：`AttachmentInfo` 新增可选 `contentType`、`description`、`submissionDate`、`isEncrypted`；`OFDDocument` 新增 `getAttachmentByName`、`getAttachmentsByFormat`、`getAttachmentSize`、`saveAttachment`（签名与语义见 API.md §3.12.1），`AttachmentSink`/`AttachmentOperationOptions` 随之导出；`ResourceLimits` 新增可选 `maxAttachmentBytes`（byte，未配置回退 `maxEntryBytes`）。
- 字体声明：`OFDDocument` 新增 `getFontResources(options?)`，返回 `readonly DocumentFontResource[]`，类型 `DocumentFontResourcesOptions` 一并导出；只读打开阶段已解析的资源索引（零额外 IO、按 `id` 升序、不含页级声明），不反映运行时字体回退结果。这是引擎唯一新增的字体相关公开 API，签名与语义见 API.md §3.12.2。
- 渲染器与视口：`Canvas2DLike`、`CanvasRenderingContext2DLike`、`PageRenderParameters`、`Viewport`、`getPageViewport`、`getPageTransform`。
- 页级内容过滤：`PageContentFilter`、`DrawLayerOptions`、`AnnotationType`、`KnownAnnotationType`、`KNOWN_ANNOTATION_TYPES`；由 `render`/`exportImage`/`getTextContent` 的 `contentFilter` 使用，白名单语义与不继承规则见 API.md §4.10。

engine 的每个根导出名必须出现在自身 `skills/API.md` 附录中，由 `test/smoke/public-api-doc.test.ts` 检查。

### 5.2 crypto

包根导出是唯一公共入口，完整签名见 [crypto API](../packages/ofdrw-viewer-crypto/skills/API.md)。

- 业务入口：`inspect`、`openDecryptingContainer`、`verifyOfd`。
- 输入/容器：`CryptoSource`、`CryptoCredential`、`Sm2PrivateKeyInput`、`CryptoOptions`、`CryptoLimits`；容器参数使用 engine 的 `VirtualContainer` 类型。
- 解析：`parseSignatureXml`、`parseSignaturesXml`、`parseSignedValue`、`parseSeal`、`parseOfdEntriesXml`、`parseTimestamp` 等签名/完整性/时间戳解析入口。
- 证书：`CertificateDer`、`parseCertificate`、`parseCertificates`、`loadCertificate`、`loadCertificates`、`certificatesToDer`。
- SM/ASN.1：`sm2Sign`、`sm2Verify`、`sm2Encrypt`、`sm2Decrypt`、`sm3Digest`、`sm4EncryptCbc`、`kdfSm3`、`parseDer`、`parseX509Certificate`、`parseSm2Cipher` 等底层函数。
- 错误与 warning：`CryptoError`、`isCryptoError`、`CRYPTO_ERROR_CODES`、`CryptoWarning`、`CRYPTO_WARNING_CODES`。

crypto 可以重导出 engine 的 `ByteSource` 类型，但不得借此扩大 engine 的运行时公共面。

### 5.3 UI

包根导出 `OFDViewer`、`registerViewerExtension`、构造选项与事件/状态类型、`HttpByteSource`、`readPreviewSourceFromLocation`、`DEFAULT_MAX_BASE64_BYTES`、`VERSION`/`getVersions` 与错误类型。框架入口使用 `./react`、`./vue`、`./element`（`./component` 为兼容别名），样式使用 `./style.css`。完整签名见 [UI API](../packages/ofdrw-viewer-ui/skills/API.md)。

- `OFDViewer.getDocumentInfo(): Promise<ViewerDocumentInfo>`：文档信息快照，一次性并发聚合 `getMetadata`/`getPermissions`/`getAttachments`/`getSignatureEntries`/`getOutline`/`getBookmarks`；结果不写入 `ViewerState`。未打开时抛 `OFD_NOT_OPENED`，销毁后抛 `OFD_DESTROYED`。`ViewerDocumentInfo` 同时从包根导出。
- 功能键新增 `attachments`（依赖 `sidebar`，默认开启）：引擎无 `saveAttachment()` 时标记 `unsupported`，文档无附件时按 `document` 关闭。
- `ViewerState.document` 字段不变（不承载权限/附件）；权限与附件通过 `getDocumentInfo()` 或既有 `getPermissions()` 读取。
- 包根同时透出引擎的 `AttachmentInfo`、`DocumentPermissions`、`DocumentMetadata` 及其新增子类型。
- 本机字体（`queryLocalFonts`）：`OFDViewer` 新增 `getLocalFontsStatus()`、`setLocalFontsEnabled(enabled)`、`onLocalFontsStatusChange(handler)`；构造选项 `fonts.localFonts`（五字段 `enabled`/`defaultEnabled`/`remember`/`maxFonts`/`consentText`，默认关闭）；`FontSource` 新增 `{ local }` 第五态；事件新增 `local-fonts:change`；开关位于工具栏「更多」→「关于」对话框（**不新增侧栏视图、不新增功能键**）。三套框架适配层均已桥接该能力：Web Component 转发同名三方法并派发 `ofd-local-fonts-change`，React 命令句柄增加同名三方法并触发 `onLocalFontsChange`，Vue `expose` 增加同名三方法并触发 `local-fonts-change`。包根导出 `LocalFontsOptions`、`LocalFontStatus`、`LocalFontsStatus`、`LocalFontsChangeEvent`、`LocalFontDeclaration`。默认关闭、需宿主配置 + 用户授权双重开启；`LocalFontsStatus.enabled` 与浏览器授权状态同步（权限非 `granted` 时一律为 `false`），失败静默回退，详见 [本地字体加载方案设计](本地字体加载方案设计.md) 与 UI API.md「本机字体」。

UI 的包根导入会安装 UI shell，并加载文本、导航、签章、打印、导出等副作用模块；React/Vue/Web Component 入口复用同一 `OFDViewer` 内核，不建立第二套文档生命周期。

### 5.4 CLI

CLI 只提供可执行文件 `ofdrw-viewer-cli`，不导出库 API。命令、参数、输出字段和退出码以 [CLI SKILL](../packages/ofdrw-viewer-cli/skills/SKILL.md) 为准；CLI 内部源码不是给其他包调用的公共接口。

### 5.5 公共类型与版本

公共类型按上述包归属，不跨包复制同名类型。UI 的 `ViewerOptions`、`ViewerState`、`ViewerEvent` 等只属于 UI；engine 的 `OFDOpenOptions`/`OFDSource` 不得被 crypto/UI/CLI 重新定义。四个包版本保持同一发布号；engine/crypto/UI 的 `VERSION` 不从 `package.json` 运行时读取，CLI 普通构建可从自身 `package.json` 读取 `CLI_VERSION`，SEA 使用构建时嵌入的版本。

## 6. 跨包调用面

当前四个包之间没有深导入，也没有跨包调用的内部实现签名。跨包调用只发生在包根导出上：

| 调用方 | 被调用方 | 使用的公共面 |
| --- | --- | --- |
| crypto | engine | `ByteSource`、`VirtualContainer`、`OFDError`/`isOFDError`、`openZipVirtualContainer` 及公共类型 |
| UI | engine | `OFDDocument`、`OFDPage`、渲染器/视口、错误、文档/文本/权限/签章类型；元数据扩展字段（`docType`/`documentHeader`/`packageInfo`/`commonData`）与附件接口（`getAttachments`/`getAttachmentByName`/`getAttachmentsByFormat`/`getAttachmentSize`/`saveAttachment`/`getAttachmentData`） |
| UI | crypto | `inspect`、`openDecryptingContainer`、`verifyOfd`、证书/SM 类型与错误类型 |
| CLI | engine | `OFDDocument`、图片导出、文本内容、字体/解码器注入、错误与 warning |
| CLI | crypto | `inspect`、`openDecryptingContainer`、`verifyOfd`、`certificatesToDer`、凭据/报告类型 |

因此 engine/crypto 内部模块之间的函数签名不是跨包契约，不应复制到本文；改动这些内部签名只需通过各自包测试，除非同时改变了包根导出或上述行为。

## 7. 跨模块契约与不变式

### 7.1 来源与字节所有权

- engine 的 `OFDSource` 只有 `arraybuffer`、`blob`、`custom` 三种；`url`、`node-file`、`wechat-file` 都不合法。URL、路径、小程序文件必须先由宿主读成字节或实现 `ByteSource`。
- `ByteSource.size` 是总字节数，单位 byte；`read(offset, length)` 返回调用方拥有的字节；`close()` 幂等，由拥有它的容器调用。异步探测大小用 `ready()`。
- `openZipVirtualContainer(source)` 适配来源并创建 ZIP 容器；容器关闭时关闭它拥有的字节源。来源是 `custom` 时，所有权按容器契约移交，调用方不得在容器关闭前重复关闭同一源。
- 已构造容器注入 `OFDDocument` 时是借用语义：engine 不关闭容器，宿主在 `doc.close()` 后自行关闭；同一明文容器可被多个文档复用（是否支持并发由容器实现决定，engine 不额外加锁）。
- `OFDOpenOptions.containerFactory` 的容器归 engine 所有：打开失败或 `doc.close()` 时 engine 关闭；`source` 作为工厂输入，来源所有权随工厂/容器。`container` 与 `containerFactory` 互斥。
- 纯容器入口 `OFDOpenFromContainerOptions` 不要求 `source`，不提供工厂；`source` 只作为宿主上下文，engine 不打开、不关闭。
- engine 只接受明文容器：`encrypted=false` 且 `read()` 返回明文；`encrypted=true` 的 raw package container 只能交给 crypto 检查/解密，直接打开报 `OFD_ENCRYPTED`。
- crypto 的 `CryptoSource` 支持 `arraybuffer`、`blob`、`url`、`byte-source`。`byte-source` 由调用方拥有，crypto 只读、不关闭；`url` 由 crypto 使用全局 `fetch` 读取完整响应，遵守 `maxSourceBytes`，不实现 Range/重试/缓存。
- `openDecryptingContainer` 的返回容器固定 `encrypted=false`；调用方负责关闭。多重解密时，中间层容器在返回前关闭，明文结果不残留 `Encryptions.xml`/`decryptseed.dat`/`entriesmap.dat` 等元数据；输入 `byte-source` 不被关闭。
- `inspect` 只读取包结构/加密头/用户/签章与完整性存在性，不解密、不验签，因此不能替代 `verifyOfd`。

### 7.2 生命周期、取消与关闭

- engine 的取消信号在入口和读取边界透传；中止抛 `OFD_ABORTED`，不能吞掉后继续返回部分页面。`doc.close()` 幂等；关闭后取页/渲染抛 `OFD_CLOSED`。RenderTask 取消后不得再完成渲染。
- crypto 的 `signal` 在读取、解密、验证入口检查；中止抛 `CRYPTO_ABORTED`，已构造的容器必须关闭，不返回半成品。取消不能被映射成普通解密失败。
- UI 取消当前加载/渲染/验证时，必须结束对应操作并保持状态一致；`destroy()` 后不得再触发渲染或改写 DOM。UI 事件与生命周期以 [生命周期与事件设计](OFD渲染引擎生命周期与事件设计.md) 为准。
- CLI 收到 `SIGINT` 以 `130` 退出；已写出的页可以保留，未完成的页不得写成成功结果。

### 7.3 错误映射

- engine 统一抛 `OFDError`，带稳定 `code`、可读 `message` 和可选 `cause`；不得把宿主 HTTP/文件系统错误码直接暴露给上层。
- crypto 统一抛 `CryptoError`，错误码见 §8；`message` 只能包含路径、用户名、算法、OID 等诊断信息，不得包含口令、私钥、PEM、`EncryptedWK` 或密钥字节。crypto 内部遇到 engine 错误时用 `isOFDError` 识别并按自身边界转换。
- UI 在功能守卫处抛 `OFD_FEATURE_DISABLED`（带 `feature`），其余错误使用 `ViewerErrorCode`；密码能力失败映射为 `OFD_CRYPTO_FAILED` 并保留 `cause`，取消映射为 `OFD_CRYPTO_CANCELLED`，未提供凭据映射为 `OFD_CRYPTO_CREDENTIAL_REQUIRED`。
- CLI 使用 `CliError` 与 §8.5 的退出码；engine/crypto 错误必须映射到稳定的进程退出码，不能把内部码直接当退出码。
- 任何层都不得在错误消息、日志或 DOM 中输出凭据、私钥、解密密钥或明文正文。

### 7.4 Warning 透传与去重

- engine 通过 `onWarning` 回调输出 `OFDWarning`，`WarningCollector` 按 `(code, pageIndex, objectId)` 去重后转发；`resourceId` 不参与去重键。
- crypto 通过独立的 `onWarning` 输出 `CryptoWarning`，不得复用 engine 的 warning 码。
- UI 的阅读器 warning 与密码能力 warning 是两个回调；UI 不把 crypto warning 改写成 engine 码。
- CLI 在文本输出中呈现 warning；`info` 等结构化结果保留 warning，不得因 warning 把成功结果改成错误退出码。

### 7.5 字体输入

- engine 的 `FontInput` 只接受已经读好的 `data`（`ArrayBuffer`/`Uint8Array`）与可选 `family`；`defaultFonts` 与 `supplementaryFonts` 都不接受 URL/路径。
- 需要按需读取字体时，宿主实现 `FontProvider.match()`，在 `match()` 内读取并返回 `FontInput`；这是 engine 唯一的字体 I/O 入口。
- UI/CLI 负责把本地目录、系统字体或宿主资源读成字节后注入；engine 不扫描文件系统、不解析字体 URL。
- 字体匹配、默认字体优先级、缺字回退和字重/字形策略以 [渲染字体缺省方案设计](渲染字体缺省方案设计.md) 为准；engine 不使用 Canvas `fillText` 作为生产文本路径。
- UI 层的字体来源（`data`/`url`/`path`/`filePath`/`local`，共五态）由 UI 读取成字节后注入，URL 读取口径与失败降级以 [字体配置方案设计](字体配置方案设计.md) 为准；`local` 为浏览器本机字体来源，默认关闭、需宿主配置与用户授权，边界见 [本地字体加载方案设计](本地字体加载方案设计.md)。

### 7.5.1 手势缩放

- 触摸捏合与 Ctrl/Cmd+滚轮在 UI 层走“预览—提交”两阶段：手势期间只做合成层视觉缩放、不重排不重绘，静止 `180 ms` 或松手后按最终有效渲染倍率重绘一次；低于画布最低渲染倍率时只提交 CSS 尺寸，不重绘。
- 预览期间 `state.view.scale` 不变，仅 `getScale()` 返回预览倍率；`scalechanging` 事件在提交时派发一次。
- 细节（锚点几何、重绘抑制、适用范围）以 [手势缩放性能设计](手势缩放性能设计.md) 为准。

### 7.6 证书输入与 DER 边界

- crypto 的公共证书接口只接收 `CertificateDer`（X.509 DER 字节）。`parseCertificate`、`loadCertificate(s)` 与 `VerifyOfdOptions.roots` 的每项都必须是单张证书 DER，不识别 PEM/Base64；`parseCertificates` 额外接受多张 DER 直接拼接，按 TLV 边界逐张解析。
- CER 字节本身就是 DER，可直接作为 `CertificateDer` 使用；PEM、Base64、多证书文本必须经 `certificatesToDer` 转为逐张 DER；拼接 DER 可直接传给 `parseCertificates`，也可选用 `certificatesToDer` 拆分。转换器做 DER 顶层结构与 X.509 最小解析校验，但不校验证书链、有效期或 KeyUsage。
- UI 的 `CertificateSource` 四态（`data`/`url`/`path`/`filePath`）由 UI 读取后统一转 DER；CLI 读取根证书文件后同样转 DER。读取失败与解析失败的处理以 [证书输入 DER 化设计](证书输入DER化设计.md) 为准。
- 未配置信任根时证书链状态是 `unknown`，不是 `invalid`；验证报告必须保留这一区分。

### 7.7 网络与宿主 I/O 委托

- engine 不发起网络请求、不读取文件、不实现 HTTP Range/重试/缓存/鉴权；这些均由宿主完成，engine 只把底层错误映射为 `OFDError`。
- UI 负责 URL 规范化、`HttpByteSource`、HEAD/Range、请求头合并、进度、取消与关闭；CLI 只接受本地文件路径并用 `NodeFileByteSource` 随机读；小程序宿主自行下载并交出字节或 `ByteSource`。
- 谁实现 I/O，谁负责错误、取消和资源释放。跨层不得把 URL 字符串继续向下传，也不得让 engine 认识 `file://` 或小程序临时路径。详细边界见 [网络与文件获取委托设计](网络获取委托设计.md)。

### 7.8 文本、坐标与单位

- engine 内部以毫米描述页面几何，渲染时按 DPI 转成像素；图片导出、viewport、文本层使用像素坐标。
- `TextContent`/`TextItem`/`TextChar` 的坐标、尺寸、基线、四角点均为页面像素坐标，原点在页面左上角，单位 px；UI 文本层与 CLI `--text` JSON 使用同一口径。
- 文本内容 API 的遍历顺序、可见性、排除规则、上限、缓存与取消以 [文本内容 API 设计](text-content-api.md) 为准；UI/CLI 不得自行解析 Content.xml 生成另一套文本。
- 页面旋转、缩放、裁剪后的坐标转换由 engine 的视口/变换函数负责；宿主只组合矩阵，不复制单位换算公式。

### 7.9 事件边界

- engine 提供 `OFDEventBus` 与 `RenderTask` 事件；事件名、字段、单位、派发顺序和失败/取消语义以 [生命周期与事件设计](OFD渲染引擎生命周期与事件设计.md) 为准。
- UI 把 engine 事件映射成 `ViewerEvent`，不得改变单位和页面索引基准；UI 的加载结束/错误边界必须清理旧操作监听器。
- crypto 与 CLI 不提供事件总线；CLI 只在进程输出中呈现结果。

### 7.10 密码能力边界

- crypto 负责：加密检测、口令/证书解密、多层/多用户、签名与完整性验证、证书链、印章解析、时间戳解析。
- crypto 不负责：生成/修改 OFD、加密包、签章、制章、证书签发、吊销查询（CRL/OCSP）、TSA 签名验证；时间戳只解析并标注“已解析，未验证”。
- UI 的 `crypto.enabled=false` 时加密文档以 `OFD_CRYPTO_UNSUPPORTED` 拒绝；`verification` 功能变为 unsupported；`autoPrompt=false` 且无预置凭据时直接拒绝，不调用 `onCredentialRequired`。
- CLI 不提供独立 `decrypt` 子命令；需要解密时通过 `convert` 的凭据参数或 `verify` 的凭据参数完成。CLI 不自行实现 SM 算法，只调用 crypto 公共入口。
- 凭据只在调用栈/内存中使用，不写入日志、DOM、URL、浏览器存储或输出文件；测试证书/私钥只能用于测试，不构成生产信任材料。

### 7.11 文档元数据与附件接口

- **元数据来源唯一**：`DocumentMetadata` 的扩展字段（`docUsage`/`docType`/`documentHeader`/`packageInfo`/`commonData`）只由 engine 在 `open()` 阶段从 OFD.xml/Document.xml/CommonData 解析，UI/CLI 不得自行解析包内 XML 生成同名数据；`getMetadata()` 仍只读内存缓存。
- **缺失即省略**：所有新增字段 optional，解析不到时不出现 key，不放 `undefined`；非法数值/路径省略并产生 `W_METADATA_FIELD`，不阻断打开。几何字段统一 `Box`（mm），包内路径经 `resolvePackagePath` 规范化并去掉前导 `/`。
- **附件索引与内容分离**：`getAttachments()` 只读 `Attachments.xml` 元信息并缓存到关闭；`getAttachmentSize()` 读声明大小（byte）不读内容；内容只能经 `saveAttachment()`（回调式分块）或 `getAttachmentData()`（整块，旧调用方保留）取得，均不缓存。
- **`saveAttachment` 语义**：回调式分块，chunk 顺序等于包内字节顺序，`chunkSize` 默认 65536 byte；返回写入字节总数（byte）；`sink` 抛错原样上抛、引擎停止读取、已写字节不回滚；附件不可用上报 `W_ATTACHMENT_RESOURCE` 并返回 `0`（`getAttachmentData`/`getAttachmentSize` 对应返回 `undefined`）。
- **`saveAttachment` 不是流式 I/O**：容器只提供整块读取，引擎先读入内存再切块回调；chunk 是本次缓冲的 `subarray` 视图，跨回调保留须自行拷贝（UI 使用 `chunk.slice()`）。文档措辞不得把它描述成流式读取。
- **单附件上限**：取 `limits.maxAttachmentBytes`，未配置（或非法）回退 `maxEntryBytes`（默认 64 MiB）；声明大小或实际大小超限一律抛 `OFD_LIMIT_EXCEEDED`，不返回部分数据，`getAttachmentData`/`getAttachmentSize`/`saveAttachment` 三个接口口径一致（含只查元数据的 `getAttachmentSize`）。
- **UI 消费契约**：UI 通过 `getDocumentInfo()` 聚合读取元数据/权限/附件，不把这些数据塞进 `ViewerState.document`；附件内容一律不进入 DOM，未知格式只提供下载；单附件**声明大小**超过 500 MB（`ATTACHMENT_LARGE_THRESHOLD_BYTES = 524288000` byte）时不读取内容，改为提示下载整个 OFD 原文件（`readSourceBytes()`，沿用 `export` 门控）；批量 ZIP 导出复用 `export/zip.ts` 的 `createStoreZip`（fflate store 模式），超阈值与读取失败条目跳过并汇总“已导出 N，跳过 M”。
- **CLI 消费契约**：`info --json` 的 `document` 子对象平铺同步 5 个新字段与 `attachments` 摘要数组（`id`/`name`/`format?`/`size?`/`modDate?`），字段名与 engine 一致、缺失即省略；文本输出只在有值时新增“文档用途/文档类型/文档根/附件”行，不新增 `attachments` 子命令。

## 8. 错误码与 warning 码注册表

这些码是公共契约。新增、删除或改名必须同步本文件、对应 `skills/API.md` 和消费方映射。

### 8.1 engine 错误码

| 码 | 语义 |
| --- | --- |
| `OFD_INVALID_PACKAGE` | 包结构/ZIP/OFD 入口非法，或来源形状非法 |
| `OFD_ENTRY_NOT_FOUND` | 包内条目缺失 |
| `OFD_UNSUPPORTED_COMPRESSION` | ZIP 压缩方式不支持 |
| `OFD_ENCRYPTED` | 打开到未解密的加密容器 |
| `OFD_XML_PARSE` | XML/结构解析失败 |
| `OFD_PAGE_NOT_FOUND` | 页索引越界或页面不存在 |
| `OFD_CANVAS_TOO_LARGE` | 画布像素超过限制 |
| `OFD_CANVAS_SIZE_MISMATCH` | 传入画布尺寸与视口不一致 |
| `OFD_RENDERER_UNSUPPORTED` | 渲染器/绘制能力不支持 |
| `OFD_ABORTED` | 操作被取消 |
| `OFD_CLOSED` | 文档或容器已关闭 |
| `OFD_NOT_OPENED` | 文档从未成功打开时请求文档级信息（区别于已打开后被关闭的 `OFD_CLOSED`）；由 UI `getDocumentInfo()` 抛出 |
| `OFD_LIMIT_EXCEEDED` | 包/条目/解压/资源超过限制 |
| `OFD_FONT_PARSE` | 字体解析失败 |
| `OFD_IMAGE_DECODE` | 图片解码失败 |

### 8.2 engine warning 码

| 码 | 语义 |
| --- | --- |
| `W_FONT_MISSING` | 文档字体缺失，使用替代字体 |
| `W_GLYPH_MISSING` | 字体缺字，绘制替代/空白 |
| `W_IMAGE_DECODE` | 图片解码失败，跳过图片 |
| `W_UNSUPPORTED_PAINT` | paint 类型不支持 |
| `W_UNSUPPORTED_CLIP` | 裁剪类型不支持 |
| `W_BAD_NUMBER` | 数值字段非法，使用默认/跳过 |
| `W_BAD_PATH` | 路径命令非法 |
| `W_DUPLICATE_RESOURCE` | 资源 ID/路径重复 |
| `W_COMPOSITE_DEPTH` | 组合对象嵌套超限 |
| `W_PATTERN_LIMIT` | pattern 复杂度/数量超限 |
| `W_ZERO_BOUNDARY` | Boundary 宽或高为 0 |
| `W_PHYSICALBOX_ORIGIN` | PhysicalBox 原点非 0 |
| `W_IMAGE_NO_CTM` | 图片缺 CTM，按约定处理 |
| `W_NEGATIVE_BOUNDARY` | Boundary 为负 |
| `W_LAYER_ORDER` | 图层顺序异常 |
| `W_BLEND_MODE` | 混合模式不支持 |
| `W_RADIAL_UNSUPPORTED` | 径向渐变不支持 |
| `W_GOURAUD_APPROX` | Gouraud 网格使用近似 |
| `W_ANNOT_EMPTY` | 注释内容为空 |
| `W_JBIG2_DECODE` | JBIG2 解码降级/失败 |

### 8.3 crypto 错误码

| 分组 | 码 |
| --- | --- |
| 输入/API | `CRYPTO_INVALID_ARGUMENT`、`CRYPTO_CREDENTIALS_REQUIRED`、`CRYPTO_SOURCE_UNSUPPORTED`、`CRYPTO_LIMIT_EXCEEDED`、`CRYPTO_ABORTED` |
| 包/加密结构 | `CRYPTO_INVALID_PACKAGE`、`CRYPTO_NOT_ENCRYPTED`、`CRYPTO_UNSUPPORTED_ENCRYPTION`、`CRYPTO_ENTRY_MAP_INVALID`、`CRYPTO_DECRYPT_FAILED`、`CRYPTO_DECRYPT_LAYER_LIMIT`、`CRYPTO_LAYER_LOOP` |
| 凭据 | `CRYPTO_USER_NOT_FOUND`、`CRYPTO_USER_AMBIGUOUS`、`CRYPTO_WRONG_PASSWORD`、`CRYPTO_PRIVATE_KEY_INVALID`、`CRYPTO_PRIVATE_KEY_PASSPHRASE_REQUIRED`、`CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION`、`CRYPTO_PRIVATE_KEY_MISMATCH` |
| ASN.1/验证 | `CRYPTO_ASN1_INVALID`、`CRYPTO_UNSUPPORTED_SES_VERSION`、`CRYPTO_UNSUPPORTED_ALGORITHM`、`CRYPTO_CERTIFICATE_INVALID`、`CRYPTO_TRUST_ROOT_INVALID`、`CRYPTO_INTEGRITY_INVALID`、`CRYPTO_SIGNATURE_INVALID`、`CRYPTO_TIMESTAMP_PARSE` |

### 8.4 crypto warning 码

| 码 | 语义 |
| --- | --- |
| `W_CRYPTO_DUPLICATE_USER` | 加密包内用户名重复 |
| `W_CRYPTO_CREDENTIAL_IGNORED` | 凭据与当前包/路径不适用，被忽略 |
| `W_CRYPTO_ENTRIES_MAP_PLAINTEXT` | 加密层 entriesmap 为明文 XML，按明文映射继续 |
| `W_CRYPTO_ENTRY_MAP_INVALID` | 条目映射非法/不完整 |
| `W_CRYPTO_KEY_USAGE_MISSING` | 证书缺少 KeyUsage 扩展，无法确认签名用途 |
| `W_CRYPTO_MULTI_LAYER` | 解密涉及多层加密 |
| `W_CRYPTO_TIMESTAMP_PARSE` | 时间戳解析降级/失败 |
| `W_CRYPTO_TIMESTAMP_IMPRINT_MISMATCH` | 时间戳 imprint 与签名值不一致 |
| `W_CRYPTO_UNKNOWN_SES_VERSION` | SES 版本未知 |
| `W_CRYPTO_REFERENCE_UNSUPPORTED` | Reference 类型/算法不支持 |
| `W_CRYPTO_SEAL_PICTURE_INVALID` | 印章图片数据非法 |
| `W_CRYPTO_TRUST_UNKNOWN` | 未配置信任根，链状态为 unknown |
| `W_CRYPTO_CERT_SOURCE_UNSUPPORTED` | 证书来源格式不支持，跳过 |

### 8.5 UI 与 CLI 错误

UI 的 `ViewerErrorCode`：`OFD_FEATURE_DISABLED`、`OFD_INVALID_OPTION`、`OFD_INVALID_PAGE`、`OFD_NOT_OPENED`、`OFD_DESTROYED`、`OFD_UNSUPPORTED`、`OFD_EXPORT_FAILED`、`OFD_PRINT_FAILED`、`OFD_SIGNATURE_PARSE_FAILED`、`OFD_CLIPBOARD_FAILED`、`OFD_CRYPTO_CREDENTIAL_REQUIRED`、`OFD_CRYPTO_CANCELLED`、`OFD_CRYPTO_UNSUPPORTED`、`OFD_CRYPTO_FAILED`。`OFD_FEATURE_DISABLED` 同时携带 `feature`。

CLI 的 `CliErrorCode` 按用途分组：

- 用法/路径：`CLI_USAGE`、`CLI_INVALID_FORMAT`、`CLI_INVALID_DPI`、`CLI_INVALID_PAGES`、`CLI_INPUT_NOT_FOUND`、`CLI_INPUT_NOT_FILE`、`CLI_INPUT_UNREADABLE`、`CLI_OUTPUT_NOT_DIRECTORY`、`CLI_OUTPUT_CREATE_FAILED`、`CLI_FONT_DIR_INVALID`、`CLI_FONT_DIR_UNREADABLE`。
- 输出：`CLI_IMAGE_WRITE_FAILED`、`CLI_TEXT_WRITE_FAILED`、`CLI_TEXT_UNSUPPORTED`、`CLI_PAGE_TOO_LARGE`。
- 凭据/根证书：`CLI_CREDENTIALS_INCOMPLETE`、`CLI_CREDENTIALS_CONFLICT`、`CLI_CREDENTIALS_REQUIRED`、`CLI_CREDENTIAL_FILE_NOT_FOUND`、`CLI_CREDENTIAL_FILE_UNREADABLE`、`CLI_ROOT_FILE_NOT_FOUND`、`CLI_ROOT_FILE_UNREADABLE`。
- 未预期：`CLI_UNEXPECTED`。

CLI 进程退出码：`0` 成功；`1` 用法/参数/路径/页码错误；`2` 文档级失败；`3` 至少一页失败且至少一页成功；`4` 加密/凭据失败；`5` 验证未通过（`invalid`/`unknown`/`unsupported`/`not-applicable`）；`130` 用户中断。

## 9. 测试目录与黄金图所有权

### 9.1 目录归属

| 目录 | 所有者与用途 |
| --- | --- |
| `test/smoke` | 根级架构测试：engine 导入边界、公共 API 文档同步、公共 API 形状、DisplayList |
| `test/fixtures/reference` | 权威参考图，供 engine 回归使用；不复制到各包 |
| `packages/ofdrw-viewer-engine/test/{api,common,container,xml,model,resource,style,font,image,render,renderer,pipeline,gouraud,text-content,text-layout,smoke}` | engine 单元/集成测试 |
| `packages/ofdrw-viewer-engine/test/golden` | 样本 manifest、比较器、容差、严格基线 |
| `packages/ofdrw-viewer-engine/test/e2e` | 批量 PDF 参考回归、稳定性/取消/内存回归 |
| `packages/ofdrw-viewer-engine/test/acceptance` | engine 公共 API 验收 |
| `packages/ofdrw-viewer-engine/test/performance` | 文本性能门禁 |
| `packages/ofdrw-viewer-engine/test/verification` | 生命周期、错误、字体等独立验证 |
| `packages/ofdrw-viewer-crypto/test/{cert,container,core,decrypt,integrity,seal,sign,timestamp,verify}` | crypto 单元/集成测试 |
| `packages/ofdrw-viewer-crypto/test/verification` | OpenSSL/Java 向量、证书 DER 边界、Node/browser 来源 |
| `packages/ofdrw-viewer-crypto/test/fixtures/crypto` | 受保护 OFD、证书/私钥、manifest 与 SHA-256 |
| `packages/ofdrw-viewer-ui/test/{unit,integration,verification}` | UI jsdom 单元、集成、独立验证 |
| `packages/ofdrw-viewer-cli/test/{unit,e2e,verification}` | CLI 单元、端到端、独立验证 |
| `packages/ofdrw-viewer-cli/test/acceptance` | 构建后 CLI 与 SEA 黑盒验收 |
| `packages/ofdrw-viewer-cli/test/fixtures` | CLI 字体/文档夹具 |

`test/.artifacts` 与各包 `test/.artifacts` 是运行产物目录，已被忽略；不得把产物当基准提交。`docs/测试方案.md` 负责 fixture 生成、样本清单、命令、CI、报告与矩阵；本文只固定目录所有者和黄金图所有权。

### 9.2 黄金图所有权

- `packages/ofdrw-viewer-engine/test/golden/samples.json` 是样本清单的唯一权威：58 个样本、169 个比较页；PDF 参考位于 `ofd_pdf_match`，样本当前全部在仓库内。
- `packages/ofdrw-viewer-engine/test/golden/baseline/strict-baseline.json` 是严格审计基线：必须保持 58 个样本、169 页；`scripts/audit-strict.mjs` 以 58/169 作为完整性断言。
- `packages/ofdrw-viewer-engine/test/golden/baseline` 下的 PNG 目录约定用于人工确认的页面基线；没有 PNG 的页不参与该比较，当前是否启用由测试方案说明。
- 样本 manifest、比较器、容差、基线与批量回归 harness 归 engine 所有；其他包只消费样本或通过公共 API 复现，不得另建一套黄金图基线。
- crypto 的受保护 OFD、证书/私钥和 manifest 归 crypto 所有；UI/CLI 复用该目录，不复制夹具。
- UI 的 `thousand.ofd`、`broken-page.ofd`、`signature-missing-value.ofd` 由 `test/acceptance/generate-fixtures.mjs` 生成，归 UI 所有且不提交。

## 10. 密码能力范围

### 10.1 当前能力

| 能力 | 入口 | 结果 |
| --- | --- | --- |
| 加密检测 | `inspect` | 包版本、大小、层数、用户、方法、签名/完整性存在性；不解密 |
| 口令解密 | `openDecryptingContainer` | 明文 `VirtualContainer`；支持多用户/多层 |
| 证书解密 | `openDecryptingContainer` | SM2 私钥恢复 FEK；私钥支持 PEM/DER、PKCS#8、加密 PKCS#8 |
| 签名验证 | `verifyOfd` | SESv1/v4/v5、Signature.xml、Reference、SignedValue、印章、证书链 |
| 完整性验证 | `verifyOfd` | OFDEntries/GB/T 35275 防夹带；无保护时 `integrity=null`，不能当作通过 |
| 证书链 | `verifyOfd` | 配置根时 `valid`/`invalid`/`expired` 等；未配置根通常 `unknown` |
| 时间戳 | `parseTimestamp`、`verifyOfd` | 只解析时间/TSA/策略/序列号，状态固定 `parsed-not-verified` |
| UI 集成 | `OFDViewer` 的 `crypto` 选项 | 自动/手动凭据、验证面板、签章状态、下载/打印权限 |
| CLI | `info`/`verify`/`convert` | 查询、验证、带凭据转图；无独立 `decrypt` 子命令 |

### 10.2 安全与限制

- 加密算法、KDF、ASN.1/X.509、SM2 曲线和签名格式以 crypto API/设计文档为准；其他包不得另写实现或绕过 `verifyOfd` 自行判定“有效”。
- 私钥、口令、FEK、`EncryptedWK`、明文包内容不得出现在日志、错误消息、DOM、URL、导出 JSON 或测试快照中；crypto 的错误消息只允许诊断性元数据。
- 资源限制（来源字节、ASN.1 深度/字节、证书数、解密层数、解压总量等）由 `CryptoLimits`/`DEFAULT_CRYPTO_LIMITS` 统一管理，调用方用 `limits` 覆盖；UI/CLI 不复制默认值。
- 时间戳只解析，不验证 TSA 签名；不实现 CRL/OCSP；证书链的吊销状态不在当前范围。
- 受保护夹具的证书/私钥是公开测试材料，禁止用于生产、真实签章或任何需要保密性的场景。
- 跨包密码能力测试矩阵（engine/crypto/UI/CLI、口令/证书/多层/无根/篡改）由 `docs/测试方案.md` 维护；新增能力必须同时补矩阵和对应包的 API 文档。

### 10.3 非能力

以下不属于当前契约，不得由 UI/CLI 私自补实现：

- 生成、修改、加密 OFD 包，创建签名/印章/时间戳。
- 独立 `decrypt` 子命令或独立解密库。
- 证书签发、吊销查询、TSA 签名验证。
- 在 engine 内识别 URL/文件路径或执行网络 I/O。
- 在 UI/CLI 内直接实现 SM2/SM3/SM4、ASN.1 或 PKCS#8 解析。