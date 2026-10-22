# OFD 渲染引擎设计方案

> 版本：0.5（设计稿，按 pdf.js 形态 + Monorepo 子包 + Renderer 扩展点 + 纯页面内容调整）  
> 日期：2026-10-22  
> 技术栈：TypeScript + Canvas 2D + fontkit  
> 仓库：Monorepo，当前唯一子包 `ofdrw-viewer-engine`  
> 范围：只做“把 OFD 页面画到 Canvas”的 engine 库，不含阅读器 UI、任何端实现（Web/Node/Electron/小程序宿主）、编辑、签章密码学验证；v1 包含注释/签章外观的静态渲染

---

## 0. 结论摘要

> 0.5 变更：v1 增加 `Seal.esl`/`SignedValue.dat` 静态签章解析（ASN.1 v1/v4/v5 结构推断、位图与内嵌矢量 OFD 章）、签章位图 multiply、标准/manual 图片 Clips 顺序、GIF 首帧解码；P9 `dense-text-perf` 按极端样本例外计时。
> 0.4 变更：采用 Monorepo 子包 `ofdrw-viewer-engine`；`Renderer` 改为 `beginGroup/endGroup`，H5 的 `CanvasFactory`/scratch 完全内部化，公开 API 不再有 `RenderSurface`；`fallbackFonts` 更名为 `supplementaryFonts`；删除 engine 级独立块栅格缓存，改为复用 display list。

1. **引擎做成一个独立、平台无关的 TypeScript 库**：以 Monorepo 子包 `ofdrw-viewer-engine` 交付；公开 API 按 pdf.js 形态收敛为 `open → getPage → page.getViewport/page.render → close`；核心只定义 `ByteSource`、Canvas、图片解码器、字体来源等接口，`Renderer` 作为正式扩展点但默认实现由 engine 提供，**v1 不实现任何端适配器**。
2. **ZIP 不做整体解压**。打开时只读 `OFD.xml`、`Document.xml` 和页树；渲染某页时才按中央目录定位并解压该页的 `Content.xml`、`PageRes.xml`、模板页、字体和图片。天然支持 HTTP Range、`Blob.slice`、Node 文件句柄和微信文件系统。
3. **文字绝不走 Canvas 文本 API**。统一走 `字体文件 → fontkit 解析 → 字形轮廓 → 路径 → fill/stroke`，因此不会受系统字体缺失、Canvas `fillText` 差异、小程序字体加载限制影响。
4. **渲染分为“异步准备”和“同步绘制”两段**：先把该页需要的字体、图片、资源 XML 全部解析/解码完，再在一个同步循环里按文档顺序绘制，避免画到一半 `await` 导致 Canvas 状态被外部改写。
5. **v1 的保真度分档**：基础路径/文字/图片、纯色、轴向渐变、路径裁剪、复合对象、模板页、页资源、**注释/签章外观**、**Gouraud/网格渐变**、**JBIG2/TIFF**、**Pattern 底纹** 为必做；**径向渐变 v1 不做**，识别到就 warning + 降级（平均色/透明），算法设计保留给 v2；重复/反射渐变、图像蒙版、边框、文字裁剪、合成粗斜体为次优先；ICC、BlendMode、加密文档、签名密码学验证不在 v1。
6. **最大风险不是解析，而是字体补充**：样例统计中约 35% 的文字对象没有内嵌字体，而浏览器/小程序无法直接读取操作系统字体轮廓。已确认方向：引擎不内置 CJK 字体，通过 `FontProvider` 或 `supplementaryFonts` 由宿主补充；包体积和授权压力留在宿主侧。
7. **标准与实现存在若干冲突**（Alpha 默认值、MiterLimit 默认值、层顺序、负尺寸 Boundary、缺失 CTM 的图片等）。本方案在“标准优先、兼容真实文件”的原则下逐项给出明确口径；仍未定的只剩宿主字体清单、径向渐变 v2 时间和 TIFF 真实样本。
8. **注释、复合对象、底纹共用“独立空间块”**：先在块内坐标记录显示列表，再整体映射回页面；同一红章/水印的显示列表可跨位置、跨页复用，group 合成由 renderer 内部处理。不要把注释外观写成单独的绘制循环。
9. **绘制参数先结算、再绘制**：`DrawParam` 的 `Relative` 链、图层/对象/容器嵌套和优先级在准备阶段全部合并成 `ResolvedStyle`，绘制阶段只读最终值；同时用 `Renderer` 隔离 Canvas，渲染器可替换，**surface/scratch 不进入公开 API**。

---

## 1. 目标、范围与原则

### 1.1 目标

- 输入一个 OFD 文件（本地文件、`ArrayBuffer`、`Blob`、URL、Node 路径、微信临时文件），能够：
  - 打开文档，得到页数；
  - 取页对象，查询物理尺寸（毫米）和指定 dpi 的 viewport（像素）；
  - 把页渲染到调用方提供的 Canvas 2D 上下文；
  - 关闭文档并释放缓存、字体、图片、解压数据。
- 同一套核心代码**不依赖具体端**：核心渲染/解析/API 不引用 `window`/`document`/`fetch`/`Blob`；H5 的默认 `createCanvas` 是唯一平台便利（且仅在 `globalThis.document` 存在时启用），其余由宿主注入。v1 只交付 engine 库，不交付宿主应用。
- 渲染结果可导出为图片（引擎只负责画到 Canvas，导出由宿主 `toDataURL`/`toBlob` 完成），作为阅读器的基线能力。
- 对真实 OFD 的坏数据有容忍度：单个对象失败只跳过该对象并 warning，不导致整页白屏。

### 1.2 非目标（v1 明确不做）

- OFD 编辑、保存、格式转换；
- 数字签名/电子签章的密码学验证；
- 注释编辑、批注回复、表单、动作（Action）的交互；注释/签章外观的**静态渲染**进入 v1；
- 全文检索、文字选择、无障碍文本层；
- PDF 导出；
- 完整 ICC 色彩管理；
- 服务端渲染集群/分布式缓存；
- 阅读器 UI（工具栏、缩略图、书签面板）；
- 阅读器控制参数（缩放、旋转、背景、打印筛选、`NoZoom`/`NoRotate` 语义）；
- Web/Node/Electron/Tauri/小程序的具体宿主适配器与打包产物；
- 端到端的文件选择、下载、缩放交互。

> 电子签章/红章通常不在页面 `Content.xml` 里，而是在 `Annotations`/`Signatures` 中。v1 必须做注释外观渲染；签名值、证书链、时间戳的密码学验证仍不在范围内。

### 1.3 设计原则

1. **正确性优先于覆盖率**：不支持的绘制特性宁可 warning + 降级，也不静默画错。
2. **按需加载**：不整包解压、不预解析所有页、不预加载所有字体。
3. **核心平台无关**：核心层不出现 DOM、Node、微信 API；平台差异全部收口到适配器。
4. **一个公开类**：对外只暴露 `OFDDocument` 和少量类型，内部模块不进入公共 API，避免把实现细节变成兼容负担。
5. **同步绘制**：资源准备完成后，页面绘制过程不 `await`，保证 Canvas 状态可控、可取消。
6. **不做过度封装**：不为每个 XML 节点建类，不为每个平台建一套渲染器；用扁平的数据模型 + 少量渲染函数。

---

## 2. OFD 渲染模型速览

### 2.1 三层结构

| 层 | 内容 | 渲染引擎关注点 |
|---|---|---|
| 容器层 | ZIP + `OFD.xml` | 入口文档、`DocBody`、`DocRoot` |
| 文档层 | `Document.xml` | 页面区域、公共资源、文档资源、模板页、页树 |
| 页面描述层 | `Pages/Page_N/Content.xml`、`PageRes.xml` | 图层、图元、绘制参数、裁剪、资源引用 |

一个 OFD 包可以有多个 `DocBody`，每个 `DocBody` 指向一个 `Document.xml`。引擎默认打开第 0 个带 `DocRoot` 的文档；`documentIndex` 按“带 `DocRoot` 的 DocBody”顺序计数，跳过没有 `DocRoot` 的版本/签名条目。

### 2.2 页树与资源

- `Document.xml/Pages` 是页树，`Page` 是叶子；按**前序遍历**展开得到线性页数组，页码从 0 开始。
- 页对象包含：
  - `Area/PhysicalBox`：页面物理尺寸（毫米）；
  - `Template`：模板页引用 + `ZOrder`；
  - `PageRes`：页资源文件；
  - `Content/Layer`：图层，图层内是 `PageBlock`/`TextObject`/`PathObject`/`ImageObject`/`CompositeObject`。
- 资源分三级作用域：
  - 公共资源 `PublicRes`（文档级）；
  - 文档资源 `DocumentRes`（文档级）；
  - 页资源 `PageRes`（页级，含模板页自己的 `PageRes`）。
- 资源 ID 在文档内唯一；真实文件偶有重复，按“页级覆盖文档级”处理并 warning。

### 2.3 坐标、Boundary 与 CTM

OFD 页面空间：左上角为原点，X 向右，Y 向下，单位毫米。Canvas 设备空间同样是左上角为原点、X 向右、Y 向下，两者方向一致，因此页面到设备只包含平移和等比缩放，**没有 Y 翻转**。

矩阵约定：本文一律使用 Canvas 的列向量约定，`A × B` 表示先应用 `B`、再应用 `A`（与 Canvas 的后乘顺序一致）。标准 8.1.5 采用行向量右乘，写法方向与本文相反，不能照抄标准中的乘法顺序；但 `CTM` 的 6 元组数值与 Canvas `transform(a,b,c,d,e,f)` 同序，可以直接传入。

对每个图元：

```
设备坐标 = 页面到设备变换 × translate(Boundary.x, Boundary.y) × CTM
```

- `Boundary` 是图元在**当前空间**（页面空间或父容器空间）的外接矩形，同时是裁剪矩形。
- `CTM` 是图元对象空间内的变换矩阵，格式 `a b c d e f`，与 Canvas `transform(a,b,c,d,e,f)` 同序。
- `Boundary` 的平移在 `CTM` **之前**；`CTM` 只作用于图元数据（路径点、文字、图像单位矩形），不作用于 `Boundary` 本身。`Clips` 也位于对象空间，在 `CTM` **之前**应用，不乘图元 `CTM`（见 10.4.1）。
- 页面到设备变换：

```
M_page = S(dpi / 25.4) × T(-PhysicalBox.x, -PhysicalBox.y)
       = [s, 0, 0, s, -s·PhysicalBox.x, -s·PhysicalBox.y]    // s = dpi / 25.4
```

其中 `dpi` 是输出精度，默认 96 DPI（1 mm = 96/25.4 px ≈ 3.7795 px）；`dpi=144/300` 即更高精度。**没有 scale、pixelRatio、rotation**——这些是阅读器控制参数，不属于 engine。

`PhysicalBox` 的 `x/y` 按标准规范应为 0（表 7：物理盒左上角即页面空间原点）；保留平移项只为兼容少数把内容坐标写成绝对坐标的文件，非零时按“绝对坐标”解读并 warning（见 10.5）。

Canvas 上的实现顺序：

```ts
ctx.setTransform(identity);
ctx.scale(s, s);                                // 先缩放
ctx.translate(-physicalBox.x, -physicalBox.y);  // 再平移；顺序不能反
ctx.translate(boundary.x, boundary.y);          // 对象原点
// 在对象空间裁剪 Boundary
ctx.beginPath();
ctx.rect(0, 0, boundary.w, boundary.h);
ctx.clip();
applyClips(...);                                // Clips 也在 CTM 之前
ctx.transform(ctm);                             // 再应用 CTM
// 绘制图元数据
```

> `setTransform(identity); scale(s, s); translate(-x, -y)` 等价于 `setTransform(s, 0, 0, s, -s·x, -s·y)`。不要写成先 `translate(-x, -y)` 再 `scale(s, s)`，否则平移量不会被缩放，`PhysicalBox` 非零时会整体偏位。

> 注意：不能先 `transform(ctm)` 再裁 `rect(0,0,w,h)`，否则裁剪矩形会被 CTM 变换，语义就错了。

### 2.4 绘制参数：先结算，再绘制

绘制参数不是“画到某个对象时再临时查一下”，而是**在绘制阶段之前完成结算**。原因：

- `DrawParam` 可以 `Relative` 链式引用；
- 页面图层、模板图层、`PageBlock`、复合对象、底纹单元、注释外观都可能形成嵌套作用域；
- 对象内联属性、对象子元素颜色、`DrawParam` 颜色之间有优先级；
- 同一个 `DrawParam` 会被大量对象复用，必须只解析一次；
- 绘制阶段如果还去查资源/解析继承，会让 Canvas 状态和错误处理不可控。

#### 2.4.1 作用域与优先级

从低到高：

```
1. 内置默认值（按对象类型：Path/Text/Image）
2. 继承样式（父作用域：图层 / 父 PageBlock / 外层 CompositeObject / 注释/底纹块的 styleRoot）
3. 对象自己的 DrawParam 链（Relative 由远到近，近者覆盖远者）
4. 对象内联属性（LineWidth/Cap/Join/MiterLimit/DashOffset/DashPattern）
5. 对象子元素 FillColor/StrokeColor（复杂 Paint 也算）
6. 对象自身的 Fill/Stroke 开关（只决定“画不画”，不从父作用域继承）
```

说明：

- `DrawParam` 只包含 `Join`、`LineWidth`、`DashOffset`、`DashPattern`、`Cap`、`MiterLimit`、`FillColor`、`StrokeColor`、`Relative`；**不包含** `Fill`/`Stroke`/`Alpha`/`Rule`/`Font`/`Size`/`HScale`/`ReadDirection`/`CharDirection`/`Weight`/`Italic`。
- `Fill`/`Stroke` 是对象级开关：对象没写时按对象类型取默认（路径 `Stroke=true, Fill=false`；文字 `Fill=true, Stroke=false`），**不继承父对象**。
- `Alpha`/`Visible` 也是对象级：`Alpha` 不通过 `DrawParam` 继承；父容器/复合对象的 alpha 在合成阶段相乘。
- 对象内联属性覆盖 `DrawParam`；对象子元素颜色覆盖 `DrawParam` 的 `FillColor/StrokeColor`。
- `DrawParam.Relative` 缺失的属性继续向“继承样式”回退，而不是直接回内置默认值。

#### 2.4.2 结算算法

```ts
// common/types.ts：渲染器/样式层共享，不含 OFD 语义
interface DrawStyle {
  lineWidth: number;                 // mm
  cap: 'Butt' | 'Round' | 'Square';
  join: 'Miter' | 'Round' | 'Bevel';
  miterLimit: number;
  dashOffset: number;
  dashPattern: readonly number[];
  fill: boolean;                     // 对象级开关，已结算
  stroke: boolean;
}

interface ResolvedStyle extends DrawStyle {
  fillPaint: PaintSpec;              // 纯色/渐变/底纹/网格描述，不含渲染器句柄
  strokePaint: PaintSpec;
}

// 与 8.2 的 Paint 同构；在样式层只做规范化，不创建 CanvasGradient/Pattern
type PaintSpec = Paint;

function flattenDrawParam(id: ResourceId): Partial<ResolvedStyle> {
  // 1. 沿 Relative 找到链尾，再反向合并；近者覆盖远者
  // 2. 环检测：visited 集合；发现环 -> warning，截断
  // 3. 结果按 id 缓存；只包含本链实际出现的字段
}

function resolveStyle(obj: GraphicUnitBase, inherited: ResolvedStyle): ResolvedStyle {
  const base = defaultsFor(obj.kind);          // 内置默认
  const parent = inherited;                    // 父作用域
  const dp = obj.drawParam ? flattenDrawParam(obj.drawParam) : {};
  const inline = pickInline(obj);              // LineWidth/Cap/Join/MiterLimit/DashOffset/DashPattern
  const childPaint = pickChildPaint(obj);      // FillColor/StrokeColor
  const style = merge(base, parent, dp, inline, childPaint);
  style.fill = obj.fill ?? defaultsFor(obj.kind).fill;
  style.stroke = obj.stroke ?? defaultsFor(obj.kind).stroke;
  return freeze(style);
}
```

- `flattenDrawParam` 与继承上下文无关，按 `id` 缓存；同一 `DrawParam` 被 1000 个对象引用只展开一次。
- `resolveStyle` 对每个可绘制对象调用一次，结果放进 `PreparedPage.styles`；绘制阶段只读 `ResolvedStyle`，不再查 `DrawParam`/`Relative`/颜色资源。
- `DrawParam` 依赖图：节点是 `DrawParam`，边是 `Relative`；先拓扑排序/DFS，环直接 warning + 断开。对象继承树不是图，不需要拓扑排序。
- 结算失败（缺资源、环、非法数值）：该字段回退到继承值/默认值，warning；不因一个样式失败阻塞整页。
- 结算结果不可变（`Object.freeze` 仅开发期；生产可不冻结以避免成本），渲染器不得修改。

#### 2.4.3 嵌套作用域

| 容器 | 传给子对象的 `inherited` |
|---|---|
| 页面图层 `Layer` | 该图层自己的 `DrawParam` 结算结果 |
| 模板页图层 | 该模板图层的 `DrawParam` 结算结果 |
| `PageBlock` | 父级 `inherited`（PageBlock 自身没有 DrawParam） |
| `CompositeObject` | 外层 `inherited` + 复合对象自己的 `DrawParam`/内联属性结算结果 |
| 注释 `Appearance` | 文档默认值 + 注释外观自身 `DrawParam`（不继承页面对象） |
| `Pattern.CellContent` | 文档默认值 + CellContent 自身 `DrawParam`（不继承填充目标对象） |

> 这是已确认口径：**Composite 继承外层对象；Annotation/Pattern 用文档默认值 + 自身 DrawParam**。好处是同一红章/底纹跨页、跨位置复用时不会被页面对象样式污染；代价是作者不能靠“外层文字颜色”给 Pattern 单元染色，必须在 CellContent 内写清楚。

#### 2.4.4 缓存

- `flattenDrawParam(id)`：按资源 ID 缓存，缓存的是“只含实际字段”的 partial。
- `resolveStyle(obj)`：按对象实例缓存；页面模型重建时失效。
- `ResolvedStyle` 的 key 不参与图片/字体缓存；它只影响绘制命令。
- 同一 `DrawParam` 的 `Relative` 链在打开文档后不变；资源作用域覆盖只影响 ID 查找，不影响已展开结果。

### 2.5 图元类型

| 图元 | 关键字段 | 绘制要点 |
|---|---|---|
| `PathObject` | `AbbreviatedData`、`Fill`/`Stroke`、`Rule` | 路径命令解析、圆弧转贝塞尔、填充/描边 |
| `TextObject` | `Font`、`Size`、`TextCode`、`CGTransform`、`HScale`、方向 | 字形轮廓、字距、方向、粗斜体 |
| `ImageObject` | `ResourceID`、`Substitution`、`ImageMask`、`Border` | 单位正方形 + CTM、边框、蒙版 |
| `CompositeObject` | `ResourceID`、`Boundary`、`CTM` | 引用矢量图资源，递归绘制内容 |
| `PageBlock` | 子对象列表 | 仅分组，无自身变换；按文档顺序递归 |

### 2.6 引擎与阅读器的边界

引擎负责：

- 解析页面描述、资源、字体、图片；
- 计算变换、裁剪、绘制参数；
- 画到 Canvas；
- 报告 warning/error；
- 缓存与释放。

阅读器负责：

- 文件选择、下载、拖拽；
- 视图缩放/滚动/翻页/旋转 UI；
- 页面 Canvas 的布局与销毁；
- 缩略图调度、预渲染下一页；
- 导出图片、打印；
- 注释/签章 UI 与验证。

---

## 3. 标准歧义与实现口径

这一节是后续编码和测试的“裁决表”。遇到真实文件与标准冲突时，以本表为准；表未覆盖的，按“标准语义 + warning”处理。

| 问题 | 标准/现实 | 采用口径 |
|---|---|---|
| `Alpha` 默认值 | 表 26 写 0，XSD 写 255 | 缺失按 255；显式 0 按全透明 |
| `MiterLimit` 默认值 | 表 21 写 3.528，XSD 写 4.234 | 缺失按 4.234 |
| 图层顺序 | 标准图 16：每种类型都是“该类型模板在下、该类型页图层在上”，类型从 Background→Body→Foreground；业务也要求先按图层类型排序 | 按图 16 分组：Background 模板→Background 层→Body 模板→Body 层→Foreground 模板→Foreground 层→Custom 层；同组模板按引用顺序、页图层按 XML 顺序，后出现覆盖前面。`layerOrder` 默认 `type`，可切 `document` 严格模式 |
| 页尺寸回退 | 页 `Area` → 模板页 `Area` → `CommonData/PageArea` | 页 `Area` 优先；否则按 `Template` 引用顺序取第一个带 `Area` 的模板；再缺用 `CommonData`；最后 A4（210×297），并 warning |
| `LineWidth=0` | 标准要求画 1 像素；设备相关 | 作为 hairline：设备空间 1px；无法保证时按 0.01mm 近似，并记录偏差 |
| `Boundary` 零/负尺寸 | 标准要求正数；真实文件出现零尺寸和负高度 | 零宽/零高直接跳过该对象（无可见内容），warning；负尺寸归一化为正矩形（x/y 取最小角），归一化后仍为零则跳过 |
| 图片缺失 `CTM` | 标准上 CTM 可省，省则 identity，图片单位正方形只有 1×1 | 默认严格 identity（1×1）；如业务文件确实依赖铺满，可显式设 `strictImageCtm=false` 兼容；缺失时 warning |
| `DeltaX/DeltaY` 缺失/为 0/数量不足/含压缩组 | 标准要求数值队列；真实文件常见 `g 3 3.1305` 这类压缩组（如 `"g 3 3.1305"`），也可能数量不匹配 | 先展开 `g <count> <value>` 组；逐字符 pen；有合法值用合法值；显式 0 尊重 0；没有则用字体 advance × Size/upem × HScale；无法展开的 token 跳过并 warning |
| `CGTransform` 位置 | 表 45 画在 `TextObject` 下，XSD/真实文件常在 `TextCode` 内或紧邻 | 两种都解析；按 `CodePosition` 关联到对应 `TextCode`；属性名兼容 `CodePosition`/`CodecPosition`、`CodeCount`/`CodecCount`；绘制时把 `Glyphs` 当整串，不按字符格拆分 |
| 命名空间 | OFD 1.0 用 `http://www.ofdspec.org/2016`，部分 1.1 文件用 `http://www.ofdspec.org` | 解析时忽略命名空间，按 local name 匹配 |
| `Size` 与 `CTM` | 真实文件有两套：`Size` 以 mm 计且 CTM≈1；`Size`≈209 且 CTM≈0.0176 | 字号统一按“对象空间单位”处理；最终大小 = `Size × CTM 的缩放`，两套都成立 |
| `TextCode` 中的空格/转义 | 标准要求空格转义为 `\0020` | 解析 `\XXXX`；字面空格保留为字符；不把 XML 缩进空白当文字 |
| `ReadDirection` | 180/270 表示从右往左/从下往上阅读 | 按逻辑字符顺序绘制，`X/Y` 是第一个逻辑字符的原点；`ReadDirection` 只决定步进方向：0=(+X)、90=(+Y)、180=(-X)、270=(-Y)。不反转字符/delta 数组；字形旋转只由 `CharDirection` 控制（依据图 63/64） |
| `Alpha` 作用于复合对象 | 标准语义是整体透明度 | `Alpha<255` 时由 `renderer.beginGroup/endGroup` 整体合成；自定义渲染器若不能隔离，warning 并退化为逐子对象 alpha |
| 图片格式 | 标准写 PNG/JPEG 等；真实文件有 `GBIG2`/`JBIG2`/`JB2`/TIFF | 内置 PNG/JPEG/WebP/GIF/BMP；JBIG2/TIFF v1 以动态 chunk 内置；失败 warning 并跳过该图 |
| 复合对象尺寸 | 资源有自己的 `Width/Height` 和内容坐标；`Boundary`/`CTM` 负责映射 | 内容先在自身空间绘制成“已完成图形”，再整体映射到图元空间；`Width/Height` 只裁剪内容，不缩放到 `Boundary` |
| OFD 1.1 `BlendMode` | 1.1 扩展 | 解析但忽略，warning；不因未知属性失败 |

### 3.1 本轮已确认口径（2026-10-21）

| 项 | 结论 | 依据 |
|---|---|---|
| 图层顺序 | 按图 16：每种类型先画该类型模板，再画该类型页图层；类型顺序 Background→Body→Foreground；非标准 `Custom` 放在 Foreground 之后；同组按引用/XML 顺序，后出现覆盖前面 | 业务确认 + 标准图 16 |
| 图片缺 `CTM` | 默认严格 identity（1×1）；`strictImageCtm=false` 才铺满 `Boundary` | 业务确认 |
| `DeltaX` 首值 | 第一个字符画在 `X`；`DeltaX[0]` 从第 1 个字符推进到第 2 个 | 业务确认 + 图 62 |
| `CGTransform` 作用域 | `CodePosition` 是当前 `TextCode` 内的字符偏移 | 业务确认 + 标准表 48 |
| `CGTransform` 多对多 | 字形列表作为整串，按字体 advance 依次绘制；整串后按 `CodeCount` 个字符的 delta 之和推进；不把字形按字符格分配 | 标准图 67–70 + 业务提示 |
| 阅读方向 | 保持逻辑字符顺序，`X/Y` 是第一个逻辑字符原点；180/270 分别用 -X/-Y 步进，不反转数组，不额外旋转字形 | 标准图 63/64 + 文字 11.3 |
| 复合对象 | 内容在 `(0,0,Width×0.3528,Height×0.3528)` 独立空间绘制成“已完成图形”，再经 `Boundary+CTM` 映射；不缩放到 `Boundary` | 业务确认 + 样本 `发票监制章-数科.ofd` |
| 多模板页尺寸 | 按 `Template` 引用顺序取第一个带 `Area` 的模板 | 业务确认 |
| 零尺寸 `Boundary` | 直接跳过该对象，不绘制 | 业务确认 |
| 字体来源 | 不内置 CJK 字体；`FontProvider` 宿主注入，环境允许时可读本地字体；可选 `supplementaryFonts` | 业务确认 |
| 径向渐变 | **v1 不做**：识别后 `W_RADIAL_UNSUPPORTED`，用平均色/透明降级；v2 再做软件光栅化 | 业务确认（v1 范围） |
| 底纹 | v1 必做；`ReflectMethod` 用 Normal/Column/Row/RowAndColumn；先按 XStep/YStep 排列，再整体应用 CTM；CellContent 走独立块 | 标准图 27/28 + 表 28 + 样本 `pattern类型.ofd` |
| `DeltaX` 压缩组 | `g <count> <value>` 先展开，再按字符位置使用 | 样本 `testPathClip.ofd` |
| 注释/签章 | v1 渲染 `Appearance` 静态外观；`Visible` 生效；`NoZoom/NoRotate`/`Print` 属于阅读器提示，engine 不处理；签名验证不做 | 业务确认 |
| 独立空间 | 注释/复合/底纹统一 `IndependentBlock`；显示列表复用，group 合成由 renderer 内部处理；平移不改变显示列表 | 业务确认 |
| 绘制参数 | 准备阶段完成 `Relative`/嵌套/优先级结算，输出 `ResolvedStyle`；绘制阶段不再解析 | 业务确认 |
| 渲染器 | `Renderer` 抽象；`H5Canvas2DRenderer` 默认，渲染器可替换；不暴露 Canvas 类型给 render | 业务确认 |
| Gouraud/LaGouraud | v1 用软件光栅化做重心插值；`EdgeFlag` 0/1/2；网格按 `VerticesPerRow` | 业务确认 |
| JBIG2/TIFF | v1 以纯 JS 动态 chunk 内置；缺失解码器时 warning，不崩页 | 业务确认 |
| 细线默认 | `MiterLimit=4.234`；`LineWidth=0` 画 hairline（1 设备像素） | 业务确认 |
| 测试基线 | `ofd_pdf_match/` 已有 55 对 OFD/PDF，按同名配对；PDF 只作为版式参考，不要求逐像素 | 业务提供 |

### 3.2 标准图示校验记录

以下不是“参考实现的做法”，而是直接按 GB/T 33190—2016 的图与正文校正：

| 图示 | 结论 | 对本设计的影响 |
|---|---|---|
| 图 16 图层渲染顺序 | 每种类型都是“该类型模板在下、该类型页图层在上”；从下到上为 Background 模板→Background 层→Body 模板→Body 层→Foreground 模板→Foreground 层 | 之前“Background 模板→所有页图层→Foreground 模板”的写法错误，已改为按类型分组 |
| 图 27/28 底纹 | `ReflectMethod` 取值是 Normal/Column/Row/RowAndColumn；`CTM` 是先按 XStep/YStep 排列后对整个底纹做变换 | 修正枚举名与 CTM 作用顺序；tile 内不再应用 CTM |
| 图 31–33 轴向渐变 | Direct/Repeat/Reflect 的效果由 MapUnit 与颜色段映射决定；Extend=0 时只保留轴线区间 | 现有轴向方案基本成立，保留 band 裁剪 |
| 图 34/36 径向渐变 | 渐变是沿中心连线扫掠椭圆；Extend=0 只填充两椭圆之间的区域，起始椭圆内部和结束椭圆外部为空；Extend=1/2 只形成锥形延伸 | v1 不做，warning 降级；v2 软件光栅化求 t |
| 图 38–42 Gouraud | 三角形内按面积（重心）插值；EdgeFlag 0/1/2 控制四边形对角线；LaGouraud 按 VerticesPerRow 组网格 | v1 软件光栅化；不再“平均色跳过” |
| 图 44 裁剪区 | 一个 Clip 内多个 Area 取并集；多个 Clip 之间取交集；数据相对图元 Boundary | 与现方案一致；补充了 Area/Path 的变换顺序 |
| 图 62–65 文字定位/字符方向 | X/Y 是第一个逻辑字符的绘制点；RD 180/270 用 -X/-Y 步进；CharDirection 只让字形绕绘制点旋转 | 修正了之前“反转 cells/deltas”和“旋转后重新解释 X/Y”的错误 |
| 图 67–70 字形变换 | CGTransform 给出一串字形索引；多对一/一对多/多对多都按字形串连续绘制，字符格只决定整串的总步进 | 删除“把 glyph 按比例分到字符格”的算法，改为 run-based |
| 图 71/72 复合对象 | `Width/Height` 是内容尺寸，超出部分裁剪；内容在独立空间描述 | 与“内容原尺寸 + Boundary/CTM 映射，不拉伸到 Boundary”一致 |

---

## 4. 开源实现调研结论

调研仓库已放在 `references/` 下，均为只读参考，不直接复制代码。

| 仓库 | 语言/路线 | 可借鉴 | 不采用/注意 |
|---|---|---|---|
| `ofdrw/ofdrw` | Java，完整 OFD 读写 + PDF/AWT 导出 | 数据模型、资源解析、页尺寸回退、字体/图片处理、测试样例 | 体积大；PDF 导出路径不能直接搬到 Canvas；资源管理是文档级，页资源需自己补 |
| `ofd-utility/ofd-core` | Rust + tiny-skia，2133 行渲染器 | 变换顺序、DrawParam 继承、路径命令、文字定位、图片单位矩形、默认值取舍 | 层顺序按 Background/Body/Foreground 排序，与标准“文档顺序”不一致；只支持部分图片格式 |
| `rofd` | Rust/WASM，现代 OFD 阅读器 | 按需渲染、字体切片/回退、图片单位矩形、文字 delta 回退、平台分层 | 使用 Parley 做复杂文本 shaping，和我们的“严格按 OFD 字距”路线不同；v1 图片格式有限 |
| `ofdjs-viewer` | TypeScript + Canvas 2D | API 分层、取消、诊断、零尺寸文字 Boundary 兼容、资源限制 | 文字用 Canvas `fillText`，不满足我们的核心约束；ZIP 用 fflate 全量解压；CGTransform/渐变/复合对象不完整 |
| `ofd.js` | JS + SVG/DOM | 旧版实现、JBIG2 解码器、真实文件兼容经验 | 按对象类型分组绘制会破坏 z-order；SVG/DOM 路线不适合 Canvas 引擎 |
| `liteofd` | TypeScript + PDF.js 字体机制 + SVG | 字体解析/子集化经验 | 依赖 DOM/SVG/FontFace，不能直接用于小程序；许可证文件与 package.json 不一致，不复制代码 |

从样例和实现中确认的关键事实：

1. **文字对象大量缺字体**：在 `references/` 的样例中统计到 11825 个 `TextObject`，其中 7658 个带内嵌字体，约 35% 依赖外部字体。没有补充字体会直接导致这些文字不显示。
2. **内嵌字体经常是“剥离子集”**：可能没有 `cmap`、`name`、`OS/2` 表，但 `glyf`/`CFF` 和 `post` 仍在；fontkit 2.0.4 仍能用 `getGlyph(gid)` 取轮廓。
3. **CFF CID 字体不能用 `getGlyph('高')`**：会因字符映射路径报错；必须用 `glyphForCodePoint(cp)` 或 `getGlyph(gid)`。
4. **字号 + CTM 有两套写法**：`Size=25.4, CTM≈1` 与 `Size≈209, CTM≈0.0176` 都可能出现；只乘其中一个会得到错误大小。
5. **`DeltaX` 经常不靠谱**：数量可能少于/多于字符数，可能使用 `g 3 3.1305` 压缩组，也可能显式全 0；不能假设它一定完整，但也不能把合法的 `g` 组当坏 token。
6. **图片局部空间是单位正方形**：ofdrw 的 AWT 导出明确先 `scale(1/image.width, 1/image.height)`，再 `CTM`，再 `Boundary` 平移；不是“像素坐标直接画”。
7. **层顺序有实现分歧**：部分实现强制 Background→Body→Foreground；标准说按出现顺序。真实文件多数只有 `Body`，但兼容性开关仍值得保留。
8. **JBIG2 不罕见**：扫描件常见 `GBIG2`/`JBIG2`/`JB2`，浏览器原生不支持；v1 已确认内置 JBIG2/TIFF 解码器（动态 chunk）。
9. **负尺寸 Boundary 真实存在**：例如 `Boundary="97.76 141.74 87.48 -87.48"`；不归一化会导致裁剪为空。
10. **页资源/模板资源容易被忽略**：只读 `PublicRes`/`DocumentRes` 会漏掉页级字体和图片；模板页也可能有自己的 `PageRes`。

许可证：ofdrw、ofd.js、liteofd、rofd 为 Apache-2.0；ofd-utility、ofdjs-viewer 为 MIT。若后续复用 JBIG2 解码器等具体代码，必须保留对应版权与 NOTICE；本设计只借鉴算法与数据模型，不复制实现。

---

## 5. 技术选型

| 能力 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript（strict） | 与 Web/PC/小程序共用；类型约束数据模型 |
| 2D 绘制 | Canvas 2D | 用户指定；Web/小程序/Node 均有实现；导出图片天然支持 |
| 字体解析 | `fontkit` 2.x | 支持 TTF/OTF/TTC/CFF/CFF CID；能处理无 `cmap`/`name` 的剥离子集；纯 JS，可进小程序 |
| XML | `saxes`（`xmlns:false`） | 纯 JS、流式、体积小；关闭命名空间处理，按 local name 匹配，兼容两种 OFD 命名空间 |
| 解压 | 原生 `DecompressionStream('deflate-raw')`，回退 `fflate` | 浏览器原生优先；小程序/旧环境用 fflate；只引入 inflate，不引入 zip 全量库 |
| 图片 | 平台 `ImageDecoder`/`createImageBitmap`/`Image` | 不把解码器绑死在核心；Node 用 canvas 的 `loadImage`；小程序用 `canvas.createImage()` |
| JBIG2 | PDF.js/ofd.js 的 Apache-2.0 解码器，独立动态 chunk | v1 必做；首次遇到 `.jb2` 时加载 |
| TIFF | `utif` 或平台解码器，独立动态 chunk | v1 必做；首次遇到 TIFF 时加载 |
| 构建 | `tsup`/`esbuild`，ESM + CJS + `.d.ts` | Web 用 ESM，Electron 主进程/旧工具链用 CJS |
| 测试 | Vitest + `@napi-rs/canvas`（Node 黄金图）+ Playwright（浏览器） | 纯 JS 单测 + 真实 Canvas 像素对比 |

不采用的路线：

- **Canvas `fillText`**：系统字体不可控、小程序字体加载受限、不同平台字形/字距不一致，违背核心约束。
- **SVG/DOM 渲染**：小程序不支持；DOM 节点多时性能差；导出图片需要再转 Canvas。
- **WebGL/WebGPU**：v1 不值得；Canvas 2D 足够覆盖阅读器；后续大页面/高 DPI 可加。
- **整包 `JSZip`/`fflate.unzip`**：违背按需加载；打开 1000 页文档会解压全部内容。
- **`opentype.js`**：CFF CID/剥离字体支持不如 fontkit；用户已指定 fontkit。

依赖体积（估算，需以实际构建为准）：

- `fontkit` 浏览器包未压缩约 530KB，minify + gzip 后约 150KB 量级；
- `saxes` 约 30KB；
- `fflate` inflate 约 8KB；
- 主包目标：gzip < 250KB（不含 JBIG2/TIFF 动态 chunk 和补充字体）；JBIG2/TIFF 首次使用时加载。

---

## 6. 总体架构

```
┌────────────────────────────────────────────────────────────┐
│ 公共 API  OFDDocument.open / pageCount / getPage            │
│           page.getViewport(...) / page.render(...) / close  │
├────────────────────────────────────────────────────────────┤
│ 文档层  DocumentModel  PageTree  PageModel  ResourceStore   │
├────────────────────────────────────────────────────────────┤
│ 样式层  DrawParamGraph  StyleResolver  ResolvedStyle        │
│         （只做结算，不碰 Canvas/资源解码）                   │
├────────────────────────────────────────────────────────────┤
│ 渲染层  PageDisplayList  ObjectRenderer  TextLayout          │
│         PathBuilder  ImageRenderer  PaintResolver           │
│         ClipResolver  IndependentBlock  Gouraud             │
├────────────────────────────────────────────────────────────┤
│ 渲染器层  Renderer  H5Canvas2DRenderer  RecordingRenderer   │
│         （只认路径/图像/样式/矩阵，不认 OFD 模型）           │
├────────────────────────────────────────────────────────────┤
│ 解析层  ZipReader  XmlParser  ModelDecoder  FontFace        │
├────────────────────────────────────────────────────────────┤
│ 平台层  ByteSource  ImageDecoder  FontProvider              │
│         （由宿主注入，v1 不实现具体端）                      │
└────────────────────────────────────────────────────────────┘
```

模块目录建议：

```
src/
  index.ts                  // 仅导出公共 API 和公共类型
  api/
    document.ts             // OFDDocument 实现
    page.ts                 // OFDPage、getViewport、render
    render-task.ts          // RenderTask（promise/cancel）
    viewport.ts             // Viewport 计算（mm × dpi）
  container/
    byte-source.ts          // ByteSource 接口 + ArrayBufferSource（核心测试用）
    zip-reader.ts           // EOCD/中央目录/局部头/解压
    path.ts                 // 包内路径解析与安全校验
  xml/
    parser.ts               // saxes 封装、XmlNode
  common/
    types.ts                // Matrix/Rgba/DrawStyle/ResolvedPaint/ImageHandle（无 OFD 模型）
    display-list.ts         // 目标无关的 DisplayList/DrawCommand
  model/
    types.ts                // 页面/图元/资源的数据结构
    decode.ts               // XML → 模型
  resource/
    store.ts                // 资源作用域、ID 查找、缓存
  style/
    types.ts                // ResolvedStyle/Paint/样式作用域
    draw-param.ts           // flattenDrawParam、Relative 环检测、缓存
    resolve.ts              // resolveStyle、PreparedPage.styles
  render/
    prepare.ts              // 准备阶段编排：资源 + 样式 + 布局
    display-list.ts         // 与渲染器无关的绘制命令
    page.ts                 // 图层/模板/切页
    object.ts               // 图元分发
    path.ts                 // 路径命令、圆弧、填充/描边
    text.ts                 // 文字布局与字形轮廓
    image.ts                // 单位矩形、边框、蒙版
    paint.ts                // 纯色/轴向/径向/底纹/Gouraud
    block.ts                // IndependentBlock 显示列表/group/复用
    annotation.ts           // 注释/签章外观（基于 block）
    gouraud.ts              // 三角形/网格软件光栅化
    clip.ts                 // 裁剪区
  renderer/
    types.ts                // Renderer/Canvas2DLike/ImageHandle
    canvas2d.ts             // H5Canvas2DRenderer + 内部 CanvasFactory
    recording.ts            // 记录渲染器（测试/调试）
  font/
    face.ts                 // fontkit 封装、字体集合选择
    glyph.ts                // 字形解析、轮廓缓存
  image/
    jbig2.ts                // JBIG2 解码（动态 chunk）
    tiff.ts                 // TIFF 解码（动态 chunk）
  platform/
    image-decoder.ts        // ImageDecoder 接口
    font-provider.ts        // FontProvider 接口
```

依赖方向必须单向：

```
common ← model ← resource ← style ← render ← api
   ↑                              ↑
renderer ─────────────────────────┘
```

- `common` 只放 `Matrix`、`Rgba`、`DrawStyle`、`ResolvedPaint`、`DisplayList`、`ImageHandle` 等无 OFD 语义的类型。
- `renderer` 只依赖 `common`，不依赖 `model`/`render`；这样自定义渲染器不需要理解 OFD。
- `render` 不 import Canvas/DOM/Node；只调用 `Renderer`。
- `style` 是纯函数层：不读 ZIP、不解码图片、不调用 Canvas；只做 `DrawParam`/作用域合并。
- `api` 负责编排打开、准备、选择渲染器、取消；不实现具体绘制。
- `platform` 只提供字节/字体/图片解码；`renderer` 只提供绘制；两者不要混在一起。

模块边界规则：

| 模块 | 可以做 | 不可以做 |
|---|---|---|
| `common` | 矩阵/颜色/`DrawStyle`/`ResolvedPaint`/渲染器句柄 | 引用 model/style/render/OFD 类型 |
| `model` | 普通数据、解析结果 | 引用 render/renderer/Canvas |
| `style` | `DrawParam` 展开、作用域合并、最终样式 | 读 ZIP、解码图片、调用 renderer |
| `render` | 几何、文字布局、显示列表、调用 renderer | import Canvas/DOM/Node、解析 XML |
| `renderer` | 路径、填充/描边、图像、group | 识别 OFD 类型、读资源、解析 DrawParam |
| `platform` | 字节/字体/图片解码接口 | 持有渲染状态、调用 Canvas |
| `api` | 编排 open/prepare/render/close | 实现具体绘制/解码 |

建议用 ESLint `import/no-restricted-paths` 或依赖图测试锁住方向，避免后续把 Canvas 调用漏进 `render`。

不把每个 XML 节点做成类；模型是普通对象，解析器直接产出，渲染器只读。

### 6.1 仓库组织（Monorepo / Packages）

仓库采用 Monorepo 组织；**当前只交付一个子包** `ofdrw-viewer-engine`，后续阅读器/宿主适配等能力按独立子包扩展。

```
<repo-root>/
  package.json                 // workspace 根，只做编排
  pnpm-workspace.yaml          // 或 yarn/npm workspaces，以工程实际为准
  docs/
    OFD渲染引擎设计方案.md
  packages/
    ofdrw-viewer-engine/
      package.json             // name: "ofdrw-viewer-engine"
      tsconfig.json
      src/
        index.ts
        api/
        common/
        model/
        resource/
        style/
        render/
        renderer/
        font/
        image/
        platform/
```

约束：

- 根目录只放 workspace 配置、脚本、文档，不放 engine 实现；
- `packages/ofdrw-viewer-engine` 是唯一发布包，包名固定为 `ofdrw-viewer-engine`；
- 后续子包（例如 Web/Node 宿主适配、阅读器组件）只能**依赖** engine，engine 不能反向依赖任何宿主子包；
- 子包之间通过 `package.json` 的 `exports` 和 workspace 协议引用，不使用跨包相对路径；
- `docs/`、`references/`、`ofd_pdf_match/` 留在根目录，不打进 engine 包；
- 未来新增子包时，各自有独立的 `package.json`/构建/测试，根 workspace 只负责统一脚本和版本。

`ofdrw-viewer-engine` 的导出只从 `packages/ofdrw-viewer-engine/src/index.ts` 暴露；内部模块不直接从包根导出。

### 6.2 绘制参数结算层

`DrawParam` 的 `Relative` 链、图层/对象内联覆盖、嵌套容器作用域，全部在 `style/` 完成，输出不可变 `ResolvedStyle`。渲染层只接收最终样式，不再判断“这个字段该从哪来”。

- `DrawParamGraph`：按资源 ID 展开 `Relative`，检测环，缓存 partial；
- `StyleResolver`：按图层/PageBlock/Composite/注释/底纹作用域合并，写入 `PreparedPage.styles`；
- `ResolvedStyle`：只含绘制需要的最终字段，不含资源 ID、不含继承关系；
- 绘制阶段没有 `inherited` 参数，没有 `resolveDrawParam` 调用。

### 6.3 绘制渲染器接口

渲染器是底层绘制实现，不是页面渲染管线。它只接收最终样式、路径、图像、矩阵和 group，不认识 `PathObject`/`DrawParam`/`PageBlock`。`Renderer` 是公开扩展点，`H5Canvas2DRenderer` 是默认实现；普通用户不需要关心默认实现。

```ts
// 从 common/types、api/viewport、renderer/types 导入；为聚焦接口，省略 Box/Viewport/Canvas2DLike/DecodedImage 的 import
import type { DrawStyle, ResolvedPaint } from '../common/types';

export type Matrix = readonly [number, number, number, number, number, number];

export interface ImageHandle {
  readonly width: number;
  readonly height: number;
}

export type CompositeMode =
  | 'source-over'
  | 'multiply' | 'screen' | 'overlay'
  | 'darken' | 'lighten'
  | 'color-dodge' | 'color-burn'
  | 'hard-light' | 'soft-light'
  | 'difference' | 'exclusion'
  | 'hue' | 'saturation' | 'color' | 'luminosity'
  | 'destination-in' | 'destination-out';

export interface GroupOptions {
  /** group 自身坐标系的 bounds，单位与当前绘制空间一致 */
  bounds: Box;
  /** group 坐标 -> 当前目标 device 坐标的矩阵 */
  matrix: Matrix;
  /** 组透明度 0..1；在 group 结束时整体乘一次 */
  alpha: number;
  /** 是否需要隔离；blend mode / soft mask / 复杂合成时 true */
  isolated?: boolean;
  /** group 的合成模式；默认 source-over */
  composite?: CompositeMode;
}

export interface Renderer {
  // 生命周期：目标画布/页面
  beginPage(context: CanvasRenderingContext2DLike, viewport: Viewport): void;
  endPage(): void;

  // 状态
  save(): void;
  restore(): void;
  setTransform(m: Matrix): void;
  transform(m: Matrix): void;
  translate(x: number, y: number): void;
  multiplyAlpha(alpha: number): void;   // 0..1，与当前 alpha 相乘
  clear(): void;

  // 路径
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  cubicCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  closePath(): void;
  clip(rule: 'nonzero' | 'evenodd'): void;

  // 填充/描边：样式是最终结算结果，paint 已由 PaintBinder 绑定到当前渲染器
  fill(style: DrawStyle, paint: ResolvedPaint, rule: 'nonzero' | 'evenodd'): void;
  stroke(style: DrawStyle, paint: ResolvedPaint): void;

  // 图像
  createImage(image: DecodedImage): ImageHandle;
  drawImage(image: ImageHandle, transform: Matrix, alpha: number, smoothing: boolean, mask?: ImageHandle): void;

  // 独立 group：组透明度、混合模式、蒙版、复合对象、注释、底纹 tile
  beginGroup(options: GroupOptions): void;
  endGroup(): void;

  // 释放渲染器内部资源（scratch canvas、pattern canvas、image handle）；不关闭主 canvas
  close(): void;
}
```

约束：

- **没有 `fillText`/`strokeText`/`measureText`**：文字统一走字形轮廓 → 路径 → `fill/stroke`，渲染器不能偷偷用平台文字 API。
- **没有公开的 `createSurface`/`beginSurface`/`drawSurface`**：surface 是渲染器内部实现，engine 不持有、不创建、不缓存。
- `beginPage` 不设置 canvas 宽高、不清屏；`clear` 只用于内部 scratch。页面背景/清屏由用户负责，透明区域保留 canvas 原内容。
- `beginGroup` 进入一个独立合成目标；group 内坐标由 `bounds` 和 `matrix` 定义；`alpha` 在 `endGroup` 时整体应用一次，不能逐子对象乘，否则重叠区域会偏深。
- `endGroup` 必须恢复到进入前的目标、变换、alpha、clip 和 composite；嵌套 group 用栈实现。
- 矩阵是普通数组，不使用 `DOMMatrix`；渲染器自己转换成平台类型。
- `ImageHandle` 是 opaque handle，核心不假设它是 Canvas/ImageBitmap/WebGL texture。
- `fill`/`stroke` 接收 `DrawStyle`；`Paint` 已经在样式层归一化为纯色/轴向/底纹/Gouraud 描述，渲染器不再判断 OFD 的 `Color`/`AxialShd` 结构。
- 渲染器抛错由渲染层捕获，warning 后继续下一个对象；`restore` 必须在 `finally`。

渲染器实现：

| 渲染器 | 用途 | 说明 |
|---|---|---|
| `H5Canvas2DRenderer` | 默认（宿主提供 Canvas2D） | 公开类；内部使用 `CanvasFactory` 创建 scratch/pattern 画布，不绑定 DOM（可注入 Node/小程序 createCanvas） |
| `RecordingRenderer` | 测试/调试/导出命令 | 记录路径/样式/矩阵/group 调用，不真正画 |
| 自定义 `Renderer` | 宿主扩展 | v1 不内置 SVG/PDF/WebGL 实现；group 可用 `<g>`/Form XObject/FBO 原生实现 |

#### 6.3.1 H5 的 CanvasFactory（渲染器内部）

`H5Canvas2DRenderer` 不直接 `new OffscreenCanvas`，也不假设 `document` 存在；它接收一个宿主提供的 `createCanvas`：

```ts
interface CanvasFactory {
  create(width: number, height: number): {
    canvas: Canvas2DLike;
    context: CanvasRenderingContext2DLike;
  };
  /** 复用同一 canvas，改尺寸并清空 */
  reset(entry: { canvas: Canvas2DLike; context: CanvasRenderingContext2DLike },
        width: number, height: number): void;
  /** width/height 置 0，释放图形资源 */
  destroy(entry: { canvas: Canvas2DLike; context: CanvasRenderingContext2DLike }): void;
}

export interface H5Canvas2DRendererOptions {
  /** 不传则使用浏览器默认实现；Node/小程序必须传 */
  createCanvas?: (width: number, height: number) => Canvas2DLike;
  /** 默认 false；true 时 getContext({willReadFrequently:false}) */
  enableHWA?: boolean;
}
```

- 浏览器默认：`document.createElement('canvas')`；Worker 可用 `OffscreenCanvas`；默认工厂只在 `globalThis.document` 存在时启用，API/渲染层不直接 import DOM；
- Node：宿主传 `@napi-rs/canvas` 的 `createCanvas`；
- 小程序：宿主传 `wx.createOffscreenCanvas` 包装；
- `create` 时 `getContext('2d', { alpha: true, willReadFrequently: !enableHWA })`；
- `reset` 可用于 scratch 池复用；v1 也可以每次 create/destroy，行为一致；
- `destroy` 把 `canvas.width/height` 置 0，和 pdf.js 的 `CanvasFactory.destroy` 一致；
- 这些 canvas 只存在于 `H5Canvas2DRenderer` 内部，engine 完全看不到；`CanvasFactory` 只是 H5 内部结构，不从包根导出。

`beginGroup/endGroup` 的内部行为：

1. 由 `bounds × matrix` 求 group 在设备空间的 AABB；
2. `floor` 得到 scratch 原点，`ceil` 得到 scratch 宽高；
3. `CanvasFactory.create(w, h)`；
4. 保存父目标，切换到 scratch context；
5. group 内按 group 空间绘制；
6. `endGroup` 恢复到父目标，`drawImage(scratch.canvas, offsetX, offsetY)`，乘 `alpha`，应用 `composite`；
7. `CanvasFactory.destroy(entry)`。

`beginGroup` 的 `isolated`/`composite` 用于 blend/SMask 等需要先隔离再合成的场景；普通组透明度只走 alpha，不需要改变子对象的绘制模式。

#### 6.3.2 样式与渲染器之间的 Paint 绑定

`ResolvedStyle` 里的 `fillPaint/strokePaint` 是 **`PaintSpec`**（纯色/轴向/底纹描述/Gouraud 描述），还不是 CanvasGradient/CanvasPattern/ImageBitmap；这样样式层不依赖渲染器。

在进入绘制前，`render/paint.ts` 的 `PaintBinder` 按当前渲染器做一次绑定：

| `PaintSpec` | `PaintBinder` 输出 `ResolvedPaint` |
|---|---|
| 纯色 | `{kind:'color', rgba}` |
| 轴向渐变 | `{kind:'gradient', spec}`；渲染器原生实现 |
| 径向渐变 | v1 已降级为颜色；v2 由 renderer 内部预栅格 |
| 底纹 | 用 `IndependentBlock` 生成 tile display list，输出 `{kind:'pattern', tile, ...}` |
| Gouraud | 输出 `{kind:'shading', spec}`，由渲染器光栅化 |

```ts
// 定义在 common/types.ts（DisplayList 见 common/display-list.ts）；Renderer 只依赖这里，不依赖 style/model
export type ResolvedPaint =
  | { kind: 'color'; rgba: Rgba }
  | { kind: 'gradient'; spec: GradientSpec }
  | { kind: 'pattern'; tile: DisplayList; width: number; height: number;
      xStep: number; yStep: number; reflect: 'Normal' | 'Column' | 'Row' | 'RowAndColumn'; ctm: Matrix }
  | { kind: 'shading'; spec: MeshShadingSpec };
```

- `DisplayList` 定义在 `common/display-list.ts`，只包含目标无关的绘制命令，不包含 OFD 模型；`render/display-list.ts` 负责构建它。
- `PaintBinder` 是 per-renderer 的，缓存 key 含 `PaintSpec` 规范化哈希 + `dpiBucket`；同一个红章/底纹跨对象复用。
- 绑定发生在绘制之前、样式结算之后；它不改变继承/优先级，只把“OFD 描述”变成“渲染器可画对象”。
- 渲染器只看到 `ResolvedStyle + ResolvedPaint`，看不到 `Pattern.CellContent`/`GouraudShd` 的 XML 结构。
- `H5Canvas2DRenderer` 对 `pattern` 用内部 tile canvas 生成 `CanvasPattern` 或手动平铺；对 `shading` 在内部 canvas 上软件光栅化；两者都不向 engine 暴露 surface。
- 自定义 SVG/PDF 渲染器可把 `pattern` 映射为 `<pattern>`/tiling pattern，把 `shading` 映射为原生 shading。

渲染器注入：

```ts
const doc = await OFDDocument.open({
  source,
  renderer: new MyRenderer(),   // 可选；默认 H5Canvas2DRenderer
});

const page = await doc.getPage(0);
const viewport = page.getViewport({ dpi: 96 });
canvas.width = Math.ceil(viewport.width);
canvas.height = Math.ceil(viewport.height);

const task = page.render({
  canvasContext: canvas.getContext('2d')!,
  viewport,
});
await task.promise;
```

- `Renderer` 是正式扩展点；默认不要求用户传，传了就必须实现完整接口。
- `page.render` 只给 `canvasContext` 和 `viewport`，不负责设置 canvas 宽高、不负责清屏/背景；canvas 的生命周期完全由用户管理。
- 渲染器切换不需要改 `PageRenderPipeline`/`ObjectRenderer`，只换 `OFDDocument.open({ renderer })`。

## 7. 容器层：按需 ZIP

### 7.1 `ByteSource`

```ts
export interface ByteSource {
  /** 总字节数，单位 byte */
  readonly size: number;
  /** 读取 [offset, offset+length) 的字节；越界由实现截断或抛错 */
  read(offset: number, length: number): Promise<Uint8Array>;
}
```

内置适配器：

| 适配器 | 实现 | 适用 |
|---|---|---|
| `ArrayBufferSource` | 直接 `slice` | 小文件、测试 |
| `BlobSource` | `blob.slice(offset, offset+length).arrayBuffer()` | 浏览器 File/Blob |
| `HttpRangeSource` | `fetch(url, { headers: { Range } })`；服务器不支持 Range 时回退整包 | URL |
| `NodeFileSource` | `fs.promises.open` + `file.read(buffer, 0, length, offset)` | Node/Electron 主进程 |
| `WeChatFileSource` | `wx.getFileSystemManager().read` + fd/position | 小程序 |

`HttpRangeSource` 注意：

- 先 `HEAD` 或 `GET Range: bytes=0-0` 探测 `Content-Range`/`Accept-Ranges`；
- 不支持 Range 时，首次读取后把整包缓存为 `ArrayBuffer`，后续走 `ArrayBufferSource`；
- 跨域需要服务端 `Access-Control-Expose-Headers: Content-Range`。

### 7.2 ZIP 读取算法

打开时执行一次：

1. 从文件尾部向前找 EOCD 签名 `0x06054b50`（最多回退 64KB + 22B，兼容注释）。
2. 解析中央目录偏移/条目数；若为 `0xFFFFFFFF` 或条目数 `0xFFFF`，查 ZIP64 EOCD locator/record。
3. 读取中央目录，建立 `path → EntryMeta`：
   - `name`、`compressedSize`、`uncompressedSize`、`method`、`localHeaderOffset`、`crc32`、`flags`。
4. 读取条目时：
   - 定位 local header，解析文件名长度/extra 长度，得到数据起始偏移；
   - `method=0` 直接切片；`method=8` 解压；
   - 支持 data descriptor（flag bit 3）：以中央目录的 size 为准，不依赖 local header；
   - 校验 CRC32（可选，默认开；失败 warning，不直接丢数据）。
5. 拒绝：加密条目、method 非 0/8、路径穿越、重复规范化路径、超出限制。

### 7.3 按需策略

| 时机 | 读取内容 |
|---|---|
| `open` | `OFD.xml`、`Document.xml`、页树；不读页内容、不读字体/图片 |
| `getPage(i)` | 该页 `Content.xml`/`PageRes`；`page.getSize()`/`page.getViewport()` 只读页尺寸，不加载字体/图片 |
| `getPage(i)` / `page.render` | 该页 `Content.xml`、`PageRes.xml`、模板页 `Content.xml`/`PageRes.xml`；按需字体/图片/复合资源 |
| 预渲染下一页（宿主可选） | 下一页同样的内容；引擎提供 `preloadPage(i)` 内部能力，不暴露为必需 API |

缓存：

- 中央目录常驻（小）；
- 解压后的 XML 条目 LRU（按字节，默认 16MB）；
- 解析后的资源索引常驻（每个资源 XML 一次）；
- 字体二进制/字体对象 LRU（默认 64MB）；
- 解码图片 LRU（默认 64MB，按像素字节估算）；
- 页面模型 LRU（默认 8 页）。

### 7.4 限制

| 限制 | 默认值 | 说明 |
|---|---|---|
| 压缩包大小 | 256 MiB | 超过拒绝打开 |
| 条目数 | 20,000 | |
| 单条目解压大小 | 64 MiB | XML/字体/图片分别可再收紧 |
| 总解压大小 | 512 MiB | 防 zip bomb |
| 压缩比 | 200:1 | 单条目超过则拒绝 |
| XML 大小 | 32 MiB | 单文件 |
| 字体大小 | 64 MiB | 单字体 |
| 图片像素 | 100 MP | 解码前按头部尺寸检查 |
| Canvas 像素 | 64 MP | 设备相关，可配置 |

限制均可通过 `open({ limits })` 覆盖，但设 0 表示不限制只建议测试使用。

---

## 8. XML 与数据模型

### 8.1 解析策略

- 使用 `saxes`，`xmlns: false`，不处理命名空间；节点名取 `:` 后的 local name。
- 属性名大小写敏感，但提供 `getAttr(node, 'LineWidth')` 的精确匹配；对已知的拼写错误（`LincWidth`、`Scrif`、`CodecPosition`）做兼容。
- 禁止 DTD/外部实体；遇到 `<!DOCTYPE` 直接拒绝或忽略实体，防 XXE。
- 解析结果：

```ts
interface XmlNode {
  name: string;                 // local name
  attrs: Record<string, string>;
  children: XmlNode[];
  text?: string;                // 仅叶子文本
}
```

- 数字解析统一走 `toNumber(raw, fallback)`：
  - 去空白、支持科学计数法；
  - `NaN`/`Infinity`/空串 → fallback + warning；
  - 数组解析按空白/逗号分割，坏 token 跳过并 warning。
  - `DeltaX/DeltaY`（常见于 `TextCode`）支持 `g <count> <value>` 压缩组：`g N V` 表示把后面的数值 `V` 重复展开 `N` 次；例如 `0 g 3 5 2` 展开为 `0, 5, 5, 5, 2`，`g 3 3.1305` 展开为 3 个 `3.1305`。`count` 必须为正整数，展开后总长度设上限（默认 100,000）防炸。`g` 组只对数值数组生效，不改变 XML 其他属性。
- 布尔解析：`true/1/yes` 为 true，`false/0/no` 为 false；其他 fallback。

### 8.2 核心类型

```ts
export type Matrix = readonly [number, number, number, number, number, number];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ResourceId = string;   // 十进制文本，避免精度/非数字问题

export interface PageRef {
  id: ResourceId;
  loc: string;                     // 已解析为包内绝对路径
}

export interface PageSize {
  width: number;                   // mm
  height: number;                  // mm
}

export interface TemplateRef {
  id: ResourceId;
  loc?: string;                    // 模板页内容文件，已解析为包内路径
  zOrder: 'Background' | 'Body' | 'Foreground';
}

export interface Clip {
  ctm?: Matrix;
  drawParam?: ResourceId;
  areas: ClipArea[];               // 同一 Clip 内取并集
}

export type ClipArea =
  | { kind: 'path'; path: PathObject }
  | { kind: 'text'; text: TextObject };

export interface ImageBorder {
  lineWidth: number;               // mm；0 表示不画
  horizontalRadius: number;        // mm
  verticalRadius: number;          // mm
  dashOffset: number;
  dashPattern: number[];
  color: Rgba;
}

export interface GraphicUnitBase {
  id?: ResourceId;
  boundary: Box;
  ctm?: Matrix;
  drawParam?: ResourceId;
  alpha: number;                   // 0..255，默认 255
  visible: boolean;
  lineWidth?: number;              // mm
  cap?: 'Butt' | 'Round' | 'Square';
  join?: 'Miter' | 'Round' | 'Bevel';
  miterLimit?: number;
  dashOffset?: number;
  dashPattern?: number[];
  clips?: Clip[];
}

export interface TextCode {
  text: string;                    // 已解码 \XXXX
  x?: number;
  y?: number;
  deltaX: number[];
  deltaY: number[];
  cgTransforms: CgTransform[];
}

export interface CgTransform {
  codePosition: number;
  codeCount: number;
  glyphCount: number;
  glyphs: number[];
}

export interface TextObject extends GraphicUnitBase {
  kind: 'text';
  font: ResourceId;
  size: number;                    // 对象空间单位（通常 mm）
  hScale: number;
  readDirection: 0 | 90 | 180 | 270;
  charDirection: 0 | 90 | 180 | 270;
  weight: number;
  italic: boolean;
  fill: boolean;
  stroke: boolean;
  fillColor?: Paint;
  strokeColor?: Paint;
  codes: TextCode[];
}

export interface PathObject extends GraphicUnitBase {
  kind: 'path';
  data: string;                    // AbbreviatedData 原文
  fill: boolean;
  stroke: boolean;
  rule: 'nonzero' | 'evenodd';
  fillColor?: Paint;
  strokeColor?: Paint;
}

export interface ImageObject extends GraphicUnitBase {
  kind: 'image';
  resourceId: ResourceId;
  substitution?: ResourceId;
  imageMask?: ResourceId;
  border?: ImageBorder;
}

export interface CompositeObject extends GraphicUnitBase {
  kind: 'composite';
  resourceId: ResourceId;
}

export type PageObject =
  | PageBlock
  | TextObject
  | PathObject
  | ImageObject
  | CompositeObject;

export interface PageBlock {
  kind: 'block';
  id?: ResourceId;
  children: PageObject[];
}

export interface Layer {
  type: 'Background' | 'Body' | 'Foreground' | 'Custom';
  drawParam?: ResourceId;
  children: PageObject[];
}

export interface PageModel {
  id: ResourceId;
  area: Box;                       // PhysicalBox，保留 x/y 原点与宽高
  size: PageSize;                  // 由 area 归一化得到，单位 mm
  layers: Layer[];
  templates: TemplateRef[];
  pageRes: string[];
  annotationFile?: string;          // 分页注释文件，已解析为包内路径
}

export interface PreparedPage {
  page: PageModel;
  /** 每个可绘制对象在进入绘制阶段前已经结算好的最终参数；绘制阶段只读 */
  styles: WeakMap<GraphicUnitBase, ResolvedStyle>;
  /** 注释外观的独立块；没有注释时为空 */
  annotationBlocks: IndependentBlock[];
}

export interface Annotation {
  id: ResourceId;
  type: 'Link' | 'Path' | 'Highlight' | 'Stamp' | 'Watermark' | string;
  visible: boolean;                 // 默认 true
  /** NoZoom/NoRotate/Print 是阅读器提示，不进模型；engine 只画 Appearance */
  appearance?: PageBlock;           // 空外观时跳过
  boundary?: Box;                   // Appearance 的 Boundary
}

export interface IndependentBlock {
  id?: ResourceId;
  source: 'composite' | 'annotation' | 'pattern-cell' | 'pageblock';
  space: { width: number; height: number }; // 块内坐标，单位 mm（Composite 已换算 0.3528）
  content: PageBlock;
  /** 块内对象继承的起点；Composite 用外层样式，Annotation/Pattern 用文档默认值 */
  styleRoot: ResolvedStyle;
  /** 资源 ID + 内容哈希 + styleRoot 哈希 + DrawParam 哈希 */
  cacheKey: string;
}
```

`Paint` 是纯色/轴向渐变/径向渐变/底纹/网格渐变的联合：

```ts
export type Paint =
  | { type: 'color'; color: Rgba }
  | { type: 'axial'; shade: AxialShade }
  | { type: 'radial'; shade: RadialShade }
  | { type: 'pattern'; pattern: Pattern }
  | { type: 'gouraud'; shade: GouraudShade };
```

### 8.3 页树展开

- `Pages` 可以有嵌套 `Pages`；递归前序遍历，`Page` 为叶子。
- 每个 `Page` 的 `BaseLoc` 相对 `Document.xml` 所在目录解析。
- 页 ID 重复时保留先出现者并 warning。
- `pageCount` 在 `open` 时确定；后续不再变化。

### 8.4 资源作用域

```ts
class ResourceStore {
  // 文档级：PublicRes + DocumentRes
  // 页级：PageRes + 模板 PageRes
  // 查找顺序：页级 -> 文档级
}
```

- 打开文档时只解析资源 XML 的索引（ID → 定义节点），不加载二进制。
- 渲染某页时建立 `PageResourceScope`：
  - 加载该页 `PageRes`；
  - 加载该页引用的模板页的 `PageRes`；
  - 与文档级资源合并；同 ID 页级覆盖文档级并 warning。
- 资源文件路径：
  - `BaseLoc` 缺省时，按资源 XML 所在目录处理（真实文件常见）；
  - `MediaFile`/`FontFile` 相对 `BaseLoc` 解析；
  - 允许 `/` 开头的包内绝对路径；统一去掉前导 `/` 后查 ZIP；
  - 拒绝 `..` 逃出包根。
- 资源 ID 统一转成十进制字符串；`#` 前缀、空白、前导零做归一化。

### 8.5 容错

- XML 解析失败：该页返回空页 + error warning；不崩溃整个文档。
- 未知节点/属性：忽略。
- 缺失必选属性：使用默认值并 warning；无法构造对象的跳过。
- 重复 ID：先到先得/页级覆盖，warning。
- 超大/超深 XML：限制节点数（如 200k）和深度（如 128）。

---

## 9. 资源层

### 9.1 字体资源

```ts
interface FontResource {
  id: ResourceId;
  fontName: string;
  familyName?: string;
  charset: string;                 // unicode/prc/big5/symbol
  serif: boolean;
  bold: boolean;
  italic: boolean;
  fixedSize: boolean;
  fontFile?: string;               // 包内路径
}
```

加载：

1. 读 `FontFile` 字节（限制 64MB）。
2. `fontkit.create(bytes)`：
   - 返回单字体或 `FontCollection`；
   - TTC 按 `FontName`/`FamilyName`/PostScript 匹配，匹配不到取第 0 个并 warning；
   - 解析失败 → 标记 `unavailable`，走兜底。
3. 记录：
   - `unitsPerEm`、`numGlyphs`、`hasCmap`、`postscriptName`、`familyName`；
   - `OS/2.usWeightClass`、`head.macStyle`、`post.italicAngle`（若存在）。
4. 字体对象按 `fontFile` 路径缓存；同一文件被多个 `FontResource` 引用时复用。

### 9.2 图片资源

```ts
interface ImageResource {
  id: ResourceId;
  mediaFile: string;               // 包内路径
  format: 'png' | 'jpeg' | 'webp' | 'gif' | 'bmp' | 'tiff' | 'jbig2' | 'unknown';
}
```

- 解码由平台 `ImageDecoder` 完成；核心只负责读字节、判格式、缓存。
- 解码结果统一为 `CanvasImageSourceLike`（浏览器 `ImageBitmap`/`HTMLImageElement`，Node canvas `Image`，小程序 `Image`）。
- 缓存键：`mediaFile + 目标用途（原图/蒙版/替换图）`；LRU 按像素字节。
- 解码失败：warning + 跳过该图；不抛出整页错误。
- 图片头部尺寸检查：PNG IHDR、JPEG SOF、GIF 逻辑屏幕、BMP 信息头、WebP VP8X；超过像素限制直接拒绝。
- `Substitution`：高分辨率输出（目标 DPI > 200）优先用替换图；否则用主图。提供 `substitution: 'auto' | 'always' | 'never'`。

#### 9.2.1 JBIG2 与 TIFF（v1 必做）

真实票据/档案大量使用二值扫描图；v1 不能只支持 PNG/JPEG。

- 格式识别顺序：扩展名 → magic → 解码器探测。
  - JBIG2 文件头：`97 4A 42 32 0D 0A 1A 0A`（`\x97JB2\r\n\x1a\n`）；OFD 里也可能是无文件头的嵌入式段，此时靠 `.jb2`/`.jbig2` 扩展名和 `ImageDecoderPlugin.format='jbig2'`。
  - TIFF：`II*\0`（little-endian）或 `MM\0*`（big-endian）。
- 解码接口统一返回 `ImageData` 或平台可 `drawImage` 的对象：

```ts
export interface DecodedImage {
  width: number;
  height: number;
  data: ImageData | CanvasImageSourceLike;
}
```

- JBIG2：
  - 只支持单页图像；多页时取第 1 页并 warning。
  - 二值输出转 RGBA：0 → 透明或黑，1 → 黑/白，按 `ImageMask`/`Decode` 决定；默认黑字白底不透明。
  - 需要处理全局段、页面信息段、通用区域、细化区域、文本区域；直接复用成熟解码器（如 `ofd.js` 的 JBIG2 解码器，Apache-2.0）时保留版权声明，不复制无 license 的代码。
  - 解码失败发 `W_JBIG2_DECODE`，图元按空白跳过。
- TIFF：
  - 支持 baseline、LZW、PackBits、Deflate；单页/第一帧；不支持多页、浮点、复杂 ICC。
  - `PhotometricInterpretation`：WhiteIsZero/BlackIsZero/RGB/CMYK/Palette；CMYK 按 9.3 近似转 RGB。
  - `BitsPerSample` 1/4/8/16；16 位缩到 8 位。
  - 条带/瓦片都支持；缺失条带按白/透明补。
- 解码器放独立 chunk，按需 `import()`；v1 明确选**纯 JS** JBIG2 解码器，不引入 WASM（小程序/包体/加载更可控）。
- 主包不静态引入 JBIG2/TIFF 解码表。
- 解码结果按 `mediaFile + 格式 + 目标尺寸` 缓存；JBIG2 二值图可缓存为 1bpp 位图，绘制时再转 RGBA，省内存。
- 像素上限在解码前检查：JBIG2 读页面信息宽高；TIFF 读 IFD 的 ImageWidth/ImageLength；超过 `maxImagePixels` 拒绝。
- 样本：`1.ofd`、`no_page_container.ofd`、`signedFile.ofd` 都含 `.jb2`；当前样本没有 `.tif/.tiff`，TIFF 用合成 fixture 覆盖。

### 9.3 颜色空间与绘制参数

- `ColorSpace`：
  - `GRAY`：1 通道；
  - `RGB`：3 通道；
  - `CMYK`：4 通道，近似转 RGB：

```
R = 255 * (1-C) * (1-K)
G = 255 * (1-M) * (1-K)
B = 255 * (1-Y) * (1-K)
```

  - `BitsPerComponent`：1/2/4/8/16，统一缩放到 0..255；
  - `Palette/CV`：按 `Index` 取色；`CV` token 可能是 `#RRGGBB` 或十进制；
  - `ICC`：记录 warning，按 DeviceRGB/CMYK 近似，不做 profile 转换。
- `DefaultCS`：颜色未指定 `ColorSpace` 时使用；再缺省用 RGB。
- `DrawParam`：
  - 解析为 `flattenDrawParam` 的 partial；`Relative` 递归解析，带环检测和深度限制（16）；
- 最终 `ResolvedStyle` 在 `preparePage` 阶段按对象结算，存入 `PreparedPage.styles`；
- 绘制阶段只读 `ResolvedStyle`，不再解析 `Relative`、不再合并图层/内联属性，也不修改资源对象。

### 9.4 复合图形资源

```ts
interface CompositeGraphicUnit {
  id: ResourceId;
  width: number;                   // 0.3528 mm 单位
  height: number;                  // 0.3528 mm 单位
  content: PageBlock;
}
```

- `Width/Height` 是内容坐标系的尺寸（0.3528 mm 单位），用于裁剪，不用于缩放到 `Boundary`；内容范围是 `[0, Width×0.3528] × [0, Height×0.3528]`。实际放置由 `CompositeObject.Boundary + CTM` 决定。
- 内容中的对象坐标就是矢量图坐标；绘制时先裁 `[0,0,Width,Height]`，再裁 `Boundary`。
- 递归深度限制 16；用资源 ID 栈检测循环引用。

### 9.5 底纹资源

`Pattern` 内含 `CellContent`（`PageBlock`）、`Width/Height`、`XStep/YStep`、`ReflectMethod`、`RelativeTo`、`CTM`。按 13.4 节处理。

---

## 10. 页面渲染管线

### 10.1 准备阶段（异步）

```
getPage(i) / page.render:
  1. 取 PageModel（缓存或解析 Content.xml）
  2. 解析页尺寸（Area 回退链）
  3. 建立 PageResourceScope（PageRes + 模板 PageRes）
  4. 收集该页所有 TextObject 的 Font 资源
  5. 收集所有 ImageObject 的 ResourceID/Substitution/ImageMask
  6. 收集所有 CompositeObject/Pattern 引用（递归收集其内部字体/图片）
  7. 并行加载字体、图片、复合资源
  8. 结算绘制参数：
     a. 展开所有被引用的 DrawParam（Relative 链、环检测、按 ID 缓存）；
     b. 按图层 → PageBlock → 对象的作用域树 resolveStyle；
     c. 结果写入 PreparedPage.styles；绘制阶段不再结算。
  9. 预解析文字布局（可选：提前算好每个 TextObject 的字形/路径）
  10. 如果该页有 annotationFile：
      读取 PageAnnot，构建注释 IndependentBlock（块内对象同样先结算样式；始终渲染可见静态外观）
  11. 返回 PreparedPage
```

- 步骤 8 必须在任何绘制调用之前完成；即使某个对象最终 `Visible=false`，也不要等到绘制时才解析它的 `DrawParam`，否则错误会延迟到状态栈里。
- 注释/底纹是独立块：它们的 `styleRoot` 在构建块时确定，块内对象在块构建阶段完成 `resolveStyle`，并存入显示列表。
- 准备阶段只做 I/O、解析、解码、样式结算，不碰目标 Canvas/渲染器。

### 10.2 绘制阶段（同步）

```
drawPage(prepared, renderer, canvasContext, viewport):
  1. renderer.beginPage(canvasContext, viewport)
  2. renderer.setTransform(identity)         // 不 clear、不设置 canvas 尺寸
  3. binder = createPaintBinder(renderer)    // 样式已结算；只做渲染器绑定
  4. renderer.setTransform(M_page)          // 绝对设置，覆盖宿主预置的 CTM
  5. 按图层类型分组绘制（图 16）：
     for group of [Background, Body, Foreground, Custom]:
       a. 该类型模板（按引用顺序）
       b. 该类型页图层（按 XML 出现顺序）
     同组内后画者覆盖先画者
  6. 注释/签章外观（按 PageAnnot 文件顺序）
  7. renderer.endPage()
```

- `drawPage` 只读 `PreparedPage.styles` 和显示列表，不再解析 `DrawParam`，不再查资源 ID，不再计算继承。
- 绘制阶段不直接调用 Canvas API；所有绘制走 `Renderer`（见 6.3），`canvasContext` 只透传给渲染器。
- 渲染器负责 Canvas 状态栈、路径、变换、裁剪、图像、group；引擎负责 OFD 语义和最终参数。

### 10.3 对象绘制伪代码

```
drawObject(prepared, renderer, binder, obj, style):
  if (!obj.visible || obj.alpha === 0) return
  if (boundary.w <= 0 || boundary.h <= 0) { warn(W_ZERO_BOUNDARY); return }

  renderer.save()
  renderer.translate(boundary.x, boundary.y)
  renderer.beginPath(); renderer.rect(0, 0, boundary.w, boundary.h); renderer.clip('nonzero')
  applyClips(renderer, obj.clips)             // 对象空间，交集；在 CTM 之前
  renderer.transform(obj.ctm ?? identity)
  if (obj.kind !== 'composite') {
    renderer.multiplyAlpha(obj.alpha / 255)    // 与父级 alpha 相乘，不覆盖
  }

  switch (obj.kind):
    path:      drawPath(renderer, binder, obj, style)
    text:      drawText(renderer, binder, obj, style)  // 字形路径 + fill/stroke，无文字 API
    image:     drawImage(renderer, binder, obj, style)
    composite: drawComposite(renderer, binder, obj, style, obj.alpha) // 组 alpha 在块贴图时乘一次
    block:     for child of obj.children:
                 drawObject(prepared, renderer, binder, child, prepared.styles.get(child))
  renderer.restore()
```

关键点：

- `style` 是 `PreparedPage.styles` 里的最终值；`drawObject` **没有 `inherited` 参数**，也不调用 `flattenDrawParam`/`resolveStyle`。
- `save/restore` 必须成对；每个对象独立，避免状态泄漏。
- `Boundary` 和 `Clips` 都在 `CTM` 之前；`Boundary` 用当前空间（页面/父容器）坐标，`Clips` 用对象空间坐标，两者都不乘图元 `CTM`。`Clip` 内部自己的 `Area.CTM × T(Boundary) × Path.CTM` 在 10.4.1 单独处理。
- 零尺寸 `Boundary` 在进入绘制前直接跳过，不创建渲染器状态；负尺寸先归一化。
- alpha 用 `multiplyAlpha`，不要用 `globalAlpha =` 覆盖父级；复合对象/独立块的组 alpha 由块整体合成，不逐个 child 乘（所以 composite 在 `drawObject` 里不要先乘一次）。
- 对象绘制失败：捕获异常，warning，继续下一个对象；`restore` 必须在 `finally` 中执行。

### 10.4 图层与模板顺序

按标准图 16，每种图层类型都是“模板在下、页图层在上”：

```
Background 模板 → Background 层
Body 模板       → Body 层
Foreground 模板 → Foreground 层
Custom 层（非标准，放在最后）
```

- 类型顺序固定为 `Background` → `Body` → `Foreground` → `Custom`（未知类型按 `Body`）。
- 组内先画该类型模板，再画该类型页图层；页图层覆盖同类型模板。
- 同类型模板按页面 `Template` 引用顺序绘制，后引用者覆盖先引用者；默认 `ZOrder=Background`。
- 同类型页图层按 `Content/Layer` 的 XML 出现顺序绘制，后出现者覆盖先出现者。
- 模板自身的内容也按“类型 + XML 顺序”绘制；模板页的 `Area` 只用于页尺寸回退，不额外变换。
- `layerOrder` 默认 `type`（上述规则）；`document` 为严格标准兼容模式，完全按 XML 出现顺序。
- 注意：这是“标准图 16 + 业务确认”的口径，不是某个开源实现的默认行为；黄金图需按此验收。

### 10.4.1 裁剪（Clips）

`Clips` 是图元对象自己的裁剪区，坐标在**对象空间**，即已经过 `Boundary` 平移、但尚未乘对象 `CTM` 的空间。因此标准图元的 `applyClips` 必须在 `renderer.transform(obj.ctm)` **之前**执行；图元 `CTM` 只作用于图元数据，不作用于裁剪区。

真实文件存在一类 `manual` 兼容写法：`Clips/Area.CTM` 已经写成了图片 `CTM` 的**逆矩阵**，用于表达“在图片单位空间里裁剪”。这种 Clips 如果仍在 `CTM` 之前应用，会被二次变换，导致裁剪区与图片交集为空或只剩一条边。v1 的口径是：

- 默认按标准顺序：`translate(Boundary) → clips → transform(obj.ctm)`；
- 仅当 `Clips/Area.CTM` 的面积比落在 `0.2–5`（典型 `manual` 样本≈1）且明显是逆编码时，改为 `translate(Boundary) → transform(obj.ctm) → clips`；
- 该判定只影响带 `Clips` 的 `ImageObject`，不影响普通路径/文字/注释；不允许把“先 CTM 后 Clips”推广到所有图元。

- 多个 `Clip` 之间取**交集**：按顺序对 Canvas 执行 `clip()`，Canvas 会自动与当前裁剪区相交。
- 一个 `Clip` 内多个 `Area` 取**并集**：把所有 Area 的轮廓合并到同一条路径，再执行一次 `clip(rule)`。
- 每个 Area 的变换：

```
M_area = Area.CTM × translate(Path.Boundary.x, Path.Boundary.y) × Path.CTM
```

  - `Area.CTM` 对整个 Area 生效；
  - `Path.Boundary` 是路径在 Area 空间的原点；
  - `Path.CTM` 是路径自己的变换；
  - `Text` 同理：`Area.CTM × translate(Text.Boundary) × Text.CTM`，再按文字布局生成轮廓。
- `Path` 的 `Fill`/`Stroke` 决定裁剪形状：
  - `Fill=true`：把路径区域加入裁剪；
  - `Stroke=true`：Canvas 不能直接把 stroke 转成裁剪路径；v1 在 `W_UNSUPPORTED_CLIP` 下降级为仅 Fill，不引入 renderer 私有的裁剪掩码接口。
- `Text` 裁剪：按第 12 节生成字形轮廓，再并入裁剪路径；默认按 Fill 处理。
- 不同 Area 使用不同 `FillRule`（nonzero/evenodd）时，单条路径无法同时表达；v1 取第一个 Rule 并 warning，v2 再支持逐 Area 合成。
- `Clips` 的 `TransFlag` 当前忽略；OFD 1.1 的扩展裁剪属性 warning。
- 裁剪区本身不做抗锯齿补偿；边缘可能比参考渲染器略硬，这是 Canvas 的限制。
- 样本验证：`testPathClip.ofd` 的 `Clip/Area CTM="0.3528 0 0 0.3528 0 0"`，`Path Boundary` 是 1163.5759×802.012，路径坐标也在千级；不做 `Area.CTM` 会完全对不上。

### 10.5 页尺寸回退

```
page.Area.PhysicalBox
  ?? template[按引用顺序第一个带 Area].Area.PhysicalBox
  ?? document.CommonData.PageArea.PhysicalBox
  ?? A4 (210 x 297, origin 0,0)
```

标准说“模板页中的定义”，没有说多个模板选哪个。业务确认口径：按页面 `Template` 的引用顺序，取**第一个**带 `Area/PhysicalBox` 的模板，不按 `ZOrder` 选；若多个模板尺寸不同，warning 并记录实际来源。

已用 `ofd_pdf_match/testImageOverridePage.ofd` 验证：页面本身没有 `Area`，模板 `Area` 是 369.3583×258.9389，`CommonData/PageArea` 是 210×297；按本口径应取模板尺寸，而不是 CommonData 的 A4。

- 只使用 `PhysicalBox`，不用 `ApplicationBox`/`ContentBox` 裁剪页面；它们是显示/版心区域，阅读器通常显示整个物理页。
- `PhysicalBox` 的宽或高 <=0 时视为缺失，继续回退并 warning；不要生成 0×0 画布。
- `PhysicalBox` 的 x/y 按标准规范应为 0（表 7：物理盒左上角就是页面空间原点）；只有少数生成器会把内容坐标写成含页偏移的绝对坐标，此时才用 `S × T(-x,-y)` 把物理盒左上角挪到设备原点。
- x/y 非零时发 `W_PHYSICALBOX_ORIGIN` 并记录；若内容坐标本身已经相对物理盒（标准合规文件），再做平移会整体偏移，因此黄金图需要覆盖这一分支。当前 `ofd_pdf_match` 的 55 个样本 x/y 全部为 0，不能作为非零分支的验证依据。

### 10.6 Viewport 与 Canvas 尺寸（用户负责）

`page.getViewport({ dpi })` 只计算页面在指定 DPI 下的像素尺寸：

```ts
interface Viewport {
  width: number;    // device px
  height: number;   // device px
  dpi: number;      // 输出精度，默认 96
}

const viewport = page.getViewport({ dpi: 96 });
// width  = pageWidthMm  * dpi / 25.4
// height = pageHeightMm * dpi / 25.4
```

- **engine 不设置 canvas.width/height、不设置 CSS 尺寸、不清屏、不做 devicePixelRatio 补偿**；canvas 的创建/尺寸/背景/复用全部由用户负责。
- 典型调用：

```ts
const viewport = page.getViewport({ dpi: 144 });
canvas.width = Math.ceil(viewport.width);
canvas.height = Math.ceil(viewport.height);
const task = page.render({ canvasContext: canvas.getContext('2d')!, viewport });
```

- `dpi=96` 是默认精度；`dpi=144/300` 用于更高精度输出。没有 `scale`/`rotation`/`pixelRatio`。
- 页面到 viewport 的变换固定为：

```
M_page = S(dpi / 25.4) × T(-PhysicalBox.x, -PhysicalBox.y)
       = [s, 0, 0, s, -s·PhysicalBox.x, -s·PhysicalBox.y]    // s = dpi / 25.4
```

- `page.render` 用 `setTransform(M_page)` 绝对设置变换，会**覆盖宿主在 context 上预置的 CTM**；宿主不要通过 `ctx.scale/rotate` 做 DPR 或视图适配。DPR 用 `dpi = 96 × devicePixelRatio` 表达（canvas 的像素尺寸仍由宿主设置）；需要额外视图变换时，在 render 前/后自行处理，或改用离屏 canvas。
- `page.render` 校验 `canvasContext.canvas` 的 `width/height` 至少覆盖 `viewport.width/height`；不足时抛 `OFD_CANVAS_SIZE_MISMATCH`，不静默裁剪。
- 按兼容口径（x/y 非零）时，内容已经由 `T(-x,-y)` 平移到 0 起，`viewport` 尺寸仍按宽高计算，不额外加上 `x/y`。
- `maxCanvasPixels` 仍然生效：`viewport.width * viewport.height` 超限直接拒绝。
- 不旋转页面；`rotation` 是阅读器视图控制，不是页面内容。

### 10.7 原子性与取消

- 绘制循环每个对象检查一次 `signal.aborted`；中止则停止。
- 为避免“画了一半”留在目标 Canvas：
  - engine 不做整页离屏原子提交；取消后目标 Canvas 内容未定义，由宿主清屏/重绘；
  - H5 的 group scratch 只用于局部合成，取消时丢弃，不自动提交到目标；
  - 需要原子提交的宿主可自行使用双 canvas 交换，engine 不干预。
- `page.render` 对同一个 Canvas 加锁：同一 Canvas 同时只允许一个渲染任务；不同 Canvas 可并行。

---

## 11. 图元渲染

### 11.1 路径

`AbbreviatedData` 命令：

| 命令 | 参数 | 语义 |
|---|---|---|
| `S` | `x y` | 新子路径起点（moveTo） |
| `M` | `x y` | 新子路径起点（同 S，兼容） |
| `L` | `x y` | 直线 |
| `Q` | `x1 y1 x2 y2` | 二次贝塞尔 |
| `B` | `x1 y1 x2 y2 x3 y3` | 三次贝塞尔 |
| `A` | `rx ry angle large sweep x y` | 椭圆弧 |
| `C` | 无 | 闭合当前子路径 |

实现要点：

- Tokenizer 支持空白/逗号分隔、负数、小数、科学计数法；操作符大小写不敏感（容错）。
- 参数数量不足/多余：跳过该命令并 warning；不要整条路径丢弃（能画多少画多少）。
- `A` 圆弧：
  - 按 SVG 端点参数化转中心参数化；
  - `rx/ry` 为 0 或起点=终点 → 退化为直线；
  - 每段最大 90°，用三次贝塞尔近似；
  - `sweep` 方向与标准一致；`large` 选择大弧。
- 填充：
  - `Fill=true` 才填充；
  - `Rule` 为 `nonzero`/`evenodd`；
  - `FillColor` 缺失 = 透明，不画；
  - 填充后再描边。
- 描边：
  - `Stroke=true` 才描边；
  - `LineWidth` 按对象空间 mm；Canvas 当前变换会把它换算成设备像素；
  - `LineWidth=0`：设备空间 hairline（见第 3 节）；
  - `DashPattern` 至少两个正数才生效；`DashOffset` 仅在虚线时有效；
  - `Cap`/`Join`/`MiterLimit` 映射到 Canvas。
- 零长度子路径：Canvas 描边可能画点；按标准保留。
- 大路径（>50k 命令）分块构建/绘制，避免单次路径过大。

### 11.2 文字

见第 12 节。

### 11.3 图像

图像对象局部空间是**单位正方形** `(0,0)-(1,1)`：

```
设备 = M_page × T(boundary.x, boundary.y) × CTM
```

- 有 `CTM`：`ctx.translate(bx,by); ctx.transform(ctm); ctx.drawImage(img, 0, 0, 1, 1)`。
- 无 `CTM`（业务确认：严格标准）：
  - 默认按 identity 画 `drawImage(img, 0, 0, 1, 1)`，即 1×1 对象单位；
  - `strictImageCtm=false` 时才按 `Boundary` 铺满（仅用于兼容明确的坏文件）；
  - 缺失 CTM 时发 `W_IMAGE_NO_CTM`，不要静默猜测。
- `Boundary` 裁剪在 `CTM` 之前，和路径/文字一致。
- 边框：
  - 在对象空间 `(0,0,boundary.w,boundary.h)` 画圆角矩形；
  - 圆角半径 `HorizontalCornerRadius`/`VerticalCornerRadius`，分别处理 x/y；
  - 边框 `LineWidth=0` 不画（与路径的 `LineWidth=0` hairline 不同）；
  - 虚线从左上角开始、顺时针；
  - 颜色默认黑，alpha 相乘。
- 蒙版 `ImageMask`：
  - 要求与主图同尺寸的二值图；
  - 解码为 alpha mask（0/255）；
  - H5 renderer 在内部 scratch 上先画主图，再 `globalCompositeOperation='destination-in'` 画蒙版；engine 不接触 scratch；
  - H5 内部可缓存“主图+蒙版”的结果；自定义渲染器可用原生 mask。
- `Substitution`：按 9.2 选择；替换图也按单位正方形绘制。
- `imageSmoothingEnabled=true`；缩小大图时质量优先。
- 样本验证：`testPathClip.ofd` 的模板图片 `CTM="410.4838 0 0 282.9323 0 0"`，`Boundary` 同尺寸；`testImageOverridePage.ofd` 的 `CTM="0 296.8414 -419.9467 0 419.9467 0"` 是旋转 90°，`Boundary="-50.8 0 419.9467 296.8414"`。两者都只有把图片当单位正方形、再乘 `CTM` 才能正确落位。

### 11.4 复合对象

复合对象是 `IndependentBlock(source='composite')`，直接复用 11.7 的块机制：

```
drawComposite(obj):
  unit = resourceStore.getComposite(obj.resourceId)
  block = blockStore.getCompositeBlock(unit)   // 块内空间 [0,Width×0.3528]×[0,Height×0.3528]
  M = M_page × T(boundary.x,boundary.y) × CTM
  drawIndependentBlock(block, M, obj.alpha)
```

- 块内内容按 `PageBlock` 规则绘制；`Boundary` 只裁剪，不把内容拉伸到 `Boundary`。
- `CompositeGraphicUnit` 的 `Width/Height` 采用 **0.3528 mm 单位**，内容坐标范围是 `[0, Width×0.3528] × [0, Height×0.3528]`；不要直接把 `Width/Height` 当 mm。
- 如果 `Boundary` 比内容范围大，内容保持原尺寸，多出的区域透明；如果更小，超出部分被裁掉。
- 复合对象的 `DrawParam` 作为子对象的继承默认值；子对象自己的内联属性覆盖。
- 递归深度 16；循环引用检测；超限 warning + 跳过。
- 组透明度：由 11.7 的块整体合成处理，避免逐子对象 alpha 导致重叠区域偏深。
- 样本验证：
  - `发票监制章-数科.ofd`：`CompositeGraphicUnit Width=342.9921 Height=235.2756`，乘以 0.3528 得 121.0×83.0；内容 `ImageObject Boundary="0 0 121 83"` 正好吻合；外层 `CompositeObject Boundary="0 0 42.6861 29.2806" CTM="0.3528 0 0 0.3528 0 0"`。
  - `intro-数科.ofd`：`Width=2653.6313` → 936.2，内容路径边界 918.1；外层 `Boundary=330.2501`、`CTM=0.3528`。
  - `testPathClip.ofd`：`Width=3782.376` → 1334.3，内容图片边界 1334.3341；外层 `Boundary=470.7248`。

### 11.5 PageBlock

- 仅分组，没有 `Boundary`/`CTM`/`Alpha`。
- 按 `children` 顺序递归；继承父级 draw params。
- 嵌套深度限制 32。

### 11.6 注释与签章外观

红章、骑缝章、水印、高亮通常不在 `Content.xml`，而在 `Annotations` 里。v1 只做**静态外观**，不做签名验证、批注交互。实现上把整个 `Appearance` 当作 `IndependentBlock(source='annotation')`，复用 11.7 的显示列表和 group 合成，而不是单独写一套绘制循环。

加载：

```
Document.xml/Annotations -> Annotations.xml
  -> Page PageID="..." FileLoc="..."
  -> PageAnnot/Annot
```

- `Annotations` 是 `Document.xml` 的可选子节点，路径相对 `Document.xml` 解析；`FileLoc` 可以是 `/Doc_0/...` 这种包内绝对路径，统一去掉前导 `/`。
- `PageID` 对应页树里的 `Page ID`，**不是页索引**；不要按数组下标猜。
- 分页注释文件懒加载：准备某页时才读该页的 `PageAnnot`，不因打开文档而扫描全部注释。
- `Annot` 关键属性：
  - `Type`：`Link`/`Path`/`Highlight`/`Stamp`/`Watermark`，未知类型按 `Appearance` 画，没有 `Appearance` 就跳过；
  - `Visible`：默认 `true`，`false` 直接跳过；
  - `NoZoom`/`NoRotate`/`Print`：属于阅读器/打印控制提示，engine **不解释**；只画 `Appearance` 的静态外观；
  - `Appearance`：`CT_PageBlock`，静态外观；可能为空（真实样本 `v4signed.ofd` 的 Stamp 就是空外观），空则 warning + 跳过。
- `Appearance` 自带 `Boundary`，子对象坐标相对这个 `Boundary` 的左上角；变换顺序：

```
M_annot = M_page × T(appearance.boundary.x, appearance.boundary.y)
```

  不能直接把 `Appearance` 子对象当页面坐标画，否则红章会跑到页面左上角。绘制前按 `Appearance.Boundary` 做一次裁剪，防止外观越界。

绘制：

- 在页面所有图层之后绘制，按 `PageAnnot` 中 `Annot` 的文件顺序，后出现覆盖前面。同一 `Appearance` 子树在多个位置/多页出现时，显示列表只构建一次；平移/缩放不改变显示列表，`M_annot` 负责落位。
- `Appearance` 内部按 `PageBlock` 规则绘制；`Stamp` 的红章通常是 `CompositeObject`，按 11.4 处理。
- 注释块变换只有一条：
  - `M_annot = M_page × T(Appearance.Boundary.x, Appearance.Boundary.y)`；
  - 不再有 `NoZoom`/`NoRotate` 的单独矩阵，也没有 `scale/pixelRatio/rotation`。
- `NoZoom`/`NoRotate`/`Print` 是阅读器/打印控制提示，engine 不实现；如果宿主需要，由宿主在显示/打印时处理，不能反向污染页面内容渲染。
- 注释始终渲染所有 `Visible=true` 的静态外观；没有 `annotations: all/print/none` 选项。
- 只做外观，不做链接跳转、批注回复、表单填写、签名验证。`Signatures/*/Signature.xml` 的 `StampAnnot` 用于定位/关联；有 `Annotations` 外观时优先按 `Appearance` 绘制，没有 `Annotations` 时按 `StampAnnot + Seal.esl/SignedValue.dat` 的静态签章绘制（见 11.6.1）。
- `v4signed.ofd` 的 Stamp `Appearance` 为空，说明不能假设“有 Signatures 就一定有可画的红章”；空外观必须 warning + 跳过，不能崩页。
- 资源作用域：`Appearance` 里的 `ResourceID` 按“页面 PageRes → 文档级 PublicRes/DocumentRes”查找；不要只查 DocumentRes。
- 资源限制与页面内容共用：注释里的图片/字体同样走 `ResourceStore` 和 `ImageDecoder`，不能绕过 zip bomb/像素上限。

样本验证：

- `testPathClip.ofd`：`Document.xml/Annotations` 指向 `Annots/Annotations.xml`；`Page PageID="1"`；`Annot Type="Watermark"` 的 `Appearance Boundary="0 0 419 295"`，内部 `ImageObject` 用 CTM 画 150×150 PNG。
- `发票监制章-数科.ofd`：`Annot Type="Stamp"`，`Appearance Boundary="166.8639 106.1897 42.6861 29.2806"`，内部 `CompositeObject Boundary="0 0 42.6861 29.2806" CTM="0.3528 0 0 0.3528 0 0"`；PDF 对应页的红章在右下角，验证了“Appearance 平移 + Composite 映射”。
- `signout.ofd`：同一页 3 个 Stamp，按文件顺序叠加；`20240531141733.ofd` 的水印带 `NoRotate="true"`，engine 仍按页面内容绘制其 `Appearance`，标志不参与变换。
- `pattern类型.ofd`：`Watermark` 的 `Appearance` 用 `Pattern` 画 45°“严禁复制”；底纹若未完成，注释只能降级为平均色/跳过，必须显式 warning。

#### 11.6.1 签章来源与 ASN.1 版本（v1 扩展）

签章不一定有可画的 `PageAnnot/Appearance`。真实文件存在两种静态签章来源，v1 都要支持：

1. `Signatures/Signatures.xml → Sign_i/Signature.xml → Seal.esl`：`Seal.esl` 是 ASN.1 DER 的 `SESeal`，图片在 `SES_SealInfo` 的 `SES_ESPictrueInfo` 内。
2. `Signature.xml → SignedValue.dat`：`SignedValue.dat` 是 `SES_Signature`，`TBS_Sign` 内嵌 `SES_SealInfo`；印章图片同样在 `SES_ESPictrueInfo` 内。不能再只读 `Signature.xml` 的 `<Seal>` 元素，否则真实文件的章会整块丢失。

版本不能靠固定字段或文件名判断，必须按 ASN.1 结构推断（与 `VersionParser` 一致）：

- `Seal.esl` 顶层 SEQUENCE：
  - size=2 → v1；
  - size=4 → 读 `SealInfo[0] → Header[0] → version(index 1)`，version=5 才是 v5，否则 v4；
  - size=5 → v5；
  - 其他 → 未知结构，warning，不崩页。
- `SignedValue.dat`（`SES_Signature`）顶层：
  - size=2 → v1；
  - size=4–5 → `TBS_Sign[0] → eSealInfo[1] → Header[0] → version`，version=5 为 v5，否则 v4；
  - 其他 → warning。
- v1/v4/v5 的 `SealInfo` 都是 `[header, esID, property, picture, extDatas?]`；`picture` 固定第 4 个字段（index 3），其 `SES_ESPictrueInfo` 为 `[type, data, width, height]`，`width/height` 单位 mm。

图片与矢量章：

- `picture.type` 为 `PNG`/`JPG`/`JPEG` 时按位图解码；`type` 大小写不敏感，格式识别失败时再用魔术字节兜底。
- `picture.type` 为 `ofd` 时，`picture.data` 是内嵌的矢量 OFD ZIP（不是图片）；v1 解析其首页并按 `StampAnnot` 尺寸/位置渲染，不能当作普通图片丢给 `createImageBitmap`。
- 矢量 OFD 章可能只含 `PathObject`/文字，没有图片资源；渲染路径复用页面 prepare/draw，不另写一套签章绘制循环。
- 位图章常见全不透明白底（alpha=255）。签章位图必须用 `multiply` 合成，让白底不遮正文；普通 `ImageObject`/注释图片仍用 source-over，不能全局改混合模式。
- 不做证书链、签名值、时间戳的密码学验证；只取 `SES_SealInfo` 的静态图片/矢量内容。

定位与绘制：

```
Document.xml/Signatures -> Signatures.xml
  -> Sign_i/Signature.xml
  -> SignedInfo/StampAnnot(PageRef, Boundary, Clip)
  -> Seal.esl 或 SignedValue.dat
```

- `PageRef` 是页 ID，不是页索引；按页树映射为 index 后再过滤。
- `StampAnnot.Boundary` 是章在页面上的外接矩形；`Clip` 是骑缝章跨页切片，按页分别裁剪，不能整章重复画到每页。
- 绘制顺序在页面所有图层和 `PageAnnot` 之后；有 `PageAnnot/Appearance` 时优先用 `Appearance`，避免同一枚章画两次。
- 无 `Seal`/`SignedValue`、坏 DER、坏 ZIP、空图片都 warning 后跳过该戳记，不崩页；同一 `SealImage` 多页/重渲染复用解码结果。

样本验证：

- `h.ofd`：2 个签章、6 个戳记，v4 PNG 40×40mm，跨页 `Clip` 0–8/8–16/16–24/24–32/32–40，右缘 8mm 切片 + 完整章。
- `V4RideRight.ofd`：1 个签章、5 个戳记，v4 PNG 42×42mm，骑缝切片正确。
- `keyword.ofd`：`Seal.esl` 为 v4 PNG，但图片全不透明白底；用 multiply 后白底不遮表格文字。
- `不规范资源路径.ofd`：`Signature.xml` 无 `<Seal>`，章在 `SignValue.dat` 的 `SES_SealInfo` 内（PNG）。
- `SignScaleError.ofd`：`SignedValue.dat` 的 `picture.type=ofd`，内嵌 104×84 矢量 OFD 章；按矢量章渲染，不能按位图解码。

### 11.7 独立空间块：注释、复合对象、底纹共用

水印/签章本质上和复合对象一样，在独立空间里画完，再整体映射回页面；同一内容可以复用显示列表。

```ts
interface IndependentBlock {
  id?: ResourceId;
  /** 块内坐标范围；子对象坐标从 (0,0) 开始 */
  space: { width: number; height: number };
  content: PageBlock;
  /** 块内目标无关的绘制命令；与 dpi/平移无关 */
  displayList: DisplayList;
  source: 'composite' | 'annotation' | 'pattern-cell' | 'pageblock';
  /** 块内对象继承的起点；Composite 用外层样式，Annotation/Pattern 用文档默认值 */
  styleRoot: ResolvedStyle;
  /** 显示列表缓存身份：资源 ID + 内容哈希 + styleRoot 哈希 + DrawParam 哈希 */
  cacheKey: string;
}
```

三类来源的映射：

| 来源 | 块内空间 | 回到页面的变换 |
|---|---|---|
| Composite | `[0,Width×0.3528] × [0,Height×0.3528]` | `M_page × T(Boundary.x,y) × CTM` |
| Annotation Appearance | `[0,Boundary.w] × [0,Boundary.h]` | `M_page × T(Boundary.x,y)`；阅读器标志不参与 |
| Pattern CellContent | `[0,Pattern.Width] × [0,Pattern.Height]` | 先按 `XStep/YStep` 排列，再整体 `Pattern.CTM` |

`drawIndependentBlock` 的核心形态：

```ts
function drawIndependentBlock(block, matrix, alpha, isolated = false, composite = 'source-over') {
  const identity: Matrix = [1, 0, 0, 1, 0, 0];
  renderer.save();
  renderer.beginPath();
  renderer.rect(0, 0, block.space.width, block.space.height);
  renderer.clip('nonzero');

  const needGroup = alpha < 1 || isolated || composite !== 'source-over';
  if (needGroup) {
    renderer.beginGroup({
      bounds: { x: 0, y: 0, w: block.space.width, h: block.space.height },
      matrix,
      alpha,
      isolated,
      composite,
    });
    renderer.setTransform(identity);
    replay(block.displayList);
    renderer.endGroup();
  } else {
    renderer.setTransform(matrix);
    replay(block.displayList);
  }

  renderer.restore();
}
```

- `matrix` 只由 `beginGroup` 或直接 `setTransform` 应用一次；group 内不再重复乘 `matrix`。
- `alpha=1` 且不需要隔离时直接回放，避免无意义的 scratch；需要整体 alpha/混合时才开 group。
- `clip` 在 group 外先应用，group 内部继承父级 clip。

绘制策略：

1. **先记录显示列表**：块内按 `PageBlock` 规则遍历一次，文字转成字形路径、图片解码成 bitmap、渐变/底纹解析成绘制命令；所有坐标保持块内坐标，不叠加页面变换。
2. **优先回放显示列表**：`setTransform(M_block)` 后按命令回放。矢量/文字在任意 `dpi` 下都清晰，显示列表与 dpi 无关。
3. **需要整体合成时才开 group**：块有组透明度、混合模式、图像蒙版、裁剪交叉时，调用 `renderer.beginGroup({ bounds, matrix, alpha, isolated, composite })`，块内对象照常绘制，`endGroup` 时整体合成。group 的 scratch canvas 由 H5 renderer 内部用 `CanvasFactory` 创建/销毁；SVG/PDF 用原生 group，engine 都看不到 surface。
4. **alpha 只在 group 结束时应用一次**：块内子对象按 1.0 画，`endGroup` 乘块 alpha，避免重叠区域被重复压暗。
5. **缓存分层**：
   - `displayListCache`：按 `cacheKey`，与 dpi 无关；
   - 不设 engine 级 raster cache；group scratch 是 renderer 内部的短生命周期资源；
   - 字形/图片仍走各自的缓存，不重复。
6. **嵌套**：注释里可以有 Composite，Composite 里可以有 Pattern；独立块可以嵌套，但递归深度统一受 16 限制，且缓存 key 要包含子块版本。
7. **变换与裁剪**：
   - 块回放前先 `clip` 到块空间 `(0,0,space.width,space.height)`；
   - 页面/对象的裁剪在 `M_block` 之外先应用；
   - 块内子对象自己的 `Boundary`/`CTM` 照常生效。
8. **复用边界**：
   - 同一 `ResourceID` 的 Composite/Pattern 天然可复用显示列表；
   - 注释没有资源 ID 时，用 `Appearance` 子树的规范化哈希做 key；同页多个相同水印、跨页相同红章都能命中；
   - `DrawParam` 继承不同则 key 不同，不能混用；
   - 显示列表复用不等于栅格复用：每次绘制仍由 renderer 重新执行命令/开 group，这是 pdf.js 的行为。

这样：
- 注释/签章不再单独写一套“平移 + 画 Appearance”的临时代码；
- 复合对象和底纹复用同一套显示列表；
- 水印 `Pattern` 只是“注释块里的一个底纹块”，嵌套关系清晰；
- `NoZoom/NoRotate` 是阅读器提示，不参与 `M_block`，也不需要改块内内容。

#### 11.7.1 与现有章节的关系

- 11.4 复合对象：用 `IndependentBlock(source='composite')`，不要再单独维护一份绘制逻辑。
- 11.6 注释/签章：用 `IndependentBlock(source='annotation')`；`Appearance` 就是块内容。
- 13.4 底纹：`CellContent` 用 `IndependentBlock(source='pattern-cell')`；tile 由 renderer 内部生成，engine 不持有 tile surface。
- 页面本身不整体做独立块，否则会失去按图层顺序与页面级裁剪的控制。

#### 11.7.2 测试

- 同一红章在 10 页重复：display list 只构建一次；每次绘制 group 由 renderer 内部开/关；
- 同一水印在不同位置：显示列表复用，`M_block` 平移不影响 key；
- 不同 alpha / DrawParam：key 不同，不串图；
- 组透明度：renderer 内部整体合成，重叠处不加深；
- 嵌套 Composite→Pattern→Text：递归/裁剪/显示列表正确；
- 阅读器标志不参与块变换；显示列表与 dpi 无关。

---

## 12. 文本与字形

这是引擎的核心差异点，单独展开。

### 12.1 fontkit 能力与边界（已实测）

在 `fontkit@2.0.4` 上验证：

- 能解析缺少 `cmap`/`name`/`OS/2` 的剥离子集 TTF；
- `font.getGlyph(gid)` 能返回字形轮廓；
- `font.glyphForCodePoint(cp)` 在 `cmap` 存在时可用；
- CFF CID 字体上 `font.getGlyph('高')` 可能报错（内部映射缺失），必须用 `glyphForCodePoint` 或 `getGlyph(gid)`；
- 无 `cmap` 时 `font.hasGlyphForCodePoint(cp)` 可能抛异常，必须先判断 `font.cmap` 是否存在或 `try/catch`；
- 字形路径命令为 `moveTo/lineTo/quadraticCurveTo/bezierCurveTo/closePath`，可直接转 Canvas 路径。

因此封装一层 `FontFace`，不把 fontkit 对象暴露给渲染器：

```ts
interface FontFace {
  key: string;                     // 字体缓存键
  family: string;
  postscriptName?: string;
  unitsPerEm: number;
  numGlyphs: number;
  hasCmap: boolean;
  weightClass?: number;
  italicAngle?: number;
  glyphForCodePoint(cp: number): Glyph | null;
  glyph(gid: number): Glyph | null;
}

interface Glyph {
  id: number;
  advanceWidth: number;            // 字体单位
  path: PathCommand[];             // 字体单位，y 向上
}
```

### 12.2 字体解析与回退

字体来源分三层，但**不把某套 CJK 字体硬编码进引擎**：

1. **内嵌字体**（`FontResource.FontFile`）——最高优先级；
2. **`FontProvider`**——由宿主提供，按 `FontName`/`FamilyName`/`Charset`/`Bold`/`Italic`/`Serif`/`FixedSize` 匹配：
   - **注入式**：宿主把字体字节/URL/路径放进 provider（Web、小程序、Electron 都可用）；
   - **本地读取**：环境允许时，Node 扫描系统字体目录，浏览器可用 `queryLocalFonts()`（需权限/用户手势）；小程序没有本地字体，只能注入；
3. **`supplementaryFonts`（可选）**——宿主显式注入的补充字体列表，按顺序用于缺字/缺字体回退；不传就没有补充，只 warning。

回退是**逐字形**的，不是逐对象：

```
resolveGlyph(cp, explicitGid, primary, style):
  if explicitGid != null:
    g = primary.glyph(explicitGid)
    if g: return { face: primary, glyph: g }
  if primary.hasCmap:
    g = primary.glyphForCodePoint(cp)
    if g && g.id != 0: return { face: primary, glyph: g }
  for face of fallbackChain(style):
    if face.hasCmap:
      g = face.glyphForCodePoint(cp)
      if g && g.id != 0: return { face, glyph: g }
  return null   // 或 .notdef
```

要点：

- `gid=0` 通常是 `.notdef`；除非字符本身就是 U+0000，否则视为缺失。
- 显式 gid 只对主字体有意义；主字体找不到时再按 code point 回退。
- 回退字体可能改变字宽；有 `DeltaX` 时以 `DeltaX` 为准，没有时才用回退字体的 advance。
- 没有字形时：
  - 默认画 `.notdef`（如果存在），否则跳过；
  - 每次对象只 warning 一次，避免刷屏。
- 样本验证：`testImageOverridePage.ofd` 的 `Font ID="7" FontName="宋体"` 没有 `FontFile`，必须由 `FontProvider` 提供；本机有 Noto CJK/文泉驿时可由 Node provider 匹配，Web/小程序则必须注入。
- 字体族名别名（大小写/空格/中文名）：
  - `宋体` ↔ `SimSun`，`黑体` ↔ `SimHei`，`楷体` ↔ `KaiTi`，`仿宋` ↔ `FangSong`，`微软雅黑` ↔ `Microsoft YaHei`；
  - 别名表可由宿主扩展。

### 12.3 字形映射与 CGTransform

`CGTransform` 描述“字符编码 → 字形索引”的多对一、一对多、多对多关系。

> 本文所有“字符位置/数量”均按 **Unicode 码点** 计数，不按 JavaScript 的 UTF-16 `string.length`。含代理对的字符（如 emoji）必须先 `Array.from(text)` 拆成码点，否则 `CodePosition` 和 `DeltaX` 会错位。

解析：

- 位置：`TextCode` 子节点、`TextCode` 前一个兄弟节点、`TextObject` 子节点都接受；
- 属性：`CodePosition`（兼容 `CodecPosition`）、`CodeCount`（兼容 `CodecCount`）、`GlyphCount`、`Glyphs`（子元素或属性）；
- `CodePosition` 是**当前 TextCode 内**的字符起始位置（从 0 开始），不是整个 TextObject 的全局位置；
- 一个 `TextCode` 可以有多个 `CGTransform`，按 `CodePosition` 排序后应用；
- `Glyphs` 解析为整数数组；数量与 `GlyphCount` 不一致时以实际数组为准并 warning。

映射与绘制算法（按图 67–70 的“字形序列”理解）：

`CGTransform` 给出的是一段**字形序列**，不是“每个字符各自对应哪些字形”的完整分组表。因此不要试图把 glyph 逐个分配到字符格；正确做法是：

1. 以 `CodePosition` 为起点，取 `CodeCount` 个字符作为一个 **run（字形串）**；
2. 按 `Glyphs` 的顺序绘制这串字形；
3. 整串绘制完后，按这 `CodeCount` 个字符的 `DeltaX/DeltaY` 之和推进 pen；
4. 这 `CodeCount` 个字符不再单独出字。

```
buildUnits(cps, cgTransforms, face):
  units = []
  i = 0
  while i < cps.length:
    t = cgTransformStartingAt(i)       // CodePosition == i，已排序
    if t:
      span = max(1, t.codeCount)
      glyphs = t.glyphs               // 保持顺序；不要按字符切分
      units.push({ cpStart: i, span, glyphs })
      i += span
    else:
      units.push({ cpStart: i, span: 1, glyphs: [mapChar(cps[i], face)] })
      i += 1
  return units
```

布局：

```
for unit of units:
  runPen = pen
  for gid of unit.glyphs:
    g = face.glyph(gid) ?? fallbackByChar(...)
    drawGlyph(g, runPen, charDirection, size, hScale)
    runPen += dir * glyphAdvance(g)   // 字形串内部按字体 advance 排
  dx = sumDeltaX(unit.cpStart, unit.span) ?? sumFallbackAdvances(unit.cpStart, unit.span)
  dy = sumDeltaY(unit.cpStart, unit.span) ?? 0
  pen += dir * (dx, dy)
```

按变换类型解释：

- **1:1**：run 一个字形，span=1；画在 pen，按 `DeltaX[0]` 推进。
- **N:1（连字）**：run 一个字形（如 `f`+`l` → `ﬂ`），span=N；画在第一个字符的 pen，整串结束后按 N 个字符的 delta 之和推进。
- **1:N（一个字符多个字形）**：run 有 N 个字形，span=1；字形按字体 advance 依次排，整串结束后按该字符的 `DeltaX[0]` 推进。若字形总宽超出字符格，允许溢出，不强行压缩。
- **N:M**：run 有 M 个字形，span=N；M 个字形按顺序、按字体 advance 排，整串结束后按 N 个字符的 delta 之和推进。图 69 的 2 字符→3 字形就是这种：三个字形连续绘制，字符格只决定整串的总宽度。
- `GlyphCount` 只用于校验/诊断；实际以 `Glyphs` 数组长度为准。
- 如果 `Glyphs` 数量与 `CodeCount` 不匹配，仍按上述规则绘制，warning；不要擅自把字形按比例分配到字符。
- 如果 run 的总字形 advance 大于字符格总宽，后一个字可能重叠；这是文档/字体本身的问题，默认不压缩（与标准示例一致），可提供 `fitGlyphRun` 兼容开关。
- `CodePosition` 越界、`CodeCount<1`、空 `Glyphs`：跳过该变换并 warning；对应字符退回逐字符 cmap 映射。

### 12.4 文字布局

对每个 `TextCode`：

```
startX = code.x ?? prevX ?? 0
startY = code.y ?? prevY ?? 0
prevX = code.x ?? prevX
prevY = code.y ?? prevY
pen = (startX, startY)
units = buildUnits(...)          // 每个 unit：cpStart/span/glyphs[]
dir = readDirection == 0   ? (+1,  0)
    : readDirection == 90  ? ( 0, +1)
    : readDirection == 180 ? (-1,  0)
    :                        ( 0, -1)   // 270
for unit of units:
  runPen = pen
  for gid of unit.glyphs:
    g = face.glyph(gid) ?? fallbackByChar(...)
    drawGlyph(g, runPen, charDirection, size, hScale)
    runPen += (dir.x * glyphAdvance(g), dir.y * glyphAdvance(g))
  dx = sumDeltaX(unit.cpStart, unit.span) ?? sumFallbackAdvances(unit.cpStart, unit.span)
  dy = sumDeltaY(unit.cpStart, unit.span) ?? 0
  pen += (dir.x * dx, dir.y * dy)
```

关键决策：

- `X/Y` 缺省采用**上一个 TextCode 的 X/Y**，不是上一个 pen 的终点。
- `DeltaX[i]` 表示第 i 个字符的步进/字位宽度：从第 i 个字符推进到第 i+1 个字符；最后一个值只描述最后一个字位，不产生下一个字符，多余时忽略。图 62 中 4 个字标注了 DeltaX0–DeltaX3，最后一个就是最后字位宽度，不能再推一个字。方向由 `ReadDirection` 决定（180/270 取负）。多对一/一对多/多对多时，按 `unit.span` 把覆盖字符的 delta 求和，作为整串结束后的 pen 步进。
- `DeltaX` 数量不足：后面的字符用字体 advance；数量多：多余忽略并 warning。
- 显式 0：尊重 0（字符重叠），不要当成缺失。
- 非法 token：跳过，用上一个合法值或字体 advance；warning。
- `g <count> <value>` 是合法压缩写法（真实文件常见，例如 `DeltaX="g 3 3.1305"`），必须先展开，不能当坏 token 丢弃。
- 没有 `DeltaX`：用字体 advance × `Size/upem` × `HScale`。
- 有 `DeltaY` 时同样逐字符推进；竖排通常 `DeltaX` 省略、`DeltaY` 有值。
- `ReadDirection` 不反转字符数组，而是改变步进方向：0 向右、90 向下、180 向左、270 向上。`X/Y` 始终是第一个逻辑字符的原点；因此 180/270 时第一个字符在右/下，后续字符向左/上排。依据图 63（90）和图 64（180）：`DeltaX0` 标注在逻辑首字符与次字符之间，视觉上对应最右侧/最下方的间隙。
- `CharDirection` 只旋转字形，不改变 pen 的推进方向；推进方向由 `DeltaX/DeltaY` 和 `ReadDirection` 决定。多字形串内部也沿 `ReadDirection` 的 `dir` 推进，`CharDirection` 只逐字形旋转；竖排多字形脚本属低频，先按此口径。

### 12.5 轮廓构建

字形在字体坐标中 y 向上，原点在基线。对象坐标 y 向下。

单个字形的变换（对象空间）：

```
M_glyph = T(penX, penY)
        × R(charDirection)
        × K(italicSkew)
        × S(Size/upem × HScale, -Size/upem)
```

- `R`：Canvas 矩阵 `[cos, sin, -sin, cos, 0, 0]`，正角度顺时针。
- `K`：斜体剪切 `[1, 0, -tan(12°), 1, 0, 0]`，在对象坐标中顶部（y 为负）向右倾。
- `S`：y 取负，完成字体坐标到对象坐标的翻转。
- 若 `HScale != 1`，只缩放 x。
- 若字体本身是斜体/粗体，不重复合成。
- 图 65：`CharDirection` 只让字形绕当前绘制点旋转；`TextCode` 的 `X/Y` 仍是对象坐标系下的绘制点，不要因为字形旋转就改用旋转后包围盒重新解释 X/Y。

构建：

```
for each glyph:
  for cmd of glyph.path:
    p = transform(M_glyph, cmd.point)
    ctx.moveTo/lineTo/quadraticCurveTo/bezierCurveTo(p)
  closePath
```

- 所有字形合成一条路径，最后一次 `fill('nonzero')`；避免每个字形单独 fill 造成接缝。
- 描边：同一条路径 `stroke()`；线宽来自 DrawParam/LineWidth（默认 0.353mm）。
- 填充/描边颜色可以是纯色、渐变、底纹；渐变按 13 节。
- 文字路径可能很大：单对象 >5000 字形时分批构建/填充，降低峰值内存。
- `Boundary` 裁剪仍生效；若 `Boundary` 为零尺寸，按业务口径**直接跳过该文字对象**，warning。

### 12.6 合成粗体/斜体

当 `TextObject.Weight >= 600` 或 `Italic=true`，但字体本身没有对应样式时：

- **粗体**：
  - 先正常填充；
  - 再用同色描边，`lineWidth = Size × 0.02`（约增加 1% 字重），`lineJoin='round'`；
  - 若对象本身还有描边，叠加而不是替换；
  - 可通过 `syntheticBold: false` 关闭。
- **斜体**：
  - 在字形变换中加入 `K`，`tan(12°) ≈ 0.2126`；
  - 可通过 `syntheticItalic: false` 关闭。
- 判定字体是否已粗/斜：
  - `FontResource.Bold/Italic`；
  - `OS/2.usWeightClass >= 600`；
  - `head.macStyle` bold/italic 位；
  - `post.italicAngle != 0`；
  - 字体名包含 `Bold/Black/Heavy/Italic/Oblique`。
- 合成样式只影响字形轮廓，不改变 `DeltaX` 推进，避免布局漂移。

### 12.7 字体缓存

- `FontFace` 按 `fontFile` 路径缓存；同一文件多资源复用。
- 字形轮廓按 `(fontKey, gid)` 缓存，LRU 默认 20,000 个；每个轮廓是路径命令数组（字体单位），不是 Canvas 路径。
- 文字布局结果按 `(textObjectId, pageId)` 缓存到 PageModel 生命周期；页面模型被淘汰时释放。
- 不缓存 `Path2D`（小程序不可用）；如需提速，缓存“已变换到对象坐标”的命令数组，但要注意内存。

### 12.8 已知问题与对策

| 问题 | 对策 |
|---|---|
| 字体无 `cmap` | 只能用显式 gid/CGTransform；否则回退 |
| CFF CID 字符映射异常 | 用 `glyphForCodePoint`/`getGlyph(gid)`，不用 `getGlyph(char)` |
| 字体集合 TTC | 按名称匹配 face；失败取第 0 个并 warning |
| 字体损坏/加密 | 捕获异常，标记不可用，回退 |
| 字形 gid 越界 | 视为缺失，回退/跳过 |
| 空格/换行 | 空格有 advance，不画轮廓；换行不是文字内容，按字符处理 |
| 文字超出 Boundary | 按标准裁剪；`Boundary` 为零则跳过整个对象 |
| 文字方向组合 | 保持逻辑字符顺序；按 ReadDirection 选步进方向，再按 CharDirection 旋转字形 |
| 字体名缺失 | 用 FamilyName/PostScript/文件名匹配；都没有则兜底 |

---

## 13. 颜色、渐变与底纹

### 13.1 基本颜色

```ts
interface Rgba {
  r: number; g: number; b: number; a: number;  // 0..255
}
```

- `Value` 按当前颜色空间通道数解析；不足补 0，多余忽略。
- `Alpha` 默认 255；与对象 `Alpha` 相乘。
- `BitsPerComponent` 缩放；16 位按 `value/65535*255`。
- 调色板：`Index` 从 0 开始；越界 warning + 黑色/透明。
- CMYK 近似转换；ICC warning。
- 颜色值中的 `#` 前缀按十六进制解析；否则按十进制/浮点。

### 13.2 轴向渐变

```ts
interface AxialShade {
  start: Point;
  end: Point;
  mapType: 'Direct' | 'Repeat' | 'Reflect';
  mapUnit?: number;
  extend: 0 | 1 | 2 | 3;
  segments: { position: number; color: Rgba }[];
}
```

- Segment 位置：
  - 第一个默认 0，最后一个默认 1；
  - 中间缺失按区间均分；
  - 保证单调不减；越界 clamp 并 warning。
- `Direct`：
  - 用 `createLinearGradient(start, end)`，stop 用原始 position；
  - Canvas 默认在两端 clamp，正好对应 Extend 的颜色延伸；
  - 但必须按 `Extend` 裁到允许的 band，否则会把不该延伸的一侧也填上：
    - `Extend=0`：`t∈[0,1]`，两端都裁；
    - `Extend=1`：`t≤1`，只裁终点外侧；
    - `Extend=2`：`t≥0`，只裁起点外侧；
    - `Extend=3`：不裁。
  - band 用两条垂直于轴线的边界线构造，与图元路径相交后裁剪，再填充。
- `Repeat`/`Reflect`：
  - `MapUnit` 默认轴线长度；`u = (t * axisLength) / mapUnit`；
  - `Repeat` 取 `u mod 1`；`Reflect` 取三角波；
  - 为了覆盖图元 bbox，生成扩展后的 stops（最多 512 个），再建渐变；
  - 超过 512 个周期时按 512 截断并 warning（视觉上已接近纯色）；
  - 同样按 `Extend` 裁 band，规则同上。
- 渐变作用于填充/描边时，坐标都在对象空间；Canvas 当前变换会正确映射。

### 13.3 径向渐变

> **v1 状态：不实现。** 遇到 `RadialShd` 发 `W_RADIAL_UNSUPPORTED`，用第一个/平均 Segment 颜色填充，或透明跳过；不要用 Canvas `createRadialGradient` 近似（会偏离图 36）。以下算法是 v2 设计，保留给后续版本。

标准图 34/36 说明：径向渐变不是“用结束圆裁一下的 Canvas 径向渐变”，而是**沿两个椭圆中心连线扫掠一组同心率椭圆**。`Extend=0` 时只填充两椭圆之间的扫掠区域，起始椭圆内部和结束椭圆外部都为空；`Extend=1/2` 只沿中心连线方向延伸出锥形区域，不是填满整个平面。图 36 的白色孔洞和三角延伸就是这个意思。

因此：

- **不要**直接用 `createRadialGradient` 填满 bbox；它会在两端 clamp，无法表达“孔洞 + 锥形延伸”。
- 一般情况用**软件光栅化**，逐像素求参数 `t`；简单同心圆可作为快速路径。
- 先做椭圆到圆的线性变换：

```
A = R(Angle) × S(1, 1 / sqrt(1 - e²))
```

- 在圆空间里，圆心 `C0/C1`、半径 `r0/r1`；对像素点 `p` 求满足

```
|p - (C0 + t·(C1-C0))|² = (r0 + t·(r1-r0))²
```

的根。展开为二次方程：

```
a = |d|² - R²
b = -2·((p-C0)·d + r0·R)
c = |p-C0|² - r0²
d = C1 - C0, R = r1 - r0
```

- 判别式 `<0`：点不在椭圆族扫过的锥内，**无论 Extend 取何值都透明**；这正是图 36 中锥形以外的白色区域。
- 有实根时按 `Extend` 选根（不要无条件取最大根，否则可能选到区间外）：
  - `Extend=0`：只接受 `t∈[0,1]`；两根都在区间内取较大者，一根在内取在内者；
  - `Extend=1`：接受 `t≤1`，取满足条件的较大根；`t<0` 的颜色按起始端；
  - `Extend=2`：接受 `t≥0`，取满足条件的较大根；`t>1` 的颜色按结束端；
  - `Extend=3`：接受所有实根，取较大根。
  - `a≈0` 时退化为一次方程 `b·t + c = 0`，单独处理。
- 颜色按 `t` 查 Segment；`MapType`：
  - `Direct`：`u=t`；
  - `Repeat`：`u = (t·L / MapUnit) mod 1`；
  - `Reflect`：三角波；
  - `L` 默认取 `|C1-C0|`；同心时取 `|r1-r0|`，避免除零。
- 由 renderer 在内部渲染到一张带 alpha 的离屏图（按图元 bbox 的设备像素），再用路径 `clip()` 后 `drawImage`；渐变图可在 renderer 内部按参数缓存，engine 不持有 surface。
- 快速路径：`e=0`、`Direct`、`Extend=3` 且两圆同心时，可以直接用 Canvas 径向渐变；其余走软件光栅化。不要为了性能牺牲图 36 的孔洞/锥形语义。
- 性能上限：单渐变 bbox 超过 4MP 时按 1/2 分辨率渲染再放大，或 warning 降级；软件光栅化按 256×256 tile 分块，避免长任务阻塞。
- 描边使用渐变：v1 先用平均色描边 + warning；v2 用描边掩码乘渐变图。

### 13.4 底纹（Pattern）

```ts
interface Pattern {
  width: number;
  height: number;
  xStep: number;
  yStep: number;
  reflectMethod: 'Normal' | 'Column' | 'Row' | 'RowAndColumn';
  relativeTo: 'Object' | 'Page';
  ctm?: Matrix;
  cell: PageBlock;
}
```

实现：

- `CellContent` 是 `IndependentBlock(source='pattern-cell')`，先记录显示列表；tile 由 renderer 在内部生成，engine 不持有 tile surface。
- `PaintBinder` 输出 `{ kind:'pattern', tile: DisplayList, width, height, xStep, yStep, reflect, ctm }`；`tile` 是目标无关的绘制命令。
- H5 `fill` 内部用 `CanvasFactory.create(tileW, tileH)` 建临时 canvas，执行 tile display list，再：
  - `Normal` 优先 `ctx.createPattern(canvas, 'repeat')`，必要时 `pattern.setTransform`；`setTransform` 不可用时改为手动平铺；
  - `ReflectMethod` 或 `XStep/YStep` 有间隙时，按 tile 范围手动平铺/翻转；
  - 用完 `CanvasFactory.destroy`，engine 看不到 tile canvas。
- SVG 映射为 `<pattern>`；PDF 映射为 tiling pattern；自定义渲染器自行决定。
- tile 像素尺寸 = `ceil(width * pxPerMm)` × `ceil(height * pxPerMm)`；`pxPerMm = dpi / 25.4 × sqrt(|det(当前对象变换 × Pattern.CTM)|)`，不引入阅读器 scale。
- **tile 内容本身不应用 `Pattern.CTM`**；标准规定先按 `XStep/YStep` 排列，再对整个排列做 CTM。
- `XStep/YStep` 缺失或小于 `Width/Height` 时，按 `Width/Height` 处理；
- `ReflectMethod`：
  - `Normal`：不翻转；
  - `Column`：奇数列水平翻转；
  - `Row`：奇数行垂直翻转；
  - `RowAndColumn`：两者叠加；
- `RelativeTo=Page` 时，tile 原点要对齐页面 `(0,0)`；由于当前已在对象空间，需要用当前对象变换的逆把页面原点换算成对象空间偏移。
- 上限：单次填充最多 10,000 个 tile；超过 warning，按纯色近似。
- 底纹用于描边时，v1 降级为平均色 + warning（描边转填充掩码成本高）。
- 样本验证：`pattern类型.ofd` 的水印注释里，`Pattern Width=107.0079 Height=26.2257 XStep=127.0079 YStep=66.2257 CTM="0.7071 -0.7071 0.7071 0.7071 0 148.5035"`，`CellContent` 是 45° 的“严禁复制”文字；CTM 必须作用于整个平铺排列，否则每个 tile 会绕自己旋转，字距/角度都会错。

### 13.5 Gouraud/LaGouraud（v1 必做）

标准图 38/39：三角形内颜色按面积（重心坐标）线性插值。图 40：`EdgeFlag` 控制 4 个控制点组成四边形时的对角线：

- `EdgeFlag=0`：不组成四边形，按独立三角形处理；
- `EdgeFlag=1`：沿 `Vb-Vc` 对角线拆成两个三角形（菱形）；
- `EdgeFlag=2`：沿 `Va-Vc` 对角线拆成两个三角形（图 40 右）。

实现（以下为 H5 renderer 内部策略；engine 只传 `{ kind:'shading', spec }`）：

```ts
interface GouraudShade {
  points: { x: number; y: number; color: Rgba; edgeFlag?: 0 | 1 | 2 }[];
  verticesPerRow?: number;       // LaGouraud 必填；每行顶点数，不是格子数
  extend: 0 | 1;
  backColor?: Rgba;
}
```

- **Gouraud**：`Point` 至少 3 个；按顺序每 4 个点构成一个四边形，用第一个点的 `EdgeFlag` 选对角线；不足 4 个的尾部按三角形处理。`EdgeFlag=0` 时把四边形当两个独立三角形（共享边不插值？仍按顶点颜色插值，效果与拆三角形一致）。
- **LaGouraud**：`VerticesPerRow` 是每行**顶点数**（兼容标准里的 `VverticesPcrRow` 拼写）；行数 `ceil(points.length / verticesPerRow)`；相邻 4 点构成网格单元，`EdgeFlag` 固定 1。缺行/缺点时 warning 并跳过不完整单元。
- 颜色空间：在设备空间做重心插值（仿射变换不改变重心坐标），避免每像素反变换回对象空间。
- 光栅化：
  1. 用当前变换 `M` 把控制点变到设备坐标；
  2. 计算三角形 bbox，clamp 到画布/图元 bbox；
  3. 对每个像素求三个重心坐标 `(w0,w1,w2)`，`w<0` 跳过；颜色 `C = w0*C0 + w1*C1 + w2*C2`；
  4. 写入 `ImageData`（RGBA8，straight alpha）；
  5. 把 `ImageData` `putImageData` 到同尺寸离屏 canvas，再 `drawImage` 到 bbox；
  6. `ctx.save();` 在当前对象空间建路径并 `clip()`；`ctx.setTransform(1,0,0,1,0,0)` 后把离屏图贴到 bbox；`restore()`。
- `Extend=0`：只画三角形覆盖区域，其余透明；`Extend=1`：先用 `BackColor` 填满图元路径，再画三角形；`BackColor` 缺失时按黑色 + warning（与 CT_Color 默认一致）。
- 抗锯齿：v1 用 1× 光栅化，边缘会有锯齿；bbox 小于 2MP 时可 2× 超采样后缩小。不要为了抗锯齿引入 WebGL。
- 性能：单图元 bbox 上限 4MP；超过按 1/2 分辨率渲染并 warning；按 256×256 tile 分块，避免长任务。
- 缓存：H5 内部可按 `GouraudShade + 变换 + 尺寸` 缓存 shading 栅格，LRU 按字节计；这是 renderer 内部缓存，engine 不持有 surface。
- 样本：当前业务样本里没有 `GouraudShd`/`LaGouraudShd`（已扫描 55 对），用合成 fixture 覆盖三角形、EdgeFlag 0/1/2、网格、Extend/BackColor。

### 13.6 渐变描边

Canvas 可以直接 `strokeStyle = gradient`，但径向椭圆的变换会同时缩放线宽。方案：

- 轴向渐变：直接用于 stroke，正确；
- 径向渐变：v1 整体降级，不进入 stroke；
- 底纹 stroke：v1 用平均色 + warning；
- v2：把描边转成填充轮廓（需要路径偏移算法）或离屏掩码 + `source-in` 渐变。

---

## 14. 跨平台适配

> **v1 交付边界：只做 engine 库，不实现任何端。** 本节是核心与宿主之间的接口契约，不是 v1 的 Web/Node/小程序适配器交付清单；具体 `ByteSource`、Canvas、图片解码、字体读取由宿主提供。

### 14.1 平台接口

> `Canvas2DLike` 属于 `renderer/types.ts`（渲染器适配），`ByteSource`/`ImageDecoder`/`FontProvider` 属于 `platform/`；这里集中列出宿主可注入的接口形状。

```ts
export interface Canvas2DLike {
  width: number;
  height: number;
  style?: { width: string; height: string };
  getContext(type: '2d', options?: {
    alpha?: boolean;
    willReadFrequently?: boolean;
  }): CanvasRenderingContext2DLike | null;
}

export interface CanvasRenderingContext2DLike {
  // 只列引擎实际使用的子集
  readonly canvas: Canvas2DLike;
  save(): void; restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
  beginPath(): void; closePath(): void;
  moveTo(x: number, y: number): void; lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  clip(rule?: 'nonzero' | 'evenodd'): void;
  fill(rule?: 'nonzero' | 'evenodd'): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  drawImage(image: any, dx: number, dy: number, dw?: number, dh?: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradientLike;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradientLike;
  createPattern(image: any, repeat: string): CanvasPatternLike | null;
  setLineDash(segments: number[]): void;
  getLineDash(): number[];
  globalAlpha: number;
  globalCompositeOperation: string;
  fillStyle: any; strokeStyle: any;
  lineWidth: number; lineCap: string; lineJoin: string; miterLimit: number;
  imageSmoothingEnabled: boolean;
}
```

不要求 `Path2D`、`DOMMatrix`、`ctx.filter`、`ctx.roundRect`、`CanvasPattern.setTransform`、`OffscreenCanvas` 一定存在。

### 14.2 平台矩阵（宿主参考，不是 v1 交付）

> 以下 14.2–14.4 只说明宿主接入时要注意的差异；v1 仓库不实现这些适配器。

| 能力 | Web | Electron/Tauri | Node | 微信小程序 |
|---|---|---|---|---|
| 文件读取 | Blob/File/fetch Range | 同 Web 或 Node IPC | `fs` | `FileSystemManager` |
| Canvas | DOM Canvas | DOM Canvas | `@napi-rs/canvas`/`node-canvas` | Canvas 2D 节点 |
| 图片解码 | `createImageBitmap`/`Image` | 同 Web | canvas `loadImage` | `canvas.createImage` |
| 临时 Canvas（scratch/pattern） | `OffscreenCanvas` 可选 | 同 Web | 由 `createCanvas` 提供 | `wx.createOffscreenCanvas` |
| 字体 | fontkit（字节） | fontkit | fontkit | fontkit |
| 解压 | `DecompressionStream`/fflate | 同 Web | `DecompressionStream`/fflate | fflate |
| Worker | 可选 | 可选 | worker_threads | `wx.createWorker` |
| 导出 | `toBlob`/`toDataURL` | 同 Web | canvas `encode` | `wx.canvasToTempFilePath` |

### 14.3 小程序注意事项

- 不支持 `Path2D`、`DOMMatrix`、`ctx.filter`；核心必须用立即路径命令和自有矩阵。
- `ctx.setLineDash`、`createRadialGradient`、`globalCompositeOperation` 需在目标基础库版本验证；启动时做能力探测，不支持则降级。
- `canvas.createImage()` 是异步的，必须在准备阶段完成；绘制阶段不能等。
- H5 内部 scratch/离屏 Canvas 有内存上限；大页面/大底纹要限制尺寸，renderer 失败时不能拖垮整页。
- 主包 2MB 限制：
  - `fontkit` + 核心可能接近上限；
  - JBIG2/TIFF 解码器放分包/按需加载；
  - 补充字体不要进 JS 包，放 CDN/分包资源。
- 文件读取用 fd + position，避免整包读入内存。
- 页面 Canvas 建议复用；切换页时先取消上一个渲染任务。

### 14.4 Node/PC

- Electron 渲染进程：直接用 Web 适配器；主进程读文件通过 `NodeFileSource` + IPC，或把 `ArrayBuffer` 传给渲染进程。
- Tauri：WebView 内用 `fetch`/自定义协议；Range 读取可通过命令桥接。
- 纯 Node：
  - `@napi-rs/canvas` 性能好、安装简单；`node-canvas` 兼容性好但原生依赖重；
  - 图片解码用 canvas 的 `loadImage`，或 `sharp` 解码后转 `ImageData`；
  - 字体兜底可直接读系统字体目录（需宿主提供 `FontProvider`）。
- PC 端如果要“系统字体自动匹配”，实现一个 `SystemFontProvider`：
  - Windows 读 `C:\Windows\Fonts`；
  - macOS 读 `/System/Library/Fonts`、`/Library/Fonts`；
  - Linux 读 `/usr/share/fonts`；
  - 建立 family/style 索引；按需读取字节给 fontkit。
  - 这是 PC 相对 Web 的优势，但仍需处理字体授权/子集化。

---

## 15. 公共 API

### 15.1 设计

公共 API 采用 pdf.js 的“文档 → 页 → 渲染任务”形态；engine 只渲染页面内容，不处理阅读器的缩放/旋转/背景/打印筛选。

```ts
export type FontInput =
  | { data: ArrayBuffer | Uint8Array; family?: string }
  | { url: string; family?: string }        // Web
  | { path: string; family?: string }       // Node
  | { filePath: string; family?: string };  // WeChat

export interface FontMatchRequest {
  fontName: string;
  familyName?: string;
  charset: string;                          // unicode/prc/big5/symbol
  bold: boolean;
  italic: boolean;
  serif: boolean;
  fixedSize: boolean;
}

export interface FontProvider {
  /**
   * 返回 null 表示没有匹配字体；也可返回多个候选，按顺序回退。
   * provider 只负责“找到字体文件/字节”，解析仍由 fontkit 完成。
   */
  match(request: FontMatchRequest): Promise<FontInput | FontInput[] | null>;
}

// 宿主可直接使用的三种实现（设计约定，不是强制 API）：
// createInjectedFontProvider(fonts: FontInput[])
// createNodeSystemFontProvider({ dirs?: string[] })
// createBrowserLocalFontProvider()                    // queryLocalFonts()，需权限

export interface ImageDecoderPlugin {
  /** "jbig2" | "tiff" 等；与图片头部识别结果匹配 */
  format: string;
  decode(data: Uint8Array): Promise<DecodedImage>; // 统一返回宽高 + ImageData/平台图像
}

export interface ResourceLimits {
  maxPackageBytes: number;          // 256 MiB
  maxEntries: number;               // 20,000
  maxEntryBytes: number;            // 64 MiB
  maxTotalUncompressedBytes: number;// 512 MiB
  maxCompressionRatio: number;      // 200
  maxXmlBytes: number;              // 32 MiB
  maxFontBytes: number;             // 64 MiB
  maxImagePixels: number;           // 100_000_000
  maxCanvasPixels: number;          // 64_000_000
  maxRecursionDepth: number;        // 16
}

export interface CacheOptions {
  xmlBytes: number;                 // 16 MiB
  fontBytes: number;                // 64 MiB
  imageBytes: number;               // 64 MiB
  glyphCount: number;               // 20,000
  pageModels: number;               // 8
}

export interface OFDOpenOptions {
  source: OFDSource;
  documentIndex?: number;              // 默认 0
  limits?: Partial<ResourceLimits>;
  supplementaryFonts?: FontInput[];    // 宿主补充的字体，按需用于缺字/缺字体
  fontProvider?: FontProvider;         // 按需提供字体
  imageDecoders?: ImageDecoderPlugin[];// JBIG2/TIFF 等
  onWarning?: (warning: OFDWarning) => void;
  cache?: Partial<CacheOptions>;
  strictImageCtm?: boolean;            // 默认 true（identity 1×1）；false 才铺满 Boundary
  layerOrder?: 'document' | 'type';    // 默认 type（先类型后出现顺序）
  /** 渲染器扩展点；默认 H5Canvas2DRenderer，普通用户无需传 */
  renderer?: Renderer;
}

export type OFDSource =
  | { kind: 'arraybuffer'; data: ArrayBuffer | Uint8Array }
  | { kind: 'blob'; blob: Blob }
  | { kind: 'url'; url: string; headers?: Record<string, string> }
  | { kind: 'node-file'; path: string }
  | { kind: 'wechat-file'; filePath: string }
  | { kind: 'custom'; source: ByteSource };

export interface Viewport {
  width: number;                      // device px
  height: number;                     // device px
  dpi: number;                        // 输出精度，默认 96
}

export interface ViewportOptions {
  dpi?: number;                       // 默认 96；144/300 用于高精度输出
}

export interface PageRenderParameters {
  canvasContext: CanvasRenderingContext2DLike;
  viewport: Viewport;
  signal?: AbortSignal;
}

export class RenderTask {
  readonly promise: Promise<void>;
  cancel(): void;
}

export class OFDPage {
  readonly index: number;
  /** 页尺寸，单位 mm */
  getSize(): PageSize;
  /** 页面在指定 dpi 下的像素尺寸；用户据此设置 canvas */
  getViewport(options?: ViewportOptions): Viewport;
  /** 渲染到用户提供的 canvasContext；不设置 canvas 尺寸、不清屏；会以 M_page 重置变换（覆盖预置 CTM） */
  render(params: PageRenderParameters): RenderTask;
}

export class H5Canvas2DRenderer implements Renderer {
  /** options 形状见 6.3.1 的 H5Canvas2DRendererOptions */
  constructor(options?: H5Canvas2DRendererOptions);
}

export class OFDDocument {
  static open(options: OFDOpenOptions): Promise<OFDDocument>;

  /** 页数，打开后立即可用 */
  readonly pageCount: number;

  /** 按需加载指定页；索引从 0 开始 */
  getPage(pageIndex: number): Promise<OFDPage>;

  /** 关闭并释放所有缓存；可重复调用 */
  close(): Promise<void>;
}
```

- `Renderer` 是公开扩展点（见 6.3）；**默认实现 `H5Canvas2DRenderer` 由 engine 内部创建**，普通用户不传 `renderer`。Node/小程序需要 `createCanvas` 时，显式构造 `H5Canvas2DRenderer` 并传入。
- `page.render` 不接收 `scale/rotation/pixelRatio/background/annotations`；这些是阅读器控制或宿主画布设置。
- `page.render` 只画页面内容；canvas.width/height、CSS 尺寸、清屏、白底/背景色全部由用户负责。
- `page.render` 返回 `RenderTask`；`cancel()` 后 `promise` 以 `OFD_ABORTED` 拒绝；与 pdf.js 的 `RenderTask` 形状一致。
- `getPage` 失败（页码越界/页损坏）抛 `OFDError`；`page.getViewport` 只依赖页尺寸，不触发内容/字体/图片加载。

### 15.2 为什么用 `page.getViewport`

用户需要在绘制前知道 canvas 应该多大，但 engine 不应该替用户设置 canvas：

- `page.getSize()` 返回 mm，供业务排版/打印使用；
- `page.getViewport({ dpi })` 返回 device px，用户据此设置 `canvas.width/height`；
- engine 不引入 `scale`，避免把“阅读器缩放”混进页面内容渲染；
- `dpi` 是输出精度，不是交互缩放；144/300 只是更高分辨率输出；
- `getViewport` 不加载字体/图片，只读页尺寸。

`page.render` 会校验 canvas 尺寸至少覆盖 viewport；不足时抛 `OFD_CANVAS_SIZE_MISMATCH`，避免静默裁剪。

### 15.3 使用示例

Web（默认 H5 renderer）：

```ts
import { OFDDocument } from 'ofdrw-viewer-engine';

const doc = await OFDDocument.open({
  source: { kind: 'blob', blob: file },
  onWarning: (w) => console.warn(w.code, w.message),
});

const page = await doc.getPage(0);
const viewport = page.getViewport({ dpi: 96 });

canvas.width = Math.ceil(viewport.width);
canvas.height = Math.ceil(viewport.height);
const ctx = canvas.getContext('2d')!;

const task = page.render({ canvasContext: ctx, viewport });
await task.promise;

await doc.close();
```

Node（显式注入 `createCanvas`）：

```ts
import { createCanvas } from '@napi-rs/canvas';
import { OFDDocument, H5Canvas2DRenderer } from 'ofdrw-viewer-engine';

const renderer = new H5Canvas2DRenderer({
  createCanvas: (width, height) => createCanvas(width, height),
});

const doc = await OFDDocument.open({
  source: { kind: 'node-file', path: '/data/a.ofd' },
  renderer,
  supplementaryFonts: [{ path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc' }],
});

const page = await doc.getPage(0);
const viewport = page.getViewport({ dpi: 192 });
const canvas = createCanvas(
  Math.ceil(viewport.width),
  Math.ceil(viewport.height)
);
const ctx = canvas.getContext('2d');
const task = page.render({ canvasContext: ctx, viewport });
await task.promise;
await doc.close();
```

自定义渲染器（正式扩展点）：

```ts
import { OFDDocument } from 'ofdrw-viewer-engine';

const doc = await OFDDocument.open({
  source,
  renderer: new MyRenderer(),   // 实现完整 Renderer 接口；用原生 group 即可，不需要 surface
});
```

取消：

```ts
const task = page.render({ canvasContext: ctx, viewport });
setTimeout(() => task.cancel(), 100);
try {
  await task.promise;
} catch (e) {
  if (e.code === 'OFD_ABORTED') return;
  throw e;
}
```

### 15.4 错误与 warning

`OFDError`：

```ts
export type OFDErrorCode =
  | 'OFD_INVALID_PACKAGE'
  | 'OFD_ENTRY_NOT_FOUND'
  | 'OFD_UNSUPPORTED_COMPRESSION'
  | 'OFD_ENCRYPTED'
  | 'OFD_XML_PARSE'
  | 'OFD_PAGE_NOT_FOUND'
  | 'OFD_CANVAS_TOO_LARGE'
  | 'OFD_CANVAS_SIZE_MISMATCH'
  | 'OFD_RENDERER_UNSUPPORTED'
  | 'OFD_ABORTED'
  | 'OFD_CLOSED'
  | 'OFD_LIMIT_EXCEEDED'
  | 'OFD_FONT_PARSE'
  | 'OFD_IMAGE_DECODE';

export interface OFDWarning {
  code: string;                    // 见 warning 表
  message: string;
  pageIndex?: number;
  objectId?: ResourceId;
  resourceId?: ResourceId;
}

export class OFDError extends Error {
  code: OFDErrorCode;
  cause?: unknown;
}
```

错误码：

| 码 | 场景 |
|---|---|
| `OFD_INVALID_PACKAGE` | 不是 ZIP / 缺 `OFD.xml` |
| `OFD_ENTRY_NOT_FOUND` | 声明的部件不存在 |
| `OFD_UNSUPPORTED_COMPRESSION` | 非 0/8 压缩方法 |
| `OFD_ENCRYPTED` | 加密条目 |
| `OFD_XML_PARSE` | 关键 XML 无法解析 |
| `OFD_PAGE_NOT_FOUND` | 页码越界 |
| `OFD_CANVAS_TOO_LARGE` | 超过画布像素限制 |
| `OFD_CANVAS_SIZE_MISMATCH` | canvas 宽高小于 viewport |
| `OFD_RENDERER_UNSUPPORTED` | renderer 缺少当前能力（如 H5 未注入 `createCanvas` 却遇到 group/pattern） |
| `OFD_ABORTED` | 被 `RenderTask.cancel()`/`AbortSignal` 取消 |
| `OFD_CLOSED` | 文档已关闭，不能再使用 |
| `OFD_LIMIT_EXCEEDED` | 超过资源限制 |
| `OFD_FONT_PARSE` | 主字体无法解析（可回退时只 warning） |
| `OFD_IMAGE_DECODE` | 图片解码失败（可跳过时只 warning） |

Warning 码：

| 码 | 含义 |
|---|---|
| `W_FONT_MISSING` | 字体资源缺失/不可用 |
| `W_GLYPH_MISSING` | 单个字符无字形 |
| `W_IMAGE_DECODE` | 图片解码失败 |
| `W_UNSUPPORTED_PAINT` | 渐变/底纹/ICC 降级 |
| `W_UNSUPPORTED_CLIP` | 裁剪组合降级 |
| `W_BAD_NUMBER` | 数字/数组非法 |
| `W_BAD_PATH` | 路径命令非法 |
| `W_DUPLICATE_RESOURCE` | 资源 ID 重复 |
| `W_COMPOSITE_DEPTH` | 复合对象递归超限 |
| `W_PATTERN_LIMIT` | 底纹 tile 超限 |
| `W_ZERO_BOUNDARY` | 对象零尺寸 Boundary，已跳过绘制 |
| `W_PHYSICALBOX_ORIGIN` | PhysicalBox x/y 非 0，已按绝对坐标兼容口径平移 |
| `W_IMAGE_NO_CTM` | 图片缺 CTM，按 1×1 identity 绘制 |
| `W_NEGATIVE_BOUNDARY` | 负尺寸 Boundary，已归一化 |
| `W_LAYER_ORDER` | 使用了类型排序兼容开关 |
| `W_BLEND_MODE` | OFD 1.1 BlendMode 被忽略 |
| `W_RADIAL_UNSUPPORTED` | 径向渐变 v1 未实现，已降级 |
| `W_GOURAUD_APPROX` | Gouraud 网格不完整/超限，近似绘制 |
| `W_ANNOT_EMPTY` | 注释 Appearance 为空，已跳过 |
| `W_JBIG2_DECODE` | JBIG2/TIFF 解码失败或缺失插件 |

默认 `onWarning` 为空（不打印）；调试时可传 `console.warn`。同一 warning 按 `(code, page, objectId)` 去重，避免刷屏。

---

## 16. 缓存、并发、取消与内存

### 16.1 缓存层级

| 缓存 | 键 | 默认预算 | 释放 |
|---|---|---|---|
| ZIP 中央目录 | 文档 | 常驻 | `close` |
| 解压 XML | 条目路径 | 16 MB | LRU |
| 资源索引 | 资源 XML 路径 | 常驻（每文件一次） | `close` |
| 字体字节/对象 | 字体路径 | 64 MB | LRU |
| 字形轮廓 | `(fontKey,gid)` | 20k 个 | LRU |
| 解码图片 | `(路径,用途)` | 64 MB | LRU + `close` |
| 页面模型 | 页索引 | 8 页 | LRU |
| DrawParam partial | 资源 ID | 常驻（每 ID 一次） | `close` |
| ResolvedStyle | 对象实例 | 随页面模型 | 页面淘汰时释放 |
| 独立块显示列表 | `cacheKey` | 常驻/LRU | 随块 |

> H5 的 group/pattern scratch canvas 不属于 engine 缓存，由 renderer 内部创建并在 `endGroup`/`fill` 结束后销毁。

- 预算按“解码后字节”估算；图片 `width*height*4`，字体按文件大小，XML 按字符串长度 ×2。
- `close()` 要：
  - 中止所有进行中的加载/渲染；
  - `ImageBitmap.close()`（若存在）；
  - 清空字体/字形/页面/图片/显示列表缓存；
  - 调用 `renderer.close()`，释放内部 scratch canvas/pattern canvas/image handle；
  - 释放文件句柄（Node/微信）。

### 16.2 并发

- 同一文档的多个 `page.render` 可以并行准备，但绘制要按 Canvas 串行；引擎对每个 Canvas 维护一个 Promise 链。
- 资源加载用 `Map<key, Promise>` 去重，避免同一字体/图片并发解析多次。
- `close()` 与进行中的渲染互斥：`close` 先置 `closed=true`，再等/中止任务；`close()` 本身幂等，重复调用直接 resolve；之后 `getPage`/`page.render` 抛 `OFD_CLOSED`。
- 不鼓励同一页面并发渲染到同一 Canvas；API 文档写明。

### 16.3 取消

- `RenderTask.cancel()` 与可选 `AbortSignal` 都转成内部 abort；准备阶段每个 I/O 前后检查，绘制阶段每个对象检查。
- 字体解析/图片解码无法中断时，等其完成再丢弃结果；不要阻塞 `close`。
- 取消后：
  - 目标 Canvas 内容未定义；H5 内部 group scratch 不会自动提交，取消后由用户清屏/重绘；
  - 临时资源进入缓存或直接释放；
  - Promise 以 `OFD_ABORTED` 拒绝。

### 16.4 内存

- 峰值内存 ≈ 最大单条目解压 + 当前页字体 + 当前页图片 + 页面模型。
- 1000 页文档不应因页数增加而线性增长；页模型/位图缓存有界。
- 大字体（CJK 20MB）解析后 fontkit 对象可能占几十 MB；只保留最近使用的 2-3 个字体，其余淘汰。
- 大图片解码后按 `ImageBitmap` 计；必要时降采样（`createImageBitmap(blob, { resizeWidth })`），但会影响清晰度，默认不降。

---

## 17. 安全与健壮性

| 风险 | 对策 |
|---|---|
| ZIP bomb | 读中央目录的 uncompressedSize；单条目/总量/压缩比限制；解压时流式计数，超限中止 |
| 路径穿越 | 解析后规范化，拒绝 `..` 逃出包根；拒绝绝对文件系统路径；重复路径拒绝 |
| XXE/实体膨胀 | 禁用 DTD/外部实体；拒绝 `<!DOCTYPE`；限制 XML 大小/深度/节点数 |
| XML 解析崩溃 | try/catch；该页空白 + error warning；不崩溃文档 |
| 数字溢出/NaN | 统一 `toNumber`，finite 检查；非法值 fallback |
| 负/零 Boundary | 负尺寸归一化；零尺寸直接跳过对象；warning |
| 图片 bomb | 解码前读头部尺寸；像素上限；解码失败跳过 |
| 字体 bomb | 字体大小上限；fontkit 异常捕获；不执行字体中的任何代码 |
| Canvas 过大 | 像素上限；超限抛 `OFD_CANVAS_TOO_LARGE`，建议降 dpi |
| 递归/循环 | 复合对象/页面块/Pattern/Relative 深度限制；资源 ID 栈检测环 |
| 恶意 URL | 默认只读包内资源，不加载外部 URL；`url` 源只取 OFD 本身 |
| 内存耗尽 | 缓存预算；大对象及时释放；可选降采样 |
| 画布状态泄漏 | 每对象 save/restore；页面开始重置 transform/alpha/composite/lineDash |
| 部分绘制 | 分组 scratch 不提交；取消后由用户清屏/重绘；renderer.close 释放内部资源 |
| 日志泄露 | warning 不含完整文件内容/字体字节；只含路径/ID |

补充：

- `close()` 后所有缓存引用置空，避免 GC 不了。
- 不把 `ArrayBuffer` 长期持有超过必要；`Blob` 源保留引用以便重读。
- 对 `HttpRangeSource` 的 206/200 响应都处理；200 表示服务器忽略 Range，缓存整包。
- 不信任 `Content-Length`；以实际读取为准。

---

## 18. 性能目标

| 场景 | 目标（中端笔记本/手机） |
|---|---|
| 打开 1000 页文档 | < 100 ms（只读入口/页树） |
| 首次渲染一页（含 1 个 CJK 字体） | < 500 ms |
| 后续渲染同文档不同页 | < 150 ms（1x=96 DPI，150 DPI≈1.56x） |
| 翻页（缓存命中字体/图片） | < 80 ms |
| 内存（100 页典型文档） | < 250 MB |
| 主包 gzip | < 250 KB（不含补充字体、JBIG2/TIFF 动态 chunk） |

**极端性能样本例外（dense-text-perf，已确认）**

`dense-text-perf.ofd` 是单页上万字形、极端密集的压测样本，不代表普通公文页。它的门禁只统计**引擎绘制耗时** `drawMs`（不含 PNG 编码 `encodeMs`），并在文档/测试报告中单列：

- 首次绘制 `drawMs < 800 ms`；
- 翻页/重绘 `drawMs < 1000 ms`；
- 第二次绘制 `drawMs < 600 ms`；
- 打开 `< 100 ms`、堆增量 `< 150 MiB`；
- 普通页面仍按首渲 `< 500 ms`、翻页 `< 150 ms`、缓存命中 `< 80 ms`，不得用该例外放宽普通页阈值。

优化手段：

- 只解压需要的条目；XML 解析一次，模型缓存。
- 字体只解析一次；字形轮廓缓存；同一页面文字路径可缓存。
- 图片解码一次；同一图片多页复用。
- 预加载下一页由宿主调度；引擎提供 `page.render` 的取消，避免快速翻页堆积。
- 大页面/高 DPI 可分块渲染（v2）；v1 超限直接报错，避免卡死。
- H5 内部可用 `CanvasFactory.reset` 复用 group/pattern scratch；不跨页缓存栅格结果。
- 绘制循环内不分配大对象；路径命令数组复用/预分配（实现时注意）。
- 不用 `Path2D`，但可用 `ctx.beginPath()` + 批量命令；V8/JSC 对立即模式路径优化较好。

---

## 19. 测试与验收

### 19.1 单元测试

- ZIP：
  - stored/deflate、ZIP64、data descriptor、注释、中文路径、重复路径、路径穿越、加密、压缩比超限；
  - 用合成 ZIP 构造，不依赖外部文件。
- XML：
  - 两种命名空间、前缀、无命名空间、属性大小写、DTD 拒绝、坏数字、超大文档；
  - `CGTransform` 子节点/兄弟节点/属性形式。
- 矩阵/变换：
  - `T(boundary)*CTM` 顺序；页面偏移；旋转 0/90/180/270；负 Boundary 归一化；
  - 裁剪顺序：标准 ImageObject `Clips` 在对象 CTM 前；manual 逆 CTM 编码仅在 CTM 后追加；两者都不能把普通图元改成“先 CTM 后裁剪”。
- 路径：
  - 所有命令、圆弧四种 flag 组合、退化弧、坏 token、零长度、evenodd。
- 颜色：
  - GRAY/RGB/CMYK、1/2/4/8/16 位、调色板、Alpha、`#` 十六进制。
- DrawParam/样式结算：
  - Relative 链、环、缺失 Relative、图层/PageBlock/Composite/Annotation/Pattern 作用域；
  - 优先级：继承 < DrawParam < 内联 < 子元素颜色；Fill/Stroke 不从父继承；
  - 同一 DrawParam 被大量对象引用只展开一次；结算结果在绘制前已写入 `PreparedPage.styles`；
  - 非法值/缺失资源回退，不阻塞整页。
- 文字：
  - DeltaX 缺失/短/长/0/非法/`g` 压缩组；CGTransform 1:1/N:1/1:N/N:M；ReadDirection 180/270；CharDirection 90/180/270；HScale；负 Boundary；零 Boundary。
- 字体：
  - 正常 TTF、无 cmap/name 的剥离子集、CFF CID、TTC、损坏字体；
  - 用固定字体 fixture，断言 glyph id/advance/bbox。
- 图片：
  - 单位矩形 + CTM；无 CTM；边框圆角/虚线；蒙版；替换图；解码失败；
  - GIF87a/89a 首帧：GCT/LCT、透明、隔行、LZW、动态 chunk；GIF 属 v1 必需格式。
- 复合/底纹：
  - 递归、循环、组透明度、tile 反射、Page 相对；Composite Width/Height 的 0.3528 单位换算。
- 注释/签章：
  - `Annotations.xml` 的 PageID 映射、绝对/相对 FileLoc、`Appearance` 平移、空外观、`Visible=false`、多 Stamp 顺序；`NoZoom/NoRotate` 只断言“不改变内容”；
  - `Seal.esl` 与 `SignedValue.dat` 的 v1/v4/v5 ASN.1 版本推断；`SES_ESPictrueInfo` PNG/JPEG/`ofd` 矢量章；白底 multiply；跨页 `StampAnnot.Clip` 切片；坏 DER/坏 ZIP 只 warning。
- 独立空间块：
  - 同一红章 10 页复用 display list；平移不改变显示列表；alpha/DrawParam 不同不串图；嵌套 Composite→Pattern→Text；组透明度整体合成。
- JBIG2/TIFF：
  - 文件头/magic、单页、二值反色、条带/瓦片、1/4/8/16 位、坏数据、像素上限。
- Gouraud：
  - 三角形、EdgeFlag 0/1/2、`VerticesPerRow` 网格、Extend/BackColor、超限降采样。
- 径向渐变：
  - v1 只断言 warning + 不崩溃；v2 再加图 36 的孔洞/锥形黄金图。
- 渲染器契约：
  - `RecordingRenderer` 断言路径/变换/裁剪/样式调用序列；
  - `H5Canvas2DRenderer` 与 `Canvas2DLike` 的最小接口一致；不调用 `fillText/strokeText/measureText`；
  - `CanvasFactory.create/reset/destroy`：尺寸、清空、`destroy` 置 0、`willReadFrequently` 选项；
  - `beginGroup/endGroup` 保存/恢复目标、变换、裁剪；组 alpha 只在 `endGroup` 乘一次；嵌套 group 正确；
  - pattern tile 在 renderer 内部创建/销毁，engine 不接触 surface；
  - `createImage/drawImage` 生命周期与释放；`close` 清理所有内部资源。
- API：
  - open/getPage/page.getViewport/page.render/close；`RenderTask.cancel`；重复 close；并发同 canvas；页码越界；canvas 尺寸不足；Node 未注入 `createCanvas` 时 group/pattern 报 `OFD_RENDERER_UNSUPPORTED`。

### 19.2 黄金图测试

- Node 端用 `@napi-rs/canvas` + `H5Canvas2DRenderer({ createCanvas })` 渲染到 PNG（引擎核心测试，不是端交付）；测试 harness 按 PDF 基线先填白底，engine 不负责背景；
- 其他渲染器/宿主由接入方自测，不列入 v1 端验收；
- 基线来源：
  - `ofd_pdf_match/` 的 55 对同名 OFD/PDF；PDF 由业务方提供，作为版式/位置参考；
  - 自建 fixture 的期望图（人工确认）；
  - rofd/ofd-utility 的输出（仅作参考，不要求逐像素）。
- 比较（按“视觉一致 + 区域容差”，不追求逐像素）：
  - 页面尺寸、元素 bbox、文字基线/行距、表格线、印章外框：偏差 ≤ 0.5 mm 或 1 设备像素（取较宽者）；
  - 颜色：关键色 ΔE2000 ≤ 5，普通填充可放宽；
  - 抗锯齿边缘不计入差异；
  - SSIM/像素差只作为辅助指标，不设统一硬阈值。
- 每次改渲染逻辑，黄金图必须人工审核差异，不能盲目更新。

### 19.3 真实文件回归

- 第一优先级：`ofd_pdf_match/` 的 55 对 OFD/PDF。PDF 只作为版式/位置参考，字体替换和抗锯齿会带来差异，按区域和容差比较。
- 建议的分组回归：
  - 基础文字/路径：`hello.ofd`、`helloworld.ofd`、`1.ofd`、`1-1.ofd`；
  - 横向文字/Delta/多 TextCode：`文字横向-数科.ofd`、`chineseDir.ofd`、`multiKeywordInTextCode.ofd`；
  - 透明度/混合：`透明度文字.ofd`、`testPathFillOpacity.ofd`；
  - 图片/替换/缺失：`containsJPEG.ofd`、`testImageNotFound.ofd`、`testImageOverridePage.ofd`；
  - 扫描件/JBIG2：`1.ofd`、`no_page_container.ofd`、`signedFile.ofd`；
  - 裁剪/复合：`testPathClip.ofd`、`helloworld_with_pageblock.ofd`、`intro-数科.ofd`；
  - 底纹：`pattern类型.ofd`；
  - 注释/水印/签章：`AddWatermarkAnnot.ofd`、`hello_watermark.ofd`、`发票监制章-数科.ofd`、`signout.ofd`、`v4signed.ofd`、`20240531141733.ofd`；
  - 不规范结构：`namespace_no_std.ofd`、`path_unstd.ofd`、`no_page_container.ofd`、`不规范资源路径.ofd`。
- 记录每个文件的页数、页尺寸、字体缺失数、warning 列表、渲染耗时，以及与 PDF 的区域差异。
- 记录每个文件的：
  - 页数、页尺寸、字体缺失数、warning 列表、渲染耗时；
  - 与参考阅读器截图的差异。
- 业务原件不提交仓库；用脱敏/自生成 fixture 做 CI。

### 19.4 引擎核心验收（不做端验收）

v1 只交付 engine 库，因此不把 Chrome/Firefox/Safari/Electron/小程序真机列为 v1 验收项；这些由宿主接入后自行验收。

| 环境 | 验收 |
|---|---|
| Node + `@napi-rs/canvas` | 全部 fixture 黄金图；批量 100 页无泄漏；字体/图片/解码器接口可注入 |
| 最小 Canvas mock | 路径命令、状态栈、变换、裁剪调用序列正确；不依赖 DOM |
| 宿主契约测试 | `ByteSource`/`Canvas2DLike`/`ImageDecoder`/`FontProvider`/`Renderer`/`H5Canvas2DRendererOptions.createCanvas` 的接口签名与生命周期 |
| 端适配（非 v1 交付） | 由宿主按 14.1 接口自行完成，不在本仓库验收 |

### 19.5 性能/稳定性

- 1000 页文档打开时间、翻页时间、内存曲线；
- 连续渲染 500 页无泄漏（`close` 后内存回落）；
- 快速取消/重渲染不残留任务；
- 恶意 ZIP/XML/图片样本不崩溃、不 OOM（在限制内拒绝）。

### 19.6 验收清单（v1）

- [ ] 不整包解压；打开 1000 页文档 <100ms。
- [ ] 文字全部走轮廓，不调用 `fillText`/`strokeText`/`measureText`。
- [ ] 内嵌 TTF/OTF/CFF CID 字体可渲染；无 cmap 字体可用显式 gid。
- [ ] 无内嵌字体的文档在有补充字体时可读；无补充时 warning 且不崩溃。
- [ ] 路径 M/S/L/Q/B/A/C、填充规则、虚线、端点/连接正确。
- [ ] 图片单位矩形 + CTM 正确；无 CTM 的兼容策略生效。
- [ ] 页尺寸回退链正确。
- [ ] 模板 Background/Foreground 顺序正确。
- [ ] 页资源/模板资源可解析。
- [ ] 裁剪路径/文字、复合对象、组透明度可用。
- [ ] 注释/签章 `Appearance` 可显示；`Visible` 有测试；`NoZoom`/`NoRotate` 不参与内容变换。
- [ ] JBIG2/TIFF 可解码；缺插件/坏数据不崩页。
- [ ] Gouraud/LaGouraud 三角形、EdgeFlag、网格可画。
- [ ] 径向渐变 v1 明确 warning 降级，不静默画错。
- [ ] 渐变/底纹的 v1 支持范围明确，降级有 warning。
- [ ] 引擎核心在 Node canvas 黄金图通过；端适配不在 v1 验收范围。
- [ ] `ofdrw-viewer-engine` 的 ESM/CJS/types 导出可被 workspace 内其他子包消费。
- [ ] `close()` 释放资源；取消可用。

---

## 20. 里程碑

| 阶段 | 内容 | 产出 | 预估 |
|---|---|---|---|
| M0 技术验证 | ZIP 随机读、fontkit 剥离字体/CFF、Canvas 路径、单位矩形 | 可运行 spike + 结论 | 1 周 |
| M1 骨架 | `open/getPage/close`、页树、页尺寸、viewport、资源作用域、路径/图片/纯色、`H5Canvas2DRenderer`（CanvasFactory/group） | 能渲染简单公文页 | 2 周 |
| M2 文字 | 字体解析、字形轮廓、Delta、CGTransform、方向、粗斜体、回退 | 文字页可读 | 2 周 |
| M3 复杂绘制 | 裁剪、复合对象、轴向渐变、Gouraud、注释/签章外观、JBIG2/TIFF、Pattern（tile/反射/CTM/注释水印） | 覆盖大多数业务文档 | 3 周 |
| M4 API/契约 | 公共 API、`Renderer` 扩展点（无公开 surface）、`H5Canvas2DRenderer` 注入、平台接口类型、错误码、取消、缓存、调用示例 | 可被宿主集成 | 1.5 周 |
| M5 硬化 | 黄金图、真实文件回归、安全限制、性能、文档 | v1 发布 | 1.5 周 |

> 以上为单人估计，按 v1 含注释/签章、Gouraud、JBIG2/TIFF、Pattern 计算；不含任何端实现。径向渐变 v1 不做，不占排期。

---

## 21. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 无内嵌字体比例高 | 文字缺失/字形错误 | 宿主字体注入 + `supplementaryFonts` 补充；字体别名；warning 可视化 |
| 字体授权/体积 | 不能随包分发 | 补充字体按许可选择；子集化；CDN/分包；PC 读系统字体 |
| CFF/CID/剥离字体兼容 | 文字不显示 | 用 fontkit 正确 API；fixture 覆盖；逐字形回退 |
| 宿主 Canvas 能力差异 | 渐变/裁剪/合成失败 | 渲染器能力探测；降级；由宿主验收 |
| H5 scratch canvas 不可用/过大 | group、pattern、蒙版失败 | 宿主注入 `createCanvas`；限制 scratch 像素；失败 warning 并跳过该块/tile，不整页崩 |
| 渐变/底纹数学复杂 | 视觉差异 | 轴向 Direct 优先；径向 v1 降级；底纹 tile；黄金图对齐 |
| JBIG2/TIFF 扫描件 | 图片空白 | v1 内置动态 chunk；解码失败 `W_JBIG2_DECODE`；二值图缓存 1bpp |
| 注释/签章外观 | 红章缺失或错位 | 独立块 + Appearance 平移；阅读器标志不参与；真实 PDF 对齐 |
| DrawParam 嵌套/优先级 | 颜色/线宽错、红章发黑 | 准备阶段统一 `flattenDrawParam`/`resolveStyle`；结算结果不可变；单测覆盖嵌套/环/内联/颜色 |
| 渲染器抽象泄漏 | 换渲染器要改 render | `Renderer` 只认路径/样式/图像/矩阵；`PaintBinder` 隔离 OFD Paint；禁止在 render 里 import Canvas |
| 样式预结算成本 | 打开/翻页变慢 | `flattenDrawParam` 按 ID 缓存；`resolveStyle` 按对象一次；不重复遍历整页 |
| Gouraud 软件光栅化 | 大图元卡顿 | bbox 4MP 上限、tile、1/2 降采样；合成 fixture 回归 |
| 大页面/高 DPI | 内存/卡顿 | 像素上限；分块渲染 v2；降 dpi |
| 标准歧义 | 与参考阅读器不一致 | 裁决表 + 兼容开关；黄金图对齐 |
| 恶意文件 | 崩溃/OOM | 限制、XXE 禁用、路径校验、递归限制 |
| 性能不达标 | 翻页卡 | 缓存、预加载、Worker、减少重解析 |
| 参考实现许可证 | 合规风险 | 只借鉴算法；复用代码保留 NOTICE；法务审核 |

---

## 22. 待确认问题

以下问题会直接影响引擎默认值或宿主集成，需要确认；未确认前按“推荐项”执行。

1. **字体清单与授权（宿主侧，engine 不内置）**
   - 引擎只定义 `FontProvider`，不交付 Web/Node/小程序字体实现；v1 不含任何端适配器。
   - 待定：宿主实际提供哪些字体、授权范围、无字体时的产品提示。

2. **径向渐变 v2 时间点**
   - v1 已确认不做，warning 降级；若后续封面/票据大量使用，再排 v2 软件光栅化。

3. **TIFF 的真实样本**
   - 55 对里没有 `.tif/.tiff`；v1 仍实现 TIFF（纯 JS 动态 chunk），但只有合成 fixture。若业务实际没有 TIFF，可把 TIFF 解码器延后，减少包体。

## 23. 参考索引

### 23.1 标准

- GB/T 33190—2016《电子文件存储与交换格式 版式文档》
  - 第 5 章 结构、第 6 章 容器、第 7 章 文档结构；
  - 8.1 坐标、8.2 绘制参数、8.3 颜色/渐变/底纹、8.4 裁剪、8.5 图元；
  - 第 9 章 图形、第 10 章 图像、第 11 章 文字、第 13 章 复合对象；
  - 附录 A XSD（默认值以 XSD 为准时需注明）。
- 本地全文：`src_material/GBT33190-2016/full.md`
- 标准图：`src_material/GBT33190-2016/images/`

### 23.2 参考仓库

| 仓库 | 本地路径 | 提交 |
|---|---|---|
| ofdrw | `references/ofdrw/` | `84e9eb2` |
| ofd.js | `references/ofd.js/` | `c426b69` |
| liteofd | `references/liteofd/` | `d551222` |
| ofd-utility | `references/ofd-utility/` | `d603791` |
| ofdjs-viewer | `references/ofdjs-viewer/` | `d3f912f` |
| rofd | `references/rofd/` | `6198684` |

重点文件：

- `references/ofdrw/ofdrw-reader/src/main/java/org/ofdrw/reader/ResourceManage.java`
- `references/ofdrw/ofdrw-core/src/main/java/org/ofdrw/core/text/CT_Text.java`
- `references/ofdrw/ofdrw-core/src/main/java/org/ofdrw/core/text/TextCode.java`
- `references/ofdrw/ofdrw-core/src/main/java/org/ofdrw/core/text/CT_CGTransform.java`
- `references/ofd-utility/ofd-core/src/render.rs`
- `references/rofd/crates/render/src/body_scene.rs`
- `references/rofd/crates/render/src/body_text.rs`
- `references/ofdjs-viewer/src/core/render.ts`
- `references/ofd.js/src/utils/ofd/ofd_render.js`

### 23.3 依赖

- fontkit：MIT，2.0.4 已验证
- saxes：ISC
- fflate：MIT
- 可选 JBIG2：PDF.js / ofd.js 的 Apache-2.0 解码器
- 可选 TIFF：`utif`（MIT）

---

## 附录 A：默认值速查

| 项 | 默认 |
|---|---|
| 页面尺寸 | 页 Area → 模板 → CommonData → A4 |
| 页面背景 | engine 不填充；canvas 现状/背景由用户管理 |
| 对象 Alpha | 255 |
| 对象 Visible | true |
| 路径 Fill | false |
| 路径 Stroke | true |
| 路径 FillColor | 透明 |
| 路径 StrokeColor | 黑 |
| 路径 Rule | nonzero |
| 文字 Fill | true |
| 文字 Stroke | false |
| 文字 FillColor | 黑 |
| 文字 StrokeColor | 透明 |
| 文字 Size | 必选，无默认 |
| 文字 HScale | 1 |
| 文字 Weight | 400 |
| 文字 Italic | false |
| 文字 Read/CharDirection | 0 |
| LineWidth | 0.353 mm |
| Cap | Butt |
| Join | Miter |
| MiterLimit | 4.234 |
| DashOffset | 0 |
| DashPattern | 空 |
| 图片边框 LineWidth | 0.353 mm |
| 图片边框颜色 | 黑 |
| 图片圆角 | 0 |
| 渐变 MapType | Direct |
| 渐变 Extend | 0 |
| 径向渐变 | v1 未实现，warning + 平均色/透明 |
| Gouraud Extend | 0 |
| LaGouraud VerticesPerRow | 必选，无默认 |
| 注释 Visible | true |
| Pattern ReflectMethod | Normal |
| Pattern RelativeTo | Object |

## 附录 B：渲染顺序速查

```
页面内容（engine 不填充背景）
  Background 模板（按引用顺序）
    模板图层（按类型 + XML 顺序）
  Background 页图层（按 XML 顺序）
  Body 模板（按引用顺序）
    模板图层（按类型 + XML 顺序）
  Body 页图层（按 XML 顺序）
  Foreground 模板（按引用顺序）
    模板图层（按类型 + XML 顺序）
  Foreground 页图层（按 XML 顺序）
  Custom 页图层（按 XML 顺序）
  注释/签章外观（按 PageAnnot 文件顺序）
```

## 附录 C：对象裁剪顺序

```
对象 Alpha/Visible 判断
  save
  translate(Boundary)
  Boundary 裁剪（对象空间 [0,w]×[0,h]）
  Clips 裁剪（标准：对象空间，多个 Clip 交集；Clip 内多个 Area 并集）
  transform(CTM)
  [仅 manual 逆编码 Clips] 追加裁剪（Area.CTM 面积比 0.2–5）
  multiplyAlpha
  fill / stroke / drawImage
  restore
```

## 附录 D：文字绘制顺序

```
解析字体/字形
  TextCode 逐个
    确定起点 X/Y
    构建 unit（字符/字形/CGTransform），保持逻辑顺序
    按 ReadDirection 选择步进方向（+X/+Y/-X/-Y）
    逐 unit：
      CharDirection 旋转
      HScale 缩放
      Italic 剪切
      构建字形路径
      推进 pen（Delta 或字体 advance）
  合并路径
  fill（默认 true）
  stroke（默认 false）
```

---

> 本文是设计稿，不包含生产代码。下一步建议先做 M0 技术验证（ZIP 随机读 + 剥离字体 + CFF CID + Canvas 轮廓），确认后再进入 M1。

### 23.3 设计参考（非代码依赖）

- pdf.js 的 `CanvasFactory` / `CanvasGraphics` 是渲染器内部 scratch canvas 与 `beginGroup/endGroup` 的直接参考：
  - `https://github.com/mozilla/pdf.js/blob/master/src/display/canvas_factory.js`
  - `https://github.com/mozilla/pdf.js/blob/master/src/display/canvas.js`
  - `https://github.com/mozilla/pdf.js/blob/master/src/display/pattern_helper.js`
  - `https://github.com/mozilla/pdf.js/blob/master/src/display/api.js`
- 不复制 pdf.js 代码；只借鉴“factory 注入 + scratch 内部化 + 公开 API 不暴露 surface”的结构。
