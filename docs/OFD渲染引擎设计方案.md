# OFD 渲染引擎设计方案

本文描述 `@ofdrw/ofdrw-viewer-engine`（下称 engine）当前的渲染模型、模块边界、页面管线、资源策略和公共 API 语义。事实依据是 `packages/ofdrw-viewer-engine/src`、`test` 与 `packages/ofdrw-viewer-engine/skills/API.md`；两者不一致时以源码和可验证行为为准。

本文不承担 API 手册、测试矩阵、UI/CLI 交互或跨模块契约的职责：精确签名、字段、默认值和错误码见 [engine API](../packages/ofdrw-viewer-engine/skills/API.md)，生命周期与事件见 [生命周期与事件设计](OFD渲染引擎生命周期与事件设计.md)，跨包边界见 [CONTRACTS](CONTRACTS.md)，测试入口、fixture 和黄金图口径见 [测试方案](测试方案.md)。

## 1. 定位、范围与非目标

### 1.1 定位

engine 是平台无关的 OFD 页面渲染内核。它接收 OFD 字节或宿主提供的只读容器，解析包结构、XML、页面模型与资源，向宿主注入的 Canvas 2D 上下文输出像素；同时提供可选的文本层、页面图片导出和文档元数据读取。engine 不依赖 DOM、Node 文件系统或网络，也不假定宿主一定存在 `document`、`OffscreenCanvas` 或系统字体。

设计目标：

- **同一份页面模型可重复渲染**：准备阶段完成解析、资源加载和样式结算，绘制阶段保持同步、只读和可取消。
- **渲染器可替换**：页面内容和图元绘制通过 `Renderer` 抽象；宿主可以实现最小 Canvas 子集，或接入自己的合成/离屏策略。
- **按需读取**：打开文档只读 ZIP 中央目录与必要 XML；页面、模板、字体、图片和注释按页加载，不整包解压。
- **失败可降级**：单个对象、字体、图片、模板或注释失败只产生 warning 并跳过，不阻断整页；容器、页模型、画布等无法继续的错误才抛出。
- **边界可嵌入**：engine 不读取 URL/本地路径、不发现系统字体、不做解密和签名验证；这些由宿主或 `crypto` 包完成。

### 1.2 范围

当前实现覆盖：

- OFD 包读取：EOCD、ZIP64、中央目录、按需解压、路径规范化与包级限制。
- XML 与模型：Document、Pages、Page、Content、Template、公共资源、注释、签章外观、附件与签名条目元数据。
- 页面渲染：图层与模板顺序、对象裁剪、路径/文字/图片/复合对象、注释与签章外观。
- 样式结算：DrawParam 继承链、对象内联属性、颜色/渐变/底纹，以及结算结果的绘制期复用。
- 文本：字形轮廓排版、逐字形字体回退、文本层和搜索所需的字符几何。
- 平台接口：`ByteSource`、`VirtualContainer`、`Renderer`、`FontProvider`、`ImageDecoderPlugin`、`createCanvas`、`encodeImage`。
- 诊断：错误码、warning 去重、取消与关闭语义。
- 性能相关缓存：XML、字体字节、解码图片、页面模型、文本层和字形轮廓缓存。

### 1.3 非目标与当前不提供

以下能力不属于 engine 当前范围，文档和调用方不应把它们当作已实现行为：

- 阅读器 UI、工具栏、侧栏、缩放/翻页交互、打印对话框；由 UI 包负责。
- CLI 参数、批量转换、系统字体发现；由 CLI 包负责。
- 加密文档解密、密码/凭据管理、证书链、签名验证、时间戳；由 `crypto` 包负责。engine 只接受明文容器。
- 网络下载、URL/本地文件读取、HTTP Range、缓存代理；由宿主实现 `ByteSource` 或 `VirtualContainer`。
- OFD 编辑、表单填写、注释创建、签章写入、文档合并。
- PDF 或其他格式渲染；engine 只处理 OFD 包。
- 排版级文字整形（复杂脚本、连字替换、双向文本重排）；当前只按 OFD 的 `TextCode`、`CGTransform`、`DeltaX/DeltaY` 和 `ReadDirection/CharDirection` 绘制已有字形。
- 完整 ICC/DeviceN/Separation 色彩管理；当前支持 GRAY/RGB/CMYK 与调色板近似。
- 径向渐变的精确椭圆光栅化；当前降级为平均色并 warning。
- `page.renderRegion`、瓦片渲染、局部重绘；`OFDPage` 当前没有该能力，也不导出相关类型。
- 数字签名外观之外的签章语义（`NoZoom`、`NoRotate`、`Print` 等阅读器提示）；engine 只画静态 `Appearance`。

### 1.4 事实来源与文档边界

- **源码**：`src/index.ts` 的公共导出、`src/api` 的公共语义、`src/render` 的绘制顺序、`src/renderer` 的 Canvas 适配。
- **测试**：`test` 下的 API、render、text、container、smoke、golden、performance 用例给出可重复断言。
- **API 手册**：签名、选项字段、默认值、错误码、warning 码和公开类型只在 [engine API](../packages/ofdrw-viewer-engine/skills/API.md) 维护；本文只解释设计语义。
- **跨文档**：事件、字体、文本层、网络委托、跨包契约和测试分别由对应文档拥有；本文只保留与渲染设计直接相关的结论并链接。

## 2. OFD 渲染模型

### 2.1 包、文档与页面

OFD 包是一个 ZIP 容器，根目录含 `OFD.xml`，其中列出文档入口。engine 打开一个包后，默认取 `documentIndex=0` 的文档，读取其 `Document.xml`：

```
ZIP 包
  OFD.xml                    文档列表与入口
  Doc_0/Document.xml         页树、公共数据、资源入口
    Pages/Page               页引用（BaseLoc、模板、注释、签章）
    CommonData/PageArea      缺省页尺寸
    CommonData/PublicRes     字体、颜色空间等公共资源
    CommonData/DocumentRes   图片等文档资源
  Doc_0/Pages/Page_0/Content.xml
  Doc_0/Templates/Template_0/Content.xml
  Doc_0/Annots/PageAnnot_0.xml
  Doc_0/Signs/Signatures.xml、Seal.esl
```

`Pages` 可以递归嵌套，`Page` 是叶子。页树按前序遍历展开；页 ID 重复时保留先出现者并上报 `W_DUPLICATE_RESOURCE`。`BaseLoc` 解析为包内规范化路径，缺失或非法时 warning，页面仍保留但可能无法加载内容。

页面模型 (`PageModel`) 由页的 `Content.xml` 解码而来，包含 `id`、`area`（mm）、`size`、`layers`、`templates`、`pageRes`、`annotationFile`；页级资源作用域由 `getPageEntry` 另行构建为 `PageEntry.resources`，作为 `preparePage` 输入，不属于 `PageModel`；`PreparedPageBundle` 保存准备产物（字体、图片、独立块等），不保存该作用域字段。模板页也是 `PageModel`，其内容按图层合并到当前页，不单独输出。

### 2.2 坐标、单位与 Boundary

页面空间采用 OFD 约定：原点在左上角，X 向右，Y 向下，长度单位 mm。Canvas 设备空间方向相同，因此页面到设备只包含缩放和平移，没有 Y 翻转。

矩阵使用 Canvas 列向量约定：`A × B` 表示先应用 `B`，再应用 `A`；6 元组与 `ctx.transform(a,b,c,d,e,f)` 同序。页面到设备的矩阵为：

```
M_page = S(dpi / 25.4) × T(-PhysicalBox.x, -PhysicalBox.y)
       = [s, 0, 0, s, -s·x, -s·y]        // s = dpi / 25.4
```

默认 DPI 为 96；`getPageViewport` 按 `size(mm) × dpi / 25.4` 计算像素尺寸，并保留 3 位小数（0.001 px）。画布分配方通常对宽高取 `Math.ceil`，例如 `864.000 → 864`、`864.3 → 865`；engine 不替宿主分配或缩放 Canvas。

对象空间由 `Boundary`（对象在当前空间的外接矩形和裁剪矩形）、`CTM`（对象空间内的变换）和 `Clips`（对象空间裁剪）共同定义：

```
设备坐标 = M_page × translate(Boundary.x, Boundary.y) × CTM
```

- `Boundary` 的平移先于 `CTM`；`CTM` 只作用于对象数据（路径、文字、图片单位正方形），不改变 `Boundary` 本身。
- 标准 `Clips` 在对象空间、`CTM` 之前应用；非标准 `Clips@TransFlag=true` 在 `CTM` 之后应用。图片另有一条兼容判定：当图片 CTM 和裁剪矩阵的面积比例落在合理区间时，按逆 CTM 解释裁剪。
- 复合对象资源内部的 `Width/Height` 使用 0.3528 mm 单位，准备阶段乘 0.3528 转成 mm；内容按自身尺寸绘制，不拉伸到 `Boundary`。
- 图片局部空间是单位正方形。缺少 `CTM` 时默认按 identity 绘制（1 mm × 1 mm）并上报 `W_IMAGE_NO_CTM`；`strictImageCtm=false` 时才用 `Boundary` 宽高铺满。

### 2.3 图元与页面容器

页面内容由 `Layer` 和 `PageBlock` 组成，叶子是图元：

| 类型 | 模型 | 绘制语义 |
| --- | --- | --- |
| 路径 | `PathObject` | 路径命令、填充/描边、线型、虚线、裁剪 |
| 文字 | `TextObject` | 字体、字号、`TextCode`、`CGTransform`、`DeltaX/DeltaY`、阅读/字符方向、HScale |
| 图片 | `ImageObject` | 单位正方形、CTM、替换图、蒙版、边框、平滑 |
| 复合 | `CompositeObject` | 引用公共资源中的复合图形，内容在独立空间构建后整体映射 |
| 页面块 | `PageBlock` | 无边界/变换的递归容器，常见于模板、注释外观、复合资源和底纹单元 |

所有可绘制对象（PathObject/TextObject/ImageObject/CompositeObject）共享 `id`、`boundary`、`ctm`、`drawParam`、`alpha`、`visible`、线型字段和 `clips`。`alpha` 取值 0..255，缺省 255；`visible=false` 或 `alpha=0` 的对象不绘制。零宽/零高边界跳过并 warning；负宽/负高归一化到左上角并 warning。PageBlock 不是图元，只有 `id` 和 `children`，不参与样式结算，也没有 `boundary`/`ctm`/`alpha`/`visible` 等字段；它只承担递归容器语义。

### 2.4 绘制参数先结算、绘制只读

样式解析集中在准备阶段，绘制阶段不再读 XML 或解析 DrawParam。优先级从低到高为：

```
对象类型默认值 < 作用域继承 < DrawParam Relative 链 < 对象内联属性 < 子元素颜色
```

- 继承只传递线宽、端点/连接、斜接限制、虚线、填充/描边 Paint；`Fill`/`Stroke` 开关、`FillRule`、`Alpha` 不从父作用域继承。
- 文字默认黑填充、不描边；路径默认不填充、黑描边；图片/复合默认不填充、不描边。
- `DrawParam` 的 `Relative` 链有最大深度 16；超过深度或出现环时上报 `W_COMPOSITE_DEPTH` 并截断。
- 默认线宽 0.353 mm，默认斜接限制 4.234；`LineWidth=0` 按 hairline 处理：设备空间 1 像素，若无法确定设备缩放则回退 1 用户单位。
- 结算结果是 `ResolvedStyle`，准备阶段写入页面 bundle 的 `WeakMap`，绘制期按对象读取；对象缺少结算样式时 warning 并跳过。

### 2.5 引擎与宿主的职责边界

| 职责 | engine | 宿主/上层 |
| --- | --- | --- |
| 字节来源 | 接受 `arraybuffer`、`blob` 或 `ByteSource`，按需读取 | 负责网络、文件、权限、缓存 |
| 容器 | 默认 ZIP 容器；接受明文 `VirtualContainer` | 可注入解密后的明文容器；不可注入未解密的 raw 容器 |
| Canvas | 只在 `Renderer` 内部创建临时画布；不创建/清理主画布 | 提供主 `canvasContext`、`createCanvas`、`encodeImage` |
| 字体 | 解析文档内嵌字体、调用 `FontProvider`、逐字形回退 | 提供字体字节/字体文件、系统字体发现策略 |
| 图片解码 | 内置头部解析与 PNG/JPEG/WebP/BMP/GIF/JBIG2/TIFF 解码路径 | 可注入额外 `ImageDecoderPlugin` |
| 输出 | 页面像素、文本层、导出图片字节 | 展示、缩放、打印、保存 |
| 安全 | 包/XML/图片/画布限制，拒绝未解密容器 | 解密、验签、证书信任、内容访问控制 |

## 3. 实现口径与标准歧义

真实 OFD 文件与标准文本存在差异。下表是当前实现采用的稳定口径；未列出的属性按“能解析则使用，不能解析则 warning/跳过”处理，不因单个未知属性使整页失败。

| 问题 | 当前口径 |
| --- | --- |
| `Alpha` 缺省 | 缺省 255；显式 0 表示全透明，不绘制 |
| `MiterLimit` 缺省 | 4.234 |
| 图层顺序 | 默认 `type`：先画 `zOrder=Background` 的模板（模板内全部图层按 Background→Body→Foreground→Custom 顺序），再画 Background 页层；Body、Foreground 同理；最后画 Custom 页层。同组模板按引用顺序，页层按 XML 顺序。`layerOrder=document` 时先按模板引用顺序展开每个模板的全部图层，再按 XML 顺序展开页图层。未知值 warning 后回退 `type` |
| 页尺寸回退 | 页 `Area/PhysicalBox` → 按模板引用顺序第一个有效模板 `Area` → `CommonData/PageArea` → A4 210×297 mm；显式宽高非正会 warning，模板/CommonData 成功回退不提示，只有整条链失败落到 A4 时 warning |
| `LineWidth=0` | 设备空间 1 px hairline；无法计算设备缩放时回退 1 用户单位 |
| `Boundary` 零/负尺寸 | 零宽/零高跳过并 `W_ZERO_BOUNDARY`；负尺寸归一化到左上角并 `W_NEGATIVE_BOUNDARY`，归一化后仍为零则跳过 |
| 图片缺 `CTM` | 默认严格 identity（1×1 mm）并 `W_IMAGE_NO_CTM`；`strictImageCtm=false` 时铺满 `Boundary` |
| `DeltaX/DeltaY` | 支持数组、空白/逗号分隔、`g <count> <value>` 压缩组；显式 0 保留；缺失值按阅读方向轴回退字体 advance；无法解析的 token 跳过并 `W_BAD_NUMBER`；数量多于字符时静默忽略多余值 |
| `CGTransform` 位置 | 允许位于 `TextCode` 前或 `TextCode` 内；`CodePosition` 是当前 `TextCode` 的字符偏移；`CodecPosition`/`CodecCount` 作为拼写兼容 |
| `CGTransform` 多对多 | 字形列表作为整串按字体 advance 连续绘制，字符格只决定整串的总步进；不把字形按字符格比例拆开 |
| XML 命名空间 | 解析时忽略命名空间，按 local name 匹配；OFD 1.0/1.1 的两种命名空间均可读 |
| `Size` 与 `CTM` | `Size` 使用对象空间单位；最终字形大小由 `Size` 与 `CTM` 缩放共同决定，兼容“mm 单位 + CTM≈1”和“0.3528 mm 单位 + 小 CTM”两类文件 |
| `TextCode` 文本 | 解码 `\XXXX` 转义；字面空格保留为字符；XML 排版产生的 CR/LF 在排版前过滤，不占用 `DeltaX` 下标，也不触发缺字 warning |
| `ReadDirection` | 保持逻辑字符顺序；`X/Y` 是第一个逻辑字符原点；0=(+X)、90=(+Y)、180=(-X)、270=(-Y)；不反转字符/delta 数组 |
| `CharDirection` | 只让字形绕绘制点旋转，不改变 pen 步进方向 |
| `Alpha` 与复合对象 | 复合对象 `Alpha<255` 时通过独立合成组在组结束时整体乘一次；普通对象在绘制前乘 alpha |
| 图片格式 | 内置 PNG/JPEG/WebP/BMP 解码；GIF 取第一帧；JBIG2/TIFF 通过动态加载的内置插件或宿主插件解码；失败 warning 并跳过该图 |
| 复合对象尺寸 | `Width/Height` 先乘 0.3528 转为 mm；内容在独立空间按原尺寸绘制，`Boundary`/`CTM` 只负责放置和映射，不拉伸内容 |
| 注释/签章 | 只渲染静态 `Appearance`；`Visible=false` 跳过；`NoZoom/NoRotate/Print` 是阅读器提示，engine 不处理；签章图片按 `Seal.esl` 提取，缺失时 warning |
| 径向渐变 | 识别后以平均色/透明降级并 `W_RADIAL_UNSUPPORTED`，不进行椭圆光栅化 |
| Gouraud/LaGouraud | 软件光栅化，三角形内按重心坐标插值；`EdgeFlag` 控制四边形对角线，`VerticesPerRow` 控制网格；控制点不足或网格不完整时 `W_GOURAUD_APPROX` |
| 底纹 | `ReflectMethod` 支持 Normal/Column/Row/RowAndColumn；先按 `XStep/YStep` 排列，再整体应用底纹 `CTM`；单元内容走独立块 |
| BlendMode | 当前不解析 OFD 1.1 的扩展混合模式，按 Canvas 默认 `source-over` 绘制；`W_BLEND_MODE` 码保留，但当前绘制路径没有触发点 |
| 未识别属性/元素 | 忽略；影响可见结果时按具体图元 warning 或跳过，不使整页失败 |

## 4. 总体架构与依赖

### 4.1 包内分层

```
api/           公共门面：OFDDocument、OFDPage、RenderTask、viewport、warning、cache
  ↓
render/        页面准备、绘制顺序、对象/文字/图片/复合/底纹/注释
  ↓
resource/      页级资源作用域、资源缓存
style/         DrawParam、继承、颜色/渐变解析
font/          字体库、字体面、字形、逐字形回退
image/         图片格式识别与解码插件
model/         XML → 只读模型、页树、页面尺寸、权限、签名条目
xml/           saxes 封装、数字/属性读取、节点限制
container/     ZIP 读取、路径规范化、默认容器
platform/      ByteSource、VirtualContainer、FontProvider、ImageDecoderPlugin
common/        矩阵、颜色、LRU、显示列表、公共类型
renderer/      Canvas 2D 渲染器、Gouraud 光栅化、录制渲染器
```

`api` 依赖内部各层；`render` 不依赖 `api`、`container`、`xml`，只消费模型、资源 bundle 和 `Renderer`；`renderer` 只依赖 `common` 与公共错误工具 `errors`，不认识 OFD 模型；`model` 不引用 `render`/`renderer`/Canvas；`platform` 不反向依赖 `api`。这些边界由 `test/smoke/import-boundaries.test.ts` 做快速回归，根测试另做 AST 级依赖检查。

### 4.2 数据流

**打开文档**

```
OFDSource
  → VirtualContainer（默认 ZIP，或宿主注入）
  → OFD.xml / Document.xml
  → 页树、公共资源、文档元数据
  → OFDDocument
```

打开阶段只读入口 XML 和必要的页信息；页面内容、模板、字体、图片和注释在首次使用时加载。

**渲染一页**

```
OFDPage.render
  → getPageEntry（页面模型 + 页级资源作用域）
  → preparePage
      模板、注释、签章、字体、图片、复合资源、底纹单元
      样式结算、显示列表构建
  → drawPage（同步）
      页面矩阵/裁剪 → 图层顺序 → 对象绘制 → 注释 → 签章
  → Renderer → 宿主 Canvas
```

**取文本层**

```
OFDPage.getTextContent
  → 页模型 + 资源
  → 以默认 96 DPI 构建 mm 文本布局
  → 缓存 mm 结果
  → 按请求 DPI 转成 px 返回
```

文本层不创建 Canvas、不调用 Canvas 文字 API，也不改变页面绘制结果；详细坐标/字符规则见 [text-content-api](text-content-api.md)。

### 4.3 关键设计取舍

- **sax 流式解析 + 轻量节点树**：避免完整 DOM 和 XPath，降低内存与攻击面；命名空间前缀在节点名中丢弃。
- **模型与渲染分离**：模型是只读普通对象，不持有 Canvas、字体面或解码图片；渲染阶段可重复执行。
- **准备/绘制两段式**：异步资源加载、样式结算和显示列表构建集中在准备阶段，绘制阶段同步执行，便于取消、复用和自定义渲染器。
- **显示列表**：复合对象、注释外观、底纹单元先构建为 `DisplayList`，绘制期回放；图片句柄在准备阶段可以是延迟句柄，绘制时按当前渲染器和 DPI 物化。
- **虚拟容器**：所有包内读取通过 `VirtualContainer`，使默认 ZIP、解密容器和宿主自定义容器共享同一接口。
- **渲染器不暴露 surface**：临时画布、pattern tile、group 合成画布由 `H5Canvas2DRenderer` 内部管理，公共 API 只接触宿主提供的 Canvas 上下文。

## 5. 容器与资源读取

### 5.1 ByteSource 与容器所有权

`OFDSource` 只接受三类来源：

| 来源 | 用途 |
| --- | --- |
| `arraybuffer` | 已读入内存的 `ArrayBuffer`/`Uint8Array` |
| `blob` | 浏览器 `Blob`/`File`，由宿主提供 |
| `custom` | 宿主实现 `ByteSource`，提供 `size`、`read(offset,length)`，可选 `ready()`/`close()` |

engine 不发起网络请求、不读取本地路径，也不把 URL 当来源。URL/本地文件必须先由宿主读成字节，或实现 `ByteSource`；浏览器 `File`/`Blob` 可以直接作为 blob 来源，也可以读成 `arraybuffer`。字体也遵循同一原则：`FontInput` 只收已读好的字节，按需读取由 `FontProvider.match()` 完成。网络/文件来源的职责划分见 [网络与文件获取委托设计](网络获取委托设计.md)。

`VirtualContainer` 是 engine 的统一只读容器：

- `encrypted=false` 且 `read()` 返回明文的容器可以注入 `OFDDocument`。
- `encrypted=true` 的 raw package container 只能用于检查或交给 `crypto` 解密；直接注入打开会抛 `OFD_ENCRYPTED`。
- 由 `source` 或 `containerFactory` 创建的容器归 engine：打开失败或 `document.close()` 时 engine 关闭；以 `container` 注入的容器是借用，engine 不关闭，由调用方负责。`close()` 幂等。

### 5.2 ZIP 按需读取

默认容器实现只读取 EOCD（含 ZIP64 locator/record）和中央目录，条目内容在 `read` 时按局部文件头偏移解压：

1. 从文件尾部向前搜索 EOCD；检查注释长度与 EOCD 位置一致。
2. 若目录偏移/条目数/大小为 32 位哨兵值，读取 ZIP64 locator 与 record。
3. 解析中央目录，规范化路径并建立精确索引；大小写不同的同名条目只允许唯一回退，存在歧义时继续失败。
4. 读取条目时校验局部文件头、压缩方法、大小、压缩比和 CRC32。
5. `data descriptor`（通用标志 bit 3）以中央目录记录的大小为准，不信任局部头中的零值。

支持 `stored`（0）与 `deflate`（8）两种方法。加密条目、未知压缩方法、路径穿越、重复规范化路径、超过包/条目/总解压/压缩比限制的条目均拒绝；CRC 失败只 warning，不丢弃数据。

默认限制见 [engine API](../packages/ofdrw-viewer-engine/skills/API.md) 的 `ResourceLimits`；`0` 在多数限制中表示不限制，但生产环境不建议关闭包大小、单条目和总解压限制。

### 5.3 XML 解析

XML 层封装 `saxes`，目标是安全、可预测地读取 OFD XML，而不是实现通用 XPath：

- `xmlns:false`，节点名只保留 local name；OFD 1.0/1.1 命名空间不影响匹配。
- 解析前拒绝包含 `DOCTYPE` 或 `ENTITY` 声明的文本，防止 XXE 和实体膨胀。
- 默认最多 200,000 个节点、嵌套深度 128；超过抛 `OFD_LIMIT_EXCEEDED`。
- 空 XML、多个根节点、语法错误抛 `OFD_XML_PARSE`。
- 标准中的常见拼写错误在解析时同时写入规范名：`LincWidth`→`LineWidth`、`Scrif`→`Scrim`、`CodecPosition`→`CodePosition`、`CodecCount`→`CodeCount`。
- 数值读取统一走容错函数：非法数字 warning 后使用回退值，不因单个属性中断整页。

### 5.4 模型、页树与资源作用域

- 资源 ID 统一规范化：去空白、去前导 `#`、纯数字去前导零后转为十进制文本；非数字 ID 原样保留，由调用方决定 warning/跳过。
- 包内路径统一为 `/` 分隔、无前导 `/`、无 `..` 的规范化形式；`BaseLoc`、模板、图片、字体、注释、签章路径都经同一规范化函数。
- 页树展开时按 `Pages` 递归前序遍历，`Page` 为叶子；重复页 ID 保留先出现者。
- 页级资源作用域由公共资源（`PublicRes`/`DocumentRes`）与页内资源引用合并而成；模板、复合对象和底纹单元在需要时递归收集其字体、图片、DrawParam 和颜色空间。
- 资源收集有深度上限（16），超过时 `W_COMPOSITE_DEPTH` 并停止展开；运行期嵌套 `PageBlock` 另有 32 层保护。
- 注释按 `PageAnnot` 文件顺序加载；签章按 `Signatures.xml`/`StampAnnot` 顺序构建。单个模板、注释或签章加载失败只影响该项。

### 5.5 字体资源

字体来源优先级固定为：

```
文档内嵌 FontFile → 宿主 FontProvider → defaultFonts → supplementaryFonts
```

- `defaultFonts` 是文档完全没有可用字体时的兜底主字体，`supplementaryFonts` 参与逐字形回退；两者的命名匹配、评分和 CLI 系统字体发现有独立设计，本文不重复。
- `fontProvider.match()` 是字体按需读取的唯一入口；engine 不读 URL、不读本地路径。
- 回退是逐字形的：主字体缺字时才尝试回退链，不会整段切换字体。缺字上报 `W_GLYPH_MISSING`，字体资源缺失/加载失败上报 `W_FONT_MISSING`。
- 字体解析使用 `fontkit`；字体大小受 `maxFontBytes` 限制，字体字节按路径缓存在预算内。

字体优先级、命名匹配和 CLI/宿主的字体配置见 [渲染字体缺省方案设计](渲染字体缺省方案设计.md)。

### 5.6 图片资源

- 图片资源按 `mediaFile` 解析；同一路径的解码结果按字节预算缓存，淘汰时调用 `close()` 释放 `ImageBitmap` 等资源。
- 头部解析先识别 PNG/JPEG/WebP/BMP/GIF/JBIG2/TIFF，读取宽高并按 `maxImagePixels` 提前拒绝超大图。
- PNG/JPEG/WebP/BMP 使用平台解码能力或内置路径；GIF 解码第一帧；JBIG2/TIFF 使用动态加载的内置插件，宿主也可以通过 `imageDecoders` 注入。
- 解码失败上报 `W_IMAGE_DECODE` 或 `W_JBIG2_DECODE` 并跳过该图片；替换图缺失时回退主图。
- 图片绘制始终使用单位正方形 + 当前对象变换；替换图在 `dpi > 200` 时按 `auto` 模式优先，`always`/`never` 可显式控制。

## 6. 页面渲染管线

### 6.1 准备阶段

`preparePage` 是异步阶段，输入页面模型、页级资源作用域、加载器和取消信号，输出 `PreparedPageBundle`。主要步骤：

1. **模板**：并行加载页面引用的模板页；单个失败 warning 后跳过，不按数组位置回退到其他模板。
2. **注释与签章**：读取 `PageAnnot` 静态外观和 `StampAnnot`/`Seal.esl`；失败只影响对应块。
3. **资源收集**：遍历页面对象、模板、复合资源、底纹单元和 DrawParam `Relative` 链，收集字体、图片、DrawParam 和底纹。
4. **字体/图片加载**：字体按资源 ID 建 `FontFaceSet`；图片解码为 `DecodedImage`，绘制期再按渲染器创建句柄。缺失资源 warning 后继续。
5. **样式结算**：为每个对象计算 `ResolvedStyle`，结果写入页面 bundle；`DrawParam` 环/深度、颜色/渐变降级在此产生 warning。
6. **独立块构建**：注释、复合对象、底纹单元构建为 `IndependentBlock`/`DisplayList`；含 alpha 合成或动态内容的块标记为动态，绘制期递归。
7. **延迟图片**：底纹 tile 等准备阶段没有目标渲染器的位置使用延迟句柄，绘制期按实际渲染器和 DPI 物化。

准备阶段可取消：每个资源加载和阶段边界检查 signal；取消抛 `OFD_ABORTED`，已产生的临时对象由调用方/lifecycle 释放。

### 6.2 绘制阶段

`drawPage` 是同步阶段，不加载资源、不解析 XML、不改变页面模型。顺序：

1. `renderer.beginPage(canvasContext, viewport)`；不设置 Canvas 宽高，不清屏。
2. 重置变换并应用 `M_page`；以 `rect(0,0,page.area.w,page.area.h)` 裁剪页面内容，避免模板/图元画出 PhysicalBox。
3. 按图层顺序展开 `PageDrawEntry`，逐项 `drawObjects`。
4. 绘制注释外观块，按 `PageAnnot` 顺序。
5. 绘制签章外观块，按 `StampAnnot` 顺序；后出现的签章覆盖先出现的。
6. `renderer.endPage()`，恢复进入前状态。

页面绘制不填充背景。背景由宿主或 `exportImage` 的 `background` 选项负责；`page.render` 只画页面内容。

### 6.3 图层与模板顺序

默认 `layerOrder=type`，按标准图 16 的分组：

```
for type in [Background, Body, Foreground, Custom]:
  for template in page.templates (引用顺序):
    if template.zOrder == type:
      for templateType in [Background, Body, Foreground, Custom]:
        for layer in template.layers (模板内 XML 顺序):
          if layer.type == templateType: 绘制该模板图层
  for layer in page.layers (XML 顺序):
    if layer.type == type: 绘制页图层
```

`Custom` 没有模板 zOrder，只绘制页图层，排在 Foreground 之后。

`layerOrder=document` 更接近 XML 文档顺序：

```
for template in page.templates (引用顺序):
  for layer in template.layers (文档顺序): 绘制模板图层
for layer in page.layers (XML 顺序): 绘制页图层
```

`type` 模式在每个类型分组内先画模板、后画页图层；`document` 模式先画全部模板、再画全部页图层。后绘制的内容覆盖先绘制的内容；模板按引用顺序，不按 ID 或文件名排序。

### 6.4 对象绘制与裁剪

单个对象的绘制顺序固定：

```
if (!visible || alpha == 0) 跳过
normalize Boundary；零尺寸跳过，负尺寸 warning 后归一化
save
translate(Boundary.x, Boundary.y)
rect(0, 0, Boundary.w, Boundary.h); clip
if (!TransFlag) apply Clips        // 标准：对象空间，CTM 之前
transform(CTM)
if (TransFlag) apply Clips         // 兼容：CTM 之后
if (kind != composite) multiplyAlpha(alpha/255)
按 kind 绘制
restore（finally，失败也恢复）
```

裁剪语义：

- 一个 `Clip` 内多个 `Area` 取并集；多个 `Clip` 之间取交集。
- `Clips@TransFlag=true` 时，该对象的全部裁剪区在对象 CTM 之后应用；缺省/false 时按标准在 CTM 之前。
- 图片的兼容路径：若 CTM 行列式与各裁剪区矩阵的面积比例在 0.2..5 之间，按“裁剪区相对图片单位空间”解释，在 CTM 之后应用；否则按标准顺序。该判定只影响图片，且只在没有 `TransFlag=true` 时生效。
- 文字负宽 Boundary 的特殊兼容：当 `Boundary` 原始宽度为负且 `TextCode.X≈-w` 时，对象原点锚定到右边界，裁剪窗口覆盖 `[-w,0]`，保持右对齐文本不丢字。

单个对象绘制异常上报 `W_UNSUPPORTED_PAINT` 并跳过；`restore()` 失败不阻断后续对象。

### 6.5 页尺寸与 Viewport

页尺寸按 3 节回退链解析，结果始终是有效的 mm 尺寸。`page.getSize()` 返回该尺寸；`page.getViewport({dpi})` 返回像素尺寸。

- `page.render` 使用调用方传入的 `viewport`；engine 不校验它是否等于 `getPageViewport(getSize(), dpi)`，宿主应使用同一 DPI 计算，否则内容比例可能不符。
- `page.exportImage` 自行按请求 DPI 计算 viewport，并创建离屏画布；导出画布的宽高取 `ceil`，并受 `maxCanvasPixels` 限制。
- `PhysicalBox` 原点非零时，页面矩阵包含平移，并上报 `W_PHYSICALBOX_ORIGIN`；这兼容把内容坐标写成绝对坐标的文件。

## 7. 图元、文本与颜色

### 7.1 路径与描边

路径模型保存对象空间中的路径命令（移动到、直线、二次/三次贝塞尔、矩形、闭合）和包围盒。绘制期：

- 填充使用 `ResolvedStyle.fillPaint` 和 `fillRule`；描边使用 `strokePaint` 及线宽、端点、连接、斜接、虚线。
- 线宽/虚线单位是对象空间（通常 mm），由页面矩阵和对象 CTM 换到设备空间；`LineWidth=0` 按 hairline 处理，无法计算设备缩放时回退 1 用户单位。
- 渐变填充的坐标如果定义在对象外层空间，绘制前会先换回对象空间，避免 CTM 被重复应用。
- 不支持/非法的路径命令跳过并 `W_BAD_PATH`；非法数字 warning 后回退。

### 7.2 文字排版与轮廓

engine 不调用 Canvas 文字 API，而是把文字转成字形轮廓路径后填充/描边。核心步骤：

1. **解析字体链**：按嵌入/Provider/defaultFonts/supplementaryFonts 顺序建立主字体和回退链。
2. **过滤排版换行**：`TextCode` 中 XML 美化产生的 CR/LF 不参与排版，不占 `DeltaX/DeltaY` 下标，也不触发缺字 warning；普通空格保留。
3. **构建 unit**：按 `CGTransform` 和字符码点构建“字符/多字形串”单元；多字形串内部按字体 advance 排布，字符格只决定整串步进。
4. **计算起点**：每个 `TextCode` 的 `X/Y` 是第一个逻辑字符原点；缺省时沿用前一个 `TextCode` 的起点。
5. **逐 unit 放置**：按 `ReadDirection` 选择 +X/+Y/-X/-Y 步进；unit 内每个字形按字体 advance × Size / unitsPerEm × HScale 推进；`DeltaX/DeltaY` 优先于字体 advance（显式 0 保留）；横排的 `DeltaY` 即使不参与主步进也会被消费，用于软换行。
6. **字形变换**：`CharDirection` 让字形绕绘制点旋转；`HScale` 水平缩放；合成斜体按 shear 变换；合成粗体在字重 ≥600 且主字体非粗体时用描边加粗。
7. **路径合并**：所有字形轮廓合并后按样式填充/描边；默认文字填充、不描边。

缺字回退逐字形进行；主字体缺字时尝试回退链，仍缺失则 `W_GLYPH_MISSING` 并跳过该字形。字体资源缺失/加载失败 `W_FONT_MISSING`。

`getTextContent` 复用同一套布局与图层顺序，但只收集字符几何，不生成 Canvas 路径；其 px 坐标、`TextChar` 四边形、缓存和限制见 [text-content-api](text-content-api.md)。

### 7.3 图片绘制

- 图片数据以单位正方形绘制，变换由对象 `CTM` + 页面矩阵决定；边框在 `Boundary` 矩形上绘制，不受图片 CTM 旋转/缩放影响。
- 蒙版由渲染器用 `destination-in` 合成；engine 不创建宿主可见的 scratch canvas。
- 替换图在 `dpi > 200` 的 `auto` 模式下优先使用，`always`/`never` 可覆盖；替换图未解码时回退主图并 warning。
- 图片平滑默认开启；边框线宽为 0 时不画，圆角/虚线使用 `Boundary` 空间单位。
- 超大图片在解码前按头部宽高和 `maxImagePixels` 拒绝；画布尺寸另受 `maxCanvasPixels` 限制。

### 7.4 复合对象、独立块与底纹

复合对象、注释外观、签章外观和底纹单元统一用 `IndependentBlock` 表示：

- 块有独立坐标空间、`DisplayList` 和可选放置边界；内容按自身尺寸绘制，放置时只做平移/变换，不拉伸。
- 复合对象的 `Width/Height` 以 0.3528 mm 为单位，准备阶段转 mm。
- 注释/签章的 `Appearance.Boundary` 作为块放置边界；签章戳记的 `Clip` 作为块本地裁剪窗口，戳记图片白底按 `multiply` 合成。
- 块内可以嵌套复合对象/底纹；超过深度或出现环时 `W_COMPOSITE_DEPTH`，不再展开。
- 复合对象 `alpha<255` 时使用合成组；普通 alpha=255 的嵌套复合可在构建期展平到父显示列表，减少绘制期递归。
- 底纹 tile 先按 `XStep/YStep` 排列，再整体应用底纹 `CTM`；`ReflectMethod` 控制重复/镜像。平铺数量超过 10,000 时按纯色近似并上报 `W_PATTERN_LIMIT`；嵌套深度达到 8 或单 tile 超过 8,000,000 像素时静默降级/缩小，不上报 warning。

### 7.5 颜色、渐变与网格

- 颜色空间支持 GRAY、RGB、CMYK 和调色板索引；`GREY` 归一化为 `GRAY`，未知类型回退 RGB。
- 每通道位深支持 1/2/4/8/16；非法位深按 8 处理，通道值夹到 0..255。
- CMYK 使用乘法近似转 RGB，不做 ICC 色彩管理；调色板优先于颜色空间通道。
- 轴向渐变按颜色段和 `MapUnit`/`Extend` 映射到 Canvas 线性渐变；`Extend=0` 只保留轴线区间。
- 径向渐变当前降级为平均色并 `W_RADIAL_UNSUPPORTED`；调用方不能依赖精确椭圆渐变。
- Gouraud/LaGouraud 使用软件光栅化：按 `EdgeFlag` 三角化，三角形内重心插值，`VerticesPerRow` 分组；单图元上限 4,000,000 像素，超过时降采样并 warning。渲染器上下文缺少 `createImageData`/`putImageData` 时降级为平均色并 `W_GOURAUD_APPROX`。
- 渐变的颜色停靠点按 0..1 夹紧；非法颜色/停靠点 warning 后忽略或回退。

## 8. 跨平台与公共 API 语义

### 8.1 平台接口

| 接口 | 作用 | 当前约束 |
| --- | --- | --- |
| `ByteSource` | 随机读字节 | 必有 `size`/`read(offset,length)`；可选 `ready()` 在 ZIP 打开前等待探测，`close()` 在自有容器关闭时释放 |
| `VirtualContainer` | 包内文件列表/读取 | 注入 `OFDDocument` 的容器必须是明文；`encrypted=true` 会被拒绝 |
| `Canvas2DLike` / `CanvasRenderingContext2DLike` | 宿主画布与 2D 上下文 | 只需 engine 使用的方法/属性；不要求 `Path2D`、`DOMMatrix`、文字 API |
| `Renderer` | 页面/图元绘制扩展点 | 不感知 OFD 模型；自定义实现需支持 `beginPage/endPage/save/restore/transform/clip/fill/stroke/drawImage/beginGroup/endGroup` 等 |
| `FontProvider` | 按需提供字体字节 | `match()` 是唯一入口；engine 不读 URL/路径 |
| `ImageDecoderPlugin` | 额外图片格式 | 需返回 `DecodedImage`；内置 GIF/JBIG2/TIFF 动态插件可复用 |
| `createCanvas` | 默认渲染器和导出的临时画布 | 使用 group/pattern/Gouraud/图片蒙版等临时画布能力或导出时，Node/小程序应注入；H5 默认用 `document.createElement('canvas')`，Worker 回退 `OffscreenCanvas` |
| `encodeImage` | 导出图片编码 | 浏览器默认 `convertToBlob`/`toBlob`；Node/小程序必须注入 |

`Renderer` 的页面入口只接收宿主 `canvasContext` 和 `viewport`，不设置画布宽高、不清屏；临时/离屏画布由渲染器内部创建和销毁，不暴露给 engine 或调用方。

### 8.2 文档与页面的语义

- **打开**：`OFDDocument.open` 接受 `OFDSource` 或已构造的 `VirtualContainer`；`documentIndex` 选择包内文档；`signal` 取消打开。engine 创建的容器在打开失败/关闭时释放；调用方注入的容器由调用方持有和关闭。
- **页面**：页码从 0 开始；`getPage` 可带 `signal`，只取消本次等待，不必然中止其他调用方共享的加载。页对象可重复获取，底层页模型/资源按页缓存。
- **渲染**：`page.render` 是同步绘制入口，返回 `RenderTask`；`task.promise` 完成/失败/取消，`task.cancel()` 幂等。engine 不管理主 Canvas 的生命周期，也不清除已有像素。
- **准备**：`page.prepare` 幂等，只加载资源/构建 bundle，不创建 Canvas；可取消，文档关闭后抛 `OFD_CLOSED`。
- **导出**：`page.render` 与 `page.exportImage` 都使用文档级 `renderer` 绘制页面内容，因此自定义 renderer 会同时影响两者；导出另用 `createCanvas` 创建离屏画布、`encodeImage` 编码。导出旋转只改变输出方向，不改变页面模型或普通渲染。PNG 可透明，JPEG/WebP 的透明背景按白底处理。
- **文本层**：`page.getTextContent` 返回请求 DPI 下的字符几何，内部缓存 mm 布局；不要求先把页面渲染到 Canvas。
- **元数据**：`getPageInfos` 走轻量页信息路径，不加载页面内容；`getOutline`/`getBookmarks`/`getMetadata`/`getPermissions`/`getAttachments` 读取文档级信息；`getAttachmentData`/`getSignedValue` 返回原始字节，不解析、不验签。
- **关闭**：`document.close()` 幂等，关闭容器、清理文档级缓存、终止进行中的加载/渲染并清理页面监听器；关闭后需要文档/页资源或异步调度的操作（`render`/`prepare`/`exportImage`/`getTextContent` 及文档查询）以 `OFD_CLOSED` 拒绝；`getSize`/`getViewport` 等纯几何计算和 `close()` 仍可用，事件总线可读取（不再派发）。

精确方法签名、选项字段和返回类型见 [engine API](../packages/ofdrw-viewer-engine/skills/API.md)。

### 8.3 事件与诊断

文档和页面都有事件入口：`document.events`、页面上的 `on/once/off/addEventListener/removeEventListener`；`OFDOpenOptions.eventBus` 允许在打开完成前监听 `document:open:*`。事件命名、载荷、派发顺序和与 promise 的关系见 [生命周期与事件设计](OFD渲染引擎生命周期与事件设计.md)。

诊断分两层：

- **错误**：无法继续的失败，抛 `OFDError`；错误码与语义见 API 错误表。典型：包/XML 非法、页不存在、容器关闭、画布超限、渲染器不支持。
- **warning**：可降级的单对象/单资源失败，通过 `onWarning` 回调上报，不中断页面。warning 收集器按 `(code, pageIndex, objectId)` 去重，同一位置只上报一次；默认回调为空。

warning 和错误都不改变返回值结构；调用方需要根据 warning 决定是否提示用户。warning 码表与每条语义见 API 的 `Warning` 一节。

### 8.4 平台适配边界

| 环境 | 渲染 | 导出 | 字体 | 备注 |
| --- | --- | --- | --- | --- |
| 浏览器主线程 | 宿主 Canvas + 默认 H5 渲染器 | 默认 `convertToBlob`/`toBlob` | `FontProvider` 读字体字节 | 支持 `document.createElement('canvas')` |
| Web Worker / OffscreenCanvas | 默认用 `OffscreenCanvas`；无全局时注入 `createCanvas` | 默认 `OffscreenCanvas.convertToBlob`；不可用时注入 `encodeImage` | 通过 `FontProvider` | 无 DOM；不能依赖 `document` |
| Node.js | 注入 `createCanvas`（如 `@napi-rs/canvas`） | 注入 `createCanvas` + `encodeImage` | `FontProvider`/本地字体字节由宿主读取 | engine 不直接依赖原生 Canvas |
| 微信小程序 | 注入 `createCanvas`，通常渲染到组件 canvas | 不直接调用 `exportImage`；用组件 canvas 截图 | 字体字节由宿主提供 | 无 `OffscreenCanvas` 编码入口；`exportImage` 需要可编码的离屏画布 |

平台差异只影响 Canvas/字体/图片解码注入，不影响页面模型、绘制顺序或文本层坐标。`open` 不创建临时画布，不受 `createCanvas` 影响。Node/小程序应在需要 group/pattern/Gouraud/图片蒙版等临时画布能力时注入 `createCanvas`；否则这些绘制路径报 `OFD_RENDERER_UNSUPPORTED`，简单 path/text 渲染仍可工作。

## 9. 缓存、并发、取消与内存

### 9.1 缓存层级

| 缓存 | 键 | 预算/上限 | 释放 |
| --- | --- | --- | --- |
| XML | 包内路径 | `cache.xmlBytes`，默认 16 MiB | 丢弃节点树；按字节估算 |
| 字体字节 | 包内路径 | `cache.fontBytes`，默认 64 MiB | 丢弃 `Uint8Array` |
| 解码图片 | 图片 `mediaFile` | `cache.imageBytes`，默认 64 MiB | 淘汰时调用 `close()` |
| 页面模型 | 页索引 | `cache.pageModels`，默认 8 页 | 丢弃页模型/资源作用域；进行中的加载有独立 pending |
| 文本层 mm 布局 | 页索引 + 文本配置（不含 DPI） | `cache.textPages`，默认 4 页 | 丢弃 mm 布局；px 换算在返回时进行 |
| 字形轮廓 | 字体面 + 字形 ID | 固定 20,000 条 | 进程级共享；丢弃轮廓路径，close 不清空 |

- 字节预算为 0 时表示不限制；条目预算为 0 时表示不限制。生产环境不建议把字节预算设为 0。
- XML、字体字节、图片、页面模型、文本 mm 等文档级 LRU 按文档实例隔离；`close()` 清空这些缓存并释放可释放资源。字形轮廓缓存是进程级共享对象，`close()` 不清空它，只按固定 20,000 条自然淘汰。
- 图片缓存淘汰会调用 `close()`，避免 `ImageBitmap` 长期占用显存；字体/XML 缓存直接丢弃引用。
- 页面模型缓存与页级 `SharedLoad` 配合：同一页的并发 `getPage` 共享一次加载，失败时删除缓存项。
- `page.prepare` 生成的 bundle 另存，当前不参与 `pageModels` 淘汰，直到 `document.close()` 才清空；对大量页显式 prepare 会保留相应内存。

### 9.2 并发

- **同一 Canvas 串行**：`renderPage` 按 `canvasContext.canvas` 维护 promise 链；同一画布上的多次 `render` 按提交顺序执行，前一个失败不阻断后一个。
- **同一页面共享加载**：页模型和文本层的并发请求通过 `SharedLoad` 共享底层 promise；页面准备通过 `preparePending` 合并并发 `page.prepare`。`render` 的隐式准备不参与 `preparePending`，与显式 `prepare` 之间可能各自构建一次 bundle；字体/图片/XML 缓存会复用已解码资源。只有页模型/文本的 `SharedLoad` 有等待方计数：最后一个等待方取消且底层尚未完成时中止；`prepare` 的共享构建不受调用方 `signal` 中止，只受 `close()` 控制，调用方 `signal` 只取消本次等待。
- **不同页面/不同 Canvas 可并行**：只要不共享同一个 Canvas 上下文，页面准备和绘制可以并行；字体/图片缓存是文档级共享，需保证写入幂等。
- **导出与普通渲染**：导出创建独立离屏画布，可与主画布渲染并行；二者共享文档级 renderer 时，渲染器实现需要自行保证内部状态安全。默认 `H5Canvas2DRenderer` 按页面激活状态管理 scratch，不应跨文档复用实例。

### 9.3 取消与关闭

- `OFDDocument.open({signal})` 取消打开；engine 自有的容器会被关闭，调用方注入的容器仍由调用方负责。
- `getPage`/`getPageInfos`/文本/导出等方法支持 `signal`；中止时以 `OFD_ABORTED` 拒绝，原因保留在 `cause`。
- `page.render` 的 `RenderTask.cancel()` 取消本次渲染；同一画布队列中的后续任务继续执行。
- `document.close()` 会中止所有活动操作（包括共享加载、渲染、文本构建），然后清理缓存/监听器/容器；关闭后需要文档/页资源或异步调度的操作（`render`/`prepare`/`exportImage`/`getTextContent` 及文档查询）以 `OFD_CLOSED` 拒绝；`getSize`/`getViewport` 等纯几何计算和 `close()` 仍可用，事件总线可读取（不再派发）。
- 取消/关闭与真正失败分开：`OFD_ABORTED`/`OFD_CLOSED` 不会被包装成渲染失败；调用方可用错误码区分。

### 9.4 内存策略

- 打开时只保留容器、入口 XML 和页信息；页面内容/模板/字体/图片按需加载。
- 页面模型受 `pageModels` 预算控制；`page.prepare` 的 bundle 独立保留到关闭，批量预取大量页时内存随页数增长。
- 图片解码结果受 `maxImagePixels` 和 `imageBytes` 双重约束；导出画布受 `maxCanvasPixels` 约束。
- 底纹 tile 和 group 使用渲染器内部临时画布，绘制结束/页面结束释放；tile 像素和数量有独立上限。
- 显示列表只保存路径/绘制命令和图片句柄，不保存页面 XML；复合/底纹单元复用同一显示列表。
- 字形轮廓缓存是进程级共享对象，条目数固定；字体面按文档/字体资源缓存，`document.close()` 后不再持有。

## 10. 安全、健壮性与性能

### 10.1 安全边界

engine 处理不可信文档，默认按“敌意输入”设计：

- **不解密、不验签**：未解密的 raw 容器注入会被拒绝；签名条目/附件只作为只读元数据/字节返回，不执行证书链或签名验证。
- **不联网、不读文件**：来源只能是内存/Blob/宿主 `ByteSource`；字体只能来自内嵌或 `FontProvider` 提供的字节。
- **ZIP 防护**：限制包大小、条目数、单条目大小、总解压大小和压缩比；拒绝加密条目、未知压缩方法、路径穿越和重复规范化路径；CRC 失败只 warning。
- **XML 防护**：拒绝 DTD/实体声明，限制节点数和嵌套深度，错误 XML 不进入模型层。
- **资源防护**：图片像素、画布像素、字体大小、XML 大小、递归深度均有上限；超限抛 `OFD_LIMIT_EXCEEDED` 或 warning 后降级。
- **解析器隔离**：字体解析在 JS 层完成，图片解码使用平台能力或 JS 插件；两者都不执行文档中的脚本、链接或外部实体，也不把文档内容拼进 `eval`/`Function`。
- **内存释放**：图片/画布/容器在淘汰或关闭时释放；`close()` 幂等，避免重复释放。

### 10.2 健壮性

- 页面级失败（容器损坏、页面 XML 无法解析、页不存在）抛错；单对象/单资源失败 warning 后跳过。
- 模板加载失败按“缺失模板”处理，不按数组位置回退，避免错画其他模板。
- 字体缺失/缺字、图片解码失败、注释空外观、签章缺图都只影响对应内容。
- 单对象绘制异常被捕获并 `W_UNSUPPORTED_PAINT`，`restore()` 在 finally 中执行，不污染后续对象。
- 页尺寸回退链始终给出有效尺寸；最终 A4 回退 warning，调用方仍可渲染。
- 取消/关闭是终止性错误，不被资源回退逻辑吞掉。

### 10.3 性能口径

性能口径以 `test/performance/text-perf.test.ts` 与 `test/api/page-info.test.ts` 的常量/断言为准，测量 engine draw 阶段，不把 PNG 编码算入渲染耗时。普通页的 500/150/80 ms 是记录在性能测试中的目标值，不套用于 `dense-text-perf`；压力样本和 1000 页场景有独立断言：

| 场景 | 口径 | 当前目标/断言 |
| --- | --- | --- |
| 普通页首次渲染 | 96 DPI，engine draw | 目标 ≤ 500 ms（记录，不作为 dense 样本阈值） |
| 同文档翻页 | 第二页首次 draw | 目标 ≤ 150 ms |
| 二次渲染 | 回到已渲染页，缓存命中 | 目标 ≤ 80 ms |
| `dense-text-perf` 首次 draw | 2 页 A4、约 1.45 MB Content.xml、大量 TextObject/路径 | ≤ 800 ms |
| `dense-text-perf` 翻页 | 同文档第二页 | ≤ 1000 ms |
| `dense-text-perf` 二次 draw | 缓存命中 | ≤ 600 ms |
| `dense-text-perf` 内存 | 3 次渲染 heapUsed 增长量 | ≤ 150 MiB |
| 1000 页 `getPageInfos` | 冷启动/缓存 | 冷 ≤ 300 ms，缓存 ≤ 50 ms |

`dense-text-perf` 与 1000 页场景的数值是回归门禁，普通页数值是目标基线；它们都不是对所有设备/文档的 SLA。极端样本有单独阈值，不能把普通页阈值套到压力样本，也不能反过来放宽普通页目标。样本缺失时相关测试会跳过；正式性能验证需要样本包可用。

### 10.4 当前边界与风险

- **Canvas 2D 依赖**：默认渲染器需要可用的 2D 上下文和临时画布；不支持 WebGL/WebGPU 后端。
- **OFD 子集**：当前覆盖主流程图元、文本、图片、复合、底纹、注释/签章外观；不覆盖所有 OFD 1.1 扩展（如混合模式、复杂颜色空间）。
- **字体依赖宿主**：不内置 CJK 字体；无字体时文字会缺字/回退，调用方必须提供字体或 Provider。
- **色彩近似**：CMYK 转 RGB、径向渐变平均色、Gouraud 降采样都是近似，不能作为印刷级色彩依据。
- **JBIG2/TIFF/GIF**：依赖动态插件；首次解码有额外加载成本，GIF 只取第一帧。
- **无签名验证/解密**：需要 `crypto` 包或宿主完成；engine 只渲染已解密、可信外观。
- **性能受文档结构影响**：大量模板/复合/底纹会增加准备阶段工作量；缓存预算过小会导致重复解析。
- **递归/缓存硬上限**：资源收集深度 16、运行期嵌套块 32，更深结构会被截断并 warning；字形轮廓缓存固定 20,000 条，按条目自然淘汰。
- **BlendMode**：`W_BLEND_MODE` 已注册但当前没有解析/触发路径；OFD 1.1 混合模式不会生效。

## 11. 验证方式

engine 的验证分四层，完整 fixture、样本清单和报告格式见 [测试方案](测试方案.md)。

### 11.1 命令入口

```bash
# 包内全量单测
pnpm -C packages/ofdrw-viewer-engine test

# 根目录全量（等价于上面的 engine 测试）
pnpm test

# 快速 smoke：公共 API、导入边界、导出契约
pnpm -C packages/ofdrw-viewer-engine exec vitest run test/smoke

# 黄金图（样本缺失时跳过）
pnpm test:golden

# 严格审计
pnpm -C packages/ofdrw-viewer-engine test:audit
```

### 11.2 关键断言

- **公共 API**：`test/smoke/public-api-doc.test.ts` 检查 `src/index.ts` 的每个导出名都出现在 [engine API](../packages/ofdrw-viewer-engine/skills/API.md)；`test/smoke/open-options.test.ts` 检查打开选项默认值和导出契约。
- **导入边界**：`test/smoke/import-boundaries.test.ts` 检查 `render/common` 不依赖 Node/原生 Canvas、`renderer` 不依赖 model/style/render/api、`api` 不直接 import `ZipReader`、`platform` 不反向依赖 `api`。
- **容器/XML**：ZIP EOCD/ZIP64、路径穿越、重复路径、加密/压缩方法、CRC、大小限制、XML DTD/节点/深度限制均有单测。
- **渲染**：路径/文字/图片/复合/注释/裁剪/图层顺序/页尺寸回退/底纹/Gouraud 的 render 测试；文字布局有独立 `test/text-layout` 和 `test/text-content`。
- **取消/生命周期**：`test/api` 覆盖 open/getPage/render/export/text 的取消、关闭、并发和错误分类。
- **黄金图**：对样本 OFD 渲染 PNG，与基线做像素差异/人工审核；PDF 配对只作为版式参考，不要求逐像素一致。
- **性能**：上述 `text-perf` 与 `page-info` 断言，测量 engine draw 与内存增长。

### 11.3 覆盖原则

测试按“可验证行为”而非实现细节组织：模型解码验证对象字段，render 验证绘制命令/顺序，API 验证 promise/取消/错误，golden 验证整体视觉。新增行为应优先补到对应层，而不是只改文档；文档中的默认值、限制、错误码必须能在源码或测试中找到依据。

## 12. 附录：默认值、顺序与绘制速查

### 12.1 默认值与内部上限

公共默认值、错误码、warning 码和完整字段表以 [engine API](../packages/ofdrw-viewer-engine/skills/API.md) 为准。以下是本文涉及、API 表未逐项列出的内部常量或实现事实：

| 项 | 值 | 说明 |
| --- | --- | --- |
| XML 最大节点数 | 200,000 | 默认，可由 `XmlParseOptions.maxNodes` 覆盖 |
| XML 最大嵌套深度 | 128 | 默认，可由 `XmlParseOptions.maxDepth` 覆盖 |
| 资源收集深度 | 16 | 复合/底纹/DrawParam 递归；超过 `W_COMPOSITE_DEPTH` |
| 运行期嵌套块深度 | 32 | `PageBlock` 递归绘制上限 |
| 单次底纹平铺数量 | 10,000 | 超过 `W_PATTERN_LIMIT`，按纯色近似 |
| 底纹嵌套深度 | 8 | 达到后按纯色近似；无 warning |
| 单 tile 像素 | 8,000,000 | 超过时按比例缩小；无 warning |
| Gouraud 单图元像素 | 4,000,000 | 超过时降采样 |
| 文字单批字形数 | 5,000 | 批量构建轮廓，避免单次路径过大 |
| `DeltaX/DeltaY` 展开值上限 | 100,000 | 防止恶意 `g` 组耗尽内存 |
| 字形轮廓缓存 | 20,000 条 | 固定上限，按条目淘汰 |
| 页尺寸最终回退 | A4 210×297 mm | 全链失败时 warning 后使用 |

### 12.2 渲染顺序

默认 `layerOrder=type`：

```
页面内容（engine 不填充背景）
  Background
    模板的全部图层（zOrder=Background，按模板引用顺序；每个模板内按图层类型顺序）
    页图层 Background（XML 顺序）
  Body
    模板的全部图层（zOrder=Body）
    页图层 Body
  Foreground
    模板的全部图层（zOrder=Foreground）
    页图层 Foreground
  Custom
    页图层（XML 顺序）
  注释外观（PageAnnot 文件顺序）
  签章外观（StampAnnot 顺序，后出现覆盖先出现）
```

`layerOrder=document`：

```
所有模板（按页面引用顺序，每个模板内按 XML 图层顺序）
所有页图层（XML 顺序）
注释外观
签章外观
```

### 12.3 对象裁剪顺序

```
对象 Alpha/Visible 判断
  save
  translate(Boundary.x, Boundary.y)
  Boundary 裁剪（对象空间 [0,w]×[0,h]）
  if (!TransFlag)
      Clips 裁剪（标准：对象空间，多个 Clip 交集；Clip 内多个 Area 并集）
  transform(CTM)
  if (TransFlag)
      Clips 裁剪（兼容：CTM 之后）
  if (图片且满足逆 CTM 兼容判定且无 TransFlag)
      Clips 裁剪（图片单位空间解释）
  multiplyAlpha（非复合对象）
  fill / stroke / drawImage / 组绘制
  restore
```

### 12.4 文字绘制顺序

```
解析字体链
  过滤 TextCode 中的 CR/LF
  逐个 TextCode
    确定起点 X/Y（缺省沿用前一 TextCode）
    构建 unit（字符/字形/CGTransform），保持逻辑顺序
    按 ReadDirection 选择步进方向（+X/+Y/-X/-Y）
    逐 unit
      逐字形放置：字体 advance × Size / unitsPerEm × HScale
      消费 DeltaX/DeltaY（显式 0 保留；缺失按阅读方向轴回退 advance）
      CharDirection 旋转字形
      HScale 缩放
      合成斜体 shear
      合并字形轮廓
  合成粗体（字重 ≥600 且主字体非粗体时描边加粗）
  fill（默认 true）
  stroke（默认 false）
```