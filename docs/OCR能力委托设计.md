# OCR 上游集成设计（UI / CLI）

> **状态：暂不实现（2026-10）**。本文档仅保留为设计参考，当前不进入实现：UI/CLI 的 OCR 能力、`@ofdrw/ofdrw-viewer-ocr` 包、模型接入与验证均暂缓。
> 重启条件：明确模型来源与验证环境后，再按 §9 的顺序启动。
>
> 设计版本：讨论稿 v0.3（2026-10）。
> 核心决策：
> 1. **engine 不参与 OCR**，零改动；
> 2. OCR 由 `@ofdrw/ofdrw-viewer-ui` / `@ofdrw/ofdrw-viewer-cli` 提供，识别对象是**整页最终渲染结果**；
> 3. **OCR 完全替代 engine 的文字提取**：启用且模型可用后，文字层/CLI 文本只来自 OCR，不再调用 `getTextContent`，不合并、不保留 `source` 字段；
> 4. **不提供任何模型**：不发布、不下载、不托管、不内置；模型由使用方自备；
> 5. OCR 包只支持 **PP-OCR 兼容契约**。
>
> 历史：v0.1（engine 内对象级 OCR）、v0.2（原生 + OCR 合并）方案作废，见 §11。

---

## 1. 目标与边界

### 目标

1. **替代而非补充**：开启 OCR 且模型可用时，UI 文字层与 CLI 文本导出**完全使用 OCR 结果**，不再读 engine 的 `TextItem`。
2. **整页识别**：图片文字、Path 绘制文字、GID 字形等所有“最终视觉文字”统一由像素识别覆盖。
3. **engine 零改动**：不加类型、选项、缓存、provider 接口。
4. **开关在 UI/CLI**：`OFDViewerOptions.ocr`、CLI `--ocr`；未配置时行为完全不变。
5. **独立跨平台包**：`@ofdrw/ofdrw-viewer-ocr` 提供 PP-OCR 管线 + 浏览器/Node/微信小程序运行时适配；不含模型。
6. **可降级**：OCR 失败时该页回退 engine 原生文字（UI）或回退原生导出（CLI），并给 warning，不阻断页面。

### 非目标

- 不做版面分析、表格结构、印章识别。
- 不提供模型、模型清单、下载命令、模型转换产物。
- 不改变 `page.render()` / `exportImage()`。
- 不做小程序 UI（只提供 `/wx` provider）。
- 不做“原生文字 + OCR 文字”的混合/去重。

---

## 2. 总体架构

```text
┌────────────────────────────── @ofdrw/ofdrw-viewer-ui ──────────────────────────────┐
│ OFDViewerOptions.ocr = { provider, dpi, ... }（provider 存在 = 启用）                │
│                                                                                    │
│  PageTextSource（UI 内部接口，二选一）                                               │
│    ├─ engine：page.getTextContent()                                                │
│    └─ OCR：                                                                        │
│         1. 离屏 canvas + page.render(ocrDpi, 无旋转) → getImageData                 │
│         2. provider.recognize({ image, dpi, pageIndex, signal })                    │
│         3. OcrPageResult → TextContent（96 DPI，无 source 字段）                     │
│         4. 缓存（按页 + dpi + provider 版本）                                        │
│                                                                                    │
│  TextLayerService / FindController 只依赖 PageTextSource                            │
│  启用 OCR 且模型可用 → 使用 OCR source；失败 → 该页回退 engine source                 │
└───────────────────────────────────┬────────────────────────────────────────────────┘
                                    │ OcrProvider（ocr 包定义）
┌───────────────────────────────────▼────────────────────────────────────────────────┐
│ @ofdrw/ofdrw-viewer-ocr                                                             │
│  core：PP-OCR 预处理 / DBNet 后处理 / CTC 解码 / 行合并 / 结果归一                     │
│  runtime：onnxruntime-node | onnxruntime-web | wx.createInferenceSession            │
│  不含模型；只读取使用方传入的 ArrayBuffer/路径/URL                                     │
└───────────────────────────────────┬────────────────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────────────────┐
│ @ofdrw/ofdrw-viewer-cli                                                             │
│  --ocr：渲染整页（@napi-rs/canvas）→ provider.recognize → 文本记录（无 source）        │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. `@ofdrw/ofdrw-viewer-ocr` 包

### 3.1 接口（不依赖 engine）

```ts
/** 图像像素坐标点。 */
export interface OcrPoint { readonly x: number; readonly y: number }

/** 行四边形；顺序左上、右上、右下、左下，单位：图像 px。 */
export type OcrQuad = readonly [OcrPoint, OcrPoint, OcrPoint, OcrPoint];

/** 字符框；可选，单位：图像 px。 */
export interface OcrChar {
  readonly text: string;
  readonly quad: OcrQuad;
  readonly confidence?: number;
}

export interface OcrLine {
  readonly text: string;
  readonly quad: OcrQuad;
  /** 0..1。 */
  readonly confidence: number;
  readonly chars?: readonly OcrChar[];
}

export interface OcrDurations {
  readonly detMs?: number;
  readonly recMs?: number;
  readonly totalMs?: number;
}

/** 一页的识别输入。 */
export interface OcrPageInput {
  /** 页索引，从 0 开始；仅用于诊断。 */
  readonly pageIndex: number;
  /** RGBA 位图；宽高与 dpi 对应。 */
  readonly image: {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
  };
  /** 渲染 DPI。 */
  readonly dpi: number;
  /** 取消信号；中止时抛 AbortError。 */
  readonly signal: AbortSignal;
}

export interface OcrPageResult {
  readonly lines: readonly OcrLine[];
  readonly durations?: OcrDurations;
}

export interface OcrProvider {
  /** 稳定标识；用于缓存键与诊断。 */
  readonly id: string;
  /** 模型/管线版本；参与缓存键。 */
  readonly version?: string;
  recognize(input: OcrPageInput): Promise<OcrPageResult>;
  dispose?(): Promise<void> | void;
}
```

### 3.2 运行时适配

| 子路径 | 运行时 | 典型环境 |
|---|---|---|
| `@ofdrw/ofdrw-viewer-ocr/node` | `onnxruntime-node` | CLI、Node 服务 |
| `@ofdrw/ofdrw-viewer-ocr/browser` | `onnxruntime-web`（WASM/WebGPU） | UI、Web |
| `@ofdrw/ofdrw-viewer-ocr/wx` | `wx.createInferenceSession`（基础库 2.30.0+） | 微信小程序 |

- 每个子路径导出 `createNodeOcrProvider` / `createBrowserOcrProvider` / `createWxOcrProvider`。
- `onnxruntime-node`/`onnxruntime-web` 是 optional peer；未安装时创建 provider 抛可操作错误。
- 包体目标：core < 100KB（不含模型/运行时）。

```ts
export interface CreateOcrProviderOptions {
  /** 必填：使用方自备模型；没有默认值。 */
  readonly models: OcrModelBundle;
  /** 运行时偏好；默认自动。 */
  readonly execution?: 'wasm' | 'webgpu' | 'cpu' | 'npu';
  /** 是否延迟到首次识别再加载；默认 false。 */
  readonly lazy?: boolean;
  /** 可选：加载进度。 */
  readonly onProgress?: (progress: OcrModelProgress) => void;
}
```

### 3.3 模型：不在交付范围

**边界**：本包**不发布、不下载、不托管、不内置任何模型**，不提供默认 URL、模型清单或下载命令；不提供模型转换脚本产物；不承担模型许可。

使用方责任：

- 自备 PP-OCR 兼容的 ONNX 模型（det/rec，可选 cls）与字典；
- 自行决定分发方式（本地文件、CDN、对象存储、小程序分包/远程）；
- 自行确认许可；
- 通过 `models` 传入 `ArrayBuffer` / 本地路径 / URL。

模型契约（PP-OCR 兼容）：

| 模型 | 输入 | 输出 | 说明 |
|---|---|---|---|
| det | `1×3×H×W` float32，ImageNet 归一化 | `1×1×H×W` 概率图 | DBNet 后处理由 core 实现 |
| rec | `1×3×48×W` float32 | `1×T×C` logits | `C = 字典行数 + 1`（索引 0 为 CTC blank） |
| dict | UTF-8 文本 | 每行一个字符 | 行号 + 1 对应类别索引 |
| cls（可选） | `1×3×48×192` float32 | `1×2`（0°/180°） | 不传时跳过方向分类 |

- 不兼容上述契约的模型，使用方需自行实现 `OcrProvider`。
- 文档只说明契约，不额外提供模型准备指南或转换产物（按讨论结论）。

### 3.4 包结构

```text
@ofdrw/ofdrw-viewer-ocr
  src/core/        管线、后处理、结果归一
  src/runtime/     各端 adapter（读取使用方提供的字节/路径/URL）
  exports:
    "."            core + 类型
    "./node"       Node provider
    "./browser"    Browser provider
    "./wx"         WeChat provider
```

---

## 4. UI 集成

### 4.1 选项

```ts
// ui/src/options.ts
export interface ViewerOcrOptions {
  /** 识别实现；由宿主自行创建（模型自备）。存在即启用 OCR。 */
  readonly provider: OcrProvider;
  /** 渲染 DPI，默认 200；范围 72..400。 */
  readonly dpi?: number;
  /** 页级结果缓存数量，默认 8。 */
  readonly maxPages?: number;
  /** 单页超时，单位 ms，默认 60_000。 */
  readonly timeoutMs?: number;
  /** 识别进度回调（可选）。 */
  readonly onProgress?: (progress: ViewerOcrProgress) => void;
}

export interface OFDViewerOptions {
  // ...现有字段
  /** OCR 能力；省略时不启用，行为与当前完全一致。 */
  readonly ocr?: ViewerOcrOptions;
}
```

- 不存在 `mode`：启用即替代，不做原生/OCR 混合。
- **触发方式**：默认手动。UI 提供“识别文字”入口（工具栏/按钮）；点击后对当前页执行 OCR，之后新进入可见区的页面自动识别（用户已授权）。
- 未点击前，文字层仍用 engine 原生文字；点击后该页起切换为 OCR。

### 4.2 页面位图

```ts
const canvas = document.createElement('canvas');
canvas.width = Math.ceil(pageInfo.widthMm * dpi / 25.4);
canvas.height = Math.ceil(pageInfo.heightMm * dpi / 25.4);
const context = canvas.getContext('2d', { willReadFrequently: true });
await page.render({
  canvasContext: context,
  viewport: { width: canvas.width, height: canvas.height, dpi },
  signal,
});
const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
```

- 坐标：图像 px 是 `dpi` 下的页面 px；转换到文字层 96 DPI 用 `× 96 / dpi`。
- 不旋转：OCR 用页面原始方向；旋转仍由 UI 的 CSS transform 承担。
- 背景填白。
- 画布像素上限沿用 UI 的 `maxCanvasPixels`；超限时降级/跳过并 warning。
- 不复用可见 canvas（分辨率受缩放影响），第一版独立离屏渲染。

### 4.3 文字来源切换

**核心：`PageTextSource` 二选一，不做合并。**

```ts
// ui/src/text/text-source.ts
export interface PageTextSource {
  getTextContent(pageNumber: number, signal: AbortSignal): Promise<TextContent>;
}
```

- 默认实现：`page.getTextContent()`。
- OCR 实现：渲染位图 → `provider.recognize` → `OcrPageResult → TextContent`。
- `TextLayerService` / `FindController` 构造参数注入 `textSource`。
- 启用 OCR 且模型可用：使用 OCR source；OCR 失败 → 该页回退 engine source。
- 不使用 `source` 字段、不区分 OCR/原生项；`TextContent` 与 engine 输出完全同构。

### 4.4 OCR 结果 → TextContent

- 输出 DPI 固定 96（与 `textContentOptions` 一致）：
  - `pageWidth = widthMm * 96 / 25.4`，`pageHeight` 同理。
  - 行 quad/rect/chars 全部 `× 96 / dpi`。
- 每行一个 `TextItem`：
  - `order`：按阅读顺序（y 升序、x 升序）从 0 递增。
  - `layer: 'page'`，`layerType: 'Body'`，`visible: true`，`alpha: 1`。
  - `text`：行文本。
  - `font`：占位 `{ resourceId: 'ocr', family: 'OCR', italic: false }`（UI geometry 不读 font，仅满足类型）。
  - `size`：行高 px（`|quad[3]-quad[0]|`）。
  - `advance`：行宽 px（`|quad[1]-quad[0]|`）。
  - `origin`：`quad[3]`（左下）。
  - `quad`：行四边形；`rect`：AABB。
  - `transform`：`pxPerMm = 96 / 25.4` 的缩放/旋转矩阵，线性部分按行方向/行高方向构造；保证 `cssLinearOf()` 后为单位矩阵，span 落在 rect 上。
  - `chars`：`includeChars` 时按行文本均分生成（`approximate: true`，无 glyphId/faceKey）。
  - `charCount`：码点数。
- `itemCount/charCount/truncated`：按 UI 的节点上限截断。
- 空结果（0 行）：返回空 `TextContent`，文字层为空。

### 4.5 查找与选区

- `FindController` 与 `TextLayerService` 共用同一 `PageTextSource`，因此启用 OCR 后查找也搜索 OCR 文本，不需要额外分支。
- 风险：OCR 慢时查找会被拖住。第一版：
  - 只对**已缓存**的 OCR 页使用 OCR source；未识别页仍查找 engine 原生文字（若该页尚未切换）。
  - 或查找前提示“正在识别”。
- 选区/复制：OCR 项 span 正常选中；`selection.ts` 基于 DOM Range，无需改动。
- 不使用 `data-source`/class 区分，因为文字层只有一种来源。

### 4.6 缓存、取消、降级

- 缓存键：`pageNumber + dpi + provider.id + provider.version`。
- LRU：`maxPages`（默认 8）。
- 取消：页面离开可见区/文档关闭/重新渲染时 abort；signal 透传到渲染与 provider。
- 超时：`AbortController + setTimeout`（不依赖 `AbortSignal.timeout`）。
- 降级：
  - OCR 失败/超时 → 该页回退 engine `TextContent`；页内状态提示“识别失败”；页面正常。
  - 位图渲染失败/超限 → 回退 engine；页内状态提示。
- 并发：默认 1 页。

### 4.7 性能风险（必须正视）

PoC 实测（200 DPI，A4 1654×2339，`@ocr-web/core` + `onnxruntime-web` WASM）：

- 模型加载 ~2.3s；
- 整页识别 **> 4 分钟未完成**（主线程阻塞）；
- 根因：det 后处理/rec 批处理把多行 padding 到最长行，单线程 WASM 计算量大。

缓解：

1. 降低分辨率（120–150 DPI）或按行分块；
2. WebGPU 或 Worker；
3. 只对用户显式触发的页执行；
4. 默认关闭 OCR，显示“识别中”状态，可取消；
5. 兜底云 OCR（不在本包范围）。

Node（onnxruntime-node）同图约 2.76s/页，可接受；CLI 默认可启用。

---

## 5. CLI 集成

### 5.1 选项

```bash
# 启用 OCR：所有页文字来自 OCR，替代 engine 文本
ofdrw-viewer-cli input.ofd --ocr --ocr-model-dir ./models

# 同时导出图片
ofdrw-viewer-cli input.ofd --ocr --ocr-model-dir ./models --out ./out

# 只导出文本（不导出图片，沿用现有 --text 行为）
ofdrw-viewer-cli input.ofd --ocr --text --ocr-model-dir ./models
```

| 选项 | 说明 |
|---|---|
| `--ocr` | 启用 OCR；文字来源完全切换为 OCR |
| `--ocr-model-dir <dir>` | **必填**：使用方自备的 det/rec/dict 所在目录；无默认值、不下载 |

- 第一版不暴露 `--ocr-dpi`（内部固定 200）、不提供单文件参数、不提供 `--ocr-text-only`。
- 不再提供 `--ocr-mode`、`--ocr-only`：OCR 是替代，不是补充。

### 5.2 渲染与识别

- 复用 `createCanvasLike(width, height)`（`@napi-rs/canvas`）+ `page.render`，`getImageData` 取 RGBA；不经过 PNG 编解码。
- 坐标换算：图像 px × `96 / ocrDpi`，与现有 `--text` 输出统一 96 DPI。
- 每页流程：
  1. 渲染整页位图；
  2. `provider.recognize`；
  3. `OcrPageResult → TextRecord[]`；
  4. 写 JSON。
- **不再调用 `page.getTextContent()`**（除非 OCR 失败降级）。
- 失败：单页 OCR 失败 → 该页静默回退 `getTextContent`，不终止整篇；模型缺失/创建失败 → 文档级错误 `CLI_OCR_MODEL_REQUIRED`。

### 5.3 输出

```json
[
  { "text": "电子发票", "x": 449.3, "y": 55.2, "w": 723.7, "h": 55.7 },
  { "text": "购买方", "x": 449.3, "y": 120.1, "w": 240.0, "h": 24.3, "confidence": 0.98 }
]
```

- 与现有 `--text` 的 `{text,x,y,w,h}` 兼容；仅 OCR 项多一个 `confidence`。
- **无 `source` 字段**：启用 OCR 后输出就是 OCR 结果。
- 文件名沿用 `xxx-p001.json`。

### 5.4 模型

- 使用方自备；`--ocr-model-dir` 必填。
- 包不提供模型、不自动下载、无默认缓存目录；缺失时报 `CLI_OCR_MODEL_REQUIRED`，提示“请自行准备 PP-OCR 兼容 ONNX 模型与字典”。
- 许可由使用方自行确认。

### 5.5 SEA

- SEA 无法内嵌 `onnxruntime-node` 原生 `.node`；模型也需外部目录。
- 第一版：SEA 版 `--ocr` 报 `CLI_OCR_UNSUPPORTED`，文档说明“OCR 需要 npm 安装版 + 自备模型”。
- 后续可选：像 `@napi-rs/canvas` 一样从外部目录加载 onnxruntime。

---

## 6. 替代语义与降级

| 场景 | UI | CLI |
|---|---|---|
| 未配置 OCR | engine 文字层/查找 | engine 文本导出 |
| 已配置、未触发 | engine 文字层/查找 | —（CLI 无手动触发，`--ocr` 即执行） |
| 已触发、成功 | 文字层/查找完全用 OCR | 文本完全用 OCR |
| 已触发、失败 | 该页回退 engine，warning | 该页回退 engine，warning |

- 不合并、不去重、不保留两套文字。
- OCR 结果与 engine 文字在坐标基准上一致（都是页面 px，输出 96 DPI），因此文字层/查找/高亮可直接复用。

---

## 7. 小程序

- UI 是 Web Component + DOM，不能在微信小程序运行。
- 本包只提供 `@ofdrw/ofdrw-viewer-ocr/wx` provider；小程序宿主自行实现渲染（`wx.createOffscreenCanvas` + `getImageData`）、文字面板/复制。
- 模型由宿主自备：分包内置或 `wx.downloadFile` 到 `USER_DATA_PATH`（需域名白名单）。

---

## 8. 兼容性与测试

### 8.1 兼容性

- engine：零改动。
- UI：`OFDViewerOptions.ocr` 可选；未配置时 `PageTextSource` 默认实现等价于当前逻辑。
- CLI：`--ocr` 可选；未启用时输出与当前一致。
- 依赖：`@ofdrw/ofdrw-viewer-ocr` 对 UI 为 optional peer；CLI 为 dependency；未启用 OCR 时动态 import，不加载运行时。
- 无 `source` 字段、无 engine 类型改动。

### 8.2 测试点

UI：

1. 未配置 `ocr`：文字层/查找与当前完全一致。
2. 启用 + 手动触发：文字层完全来自 OCR，`getTextContent` 不再被调用。
3. 触发失败：回退 engine 文字 + 页内状态提示，不发 warning。
4. OCR→TextContent 坐标：固定 quad 在 96/200 DPI 下的 rect/size/advance/origin/transform；span 落在 rect 上。
5. 缓存：同页二次读取不重复识别。
6. 取消/关闭：abort 后不写文字层；关闭中止进行中的 OCR。
7. 选区/复制：OCR span 可选中复制。
8. 查找：共用 source，命中 OCR 文本。

CLI：

9. `--ocr`：不调用 `getTextContent`，输出 OCR 记录，无 `source`。
10. OCR 失败：该页静默回退原生文本，不终止整篇。
11. 模型目录缺失：`CLI_OCR_MODEL_REQUIRED`，不自动下载。
12. SEA：`CLI_OCR_UNSUPPORTED`。

### 8.3 测试替身

- `FakeOcrProvider`：返回固定行（文本 + quad + confidence），不依赖模型。
- UI 测试用固定 quad 断言坐标；CLI 用 fake 输出断言 JSON。

---

## 9. 实现顺序

> 当前状态：暂不执行。以下顺序仅作为重启后的参考。

1. **`@ofdrw/ofdrw-viewer-ocr` core + Node runtime**：PP-OCR 管线与结果格式（模型由测试方自备）。
2. **CLI `--ocr`**：渲染 → 识别 → JSON，验证精度/坐标/性能。
3. **UI `PageTextSource` 重构**：TextLayerService/FindController 注入点，默认实现不变，确保现有测试全绿。
4. **UI OCR source + 触发入口 + 文字层**：手动触发、缓存、降级。
5. **浏览器 runtime 性能优化**：分块/Worker/WebGPU。
6. **小程序 `/wx` runtime**（独立迭代）。

---

## 10. 已定与待定

已定：

- **v1 验收范围**：CLI `--ocr` 闭环、UI 手动识别 + 透明文字层、小程序 `/wx` provider、真实模型集成验证。
- **UI 行为**：当前页识别；首次点击后后续可见页自动识别；查找随文字层切 OCR；OCR 未完成/失败页查找回退原生；识别状态提示；失败回退 engine 文字层。
- **CLI 参数**：仅 `--ocr`、`--ocr-model-dir`（必填）；不暴露 `--ocr-dpi`、单文件参数、`--ocr-text-only`。
- **失败处理**：该页回退原生文字；UI 显示失败状态，CLI 静默回退（不额外 warning）。
- **包名**：`@ofdrw/ofdrw-viewer-ocr`。

待定（实现前需要确认）：

| # | 问题 | 推荐 |
|---|---|---|
| D1 | 真实模型验证的模型文件由谁提供 | 使用方提供本地路径；或允许临时下载到 `.local/`（不提交、不随包发布） |
| D2 | 小程序 `/wx` 的验证方式 | 类型检查 + 模拟 `wx` API 单测；真机/开发者工具由使用方验证 |
| D3 | UI 触发入口的具体位置 | 工具栏按钮，文案“识别文字” |

---

## 11. 决策记录

- 2026-10：放弃 v0.1“engine 内 OCR 开关 + 对象级 target”方案。原因：Path 绘制文字、复合对象、GID 字形来源太多，engine 内按对象收集复杂且易漏；整页像素识别更通用；engine 保持零 OCR 依赖。
- 2026-10：放弃 v0.2“原生 + OCR 合并”方案。OCR 改为**完全替代** engine 文字提取；不保留 `source` 字段，不做混合/去重。
- 2026-10：模型不由本包提供/下载/托管；只定义 PP-OCR 兼容契约，模型与许可由使用方负责。