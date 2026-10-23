# engine-h5：纯静态 OFD 渲染

无打包、无包管理：一个 HTML、一个 `app.js`，加上预置的引擎压缩包。打开页面自动显示内置
样例，也可以选择本地 `.ofd` 文件、上一页/下一页。

## 运行

在仓库根目录用任意静态服务器启动（站点根必须是仓库根），例如：

```bash
python3 -m http.server 5180
# 或 npx serve .
```

访问 <http://127.0.0.1:5180/examples/engine-h5/>。不要用 `file://` 打开，样例通过 `fetch` 读取。

## 文件

```
index.html                    页面结构 + 内联样式
app.js                        打开文档、翻页、渲染
ofdrw-viewer-engine.min.js    引擎 IIFE 压缩产物，挂载 globalThis.OFDRWViewer
samples/                      doc1File.ofd（11 页）、dense-text-perf.ofd（2 页）
```

## 关键代码

```html
<script src="./ofdrw-viewer-engine.min.js"></script>
<script type="module" src="./app.js"></script>
```

```js
const { OFDDocument } = globalThis.OFDRWViewer;

const doc = await OFDDocument.open({ source: { kind: 'arraybuffer', data } });
const page = await doc.getPage(0);
const viewport = page.getViewport({ dpi: 96 });

canvas.width = Math.ceil(viewport.width);
canvas.height = Math.ceil(viewport.height);
await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
```

引擎只画页面内容；画布尺寸、清屏和白色背景由示例负责。

## 引擎产物来源

产物来自 `packages/ofdrw-viewer-engine/dist/`，由 `pnpm -C packages/ofdrw-viewer-engine build`
生成：

- `ofdrw-viewer-engine.min.js`：压缩版，约 710 KB（gzip 260 KB），本示例使用；
- `ofdrw-viewer-engine.js`：未压缩版，便于调试。

两个文件都已内联 fontkit、saxes、fflate 和图片解码器，全局变量均为 `OFDRWViewer`。
更新引擎后重新构建并替换：

```bash
pnpm -C packages/ofdrw-viewer-engine build
cp packages/ofdrw-viewer-engine/dist/ofdrw-viewer-engine.min.js examples/engine-h5/
```