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

## 早期版本

历史版本记录见 [skills/API.md](./skills/API.md) §14「变更记录」。