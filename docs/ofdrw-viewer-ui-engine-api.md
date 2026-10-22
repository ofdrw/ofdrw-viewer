# @ofdrw/ofdrw-viewer-ui 所需引擎 API 与功能说明

| 项 | 内容 |
|---|---|
| 状态 | 已确认并实现（P0/P1 + P2 权限/附件/导出旋转；renderRegion 暂不实现） |
| 版本 | 0.3 |
| 日期 | 2026-10-22 |
| 使用方 | `@ofdrw/ofdrw-viewer-ui` |
| 提供方 | `@ofdrw/ofdrw-viewer-engine` |
| 关联设计 | [ofdrw-viewer-ui 设计方案](./ofdrw-viewer-ui设计方案.md) |
| 核心边界 | 引擎只负责**从 OFD 容器读取数据、结构化为对象信息、返回原始字节**；不解析电子签章，不做 ASN.1/X.509/证书链/签名值/时间戳验证，不负责 UI |

## 0. 边界声明

### 0.1 引擎做什么

- 打开/关闭 OFD 容器，读取 ZIP 条目。
- 解析 OFD XML（`Document.xml`、`Page.xml`、`Signatures.xml`、`Signature.xml`、`OFD.xml` 等）为**对象信息**。
- 提供页面尺寸、页面文本/空间信息、大纲、书签、签章 XML 元数据、原始签章资源字节、文档元数据、权限、附件。
- 复用现有渲染管线绘制页面和签章外观。

### 0.2 引擎不做什么

- **不解析 `SignedValue.dat` 的 ASN.1 结构**；不解析 DER/BER、X.509 证书、CMS/SES 字段。
- 不把 `Seal.esl` 作为公开资源；印章信息由 UI 从 `SignedValue.dat` 的 `TBS_Sign.eseal` 获取。
- 不判断签章时间、签署人、证书主题、印章类型、签章有效性。
- 不做证书链、CRL/OCSP、时间戳、签名值验证。
- 不实现阅读器 UI、布局、缩放、打印编排；提供整页 `exportImage`（含可选导出旋转），但不负责阅读器交互旋转/裁剪。

### 0.3 签章数据的分工

```text
引擎：
  Signatures.xml 索引
  Signature.xml 元数据（ID/Type/Provider/SignatureDateTime/StampAnnot/资源路径）
  SignedValue.dat 原始字节
        │
        ▼
@ofdrw/ofdrw-viewer-ui 的 SignatureService：
  ASN.1 解析 SES_Signature
  从 TBS_Sign.eseal 取印章信息
  X.509 证书解析
  字段映射、格式化、错误降级
        │
        ▼
UI：签章列表、页面覆盖层、详情面板、“未验证”标识
```

这样引擎不依赖 `asn1js` / `asn1.js` / `@peculiar/*`，包体和职责都更小；签章格式差异由 UI 侧处理。

> 为什么只返回 `SignedValue.dat`：v1/v4/v5 的 `TBS_Sign` 都包含 `eseal`，印章信息（名称/类型/图片等）可以从 `SignedValue.dat` 得到，因此不需要再单独读取 `Seal.esl`。`Seal.esl` 仅保留给引擎渲染外观的内部路径使用，不进入公开 API。

> 说明：引擎现有的 `decodeSealImage` 为了**渲染签章外观**可能读取 `Seal.esl`；这属于渲染路径，不是本次公开的签章信息 API。

---

## 1. API 总览

| API | 优先级 | 状态 | 功能 | 读取 | 是否解析 ASN.1 |
|---|---|---|---|---|---|
| `document.getPageInfos(options?)` | P0 | 已实现 | 批量页尺寸/页区域 | 页树、`Page.xml` 的 `Area`、模板回退 | 否 |
| `page.getTextContent(options?)` | P0 | 已实现 | 页面文本与空间信息 | 页面模型、字体、文本布局 | 否 |
| `document.getOutline(options?)` | P0 | 已实现 | 大纲树 + 跳转目标 | `Document.xml` 的 `Outlines` | 否 |
| `document.getBookmarks(options?)` | P0 | 已实现 | 书签列表 + 跳转目标 | `Document.xml` 的 `Bookmarks` | 否 |
| `document.getSignatureEntries(options?)` | P0 | 已实现 | 签章 XML 元数据、页面位置、资源路径 | `Signatures.xml`、`Signature.xml` | **否** |
| `document.getSignedValue(id, options?)` | P0 | 已实现 | 返回 `SignedValue.dat` 原始字节；印章信息在该文件的 `TBS_Sign.eseal` 中 | ZIP 条目 | **否** |
| `document.getMetadata()` | P1 | 已实现 | 文档属性 | `OFD.xml` 的 `DocInfo` | 否 |
| `page.prepare(options?)` | P1 | 已实现 | 预取页面模型/字体/图片 | 页面资源 | 否 |
| `document.getPermissions()` | P2 | 已实现 | 文档权限声明（只读，不强制） | `Document.xml` 的 `Permissions` | 否 |
| `document.getAttachments()` / `getAttachmentData()` | P2 | 已实现 | 附件元信息/原始字节（不解析内容） | `Attachments.xml`、附件条目 | 否 |
| `exportImage({ rotation })` | P2 | 已实现 | 仅导出方向旋转 | 页面 | 否 |
| `page.renderRegion(...)` | P2 | **暂不实现/无排期** | 局部/瓦片渲染；不导出、不在 `OFDPage` 上 | 页面 | 否 |

---

## 2. 通用约定

### 2.1 异步、取消、缓存

- 所有 IO 型 API 返回 `Promise`；可选 `signal?: AbortSignal`。
- 取消以 `OFD_ABORTED` 拒绝；文档已关闭以 `OFD_CLOSED` 拒绝。
- 同一资源的并发请求应去重（返回同一个 Promise 或共享结果），避免重复读 ZIP。
- 结果缓存到 `document.close()`；关闭后清空，不允许返回旧文档数据。
- `getSignedValue` 的原始字节**不建议长期缓存**：文件可能较大，UI 解析后只缓存结构化详情；引擎可按字节数做有界 LRU 或每次读取。

### 2.2 单位

| 数据 | 单位 | 说明 |
|---|---|---|
| `PageInfo.widthMm/heightMm` | mm | 页面物理尺寸 |
| `Box` | mm | `x/y/width/height`，OFD 页面坐标，原点 PhysicalBox 左上角 |
| `DocumentDestination` 坐标 | mm | 与 OFD `Dest` 一致 |
| `TextContent` 全部几何 | px | `dpi` 对应像素；原点页面左上角，y 向下 |
| `zoom` | 倍率 | 1 = 100%；不做百分比转换 |
| `AttachmentInfo.size` | byte | 文件大小 |
| 日期 | 字符串 | 保留 OFD 原文（ISO 形式）；引擎不做时区推断 |

### 2.3 错误与 warning

- 错误类型：`OFDError`（现有），`code` 使用现有 `OFD_*`。
- warning：`OFDWarning`，不中断；同一 `(code, pageIndex, objectId/resourceId)` 去重。
- 可选信息缺失（无大纲、无书签、无签章、无附件）**不是错误**，返回空数组/`undefined`。
- 单个条目损坏（某一页尺寸、某一个签章 XML）只 warning，不影响其他条目。
- 容器损坏/索引无法读取才是错误。

建议新增 warning 码（字符串类型已允许扩展）：

| 码 | 场景 |
|---|---|
| `W_PAGE_INFO_MISSING` | 页树有页但 `Page.xml` 缺失/无法定位 |
| `W_PAGE_INFO_INVALID` | `Area`/模板尺寸非法，回退默认 |
| `W_OUTLINE_TARGET` | 大纲 `Dest` 的 PageID/类型/坐标无效 |
| `W_BOOKMARK_TARGET` | 书签 `Dest` 无效 |
| `W_SIGNATURE_ENTRY` | `Signatures.xml`/`Signature.xml` 条目损坏或字段缺失 |
| `W_SIGNATURE_RESOURCE` | 声明了 `SignedValue.dat` 但读取失败 |
| `W_METADATA_FIELD` | `DocInfo` 字段格式非法，跳过该字段 |
| `W_PERMISSION_FIELD` | 权限字段非法，按默认值处理 |

### 2.4 API 稳定性

- 新增 API 为加法式；不改变现有 `OFDDocument`/`OFDPage` 行为。
- 不公开内部 `PageModel`/`PreparedPageBundle`/`DerNode` 等实现类型。
- 所有公开类型从 `src/index.ts` 导出；命名稳定，后续只做可选字段扩展。
- `CacheOptions` 只加可选字段（如 `textPages`），不破坏旧调用方。

---

## 3. `document.getPageInfos`

### 3.1 签名

```ts
interface PageInfoOptions {
  /** 起始页索引，0-based；默认 0。 */
  start?: number;
  /** 返回页数；默认剩余全部；0 表示空。 */
  count?: number;
  /** 取消信号。 */
  signal?: AbortSignal;
}

interface PageInfo {
  /** 页索引，0-based。 */
  index: number;
  /** 页宽，mm。 */
  widthMm: number;
  /** 页高，mm。 */
  heightMm: number;
  /** PhysicalBox 原点 x，mm；可选。 */
  xMm?: number;
  /** PhysicalBox 原点 y，mm；可选。 */
  yMm?: number;
}

getPageInfos(options?: PageInfoOptions): Promise<readonly PageInfo[]>;
```

### 3.2 功能说明

- 返回连续页的尺寸信息，供 UI 建立页壳、计算总高度、虚拟滚动、缩略图布局。
- **只读页树 + 每页 `Page.xml` 的 `Area`**；必要时按现有回退链解析模板/`CommonData/PageArea`。
- **不得**调用 `preparePage`、解码字体/图片、构建 display list、创建 canvas。
- `start` 越界：返回空数组，不抛错；`count` 越界：截断到实际页数。
- 结果按 `index` 升序；必须与 `page.getSize()` 完全一致（同源解析逻辑）。
- 缺失/非法页：warning，返回可用的宽高（回退默认 A4 或 `CommonData/PageArea`），并标记来源（可选字段 `source?: 'page' | 'template' | 'default'`，P1）。
- 缓存：按文档缓存全部/分片结果；同一页重复请求不重复读 XML。
- 1000 页目标：首次 ≤ 300 ms（本地 ZIP，参考机）；缓存后 ≤ 50 ms。

### 3.3 验收

| 用例 | 断言 |
|---|---|
| 1000 页 A4 | 返回 1000 条，与逐页 `getSize()` 一致 |
| 混合页尺寸 | 每条按自己的 `Area` |
| 模板页尺寸 | 正确回退到模板/CommonData |
| 缺失 `Page.xml` | 该页 warning + 可用回退尺寸，其余页正常 |
| 非法 `Area` | warning，不产生 NaN/负值 |
| `start/count` | 边界正确，顺序正确 |
| abort | `OFD_ABORTED`，无未处理 rejection |
| close | `OFD_CLOSED` |

---

## 4. `page.getTextContent`

### 4.1 签名

```ts
interface TextContentOptions {
  /** 输出 DPI，默认 96；非法值回退 96。 */
  dpi?: number;
  /** 是否返回 chars，默认 true。 */
  includeChars?: boolean;
  /** 是否包含注释 Appearance 文字，默认 false。 */
  includeAnnotations?: boolean;
  /** 是否包含不可见文字，默认 false。 */
  includeInvisible?: boolean;
  /** 图层顺序；缺省沿用打开时的 layerOrder。 */
  layerOrder?: 'document' | 'type';
  /** 取消信号。 */
  signal?: AbortSignal;
  /** 文本项上限，默认 20,000；0 表示不限。 */
  maxTextItems?: number;
  /** 字符上限，默认 500,000；0 表示不限。 */
  maxTextChars?: number;
}

getTextContent(options?: TextContentOptions): Promise<TextContent>;
```

类型与完整语义见 [v1.1 文本内容 API 设计](./text-content-api.md)，此处只列引擎实现必须保证的要点：

| 类型 | 关键字段 |
|---|---|
| `TextContent` | `pageIndex`、`dpi`、`unit:'px'`、`pageWidth`、`pageHeight`、`items`、`itemCount`、`charCount`、`truncated` |
| `TextItem` | `text`、`font`、`size`、`transform`、`origin`、`rect`、`quad`、`advance`、`charCount`、`chars?` |
| `TextChar` | `text`、`codePoint`、`glyphId`、`faceKey`、`fallback`、`origin`、`advance`、`rect`、`quad`、`approximate` |
| `TextQuad` | 左上、右上、右下、左下，px |
| `TextRect` | `x/y/width/height`，px |

### 4.2 功能说明

- 复用 `layoutText` 的布局结果，输出页面可读文字；不调用 Canvas 文字 API。
- 坐标以页面 `PhysicalBox` 左上角为原点，y 向下；`px = mm * dpi / 25.4`。
- 内部按 mm 缓存，`dpi` 不进入缓存键；96/144/300 DPI 共用同一份布局。
- 只遍历页面/模板/复合/注释的可见文字；不进入 Pattern tile、ClipArea.text。
- 超限截断，发 `W_TEXT_ITEM_LIMIT` / `W_TEXT_CHAR_LIMIT`，不抛错。
- 空页返回 `items: []`、`itemCount: 0`、`charCount: 0`。
- 缓存：`CacheOptions.textPages` 默认 4；`close()` 中止并清空。
- 无 text driver 的宿主手工 `OFDPage`：`OFD_RENDERER_UNSUPPORTED`。
- 文档关闭：`OFD_CLOSED`；取消：`OFD_ABORTED`。

### 4.3 验收

| 用例 | 断言 |
|---|---|
| 横排/竖排/180/270 阅读方向 | item/char 的 quad 方向、advance、rect 与 `layoutText` 一致 |
| 96/144/300 DPI | 同一 mm 缓存；px 线性缩放；页面宽高正确 |
| `includeChars=false` | `chars` 省略，`text/charCount` 正确 |
| `includeInvisible/includeAnnotations` | 默认排除；true 时按预期加入 |
| 空页/无文字 | 空数组，不报错 |
| 超限 | 截断 + warning，不无界分配 |
| 1000 页 | 逐页调用可工作；不会因调用一次而加载全部页 |
| abort/close | 正确拒绝，无未处理 rejection |

---

## 5. `document.getOutline`

### 5.1 签名

```ts
type DestinationType = 'XYZ' | 'Fit' | 'FitH' | 'FitV' | 'FitR';

interface DocumentDestination {
  /** OFD Dest@Type。 */
  type: DestinationType;
  /** 目标页索引，0-based。 */
  pageIndex: number;
  /** 目标区域，mm；按 Type 可选。 */
  leftMm?: number;
  topMm?: number;
  rightMm?: number;
  bottomMm?: number;
  /** XYZ 的缩放倍率；1 = 100%。 */
  zoom?: number;
}

interface OutlineNode {
  /** 标题。 */
  title: string;
  /** OFD Expanded；缺省由 UI 决定。 */
  expanded?: boolean;
  /** 子节点，保持 XML 顺序。 */
  children: readonly OutlineNode[];
  /** 跳转目标；无效/缺失时省略。 */
  dest?: DocumentDestination;
}

getOutline(options?: { signal?: AbortSignal }): Promise<readonly OutlineNode[]>;
```

### 5.2 功能说明

- 读取 `Document.xml` 的 `Outlines/OutlineElem`，递归构建树。
- 读取 `Title`、`Expanded`，以及 `Actions/Action/Goto` 的目标：
  - `Dest`：直接映射；
  - `Bookmark`：按书签名查找 `Bookmarks` 中的 `Dest`；
  - 其他 Action：不解析，节点无 `dest`。
- `Dest@PageID` 用页 ID → 页索引映射；映射失败或 `Type` 未知/坐标非法时：
  - 保留节点与子节点；
  - 省略 `dest`；
  - 发 `W_OUTLINE_TARGET`。
- 无 `Outlines` 返回空数组，不报错。
- 不返回 HTML/样式；UI 负责树渲染。
- 结果缓存；`close()` 清理。

### 5.3 验收

| 用例 | 断言 |
|---|---|
| 多层大纲 | 层级/顺序与 XML 一致 |
| `Expanded` | 正确映射 |
| `Dest XYZ/Fit/FitH/FitV/FitR` | 字段按 Type 输出，mm/zoom 正确 |
| `Goto Bookmark` | 能解析到书签目标 |
| 无效 PageID/未知 Type | 节点保留，`dest` 省略 + warning |
| 无大纲 | 空数组，不报错 |
| 1000 页 | 不加载页面内容，仅 XML |

---

## 6. `document.getBookmarks`

### 6.1 签名

```ts
interface BookmarkItem {
  /** Bookmark@Name。 */
  name: string;
  /** 跳转目标；无效/缺失时省略。 */
  dest?: DocumentDestination;
}

getBookmarks(options?: { signal?: AbortSignal }): Promise<readonly BookmarkItem[]>;
```

### 6.2 功能说明

- 读取 `Document.xml` 的 `Bookmarks/Bookmark`，保持 XML 顺序。
- `Name` 必填；缺失则 warning 并跳过该条。
- `Dest` 解析规则与大纲一致；无效时保留书签、省略 `dest` + `W_BOOKMARK_TARGET`。
- 无书签返回空数组。
- 不做去重/排序（UI 可按需处理）。

### 6.3 验收

| 用例 | 断言 |
|---|---|
| 多书签 | 顺序与 XML 一致 |
| 同名书签 | 都保留 |
| 无效 Dest | 保留书签，无 dest + warning |
| 无书签 | 空数组 |

---

## 7. 签章对象信息：`getSignatureEntries`

> 这是本次边界调整的重点：引擎**只返回 XML 元数据和 `SignedValue.dat` 原始字节**，不解析 ASN.1，不解析证书，不判断签署人/签章时间/印章类型。`Seal.esl` 不进入公开 API。

### 7.1 签名

```ts
interface SignatureProvider {
  /** Provider@ProviderName。 */
  name?: string;
  /** Provider@Company。 */
  company?: string;
  /** Provider@Version。 */
  version?: string;
}

interface SignatureReferenceInfo {
  /** Reference@FileRef。 */
  fileRef: string;
}

interface SignatureStampInfo {
  /** StampAnnot@ID。 */
  id?: string;
  /** StampAnnot@PageRef，页 ID。 */
  pageId: string;
  /** 页索引，0-based；PageRef 未匹配时省略。 */
  pageIndex?: number;
  /** 戳记边界，mm。 */
  boundary: Box;
  /** 裁剪区域，mm；可选。 */
  clip?: Box;
}

interface SignatureEntryInfo {
  /** Signature@ID。 */
  id: string;
  /** Signature@Type，例如 `Seal`/`Sign`。 */
  type: string;
  /** Signature.xml 的包内路径。 */
  baseLoc: string;
  /** Provider 信息。 */
  provider?: SignatureProvider;
  /** SignatureDateTime 原文；不转换时区。 */
  signatureDateTime?: string;
  /** 保护范围。 */
  references: readonly SignatureReferenceInfo[];
  /** 页面戳记，保持 XML 顺序。 */
  stamps: readonly SignatureStampInfo[];
  /** SignedValue.dat 包内路径；未声明时省略。 */
  signedValuePath?: string;
  /** 是否声明了 SignedValue.dat。 */
  hasSignedValue: boolean;
}

getSignatureEntries(
  options?: { signal?: AbortSignal },
): Promise<readonly SignatureEntryInfo[]>;
```

### 7.2 功能说明

- 读取 `Signs/Signatures.xml`（兼容同级 `Signatures.xml`）索引，再逐条读取 `Signature.xml`。
- **只解析 XML**，包括：
  - `Signature@ID/@Type/@BaseLoc`；
  - `SignedInfo/Provider@ProviderName/@Company/@Version`；
  - `SignedInfo/SignatureDateTime`；
  - `SignedInfo/References/Reference@FileRef`；
  - `SignedInfo/StampAnnot@ID/@PageRef/@Boundary/@Clip`；
  - `SignedValue` 的 `BaseLoc` 或文本路径。
- **不读取** `SignedValue.dat` 的内容；`hasSignedValue` 只表示“是否声明了路径”。
- **只关心 `SignedValue.dat`**：v1/v4/v5 的 `TBS_Sign` 都包含 `eseal`，印章信息可以从这里得到；`Seal.esl` 不进入公开 API，引擎可忽略。
- `SignedValue.dat` 可能缺失（例如只有印章外观、无独立签名值文件）；`hasSignedValue=false` 是正常情况。此时条目仍返回，UI 显示“签章信息不完整”，不回退读取 `Seal.esl`。
- **不解析** ASN.1/DER、证书、印章名称/类型/有效期、签章时间语义、签名算法。
- 条目录入规则：
  - `ID` 缺失/重复：warning，跳过重复项（先到先得）；
  - `BaseLoc` 缺失/无法解析：warning，跳过该条；
  - `Signature.xml` 读取/XML 解析失败：warning，跳过该条；
  - `SignedValue` 路径缺失：条目仍返回，`hasSignedValue = false`；
  - `StampAnnot` 的 `PageRef` 未匹配：`pageIndex` 省略，保留 `pageId` + warning；`Boundary` 非法：warning，跳过该戳记或按 0 处理（实现需固定一种，建议跳过）。
- `boundary`/`clip` 用 mm，字段为 `Box`：`x/y/width/height`。
- `signatureDateTime` 保持原文；UI 负责格式化。
- 结果按 `Signatures.xml` 顺序；缓存；`close()` 清理。
- 100 个签章目标 ≤ 100 ms（只读 XML，不读大二进制）。

### 7.3 验收

| 用例 | 断言 |
|---|---|
| v1/v4/v5 签章样本 | ID/Type/路径/时间/位置正确，不读取 `.dat`；忽略 `.esl` |
| 多戳记 | 每个 `StampAnnot` 一条，页码/边界正确 |
| 缺失 `Signature.xml` | 跳过该条 + warning，其他条正常 |
| 缺失 `SignedValue` 路径 | 条目保留，`hasSignedValue = false` |
| 重复 ID | 先到先得 + warning |
| 无效 PageRef/Boundary | 不崩溃；按约定省略/跳过 + warning |
| 100 个签章 | ≤ 100 ms，未读 ASN.1 |
| abort/close | 正确拒绝 |

---

## 8. 签章原始资源：`getSignedValue`

### 8.1 签名

```ts
interface SignedValueFile {
  /** 所属签章 ID。 */
  signatureId: string;
  /** SignedValue.dat 包内路径。 */
  path: string;
  /** 原始字节；调用方拥有，引擎不解释内容。 */
  data: Uint8Array;
  /** 字节长度。 */
  byteLength: number;
}

getSignedValue(
  signatureId: string,
  options?: { signal?: AbortSignal },
): Promise<SignedValueFile | undefined>;
```

### 8.2 功能说明

- 按 `SignatureEntryInfo.signedValuePath` 读取 `SignedValue.dat`，返回**原始字节**。
- **只返回 `SignedValue.dat`**；不再接受 `kind`，也不暴露 `Seal.esl`。
- 依据：v1/v4/v5 的 `TBS_Sign` 都包含 `eseal`（`SES_SealInfo`），印章名称/类型/图片等信息可以从 `SignedValue.dat` 解析出来，因此不需要单独读取 `Seal.esl`。
- **不解析**内容；不判断版本、不解析 ASN.1、不解析证书、不验签。
- 返回规则：
  - 条目未声明 `SignedValue`（`hasSignedValue=false`）：`undefined`，**不 warning**；
  - 声明了路径但文件不存在/读取失败：warning `W_SIGNATURE_RESOURCE`，返回 `undefined`；
  - ZIP 结构损坏：抛 `OFD_INVALID_PACKAGE`；
  - 文档关闭/取消：`OFD_CLOSED`/`OFD_ABORTED`；
  - 超过资源限制：`OFD_LIMIT_EXCEEDED`（使用现有 `ResourceLimits` 条目上限）。
- `data` 是调用方可拥有的副本；引擎不得在 `close()` 后保留引用。
- 可做有界缓存（按字节数），但默认建议每次读取；UI 解析后只缓存结构化详情。
- 路径必须做包内规范化，禁止 `..` 越界。
- **边界情况**：如果文档只有 `Seal.esl`、没有 `SignedValue.dat`，本 API 返回 `undefined`；UI 只能显示“签章信息不完整”，不回退读取 `Seal.esl`。这是当前简化方案的明确取舍。

### 8.3 为什么不在引擎里解析

- `SignedValue.dat` 有 v1/v4/v5 多种结构，且存在非标签名；解析器需要持续演进而引擎应保持稳定。
- ASN.1/X.509 解析库（`asn1js`/`@peculiar/*`）体积不小，放进引擎会拖累所有渲染使用者。
- 引擎不应该因为“展示签章信息”而承担密码学语义；UI 只需要字节。
- 以后如果要做验签，也应该由独立模块/服务实现，而不是混进渲染引擎。

### 8.4 验收

| 用例 | 断言 |
|---|---|
| v1/v4/v5 `SignedValue.dat` | 返回字节与 ZIP 条目逐字节一致 |
| 资源不存在 | `undefined`；声明了但缺失 → warning |
| 文档只有 `Seal.esl` | 返回 `undefined`，不读取/不回退 |
| 大文件 | 遵守 limits；超限 `OFD_LIMIT_EXCEEDED` |
| close/abort | 正确拒绝 |
| 不解析 | 不 import ASN.1 库；不产生证书/签章字段 |

---

## 9. `document.getMetadata`

### 9.1 签名

```ts
interface DocumentMetadata {
  /** OFD 版本，例如 `1.0`。 */
  version: string;
  /** 页数。 */
  pageCount: number;
  /** 源文件字节数；未知时省略。 */
  packageSize?: number;
  /** DocInfo/Title。 */
  title?: string;
  /** DocInfo/Author。 */
  author?: string;
  /** DocInfo/Subject。 */
  subject?: string;
  /** DocInfo/Abstract。 */
  abstract?: string;
  /** DocInfo/CreationDate 原文。 */
  creationDate?: string;
  /** DocInfo/ModDate 原文。 */
  modDate?: string;
  /** DocInfo/Creator。 */
  creator?: string;
  /** DocInfo/CreatorVersion。 */
  creatorVersion?: string;
  /** DocInfo/Keywords。 */
  keywords?: readonly string[];
  /** DocInfo/DocID。 */
  docId?: string;
  /** 自定义元数据；键值均为字符串。 */
  customData?: Readonly<Record<string, string>>;
}

getMetadata(options?: { signal?: AbortSignal }): Promise<DocumentMetadata>;
```

### 9.2 功能说明

- 读取 `OFD.xml` 的 `DocBody/DocInfo`；`version`/`pageCount` 来自已打开文档。
- 缺失字段省略；格式非法字段 warning `W_METADATA_FIELD` 后跳过。
- 日期保留原文，不转换时区。
- 无 `DocInfo` 也返回 `version/pageCount`，不报错。
- P1；文档属性对话框使用。

### 9.3 验收

| 用例 | 断言 |
|---|---|
| 完整 DocInfo | 字段正确 |
| 无 DocInfo | 只有版本/页数 |
| 非法日期 | 跳过 + warning |
| 多文档包 | 取 `documentIndex` 对应文档的 DocInfo |

---

## 10. `page.prepare`

### 10.1 签名

```ts
interface PagePrepareOptions {
  /** 取消信号。 */
  signal?: AbortSignal;
}

prepare(options?: PagePrepareOptions): Promise<void>;
```

### 10.2 功能说明

- 预取页面模型、字体、图片、模板等 `preparePage` 所需资源，填充页面缓存；**不创建 canvas、不绘制**。
- 供 UI 滚动预取下一页/上一页，降低首次渲染延迟。
- 幂等：已准备/正在准备时复用；并发去重。
- 失败按页面加载错误处理；取消 `OFD_ABORTED`；关闭 `OFD_CLOSED`。
- P1；移动端可关闭预取。

### 10.3 验收

| 用例 | 断言 |
|---|---|
| prepare 后 render | 更快，且不改变渲染结果 |
| 并发 prepare | 只准备一次 |
| abort/close | 正确拒绝/清理 |
| 不创建 canvas | 无 canvas 副作用 |

---

## 11. `document.getPermissions`（已实现，P2）

### 11.1 签名

```ts
interface DocumentPermissions {
  /** 是否允许编辑，默认 true。 */
  edit: boolean;
  /** 是否允许添加/修改标注，默认 true。 */
  annot: boolean;
  /** 是否允许导出，默认 true。 */
  export: boolean;
  /** 是否允许数字签名，默认 true。 */
  signature: boolean;
  /** 是否允许添加水印，默认 true。 */
  watermark: boolean;
  /** 是否允许截屏，默认 true。 */
  printScreen: boolean;
  /** 打印权限；未声明表示可打印且份数不限。 */
  print?: {
    /** 是否允许打印，默认 true。 */
    printable: boolean;
    /** 允许份数；未声明表示不限；0 表示不允许打印。 */
    copies?: number;
  };
  /** 访问有效期；未声明表示不受限，日期保留 XML 原文。 */
  validPeriod?: {
    start?: string;
    end?: string;
  };
}

getPermissions(options?: { signal?: AbortSignal }): Promise<DocumentPermissions>;
```

### 11.2 功能说明

- 读取 `Document.xml` 的 `Permissions`；缺省全部 `true`，`print`/`validPeriod` 省略表示可打印不限、无有效期限制。
- **只读声明，不做 DRM 强制**：引擎不会因 `export:false` 拒绝 `exportImage`，也不会阻止打印；UI 仅据此禁用按钮/提示。
- 非法字段 warning `W_PERMISSION_FIELD`，按默认允许回退（份数非法按不限）。
- `copies=0` 表示不允许打印；负值/非法值按不限处理；日期不判断当前是否在有效期内。
- 取消 `OFD_ABORTED`、关闭 `OFD_CLOSED`。

---

## 12. 附件（已实现，P2）

```ts
interface AttachmentInfo {
  id: string;                    // 已规范化
  name: string;
  format?: string;
  size?: number;                 // byte；XML Size 以 KB 声明，引擎换算
  creationDate?: string;         // 原文
  modDate?: string;              // 原文
  visible?: boolean;             // 缺省 true
  usage?: string;                // 缺省 'none'
}

getAttachments(options?: { signal?: AbortSignal }): Promise<readonly AttachmentInfo[]>;

getAttachmentData(
  id: string,
  options?: { signal?: AbortSignal },
): Promise<Uint8Array | undefined>;
```

- 读取 `Attachments.xml` 的元信息；`getAttachmentData` 返回附件原始字节，**不解析附件内容/格式**，不执行附件。
- 无 `Attachments.xml` 返回空数组；保持 XML 顺序；重复 ID 保留先到者并 warning `W_DUPLICATE_RESOURCE`。
- `Size` 由 XML 的 KB 换算为 byte（×1024 四舍五入）；缺失/非法 warning `W_ATTACHMENT_FIELD` 后省略。
- 缺 ID/Name 跳过并 warning `W_ATTACHMENT_FIELD`；FileLoc 路径非法 warning 后仍列出元信息，但取数据失败。
- `getAttachmentData`：附件不存在/无 FileLoc/文件读取失败 warning `W_ATTACHMENT_RESOURCE` 并返回 `undefined`；`OFD_LIMIT_EXCEEDED`/`OFD_INVALID_PACKAGE` 原样抛出；取消 `OFD_ABORTED`、关闭 `OFD_CLOSED`。
- 不暴露 FileLoc；不缓存大文件字节，调用方自行缓存结构化结果。

---

## 13. 局部渲染（暂不实现/无排期）

按用户决定，`page.renderRegion` **不实现、不导出**：`OFDPage` 上没有该方法，`src/index.ts` 不导出 `PageRenderRegionParameters` 或相关类型；本节不提供可调用的公开签名，避免被误当作已实现契约。

- 原因：1000 页 A4@4x 约 14.3MP，低于 32MP 上限；先降 DPI + CSS 放大可满足当前阅读器。
- 如未来排期，必须保持与整页渲染相同的图层/对象顺序，仅改变 CTM 与 clip，并重新走契约评审。
- 当前 UI 不得调用/声明该 API；engine 不提供兼容桩。

---

## 14. 导出旋转（已实现，P2）

```ts
interface PageImageExportOptions {
  // 其他字段见公开 API §4.5
  /** 导出旋转，默认 0；仅 0/90/180/270，顺时针。 */
  rotation?: 0 | 90 | 180 | 270;
}
```

- 仅影响导出图片方向，不改变页面模型、`page.render` 或页面状态。
- 90/270 输出 `PageImageResult.width/height` 互换；内容按顺时针旋转；透明背景保持透明。
- 非法 rotation warning `W_BAD_NUMBER`（objectId=`exportImage.rotation`）后回退 0，不中断导出。
- 90/270 的像素上限按旋转后输出尺寸判断；`encodeImage` 收到最终旋转画布。

---

## 15. 错误码与返回值约定

### 15.1 错误码

| 码 | API | 场景 |
|---|---|---|
| `OFD_CLOSED` | 全部 | 文档已关闭 |
| `OFD_ABORTED` | 全部 | `signal` 取消 |
| `OFD_PAGE_NOT_FOUND` | `getTextContent`/`prepare` | 页不存在 |
| `OFD_ENTRY_NOT_FOUND` | 资源/附件 | ZIP 条目缺失（视 API 约定可转 warning） |
| `OFD_INVALID_PACKAGE` | 资源/附件 | ZIP 结构损坏 |
| `OFD_XML_PARSE` | XML API | 关键 XML 无法解析 |
| `OFD_LIMIT_EXCEEDED` | 资源/文本 | 超过资源/文本限制 |
| `OFD_RENDERER_UNSUPPORTED` | `getTextContent` | 无 text driver |
| `OFD_IMAGE_DECODE` | 渲染/导出 | 图片解码失败（现有） |

### 15.2 返回空 vs 抛错

| 场景 | 行为 |
|---|---|
| 无大纲/书签/签章/附件 | 空数组，不抛错 |
| 某个签章 XML 损坏 | 跳过该条 + warning；其他条正常 |
| `SignedValue.dat` 未声明/不存在 | `undefined`，不 warning |
| `SignedValue.dat` 声明但缺失 | `undefined` + warning |
| 页尺寸缺失/非法 | 回退 + warning |
| 关键 XML（Document.xml）损坏 | 打开阶段已失败；后续 API 不重复抛 |
| 取消/关闭 | 抛 `OFD_ABORTED`/`OFD_CLOSED` |

---

## 16. 性能与实现备注

### 16.1 性能目标

| API | 目标（参考机，1000 页/本地 ZIP） |
|---|---|
| `getPageInfos()` 全量 | ≤ 300 ms；缓存 ≤ 50 ms |
| `getTextContent()` 单页（96 DPI，冷） | ≤ 300 ms；缓存 ≤ 50 ms |
| `getOutline()` / `getBookmarks()` | ≤ 50 ms |
| `getSignatureEntries()`（100 条） | ≤ 100 ms；不读 `.esl/.dat` |
| `getSignedValue()`（5 MB） | ≤ 50 ms |
| `getMetadata()` / `getPermissions()` | ≤ 20 ms |
| `prepare()` 单页 | 与 `preparePage` 同量级 |

### 16.2 实现备注

- `getPageInfos` 已使用 `model/page-info.ts` 只扫描页头 Area/模板引用；不要走完整 `preparePage`。
- `getTextContent` 按 v1.1 设计实现；复用 `layoutText`/`preparePage`/`drawPage` 的遍历顺序，不复制一套。
- 大纲/书签订阅已解析的 `Document.xml` 模型；不要重复读 XML。
- `getSignatureEntries` 复用 `model/signature.ts` 的 `decodeSignaturesIndex`/`decodeSignature`（它们已解析 `Signature.xml`，且不读 ASN.1）；补齐 Provider/SignatureDateTime/References 字段。
- `getSignedValue` 复用现有 `readSignatureFile`/ZIP 读取；只返回 `SignedValue.dat` 字节，不调用 `decodeSealImage`。
- `getMetadata` 已接入 `DocInfo` 解码；`CT_DocInfo` 字段注意 `Title`（ofdrw 的 `getTile` 是拼写问题，不是字段名）。
- `getPermissions`/`getAttachments` 已实现且为加法，不影响现有打开流程；`getAttachmentData` 按需读取，不解析内容。
- `exportImage.rotation` 在导出侧二次绘制，仅改变输出方向；正常 `page.render` 不变。`renderRegion` 不实现、不导出。
- 不要为了这些 API 在引擎里引入 `asn1js`/`asn1.js`/`@peculiar/*`；ASN.1 是 UI 包的依赖。

### 16.3 测试夹具

- 页面：1000 页 A4、混合尺寸、模板页、缺失页。
- 文本：横排/竖排/旋转/CGTransform/缺字/空页/超限。
- 大纲/书签：多层、无效 PageID、未知 Dest Type、Goto Bookmark。
- 签章：`references/ofdrw/ofdrw-gm/src/test/resources/` 的 `SignedValueV4.dat`、`SignedValueV5.dat`、`Signature.xml`，以及 `UserV1.esl`/`UserV4.esl`/`UserV5.esl`（用于确认引擎忽略它们）；覆盖多戳记、缺失 `SignedValue`、损坏 XML。
- 元数据/权限/附件：完整/缺失/非法字段。
- 取消/关闭：每个 API 至少一个 abort/close 用例。

---

## 17. 优先级与交付

| 优先级 | API | 说明 |
|---|---|---|
| P0 | `getPageInfos` | 1000 页布局的前提 |
| P0 | `page.getTextContent` | 文本层/查找/选择的前提 |
| P0 | `getOutline` / `getBookmarks` | 导航侧栏 |
| P0 | `getSignatureEntries` | 签章列表/覆盖层（只读 XML） |
| P0 | `getSignedValue` | 供 UI 解析 ASN.1；只取 SignedValue.dat |
| P1 | `getMetadata` | 文档属性 |
| P1 | `page.prepare` | 滚动预取 |
| P2 | `getPermissions` / `getAttachments` / `getAttachmentData` | 权限/附件；**已实现** |
| P2 | `exportImage.rotation` | 导出方向增强；**已实现** |
| P2 | `renderRegion` | 局部/瓦片渲染；**暂不实现/无排期，不导出** |

**P0 完成定义**：类型从 `src/index.ts` 导出；单测覆盖上表验收项；1000 页/签章样本通过；无新增 ASN.1 依赖；`pnpm typecheck`/`test` 通过。**r10 状态：P0/P1 与 P2 权限/附件/导出旋转已实现并经公开 API 文档同步；`renderRegion` 不实现、不导出。**

---

## 18. 已确认与已裁决

### 18.1 已确认

- 引擎不解析电子签章；只提供 `Signature.xml` 元数据和 `SignedValue.dat` 原始字节。
- `Seal.esl` 不进入公开 API；v1/v4/v5 的 `TBS_Sign.eseal` 已包含印章信息，UI 从 `SignedValue.dat` 解析即可。
- 只保留 `getSignedValue(id, options?)`，不接受 `kind`；`SignedValue.dat` 缺失时返回 `undefined`，不回退读取 `Seal.esl`。
- 未声明 `SignedValue` 返回 `undefined` 且不 warning；声明但文件缺失返回 `undefined` + `W_SIGNATURE_RESOURCE`，不抛 `OFD_ENTRY_NOT_FOUND`。

### 18.2 已裁决

1. `getSignatureEntries` 命名采用，`Entries` 强调“只读 XML 条目，不是解析后的签章”；不再使用 `getSignatureInfos`/`getSignatureMetadata`。
2. `getPageInfos` 采用 `start/count` 分片，并已实现；默认 `start=0`、`count=剩余全部`，越界空/截断，结果按索引升序。
3. `getMetadata` 进入 P1 并已实现；无 `DocInfo` 仍返回版本/页数。
4. `getPermissions`/附件/`exportImage.rotation` 已实现；`renderRegion` 按用户决定不实现、不导出、无排期，不作为 MVP 依赖。

## 19. 实现状态（r10，2026-10-22）

| API | 状态 | 实现要点 |
|---|---|---|
| `getPageInfos` | 已实现（P0） | 轻量页头读取；Page→Template→CommonData→A4 回退；按页缓存/并发去重；`start/count/signal` |
| `getOutline` / `getBookmarks` | 已实现（P0） | 打开阶段解析并缓存；保持 XML 顺序；无结果空数组；无效目标 warning 后省略 `dest` |
| `getSignatureEntries` | 已实现（P0） | 只读 `Signatures.xml`/`Signature.xml`；Provider/References/StampAnnot；边界 mm；不读 `.dat`/`.esl`、不解析 ASN.1 |
| `getSignedValue` | 已实现（P0） | 只返回 `SignedValue.dat` 原始字节；缺失 `undefined` + `W_SIGNATURE_RESOURCE`；不缓存大文件 |
| `getMetadata` | 已实现（P1） | DocInfo 字段；日期原文；无 DocInfo 仍返回版本/页数 |
| `page.prepare` | 已实现（P1） | 96 DPI bundle；幂等/并发去重；不创建 canvas；abort/close |
| `page.getTextContent` | 已实现（P0） | 复用 `layoutText`；px 输出/mm 缓存；`textPages=4`，缓存键不含 dpi；超限截断 warning |
| `getPermissions` | 已实现（P2） | 只读 `Document.xml/Permissions`；默认全 true；不做 DRM 强制；`W_PERMISSION_FIELD` |
| `getAttachments` / `getAttachmentData` | 已实现（P2） | 按需解析并缓存元信息；Size KB→byte；原始字节；不解析内容；`W_ATTACHMENT_FIELD`/`W_ATTACHMENT_RESOURCE` |
| `exportImage.rotation` | 已实现（P2） | 0/90/180/270；仅导出方向；90/270 宽高互换；非法值 `W_BAD_NUMBER` 回退 0 |
| `renderRegion` | **暂不实现/无排期** | 不导出、不在 `OFDPage` 上；UI 不得依赖 |

边界复核：引擎不新增 ASN.1/X.509/CMS 依赖；`Seal.esl` 不进入公开 API；`SignedValue.dat` 只作为原始字节返回。公开文档以 `docs/公开API.md` 和 `src/index.ts` 为准。
