# OFD 转图片与空间文本 CLI（ofdrw-viewer-cli）设计方案

> 状态：设计定稿 v1.2（2026-10-22）
> 定位：`ofdrw-viewer-engine` 的 Node CLI 子包；消费 engine 公共 API，输出页面图片，并可通过 `--text` 额外导出带坐标的文本；发布为多平台自包含可执行文件，并配套仓库内 Agent skill。
> 依据：《OFD 渲染引擎设计方案》v0.4 第 6.1/14.4/15 节、[`docs/text-content-api.md`](./text-content-api.md)。

## 1. 背景与目标

engine 只提供平台无关的页面渲染与文本内容 API，不负责读文件、创建 Canvas、编码图片、写 JSON 和跨平台分发。本子包补齐 Node 侧的完整链路：

```text
OFD 文件
  ├─ page.getTextContent() → 文字 + 位置（px）
  └─ page.render()        → Canvas → PNG/JPEG/WebP
```

目标：

1. 一条命令完成单文件、多页 OFD 的图片导出，`--text` 时同时导出空间文本；
2. 图片与文本共用同一页、同一 DPI、同一坐标系，可直接叠加；
3. 发布为 Linux/macOS/Windows 自包含可执行文件，用户无需安装 Node；
4. 提供仓库内 Agent skill，让 agent 能稳定定位可执行文件、调用、读取图片与可选 JSON；
5. 对坏文件、缺字体、缺图、文本截断、超大页面给出明确错误/警告。

## 2. 范围

### 2.1 v1 范围内

- 单个本地 OFD 文件输入；
- 输出 PNG（默认）、JPEG、WebP；
- `--text` 时输出每页 `<stem>-p<NNN>.json`（每项 `text` + `x/y/w/h`）；默认不输出 JSON；
- 全部页或指定页范围（`1-3,5`）；
- DPI、字体目录补充（`--font-dir`）；
- 人读日志；错误与 warning 直接打印到控制台；
- SIGINT 取消与临时文件清理；
- Node SEA 自包含可执行文件，多平台构建与发布；
- Agent skill（仅仓库源文件，不安装到本机，也不随 release 打包）。

### 2.2 v1 明确不做

- 多文件/目录批量、通配符、stdin/URL 输入；
- PDF 输出、打印；
- OCR（文本来自 OFD 内容层，不识别图片文字）；
- 注释/签章文字（`includeAnnotations=false`）；
- 多文档包的文档选择（只处理第一个文档）；
- 并行渲染（固定串行）；
- 自动扫描系统字体；
- 图片 DPI 元数据（PNG pHYs / JPEG density）写入；
- 纯文本模式（不渲染图片）；
- Linux musl/Alpine 产物；
- macOS 签名/公证与 Windows 代码签名。

## 3. 与 engine 的边界

CLI 只能从 `ofdrw-viewer-engine` 包根导入类型与 API，禁止跨包相对路径引用 engine 内部模块。

| CLI 需要的能力 | 来源 |
| --- | --- |
| 打开文档、页树、页尺寸、渲染任务、取消 | `OFDDocument` / `OFDPage` / `RenderTask` |
| 默认 Canvas2D 渲染器 | `H5Canvas2DRenderer` |
| Viewport 计算 | `page.getViewport({ dpi })` |
| 空间文本 | `page.getTextContent({ dpi, includeChars: false })`，只取 `item.text/rect` |
| 字体补充 | `OFDOpenOptions.supplementaryFonts` |
| 图片解码插件 | `OFDOpenOptions.imageDecoders` |
| warning/error | `onWarning`、`OFDError` |

依赖状态：

- 图片链路使用 `OFDDocument.open`、`OFDPage.getViewport` 与 `OFDPage.exportImage`；
- 文本链路使用 `OFDPage.getTextContent`（v1.1 增量，设计见 [`docs/text-content-api.md`](./text-content-api.md)），固定 `includeChars=false`；
- 截至本设计定稿，图片与文本链路均已落地并通过 CLI 单测、e2e 与 48 例黑盒验收；本机 Linux x64 + Node 26.10 验证。

`--text` 时文本 API 不可用的行为：`OFDDocument.open` 成功后检测 `typeof page.getTextContent === 'function'`；不存在则打印 `CLI_TEXT_UNSUPPORTED` 并退出 2，不静默只导出图片。

需要 engine 侧确认的一条契约：

- JBIG2/TIFF 内置解码器（`src/image/format.ts` 的 `builtinImageDecoders`）是否由 `OFDDocument.open` 默认启用。若默认不启用，应从包根导出该插件集合；否则 CLI 只能把 JBIG2/TIFF 页作为“图片缺失 warning”处理。

## 4. Node 约束与子包组织

### 4.1 运行约束

源码与开发环境只面向 Node，不做浏览器/小程序适配：

- 开发运行时 Node ≥ 22，ESM；
- 只用 Node 内置模块：`node:fs/promises`、`node:path`、`node:os`、`node:util.parseArgs`、`node:process`；
- 文件输入由 CLI 的 `NodeFileByteSource` 以 `OFDSource` 的 `custom` 形式提供，使用 `fs.promises.open` 随机读；
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
    cli.ts                  # parseArgs、帮助、参数校验、退出码
    convert.ts              # 打开文档、逐页导出、汇总
    text.ts                 # getTextContent → text + x/y/w/h 数组
    output.ts               # 输出目录、命名、图片编码、原子写
    log.ts                  # 进度、摘要、错误与 warning 输出
    errors.ts               # 错误到退出码映射
    canvas.ts               # @napi-rs/canvas 加载（普通 Node / SEA 两种来源）
    sea.ts                  # SEA 资产解压、缓存与 NAPI 路径设置
    image-decoder.ts        # Node 图片解码插件（png/jpeg/webp）
    fonts.ts                # --font-dir 递归扫描与去重
  test/
    unit/                   # 参数、命名、字体扫描、退出码、日志、JSON 序列化
    e2e/                    # 构建后普通 bin 的真实子进程
    acceptance/             # 黑盒验收：真实 bin/SEA + engine 文本 oracle
```

### 4.3 约定

- 子包目录、包名、命令名（`bin`）统一为 `ofdrw-viewer-cli`；
- 参数解析使用 Node 22 的 `node:util.parseArgs`，不引入 commander/yargs；
- 生产依赖只增加 `@napi-rs/canvas`；测试可增加 `pngjs`（校验尺寸/非空白），不进入运行时；
- `cli.ts` 负责参数，`convert.ts` 负责流程，`text.ts` / `output.ts` / `canvas.ts` / `sea.ts` 各负责一件事；
- 不导出公共库 API；测试通过内部 import 与 `spawn` 完成。

## 5. CLI 接口

### 5.1 用法

```bash
ofdrw-viewer-cli <input.ofd> [options]
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
```

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
| `-h, --help` | — | 帮助 |
| `-V, --version` | — | 版本与平台 |

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
| `2` | 文档级失败：无法打开、非 OFD、加密、`--text` 时文本 API 不可用等 |
| `3` | 页级失败：至少一页失败；全部页失败仍为 3 |
| `130` | 用户中断（SIGINT） |

一个页面成功 = 图片写出；`--text` 时还要求 JSON 也写出。任一失败即该页失败，但保留已成功的那一份。全部页失败仍返回 `3`；文档打开失败才是 `2`。

### 5.5 控制台输出

- 成功：`完成：12/12 页 → /abs/out（1.2s）`；`--text` 时为 `完成：12/12 页（图片 + 文本）→ ...`；
- 页失败：即时打印 `页面 3/12 失败 [OFD_IMAGE_DECODE]：...`，继续后续页；结束时打印 `完成：11/12 页，1 页失败 → /abs/out`；
- 文档失败：`打开失败 [OFD_INVALID_PACKAGE]：...`；
- warning：即时打印 `警告 [W_FONT_MISSING] 第 1 页：...`，结束时按 code 汇总计数；
- 正常摘要写 stdout，错误与 warning 写 stderr；
- TTY 下显示单行进度 `[3/12]`，非 TTY 不输出逐页进度；
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
const source = await NodeFileByteSource.open(input);
const doc = await OFDDocument.open({
  source: { kind: 'custom', source },
  createCanvas: createCanvasLike,
  encodeImage: encodeCanvasImage,
  imageDecoders: [...nodeImageDecoders],
  supplementaryFonts: fontFiles.map((font) => ({ path: font.path })),
  onWarning: printWarning,
});
```

- 只使用公共 API；不读取 ZIP、不解析 XML；
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
- SIGINT：CLI 主流程 AbortController 触发 `signal`，传给 `exportImage` 与 `getTextContent` 取消当前页；退出 130；
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
| Linux x64 (glibc) | `ubuntu-24.04` | `ofdrw-viewer-cli-<version>-linux-x64.tar.gz` |
| Linux arm64 (glibc) | `ubuntu-24.04-arm` | `ofdrw-viewer-cli-<version>-linux-arm64.tar.gz` |
| macOS x64 | `macos-13` | `ofdrw-viewer-cli-<version>-darwin-x64.tar.gz` |
| macOS arm64 | `macos-14` | `ofdrw-viewer-cli-<version>-darwin-arm64.tar.gz` |
| Windows x64 | `windows-latest` | `ofdrw-viewer-cli-<version>-windows-x64.zip` |
| Windows arm64 | `windows-11-arm` | `ofdrw-viewer-cli-<version>-windows-arm64.zip` |

每个压缩包包含：

```text
ofdrw-viewer-cli[.exe]
README.md
LICENSE
```

发布同时生成 `SHA256SUMS`。

### 8.5 CI 发布流程

新增 `.github/workflows/release-cli.yml`：

- 触发：`workflow_dispatch` 或 tag `cli-v*`；
- matrix 构建各平台；
- 每个 job：安装 Node 26.10、pnpm、依赖，运行 `pnpm --filter ofdrw-viewer-cli build:sea`，执行冒烟测试，上传 artifact；
- release job：下载全部 artifact、生成 `SHA256SUMS`、创建 GitHub Release；
- 权限仅 `contents: write`；
- 不自动执行 `git push`；发布由 tag/手动触发。

### 8.6 已知限制

- Linux 仅 glibc；musl/Alpine 不提供；
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
packages/ofdrw-viewer-cli/skills/ofdrw-viewer-cli/SKILL.md
```

skill 名：`ofdrw-viewer-cli`。skill 源文件作为 CLI 子包的一部分维护，只放仓库，不安装到 `~/.agents/skills/`，也不随 release 压缩包分发。

### 9.2 Skill 内容

frontmatter：

```yaml
---
name: ofdrw-viewer-cli
description: Convert OFD documents into per-page PNG/JPEG/WebP images with the ofdrw-viewer-cli executable, optionally adding spatial text JSON via --text. Use when an agent needs OFD page images, text with pixel coordinates, layout inspection, or OCR-free text extraction from an OFD file.
---
```

正文必须覆盖：

1. **何时使用**：需要 OFD 页面图、带坐标文本、版面定位；纯文本解析优先用 `mineru`。
2. **定位可执行文件**：`$OFDRW_VIEWER_CLI` → `command -v ofdrw-viewer-cli` → 仓库 `dist/sea/...`；找不到时按平台下载 release 并校验 `SHA256SUMS`，不要静默安装。
3. **命令**：
   ```bash
   "$CLI" input.ofd -o out
   "$CLI" input.ofd -o out --text
   "$CLI" input.ofd -o out --pages 1 --dpi 96
   "$CLI" input.ofd -o out --font-dir ./fonts
   ```
4. **产物**：默认 `<stem>-p001.png`；`--text` 时额外 `<stem>-p001.json`；命名规则与退出码。
5. **JSON 字段**：数组，每项只有 `{text,x,y,w,h}`；坐标原点左上、y 向下，与 PNG 对齐；不含字符/字体/quad。
6. **Agent 工作流**：
   - 先 `--pages 1` 预览图片；
   - 需要文字/坐标时加 `--text`；
   - 用 JSON 做文字搜索、区域定位、版面分析；
   - 用 PNG 做视觉确认；
   - 不要把 JSON 当 OCR 结果；缺字形时 `text` 仍可用，但 `glyphId` 可能为空。
7. **错误处理**：退出码 0/1/2/3/130；`OFD_*` 错误码；不要对 `2` 盲目重试；`3` 时检查 stderr 并保留已产出文件。
8. **字体**：`W_FONT_MISSING` 时用用户提供的字体目录；不要自动下载字体。
9. **安全**：路径加引号；不要执行不受信任的可执行文件；下载后校验 SHA256；大页/高 DPI 注意内存。
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
- warning 不改变退出码；文本截断只打印 engine warning，JSON 不含 `truncated` 字段。

## 11. 测试与验收

### 11.1 单元测试与 e2e

默认 `pnpm -C packages/ofdrw-viewer-cli test` 运行 10 个文件、171 个用例，不包含较慢的黑盒验收：

- `parseArgs`：必填输入、未知参数、默认值、`--text` 开关、中文参数错误；
- 页码解析：`1-3,5`、重复、乱序、越界、非法输入，以及单段/合并后总页数 100000 上限；
- 输出命名：默认图片；`--text` 时图片与 JSON 成对、同 stem 同页号；
- 字体目录扫描：递归、扩展名过滤、去重、空目录 warning；新增自合成 `test/fixtures/minimal.ttf` 保证 `--font-dir` 始终可执行；
- 退出码映射、摘要、TTY/非 TTY 进度、`CLI_VERSION` 与 package.json 一致；
- 文本 JSON：`TextItem` → `{text,x,y,w,h}`、过滤空 `text`、保持 `items` 顺序、不输出其他字段；空页 `[]`；
- 原子写：成功替换、失败清理临时文件；
- SEA 资产路径、`u<uid>` 缓存命名、属主/0700/0600/符号链接/摘要不符/预置目录负向校验。

`test/e2e/cli.test.ts` 以真实 `dist/bin.js` 子进程覆盖图片与文本主路径；`test:acceptance` 额外执行黑盒验收。

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

截至 2026-10-22，本期 P1–P5 已完成并在本机 Linux x64（Node 26.10、glibc）验证；P6 为后续可选项。

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 本设计评审；CLI 参数、输出、文本 JSON、SEA 方案定稿 | 完成 |
| P1 | 包骨架、参数解析、输出/日志、字体目录扫描、Node Canvas/图片解码、单元测试 | 完成 |
| P2 | 接 `OFDDocument`/`OFDPage.exportImage`，跑通图片导出；错误与取消 | 完成 |
| P3 | 接 `OFDPage.getTextContent`，用 `--text` 跑通空间文本 JSON | 完成 |
| P4 | SEA 构建脚本、平台矩阵（含 Windows arm64）、冒烟测试、release workflow | 完成（Linux x64 产物实测；其他平台待 CI/实机） |
| P5 | Agent skill 编写与仓库内校验、README/发布说明 | 完成 |
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
5. CLI 参数为输入、输出目录、格式、DPI、页码、字体目录、`--text`；其余行为使用内部默认值；
6. 默认只导出图片；`--text` 时每页额外导出空间文本 JSON；
7. `--text` 的文本为 px 坐标、文本项级 `text + x/y/w/h`、与图片同 DPI；
8. 发布采用 Node SEA 自包含可执行文件，Windows arm64 纳入 v1；
9. 提供 `packages/ofdrw-viewer-cli/skills/ofdrw-viewer-cli/SKILL.md`，skill 源文件随子包维护，仅放仓库，不安装、不随 release 分发；
10. macOS 只编译可执行文件，不签名、不公证。

待确认：

1. JBIG2/TIFF 内置解码是否由 `OFDDocument.open` 默认启用；
2. `windows-11-arm` runner 是否可用；不可用时是否接受用 ARM64 Node 二进制交叉注入。