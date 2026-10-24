# OFD 转图片、查询与验签 CLI（ofdrw-viewer-cli）设计方案

本文件定义 `@ofdrw/ofdrw-viewer-cli` 的当前设计：它如何消费 engine 与 crypto 的公共 API，把 OFD 转成逐页图片与空间文本，并完成 `info` 查询、`verify` 验签与加密文档转换，以及如何打包成多平台自包含可执行文件。

CLI 的完整参数表、输出示例与 Agent 使用步骤见 [`packages/ofdrw-viewer-cli/skills/SKILL.md`](../packages/ofdrw-viewer-cli/skills/SKILL.md)；本文不复制该表，只说明命令语义、设计约束与实现边界。跨包契约见 [`CONTRACTS.md`](./CONTRACTS.md)，测试矩阵见 [`测试方案.md`](./测试方案.md)，构建与发布流程见 [`packages/ofdrw-viewer-cli/docs/BUILDING.md`](../packages/ofdrw-viewer-cli/docs/BUILDING.md)。

## 1. 定位、范围与非目标

### 1.1 定位

engine 只提供平台无关的页面渲染与文本内容 API，不负责读文件、创建 Canvas、编码图片、写 JSON、记录日志和跨平台分发。CLI 是 Node 侧的完整宿主：

- 打开本地 OFD，注入 Canvas、编码器、图片解码插件与字体字节；
- 按页导出图片，并在 `--text` 时导出同坐标系的空间文本 JSON；
- 提供 `info`（只查询）与 `verify`（一次性完整性 + 签名验证）；
- 对加密文档，用口令或 SM2 私钥在内存中解密后渲染，不落盘明文；
- 把错误、warning、进度与退出码收敛成稳定的终端契约；
- 以 Node SEA 发布 Linux/macOS/Windows 自包含可执行文件。

### 1.2 目标

- 同一套命令、参数与输出契约在普通 Node 与 SEA 产物下保持一致；
- 页级产物（PNG/JPEG/WebP 与 JSON）可被脚本直接消费，失败粒度与退出码稳定；
- 人能读的进度、错误与 warning 清晰可定位，且不泄露凭据；
- 构建可复现、按平台分发，终端用户不需要安装 Node。

### 1.3 范围

- 单个本地 OFD 文件输入；输出 PNG（默认）、JPEG、WebP；
- 全部页或指定页范围（`1-3,5`），输出 DPI 默认 96；
- `--text` 时每页额外输出 `<stem>-p<NNN>.json`（`text` + `x/y/w/h`，px）；
- `--font-dir` 补充字体，默认自动发现白名单系统字体，`--no-system-fonts` 可关闭；
- 人读日志；错误与 warning 直接打印到控制台；
- SIGINT 取消、临时文件清理与原子写；
- `info`：查询加密层、用户、签名与完整性摘要；明文文档再查元数据、页数、页尺寸，不解密、不验签；
- `verify`：一次性完成防夹带完整性、全部签名、证书链、印章与时间戳解析；
- 加密转图片：`--password` 或 `--key`（PEM/DER/PKCS#8），可选 `--key-passphrase`、`--user`；
- `--root`（PEM/DER/CER/Base64，可重复）与 `--sm2-user-id`；
- 终端人类可读输出清理控制字符，JSON 保留原始值；
- Node SEA 自包含可执行文件与多平台发布产物；
- 输入包字节受 engine `maxPackageBytes` 与 crypto `maxSourceBytes` 默认上限约束（均 256 MiB），超限按文档级失败处理。

### 1.4 非目标

- 多文件/目录批量、通配符、stdin/URL 输入；
- PDF 输出、打印；
- OCR（文本来自 OFD 内容层，不识别图片文字）；
- 注释与签章文字（`includeAnnotations=false`）；
- 多文档包的文档选择（固定处理第一个文档）；
- 并行渲染（固定串行）；
- 图片 DPI 元数据（PNG pHYs / JPEG density）写入；
- 纯文本模式（不渲染图片）；
- 独立 `decrypt` 子命令（加密文档直接带凭据转图片；`decrypt` 固定用法错误）；
- 明文落盘、批量验签、CRL/OCSP 吊销检查；
- Linux musl/Alpine 产物；
- macOS 签名/公证与 Windows 代码签名；
- 自动下载根证书、字体或可执行文件；系统字体发现只属于 CLI 宿主策略，engine 不做自动发现（见 [`渲染字体缺省方案设计.md`](./渲染字体缺省方案设计.md)）。

## 2. 与 engine / crypto 的边界

### 2.1 导入与职责

CLI 只从 `@ofdrw/ofdrw-viewer-engine` 与 `@ofdrw/ofdrw-viewer-crypto` 包根导入类型与 API，禁止跨包相对路径引用内部模块。三方职责固定：

- engine：解包、页面模型、渲染、文本内容、字体匹配与回退；不联网、不读文件，也不读字体路径或 URL；
- crypto：口令/私钥解析、解密、完整性/签名/证书链/印章/时间戳验证；不依赖 CLI、UI 或 engine；
- CLI：文件读取策略、Canvas/编码/解码、字体字节读取、输出命名、日志、退出码、输入源生命周期。

OFD 由 CLI 用 `fs` 随机读后以 `custom` 源传给 engine，或以 `{ kind: 'byte-source', source }` 传给 crypto；字体由 CLI 预读为 `{ data }`；根证书由 CLI 读原始字节后转换为 DER。CLI 不重复实现 SM2/SM3/SM4、ASN.1、证书链或解密逻辑。 文件、字体与根证书的读取边界见 [网络与文件获取委托设计](网络获取委托设计.md)。

### 2.2 使用的公共 API

| CLI 需要的能力 | 来源 |
| --- | --- |
| 打开文档、页树、页尺寸、渲染任务、取消 | `OFDDocument` / `OFDPage` / `RenderTask` |
| 默认 Canvas2D 渲染器 | engine 内置 `H5Canvas2DRenderer`（CLI 只注入 Canvas 工厂） |
| Viewport 计算 | `page.getViewport({ dpi })` |
| 空间文本 | `page.getTextContent({ dpi, includeChars: false })`，只取 `item.text/rect` |
| 整页渲染与编码 | `page.exportImage({ dpi, format, quality, background, signal })` |
| 字体补充 | `OFDOpenOptions.supplementaryFonts`（CLI 通过 `loadFontInputs()` 读取字节，传 `{ data }`） |
| 图片解码插件 | `OFDOpenOptions.imageDecoders`（CLI 提供 PNG/JPEG/WebP；GIF/JBIG2/TIFF 由 engine 内置解码器按需加载） |
| warning/error | `onWarning`、`OFDError` |
| 包/加密/签名摘要 | `inspect(source)`，只读，不解密不验签 |
| 加密解密 | `openDecryptingContainer({ source, credentials })` → 明文 `VirtualContainer` |
| 证书输入转换 | `certificatesToDer(bytes)`（PEM 单/多证书、DER/CER、Base64） |
| 完整性 + 签名验证 | `verifyOfd({ source/container, roots, sm2UserId })` → `VerificationReport` |
| crypto warning | `CryptoWarning`；由 CLI 统一写 stderr |

依赖方向固定为 `CLI → engine`、`CLI → crypto`；engine 与 crypto 互不依赖。签名、报告字段与错误码语义由各包的 `skills/API.md` 与 crypto 设计文档持有，CLI 只决定命令、输出与退出码。

## 3. Node 约束与子包组织

### 3.1 运行约束

- 运行时 Node ≥ 22，纯 ESM；`bin` 指向 `dist/bin.js`；
- 只使用 Node 内置模块（`node:fs/promises`、`node:path`、`node:os`、`node:util` 的 `parseArgs`、`node:process` 等）与 `@napi-rs/canvas` 原生依赖；不引入浏览器 polyfill 或 `jsdom`；
- 输入 OFD 用 `fs.FileHandle` 随机读，不整包 `readFile`；私钥、根证书、字体等小文件可整文件读取；
- 输出写同目录临时文件，`fsync` 后 `rename`，失败清理临时文件；
- 日志写 `process.stdout` / `process.stderr`，`bin.ts` 只把 `main()` 返回值写入 `process.exitCode`，不使用 `process.exit()`；
- 版本号普通 Node 下读 `package.json`，SEA 下由启动包装从内嵌清单写入环境变量；
- 不导出公共库 API；测试通过内部 import 与子进程完成。

### 3.2 模块划分

| 模块 | 职责 |
| --- | --- |
| `src/cli.ts` | `parseArgs`、子命令分派、帮助/版本、参数校验、进度输出、退出码 |
| `src/convert.ts` | 打开文档（可注入解密容器）、逐页导出、汇总与清理 |
| `src/info.ts` | `info` 子命令：crypto `inspect` + engine 明文元数据/页尺寸 |
| `src/verify.ts` | `verify` 子命令：`verifyOfd` + 文本/JSON 输出 |
| `src/credentials.ts` | 口令/私钥/根证书读取，组装 crypto 公共类型，输入源打开与关闭 |
| `src/node-file-source.ts` | 基于 `fs.FileHandle` 的只读随机访问 `ByteSource` |
| `src/output.ts` | 输出目录、页号补零命名、原子写 |
| `src/pages.ts` | 页码范围解析、去重合并、越界与上限校验 |
| `src/text.ts` | `getTextContent` 结果扁平化为 `text/x/y/w/h` |
| `src/fonts.ts` | `--font-dir` 扫描、系统字体发现、字节读取与合并去重 |
| `src/canvas.ts` | `@napi-rs/canvas` 加载与 engine Canvas/编码适配 |
| `src/image-decoder.ts` | PNG/JPEG/WebP 解码插件 |
| `src/sea.ts` | SEA 资产解压、缓存校验与 NAPI 环境变量设置 |
| `src/log.ts` | 信息、错误、warning 与 warning 汇总输出 |
| `src/errors.ts` | CLI 错误码、crypto/engine 错误到退出码映射 |
| `src/crypto-output.ts` | crypto warning 到 stderr 的统一呈现 |
| `src/safe-text.ts` | 终端文本控制字符清理 |

`cli.ts` 不实现渲染或密码学；`convert.ts`、`info.ts`、`verify.ts` 各自负责一条流程；`text.ts`、`output.ts`、`canvas.ts`、`sea.ts` 各自只做一件事。

### 3.3 构建产物

- `dist/bin.js`：普通 Node 入口，`package.json` 的 `bin` 指向它；
- `dist/sea/ofdrw-viewer-cli[.exe]`：当前平台自包含可执行文件；
- `dist/release/ofdrw-viewer-cli-<version>-<target>.tar.gz|.zip`：发布归档，附同名 `.sha256`；
- `scripts/build-sea.mjs` 负责 SEA 构建与冒烟，`scripts/package-sea.mjs` 负责归档打包。

## 4. CLI 接口

### 4.1 入口与子命令分派

```text
ofdrw-viewer-cli <input.ofd> [转图片选项] [凭据选项]

ofdrw-viewer-cli info <input.ofd> [--json]

ofdrw-viewer-cli verify <input.ofd> [凭据选项] [--root <file>]... [--sm2-user-id <id>] [--json]

ofdrw-viewer-cli version [--json]
```

分派规则：

- 解析阶段先处理 `--help`/`-V`，再判断子命令；第一个位置参数严格等于 `info`、`verify`、`version` 时进入对应子命令；`decrypt` 例外，固定用法错误（退出 1），但 `decrypt --help`/`decrypt -V` 仍按帮助/版本返回 0；其余情况按转图片处理；
- 文件名恰好为 `info`、`verify`、`version`、`decrypt` 时，写成 `./info` 等形式规避子命令识别；
- `decrypt` 不是子命令，出现时固定用法错误（退出 1），提示改用 `verify` 或带凭据的转图片；
- `--help`、`-V/--version` 优先于输入校验：缺少输入也返回 0 并打印帮助或短版本；
- `version` 子命令不接受输入文件，只接受 `--json`；文本输出 CLI 版本、平台-架构与 Node 版本，JSON 输出 `{ cli, platform, arch, node }`；
- `info` 只接受输入与 `--json`；出现凭据、`--root`、`--sm2-user-id` 或转图片参数 → 用法错误（1）；
- `verify` 接受凭据、`--root`、`--sm2-user-id`、`--json`；出现 `--out`、`--format`、`--dpi`、`--pages`、`--font-dir`、`--no-system-fonts`、`--text` → 用法错误（1）；
- 转图片接受凭据；出现 `--root`、`--sm2-user-id`、`--json` → 用法错误（1）；
- 只接受一个位置输入文件；多文件、缺输入、未知参数、非法选项值都归用法错误（1）。

完整参数表、示例与输出说明见 [`skills/SKILL.md`](../packages/ofdrw-viewer-cli/skills/SKILL.md)。

### 4.2 参数与校验规则

转图片参数的默认值与设计约束：

- 输入必须是存在的普通文件，否则退出 1；打开文档阶段的包结构错误归 2，凭据/解密错误归 4；CLI 自身路径错误归 1，crypto 输入源打开失败归 2；
- `--out` 默认当前工作目录下的输入文件 stem；不存在时递归创建，指向非目录或创建失败退出 1；
- `--format` 取值为 `png`/`jpeg`/`webp`（大小写不敏感），默认 `png`；扩展名分别为 `.png`/`.jpg`/`.webp`；
- `--dpi` 必须是正安全整数，默认 96；大于 1200 时产生 `W_DPI_HIGH` 但继续执行；
- `--pages` 使用 1 起闭区间，逗号分隔，允许连字符与逗号两侧空白；解析后去重、升序、合并重叠区间；单段跨度与合并后总页数上限均为 100000，超限在展开前退出 1；未提供时展开为 `1..pageCount`，`pageCount` 超过 100000 也退出 1；页码越界在拿到 `pageCount` 后判定，退出 1；
- `--font-dir` 递归扫描 `ttf/otf/ttc/otc`（扩展名大小写不敏感），目录不存在、不是目录或不可读取退出 1；空目录产生 `W_FONT_DIR_EMPTY` 后继续；
- 默认自动发现白名单系统字体；`--no-system-fonts` 关闭发现，只使用 `--font-dir`；
- `--text` 为布尔开关，默认关闭；
- `--password` 与 `--key` 互斥；`--user` 必须与二者之一同用；`--key-passphrase` 必须与 `--key` 同用；空路径/空 userId 退出 1；
- `--key` 接受 PEM 或 DER（含 PKCS#8）；`--key-passphrase` 只用于加密私钥；
- `--root` 可重复，接受 PEM（单/多证书）、DER/CER 与 Base64；同一路径重复传入按路径去重；仅 `verify`；
- `--sm2-user-id` 去除首尾空白后非空；省略时使用标准值 `1234567812345678`；仅 `verify`；
- `--json` 只用于 `info`、`verify`、`version`。

固定行为（不可配置）：

- 白底、不透明；目标文件已存在时直接覆盖，采用“临时文件 + `fsync` + `rename`”原子替换；
- 页面串行处理，JPEG/WebP 编码质量固定 0.9；
- engine 使用默认选项：`documentIndex=0`、`layerOrder=type`、`strictImageCtm=true`；CLI 只覆盖 Canvas、编码、解码、字体、warning 与取消信号；
- 错误与 warning 直接打印到控制台，不写日志文件；
- 口令、私钥、PEM 与 `EncryptedWK` 不进入日志、错误消息或帮助文本。

### 4.3 输出命名与目录

- 每页图片：`<out>/<stem>-p<NNN>.<ext>`；
- `--text` 时每页文本：`<out>/<stem>-p<NNN>.json`；
- `<stem>` 为输入文件名去扩展名，原样保留中文与空格；
- `NNN` 至少 3 位，实际宽度取 `max(3, pageCount 的十进制位数)`；单页文档同样使用 `-p001`；
- 图片与文本共用页号、DPI 与输出目录，坐标可直接叠加；
- 已存在目标直接覆盖；写入失败不留下临时文件。

### 4.4 退出码

| 码 | 语义 | 适用场景 |
| --- | --- | --- |
| 0 | 成功 | 转图片全部页成功；`info` 查询成功；`verify` 的 `overall=valid` |
| 1 | 用法/参数错误 | 未知参数、缺少输入、`decrypt`、子命令参数冲突、页码范围非法、路径不可用、`--font-dir` 非法 |
| 2 | 文档级失败 | 非 OFD、包损坏、无法打开、页面像素超限、`--text` 时文本 API 不可用、SEA 资产失败 |
| 3 | 页级失败 | 转图片至少一页失败（文本读取/写盘失败；但文本导出 catch 中的 `OFD_RENDERER_UNSUPPORTED` 映射的 `CLI_TEXT_UNSUPPORTED` 及其他文档级 `CliError` 属文档级失败 2，不按页级失败处理）；全部页失败仍为 3 |
| 4 | 加密/凭据失败 | 缺少凭据、用户名不存在/不唯一、口令/私钥错误、解密失败 |
| 5 | 验证未通过 | `verify` 的 `invalid`/`unknown`/`unsupported`/`not-applicable` |
| 130 | 用户中断 | SIGINT 或注入的取消信号 |

映射规则：

- engine 的 `OFDError` 在打开/文档准备等文档级路径按失败 2 处理；逐页 `getPage` 与图片导出的 catch 中按页级失败（3）处理（图片导出遇文档级 `CliError` 仍直接 rethrow）；文本导出 catch 的 unsupported 映射见下。`OFD_ENCRYPTED` 在无凭据转图片时映射为 `CLI_CREDENTIALS_REQUIRED`（4）；
- crypto 的 `CryptoError` 按类别映射：参数类 1、源/包结构/未加密类 2、凭据/解密入口/密钥类 4、ASN.1/算法/证书/完整性/签名/时间戳类 5、取消 130；
- 未知异常归 `CLI_UNEXPECTED`，按文档级失败（2）并保留堆栈；
- 只在文本导出 catch 中把 `OFD_RENDERER_UNSUPPORTED` 映射为 `CLI_TEXT_UNSUPPORTED`（文档级失败 2，不按页级失败处理），其他文档级 `CliError` 同样直接 rethrow；图片导出不走该映射：engine `OFDError`（含 `OFD_RENDERER_UNSUPPORTED`）默认按页级失败（3）继续，`CLI_IMAGE_WRITE_FAILED` 同样按页级（3）；仅文档级 `CliError` 直接退出 2；其他文本读取错误与 `CLI_TEXT_WRITE_FAILED` 也按页级失败（3）记录该页后继续后续页；
- `info` 成功固定 0；`verify` 只有 `overall=valid` 为 0，`unknown` 也是 5。

### 4.5 控制台输出

- stdout：帮助、短版本、`info`/`verify` 的文本或 JSON、转图片结束摘要；
- stderr：错误、warning、逐页进度、warning 汇总、用法提示与未知异常堆栈；
- 逐页进度每页两行，始终写 stderr，TTY 与管道一致，不用 `\r` 覆盖：
  - `[<index>/<total>] 第 <page> 页 开始`
  - `[<index>/<total>] 第 <page> 页 完成|失败`
  - 取消发生在页中时，可能只有“开始”而没有结束行；
- 页失败即时输出：`页面 <page>/<total> 失败 [CODE]：message`，随后继续后续页；
- 结束摘要：
  - 成功：`完成：S/T 页 → <out>（<秒>s）`；带 `--text` 时为 `完成：S/T 页（图片 + 文本）→ <out>（<秒>s）`
  - 有失败页：`完成：S/T 页[（图片 + 文本）]，N 页失败 → <out>`
  - 取消：`已取消：S/T 页 → <out>`
- warning 即时输出：`警告 [W_CODE][ 第 N 页]：message`；结束时输出 `警告汇总：CODE×N、...`，按 code 字典序，汇总不改变退出码；
- 错误：`错误[CODE]：message`；`CLI_USAGE` 额外输出用法提示与 `--help` 指引，路径/页码等具体错误只输出错误行；
- 人类可读通道统一净化：移除 ANSI CSI，替换 C0/C1、换行、U+2028/U+2029 为空格；覆盖 `Logger.error/warn/pageError`、crypto warning 的 message/path、`info`/`verify` 文本字段；
- JSON 与正常摘要保留文档原始值；`info`/`verify` 的 JSON 使用 2 空格缩进，`--text` 的 JSON 使用紧凑序列化；未知异常堆栈不净化。

### 4.6 `info`

`info` 只调用 crypto 的 `inspect` 读取包级摘要；明文包再用 engine 只读打开读取元数据、页数与页尺寸。它不解密、不验签、不渲染页面。同一 `NodeFileByteSource` 先以 `{ kind: 'byte-source', source }` 交给 `inspect`，再以 `{ kind: 'custom', source }` 打开 engine；document 关闭失败只产生 warning，不改变退出码。

行为：

- 加密包不要求凭据，也不自动解密；元数据标记为不可用，但包级信息照常输出并以退出 0 结束；
- 明文包的文档元数据在 JSON 中缺失字段直接省略，文本输出显示“无”；
- `inspect` 与 engine 的 warning 都逐条打印，结束时汇总，不改变退出码；
- 参数/路径错误 1，非法包等包结构错误 2，取消 130。

文本输出按固定顺序：文件、大小、OFD 版本、加密（层数）、用户、签名、完整性；有文档信息时继续输出标题、作者、主题、创建时间、修改时间、创建工具、页数、页面尺寸。页面尺寸只展示前 5 页，超出时追加“完整尺寸见 `--json`”；加密无凭据时追加“元数据不可用（加密文档，需凭据）”。

`--json` 输出固定结构：

```json
{
  "command": "info",
  "input": "<绝对路径>",
  "packageSize": 0,
  "ofdVersion": "<可选>",
  "encrypted": false,
  "layers": [],
  "users": [],
  "signatureCount": 0,
  "integrityPresent": false,
  "document": {
    "version": "<OFD 版本>",
    "pageCount": 0,
    "pageSizes": [{ "widthMm": 210, "heightMm": 297 }]
  },
  "warnings": []
}
```

顶层 `ofdVersion` 在有 `document` 时取 `document.version`，否则取 `inspect` 的版本；缺失字段在 JSON 中省略而不输出 `null`。`document` 仅在明文包出现，可含 `title`、`author`、`subject`、`abstract`、`creationDate`、`modDate`、`creator`、`creatorVersion`、`keywords`、`docId`、`customData`；`layers`/`users`/`warnings` 的字段语义由 [`ofdrw-viewer-crypto设计方案.md`](./ofdrw-viewer-crypto设计方案.md) 与 [`packages/ofdrw-viewer-crypto/skills/API.md`](../packages/ofdrw-viewer-crypto/skills/API.md) 持有。

### 4.7 `verify`

`verify` 调用一次 `verifyOfd`，同时完成防夹带完整性、全部签名、证书链、印章与时间戳解析；加密包由 crypto 内部解密，CLI 不落盘明文。

行为：

- `overall` 取 `valid`/`invalid`/`unknown`/`unsupported`/`not-applicable`；时间戳只解析、不参与聚合；
- 只有 `overall=valid` 退出 0；其余状态（含 `unknown`）退出 5；
- 存在签名或完整性保护但未配置 `--root` 时，证书链状态为 `unknown`，签名/完整性状态随之不可判定，`overall` 不会为 `valid`；这是预期安全状态，不是验证通过。需要可信结论时必须配置正确根证书；
- 签名与完整性都不存在时 `overall=not-applicable`，退出 5；
- `--json` 即使结果为 `invalid`/`unknown` 也先输出完整报告，再返回 5；
- 报告中的 `warnings` 逐条打印；`--root` 文件不存在/不可读退出 1，内容无法转换为证书时按 crypto 错误映射退出 5；
- 口令错误、用户不匹配、私钥错误 → 4；包结构/源超限 → 2；验证入口无法产出报告 → 5；取消 → 130；`--sm2-user-id` 只影响签名数学验证；

文本输出按固定顺序：验证结果、解密摘要（如已解密）、完整性、逐签名结果（可含时间戳行）、根证书行。根证书行使用命中的 `trustAnchor` 指纹去重计数；没有命中但配置了根时，回退到本次配置的去重路径数（至少显示 1）；未配置时显示“未配置”。多签名与完整性的链状态按“签名顺序 + 完整性”去重后以 `/` 连接，不做状态降级；没有链状态子项时显示 `unknown`。

`--json` 输出固定外壳（示例省略 `report` 其余字段）：

```json
{ "command": "verify", "input": "<绝对路径>", "report": { "overall": "valid" } }
```

`report` 是 crypto 的 `VerificationReport`，字段包括 `overall`、`package`、可选 `decryption`、`integrity`（未保护为 `null`）、`signatures`、`rootsConfigured`、`warnings`、`startedAt`、`durationMs`；字段定义与语义见 [`ofdrw-viewer-crypto设计方案.md`](./ofdrw-viewer-crypto设计方案.md) 与 [`packages/ofdrw-viewer-crypto/skills/API.md`](../packages/ofdrw-viewer-crypto/skills/API.md)。

### 4.8 加密文档转图片

```bash
ofdrw-viewer-cli encrypted.ofd -o out --password '***'
ofdrw-viewer-cli encrypted.ofd -o out --key encrypt.key.pem
ofdrw-viewer-cli encrypted.ofd -o out --key encrypt.key.pem --key-passphrase '***'
```

- 凭据：`--password`（口令用户）或 `--key`（SM2 私钥，PEM/DER/PKCS#8）；可选 `--user` 指定 `UserInfo@UserName`；`--key-passphrase` 只用于加密 PKCS#8；
- 流程与“打开文档与解密容器”一致：字节源 → `openDecryptingContainer` → 明文容器 → `OFDDocument.open` → 逐页导出；容器由 CLI 关闭，明文不落盘；
- 未提供凭据或凭据错误：不进入渲染、不产出页面，退出 4；
- 明文文档带凭据：产生 `W_CRYPTO_CREDENTIAL_IGNORED`，转图片行为与不带凭据一致，退出码按页面结果计算；`verify` 则按报告 `overall` 计算；
- 转图片不接受 `--root`、`--sm2-user-id`、`--json`；需要验签请使用 `verify`；
- 页面级失败退出 3，文档/包错误 2，SIGINT 130；
- 不提供独立 `decrypt`；明文只存在于内存中的解密容器，不落盘。

## 5. 空间文本导出（`--text`）

- 数据来源：`page.getTextContent({ dpi, includeChars: false })`；CLI 只消费 `items` 的 `text` 与 `rect`；
- 输出为扁平 JSON 数组，每项恰好五个字段：
  - `text`：engine 已过滤 CR/LF，不保留换行；普通空格等空白保留，CLI 原样透传；
  - `x`/`y`：包围盒左上角坐标，px；
  - `w`/`h`：包围盒宽高，px；
- 坐标直接取 `rect` 的小数值，不做取整；保持 `items` 原始顺序；
- 跳过 `text` 为空的项；空页输出 `[]`；JSON 使用紧凑序列化；
- 文本与图片共用同一页、同一 DPI、同一坐标系，因此可直接叠加；
- 处理顺序为先文本后图片；文本导出 catch 中的 `OFD_RENDERER_UNSUPPORTED`（映射 `CLI_TEXT_UNSUPPORTED`）及其他文档级 `CliError` 按文档级失败退出 2，不按页级失败处理；其余文本读取失败只记该页失败，文本 JSON 写盘失败（`CLI_TEXT_WRITE_FAILED`）也按页级失败（退出 3）处理，二者都继续导出同页图片与后续页；图片写盘失败（`CLI_IMAGE_WRITE_FAILED`）保留已写出的 JSON 并继续后续页；
- 进入逐页流程前先检查首个选中页是否提供 `getTextContent`；缺失时按文档级失败退出 2（`CLI_TEXT_UNSUPPORTED`），不静默只导出图片；`getTextContent` 抛 `OFD_RENDERER_UNSUPPORTED` 时同样映射为该错误；
- engine 对文本收集有默认上限（20,000 项、500,000 字符）：超限停止收集并产生 warning，CLI 只透传 warning，JSON 不含截断标记；
- 缺字体时 engine 会跳过对应文本项并产生 `W_FONT_MISSING`，其余文本项照常输出。

文本项模型、坐标与可见性规则见 [`text-content-api.md`](./text-content-api.md)。

## 6. 渲染与写盘流程

### 6.1 打开文档与解密容器

无凭据：

1. 用 `NodeFileByteSource` 以 `fs.promises.open(..., 'r')` 打开输入，随机读取，不整包 `readFile`；
2. 以 `{ kind: 'custom', source }` 交给 `OFDDocument.open`，注入 `createCanvas`、`encodeImage`、`imageDecoders` 与 `onWarning`，字体非空时再注入 `supplementaryFonts`；
3. 加密包由 engine 抛 `OFD_ENCRYPTED`，CLI 转为 `CLI_CREDENTIALS_REQUIRED`，不进入渲染，退出 4。

有凭据：

1. `openCryptoSource` 重新打开输入文件，组装 `{ kind: 'byte-source', source }`；
2. `openDecryptingContainer({ source, credentials, signal })` 在内存中解密，得到明文 `VirtualContainer`；
3. crypto 返回的 warning 逐条打印；明文包带凭据时产生 `W_CRYPTO_CREDENTIAL_IGNORED`，行为与不带凭据一致；
4. 明文容器交给 `OFDDocument.open({ container, ... })`；engine 只借用容器，不关闭它。

资源所有权与关闭顺序：

- 无凭据路径：engine 基于 `custom` 源创建并拥有容器，`document.close()` 会关闭容器与字节源；CLI 仍对 `NodeFileByteSource` 做幂等兜底关闭；
- 有凭据路径：解密容器由 CLI 创建并拥有，engine 借用；按 `document → container → byteSource` 顺序关闭；
- 成功、异常、取消与 SIGINT 都走同一 `finally`；
- 关闭失败只产生 warning（`W_DOC_CLOSE_FAILED`、`W_CONTAINER_CLOSE_FAILED`、`W_SOURCE_CLOSE_FAILED`），不覆盖主流程结果。

`--text` 时在打开成功后、逐页导出前检查文本 API；未加 `--text` 不检查。

### 6.2 逐页导出

1. 打开成功后用 `document.pageCount` 校验页码范围，得到升序页号列表；
2. 逐页串行执行：
   - `document.getPage(pageNumber - 1)`；失败计页级失败并继续；
   - 用 `page.getViewport({ dpi })` 计算 `ceil(width) × ceil(height)`，超过 engine 默认 `maxCanvasPixels`（64,000,000）时抛 `CLI_PAGE_TOO_LARGE`，按文档级失败退出 2，不分配 Canvas、不写该页文件；
   - `--text` 时先读取文本并原子写 JSON；`OFD_RENDERER_UNSUPPORTED`（映射 `CLI_TEXT_UNSUPPORTED`）及其他文档级 `CliError` 按文档级失败退出 2，不按页级失败处理；其余文本读取失败或写盘失败（`CLI_TEXT_WRITE_FAILED`）都只记页级失败（退出 3），继续尝试同页图片与后续页；
   - 调用 `page.exportImage({ dpi, format, quality: 0.9, background: '#ffffff', signal })`，再原子写图片；图片写盘失败只记页级失败；
3. 页面成功 = 图片写出，且（`--text` 时）JSON 也写出；页级失败保留已成功的那一份产物并继续后续页；
4. 页级失败不改变后续页处理；全部页失败仍返回 3；
5. 取消信号在每页开始与文本写完后检查；图片完成后进入下一页时再检查；命中后停止后续页，已完成页保留，退出 130。

engine 负责整页渲染、尺寸取整、白底与格式编码；CLI 只负责页选择、命名、落盘、进度与汇总。

### 6.3 Canvas、编码与图片解码

- `canvas.ts` 普通 Node 下按包名加载 `@napi-rs/canvas`；SEA 下从 `OFDRW_CANVAS_DIR` 指向的资产目录加载，并依赖 `NAPI_RS_NATIVE_LIBRARY_PATH` 指向平台 `.node`；模块加载结果进程内缓存；
- `createCanvasLike(width, height)` 适配 engine 的 `Canvas2DLike`；`encodeCanvasImage` 按格式调用 `toBuffer`：PNG 忽略质量，JPEG/WebP 使用 CLI 固定的 0.9；
- `image-decoder.ts` 用 `@napi-rs/canvas.loadImage` 提供 PNG/JPEG/WebP 解码插件，注入 `imageDecoders`；
- engine 对 GIF/JBIG2/TIFF 有内置解码器，宿主未注入时按需加载；Node 侧没有浏览器原生解码能力，不能依赖 `createImageBitmap`；
- 图片解码失败由 engine 产生对应 warning（`W_IMAGE_DECODE` 或 `W_JBIG2_DECODE`）并跳过该图，不中断整页。

### 6.4 字体集成

- `--font-dir` 的字体排在系统字体之前，合并时按 realpath 去重；
- CLI 通过 `loadFontInputs()` 在转换开始前读取全部字体字节，以 `supplementaryFonts` 注入 engine；engine 不读路径、不读 URL、不联网；
- 系统字体默认自动发现，`--no-system-fonts` 关闭；发现算法、白名单目录、限额与安全边界由 [`渲染字体缺省方案设计.md`](./渲染字体缺省方案设计.md) 持有；
- 字体字节读取失败产生 `W_FONT_MISSING` 并跳过该文件，其余字体照常注入；
- 缺字体、缺字形分别由 engine 产生 `W_FONT_MISSING`、`W_GLYPH_MISSING`；CLI 只透传，有页号时附页号；
- 单个字体超过 engine 默认 `maxFontBytes`（64 MiB）时被忽略并产生 warning，CLI 不做二次校验。

### 6.5 取消与原子写

- 主流程注册一次 `SIGINT`，首次触发时中止 `AbortController`；信号传入 engine 渲染/文本读取与 crypto 解密/验证；
- 取消后不再开始新页；当前页可能完成也可能中断；已写出的文件保留，不产生半成品；
- 所有输出都先写同目录唯一临时文件（`.名字.tmp-<pid>-<uuid>`），`fsync` 后 `rename` 到目标；任一步失败删除临时文件；
- SIGINT 或取消返回 130；`verify` 取消不产出半份报告；
- 输出目录在读取与渲染前创建；解析阶段的用法错误（如 `--pages` 区间过大、`--dpi` 非法）发生在创建目录之前，凭据构建与页码越界校验发生在创建目录之后。

## 7. 自包含可执行文件与多平台分发

### 7.1 选型

采用 Node SEA（Single Executable Application）：每个产物内嵌 Node 运行时、CLI/engine/crypto JS 与当前平台 `@napi-rs/canvas` 原生模块。

- 运行 CLI 的终端用户不需要安装 Node；包声明的运行时下限仍是 Node ≥ 22；
- SEA 构建使用 `node --build-sea`，构建机要求 Node ≥ 25.5，推荐 26.10；
- 一平台一架构一产物，不做 universal binary，不做跨平台交叉构建；
- 不使用 Bun/Deno 运行时，避免 Skia/N-API 与字体行为差异。

### 7.2 打包流程

1. 生成 SEA 启动包装：先 `prepareSeaAssets()`，失败时打印 `CLI_SEA_EXTRACT_FAILED` 并退出 2，成功后动态导入 `bin.ts`；
2. 用 esbuild 把包装与 CLI/engine/crypto 打成单个 ESM 文件（`format: 'esm'`、`platform: 'node'`、`target: 'node22'`），`@napi-rs/canvas` 保持 external；
3. 收集 `@napi-rs/canvas` 的 JS 与 `package.json` 到 `assets/canvas/`，收集当前平台原生包的 `.node` 与 `package.json` 到 `assets/native/`；
4. 生成 `canvas-manifest.json`：`schemaVersion`、CLI 版本、平台、架构、canvas 版本、原生包名与版本、`.node` 文件名、全部资产摘要（SHA-256 前 16 位十六进制）；
5. 写 `sea-config.json`（`mainFormat: 'module'`、关闭实验 warning、内嵌资产），运行 `node --build-sea`；Unix 设置可执行位；
6. 在隔离临时目录执行冷启动、二次启动与真实 OFD 图片冒烟（文本路径由验收用例单独覆盖）；
7. `package:sea` 把可执行文件、根目录 `README.md` 与 `LICENSE` 打包为 `.tar.gz`（Windows 为 `.zip`），并写 `<归档>.sha256`；不包含 `skills/`、源码或 `.node`。

### 7.3 SEA 启动时的资产解压

普通 Node 下 `prepareSeaAssets()` 直接返回；SEA 下：

- 启动包装在顶层引用 `import.meta.url`，为空时输出 `CLI_SEA_ENTRY_URL` 并退出 2，保证 `createRequire(import.meta.url)` 可用；
- 读取并校验内嵌清单：格式版本、平台/架构与当前进程一致、资产键非空且包含清单声明的 `.node`、路径段安全；
- 平台不匹配时提示下载对应平台产物并退出 2；
- 缓存根：POSIX 为 `<tmpdir>/ofdrw-viewer-cli-u<uid>`，Windows 为 `<tmpdir>/ofdrw-viewer-cli`；
- 缓存目录：`<缓存根>/<u<uid>|win>-<version>-<platform>-<arch>-<digest>/`；
- 解压先写 `<缓存根>/.tmp-<digest>-<pid>-<随机后缀>`，校验全部资产摘要后 `rename` 到缓存目录；并发竞争时若目标已完整则复用，否则 fail-closed；
- `.complete` 文件内容为资产摘要；复用前校验目录/文件类型、非符号链接、POSIX 属主为当前 uid、目录 0700、文件 0600，并按构建脚本相同算法重算摘要；
- 任一校验失败抛 `SeaAssetError`，启动包装输出 `CLI_SEA_EXTRACT_FAILED` 并退出 2，不加载未验证文件；
- 成功后设置 `OFDRW_CANVAS_DIR`、`NAPI_RS_NATIVE_LIBRARY_PATH` 与 `OFDRW_CLI_VERSION`，供 Canvas 加载与版本输出使用；
- 缓存根名可预测：其他用户预建同名根会因属主/权限校验而 fail-closed，只影响该用户启动，不加载未验证资产。

### 7.4 平台矩阵与产物

构建脚本与打包脚本支持以下目标。发布流水线当前在 5 个原生 runner 上构建 Linux/macOS/Windows x64 与 Linux/macOS ARM64；Windows ARM64 产物需在原生 ARM64 runner 上单独构建，不能用 x64 冒充：

| 目标 | 平台-架构 | 归档后缀 |
| --- | --- | --- |
| `linux-x64-gnu` | Linux x86_64 glibc | `.tar.gz` |
| `linux-arm64-gnu` | Linux ARM64 glibc | `.tar.gz` |
| `darwin-x64` | macOS Intel | `.tar.gz` |
| `darwin-arm64` | macOS Apple Silicon | `.tar.gz` |
| `win32-x64` | Windows x64 | `.zip` |
| `win32-arm64` | Windows ARM64 | `.zip` |

- 归档命名：`ofdrw-viewer-cli-<version>-<target>.tar.gz|.zip`，同名 `.sha256` 记录归档摘要；
- Linux 只支持 glibc；不提供 musl/Alpine、LoongArch、RISC-V、32 位 ARM/ARMv7/armhf；
- 归档内只放可执行文件、`README.md`、`LICENSE`。

构建机 Node 版本、本地构建步骤与产物命名以 [`packages/ofdrw-viewer-cli/docs/BUILDING.md`](../packages/ofdrw-viewer-cli/docs/BUILDING.md) 为准；发布流水线的平台范围以仓库内的发布工作流为准（当前为 5 个原生 runner）。

### 7.5 当前限制

- macOS 不签名、不公证，首次运行可能被 Gatekeeper 隔离；Windows 未签名，可能触发 SmartScreen；
- 首次启动需把原生资产解压到系统临时目录，要求临时目录可写且磁盘空间充足；极简容器未提供可写临时目录时无法启动；
- 可预测缓存根可能被其他用户预建，导致该用户启动 fail-closed（退出 2），不影响已存在缓存；
- 产物体积包含 Node 运行时与原生模块，分发体积较大；安全更新只能重新构建并发布；
- 不提供自动更新或后台下载。

## 8. 错误与 warning 呈现

- 错误格式：`错误[CODE]：message`，写 stderr；`CODE` 保留 engine/crypto 原始错误码，CLI 自身错误使用 `CLI_*`；
- page 失败格式：`页面 <page>/<total> 失败 [CODE]：message`；
- warning 格式：`警告 [W_CODE][ 第 N 页]：message`；结束时按 code 汇总；
- warning 不改变退出码，只影响诊断；
- CLI 自身产生的 warning：`W_DPI_HIGH`、`W_FONT_DIR_EMPTY`、`W_FONT_MISSING`（字体字节读取失败）、`W_SOURCE_CLOSE_FAILED`、`W_DOC_CLOSE_FAILED`、`W_CONTAINER_CLOSE_FAILED`；
- engine/crypto warning 的 code 与消息透传（人类可读通道净化后输出）；warning 码集合与注册表由 [`CONTRACTS.md`](./CONTRACTS.md) 与各包 `skills/API.md` 持有，CLI 不新增跨包码；
- 未知异常归 `CLI_UNEXPECTED` 并打印堆栈；用法错误额外打印用法行与 `--help` 指引；
- 错误、warning 与帮助文本不回显口令、私钥、PEM、`EncryptedWK` 或凭据文件内容；
- 人类可读通道净化规则见“控制台输出”；JSON 保留原始值。

## 9. 验证方式

CLI 特有断言（完整矩阵见 [`测试方案.md`](./测试方案.md)）：

- 参数与分派：默认值、子命令参数互斥、`decrypt` 拒绝、`--help`/`-V` 优先、`version` 输出、用法错误中文提示且不回显敏感值；
- 页码：单页/区间/重复/乱序/空白、单段与合计 100000 上限、越界、文档页数超限；
- 命名与目录：默认 `cwd/<stem>/`、补零宽度、`jpeg → .jpg`、覆盖写、目录创建失败；
- 字体：`--font-dir` 递归/过滤/去重/空目录、系统白名单与限额、符号链接与白名单逃逸、合并顺序与日志、`--no-system-fonts`；
- 文本：`text/x/y/w/h`、`items` 顺序、空文本过滤、空页 `[]`、`OFD_RENDERER_UNSUPPORTED` 映射 `CLI_TEXT_UNSUPPORTED`、其他文档级 `CliError` 均退出 2 且不按页级失败处理；其余文本读取失败不阻止图片（页失败退出 3）、文本写盘失败不阻止图片（页失败退出 3）、图片写盘失败保留文本（退出 3）、文本 API 缺失退出 2；
- 原子写与取消：失败/取消无临时文件、已写文件保留、SIGINT 130；
- `info`：加密包无凭据退出 0 且无文档块、明文元数据与页尺寸、文本前 5 页摘要、warning 不改变退出码；
- `verify`：无根 `unknown` 退出 5、有效根 `valid` 退出 0、篡改/夹带 `invalid` 退出 5、缺失凭据 4、`not-applicable` 5、根行计数与链状态去重、时间戳只解析；
- 终端安全：ANSI/C0/C1/U+2028/U+2029 清理、JSON 原值、crypto warning path 清理；
- 性能：`dense-text-perf.ofd` 用例检查每页耗时在宽松超时内、文本顺序与 JSON 体积稳定，没有独立性能门禁；
- SEA：缓存命名与权限、符号链接/属主/摘要负向校验、`CLI_SEA_EXTRACT_FAILED` 退出 2、PATH 不含 Node 时 `--version`/`--help`/图片/文本冒烟。

实现与测试映射（路径以 CLI 包根为基准）：

| 能力 | 实现 | 主要测试 |
| --- | --- | --- |
| 参数、子命令、退出码、进度 | `src/cli.ts` | `test/unit/cli.test.ts`、`test/unit/crypto-cli.test.ts` |
| 转换流程、页级/文档级失败、取消 | `src/convert.ts` | `test/unit/convert.test.ts`、`test/e2e/cli.test.ts` |
| 命名、目录、原子写 | `src/output.ts` | `test/unit/output.test.ts` |
| 页码范围 | `src/pages.ts` | `test/unit/cli.test.ts` |
| 文本 JSON | `src/text.ts` | `test/unit/text.test.ts`、`test/e2e/cli.test.ts` |
| 字体扫描与系统发现 | `src/fonts.ts` | `test/unit/fonts.test.ts` |
| `info` | `src/info.ts` | `test/unit/info-document.test.ts`、`test/unit/crypto-cli.test.ts` |
| `verify` | `src/verify.ts` | `test/unit/crypto-cli.test.ts`、`test/verification/` |
| 凭据、根证书、输入源 | `src/credentials.ts`、`src/node-file-source.ts` | `test/unit/byte-source.test.ts`、`test/unit/node-file-source.test.ts` |
| warning/净化 | `src/log.ts`、`src/safe-text.ts`、`src/crypto-output.ts` | `test/unit/log.test.ts`、`test/unit/stderr-safety.test.ts` |
| SEA 资产与缓存 | `src/sea.ts`、`scripts/build-sea.mjs` | `test/unit/sea.test.ts`、`test/acceptance/sea.acceptance.ts` |
| 黑盒验收 | `dist/bin.js`、`dist/sea/` | `test/acceptance/*.acceptance.ts` |

验证命令：

```bash
pnpm -C packages/ofdrw-viewer-cli typecheck
pnpm -C packages/ofdrw-viewer-cli test
pnpm -C packages/ofdrw-viewer-cli build
pnpm -C packages/ofdrw-viewer-cli test:acceptance
```

`test:acceptance` 会先构建普通 CLI 与 SEA，再以真实子进程运行图片、文本、加密、`info`/`verify` 与 SEA 用例；SEA 用例在 `PATH` 不含 Node 的隔离环境中执行。
