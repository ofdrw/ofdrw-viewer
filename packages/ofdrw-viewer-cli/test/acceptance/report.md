# ofdrw-viewer-cli 图片功能与 SEA 黑盒验收报告

- 验收日期：2026-10-22
- 环境：Linux x64（glibc），Node v26.10.0，pnpm 11.24.0
- 验收对象：`packages/ofdrw-viewer-cli` 当前工作树（`src/` 未改动），SEA 产物由 `scripts/build-sea.mjs` 现场构建
- 验收方式：只通过真实子进程（`dist/bin.js`、SEA 可执行文件）观察行为；engine 公共 API 仅用于计算 `getViewport({dpi})` 期望尺寸

## 1. 执行命令与结果

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm -C packages/ofdrw-viewer-cli typecheck` | 0 | 通过 |
| `pnpm -C packages/ofdrw-viewer-cli test` | 0 | 8 个文件、124/124 通过；默认测试不收集验收用例 |
| `pnpm -C packages/ofdrw-viewer-cli test:acceptance` | 0 | 2 个文件、35/35 通过（CLI 32 + SEA 3） |
| `pnpm -C packages/ofdrw-viewer-cli build:sea` | 0 | 180.9 MB；冷启动 `--version` 176 ms，二次启动 127 ms，转换冒烟生成 PNG |

`test:acceptance` 会依次执行现有 `build`、`build:sea`，再运行
`vitest run --config test/acceptance/vitest.config.ts`，因此可在干净检出上直接运行。

## 2. 样本与夹具

| 用途 | 样本 | 说明 |
| --- | --- | --- |
| 单页 / A4 / 默认参数 | `ofd_pdf_match/helloworld.ofd` | 1 页；缺字体，页面本身接近空白，仅用于尺寸/命名/白底 |
| 多页 / 内容非空白 | `ofd_pdf_match/999.ofd` | 5 页；含图文，用于非空白、部分页失败、SIGINT、原子替换 |
| 坏文件 | 测试内写入的 `not-an-ofd-package` | 验证文档级失败 |
| 字体目录 | `test/.fixtures/fonts/DroidSansFallbackFull.ttf` | 优先使用；该文件被 gitignore，缺失时回退常见系统字体，均缺失则跳过该用例 |

所有输出目录均由 `os.tmpdir()` 下的 `mkdtemp` 创建，`afterEach` 递归清理，不在仓库内留下产物。

## 3. 验收覆盖与结果

### 3.1 参数、输出与格式

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| `--help` / `--version` | 退出 0；含用法、全部图片期参数、版本与平台 | 通过 |
| 单页默认 PNG | 仅 1 个 `helloworld-p001.png`；PNG magic；白底；无 `.tmp`、无 `.json` | 通过 |
| 尺寸 vs `getViewport` | 96 DPI：794×1123（viewport 793.701×1122.52）；150 DPI：1241×1754（viewport 1240.157×1753.937），均按 `ceil` 一致 | 通过 |
| 多页全量 | `999.ofd` 输出 `p001`–`p005` 共 5 张；逐张可解码且非空白 | 通过 |
| `--pages` | `3,1,3` 去重升序后只输出 `p001`、`p003` | 通过 |
| `--format jpeg` | `.jpg`；magic `ffd8ff`；尺寸与 oracle 一致；角落白底；非空白 | 通过 |
| `--format webp` | `.webp`；`RIFF`/`WEBP` magic；尺寸与 oracle 一致；非空白 | 通过 |
| 默认输出目录 | 未给 `-o` 时输出到 `cwd/<输入 stem>/` | 通过 |
| `-o` 嵌套目录 | 不存在时递归创建 | 通过 |
| `--font-dir` | 字体放在 `nested/sub` 子目录仍被递归扫描；退出 0 正常出图 | 通过 |

### 3.2 退出码与错误信息

| 用例 | 期望 | 实际 |
| --- | --- | --- |
| 缺输入 / 多输入 / 未知参数 / 缺 `-o` 值 | 1 + 用法提示 | 一致 |
| `--format gif`、`--dpi 0`、`--dpi abc`、`--pages 0`、`--pages 3-1` | 1 + 中文错误 | 一致 |
| `--text`（本期未实现） | 1，`未知参数：--text`，无输出目录、无 JSON | 一致 |
| 输入不存在 / 输入是目录 / 输出路径是文件 / 字体目录不存在 | 1 | 一致 |
| 页码越界 `--pages 9` | 1，`页码越界`，不写图片 | 一致 |
| 坏 OFD | 2，stderr 含 `错误[OFD_*]` | 一致 |
| 部分页失败（第 3 页目标被同名目录占用） | 3，保留 4 张成功 PNG，stderr 报第 3 页失败，无 `.tmp` | 一致 |
| 全部页失败 | 3 | 一致 |

### 3.3 SIGINT 与原子写

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| SIGINT | `999.ofd --dpi 600` 启动 700 ms 后发送 SIGINT；退出码 130；stdout 含 `已取消：`；已写图片完整；无 `.tmp-*` 残留 | 通过 |
| 覆盖写 | 预置 `OLD-CONTENT` 的同名文件被完整替换为 PNG，无 `.tmp-*` | 通过 |
| 原子替换 | 600 DPI 转换约 6.4 s 窗口内每 20 ms 读取目标文件：始终为完整旧内容或完整 PNG，从未出现半截内容；结束后为 PNG；无 `.tmp-*` | 通过 |

### 3.4 SEA 可执行文件

隔离环境：`PATH` 只含空目录（探测 `node --version` 返回 ENOENT），`TMPDIR`/`TEMP`/`TMP` 指向隔离目录，清空 `OFDRW_CANVAS_DIR`、`NAPI_RS_NATIVE_LIBRARY_PATH`、`NODE_OPTIONS`。

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| 无 Node 运行 `--version` / `--help` | 退出 0；版本、平台、用法正确 | 通过 |
| 无 Node 运行图片转换 | `999.ofd --pages 1` → `999-p001.png`，794×530，非空白、白底；随后 `helloworld.ofd` → 794×1123 | 通过 |
| 冷/热启动缓存 | 缓存目录 `<TMPDIR>/ofdrw-viewer-cli/<版本>-<平台>-<架构>-<摘要>` 唯一；目录权限 0700；二次启动不新增目录、`.complete` 的 mtime 不变 | 通过 |
| TMPDIR 不可用 | 退出 2，stderr 含 `CLI_SEA_EXTRACT_FAILED` | 通过 |

## 4. 验收测试清单

- 文件：`test/acceptance/cli.acceptance.ts`（32 个用例）、`test/acceptance/sea.acceptance.ts`（3 个用例），共 35 个
- 配置：`test/acceptance/vitest.config.ts`，只收集 `*.acceptance.ts`，默认 `pnpm test` 不运行
- `package.json` 仅新增一行：
  `"test:acceptance": "pnpm run build && pnpm run build:sea && vitest run --config test/acceptance/vitest.config.ts"`

## 5. 未覆盖项与剩余风险

未覆盖：

- macOS / Windows / Linux arm64 实机运行；签名、公证、SmartScreen/Gatekeeper 行为
- Windows `tar.gz`/`zip`、`SHA256SUMS` 的 release workflow 实际运行
- SEA 缓存目录只读时的热启动（t3 曾手工验证，本次验收未纳入）
- `--font-dir` 对 `W_FONT_MISSING` 数量的量化影响：`helloworld.ofd` 缺失的是文档内嵌字体，补充字体不能消除该 warning
- 中文/空格路径、超长路径、极简容器（无 `/tmp`）等平台边界
- 本期明确不验收 `--text`/JSON

剩余风险：

- SEA 产物约 180.9 MB，分发体积较大
- `test:acceptance` 会重建 `dist` 与 SEA（约 70 s），并依赖 engine 的 `dist` 已构建；并行构建 engine 时曾出现一次 esbuild 解析 `ofdrw-viewer-engine` 的瞬时失败，engine 重建完成后重试通过，不是 CLI 缺陷
- `--font-dir` 用例依赖本机字体：仓库夹具被 gitignore，干净环境无系统字体时会跳过该用例（报告与测试输出会体现）
- SIGINT 用例依赖 700 ms 时机与 600 DPI 渲染窗口；在极快机器上理论上可能提前完成，当前环境稳定通过
- 原子替换通过高频采样验证，不是形式化证明

## 6. 结论

本机 Linux x64 下，图片 CLI 与 SEA 产物的本期验收项全部通过；未发现需要修改 `src/` 的产品缺陷。