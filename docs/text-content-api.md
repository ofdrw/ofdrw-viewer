# 文本内容 API 设计

## 1. 定位与边界

`@ofdrw/ofdrw-viewer-engine` 的 `OFDPage.getTextContent(options?)` 返回阅读器文字层：一个页面按绘制顺序展开的 `TextContent`，以 **px** 为主坐标，内部以 **mm** 布局并按页缓存。它只读 OFD `TextObject` 和 `layoutText` 的字形放置结果，不调用 Canvas 文字 API，也不改变绘制结果。

**范围**

- `TextContent`/`TextItem`/`TextChar` 的字段语义与单位。
- 页面、模板、复合对象、注释文字的收集顺序和可见性判定。
- 坐标、字符四边形、缺字、近似字形和多方向文字的几何。
- 选项默认值、页级上限、缓存、并发、取消和关闭。
- warning、错误、可降级边界，以及当前测试口径。

**非目标**

- 不做 OCR、PDF 文本抽取或文档级全文索引；只读 OFD `TextObject`。
- 不用文本层替代渲染；绘制仍走 `layoutText` + Canvas 字形路径。
- 不收集 Pattern tile 内的文字，也不把 `ClipArea.text` 当作正文。
- 默认不收集注释/签章 Appearance 文字；显式开启后才加入。
- 不提供单独的字符级 JSON/文件导出接口；返回的 `TextContent` 可由调用方自行序列化。
- 不承诺逐字符 ink 轮廓精度；字符四边形是布局单元，不是字形墨迹包围盒。
- 不提供文档级批量抽取；宿主按页调用并自行聚合。
- 不定义 UI 的选择、高亮和查找交互；这些由 UI 消费本层的几何。

精确定义和导出名以 [engine API](../packages/ofdrw-viewer-engine/skills/API.md) 为准；本文只维护语义、默认值和边界。

## 2. 数据模型与公共类型

`TextContent` 是一页的结果；`TextItem` 对应一个 `TextObject`；`TextChar` 对应一个布局码点。几何坐标与尺寸字段单位为 px，`TextContent.unit` 固定为 `'px'`；`alpha` 为 0..1，`unit`/`layer`/`font`/`transform` 按各自类型表定义。

### 2.1 `TextContent`

| 字段 | 含义 |
|---|---|
| `pageIndex` | 页索引，从 0 开始 |
| `dpi` | 本次输出的 DPI；px 换算依据 |
| `unit` | 固定 `'px'` |
| `pageWidth` / `pageHeight` | 页面可视宽高，px；由解析后的页面尺寸换算 |
| `items` | 按绘制顺序排列的文本项 |
| `itemCount` | 实际返回的 `TextItem` 数 |
| `charCount` | 实际返回文本项的码点数之和；即使 `includeChars=false` 也统计 |
| `truncated` | `{ items: boolean; chars: boolean }`，标记触达上限的维度 |

空页返回 `items: []`、`itemCount: 0`、`charCount: 0`，不报错。

### 2.2 `TextItem`

| 字段 | 含义 |
|---|---|
| `order` | 返回结果中的绘制顺序下标，从 0 递增 |
| `objectId?` | `TextObject.id`；匿名对象省略 |
| `templateId?` | 模板文字所属模板页 ID |
| `annotationId?` | 注释文字所属注释 ID |
| `blockId?` | 所在复合块 ID；顶层文字省略（PageBlock 不写入自己的 ID） |
| `layer` | `'template' \| 'page' \| 'annotation'` |
| `layerType` | 所在图层类型：`Background`/`Body`/`Foreground`/`Custom` |
| `zOrder?` | 模板有效 ZOrder；页图层和注释省略 |
| `visible` | 对象自身是否 `visible` 且 `alpha > 0` |
| `alpha` | 对象自身 alpha，0..1；不含父组透明度 |
| `text` | 按 `TextCode` 顺序拼接的文本，过滤 CR/LF，保留普通空格和其他码点 |
| `font` | 主字体元信息；不含回退字体或字体对象 |
| `size` | 字号，px；取 `TextObject.Size` 的换算值，不做字形 ink 尺寸 |
| `transform` | 布局局部 mm → 页面 px 的 2×3 矩阵 |
| `origin` | 首个 1:1 placement 字符的 baseline；无 1:1 字符时取首字符 |
| `rect` | 所有字符 `rect` 的轴对齐并集，px |
| `quad` | `rect` 的四角，轴对齐外接四边形，px |
| `advance` | 沿阅读方向的总推进量，px，始终非负 |
| `charCount` | 本项码点数（含缺失字形） |
| `chars?` | 字符级数组；`includeChars=false` 时省略 |

`text` 与 `chars` 都不含 CR/LF；`text` 保留普通空格、制表符等未被布局过滤的码点。`chars` 与 `text` 的码点顺序一致。

### 2.3 `TextChar`

| 字段 | 含义 |
|---|---|
| `text` | 该码点的文本；辅助平面字符可能是两个 UTF-16 单元 |
| `codePoint` | Unicode 码点 |
| `glyphId?` | 实际字形 ID；1:1 placement 时存在，缺字/近似时省略 |
| `faceKey?` | 实际字体面 key；1:1 placement 时存在 |
| `fallback` | 1:1 placement 是否使用了非主字体面 |
| `origin` | 字符 baseline 起点，px |
| `advance` | 字符推进量，px；缺字为 0 |
| `rect` | 字符四边形的轴对齐包围盒，px |
| `quad` | 字符单元四边形，顺序为左上、右上、右下、左下；随 `CharDirection` 旋转 |
| `approximate` | 是否由多字形 run 的组框近似得到 |

`TextItem.quad` 与 `TextChar.quad` 不是同一类几何：后者是字符单元的四点，前者是该文本项 `rect` 的四角，因此即使字符旋转，`TextItem.quad` 仍是轴对齐包围盒。需要旋转/竖排的精确可点击区域时使用 `chars[].quad`。

`TextFontInfo` 含 `resourceId`、`family`、可选 `postscriptName`/`weightClass` 和 `italic`；它描述主字体，不列出回退字体。

## 3. 坐标与几何

### 3.1 页面坐标

```text
s = dpi / 25.4
pagePx = (pageMm - area.originMm) × s
```

- 原点为页面 `PhysicalBox` 左上角，y 向下，单位 px；允许负坐标和小数，不取整。
- `TextContent.pageWidth/pageHeight = page.size（解析后的可视尺寸，mm） × s`。
- 页面内容先平移到 `PhysicalBox` 原点：`base = T(-area.x, -area.y)`；模板页的 `Area` 不参与文本项的额外平移，模板 `Area` 只用于页尺寸回退。

### 3.2 文本项矩阵

```text
M_item_mm = T(-area.x, -area.y) × T(boundary.x, boundary.y) × ctm
transformPx = S(s) × M_item_mm
```

`boundary` 是归一化后的 `TextObject.Boundary`；`ctm` 缺省为单位矩阵。`transform` 的局部坐标仍是 mm，乘 `S(s)` 后得到页面 px，因此调用方可用 `transform` 把局部 mm 点换算成页面 px。

- **注释**：在 `base` 后再乘 `T(annotation.boundary.x, annotation.boundary.y)`，再乘文字对象的 `T(boundary) × ctm`。注释外层 Boundary 不做归一化，保持与绘制阶段一致的平移语义。
- **复合对象**：外层矩阵为 `M_parent × T(composite.boundary) × composite.ctm`；块内文字再乘自身 `T(boundary) × ctm`。
- **PageBlock**：没有自身变换，直接递归子对象，沿用当前矩阵。

### 3.3 字符四边形

对 1:1 placement 的字符：

```text
M_char = M_item_mm × T(placement.x, placement.y) × R(charDirection)
局部四点（mm，baseline 为 y=0，字形上方为负 y）：
p0 = (0,        -size)
p1 = (advance,  -size)
p2 = (advance,   0)
p3 = (0,          0)
```

- `char.origin = transform(M_item_mm, placement.x, placement.y)`。
- `char.advance = placement.advance`（mm），输出时乘 `s`。
- `char.quad = [M_char(p0), M_char(p1), M_char(p2), M_char(p3)]`，顺序固定；`char.rect` 是四点 AABB。
- `CharDirection` 只旋转字符单元，不改变阅读方向的 pen 步进；0/90/180/270 之外的运行时值按 0 处理。
- `ReadDirection` 决定 pen 步进：0 为 +X、90 为 +Y、180 为 -X、270 为 -Y；字符起点由布局 placement 给出，不由文本层重新排版。
- 合成粗体/斜体不改变 `size`、`advance` 或字符单元尺寸；文本层只提供布局几何。

缺失字形（没有 placement）：

- `glyphId`/`faceKey` 省略，`advance=0`。
- `rect` 宽高为 0，`quad` 四点为 `origin`，`approximate=false`，`fallback=false`。
- 字符仍保留在 `chars` 和 `text` 中，`charCount` 仍计数。

多字形/连字 run（placement 数与码点数不一致）：

- 每个码点使用 run 首 placement 到 run 末推进的组框，`approximate=true`。
- `glyphId`/`faceKey` 省略；`advance` 为组框推进量；`fallback=false`（当前实现不追踪近似 run 的字体面）。
- 字符仍逐个返回，用于选择/高亮，但几何是近似值。

### 3.4 文本项几何

- `origin`：第一个 1:1 placement（有 `glyphId`）字符的 baseline；没有 1:1 字符时取第一个字符起点；没有字符时取 `M_item_mm` 的原点。
- `rect`：所有 `chars[].rect` 的并集；没有字符时为 `{ x: origin.x, y: origin.y - size, width: 0, height: size }` 的退化框，不是零高框。
- `quad`：`rect` 的四个角，轴对齐；不是旋转凸包。
- `advance`：从首个 layout unit 的起点到布局末端 `endX/endY` 的欧氏距离，输出 px；不是字符 advance 的简单求和。
- `size`：`TextObject.Size` 的 mm→px 换算；不是实际字形墨迹高度。

## 4. 遍历、可见性与排除

### 4.1 与绘制共用的顺序

文本层复用 `resolvePageDrawOrder`，与 `drawPage` 使用同一图层展开规则：

- **`type` 模式**（默认）：按 `Background → Body → Foreground → Custom` 分组。每组先遍历模板：模板有效 ZOrder 等于当前组时，按模板自身图层类型顺序遍历该模板的**全部图层**，再遍历同类型的页图层。模板有效 ZOrder 取页面 `TemplateRef.zOrder`，缺省为 `Background`。`Custom` 组没有模板项，只有页图层。
- **`document` 模式**：先按页面引用顺序遍历所有模板（每个模板按自身 XML 图层顺序），再按 XML 顺序遍历页图层。
- **注释**：在页面图层之后，按 `annotationBlocks` 顺序；只有 `includeAnnotations=true` 才加入。
- 页图层内的 `PageBlock` 递归子对象；`CompositeObject` 通过 `PreparedPageBundle.blocks` 递归块内容；复合对象只按引用次数遍历，同一资源被引用两次会产生两组 item，不按 `objectId` 去重。

`layer`/`templateId`/`zOrder`/`annotationId` 由遍历上下文填写；复合块内文字继承引用它的外层 `layer/layerType/templateId/zOrder`，`blockId` 记录最近一层 CompositeObject 的块 ID；PageBlock 只递归，不产生或覆盖 `blockId`。

### 4.2 可见对象判定

文字对象必须同时满足：

```text
style 存在
且 (includeInvisible || (object.visible && object.alpha > 0))
且 normalizedBoundary.w > 0 && normalizedBoundary.h > 0
且 (style.fill || style.stroke)
且 object.size > 0
```

- `includeInvisible=true` 只放宽 `visible/alpha`；无样式、零 Boundary、无填充/描边、零字号仍然跳过。
- `TextItem.visible = object.visible && object.alpha > 0`；`alpha = object.alpha / 255`。
- 父复合块的 alpha 不乘入子项 `alpha`；父对象不可见或 alpha=0 时，默认整块跳过，因此不会产生子项。
- `includeInvisible=true` 时父对象仍按自己的可见性/alpha 进入递归；子项仍只记录自身 alpha，宿主需要结合父级信息时应从 `blockId` 和图层结构推断，当前结果不提供父组透明度。

### 4.3 排除规则

- **Pattern**：`prepared.blocks` 中 `source='pattern-cell'` 的块不遍历；底纹 tile 是 Paint，不是页面文字。
- **ClipArea.text**：不遍历。它只是裁剪轮廓，不是内容；即使文字对象只被 Clip 引用，也不产生文本项。
- **注释**：默认不遍历 `annotationBlocks`；`includeAnnotations=true` 时在最后加入，`layer='annotation'`、`layerType` 当前固定为 `'Body'`、`annotationId` 为注释块 ID。
- **不可见对象**：默认跳过 `visible=false` 或 `alpha=0` 的文字；`includeInvisible=true` 保留并给出 `visible=false`。
- **非文字对象**：路径、图片、复合对象本身不产生 `TextItem`，只递归其中文字。

### 4.4 深度与异常对象

- `PageBlock` 和 `CompositeObject` 的递归深度上限为 16；超深时上报 `W_COMPOSITE_DEPTH` 并跳过该分支。
- 复合资源缺少独立块时，跳过该分支并上报 `W_COMPOSITE_DEPTH`；复合块缺少块样式时，跳过该分支并上报 `W_UNSUPPORTED_PAINT`。
- 文字对象缺少结算样式时上报 `W_UNSUPPORTED_PAINT` 并跳过。
- 字体资源未加载时上报 `W_FONT_MISSING` 并跳过该文字项；缺字形仍在项内保留，只产生零几何字符。
- 遍历在每个图层项和每个对象前检查 `signal`；取消后整页构建以 `OFD_ABORTED` 拒绝，不返回部分结果。

## 5. 选项、默认值与限制

`TextContentOptions` 的精确签名见 [engine API](../packages/ofdrw-viewer-engine/skills/API.md)。当前默认值：

| 选项 | 默认 | 语义 |
|---|---|---|
| `dpi` | 96 | 输出换算 DPI；非有限或 `<=0` 回退 96，不设上限 |
| `includeChars` | `true` | 是否返回 `chars`；`false` 时 `text`/`charCount` 仍返回 |
| `includeAnnotations` | `false` | 是否加入注释 Appearance 文字 |
| `includeInvisible` | `false` | 是否加入 `visible=false` 或 `alpha=0` 的文字 |
| `layerOrder` | 打开文档时的值（默认 `type`） | `type`/`document`；运行时非法值按 `type` 并上报 `W_LAYER_ORDER` |
| `signal` | 无 | 取消本次等待；以 `OFD_ABORTED` 拒绝 |
| `maxTextItems` | 20,000 | 非负整数；`0` 表示不限 |
| `maxTextChars` | 500,000 | 非负整数；`0` 表示不限 |

限制是**页级**，不是文档级。宿主需要对多页聚合时逐页调用并自行汇总。

### 5.1 上限语义

- 每个 `TextObject` 的全部布局码点计入 `charCount`；CR/LF 在计数前已被过滤。
- 尝试加入下一个文本项时，如果 `items.length >= maxTextItems`：停止遍历，`truncated.items=true`，上报 `W_TEXT_ITEM_LIMIT`。如果刚好达到上限而没有下一项，不标记截断。
- 尝试加入下一个文本项时，如果 `charCount + 该项码点数 > maxTextChars`：**整项不加入**，停止遍历，`truncated.chars=true`，上报 `W_TEXT_CHAR_LIMIT`。不会返回半个 item，也不会只截断该 item 的 chars。
- `maxTextItems`/`maxTextChars` 的非法值（负数、非整数、`NaN`）回退默认；`0` 表示不限。
- `truncated` 是结果标记，不是异常；达到上限不抛错。同一项同时触达两个上限时，当前实现先检查字符上限，`truncated.chars` 优先。
- `includeChars=false` 只省略 `chars` 输出，不改变 `text`、`charCount`、上限计数或几何；字符几何仍参与 item 的 origin/rect/advance 计算。

## 6. 缓存、并发与取消

### 6.1 两级缓存

**页面级缓存**：复用文档的页面模型/资源缓存（`CacheOptions.pageModels`，默认 8 页）。文本构建通过 `getPageEntry` 读取页模型、模板和资源作用域，不重复解析 XML。

**文本 mm 缓存**：`OFDDocument` 私有 `textCache` 保存 `TextPageMm`，按页和配置 LRU：

- 键：`pageIndex`、`layerOrder`、`includeChars`、`includeAnnotations`、`includeInvisible`、`maxTextItems`、`maxTextChars`。
- 不含 `dpi`：同一页不同 DPI 复用同一份 mm 布局，命中后只做 px 换算。
- `CacheOptions.textPages` 默认 4；非有限值回退 4，负值按 0，小数向下取整。内部 LRU 的 `0` 表示**不限制条目数**，不是关闭缓存；需要限制内存的调用方应设置正数。
- 淘汰只丢 mm 数据，不关闭字体/图片；`close()` 清空文本缓存和 pending。

文本构建需要整页准备：若 `preparedBundles` 已有 96 DPI 的 bundle 则复用，否则调用整页 `preparePage`（当前没有“只布局、不解码图片”的选项）。因此首次文本读取可能包含图片准备成本；这是当前实现边界，不是文本层额外解码。

### 6.2 并发

- 同一缓存键的并发 `getTextContent` 共享一个构建 Promise；每个调用方各自等待，不重复 layout。
- 每个构建维护 `waiters` 计数。单个调用方 `signal` 中止时，只让该调用方以 `OFD_ABORTED` 拒绝，不影响其他 waiter。
- 最后一个 waiter 离开且构建尚未完成时，内部 controller 被中止，构建停止并删除 pending；后续调用重新开始。
- 页面准备有独立的 `preparePending` 去重，但文本构建不读取该 pending；同一页同时 `page.prepare()` 与 `getTextContent()` 时，可能各自执行一次准备。两者写入的缓存不同，不会互相污染。
- 共享构建的 warning 由文档 `WarningCollector` 按 `(code, pageIndex, objectId)` 去重；文本层自身对每个上限 warning 另有一次性标记。

### 6.3 取消与关闭

- 入口先检查文档是否关闭，再检查预取消 signal；文档已关闭且 signal 已中止时以 `OFD_CLOSED` 优先。
- 构建在 `getPageEntry` 之后、`preparePage` 之后、收集完成之后检查内部 signal；收集过程中每个图层项、每个对象、每个块递归前检查。
- `layoutText` 是同步纯函数，内部没有取消点；单个超大 `TextObject` 只能等其布局完成后再检查取消。这是当前取消粒度边界。
- `close()` 设置关闭标志、中止共享构建并清空 `textCache`/`textPending`；等待中的调用以 `OFD_CLOSED` 拒绝，不再写入缓存。
- 缓存命中路径仍会检查入口的关闭/预取消状态，但在完成检查后直接做 px 转换；关闭发生在转换期间不会产生新缓存。

## 7. 警告、错误与降级

### 7.1 warning

文本路径沿用文档 `onWarning`，warning 不中断整页：

| code | 触发 | 上下文 |
|---|---|---|
| `W_TEXT_ITEM_LIMIT` | 尝试加入下一项时达到 `maxTextItems` | `pageIndex`、可选 `objectId` |
| `W_TEXT_CHAR_LIMIT` | 下一项会使字符数超过 `maxTextChars` | `pageIndex`、可选 `objectId` |
| `W_FONT_MISSING` | 文字对象的字体资源未加载，整项跳过 | `pageIndex`、`objectId` |
| `W_GLYPH_MISSING` | 字体缺少某字形，字符保留但几何为零 | `pageIndex`、`objectId` |
| `W_BAD_NUMBER` | 字号/方向/Delta/CGTransform 等数值非法，使用回退 | `pageIndex`、`objectId` |
| `W_LAYER_ORDER` | 运行时 `layerOrder` 非法，按 `type` | `pageIndex` |
| `W_COMPOSITE_DEPTH` | 块递归超深或复合资源缺少独立块 | `pageIndex`、`objectId` |
| `W_UNSUPPORTED_PAINT` | 文字/复合块缺少结算样式 | `pageIndex`、`objectId` |

`W_TEXT_ITEM_LIMIT`/`W_TEXT_CHAR_LIMIT` 当前通过 `onWarning` 以字符串码上报，但未列入 `WarningCode`/`WARNING_CODES` 联合；调用方按 `OFDWarning.code` 的字符串分支处理即可。这是类型注册边界，不是 warning 未发出。

### 7.2 错误

| 场景 | 结果 |
|---|---|
| 页索引非法 | `OFD_PAGE_NOT_FOUND` |
| 文档已关闭 | `OFD_CLOSED` |
| 调用方取消/最后一个 waiter 中止 | `OFD_ABORTED` |
| 手工构造的 `OFDPage` 没有文本驱动 | `OFD_RENDERER_UNSUPPORTED` |
| 页面模型/XML/资源读取失败 | 沿用 `OFD_ENTRY_NOT_FOUND`/`OFD_INVALID_PACKAGE` 等页面加载错误 |
| warning 条件 | 不抛错，按上表降级 |

文本层不新增 `OFD_TEXT_*` 错误码。上限、缺字体、缺字形、近似 run 都是结果降级，不是异常。

### 7.3 降级边界

- 缺字形：保留字符项和 `text`，`advance=0`，四点为起点；选择/高亮时表现为零宽字符。
- 多字形 run：每个字符共享组框，`approximate=true`；不承诺逐字符墨迹位置。
- 缺字体：整项跳过并上报 `W_FONT_MISSING`，不会输出无字体项。
- 超限：整项停止，不返回半个 item；`truncated` 告诉调用方哪个维度触达上限。
- 单个对象的 `layoutText` 异常没有被收集层额外捕获；正常输入下 `layoutText` 用 warning/默认值处理非法数值，非预期异常会使整页构建拒绝，而不是静默跳过。该边界适合作为实现侧健壮性检查项。
- 文本几何不受合成粗体/斜体影响；需要视觉墨迹范围时不能直接用 `TextChar.quad` 代替字形轮廓。

## 8. 验证方式

当前测试入口：

```bash
pnpm -C packages/ofdrw-viewer-engine test
pnpm test                         # 根目录脚本，等价于包内全量测试
pnpm -C packages/ofdrw-viewer-engine typecheck
```

文本层断言分布在：

- `packages/ofdrw-viewer-engine/test/text-content/collect.test.ts`：坐标/DPI、字符映射、阅读/字符方向、缺字、近似 run、可见性、模板/页/复合/注释顺序、Pattern/Clip 排除、上限与 warning。
- `packages/ofdrw-viewer-engine/test/api/text-content-api.test.ts`：接线、默认值、mm 缓存与 DPI 换算、同键并发、`includeChars`/`includeInvisible`、上限、取消、关闭、手工页面错误。
- `packages/ofdrw-viewer-engine/test/acceptance/ui-api.acceptance.test.ts`：文本几何/DPI/取消/关闭，以及 1000 页文档只读取目标页 `Content.xml` 的按需加载断言。

当前没有专门的文本层 bbox/黄金图测试：`test/golden` 验证渲染像素，`test/performance/text-perf.test.ts` 验证 dense-text 样本的渲染耗时和内存，不是 `getTextContent` 的几何或性能门禁。渲染黄金图入口为 `pnpm -C packages/ofdrw-viewer-engine test:golden`，其结果不能替代文本几何断言。文本层验证以几何单测和 API 行为测试为主；测试矩阵、黄金图口径和批量回归入口由 [测试方案](./测试方案.md) 维护，本文不复制。
