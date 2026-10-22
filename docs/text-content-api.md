# v1.1 文本内容 API 设计（阅读器文字层）

| 项 | 内容 |
|---|---|
| 设计任务 | T13.1 文本内容 API 设计落盘 |
| 版本 | v1.1 增量设计；**r9 已纳入 v1 公共契约** |
| 依赖 | v1 T4 `layoutText`、T6b `prepare/drawPage`、T7 `OFDDocument/OFDPage` |
| 状态 | 已实现（2026-10-22，r9）；实现状态/差异见 §14 |
| 任务 | 设计 t18；实现 t70/t72；文档同步 t73 |

## 0. 结论摘要

v1.1 新增 **阅读器文字层**：`OFDPage.getTextContent(options?)` 返回以 **px** 为主坐标的 `TextContent`，内部以 **mm** 布局并缓存；文字仍只走 `layoutText`，不调用 Canvas 文字 API。

核心口径：

1. 一个 `TextItem` 对应一个 `TextObject`，`TextCode` 按 XML 顺序拼接；字符级数据放在 `TextItem.chars`。
2. 主坐标 px：`px = mm × dpi / 25.4`，原点为 `PhysicalBox` 左上角；与 `getPageTransform`/`drawPage` 完全一致。
3. 缓存以 mm 保存，`dpi` 不进入缓存键；同一页 96/144/300 DPI 复用同一份 mm 布局，只在输出时换算。
4. 复用 `layoutText` 的 `TextLayoutUnit.placements`；不改 v1 文字绘制结果。
5. 复用 `drawPage` 的模板/图层顺序与可见对象遍历；依赖 T20/T21 的 `ZOrder` 修复，不另写一套模板规则。
6. 不进入 Pattern tile、ClipArea.text；只遍历页面/模板/复合/注释的可见内容。
7. `maxTextItems`/`maxTextChars` 有硬上限；超限截断并发 `W_TEXT_ITEM_LIMIT`/`W_TEXT_CHAR_LIMIT`，不抛错、不无界分配。
8. 缓存/并发/取消在 `OFDDocument` 层统一管理；`close()` 中止所有文本任务并清缓存。

## 1. 非目标与边界

- **设计时非目标、r9 已纳入**：T13.1 设计时 `OFDPage.getTextContent`/`TextContent*`/`W_TEXT_*` 属 v1.1 增量，v1 的 19.6 未新增验收项；r9 已作为阅读器 UI API P0 纳入公开契约，状态见 §14。
- **不改变 v1 绘制**：`drawTextObject`、`layoutText` 的现有输出不变；T13.2 只允许新增纯函数/类型，不改变 v1 测试断言。
- **不引入 Canvas/DOM/Node 依赖**：`render/text-content.ts` 只能 import `model`/`style`/`font`/`render` 的纯类型/纯函数，不 import `renderer/canvas2d`、`api` 或 `node:*`。
- **不做 OCR/PDF 文本抽取**：只读 OFD `TextObject` 模型。
- **不处理 Pattern/Clip 内部文字**：它们是绘制/裁剪语义，不是页面可读文字（见 §5.4）。
- **不在 v1.1 打开 Node 适配**：T13.5 的 Web 层仍 Web-first；Node 仅测试注入。

## 2. 当前实际签名核对（2026-10-21 工作树）

| 现有模块 | 实际签名/字段 | 对本设计的约束 |
|---|---|---|
| T4 [`src/render/text.ts:564`](../packages/ofdrw-viewer-engine/src/render/text.ts:564) | `layoutText(object, faces, options?): TextLayout` | 直接复用；输出 `TextLayout.units`、`endX/endY`、`TextLayoutUnit.placements`（含 `faceKey/gid/x/y/advance`）与 `cpStart/codeCount`。 |
| T4 [`src/render/text.ts:28`](../packages/ofdrw-viewer-engine/src/render/text.ts:28) | `GlyphRun {face,gid,advanceWidth,path}`、`GlyphPlacement {faceKey,gid,x,y,advance}` | 字符几何从 `placements` 推；不读取 `path`，避免复制轮廓。 |
| T4 [`src/render/text.ts:82`](../packages/ofdrw-viewer-engine/src/render/text.ts:82) | `TextLayoutOptions {onWarning,objectId,outlineCache}` | 文本 API 复用 warning/缓存；`objectId` 用于 warning 去重。 |
| T6b [`src/render/prepare.ts:81`](../packages/ofdrw-viewer-engine/src/render/prepare.ts:81) | `PreparePageInput {page,resources,loader,dpi?,strictImageCtm?,signal?,onWarning?}` | 文本 API 可复用 `preparePage`；建议新增可选 `loadImages?: boolean`，文本路径不解码图片。 |
| T6b [`src/render/prepare.ts:99`](../packages/ofdrw-viewer-engine/src/render/prepare.ts:99) | `PreparedPageBundle {page,templates,fonts,images,blocks}` | 提供 `styles`（`page.styles`）、字体、模板、注释块；文本遍历不复用 `displayList`。 |
| T6b [`src/render/page.ts:44`](../packages/ofdrw-viewer-engine/src/render/page.ts:44) | `drawPage(prepared,renderer,ctx,viewport,options?)` | 图层顺序/模板解析/注释顺序需抽出纯函数供文本 API 共用；不得复制一套。 |
| T6b [`src/render/object.ts:281`](../packages/ofdrw-viewer-engine/src/render/object.ts:281) | `drawObject(context,object,style)` | 可见性/归一化 Boundary/对象矩阵规则要共用；文本 API 只取几何，不绘制。 |
| T6b [`src/render/block.ts:186`](../packages/ofdrw-viewer-engine/src/render/block.ts:186) | `drawIndependentBlock(context,block)` | 文本遍历用 `block.content`/`getBlockStyles`，不调用绘制。 |
| T7 [`src/api/page.ts:28`](../packages/ofdrw-viewer-engine/src/api/page.ts:28) | `OFDPage` 构造函数 `(index,pageSize,driver)`；`render()` | 增加可选 text driver；保持旧三参构造可编译（宿主不应直接构造，但 API 兼容）。 |
| T7 [`src/api/document.ts:497`](../packages/ofdrw-viewer-engine/src/api/document.ts:497) | `getPage(pageIndex): Promise<OFDPage>` | 传入文本 driver；内部复用 `getPageEntry` 与缓存。 |
| T7 [`src/api/types.ts:46`](../packages/ofdrw-viewer-engine/src/api/types.ts:46) | `CacheOptions` 5 个必填字段 | v1.1 加可选 `textPages?: number`（默认 4），不破坏现有调用方。 |
| T7 [`src/api/viewport.ts:22`](../packages/ofdrw-viewer-engine/src/api/viewport.ts:22) | `MM_PER_INCH=25.4`、`getPageTransform` | px 换算直接用 `dpi / MM_PER_INCH`；不要另写常量。 |
| `src/model/types.ts:97` | `TextCode {text,x?,y?,deltaX,deltaY,cgTransforms}`；`TextObject {font,size,hScale,readDirection,charDirection,weight,italic,fill,stroke,codes}` | `text` 已解码、`Array.from` 处理码点；一个 TextObject 一个 item。 |
| `src/style/types.ts:16` | `ResolvedStyle {fill,stroke,fillPaint?,strokePaint?,alpha}` | 可见性判断用 `style.fill || style.stroke`；不要只信 `object.fill`。 |
| `src/model/types.ts:235` | `Annotation {visible,appearance?,boundary?}` | `includeAnnotations` 只遍历 `prepare` 已过滤的 annotation blocks；不自行重解 XML。 |

## 3. 公共类型（v1.1）

```ts
/** 文本坐标单位：主坐标 px（页面 PhysicalBox 左上角为原点，y 向下）。 */
export type TextUnit = 'px';

/** 二维点，单位 px。 */
export interface TextPoint {
  x: number;
  y: number;
}

/** 轴对齐矩形，单位 px；x/y 为左上角。 */
export interface TextRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 字形单元四边形，单位 px。
 * 顺序固定为：左上、右上、右下、左下（相对于字形/字符方向）。
 * 旋转文字下“上”指字形自身方向，不是页面 y 方向。
 */
export type TextQuad = readonly [TextPoint, TextPoint, TextPoint, TextPoint];

/** 字体元信息；主字体来自 TextObject.font。 */
export interface TextFontInfo {
  /** 字体资源 ID（TextObject.font）。 */
  resourceId: string;
  /** 字体族名。 */
  family: string;
  /** PostScript 名（若存在）。 */
  postscriptName?: string;
  /** OS/2 weightClass（若存在）。 */
  weightClass?: number;
  /** 字体本身是否斜体。 */
  italic: boolean;
}

/** 文本项所在层。 */
export type TextLayer = 'template' | 'page' | 'annotation';

/** 单个 TextObject 的阅读器文本项。 */
export interface TextItem {
  /** 绘制顺序下标，从 0 递增；与 layerOrder 一致。 */
  order: number;
  /** TextObject.id；匿名对象为 undefined。 */
  objectId?: string;
  /** 模板时给出模板页 ID。 */
  templateId?: string;
  /** 注释时给出注释 ID。 */
  annotationId?: string;
  /** 所在复合块 ID；顶层为 undefined。 */
  blockId?: string;
  /** 所在层。 */
  layer: TextLayer;
  /** 所在图层类型；复合块继承外层。 */
  layerType: 'Background' | 'Body' | 'Foreground' | 'Custom';
  /** 有效模板 ZOrder；非模板 undefined。 */
  zOrder?: 'Background' | 'Body' | 'Foreground';
  /** 是否参与绘制；includeInvisible=false 时恒为 true。 */
  visible: boolean;
  /** 对象 alpha，0..1（仅对象自身；不含父块 group alpha）。 */
  alpha: number;
  /** 原始文本（按 TextCode 顺序拼接，保留空白/换行）。 */
  text: string;
  /** 主字体信息。 */
  font: TextFontInfo;
  /** 字号，单位 px。 */
  size: number;
  /** 布局局部 mm → 页面 px 的矩阵；列向量约定。 */
  transform: Matrix;
  /** 首字符 baseline 起点，单位 px。 */
  origin: TextPoint;
  /** 轴对齐包围盒，单位 px。 */
  rect: TextRect;
  /** 外接四边形，单位 px；旋转/多 run 时可能大于单字符范围。 */
  quad: TextQuad;
  /** 沿阅读方向的总推进量，单位 px；始终非负。 */
  advance: number;
  /** 文本字符数（按 Unicode 码点计，含缺失字形）。 */
  charCount: number;
  /** 字符级数据；includeChars=false 时省略。 */
  chars?: TextChar[];
}

/** 单个 Unicode 码点的字符项。 */
export interface TextChar {
  /** 该码点的文本（可能是代理对的两个 UTF-16 单元）。 */
  text: string;
  /** Unicode 码点。 */
  codePoint: number;
  /** 实际使用的字形 ID；缺字时为 undefined。 */
  glyphId?: number;
  /** 实际字体面 key；缺字时为 undefined。 */
  faceKey?: string;
  /** 是否使用回退字体（非主字体）。 */
  fallback: boolean;
  /** 字符起点（baseline），单位 px。 */
  origin: TextPoint;
  /** 该字符的推进量，单位 px；缺失字形为 0。 */
  advance: number;
  /** 轴对齐包围盒，单位 px；缺失字形时宽高为 0。 */
  rect: TextRect;
  /** 字符单元四边形，单位 px；缺失字形时四点为 origin。 */
  quad: TextQuad;
  /** 是否由近似映射得到（多字形 run 与字符数不一致）。 */
  approximate: boolean;
}

/** 一页的阅读器文本内容。 */
export interface TextContent {
  /** 页索引，从 0 开始。 */
  pageIndex: number;
  /** 输出 DPI；px 换算依据。 */
  dpi: number;
  /** 坐标单位，固定 'px'。 */
  unit: TextUnit;
  /** 页面可视宽高，单位 px。 */
  pageWidth: number;
  pageHeight: number;
  /** 按绘制顺序的文本项。 */
  items: TextItem[];
  /** 包含的 TextItem 数。 */
  itemCount: number;
  /** 包含的字符数（即使 includeChars=false 也统计）。 */
  charCount: number;
  /** 是否发生截断。 */
  truncated: {
    /** 达到 maxTextItems。 */
    items: boolean;
    /** 达到 maxTextChars。 */
    chars: boolean;
  };
}

/** 文本内容选项。 */
export interface TextContentOptions {
  /** 输出 DPI，默认 96；非法值回退 96。 */
  dpi?: number;
  /** 是否返回 chars；默认 true。false 时 item.chars 省略，但 text/charCount 保留。 */
  includeChars?: boolean;
  /** 是否包含注释 Appearance 文字；默认 false。 */
  includeAnnotations?: boolean;
  /** 是否包含 Visible=false 或 alpha=0 的文字；默认 false。 */
  includeInvisible?: boolean;
  /** 图层顺序；缺省沿用 document 打开时的 layerOrder。 */
  layerOrder?: 'document' | 'type';
  /** 取消信号；中止以 OFD_ABORTED 拒绝。 */
  signal?: AbortSignal;
  /** 文本项上限；默认 20,000；0 表示不限（宿主自担内存风险）。 */
  maxTextItems?: number;
  /** 字符上限；默认 500,000；0 表示不限。 */
  maxTextChars?: number;
}
```

### 3.1 类型放置与导出（实现差异）

- **实际实现**：公开类型放 `src/api/ui-types.ts`，由 `src/index.ts` 直接导出；`src/render/text-content.ts` 只保留 `TextPageMm/TextItemMm/TextCharMm` 等内部 mm 结构及 `collectTextPageMm`/`toTextPagePx`。
- 原设计建议 `src/render/text-content-types.ts`；为满足 r9 公共类型统一入口且避免 render→api 反向依赖，按 t66 契约调整为 `api/ui-types.ts`，render 侧使用内部结构/映射。
- `TextContent` 不携带 Renderer/Canvas/内部 `PreparedPageBundle`。
- 不导出 `TextPageData` 等 mm 内部结构。

## 4. 坐标与几何规则

### 4.1 px 主坐标

与 v1 `getPageTransform`/`drawPage` 一致：

```text
s = dpi / 25.4
M_page_px = S(s) × T(-PhysicalBox.x, -PhysicalBox.y)
```

- 原点：页面 PhysicalBox 左上角；y 向下；单位 px。
- `TextContent.pageWidth/pageHeight = page.size × s`（不是 `area.width × s` 后再平移）。
- 所有 `transform/rect/quad/origin/advance/size` 均为 px；允许小数，API 不取整。
- 内部 mm 缓存：`transformPageMm = T(-area.x,-area.y) × T(boundary.x,boundary.y) × CTM`，px 输出时左乘 `S(s)`：

```text
transformPx = S(s) × transformPageMm
```

### 4.2 TextItem.transform

`TextItem.transform` 把 `layoutText` 的局部坐标（mm）映射到页面 px：

```text
M_item = T(-area.x,-area.y) × T(object.boundary.x, object.boundary.y) × object.ctm
item.transform = S(dpi/25.4) × M_item
```

- 模板页不额外应用 `TemplatePage.Area`（与 T6b 一致：模板 Area 只用于页尺寸回退）。
- 注释：`M_item = T(-area.x,-area.y) × T(annotation.boundary.x,y) × T(object.boundary.x,y) × CTM`。
- 复合对象：块内容坐标以块空间为起点；外层对象矩阵为 `M_parent × T(composite.boundary) × composite.ctm`，块内 TextObject 再乘自身 `T(boundary) × CTM`。
- PageBlock 无自身变换，只递归。

### 4.3 TextChar 四边形

对 `TextLayoutUnit.placements[i]`：

```text
M_char = M_item × T(placement.x, placement.y) × R(charDirection)
```

局部细胞四点（mm，baseline 为 y=0，字形上方为负 y）：

```text
p0 = (0,        -size)   // 左上
p1 = (advance,   -size)  // 右上
p2 = (advance,    0)     // 右下
p3 = (0,          0)     // 左下
```

- `quad = [M_char(p0), M_char(p1), M_char(p2), M_char(p3)]`，顺序固定。
- `char.origin = M_item(placement.x, placement.y)`；`char.advance = placement.advance × s`。
- `char.rect` 是 quad 四点的轴对齐包围盒。
- 缺失字形：`glyphId/faceKey=undefined`，`advance=0`，四点为 `origin`，`rect` 宽高 0。
- `charDirection` 旋转使用与 `glyphMatrix` 相同的 y-down 旋转矩阵；不应用合成斜体（文本层只需要可点击/可选择几何，不改变 ink 轮廓）；合成粗体也不改 advance。
- `size` 取 `object.size`（mm→px），不做 glyph 实际 ink bbox；因此四边是字面 cell，不是轮廓紧包围盒。

### 4.4 字符映射规则

`TextLayoutUnit` 只保证 run 覆盖 `cpStart/codeCount`，不保证 `placements.length === codeCount`：

1. 每个 `TextCode` 先 `Array.from(text)` 得到码点序列。
2. 若 `placements.length === codeCount`：逐字符映射 `placement[i]`，`approximate=false`。
3. 若 `placements.length !== codeCount`（连字/多字形/缺字）：
   - 计算 run 首 placement 到 run 末（按 `advance` 累加）的组框；
   - 该 run 的每个字符都使用组框，`approximate=true`；
   - `glyphId/faceKey` 只有能一一对应时填；否则留空。
4. 缺失字形（`placements` 为空）：所有字符 `advance=0`、四点为 `unit.x/y`，`approximate=false`。
5. `TextItem.text` 始终保留全部码点；`charCount` 按码点计；`chars` 顺序与 `text` 一致。

> 说明：这是阅读器选择/高亮几何的近似；不承诺逐字符 ink 精度。对 1:1 的绝大多数 OFD 文本，`approximate=false`。

### 4.5 TextItem 的 rect/quad/advance/origin

- `origin`：第一个有 placement 的字符起点；全缺字时取第一个 unit 的 `x/y`。
- `advance`：沿阅读方向的 pen 总位移绝对值：

```text
dx = endX - startX; dy = endY - startY
advance = sqrt(dx² + dy²)   // mm→px 后
```

- `rect`：所有 `chars.rect` 的并集；无 chars 时由 `origin/advance/size` 构造。
- `quad`：`rect` 的四角（轴对齐外接四边形），用于快速 culling；字符级旋转几何以 `chars[].quad` 为准。这样避免对多 run/旋转文字构造复杂凸包。

## 5. 遍历、可见性与排除规则

### 5.1 与 drawPage 共用的顺序

新增纯函数（T13.2，放 `src/render/page-order.ts` 或 `page.ts` 内部导出）：

```ts
type DrawEntry =
  | { kind: 'template'; ref: TemplateRef; model: PageModel; zOrder: EffectiveZOrder }
  | { kind: 'page-layer'; layer: Layer }
  | { kind: 'annotation'; block: IndependentBlock };

resolvePageDrawOrder(prepared, options: { layerOrder; includeAnnotations }): DrawEntry[]
```

- `type` 模式：`Background → Body → Foreground → Custom`；每组先模板（同组按页面引用顺序）再页图层；模板的 **有效 ZOrder 优先取页面 `TemplateRef.zOrder`，缺省 Background**（依赖 T20/T21；不得沿用当前错误的 `page.ts` 分组）。
- `document` 模式：模板按引用顺序整体先画，再页图层 XML 顺序；注释始终最后。
- `drawPage` 改为使用该函数；文本 API 复用同一函数，保证文字顺序与视觉顺序一致。
- `includeAnnotations=false` 时函数不返回 annotation 项；`drawPage` 永远包含注释（渲染语义不变）。

### 5.2 可见对象判定

文本只收集 `TextObject`，但用与绘制一致的谓词：

```text
style = prepared.page.styles.get(object)（或 getBlockStyles(block).get(object)）
可绘制 = style != null
      && (includeInvisible || (object.visible && object.alpha > 0))
      && normalizedBoundary(object.boundary).w > 0
      && normalizedBoundary(object.boundary).h > 0
      && (style.fill || style.stroke)
      && object.size > 0
```

- `style.fill/stroke` 与 `drawTextObject` 的提前返回一致；无 Paint 的文字不进入文本层。
- `includeInvisible=true` 只放宽 `visible/alpha`；无样式/零 Boundary/无 Paint/零字号仍跳过（没有可读几何）。
- `TextItem.visible = object.visible && object.alpha > 0`；`alpha = object.alpha / 255`。
- 不因为父 composite group alpha 为 0 而丢弃子文字：父 alpha 影响可见性；若 `includeInvisible=false` 且父 alpha=0，整块跳过。父 alpha 不写入子 item（避免把组 alpha 重复乘到字符坐标）。

### 5.3 递归范围

- 页图层/模板图层：`Layer.children`，遇到 `PageBlock` 递归，遇到 `CompositeObject` 递归其 `PreparedPageBundle.blocks` 的 `block.content`（用 `getBlockStyles`）。
- 注释：`prepared.page.annotationBlocks`，仅 `includeAnnotations=true`；`block.source='annotation'`。
- `PageBlock` 深度按 `MAX_BLOCK_DEPTH=16`；循环/超深时 warning 并跳过，与绘制一致。
- 复合块只遍历一次每个 occurrence；同一资源被引用两次就产生两组 item（视觉上也画两次），用 `order` 区分，不按 objectId 去重。
- **底纹**：`PatternSpec.cell`/`PreparedPageBundle.blocks` 中 `source='pattern-cell'` 一律不遍历。底纹是 Paint，不是页面内容；tile 内文字不应重复出现在阅读层。
- **Clip**：`ClipArea.text` 不遍历。它只是裁剪轮廓，不是内容；即使某 TextObject 只被 Clip 引用，也不产生 item。
- **注释 Appearance**：只在 `includeAnnotations=true` 时遍历，默认不进入正文阅读顺序。

### 5.4 文本层类型

- `layer='template'`：来自模板页；`templateId=model.id`，`zOrder=entry.zOrder`。
- `layer='page'`：来自页图层；`zOrder` 缺省。
- `layer='annotation'`：来自注释 Appearance；`annotationId=block.id`；`layerType` 按 appearance 所在层（通常 `Body`）；`zOrder` 缺省。
- 复合块内文字继承引用它的外层 `layer/layerType/templateId/zOrder`；`blockId` 记录当前块 ID。

## 6. 选项、默认值与限制

### 6.1 默认值

| 选项 | 默认 | 说明 |
|---|---|---|
| `dpi` | 96 | 非法（非有限/≤0）回退 96，与 `getViewport` 一致。 |
| `includeChars` | true | 阅读器选择/高亮需要 chars；不需要时可关。 |
| `includeAnnotations` | false | 正文默认不含水印/签章外观；显式开启。 |
| `includeInvisible` | false | 与绘制一致。 |
| `layerOrder` | document 打开值（默认 `type`） | 显式覆盖；非法值按 `type` 并 warning `W_LAYER_ORDER`。 |
| `signal` | undefined | 中止以 `OFD_ABORTED` 拒绝。 |
| `maxTextItems` | 20,000 | 0=不限；非整数/负数回退默认。 |
| `maxTextChars` | 500,000 | 0=不限；非整数/负数回退默认。 |

### 6.2 限制语义

- 按 `TextObject` 粒度计数：一个 TextObject 的码点数计入 `charCount`。
- 达到 `maxTextItems`：不再加入后续 item；`truncated.items=true`；warning `W_TEXT_ITEM_LIMIT`。
- 达到 `maxTextChars`：若下一个 item 会超过，**不加入该 item**（避免半个 item），停止；`truncated.chars=true`；warning `W_TEXT_CHAR_LIMIT`。
- `truncated` 是二值对象，不是异常；调用方可提高限制重试。
- `itemCount/charCount` 只统计实际返回的 item/字符；`charCount` 不受 `includeChars` 影响。
- 限制是**页级**，不是文档级；大量页由宿主逐页取。

## 7. 缓存、并发与取消

### 7.1 双级缓存

**第 1 级**：复用现有 `OFDDocument.pageCache`（`PageEntry`：PageModel + ResourceScope + templates）。文本 API 不重复加载页面/XML/资源；`getPageEntry` 已有的 LRU 与并发合并继续生效。

**第 2 级**：`OFDDocument.textCache` 保存与 DPI 无关的 mm 文本数据：

```text
TextPageData (mm)
  ├─ items: TextItemMm[]（transformPageMm/rectMm/quadMm/advanceMm）
  └─ chars?: TextCharMm[]
```

- 键（`TextCacheKey`）：

```text
pageIndex
layerOrder
includeAnnotations
includeInvisible
includeChars
maxTextItems
maxTextChars
```

- **不含 `dpi`**：mm 布局与 DPI 无关；输出时乘 `S(dpi/25.4)`。
- 键不含 `document` 实例：缓存挂在 `OFDDocument` 私有字段，不同文档天然隔离。
- `textPages`：`CacheOptions` 新增可选 `textPages?: number`，默认 4（按页数 LRU）；淘汰只丢 mm 数据，不关闭字体/图片。
- 命中缓存只做 px 转换/裁剪；转换 O(items+chars)，不重新 layout。
- `close()` 清空 text cache/pending，禁止后续命中。

### 7.2 并发合并

- `OFDDocument` 私有 `textPending: Map<TextCacheKey, TextPending>`。
- 同一键的并发调用共享一个 build promise；每个调用方各自等待，不重复 layout。
- `TextPending` 记录 `controller: AbortController` 与 `waiters: number`。
- 调用方 `signal` 只影响自己的等待：
  - abort 时该调用方以 `OFD_ABORTED` 拒绝并 `waiters--`；
  - `waiters=0` 且 build 未完成时，`controller.abort()`，避免无人等待的 layout 继续；
  - build 完成后写缓存、删除 pending（无论成功/失败）。
- 共享 build 的 warning 只上报一次；`WarningCollector` 再做 `(code,pageIndex,objectId)` 去重。
- 不使用 `Promise.race` 留下未处理 rejection；所有 build promise 都有 `.catch` 清理。

### 7.3 取消点

build 在以下边界检查内部 signal（外部 signal 不直接传入共享 build）：

1. `loadPageEntry` 前后；
2. `preparePage` 前后（loader 已支持 signal）；
3. 每条 `DrawEntry`；
4. 每个 `PageBlock`/`CompositeObject` 递归；
5. 每个 `TextObject` 的 `layoutText` 前后；
6. 每个 item 加入前。

`layoutText` 本身是同步纯函数，不中途取消；单个超大 TextObject 是已知粒度风险（见 §12）。`close()` 通过内部 controller 中止所有 pending；`abort` 统一 `OFD_ABORTED`。

## 8. 警告、错误与降级

### 8.1 新增 warning（v1.1 契约）

| code | 触发 | 上下文 |
|---|---|---|
| `W_TEXT_ITEM_LIMIT` | 达到 `maxTextItems` | `pageIndex` |
| `W_TEXT_CHAR_LIMIT` | 达到 `maxTextChars` | `pageIndex` |

- 在 T13.2 同步 `src/warnings.ts` 的 `WarningCode`/`WARNING_CODES` 与 v1.1 契约文档；**v1 的 `CONTRACTS.md` 不提前加**（T13.1 不改）。
- 现有 `W_FONT_MISSING`/`W_GLYPH_MISSING`/`W_BAD_NUMBER` 由 `layoutText` 产生，沿用 `objectId`；文本 API 不吞掉。
- `W_LAYER_ORDER` 对非法 `layerOrder` 沿用现有码（与 drawPage 一致）。
- 截断 warning 每个页面同一 code 只报一次；不按 item 刷屏。

### 8.2 错误

- 页不存在：`OFD_PAGE_NOT_FOUND`（与 `getPage` 一致）。
- 文档关闭：`OFD_CLOSED`。
- 取消：`OFD_ABORTED`。
- 页面模型/XML 加载失败：沿用 `getPageEntry`/`preparePage` 的 `OFD_ENTRY_NOT_FOUND`/`OFD_INVALID_PACKAGE`，不新增错误码。
- 单个 TextObject layout 异常：warning 后跳过该 item，不使整页失败；warning 使用 `W_UNSUPPORTED_PAINT`（现有码）或 `W_GLYPH_MISSING`，不新增 `W_TEXT_*` 异常码。
- 选项非法：按 §6.1 回退默认，不抛错（与 `getViewport` 的 DPI 回退一致）；`layerOrder` 非法按 `type` 并 warning。
- 公共 promise 只 reject `OFDError`；意外错误用 `wrapError` 包装为 `OFD_RENDERER_UNSUPPORTED`（v1 API 已有语义）。

## 9. 重构点（v1.1 已实施）

### 9.1 T4 文字布局

- **不需要改 `layoutText` 的返回结构。** `TextLayoutUnit.placements` 已含字符几何所需字段；T4 只需导出/保持 `layoutText` 纯函数。
- 新增 `src/render/text-content.ts` 内的纯 helper：

```ts
function layoutTextToChars(
  object: TextObject,
  layout: TextLayout,
  itemTransformMm: Matrix,
): TextCharMm[]
```

- 不调用 `buildTextPath`/`drawTextObject`；不取 glyph outline，避免为文字层生成路径。
- 若后续发现 `placements.length` 与 `codeCount` 的映射不足，T13.2 可加 `TextLayoutUnit.charSpans?: ...`，但必须保持 `layoutText` 现有字段/绘制行为不变。

### 9.2 T6b prepare

- **方案 A（推荐 T13.2，最小改动）**：复用 `preparePage`，新增内部可选 `PreparePageInput.loadImages?: boolean`（默认 true）；文本 API 传 `false`，避免解码图片。
  - `loadImages=false` 时 `PreparedPageBundle.images` 为空；composite block 仍构建（deferred 句柄不物化），文本遍历只读 `content/styles`，不物化图片。
  - 仍需构建 display list 是已知浪费；T13.4 若 profile 超标，再引入方案 B。
- **方案 B（性能优化，T13.3/T13.4）**：抽出 `collectPageRuntime`/`resolveTextStyles`，新增 `prepareTextPage`，只加载字体/模板/注释/样式，不构建 displayList/composite/pattern tile。
  - 必须复用 `collectBlock`/`resolvePageStyles` 的资源收集与样式结算，不得复制粘贴规则。
- **约束**：不改变 `preparePage` 现有调用方的默认行为；`PreparedPageBundle` 字段不变。

### 9.3 T6b drawPage/object

- 从 `page.ts` 抽出 `resolvePageDrawOrder`（§5.1），`drawPage` 与 `text-content` 共用；删除文本侧重复模板/图层规则。
- 从 `object.ts` 抽出/复用：
  - `normalizedBoundary`（已导出）；
  - `getPreparedStyle`（已导出）；
  - 可见性谓词（建议新增 `isDrawableText(object, style, includeInvisible)`，`drawText` 与 text collector 共用；若不改绘制，至少让文本 helper 与 `drawObject` 的 `visible/alpha/boundary/size` 判定逐条对齐）。
- `getBlockStyles`（`object.ts:120`）用于复合/注释块；文本遍历不通过 displayList 反推文字（displayList 无文字命令）。
- **依赖 T20/T21**：`ZOrder` 默认/页面 ref 优先级修复完成后，文本顺序才与设计一致；T13.2 开始前应确认 t20/t21 已合并。

### 9.4 T7 API

- `OFDPage` 构造函数增加可选文本驱动。实际实现位于第 6 个参数（`exportDriver`/`prepareDriver` 之后），保持旧三参调用可编译：

```ts
type PageTextDriver = (options: TextContentOptions) => Promise<TextContent>;

constructor(
  index,
  pageSize,
  driver,
  exportDriver?,
  prepareDriver?,
  textDriver?: PageTextDriver,
)
```

- `getTextContent(options?)`：
  - 无 `textDriver`（宿主手工构造）→ reject `OFD_RENDERER_UNSUPPORTED`；
  - 有 driver → 直接委托；不自己持有文档引用。
- `OFDDocument.getPage` 传入闭包 `textDriver = (options) => this.loadTextContent(pageIndex, options)`；内部复用 `getPageEntry`/`preparePage`/缓存。
- `OFDDocument.close` 增加 `textController.abort()`、清 `textCache/textPending`；等待 pending 不必阻塞 close（取消是异步的），但需避免未处理 rejection。
- `CacheOptions.textPages?: number`；`DEFAULT_CACHE_OPTIONS` 加 `textPages: 4`（`api/types.ts` 现有 `DEFAULT_CACHE_OPTIONS` 是 `CacheOptions`，加可选即可）。
- `src/index.ts` 导出 7 个类型 + `TextContentOptions`；不导出 `TextPageData`/internal helper。

### 9.5 单元/集成边界

- 新增 `src/render/text-content.ts`：不 import `renderer/*`、`api/*`、`container/*`、`node:*`；只 import `model/types`、`style/types`、`font/types`、`render/text`、`render/prepare` 类型、`common/matrix`。
- `src/api/document.ts` 负责 I/O/缓存/loader，不把 XML/资源逻辑搬进 `text-content.ts`。
- 更新 `test/smoke/import-boundaries.test.ts`：把 `render/text-content.ts` 纳入 PURE/RENDER 规则；文本 API 不得导入 Canvas。

## 10. 测试与黄金图口径

### 10.1 单元测试（T13.2/T13.3）

| 用例 | 断言 |
|---|---|
| 水平/垂直/180/270 阅读方向 | item/char quad 方向、advance、rect 与 `layoutText` placements 一致 |
| `CharDirection=90/180/270` | 字符 quad 旋转；item rect 仍为轴对齐外接 |
| 多 TextCode + `DeltaX/DeltaY`（含 `0 g 3 5 2`） | 字符顺序/advance/pen 与 v1 布局一致 |
| CGTransform 1:1 / 多字形 / 缺字 | `approximate`、glyphId、零几何行为 |
| HScale/字号/合成粗斜体 | advance/size 不受合成斜体影响；加粗不改 advance |
| Boundary/CTM/PhysicalBox 原点 | transform/px 原点正确；`-0` 归一 |
| 模板/页/复合/注释顺序 | `order` 与 drawPage 图层顺序一致；Foreground 模板在页 Body 之后 |
| `includeInvisible` / `includeAnnotations` | 默认排除；true 时按预期加入 |
| `includeChars=false` | `chars` undefined；text/charCount 仍正确 |
| Pattern cell/Clip text | 不出现；不因底纹 tile 重复 |
| 96/144/300 DPI | 同一 mm 缓存；px 线性缩放；页面宽高正确 |
| `close`/abort | `OFD_CLOSED`/`OFD_ABORTED`；无未处理 rejection |
| 限制 | 20k/500k 边界、截断 flags、warning 各一次 |
| 并发同键 | 只 layout 一次；一个 waiter abort 不影响另一个 |

### 10.2 黄金图/真实样本（T13.4）

- **不是像素渲染的替代**：文本层仍需 v1 黄金图；文本层用几何校验。
- 5 个代表样本（hello、文字横向-数科、chineseDir、透明度文字、发票监制章-数科）：
  - 用 `pdftotext -bbox`（poppler，已有 pdftoppm）提取 PDF 词框；与 item/char rect 中心/宽高比较；
  - 容差：中心 ≤ 2px、宽高 ≤ 3px（96 DPI）；旋转/竖排样本按 quad 中心；不比较字形 ink。
  - 允许 `W_FONT_MISSING` 的样本只比较可用字形；记录 warning。
- 57 条样本（55 基准 + manual + dense-text-perf）批量：
  - `getPage` + `getTextContent` 不崩溃；每页返回 `TextContent`；
  - `dense-text-perf` page1 8331 TextObject/15074 字符，检查 `itemCount/charCount` 与限制默认不截断；
  - 禁止把 Pattern/Clip 内文字计入（对 `pattern类型` 做断言）；
  - `manual` 缺失时 skip，不硬失败。
- 性能（T13.4，不作为 v1 P9 的替代）：
  - dense-text-perf page1 首次 `getTextContent` 目标 < 300ms（Node，96 DPI，缓存空）；
  - 同页二次 < 30ms（缓存命中）；
  - 内存增量 < 150MiB；超标记录并优化（不直接放宽）。
  - 这些是 v1.1 建议门槛，不是 v1 19.6 验收项。

### 10.3 Web/E2E（T13.5）

- `examples/web` 增加“文字层”开关：CSS/Canvas 叠加 `TextItem.rect/quad`；选择/高亮只用几何，不调用 Canvas 文字 API。
- 用 playwright-cli 打开本地 `examples/web`（file:// 或本地静态服务，按全局要求加 `--allow-file-access-from-files`），验证：
  - 打开 hello/中文/底纹/注释样本，`getTextContent` 返回非空；
  - 96/144 DPI 切换后 rect 随缩放；
  - 选择/高亮位置与视觉文字对齐（截图人工确认）；
  - 快速翻页/取消无报错；关闭浏览器。
- 不引入 CDN/新依赖；不启动长期服务。

## 11. T13.2–T13.5 拆分与验收

### T13.2 文本布局与收集内核

**范围**：`src/render/text-content-types.ts`、`src/render/text-content.ts`、`page-order.ts`（或 `page.ts` 导出）、`preparePage.loadImages?`；不改 `drawTextObject` 输出。

**验收**：
- `pnpm -C packages/ofdrw-viewer-engine run typecheck` exit 0；
- 新增文本布局/字符映射/遍历单测全过；
- v1 text/render 单测无回归；
- import 边界：无 Canvas/Node/DOM；
- 不新增公共 API（类型可先内部）。

**交付物**：实现 + 单测 + 签名变更说明。

### T13.3 公共 API 与缓存

**范围**：`OFDPage.getTextContent`、`OFDDocument.loadTextContent`、`CacheOptions.textPages`、`src/index.ts` 导出、缓存/并发/取消/限制。

**验收**：
- API 行为测试（page/close/abort/并发/limits）全过；
- 公共导出/d.ts 消费通过；
- 96/144/300 DPI 与 mm 缓存测试；
- v1 API 回归（`getPage/render/close`）全过；
- 无 v1 `CONTRACTS` 变更（v1.1 契约另开）。

### T13.4 真实样本/黄金图/性能

**范围**：`test/text-content/`、黄金图文本几何对比、57 样本回归、性能脚本。

**验收**：
- 5 代表样本 bbox 容差通过；
- 57 样本 0 崩溃；dense-text-perf 不截断（默认限制）；
- 性能门槛达标或记录优化结论；
- 全量 `pnpm test` 通过（QA 修复并发超时后）；
- 不修改 v1 黄金基线；文本几何证据单独存放。

### T13.5 Web 文字层与 v1.1 验收

**范围**：`examples/web` 文字层开关/选择高亮；playwright E2E；`docs/验收计划-v1.1.md`。

**验收**：
- Web 代表样本截图/选择对齐；
- 无 CDN、无新依赖；
- 浏览器控制台无错误；关闭浏览器；
- v1.1 独立验收清单（不含 v1 19.6 扩张）全部 pass。

## 12. 风险与待决问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| `layoutText` 的 run/字符映射非 1:1 | 连字/多字形字符 quad 只能近似 | `approximate=true`；优先保证 1:1；T13.4 用真实样本统计近似率 |
| `preparePage` 解码图片浪费 | 文本页首开慢/内存高 | T13.2 加 `loadImages=false`；T13.4 profile，必要时方案 B |
| T6b `ZOrder` 修复（T20/T21）未合并 | 文本顺序错误 | T13.2 前依赖 t20/t21；复用 `resolvePageDrawOrder`，不复制规则 |
| T6b composite cache/style bug（T6c M03） | 复合内文字样式/重复错误 | 先修 T6c M03；文本层不绕过缓存 |
| 注释/模板字体缺失 | item 为空或只部分字符 | 沿用 W_FONT_MISSING/W_GLYPH_MISSING；不静默 |
| 大量 TextObject（dense-text-perf） | 首开超时/内存 | 限制 + 缓存 + 只在需要时 chars；T13.4 profile |
| 取消粒度（layoutText 同步） | 超大单对象不能即时取消 | 在对象边界检查；记录风险，后续可给 layoutText 加可选 signal |
| Pattern/Clip 误收集 | 重复/不可见文字 | 明确不遍历 `pattern-cell`/`ClipArea.text`；测试锁定 |
| `OFDPage` 公共构造兼容 | 宿主手工构造无 text driver | 可选参数；无 driver 时 `OFD_RENDERER_UNSUPPORTED`，不破坏 v1 |
| `TextCode.text` 代理对/转义 | 字符数错误 | 统一 `Array.from` + `codePoint`，单测覆盖 |
| `includeChars=false` 与限制计数 | 计数不一致 | `charCount` 始终按文本码点计；chars 仅输出层裁剪 |

## 13. 与 v1 验收的关系

- 本文档原为 **v1.1 设计**；r9 已把 P0 文本 API 纳入公开契约，v1 的 `docs/验收计划.md`/19.6 原始清单不新增 A19 文本层，但公开 API 文档同步由 t73 完成。
- T13.2–T13.5 的实现已落 t70/t72；T7/T10 只做加法式可选扩展，不破坏 v1 既有调用与行为。
- 本轮 t73 只同步文档，未修改实现代码。

## 14. 实现状态与差异（r9，2026-10-22）

| 项 | 状态 |
|---|---|
| `OFDPage.getTextContent` | 已实现（t72 接线） |
| `render/text-content.ts` 收集内核 | 已实现（t70）：`collectTextPageMm`/`toTextPagePx`，复用 `layoutText`，不调用 Canvas 文字 API |
| px/mm | 已实现：mm 缓存、px 输出，`dpi` 不入缓存键 |
| `CacheOptions.textPages` | 已实现：默认 4，按页 LRU（t72） |
| 并发/取消/close | 已实现：同键共享构建、waiters 计数、caller abort 只影响自身、close 中止并清缓存 |
| 限制/截断 | 已实现：`maxTextItems`/`maxTextChars`，`W_TEXT_ITEM_LIMIT`/`W_TEXT_CHAR_LIMIT` |
| 类型位置 | **差异**：公开类型在 `src/api/ui-types.ts`，不在原建议的 `render/text-content-types.ts` |
| 构造函数 driver | **差异**：文本 driver 为第 6 个可选参数（在 export/prepare driver 之后） |
| Pattern/ClipArea.text | 已按设计跳过；不收集其内部文字 |
| 测试 | `test/render/text-content`、`test/api/text-content-api`、`test/text-layout` 已覆盖；具体计数见实现任务输出 |
