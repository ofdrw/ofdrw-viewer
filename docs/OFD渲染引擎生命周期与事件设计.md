# OFD 渲染引擎生命周期与事件设计

## 1. 定位、范围与非目标

本文定义 `@ofdrw/ofdrw-viewer-engine` 的文档、页面与操作生命周期，以及供宿主观察这些过程的类型化事件。事件只描述“发生了什么”，不参与控制流；取消由 `AbortSignal`/`RenderTask.cancel()` 驱动，关闭由 `document.close()` 驱动。

**范围**

- `OFDDocument.open()`、`getPage()`、`close()` 的状态与顺序。
- `page.render()` 的任务生命周期、取消与同 Canvas 串行。
- `page.prepare()`、`page.getTextContent()`、`page.exportImage()` 与关闭的关系；它们不派发操作事件。
- 14 个公共事件的名称、载荷字段、派发语义、监听器过滤和异常隔离。
- 宿主（尤其是 UI）如何把引擎事件映射为加载、错误和取消状态。
- 事件路径的性能约束与当前测试入口。

**非目标**

- 不提供打开或渲染的内部子阶段（容器、XML、模型、准备、绘制等）事件。
- 不提供缓存命中、共享加载、队列等待、字节下载、百分比或逐图元进度。
- 不把事件作为控制接口；监听器不能阻止操作、修改参数或改变绘制结果。
- 不在载荷中暴露 `PageModel`、`PreparedPageBundle`、XML 节点、字体/图片字节或 Canvas 对象。
- 不派发 warning 事件；warning 继续通过 `onWarning` 上报。
- 不规定 UI 的视觉、动效和文案；这些由 [UI 设计方案](./ofdrw-viewer-ui设计方案.md) 维护，本文只约束事件到 UI 状态的映射。

**约束**

| 约束 | 影响 |
|---|---|
| 平台无关 | 事件总线不依赖 DOM `EventTarget`、`CustomEvent`、`window` 或 `document` |
| 同步派发 | 监听器在 `emit` 的调用栈内执行，不返回 Promise |
| 页面级粒度 | 一个操作只有开始和终止，不拆内部阶段 |
| 取消是正常路径 | 调用方取消和文档关闭派发 `abort`，不伪装成 `error` |
| 载荷轻量 | 只含标量、`OFDError` 和标识字段，不持有页面模型或字节 |

## 2. 生命周期

### 2.1 对象与所有权

| 对象 | 创建者 | 生命周期 | 释放 |
|---|---|---|---|
| `OFDSource` | 宿主 | 由宿主传入 | 由宿主的字节源管理 |
| `VirtualContainer` | 默认 ZIP、`containerFactory` 或宿主 | 打开到 `close()` | engine 自有容器在关闭/打开失败时关闭；宿主注入的容器只清引用，不关闭 |
| `OFDDocument` | `OFDDocument.open()` | 打开成功到 `close()` | `close()` 释放缓存、渲染器、字体与图片；可重复调用 |
| `OFDPage` | `document.getPage()` | 可长于一次操作；文档关闭后失效 | 不单独关闭；随文档关闭失效 |
| `RenderTask` | `page.render()` | 一次渲染 | `task.promise` 结束即完成；`cancel()` 可重复调用 |
| `OFDEventBus` | 宿主注入或 engine 创建 | 至少覆盖文档生命周期 | 文档关闭后静默；监听器由宿主或文档持有 |

页面对象不拥有 Canvas、页面模型或渲染器，只是文档能力的句柄。页面监听器是文档总线按 `pageIndex` 过滤的视图，不是独立的事件循环。

### 2.2 文档生命周期

```text
无实例 --open()--> Opening --open:end--> Open --close()--> Closing --close:end--> Closed
                         |                                      |
                         +--open:error / open:abort--> Failed  +--重复 close()--> Closed（无事件）
```

- `Opening` 阶段文档对象尚未返回，宿主只能通过 `OFDOpenOptions.eventBus` 观察 `document:open:*`。
- `document:open:start` 在任何容器读取前同步派发；`document:open:end` 在文档构造完成、`open()` Promise resolve 前派发，此时 `document.events` 与注入总线是同一对象。
- 打开失败派发 `document:open:error`；`signal` 取消派发 `open:abort(cause='caller')`。失败或取消时没有可用文档实例；engine 自有容器会被释放，取消后才返回的容器也会被异步关闭。宿主借用的容器保持宿主所有权。
- `Open` 状态可执行查询、取页、准备、渲染、文本和导出；新操作在文档关闭后一律拒绝。
- `Closing` 从 `close()` 设置关闭标志并派发 `close:start` 开始。此后不再接受新的公开操作；已登记的活动操作被中止，`close()` 等待它们 settle 后释放容器、渲染器、字体、XML/图片缓存、页面模型、prepare bundle 和文本缓存。
- `Closed` 是终态；第二次 `close()` 立即返回，不派发事件。`close()` 本身不向调用方抛错，释放阶段的容器/渲染器异常被吞掉；活动操作仍按各自 Promise 语义拒绝。

`close()` 的事件顺序固定为：

```text
document:close:start
  → 活动操作 abort(cause='close')（各自派发页面 abort 或静默拒绝）
  → 等待 activity settle
  → 释放资源
  → document:close:end
  → 总线静默，清理页面监听器
```

`document:close:end` 是本文档的最后一帧事件；之后即使仍有旧引用，也不会再派发事件。

### 2.3 页面与操作生命周期

页面没有单一的 `loading/rendering/ready` 状态，因为同一页可以同时被主视图渲染、缩略图渲染、文本读取、准备和导出。生命周期按操作定义：

| 操作 | 公开入口 | 事件 | 说明 |
|---|---|---|---|
| 页面加载 | `document.getPage()` | `page:load:*` | 加载页模型、模板页和页资源，返回页面句柄 |
| 页面渲染 | `page.render()` | `page:render:*` | 异步准备后同步绘制；同一 Canvas 串行 |
| 页面准备 | `page.prepare()` | 无操作事件 | 按 96 DPI 预取并缓存 bundle；调用方 signal 只取消本次等待，准备本身继续缓存 |
| 文本内容 | `page.getTextContent()` | 无操作事件 | 构建阅读器文本层；语义见 [文本内容 API](./text-content-api.md) |
| 图片导出 | `page.exportImage()` | 无操作事件 | 离屏渲染、旋转与编码；关闭会中止 |

`prepare`、`getTextContent` 和 `exportImage` 仍是文档活动：`close()` 会中止它们并等待其 Promise settle，但它们不派发 `page:prepare:*`、`page:text:*` 或 `page:export:*`。当前公共事件只有文档打开/关闭和页面加载/渲染四组。

`RenderTask` 的生命周期：

1. `page.render()` 先做同步入口校验；失败时返回 `id=0` 的已拒绝任务，不派发事件。
2. 校验通过后分配 `operationId`，在 `render()` 返回前同步派发 `page:render:start`。
3. 任务进入目标 Canvas 的串行链；前一个任务失败不会阻断后续任务。
4. 准备/绘制完成派发 `end`，真实失败派发 `error`，调用方取消或文档关闭派发 `abort`；终止事件先于 `task.promise` settle。
5. `task.cancel()` 只标记取消并中止内部信号，可重复调用；取消一个已排队任务时，它仍要等到获得执行机会后才观察到取消并派发 `abort`。

页面句柄在文档关闭后仍可调用 `getSize()`/`getViewport()` 这类纯计算；`render`、`prepare`、`getTextContent`、`exportImage` 会以 `OFD_CLOSED` 拒绝，且不再派发页面事件。

### 2.4 关键时序与入口边界

**打开**

```text
open({ source|container, eventBus, signal })
  → 参数形状校验（失败：无事件、reject）
  → document:open:start（同步）
  → 获取容器、解析 OFD.xml/Document.xml、加载资源索引、构造文档
  → document:open:end（resolve 前）→ resolve(document)
```

参数形状校验只覆盖缺少 `options`、缺少 `source` 且没有容器/工厂、`container` 与 `containerFactory` 同时出现；这些失败不派发事件。`documentIndex` 越界、包损坏、加密容器、资源限制等发生在 `start` 之后，走 `start → error`。

**取页与渲染**

```text
getPage(index)
  → 文档关闭/索引非法/预取消（失败：无事件）
  → page:load:start（同步）
  → 共享页面加载、构造页面句柄
  → page:load:end（resolve 前）→ resolve(page)

page.render(params)
  → 文档关闭/参数非法（失败：id=0 的拒绝任务，无事件）
  → page:render:start（render 返回前同步）
  → 等待同 Canvas 前序任务 → 准备 → 绘制
  → page:render:end|error|abort（task.promise settle 前）
```

`getPage` 的预取消在 `start` 前返回，无任何事件；`render` 的预取消信号仍派发 `start → abort`。`open` 的预取消同理派发 `start → abort`。`getPage` 缓存命中、`render` 使用已准备 bundle 时仍各派发一对新的 `start/end`，不派发缓存命中事件。

**并发与关闭**

- 同一 Canvas 的渲染严格串行；不同 Canvas 可并行。不同操作的 `start`/终止事件可交错，不保证跨操作的相对顺序，用 `operationId` 归属、用 `sequence` 观察总线顺序。
- 页面模型、页面准备和文本构建有共享加载/去重；单个 `getPage` 调用方的 signal 只取消本次等待，不中止其他等待者共享的加载。`close()` 的中止会作用于共享流程。
- `close()` 快照当前仍登记的活动运行数作为 `abortedOperations`，随后中止并等待。关闭触发的页面 `abort` 一律为 `cause='close'`；若页面加载在关闭前已因调用方信号取消，则保留 `cause='caller'`。
- `end`/`error`/`abort` 在同一操作内互斥；入口校验失败不进入操作生命周期，不派发 `start`，也不会补发终止事件。

## 3. 事件模型

### 3.1 名称、公共字段与单位

事件名格式为 `<对象>:<操作>:<后缀>`：

- 对象：`document`、`page`。
- 操作：`open`、`close`、`load`、`render`。
- 后缀：`start`、`end`、`error`、`abort`。

当前共 14 个事件，全部小写、冒号分层；不提供 UI 风格别名，UI 在自己的事件层转换。

所有事件带 `type`、`timestamp`、`sequence`；带操作的再带 `operationId`，页面操作再带 `pageIndex`。精确字段与 TypeScript 类型见 [engine API 的事件章节](../packages/ofdrw-viewer-engine/skills/API.md)，本文只列语义和字段名。

| 字段 | 单位/含义 |
|---|---|
| `type` | 事件名字面量 |
| `timestamp` | Unix 毫秒，`Date.now()` |
| `sequence` | 总线实际派发序号，从 1 单调递增 |
| `operationId` | 文档内操作编号，从 1 分配；`RenderTask.id` 使用同一编号 |
| `pageIndex` | 页索引，从 0 开始 |
| `durationMs` | 操作耗时，毫秒 |
| `width` / `height` | `page:render:start` 的 Canvas/viewport 尺寸，设备像素 |
| `widthMm` / `heightMm` | 页面物理尺寸，毫米 |
| `dpi` | 渲染精度，DPI |
| `packageSize` | 原始 OFD 包字节数，byte |
| `pageCount` | 文档总页数，页 |
| `abortedOperations` | 本次关闭中止的活动运行数量，个 |

`sequence` 只在事件实际派发时递增：某个事件没有监听器时不会消耗序号，也不会构造载荷。因此后注册的监听器看到的第一个事件仍可能从 `sequence=1` 开始，而 `operationId` 已递增。`operationId` 按文档分配，打开、取页、渲染和关闭都会占用编号；没有监听器也照常分配。

### 3.2 事件目录

**文档事件**

| 事件 | 触发时机 | 额外载荷 | 终止 |
|---|---|---|---|
| `document:open:start` | 参数形状校验通过、容器读取前，同步 | `sourceKind`、`documentIndex`、`viaContainer` | 否 |
| `document:open:end` | 文档构造完成、`open()` resolve 前 | `pageCount`、`version`、`packageSize`、`durationMs` | 是 |
| `document:open:error` | 打开失败 | `error`、`durationMs` | 是 |
| `document:open:abort` | 打开被调用方 signal 取消 | `cause:'caller'`、`reason?`、`durationMs` | 是 |
| `document:close:start` | 关闭开始、中止活动操作前 | 无额外字段 | 否 |
| `document:close:end` | 活动操作 settle、资源释放后 | `durationMs`、`abortedOperations` | 是 |

`sourceKind` 是声明的来源类型（`arraybuffer`、`blob` 或 `custom`）；直接注入容器且没有 `source` 时为 `custom`。URL 等网络来源由 UI 转成 `custom`，获取细节见 [网络获取委托设计](./网络获取委托设计.md)。`viaContainer` 在提供 `container` 或 `containerFactory` 时为 `true`，默认 ZIP 为 `false`。`documentIndex` 默认为 0。

**页面事件**

| 事件 | 触发时机 | 额外载荷 | 终止 |
|---|---|---|---|
| `page:load:start` | `getPage` 入口校验通过后，同步 | 无额外字段 | 否 |
| `page:load:end` | 页面句柄创建完成、`getPage()` resolve 前 | `widthMm`、`heightMm`、`durationMs` | 是 |
| `page:load:error` | 页面模型/资源加载失败 | `error`、`durationMs` | 是 |
| `page:load:abort` | 取页等待被取消或文档关闭 | `cause`（`caller`/`close`）、`reason?`、`durationMs` | 是 |
| `page:render:start` | 入口校验通过、`render()` 返回前，同步 | `dpi`、`width`、`height` | 否 |
| `page:render:end` | 绘制完成、`task.promise` resolve 前 | `durationMs` | 是 |
| `page:render:error` | 准备或绘制真实失败 | `error`、`durationMs` | 是 |
| `page:render:abort` | `task.cancel()`、外部 signal 或文档关闭 | `cause`（`caller`/`close`）、`reason?`、`durationMs` | 是 |

`page:load:start` 在页面句柄创建前派发，所以不能在页面对象上监听自己的加载事件；应在 `document.events` 或 `document.on` 上监听。页面句柄上的 `page:load:*` 订阅类型存在，但注册时该页的加载已经结束，通常不会收到事件。

### 3.3 派发与监听器语义

| 语义 | 约定 |
|---|---|
| 同步 | 监听器在 `emit` 调用栈内执行；引擎不等待返回值 |
| 快照 | 派发开始时复制监听器集合；派发中新增的监听器不参与本次事件 |
| `once` | 调用监听器前移除；监听器抛错也不会再次触发 |
| `signal` | 注册时已中止则不注册；注册后中止自动移除 |
| 退订 | `off`/`removeEventListener` 移除匹配回调；同一回调的多次注册全部移除 |
| 异常 | 单个监听器抛错被捕获，不影响其他监听器或引擎结果；配置 `onListenerError` 时上报，否则静默；异常回调自身抛错也被吞掉 |
| 重入 | 允许监听器再次调用引擎 API；新操作使用新的 `operationId` |
| 顺序 | 同一操作内严格 `start → 终止`；跨操作不保证相对顺序，用 `sequence` 观察派发顺序 |
| 关闭后 | `document:close:end` 之后总线静默；已注册监听器保留但不再被调用 |
| 页面过滤 | 页面监听器只在 `event.pageIndex` 等于本页索引时调用；文档监听器收到全部页面事件 |

`OFDEventBus` 提供 `on`、`once`、`off`、`addEventListener`、`removeEventListener`、`removeAllListeners`、`listenerCount`；`document` 和 `page` 只转发 `on`/`once`/`off`/`addEventListener`/`removeEventListener`；需要移除全部监听器或计数时使用 `document.events.removeAllListeners()` / `document.events.listenerCount()`。`emit` 与序号分配是引擎内部入口，宿主只应订阅；页面监听器在文档关闭时由引擎清理。

不建议在监听器里同步调用 `document.close()`。引擎允许重入，但关闭会等待当前操作，容易让宿主状态竞争；关闭应由明确的用户/生命周期动作触发。

### 3.4 失败、取消与关闭

- `error`：真实失败。`document:open:error` 和 `page:load:error`/`page:render:error` 携带 `OFDError`；Promise 保留同一错误（页面加载错误可能被包装为 `OFD_ENTRY_NOT_FOUND`）。
- `abort`：调用方取消或文档关闭。`task.cancel()`、外部 `signal`、`getPage`/`open` 的 `signal` 都归为 `cause='caller'`；`close()` 归为 `cause='close'`。关闭优先于调用方取消：文档已关闭时，即使调用方 signal 也中止，页面终止事件为 `cause='close'`。
- `page:render` 的取消 Promise 统一以 `OFD_ABORTED` 拒绝；`page:load` 的关闭场景可能以 `OFD_CLOSED` 或底层 `OFD_ABORTED` 拒绝，但终止事件始终是 `abort`，不是 `error`。
- `document:open` 取消以 `OFD_ABORTED` 拒绝；打开失败保留包/资源错误码。
- 入口校验失败不派发任何事件。`render` 的入口失败返回 `task.id === 0` 的拒绝任务；`getPage` 的越界/预取消和 `open` 的参数形状错误直接拒绝。
- `close()` 幂等；第二次调用不派发事件。`close:end` 之后的任何调用都不会产生新事件。

## 4. 公共事件 API

精确签名、类型映射和字段表由 [engine API](../packages/ofdrw-viewer-engine/skills/API.md) 维护；本节只说明调用面上的生命周期语义。

| 入口 | 语义 |
|---|---|
| `OFDEventBus` | 事件总线实现；可独立创建，也可注入 `OFDOpenOptions.eventBus` |
| `OFDOpenOptions.eventBus` | 打开前创建并注册监听；省略时 engine 创建，成功后通过 `document.events` 访问 |
| `OFDOpenOptions.signal` | 打开取消；派发 `open:abort(cause='caller')` 并以 `OFD_ABORTED` 拒绝 |
| `document.events` | 本文档总线；与注入总线同一对象 |
| `document.events.removeAllListeners()` / `document.events.listenerCount()` | 清空/统计总线监听器；仅 `OFDEventBus` 提供，`document`/`page` 不转发 |
| `document.on/once/off/addEventListener/removeEventListener` | 订阅文档全部事件；`addEventListener` 支持 `once`/`signal` |
| `document.getPage(index, { signal })` | 页面加载；signal 只取消本次等待，不中止共享加载 |
| `page.on/once/off/addEventListener/removeEventListener` | 只接收本页 `page:*` 事件；`page:load:*` 通常已错过 |
| `page.render(params)` | 返回 `RenderTask`；`start` 同步派发，终止事件在 Promise settle 前 |
| `RenderTask.cancel()` | 幂等取消；不立即伪造终止事件，任务在观察到取消时派发 `abort` |

宿主约定：

- 一个总线只服务一个文档。引擎不检查重复使用；同一总线接两个文档会让监听器收到混合事件，`operationId` 也不再能单独标识文档。
- 注入总线后，engine 不负责关闭或清空它；`document.close()` 只让本文档的派发器静默，并清理页面过滤监听器。宿主若复用总线，应自行 `removeAllListeners()`。
- `document.events` 在关闭后仍可读取，但不会再派发事件。
- `documentIndex` 只是多文档包的文档选择参数，不影响事件顺序或编号。

## 5. 使用示例

**打开前监听**

```ts
import { OFDEventBus, OFDDocument } from '@ofdrw/ofdrw-viewer-engine';

const events = new OFDEventBus();
events.on('document:open:start', (event) => {
  console.log(event.operationId, event.sourceKind, event.viaContainer);
});
events.on('document:open:error', (event) => {
  console.error(event.error.code, event.durationMs);
});

const doc = await OFDDocument.open({
  source: { kind: 'arraybuffer', data: bytes },
  eventBus: events,
});
```

**页面渲染与取消**

```ts
const page = await doc.getPage(0);
const task = page.render({ canvasContext: ctx, viewport });

page.on('page:render:end', (event) => {
  if (event.operationId === task.id) console.log('done', event.durationMs);
});
page.on('page:render:abort', (event) => {
  if (event.operationId === task.id) console.log('cancelled', event.cause);
});

task.cancel();
await task.promise.catch((error) => {
  if (error.code !== 'OFD_ABORTED') throw error;
});
```

**关闭**

```ts
doc.on('document:close:start', () => {
  // 停止 UI 计时器，拒绝新的用户操作
});
await doc.close();
// close:end 之后不再有事件；页面监听器已清理
```

## 6. UI 对接约束

UI 的视觉、动效、文案和可访问性由 [UI 设计方案：加载、错误与空态](./ofdrw-viewer-ui设计方案.md#加载错误与空态) 维护；本节只约束引擎事件如何驱动 UI 状态。

### 6.1 事件映射

| 引擎事件 | UI 行为 | 约束 |
|---|---|---|
| `document:open:start` | 文档状态置为打开中，启动全屏 loading 计时 | 不立即显示遮罩；小文件不应闪一下 |
| `document:open:end` | 引擎文档已可用 | **不是全屏 loading 的结束点**；UI 还需页壳、页尺寸和初始滚动 |
| `document:open:error` | 立即显示全屏错误和重试/关闭 | 错误不等待 loading 延迟 |
| `document:open:abort` | 清理全屏 loading，回到空态 | 用户取消不报错；若引擎文档已打开但布局未完成，调用 `close()` |
| `document:close:start` | 停止计时器，清理页面/缩略图 loading 与 `operationId` 映射 | 不再接受新的公开操作；覆盖层清理应在此完成 |
| `document:close:end` | 仅用于确认关闭完成 | 不应依赖它清理覆盖层；`close:start` 已清理，之后无事件 |
| `page:load:*` | 不作为主阅读区 loading 触发器 | 页壳由 `getPageInfos` 先建好；页面加载错误由渲染队列统一处理 |
| `page:render:start` | 登记用途和 `operationId`，主页面启动页面 loading 计时 | 主页面和缩略图共用同一事件名，必须按用途归属 |
| `page:render:end` | 按 `operationId` 清除计时器、隐藏页面 loading | UI 的 `pagerendered` 仍在 `task.promise` resolve 后派发 |
| `page:render:error` | 清除计时器，显示页内错误卡和重试 | 不重复弹 toast |
| `page:render:abort` | 清除计时器，静默隐藏 loading | 取消和关闭不是错误 |

`document:open:end` 只表示引擎文档可用；UI 的 `documentopen` 在页壳、页尺寸和初始滚动就绪后派发，是全屏 loading 的结束点。页面 loading 可以在 `page:render:end` 时提前隐藏，但 UI 的“已渲染页”集合和 `pagerendered` 仍等待 `task.promise`；两者不是同一时刻。

### 6.2 用途归属与旧操作隔离

`page:render:*` 只带 `pageIndex` 和 `operationId`，不带“主页面/缩略图”标签。同一页可能同时有主页面和缩略图渲染，不能只按 `pageIndex` 更新主页面 loading。

推荐在每次 `page.render()` 前登记用途：

```ts
pendingStarts.get(pageIndex)?.push({ purpose: 'main' as const });
const task = page.render({ canvasContext, viewport, signal });
// page:render:start 在 render() 返回前同步派发，监听器从 pendingStarts 取出用途，
// 建立 operationId -> { purpose, pageIndex } 映射。
```

- 若 `render()` 在入口校验阶段抛错/返回拒绝任务而没有派发 `start`，调用方必须移除刚登记的 pending 项。
- `end/error/abort` 按 `operationId` 路由；未知 `operationId` 直接忽略。
- 同一页的新操作覆盖旧操作时，以最新 `operationId` 为准；旧操作晚到的 `abort` 不得关闭新操作的 loading。
- 缩略图事件只更新对应缩略图项，不能触发主页面遮罩；主页面事件也不能更新缩略图状态。

### 6.3 加载结束与错误边界

- 全屏 loading 结束后，页面骨架接管；`document:close:start` 必须清理所有计时器，避免关闭后残留 loading。
- `page:load:*` 不是主阅读区 loading 的触发器；页面加载失败应在渲染队列的 Promise/错误路径统一呈现，避免和 `page:render:error` 重复报错。
- `page:render:abort` 不显示错误 toast；`page:render:error` 才显示页内错误卡。重试应使用新的操作，旧 `operationId` 的终止事件不能覆盖新状态。
- 不使用不存在的 `phase`、`cacheHit`、`joined`、百分比等字段；不把 `page:load:*` 和 `page:render:*` 当成同一操作。
- 不在 `page:render:start` 监听器里执行重活；它位于 `render()` 调用栈内，会延迟任务返回。

## 7. 性能与验证

### 7.1 事件路径

| 项 | 约束 |
|---|---|
| 无监听器 | 派发前检查监听器集合；为空直接返回，不构造事件、不消耗 `sequence` |
| 载荷 | 只含标量、`OFDError` 和标识字段；不持有页面模型、字节或显示列表 |
| 派发 | 同步、无 Promise、无微任务；每个操作最多一对 `start` + 终止事件 |
| 页面监听 | 每个页面订阅在总线上建立一个过滤包装；注销/关闭时释放 |
| 内存 | 事件对象不进入缓存；页面关闭时清理页面监听器；总线监听器保留到宿主清理或总线释放 |
| 关闭 | 先停止派发再清理页面视图，避免关闭后回调访问已释放资源 |

当前没有独立的事件微基准门禁；回归由类型检查、事件契约单测和全量测试覆盖。事件监听器应保持短小，避免在同步派发中执行渲染、网络或大对象序列化。

### 7.2 当前验证

事件契约由 `packages/ofdrw-viewer-engine/test/api/events.test.ts` 和 `events-contract.test.ts` 覆盖，重点断言：

- 14 个事件名与载荷字段、`sequence` 从 1 递增、无监听器不消耗序号。
- `document:open` 的 `start` 同步、`end` 在 resolve 前；失败只派发 `start → error`；取消只派发 `start → abort(caller)`。
- `getPage` 的 `start` 同步、`end` 在 resolve 前；缓存命中仍派发新操作；越界/预取消零事件。
- `render` 的 `start` 同步、`end` 在 resolve 前；`task.id === operationId`；入口失败 `id=0` 且零事件。
- `task.cancel()` 重复调用只派发一次 `abort(caller)`；外部 signal 携带 `reason`；真实绘制失败派发 `error` 而非 `abort`。
- 关闭时 `close:start → 活动 abort(close) → close:end`；`close:end` 后无事件；第二次 `close()` 无事件。
- 页面监听器按 `pageIndex` 过滤；`once`、`off`、`signal` 与关闭清理行为。
- 监听器抛错不影响渲染结果和其他监听器；`onListenerError` 自身抛错被吞掉。

测试矩阵和黄金图/集成入口由 [测试方案](./测试方案.md) 统一维护；本文不复制矩阵。常用命令：

```bash
pnpm -C packages/ofdrw-viewer-engine test
pnpm test                         # 根目录脚本，等价于包内全量测试
pnpm -C packages/ofdrw-viewer-engine typecheck
```

## 8. 附录：事件速查

所有事件都有 `type`、`timestamp`、`sequence`；下表只列额外字段。

| 事件 | 额外字段 | 终止 |
|---|---|---|
| `document:open:start` | `operationId`、`sourceKind`、`documentIndex`、`viaContainer` | 否 |
| `document:open:end` | `operationId`、`pageCount`、`version`、`packageSize`、`durationMs` | 是 |
| `document:open:error` | `operationId`、`error`、`durationMs` | 是 |
| `document:open:abort` | `operationId`、`cause:'caller'`、`reason?`、`durationMs` | 是 |
| `document:close:start` | `operationId` | 否 |
| `document:close:end` | `operationId`、`durationMs`、`abortedOperations` | 是 |
| `page:load:start` | `operationId`、`pageIndex` | 否 |
| `page:load:end` | `operationId`、`pageIndex`、`widthMm`、`heightMm`、`durationMs` | 是 |
| `page:load:error` | `operationId`、`pageIndex`、`error`、`durationMs` | 是 |
| `page:load:abort` | `operationId`、`pageIndex`、`cause`、`reason?`、`durationMs` | 是 |
| `page:render:start` | `operationId`、`pageIndex`、`dpi`、`width`、`height` | 否 |
| `page:render:end` | `operationId`、`pageIndex`、`durationMs` | 是 |
| `page:render:error` | `operationId`、`pageIndex`、`error`、`durationMs` | 是 |
| `page:render:abort` | `operationId`、`pageIndex`、`cause`、`reason?`、`durationMs` | 是 |
