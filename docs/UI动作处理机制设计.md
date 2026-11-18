# UI 动作处理机制设计

本文是 `@ofdrw/ofdrw-viewer-ui` 侧 **OFD 动作（Action）执行机制**的设计方案，覆盖触发、命中、执行、状态与生命周期全链路。**本文只做设计，不描述实现进度**。

配套文档：

- 动作与音视频的**标准依据、engine 数据结构、解析规则**见 [音视频与动作方案设计](./音视频与动作方案设计.md)（下称"主文档"）。本文不重复其类型定义与 XML 规则。
- UI 与 engine 的通用边界见 [ofdrw-viewer-ui-engine-api](./ofdrw-viewer-ui-engine-api.md)。
- 跨包契约见 [CONTRACTS](./CONTRACTS.md)。

---

## 1. 定位与范围

### 1.1 本文解决的问题

engine 能解析出动作（`ActionInfo`），但"**什么时候执行、点击了哪个动作、执行成什么样、出错怎么办**"全部属于 UI。当前 UI 对动作的处理是**碎片化的**：

| 现状 | 问题 |
| --- | --- |
| 大纲/书签跳转在 `views/outline.ts`、`views/bookmarks.ts` 各写一份 | `Goto` 只能从导航面板触发 |
| 图元上的 `CLICK` + `Goto` **完全不生效** | 最常见的"点击跳转"不可用 |
| `URI`/`GotoA`/`Sound`/`Movie` 无任何执行方 | 四类动作不可用 |

**本文的目标**：建立**唯一的动作执行入口**，让五种动作、三种事件、四种宿主都走同一条路径。

### 1.2 范围

- 动作的**收集与索引**（按文档/页缓存）
- 动作的**触发**（DO / PO / CLICK）
- **命中测试**（页面坐标 → 动作）
- **执行语义**（顺序、同步阻塞、循环防护、错误隔离）
- 五种动作的 **handler 分发**
- 状态快照、事件、生命周期与清理

### 1.3 非目标

- 不解析 XML、不实现 `Dest` 几何换算（归 engine）。
- 不实现音视频解码（浏览器原生）。
- 不实现动作编辑与写回。
- 不实现"演示放映模式"（自动翻页 + 自动执行），`DO`/`PO` 只做一次性自动执行。

---

## 2. 设计原则

| 原则 | 说明 |
| --- | --- |
| **单一入口** | 所有动作执行必经 `ActionService.execute()`，任何模块（大纲、书签、图元、宿主 API）不得自行执行动作 |
| **复用优先** | `Goto` 复用 `goToDestination()`，`GotoA` 复用附件下载，不写第二套 |
| **执行与解析分离** | engine 给 `ActionInfo`（毫米声明），UI 负责像素命中与执行 |
| **默认保守** | 自动执行（DO/PO）默认关闭；`URI` 默认协议白名单 |
| **失败隔离** | 单个动作失败不影响页面渲染、不影响后续动作、不打断阅读 |
| **可观测** | 每次执行/跳过/失败都有 `ViewerEvent`，宿主可埋点 |

---

## 3. 架构

### 3.1 模块结构

```
src/actions/
├── index.ts                  扩展注册入口（registerViewerExtension）
├── action-service.ts         ActionService：收集、缓存、分发、生命周期
├── action-executor.ts        ActionExecutor：顺序执行、同步阻塞、循环防护
├── pointer-router.ts         PointerRouter：pointer 事件 → 命中动作
├── click-table.ts            ClickTable：按页命中表（bbox + 动作 + 绘制序）
├── geometry.ts               engine 几何 → 命中用像素矩形（不自行换算 DPI）
└── handlers/
    ├── index.ts              五种 handler 的注册位
    ├── goto.ts               Goto（Dest / Bookmark）
    ├── uri.ts                URI
    ├── goto-attachment.ts    GotoA
    ├── sound.ts              Sound
    ├── movie.ts              Movie
    ├── media-player.ts       播放器实例表（按 resourceId 复用）+ ObjectURL 释放
    └── media-presenter.ts    呈现层（内联 / 弹出浮层 / 下载降级）
```

### 3.2 接入方式：复用现有扩展机制

UI 已有成熟的扩展点，**不引入新框架**：

```ts
// src/actions/index.ts
registerViewerExtension((viewer) => viewer.attachActionService(new ActionService(viewer)));
```

配套改动（沿用文本层、签章的既有做法）：

| 改动点 | 内容 |
| --- | --- |
| `viewer.ts` 的 `ViewerServices` 接口 | 新增 `actions?: ViewerActionService` |
| `viewer.ts` | 新增 `attachActionService()`（照 `attachExportService` 写法） |
| `src/index.ts` | 增加 `import './actions/index';` 副作用导入 |
| `features.ts` 的 `VIEWER_FEATURES` | 新增 `'actions'`；同步 `FEATURE_DEPENDENCIES` 与 `i18n` 的 `FEATURE_LABEL_KEYS`（漏键会 typecheck 失败） |

### 3.3 数据流

```
                    ┌──────────── engine 公共 API ────────────┐
                    │ getDocumentActions()                     │
                    │ getPageActionsByEvent(page, event)       │
                    │ getPageActionGeometries(page,{dpi:96})   │
                    └────────────────┬─────────────────────────┘
                                     │ ActionInfo + 批量像素几何（ActionGeometryEntry[]）
                                     ▼
   ┌────────────────────────── ActionService ──────────────────────────┐
   │  文档级动作缓存（DO）                                               │
   │  按页动作缓存（PO / CLICK）+ 页淘汰联动                             │
   └───────┬──────────────────────┬──────────────────────┬─────────────┘
           │ DO                   │ PO                   │ CLICK
           ▼                      ▼                      ▼
   documentopen 后一次      页面首次可见且渲染完成      PointerRouter
                                                          │ 命中
                                                          ▼
                                              ┌──── ActionExecutor ────┐
                                              │ 顺序 / Synchronous     │
                                              │ 循环防护 / 错误隔离    │
                                              └───────────┬────────────┘
                                                          ▼
                    goto | uri | gotoa | sound | movie（handlers）
                                                          │
                                                          ▼
                                     ViewerEvent + ViewerState 快照
```

---

## 4. 动作收集与缓存

### 4.1 缓存策略

| 数据 | 来源 | 缓存位置 | 失效 |
| --- | --- | --- | --- |
| 文档级动作 | `getDocumentActions()`（同步，open 阶段已解析） | `ActionService` 实例字段 | 文档关闭 |
| 页级 + 图元动作 | `getPageActionsByEvent(page, event)`（异步） | `Map<pageIndex, PageActionSet>` | 页被 `trimCache()` 淘汰 / 文档关闭 |
| 命中表 | 由页级 CLICK 动作构建 | 同上，随页动作一起淘汰 | 同上 |

### 4.2 页级加载

```ts
/** 单页的动作集合。 */
interface PageActionSet {
  /** PO 动作，页面首次可见时执行一次。 */
  pageOpen: readonly ActionInfo[];
  /** CLICK 动作 + 已计算的 96 DPI 像素几何，供命中表使用。 */
  click: ReadonlyArray<{ action: ActionInfo; bbox: PixelBox; corners?: readonly PixelPoint[] }>;
  /** 是否已执行过 PO（保证每页一次）。 */
  pageOpenDone: boolean;
}
```

**加载时机**：两条路径并存，互不阻塞首屏绘制。

| 触发 | 用途 |
| --- | --- |
| 文档打开后预加载当前可见页 | 保证首屏点击立即可用 |
| 页面**首次渲染完成**（`completeRender`） | 补加载渲染进度领先于预加载的页；判断是否执行 `PO` |
| 命中测试 / 宿主 API 缺缓存时按需加载 | 兜底：`hitTestAt()` 首次命中失败、`executeActions()` 调用时补齐 |

**点击可用性不依赖渲染完成**：页动作集合只在渲染完成后才加载会让「渲染未结束时点击图元」被静默丢弃，因此打开文档即预加载可见页；尚未加载完成时的首次点击不命中原图元，加载完成后下一次点击即正常。加载失败只上报 warning 并置空，不重试、不阻断。

### 4.3 与页缓存联动（必须做，否则内存与播放泄漏）

沿用文本层 `releasePage()` 与签章 `releaseOverlays` 的既有位置：

| 时机 | 处理 |
| --- | --- |
| 页被 `trimCache()` 淘汰 | 删除该页 `PageActionSet`；**中止该页进行中的执行**（见下）；**暂停并销毁该页所有播放器**；`revokeObjectURL` |
| 文档关闭 | 清空全部缓存，中止整篇执行，销毁全部播放器 |

**取消粒度按页**：每页持有独立的 `AbortController`，页淘汰时只中止该页尚未完成的动作执行与待加载任务，不影响其他页与文档级（DO）执行；文档关闭时统一中止全部页与文档级执行。中止记为 `'cancelled'`，队列中尚未开始的动作直接丢弃、不派发结果事件。

**PO 的「每页一次」跨淘汰持久**：`PageActionSet` 随页缓存淘汰销毁，因此页内的 `pageOpenDone` 只表达「本次缓存有效期内已处理」；服务层另用 `pageOpenDonePages` 集合按页索引记录 PO 已处理，该集合按文档会话保存、不随页淘汰清除。翻页后重新进入同一页不会重放 PO。

> 漏掉这一步的后果是：翻页后音频继续在后台播放。

---

## 5. 触发机制

### 5.1 三种事件总表

| 事件 | 触发点 | 动作来源 | 执行次数 | 受开关控制 |
| --- | --- | --- | --- | --- |
| **DO** | `documentopen` 之后 | `getDocumentActions()` 过滤 `event === 'DO'` | 全文档 **1 次** | `autoExecuteActions` |
| **PO** | 页面首次进入可视区 **且** 渲染完成 | `PageActionSet.pageOpen` | 每页 **1 次**（页内 `pageOpenDone` + 服务层 `pageOpenDonePages` 跨淘汰保证，见 §4.3） | `autoExecuteActions` |
| **CLICK** | 页面 `pointerup` | `PageActionSet.click` | 每次点击 | 总是执行 |

### 5.2 自动执行开关

```ts
interface ViewerOptions {
  actions?: {
    /** 由宿主预设的初始值；用户可通过「关于」对话框覆盖。默认 false。 */
    autoExecuteActions?: boolean;
    /** 是否允许用户通过界面修改该开关。默认 true。 */
    allowUserToggleAutoExecute?: boolean;
    /** 最大嵌套动作深度。默认 4。 */
    maxActionDepth?: number;
    /** Goto 跳转是否平滑滚动。默认 true。 */
    smoothGoto?: boolean;
  };
}
```

**开关位置：「更多」→「关于」对话框**，沿用本机字体（`localFonts.set`）已验证的既有做法：

| 项 | 方案 |
| --- | --- |
| 位置 | 工具栏「更多」→「关于」对话框，新增一行"自动执行文档动作"开关 |
| 复用 | `UIShellCommand` 新增 `{ type: 'actions.setAutoExecute'; value: boolean }`，与 `localFonts.set` 同形 |
| 状态回传 | `UIShellViewState` 新增可选 `actions?: { autoExecute: boolean; allowUserToggle?: boolean }`，由 `OFDViewer` 推送到外壳，与 `localFonts` 同构 |
| 持久化 | **不持久化**（与会话一致，刷新后回到宿主预设值；避免用户忘记曾开启而出现意外弹窗） |
| 宿主开关 | `actions.autoExecuteActions` 提供初始值；`allowUserToggleAutoExecute: false` 可禁止用户改动（如受限展示场景） |
| 禁止改动时的表现 | `allowUserToggle` 为 `false`：开关渲染为**禁用态**、点击无效；「关于」里该行给出说明文案，不隐藏该行（与"能力不存在"区分） |

`autoExecuteActions` **与音视频自动播放共用同一开关**（不设 `media.autoPlayMedia`），避免两个开关互相干扰。

**默认 false 的理由**：

1. 浏览器禁止无用户手势的有声自动播放；
2. 自动弹窗/自动跳转打断阅读；
3. 现有用户阅读体验不变——需用户在「关于」里显式开启。

**关闭时的上报**：`autoExecuteActions = false` 时 DO/PO 动作一律不执行，同时派发 `action:skipped`（`reason: 'autoplay-disabled'`），并计入 `ViewerState.actions.pendingAutoActions`；宿主可据此提示用户（例如在含自动播放的文档上显示一次性提示"此文档包含 3 个自动动作，可在「更多 → 关于」中开启"）。

上报粒度按触发点分两级，**每批只派发一条**（载荷不带逐条动作明细，`type` 取该批首个动作）：

| 触发点 | 派发粒度 | 载荷 |
| --- | --- | --- |
| DO（文档级） | **按文档聚合**：文档打开时若有 DO 动作且开关关闭，派发一次；重复发现不重复派发 | `{ type, reason: 'autoplay-disabled' }`，**不带** `pageIndex` |
| PO（页级） | **按页聚合**：某页 PO 首次被判定（进入可见区）且开关关闭时派发一次；同页再次进入可见区不再派发 | `{ type, reason: 'autoplay-disabled', pageIndex }` |

两批互不重复：DO 只在文档打开时判定一次，PO 每页只在首次可见时判定一次。`ViewerState.actions.pendingAutoActions` 统计的是被跳过动作的**总条数**（不是事件条数）——每页/文档最多 1 条事件，但事件代表该批全部动作。

用户在「关于」里把开关打开后，此前被跳过的 DO/PO **补执行**（`runPendingAutoActions`）：先清空待执行计数，再重跑文档级与当前可见页的 PO，按正常执行路径派发 `action:executed` 等事件。

`features.actions = false` 时不执行、也不派发 `action:skipped`（功能关闭属于宿主主动禁用，不当成"待执行"提示）。

### 5.3 PO 触发条件

```
页面渲染完成（completeRender）
        │
        ├─ 已执行过 → 跳过
        ├─ autoExecuteActions = false → 记录并跳过
        └─ 页面与视口相交（IntersectionObserver 或现有可见页计算）
                │
                └─ 是 → 执行 pageOpen 动作 → pageOpenDone = true
```

复用现有可见页判定（`viewer.ts` 的 `visiblePageRange`），不新建观察器。

---

## 6. CLICK 命中机制

### 6.1 事件流

```
pointerdown ──→ 记录起点（clientX/Y）
                      │
pointerup  ──→ 位移 > DRAG_THRESHOLD(4px) ? ──是──→ 拖拽/选择，不触发
                      │
                      ├─否──→ 存在活动文本选区？ ──是──→ 不触发
                      │
                      └─否──→ 命中测试 → 执行
```

**为什么用 `pointerup` 而非 `click`**：需要区分"拖拽/选择"与"点击"；`click` 在拖拽后也可能触发，且无法拿到起点。

### 6.2 与既有交互的让位规则

页面已有文本选择、双击缩放、签章点击。动作点击必须让位：

| 冲突方 | 处理 |
| --- | --- |
| **文本选择** | 有活动选区时不触发；否则 `pointerup` 先于选择完成的时序需用"选区非空"判定 |
| **双击缩放** | 双击事件会先派发两次 `pointerup` —— 命中动作时不触发双击缩放（在 `handleDblClick`/`handleTap` 前置判断） |
| **签章框** | 签章是 `<button>`，DOM 命中优先，`pointerup` 目标是签章时直接跳过 |
| **媒体元素** | 目标是 `<video>`/`<audio>` 时跳过（播放器自身控件优先） |

### 6.3 必须修改的既有代码

| 位置 | 现状 | 改法 |
| --- | --- | --- |
| `viewer.ts` 双击缩放防误触选择器 | `target.closest('a,button,input,select,textarea,[contenteditable="true"]')` | 追加 `video,audio,[data-ofd-media]`，否则双击视频会触发页面缩放 |

### 6.4 坐标换算

```
clientX/Y
   → getContentPointAtViewport(x, y)    ← 核心新增，纯读取，返回页面像素点
   → { pageIndex, xPx, yPx }            ← 已扣除页盒偏移、减去滚动、除以缩放倍率
   → 与该页命中表的 bbox 求交
```

**使用核心的 `getContentPointAtViewport(clientX, clientY)`**（`viewer.ts`），它是本设计要求的**纯读取**坐标入口：

```ts
/** 视口坐标 → 页面像素坐标；坐标不落在任何页面上时返回 undefined。 */
getContentPointAtViewport(
  clientX: number,
  clientY: number,
): { pageIndex: number; xPx: number; yPx: number } | undefined;
```

**不等于**内部的 `contentPointAtViewport()`：后者在换算的同时会记录缩放锚点等内部状态，点击命中这类只读判定不能用它改写状态。两者共用同一坐标链，`getContentPointAtViewport()` 只去掉了写入部分。

**坐标换算语义**（必须与文本层、engine 几何一致）：

1. 先在主滚动容器坐标系中扣除视口左边距、主区域滚动与内容偏移；
2. 由布局求出所在页 `pageIndex`（0-based）与页内偏移；
3. 页内偏移是布局倍率下的 CSS px，除以当前有效缩放倍率后得到 **96 DPI 页面像素**；
4. 输出原点是页面左上角、y 向下。

页面旋转由 `surface` 的 CSS transform 承担，坐标**不需要**重算：命中的 bbox 是未旋转的页面像素，`getContentPointAtViewport()` 返回的也是逆变换后的页面坐标。

### 6.5 命中表

```ts
/** 单页的 CLICK 命中表。 */
interface ClickHitTable {
  /** 命中项，已按 `paintOrder` 降序（层叠靠上的在前）。 */
  readonly items: readonly ClickHitItem[];
}

/** 单个可点击动作的命中项。 */
interface ClickHitItem {
  readonly action: ActionInfo;
  /** 外接矩形，96 DPI 页面像素。 */
  readonly bbox: ActionBox;
  /** 绘制序权重，越大越靠上；同一宿主的全部 CLICK 动作共享同一权重。 */
  readonly paintOrder: number;
}

function hitTestTable(
  table: ClickHitTable | undefined,
  point: ActionPoint,
): readonly ActionInfo[] | undefined;
```

**命中表的构建**：一次调用 engine 的批量入口 `getPageActionGeometries(pageIndex, { dpi: 96 })` 取齐该页全部可定位动作及其像素几何，只保留 `event === 'CLICK'` 且宽高均大于 0 的项。几何**全部来自 engine**，UI 不做毫米 → 像素换算（第二份换算会与 `getPageTransform` 的口径漂移，只在特定页面/倍率下暴露）。

**坐标反变换的 z 序取法**：engine 返回顺序是"页级动作在前、其后图元按绘制序"，下标越大越靠上。命中表按 `paintOrder` 降序保存，扫描即反向遍历，取第一个命中的宿主分组，与该宿主上所有 CLICK 动作一起执行（同一图元的多个动作必须一起命中，避免"点同一个框只触发一半"）。

页内动作数通常 < 20，**线性扫描足够**，不引入空间索引（如四叉树），避免过度设计。

### 6.6 命中口径：只做外接矩形粗判

命中判定**只使用 `ActionGeometry.bbox` 外接矩形**，矩形四边含边界判定。

- `Action/Region` 的折线路径**不参与**命中判定（设计 §14 决策 6）：不做 even-odd 奇偶规则精判，也不做贝塞尔曲线离散化。环形、凹形、带挖空的区域，其外接矩形内部一律视为触发区。
- 这样处理的直接好处是**判定口径统一**：同一宿主上的多个 CLICK 动作共享同一个外接矩形，不会出现"一个动作命中、同宿主的另一个不命中"的不一致。
- engine 仍会解析并上报 `Region`（`W_ACTION_REGION` 覆盖路径非法的情况），只是 UI 不回读折线。需要更精确命中的宿主应在 engine 侧扩展几何 API，而不是在 UI 侧另写一份路径判定。

> 取舍记录：本设计早期版本要求在 bbox 粗判后用 `isPointInActionRegion()` 做精确判定，这与 §14 决策 6"外接矩形粗判即可"冲突。以决策 6 为准——OFD 动作区域绝大多数是矩形，精确判定的收益远小于"两套判定口径不一致"带来的缺陷风险。

---

## 7. 执行语义

### 7.1 执行器接口

```ts
/** 动作执行结果。 */
export type ActionOutcome = 'executed' | 'skipped' | 'cancelled' | 'failed';

/** 动作执行上下文。 */
export interface ActionExecutionContext {
  /** 触发来源，决定呈现模式。 */
  trigger: 'DO' | 'PO' | 'CLICK' | 'HOST';
  /** 触发页索引（DO 时为 0）。 */
  pageIndex: number;
  /** 触发图元锚点（用于弹出式窗口定位与高亮）。 */
  anchor?: { objectId?: string; bbox: PixelBox };
  /** 取消信号。 */
  signal?: AbortSignal;
}

/** 执行一组动作。 */
execute(actions: readonly ActionInfo[], context: ActionExecutionContext): Promise<readonly ActionOutcome[]>;
```

### 7.2 规则表

| 规则 | 实现 |
| --- | --- |
| **顺序执行** | 按 `ActionInfo[]` 顺序依次 `await` |
| **`Synchronous` 阻塞** | `sound.synchronous === true` 时等待 `ended` 后才继续；`repeat === true` 时该字段无效（标准显式规定） |
| **`Movie` 不阻塞** | 标准无 `Synchronous` 属性，立即返回 |
| **实例复用** | 同一 `resourceId` 的播放器**按资源 ID 建实例表**；否则 `Pause`/`Resume` 无法成立 |
| **`Movie@Operator`** | `Play` 播放；`Stop` 停止并复位销毁；`Pause` 暂停保留位置；`Resume` 从暂停处继续 |
| **循环防护** | 嵌套深度达到 `maxActionDepth`（默认 4）即整组不执行，并逐个上报 `action:error`（`code: 'OFD_ACTION_LOOP'`，`reason: 'loop'`） |
| **错误隔离** | 单个动作失败记 `'failed'`，继续执行后续动作 |
| **取消** | 取消信号细分到页：每页独立 `AbortController`，页淘汰时只中止该页；文档关闭/组件销毁中止全部。中止记 `'cancelled'`，排队中的动作直接丢弃、不派发事件、不调用 handler |

### 7.3 循环防护详解

`Goto` 跳到自身页会重新触发该页 `PO`，形成死循环：

```
点击 Goto(本页) → 触发 PO → 又执行 Goto(本页) → ...
```

防护两道：

1. **深度限制**：动作执行嵌套深度达到 `maxActionDepth` 即停止；
2. **PO 去重**：同页 `PO` 每页只处理一次（页内 `pageOpenDone` + 服务层 `pageOpenDonePages` 跨页淘汰持久，见 §4.3），因此 `Goto` 回本页不会再触发 `PO`。

第二道已能阻断绝大多数循环；第一道作为兜底。

---

## 8. Handler 设计

### 8.1 五种动作的执行映射

| 动作 | 执行方式 | 复用情况 |
| --- | --- | --- |
| **Goto（Dest）** | `goToDestination(viewer, dest)` | ✅ 复用 `views/shared.ts` 现有实现 |
| **Goto（Bookmark）** | 查书签名 → 找对应 `dest` → 同上 | ✅ 复用 |
| **URI** | 协议白名单校验 → `window.open(uri, target)` | 新增 |
| **GotoA** | 查附件 → 走现有附件下载/打开流程 | ✅ 复用 `views/attachments.ts` |
| **Sound** | 建立/复用 `<audio>` → 设 `volume` → `play()` | 新增（音视频方案） |
| **Movie** | 建立/复用 `<video>` → 内联或弹出 → 按 `Operator` 控制 | 新增（音视频方案） |

**3 个 handler 可直接复用现有实现**，是这套机制的主要收益。

### 8.2 Goto

```ts
// 复用现有实现，不重写
import { goToDestination } from '../views/shared';

async function handleGoto(ctx, payload: GotoActionPayload): Promise<ActionOutcome> {
  const dest = payload.dest ?? resolveBookmark(payload.bookmarkName);
  if (!dest) return 'skipped';
  goToDestination(viewer, dest);
  return 'executed';
}
```

- 书签名 → `Dest` 的解析：使用 engine 已解析的 `getBookmarks()` 结果建名称索引；
- 平滑滚动：沿用 `goToDestination` 现有的 `{ smooth: true }`，不新增行为；
- 目标页越界/无效：engine 已用 `W_ACTION_TARGET` 上报且 `dest` 缺省，此处返回 `'skipped'`。

### 8.3 URI

URI 动作**不静默跳转**：先弹确认框告知用户即将访问外部地址，用户确认后才在新页面打开。

```text
CLICK → 协议白名单校验 ──不通过──→ skipped('policy')
                │通过
                ▼
        弹出确认对话框（显示完整 URL 与域名）
                │
        ├─ 取消/关闭 ──→ skipped('declined')
        └─ 确认 ──→ window.open(url, '_blank', 'noopener,noreferrer')
                   └─ 被浏览器拦截（返回 null）→ error('popup-blocked')
```

```ts
async function handleUri(ctx, payload: UriActionPayload): Promise<ActionOutcome> {
  const url = resolveUri(payload.uri, payload.base);
  if (!url || !allowedProtocols.includes(url.protocol)) return 'skipped'; // reason: 'policy'

  const confirmed = await confirmExternalVisit(url.href);
  if (!confirmed) return 'skipped'; // reason: 'declined'

  const opened = window.open(url.href, '_blank', 'noopener,noreferrer');
  return opened ? 'executed' : 'failed'; // 失败 reason: 'popup-blocked'
}
```

**确认对话框设计**：

| 项 | 方案 |
| --- | --- |
| 载体 | 复用现有 `DialogManager`（已含遮罩、焦点陷阱、`Esc` 关闭、关闭后焦点回到触发图元） |
| 标题 | i18n `actions.uri.title`："即将离开当前文档" |
| 正文 | 显示**完整 URL**（`sanitizeDisplayText` 去控制字符）+ **主机名单独强调** |
| 按钮 | 主按钮"打开"（i18n `actions.uri.confirm`）；次按钮"取消"（`actions.uri.cancel`，**默认焦点在此**，防误触确认） |
| 记住选择 | **不提供**。每次点击都确认，不做节流/豁免，不写任何存储 |
| 无障碍 | 复用 `DialogManager` 的焦点陷阱与 `Esc`；`role="alertdialog"`（安全相关确认）；关闭后焦点回到触发图元 |
| i18n 键 | `actions.uri.title` / `actions.uri.body`（含 `{host}`、`{url}` 插值）/ `actions.uri.confirm` / `actions.uri.cancel`；zh-CN 与 en-US **键集合必须同构** |

**为什么必须做确认**：文档可携带任意 URL，静默跳转是钓鱼与钓鱼式重定向的典型载体；用户需要看到目标地址才能判断是否可信。这与 `noopener,noreferrer` 一起构成基础防护。

**协议白名单**：**仅 `['http:', 'https:']`**。`mailto:`/`tel:`/`ftp:` 与 `javascript:`、`data:`、`file:`、`blob:` 一律拒绝，不弹框，直接 `skipped`（`reason: 'policy'`）。

> 取舍记录：不放行 `mailto:` 是有意收紧——它同样能让文档唤起外部程序，而 OFD 是版式文档交换格式，邮件跳转的正当用途极少。

**相对地址**：`Base` 参与解析（`new URL(uri, base)`）；解析失败视为 `skipped`（`reason: 'target-missing'`）。

**打开方式（尊重文档声明）**：

| `Target` | 行为 |
| --- | --- |
| 缺省或 `_blank` | `window.open(url, '_blank', 'noopener,noreferrer')` |
| `_self` | `window.location.assign(url)` —— **当前窗口跳转，离开阅读器** |
| 其他值 | 按 `_blank` 处理 |

**`_self` 的代价要明确**：当前窗口跳转会让阅读器文档状态丢失（除非宿主有离开前拦截）。UI **不做离开确认**（用户已在 URI 确认框里确认过一次，再弹一次是重复打断），但会在 `action:executed` 事件里带 `target: '_self'`，宿主需要时自行处理。

**其他**：

- 新窗口打开时 `noopener,noreferrer` 强制，防反向控制与 Referer 泄漏；
- 弹窗被浏览器拦截（`window.open` 返回 `null`）→ 上报 `action:error`（`reason: 'popup-blocked'`），UI 提示"请允许弹出窗口后重试"。

### 8.4 GotoA

```ts
async function handleGotoA(ctx, payload: GotoAActionPayload): Promise<ActionOutcome> {
  // 复用现有附件下载
  return attachmentView.open(payload.attachId) ? 'executed' : 'skipped';
}
```

- `NewWindow` **忽略**：浏览器下载无"新窗口"语义，统一走现有附件下载/打开；
- 附件不存在：`'skipped'` 并上报。

### 8.5 Sound / Movie

详见 [音视频与动作方案设计](./音视频与动作方案设计.md) §7。要点：

| 场景 | 行为 |
| --- | --- |
| `owner.kind === 'object'` 且 `Movie` | **内联**播放窗口 = 图元矩形（标准 §12） |
| `owner.kind ∈ {document, page, outline}` 或 `Sound` | **弹出式** `<dialog>`（音频用自绘控制条） |
| 自动播放被拦截 | `NotAllowedError` 时静音重试（可配置） |
| 浏览器不支持格式 | `MEDIA_ERR_SRC_NOT_SUPPORTED` → `OFD_MEDIA_UNSUPPORTED` |

---

## 9. 状态与事件

### 9.1 `ViewerState` 新增

```ts
interface ViewerState {
  actions: {
    /** 是否有未执行的 DO/PO 动作（宿主可提示用户）。 */
    pendingAutoActions: number;
    /** 当前活动播放器数量。 */
    activePlayers: number;
  };
}
```

**不承载字节与 URL**，只放可安全序列化的计数。

### 9.2 `ViewerEvent` 新增

| 事件 | 载荷 | 说明 |
| --- | --- | --- |
| `action:executed` | `ActionExecutedEvent`：`{ type; owner; pageIndex?; target? }` | 执行成功 |
| `action:skipped` | `ActionSkippedEvent`：`{ type; reason; pageIndex? }` | 跳过 |
| `action:error` | `ActionErrorEvent`：`{ type; code; reason?; message?; pageIndex? }` | 失败 |
| `media:play` / `media:pause` / `media:ended` / `media:stop` | `MediaStateEvent`：`{ resourceId; kind; pageIndex? }` | 播放态变化 |
| `media:error` | `MediaErrorEvent`：`MediaStateEvent` + `{ code: 'unsupported' \| 'decode' \| 'load'; message? }` | 播放失败 |

公共载荷约定：

- `type` 为 `ActionType`，`owner` 为 `ActionOwner`，两者直接来自 engine 的 `ActionInfo`；
- `pageIndex` 为 0-based，**只在有页上下文时出现**：页面/图元级动作带该字段，文档级（DO）与大纲级动作省略（不是填 0）；
- `target` 只在 `URI` 动作执行成功时出现，值为实际打开方式（`_self` / `_blank`），与 §8.3「`_self` 的代价要明确」对应；
- `reason` / `message` / `code` 三者在失败时都可省略：`code` 是稳定错误码字符串（如 `OFD_MEDIA_UNSUPPORTED`、`OFD_ACTION_FAILED`），`reason` 是分类，`message` 是面向诊断的可读信息。

```ts
/** 动作跳过原因。 */
type ActionSkipReason =
  | 'autoplay-disabled'    // autoExecuteActions = false
  | 'autoplay-blocked'     // 浏览器拦截自动播放
  | 'policy'               // URI 协议被白名单拒绝（不弹框）
  | 'declined'             // 用户取消了外部访问确认
  | 'target-missing'       // Goto 目标无效 / 书签名查不到 / 附件不存在 / 播放器实例不存在
  | 'unsupported'          // 浏览器不支持该媒体格式 / 引擎不具备附件读取能力
  | 'resource-missing';    // 文档未声明该动作引用的媒体资源

/** 动作失败原因。 */
type ActionErrorReason =
  | 'loop'                 // 超过 maxActionDepth
  | 'popup-blocked'        // window.open 被浏览器拦截
  | 'unsupported'          // 媒体格式/编解码不支持
  | 'load';                // 读取媒体字节失败
```

**`ActionOutcome` 与 `ActionErrorReason` 的关系**：`ActionOutcome` 是执行器返回的四态（`'executed' | 'skipped' | 'cancelled' | 'failed'`）；`'cancelled'` 只出现在返回值里，**不派发事件**（被取消的动作没有实际生效，宿主无需感知）。`'failed'` 派发 `action:error` 并同时上报 `W_ACTION_EXECUTE`。

**必须同步登记到 `component/support.ts` 的 `VIEWER_EVENT_BRIDGES`**，否则 React/Vue/Web Component 收不到。桥接名见 UI `skills/API.md` 的事件表（`ofd-action-*` / `ofd-media-*`、`onAction*` / `onMedia*`、`action-*` / `media-*`）。

---

## 10. 生命周期与清理

### 10.1 生命周期表

| 时机 | 处理 |
| --- | --- |
| 文档打开完成 | 新建整篇 `AbortController`；缓存 `getDocumentActions()`；预加载可见页 `PageActionSet`；`autoExecuteActions=true` 时执行 DO 动作，关闭时按文档派发 `action:skipped`（`reason: 'autoplay-disabled'`） |
| 页面首次渲染完成 | 补加载该页 `PageActionSet`（`PO` 动作 + CLICK 几何）；判断是否执行 PO |
| 页面被淘汰 | 中止该页 `AbortController`；删除 `PageActionSet` 与进行中的加载；销毁该页播放器；`revokeObjectURL`；`pageOpenDonePages` 保留 |
| 文档关闭 | 中止全部页与文档级执行、清空缓存、清空 `pageOpenDonePages`、销毁全部播放器、撤销全部 URL |
| 组件销毁 | 移除所有事件监听、卸载扩展、销毁服务 |

### 10.2 播放器实例管理

```ts
/** 按资源 ID 复用播放器实例。 */
players: Map<ResourceId, MediaPlayerHandle>;
```

- `Play` 时若无实例则创建，有实例则复用；
- `Pause`/`Resume` 依赖实例复用；
- `Stop` 时销毁实例并移除 DOM；
- 页淘汰时只销毁 `pageIndex` 等于该页的实例，文档关闭时批量销毁全部实例并撤销 ObjectURL；
- `ViewerState.actions.activePlayers` 反映未暂停、未销毁的实例数。

### 10.3 页级执行与 PO 去重

```
文档会话
├── documentAbort : AbortController        ← documentclose / destroy 中止
├── pages: Map<pageIndex, PageActionSet>   ← trimCache 淘汰时删除
├── pageAbort: Map<pageIndex, AbortController>  ← 每页独立，淘汰时只中止该页
└── pageOpenDonePages: Set<pageIndex>      ← 跨淘汰持久，documentclose 清空
```

PO 是否"已处理"由服务层 `pageOpenDonePages` 判定：页淘汰会销毁 `PageActionSet`，若只看页内 `pageOpenDone`，翻回同一页会重放 PO 音频/视频。两者协同：`pageOpenDonePages` 记录"这篇文档里这一页已经处理过 PO"，`PageActionSet.pageOpenDone` 记录"当前缓存有效期内已处理"，避免同页多次可见性变化重复处理。

---

## 11. 与既有功能的交互

### 11.1 冲突与让位

| 交互对象 | 处理 |
| --- | --- |
| **文本层/选区** | 有活动选区时不触发 CLICK 动作 |
| **双击缩放** | 命中动作时不触发缩放；防误触选择器补 `video,audio,[data-ofd-media]` |
| **签章层** | 签章是 `<button>`，DOM 命中优先，直接跳过 |
| **图层显示控制** | 图元所在图层隐藏时，其 CLICK 动作**不参与命中**（与渲染保持一致） |
| **打印/导出** | 动作不参与；媒体层 `@media print { display: none }` |
| **查找高亮** | 不影响 |

### 11.2 与大纲/书签的关系

**收敛到单一入口**：`views/outline.ts` 与 `views/bookmarks.ts` 现有的直接 `goToDestination` 调用改为经由 `ActionService.execute()`，即使节点没有显式 `Actions`（engine 仍会由 `Goto` 派生 `dest`），也走同一路径。

这样避免"大纲跳转正常、图元跳转失效"这类双路径不一致。

---

## 12. 实现顺序

| 阶段 | 内容 | 交付判定 |
| --- | --- | --- |
| **A1 骨架** | `ActionService` + 扩展注册 + `ViewerServices` 接线 + 状态与事件 | 单测：服务可 attach/detach，事件正确派发 |
| **A2 三种触发** | DO / PO / CLICK 触发与缓存、`autoExecuteActions` 开关 | 单测：DO 一次、PO 每页一次、开关关闭时全部跳过 |
| **A3 命中** | `PointerRouter` + `ClickTable` + 让位规则 + 防误触选择器修正 + 只做外接矩形粗判 | 单测：坐标换算、z 序取法、拖拽不触发、粗判口径 |
| **A4 执行器** | 顺序、`Synchronous`、循环防护、错误隔离、取消 | 单测：同步阻塞、深度限制、单动作失败不中断 |
| **A5 五种 handler** | Goto / URI / GotoA（复用现有）+ Sound / Movie（依赖音视频方案） | 单测：每种动作的成功/跳过/失败路径 |
| **A6 生命周期** | 页淘汰清理、播放器管理、文档关闭（**必须与 A2 同批验证**） | 单测：页淘汰后播放器已销毁、无后台播放 |
| **A7 文档与契约** | CONTRACTS、UI `skills/API.md`、事件桥接表、i18n | 对照清单逐条勾选 |

**依赖关系**：A1→A2→A3→A4 严格顺序；A5 的 `Sound`/`Movie` 依赖主文档的 P1–P3（engine 侧）。A6 必须与 A2 同批完成，否则会有播放泄漏。

---

## 13. 测试要点

| 用例 | 断言 |
| --- | --- |
| 图元 `CLICK` + `Goto` | 跳转到目标页，滚动位置正确 |
| 大纲节点动作 | 执行一次，不重复 |
| `DO` 动作 | 文档打开后执行一次；开关关闭时零执行 |
| `PO` 动作 | 页面首次可见执行一次；再次滚动回来不重复 |
| `Sound` + `Synchronous` | 后续动作阻塞到音频结束 |
| `Movie` + `Pause`/`Resume` | 实例复用，位置保留 |
| `URI` 协议白名单 | `javascript:`/`data:`/`mailto:` 被拒并报 `policy`，**且不弹确认框** |
| `URI` 确认框-取消 | 用户点取消 → `skipped('declined')`，**无新页面打开** |
| `URI` 确认框-确认 | 用户确认 → 新页面打开；`window.open` 返回 `null` 时报 `popup-blocked` |
| `URI` + `Target="_self"` | 当前窗口 `location.assign`，事件带 `target: '_self'` |
| `URI` 默认焦点 | 确认框打开时焦点在「取消」按钮上 |
| `GotoA` | 触发附件下载 |
| 循环 `Goto` | 不无限循环，`maxActionDepth` 生效 |
| 页淘汰 | 播放器销毁，无后台播放 |
| 拖拽/选择 | 不触发 CLICK 动作 |
| 双击视频 | 不触发页面缩放 |
| 「关于」开关 | 切换后 `autoExecuteActions` 立即生效；刷新后回到宿主预设值（不持久化） |

样本：复用工作区已有的 `ofd_pdf_match/gb-12-media.ofd`（图元 `CLICK` + `Movie` / `Sound`），其余样本见主文档 §12.2。

---

## 14. 已定决策

以下均已确认，不再是开放问题：

| # | 决策点 | 结论 |
| --- | --- | --- |
| 1 | `URI` 确认框是否允许"记住选择" | **不允许**。每次都确认，不写任何存储 |
| 2 | `URI` 的 `Target="_self"` | **尊重文档声明**：当前窗口 `location.assign` 跳转；事件带 `target: '_self'`，宿主可自行拦截 |
| 3 | `URI` 协议白名单 | **仅 `http:` / `https:`**（不含 `mailto:` / `tel:` / `ftp:`） |
| 4 | `DO`/`PO` 自动执行默认值 | **默认 false**；用户可在「更多 → 关于」中手动开启（沿用 `localFonts.set` 先例），不持久化 |
| 5 | 宿主手动执行 API | **提供** `viewer.executeActions(...)`，便于集成与自动化测试 |
| 6 | `Region` 精度 | **外接矩形粗判**即可，不做精确路径命中（§6.6 按此口径执行） |
| 7 | `GotoA` 的 `NewWindow` | **忽略**，统一走现有附件下载/打开 |
| 8 | PO 触发时机是否需要"停留 N ms" | **不需要**，进入可见即触发 |
| 9 | 执行入口命名 | 服务层 `ViewerActionService.executeActions`、实例方法 `viewer.executeActions`、服务实现 `ActionService.executeActions` 三处同名，不保留 `executePageActions` |
| 10 | 自动执行开关的宿主控制 | `allowUserToggleAutoExecute: false` 时开关为禁用态、点击无效，「关于」里保留该行并给出说明 |
| 11 | 图片/媒体选项是否进 `ViewerOptions` | **不进**：`ViewerOptions` 只有 `actions` 一个相关选项；媒体音量、自动播放静音重试、单资源读取上限等为动作模块内部常量，不作为公共配置 |
| 12 | 页淘汰的取消粒度 | **按页**：每页独立 `AbortController`，淘汰只中止该页；文档关闭中止全部 |
| 13 | PO 每页一次的作用域 | **跨页淘汰持久**（`pageOpenDonePages`），仅文档关闭时清空 |

### 14.1 宿主手动执行 API

```ts
/** 手动执行某页的指定事件动作；返回每个动作的结果。 */
executeActions(pageIndex: number, event: ActionEvent, options?: { signal?: AbortSignal }): Promise<readonly ActionOutcome[]>;
```

- 与内部触发走**同一条** `ActionService.execute()` 路径，不另写逻辑；
- `executeActions(i, 'PO')` **不修改** `pageOpenDone` / `pageOpenDonePages`（手动调用不应"消耗"自动执行机会）；
- 使用**该页的取消信号**执行，页淘汰会中止手动调用；额外的 `options.signal` 与之合并（任一中止即中止）；
- `pageIndex` 非整数或越界抛 `OFD_PAGE_NOT_FOUND`；未挂载动作服务（`features.actions = false` 或引擎不具备动作能力）时抛 `OFD_FEATURE_DISABLED`（`feature: 'actions'`）；文档未打开时抛 `OFD_NOT_OPENED`，销毁后抛 `OFD_DESTROYED`；
- 返回数组与 `getPageActionsByEvent(pageIndex, event)` 的结果等长且顺序一一对应；被取消的动作返回 `'cancelled'`。

与本 API 配套的宿主接口（完整签名见 UI `skills/API.md`「动作与音视频」）：

| 方法 | 说明 |
| --- | --- |
| `executeActions(pageIndex, event, options?)` | 手动执行某页某事件的动作 |
| `getAutoExecuteActions()` | 读取自动执行开关；动作模块未挂载时返回 `undefined` |
| `setAutoExecuteActions(enabled)` | 设置自动执行开关（不持久化）；`allowUserToggleAutoExecute: false` 时忽略 |
| `getAutoExecuteActionsToggleAllowed()` | 是否允许用户修改该开关（对应 `allowUserToggleAutoExecute`）；动作模块未挂载时返回 `undefined` |
| `attachActionService(service)` | 挂载动作服务，返回卸载函数 |
| `getContentPointAtViewport(clientX, clientY)` | 视口坐标 → 页索引与 96 DPI 页面像素（纯读取，见 §6.4） |

---

## 附录 B：实现状态

本附录记录 A1–A7 各阶段的落地状态与实现与本文的已知差异。统计口径按**文件与公共符号**，不按代码行数。

### 阶段状态

| 阶段 | 状态 | 关键交付 |
| --- | --- | --- |
| A1 骨架 | 已落地 | `src/actions/` 下的服务、执行器、命中表、几何与 handler 注册；`ViewerServices.actions`、`attachActionService()`；`features` 新增 `actions` 功能键 |
| A2 三种触发 | 已落地 | DO（`documentopen` 后一次）、PO（页面渲染完成 + 可见）、CLICK（指针路由）；`actions.autoExecuteActions` 默认 false；关闭时派发 `action:skipped`（`reason: 'autoplay-disabled'`）并按文档/按页聚合 |
| A3 命中 | 已落地 | `pointer-router.ts` + `click-table.ts`；让位规则（拖拽阈值、活动选区、签章/媒体元素）；`ZOOM_GUARD_SELECTOR` 统一常量；命中口径修正为**只做外接矩形粗判** |
| A4 执行器 | 已落地 | 顺序执行、`Synchronous` 阻塞、`maxActionDepth`、错误隔离、取消（按页 `AbortController` 在收尾中） |
| A5 五种 handler | 已落地 | Goto / URI / GotoA / Sound / Movie 五个 handler，媒体播放器管理器与呈现层 |
| A6 生命周期 | 已落地 | 页淘汰释放（播放器销毁 + `revokeObjectURL`）、播放器实例表、文档关闭全量清理 |
| A7 文档与契约 | 本轮收尾 | 本文回填、`docs/CONTRACTS.md` 公共契约、UI `skills/API.md` 动作/媒体章节、`VIEWER_EVENT_BRIDGES`、i18n `actions.*`/`media.*` |

### 代码与测试规模

| 项 | 数值 | 统计口径 |
| --- | --- | --- |
| `src/actions/` 实现文件 | 15 个（根目录 7 个 + `handlers/` 8 个） | `glob src/actions/**/*.ts`，含 `index.ts` 与 `handlers/index.ts` 两个注册位 |
| 其中 handler | 5 个（`goto`/`uri`/`goto-attachment`/`sound`/`movie`）+ 2 个媒体支撑（`media-player`/`media-presenter`）+ 1 个注册位（`handlers/index`） | 同上 |
| UI 自有告警码新增 | 5 个（`W_ACTION_LOAD`、`W_ACTION_EXECUTE`、`W_MEDIA_RESOURCE`、`W_MEDIA_PLAY`、`W_NAV_ACTION`） | `src/diagnostics.ts` 的 `UI_WARNING_CODES` |
| 动作单测用例数 | **156 例 / 12 文件** | `pnpm -C packages/ofdrw-viewer-ui exec vitest run test/unit/actions` |
| UI 包全量用例 | **1141 例 / 97 文件** | `pnpm -C packages/ofdrw-viewer-ui test`（typecheck 0 错误） |

> 上表数字取自本轮收尾后的实际运行结果。

### 与设计的差异（实现后回填）

1. **关于对话框开关放在 P5 收尾**登入 `UIShellCommand.actions.setAutoExecute` + `UIShellViewState.actions`（含 `autoExecute` 与可选 `allowUserToggle`），沿用 `localFonts` 的「可选方法存在即用」模式，未改动 `UIShellHost` 必选面（§5.2 已定）。
2. **`VIEWER_EVENT_BRIDGES` 增加覆盖性断言**（§3.2 之外补充）：`ViewerEventMap` 原为 `type` 而非 `satisfies`，漏登记桥接不会报错。现加编译期断言，漏登记会 typecheck 失败。
3. **`getContentPointAtViewport()` 作为 `OFDViewer` 的公开方法存在**，但未从包根导出为独立类型；它只返回 `{ pageIndex, xPx, yPx }`，无副作用，供动作模块和宿主自建命中逻辑使用（§6.4）。
4. **`handlers/` 实为 8 个文件**而非 5 个：除 5 个 handler 外新增 `media-player.ts`（播放器管理器）、`media-presenter.ts`（呈现层）、`index.ts`（注册位）。媒体播放的复杂度集中在管理器与呈现层，单独拆出更清晰。
5. **`ActionSkipReason` 比设计多 `'resource-missing'`**：媒体动作引用的资源在文档中不存在时单独归类，与"目标缺失"（Goto 目标/附件）区分，便于宿主分别提示。
6. **`ActionErrorReason` 比设计多 `'load'`**：读取媒体字节失败（引擎 `OFD_LIMIT_EXCEEDED`、网络失败等）归为 `'load'`，与"格式不支持"的 `'unsupported'` 区分。
7. **事件载荷比设计多三个字段**：`ActionSkippedEvent.pageIndex`（有页上下文时出现）、`ActionErrorEvent.message`（面向诊断的可读信息）、`ActionExecutedEvent.target`（URI 动作的实际打开方式）。
8. **事件名与设计完全一致**：`action:executed` / `action:skipped` / `action:error` / `media:play` / `media:pause` / `media:ended` / `media:stop` / `media:error`，共 8 条。
9. **媒体选项不进入 `ViewerOptions`**：单资源读取上限（256 MiB，与引擎 `maxMediaBytes` 默认值一致）、主音量、自动播放被拦截时静音重试等为动作模块内部常量，宿主无法配置；`ViewerOptions` 只新增 `actions`。
10. **`ActionService` 的执行入口统一命名 `executeActions`**：与 `ViewerActionService.executeActions`、`viewer.executeActions` 三处同名，不再保留 `executePageActions`。

### 已知限制

- **图层隐藏时 CLICK 仍参与命中（未实现联动）**：`ActionInfo` 不携带图层归属，靠 `PageContentFilter` 反推不可靠，且 `setLayerVisibility()` 触发的重绘只取消在途渲染、不重建页动作集合；该场景罕见，第一版不处理（§11.1 已记录）。
- **命中只到外接矩形**：环形/凹形 `Region` 的挖空部分同样触发（§6.6 与 §14 决策 6 的已知代价）。
- **端到端交互已做真实浏览器验证**：以 `?file=samples/...` 加载含「图元 `CLICK` + `Goto`」的样本，实测命中（图元中心命中、页面角落不命中）→ 执行 → 页码跳转 → `action:executed` 事件携带 `owner`/`pageIndex`；同时验证开关默认值、切换与回读、`allowUserToggle`、越界页索引抛 `OFD_PAGE_NOT_FOUND`。**未在生产规模的媒体样本上验证播放**：样本视频解码会阻塞无头浏览器的事件循环，媒体播放路径仍由单测覆盖。
- **jsdom 无法覆盖样式类缺陷**：纯 CSS 的层级/定位问题（媒体层与弹出浮层的 `z-index`、`position`、打印隐藏）只能在真实浏览器里发现，单测断言只能覆盖 DOM 结构与类名。
