---
name: ofdrw-viewer-cli
description: Convert local OFD documents into per-page PNG/JPEG/WebP images with the ofdrw-viewer-cli executable, export pixel-coordinate text JSON with --text, query package/encryption/signature/integrity metadata with info, and verify anti-smuggling integrity plus every signature and certificate chain with verify. Use when an agent needs OFD page images, spatial text JSON, encrypted-document conversion with a password or SM2 private key, or signature/chain verification. Covers offline local-file input, system and --font-dir font discovery, memory-only decryption, JSON output, exit codes, and terminal-safety limits.
---

# OFD 转图片、查询与验签（ofdrw-viewer-cli）

把单个本地 OFD 文件逐页转换为图片；加 `--text` 时同页再导出一份带像素坐标的文本 JSON。`info` 只读查询包结构、加密层、用户、签名与完整性摘要（明文包另含元数据与页尺寸），不解密、不验签；`verify` 一次性验证防夹带完整性、全部签名、证书链与印章，时间戳只解析、不验证；`version` 输出运行环境，排查问题时先收集。

加密文档可用口令或 SM2 私钥在内存中解密后转图或验证：不写明文文件、不联网、没有 `decrypt` 子命令。

## 适用与不适用

适用：

- 需要 OFD 页面图片（预览、视觉检查、后续图像处理）；
- 需要带像素坐标的文本（版面分析、区域定位、文本搜索高亮）→ 加 `--text`；
- 需要判断是否加密、有哪些用户/签名/完整性保护 → `info`；需要签名有效性与是否被夹带、篡改、证书链是否可信 → `verify`；
- 需要把加密 OFD 转成图片 → 带凭据转图片。

不适用：

- 只需提取 OFD 中的文字：使用 `mineru` skill；本 CLI 只产出页面图与坐标，不做结构化文本提取；
- 浏览器内交互阅读、滚动缩放与打印：使用 `ofdrw-viewer-ui`；
- 批量/目录、通配符、stdin 或 URL 输入、PDF、OCR：不支持，一次只处理一个本地文件。

## 可执行文件定位

按顺序检查：环境变量 `OFDRW_VIEWER_CLI` 指向的路径 → `command -v ofdrw-viewer-cli` → 仓库内构建产物 `packages/ofdrw-viewer-cli/dist/sea/ofdrw-viewer-cli`（Windows 为 `.exe`）。

```bash
CLI="${OFDRW_VIEWER_CLI:-ofdrw-viewer-cli}"
"$CLI" version
```

- `version`：两行，`ofdrw-viewer-cli <版本> (<平台>-<架构>)` 与 `node <Node.js 版本>`；`version --json` 输出 `{ "cli", "platform", "arch", "node" }`；
- `--version`：只输出首行的单行版本；两者都不含依赖包版本。

找不到可执行文件时不要下载或执行来源不明的二进制：告知用户安装 `@ofdrw/ofdrw-viewer-cli`（Node.js >= 22），或从对应平台的 release 压缩包解压运行，并用同目录的 `<压缩包>.sha256` 校验后再执行。

## 子命令与参数

```bash
# 转图片：全部页 PNG，默认 96 DPI，输出到 ./<输入名>/
"$CLI" input.ofd
"$CLI" input.ofd -o ./out --pages 1 --format jpeg --dpi 300
"$CLI" input.ofd --text
"$CLI" input.ofd -o ./out --font-dir ./fonts
"$CLI" input.ofd -o ./out --no-system-fonts

# 版本、查询与验签（未配置根证书时链状态为 unknown，退出 5）
"$CLI" version
"$CLI" version --json
"$CLI" info input.ofd --json
"$CLI" verify signed.ofd
"$CLI" verify signed.ofd --root root-ca.crt.pem --root root.der --json

# 加密文档验证 / 转图片
"$CLI" verify encrypted.ofd --password 'your-password' --root root-ca.crt.pem
"$CLI" verify encrypted.ofd --key signer.key.pem --key-passphrase 'key-pass' --root root-ca.crt.pem
"$CLI" encrypted.ofd -o ./out --password 'your-password'
"$CLI" cert-encrypted.ofd -o ./out --key encrypt.key.pem

# 文件名恰为 info/verify/version/decrypt 时加 ./ 前缀，避免被当作子命令
"$CLI" info ./info
"$CLI" ./verify -o ./out
```

参数：

| 参数 | 默认值 | 适用 | 说明 |
| --- | --- | --- | --- |
| `<input>` | 必填 | 全部 | 单个本地 OFD 文件路径 |
| `-o, --out <dir>` | 当前工作目录下的 `<输入 stem>/` | 转图片 | 输出目录，不存在时创建 |
| `-f, --format <fmt>` | `png` | 转图片 | `png`/`jpeg`/`webp`，大小写不敏感；扩展名分别为 `.png`/`.jpg`/`.webp` |
| `-d, --dpi <n>` | `96` | 转图片 | 正整数；超过 1200 时输出 `W_DPI_HIGH` 警告但继续 |
| `-p, --pages <ranges>` | 全部页 | 转图片 | 1 起闭区间，如 `1-3,5`；自动去重升序，逗号/连字符两侧可含空格 |
| `--font-dir <dir>` | 无 | 转图片 | 递归扫描 `ttf/otf/ttc/otc`，结果排在系统字体之前参与匹配 |
| `--no-system-fonts` | 关闭 | 转图片 | 关闭系统字体自动发现，只使用 `--font-dir`（旧版行为） |
| `--text` | 关闭 | 转图片 | 每页额外导出 `<stem>-p<NNN>.json` |
| `--user <name>` | 无 | 转图片 / verify | 指定加密文档的 `UserInfo@UserName`；必须与 `--password` 或 `--key` 同用 |
| `--password <password>` | 无 | 转图片 / verify | 口令用户；与 `--key` 互斥 |
| `--key <path>` | 无 | 转图片 / verify | SM2 私钥文件（PEM/DER/PKCS#8） |
| `--key-passphrase <text>` | 无 | 转图片 / verify | 加密 PKCS#8 私钥口令；必须与 `--key` 同用 |
| `--root <file>` | 无 | 仅 verify | 信任根证书；PEM（可多证书）、DER/CER 或 Base64 文本，可重复、自动去重 |
| `--sm2-user-id <id>` | 标准值 `1234567812345678` | 仅 verify | 自定义 SM2 签名 userId，首尾空白自动去除 |
| `--json` | 关闭 | info / verify / version | 输出固定 JSON 结构 |
| `-h, --help` | — | 全部 | 显示帮助，优先于输入校验 |
| `-V, --version` | — | 全部 | 单行版本与平台；详细版本用 `version` 子命令 |

参数约束（违反均退出 1，错误码见「退出码与错误」）：

- 一次只接受一个输入文件；缺少输入、未知参数、缺参数值、多个输入都报用法错误；
- `version` 不接受输入文件，也不接受除 `--json` 外的任何选项；`info` 只接受 `--json`，带凭据、`--root`、`--sm2-user-id` 或转图片参数都会报用法错误；
- `verify` 接受凭据、`--root`、`--sm2-user-id`、`--json`，拒绝转图片参数（`-o`、`--format`、`--dpi`、`--pages`、`--font-dir`、`--no-system-fonts`、`--text`）；转图片拒绝 `--root`、`--sm2-user-id`、`--json`；
- `--password` 与 `--key` 互斥；`--key-passphrase` 需要 `--key`；`--user` 需要 `--password` 或 `--key`；各路径选项不接受空值；
- 页码范围语法非法、页号小于 1、区间倒置、单段或总计超过 100000 页、页号超过文档总页数，均退出 1 且不写图片；
- 没有 `decrypt` 子命令：`"$CLI" decrypt` 固定退出 1，并提示改用 `verify` 或带凭据转图片。

## `info` 输出

文本按固定顺序逐行输出，例如：

```text
文件: /abs/input.ofd
大小: 17210 B
OFD 版本: 1.0
加密: 否
用户: 无
签名: 0
完整性: 无
标题: 无
创建工具: 无
页数: 2
页面尺寸: 第 1 页 210×297 mm；第 2 页 210×297 mm
```

前 7 行是包摘要（加密包的 `加密:` 行显示 `是（N 层）`，`用户:` 行显示 `用户名 (方法)`）；明文包继续输出 `标题:`、`作者:`、`主题:`、`创建时间:`、`修改时间:`、`创建工具:`、`页数:`、`页面尺寸:`，缺失值显示 `无`（示例省略了其中四项）。加密包不输出元数据行，改为 `元数据不可用（加密文档，需凭据）`。`页面尺寸` 最多展示前 5 页，超出时追加 `…（共 N 页，完整尺寸见 --json）`。

`info --json` 固定字段：

- `command: "info"`、`input`、`packageSize`、`ofdVersion?`、`encrypted`；
- `layers[]`：每层 `layer/id/encryptDate?/encryptScope?/decryptSeedPath/entriesMapPath/users[]`；
- `users[]`：跨层去重后的 `userName/method`（`password`/`certificate`/`unknown`）；
- `signatureCount`、`integrityPresent`、`warnings[]`；
- `document?`：仅明文包，含 `version`、`pageCount`、`pageSizes[].widthMm/heightMm`、`title`、`author`、`subject`、`abstract`、`creationDate`、`modDate`、`creator`、`creatorVersion`、`keywords`、`docId`、`customData`；缺失字段省略，加密包整体不输出。

`info` 对加密包也退出 0，不需要口令：它不解密、不验签、不读私钥。包损坏或无法读取时才退出 2。

## `verify` 输出

文本示例：

```text
验证结果: valid
完整性: 未保护
签名 1: s001 valid（SESv4，引用 6/6，证书链 valid，印章 valid）
  时间戳: parsed-not-verified（已解析，未验证）（2026-10-22T17:51:06.000Z）
根证书: 已配置 1 / 链 valid
```

- `验证结果` 取报告的 `overall`：`valid`/`invalid`/`unknown`/`unsupported`/`not-applicable`；加密文档先解密，文本额外输出一行 `解密: 已解密（N 层）`；
- `完整性: 未保护` 表示包内没有 `OFDEntries.xml` + `signedvalue.dat`，既不是通过也不是失败；受保护时显示 `status（FileList N，缺失 X，额外 Y）`；
- 每个签名一行，含状态、SES 版本、引用计数、证书链状态与（存在时）印章状态；无签名时输出 `签名: 无`；时间戳只解析、不验证，固定显示 `parsed-not-verified（已解析，未验证）`，解析失败时显示原因；
- `根证书` 行给出命中的信任锚数量（按指纹去重，不是 `--root` 路径数；未命中任何锚时回退为本次配置的路径数）与链状态；多签名与完整性状态按顺序去重聚合（如 `valid/incomplete`）；
- `verify --json` 固定为 `{ command: "verify", input, report }`，`report` 含 `overall`、`package`、`decryption?`、`integrity`、`signatures`、`rootsConfigured`、`warnings`、`startedAt`、`durationMs`；即使 `invalid`/`unknown` 也输出完整报告再退出 5。

只有 `overall=valid` 才退出 0；`invalid`/`unknown`/`unsupported`/`not-applicable` 均退出 5。**未配置 `--root` 时不会被判 `valid`：通常为 `unknown`（退出 5），不能当成验证通过**；配置正确根证书后才会 `valid`。既无签名又无完整性保护的文档为 `not-applicable`，同样退出 5。

## 加密文档

- 口令用户用 `--password`；证书用户用 `--key` 指定 SM2 私钥（PEM/DER/PKCS#8），私钥有口令时加 `--key-passphrase`；需要指定用户时加 `--user`；
- 解密在内存中完成，转图片与验签共用同一套凭据参数，不写明文临时文件；`verify` 对加密文档在内部解密后再验证；
- 缺少凭据、用户名不存在、口令/私钥错误、解密失败：退出 4，不产出页面；
- 明文文档带凭据：凭据被忽略，输出 `W_CRYPTO_CREDENTIAL_IGNORED` 警告；转图片时结果与不带凭据一致并退出 0，`verify` 仍按 `overall` 返回 0 或 5。

## 字体与缺省渲染

只影响转图片；`info`/`verify` 不加载字体。CLI 默认自动发现系统字体，用于渲染文档中未内嵌的文字（尤其是中文）：

| 平台 | 只读扫描目录 |
| --- | --- |
| Linux | `/usr/share/fonts`、`/usr/local/share/fonts`、`~/.fonts`、`~/.local/share/fonts` |
| macOS | `/System/Library/Fonts`、`/Library/Fonts`、`~/Library/Fonts` |
| Windows | `%WINDIR%\Fonts`、`%LOCALAPPDATA%\Microsoft\Windows\Fonts` |

- 只收集 `ttf/otf/ttc/otc`，按 realpath 去重；CJK 关键字字体优先，其次常见西文字体；最多扫描 2000 个字体文件，注入前 6 个、总字节不超过 96 MiB（TTC/OTC 按整个文件计，超预算的字体跳过并继续尝试更小的字体）；
- 只读白名单目录：不跟随目录符号链接，文件符号链接的 realpath 必须仍在白名单内；不写系统目录、不访问网络、不调用 `fc-list`、不访问注册表；
- 不传 `--font-dir`：只用自动发现的系统字体；传 `--font-dir`：与系统字体合并，用户目录优先（按 realpath 去重）；`--no-system-fonts`：关闭自动发现，只用 `--font-dir`，不扫描也不输出发现日志；
- 发现结果以一行日志写 stderr（如 `自动发现系统字体 6 个（扫描 46 个文件）`），不污染 stdout；系统目录不存在或不可读视为未发现、不报错；
- 字体字节由 CLI 自行读取后交给 engine；engine 不联网、不读取字体路径。单个字体文件读取失败上报 `W_FONT_MISSING` 并跳过；转换中仍缺字形时按 `W_FONT_MISSING`/`W_GLYPH_MISSING` 警告处理，转换继续；
- `--font-dir` 目录不存在、不是目录或不可读时退出 1；目录内没有字体文件时输出 `W_FONT_DIR_EMPTY` 警告并继续；出现缺字警告时向用户询问字体目录并追加，不要自动下载字体。

## 输出文件与文本 JSON

默认输出目录为当前工作目录下的输入文件名（不含扩展名），`-o` 覆盖：

```text
out/
  input-p001.png
  input-p001.json
  input-p002.png
```

- 命名 `<输入 stem>-p<页号>.<扩展名>`；页号补零位数为 `max(3, 文档总页数位数)`（如 1000 页文档为 4 位）；扩展名按 `--format` 取 `.png`/`.jpg`/`.webp`；图片白底，JPEG/WebP 固定质量 0.9；
- 每页图片与文本互相独立：一侧失败仍会尝试另一侧，该页计为失败；同名文件直接覆盖；写入采用同目录临时文件 + `fsync` + `rename` 原子替换，成功后不残留临时文件；
- 逐页向 stderr 追加进度行 `[本次序号/本次总页数] 第 <文档页号> 页 开始|完成|失败`，每行独立保留，重定向到管道或日志文件时同样输出；
- 结束时向 stdout 输出一行摘要：成功为 `完成：成功/总数 页 → 输出目录（耗时）`，加 `--text` 时为 `完成：成功/总数 页（图片 + 文本）→ 输出目录（耗时）`；有失败页时追加 `，N 页失败` 且不带耗时；被取消时为 `已取消：成功/总数 页 → 输出目录`。

文本 JSON 每页一个扁平数组，每项只有 `text/x/y/w/h`，按文本项原顺序输出并跳过空文本：

```json
[
  { "text": "发票", "x": 100, "y": 176, "w": 48, "h": 24 }
]
```

- `x/y/w/h` 的单位为 px；原点为页面左上角、y 向下，与同页图片同 DPI；
- 空页写 `[]`；不含字体、字符、页号或页面尺寸，也不含注释/签章文字。

## 退出码与错误

| 码 | 含义 | 处理 |
| --- | --- | --- |
| `0` | 成功 | 图片全部导出、`info` 查询成功，或 `verify` 的 `overall=valid` |
| `1` | 用法/参数/路径错误 | 修正命令后重试，不要原样重试 |
| `2` | 文档级失败 | 非 OFD、包损坏、无法打开、文本 API 缺失、页面像素超限、SEA 资产失败等 |
| `3` | 页级失败（部分或全部页） | 保留已产出文件，按 stderr 定位失败页；其他页结果仍可用 |
| `4` | 加密/凭据失败 | 缺少凭据、用户名不存在、口令/私钥错误、解密失败；向用户确认凭据 |
| `5` | 验证未通过 | `invalid`/`unknown`/`unsupported`/`not-applicable`；无根 `unknown` 属预期 |
| `130` | 用户中断（SIGINT/取消，如 `OFD_ABORTED`） | 已完成的页保留，可重跑 |

常见错误码：

- 用法/路径（退出 1）：`CLI_USAGE`、`CLI_INVALID_FORMAT`、`CLI_INVALID_DPI`、`CLI_INVALID_PAGES`、`CLI_INPUT_NOT_FOUND`、`CLI_INPUT_NOT_FILE`、`CLI_INPUT_UNREADABLE`、`CLI_OUTPUT_NOT_DIRECTORY`、`CLI_OUTPUT_CREATE_FAILED`、`CLI_FONT_DIR_INVALID`、`CLI_FONT_DIR_UNREADABLE`、`CLI_CREDENTIALS_CONFLICT`、`CLI_CREDENTIALS_INCOMPLETE`、`CLI_CREDENTIAL_FILE_NOT_FOUND`、`CLI_CREDENTIAL_FILE_UNREADABLE`、`CLI_ROOT_FILE_NOT_FOUND`、`CLI_ROOT_FILE_UNREADABLE`；
- 文档级（退出 2）：`OFD_INVALID_PACKAGE`、`CRYPTO_INVALID_PACKAGE`、`CLI_TEXT_UNSUPPORTED`（去掉 `--text`）、`CLI_PAGE_TOO_LARGE`（降低 `--dpi`）、`CLI_SEA_EXTRACT_FAILED`（清理或更换 `TMPDIR`）、`CLI_UNEXPECTED`；`info`/`verify` 在参数校验通过后打开输入失败（`CLI_INPUT_UNREADABLE`）也按 2 处理；
- 加密/凭据（退出 4）：`CLI_CREDENTIALS_REQUIRED`、`CRYPTO_CREDENTIALS_REQUIRED`、`CRYPTO_USER_NOT_FOUND`、`CRYPTO_USER_AMBIGUOUS`、`CRYPTO_WRONG_PASSWORD`、`CRYPTO_PRIVATE_KEY_INVALID`、`CRYPTO_PRIVATE_KEY_PASSPHRASE_REQUIRED`、`CRYPTO_PRIVATE_KEY_MISMATCH`、`CRYPTO_UNSUPPORTED_ENCRYPTION`；
- 页级（退出 3）：`CLI_IMAGE_WRITE_FAILED`、`CLI_TEXT_WRITE_FAILED`（检查输出目录权限与同名目录），以及 engine 的逐页错误码（如 `OFD_IMAGE_DECODE`）；
- 验证（退出 5）：签名/完整性/证书链问题通过报告状态体现而不抛错；crypto 抛出的 ASN.1/算法/证书类错误（如 `CRYPTO_ASN1_INVALID`、`CRYPTO_CERTIFICATE_INVALID`）同样退出 5。

## JSON 与终端安全

- `--json` 写 stdout 且保留包内原始值（不做控制字符清理），脚本应解析 stdout，不要解析文本输出；
- `info`/`verify` 的文本输出、`version`、转换摘要写 stdout；错误、warning 与逐页进度写 stderr；
- 面向终端的人类可读输出会移除 ANSI 转义序列，并把换行、C0/C1 控制字符、U+2028/U+2029 替换为空格，防止恶意 OFD 的 UserName、签名 ID、warning 路径伪造终端输出行；未知异常的堆栈按原样输出；
- warning 逐条输出，结束时按 warning 码排序汇总（如 `警告汇总：W_CRYPTO_TRUST_UNKNOWN×1`）；输出格式：`错误[CODE]：message`、`警告 [CODE] 第 N 页：message`、`页面 N/M 失败 [CODE]：message`。

## Agent 工作流

1. **判断需求**：只要图片/坐标 → 转图片；只要元数据 → `info`；要信任结论 → `verify`。
2. **先查询**：`info --json` 确认是否加密、有哪些用户与签名；需要渲染或验证时向用户索取口令或私钥，不要猜。
3. **再验证**：`verify` 前向用户索取信任根；没有根时不会被判 `valid`：通常为 `unknown`，无签名且无完整性为 `not-applicable`，签名/证书本身失效时仍为 `invalid`/`unsupported`，均退出 5；不要向用户报告“验证通过”。
4. **小样本预览**：先 `--pages 1` 检查 PNG；需要坐标时加 `--text`，读取 JSON 按 `text` 搜索并用 `x/y/w/h` 定位。
5. **处理缺字**：默认系统字体；仍有 `W_FONT_MISSING`/`W_GLYPH_MISSING` 时向用户询问字体目录并用 `--font-dir` 追加，不要下载字体。
6. **大文档分批**：用 `--pages` 分段，避免一次生成过多图片与 JSON。
7. **按退出码收尾**：1 修正命令；2/5 向用户说明原因；3 保留已产出并定位失败页；4 确认凭据；130 可直接重跑。

## 安全与限制

- 路径可能含中文/空格，始终加引号；文件名恰为 `info`/`verify`/`version`/`decrypt` 时加 `./` 前缀；
- 只对可信 OFD 运行；超大页面或高 DPI 会占用大量内存（超过 1200 DPI 有 `W_DPI_HIGH` 警告）；
- `--password`/`--key-passphrase` 可能进入 shell 历史或进程列表：不要记录、回显或提交凭据；错误信息只列出参数名，不回显取值；
- CLI 不联网、不访问远程输入、不自动下载字体或二进制；字体只读白名单目录（见「字体与缺省渲染」）；不提供 `decrypt`，不写明文文件；不做 CRL/OCSP 吊销检查；
- 自包含可执行文件首次运行会把原生模块解压到 `<临时目录>/ofdrw-viewer-cli-u<uid>/u<uid>-<版本>-<平台>-<架构>-<摘要>/`（Windows 无 uid 时为 `<临时目录>/ofdrw-viewer-cli/win-<版本>-<平台>-<架构>-<摘要>/`），需要可写的 `TMPDIR`/`TEMP`/`TMP`；目录 0700、文件 0600，复用前校验属主、权限、符号链接与全部资产摘要；POSIX 根按 uid 隔离，不同用户互不干扰；
- 缓存根名可预测：其他用户预建同名根会使本次启动 fail-closed 退出 2（`CLI_SEA_EXTRACT_FAILED`，不加载资产，只影响当前用户启动）。

## 平台提示

- Linux：需要 glibc；Alpine/musl 不支持；
- macOS：release 可执行文件未签名、未公证，首次运行可能被 Gatekeeper 拦截；
- Windows：未签名 exe，可能触发 SmartScreen 提示；遇到拦截时按系统安全策略处理，不要绕过。

## 参考

- 安装、快速开始与演示：[cli README](../README.md)
- 页面渲染、字体匹配与文本层能力：[engine SKILL](../../ofdrw-viewer-engine/skills/SKILL.md)
- 加密检测与解密、签名与证书链能力：[crypto SKILL](../../ofdrw-viewer-crypto/skills/SKILL.md)
