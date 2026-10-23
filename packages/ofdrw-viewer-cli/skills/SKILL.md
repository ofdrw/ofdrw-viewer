---
name: ofdrw-viewer-cli
description: Convert OFD documents into per-page PNG/JPEG/WebP images with the ofdrw-viewer-cli executable, query package/encryption/signature metadata with info, and verify anti-smuggling integrity plus all signatures with verify. Use when an agent needs OFD page images, spatial text JSON, encrypted-document conversion, or signature/chain verification.
---

# OFD 转图片、查询与验签（ofdrw-viewer-cli）

把单个 OFD 文件转换为每页一张图片；加 `--text` 时，同页再输出一个带坐标的文本 JSON。另提供两个只读子命令：

- `info`：查询包结构、加密层、用户、签名与完整性，不解密、不验签；
- `verify`：一次性验证防夹带完整性、全部签名、证书链、印章与时间戳解析。

加密文档可直接用口令或 SM2 私钥转图片；CLI 在内存中解密，不生成明文文件，也没有独立 `decrypt` 子命令。

## 何时使用

- 需要 OFD 页面图片（预览、视觉检查、后续图像处理）；
- 需要带像素坐标的文本（版面分析、区域定位、文本搜索高亮）→ 加 `--text`；
- 需要判断 OFD 是否加密、有哪些用户/签名/完整性保护 → `info`；
- 需要验证签名是否有效、是否被夹带/篡改、证书链是否可信 → `verify`；
- 需要把加密 OFD 转成图片 → 带凭据执行转图片。

如果任务只是读取 OFD 中的文字，优先使用 `mineru` skill；本 CLI 用于页面图、空间坐标、加密转换或验签场景。

## 定位可执行文件

按顺序检查：

1. 环境变量 `OFDRW_VIEWER_CLI` 指向的路径；
2. `command -v ofdrw-viewer-cli`；
3. 仓库内构建产物：`packages/ofdrw-viewer-cli/dist/sea/ofdrw-viewer-cli`（Windows 为 `.exe`）。

```bash
CLI="${OFDRW_VIEWER_CLI:-ofdrw-viewer-cli}"
"$CLI" --version
```

如果找不到可执行文件，**不要擅自下载或执行来源不明的二进制**。告知用户需要安装，并给出对应平台的 release 压缩包与 `SHA256SUMS` 校验步骤。

本 skill 只随仓库维护，不安装到 `~/.agents/skills/`；不要把它复制到 agent 运行环境。

## 命令

```bash
# 转图片：全部页 PNG，默认 96 DPI，输出到 ./<输入名>/（不含扩展名）
"$CLI" input.ofd

# 指定页、输出目录、格式、DPI
"$CLI" input.ofd -o ./out --pages 1 --format jpeg --dpi 300

# 同时导出空间文本 JSON
"$CLI" input.ofd --text

# 补充字体目录（默认已自动发现系统字体，这里仅追加自定义字体）
"$CLI" input.ofd -o ./out --font-dir ./fonts

# 关闭系统字体自动发现，仅使用 --font-dir（复现旧版行为）
"$CLI" input.ofd -o ./out --no-system-fonts

# 只查询，不解密/不验签
"$CLI" info input.ofd
"$CLI" info input.ofd --json

# 验签：未配置根证书时链状态为 unknown，退出 5
"$CLI" verify signed.ofd
# 配根后验证；--root 可重复，支持 PEM/DER/CER
"$CLI" verify signed.ofd --root root-ca.crt.pem
"$CLI" verify signed.ofd --root root.pem --root root.der --json

# 加密文档验证 / 转图片
"$CLI" verify encrypted.ofd --password 'your-password' --root root-ca.crt.pem
"$CLI" verify encrypted.ofd --key signer.key.pem --key-passphrase 'key-pass' --root root-ca.crt.pem
"$CLI" encrypted.ofd -o ./out --password 'your-password'
"$CLI" cert-encrypted.ofd -o ./out --key encrypt.key.pem

# 文件名恰为 info/verify/decrypt 时用 ./ 前缀避免被当作子命令
"$CLI" info ./info
"$CLI" ./verify -o ./out
```

参数：

| 参数 | 默认 | 适用 | 说明 |
| --- | --- | --- | --- |
| `<input>` | 必填 | 全部 | 本地 OFD 文件 |
| `-o, --out <dir>` | `./<输入名>/`（不含扩展名） | 转图片 | 输出目录 |
| `-f, --format <fmt>` | `png` | 转图片 | `png` / `jpeg` / `webp` |
| `-d, --dpi <n>` | `96` | 转图片 | 图片与文本共用的 DPI |
| `-p, --pages <ranges>` | 全部 | 转图片 | 1 起闭区间，如 `1-3,5`；总跨度上限 100000 页 |
| `--font-dir <dir>` | 无 | 转图片 | 补充字体目录；默认已自动发现系统字体，此处结果优先参与匹配 |
| `--no-system-fonts` | 关闭 | 转图片 | 关闭系统字体自动发现，仅使用 `--font-dir`（旧版行为） |
| `--text` | 关闭 | 转图片 | 每页额外导出空间文本 JSON |
| `--user <name>` | 无 | 转图片 / verify | 指定加密文档的 `UserInfo@UserName` |
| `--password <password>` | 无 | 转图片 / verify | 口令用户；与 `--key` 互斥 |
| `--key <path>` | 无 | 转图片 / verify | SM2 私钥（PEM/DER/PKCS#8） |
| `--key-passphrase <text>` | 无 | 转图片 / verify | 加密 PKCS#8 私钥口令，必须配合 `--key` |
| `--root <file>` | 无 | 仅 verify | 信任根证书，PEM/DER/CER，可重复 |
| `--sm2-user-id <id>` | `1234567812345678` | 仅 verify | 自定义 SM2 签名 userId |
| `--json` | 关闭 | info / verify | 输出固定 JSON 结构 |
| `-h, --help` | — | 全部 | 帮助 |
| `-V, --version` | — | 全部 | 版本与平台 |

`info` 只接受 `--json`；带 `--user/--password/--key/--key-passphrase/--root/--sm2-user-id` 或转图片参数会报用法错误（1）。
`verify` 不接受转图片参数（`-o`/`--format`/`--dpi`/`--pages`/`--font-dir`/`--no-system-fonts`/`--text`）；需要导出图片时不要使用 `verify` 子命令。
转图片不接受 `--root`/`--sm2-user-id`/`--json`。

## `info` 输出

文本示例：

```text
文件: /abs/input.ofd
大小: 17210 B
OFD 版本: 未知
加密: 是（1 层）
用户: fixture-password-user (password)
签名: 0
完整性: 无
```

`info --json` 固定字段：

- `command: "info"`、`input`、`packageSize`、`ofdVersion?`、`encrypted`；
- `layers[]`：每层 `layer/id/encryptDate?/encryptScope?/decryptSeedPath/entriesMapPath/users[]`；
- `users[]`：去重后的 `userName/method`（`password`/`certificate`/`unknown`）；
- `signatureCount`、`integrityPresent`、`warnings[]`；
- `document?`：仅明文文档，含 `version`、`pageCount`、`pageSizes[].widthMm/heightMm`、`title`、`author`、`subject`、`abstract`、`creationDate`、`modDate`、`creator`、`creatorVersion`、`keywords`、`docId`、`customData`；缺失字段省略。加密文档不输出（`info` 不读取凭据）。

`info` 对加密包也返回 0，不需要口令；它不会解密、不会验签、不会读取私钥。包损坏/无法读取时才退出 2。

## `verify` 输出

文本示例：

```text
验证结果: valid
完整性: 未保护
签名 1: s001 valid（SESv4，引用 6/6，证书链 valid，印章 valid）
  时间戳: parsed-not-verified（已解析，未验证）（2026-10-22T17:51:06.000Z）
根证书: 已配置 1 / 链 valid
```

- `验证结果` 取 `overall`：`valid`/`invalid`/`unknown`/`unsupported`/`not-applicable`；
- `完整性: 未保护` 表示没有 OFDEntries.xml + signedvalue.dat，不是通过也不是失败；
- 时间戳只解析、不验证，固定显示“已解析，未验证”；
- `根证书` 行同时给出配置数量与链状态；多签名/完整性状态会按顺序去重聚合（如 `valid/incomplete`）；
- `verify --json` 固定为 `{ command: "verify", input, report }`，`report` 含 `overall/package/integrity/signatures/rootsConfigured/warnings` 等字段；即使 `invalid`/`unknown` 也输出完整报告再退出 5。

只有 `overall=valid` 才退出 0。**未配置 `--root` 时链状态是 `unknown`，退出 5，不能当成验证通过**；配置正确根证书后才会得到 `valid`。无效/被篡改/夹带/不支持的文档退出 5，不是 0。

## 加密文档转图片

- 口令：`--password`；
- 证书用户：`--key` 指定 SM2 私钥；私钥有口令时加 `--key-passphrase`；
- 可选用 `--user` 指定用户名；
- 解密在内存中完成，随后交给 engine 渲染，不写明文临时文件；
- 缺少凭据、用户名不存在、口令/私钥错误：退出 4，不产出页面；
- 明文文档不加凭据时行为与旧版完全一致；
- 没有独立 `decrypt`；`"$CLI" decrypt` 固定退出 1。

## 字体与缺省渲染

适用于转图片；`info`/`verify` 不加载字体。CLI 默认自动发现系统字体，用它们渲染文档中未内嵌的文字（尤其是中文）：

| 平台 | 只读扫描目录 |
| --- | --- |
| Linux | `/usr/share/fonts`、`/usr/local/share/fonts`、`~/.fonts`、`~/.local/share/fonts` |
| macOS | `/System/Library/Fonts`、`/Library/Fonts`、`~/Library/Fonts` |
| Windows | `%WINDIR%\Fonts`、`%LOCALAPPDATA%\Microsoft\Windows\Fonts` |

发现过程只收集 `ttf/otf/ttc/otc`，按 realpath 去重，CJK 关键字字体优先；最多扫描 2000 个字体文件，并按优先级注入前 6 个、总字节不超过 96 MiB（TTC/OTC 按整个文件字节计，超出预算的字体跳过并继续尝试后续更小字体）。只读上述白名单目录，不写系统目录、不访问网络；不跟随目录符号链接，文件符号链接的真实路径必须仍在白名单目录内。

- 不传 `--font-dir`：只使用自动发现的系统字体；
- `--font-dir <dir>`：扫描结果作为扩充，参与字体匹配时排在系统字体之前，两者按 realpath 去重；
- `--no-system-fonts`：关闭自动发现，仅使用 `--font-dir`，与旧版本行为一致。

发现数量以一行日志写入 stderr（如 `自动发现系统字体 6 个（扫描 46 个文件）`），不污染 stdout 的摘要/JSON；使用 `--no-system-fonts` 时不扫描、也不输出该行。系统目录不存在或不可读时视为未发现，不报错；仍然找不到字体时按原有 `W_FONT_MISSING`/`W_GLYPH_MISSING` 处理。

## 输出（图片与文本）

默认：

```text
out/
  input-p001.png
  input-p002.png
```

加 `--text`：

```text
out/
  input-p001.png
  input-p001.json
  input-p002.png
  input-p002.json
```

- 命名：`<输入 stem>-p<NNN>.<ext>`，页号至少 3 位；
- 已存在文件会被覆盖；
- 每页独立处理：某页文本失败仍会尝试出图，反之亦然；
- 页范围总跨度超过 100000 页会在展开前退出 1。

文本 JSON 每页一个扁平数组，每项只有 `text/x/y/w/h`：

```json
[
  { "text": "发票", "x": 100, "y": 176, "w": 48, "h": 24 }
]
```

`x/y/w/h` 单位 px，原点为页面左上角，y 向下，与同页 PNG 同 DPI；空页为 `[]`；不含字体、字符、页号或页面尺寸。

## JSON 与终端安全

- `--json` 写 stdout，保留文档中的原始值；脚本应解析 stdout，不解析文本输出。
- 错误与 warning 写 stderr；info/verify 的文本输出、`--json` 与成功摘要写 stdout。
- 人类可读的 stderr 会移除 ANSI 控制序列，并把换行、C0/C1 控制字符、U+2028/U+2029 替换为空格，防止恶意 OFD 的 UserName、签名 ID、warning 路径伪造终端输出行；未知异常的堆栈按原样输出。
- warning 逐条输出，结束时按 warning 码汇总（如 `警告汇总：W_CRYPTO_TRUST_UNKNOWN×1`）。
- 错误格式为 `错误[CODE]：message`；warning 格式为 `警告 [W_CODE] 第 N 页：message`。

## Agent 工作流

1. **先判断需求**：只要图片/坐标 → 转图片；只要元数据 → `info`；要信任结论 → `verify`。
2. **查询**：先 `info --json`，确认是否加密、有哪些用户与签名；加密且需要渲染/验证时向用户索取口令或私钥，不要猜。
3. **验签**：`verify` 前尽量向用户索取信任根；没有根时结果一定是 `unknown`（退出 5），不要向用户报告“验证通过”。
4. **预览**：转图片先 `--pages 1`，检查 PNG 是否正常。
5. **坐标**：需要时加 `--text`，读取 JSON，按 `text` 搜索并用 `x/y/w/h` 定位。
6. **加密转换**：带 `--password` 或 `--key`；不要把口令写进脚本日志或提交到仓库。
7. **缺字/乱码**：CLI 默认会自动发现系统字体（stderr 有「自动发现系统字体 N 个（扫描 M 个文件）」）；若仍有 `W_FONT_MISSING`/`W_GLYPH_MISSING`，向用户询问字体目录并用 `--font-dir` 追加。不要自动下载字体；`--no-system-fonts` 仅用于复现旧版行为或强制只用指定目录。详见「字体与缺省渲染」。
8. **大文档**：优先按页码范围分批，避免一次生成过多图片与 JSON。

## 退出码与错误

| 码 | 含义 | 处理 |
| --- | --- | --- |
| `0` | 成功 | 图片全部导出、`info` 查询成功，或 `verify` 的 `overall=valid` |
| `1` | 参数/路径错误 | 修正命令，不要重试 |
| `2` | 文档级失败（非 OFD、包损坏、无法打开、`--text` 文本 API 不可用、SEA 资产失败等） | 读取 stderr 的 `OFD_*`/`CLI_TEXT_UNSUPPORTED`/`CLI_SEA_EXTRACT_FAILED`，不要盲目重试 |
| `3` | 页级失败（部分或全部页） | 保留已产出文件，读取 stderr 定位失败页 |
| `4` | 加密/凭据失败 | 缺少凭据、用户名不存在、口令/私钥错误、解密失败；向用户确认凭据，不要反复尝试 |
| `5` | 验证未通过 | `invalid`/`unknown`/`unsupported`/`not-applicable`；无根 `unknown` 属预期，需向用户说明 |
| `130` | 用户中断 | 已完成的页保留，可重跑 |

常见错误：

- `OFD_INVALID_PACKAGE`：文件不是有效 OFD 包；
- `OFD_ENCRYPTED`：文档加密，转图片/验证需要凭据；
- `CRYPTO_CREDENTIALS_REQUIRED`：加密文档未提供凭据（退出 4）；
- `CRYPTO_WRONG_PASSWORD` / `CRYPTO_PRIVATE_KEY_MISMATCH`：口令或私钥不匹配（退出 4）；
- `CRYPTO_INVALID_PACKAGE`：包结构/加密元数据损坏；
- `OFD_PAGE_NOT_FOUND`：页码范围越界；
- `OFD_CANVAS_TOO_LARGE`：页面/DPI 过大，降低 `--dpi`；
- `CLI_TEXT_UNSUPPORTED`：engine 没有文本 API；去掉 `--text` 或升级 engine/CLI；
- `CLI_TEXT_WRITE_FAILED`：文本 JSON 写盘失败；检查输出目录权限/同名目录；
- `CLI_SEA_EXTRACT_FAILED`：SEA 缓存不可写、权限/属主/符号链接异常或资产摘要不匹配；清理/更换 `TMPDIR` 或使用 release 重新运行；
- `OFD_ABORTED`：被取消。

## 安全与限制

- 路径可能含中文/空格，始终加引号；文件名恰为 `info`/`verify`/`decrypt` 时加 `./`；
- 只对可信的 OFD 文件运行；超大页面/高 DPI 可能占用大量内存；
- 默认自动扫描白名单系统字体目录（只读、不联网，注入上限 6 个 / 96 MiB，目录符号链接不跟随）；`--no-system-fonts` 可关闭；不自动下载字体或二进制；
- `--password`/`--key-passphrase` 可能进入 shell 历史或进程列表；不要记录、回显或提交凭据；
- 不提供独立 `decrypt`，不写明文文件；
- 不支持批量/目录、PDF、OCR、注释文字、Linux musl；
- 首次运行自包含可执行文件时会把原生模块解压到 `<tmpdir>/ofdrw-viewer-cli-u<uid>/u<uid>-<version>-<platform>-<arch>-<digest>/`（Windows 无 uid 时根为 `<tmpdir>/ofdrw-viewer-cli`），需要可写的 `TMPDIR`/`TEMP`/`TMP`；目录 0700、文件 0600，复用前校验属主与全资产摘要；
- POSIX 缓存根按当前 uid 隔离（`ofdrw-viewer-cli-u<uid>`），不同用户不会撞首个用户的 0700 根；旧共享根不再读取/复用；Windows 无 uid 时保留固定根名；
- 根名可预测：其他用户预建同名根会因属主/权限校验 fail-closed 退出 2（不加载资产），仅造成该用户启动 DoS；
- CLI 的 npm `files` 只有 `dist`，release 压缩包只有可执行文件、README、LICENSE；skill 不进入包或发布，也不安装到用户目录；
- macOS 首次运行可能被 Gatekeeper 拦截；Windows 可能触发 SmartScreen。按用户环境说明处理，不要绕过系统安全策略。

## 平台提示

- Linux：需要 glibc；Alpine/musl 不支持；
- macOS：release 只编译可执行文件，不签名、不公证；
- Windows：未签名 exe，SmartScreen 可能提示。

## 参考

- CLI 设计：`docs/CLI设计方案.md`
- CRYPTO 设计：`docs/ofdrw-viewer-crypto设计方案.md` 第 7 章
- 文本 API 细节：`docs/text-content-api.md`