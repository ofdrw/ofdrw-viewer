---
name: ofdrw-viewer-cli
description: Convert OFD documents into per-page PNG/JPEG/WebP images with the ofdrw-viewer-cli executable, optionally adding spatial text JSON via --text. Use when an agent needs OFD page images, text with pixel coordinates, layout inspection, or OCR-free text extraction from an OFD file.
---

# OFD 转图片与空间文本（ofdrw-viewer-cli）

把单个 OFD 文件转换为每页一张图片；加 `--text` 时，同页再输出一个带坐标的文本 JSON。图片与 JSON 使用同一 DPI、同一坐标系，可直接叠加。

默认只出图片，避免不需要文本时产生额外文件。

## 何时使用

- 需要 OFD 的页面图片（预览、视觉检查、后续图像处理）；
- 需要带像素坐标的文本（版面分析、区域定位、文本搜索高亮）→ 加 `--text`；
- 需要把 OFD 内容交给只接受图片/JSON 的下游流程。

如果任务只是读取 OFD 中的文字，优先使用 `mineru` skill；本 CLI 用于需要**页面图或空间坐标**的场景。

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
# 全部页：每页 PNG，默认 96 DPI，输出到 ./<输入文件名>/
"$CLI" input.ofd

# 同时导出空间文本 JSON
"$CLI" input.ofd --text

# 指定输出目录
"$CLI" input.ofd -o ./out

# 先看第一页
"$CLI" input.ofd -o ./out --pages 1 --dpi 96

# 高精度 + 文本
"$CLI" input.ofd -o ./out --dpi 300 --text

# JPEG / WebP
"$CLI" input.ofd -o ./out --format jpeg

# 缺字体时补充字体目录
"$CLI" input.ofd -o ./out --font-dir ./fonts
```

参数只有：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `<input>` | 必填 | 本地 OFD 文件 |
| `-o, --out <dir>` | `./<输入文件名>/` | 输出目录 |
| `-f, --format <fmt>` | `png` | `png` / `jpeg` / `webp` |
| `-d, --dpi <n>` | `96` | 图片与文本共用的 DPI |
| `-p, --pages <ranges>` | 全部 | 1 起闭区间，如 `1-3,5`；总跨度上限 100000 页 |
| `--font-dir <dir>` | 无 | 补充字体目录 |
| `--text` | 关闭 | 每页额外导出空间文本 JSON |
| `-h, --help` | — | 帮助 |
| `-V, --version` | — | 版本与平台 |

CLI 没有 JSON 控制台报告，也没有 quiet/verbose；成功摘要写 stdout，错误与 warning 写 stderr。

## 输出

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
- 默认每页只产出图片；`--text` 时同页额外产出 JSON；
- 已存在文件会被覆盖；
- 每页独立处理：某页文本失败仍会尝试出图，反之亦然；
- 页范围总跨度超过 100000 页会在展开前退出 1。

## 文本 JSON

只有 `--text` 才生成。每页一个扁平数组，每项只有文字和位置：

```json
[
  { "text": "发票", "x": 100, "y": 176, "w": 48, "h": 24 },
  { "text": "金额", "x": 400, "y": 300, "w": 48, "h": 24 }
]
```

- `text`：该文本项的原始内容（可能含空格/换行）；
- `x/y`：包围盒左上角；`w/h`：包围盒宽高；
- 单位 px，原点为页面左上角，y 向下，与同页 PNG 同 DPI；
- 旋转/竖排文字取轴对齐包围盒；
- 空页为 `[]`；
- 不含字体、字符、quad、页号、页面尺寸；页号看文件名，页面尺寸看 PNG；
- engine 达到默认文本项/字符上限时会打印 `W_TEXT_ITEM_LIMIT`/`W_TEXT_CHAR_LIMIT` warning，JSON 本身不带截断标志；
- 文本项很多时数组会很大；大文档按页处理。

## Agent 工作流

1. **预览图片**：先 `--pages 1`，检查 PNG 是否正常。
2. **需要坐标时加 `--text`**：读取 JSON，确认数组非空。
3. **定位文本**：按 `text` 搜索；用 `x/y/w/h` 得到像素区域。
4. **视觉确认**：查看同页 PNG；坐标与图片同 DPI，可直接对应。
5. **全量导出**：确认无误后去掉 `--pages` 或指定完整范围。
6. **缺字/乱码**：检查 stderr 的 `W_FONT_MISSING`/`W_GLYPH_MISSING`；向用户询问字体目录并用 `--font-dir` 重试。不要自动下载字体。
7. **大文档**：优先按页码范围分批，避免一次生成过多图片与 JSON。

## 退出码与错误

| 码 | 含义 | 处理 |
| --- | --- | --- |
| `0` | 全部成功 | 正常读取输出 |
| `1` | 参数/路径错误 | 修正命令，不要重试 |
| `2` | 文档级失败（非 OFD、加密、`--text` 时文本 API 不可用、SEA 资产解压/缓存校验失败等） | 读取 stderr 的 `OFD_*`/`CLI_TEXT_UNSUPPORTED`/`CLI_SEA_EXTRACT_FAILED`，不要盲目重试 |
| `3` | 页级失败（部分或全部页） | 保留已产出文件，读取 stderr 定位失败页 |
| `130` | 用户中断 | 已完成的页保留，可重跑 |

错误格式：`错误[OFD_XXX]：message`；warning 格式：`警告 [W_XXX] 第 N 页：message`。

常见错误：

- `OFD_INVALID_PACKAGE`：文件不是有效 OFD 包；
- `OFD_ENCRYPTED`：文档加密，v1 不支持；
- `OFD_PAGE_NOT_FOUND`：页码范围越界；
- `OFD_CANVAS_TOO_LARGE`：页面/DPI 过大，降低 `--dpi`；
- `CLI_TEXT_UNSUPPORTED`：engine 没有文本 API；去掉 `--text` 或升级 engine/CLI；
- `CLI_TEXT_WRITE_FAILED`：文本 JSON 写盘失败；检查输出目录权限/同名目录；
- `CLI_SEA_EXTRACT_FAILED`：SEA 缓存不可写、权限/属主/符号链接异常或资产摘要不匹配；清理/更换 `TMPDIR` 或使用 release 重新运行；
- `OFD_ABORTED`：被取消。

## 安全与限制

- 路径可能含中文/空格，始终加引号；
- 只对可信的 OFD 文件运行；超大页面/高 DPI 可能占用大量内存；
- 不自动扫描系统字体，不自动下载字体或二进制；
- v1 不支持批量/目录、PDF、OCR、注释文字、Linux musl；
- 首次运行自包含可执行文件时会把原生模块解压到 `<tmpdir>/ofdrw-viewer-cli/u<uid>-<version>-<platform>-<arch>-<digest>/`，需要可写的 `TMPDIR`/`TEMP`/`TMP`；目录 0700、文件 0600，复用前校验属主与全资产摘要；
- 缓存根 `<tmpdir>/ofdrw-viewer-cli` 是共享路径；多用户 Linux 主机上建议每个用户使用独立 `TMPDIR`，否则后续用户可能因根目录属主校验失败；
- CLI 的 npm `files` 只有 `dist`，release 压缩包只有可执行文件、README、LICENSE；skill 不进入包或发布，也不安装到用户目录；
- macOS 首次运行可能被 Gatekeeper 拦截；Windows 可能触发 SmartScreen。按用户环境说明处理，不要绕过系统安全策略。

## 平台提示

- Linux：需要 glibc；Alpine/musl 不支持；
- macOS：release 只编译可执行文件，不签名、不公证；
- Windows：未签名 exe，SmartScreen 可能提示。

## 参考

- CLI 设计：`docs/CLI设计方案.md`
- 文本 API 细节：`docs/text-content-api.md`