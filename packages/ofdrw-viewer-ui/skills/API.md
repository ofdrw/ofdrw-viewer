# @ofdrw/ofdrw-viewer-ui API 参考

本文件是 `@ofdrw/ofdrw-viewer-ui` 的完整 API 参考。入口说明、安装、5 分钟示例和边界见 [SKILL.md](./SKILL.md)。

```ts
import { OFDViewer } from '@ofdrw/ofdrw-viewer-ui';
import '@ofdrw/ofdrw-viewer-ui/style.css';

const viewer = new OFDViewer({ container: '#viewer', source: file });
await viewer.ready;
```

## 入口与版本

### 子路径

| 子路径 | 导出内容 |
| --- | --- |
| `@ofdrw/ofdrw-viewer-ui` | `OFDViewer`、公共类型、错误、`HttpByteSource`、URI 解析、版本 |
| `@ofdrw/ofdrw-viewer-ui/react` | React `OFDViewer`、`OFDViewerHandle`、`OFDViewerProps` 及事件类型 |
| `@ofdrw/ofdrw-viewer-ui/vue` | Vue `OFDViewer` 及共享 prop 类型（`FeatureDisplay`/`Rotation`/`ScaleValue`/`SidebarView`/`Theme`/`ViewerFeatures`） |
| `@ofdrw/ofdrw-viewer-ui/element` | `OFDViewerElement`、`OFD_VIEWER_TAG`、`defineOFDViewerElement` |
| `@ofdrw/ofdrw-viewer-ui/component` | `element` 的兼容别名 |
| `@ofdrw/ofdrw-viewer-ui/style.css` | 主题样式，必须由宿主显式引入 |

公共入口会安装内置 UI 外壳，并以副作用方式注册文本/查找、导航、签章、打印、导出能力；框架入口也会导入公共入口。

公共入口同时导出引擎侧的数据类型：`DocumentMetadata`、`DocumentHeader`、`DocumentPageArea`、`OfdPackageInfo`、`CommonDataSummary`、`AttachmentInfo`、`DocumentPermissions`、`PageInfo`，以及 UI 自己的 `ViewerDocumentInfo`、`ViewerFeature`、`ViewerFeatureStates`。

### `VERSION` 与 `getVersions`

`VERSION` 是 UI 包版本字符串，当前为 `0.1.0`。`getVersions()` 返回 UI、渲染引擎与密码能力包三个版本：

```ts
interface ViewerVersions {
  readonly ui: string;
  readonly engine: string;
  readonly crypto: string;
}
```

工具栏“更多 → 关于”也展示这些版本，便于用户反馈问题时截图。

### `registerViewerExtension`

```ts
type ViewerExtension = (viewer: OFDViewer) => void | (() => void);

function registerViewerExtension(extension: ViewerExtension): () => void;
```

- 注册后立即应用到当前所有活动阅读器，并在之后创建的阅读器构造时应用。
- 同一个函数重复注册是幂等的，每个实例只应用一次。
- 返回的函数只取消“后续注册”，不会对已应用实例执行清理；扩展返回的 cleanup 在该实例 `destroy()` 时调用。
- 扩展抛错不会中断阅读器创建，错误通过 `error` 事件上报，错误码为 `OFD_UNSUPPORTED`。

`viewer.applyExtension(extension)` 可对单个实例应用扩展；同样幂等。

## 构造选项

### `OFDViewerOptions`

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `container` | `HTMLElement / string` | 必填 | 挂载点；字符串按 CSS 选择器解析，元素必须已存在 |
| `source` | `ViewerSource` | 无 | 文档来源；省略时读取 `?file=`/`?base64=` |
| `initialPage` | `number` | `1` | 初始页，1-based；非有限值按 1，打开时夹取到有效页 |
| `initialScale` | `number / ZoomMode` | `'auto'` | 数字为倍率（0.1–25）；字符串为缩放模式 |
| `rotation` | `0 / 90 / 180 / 270` | `0` | 初始顺时针旋转角度 |
| `sidebar` | `SidebarView / null` | `null` | 初始侧栏；`null` 表示关闭 |
| `features` | `ViewerFeatures` | 全部开启 | 功能开关补丁，只需写要关闭的键 |
| `featureDisplay` | `FeatureDisplay` | `'hide'` | 被关闭功能的展示方式 |
| `theme` | `'light' / 'dark' / 'auto'` | `'auto'` | `auto` 跟随 `prefers-color-scheme` |
| `locale` | `string` | `'zh-CN'` | 内置 `zh-CN`/`en-US`；翻译层不可识别时回落到 `zh-CN` |
| `maxCanvasPixels` | `number` | `32_000_000` | 单页 canvas 像素上限（width × height） |
| `pageCacheSize` | `number` | 桌面 `10`，移动 `4` | 已渲染页 canvas 缓存数量 |
| `thumbnailCacheSize` | `number` | `100` | 缩略图缓存数量；当前版本尚未接入实现，见下 |
| `renderConcurrency` | `number` | 桌面 `2`，移动 `1` | 同时渲染页数 |
| `updateHash` | `boolean` | `false` | 把页码/缩放/旋转/侧栏写入 URL hash |
| `requestInit` | `RequestInit` | 无 | URL 来源的额外请求参数；只使用 `headers` |
| `debug` | `DebugViewerOptions` | 控制台打印开启 | 诊断输出开关（`console`/`levels`/`codes`），见 [诊断与日志](#诊断与日志) |
| `onWarning` | `(warning: ViewerWarning) => void` | 无 | 非阻断诊断回调 |
| `onError` | `(error: ViewerErrorInfo) => void` | 无 | 打开/渲染/交互失败回调 |
| `crypto` | `CryptoViewerOptions` | 默认启用 | 加密文档与验签配置 |
| `fonts` | `ViewerFontOptions` | 无 | 字体配置（`default`/`supplementary`/`loader`/`aliases`/`localFonts`），见下 |

`container` 是唯一必填项。字符串选择器在构造时解析；找不到元素抛 `OFD_INVALID_OPTION`。

`container` 是宿主挂载点，须自备确定高度（例如 `#viewer { height: 640px }`）。`OFDViewer` 不修改宿主样式，而是在挂载点内创建 `.ofd-viewer` 根节点；该根节点使用 `display: grid; grid-template-rows: auto 1fr; width: 100%; height: 100%; min-height: 0`，相对挂载点撑满。React/Vue 外层默认 `width/height: 100%`，同样需要父容器提供高度。

### `ResolvedViewerOptions`

`ResolvedViewerOptions` 是内部展开默认值后的完整选项形状，字段与 `OFDViewerOptions` 相同，但除 `source`、`requestInit`、`debug`、`onWarning`、`onError`、`crypto`、`fonts` 外均为必填。调用方通常不需要构造该类型；它用于需要读取解析结果或编写扩展的 TypeScript 场景。

### 默认值与移动端差异

- 初始缩放 `auto` 等价于适合宽度；`page-width` 适合宽度，`page-fit` 适合整页，`page-actual` 为 100%。
- `setScale()` 和数字型 `initialScale` 都会被夹取到 `0.1`–`25`；非有限数字按 `1`。
- 移动端默认值在**构造时**按 `matchMedia('(max-width: 767px)')` 判断：页缓存 4、渲染并发 1；桌面为 10/2。断点变化不会自动改这些值。
- `locale` 会设置根节点 `lang` 并写入 `state.ui.locale`；翻译器会把 `zh`/`en` 等别名归一，未注册语言回落到 `zh-CN`，但 `state.ui.locale` 保留传入值。
- `maxCanvasPixels` 超限时通常静默降低该页渲染 DPI；只有连续降档仍失败时才产生 `W_CANVAS_LIMIT` warning，不能用它判断每一次降档。
- `thumbnailCacheSize` 当前只被解析，未接入缩略图缓存实现，实际缓存数量固定；不要依赖该选项控制缩略图内存。
- `updateHash` 默认关闭，避免嵌入场景污染宿主地址。启用后 hash 形如 `#page=3&zoom=page-width&rotation=90&sidebar=outline`，未知参数会保留；监听 `hashchange`/`popstate` 恢复视图，非法字段忽略。查询串 `?file=`/`?base64=` 与 hash 互不覆盖。

### 诊断与日志

诊断通过三条通道同时可达：`onWarning`/`onError` 回调、`warning`/`error` 事件（Web Component 为 `ofd-warning`/`ofd-error`）、浏览器控制台。回调与事件**每次都触发**；控制台输出默认开启、按下面的规则过滤与去重。完整设计见 [`警告与错误日志方案设计.md`](../../../docs/警告与错误日志方案设计.md)。

#### 码表

引擎与密码能力包的码由各自包提供（引擎 `WARNING_CODES`、crypto `CRYPTO_WARNING_CODES`），UI 不重写码；下表是 UI 自有码，导出为冻结常量 `UI_WARNING_CODES`（`UI_WARNING_CODES.W_METADATA` 可用类型检查拦截拼错，`Object.values(UI_WARNING_CODES)` 得到完整码表）。

| 主题 | 码 | 触发点 |
| --- | --- | --- |
| 文档信息 | `W_METADATA`、`W_OUTLINE`、`W_BOOKMARKS` | 元数据/大纲/书签读取失败 |
| 导航 | `W_NAV_DEST`、`W_NAV_JUMP`、`W_NAV_ZOOM` | 跳转目标无效、跳页/缩放失败 |
| 缩略图 | `W_THUMBNAIL`、`W_THUMBNAIL_JUMP` | 缩略图渲染/跳转失败 |
| 文本 | `W_TEXT_LOAD`、`W_TEXT_EMPTY`、`W_TEXT_UNSUPPORTED`、`W_TEXT_LAYER_LIMIT` | 文本层加载、空文本、不支持、超限 |
| 查找 | `W_FIND_FAILED`、`W_FIND_LIMIT`、`W_FIND_PAGE`、`W_FIND_PAGE_LIMIT` | 查找失败/超限/翻页 |
| 导出打印 | `W_EXPORT_PARTIAL`、`W_EXPORT_PAGE`、`W_OUTPUT_LARGE_TASK`、`W_OUTPUT_DPI_REDUCED` | 部分导出、单页失败、大任务、DPI 降档 |
| 签名与附件 | `W_SIGNATURE_ASN1`、`W_SIGNATURE_RESOURCE`、`W_SIGNATURE_TIMESTAMP`、`W_SIGNATURE_ENTRIES`、`W_ATTACHMENT_RESOURCE` | ASN.1、资源、时间戳、条目读取、附件资源 |
| 密码能力 | `W_CRYPTO_VERIFICATION_CALLBACK`、`W_CRYPTO_VERIFY_FAILED`、`W_CRYPTO_CERT_SOURCE_UNSUPPORTED` | 验证回调异常、自动/重新验证失败、根证书来源不支持 |
| 界面 | `W_UI_LISTENER`、`W_UI_CLEANUP`、`W_ENGINE_EVENT`、`W_FULLSCREEN_FALLBACK` | 事件监听器异常、清理失败、引擎事件异常、全屏降级 |
| 来源 | `W_QUERY_SOURCE` | 查询参数来源解析 |
| 资源限制 | `W_CANVAS_LIMIT` | 画布降档仍失败 |

引擎码（如 `W_FONT_MISSING`、`W_GLYPH_MISSING`）由引擎定义、UI 只转发，**不属于** `UI_WARNING_CODES`；错误码以 `OFDViewerError.code` 抛出，见下文错误与异常章节。

#### 级别

| 级别 | 语义 | 默认输出 |
| --- | --- | --- |
| `info` | 有诊断价值但不异常 | 不打印 |
| `warn` | 可容忍、影响部分内容（缺字、缺字体、部分导出） | `console.warn` |
| `error` | 阻断或操作失败（打开/渲染/加密失败等） | `console.error` |

级别由码决定，而非调用点：`resolveDiagnosticLevel(code)` 按 `UI_WARNING_LEVELS` 映射取级别，未登记的码（含引擎/crypto 码与宿主扩展码）按 `warn`；`error` 级只来自 `onError` 链路。

#### 控制台格式与去重

```text
[ofd-viewer] warning W_FONT_MISSING 字体缺失：FontName=宋体 {resourceId: 3}
[ofd-viewer] warning W_GLYPH_MISSING 缺字：0x20BB7 {pageIndex: 0, resourceId: 12}
[ofd-viewer] error OFD_CRYPTO_FAILED 读取文档加密信息失败：...
```

- 三个参数：`label`（`[ofd-viewer] warning|error <code>`）、`message`、`context`（只含 `pageIndex`，0-based，与 `resourceId`）；不打印 `cause` 堆栈，需要时用 `onError` 的 `cause`。
- 去重键：warning 为 `code` + `pageIndex` + `resourceId`，error 为 `code` + `pageIndex`；同一文档会话内只打印一次，`open()` 时清空。千页文档不会刷屏，重新打开同一文档会再打印一次。
- 前缀固定为 `[ofd-viewer] `，可在控制台过滤框输入 `[ofd-viewer]` 一次筛出全部诊断。

#### `debug` 选项

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `debug.console` | `boolean` | `true` | 整体开关；`false` 时完全不打印，回调与事件不受影响 |
| `debug.levels` | `readonly ('info'\|'warn'\|'error')[]` | 无（按级别默认输出） | 只打印列出的级别 |
| `debug.codes` | `readonly string[]` | 无（不过滤码） | 只打印列出的码（引擎/crypto 码也可列） |

````ts
new OFDViewer({
  container: '#viewer',
  source: '/sample.ofd',
  debug: {
    console: false,                    // 整体关闭
    // 或只关心字体问题：
    // levels: ['warn', 'error'],
    // codes: ['W_FONT_MISSING', 'W_GLYPH_MISSING'],
  },
});
````

过滤在去重**之前**判断：被过滤的诊断不占用去重键，后续放宽过滤（或同一码在放行配置下出现）时仍能打印。工具函数 `formatDiagnostic(diagnostic)` 返回同样的 `{ label, message, context }`，`DiagnosticPrinter` 可用于宿主自己的诊断管道。

### 国际化词条

内置 `zh-CN`/`en-US` 两套词条键集同构，宿主可通过翻译层覆盖。附件与属性面板相关词条分组：

| 前缀 | 用途 | 关键键 |
| --- | --- | --- |
| `attachments.*` | 附件侧栏与附件操作 | `attachments.title`（侧栏标签）、`name`、`format`、`size`、`date`、`download`、`downloadNamed`、`exportAll`、`exportSummary`、`empty`（空状态）、`missing`、`sizeKb`、`sizeMb`、`cancel`、`downloadOfd`、`confirmLargeTitle`、`confirmLarge`（含 `{name}`/`{size}`/`{threshold}`）、`error`（含 `{name}`/`{message}`）、`unsupported`、`ofdUnavailable` |
| `properties.*` | 文档属性对话框六个分组 | 分组标题、新元数据字段、权限项、单位与数值模板 |
| `feature.attachments` | 功能开关文案 | — |
| `localFonts.*` | 设置侧栏的本机字体分组与授权确认框 | `group`、`toggle`、`toggleHint`、`status.prompt`、`status.enabled`、`status.unsupported`、`status.denied`、`dialog.title`、`dialog.description`、`dialog.allow`、`dialog.deny` |
| `sidebar.settings` | 侧栏「设置」标签 | — |

### 容器与来源

`source` 省略时，`open()` 依次检查显式参数、构造来源、`?file=`、`?base64=`；都没有时 `ready` 以 `OFD_INVALID_OPTION` 拒绝。详细解析规则见[通过 URI 参数预览](#通过-uri-参数预览)。

`requestInit` 只对 URL 来源生效，且只读取 `headers`：先合并 `requestInit.headers`，再用来源对象自带 `headers` 覆盖（来源优先）。`credentials`、`mode`、`cache` 等字段不会转发，fetch 使用浏览器默认的 `same-origin` 凭据策略。

### 字体配置

`fonts` 与 `crypto` 同级：只在实例创建时读取，实例存在后修改需重新 `open()`。UI 负责把字体来源读取为字节，再映射到引擎选项：`fonts.default` → `defaultFonts`，`fonts.supplementary` → `supplementaryFonts`，`fonts.aliases` 以内置别名表为基准**追加**后传给引擎 `aliases`；`fonts.loader` 只在 UI 内使用。只传读取成功的来源，且只在结果非空时传字段，全部失败时不传，引擎按无字体处理。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `default` | `readonly FontSource[]` | 默认字体：文档字体完全缺省时的替代字体，优先级高于 `supplementary` |
| `supplementary` | `readonly FontSource[]` | 补充字体：主字体存在但缺字时逐字形补齐 |
| `loader` | `FontSourceLoader` | `path`/`filePath` 来源的读取器；未提供时这两类来源被跳过 |
| `aliases` | `FontAliasTable` | 追加到引擎内置别名组的字体别名组 |
| `localFonts` | `LocalFontsOptions` | 浏览器本机字体（`queryLocalFonts`）能力配置；省略等价于「关闭 + 不展示开关」，见[本机字体](#本机字体) |

`FontSource` 与 `CertificateSource` 同为四态：`{ data }`（已读好的字节）、`{ url, headers? }`（UI 用 `fetch` 读取，`headers` 与 `requestInit.headers` 合并，来源优先）、`{ path }`/`{ filePath }`（由 `loader` 读取）。`FontSource` 另有第五态 `{ local }`（浏览器本机字体），只在宿主启用 `fonts.localFonts` 且用户授权后才读取，见[本机字体](#本机字体)。只接受**完整字体文件**（单文件覆盖目标字符集，如 `.ttf`/`.otf`/`.woff2`），不接受 CSS 的 unicode-range 子集切片；同一 URL 在一次实例生命周期内只读取一次。

读取失败（非 2xx、网络错误、缺少 `loader`、`loader` 返回 `null`、字节为空）只跳过该来源并通过 `onWarning`/`ofd-warning` 上报 `W_FONT_MISSING`，**只 warning、不上报 `error`、不阻断文档打开**；因 `open()` 被取消（AbortError）导致的读取中断**不产生任何 warning**，由取消流程本身负责收尾。Web Component 另有 `fonts` property 与 `font-default`/`font-supplementary` 简写属性，见 [Web Component](#web-component)。

```ts
new OFDViewer({
  container: '#viewer',
  source: '/doc.ofd',
  fonts: {
    default: [{ url: '/fonts/NotoSerifSC-Regular.woff2', family: 'Noto Serif SC' }],
    supplementary: [{ url: '/fonts/NotoSansSC-Regular.woff2' }],
  },
});
```

完整设计（格式兼容性、CDN 选型、安全边界）见 [`字体配置方案设计.md`](../../../docs/字体配置方案设计.md)，本机字体的完整方案见 [`本地字体加载方案设计.md`](../../../docs/本地字体加载方案设计.md)。

#### 本机字体

浏览器可通过 [Local Font Access API](https://developer.mozilla.org/en-US/docs/Web/API/Local_Font_Access_API)（`queryLocalFonts`，Chrome 103+ 桌面端）在用户授权后读取本机已安装的字体字节，用来补上宿主没有提供、而用户机器上恰好有的同名字体（典型场景：Windows 自带 `宋体`/`黑体`/`微软雅黑`）。

设计原则是**默认不生效、失败全回退**：浏览器不支持、宿主未配置、用户未授权、被站点策略禁止、本机未安装时，该来源被静默跳过，其余来源与「未引入本功能」时完全一致。

启用需要宿主与用户双方同意，缺一不可：

1. **宿主配置**：`fonts.localFonts.enabled: true`，否则能力对用户完全不可见（侧栏不出现开关，`{ local }` 来源按不支持跳过）；
2. **用户授权**：用户在侧栏「设置 → 字体」里打开「使用本机字体」，并在确认框点「允许」——浏览器只接受**用户手势**内的权限申请，因此阅读器不会在 `open()` 里静默申请，也不会自动弹浏览器授权框。

`LocalFontsOptions` 字段：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `false` | 是否允许展示「使用本机字体」开关；`false` 或省略时整个能力不可见 |
| `defaultEnabled` | `boolean` | `false` | 宿主默认值：用户从未做过选择时生效 |
| `remember` | `boolean` | `true` | 是否把用户选择记在 `localStorage`；`false` 时不读不写 |
| `maxFonts` | `number` | `8` | 单个文档最多查询多少个**文档声明字体**；非有限数或 `< 1` 按 8，上限钳到 32 |
| `consentText` | `string` | 内置文案 | 授权确认框说明文案覆盖（例如内网统一口径） |

生效值遵循「**宿主配置决定默认值，用户选择优先**」：

| 条件 | 生效的 `enabled` | 展示开关 |
| --- | --- | --- |
| `fonts.localFonts` 未配置，或 `enabled !== true` | `false` | 否 |
| 浏览器没有 `queryLocalFonts` | `false` | 否（只展示「浏览器不支持」原因） |
| `remember !== false` 且 `localStorage` 有用户选择 | 用户选择 | 是 |
| 以上都不成立 | `defaultEnabled === true` | 是 |

`FontSource` 的 `{ local }` 来源：

```ts
fonts: {
  default: [
    // 宿主显式配置的字体始终在前（优先）。
    { url: '/fonts/NotoSerifSC-Regular.woff2', family: '宋体' },
    // 本机字体：字符串 / 字符串数组 / 文档声明形态
    { local: 'SimSun' },
    { local: ['SimSun', 'NSimSun'], family: '宋体' },
    { local: { fontName: '宋体' } }, // 由 UI 展开候选名（含变体回退链）
  ],
}
```

| `local` 取值 | 语义 |
| --- | --- |
| `string` | 单个本机字体名：PostScript 名（`SimSun`）、英文名或中文名 |
| `readonly string[]` | 候选名列表，按顺序尝试，命中即停止 |
| `LocalFontDeclaration` | 文档声明形态 `{ fontName, familyName?, bold?, italic?, family? }`，由 UI 展开为候选 PostScript 名（中文名 → 真实 PS 名 + 变体回退链） |

`LocalFontDeclaration` 是 `local` 的「文档声明形态」，字段与引擎 `DocumentFontResource` 的对应字段同名，便于直接把文档声明交给 UI：

```ts
interface LocalFontDeclaration {
  readonly fontName: string;      // 文档 FontName，如 '宋体'；必填
  readonly familyName?: string;   // 文档 FamilyName；参与匹配，不单独产生候选
  readonly bold?: boolean;        // 文档声明为粗体时传 true，参与变体回退链
  readonly italic?: boolean;      // 文档声明为斜体时传 true
  readonly family?: string;       // 覆盖读到的字体面 family；缺省用 fontName
}
```

`family` 缺省时，展开命中后的 `FontInput.family` 取 `fontName`，使引擎按文档声明的名字精确匹配。

要点：

- **注入位置固定为「宿主配置在前、本机字体在后」**：`defaultFonts = [...宿主 default, ...本机字体]`，宿主显式指定的字体永远优先，本机字体只补位（宿主没配 `default` 时结果就是本机字体）。本机字体**只注入 `defaultFonts`，不注入 `supplementaryFonts`**：引擎按 `default:N` 与 `supplementary:M` 分别建字体面且不跨列表去重，同时注入会让同一份 10–20 MB 字体被解析两次、内存翻倍；本机字体是「替代/优先」语义，不是「补字」语义。即使 `{ local }` 来源写在 `fonts.supplementary` 里，读到的字节也进入 `defaultFonts`。
- 本机字体的 `FontInput.family` 取**文档声明的 `FontName`**（如 `宋体`），而不是本机字体自身的 family，这样引擎按「归一化名精确相等」评分时能命中并压过兜底字体。
- 只查询**文档声明过且没有内嵌 `fontFile`** 的字体（内嵌字体本来就优先，查询是浪费），按 `maxFonts` 截断。
- 读到的字体字节只经 `blob()`/`readBlobBytes()` 进入内存交给引擎渲染，**不上传、不落盘、不写日志、不写存储**；`localStorage` 只存一个布尔选择与「已告知」标记，不存字体清单。
- 只做**定向查询**（`queryLocalFonts({ postscriptNames })`），不做全量枚举；候选名匹配**区分大小写**（`SimSun` 命中，`SIMSun`/`simsun` 不命中），中文名不能用于查询，因此中文声明必须先经内置常见字体表/别名表展开为真实 PostScript 名（内置表未命中时**不推断大小写**，只保留文档原样的合法 PostScript 名）。
- 单个声明的候选名顺序：**变体后缀 → 基础名 → 别名组成员 → 文档原始名**；候选总数上限 6，并为文档原始名至少预留一个位置，避免原样写的 PostScript 名被变体候选挤掉。一个声明只发起一次 `queryLocalFonts` 调用。
- 变体后缀不凭空推断：请求粗体时按 `<base>-Bold` → `<base>Bold` → `<base>` 回退，`SimHei-Bold` 这类不存在的变体会落到 `SimHei` 常规字形，**不做合成加粗**。
- 开关变化（开启授权 / 关闭）会**重开当前文档并恢复页码、缩放、旋转**（不做字体热替换）；已授权后再开不再弹确认框，关闭开关只清空本机字体缓存，浏览器授权保持「已授权」。
- 浏览器不支持（Firefox / Safari / 移动端 / Chrome 103 之前 / 站点 `Permissions-Policy: local-fonts` 被禁用）时整个能力不可见，行为与不引入本功能一致；不提供 polyfill。

状态通过 [`getLocalFontsStatus()` / `setLocalFontsEnabled()` / `onLocalFontsStatusChange()`](#本机字体方法) 读取与控制，事件为 [`local-fonts:change`](#事件名与载荷)。

失败口径：本机字体读不到时一律跳过该来源并上报 `W_FONT_MISSING`（**只 warning、不上报 `error`、不阻断打开**），`message` 只含字体名与错误摘要，不含字体字节、不含本机字体清单。`open()` 被取消（AbortError）导致的中断**不产生任何 warning**。注意：浏览器不支持时也会产生 `W_FONT_MISSING`，宿主若需要「静默忽略不支持」应先用 `getLocalFontsStatus().supported` 或 `debug.codes` 过滤。

### URL hash 同步

启用 `updateHash` 后，页码、缩放、旋转、侧栏变化会写回 hash；`sidebar` 关闭写为 `none`。`hashchange`/`popstate` 触发的恢复只应用能解析的字段，不会因为非法字段清空视图。

## 功能开关

### 功能键

`ViewerFeature` 是以下 20 个键的联合；`ViewerFeatures` 是 `Partial<Record<ViewerFeature, boolean>>`，未出现的键默认开启。

| 功能键 | 作用 | 依赖 |
| --- | --- | --- |
| `toolbar` | 顶部工具栏 | — |
| `sidebar` | 侧栏容器 | — |
| `thumbnails` | 缩略图 | `sidebar` |
| `outline` | 大纲 | `sidebar` |
| `bookmarks` | 书签 | `sidebar` |
| `attachments` | 附件侧栏（列表/下载/导出） | `sidebar` |
| `pageNavigation` | 翻页/跳页 | — |
| `pageNumberInput` | 页码输入框 | — |
| `zoom` | 缩放按钮、快捷键与手势 | — |
| `rotate` | 旋转 | — |
| `fullscreen` | 全屏 | — |
| `textLayer` | 透明文本层 | — |
| `selection` | 文本选择与复制 | `textLayer` |
| `find` | 全文查找与高亮 | `textLayer` |
| `print` | 打印 | — |
| `export` | 单页/多页图片导出 | — |
| `signatures` | 签章列表、覆盖层与详情 | — |
| `verification` | 验证面板与验签 | — |
| `documentProperties` | 文档属性 | — |
| `keyboardShortcuts` | 键盘快捷键 | — |

依赖不满足时，被依赖功能以 `reason: 'dependency'` 关闭，并可能继续级联（例如 `sidebar` 关闭会关闭缩略图/大纲/书签/附件）。`toolbar`/`sidebar` 关闭时，其内部控件即使自身开启也不可见。

### 有效状态与原因

```ts
type FeatureReason = 'host' | 'document' | 'unsupported' | 'dependency';

interface FeatureState {
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly reason?: FeatureReason;
}

type ViewerFeatureStates = Record<ViewerFeature, FeatureState>;

interface FeatureAvailability {
  readonly document?: Partial<Record<ViewerFeature, boolean>>;
  readonly unsupported?: Partial<Record<ViewerFeature, boolean>>;
}
```

优先级：宿主 `features[key] === false`（`host`）→ 文档权限不允许（`document`）→ 引擎/环境不支持（`unsupported`）→ 依赖不满足（`dependency`）。宿主无法用 `features: true` 绕过文档权限、环境能力或依赖。

### 功能展示

```ts
type FeatureDisplayMode = 'hide' | 'disable';
type FeatureDisplay =
  | FeatureDisplayMode
  | Partial<Record<ViewerFeature, FeatureDisplayMode>>;
```

- `'hide'`（默认）：隐藏对应控件。
- `'disable'`：保留控件但禁用，并显示带原因的提示。
- 对象形式按功能覆盖，未覆盖的键回落到 `'hide'`。

`visible` 由展示方式决定：`disable` 时关闭的功能仍可见，但 `enabled === false`。展示方式不改变功能是否可用。

### 运行时更新

```ts
viewer.setFeatures({ print: false }, { display: 'disable' });
viewer.setFeatures({ print: true });
viewer.setFeatureDisplay({ export: 'disable' });
```

`setFeatures(patch, { display? })` 合并补丁；`setFeatureDisplay(display)` 替换展示配置。两者都会立即刷新 UI 并触发 `featureschange`。

### 文档与能力约束

文档权限、内容可用性以及引擎/环境能力会写入 `FeatureAvailability`。例如没有文本层的文档会关闭 `textLayer` 及其依赖；`crypto.enabled=false` 时 `verification` 被标记为 `unsupported`，验证面板/按钮不可用，`verify()` 与 `openVerificationPanel()` 会以 `OFD_FEATURE_DISABLED`（`feature='verification'`）拒绝。

`attachments` 的两类关闭原因：引擎文档没有 `saveAttachment()`（旧引擎或未实现）→ `unsupported`；引擎具备能力但 `getAttachments()` 为空或读取失败 → `document`。两种情况下侧栏都不渲染附件标签页，`openSidebar('attachments')` 抛 `OFD_FEATURE_DISABLED`。

## 事件

### 事件名与载荷

`ViewerEventMap` 定义全部事件；`ViewerEventName` 是键的联合，`ViewerEventPayload<K>` 是对应载荷，`ViewerEventHandler<K>` 是 `(payload) => void`。

| 事件 | 载荷 | Web Component | React | Vue |
| --- | --- | --- | --- | --- |
| `documentopen` | `DocumentOpenEvent` | `ofd-document-open` | `onDocumentOpen` | `document-open` |
| `documentclose` | `DocumentCloseEvent` | `ofd-document-close` | `onDocumentClose` | `document-close` |
| `pagechanging` | `PageChangingEvent` | `ofd-page-change` | `onPageChange` | `page-change` |
| `pagerendered` | `PageRenderedEvent` | `ofd-page-rendered` | `onPageRendered` | `page-rendered` |
| `pagesloaded` | `PagesLoadedEvent` | `ofd-pages-loaded` | `onPagesLoaded` | `pages-loaded` |
| `scalechanging` | `ScaleChangingEvent` | `ofd-scale-change` | `onScaleChange` | `scale-change` |
| `rotationchanging` | `RotationChangingEvent` | `ofd-rotation-change` | `onRotationChange` | `rotation-change` |
| `sidebarviewchanged` | `SidebarViewChangedEvent` | `ofd-sidebar-view-change` | `onSidebarViewChange` | `sidebar-view-change` |
| `findstart` | `FindStartEvent` | `ofd-find-start` | `onFindStart` | `find-start` |
| `findmatches` | `FindMatchesEvent` | `ofd-find-matches` | `onFindMatches` | `find-matches` |
| `findcurrent` | `FindCurrentEvent` | `ofd-find-current` | `onFindCurrent` | `find-current` |
| `selectionchange` | `SelectionChangeEvent` | `ofd-selection-change` | `onSelectionChange` | `selection-change` |
| `signatureclick` | `SignatureClickEvent` | `ofd-signature-click` | `onSignatureClick` | `signature-click` |
| `verificationcompleted` | `VerificationCompletedEvent` | `ofd-verification-completed` | `onVerificationCompleted` | `verification-completed` |
| `printstart` | `PrintStartEvent` | `ofd-print-start` | `onPrintStart` | `print-start` |
| `printprogress` | `PrintProgressEvent` | `ofd-print-progress` | `onPrintProgress` | `print-progress` |
| `printend` | `PrintEndEvent` | `ofd-print-end` | `onPrintEnd` | `print-end` |
| `exportprogress` | `ExportProgressEvent` | `ofd-export-progress` | `onExportProgress` | `export-progress` |
| `warning` | `WarningEvent` | `ofd-warning` | `onWarning` | `warning` |
| `error` | `ErrorEvent` | `ofd-error` | `onError` | `error` |
| `featureschange` | `FeaturesChangeEvent` | `ofd-features-change` | `onFeaturesChange` | `features-change` |
| `statechange` | `StateChangeEvent` | `ofd-state-change` | `onStateChange` | `state-change` |
| `local-fonts:change` | `LocalFontsChangeEvent`（等同 `LocalFontsStatus`） | 当前版本未桥接 | 当前版本未桥接 | 当前版本未桥接 |

`signatureclick` 在类型和适配器桥接表中存在，但当前版本没有实际触发点；需要处理签章交互时，使用 `getSignatures()`/`showSignature()` 或内置侧栏的现有入口。

### 载荷类型

- `DocumentOpenEvent`：`{ pageCount: number }`，文档打开且页数已知。
- `DocumentCloseEvent`：`Record<string, never>`，关闭完成。
- `PageChangingEvent`：`{ pageNumber: number; previous: number }`，页码均为 1-based。
- `PageRenderedEvent`：`{ pageNumber: number; scale: number; rotation: Rotation }`。
- `PagesLoadedEvent`：`{ pageCount: number }`，初始可见页加载完成。
- `ScaleChangingEvent`：`{ scale: number; zoomMode: ZoomMode; previous: number }`。
- `RotationChangingEvent`：`{ rotation: Rotation; previous: Rotation }`。
- `SidebarViewChangedEvent`：`{ view: SidebarView | null }`，关闭时为 `null`。
- `FindStartEvent`、`FindMatchesEvent`、`FindCurrentEvent`：`{ query: string; total: number; current: number }`；`current` 为 1-based，无匹配为 0。
- `SelectionChangeEvent`：`{ text: string; isEmpty: boolean }`。
- `SignatureClickEvent`：`{ id: string; pageNumber: number }`。
- `PrintStartEvent`、`PrintProgressEvent`、`PrintEndEvent`：`{ current: number; total: number }`。
- `ExportProgressEvent`：`{ current: number; total: number }`。
- `VerificationCompletedEvent`：等同于 `VerificationReport`，不含凭据。
- `WarningEvent`：等同于 `ViewerWarning`，`{ code, message, pageIndex? }`，`pageIndex` 为 0-based。
- `ErrorEvent`：等同于 `ViewerErrorInfo`，在 warning 字段之外可带 `cause`。
- `FeaturesChangeEvent`：等同于 `ViewerFeatureStates`。
- `StateChangeEvent`：等同于完整的 `ViewerState` 快照。
- `LocalFontsChangeEvent`：等同于 `LocalFontsStatus`；本机字体开关/权限/加载状态变化时触发。目前只有核心事件通道（`viewer.on('local-fonts:change', …)` 与 `onLocalFontsStatusChange()`），Web Component / React / Vue 适配层尚未桥接该事件。

### 订阅

```ts
const off = viewer.on('pagechanging', ({ pageNumber, previous }) => {
  console.log(previous, '->', pageNumber);
});
viewer.once('documentopen', ({ pageCount }) => console.log(pageCount));
off();
viewer.off('pagechanging', handler);
```

`on` 返回取消订阅函数；`once` 只触发一次；`off` 需要传入同一函数引用。事件按注册顺序同步派发；`statechange` 在状态提交后触发。

## 公共方法

方法签名以 TypeScript 声明为准。带功能守卫的方法在功能关闭时抛 `OFD_FEATURE_DISABLED`（错误对象带 `feature`）；未打开文档时抛 `OFD_NOT_OPENED`；销毁后抛 `OFD_DESTROYED`。

### 生命周期

| 方法 | 说明 |
| --- | --- |
| `new OFDViewer(options)` | 创建 DOM 外壳并异步打开 `options.source`；构造本身不等待打开 |
| `ready: Promise<void>` | 首次打开完成；失败时 reject |
| `open(source?: ViewerSource): Promise<void>` | 打开/切换文档；省略时按构造来源或查询参数解析；会取消上一次未完成打开 |
| `close(): Promise<void>` | 关闭文档，保留外壳；状态变为 `closed`，可再次 `open()` |
| `destroy(): void` | 移除根节点、解绑事件、释放渲染与来源；可重复调用 |
| `on(event, handler): () => void` | 订阅事件 |
| `once(event, handler): () => void` | 订阅一次 |
| `off(event, handler): void` | 取消订阅 |
| `applyExtension(extension): void` | 对当前实例应用扩展；幂等 |

### 状态读取

| 方法 | 返回 |
| --- | --- |
| `getState()` | `ViewerState` 只读快照 |
| `getPageCount()` | 总页数；未打开为 0 |
| `getPageNumber()` | 当前页，1-based |
| `getCurrentPage()` | `getPageNumber()` 的别名 |
| `getFindState()` | `FindState` |
| `getScale()` | 当前实际缩放倍率 |
| `getRotation()` | 当前旋转角度 |
| `getSidebarView()` | 当前侧栏；关闭为 `null` |
| `getVisiblePageRange()` | `{ start, end }`，内部页索引 0-based 闭区间；无页时 `end < start` |
| `getRenderStats()` | `{ queued, running, completed, failed, cancelled }` 渲染队列统计 |
| `getFeatureState(feature)` | 单个 `FeatureState` |
| `getFeatureStates()` | 全部 `ViewerFeatureStates` 快照 |
| `isFeatureEnabled(feature)` | 功能是否可用 |
| `getPageView(pageNumber)` | 页视图对象；页码越界返回 `undefined`，不做夹取 |
| `getPageViews()` | 全部页视图只读数组 |
| `getPageInfo(pageNumber)` | `PageInfo`；越界返回 `undefined` |
| `getPageInfos()` | 全部 `PageInfo` 只读数组 |
| `getDocument()` | 底层引擎文档；未打开为 `null` |
| `getPage(pageNumber): Promise<EnginePage>` | 读取引擎页面对象；页码夹取到有效页 |
| `getPermissions(): Promise<DocumentPermissions>` | 文档权限；未打开返回全部允许的宽松默认值 |
| `getDocumentInfo(): Promise<ViewerDocumentInfo>` | 文档信息快照（元数据/页信息/权限/附件/签章/大纲/书签计数）；**未打开抛 `OFD_NOT_OPENED`** |
| `getRoot()` | 阅读器根 `HTMLElement` |
| `getElements()` | 内置 UI 结构元素 `{ root, toolbar, body, sidebar, sidebarMask, main, findbar, dialogLayer, toastLayer }` |
| `warnCrypto(code, message)` | 供密码服务/扩展上报 warning，宿主一般不用 |
| `getLocalFontsStatus()` | 本机字体状态快照 `LocalFontsStatus`，见[本机字体方法](#本机字体方法) |

`getPageView()`/`getPageViews()` 返回的是内部页视图对象，主要供扩展使用；普通宿主优先用 `getPageInfo()` 与引擎页面 API。

#### `getDocumentInfo()`

```ts
interface ViewerDocumentInfo {
  readonly metadata: DocumentMetadata;            // 引擎完整元数据（含 docType/documentHeader/packageInfo/commonData）
  readonly pageCount: number;
  readonly pageInfos: readonly PageInfo[];
  readonly permissions: DocumentPermissions;
  readonly attachments: readonly AttachmentInfo[]; // 保持 XML 顺序；无附件为 []
  readonly signatureCount: number;                 // 签章条目数
  readonly outlineCount: number;                   // 大纲顶层条目数
  readonly bookmarkCount: number;                  // 书签条目数
  readonly origin?: ViewerOrigin;                  // 内存字节打开时省略
}
```

- **按需调用**：结果不写入 `ViewerState.document`，不会因每次状态刷新产生额外渲染，宿主要多用时应自行缓存返回值。
- **一次性聚合**：内部并发调用 `getMetadata()`、`getPermissions()`、`getAttachments()`、`getSignatureEntries()`、`getOutline()`、`getBookmarks()`，全部命中引擎缓存，不额外读取包内条目。
- **严格接口**：未打开文档时抛 `OFD_NOT_OPENED`，不返回空壳；销毁后抛 `OFD_DESTROYED`。这与 `getPermissions()` 不同——后者未打开时仍返回宽松默认值。
- **旧引擎兼容**：底层引擎没有 `getAttachments()` 时 `attachments` 返回 `[]`，不报错。

#### 本机字体方法

```ts
/** 本地字体权限状态。 */
type LocalFontStatus = 'prompt' | 'granted' | 'denied' | 'unsupported';

/** 本地字体当前状态。 */
interface LocalFontsStatus {
  readonly supported: boolean;      // 本机字体能力对本次阅读器是否生效（宿主已启用且浏览器支持）
  readonly enabled: boolean;        // 开关是否开启（用户选择或宿主默认值）
  readonly permission: LocalFontStatus; // 未申请 / 已授权 / 已拒绝 / 不支持
  readonly visible: boolean;        // 是否应展示「使用本机字体」开关
  readonly loading: boolean;        // 最近一次读取是否正在进行
}

class OFDViewer {
  /** 读取本地字体状态；只做查询，不触发授权。 */
  getLocalFontsStatus(): LocalFontsStatus;
  /** 设置开关并（在需要时）申请授权。 */
  setLocalFontsEnabled(enabled: boolean): Promise<void>;
  /** 订阅状态变化；返回退订函数。 */
  onLocalFontsStatusChange(handler: (status: LocalFontsStatus) => void): () => void;
}
```

| 成员 | 行为 |
| --- | --- |
| `getLocalFontsStatus()` | 返回状态快照；**不触发**权限申请，页面加载阶段调用不会弹授权框、不产生 `SecurityError` |
| `setLocalFontsEnabled(enabled)` | `enabled=true` 时应在**用户点击事件中直接调用**（浏览器只接受用户手势内的权限申请）；生效值变化时内部重开当前文档并恢复页码/缩放/旋转。销毁后调用抛 `OFD_DESTROYED` |
| `onLocalFontsStatusChange(handler)` | 与核心事件 `local-fonts:change` 同源：一次状态变化各触发一次；返回退订函数，重复订阅互不影响 |

字段语义注意：

- `supported: false` 表示「该能力对本次阅读器不生效」——宿主未启用 `fonts.localFonts`、或浏览器不提供 `queryLocalFonts`、或站点策略禁用；此时 `permission` 恒为 `unsupported`，侧栏不展示开关。
- `permission: 'denied'` 与「本机未安装」在 `queryLocalFonts()` 层面返回值相同（都是空数组），阅读器用 `navigator.permissions.query({ name: 'local-fonts' })` 区分，因此不要用查询结果自行判断「用户拒绝」。
- 用户拒绝后：开关置为关闭并写入用户选择，**本会话不再弹确认框**；侧栏开关仍可手动打开再次尝试。拒绝反馈只在侧栏面板内展示文案，不发 toast。
- 确认框「允许」为 Sync 回调内发起权限申请；Esc / 遮罩关闭视同「不允许」但**不**写入用户选择（下次仍会询问）。

### 导航与缩放

| 方法 | 说明 |
| --- | --- |
| `goToPage(pageNumber, { smooth? })` | 跳页；1-based，越界夹取；`smooth` 控制平滑滚动 |
| `nextPage()` / `previousPage()` | 下一页/上一页 |
| `firstPage()` / `lastPage()` | 首页/末页 |
| `setScale(scale)` | 设置实际倍率，夹取到 0.1–25 |
| `setZoomMode(mode)` | 设置 `auto`/`page-actual`/`page-fit`/`page-width` |
| `zoomIn()` / `zoomOut()` | 按预置档位放大/缩小 |
| `resetZoom()` | 回到 `auto` |
| `setRotation(rotation)` | 设置旋转；任意数字规范为 0/90/180/270 |
| `rotateClockwise()` / `rotateCounterClockwise()` | 顺时针/逆时针旋转 90° |

功能守卫：翻页与跳页需要 `pageNavigation`；缩放组需要 `zoom`；旋转组需要 `rotate`。

### 侧栏、全屏与对话框

| 方法 | 说明 |
| --- | --- |
| `openSidebar(view)` | 打开 `thumbnails`/`outline`/`bookmarks`/`signatures`/`attachments`/`settings`；需要 `sidebar` 及对应功能 |
| `closeSidebar()` | 关闭侧栏；已关闭时无操作 |
| `toggleSidebar()` | 已打开则关闭，否则打开第一个可用侧栏 |
| `setFullscreen(value): Promise<void>` | 进入/退出全屏；原生不支持或失败时回退为沉浸式样式并产生 `W_FULLSCREEN_FALLBACK` |
| `toggleFullscreen()` | 不等待 `setFullscreen()` 返回的 Promise，也不会自动上报失败；需要错误处理时直接调用 `setFullscreen(value)` 并 `catch` |
| `showDialog(options)` | 打开内置对话框，返回对话框元素；未挂载内置 UI 抛 `OFD_UNSUPPORTED` |
| `closeDialog(restoreFocus = true)` | 关闭当前对话框，默认把焦点还给触发元素 |

`UIDialogOptions`：

```ts
interface UIDialogAction {
  readonly label: string;
  readonly primary?: boolean;
  readonly closeOnClick?: boolean; // 默认 true
  readonly onClick?: () => void;
}

interface UIDialogOptions {
  readonly name: DialogName;        // 'print' | 'export' | 'documentProperties' | 'signatureDetail' | 自定义
  readonly title?: string;          // 默认“提示”
  readonly description?: string;
  readonly content?: Node | string;
  readonly actions?: readonly UIDialogAction[]; // 默认“关闭”
  readonly dismissible?: boolean;   // 默认 true，允许 Esc/遮罩关闭
  readonly onClose?: () => void;
}
```

`DialogName` 允许宿主扩展字符串，内置名称仅为约定。

`SidebarView` 为 `'thumbnails' | 'outline' | 'bookmarks' | 'signatures' | 'attachments' | 'settings'`。`settings` 是设置面板，只有「字体」一组（本机字体开关），行为见下节；它不参与 `toggleSidebar()` 的「第一个可用侧栏」自动选择，也不新增功能键——访问控制只来自 `sidebar` 功能门控与 `fonts.localFonts.enabled`。

#### 设置侧栏（本机字体开关）

`settings` 侧栏展示本机字体开关，是启用 `queryLocalFonts` 的用户入口（见[本机字体](#本机字体)）：

| 项 | 内容 |
| --- | --- |
| 分组 | 「字体」 |
| 开关 | 「使用本机字体」+ 说明「用本机已安装的字体替换缺失字体」，`role="switch"` + `aria-checked`，键盘可操作 |
| 状态文案 | `未授权`（首次）/ `已启用` / `未获得授权`（`denied`）/ `浏览器不支持` |
| 隐藏条件 | 浏览器不支持，或 `fonts.localFonts.enabled !== true`（整个字体分组不出现） |

约束：**不新增工具栏按钮、不加 toast 引导、不在缺字时主动打扰**，用户从侧栏设置进入。点击开关在用户手势内同步发起授权申请。

#### 附件侧栏

`attachments` 侧栏显示当前文档的附件列表，并负责下载与批量导出；需要 `sidebar` 与 `attachments` 同时开启，且文档确实带附件（见“文档与能力约束”）。

列表列与缺失处理：

| 列 | 内容 | 缺失时 |
| --- | --- | --- |
| 名称 | `AttachmentInfo.name` | 必填；无名条目直接跳过 |
| 格式 / 大小 / 日期 | `format`、`size`（格式化为 KB/MB）、`modDate`（回退 `creationDate`） | 显示 `-` |
| 下载 | 单个下载按钮 | — |

下载与导出行为：

- **单个下载**：调用引擎 `saveAttachment()` 回调式收集（每块 `slice()` 拷贝后再拼接，引擎缓冲不可跨回调复用）→ `Blob` → `URL.createObjectURL` → 隐藏 `<a download>` 触发 → 延迟 `revokeObjectURL`。附件始终先完整读入内存再下载，不是流式落盘；文件名优先 `name`、其次 `id`，按 `/`、`\` 分段去除 `..`，过滤控制字符与平台保留字符；无扩展名时按 `format` 补全。
- **大附件阈值**：单附件**声明大小**超过 `ATTACHMENT_LARGE_THRESHOLD_BYTES = 524288000`（**500 MB**）时**不读取附件内容**；确认框提示“是否改为下载整个 OFD 原文件”，用户取消则什么都不读，确认后经 `readSourceBytes()` 下载整个 OFD（该路径沿用 `export` 功能与文档导出权限门控；不可读取时提示 `attachments.ofdUnavailable`）。未声明 `size` 的附件不参与阈值判断。
- **导出全部**：顶层“导出全部”按钮把全部附件打包为 ZIP 下载；复用图片导出的 `createStoreZip()`（`export/zip.ts`，fflate store 模式、按需动态 `import`），不引入新依赖。ZIP 条目名取附件 `name`，重名追加 `-2`/`-3` 后缀；超过阈值的附件与读取失败的条目跳过，完成后汇总提示“已导出 N 个附件，跳过 M 个”。
- **错误处理**：读取失败上报 `W_ATTACHMENT_RESOURCE` 并写面板状态文本，不抛到宿主。
- **安全约束**：附件内容一律不进入 DOM（不使用 `innerHTML`/`srcdoc`），未知格式只提供下载、不提供预览。

### 主题、语言与功能

| 方法 | 说明 |
| --- | --- |
| `setTheme(theme)` | 设置 `light`/`dark`/`auto`，写入根节点 `data-theme` |
| `setLocale(locale)` | 设置根节点 `lang`、`state.ui.locale` 与翻译器 |
| `setFeatures(patch, { display? })` | 合并功能补丁并立即生效 |
| `setFeatureDisplay(display)` | 替换功能展示配置 |

这些方法没有功能守卫；非法值的行为由 TypeScript 类型约束，运行时不做完整校验。

### 弹出层动效

样式表为对话框、印章浮层、更多菜单、查找栏、侧栏 overlay/drawer 与 Toast 提供统一的打开动画：默认 `180ms ease-out`，只做入场；关闭、替换和隐藏立即生效，不等待动画。宿主可在 `.ofd-viewer` 上覆盖 `--ofd-motion-duration`，建议保持在 `160–200ms`。

- 对话框：遮罩 `ofd-fade-in`，内容 `ofd-dialog-in`（6px 上移 + 淡入）；所有内置对话框都走 `.ofd-dialog`。
- 印章浮层：`.ofd-signature-popover--in`（4px 上移 + 淡入），创建并完成定位后启用，内部重渲染不重播。
- 更多菜单：`.ofd-more-menu--open`（`scale(0.96)→1` + 淡入），`data-placement="above|below"` 决定 transform-origin。
- 查找栏/侧栏/Toast：分别使用 `ofd-findbar-in`、`ofd-sidebar-in`/`ofd-fade-in`、`ofd-toast-in`，节奏一致。

`prefers-reduced-motion: reduce` 下所有新增动画均被关闭，内容直接出现在最终位置。动画不改变焦点、键盘操作或脚本定位；更多菜单使用布局尺寸计算位置，避免缩放影响夹紧结果。

### 文本、查找与选区

| 方法 | 说明 |
| --- | --- |
| `find(query, options?): Promise<void>` | 查找；空查询会清除查找；需要 `find` |
| `findNext(): Promise<void>` | 下一个匹配，循环到首个 |
| `findPrevious(): Promise<void>` | 上一个匹配，循环到末个 |
| `clearFind()` | 清除查询、匹配与高亮 |
| `getSelectedText()` | 当前选区文本；需要 `selection` |
| `copySelection(): Promise<void>` | 复制选区；失败抛 `OFD_CLIPBOARD_FAILED` |
| `clearSelection()` | 清除选区 |

查找默认从当前页开始，按当前页→文末、文首→当前页前一页的顺序搜索；空查询不会抛错。

### 签章与验证

| 方法 | 说明 |
| --- | --- |
| `verify(options?): Promise<VerificationReport>` | 重新验证；可传 `signatureIds` 与 `signal`；需要 `verification` |
| `getVerificationReport()` | 最近一次报告；未验证或文档关闭后为 `undefined` |
| `setRootCertificates(roots): Promise<CertificateSummary[]>` | 替换信任根并尝试重新验证；需要密码能力启用 |
| `getRootCertificates()` | 当前信任根摘要 |
| `openVerificationPanel()` | 打开工具栏验证面板；需要 `verification` 与内置 UI；密码能力关闭时 `verification` 为 unsupported，调用抛 `OFD_FEATURE_DISABLED` |
| `getSignatures()` | 当前签章摘要；需要 `signatures` |
| `getSignatureDetail(id): Promise<SignatureDetail>` | 读取签章详情；需要签章服务 |
| `showSignature(id): Promise<void>` | 打开/定位签章 |
| `focusSignature(id): Promise<void>` | 当前实现等同于 `showSignature` |

`crypto.enabled=false` 时 `verification` 功能为 unsupported，`verify()` 与 `openVerificationPanel()` 抛 `OFD_FEATURE_DISABLED`（`feature='verification'`），不是 `OFD_CRYPTO_UNSUPPORTED`；对 UI 公开方法而言，`OFD_CRYPTO_UNSUPPORTED` 仅用于加密文档打开、`setRootCertificates()` 等直接密码能力调用。`verification` 可用但文档未打开时，`verify()` 抛 `OFD_NOT_OPENED`。`setRootCertificates()` 中单个 `url`/`data` 根无效只产生 warning 并跳过，`path`/`filePath` 的 loader 抛错会以 `OFD_CRYPTO_FAILED` 失败；全部无效时返回空数组。

### 打印与导出

| 方法 | 说明 |
| --- | --- |
| `print(options?): Promise<void>` | 调用浏览器打印；默认当前页、自动 DPI、当前旋转、不含背景 |
| `exportImage(options?): Promise<ExportImageResult>` | 导出单页图片并触发下载；默认当前页、PNG |
| `exportImages(options?): Promise<void>` | 导出多页 ZIP 并触发下载；默认当前页 |
| `exportOfd(options?): Promise<ExportOfdResult>` | 导出当前 OFD 原文件并触发下载；加密文档导出原始加密字节 |
| `readSourceBytes(signal?): Promise<Uint8Array>` | 读取当前来源原始字节，供导出/宿主复用；与 `exportOfd()` 共用 `export` 功能与文档导出权限门控。功能关闭/文档禁止导出抛 `OFD_FEATURE_DISABLED`（`feature='export'`），未打开抛 `OFD_NOT_OPENED` |

`exportOfd()` 与图片导出共用 `export` 功能开关和文档导出权限；公开的 `readSourceBytes()` 使用同一门控。URL 来源会按打开时的请求头重新读取；ArrayBuffer/Uint8Array/Blob 直接复用；自定义随机读源按顺序读取，实际读取长度必须等于声明的 `size`，短读不再静默截断而是抛 `OFD_EXPORT_FAILED`。导出过程不渲染、不解密、不重建 OFD，文件名默认 `{docName}.ofd`，可由 `filename` 覆盖并自动补 `.ofd`。读取失败、短读、空文件或宿主不支持时映射为 `OFD_EXPORT_FAILED`；取消仍保留 `AbortError`。

打印失败抛 `OFD_PRINT_FAILED`；导出全部页失败抛 `OFD_EXPORT_FAILED`；单页失败降级为 `W_EXPORT_PAGE`/`W_EXPORT_PARTIAL` warning。取消通过 `signal` 传入：取消时统一转为 `AbortError`（`name='AbortError'`）拒绝；`OFD_INVALID_OPTION` 仅表示选项非法。

### 扩展与服务

以下方法主要供内置能力和扩展作者使用，普通宿主通常不需要调用：

| 方法 | 说明 |
| --- | --- |
| `attachFindController(service)` | 挂载查找控制器，返回卸载函数 |
| `attachTextLayerService(service)` | 挂载文本层服务 |
| `attachSignatureService(service)` | 挂载签章服务 |
| `attachPrintService(service)` | 挂载打印服务 |
| `attachExportService(service)` | 挂载导出服务 |
| `trackPageRenderStart(pageIndex, purpose)` | 登记一次页面渲染开始，返回 `{ drop() }`；`purpose` 为 `main`/`thumbnail`，页索引 0-based |

同一类服务重复挂载时后挂载者生效；返回的卸载函数只移除对应服务。`trackPageRenderStart` 用于让扩展把引擎渲染事件与主页面/缩略图关联，普通宿主不需要使用。

## 状态快照

### `ViewerState`

```ts
interface ViewerState {
  readonly document: DocumentState;
  readonly view: ViewState;
  readonly ui: UIState;
}
```

状态是只读快照，所有变更由阅读器内部完成；页面级临时渲染状态（canvas、任务句柄）不会进入快照。

### `DocumentState`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `source` | 引擎来源 / `null` | 规范化后的引擎来源；未打开为 `null` |
| `origin` | `ViewerOrigin / undefined` | 原始来源命名信息，用于标题和导出文件名 |
| `pageCount` | `number` | 总页数 |
| `pageInfos` | `PageInfo[]` | 全部页尺寸信息，按页索引升序 |
| `metadata` | `DocumentMetadata` | 文档属性；不可用或未加载时省略 |
| `signaturesSummary` | `SignatureEntryInfo[]` | 签章 XML 元数据摘要，不解析签名值 |
| `outline` | `OutlineNode[]` | 大纲；未加载或为空时省略 |
| `bookmarks` | `BookmarkItem[]` | 书签；未加载或为空时省略 |
| `status` | `'idle' / 'opening' / 'ready' / 'error' / 'closed'` | 文档生命周期 |

`ViewerOrigin` 是 `{ kind: 'url', url }` / `{ kind: 'file', name }` / `{ kind: 'blob' }` 的联合，只保留命名所需信息，不进入网络读取；文档来源不是 URL/File 时 `origin` 省略。

该结构不承载权限与附件：`DocumentState` 没有 `permissions`/`attachments` 字段，这两类数据通过 `getDocumentInfo()` 或 `getPermissions()` 读取，避免状态快照随文档信息膨胀。

### `ViewState`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `pageNumber` | `number` | 当前页，1-based |
| `scale` | `number` | 当前实际缩放倍率 |
| `zoomMode` | `ZoomMode` | 当前缩放模式 |
| `rotation` | `Rotation` | 当前旋转角度 |
| `sidebarView` | `SidebarView / null` | 打开的侧栏；关闭为 `null` |
| `fullscreen` | `boolean` | 是否全屏/沉浸 |
| `scrollTop` | `number` | 主区域滚动位置，单位 px |
| `visiblePageRange` | `VisiblePageRange` | 可见页范围，0-based 闭区间 |
| `selectedText` | `string` | 当前选区文本 |
| `findState` | `FindState` | 查找状态 |

### `UIState`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `theme` | `Theme` | 当前主题 |
| `locale` | `string` | 当前语言标签 |
| `toolbarCollapsed` | `boolean` | 工具栏是否折叠 |
| `dialog` | `DialogName / null` | 当前对话框 |
| `toast` | `ViewerToast / null` | 当前 Toast |
| `warnings` | `ViewerWarning[]` | 诊断信息列表 |
| `features` | `ViewerFeatureStates` | 全部功能有效状态 |

### `InitialViewerStateOptions`

用于构造初始状态快照，主要供测试或自定义外壳：`pageNumber`（默认 1）、`scale`（默认 1）、`zoomMode`（默认 `auto`）、`rotation`（默认 0）、`sidebarView`（默认 `null`）、`theme`（默认 `auto`）、`locale`（默认 `zh-CN`）、`features`（默认全部开启）。

### 诊断与 Toast

- `ViewerWarning`：`{ code: string; message: string; pageIndex?: number }`；`pageIndex` 为 0-based，与页面无关时省略。
- `ViewerErrorInfo`：继承 `ViewerWarning`，额外带 `cause?: unknown`。
- `ViewerToast`：`{ id: string; message: string; level: ToastLevel }`；`ToastLevel` 为 `info`/`warning`/`error`。
- `warnings` 只保留诊断，不代表操作失败；失败会同时通过 `error` 事件和 Promise 拒绝报告。

## 文档、页面与文本类型

### `DocumentMetadata` 与 `DocumentDestination`

`DocumentMetadata` 描述文档属性：`version`、`pageCount`、`packageSize?`、`title?`、`author?`、`subject?`、`abstract?`、`creationDate?`、`modDate?`、`creator?`、`creatorVersion?`、`keywords?`、`docId?`、`customData?`。日期字段保留 OFD 原文，不转换时区。

新增可选字段（全部“缺失即省略”，不放入 `undefined`）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `docUsage` | `string?` | 文档用途（DocInfo/DocUsage） |
| `docType` | `string?` | `OFD.xml` 的 `OFD@DocType`，例如 `OFD`/`Render`/`None` |
| `documentHeader` | `DocumentHeader?` | Document.xml 头部声明 |
| `packageInfo` | `OfdPackageInfo?` | 包级结构：`docRoot`（包内路径）、`docBodyCount`、`maxUnitId?` |
| `commonData` | `CommonDataSummary?` | 公共数据摘要：`pageArea?`、`defaultColorSpaceId?`、`documentVersion?`、`dataDir?` |

`DocumentHeader` 字段：`docId?`、`version?`、`maxUnitId?`、`pageArea?`（`DocumentPageArea`：`physicalBox?`/`applicationBox?`/`bleedBox?`，`Box` 单位 mm）、`publicRes?`/`documentRes?`/`templatePageRes?`（`readonly string[]`，包内路径列表）、`defaultCs?`、`docUsage?`。设置 `documentProperties` 后，属性对话框据此分组展示包信息、颜色与资源等内容。

`AttachmentInfo` 描述单个附件：`id`、`name` 必含；可选 `format`、`size`（byte）、`creationDate`、`modDate`、`visible`、`usage`、`contentType`（MIME）、`description`、`submissionDate`、`isEncrypted`。附件列表通过 `getDocumentInfo().attachments` 或附件侧栏读取，UI 不解析附件内容。

`DocumentDestination` 描述文档内跳转目标：`{ type, pageIndex, leftMm?, topMm?, rightMm?, bottomMm?, zoom? }`；`type` 为 `XYZ`/`Fit`/`FitH`/`FitV`/`FitR`，`pageIndex` 为 0-based，坐标单位 mm。当前版本没有 `goToDestination()`，需要自行读取目标页后调用 `goToPage(pageIndex + 1)`。

### `PageInfo`

`PageInfo` 为单页尺寸：`{ index, widthMm, heightMm, xMm?, yMm?, source? }`；`index` 为 0-based，尺寸单位为 mm，`source` 为 `page`/`template`/`default`。

### `OutlineNode` 与 `BookmarkItem`

- `OutlineNode`：`{ title, expanded?, children, dest? }`，`children` 保持 XML 顺序，`dest` 为目标。
- `BookmarkItem`：`{ name, dest? }`，`name` 为书签名，`dest` 为目标。

两者通过 `DocumentState.outline`/`bookmarks` 或侧栏展示；`dest` 缺失表示该条目不可跳转。

### `TextContent` 与 `TextItem`

`TextContent` 是一页文本内容：`{ pageIndex, dpi, unit, pageWidth, pageHeight, items, itemCount, charCount, truncated }`；坐标单位固定为 `px`，`truncated` 为 `{ items: boolean; chars: boolean }`。

`TextItem` 是一个文本对象：包含 `order`、`objectId?`、`templateId?`、`annotationId?`、`blockId?`、`layer`、`layerType`、`zOrder?`、`visible`、`alpha`、`text`、`font`、`size`、`transform`、`origin`、`chars` 等字段。`font` 为字体元信息；`size` 单位为 px；`transform` 是布局局部 mm 到页面 px 的矩阵。

### `TextChar`、`TextRect` 与 `TextQuad`

- `TextChar`：`{ text, codePoint, glyphId?, faceKey?, fallback, origin, advance, rect, quad, approximate }`；`origin` 为基线起点，单位 px；`advance` 为推进量，单位 px。
- `TextRect`：`{ x, y, width, height }`，单位 px，`x`/`y` 为左上角。
- `TextQuad`：四个 `{ x, y }` 点组成的只读元组，顺序为左上、右上、右下、左下；旋转文字下“上”指字形自身方向。

普通宿主通常通过查找/选区间接使用这些类型；需要自行渲染文本层时才直接消费。

## 通过 URI 参数预览

### `ViewerSource`

```ts
type ViewerSource =
  | ArrayBuffer
  | Uint8Array
  | Blob                 // 包含 File
  | string               // URL
  | { readonly url: string; readonly headers?: Record<string, string> };
```

空 `ArrayBuffer`/`Uint8Array`、空 Blob、空 URL、空 `{ url }` 均以 `OFD_INVALID_OPTION` 拒绝。URL 字符串和 `{ url }` 都转换为 `HttpByteSource`；不能直接把 `HttpByteSource` 实例传给 `source`。

### 来源解析与请求头

来源优先级：`open(source)` 显式参数 → 构造 `options.source` → `?file=` → `?base64=`。`open()` 每次都会重新解析；普通打开失败时旧文档已在尝试新文档前关闭，状态为 `error`，需要调用方重新打开。若在凭据阶段取消（`OFD_CRYPTO_CANCELLED`），旧文档保持可读并恢复为 `ready`。

请求头合并顺序：`requestInit.headers` 先，来源对象 `headers` 后（来源优先）。`requestInit` 的其余字段不转发。

### `?file=`

- 值应为目标地址的 `encodeURIComponent` 结果。
- 先由 `URLSearchParams` 解码一次，再尝试一次 `decodeURIComponent`；非法百分号序列保留原值。
- 绝对 `http(s)` 地址直接使用；相对路径以 `location.href` 为 base 解析。
- 仅接受 `http:`/`https:`；`file:`、`javascript:`、`data:` 等以 `OFD_INVALID_OPTION` 拒绝。
- 空值、非法 URL 以 `OFD_INVALID_OPTION` 拒绝。
- 与 `base64` 同时存在时 `file` 优先，并产生 `W_QUERY_SOURCE` warning。

### `?base64=`

- 支持纯 base64 与 `data:...;base64,...`；data URI 必须包含 `;base64` 标记和逗号。
- 兼容 URL-safe `-`/`_`、缺失 padding、换行/空格；未编码的 `+` 会被 `URLSearchParams` 解成空格后还原。
- 解码后默认上限 `DEFAULT_MAX_BASE64_BYTES = 67_108_864`（64 MiB）。
- 非法字符、空值、非法 data URI、超限抛 `OFD_INVALID_OPTION`；缺少 `atob` 抛 `OFD_UNSUPPORTED`。
- base64 会进入历史、日志、Referer 和 APM；敏感文档不要使用。

### `readPreviewSourceFromLocation`

```ts
function readPreviewSourceFromLocation(
  location: PreviewLocation,
  options?: PreviewSourceOptions,
): ViewerSource | null;

interface PreviewLocation {
  readonly href: string;
  readonly search: string;
}

interface PreviewSourceOptions {
  readonly onWarning?: (warning: ViewerWarning) => void;
  readonly maxBase64Bytes?: number; // 默认 64 MiB
}
```

- 只读取 `search`，不读取或改写 hash。
- 两个参数都不存在时返回 `null`；`file` 返回绝对 URL 字符串，`base64` 返回 `Uint8Array`。
- `maxBase64Bytes` 非有限或为负时回落到默认值；传 `0` 会让任何非空数据超限。
- 抛错类型与 `?file=`/`?base64=` 规则一致。

## HttpByteSource

### 构造与选项

```ts
const source = new HttpByteSource(url, options?);

interface HttpByteSourceOptions {
  readonly headers?: Record<string, string>;
  readonly allowFullDownload?: boolean; // 默认 true
  readonly signal?: AbortSignal;
  readonly onProgress?: (loaded: number, total: number | undefined) => void;
  readonly fetch?: typeof fetch;
}
```

- `headers` 原样用于每次请求；与 `requestInit.headers` 的合并在阅读器内部完成，本类不做合并。
- `allowFullDownload` 控制服务器忽略 Range 或启用内容编码时是否允许整包下载；默认允许。
- `signal` 与 `close()` 合并生效。
- `onProgress` 只在整包读取时回调，`loaded`/`total` 单位为 byte；无法确定总长时 `total` 为 `undefined`。
- `fetch` 可注入，便于测试或宿主定制；缺省使用绑定到 `globalThis` 的全局 `fetch`。

### 读取与关闭

| 成员 | 说明 |
| --- | --- |
| `size: number` | 总字节数；探测完成前为 0 |
| `ready(): Promise<void>` | 等待大小探测；重复调用不重复请求；关闭后调用抛 `OFD_CLOSED` |
| `read(offset, length): Promise<Uint8Array>` | 读取区间；偏移越界、长度为 0 或 416 时返回空数组；关闭后抛 `OFD_CLOSED` |
| `close(): Promise<void>` | 中止在途请求并释放监听；可重复调用 |

探测先发 `HEAD`；服务器不支持 HEAD 或未给 `Content-Length` 时用 `Range: bytes=0-0`，从 `Content-Range` 读取总长。读取按需发 `Range`，不在内存中缓存整包；只有整包回退时才缓存。

### 回退与错误

- 服务器返回 200（忽略 Range）→ 整包下载并缓存；`allowFullDownload=false` 时抛 `OFD_INVALID_PACKAGE`。
- 响应带 `Content-Encoding`（gzip/br 等）→ Range 不可信，整包下载后按真实字节切片；禁用整包回退时报错。
- `Content-Range` 总长与探测值不一致 → 整包下载。
- HTTP 非 2xx、探测失败、缺少总长且无 HEAD 兜底 → `OFD_INVALID_PACKAGE`。
- 取消/关闭导致的错误原样重新抛出；`close()` 后 `read()` 抛 `OFD_CLOSED`。
- 跨域需要服务端允许 `Range` 并暴露 `Content-Range`。

## 查找、打印与导出

### `FindOptions` 与 `FindState`

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `caseSensitive` | `boolean` | `false` | 是否区分大小写 |
| `wholeWord` | `boolean` | `false` | 是否全词匹配（主要对拉丁文有效） |
| `highlightAll` | `boolean` | `true` | 是否高亮全部匹配 |
| `fromCurrentPage` | `boolean` | `true` | 是否从当前页开始搜索 |

`FindState` 为 `{ query, current, total, searching, caseSensitive, wholeWord, highlightAll }`；`current` 为 1-based，无匹配为 0。查找文本会归一化空白；空查询会清空状态而不是抛错。

### `PageRange`

```ts
type PageRange =
  | 'all'
  | 'current'
  | { readonly from: number; readonly to: number } // 1-based 闭区间
  | readonly number[];                             // 1-based，去重升序
```

- 页码必须为 1-based 整数；数组会去重并升序。
- `{ from, to }` 要求 `1 <= from <= to <= pageCount`。
- 空数组、越界、`from > to`、非整数值抛 `OFD_INVALID_OPTION`。
- 内置打印/导出对话框还支持 `1-3,5`、`-3`、`5-` 文本；公开 TypeScript 类型只声明 `PageRange`，宿主直接传字符串需要自行断言，运行时会解析。

### `PrintOptions`

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `pages` | `PageRange` | `'current'` | 打印范围 |
| `dpi` | `number / 'auto'` | `'auto'` | 输出 DPI；`auto` 自动分档；显式值须为 `(0, 600]` 的有限数字，否则抛 `OFD_INVALID_OPTION`；结果四舍五入 |
| `includeBackground` | `boolean` | `false` | 是否把页面背景渲染进图片；默认白底 |
| `rotation` | `Rotation / 'current'` | `'current'` | 打印方向；`current` 沿用阅读旋转 |
| `signal` | `AbortSignal` | 无 | 取消打印 |

打印会先把页面渲染为图片，再调用浏览器打印对话框；不会生成 PDF。打印失败抛 `OFD_PRINT_FAILED`。

### `ExportImageOptions`

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `page` | `number` | 当前页 | 页码，1-based；非法页抛 `OFD_INVALID_PAGE` |
| `format` | `ImageFormat` | `'png'` | `ImageFormat` 等同于 `PageImageFormat`：`png`/`jpeg`/`webp`；WebP 不支持时可能回退 PNG |
| `dpi` | `number / 'auto'` | `'auto'` | 输出 DPI；`auto` 自动分档；显式值须为 `(0, 600]` 的有限数字，否则抛 `OFD_INVALID_OPTION`；结果四舍五入 |
| `quality` | `number` | `0.92` | JPEG/WebP 质量，0–1；越界抛 `OFD_INVALID_OPTION`；PNG 忽略 |
| `background` | `string / null` | PNG 白底 | PNG 传 `null` 得到透明背景；JPEG/WebP 强制白底 |
| `rotation` | `Rotation` | `0` | 导出旋转 |
| `filename` | `string` | 自动生成 | 输出文件名（不含扩展名）；单页直接使用，多页作为前缀追加 `-p{pageNumber}` |
| `signal` | `AbortSignal` | 无 | 取消导出 |

### `ExportImagesOptions`

继承 `ExportImageOptions`（去掉 `page`），额外支持：

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `pages` | `PageRange` | `'current'` | 导出范围 |
| `zipFilename` | `string` | 自动生成 | ZIP 文件名（不含扩展名） |

多页导出固定打包为 ZIP。多页导出时 `filename` 作为前缀追加 `-p{pageNumber}`；单页 `exportImage` 直接使用该名称。

### `ExportOfdOptions` 与 `ExportOfdResult`

```ts
interface ExportOfdOptions {
  readonly filename?: string; // 不含或包含 .ofd，均规范为 .ofd
  readonly signal?: AbortSignal;
}

interface ExportOfdResult {
  readonly blob: Blob;        // type: application/ofd，内容为原始 OFD 字节
  readonly filename: string;  // 以 .ofd 结尾
  readonly size: number;      // 字节数
}
```

`exportOfd()` 导出阅读器打开时的原始 OFD 字节，不经过渲染或重新打包。加密文档导出的是原始加密包，不会用解密后的容器替换；宿主若自定义 `OutputHost.readSourceBytes`，必须返回打开时的原始字节，并在数据不足时返回错误。公开方法 `readSourceBytes()` 复用同一功能/权限门控，便于宿主自行保存或上传原文件。

### `ExportImageResult` 与 `ExportProgressEvent`

```ts
interface ExportImageResult {
  readonly blob: Blob;
  readonly filename: string;
  readonly pageNumber: number;
  readonly format: ImageFormat;
}

interface ExportProgressEvent {
  readonly current: number; // 已完成页数
  readonly total: number;   // 总页数
}
```

`exportImage()` 会触发浏览器下载并返回结果；`exportImages()` 只触发下载，不返回 ZIP 字节。

### DPI、格式与文件名

- `auto` DPI 按本次页数分档：≤50 页 200，51–200 页 150，>200 页 96；显式 DPI 须为 `(0, 600]`，结果四舍五入。
- `quality` 只影响 JPEG/WebP；PNG 始终无损。
- PNG 默认白底，`background: null` 透明；JPEG/WebP 不支持透明，强制白底。
- 自动文件名优先使用来源文件名/URL 路径，其次为 `metadata.title`，都无法推导时用 `document`；默认图片名为 `{docName}-p{page}`。自定义 `filename` 在多页导出时作为前缀，单页 `exportImage` 直接使用该名称。多页 ZIP 使用 `zipFilename`（可带或不带 `.zip`），未提供时生成 `{docName}-images.zip`。
- 单页失败产生 `W_EXPORT_PAGE`；部分失败产生 `W_EXPORT_PARTIAL`，成功页仍写入 ZIP；全部失败抛 `OFD_EXPORT_FAILED`。

## 签章、验证与 crypto

### `CryptoViewerOptions` 与 `CryptoOptions`

`CryptoViewerOptions` 继承密码能力包的 `CryptoOptions`：

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | 是否启用密码能力；`false` 时加密文档以 `OFD_CRYPTO_UNSUPPORTED` 拒绝，`verification` 功能变为 unsupported |
| `credentials` | `CryptoCredential / CryptoCredential[]` | 无 | 预置凭据；提供后不弹内置登录框 |
| `autoPrompt` | `boolean` | `true` | 无预置凭据时是否弹内置登录框 |
| `rootCertificates` | `CertificateSource[]` | `[]` | 初始信任根；空数组表示未配置，链状态通常为 `unknown` |
| `certificateLoader` | `CertificateInputLoader` | 无 | 读取 `path`/`filePath` 根证书的原始字节 |
| `autoVerify` | `boolean` | `true` | 打开成功后自动验证一次；仅在密码能力启用、`verification` 功能开启且存在签章或完整性信息时执行 |
| `onVerification` | `(report) => void` | 无 | 验证完成回调；回调抛错只产生 warning |
| `onCredentialRequired` | `(inspection) => Promise<CryptoCredential / null>` | 无 | 接管凭据弹窗；返回 `null` 取消 |
| `limits` | `Partial<CryptoLimits>` | 密码能力包默认值 | 资源上限；字段与默认值见密码能力 API |
| `signal` | `AbortSignal` | 无 | 当前只用于根证书 `url` 读取与根证书解析，不取消文档 inspect/decrypt 或 `verify()` |
| `onWarning` | `(warning) => void` | 无 | 密码能力 warning；与阅读器 `onWarning` 分开 |
| `sm2UserId` | `string` | `'1234567812345678'` | SM2 签名 userId，不从证书推导 |
| `now` | `Date` | `new Date()` | 校验证书有效期的当前时间，测试可注入 |

`CryptoOptions` 本身包含 `limits`、`signal`、`onWarning`、`sm2UserId`、`now`。`limits` 的字段名、单位和默认值统一由密码能力包维护；UI 不复制默认值。

### 凭据

```ts
type CryptoCredential =
  | { kind: 'password'; userName?: string; password: string }
  | {
      kind: 'private-key';
      userName?: string;
      privateKey: { pem?: string; der?: Uint8Array; passphrase?: string };
    };
```

- 口令按 UTF-8 参与 KDF，不做 Unicode 归一化。
- SM2 私钥 `pem`/`der` 二选一；`passphrase` 用于加密 PKCS#8。
- `userName` 省略时仅在唯一匹配用户时自动选择；多用户建议显式指定。
- 凭据只保留在调用栈/内存，不写日志、DOM、URL 或浏览器存储。

### 根证书

```ts
type CertificateSource =
  | { data: ArrayBuffer | Uint8Array; name?: string }
  | { url: string; headers?: Record<string, string>; name?: string }
  | { path: string; name?: string }
  | { filePath: string; name?: string };

type CertificateInputLoader = (
  source: CertificateSource,
) => Uint8Array | ArrayBuffer | null | Promise<Uint8Array | ArrayBuffer | null>;
```

| 形态 | 读取方式 | 失败行为 |
| --- | --- | --- |
| `data` | 直接使用 | 解析失败 warning 并跳过 |
| `url` | 浏览器 `fetch` | HTTP/解析失败 warning 并跳过 |
| `path` / `filePath` | `certificateLoader` | 无 loader 时 warning 并跳过；loader 抛错时 `OFD_CRYPTO_FAILED` |

`certificateLoader` 返回原始字节（PEM/DER/CER/Base64，可含多张证书），不要自行解析；UI 统一转换为 DER。浏览器宿主通常只用 `data`/`url`；Electron/Node 宿主可用 `fs.readFile` 实现路径读取。

### 验证行为与错误

- 预置 `credentials` 时不弹窗；`autoPrompt=false` 且无预置凭据时直接以 `OFD_CRYPTO_CREDENTIAL_REQUIRED` 拒绝，不会调用 `onCredentialRequired`。
- `autoPrompt=true` 且无预置凭据时才调用 `onCredentialRequired`；返回 `null` → `OFD_CRYPTO_CANCELLED`。
- `crypto.enabled=false` 时跳过密码初始化；加密文档打不开，明文文档正常阅读；`verification` 功能为 unsupported，调用 `verify()`/`openVerificationPanel()` 会在功能守卫处被拒绝。
- `autoVerify=true` 且文档有签章或完整性信息时，打开成功后自动验证；没有可验证内容时跳过。
- `verify({ signatureIds?, signal? })` 只验证指定签名或全部签名；`signal` 取消本次验证。
- `features.verification=false` 或 `crypto.enabled=false` 时 `verify()` 与 `openVerificationPanel()` 抛 `OFD_FEATURE_DISABLED`（`feature='verification'`）；旧报告失效。
- 验证失败统一映射为 `OFD_CRYPTO_FAILED` 并保留 `cause`；取消映射为 `OFD_CRYPTO_CANCELLED`。
- 打开阶段：加密检测（`inspect`）非取消失败同样映射为 `OFD_CRYPTO_FAILED`（错误码不变），但文案改为「读取文档加密信息失败：<detail>」，说明文档加密信息/包结构读取失败、与凭据无关；只有真正执行解密且凭据不匹配时才是「解密失败，请检查凭据后重试」。
- 与凭据无关的结构问题不会阻断打开：`Signatures.xml` 中 `Signature` 缺 `Type`/`BaseLoc`（规范中 `Type` 可选）只影响该签名本身——`Type` 为空串、`BaseLoc` 为空串时验证层记 `SIGNATURE_BASELOC_INVALID`；`BaseLoc` 路径穿越等非法值仍抛 `CRYPTO_INVALID_PACKAGE`。

### `VerificationReport`

| 字段 | 说明 |
| --- | --- |
| `overall` | 汇总状态；只看签名数学、dataHash、Reference、防夹带完整性和印章结构/数学，时间戳与证书链不参与 |
| `package` | 包级信息（版本、条目数等） |
| `decryption` | 加密源内部解密摘要；明文时省略 |
| `integrity` | 防夹带完整性结果；无保护时为 `null`，不能当作“通过” |
| `signatures` | 每个签名的 `SignatureVerification[]` |
| `rootsConfigured` | 是否配置了信任根 |
| `warnings` | 本次验证产生的 warning |
| `startedAt` | 开始时间，ISO 8601 |
| `durationMs` | 耗时，单位毫秒 |

### `SignatureVerification`

每个签名结果包含：`id`、`type`、`version`、`baseLoc`、`signedValuePath?`、`status`、`signingTime?`、`signingTimeSource?`、`signature`（数学验签）、`dataHash`（原文摘要比对）、`references`（保护范围校验）、`certificate`（证书链）、`seal?`（印章校验）、`timestamp`（只解析）、`issues`。`status` 为 `VerificationStatus`，取值为 `valid`/`invalid`/`unknown`/`not-applicable`/`unsupported`。`signingTime` 为可解析的签发时间字符串，来源优先级为时间戳信息、时间戳 `genTime`、`Signature.xml` 的 `SignatureDateTime`；缺失时 UI 显示“未提供”。

证书链状态可能为 `valid`/`invalid`/`expired`/`not-yet-valid`/`untrusted`/`incomplete`/`unsupported`/`not-present`/`unknown`；未配置根时通常为 `unknown`。证书链独立展示在“根证书链验证”栏中，`untrusted`/`expired`/`incomplete`/`unknown` 等链结果不得改写 `overall`。时间戳状态固定为 `parsed-not-verified`/`not-present`/`parse-error`，永不参与 `overall`。

### 签章摘要与详情类型

- `SignatureEntryInfo`：`{ id, type, baseLoc, provider?, signatureDateTime?, references, stamps, signedValuePath?, hasSignedValue }`；`references` 为 `SignatureReferenceInfo[]`（`{ fileRef }`），`stamps` 为 `SignatureStampInfo[]`（`{ id?, pageId, pageIndex?, boundary, clip? }`，几何单位 mm）。
- `SignatureProvider`：`{ name?, company?, version? }`。
- `SignedValueFile`：`{ signatureId, path, data: Uint8Array, byteLength }`，原始签名值字节；调用方拥有，UI 不解释内容。
- `SignatureDetail`：`{ entry, seal?, signer?, validation, warnings?, verification? }`。
- `SealInfo`：`{ version, esId?, name?, typeCode?, typeLabel?, createDate?, validStart?, validEnd?, certificate?, image? }`。
- `SealImageInfo`：`{ format, widthMm, heightMm, data? }`；`data` 仅用于 UI 以 Blob URL 渲染，不进入状态/日志。
- `SignerInfo`：`{ certificate?, certificateDer?, signedAt?, signedAtSource?, algorithm?, dataHash?, propertyInfo?, timestampPresent? }`；`certificateDer` 为调用方拥有的签名者证书 DER，可直接下载，不包含私钥或 PEM；`SignedAtSource` 为 `timeInfo`/`signatureDateTime`/`timestamp-token`。
- `SignatureValidation`：`{ status: 'not-verified', note }`；详情页只展示解析信息，不宣称验签通过。
- `CertificateInfo`：`{ subject, issuer, serialNumber, notBefore?, notAfter?, subjectAttributes?, signatureAlgorithm?, publicKeyAlgorithm? }`。
- `CertificateAttributes`：`{ cn?, o?, ou?, c?, st?, l?, email?, serialNumber? }`。
- `AlgorithmInfo`：`{ oid, name? }`。
- `CertificateSummary`：`{ subject, issuer, serialNumber, notBefore, notAfter, fingerprintSha256, publicKeyAlgorithm?, signatureAlgorithm?, keyUsage?, isCA }`。

### 验证结果展示约定

- 总体徽标只由 `report.overall` 决定；`report.overall` 已排除证书链和时间戳。签名数学、dataHash、Reference、防夹带完整性与印章结构/数学通过即显示绿色“有效”，证书链不可信、过期、不完整或未知时不得改成无效/灰色。
- 证书链在签章详情的“根证书链验证”栏独立展示链状态、是否配置信任根、签名者证书、信任锚、链成员和问题；无报告时明确显示“未验证”。链结果只影响该栏，不参与最终结论。
- 验证面板不显示“验证时间/耗时”；签名卡片显示 crypto 提供的 `signingTime`，缺失时为“未提供”。带时区的 ISO 时间换算 UTC+8，无时区字面量保持原值。
- 签章者旁用文字 + 颜色展示可信 tag：仅当 `certificate.status === 'valid'` 时为“可信”，其余/未知/未验证为“可信状态未知”，不出现“证书链通过”。
- 签章者证书和信任根证书可下载为 `.der`；文件名取 CN/序列号并清洗非法字符，Blob URL 下载后释放。印章图片仍只以 Blob URL 临时渲染。
- 侧栏签章列表为卡片式按钮，不使用 ▣/✎ 图标装饰，保留名称、类型、时间、签章者、页码和状态；支持键盘激活、焦点样式和 `aria-current` 选中态。页面印章浮层的“查看签章详情”与侧栏项调用同一个 `showSignature()` 详情面板。

### 验证状态与检测结果

`OfdInspection` 是打开前的检测结果：`{ encrypted, packageSize, entryCount, ofdVersion?, layers, users, signatures, integrityPresent, warnings }`。`layers` 与 `users` 分别描述加密层和用户，`signatures` 是签名摘要，`integrityPresent` 表示是否同时存在包级清单与签名值文件。

`VerificationStatus` 是通用状态联合：`valid`/`invalid`/`unknown`/`not-applicable`/`unsupported`。密码能力包的算法覆盖、证书链判定、完整性校验与不检查项由[密码能力 API](../../ofdrw-viewer-crypto/skills/API.md)维护；UI 只负责展示，不在这里重复算法细节。

## Web Component

### 属性

`<ofd-viewer>` 观察以下 HTML 属性；属性变化时调用对应实例方法，非法值被忽略。

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| `src` | URL 字符串 | 设置/替换文档来源；空值关闭文档 |
| `page` | 数字 | 跳转到 1-based 页码；非法值忽略 |
| `scale` | 数字 / 缩放模式 | 数字走 `setScale`，模式走 `setZoomMode` |
| `rotation` | 数字 | 规范为 0/90/180/270 |
| `theme` | `light`/`dark`/`auto` | 仅合法值生效 |
| `locale` | 字符串 | 非空时生效 |
| `sidebar` | 侧栏名 / 空 / `none` / `off` | 空、`none`、`off` 关闭侧栏；非法值忽略 |
| `font-default` | 逗号分隔 URL | 默认字体简写，映射为 `fonts.default: [{ url }]` |
| `font-supplementary` | 逗号分隔 URL | 补充字体简写，映射为 `fonts.supplementary: [{ url }]` |

`src` 变化会重新打开文档；设置空 `src` 会关闭文档但保留元素。未连接 DOM 时设置属性不会创建实例，连接后按当前属性创建。

`font-default`/`font-supplementary` 按英文逗号切分，逐项去除首尾空白并丢弃空项；属性缺失、空值或全部为空项时不传对应字段。两者都是 `observedAttributes`：值变化时**销毁并按当前属性重建**实例（与 `src` 的解绑重建语义一致），因此已加载的文档需要重新打开；属性是更具体的配置入口，设置时覆盖 `fonts` property 的同名字段，`loader`/`aliases` 仍来自 property。

### Property

| Property | 类型 | 说明 |
| --- | --- | --- |
| `viewer` | `OFDViewer / null` | 底层实例，只读 |
| `source` | `ViewerSource / null` | 复杂来源；优先于 `src` 属性；设为 `null` 关闭 |
| `features` | `ViewerFeatures` | 功能补丁；设置时立即调用 `setFeatures`，不重建实例 |
| `crypto` | `CryptoViewerOptions / undefined` | 密码能力配置；只在实例创建时读取，实例存在后修改不重建 |
| `fonts` | `ViewerFontOptions / undefined` | 字体配置；只在实例创建时读取，实例存在后修改不重建 |

`features` getter 返回补丁副本；`crypto` 与 `fonts` 在实例创建前设置才生效，且不重建实例。

### 方法

| 方法 | 说明 |
| --- | --- |
| `setFeatures(patch, { display? })` | 合并功能补丁；会保存补丁供重建使用 |
| `open(source?)` | 打开文档；无实例时先创建 |
| `close()` | 关闭文档并移除 `src` 属性 |
| `verify(options?)` | 重新验证；无实例时抛普通 `Error` |
| `getVerificationReport()` | 最近报告 |
| `setRootCertificates(roots)` | 替换信任根；无实例时返回空数组 |
| `getRootCertificates()` | 当前信任根摘要 |
| `openVerificationPanel()` | 打开验证面板 |
| `exportOfd(options?)` | 导出当前 OFD 原文件；无实例时返回 `null` |
| `destroy()` | 销毁实例；可重复调用 |

Web Component 尚未转发本机字体方法（`getLocalFontsStatus`/`setLocalFontsEnabled`/`onLocalFontsStatusChange`），需要程序化控制时通过 `el.viewer` 访问底层实例。`fonts` property 支持 `localFonts`，但与本机字体其余配置一样只在实例创建时读取。

### 组件事件

事件名为 `ofd-*`，`event.detail` 为对应载荷，`bubbles: true`、`composed: true`。完整映射见[事件名与载荷](#事件名与载荷)。

### 组件生命周期

- `connectedCallback` 创建实例并绑定事件；未设置 `src`/`source` 时仍会创建实例以读取查询参数。
- `disconnectedCallback` 销毁实例并解绑事件；重新连接时按当前属性重建。
- 无来源时 `ready` 会拒绝，组件内部已 catch，不会产生未处理 rejection。
- 默认样式：仅当宿主内联 `display`/`height`/`min-height` 未设置时，`connectedCallback` 才补 `display: block; height: 100%; min-height: 0`；父容器仍需提供确定高度，组件不会替父容器撑高。

`OFDViewerElement`、`OFD_VIEWER_TAG`、`defineOFDViewerElement(tagName = 'ofd-viewer')` 从 `/element` 导出；该入口还导出 `FeatureDisplay`、`SidebarView`、`ViewerFeatures`、`ViewerSource` 类型。导入 `/element` 会自动注册一次，重复调用安全。

## React

### React Props

`OFDViewerProps` 继承 `Omit<OFDViewerOptions, 'container' | 'source' | 'initialPage' | 'initialScale' | 'sidebar' | 'onWarning' | 'onError'>` 与 `ViewerEventHandlers`，并增加：

| Prop | 类型 | 说明 |
| --- | --- | --- |
| `source` | `ViewerSource` | 文档来源；省略时读查询参数 |
| `page` | `number` | 受控页码，1-based；变化时调用 `goToPage` |
| `scale` | `number / ZoomMode` | 受控缩放；数字为倍率，字符串为模式 |
| `sidebar` | `SidebarView / null` | 受控侧栏；`null` 关闭 |
| `onReady` | `() => void` | 首次打开完成回调 |
| `className` | `string` | 外层容器 class |
| `style` | `CSSProperties` | 外层容器样式；默认 `width/height: 100%` |

`rotation`、`theme`、`locale`、`features`、`featureDisplay`、`crypto` 等其他构造选项通过继承直接传入。`onWarning`/`onError` 由 `ViewerEventHandlers` 提供，作为事件回调使用，不再作为构造选项。

### 事件回调

`ViewerEventHandlers` 的字段名为 `on` + 事件名 PascalCase，例如 `onDocumentOpen`、`onPageChange`、`onScaleChange`、`onRotationChange`、`onFindMatches`、`onVerificationCompleted`、`onWarning`、`onError`。完整对应关系见[事件名与载荷](#事件名与载荷)。

### 命令句柄

`OFDViewerHandle` 通过 `ref` 暴露：

- 实例：`getInstance()`、`getViewer()`；
- 文档：`open(source?)`、`close()`；
- 导航/视图：`goToPage`、`nextPage`、`previousPage`、`setScale`、`setZoomMode`、`setRotation`、`setFeatures`；
- 查找/输出：`find`、`print`、`exportImage`、`exportOfd`；
- 状态：`getState`、`getFeatureState`、`isFeatureEnabled`；
- 验证：`verify`、`getVerificationReport`、`setRootCertificates`、`getRootCertificates`、`openVerificationPanel`。

`getInstance` 在挂载前返回 `null`；`exportImage`/`exportOfd` 在无实例时返回 `null`；`verify` 在无实例时抛 `Error('阅读器尚未挂载')`。

本机字体方法未进入命令句柄：需要 `getLocalFontsStatus()`/`setLocalFontsEnabled()` 时用 `getInstance()`（或 `getViewer()`）拿到实例后调用。`fonts.localFonts` 仍是构造期选项，通过继承的 `fonts` prop 传入。

### React 受控同步

- `page`、`scale`、`rotation`、`theme`、`locale`、`sidebar`、`features`、`featureDisplay` 变化分别调用对应实例方法；受控同步中的抛错/拒绝被静默忽略，不会触发核心 `error` 事件；需要错误反馈时直接调用命令句柄并自行处理 Promise。
- `source` 变化调用 `open`，不会重建实例；引用相等时不重复打开；打开失败仍由核心 `error` 事件报告。
- 卸载时解绑事件并 `destroy()`。
- 外层只创建一个 `div`；阅读器在其内部建立 DOM。

`/react` 额外导出 `Rotation`、`ScaleValue`、`SidebarView`、`ViewerEventHandlers`、`ViewerFeatures`、`FeatureDisplay`、`Theme`、`OFDViewerHandle`、`OFDViewerProps`。

## Vue

### Vue Props

| Prop | 类型 | 说明 |
| --- | --- | --- |
| `source` | `ViewerSource` | 文档来源；省略时读查询参数 |
| `page` | `number` | 受控页码，1-based |
| `scale` | `number / ZoomMode` | 受控缩放 |
| `rotation` | `0/90/180/270` | 初始/受控旋转 |
| `theme` | `light/dark/auto` | 初始/受控主题 |
| `locale` | `string` | 初始/受控语言 |
| `sidebar` | `SidebarView / null` | 初始/受控侧栏 |
| `features` | `ViewerFeatures` | 功能补丁 |
| `featureDisplay` | `FeatureDisplay` | 功能展示 |
| `options` | `AdvancedOptions` | 高级构造选项；公共 props 优先 |

`AdvancedOptions = Omit<OFDViewerOptions, 'container' | 'source'>`。`options` 可传 `crypto`、缓存、并发、`updateHash`、`onWarning`/`onError` 等；与顶层 props 同名时顶层优先。

### Emits

组件 emit `ready` 以及事件桥接的 kebab-case 名称：`document-open`、`document-close`、`page-change`、`page-rendered`、`pages-loaded`、`scale-change`、`rotation-change`、`sidebar-view-change`、`find-start`、`find-matches`、`find-current`、`selection-change`、`signature-click`、`verification-completed`、`print-start`、`print-progress`、`print-end`、`export-progress`、`warning`、`error`、`features-change`、`state-change`。载荷与核心事件一致。

### Expose

模板 ref 暴露 `getInstance`、`getViewer`、`open`、`close`、`goToPage`、`nextPage`、`previousPage`、`setScale`、`setZoomMode`、`setRotation`、`setFeatures`、`find`、`print`、`exportImage`、`exportOfd`、`getState`、`getFeatureState`、`isFeatureEnabled`、`verify`、`getVerificationReport`、`setRootCertificates`、`getRootCertificates`、`openVerificationPanel`。

本机字体方法未进入 expose：需要 `getLocalFontsStatus()`/`setLocalFontsEnabled()` 时用 `getInstance()` 调用；`fonts.localFonts` 通过 `options`（`AdvancedOptions`）传入。

### Vue 受控同步

- `page`、`scale`、`rotation`、`theme`、`locale`、`sidebar` 等受控同步中的抛错/拒绝被静默忽略，不会触发核心 `error` 事件；需要错误反馈时直接调用 expose 命令并自行处理 Promise。
- `source` 变化调用 `open`，值未变化时跳过；打开失败由核心 `error` 事件报告。
- `features` 深度监听，变化时调用 `setFeatures`。
- 卸载时 `destroy()`；组件实例用 `shallowRef`/`markRaw` 持有，不进入响应式代理。
- `/vue` 额外导出 `FeatureDisplay`、`Rotation`、`ScaleValue`、`SidebarView`、`Theme`、`ViewerFeatures`。

## 错误

### `OFDViewerError`

```ts
class OFDViewerError extends Error {
  readonly code: ViewerErrorCode;
  readonly feature?: ViewerFeature;
  readonly pageNumber?: number;
  readonly cause?: unknown;
}
```

`feature` 只在功能类错误上出现；`pageNumber` 为 1-based；`cause` 保留底层错误。`name` 固定为 `OFDViewerError`。

```ts
interface ViewerErrorOptions {
  readonly cause?: unknown;
  readonly feature?: ViewerFeature;
  readonly pageNumber?: number;
}
```


### UI 错误码

`ViewerErrorCode`：

| 错误码 | 触发场景 |
| --- | --- |
| `OFD_FEATURE_DISABLED` | 功能被关闭时调用受守卫方法；带 `feature` |
| `OFD_INVALID_OPTION` | 容器/来源/选项/范围/查询参数非法 |
| `OFD_INVALID_PAGE` | 导出页码非法 |
| `OFD_NOT_OPENED` | 需要已打开文档的操作 |
| `OFD_DESTROYED` | 实例销毁后调用方法 |
| `OFD_UNSUPPORTED` | 缺少服务、内置 UI 或环境能力 |
| `OFD_EXPORT_FAILED` | 多页导出全部失败 |
| `OFD_PRINT_FAILED` | 打印失败 |
| `OFD_SIGNATURE_PARSE_FAILED` | 签章详情解析失败 |
| `OFD_CLIPBOARD_FAILED` | 复制选区失败 |
| `OFD_CRYPTO_CREDENTIAL_REQUIRED` | 无预置凭据且 `autoPrompt=false` |
| `OFD_CRYPTO_CANCELLED` | 用户取消凭据或验证 |
| `OFD_CRYPTO_UNSUPPORTED` | 加密文档在密码能力关闭时打开、`setRootCertificates()` 等直接密码能力调用；`verification` 关闭时先由功能守卫拦截 |
| `OFD_CRYPTO_FAILED` | 解密/验签/根证书加载失败，以及打开阶段的加密信息读取失败（文案区分两者，错误码不变） |

`OFD_FEATURE_DISABLED` 常量值为字符串 `'OFD_FEATURE_DISABLED'`。

### 辅助函数

| 函数 | 说明 |
| --- | --- |
| `isOFDViewerError(value)` | 判断是否为 `OFDViewerError` |
| `createFeatureDisabledError(feature, message?)` | 创建带 `feature` 的功能关闭错误 |
| `isFeatureDisabledError(value, feature?)` | 判断功能关闭错误；省略 `feature` 时只校验错误码 |
| `assertFeatureEnabled(feature, state)` | 状态不可用时抛功能关闭错误 |
| `toOFDViewerError(error, code, message, options?)` | 包装为 `OFDViewerError`；已是该类型时原样返回 |

`OFDError`、`OFDErrorCode`、`OFDErrorOptions`、`isOFDError`、`toOFDError` 从渲染引擎包原样重导出，用于统一判断底层错误；引擎错误码清单见[渲染引擎 SKILL](../../ofdrw-viewer-engine/skills/SKILL.md)。

## 导出索引

以下名称均从 `@ofdrw/ofdrw-viewer-ui` 公共入口导出。

**核心与扩展**：`OFDViewer`、`registerViewerExtension`、`ViewerExtension`、`VERSION`、`getVersions`、`ViewerVersions`。

**构造与 crypto 选项**：`OFDViewerOptions`、`ResolvedViewerOptions`、`CryptoViewerOptions`、`CryptoOptions`、`CertificateSource`、`CertificateInputLoader`。

**功能**：`ViewerFeature`、`ViewerFeatures`、`ViewerFeatureStates`、`FeatureState`、`FeatureReason`、`FeatureDisplay`、`FeatureDisplayMode`、`FeatureAvailability`。

**字体**：`FontSource`、`ViewerFontOptions`、`FontSourceLoader`、`FontSourceResolver`、`FontSourceResolverOptions`、`LocalFontsOptions`、`LocalFontDeclaration`、`composeFontAliases`；再导出引擎的 `FontAliasTable`、`FontInput`、`FontMatchRequest`、`FontProvider`。

**本机字体**：`LocalFontStatus`、`LocalFontsStatus`、`LocalFontsChangeEvent`。

**状态**：`ViewerState`、`DocumentState`、`ViewState`、`UIState`、`InitialViewerStateOptions`、`ViewerWarning`、`ViewerErrorInfo`、`ViewerToast`、`ToastLevel`、`DialogName`、`VisiblePageRange`、`FindState`、`ZoomMode`、`ScaleValue`、`Rotation`、`SidebarView`、`Theme`。

**事件**：`ViewerEventMap`、`ViewerEventName`、`ViewerEventPayload`、`ViewerEventHandler`、`DocumentOpenEvent`、`DocumentCloseEvent`、`PageChangingEvent`、`PageRenderedEvent`、`PagesLoadedEvent`、`ScaleChangingEvent`、`RotationChangingEvent`、`SidebarViewChangedEvent`、`FindStartEvent`、`FindMatchesEvent`、`FindCurrentEvent`、`SelectionChangeEvent`、`SignatureClickEvent`、`VerificationCompletedEvent`、`PrintStartEvent`、`PrintProgressEvent`、`PrintEndEvent`、`ExportProgressEvent`、`WarningEvent`、`ErrorEvent`、`FeaturesChangeEvent`、`StateChangeEvent`、`LocalFontsChangeEvent`。

**来源与预览**：`ViewerSource`、`PreviewLocation`、`PreviewSourceOptions`、`DEFAULT_MAX_BASE64_BYTES`、`readPreviewSourceFromLocation`、`HttpByteSource`、`HttpByteSourceOptions`。

**文档与页面**：`DocumentMetadata`、`DocumentDestination`、`PageInfo`、`OutlineNode`、`BookmarkItem`、`PageRange`、`ImageFormat`、`PageImageFormat`、`GoToPageOptions`。

**文本**：`TextContent`、`TextItem`、`TextChar`、`TextRect`、`TextQuad`。

**查找/打印/导出**：`FindOptions`、`PrintOptions`、`ExportImageOptions`、`ExportImagesOptions`、`ExportImageResult`。

**签章与验证**：`SignatureEntryInfo`、`SignatureProvider`、`SignatureReferenceInfo`、`SignatureStampInfo`、`SignedValueFile`、`SignatureDetail`、`SignatureValidation`、`SignatureVerification`、`SealInfo`、`SealImageInfo`、`CertificateInfo`、`CertificateAttributes`、`AlgorithmInfo`、`SignerInfo`、`SignedAtSource`、`VerificationReport`、`VerificationStatus`、`CertificateSummary`、`OfdInspection`、`CryptoCredential`。

**UI 对话框**：`UIDialogAction`、`UIDialogOptions`。

**错误**：`OFDViewerError`、`ViewerErrorCode`、`ViewerErrorOptions`、`OFD_FEATURE_DISABLED`、`isOFDViewerError`、`createFeatureDisabledError`、`isFeatureDisabledError`、`assertFeatureEnabled`、`toOFDViewerError`、`OFDError`、`OFDErrorCode`、`OFDErrorOptions`、`isOFDError`、`toOFDError`。

`/react`、`/vue`、`/element` 的额外导出见各适配器章节。