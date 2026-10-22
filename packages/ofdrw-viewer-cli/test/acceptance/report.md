# ofdrw-viewer-cli 图片与 `--text` 空间文本黑盒验收报告

- 验收日期：2026-10-22
- 环境：Linux x64（glibc），Node v26.10.0，pnpm 11.24.0
- 验收对象：`packages/ofdrw-viewer-cli` 提交 `e542845`（含 t8 `a6c1f80`、t11 `283eca3`）的稳定工作树；`src/` 未改动，SEA 产物由 `scripts/build-sea.mjs` 现场重建
- 验收方式：黑盒启动真实子进程（`dist/bin.js`、SEA 可执行文件）；engine 公共 API 只用于 `getViewport({dpi})` 与 `getTextContent({dpi, includeChars:false})` 计算期望值；`CLI_TEXT_UNSUPPORTED` 因真实 engine 始终提供文本 API，改用进程内可控 mock
- 相对 t4 基线 `dd1baa8`：t8 新增 `--text`，t11 修复 SEA 缓存投毒与页码/进度，engine `e542845` 修复负宽 Boundary 右对齐文本；t4 的“`--text` 未知参数”断言已删除并替换为真实文本导出断言。t4 的图片与 SEA 用例在 t9 基线上全部复跑通过

## 1. 执行命令与结果

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm -C packages/ofdrw-viewer-cli typecheck` | 0 | `tsc --noEmit` 通过 |
| `pnpm -C packages/ofdrw-viewer-cli test` | 0 | 10 个文件、171/171 通过；默认测试不收集验收用例 |
| `pnpm -C packages/ofdrw-viewer-cli test:acceptance` | 0 | 3 个文件、48/48 通过（CLI 42 + SEA 4 + 文本 API mock 2）；耗时约 35 s |
| `pnpm -C packages/ofdrw-viewer-cli build:sea` | 0 | 180.9 MB；冷启动 `--version` 290 ms，二次启动 224 ms，转换冒烟生成 PNG |

`test:acceptance` 依次执行 `build`、`build:sea`、`vitest run --config test/acceptance/vitest.config.ts`，因此每次都在最新源码上重建 `dist` 与 SEA，再跑黑盒用例。

## 2. 样本与夹具

| 用途 | 样本 | 说明 |
| --- | --- | --- |
| 单页 / A4 / 默认参数 / 空文本 | `ofd_pdf_match/helloworld.ofd` | 1 页；缺少文档内嵌字体，页面接近空白；用于尺寸、命名、`--text` 输出 `[]` |
| 多页 / 内容非空白 | `ofd_pdf_match/999.ofd` | 5 页；用于多页、非空白、部分页失败、SIGINT、原子替换、SEA 图片转换 |
| 文本主样本 | `ofd_pdf_match/dense-text-perf.ofd` | 2 页；96 DPI 下第 1 页 147 项 / 15,442 字符，第 2 页 8,331 项 / 15,074 字符 |
| 坏文件 | 测试内写入的 `not-an-ofd-package` | 验证文档级失败 |
| 字体目录 | `test/.fixtures/fonts/DroidSansFallbackFull.ttf` | 优先使用；文件被 gitignore，缺失时回退系统字体，均缺失则跳过该用例 |

所有输出目录均由 `os.tmpdir()` 下的 `mkdtemp` 创建，`afterEach` 递归清理，不在仓库内留下产物。

## 3. 验收覆盖与结果

### 3.1 图片参数、输出与格式

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| `--help` / `--version` | 退出 0；含用法、全部参数（含 `--text`）、版本与平台 | 通过 |
| 单页默认 PNG | 仅 `helloworld-p001.png`；PNG magic；白底；无 `.tmp`、无 `.json` | 通过 |
| 尺寸 vs `getViewport` | 96 DPI：794×1123（viewport 793.701×1122.52）；150 DPI：1241×1754（viewport 1240.157×1753.937），均按 `ceil` 一致 | 通过 |
| 多页全量 | `999.ofd` 输出 `p001`–`p005` 共 5 张；逐张可解码且非空白 | 通过 |
| `--pages` | `3,1,3` 去重升序后只输出 `p001`、`p003` | 通过 |
| `--format jpeg` / `webp` | `.jpg` magic `ffd8ff`；`.webp` RIFF/WEBP magic；尺寸与 oracle 一致；非空白 | 通过 |
| 默认输出目录 / 嵌套 `-o` | 未给 `-o` 时输出到 `cwd/<输入 stem>/`；嵌套目录自动递归创建 | 通过 |
| `--font-dir` | 字体放在 `nested/sub` 子目录仍被递归扫描；退出 0 正常出图 | 通过 |

### 3.2 退出码、错误信息与原子写

| 用例 | 期望 | 实际 |
| --- | --- | --- |
| 缺输入 / 多输入 / 未知参数 / 缺 `-o` 值 | 1 + 用法提示 | 一致 |
| `--format gif`、`--dpi 0`、`--dpi abc`、`--pages 0`、`--pages 3-1` | 1 + 中文错误，不创建输出目录 | 一致 |
| 输入不存在 / 输入是目录 / 输出路径是文件 / 字体目录不存在 | 1 | 一致 |
| 页码越界 `--pages 9` | 1，`页码越界`，不写图片 | 一致 |
| 坏 OFD | 2，stderr 含 `错误[OFD_*]` | 一致 |
| 部分页失败（第 3 页目标被同名目录占用） | 3，保留 4 张成功 PNG，stderr 报第 3 页失败，无 `.tmp` | 一致 |
| 全部页失败 | 3 | 一致 |
| 覆盖写 / 原子替换 | 旧文件完整替换；600 DPI 约 6.4 s 窗口内每 20 ms 采样，始终为完整旧内容或完整 PNG | 通过 |

### 3.3 `--text` 空间文本 JSON

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| dense 第 1 页结构 | `dense-text-perf-p001.json` 为数组，147 项；每项键严格为 `text/x/y/w/h`，类型正确、`text` 非空；无 `.tmp` | 通过 |
| dense 第 1 页顺序与坐标 | 与 `getTextContent({dpi:96, includeChars:false})` 过滤空 `text` 后的 items **全量逐项**比较 `text/x/y/w/h`，顺序一致；首项、末项单独复核 | 通过 |
| JSON 体积与图片对齐 | 第 1 页 JSON 48,079 B；同页 PNG 974,608 B、794×1123，与 96 DPI viewport 取整一致；所有坐标落在页面内 | 通过 |
| dense 第 2 页大量文本 | 8,331 项；与 oracle 全量逐项一致，另固定抽样索引 0/1/2/4165/8328/8329/8330；JSON 873,182 B；PNG 986,121 B、794×1123 | 通过 |
| 第 2 页性能 | 单页 CLI 子进程（含启动、文本、渲染、写盘）约 1.2–1.9 s；门禁 < 30 s，避免把慢机误判 | 通过 |
| 全量 2 页 | 4 个产物：`p001.json`、`p001.png`、`p002.json`、`p002.png`；项数 147 + 8,331 | 通过 |
| 空页 | `helloworld.ofd --text` 写 `[]`（2 B），同时输出 PNG | 通过 |
| 不传 `--text` | dense 两页只生成 PNG，不生成任何 JSON | 通过 |
| 格式组合 | `--format jpeg` / `webp` + `--text --pages 1`：图片扩展名正确，JSON 与图片同页号 | 通过 |
| `--dpi` 组合 | `--dpi 144 --text --pages 1`：JSON 坐标与 144 DPI oracle 全量一致；PNG 1191×1684（viewport 取整） | 通过 |
| 默认输出目录 | 未给 `-o`：PNG 与 JSON 共用 `cwd/dense-text-perf/` | 通过 |
| 文本写盘失败 | 预占 JSON 路径为目录：退出 3，stderr `CLI_TEXT_WRITE_FAILED`，同页 PNG 保留，无 `.tmp` | 通过 |
| 图片写盘失败 | 预占 PNG 路径为目录：退出 3，stderr `CLI_IMAGE_WRITE_FAILED`，同页 JSON 保留且 147 项，无 `.tmp` | 通过 |
| SIGINT | `999.ofd --text --dpi 600` 启动 700 ms 后中断：退出 130、stdout `已取消：`、已产出 JSON 可解析、PNG 完整、无 `.tmp` | 通过 |
| 文本 API 缺失 | 进程内 mock `OFDDocument.open`：`OFDPage.getTextContent` 缺失时退出 2、stderr `错误[CLI_TEXT_UNSUPPORTED]`，不写任何文件 | 通过 |
| engine 未绑定文本驱动 | mock `getTextContent` 抛 `OFD_RENDERER_UNSUPPORTED`：映射为 `CLI_TEXT_UNSUPPORTED` 并退出 2 | 通过 |

### 3.4 SEA 可执行文件

隔离环境：`PATH` 只含空目录（探测 `node --version` 返回 ENOENT），`TMPDIR`/`TEMP`/`TMP` 指向隔离目录，清空 `OFDRW_CANVAS_DIR`、`NAPI_RS_NATIVE_LIBRARY_PATH`、`NODE_OPTIONS`。

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| 无 Node 运行 `--version` / `--help` | 退出 0；版本、平台、用法正确 | 通过 |
| 无 Node 运行图片转换 | `999.ofd --pages 1` → 794×530、非空白；`helloworld.ofd` → 794×1123 | 通过 |
| 无 Node 运行 `--text` | `dense-text-perf.ofd --text --pages 1`：退出 0，生成 PNG 794×1123 + JSON 147 项，JSON 与 96 DPI oracle 全量一致 | 通过 |
| 冷/热启动缓存 | 缓存目录唯一、目录权限 0700；二次启动不新增目录、`.complete` mtime 不变 | 通过 |
| TMPDIR 不可用 | 退出 2，stderr 含 `CLI_SEA_EXTRACT_FAILED` | 通过 |

## 4. 验收测试清单

- `test/acceptance/cli.acceptance.ts`：42 个用例（文本 11 + 其余图片/参数/退出码/SIGINT 31；原“`--text` 未知参数”用例已删除）
- `test/acceptance/sea.acceptance.ts`：4 个用例（图片 3 + 文本 1）
- `test/acceptance/text-mock.acceptance.ts`：2 个用例（文本 API 缺失与 engine 不支持）
- 合计 48 个用例、3 个文件
- 配置：`test/acceptance/vitest.config.ts`，只收集 `*.acceptance.ts`，默认 `pnpm test` 不运行
- `package.json` 未改动；`test:acceptance` 仍为：
  `pnpm run build && pnpm run build:sea && vitest run --config test/acceptance/vitest.config.ts`

## 5. 未覆盖项与剩余风险

未覆盖：

- macOS / Windows / Linux arm64 实机运行；签名、公证、SmartScreen/Gatekeeper 行为
- Windows `tar.gz`/`zip`、`SHA256SUMS` 的 release workflow 实际运行
- SEA 缓存目录只读时的热启动（t3 曾手工验证，本次验收未纳入）
- OCR 或字符级文本（`includeChars:true`）：本期只验收 `includeChars:false` 的空间文本项
- 文本 API 缺失使用进程内 mock，未在旧版 engine 的真实二进制上复现
- 中文/空格路径、超长路径、极简容器（无 `/tmp`）等平台边界
- `--font-dir` 对 `W_FONT_MISSING` 数量的量化影响：`helloworld.ofd` 缺失的是文档内嵌字体，补充字体不能消除该 warning

剩余风险：

- SEA 产物约 180.9 MB，分发体积较大
- `test:acceptance` 会重建 `dist` 与 SEA（约 70 s），并依赖 engine 的 `dist` 已构建；并行构建 engine 时曾出现一次 esbuild 解析 `ofdrw-viewer-engine` 的瞬时失败，engine 重建完成后重试通过，不是 CLI 缺陷
- `--font-dir` 用例依赖本机字体：仓库夹具被 gitignore，干净环境无系统字体时会跳过该用例（测试输出会体现）
- SIGINT 用例依赖 700 ms 时机与 600 DPI 渲染窗口；在极快机器上理论上可能提前完成，当前环境稳定通过
- 第 2 页性能门禁为 30 s，实际约 1.2–1.9 s；该门禁用于发现数量级退化，不作为精确性能基准
- 原子替换通过高频采样验证，不是形式化证明
- t4 的验收快照因后续 license 元数据与 t8/t11 源码变化而失效；本报告与 48 个用例绑定当前 `e542845` 完整字节

## 6. 结论

本机 Linux x64 下，图片 CLI、`--text` 空间文本 JSON 与 SEA 产物的本期验收项全部通过；第 2 页 8,331 项大量文本保持顺序且与 engine oracle 一致；未发现需要修改 `src/` 的产品缺陷。