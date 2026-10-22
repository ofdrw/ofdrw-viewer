# OFD 转图片 CLI（ofdrw-view-cli）设计方案

> 状态：设计定稿 v1.0（2026-10-22），待 engine 侧确认 JBIG2/TIFF 默认启用契约
> 定位：`ofdrw-viewer-engine` 的 Node 宿主子包，只消费 engine 公共 API，不反向依赖。
> 依据：《OFD 渲染引擎设计方案》v0.4 第 6.1 节“仓库组织”、第 14.4 节“Node/PC”、第 15 节“公共 API”。

## 1. 背景与目标

engine 只提供平台无关的页面渲染 API，不负责读文件、创建 Canvas、编码图片和批量输出。本子包补齐 Node 端“把一个 OFD 文档转成一组图片”的最小可用链路：

```text
OFD 文件 → OFDDocument.open → 逐页 page.render → Canvas → PNG/JPEG/WebP 文件
```

目标：

1. 一条命令完成单文件、多页 OFD 到图片目录的转换；
2. 输出可脚本化：稳定的文件命名、退出码、JSON 报告；
3. Node 平台差异（Canvas、图片解码、字体）集中在 CLI 内部，不污染 engine；
4. 对坏文件、缺字体、缺图、超大页面给出明确错误/警告，不静默失败。

## 2. 范围

### 2.1 v1 范围内

- 单个本地 OFD 文件输入；
- 输出 PNG（默认）、JPEG、WebP；
- 全部页或指定页范围（`1-3,5`）；
- DPI、背景色/透明背景、JPEG/WebP 质量；
- 字体目录补充（`--font-dir`，可重复）；
- 人读日志与 `--json` 机器可读报告；
- SIGINT 取消与临时文件清理。

### 2.2 v1 明确不做

- 多文件/目录批量、通配符、stdin/URL 输入；
- PDF 输出、打印；
- 多文档包以外的文档筛选（`--document-index` 仅透传，默认 0）；
- 并行渲染（默认串行，理由见 6.6）；
- 自动扫描系统字体；
- 图片 DPI 元数据（PNG pHYs / JPEG density）写入；
- 逐像素视觉验收（由 engine 黄金图 harness 负责）。

## 3. 与 engine 的边界

CLI 只能从 `ofdrw-viewer-engine` 包根导入类型与 API，禁止跨包相对路径引用 engine 内部模块。

| CLI 需要的能力 | 来源 |
| --- | --- |
| 打开文档、页树、页尺寸、渲染任务、取消 | `OFDDocument` / `OFDPage` / `RenderTask` |
| 默认 Canvas2D 渲染器 | `H5Canvas2DRenderer` |
| Viewport 计算 | `page.getViewport({ dpi })` |
| 字体补充 | `OFDOpenOptions.supplementaryFonts` |
| 图片解码插件 | `OFDOpenOptions.imageDecoders` |
| warning/error | `onWarning`、`OFDError` |

engine 当前 [document.ts](../packages/ofdrw-viewer-engine/src/api/document.ts) 与 [page.ts](../packages/ofdrw-viewer-engine/src/api/page.ts) 仍是 `notImplemented` 桩。CLI 的 P1 可以先完成参数、输出、字体扫描、Node 适配和单元测试；P2 端到端联调依赖 API 实现落地。

需要 engine 侧确认的一条契约：

- JBIG2/TIFF 内置解码器（`src/image/format.ts` 的 `builtinImageDecoders`）是否由 `OFDDocument.open` 默认启用。若默认不启用，应从包根导出该插件集合，CLI 才能在不引用内部模块的前提下注入；否则 CLI 只能把 JBIG2/TIFF 页作为“图片缺失 warning”处理。

## 4. 子包组织

```text
packages/ofdrw-view-cli/
  package.json              # name: ofdrw-view-cli, bin: ofdrw-viewer-cli
  tsconfig.json
  tsup.config.ts
  README.md
  src/
    bin.ts                  # shebang，调用 runCli()
    index.ts                # 仅导出 runCli（可选，供集成测试）
    cli.ts                  # parseArgs、帮助、参数校验、退出码
    convert.ts              # 打开文档、逐页渲染、汇总结果
    output.ts               # 输出目录、命名、编码、原子写
    report.ts               # 人读日志与 JSON 报告
    errors.ts               # 错误到退出码的映射
    node/
      canvas.ts             # @napi-rs/canvas 画布工厂与类型桥接
      image-decoder.ts      # PNG/JPEG/WebP 解码插件
      fonts.ts              # --font-dir 递归扫描与去重
  test/
    unit/                   # 参数、命名、字体扫描、退出码、报告
    e2e/                    # 构建后 spawn 真实 CLI
```

约定：

- 子包目录与包名固定为 `ofdrw-view-cli`，命令名（`bin`）为 `ofdrw-viewer-cli`；
- 包使用 ESM，`bin` 指向 `dist/bin.js`，构建时保留 shebang；
- 参数解析使用 Node 22 的 `node:util.parseArgs`，不引入 commander/yargs；
- 生产依赖只增加 `@napi-rs/canvas`；测试可增加 `pngjs`（校验尺寸/非空白），不进入运行时；
- 不把 CLI 逻辑拆成多层 service；`cli.ts` 负责参数，`convert.ts` 负责流程，`node/` 负责平台差异。

## 5. CLI 接口

### 5.1 用法

```bash
ofdrw-viewer-cli <input.ofd> [options]
```

示例：

```bash
# 全部页，PNG，默认 96 DPI，输出到 ./发票示例/
ofdrw-viewer-cli 发票示例.ofd

# 指定输出目录、页码与格式
ofdrw-viewer-cli 发票示例.ofd -o ./out --pages 1-2,4 --format jpeg

# 高精度 + 补充字体目录
ofdrw-viewer-cli manual.ofd --dpi 300 --font-dir ./fonts
```

### 5.2 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `<input>` | 必填 | 本地 OFD 文件路径 |
| `-o, --out <dir>` | `./<输入文件名>/` | 输出目录；不存在时递归创建；指向文件则报错 |
| `-f, --format <fmt>` | `png` | `png` / `jpeg` / `webp` |
| `-d, --dpi <n>` | `96` | 输出 DPI，正整数；与 engine 默认一致 |
| `-p, --pages <ranges>` | 全部 | 1 起闭区间，如 `1-3,5`；重复/重叠自动去重排序 |
| `--font-dir <dir>` | 无 | 补充字体目录；递归扫描 ttf/otf/ttc/otc |
| `-h, --help` | — | 帮助 |
| `-V, --version` | — | 版本 |

固定行为，不提供参数：

- 白底，不透明；
- 目标文件已存在时直接覆盖，采用“临时文件 + rename”原子替换；
- 串行渲染；
- 页级失败继续，结束时汇总；文档级失败立即退出；
- JPEG/WebP 质量固定 90；
- engine 使用默认选项：`documentIndex=0`、默认 `strictImageCtm`、`layerOrder=type`；
- 不提供 JSON/quiet/verbose；错误与 warning 直接打印到控制台。

参数校验规则：

- `--dpi` 必须是正整数；超过 1200 时给 warning，仍继续；
- `--pages` 语法非法、页码越界（> pageCount）属于用法错误，退出 1；
- `--font-dir` 不存在或不是目录时报错退出 1；目录内无字体时 warning 后继续；
- `--format` 非法时打印允许值并退出 1；
- 未知参数、缺少 `<input>` 时打印 usage 并退出 1。

### 5.3 输出命名与目录

- 文件名：`<input-stem>-p<NNN>.<ext>`；
- 页号至少 3 位，按 `pageCount` 位数取 `max(3, digits)`，例如 12 页为 `-p001`，1200 页为 `-p0001`；
- 输入 stem 原样保留（含中文、空格），不做 slug；
- 单页文档同样使用 `-p001` 后缀，保证脚本处理一致；
- `--no-overwrite` 时任一目标存在即失败，不产生部分覆盖；
- 默认覆盖已有文件，采用“临时文件 + rename”原子替换。

### 5.4 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 全部页成功（允许 warning） |
| `1` | 用法错误、参数非法、输入/输出路径错误、页码越界 |
| `2` | 文档级失败：无法打开、非 OFD、加密、XML/资源限制等 |
| `3` | 页级失败：至少一页失败，且至少一页成功 |
| `130` | 用户中断（SIGINT） |

页级失败全部失败时仍返回 `3`；文档打开失败才是 `2`。

### 5.5 JSON 报告

`--json` 时 stdout 只输出 JSON，日志与进度全部写 stderr。

```json
{
  "schemaVersion": 1,
  "tool": { "name": "ofdrw-view-cli", "version": "0.1.0" },
  "input": "/abs/input.ofd",
  "outputDir": "/abs/out",
  "format": "png",
  "dpi": 96,
  "pageCount": 12,
  "pages": [
    {
      "page": 1,
      "file": "input-p001.png",
      "width": 794,
      "height": 1123,
      "elapsedMs": 123,
      "warnings": []
    }
  ],
  "failures": [
    { "page": 3, "code": "OFD_IMAGE_DECODE", "message": "..." }
  ],
  "warnings": [
    { "code": "W_FONT_MISSING", "message": "...", "pageIndex": 0 }
  ],
  "elapsedMs": 1234,
  "exitCode": 0
}
```

- `pages` 只含成功页；`failures` 只含失败页；
- `warnings` 是打开阶段与所有页的并集，页级 warning 同时保留在对应 `pages[].warnings`；
- `exitCode` 与进程退出码一致，便于调用方在管道中读取；
- 字段只追加、不删除；变更需提升 `schemaVersion`。

## 6. 渲染流程

### 6.1 打开文档

```ts
const doc = await OFDDocument.open({
  source: { kind: 'node-file', path: input },
  renderer: new H5Canvas2DRenderer({ createCanvas }),
  imageDecoders: nodeImageDecoders,
  supplementaryFonts: fontFiles.map((path) => ({ path })),
  onWarning: (warning) => collector.push(warning),
  documentIndex,
  strictImageCtm,
  layerOrder,
});
```

- 只使用公共 API；不读取 ZIP、不解析 XML；
- `onWarning` 统一收敛，避免引擎 warning 直接打印导致 `--json` 输出被污染；
- 打开失败时把 `OFDError.code` 原样放进报告并退出 2。

### 6.2 逐页渲染

```ts
for (const pageNumber of pageNumbers) {
  const page = await doc.getPage(pageNumber - 1);
  const viewport = page.getViewport({ dpi });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));

  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  paintBackground(context, width, height);

  await page.render({
    canvasContext: context,
    viewport: { width, height, dpi },
  }).promise;

  const bytes = canvas.toBuffer(mime, { quality });
  await writeAtomic(outputPath, bytes);
  canvas.width = 0;
  canvas.height = 0; // 尽快释放原生像素缓冲
}
```

- Viewport 取整后传给 `render`，与 engine 的 Canvas 尺寸校验保持一致；
- 背景由 CLI 负责，engine 不清屏；默认白底，`--transparent` 时 PNG/WebP 不填背景；
- JPEG 不支持 alpha，`--transparent` 下强制白底并 warning；
- 单页渲染色后立即释放 canvas，降低串行处理的内存峰值；
- 页级异常记录到 `failures`，默认继续下一页；
- 全部结束后 `await doc.close()`，关闭失败只记录 warning，不覆盖已有结果。

### 6.3 Node 平台适配

`node/canvas.ts`：

```ts
import { createCanvas } from '@napi-rs/canvas';
import type { Canvas2DLike } from 'ofdrw-viewer-engine';

export function createNodeCanvas(width: number, height: number): Canvas2DLike {
  return createCanvas(width, height) as unknown as Canvas2DLike;
}
```

- `@napi-rs/canvas` 是原生依赖，按平台分发二进制；CLI 在安装后做一次可用性检查，失败时给出明确安装提示；
- 编码统一走 `canvas.toBuffer(mime, { quality })`，PNG 忽略 quality；
- 不引入 `pngjs` 作为运行时依赖，避免重复编码路径。

### 6.4 字体

v1 只支持“指定字体所在目录”：

- `--font-dir` 可重复；
- 递归扫描 `.ttf` / `.otf` / `.ttc` / `.otc`，大小写不敏感；
- 目录按参数顺序、文件按路径字典序排列，去重（`realpath`）后保证可复现；
- 以 `{ path }[]` 传给 `supplementaryFonts`，由 engine 解析并按字体资源匹配；
- 默认不扫描系统字体，避免不同机器结果不一致；
- 找不到匹配字体时由 engine 产生 `W_FONT_MISSING`，CLI 汇总展示，不中断转换。

### 6.5 图片解码

- Node 端通过 `@napi-rs/canvas.loadImage` 注入 `png` / `jpeg` / `webp` 三个解码插件；
- 插件实现放在 CLI 包内（生产代码），不复用 `packages/ofdrw-viewer-engine/test/helpers` 的测试文件；
- GIF/BMP 等格式 v1 不承诺；解码失败由 engine 产生 `W_IMAGE_DECODE` 并跳过该图；
- JBIG2/TIFF 依赖 engine 内置解码器，契约见第 3 节；CLI 不重复实现解码表。

### 6.6 取消、并发与原子写

- 默认串行：单页 canvas 的像素内存可能很大，并行会放大峰值；`pageModels` 缓存也按文档共享。v1 不提供 `--concurrency`；
- SIGINT：设置取消标志，对当前 `RenderTask.cancel()`，等待 promise 结束后退出 130；
- 写文件：先写同目录临时文件 `.tmp-<name>-<pid>-<random>`，完成后 `rename`；失败/取消时删除临时文件；
- 中断后已完成的页保留，未完成页不产生半成品文件；
- 超大页面：渲染前用 `width × height` 与 engine 默认 `maxCanvasPixels`（64,000,000）比较，超限时给出“降低 --dpi”的可读提示并退出 2，不分配 canvas。

## 7. 错误与 warning 呈现

- 错误：`错误[OFD_XXX]: message`，写 stderr；`--verbose` 追加 `cause` 与堆栈；
- 非 `OFDError`：归类为 `CLI_UNEXPECTED`，同样写 stderr；
- warning：默认只在结束时汇总计数，例如 `warning: 3 条（W_FONT_MISSING×2、W_IMAGE_DECODE×1）`；
- `--verbose` 或 `--json` 时输出每条 warning 的 code/message/pageIndex/objectId；
- warning 不改变退出码；如后续需要“warning 即失败”，再单独增加开关。

## 8. 测试与验收

### 8.1 单元测试

- `parseArgs`：必填输入、未知参数、互斥参数、默认值；
- 页码解析：`1-3,5`、重复、乱序、越界、非法输入；
- 输出命名：页数位数、中文/空格 stem；
- 字体目录扫描：递归、扩展名过滤、去重、空目录 warning；
- 退出码映射与 JSON 报告 schema；
- 原子写：成功替换、失败清理临时文件。

### 8.2 集成 / e2e

构建后用 `spawn(process.execPath, ['dist/bin.js', ...])` 跑真实样本：

| 用例 | 样本 | 断言 |
| --- | --- | --- |
| 单页 PNG | `hello.ofd` | 退出 0；1 个文件；尺寸 = `ceil(mm × dpi / 25.4)`；非空白 |
| 多页/页码范围 | `发票示例.ofd` | 页数正确；`--pages 1-2` 只产出 2 个文件 |
| 图片 | `containsJPEG.ofd` | 无 `W_IMAGE_DECODE`；图片区非空白 |
| 透明/背景 | `透明度文字.ofd` + `--transparent` | PNG 存在 alpha；JPEG 强制白底 |
| 缺字体 | `hello.ofd`（无内嵌字体） | `W_FONT_MISSING`；不崩溃；页面仍产出 |
| 字体目录 | 上述 + `--font-dir` 指向 Noto CJK | warning 减少/消失；文字区域 ink 增加 |
| 坏文件 | 非法字节/截断 OFD | 退出 2；stderr 含 `OFD_INVALID_PACKAGE` |
| 取消 | 大页样本 + SIGINT | 退出 130；无 `.tmp-*` 残留 |
| JSON | 任意样本 + `--json` | stdout 可 `JSON.parse`；字段齐全 |
| 帮助/版本 | — | 退出 0；输出包含用法/版本 |

- 像素级比较不放进 CLI 测试；engine 的黄金图 harness 已覆盖渲染正确性；
- CLI 测试只验证“输出链路正确”：文件存在、尺寸、格式 magic、非空白 ink、页数、报告；
- 测试产物写到 `test/.artifacts/`，结束后清理，不提交。

### 8.3 跨平台

- Linux 必测；
- Windows/macOS 至少手测：路径分隔符、中文与空格文件名、`@napi-rs/canvas` 二进制加载；
- 不把平台相关路径写死在测试里，统一用 `node:path` 与临时目录。

### 8.4 性能

- 用 `dense-text-perf.ofd` 记录“打开/每页/总耗时”，写进 JSON 报告；
- v1 不设硬性性能门禁，只保留基线，后续回归对比。

## 9. 分阶段与依赖

| 阶段 | 内容 | 依赖 |
| --- | --- | --- |
| P0 | 本设计评审、参数/命名/退出码定稿 | — |
| P1 | 包骨架、参数解析、输出/报告、字体目录扫描、Node canvas/图片解码、单元测试 | 无 |
| P2 | 接 `OFDDocument`/`OFDPage` 实现，跑通单页/多页；错误与取消 | engine API（T12） |
| P3 | 真实样本回归、字体/透明背景/JSON、README、构建与打包 | P2 |
| P4（可选） | 批量、并发、系统字体、PDF 输出 | 后续需求 |

风险：

- engine API 未落地时 P2 阻塞；P1 仍可独立交付；
- `@napi-rs/canvas` 原生包在目标平台安装失败会阻塞全部功能，需要安装检查与文档说明；
- JBIG2/TIFF 契约未确认时，扫描类票据样本可能缺图；
- 超大页面/高 DPI 可能触发内存上限，需要清晰提示。

## 10. 已定事项与待确认项

已定：

1. 子包名 `ofdrw-view-cli`，命令名 `ofdrw-viewer-cli`；
2. 默认输出目录 `./<输入文件名>/`；
3. 默认 DPI 96；
4. 目标文件已存在时默认覆盖，可用 `--no-overwrite` 关闭。

待确认：

1. JBIG2/TIFF 内置解码是否由 `OFDDocument.open` 默认启用（见第 3 节）。