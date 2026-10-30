---
name: ofdrw-viewer-ui
description: >-
  Embed the framework-agnostic OFD reader UI from @ofdrw/ofdrw-viewer-ui in web apps. Use this skill whenever a task involves a complete OFD reading interface, including continuous scrolling, zoom/rotation, thumbnails, outline/bookmarks, attachments sidebar with per-file download and ZIP export of embedded files, text selection and search, printing, PNG/JPEG/WebP and original OFD export, document info snapshot via getDocumentInfo, encrypted-document credentials, signature overlays and verification panels, per-page layer visibility via the layerPanel option (six content layers plus annotation-type filtering and sidebar tab icons), or the Web Component/React/Vue adapters. Covers installation, style import, container sizing, OFDViewer options/methods/events, feature gates, crypto configuration, framework wrappers, canvas sharpness and the supersample presets (off/auto/high/max), and known boundaries. Also covers URL loading in the UI layer: HttpByteSource, HTTP Range/CORS, request headers, cancellation, shared byte sources (engine does not fetch), host-controlled font bytes, and URI parameter preview: ?file= URLs, ?base64= values, base64 预览, encoding, priority and security. Use for OFD 阅读器、OFD 在线预览、URI 参数预览、?file=、?base64=、base64 预览、Vue/React OFD 组件、URL 跨域/Range 排障、文字模糊/渲染清晰度/超采样、图层显示控制/layerPanel/注释类型过滤, or when embedding @ofdrw/ofdrw-viewer-ui.
---

# OFD 阅读器 UI（@ofdrw/ofdrw-viewer-ui）

把 `@ofdrw/ofdrw-viewer-ui` 嵌入 Web 应用，得到完整的 OFD 阅读器。核心是 `OFDViewer` 类；`<ofd-viewer>`、React、Vue 都是对同一实例的薄封装。UI 负责阅读器外壳、交互和网络读取，消费渲染引擎的页面绘制与密码能力包的验证报告，不维护第二套 ASN.1/验签实现。

阅读器运行在**纯 SPA** 环境，不承诺 SSR/服务端水合，也不提供局部/瓦片渲染。完整选项、事件、方法、类型和默认值见 [API.md](./API.md)。

## 什么时候用

- 在 Web 应用中嵌入完整 OFD 阅读器，而不是只画一页；
- 需要连续滚动、页码、缩放/旋转、缩略图、大纲与书签导航；
- 需要透明文本层、文本选择/复制、全文查找与高亮；
- 需要打开加密 OFD（口令或 SM2 私钥），展示签章覆盖层与验证面板；
- 需要浏览器打印、单页/多页图片导出（PNG/JPEG/WebP，多页 ZIP）；
- 需要查看、下载 OFD 内嵌附件（附件侧栏，单个下载或整包 ZIP 导出），或读取文档信息快照（元数据、权限、附件、各类计数）；
- 需要 `<ofd-viewer>` Web Component 或 React/Vue 薄适配；
- 需要用 `?file=` / `?base64=` 链接直接预览 OFD，而不改宿主代码。

不适用：只需要把页面渲染到 Canvas，直接用渲染引擎包；批量转换文件用命令行工具；只提取文字用文档解析工具。

## 安装

```bash
pnpm add @ofdrw/ofdrw-viewer-ui
# 或 npm install @ofdrw/ofdrw-viewer-ui
```

在本仓库内从源码构建：

```bash
pnpm install
pnpm -C packages/ofdrw-viewer-engine build
pnpm -C packages/ofdrw-viewer-ui build
```

- 运行时需要 DOM、ES2020、Canvas 2D；打印依赖 `window.print`。
- React/Vue 是可选 peer 依赖；只用纯 HTML/Web Component 时不会加载框架代码。
- 包未声明 `sideEffects: false`，公共入口和各能力模块的注册不会被 bundler 当作纯模块摇掉。

## 样式与容器

主题样式必须由宿主显式引入，wrapper 不会自动注入：

```ts
import '@ofdrw/ofdrw-viewer-ui/style.css';
```

阅读器根元素需要确定高度，父容器也要有高度：

```html
<div id="viewer" style="height: 640px"></div>
```

挂载点必须自备确定高度，`OFDViewer` 不会修改宿主样式；它在挂载点内创建 `display: grid` 的 `.ofd-viewer` 根节点，并通过 `width/height: 100%` 撑满挂载点。`<ofd-viewer>` 自身是宿主：只有内联 `display`/`height`/`min-height` 未设置时，`connectedCallback` 才补 `display: block; height: 100%; min-height: 0`；父容器仍需提供高度，组件不会替父容器撑高。

弹出层（对话框、印章浮层、更多菜单、查找栏、侧栏 overlay/drawer、Toast）默认使用 `180ms ease-out` 的淡入 + 轻位移打开动画，关闭即时。可通过 `--ofd-motion-duration` 调整，建议 `160–200ms`；`prefers-reduced-motion: reduce` 下自动关闭。动画不影响定位、焦点和键盘操作。

## 渲染清晰度与超采样

文字走字形轮廓填充（不是 `fillText`），没有 hinting 与次像素渲染，所以低倍率下的观感主要取决于
画布采样密度。默认渲染口径是 **画布位图对齐设备像素 + 按倍率自适应超采样**：页盒尺寸对齐到
`1/DPR` 网格，避免整页落在半像素上被重采样而均匀发虚。

`supersample` 控制后备像素密度：

| 取值 | 行为 | 后备/CSS 像素比 |
| --- | --- | --- |
| `'auto'`（默认） | 按页面设备像素面积分档 | 低倍率 2.0 → 中 1.5 → 大 1.0 |
| `'off'` | 固定 1 倍 | 1.0 |
| `'high'` | 每档再加 1 倍 | 3.0 / 2.5 / 2.0 |
| `'max'` | 固定 3 倍 | 3.0 |
| `1..4` | 固定倍率 | 该值 |

```ts
// 默认即可；文字仍偏软时提高一档。
const viewer = new OFDViewer({ container: '#viewer', source: file, supersample: 'high' });
```

原则与代价：

- **只在构造时生效**。改采样密度需要重建 canvas，因此没有运行时 setter；`<ofd-viewer>` 对应
  `supersample` 属性，变更后重建实例并重新打开文档。
- **移动端默认 1**（优先保流畅），显式传 `'high'` / `'max'` / 数字时以传入值为准；DPR ≥ 2 时
  `auto` 实际不额外放大，因为已有 2 倍后备像素。
- **像素数按倍率平方增长**，受 `maxCanvasPixels`（桌面 256MP / 移动 32MP）约束，超限会降级并
  产生 `W_CANVAS_LIMIT`。高倍率下超采样自动回落到 1:1，属于预期行为。
- **极限倍率受浏览器限制**：A4 在 2500% 需要约 557MP / 2.2GB 显存，超出可稳定分配范围，此时
  画布会被降级，观感回到较软；这是物理上限，不是配置遗漏。

排障：文字模糊先确认 `devicePixelRatio`（缩放 125%/150% 或 Retina 下应 ≥ 1.25）、再确认是否
命中了 `W_CANVAS_LIMIT`；缺字体 `W_FONT_MISSING` 会让回退字形观感变差，两者要分开判断。
设计细节见 [手势缩放性能设计](../../../docs/手势缩放性能设计.md) §5.3–5.4。

## 5 分钟跑通

页面 URL 已带 `?file=` 或 `?base64=` 时可以省略 `source`，直接 `new OFDViewer({ container })`。

```ts
import { OFDViewer } from '@ofdrw/ofdrw-viewer-ui';
import '@ofdrw/ofdrw-viewer-ui/style.css';

const viewer = new OFDViewer({
  container: '#viewer',
  source: file, // File / Blob / ArrayBuffer / Uint8Array / URL / { url, headers? }
  initialPage: 1,
  initialScale: 'auto',
  theme: 'auto',
  locale: 'zh-CN',
  features: { print: false },
  onWarning: ({ code, message }) => console.warn(code, message),
  onError: ({ code, message }) => console.error(code, message),
});

await viewer.ready;

viewer.on('pagechanging', ({ pageNumber }) => {
  console.log('当前页', pageNumber);
});
viewer.goToPage(2);
viewer.setZoomMode('page-width');
viewer.openSidebar('thumbnails');

// 销毁：解绑 DOM/事件并释放渲染资源。
viewer.destroy();
```

`container` 是唯一必填选项；`source` 省略时按查询参数解析，两者都没有则 `ready` 以 `OFD_INVALID_OPTION` 拒绝。默认初始页为 1、初始缩放为 `auto`、主题为 `auto`、语言为 `zh-CN`。

## 网络与文件获取委托（UI 侧）

在浏览器中，UI 是 OFD 网络读取的唯一入口：URL 字符串与 `{ url, headers? }` 在打开时被规范化为一个 `HttpByteSource`，crypto 检测与 engine 渲染共用同一实例，只探测/读取一次；`File`/`Blob`/`ArrayBuffer`/`Uint8Array` 不经过网络，直接交给 engine。引擎包不再接受 URL；字体字节也由 UI 按 `fonts` 配置读取后交给引擎，见 [字体配置](#字体配置)。设计背景与分层边界见 [网络获取委托设计](../../../docs/网络获取委托设计.md)，完整选项见 [API.md 构造选项](./API.md#ofdvieweroptions)。

### URL 来源与鉴权

```ts
const viewer = new OFDViewer({
  container: '#viewer',
  source: {
    url: '/api/ofd/123',
    headers: { Authorization: `Bearer ${token}` },
  },
});
await viewer.ready;
```

- `requestInit.headers` 先合并，来源对象 `headers` 覆盖同名键（来源优先）；`requestInit.credentials` 不转发，fetch 使用浏览器默认的 `same-origin` 凭据策略。
- 跨域时服务端需允许 `Range` 请求，并通过 `Access-Control-Expose-Headers` 暴露 `Content-Range`；`Authorization` 等自定义头也要在 CORS 允许列表中。
- 服务器忽略 Range 或响应启用 `Content-Encoding` 时，UI 会整包下载并缓存；`HttpByteSourceOptions.allowFullDownload` 设为 `false` 可禁用该回退。
- 探测/HTTP 状态/非法 `Content-Range` 抛 `OFD_INVALID_PACKAGE`；关闭后读取抛 `OFD_CLOSED`。鉴权 token 的刷新、重试与存储由宿主负责。

### 宿主自行读取：fetch → Blob/ArrayBuffer

```ts
const viewer = new OFDViewer({ container: '#viewer', source: '/sample.ofd' });
await viewer.ready;

const response = await fetch('/api/ofd/456', {
  headers: { Authorization: `Bearer ${token}` },
});
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const bytes = await response.arrayBuffer(); // 也可 await response.blob()
await viewer.open(bytes); // 字节已由宿主读取，UI 不再发起网络请求
```

需要宿主统一处理鉴权、重试或 CORS 时，先 `fetch` 再 `viewer.open(blob | arrayBuffer)`；后续切换文档同样接受 `File`/`Blob`。

### 直接使用 HttpByteSource

`HttpByteSource` 也作为公共 API 导出，便于宿主预读、探测或接入自定义加载流程：

```ts
import { HttpByteSource } from '@ofdrw/ofdrw-viewer-ui';

const source = new HttpByteSource('/api/ofd/789', {
  headers: { Authorization: `Bearer ${token}` },
  signal: abortController.signal,
});
await source.ready(); // HEAD/Range 探测；失败抛 OFD_INVALID_PACKAGE
const head = await source.read(0, 8); // 按需 Range 读取，越界截断
await source.close(); // 幂等；之后 read() 抛 OFD_CLOSED
```

`ByteSource` 不是 `OFDViewer.source` 的合法类型；要复用同一份字节，请直接传 URL（UI 内部复用同一实例）或传读取后的字节。构造参数与错误语义见 [API.md HttpByteSource](./API.md#httpbytesource)。

### 省略 source：?file= / ?base64=

`source` 可省略，此时读取页面查询参数预览：

```text
https://viewer.example.com/?file=https%3A%2F%2Ffiles.example.com%2Fdemo.ofd
https://viewer.example.com/?base64=UEsDBBQAAAAI
```

来源优先级为：`viewer.open(source)` 显式参数 > 构造选项 `source` > `?file=` > `?base64=`；`file` 与 `base64` 同时存在时用 `file`，并产生一条 `W_QUERY_SOURCE` warning。无任何来源时 `ready` 以 `OFD_INVALID_OPTION` 拒绝；`?file=` 只接受 `http(s)`，非法协议、空 URL、非法/超限 base64 同样抛 `OFD_INVALID_OPTION`。编码细节、安全提醒与链接生成见下文《通过 URI 参数预览》。

## 文档来源

`source` 支持 `File`/`Blob`、`ArrayBuffer`/`Uint8Array`、URL 字符串、`{ url, headers? }`。切换文档直接 `await viewer.open(nextSource)`；`await viewer.open()` 会重新按构造来源或当前查询参数打开。

## 字体配置

引擎不读取字体 URL/路径，字体读取由 UI 完成：构造时传 `fonts`，UI 把每个来源读成字节后映射到引擎的 `defaultFonts`/`supplementaryFonts`。

```ts
new OFDViewer({
  container: '#viewer',
  source: '/sample.ofd',
  fonts: {
    // 文档字体完全缺省时的替代字体。
    default: [{ url: '/fonts/NotoSerifSC-Regular.woff2', family: 'Noto Serif SC' }],
    // 主字体缺字时逐字形补齐。
    supplementary: [{ url: '/fonts/NotoSansSC-Regular.woff2' }],
  },
});
```

- 来源四态与证书一致：`{ data }`、`{ url, headers? }`、`{ path }`、`{ filePath }`；后两类需要 `fonts.loader`，UI 自身不访问文件系统。另有第五态 `{ local }`（浏览器本机字体），见下文本机字体一节。
- `url` 的 `headers` 与 `requestInit.headers` 合并（来源优先）；同一 URL 在实例生命周期内只读取一次。
- 只接受**完整字体文件**（`.ttf`/`.otf`/`.woff2`），不接受 CSS 的 unicode-range 子集切片；引擎用字形轮廓绘制，与 CSS 字体加载无关。
- 读取失败只产生 `W_FONT_MISSING` warning（`onWarning`/`ofd-warning`），不阻断文档打开；`fonts.aliases` 会追加到引擎内置别名组，而不是替换。
- `fonts` 与 `crypto` 同级：只在实例创建时读取，修改后重新 `open()`；Web Component 还可用 `font-default`/`font-supplementary` 逗号分隔 URL 简写，变更时重建实例。
- 排查缺字：控制台默认打印 `[ofd-viewer] warning W_FONT_MISSING ...` / `W_GLYPH_MISSING ...`（含 `pageIndex`/`resourceId`，同一文档会话内去重），需要静默时传 `debug: { console: false }`。
- 典型样本：`ofd_pdf_match/拿来主义_page6.ofd` 的 `PublicRes` 只声明 `FontName="宋体"`、没有 `FontFile`，不配字体时整页空白；配上宋体风格默认字体后正文可见。
- 在线演示站的字体策略（可复制的宿主示例）：纯本地兜底、不依赖 CDN——`default` 为站点自带思源宋体子集（`fonts/source-han-serif-sc.woff2`，OFL，约 10.6 MiB），`supplementary` 为站点自带思源黑体子集（`fonts/source-han-sans-sc.woff2`，OFL，约 7.5 MiB），同时作为宋体缺字时的逐字形补充；`aliases` 追加「宋体/simsun/…/notoserifcjksc」与「黑体/simhei/微软雅黑/…/notosanscjksc」两组，保证宋体与黑体声明都能命中对应字体。本地路径用 `import.meta.env.BASE_URL` 拼接以兼容子路径部署；字体文件不进入 npm 包。

完整设计（引擎兼容性、CDN 选型、安全边界）见 [字体配置方案设计](../../../docs/字体配置方案设计.md)，字段与类型见 [API.md 字体配置](./API.md#字体配置)。

### 本机字体（可选）

浏览器本机字体（`queryLocalFonts`，Chrome 103+ 桌面端）让阅读器在用户授权后读取本机已安装的字体，补上宿主没提供、而用户机器上恰好有的同名字体（如 Windows 自带的宋体、黑体、微软雅黑）。**默认关闭，且必须宿主与用户双方同意**。

```ts
new OFDViewer({
  container: '#viewer',
  source: '/sample.ofd',
  fonts: {
    default: [{ url: '/fonts/NotoSerifSC-Regular.woff2', family: '宋体' }],
    // 想在文档打开时自动询问用户，把 defaultEnabled 设为 true（演示站的默认做法）。
    // 只想让用户在「关于」里手动开，保持 defaultEnabled: false。
    localFonts: { enabled: true, defaultEnabled: true, maxFonts: 8 },
    // 可选：直接声明本机字体来源（仍受上面的开关与用户授权约束）。
    supplementary: [{ local: 'SimSun' }],
  },
});
```

#### `LocalFontsOptions` 五个字段

| 字段 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `false` | **总闸**。为 `true` 才启用能力；否则「关于」里不出现开关、`{ local }` 来源按不支持跳过 |
| `defaultEnabled` | `boolean` | `false` | **用户意向的默认值**。用户从未表态时生效：`true` 时文档打开就会弹确认框；`false` 时用户需去「关于」里手动开 |
| `remember` | `boolean` | `true` | 是否把用户选择记进 `localStorage`（只存两个布尔值）；`false` 时每次打开都会重新询问 |
| `maxFonts` | `number` | `8` | 单文档最多查询几个**文档声明字体**（不是候选名字数；单个声明最多 6 个候选名） |
| `consentText` | `string` | 内置文案 | 覆盖确认框的说明文字（内网统一口径时用） |

#### 生效值：四个状态字段的分工

| 字段 | 来源 | 含义 | 与开关的关系 |
| --- | --- | --- | --- |
| `visible` | 宿主 `fonts.localFonts.enabled === true` 且浏览器提供 API | 能力是否对用户可见 | `false` 时「关于」里整行不渲染 |
| `supported` | `typeof window.queryLocalFonts === 'function'` | **仅**表示浏览器提供 API | `false` 时开关隐藏并禁用，只留原因文案 |
| `permission` | `navigator.permissions` 的 `local-fonts` | 浏览器授权态：`prompt`/`granted`/`denied` | 决定 `enabled` 与状态文案 |
| `enabled` | 计算值 | **真正生效值**：`用户意向为开 && permission === 'granted'` | **这就是开关的显示状态** |

用户意向 = 已记住的用户选择，没有则用 `defaultEnabled`。

**核心原则：开关状态与浏览器授权状态同步。** 权限为 `prompt` 或 `denied` 时 `enabled` 一律为 `false`（开关显示为关）——任何授权失败都会让开关自动回到关闭态，用户点一下即可重新申请，不会停在「开着却不起作用」的假象上。

注入路径与显示值同源：控制器用同一个条件（`用户意向 && permission === 'granted'`）决定是否生成 `{ local }` 来源，因此「开关显示为开」与「字体真的被注入」永远一致。权限未授予时发起查询必然失败，还会让「未授权」与「本机没装」无法区分。

#### 开启方式与行为

- **宿主配置**：`fonts.localFonts.enabled: true`；不配或为 `false` 时能力对用户完全不可见（`visible === false`，「关于」里不渲染开关行，`{ local }` 来源按不支持跳过）。
- **用户授权（两个入口）**：
  1. **文档打开后自动弹确认框**——条件是「能力可见 + 用户意向为开 + 浏览器权限仍是 `prompt` + 本会话未问过 + 跨会话未表态」。点「允许」后在同一 click 事件内申请浏览器权限（浏览器只接受**用户手势**内的申请，阅读器不会在 `open()` 里静默申请）。
  2. **工具栏「更多」→「关于」里的开关**——事后修改意向，切换后立即生效。
- **授权只需一次**：浏览器记住授权后，刷新页面、重开文档都静默生效；开启/关闭开关会重开当前文档并恢复页码/缩放/旋转。
- **开关状态与浏览器授权同步**：`LocalFontsStatus.enabled = 用户意向为开 && permission === 'granted'`。权限为 `prompt`/`denied` 时开关一律显示为关——任何授权失败都会让开关自动回到关闭态，不会停在「开着却不起作用」的假象上。
- **三种关闭确认框的方式结果不同**：
  - 点「允许」且授权成功 → 开关为开、记住选择，下次不再问；
  - 点「不允许」/ 浏览器拒绝 → 开关为**关**、**清除用户意向记录**，下次不再自动弹框，用户可点开关重新申请（Chrome 在 `denied` 后不会再次弹授权框，需先在浏览器站点设置里改为允许）；
  - 按 Esc / 点遮罩 → 不写入任何记录，**下次仍会询问**。
- **关闭即回退**：关闭开关清空本机字体缓存并重开文档，画面立即回到原有字体来源，其它功能不受影响。
- **注入位置**：宿主配置的 `default` 在前、本机字体追加在后，宿主显式字体始终优先。本机字体**只进 `defaultFonts`，不进 `supplementaryFonts`**——同一份 10–20 MB 字体同时注入两个列表会被引擎解析两次、内存翻倍，而本机字体是「替代/优先」语义而非补字语义。
- **失败静默回退**：浏览器不支持、用户拒绝、站点 `Permissions-Policy` 禁用、本机未安装、读字节失败时，本机字体被跳过，只产生 `W_FONT_MISSING` warning（`message` 只含字体名与错误摘要），不阻断打开。注意**不支持时也会产生该 warning**；需要完全静默时用 `debug: { codes: [...] }` 过滤或先查 `getLocalFontsStatus().supported`。
- **隐私**：只按文档声明做定向查询，不做全量枚举；字体字节只在内存中交给引擎渲染，不上传、不落盘、不写日志。

#### 机制概要（一次 `open()` 发生了什么）

```text
① 刷新权限态 + 把生效值同步给控制器
② resolveFonts()：宿主 default/supplementary 先读，本机来源按【上一次】读到的声明生成
③ openDocument(...)              ← 首次打开（此时可能还没有本机字体）
④ document.getFontResources()    ← 打开后才知道文档声明了什么字体
⑤ 声明非空且已启用 → 带本机字体重开一次（恢复页码/缩放/旋转）
⑥ 权限仍为 prompt 且未表态 → 弹确认框
```

因此一次「打开」最多可能调用 3 次 `openDocument`（首屏 / 补注入 / 授权后），这是设计选择而非缺陷：声明只能在打开后读取，合并时机会互相纠缠。重开用的是已缓存字节，无网络开销。

名字转换是关键一环：文档声明的是 `宋体`，而 `queryLocalFonts` 只接受**区分大小写的 PostScript 名**（`SimSun`）。阅读器按「变体后缀 → 基础名 → 别名成员 → 原始名」展开候选名（单个声明最多 6 个，为原始名预留槽位），**不推断大小写**（`Simsun` 查不到，只有 `SimSun` 能命中），一次调用整批传入后按候选顺序取第一个命中。命中后 `FontInput.family` 取**文档声明的名字**（`宋体`），让引擎的「精确名匹配 200 分」生效。

状态与控制：`viewer.getLocalFontsStatus()`、`viewer.setLocalFontsEnabled(enabled)`（须在用户点击事件内调用）、`viewer.onLocalFontsStatusChange(handler)`，以及核心事件 `local-fonts:change`。详见 [API.md 本机字体](./API.md#本机字体) 与 [本地字体加载方案设计](../../../docs/本地字体加载方案设计.md)。

`source` 取值补充说明：

- 空字节、空 Blob、空 URL 以 `OFD_INVALID_OPTION` 拒绝。
- URL 由 UI 在内部转换为 `HttpByteSource`；引擎只接收字节，不联网。
- `requestInit` 只对 URL 来源生效，且**只使用 `headers`**：先合并 `requestInit.headers`，再由来源对象的 `headers` 覆盖（来源优先）。`credentials` 不转发，fetch 使用浏览器默认的 `same-origin` 凭据策略。
- 鉴权 token 的刷新、重试与存储由宿主负责，阅读器不持久化凭据。

## 通过 URI 参数预览

不传 `source` 时，`open()` 读取当前页面的 `location.search`，识别 `?file=` 与 `?base64=`；只读查询串，不读取也不改写 `updateHash` 使用的 hash。来源优先级：

1. `viewer.open(source)` 的显式参数；
2. 构造选项 `options.source`；
3. `?file=`；
4. `?base64=`。

`file` 与 `base64` 同时存在时用 `file`，并产生一条 `W_QUERY_SOURCE` warning。

`?file=` 的值必须是目标地址经过 `encodeURIComponent` 后的结果；实现会先由 `URLSearchParams` 解码一次，再尝试一次 `decodeURIComponent`，非法百分号序列保留原值。支持绝对 `http(s)` 地址和相对当前页面的路径；解析后仅接受 `http:`/`https:`，`file:`、`javascript:`、`data:` 等协议一律以 `OFD_INVALID_OPTION` 拒绝。

```text
# 绝对地址（值本身已 encodeURIComponent）
https://viewer.example.com/?file=https%3A%2F%2Ffiles.example.com%2Fofd%2Fdemo.ofd

# 同源相对路由，以当前页面为 base
https://viewer.example.com/app/?file=%2Fapi%2Fofd%2F123.ofd

# 含中文与空格的路径（原路径 /api/ofd/发票 2026.ofd）
https://viewer.example.com/?file=%2Fapi%2Fofd%2F%E5%8F%91%E7%A5%A8%202026.ofd
```

```js
const target = new URL('/api/ofd/发票 2026.ofd', window.location.href).href;
const url = `${location.origin}${location.pathname}?file=${encodeURIComponent(target)}`;
```

`?base64=` 支持纯 base64 和 `data:application/ofd;base64,...`；data URI 必须带 `;base64` 标记与逗号。兼容 URL-safe 字符（`-`/`_`）、缺失的 padding、换行/空格，但仍建议对值做 `encodeURIComponent`，避免 `+`、`/`、`=` 被查询串解释。解码后默认上限 **64 MiB**（`DEFAULT_MAX_BASE64_BYTES`）；非法字符、空值、非法 data URI、超限抛 `OFD_INVALID_OPTION`，环境缺少 `atob` 抛 `OFD_UNSUPPORTED`。

```text
# 纯 base64（只是格式示例，必须替换为完整文件）
https://viewer.example.com/?base64=UEsDBBQAAAAI

# data URI（同样只是格式示例）
https://viewer.example.com/?base64=data%3Aapplication%2Fofd%3Bbase64%2CUEsDBBQAAAAI
```

```bash
B64=$(base64 -w0 demo.ofd)
node -e 'console.log("https://viewer.example.com/?base64=" + encodeURIComponent(process.argv[1]))' "$B64"
```

安全提醒：

- base64 会进入浏览器历史、服务器访问日志、Referer 和监控/APM；敏感文档不要用 `?base64=`，改用一次性 `source`、POST 或短时效下载链接。
- 不要把鉴权 token 拼进 URL；需要鉴权时用 `{ url, headers? }` 或 `requestInit.headers`。
- 超长 URL 可能被代理/浏览器截断；大文件优先用 `file=` 或直接传字节。
- 部署时服务端需允许 CORS 与 `Range`，并暴露 `Content-Range`。

完整参数表、解析函数 `readPreviewSourceFromLocation()` 与 `PreviewLocation`/`PreviewSourceOptions` 见 [API.md 通过 URI 参数预览](./API.md#通过-uri-参数预览)。

## 网络来源与字节源

URL 不交给引擎：UI 的 `HttpByteSource` 按 HTTP Range 读取，crypto 与 engine 共用同一实例，避免重复探测/下载。明文路径由 engine 拥有 `custom` 源并在关闭文档时释放；加密路径由 UI 持有并关闭。

```ts
import { HttpByteSource, type HttpByteSourceOptions } from '@ofdrw/ofdrw-viewer-ui';

const options: HttpByteSourceOptions = {
  headers: { Authorization: 'Bearer <token>' }, // 与 requestInit.headers 合并时来源优先
  signal: abortController.signal,
  allowFullDownload: true,
  onProgress: (loaded, total) => console.log(loaded, total), // 单位 byte
};
const httpSource = new HttpByteSource('/api/doc.ofd', options);
await httpSource.ready(); // 大小探测完成；失败时抛 OFDError
const head = await httpSource.read(0, 4);

// OFDViewer 的 source 仍传 URL/字节（不能直接传 ByteSource）；
// 传 URL 时 UI 会按同样规则在内部创建 HttpByteSource。
const viewer = new OFDViewer({ container: '#viewer', source: '/api/doc.ofd' });
```

- 探测：先 `HEAD`，必要时 `Range: bytes=0-0`；`ready()` 缓存结果，重复调用不重复请求。
- 读取：`read(offset, length)` 按需发 Range，越界截断；416 或越界返回空数组。
- 回退：服务器忽略 Range（200）、响应启用 `Content-Encoding` 或总长不一致时整包下载并缓存；`allowFullDownload=false` 时改为报错。
- 取消：`signal` 与 `close()` 合并生效；关闭后 `read()` 抛 `OFD_CLOSED`，`close()` 可重复调用。
- CORS：跨域需要服务端允许 `Range`，并暴露 `Content-Range`。
- 进度：`onProgress` 只在整包读取时可用；字体下载在 `open()` 期间显示「正在加载字体…」，但 UI 不额外暴露字体字节级进度回调。
- 字体：引擎不读取字体 URL/路径；UI 通过 `fonts.default`/`fonts.supplementary` 的 `{ url }` 来源读取字体字节（也可用 `data` 或 `loader`），读取失败只产生 `W_FONT_MISSING` warning，不阻断打开。

完整构造参数、默认值与错误语义见 [API.md HttpByteSource](./API.md#httpbytesource)。

## 框架适配

### Web Component

```html
<link rel="stylesheet" href="/node_modules/@ofdrw/ofdrw-viewer-ui/dist/style.css" />
<ofd-viewer id="reader" src="/sample.ofd" theme="auto" locale="zh-CN"></ofd-viewer>

<script type="module">
  import '@ofdrw/ofdrw-viewer-ui/element';

  const reader = document.querySelector('#reader');
  reader.features = { print: false };
  reader.style.height = '640px';

  reader.addEventListener('ofd-page-change', (event) => {
    console.log(event.detail.pageNumber);
  });
</script>
```

标签默认是 `ofd-viewer`，采用 light DOM，不创建 Shadow DOM。基础属性为 `src`、`page`、`scale`、`rotation`、`theme`、`locale`、`sidebar`、`font-default`、`font-supplementary`、`supersample`、`layer-panel`；复杂配置用 `features`、`crypto`、`fonts`、`source` property。`font-default`/`font-supplementary` 是逗号分隔的字体 URL 简写；它们与 `supersample`、`layer-panel` 都只在创建实例时生效，变更时销毁并按新属性重建实例（文档会重新打开）。省略 `src` 时仍会创建实例并读取查询参数；断开连接销毁实例，重新连接按当前属性重建。事件名为 `ofd-*`，`event.detail` 为对应载荷，`reader.viewer` 是底层只读实例。本机字体能力可直接调用 `reader.getLocalFontsStatus()`、`reader.setLocalFontsEnabled(enabled)`、`reader.onLocalFontsStatusChange(handler)`（未创建实例时分别返回默认状态、抛 `Error('阅读器尚未创建')`、返回空退订函数），状态变化同时派发 `ofd-local-fonts-change`。`sidebar` 属性接受 `thumbnails`/`outline`/`bookmarks`/`signatures`/`attachments`/`layers`（空、`none`、`off` 关闭），与核心共用 `SIDEBAR_VIEWS` 单一清单；`layer-panel` 属性可配置图层 tab（见[图层显示控制](#图层显示控制layerpanel)）。

完整属性/property/方法/事件见 [API.md Web Component](./API.md#web-component)。

### React

```tsx
import { useRef } from 'react';
import { OFDViewer, type OFDViewerHandle } from '@ofdrw/ofdrw-viewer-ui/react';
import '@ofdrw/ofdrw-viewer-ui/style.css';

export function Reader() {
  const ref = useRef<OFDViewerHandle>(null);
  return (
    <div style={{ height: 640 }}>
      <OFDViewer
        ref={ref}
        source="/sample.ofd"
        features={{ print: false }}
        onReady={() => ref.current?.goToPage(1)}
        onPageChange={({ pageNumber }) => console.log(pageNumber)}
      />
    </div>
  );
}
```

`source`/`features` 等 prop 变化只调用核心方法，不会重建实例；卸载时销毁。`supersample` 属构造选项，**变更会重建实例并重新打开文档**（采样密度无法原地调整）。`page` 为 1-based 受控页码，`scale` 可传数字或缩放模式，`sidebar` 传 `null` 关闭。ref 暴露 `getInstance`、`open`、`goToPage`、`setScale`、`setRotation`、`setFeatures`、`find`、`print`、`exportImage`、`exportOfd`、`verify`、`getLocalFontsStatus`、`setLocalFontsEnabled`、`onLocalFontsStatusChange` 等薄方法；本机字体状态变化还可通过 `onLocalFontsChange` 回调接收。外层容器默认 `width/height: 100%`。

完整 props、事件回调和句柄见 [API.md React](./API.md#react)。

### Vue

```vue
<script setup lang="ts">
import { OFDViewer } from '@ofdrw/ofdrw-viewer-ui/vue';
import '@ofdrw/ofdrw-viewer-ui/style.css';

const features = { print: false };
</script>

<template>
  <div style="height: 640px">
    <OFDViewer
      source="/sample.ofd"
      :features="features"
      @page-change="({ pageNumber }) => console.log(pageNumber)"
    />
  </div>
</template>
```

组件只创建一个外层 `div`，实例用 `shallowRef`/`markRaw` 持有，不进入响应式代理。公共 props 覆盖 `options` 里的同名项；事件使用 kebab-case。模板 ref 可调用 `getInstance`、`goToPage`、`setScale`、`setRotation`、`setFeatures`、`find`、`print`、`exportImage`、`exportOfd`、`verify`、`getLocalFontsStatus`、`setLocalFontsEnabled`、`onLocalFontsStatusChange` 等 expose 方法；本机字体状态变化还可通过 `@local-fonts-change` 接收。

完整 props、emits 与 expose 见 [API.md Vue](./API.md#vue)。

子路径与导出内容见 [子路径导出](./API.md#子路径)。

## 核心工作流

### 打开、切换与关闭

```ts
await viewer.open('/api/doc-b.ofd');
await viewer.open();  // 重新按 options.source 或 ?file=/?base64= 打开
await viewer.close(); // 保留外壳，状态回到 closed，可再次 open
viewer.destroy();     // 移除根节点；销毁后调用方法抛 OFD_DESTROYED
```

`open()` 会取消上一次未完成的打开并释放其来源；失败通过 `ready`/返回的 Promise 拒绝，同时触发 `error` 事件。

### 导航、缩放与旋转

```ts
viewer.goToPage(3, { smooth: true }); // 页码 1-based；越界夹取到有效页
viewer.nextPage();
viewer.setScale(1.5);                 // 夹取到 0.1–25
viewer.setZoomMode('page-fit');       // auto/page-actual/page-fit/page-width
viewer.zoomIn();
viewer.setRotation(270);              // 规范为 0/90/180/270
viewer.rotateClockwise();
```

页面滚动、可见页范围和渲染队列由阅读器维护；调用方只需要设置目标页/缩放/旋转。

### 功能开关与展示

```ts
viewer.setFeatures({ print: false }, { display: 'disable' });
viewer.setFeatures({ print: true });
viewer.setFeatureDisplay({ export: 'disable' });
```

`features` 是补丁对象，未出现的键默认开启；非法键/值被忽略。共 20 个功能键：`toolbar`、`sidebar`、`thumbnails`、`outline`、`bookmarks`、`attachments`、`pageNavigation`、`pageNumberInput`、`zoom`、`rotate`、`fullscreen`、`textLayer`、`selection`、`find`、`print`、`export`、`signatures`、`verification`、`documentProperties`、`keyboardShortcuts`。关闭 `textLayer` 会级联关闭 `selection` 和 `find`，关闭 `sidebar` 会级联关闭 `thumbnails`/`outline`/`bookmarks`/`attachments`（“图层”不是功能键，由 `layerPanel` 控制，`sidebar` 关闭时同样不可用，见[图层显示控制](#图层显示控制layerpanel)）。受功能守卫的方法在功能禁用时抛 `OFD_FEATURE_DISABLED`，可用 `isFeatureDisabledError(error, 'print')` 判断；`closeSidebar()` 等清理方法不设守卫。

`attachments` 依赖 `sidebar`，另有两种由实现状态决定的关闭原因，宿主无法用 `features: true` 打开：引擎文档没有 `saveAttachment()`（旧引擎）时为 `unsupported`；引擎支持但 `getAttachments()` 为空或读取失败时为 `document`。两种情况下侧栏不渲染附件 tab，`openSidebar('attachments')` 抛 `OFD_FEATURE_DISABLED`。

`featureDisplay` 只决定被关闭功能的控件如何展示：`hide` 隐藏，`disable` 保留但禁用。`features: true` 不能绕过文档权限或引擎/环境限制；完整功能键、依赖与有效状态见 [API.md 功能开关](./API.md#功能开关)。

### 图层显示控制（layerPanel）

内置侧栏新增“图层”tab（顺序：缩略图/大纲/书签/签章/附件/**图层**）。面板是“全部页面”总项 + 每页一行；每页可展开 `签章 / 注释 / 自定义 / 前景 / 正文 / 背景` 六项，总项与页面行、六项复选框（不含注释类型）都支持跨页半选，右上角“恢复默认”把全部页恢复为 `defaultVisibility`（不重建树、保持展开状态与焦点；只有过滤签名变化的页重绘）。勾选变化直接进入渲染：只重绘签名变化的页，并同步文本层/查找/选区、缩略图、导出与打印。

```ts
// 默认隐藏每页背景（示例独立于下方“只隐藏水印”的构造示例）
new OFDViewer({
  container: '#viewer',
  source: file,
  layerPanel: {
    enabled: true,          // false 时不渲染“图层”tab，openSidebar('layers') 抛 OFD_FEATURE_DISABLED
    disabled: false,        // true 时保留 tab 但禁用交互并给出原因提示
    defaultVisibility: { background: false }, // 缺省六项全可见
  },
});

// viewer 的创建见上文；以下为该实例的方法
viewer.openSidebar('layers');                        // layers 不是功能键，只由 layerPanel 控制
viewer.getLayerVisibility(1);                        // 六项齐全的快照
viewer.setLayerVisibility(3, { background: true });  // 只改第 3 页；未给的键保留当前值
viewer.setLayerVisibility(3, { annotations: false }); // 关闭第 3 页注释总开关
viewer.resetLayerVisibility();                       // 全部页恢复 layerPanel.defaultVisibility
```

- `layerPanel` 只在构造时生效（与 `fonts`/`supersample` 一致），层状态**不做持久化**：重新 `open()`/`close()` 后回到 `defaultVisibility`。
- 关闭某项只影响该页该内容的绘制；四层（`custom`/`foreground`/`body`/`background`）按 `{ page, templates }` 映射到引擎 `PageContentFilter`，六项全可见时不传过滤（签名 `all`，默认态零额外成本）。
- `layerPanel.enabled=false` 时 tab 不出现；`disabled=true` 时 tab 仍可见但点击无效，`setLayerVisibility()`/`resetLayerVisibility()`/`openSidebar('layers')` 抛 `OFD_FEATURE_DISABLED`。
- 侧栏 tab（缩略图/大纲/书签/签章/附件/图层）都带内联图标；标题栏放不下全部“图标 + 文字”时**全部**切为仅图标，`title`/`aria-label` 保留完整名称，宽度恢复后自动切回（打开、拖拽/键盘调宽、切语言、断点与功能开关变化时立即重判；侧栏打开期间每 250 ms 兜底复核一次）。
- 面板交互：全部页面总项 + 每页一行，当前页自动展开；总项与六项在“跨页取值不一致”时半选，页面行自身表示“该页六项的页内混合”，注释类型只有开/关两态；半选点击=全选。“恢复默认”保持展开状态；树只有一个 Tab 停靠点，方向键/Home/End/Space 操作。

#### 注释类型

“注释”是复合项：一个总开关 + 可展开的类型列表。展开后列出**常见五类**（`Link`/`Path`/`Highlight`/`Stamp`/`Watermark`，顺序固定、按当前语言显示为链接/路径/高亮/印章/水印）以及**该页实际出现的其他类型**（显示引擎原值，如 `Note`、`Signature`，按名称字典序排列，区分大小写）。没有内容的类型也会列出，只是淡色显示，仍可正常勾选。

```ts
// 默认只隐藏水印注释（构造示例，替换上面的实例）
const withWatermarkHidden = new OFDViewer({
  container: '#viewer',
  source: file,
  // 等价于 { annotations: { enabled: true, types: { Watermark: false } } }
  layerPanel: { defaultVisibility: { annotations: { types: { Watermark: false } } } },
});

// 运行时只隐藏某一页的注释类型：types 与当前类型表按键合并，其余类型与总开关不动
viewer.setLayerVisibility(3, { annotations: { types: { Stamp: false } } });
// 再次取消该页的 Path
viewer.setLayerVisibility(3, { annotations: { types: { Path: false } } });
// 恢复该页的 Stamp（传 true = 从类型表里删掉该键，回到勾选）
viewer.setLayerVisibility(3, { annotations: { types: { Stamp: true } } });

// 读取：annotations 一定是 { enabled, types } 对象，types 只含被取消的类型
const v = viewer.getLayerVisibility(3);
v.annotations; // { enabled: true, types: { Path: false } }（只含被取消的类型）
```

规则要点：

- `annotations` 可写布尔或对象：`false` ≡ `{ enabled: false }`，`true`/省略 ≡ `{ enabled: true, types: {} }`；`types` 只记录**被取消**的类型，`{}` 就是全勾。
- **总开关关闭时类型勾选被记住**：`setLayerVisibility(3, { annotations: false })` 不会清空类型表，之后 `{ annotations: true }` 恢复原来的类型选择；面板里总开关关闭时类型行显示为未勾选，但不改存储。
- 半选粒度：注释类型复选框只出现在页面行，且只有开/关两态（永不半选）；“全部页面”总项不显示类型复选框，也不做跨页类型三态，批量写类型只能走 `setAnnotationTypeForAllPages()`。
- 引擎映射：总开关关闭**或该页列出的类型全部取消（零勾选）** → `annotations: false` 且不写 `annotationTypes`；总开关打开且类型全勾 → `annotations: true` 且不写 `annotationTypes`；只有部分取消时才写入白名单 `annotationTypes = 候选全集 ∪ 该页列出类型 中未被显式取消的类型`（探测不到的追加类型因此不会被误隐藏；候选全集 = 常见五类 + UI 内置探测候选）。
- 类型列表来自 UI 侧的惰性探测（引擎没有读取本页注释类型的公开接口）：展开时用候选白名单 + 注释文字试探；探测失败或注释没有外观文字时只列常见五类，不重试、不告警，也不改变可见性。类型补齐不会重绘页面。

### 查找与选中

```ts
await viewer.find('发票', { caseSensitive: false, wholeWord: false });
await viewer.findNext();
await viewer.findPrevious();
viewer.clearFind();
console.log(viewer.getSelectedText());
await viewer.copySelection();
```

查找默认从当前页开始、高亮全部匹配；空查询会清除查找。`find`/`findNext`/`findPrevious`/`clearFind` 需要 `find` 功能，选中与复制需要 `selection` 和 `textLayer`。完整选项与事件见 [API.md 查找、打印与导出](./API.md#查找打印与导出)。

**文字层按页构建**：滚动停止 150 ms 后为可见页建满整页 span，滚动中不构建首次访问页；页离开可见集合后由页级 LRU 按页数/span 预算保留或整页释放，不再按行裁剪。由此带来的行为边界：

- 未访问过的页在滚动到附近并停止 150 ms 后才可选中；已建页在缓存预算内可来回复用；
- 选区快照保存完整文本与每页矩形，中间页被淘汰后 `getSelectedText()` / 复制 / 高亮仍完整；端点页 pin 只保原生 Shift 扩选；
- 查找、跳转与高亮基于引擎逐页文本读取与页坐标定位，不依赖文字层 DOM；
- 缩放/旋转只改图层变换，不清空快照、不重算矩形；
- `textSpanBudget`、`selectionPinSpanBudget`、`textLayerMaxSpans` 分别控制滚动 span 预算、pin 预算与单页上限；
- 整本全选为非目标：Ctrl+A 只覆盖已构建页。

### 打印、图片与原 OFD 导出

```ts
await viewer.print({ pages: 'current', dpi: 'auto', includeBackground: false });
const result = await viewer.exportImage({
  page: 1,
  format: 'png',
  dpi: 300,
  background: null, // PNG 透明；JPEG/WebP 强制白底
});
await viewer.exportImages({
  pages: 'all',
  format: 'jpeg',
  quality: 0.92,
  zipFilename: '发票',
});
const original = await viewer.exportOfd({ filename: '发票原件' });
console.log(original.filename, original.size);
```

默认打印当前页、`dpi: 'auto'`、沿用当前旋转；默认导出当前页、PNG、`quality: 0.92`。`auto` DPI 按本次页数分档：≤50 页 200、51–200 页 150、>200 页 96；显式 DPI 须为 `(0, 600]`，结果四舍五入。多页导出生成 ZIP；单页失败会降级为 warning，全部失败抛 `OFD_EXPORT_FAILED`。打印调用浏览器打印对话框，不生成 PDF；图片导出不合并为 PDF。`exportOfd()` 导出阅读器打开时的原始 OFD 字节，不重新渲染；加密文档导出原始加密包；与图片导出共用 `export` 功能开关和文档权限。

### 附件与文档信息

附件由内置侧栏展示，宿主只需打开侧栏或读取信息快照：

```ts
viewer.openSidebar('attachments');   // 需要 sidebar 与 attachments 功能；文档无附件时不可用
const info = await viewer.getDocumentInfo();
console.log(info.attachments);       // AttachmentInfo[]，保持 XML 顺序
console.log(info.metadata.docType, info.metadata.packageInfo?.docRoot);
console.log(info.pageCount, info.signatureCount, info.outlineCount, info.bookmarkCount);
```

附件侧栏：

- 列表列：名称、格式 · 大小 · 日期（`modDate` 缺失回退 `creationDate`，两者都没有显示 `-`）、单个“下载”按钮；没有 `name` 的条目直接跳过。无附件时显示空状态。
- 单个下载：先经引擎 `saveAttachment()` 分块读完整份附件到内存，再生成 `Blob` 并触发浏览器下载；文件名优先用 `name`、其次 `id`，会过滤路径分隔符、控制字符与平台保留字符，无扩展名时按 `format` 补全。读取失败只在面板内提示并上报 `W_ATTACHMENT_RESOURCE`，不抛给宿主。
- 导出全部：把全部附件打包成 store 模式 ZIP（复用图片导出的 `createStoreZip`，fflate 按需动态导入，不引入新依赖），条目名为附件名、重名追加 `-2`/`-3`；超过阈值的附件与读取失败的条目会被跳过，完成后汇总“已导出 N 个附件，跳过 M 个”。
- 大附件阈值 `ATTACHMENT_LARGE_THRESHOLD_BYTES = 524288000`（**500 MB**）：按附件的**声明大小**判断，超过阈值时**不读取附件内容**，确认框提示“是否改为下载整个 OFD 原文件”——取消则什么都不读，确认后经 `readSourceBytes()` 下载整个 OFD（沿用 `export` 功能与文档导出权限门控）。未声明 `size` 的附件不参与阈值判断，走普通下载。
- 安全约束：附件内容一律不进入 DOM（不用 `innerHTML`/`srcdoc`），未知格式只提供下载、不提供预览。

`getDocumentInfo()` 返回 `ViewerDocumentInfo`：`metadata`（引擎完整元数据，含 `docType`/`documentHeader`/`packageInfo`/`commonData`）、`pageCount`、`pageInfos`、`permissions`、`attachments`、`signatureCount`、`outlineCount`、`bookmarkCount`，以及可选的 `origin`。

- **按需调用**：结果不写入 `ViewerState.document`，不会触发状态订阅者重渲染；宿主需要多次使用时应自行缓存返回值，而不是每次渲染都调用。
- **一次性聚合**：内部并发读取元数据、权限、附件、签章、大纲与书签，全部命中引擎缓存。
- **未打开抛 `OFD_NOT_OPENED`**：不返回空壳（与 `getPermissions()` 未打开时返回宽松默认值不同）；销毁后抛 `OFD_DESTROYED`。
- 属性对话框（`documentProperties` 功能）按六个分组展示：文档属性、包信息、页面设置、颜色与资源、安全与结构、附件清单；某分组内全部字段缺失时整组隐藏。

### 加密文档与签名验证

```ts
const viewer = new OFDViewer({
  container: '#viewer',
  source: encryptedFile,
  crypto: {
    enabled: true,
    credentials: [{ kind: 'password', userName: 'alice', password: '***' }],
  },
});

await viewer.ready;
const report = await viewer.verify();
console.log(report.overall);
```

- 预置 `credentials` 时不弹内置登录框；未预置时由 `autoPrompt`/`onCredentialRequired` 决定弹窗或拒绝。
- `crypto.enabled=false` 时只保证明文文档阅读：加密文档以 `OFD_CRYPTO_UNSUPPORTED` 拒绝；`verification` 功能为 unsupported，`verify()`/`openVerificationPanel()` 以 `OFD_FEATURE_DISABLED`（`feature='verification'`）拒绝，不把密文当明文渲染。
- `report.overall` 只汇总签名数学、dataHash、Reference、防夹带完整性和印章结构/数学；证书链在详情中独立成栏，不可信/过期/未知不改变总体结论。签章者旁按链状态显示“可信/可信状态未知”，签发时间与证书下载来自 crypto 报告/详情。页面印章浮层的“查看签章详情”与侧栏签章项打开同一个详情面板。
- 完整 crypto 选项、凭据/根证书形态、自动验证、报告字段与取消语义见 [API.md 验证行为与错误](./API.md#验证行为与错误)。

## 已知边界

- **纯 SPA**：不承诺 SSR/水合；不提供局部/瓦片渲染。
- **网络在 UI 层**：URL 由 `HttpByteSource` 读取（Range + 整包回退），跨域需要 CORS 与 `Content-Range` 暴露头；鉴权头由宿主提供。
- **字体在 UI 层读取**：引擎不读取字体 URL/路径，UI 层可用 `fonts.default`/`fonts.supplementary` 的 `{ url }` 直接配置，读取由 UI 完成；只接受完整字体文件，不接受 CSS 切片，读取失败只产生 `W_FONT_MISSING` warning。设计见 [字体配置方案设计](../../../docs/字体配置方案设计.md)。
- **本机字体仅 Chromium 桌面端**：`queryLocalFonts` 自 Chrome 103 起可用，Firefox / Safari / 移动端 / 旧版 Chromium / 站点被 `Permissions-Policy: local-fonts` 禁用时整个能力不可见，行为与引入该功能前一致，不做 polyfill。默认关闭且需宿主 `fonts.localFonts.enabled` + 用户授权双重开启（授权入口：文档打开后的确认框，或「关于」对话框里的开关）；关闭开关或授权失败时立即回退到原有字体来源。
- **本机字体授权必须由点击触发**：无用户手势调用 `queryLocalFonts` 必然 `SecurityError`，因此确认框的「允许」在 click 回调内同步发起申请；`permission: 'denied'` 与「字体未安装」在 API 层返回值相同，阅读器用 `navigator.permissions.query({ name: 'local-fonts' })` 区分。
- **本机字体不做全量枚举、不做字体选择器**：只按文档声明的字体名定向查询（无内嵌 `fontFile` 的声明，按 `maxFonts` 截断）；中文名不能直接用于查询，需经内置常见字体表与别名表展开为 PostScript 名（匹配区分大小写）。
- **本机字体不做合成加粗**：粗体请求按 `<base>-Bold` → `<base>Bold` → `<base>` 回退，`SimHei-Bold` 这类不存在的变体会落到常规字形，观感上是「粗体请求用了常规字形」。
- **本机字体重开代价**：开启/关闭开关会重开当前文档（恢复页码/缩放/旋转），大文档有短暂加载；不做字体热替换。
- **`local-fonts:change` 三端均可接收**：核心 `viewer.on('local-fonts:change', …)`；Web Component 派发 `ofd-local-fonts-change` 并转发 `getLocalFontsStatus`/`setLocalFontsEnabled`/`onLocalFontsStatusChange`；React 为 `onLocalFontsChange` 回调与命令句柄同名方法；Vue 为 `@local-fonts-change` 与 expose 同名方法。启用本机字体仍需在用户点击事件的同步栈内调用 `setLocalFontsEnabled(true)`，在挂载回调或定时器中调用不会弹出授权框。
- **页级字体声明不参与本机字体匹配**：只处理 `DocumentRes`/`PublicRes` 中的文档级字体声明，`PageRes.xml` 里声明的字体不进入查询清单。
- **控制台诊断默认开启**：缺字体 `W_FONT_MISSING`、缺字 `W_GLYPH_MISSING`、`W_CANVAS_LIMIT` 等 warning 与错误会以 `[ofd-viewer] warning <code>` / `[ofd-viewer] error <code>` 前缀打印到浏览器控制台，附 `{ pageIndex, resourceId }` 上下文；同一 `code` + `pageIndex` + `resourceId` 在一个文档会话内只打印一次，`open()` 时重置。`onWarning`/`onError` 语义不变；`debug: { console: false }` 可整体关闭，`debug.levels`/`debug.codes` 可只保留指定级别或码（过滤先于去重）。UI 自有码表导出为 `UI_WARNING_CODES`（错误码前缀为 `OFD_*`）。见 [API.md 诊断与日志](./API.md#诊断与日志)。
- **URI 参数预览只读查询串**：`?file=` 仅接受 `http(s)`；`?base64=` 默认上限 64 MiB，且会进入历史/日志/Referer，敏感文档不应使用。
- **打印/导出范围**：打印调用浏览器对话框，不生成 PDF；图片导出不合并为 PDF；原 OFD 导出是字节拷贝，不重新打包或修正文档。
- **加密边界**：`crypto.enabled=false` 时加密文档直接拒绝；吊销状态不检查，固定为未检查；时间戳只解析、不验证，不参与整体结论。
- **跳转目标**：`goToDestination` 尚未暴露；可读 `getPageInfos()` 后用 `goToPage(pageIndex + 1)` 跳转，页内坐标由调用方处理。
- **性能**：未对数千页大文档、超大文件或低端设备做硬性性能承诺；首屏与全篇查找耗时随页数增长，宿主应自行压测。文字层 DOM 规模受页级 LRU 的页数/span 预算约束，不随总页数无限增长；超大单页受 `textLayerMaxSpans` 兜底。
- **缩略图缓存**：`thumbnailCacheSize` 当前仅被解析，尚未接入缩略图缓存实现，实际缓存数量固定；需要严格控制内存时不要依赖该选项。
- **附件**：附件列表只在 `attachments` 功能开启、引擎具备 `saveAttachment()` 且文档确有附件时出现；无附件时不渲染 tab。超过 500 MB（按声明大小）的附件不读取内容，只能改为下载整个 OFD 原文件；“导出全部”会跳过超阈值与读取失败的条目并汇总提示，不静默丢弃，但也不会部分重试。
- **附件内容不渲染**：附件只做下载，不预览、不插入 DOM、不执行；未知格式没有内置查看器。
- **附件读取不是流式**：引擎先整块读入内存再分块回调，UI 也会先把附件拼成完整 `Blob` 再下载；下载超大附件会占用等量内存，受引擎单附件上限（`maxAttachmentBytes`，未配置回退 `maxEntryBytes` 默认 64 MiB）约束。
- **大附件阈值不可配置**：`524288000` 是源码常量，没有 `options` 入口；需要不同阈值时只能改用引擎接口自行实现下载。
- **`<ofd-viewer sidebar="attachments">` 已支持**：适配层与核心共用 `SIDEBAR_VIEWS` 清单，`attachments` 可直接写在属性上；未知取值仍被忽略。
- **图层不做对象级可见性**：只能按页控制六项内容层与注释类型，不能按 `annotationId` 单独隐藏某个注释或对象。
- **图层状态不持久化**：每页可见性与注释类型勾选只存在于当前文档会话，不写 `localStorage`/`sessionStorage`/URL hash；重新 `open()`/`close()` 回到 `layerPanel.defaultVisibility`。需要跨会话记忆时由宿主自行保存并用 `getLayerVisibility()`/`setLayerVisibility()` 恢复。
- **签章不拆分类型**：`signatures` 始终是一个布尔开关；`Stamp` 属于**注释类型**，与签章开关互不影响。
- **注释类型列表不可由宿主自定义**：没有 `layerPanel.annotationTypes` 选项。常见五类固定为 `Link`/`Path`/`Highlight`/`Stamp`/`Watermark`，其余类型来自“该页实际出现的注释”并且只在展开该页类型组时惰性探测；探测失败（无外观文字、页不支持读取文本、打开被取消）时只列常见五类，不报错、不告警。Web Component 的 `layer-panel` 属性只能表达 `enabled`/`disabled` 与六项布尔，注释类型需用核心选项或 `setLayerVisibility()`。
- **侧栏 tab 溢出切仅图标**：标题栏放不下全部“图标 + 文字”时全部 tab 切为仅图标（`title`/`aria-label` 保留完整名称），宽度恢复后自动切回（触发点同上）；不会隐藏或收纳个别 tab。

## 新增或修改 UI API 时的同步清单

核心选项、方法、事件、类型发生变化时，四个入口必须一起走完；漏掉 element 层是最常见的疏漏，
因为它维护了一张硬编码的属性白名单，没有列进去的属性等同于不存在。

| 入口 | 需要同步的位置 |
| --- | --- |
| 核心 `@ofdrw/ofdrw-viewer-ui` | `src/options.ts`（选项与默认值）→ `src/viewer.ts`（实现）→ `src/index.ts`（类型导出） |
| React `./react` | props 自动透传，通常无需改动；**新增类型需在 `src/react/index.ts` 再导出** |
| Vue `./vue` | 同 React，类型再导出在 `src/vue/index.ts` |
| Web Component `./element` | `OBSERVED_ATTRIBUTES` 加入属性名 → `ensureViewer()` 读取并传入构造选项 → `attributeChangedCallback` 处理变更（运行时生效则调用核心方法，仅构造时生效则重建）→ `src/component/support.ts` 增加解析函数 |
| 文档 | `skills/API.md` 的构造选项表与 Web Component 属性表、`skills/SKILL.md` 相关章节 |

`layerPanel` 这类**构造时生效**的配置同样要在 Web Component 加入 `layer-panel` 属性并走销毁重建；新增侧栏视图时注意 `layers` 由 `layerPanel` 门控而不是 `ViewerFeature`。

判断「能否运行时修改」再决定 element 的处理方式：能运行时生效的走 setter（如 `scale`、`theme`）；
只能构造时生效的（如 `fonts`、`supersample`）走销毁重建，并在文档里写清会重新打开文档。

## 参考

- [API.md](./API.md)：完整构造选项、功能开关、事件、方法、类型与适配器参考。
- [渲染引擎 SKILL](../../ofdrw-viewer-engine/skills/SKILL.md)：页面渲染、文本层、字体与引擎类型。
- [密码能力 API](../../ofdrw-viewer-crypto/skills/API.md)：解密、验签、证书链与报告细节。
- [手势缩放性能设计](../../../docs/手势缩放性能设计.md)：缩放锚点、重绘时机、超采样分档与高倍率画布预算。
- [页面缓存与文本层生命周期设计](../../../docs/页面缓存与文本层生命周期设计.md)：页级构建、LRU/预算、选区快照与端点 pin。
