# OFD 转图片、加密查询与验签 CLI（ofdrw-viewer-cli）设计方案

> 状态：设计定稿 v1.3（2026-10-23）
> 定位：`@ofdrw/ofdrw-viewer-engine` 的 Node CLI 子包；消费 engine 与 `@ofdrw/ofdrw-viewer-crypto` 公共 API，输出页面图片/空间文本，并提供 `info` 查询、`verify` 验签与加密文档转图片；发布为多平台自包含可执行文件，并配套仓库内 Agent skill。
> 依据：《OFD 渲染引擎设计方案》v0.5-r12 第 6.1/14.4/15 节、[`docs/text-content-api.md`](./text-content-api.md)、[`docs/ofdrw-viewer-crypto设计方案.md`](./ofdrw-viewer-crypto设计方案.md) 第 7 章。

## 1. 背景与目标

engine 只提供平台无关的页面渲染与文本内容 API，不负责读文件、创建 Canvas、编码图片、写 JSON 和跨平台分发。本子包补齐 Node 侧的完整链路：

```text
OFD 文件
  ├─ crypto.inspect()        → 加密层/用户/签名/完整性摘要（info）
  ├─ engine.getMetadata()/getPageInfos() → 明文文档属性/页数/页尺寸（info）
  ├─ crypto.openDecryptingContainer() → 内存明文容器（加密转图片/verify）
  ├─ crypto.verifyOfd()      → 完整性+签名+链+印章+时间戳解析（verify）
  ├─ page.getTextContent()   → 文字 + 位置（px）
  └─ page.render()           → Canvas → PNG/JPEG/WebP
```

目标：

1. 一条命令完成单文件、多页 OFD 的图片导出，`--text` 时同时导出空间文本；
2. 图片与文本共用同一页、同一 DPI、同一坐标系，可直接叠加；
3. 发布为 Linux/macOS/Windows 自包含可执行文件，用户无需安装 Node；
4. 提供仓库内 Agent skill，让 agent 能稳定定位可执行文件、调用、读取图片与可选 JSON；
5. 对坏文件、缺字体、缺图、文本截断、超大页面给出明确错误/警告；
6. 提供 `info`（只查询）与 `verify`（一次性完整性+签名验证）子命令；
7. 加密 OFD 可用口令或 SM2 私钥在内存中解密后转图片，不落盘明文，不提供独立 `decrypt`。

## 2. 范围

### 2.1 v1.3 范围内

- 单个本地 OFD 文件输入；
- 输出 PNG（默认）、JPEG、WebP；
- `--text` 时输出每页 `<stem>-p<NNN>.json`（每项 `text` + `x/y/w/h`）；默认不输出 JSON；
- 全部页或指定页范围（`1-3,5`）；
- DPI、字体目录补充（`--font-dir`）；
- 人读日志；错误与 warning 直接打印到控制台；
- SIGINT 取消与临时文件清理；
- Node SEA 自包含可执行文件，多平台构建与发布；
- `info` 查询加密层/用户/签名/完整性摘要，明文文档再查元数据/页数/页尺寸，不解密、不验签；
- `verify` 一次性完成防夹带完整性、全部签名、证书链、印章与时间戳解析；
- 加密文档转图片：`--password` 或 `--key`（PEM/DER/PKCS#8），可选 `--key-passphrase`/`--user`；
- `--root`（PEM/DER/CER/Base64，可重复，CLI 入口经 `certificatesToDer` 转为 DER）与 `--sm2-user-id`；
- 终端人类可读输出清理控制字符，JSON 保留原始值；
- Agent skill（仅仓库源文件，不安装到本机，也不随 release 打包）。

### 2.2 v1.3 明确不做

- 多文件/目录批量、通配符、stdin/URL 输入；
- PDF 输出、打印；
- OCR（文本来自 OFD 内容层，不识别图片文字）；
- 注释/签章文字（`includeAnnotations=false`）；
- 多文档包的文档选择（只处理第一个文档）；
- 并行渲染（固定串行）；
- 自动扫描系统字体；
- 图片 DPI 元数据（PNG pHYs / JPEG density）写入；
- 纯文本模式（不渲染图片）；
- 独立 `decrypt` 子命令（加密文档请直接带凭据转图片；`decrypt` 固定退出 1）；
- 明文落盘、批量验签、CRL/OCSP 吊销检查；
- Linux musl/Alpine 产物；
- macOS 签名/公证与 Windows 代码签名。

## 3. 与 engine 的边界

CLI 只能从 `@ofdrw/ofdrw-viewer-engine` 与 `@ofdrw/ofdrw-viewer-crypto` 包根导入类型与 API，禁止跨包相对路径引用内部模块。

| CLI 需要的能力 | 来源 |
| --- | --- |
| 打开文档、页树、页尺寸、渲染任务、取消 | `OFDDocument` / `OFDPage` / `RenderTask` |
| 默认 Canvas2D 渲染器 | `H5Canvas2DRenderer` |
| Viewport 计算 | `page.getViewport({ dpi })` |
| 空间文本 | `page.getTextContent({ dpi, includeChars: false })`，只取 `item.text/rect` |
| 字体补充 | `OFDOpenOptions.supplementaryFonts` |
| 图片解码插件 | `OFDOpenOptions.imageDecoders` |
| warning/error | `onWarning`、`OFDError` |
| 包/加密/签名摘要 | `inspect(source)`，只读，不解密不验签 |
| 加密解密 | `openDecryptingContainer({ source, credentials })` → 明文 `VirtualContainer` |
| 完整性+签名验证 | `verifyOfd({ source/ container, roots, sm2UserId })` → `VerificationReport` |
| crypto warning | `CryptoWarning`；由 CLI 统一写 stderr |

依赖状态：

- 图片链路使用 `OFDDocument.open`、`OFDPage.getViewport` 与 `OFDPage.exportImage`；
- 文本链路使用 `OFDPage.getTextContent`（v1.1 增量，设计见 [`docs/text-content-api.md`](./text-content-api.md)），固定 `includeChars=false`；
- 截至本设计定稿，图片/文本链路与 crypto `info`/`verify`/加密转图片均已落地并通过 CLI 单测、e2e 与 5 文件 82 例黑盒验收（含 SEA）；本机 Linux x64 + Node 26.10 验证。
- CLI 复用 crypto 的口令/私钥解析、解密、验签与链校验，不重复实现密码学逻辑；crypto 不依赖 CLI/UI/engine。

`--text` 时文本 API 不可用的行为：`OFDDocument.open` 成功后检测 `typeof page.getTextContent === 'function'`；不存在则打印 `CLI_TEXT_UNSUPPORTED` 并退出 2，不静默只导出图片。

需要 engine 侧确认的一条契约：

- JBIG2/TIFF 内置解码器（`src/image/format.ts` 的 `builtinImageDecoders`）是否由 `OFDDocument.open` 默认启用。若默认不启用，应从包根导出该插件集合；否则 CLI 只能把 JBIG2/TIFF 页作为“图片缺失 warning”处理。

## 4. Node 约束与子包组织

### 4.1 运行约束

源码与开发环境只面向 Node，不做浏览器/小程序适配：

- 开发运行时 Node ≥ 22，ESM；
- 只用 Node 内置模块：`node:fs/promises`、`node:path`、`node:os`、`node:util.parseArgs`、`node:process`；
- 文件输入由 CLI 的 `NodeFileByteSource` 使用 `fs.promises.open` 随机读；对 crypto 以 `{ kind: 'byte-source', source }` 传入，对 engine 以 `OFDSource` 的 `custom` 形式传入；两种路径都不对输入 OFD 整包 `readFile`；
- 输出先写同目录临时文件，`fsync` 后 `rename`，失败清理临时文件；
- Canvas、图片解码、字体目录直接使用 Node 侧实现；
- 不引入 `jsdom`、browser polyfill、`Blob`/`fetch` 兼容层；
- 日志写 `process.stdout` / `process.stderr`，退出码写 `process.exitCode`。

发布产物是内嵌 Node 运行时的自包含可执行文件，最终用户不需要安装 Node；源码仍只依赖 Node API。

### 4.2 目录

```text
packages/ofdrw-viewer-cli/
  package.json              # type: module；bin: ofdrw-viewer-cli；engines.node >=22
  tsconfig.json
  tsconfig.build.json       # tsc 构建 dist（无 tsup）
  scripts/
    build-sea.mjs           # SEA 打包：bundle、收集 assets、生成可执行文件
  src/
    bin.ts                  # shebang + main()
    cli.ts                  # parseArgs、子命令分派、帮助、参数校验、退出码
    convert.ts              # 打开文档（可注入解密容器）、逐页导出、汇总
    info.ts                 # info 子命令：crypto inspect + engine 明文元数据/文本/JSON 输出
    verify.ts               # verify 子命令：verifyOfd + 文本/JSON 输出
    credentials.ts          # 口令/私钥/根证书读取，组装 crypto 公共类型
    crypto-output.ts        # crypto warning → stderr，统一净化
    safe-text.ts            # 终端文本控制字符清理
    text.ts                 # getTextContent → text + x/y/w/h 数组
    output.ts               # 输出目录、命名、图片编码、原子写
    log.ts                  # 进度、摘要、错误与 warning 输出
    errors.ts               # 错误到退出码映射（含 crypto 4/5）
    canvas.ts               # @napi-rs/canvas 加载（普通 Node / SEA 两种来源）
    sea.ts                  # SEA 资产解压、缓存与 NAPI 路径设置
    image-decoder.ts        # Node 图片解码插件（png/jpeg/webp）
    fonts.ts                # --font-dir 递归扫描与去重
  test/
    unit/                   # 参数、命名、字体、退出码、日志、info/verify、stderr 安全
    e2e/                    # 构建后普通 bin 的真实子进程
    verification/           # 独立 V-CLI 契约/文本/转换用例
    acceptance/             # 黑盒验收：真实 bin/SEA + crypto 夹具 + engine 文本 oracle
```

### 4.3 约定

- 子包目录、包名、命令名（`bin`）统一为 `ofdrw-viewer-cli`；
- 参数解析使用 Node 22 的 `node:util.parseArgs`，不引入 commander/yargs；
- 生产依赖为 `@napi-rs/canvas`、`@ofdrw/ofdrw-viewer-engine`、`@ofdrw/ofdrw-viewer-crypto`；测试可增加 `pngjs`（校验尺寸/非空白），不进入运行时；
- `cli.ts` 负责参数/子命令，`convert.ts`/`info.ts`/`verify.ts` 各自负责一条流程，`text.ts`/`output.ts`/`canvas.ts`/`sea.ts` 各负责一件事；
- 不导出公共库 API；测试通过内部 import 与 `spawn` 完成。

## 5. CLI 接口

### 5.1 用法

```text
ofdrw-viewer-cli <input.ofd> [转图片选项] [加密凭据选项]

ofdrw-viewer-cli info <input.ofd> [--json]

ofdrw-viewer-cli verify <input.ofd> [加密凭据选项] [--root <file>]... [--sm2-user-id <id>] [--json]
```

示例：

```bash
# 全部页：PNG，96 DPI，输出到 ./发票示例/
ofdrw-viewer-cli 发票示例.ofd

# 同时导出空间文本 JSON
ofdrw-viewer-cli 发票示例.ofd --text

# 指定页、JPEG、文本
ofdrw-viewer-cli 发票示例.ofd -o ./out --pages 1-2,4 --format jpeg --text

# 高精度 + 补充字体目录
ofdrw-viewer-cli manual.ofd --dpi 300 --font-dir ./fonts

# 只查询（加密包无需凭据）
ofdrw-viewer-cli info encrypted.ofd --json

# 配置信任根验证；无根时为 unknown
ofdrw-viewer-cli verify signed.ofd --root root-ca.crt.pem

# 加密文档转图片 / 验证
ofdrw-viewer-cli encrypted.ofd -o ./out --password '***'
ofdrw-viewer-cli cert-encrypted.ofd -o ./out --key encrypt.key.pem
ofdrw-viewer-cli signed-encrypted.ofd --password '***' --root root-ca.crt.pem
```

子命令识别：第一个位置参数严格等于 `info` 或 `verify` 时进入子命令；文件名恰为 `info`/`verify`/`decrypt` 时用 `./info`、`./verify`、`./decrypt` 规避。`decrypt` 永远不是子命令，固定用法错误（1）。

### 5.2 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `<input>` | 必填 | 本地 OFD 文件路径 |
| `-o, --out <dir>` | `./<输入文件名>/` | 输出目录；不存在时递归创建；指向文件则报错 |
| `-f, --format <fmt>` | `png` | `png` / `jpeg` / `webp` |
| `-d, --dpi <n>` | `96` | 图片与文本共用的输出 DPI，正整数 |
| `-p, --pages <ranges>` | 全部 | 1 起闭区间，如 `1-3,5`；重复/重叠自动去重排序；总跨度上限 100000 页 |
| `--font-dir <dir>` | 无 | 补充字体目录；递归扫描 ttf/otf/ttc/otc |
| `--text` | 关闭 | 每页额外导出空间文本 JSON |
| `--user <name>` | 无 | 加密文档用户名；转图片/verify |
| `--password <password>` | 无 | 口令用户；与 `--key` 互斥；转图片/verify |
| `--key <path>` | 无 | SM2 私钥（PEM/DER/PKCS#8）；转图片/verify |
| `--key-passphrase <text>` | 无 | 加密 PKCS#8 私钥口令；必须配合 `--key` |
| `--root <file>` | 无 | 信任根证书（PEM/DER/CER/Base64，可重复）；CLI 读取后经 `certificatesToDer` 转为 DER；仅 verify |
| `--sm2-user-id <id>` | `1234567812345678` | 自定义 SM2 签名 userId；仅 verify |
| `--json` | 关闭 | info/verify 输出固定 JSON |
| `-h, --help` | — | 帮助 |
| `-V, --version` | — | 版本与平台 |

参数上下文：

- `info` 只接受输入与 `--json`；带凭据、`--root`、`--sm2-user-id` 或转图片参数 → 用法错误（1）；
- `verify` 接受凭据/`--root`/`--sm2-user-id`/`--json`；拒绝 `-o`/`--format`/`--dpi`/`--pages`/`--font-dir`/`--text`（1）；
- 转图片接受凭据，但拒绝 `--root`/`--sm2-user-id`/`--json`（1）；
- `--password` 与 `--key` 互斥；`--user` 必须与二者之一同用；`--key-passphrase` 必须与 `--key` 同用。

固定行为，不提供参数：

- 白底，不透明；
- 目标文件已存在时直接覆盖，采用“临时文件 + rename”原子替换；
- 串行处理页面；
- 默认只导出图片；`--text` 时每页额外导出空间文本 JSON；
- `--text` 时每项只保留 `text` 与 `rect`（`x/y/w/h`），不含字符级数据；不含注释/签章文字；
- 页级失败继续，结束时汇总；文档级失败立即退出；
- TTY 下显示单行逐页进度 `[N/M]`，非 TTY 不输出进度；
- JPEG/WebP 质量固定 90；
- engine 使用默认选项：`documentIndex=0`、默认 `strictImageCtm`、`layerOrder=type`；
- 不提供其他输出开关；错误与 warning 直接打印到控制台。

参数校验规则：

- `--dpi` 必须是正整数；超过 1200 时给 warning，仍继续；
- `--pages` 语法非法、页码越界（> pageCount）属于用法错误，退出 1；
- `--font-dir` 不存在或不是目录时报错退出 1；目录内无字体时 warning 后继续；
- `--format` 非法时打印允许值并退出 1；
- 未知参数、缺少 `<input>` 时打印 usage 并退出 1。

### 5.3 输出命名与目录

默认每页产出一张图片，文件名同 stem、同页号：

```text
<out>/
  发票示例-p001.png
  发票示例-p002.png
```

加 `--text` 时，同页额外产出同名 JSON：

```text
<out>/
  发票示例-p001.png
  发票示例-p001.json
  发票示例-p002.png
  发票示例-p002.json
```

- 页号至少 3 位，按 `pageCount` 位数取 `max(3, digits)`；
- 输入 stem 原样保留（含中文、空格），不做 slug；
- 单页文档同样使用 `-p001` 后缀；
- 已存在文件直接覆盖，采用原子替换；
- `--text` 时图片与 JSON 同页同 DPI，坐标可直接叠加。

### 5.4 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 全部页成功（允许 warning/文本截断） |
| `1` | 用法错误、参数非法、输入/输出路径错误、页码越界 |
| `2` | 文档级失败：无法打开、非 OFD/包损坏、`--text` 时文本 API 不可用等；加密但缺凭据归 4 |
| `3` | 页级失败：至少一页失败；全部页失败仍为 3 |
| `4` | 加密/凭据失败：缺少凭据、用户名不存在、口令/私钥错误、解密失败 |
| `5` | 验证未通过：verify 的 invalid/unknown/unsupported/not-applicable |
| `130` | 用户中断（SIGINT） |

一个页面成功 = 图片写出；`--text` 时还要求 JSON 也写出。任一失败即该页失败，但保留已成功的那一份。全部页失败仍返回 `3`；文档打开失败才是 `2`。`info` 成功固定 0；`verify` 只有 `overall=valid` 才 0，`unknown` 也 5。

### 5.5 控制台输出

- 成功：`完成：12/12 页 → /abs/out（1.2s）`；`--text` 时为 `完成：12/12 页（图片 + 文本）→ ...`；
- 页失败：即时打印 `页面 3/12 失败 [OFD_IMAGE_DECODE]：...`，继续后续页；结束时打印 `完成：11/12 页，1 页失败 → /abs/out`；
- 文档失败：`打开失败 [OFD_INVALID_PACKAGE]：...`；
- warning：即时打印 `警告 [W_FONT_MISSING] 第 1 页：...`，结束时按 code 汇总计数；
- `info`/`verify` 文本输出写 stdout；JSON（`--json`）也写 stdout，二者不混用；
- warning 逐条写 stderr，结束时输出 `警告汇总：CODE×N、...`；
- 正常摘要写 stdout，错误与 warning 写 stderr；
- TTY 下显示单行进度 `[3/12]`，非 TTY 不输出逐页进度；
- 人类可读 stderr 与 info/verify 文本会移除 ANSI CSI、替换 C0/C1/U+2028/U+2029；未知异常堆栈仍按原样输出；JSON 保留原始值；
- 脚本化依赖退出码与输出文件。

## 6. 空间文本导出（`--text`）

### 6.1 来源与坐标

仅在传入 `--text` 时调用 `OFDPage.getTextContent({ dpi, includeChars: false })`（设计见 [`docs/text-content-api.md`](./text-content-api.md)），不解析 XML、不做 OCR。

CLI 只做一次扁平化，把每个 `TextItem` 转成一条记录：

- `x/y/w/h` 取 `TextItem.rect`；
- 单位 px，原点为页面左上角，y 向下；
- 与同页图片使用同一 `dpi`，坐标可直接叠加到 PNG；
- 旋转/竖排/多 run 的文字取 `rect` 的轴对齐包围盒，不输出 `quad`；
- 每个 `TextItem` 一条，保持 `items` 原始顺序；
- 跳过 `text` 为空的项；
- 不输出页号、字体、层级、矩阵、字符、`truncated` 等字段；页号由文件名给出，页面尺寸由同页 PNG 给出。

### 6.2 JSON 结构

每页写一个扁平数组，元素只有 `text` 与位置：

```json
[
  { "text": "发票", "x": 100, "y": 176, "w": 48, "h": 24 },
  { "text": "金额", "x": 400, "y": 300, "w": 48, "h": 24 }
]
```

转换逻辑：

```ts
const content = await page.getTextContent({ dpi, includeChars: false });
const records = content.items
  .filter((item) => item.text.length > 0)
  .map((item) => ({
    text: item.text,
    x: item.rect.x,
    y: item.rect.y,
    w: item.rect.width,
    h: item.rect.height,
  }));
await writeFileAtomic(jsonPath, JSON.stringify(records));
```

- 空页写 `[]`；
- 坐标保留原始小数，不做取整或单位换算；
- `text` 保留原始内容（可能含空格/换行），位置是该项的包围盒。

### 6.3 粒度与限制

`--text` 启用时：

- 固定 `includeChars=false`，只做文本项级位置，不展开字符；
- 固定 `includeAnnotations=false`、`includeInvisible=false`；
- `layerOrder` 沿用文档打开时的默认值（`type`）；
- 使用 API 默认上限：`maxTextItems=20,000`、`maxTextChars=500,000`；
- 截断不失败：engine 产生 `W_TEXT_ITEM_LIMIT` / `W_TEXT_CHAR_LIMIT` warning，JSON 中不包含截断标志；
- 缺字体时 `text` 仍保留，CLI 不因此判失败。

### 6.4 文本与图片的独立性

`--text` 时每页分别尝试文本与图片；默认只尝试图片：

```ts
let textOk = true;
let imageOk = false;
if (textEnabled) {
  textOk = false;
  try { await exportText(page, outJson); textOk = true; } catch (error) { logPageError(...); }
}
try { await exportImage(page, outImage); imageOk = true; } catch (error) { logPageError(...); }
if (!textOk || !imageOk) pageFailed = true;
```

- 文本失败不阻止图片；图片失败不阻止文本；
- 两者都失败时只记一条页失败；
- `--text` 时文本 API 不存在属于全局能力缺失，打开后立即退出 2，不进入逐页流程；不加 `--text` 不检测该 API。

## 7. 渲染流程

### 7.1 打开文档

```ts
const fileSource = await NodeFileByteSource.open(input);
const cryptoSource: CryptoSource = { kind: 'byte-source', source: fileSource };
let container: VirtualContainer | undefined;
try {
  if (hasCredentials) {
    const opened = await openDecryptingContainer({ source: cryptoSource, credentials });
    container = opened.container;
    reportCryptoWarnings(logger, opened.warnings);
  }
  const doc = await OFDDocument.open({
    ...(container === undefined
      ? { source: { kind: 'custom', source: fileSource } }
      : { container }),
    createCanvas: createCanvasLike,
    encodeImage: encodeCanvasImage,
    imageDecoders: [...nodeImageDecoders],
    supplementaryFonts: fontFiles.map((font) => ({ path: font.path })),
    onWarning: printWarning,
  });
  // ...逐页导出...
  await doc.close();
} finally {
  // crypto 不关闭调用方字节源；engine 直接 custom 路径也由 CLI 幂等兜底。
  await fileSource.close().catch(() => undefined);
  await container?.close().catch(() => undefined);
}
```

- 只使用公共 API；不读取 ZIP、不解析加密 XML；
- 有凭据时把 `{ kind: 'byte-source', source: fileSource }` 传给 `openDecryptingContainer`，再把明文 `VirtualContainer` 注入 engine；容器由 CLI 关闭，明文不落盘；
- 无凭据时把同一 `NodeFileByteSource` 以 engine `custom` 形式直开；加密包由 engine 抛 `OFD_ENCRYPTED`，CLI 映射为退出 4；
- `onWarning` 直接打印到 stderr，不改变退出码；
- 打开失败时打印 `OFDError.code` 并退出 2；
- `--text` 时打开后检测 `page.getTextContent` 是否存在；未加 `--text` 不检测。

### 7.2 逐页导出

```ts
for (const pageNumber of pageNumbers) {
  const page = await doc.getPage(pageNumber - 1);

  // 1) 空间文本（仅 --text）
  if (textEnabled) {
    const content = await page.getTextContent({ dpi, includeChars: false });
    const records = content.items
      .filter((item) => item.text.length > 0)
      .map((item) => ({
        text: item.text,
        x: item.rect.x,
        y: item.rect.y,
        w: item.rect.width,
        h: item.rect.height,
      }));
    await writeAtomic(jsonPath, JSON.stringify(records));
  }

  // 2) 图片（始终）
  const result = await page.exportImage({
    dpi,
    format,
    quality: 0.9,
    background: '#ffffff',
    signal,
  });
  const imagePath = buildImagePath(outDir, stem, pageNumber, format, doc.pageCount);
  await writeFileAtomic(imagePath, result.data);
}
```

- 文本与图片使用同一 `dpi`；
- 默认只处理图片；`--text` 时先文本后图片，文本不依赖 Canvas，失败时仍可继续出图；
- 图片编码、白底、尺寸取整由 engine `exportImage` 负责，CLI 只命名、落盘与汇总；
- 全部结束后 `await doc.close()`，关闭失败只打印 warning。

### 7.3 Node Canvas 加载

`canvas.ts` 需要同时支持两种来源：

- 普通 Node：从 `node_modules` 加载 `@napi-rs/canvas`；
- SEA 可执行文件：从内嵌资产解压目录加载 `@napi-rs/canvas`，并设置 `NAPI_RS_NATIVE_LIBRARY_PATH` 指向平台 `.node`。

```ts
import { createRequire } from 'node:module';
import { join } from 'node:path';

export function loadCanvas(): typeof import('@napi-rs/canvas') {
  const dir = process.env.OFDRW_CANVAS_DIR;
  if (dir) {
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH = join(dir, 'native', manifest.nodeFile);
    return createRequire(join(dir, 'canvas', 'index.js'))(join(dir, 'canvas'));
  }
  return createRequire(import.meta.url)('@napi-rs/canvas');
}
```

- 直接使用 `createCanvas`，不封装 CanvasFactory；
- 编码统一 `canvas.toBuffer(mime, { quality: 90 })`；
- 不引入 `pngjs` 作为运行时依赖。

### 7.4 字体

实现位于 `fonts.ts`：

- `--font-dir` 指定一个目录；
- 递归扫描 `.ttf` / `.otf` / `.ttc` / `.otc`，大小写不敏感；
- 文件按路径字典序排列，去重（`realpath`）；
- 以 `{ path }[]` 传给 `supplementaryFonts`，由 engine 匹配；
- 默认不扫描系统字体；
- 缺字体由 engine 产生 `W_FONT_MISSING`；文本仍保留，图片可能少字形。

### 7.5 图片解码

Node 侧实现位于 `image-decoder.ts`：

- 通过 `@napi-rs/canvas.loadImage` 注入 `png` / `jpeg` / `webp`；
- 插件放在 CLI 生产代码，不复用 engine 测试 helper；
- GIF/BMP v1 不承诺；失败由 engine 产生 `W_IMAGE_DECODE` 并跳过该图；
- JBIG2/TIFF 依赖 engine 内置解码器，契约见第 3 节。

### 7.6 取消与原子写

- 固定串行；
- SIGINT：CLI 主流程 AbortController 触发 `signal`，传给 `exportImage`、`getTextContent` 与 crypto 的 `byte-source` 读取；取消当前页/解密/验证并退出 130；
- `NodeFileByteSource` 在 `finally` 中关闭；无论成功、异常还是取消，都不把文件句柄留给 crypto（crypto 不关闭调用方字节源）；
- 图片写同目录临时文件，完成后 `rename`；`--text` 时 JSON 同样原子写；失败/取消时删除临时文件；
- 中断后已完成的页保留，未完成页不产生半成品文件；
- 超大页面：渲染前用 `width × height` 与 engine 默认 `maxCanvasPixels`（64,000,000）比较，超限提示“降低 --dpi”并退出 2，不分配 canvas。

## 8. 自包含可执行文件与多平台分发

### 8.1 选型

采用 **Node SEA（Single Executable Application）**：

- 官方方案，内嵌 Node 运行时，用户无需安装 Node；
- 原生模块通过 SEA `assets` 嵌入，启动时解压到临时目录，用 `NAPI_RS_NATIVE_LIBRARY_PATH` 加载；
- 已在本机 Linux x64 验证：Node 26.10 + `@napi-rs/canvas` 1.0.13，SEA 可执行文件成功创建 Canvas、输出 PNG 与空间文本 JSON；体积约 180.9 MB；
- 不使用 Bun/Deno 运行时，避免 Skia/N-API 与字体行为的兼容性风险。

构建机要求 Node ≥ 26.10（`node --build-sea` 由 Node 25.5+ 提供）。产物内嵌运行时，终端用户无 Node 版本要求。

### 8.2 打包机制

`scripts/build-sea.mjs`：

1. 用 esbuild 打包 `src/bin.ts`：
   - `format: 'esm'`、`platform: 'node'`、`target: 'node26'`；
   - `external: ['@napi-rs/canvas']`，避免把 canvas JS 打进 bundle；
2. 收集 `@napi-rs/canvas` 包 JS 与 `package.json` 到 `dist/sea/assets/canvas/`；
3. 收集当前平台包（如 `@napi-rs/canvas-linux-x64-gnu`）的 `.node` 与 `package.json` 到 `dist/sea/assets/native/`；
4. 生成 `canvas-manifest.json`（平台包名、`.node` 文件名）；
5. 生成 `sea-config.json`：
   - `main`、`output`、`mainFormat: 'module'`；
   - `disableExperimentalSEAWarning: true`；
   - `assets` 指向上述文件；
6. 运行 `node --build-sea sea-config.json`；
7. Unix 设置可执行位；macOS 只编译产物，不执行 codesign；
8. 运行 `--version`、`--help` 与 `helloworld.ofd` 转换冒烟；空间文本由 acceptance 单独覆盖。

### 8.3 SEA 启动时的资产解压

`sea.ts`：

- `sea.isSea()` 为 false 时直接返回；
- 读取 `sea.getAssetKeys()` / `sea.getRawAsset()`；
- POSIX 缓存根为 `os.tmpdir()/ofdrw-viewer-cli-u<uid>`，Windows 无 uid 时为 `os.tmpdir()/ofdrw-viewer-cli`；版本目录为 `u<uid>-<version>-<platform>-<arch>-<digest>/`；旧共享根 `ofdrw-viewer-cli` 不再读取/复用；
- 用 `.complete` 标记避免重复解压；先写 staging 目录，校验摘要后 `rename`；
- 设置 `OFDRW_CANVAS_DIR` 与 `NAPI_RS_NATIVE_LIBRARY_PATH`；
- POSIX 下校验缓存根、版本目录、`.complete`、`canvas/`、`native/` 与全部清单资产的属主=当前 uid、目录 0700、文件 0600，拒绝符号链接；Windows 拒绝符号链接/重解析点；
- 复用缓存前按构建脚本同算法重算全部资产 SHA-256 摘要，并校验清单字段与路径段；不匹配、权限异常或预置目录非空时统一 `SeaAssetError` → `CLI_SEA_EXTRACT_FAILED` 退出 2，不加载未验证文件；
- 失败时打印明确错误（临时目录不可写、磁盘不足、缓存不安全）并退出 2。

### 8.4 平台矩阵与产物名

| 平台 | 运行器 | 产物 |
| --- | --- | --- |
| Linux x64 (glibc) | `ubuntu-24.04` | `ofdrw-viewer-cli-<version>-linux-x64-gnu.tar.gz` |
| Linux arm64 (glibc) | `ubuntu-24.04-arm` | `ofdrw-viewer-cli-<version>-linux-arm64-gnu.tar.gz` |
| macOS x64 | `macos-13` | `ofdrw-viewer-cli-<version>-darwin-x64.tar.gz` |
| macOS arm64 | `macos-14` | `ofdrw-viewer-cli-<version>-darwin-arm64.tar.gz` |
| Windows x64 | `windows-2022` | `ofdrw-viewer-cli-<version>-win32-x64.zip` |
| Windows arm64 | `windows-11-arm` | `ofdrw-viewer-cli-<version>-win32-arm64.zip` |

每个压缩包包含：

```text
ofdrw-viewer-cli[.exe]
README.md
LICENSE
```

每个单平台产物同时生成 `.sha256`；发布时再由 CI 汇总生成 `SHA256SUMS`。构建、平台限制与 Node 版本要求以 `packages/ofdrw-viewer-cli/docs/BUILDING.md` 为准。

### 8.5 CI 发布流程

仓库使用 `.github/workflows/release-cli.yml`：

- 触发：`workflow_dispatch` 或 tag `cli-v*`；
- matrix 构建各平台；
- 每个 job：安装 Node 26.10、pnpm、依赖，运行 `pnpm -C packages/ofdrw-viewer-cli build:sea -- --target <target>`，执行图片与 `--text` 冒烟测试，运行 `package:sea` 并上传 artifact；
- release job：下载全部 artifact、生成 `SHA256SUMS`、创建 GitHub Release；
- 权限仅 `contents: write`；
- 不自动执行 `git push`；发布由 tag/手动触发。

### 8.6 已知限制

- Linux 仅 glibc；musl/Alpine 不提供；
- 所有 ARM 目标均为 ARM64；不提供 32 位 ARM / ARMv7 / armhf；
- LoongArch/龙芯不提供，Node 与 canvas 生态缺少稳定构建链；
- macOS 只编译可执行文件，不签名、不公证；首次运行可能被 Gatekeeper 拦截；
- Windows 未签名，可能触发 SmartScreen；
- 单文件体积约 180 MB（Linux x64 实测），压缩后仍较大；
- 首次启动需解压约 36 MB 原生模块，后续命中缓存；
- POSIX 缓存根带当前 uid（`ofdrw-viewer-cli-u<uid>`），不同用户不会撞首个用户的 0700 根；旧共享根不再读取/复用。Windows 无 uid 时保留固定根名，`TEMP` 通常按用户隔离；
- 根名可预测：其他用户预建同名根会因属主/权限校验 fail-closed 退出 2（不加载未验证资产），仅造成该用户启动 DoS；
- 安全更新需要重新构建并发布。

## 9. Agent skill

### 9.1 位置与命名

仓库源文件：

```text
packages/ofdrw-viewer-cli/skills/SKILL.md
```

skill 名：`ofdrw-viewer-cli`。skill 源文件作为 CLI 子包的一部分维护，只放仓库，不安装到 `~/.agents/skills/`，也不随 release 压缩包分发。

### 9.2 Skill 内容

frontmatter：

```yaml
---
name: ofdrw-viewer-cli
description: Convert OFD documents into per-page PNG/JPEG/WebP images with the ofdrw-viewer-cli executable, query package/encryption/signature metadata with info, and verify anti-smuggling integrity plus all signatures with verify. Use when an agent needs OFD page images, spatial text JSON, encrypted-document conversion, or signature/chain verification.
---
```

正文必须覆盖：

1. **何时使用**：页面图/坐标文本、加密转换、`info` 元数据查询、`verify` 验签；纯文本解析优先用 `mineru`。
2. **定位可执行文件**：`$OFDRW_VIEWER_CLI` → `command -v ofdrw-viewer-cli` → 仓库 `dist/sea/...`；找不到时按平台下载 release 并校验 `SHA256SUMS`，不要静默安装。
3. **命令**：转图片（含 `--pages/--format/--dpi/--font-dir/--text`）、`info`、`verify`、加密转图片、`--root`/`--sm2-user-id`，以及文件名恰为 `info`/`verify`/`decrypt` 时用 `./` 前缀。
4. **参数上下文**：`info` 只接受 `--json`；`verify` 不接受转图片参数；转图片不接受 `--root`/`--sm2-user-id`/`--json`；口令与私钥互斥。
5. **产物**：默认 `<stem>-p001.png`；`--text` 时额外 `<stem>-p001.json`；`info`/`verify` 文本与 JSON 的字段。
6. **JSON 与文本差异**：`--json` 写 stdout 且保留原始值；文本/stderr 清理控制字符；warning 汇总规则。
7. **Agent 工作流**：
   - 先 `info` 判断是否加密、有哪些用户/签名；
   - 需要信任结论时先向用户索取根证书，再 `verify`；无根 `unknown` 不得报告为通过；
   - 转图片先 `--pages 1` 预览，需要坐标时加 `--text`；
   - 加密文档带凭据转换，不记录/回显凭据；
   - 缺字形时 `text` 仍可用，用 `--font-dir` 重试。
8. **错误处理**：退出码 0/1/2/3/4/5/130；`OFD_*` 与 `CRYPTO_*` 错误码；不要对 2/4/5 盲目重试。
9. **安全**：路径加引号；不要执行不受信任的可执行文件；下载后校验 SHA256；不提供独立 decrypt；大页/高 DPI 注意内存。
10. **平台**：Linux glibc、macOS Gatekeeper、Windows SmartScreen 备注。

### 9.3 分发

- skill 源文件随 CLI 子包版本管理，仅此一份；
- 不放入 release 压缩包，也不在本机安装；
- 不要在 agent 运行环境安装、复制或软链该 skill；仅从仓库读取。

## 10. 错误与 warning 呈现

- 错误：`错误[OFD_XXX]：message`，写 stderr；
- 非 `OFDError`：归类为 `CLI_UNEXPECTED`，打印 message 与堆栈；
- 文本 API 缺失（仅 `--text`）：`CLI_TEXT_UNSUPPORTED`，退出 2；
- 文本 JSON 写盘失败（仅 `--text`）：`CLI_TEXT_WRITE_FAILED`，该页失败、保留图片，退出 3；
- SEA 资产解压/缓存校验失败：`CLI_SEA_EXTRACT_FAILED`，退出 2，不加载未验证文件；
- warning：即时打印 `警告 [W_XXX] 第 N 页：message`，结束时按 code 汇总；
- warning 不改变退出码；文本截断只打印 engine warning，JSON 不含 `truncated` 字段；
- 人类可读 stderr（`Logger.error/warn/pageError` 与 crypto warning 的 message/path）写前统一 `sanitizeDisplayText`：移除 ANSI CSI，替换 C0/C1/U+2028/U+2029，防止恶意 OFD 伪造 warning/错误行；
- `Logger.info` 与 `--json` stdout 保留原始值；info 成功路径在 payload 输出后调用 `flushWarningSummary()`；
- 错误/警告不包含口令、私钥、PEM、`EncryptedWK`。

## 11. 测试与验收

### 11.1 单元测试与 e2e

默认 `pnpm -C packages/ofdrw-viewer-cli test` 运行 15 个文件、258 个用例，不包含较慢的黑盒验收：

- `parseArgs`：必填输入、未知参数、默认值、`--text` 开关、中文参数错误；
- 页码解析：`1-3,5`、重复、乱序、越界、非法输入，以及单段/合并后总页数 100000 上限；
- 输出命名：默认图片；`--text` 时图片与 JSON 成对、同 stem 同页号；
- 字体目录扫描：递归、扩展名过滤、去重、空目录 warning；新增自合成 `test/fixtures/minimal.ttf` 保证 `--font-dir` 始终可执行；
- 退出码映射、摘要、TTY/非 TTY 进度、`CLI_VERSION` 与 package.json 一致；
- 文本 JSON：`TextItem` → `{text,x,y,w,h}`、过滤空 `text`、保持 `items` 顺序、不输出其他字段；空页 `[]`；
- 原子写：成功替换、失败清理临时文件；
- SEA 资产路径、`u<uid>` 缓存命名、属主/0700/0600/符号链接/摘要不符/预置目录负向校验；
- `info`/`verify`：参数上下文、文本/JSON 字段、无根 unknown、有效根 valid、篡改/夹带 invalid、加密凭据、`decrypt` 拒绝；
- 终端安全：Logger.error/warn/pageError、crypto warning message/path、info/verify 文本对换行/ESC/C1/U+2028 的清理，JSON 原值保留；
- 加密转换：口令/私钥、缺/错凭据、页范围/格式/文本参数。

`test/e2e/cli.test.ts` 以真实 `dist/bin.js` 子进程覆盖图片与文本主路径；`test/verification` 独立覆盖 CLI 契约；`test:acceptance` 额外执行 5 文件 82 例黑盒验收（含 SEA）。

### 11.2 图片黑盒验收（CLI 42 例中的图片/参数/退出码部分）

| 用例 | 样本 | 断言 |
| --- | --- | --- |
| 单页 PNG（默认） | `helloworld.ofd` | 退出 0；只有 1 个 PNG；尺寸 = `ceil(viewport)`；白底、非空白 |
| 多页/页码范围 | `999.ofd` | 5 页全量或 `--pages` 只产出选中页；页号补零 |
| 格式 | 任意单页 + `--format jpeg` / `webp` | 扩展名与 magic 正确；白底、非空白 |
| DPI | 任意单页 + `--dpi` | 图片尺寸与 `getViewport({dpi})` 取整一致 |
| 输出目录 | 未指定 `-o` / 嵌套目录 | 默认 `cwd/<stem>/`；不存在时递归创建 |
| 字体目录 | `minimal.ttf` / 系统字体 | 递归扫描；缺失时按报告标记 skip |
| 坏文件/缺文件/目录/页码越界 | 非法输入 | 分别退出 2/1；不创建输出目录 |
| 部分页失败/全部页失败 | `999.ofd` | 保留成功页；退出 3；无 `.tmp` |
| 覆盖与原子替换 | 已存在目标 | 旧文件完整替换；采样期间不出现半成品 |
| SIGINT | 大页样本 | 退出 130；无 `.tmp` 残留 |
| 帮助/版本 | — | 退出 0；含全部参数（含 `--text`）、版本与平台 |

### 11.3 文本黑盒验收（CLI 11 例 + text-mock 2 例）

以下用例均带 `--text`：

| 用例 | 样本 | 断言 |
| --- | --- | --- |
| 第 1 页结构与 oracle | `dense-text-perf.ofd --pages 1` | 147 项；每项恰好 `text/x/y/w/h`；与 96 DPI oracle 全量逐项一致；坐标在页面内 |
| 第 2 页大量文本 | `dense-text-perf.ofd --pages 2` | 8,331 项；与 oracle 全量一致；JSON 约 873 KB；< 30 s |
| 全量两页 | `dense-text-perf.ofd` | 4 个产物；p001/p002 的 PNG+JSON 成对 |
| 空文本页 | `helloworld.ofd` | 写 `[]`（2 B），PNG 仍产出 |
| 不传 `--text` | `dense-text-perf.ofd` | 不调用 `getTextContent`；不生成任何 JSON |
| 格式组合 | `--format jpeg/webp --text` | 图片扩展名正确；JSON 同页号 |
| DPI 组合 | `--dpi 144 --text` | JSON 与 144 DPI oracle 全量一致；PNG 同 DPI |
| 默认输出目录 | `--text` 无 `-o` | PNG 与 JSON 共用 `cwd/<stem>/` |
| 文本写盘失败 | 预占 JSON 路径为目录 | 退出 3；保留同页 PNG；无 `.tmp` |
| 图片写盘失败 | 预占 PNG 路径为目录 | 退出 3；保留同页 JSON；无 `.tmp` |
| SIGINT | `999.ofd --text --dpi 600` | 退出 130；已产出 JSON 可解析、PNG 完整；无 `.tmp` |
| 文本 API 缺失 | mock engine | 退出 2；stderr 含 `CLI_TEXT_UNSUPPORTED`；不写文件 |
| engine 未绑定文本驱动 | mock `OFD_RENDERER_UNSUPPORTED` | 映射 `CLI_TEXT_UNSUPPORTED` 退出 2 |

已知未覆盖：真实缺字体页面仍保留非空 text（设计 §6.3）、多页部分文本失败/文本+图片同时失败、真实旧版 engine 二进制缺 API；这些作为后续补充项。

### 11.4 SEA 可执行文件测试

`test/acceptance/sea.acceptance.ts` 4 例，全部在 `PATH` 不含 Node 的隔离环境中运行：

- `--version` / `--help`；
- `helloworld.ofd`/`999.ofd` 图片转换与缓存命中；
- `dense-text-perf.ofd --text --pages 1` 生成 147 项 JSON + PNG，与 oracle 全量一致；
- `TMPDIR` 不可用时退出 2 并输出 `CLI_SEA_EXTRACT_FAILED`。

构建冒烟由 `build-sea.mjs` 覆盖冷/热启动与 `helloworld.ofd` PNG。

### 11.5 运行平台覆盖

- Linux glibc x64/arm64 必测；
- macOS x64/arm64 必测；
- Windows x64/arm64 必测；
- 路径分隔符、中文/空格文件名、`@napi-rs/canvas` 原生加载；
- 不把平台相关路径写死在测试里，统一用 `node:path` 与临时目录。

### 11.6 性能

- 用 `dense-text-perf.ofd` 记录打开、文本、渲染、总耗时并打印；
- v1 不设硬性性能门禁，保留基线。

## 12. 分阶段与依赖

截至 2026-10-23，本期 P1–P5 已完成并在本机 Linux x64（Node 26.10、glibc）验证；P6 为后续可选项。

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 本设计评审；CLI 参数、输出、文本 JSON、SEA 方案定稿 | 完成 |
| P1 | 包骨架、参数解析、输出/日志、字体目录扫描、Node Canvas/图片解码、单元测试 | 完成 |
| P2 | 接 `OFDDocument`/`OFDPage.exportImage`，跑通图片导出；错误与取消 | 完成 |
| P3 | 接 `OFDPage.getTextContent`，用 `--text` 跑通空间文本 JSON | 完成 |
| P4 | SEA 构建脚本、平台矩阵（含 Windows arm64）、冒烟测试、release workflow | 完成（Linux x64 产物实测；其他平台待 CI/实机） |
| P5 | Agent skill 编写与仓库内校验、README/发布说明 | 完成（v1.3 已同步 info/verify/加密转换） |
| P6（可选） | 批量、并发、系统字体、PDF 输出、纯文本模式 | 未做 |

已知风险与后续项：

- SEA 内嵌原生模块依赖临时目录可写；极简容器需提供可写 tmp；
- 可预测 uid 的其他用户可预建 `ofdrw-viewer-cli-u<uid>` 根，导致该用户 SEA 启动 fail-closed（exit 2，不加载资产）；按用户隔离根不再有跨用户 0700 根冲突；
- 二进制约 180.9 MB，分发体积较大；
- macOS 未签名、未公证、Windows 未签名，首次运行有系统提示；
- 文本 JSON 在超大文档上可能很大（默认 500k 字符上限），需要截断 warning；
- 真实缺字体文本保留、多页部分文本失败、旧版 engine 缺 API 尚未纳入黑盒；
- macOS/Windows/arm64 实机、`windows-11-arm` runner、签名/公证仍待 CI 或用户环境验证；
- JBIG2/TIFF 契约未确认时，扫描类票据样本可能缺图。

## 13. 已定事项与待确认项

已定：

1. 子包目录、包名、命令名统一为 `ofdrw-viewer-cli`；
2. 默认输出目录 `./<输入文件名>/`；
3. 默认 DPI 96；
4. 目标文件已存在时默认覆盖；
5. CLI 参数为输入、输出目录、格式、DPI、页码、字体目录、`--text`、加密凭据、`--root`、`--sm2-user-id`、`--json`；其余行为使用内部默认值；
6. 默认只导出图片；`--text` 时每页额外导出空间文本 JSON；
7. `--text` 的文本为 px 坐标、文本项级 `text + x/y/w/h`、与图片同 DPI；
8. `info` 只查询、不解密不验签；`verify` 一次性验证完整性+全部签名；无独立 `decrypt`；
9. 加密 OFD 用口令或 SM2 私钥解密后渲染，明文不落盘；`--root` 可重复，无根判定 `unknown`；
10. 人类可读 stderr/文本清理控制字符，JSON 保留原始值；
11. 发布采用 Node SEA 自包含可执行文件，Windows arm64 纳入 v1；
12. 提供 `packages/ofdrw-viewer-cli/skills/SKILL.md`，skill 源文件随子包维护，仅放仓库，不安装、不随 release 分发；
13. macOS 只编译可执行文件，不签名、不公证。

待确认：

1. JBIG2/TIFF 内置解码是否由 `OFDDocument.open` 默认启用；
2. `windows-11-arm` runner 是否可用；不可用时是否接受用 ARM64 Node 二进制交叉注入。
## 14. 加密文档、`info` 与 `verify`（v1.3 增量）

本章记录 v1.3 新增的 CLI 契约；crypto 内部算法与报告字段细节以 [`docs/ofdrw-viewer-crypto设计方案.md`](./ofdrw-viewer-crypto设计方案.md) 第 7 章为准。

### 14.1 命令总览与兼容

保留既有“无子命令 = 转图片”的行为：

```text
ofdrw-viewer-cli <input.ofd> [转图片选项] [加密凭据选项]
ofdrw-viewer-cli info <input.ofd> [--json]
ofdrw-viewer-cli verify <input.ofd> [加密凭据选项] [--root <file>]... [--sm2-user-id <id>] [--json]
```

| 命令 | 用途 | 是否解密 | 是否验签 |
| --- | --- | --- | --- |
| 转图片（无子命令） | 页面图片；`--text` 时空间文本 | 提供凭据时解密 | 否 |
| `info` | 包结构/加密层/用户/签名/完整性摘要 + 明文文档元数据/页尺寸 | 否 | 否 |
| `verify` | 防夹带完整性 + 全部签名 + 证书链 + 印章 + 时间戳解析 | 加密输入时内部解密 | 是 |

- 子命令只认第一个位置参数**严格等于** `info` 或 `verify`；文件名恰好为 `info`/`verify`/`decrypt` 时用 `./info`、`./verify`、`./decrypt` 前缀规避。
- `decrypt` 不是子命令；出现时固定用法错误（退出 1），提示使用 `verify` 或带凭据的转图片命令。
- 不提供“只解密”“只验完整性”“只验某个签名”等独立命令。

### 14.2 `info`（只查询）

语义：先读取包结构、加密层、用户、签名条目与完整性存在性；明文包再用 engine 只读打开同一字节源，读取文档属性与页尺寸。**不调用** `openDecryptingContainer`/`verifyOfd`，不读取私钥、不渲染页面、不输出 `EncryptedWK`。加密包无凭据时不自动解密，`document` 省略。

文本示例（明文）：

```text
文件: /abs/input.ofd
大小: 5226 B
OFD 版本: 1.0
加密: 否
用户: 无
签名: 0
完整性: 无
标题: 无
作者: 无
主题: 无
创建时间: 2021-06-02
修改时间: 无
创建工具: OFD R&W（1.9.8）
页数: 2
页面尺寸: 第 1 页 210×297 mm；第 2 页 210×297 mm
```

加密无凭据时在原摘要后追加一行：`元数据不可用（加密文档，需凭据）`。页面尺寸文本最多展示前 5 页，更多页时追加“共 N 页，完整尺寸见 --json”；JSON 始终保留全部页尺寸。

`info --json` 固定结构（对应 `CliInfoJson`）：

```ts
interface CliInfoJson {
  readonly command: 'info';
  readonly input: string;            // 绝对路径
  readonly packageSize: number;      // byte
  readonly ofdVersion?: string;      // 明文优先取 document.version；均不可读时省略
  readonly encrypted: boolean;
  readonly layers: readonly EncryptionLayerInfo[];
  readonly users: readonly EncryptionUserInfo[];
  readonly signatureCount: number;
  readonly integrityPresent: boolean;
  readonly document?: CliDocumentInfo; // 加密无凭据时省略
  readonly warnings: readonly CryptoWarning[];
}

interface CliDocumentInfo {
  readonly version: string;          // 与顶层 ofdVersion 同源
  readonly pageCount: number;        // 页数
  readonly pageSizes: readonly { widthMm: number; heightMm: number }[]; // 每页尺寸，mm
  readonly title?: string;           // DocInfo/Title
  readonly author?: string;
  readonly subject?: string;
  readonly abstract?: string;
  readonly creationDate?: string;    // 原文
  readonly modDate?: string;         // 原文
  readonly creator?: string;
  readonly creatorVersion?: string;
  readonly keywords?: readonly string[];
  readonly docId?: string;
  readonly customData?: Readonly<Record<string, string>>;
}
```

JSON 示例（节选，明文 `plain.ofd`）：

```json
{
  "command": "info",
  "input": "/abs/input.ofd",
  "packageSize": 5226,
  "ofdVersion": "1.0",
  "encrypted": false,
  "layers": [],
  "users": [],
  "signatureCount": 0,
  "integrityPresent": false,
  "document": {
    "version": "1.0",
    "pageCount": 2,
    "pageSizes": [
      { "widthMm": 210, "heightMm": 297 },
      { "widthMm": 210, "heightMm": 297 }
    ],
    "creationDate": "2021-06-02",
    "creator": "OFD R&W",
    "creatorVersion": "1.9.8",
    "docId": "4228962e12c247e2984e79d8334ed10e"
  },
  "warnings": []
}
```

- `layers[]` 从外到内，含 `layer/id/encryptDate?/encryptScope?/decryptSeedPath/entriesMapPath/users[]`；`users[]` 为全层按键去重后的视图，`method` 为 `password`/`certificate`/`unknown`。
- 加密包也退出 0，无需口令；明文包 `encrypted=false`、`layers/users=[]`。加密包无凭据时 `document` 整体省略，但 `layers/users/signatureCount/integrityPresent` 仍按 `inspect` 输出。
- 输入以 `NodeFileByteSource` 构造 `{ kind:'byte-source', source }` 交给 `inspect`；`inspect` 关闭内部容器但不关闭字节源。明文包随后用同一字节源以 `{ kind:'custom', source }` 调 `OFDDocument.open`，只执行 `getMetadata()`/`getPageInfos()`，在 `finally` 关闭 document，再由 CLI 关闭字节源；`document` 关闭失败只产生 warning，不改变退出码。
- 顶层 `ofdVersion` 统一口径：有 `document` 时取 `document.version`，否则取 `inspect.ofdVersion`，避免 crypto/engine 两套版本字段冲突；`document.version` 与之相同。
- 字段缺失时省略，不输出 `null`；文本对缺失的标题/作者/主题/创建时间/修改时间/创建工具显示 `无`。
- `document` 的 `pageSizes` 按页序，单位 mm；JSON 不截断，文本只做摘要。
- 包无法读取/结构非法 → 退出 2；`info` 不因未配置根或未验签失败。engine 打开/读取失败按文档级失败映射，不静默吞掉。
- `inspect` 与 engine 的 warning 都逐条写 stderr（engine warning 可带页号），payload 输出后调用 `flushWarningSummary()`；JSON stdout 不受影响。

### 14.3 `verify`（一次性完整性 + 签名）

语义：输入以 `{ kind:'byte-source', source: NodeFileByteSource }` 交给 `verifyOfd`；若输入加密，crypto 内部用凭据按需解密（内部临时容器）并关闭，再完成防夹带完整性、全部签名、证书链、印章与时间戳解析；时间戳只解析、不验证。CLI 只关闭调用方字节源，不关闭 crypto 内部容器。

文本示例：

```text
验证结果: valid
完整性: 未保护
签名 1: s001 valid（SESv4，引用 6/6，证书链 valid，印章 valid）
  时间戳: parsed-not-verified（已解析，未验证）（2026-10-22T17:51:06.000Z）
根证书: 已配置 1 / 链 valid
```

`verify --json` 固定结构：

```ts
interface CliVerifyJson {
  readonly command: 'verify';
  readonly input: string;            // 绝对路径
  readonly report: VerificationReport;
}
```

`VerificationReport` 关键字段：`overall`、`package`、`decryption?`、`integrity`（未保护为 `null`）、`signatures[]`、`rootsConfigured`、`warnings[]`、`startedAt`、`durationMs`。详细子状态见 crypto 设计 §3.6/§5.7。

行为约定：

- `overall` 取 `valid`/`invalid`/`unknown`/`unsupported`/`not-applicable`；时间戳不参与聚合。
- 只有 `overall=valid` 退出 0；其余（含 `unknown`）退出 5。
- **未配置 `--root` 时链状态为 `unknown`，这是预期安全状态，不是验证通过**；需要可信结论时必须配置正确根证书。
- `--root` 可重复，支持 PEM/DER/CER/Base64；CLI 读取每个文件的原始字节后调用 crypto 的 `certificatesToDer` 转为逐张 DER，再传给只接收 DER 的 `verifyOfd`。同一根以多条路径传入时，文本按实际命中的 `trustAnchor` 指纹去重计数。
- 根证书行固定为 `根证书: 未配置 / 链 <status>` 或 `根证书: 已配置 N / 链 <status>`；多签名/完整性链状态按“签名顺序 + 完整性”去重聚合（如 `valid/incomplete`）。
- `--sm2-user-id` 覆盖默认 SM2 userId `1234567812345678`；仅影响签名数学验证。
- `--json` 即使 `invalid`/`unknown` 也先输出完整报告，再返回 5。
- 签名/完整性均不存在时 `overall=not-applicable`，退出 5。
- 口令错误/用户不匹配/私钥错误 → 退出 4；入口无法产出报告时按包结构/凭据/验证入口分别归 2/4/5。

### 14.4 加密文档转图片

```bash
ofdrw-viewer-cli encrypted.ofd -o out --password '***'
ofdrw-viewer-cli encrypted.ofd -o out --key encrypt.key.pem
ofdrw-viewer-cli encrypted.ofd -o out --key encrypt.key.pem --key-passphrase '***'
```

- 凭据：`--password`（口令用户）或 `--key`（SM2 私钥，PEM/DER/PKCS#8）；可选用 `--user` 指定 `UserInfo@UserName`；`--key-passphrase` 仅用于加密 PKCS#8。
- 流程：`NodeFileByteSource` → `{ kind:'byte-source', source }` → `openDecryptingContainer` → 明文 `VirtualContainer` → `OFDDocument.open({ container })` → 既有页面导出；容器由 CLI 关闭，明文不落盘。
- 字节源由 CLI 拥有，成功、异常、取消/SIGINT 后关闭；crypto 不关闭调用方字节源。明文包时 `openDecryptingContainer` 返回 source-backed 容器，仍由 CLI 关闭。
- 未提供凭据/凭据错误：不进入渲染、不产出页面，退出 4。
- 明文文档不加凭据时行为、输出命名、页码、DPI、`--text`、`--font-dir` 完全兼容旧版。
- 转图片不接受 `--root`/`--sm2-user-id`/`--json`；需要验签请使用 `verify`。
- 页面级失败仍退出 3；文档/包错误 2；SIGINT 130。

### 14.5 JSON 与文本/终端输出

- `info`/`verify` 的 `--json` 都写 stdout，包含固定 `command`/`input`；文本模式写 stdout；warning/error 写 stderr；不混合。
- JSON 保留文档原始值，便于机读；文本/错误/warning 属于人类可读通道。
- 人类可读通道统一净化：移除 ANSI CSI，替换换行/C0/C1/U+2028/U+2029 为空格，覆盖 info UserName、verify Signature ID/parseError、crypto warning message/path、Logger.error/warn/pageError，防止恶意 OFD 伪造输出行；未知异常的堆栈不在净化范围。
- `Logger.info` 不净化，因为 JSON 与正常摘要必须保留原值。
- warning 逐条输出，结束时按 code 汇总；汇总不改变退出码。

### 14.6 退出码与错误边界

| 码 | 语义 | 适用场景 |
| --- | --- | --- |
| 0 | 成功 | 转图片全部成功；info 查询成功；verify `overall=valid` |
| 1 | 用法/参数错误 | 未知参数、缺少输入、`decrypt`、info 带凭据、参数组合冲突 |
| 2 | 文档级失败 | 非 OFD、包损坏、无法打开、SEA 资产失败 |
| 3 | 页级失败 | 转图片至少一页失败；全部页失败仍为 3 |
| 4 | 加密/凭据失败 | 缺少凭据、用户名不存在、口令/私钥错误、解密失败 |
| 5 | 验证未通过 | verify 的 invalid/unknown/unsupported/not-applicable |
| 130 | 用户中断 | SIGINT/AbortSignal |

- 错误格式 `错误[CODE]：message`；warning 格式 `警告 [W_CODE] 第 N 页：message`。
- 输出不得包含口令、私钥、PEM、`EncryptedWK`；错误消息不回显凭据。
- 加密转换的包/解密失败为 4，文档结构为 2，页级为 3，SIGINT 为 130。

### 14.7 安全与实现边界

- CLI 只消费 crypto 公共 API，不重复实现 SM2/SM3/SM4、ASN.1、证书链或解密逻辑。
- OFD 输入统一用 `NodeFileByteSource` 随机读，以 `byte-source` 交给 crypto，不对输入包调用 `readFile` 整包；私钥/根证书/字体等小文件可按原方式读取。
- crypto 先按字节源 `size` 预检 `maxSourceBytes`（默认 256 MiB），不读取内容；超限按文档级失败退出 2。
- 取消经 `AbortSignal` 传入每次字节读取，命中后退出 130；`verify` 的取消不产生半份报告。
- 解密只在内存中发生，不写明文临时文件；`verify` 内部的临时容器不暴露给用户。
- `NodeFileByteSource` 由 CLI 拥有并在成功/失败/取消/SIGINT 后关闭；crypto 不关闭调用方字节源；engine 直接使用 custom 源时由 CLI 幂等兜底关闭。
- 不自动下载根证书/字体/二进制；根证书由用户通过 `--root` 提供。
- 仅对可信 OFD 运行；超大页面/高 DPI 可能占用大量内存。
- `--password`/`--key-passphrase` 可能进入 shell 历史或进程列表，帮助与文档明确提示，不在日志中打印。

### 14.8 实现与测试映射

| 能力 | 实现 | 测试 |
| --- | --- | --- |
| 子命令/参数/退出码 | `src/cli.ts` | `test/unit/cli.test.ts`、`test/unit/crypto-cli.test.ts` |
| info 文本/JSON/明文元数据 | `src/info.ts` | `test/unit/info-document.test.ts`、`test/unit/crypto-cli.test.ts`、`test/verification/cli-info-verify.test.ts`、`test/acceptance/crypto.acceptance.ts` |
| verify 文本/JSON | `src/verify.ts` | 同上 + `test/acceptance/crypto.acceptance.ts` |
| 凭据/根证书读取 | `src/credentials.ts` | `test/unit/crypto-cli.test.ts` |
| warning 呈现/净化 | `src/crypto-output.ts`、`src/log.ts`、`src/safe-text.ts` | `test/unit/stderr-safety.test.ts` |
| 加密转图片 | `src/convert.ts` | `test/verification/cli-convert.test.ts`、acceptance |
| 黑盒/SEA | `dist/bin.js`、`dist/sea/...` | `test/acceptance/*.acceptance.ts` |

验证命令：`pnpm -C packages/ofdrw-viewer-cli typecheck`、`test`、`build`、`test:acceptance`；acceptance 覆盖 5 文件 82 例（含 SEA）。
