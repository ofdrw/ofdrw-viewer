# engine-h5：纯静态 OFD 渲染

无打包、无包管理、无框架：一个 HTML、一个 `app.js`，加上预置的引擎压缩包。打开页面
自动显示内置样例，也可以选择本地 `.ofd` 文件、上一页/下一页。

## 运行

在本目录执行：

```bash
cd examples/engine-h5
node serve.mjs
```

访问 <http://127.0.0.1:5180/>。端口可通过环境变量修改：

```bash
PORT=8080 node serve.mjs
```

不要用 `file://` 直接打开：样例通过 `fetch` 读取，`file://` 下会被浏览器拦截。

## 文件

```
index.html                    页面结构 + 内联样式
app.js                        打开文档、翻页、渲染
serve.mjs                     零依赖静态服务器
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

## 引擎产物

`ofdrw-viewer-engine.min.js` 取自 `@ofdrw/ofdrw-viewer-engine` 的 `dist/`，已内联
fontkit、saxes、fflate 和图片解码器，全局变量为 `OFDRWViewer`。升级引擎时直接替换本目录
的压缩包即可。