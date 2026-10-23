# 变更记录（@ofdrw/ofdrw-viewer-engine）

本文件记录公开 API 与行为变更。当前尚未发布的变更放在 **Unreleased**，发布时才写入版本号；包版本保持 `0.1.0`，本次不升级。

## Unreleased

### 网络/文件获取委托给宿主（breaking）

engine 不再联网、不读取本地文件：它只接受已经可读的字节（`arraybuffer`/`blob`）或宿主实现的 `custom ByteSource`。URL 获取、鉴权、Range、取消、进度、本地文件与小程序临时文件读取全部由 UI/CLI/宿主负责。

设计依据：[docs/网络获取委托设计.md](../../docs/网络获取委托设计.md)；迁移说明：[skills/API.md](./skills/API.md) §3.2、§8.1；平台示例：[skills/SKILL.md](./skills/SKILL.md#来源与字体由宿主提供engine-不联网)。

#### 移除（文档来源）

| 移除项 | 旧 → 新 |
| --- | --- |
| `OFDSource.kind='url'`（含 `url`/`headers` 字段） | 宿主 `fetch` 后传 `{ kind: 'arraybuffer', data }`；大文件/Range 场景传 `{ kind: 'custom', source: ByteSource }` |
| `OFDSource.kind='node-file'`（`path`） | Node 宿主 `readFile` 后传 `arraybuffer`，或 `fs.open` 随机读实现 `custom ByteSource` |
| `OFDSource.kind='wechat-file'`（`filePath`） | 小程序宿主 `wx.downloadFile` + `wx.getFileSystemManager()` 读取后传 `arraybuffer`/`custom` |
| `HttpRangeSource`、`FetchLike`/`FetchResponseLike` 及 HTTP 探测/206/`Content-Range`/`Content-Encoding`/416 辅助 | 迁移到调用方（UI 使用 `HttpByteSource`；其他宿主自行实现） |
| `NodeFileSource`、`WechatFileSource` 占位类 | 宿主实现 `ByteSource` |

运行时兼容：JavaScript 或旧版本调用方传入已删除的 `kind` 时，`OFDDocument.open`/`openZipVirtualContainer` 抛出带迁移提示的 `OFDError`——`url` 为 `OFD_INVALID_PACKAGE`，`node-file`/`wechat-file` 为 `OFD_RENDERER_UNSUPPORTED`。

```ts
// 旧
const doc = await OFDDocument.open({ source: { kind: 'url', url } });

// 新
const response = await fetch(url);
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const doc = await OFDDocument.open({
  source: { kind: 'arraybuffer', data: await response.arrayBuffer() },
});
```

#### 移除（字体来源）

| 移除项 | 旧 → 新 |
| --- | --- |
| `FontInput.url` / `FontInput.path` / `FontInput.filePath` | 宿主读取字节后传 `{ data: ArrayBuffer \| Uint8Array, family? }` |
| `OFDOpenOptions.loadInput`、`FontInputLoader`、`fontInputLoader`、`createFontInputLoader()` | 一次性字体用 `supplementaryFonts`/`defaultFonts: [{ data }]`；按需读取实现 `FontProvider.match()` 并返回 `{ data }` |

`FontProvider.match()` 仍是字体按需读取的唯一入口，且返回的 `{ data }` 可直接使用；engine 不发起字体请求。

```ts
// 旧
supplementaryFonts: [{ url: '/fonts/a.ttf' }]

// 新
const data = await (await fetch('/fonts/a.ttf')).arrayBuffer();
supplementaryFonts: [{ data }]
```

#### 事件与 CLI

- `document:open:start.sourceKind` 类型收窄为 `'arraybuffer' | 'blob' | 'custom'`；URL 文档的运行时值由 `url` 变为 `custom`，依赖该字段的宿主需同步调整。
- CLI 改为由 CLI 读取字体文件字节后以 `supplementaryFonts: [{ data }]` 注入 engine；`--font-dir` 扫描、系统字体发现、realpath 去重、排序与 96 MiB 预算保持不变，输出与改造前一致。engine 不再提供 `loadInput`。
- engine 对非 `data` 的字体来源上报 `W_FONT_MISSING` 并跳过，不中断文档打开。

#### 未变化

- UI 接入 API 不变：`source` 仍可传 URL 字符串或 `{ url, headers? }`；UI 内部创建 `HttpByteSource`，crypto 与 engine 共用同一字节源。
- crypto 的 `CryptoSource.url` 保留，仅服务直接使用 crypto 的宿主；UI 集成改用 `byte-source`。
- 渲染、解析、ZIP 容器、资源限制与 warning 口径不变。
- 包版本保持 `0.1.0`（尚未发布，不升级版本号）。

## 版本历史

Unreleased 见上方章节；下表保留原 API 文档「变更记录」中的已发布历史。

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1.2-r1 | 2026-10-23 | 新增 `VERSION` 常量与 `getVersion()`，供 CLI/UI 与宿主在故障排查时读取引擎版本；版本内置于产物，不依赖 `package.json` |
| v1.1-r12 | 2026-10-23 | 新增页面级事件系统：`OFDEventBus`、`document.events` 与 `document/page` 的 `on/once/off/addEventListener/removeEventListener`；`OFDOpenOptions.eventBus/signal`、`getPage(index,{signal})`、`RenderTask.id`；14 个事件与载荷类型；入口校验失败不派发事件，`close:end` 后静默 |
| v2.0-r1 | 2026-10-23 | 新增 `VirtualContainer`/`VirtualFileMeta`/`VirtualReadOptions`/`VirtualContainerFactory`/`openZipVirtualContainer`/`OpenZipVirtualContainerOptions`；`OFDOpenOptions.source` 保持必填，新增 `OFDOpenFromContainerOptions`（`container` 必填、`source` 可选上下文）与 `OFDDocument.open` 重载；新增 `container`（借用）与 `containerFactory`（engine 拥有）；明确 raw/明文容器边界与 `AbortSignal` 透传；默认 ZIP 行为不变 |
| v1.0-r11 | 2026-10-22 | 新增可选 `OFDOpenOptions.loadInput` / `FontInputLoader`：不传时 Web 默认 `url` fetch、`path`/`filePath` 不支持；Node CLI `--font-dir` 注入 `node:fs` loader，真正读取并展开 TTF/OTF/TTC/OTC，按实际 family 匹配；999.ofd `W_FONT_MISSING` 归零。**（该能力已在 Unreleased 中移除，见上）** |
| v1.0-r10 | 2026-10-22 | 同步 P2：`getPermissions`（只读声明，不做 DRM）、`getAttachments`/`getAttachmentData`（原始字节，不解析内容）、`exportImage.rotation`（仅导出方向，90/270 宽高互换）；登记 `W_PERMISSION_FIELD`/`W_ATTACHMENT_FIELD`/`W_ATTACHMENT_RESOURCE`；`page.renderRegion` 暂不实现/无排期且不导出 |
| v1.0-r9 | 2026-10-22 | 同步 P0/P1 阅读器 UI API：getPageInfos/getOutline/getBookmarks/getMetadata/getSignatureEntries/getSignedValue/page.prepare/page.getTextContent；新增 PageInfo/Outline/Bookmark/签章/SignedValue/Metadata/TextContent 类型与 `CacheOptions.textPages`；明确不解析 ASN.1/不暴露 Seal.esl/P2 延后 |
| v1.0-r8 | 2026-10-22 | 初版公开 API 文档：document/page/render/exportImage、平台注入、错误/warning、限制/缓存、类型附录；建立与 `src/index.ts` 的同步检查；同版增加 `page.exportImage` 与 `encodeImage` |
| v1.0-r7 | 2026-10-22 | 增加 `OFDOpenOptions.createCanvas`（矢量签章/导出） |
