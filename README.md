# ofdrw-viewer

OFD 页面渲染引擎。

## 目录结构

```
ofdrw-viewer/
  package.json                      # 项目配置
  docs/
    OFD渲染引擎设计方案.md
  packages/
    ofdrw-viewer-engine/            # 引擎包
      package.json
      tsconfig.json
      src/
        index.ts                    # 公共 API 出口
        api/                        # OFDDocument / OFDPage / RenderTask
        common/                     # 无 OFD 语义的公共类型
        model/                      # 页面/图元/资源数据模型
        resource/                   # 资源作用域与缓存
        style/                      # DrawParam 结算
        render/                     # 页面渲染管线
        renderer/                   # Renderer 抽象与默认实现
        font/                       # 字体解析与字形轮廓
        image/                      # JBIG2/TIFF 等图片解码
        platform/                   # 宿主注入的平台接口
```

## 子包

三个子包统一使用 `@ofdrw` npm 作用域，目录名保持 `ofdrw-viewer-*`：

| 包名 | 目录 | 说明 |
| --- | --- | --- |
| `@ofdrw/ofdrw-viewer-engine` | `packages/ofdrw-viewer-engine` | 平台无关的 OFD 页面渲染引擎 |
| `@ofdrw/ofdrw-viewer-ui` | `packages/ofdrw-viewer-ui` | 框架无关的 OFD 阅读器 UI |
| `@ofdrw/ofdrw-viewer-cli` | `packages/ofdrw-viewer-cli` | OFD 转图片命令行工具（`ofdrw-viewer-cli` 命令） |

## OFD 转图片 CLI（ofdrw-viewer-cli）

`packages/ofdrw-viewer-cli` 是本仓库的 Node CLI：把单个 OFD 文件逐页导出为 PNG/JPEG/WebP；加 `--text` 时，同页额外输出一个带像素坐标的空间文本 JSON。图片和 JSON 使用同一页、同一 DPI、同一坐标系，可直接叠加。

### 安装与构建

源码开发环境需要 Node ≥ 22 和 pnpm：

```bash
pnpm install
pnpm cli:build
node packages/ofdrw-viewer-cli/dist/bin.js --version
```

从 release 安装时，下载对应平台的 `ofdrw-viewer-cli-<version>-<platform>-<arch>.tar.gz`（Windows 为 `.zip`），解压后直接运行 `ofdrw-viewer-cli`；请先用同目录的 `SHA256SUMS` 校验。release 产物内嵌 Node 运行时，最终用户不需要安装 Node。

### 图片用法

```bash
# 全部页，PNG，默认 96 DPI，输出到 ./<输入 stem>/
node packages/ofdrw-viewer-cli/dist/bin.js ofd_pdf_match/helloworld.ofd

# 指定目录、页码和 JPEG
node packages/ofdrw-viewer-cli/dist/bin.js ofd_pdf_match/999.ofd -o ./out --pages 1-2,4 --format jpeg

# 补充字体目录并提高 DPI
node packages/ofdrw-viewer-cli/dist/bin.js ofd_pdf_match/999.ofd -o ./out --dpi 300 --font-dir ./fonts
```

### `--text` 空间文本

```bash
node packages/ofdrw-viewer-cli/dist/bin.js ofd_pdf_match/dense-text-perf.ofd --text --pages 1
```

每页额外生成 `<stem>-p<NNN>.json`。JSON 是扁平数组，每项只有五个字段：

```json
[
  { "text": "发票", "x": 100, "y": 176, "w": 48, "h": 24 },
  { "text": "金额", "x": 400, "y": 300, "w": 48, "h": 24 }
]
```

- `x/y/w/h` 来自 engine `TextItem.rect` 的轴对齐包围盒，单位 px，原点在页面左上角、y 向下；与同页图片同 DPI，不做取整。
- 保持 engine `items` 顺序，跳过空 `text`；空页写 `[]`。
- 不含 `chars`、`quad`、字体、页号或页面尺寸；页号看文件名，页面尺寸看同页图片。
- 不传 `--text` 时不调用 `getTextContent`，也不生成 JSON。

### 输出命名

- 图片：`<输入 stem>-p<NNN>.<ext>`；`PNG` 为 `.png`，JPEG 为 `.jpg`，WebP 为 `.webp`；页号至少 3 位。
- 文本：`<输入 stem>-p<NNN>.json`，与同页图片同 stem、同页号。
- 未指定 `-o` 时输出到当前目录下的 `<输入 stem>/`；目标存在时覆盖，采用同目录临时文件 + `rename` 原子替换。

### 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 全部页成功 |
| `1` | 用法、路径或页码范围错误 |
| `2` | 文档级失败：无法打开、非 OFD、加密、`--text` 文本 API 不可用、SEA 资产解压失败等 |
| `3` | 页级失败：至少一页失败；`--text` 时文本和图片任一失败都算该页失败，已成功的一份保留 |
| `130` | SIGINT 取消；已完成页保留 |

页范围总跨度上限为 100000 页，超限会在展开前报错退出 1。成功摘要写 stdout，错误和 warning 写 stderr。

### 自包含可执行文件（SEA）

```bash
pnpm cli:build:sea
packages/ofdrw-viewer-cli/dist/sea/ofdrw-viewer-cli --version
packages/ofdrw-viewer-cli/dist/sea/ofdrw-viewer-cli ofd_pdf_match/dense-text-perf.ofd -o /tmp/out --text --pages 1
```

构建机需要 Node ≥ 25.5（当前 Linux x64 实测 Node 26.10）；产物约 180.9 MB。首次运行把 `@napi-rs/canvas` 资产解压到 `<tmpdir>/ofdrw-viewer-cli-u<uid>/u<uid>-<version>-<platform>-<arch>-<digest>/`（Windows 无 uid 时根为 `<tmpdir>/ofdrw-viewer-cli`；旧共享根不再复用），目录 0700、文件 0600；后续命中 `.complete` 缓存。需要可写的 `TMPDIR`/`TEMP`/`TMP`。多平台 release 由 `.github/workflows/release-cli.yml` 的 matrix 构建，并生成 `SHA256SUMS`。

### 测试

```bash
pnpm typecheck
pnpm cli:test
pnpm cli:test:acceptance   # 会重建 dist 与 SEA，串行运行真实 CLI/SEA 验收
```

验收覆盖图片、`--text` 空间文本（dense 两页 147/8,331 项与 engine oracle 全量一致）、空页、独立失败、退出码、SIGINT 和 SEA 文本冒烟。

### Skill

Agent skill 源文件位于 `packages/ofdrw-viewer-cli/skills/ofdrw-viewer-cli/SKILL.md`，只随仓库维护，不安装到 `~/.agents/skills/`，也不进入 CLI npm 包或 release 压缩包。

## 约定

- 根目录只放项目配置、脚本与文档，不放引擎实现。
- 引擎公共 API 只从 `packages/ofdrw-viewer-engine/src/index.ts` 导出。
- `docs/`、`references/`、`ofd_pdf_match/` 不进入 engine 包。

## 许可证

本项目采用 [MIT License](LICENSE) 开源。
Copyright (c) 2026 Quan Guanyu
