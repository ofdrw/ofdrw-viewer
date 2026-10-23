# ofdrw-viewer-cli

[![npm version](https://img.shields.io/npm/v/@ofdrw/ofdrw-viewer-cli)](https://www.npmjs.com/package/@ofdrw/ofdrw-viewer-cli)
[![GitHub release](https://img.shields.io/github/v/release/ofdrw/ofdrw-viewer)](https://github.com/ofdrw/ofdrw-viewer/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-green)](https://nodejs.org/)

## ✨ 功能概述

- **转图片**：把 OFD 逐页导出为 PNG（默认）、JPEG 或 WebP；
- **字体自动发现**：默认使用系统字体渲染文档中未内嵌的文字，`--font-dir` 追加自定义字体，`--no-system-fonts` 可关闭；
- **空间文本**：加 `--text` 时每页额外导出带像素坐标的 JSON；
- **加密文档**：用口令或 SM2 私钥解密后导出，明文不落盘；
- **`info` 查询**：只读查看包大小、加密层、用户、签名、完整性与明文文档元数据/页尺寸，不解密、不验签；
- **`verify` 验签**：一次性校验防夹带完整性、全部签名、证书链印章与时间戳（时间戳只解析展示，不验证）。

> `verify` 不会修改文档，也不提供独立 `decrypt` 子命令；加密文档请直接用凭据执行转图片。

![ofdrw-viewer-cli 演示](demo/demo.gif)

## 📦 安装

```bash
npm install -g @ofdrw/ofdrw-viewer-cli
```

不想安装 Node？从 [Releases](https://github.com/ofdrw/ofdrw-viewer/releases) 下载对应平台的压缩包：Linux/macOS 选 `.tar.gz`，Windows 选 `.zip`。解压后直接运行，无需安装 Node；可用同目录的 `SHA256SUMS` 校验文件。

## ⚡ 用法

### 导出图片

```bash
# 全部页；输出到 ./<输入文件名>/
ofdrw-viewer-cli input.ofd

# 指定目录、页码、格式和清晰度
ofdrw-viewer-cli input.ofd -o out --pages 1-3 --format jpeg --dpi 300
```

`--pages 1-3` 只导出第 1 到第 3 页（含两端）；`--format` 可选 `png`、`jpeg`、`webp`；`--dpi` 控制清晰度，并同步影响文字坐标。

### 字体与缺省渲染

CLI 默认自动发现系统字体，用它们渲染文档中未内嵌的文字（尤其是中文）：

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

### 导出文字位置

```bash
ofdrw-viewer-cli input.ofd --text
```

每页会多一个同名 JSON（如 `input-p001.json`），字段为 `text`、`x`、`y`、`w`、`h`；单位像素，原点在页面左上角，和同页图片使用相同 DPI。

### 查询文档信息

```bash
ofdrw-viewer-cli info input.ofd
ofdrw-viewer-cli info input.ofd --json
```

`info` 先调用 crypto 的 `inspect` 查看包大小、加密层、用户、签名与完整性，不解密、不验签；加密文档不需要口令也能查询，成功退出 `0`。对明文文档，`info` 再用 engine 只读打开同一个 `NodeFileByteSource`，读取 `getMetadata()` 与 `getPageInfos()`，补充 OFD 版本、页数、每页宽高（mm）和 DocInfo 元数据（标题、作者、主题、摘要、创建/修改时间、创建工具/版本、关键字、DocID、自定义字段）。不渲染页面、不读取正文、不验签；文档关闭后再关闭字节源。

文本输出在原摘要后增加标题、作者、主题、创建时间、修改时间、创建工具、页数与页面尺寸；页面超过 5 页时只展示前 5 页，完整页尺寸保留在 `--json`。加密文档无凭据时不输出 `document`，并明确提示 `元数据不可用（加密文档，需凭据）`。`--json` 保留原字段并新增可选 `document`，便于脚本读取。CLI 不整包 `readFile`；`info` 只接受 `--json`，带凭据/`--root` 等参数会报用法错误。

`--json` 示例（节选）：

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

### 验证签名与完整性

```bash
# 配置信任根后验证
ofdrw-viewer-cli verify signed.ofd --root root-ca.crt.pem

# 多个根（PEM/DER/CER/Base64 均可，可重复）
ofdrw-viewer-cli verify signed.ofd --root root.pem --root root.der --json

# 加密文档先解密再验证
ofdrw-viewer-cli verify encrypted.ofd --password 'your-password' --root root-ca.crt.pem
ofdrw-viewer-cli verify encrypted.ofd --key signer.key.pem --key-passphrase 'key-pass' --root root-ca.crt.pem
```

`verify` 在一次调用中完成防夹带完整性与全部签名验证，并输出证书链、印章与时间戳解析结果（时间戳状态固定 `parsed-not-verified`，只解析、不验证）。CLI 同样用 `NodeFileByteSource` 随机读输入并以 `byte-source` 交给 crypto；需要解密时由 crypto 内部按需读取并关闭临时容器。**只有 `overall=valid` 才退出 0**；未配置根证书时链状态为 `unknown`，退出 `5`，这是预期安全状态，不是“验证通过”。

`--root` 文件由 CLI 读取原始字节后调用 `certificatesToDer` 转换为逐张 DER，再传给只接收 DER 的 `verifyOfd`；crypto 不做 PEM/Base64/CER 探测。单个 PEM 文件可含多张证书，多个 `--root` 会按文件顺序展开。

- `--root`：信任根证书，PEM/DER/CER/Base64，可重复；CLI 入口先经 `certificatesToDer` 转为 DER；仅 `verify` 使用；
- `--user`：指定加密文档的 `UserInfo@UserName`，需配合 `--password` 或 `--key`；
- `--password`：口令用户；与 `--key` 互斥；
- `--key`：SM2 私钥文件（PEM/DER/PKCS#8）；
- `--key-passphrase`：加密 PKCS#8 私钥口令，必须与 `--key` 一起使用；
- `--sm2-user-id`：自定义 SM2 签名 userId，默认 `1234567812345678`，仅 `verify` 使用；
- `--json`：`info`/`verify` 以 JSON 输出；`verify` 即使失败也输出完整报告再返回非 0；
- `verify` 不接受 `-o`/`--format`/`--dpi`/`--pages`/`--font-dir`/`--no-system-fonts`/`--text`，需要出图请直接使用转图片命令。

### 加密文档转图片

```bash
ofdrw-viewer-cli encrypted.ofd -o out --password 'your-password'
ofdrw-viewer-cli encrypted.ofd -o out --key encrypt.key.pem
ofdrw-viewer-cli encrypted.ofd -o out --key encrypt.key.pem --key-passphrase 'key-pass'
```

CLI 用 `NodeFileByteSource` 随机读输入，并把 `{ kind: 'byte-source', source }` 交给 crypto；在内存中解密后把明文容器交给 engine 渲染，不生成明文临时文件。缺少凭据或凭据错误时退出 `4`，不会产出页面；其他转图片参数与明文文档完全一致。

### 文件输入与随机访问

CLI 的 OFD 文件输入统一走 `NodeFileByteSource`（`fs.promises.open` + 位置读取），以
`{ kind: 'byte-source', source }` 传给 crypto 的 `inspect`/`openDecryptingContainer`/
`verifyOfd`；明文 `info` 还用同一字节源以 `{ kind: 'custom', source }` 交给 engine
读取元数据。`info`、`verify` 和加密转图片都不会对输入 OFD 调用 `readFile` 整包。
字节源由 CLI 拥有，在成功、失败、取消或 SIGINT 后关闭；engine 关闭文档后 CLI 再
释放字节源，crypto 只读、不关闭调用方字节源。取消通过 `AbortSignal` 传入 crypto
与 engine，命中后按用户中断退出 `130`。crypto 先按字节源的 `size` 检查
`maxSourceBytes`（默认 256 MiB），不读取内容；超限按文档级失败退出 `2`。私钥、
根证书、字体等非 OFD 小文件仍可按原方式读取。

### 文件名恰好为 `info` 或 `verify`

`info`、`verify` 是子命令名。若输入文件恰好叫这两个名字，请在路径前加 `./`，例如 `ofdrw-viewer-cli info ./info` 或 `ofdrw-viewer-cli ./verify`，避免被当成子命令。文件名恰好为 `decrypt` 时同样写成 `./decrypt`。

## 📊 JSON 与文本输出

- `info`/`verify` 的文本输出面向人阅读；`--json` 输出固定结构，写 stdout，可被脚本解析。
- `info --json`：`command`、`input`、`packageSize`、`ofdVersion`、`encrypted`、`layers`、`users`、`signatureCount`、`integrityPresent`、`warnings`；明文文档另有 `document`（`version`、`pageCount`、`pageSizes[].widthMm/heightMm`、`title`、`author`、`subject`、`abstract`、`creationDate`、`modDate`、`creator`、`creatorVersion`、`keywords`、`docId`、`customData`，缺失字段省略）。`document.version` 与顶层 `ofdVersion` 同源；加密无凭据时省略 `document`。
- `verify --json`：`command`、`input`、`report`；`report` 包含 `overall`、`package`、`integrity`、`signatures`、`rootsConfigured`、`warnings` 等字段。
- JSON 保留文档中的原始值；文本/错误/warning 会移除 ANSI 控制序列，并把换行、C0/C1 控制字符和 U+2028/U+2029 替换为空格，防止恶意 OFD 伪造终端输出行；未知异常的堆栈按原样输出。
- warning 逐条写 stderr，结束时按 warning 码输出“警告汇总”；正常摘要写 stdout。

## 🚦 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 成功：图片全部导出、`info` 查询成功，或 `verify` 的 `overall=valid` |
| `1` | 用法/参数错误（未知参数、缺少输入、`decrypt`、参数组合冲突等） |
| `2` | 文档级失败（非 OFD、包损坏、无法打开、SEA 资产失败等） |
| `3` | 页级失败（至少一页失败；全部页失败仍为 3） |
| `4` | 加密/凭据失败（缺少凭据、用户名不存在、口令/私钥错误、解密失败） |
| `5` | 验证未通过（`invalid`/`unknown`/`unsupported`/`not-applicable`） |
| `130` | 用户中断（SIGINT） |

## 🔒 安全提示

- `--password` 和 `--key-passphrase` 可能出现在 shell 历史或进程列表中，请使用安全的方式传递；
- CLI 不打印口令、私钥、PEM 或 `EncryptedWK`；
- 系统字体发现只读上述白名单目录，不写、不下载、不联网；不跟随目录符号链接，文件符号链接经 realpath 校验仍在白名单内才读取；
- 只对可信来源的 OFD 运行；超大页面或高 DPI 可能占用大量内存；
- 未配置根证书时无法判断信任链，`verify` 会明确返回 `unknown` 而不是误报成功。

## 📖 完整说明

想了解全部参数、输出规则和 Agent 工作流，运行 `ofdrw-viewer-cli --help`，或查看 [完整说明](https://github.com/ofdrw/ofdrw-viewer/blob/main/packages/ofdrw-viewer-cli/skills/SKILL.md)。

## 🛠️ 开发

在仓库根目录构建并运行测试：

```bash
pnpm cli:build
pnpm cli:test
```

## 📄 许可证

本项目采用 [MIT License](../../LICENSE) 开源。Copyright (c) 2026 Quan Guanyu
