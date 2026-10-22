# examples/web — OFD 渲染引擎最小 Web 验证页

用于在真实浏览器里验证 `ofdrw-viewer-engine` 公共 API 的最小页面，不是阅读器完整 UI。

## 运行

```bash
# 开发服务器（默认 http://127.0.0.1:5178，可用 WEB_PORT 覆盖）
pnpm -C examples/web run dev

# 构建 + preview
pnpm -C examples/web run build
pnpm -C examples/web run preview

# 构建并做 HTTP 200 冒烟（启动 preview，检查首页与内置示例，然后退出）
node examples/web/check.mjs
```

端口默认 `5178`：

```bash
WEB_PORT=5188 pnpm -C examples/web run dev
WEB_PORT=5188 node examples/web/check.mjs
```

## 功能与选择器

| 功能 | `data-testid` | 说明 |
| --- | --- | --- |
| 文件选择 | `file-input` / `drop-zone` | File → `{ kind: 'blob' }`；也支持拖拽 |
| URL 加载 | `url-input` / `url-load` | `{ kind: 'url' }`，依赖 HTTP Range；同源静态文件即可 |
| 内置示例 | `sample-load` | 用户点击后加载 `public/samples/hello.ofd` |
| DPI | `dpi-select` | 96 / 144 / 300，切换后重渲染当前页 |
| 翻页 | `prev-page` / `next-page` / `page-input` / `page-total` | 1-based 页码输入 |
| 渲染/取消 | `render-button` / `cancel-button` | 同 Canvas 的并发由 engine 串行化，页面切换会先 cancel |
| 文档信息 | `file-name` / `page-count` / `page-indicator` / `page-size` / `viewport-size` / `render-time` | 页尺寸单位 mm，视口单位 px |
| 画布 | `page-canvas` | 尺寸按 `page.getViewport({ dpi })` 向上取整 |
| warning | `warning-count` / `warning-list` | 按 code 去重并计数 |
| error | `error-panel` / `error-code` / `error-message` | `OFDError.code` 与 message |
| 字体注入 | `font-input` / `font-list` / `font-clear` | 选择 TTF/OTF/TTC 后自动重载当前文档 |

## URL 源验证注意

- 请使用**不压缩** `.ofd` 的静态服务器（如 `python3 -m http.server 5179 --directory public`
  或 QA 的 `test/acceptance/serve-fixture.mjs`）。`vite preview` 会按 gzip 长度返回
  `Content-Range`，而引擎按解压后的文档字节做 Range 读取，会报 `OFD_INVALID_PACKAGE`
  （`未找到 ZIP EOCD`）；这是服务器压缩与字节 Range 的冲突，不是页面 URL 逻辑。
- 内置 `hello.ofd` 没有内嵌字体：直接加载会渲染空白并产生 `W_FONT_MISSING`（页面不崩溃）；
  用「可选补充字体」注入系统 Noto CJK 后可看到正文，这是 W5 的预期路径。

## 实现说明

- Vite 直接 alias `ofdrw-viewer-engine` 到 `packages/ofdrw-viewer-engine/src/index.ts`，因此不依赖预先 `pnpm install` 的 workspace link，也不修改 engine `dist`。
- 不依赖 CDN、外部字体或远程图片；内置示例仅 5 KB。
- 页面不自动播放或自动加载示例；所有加载都由用户操作触发。
- 取消/翻页时页面会取消上一个 `RenderTask`，并等待其 promise 落定，避免同 Canvas 任务堆积。
- 测试产物目录约定：`test/.artifacts/t13/`（由验收脚本写入，不属于本目录）。