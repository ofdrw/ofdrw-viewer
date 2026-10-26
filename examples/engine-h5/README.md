# engine-h5：单文件 OFD 渲染示例

一个 `index.html` 搞定，不需要构建、也不需要服务端：双击用浏览器打开，选择本地 `.ofd` 文件即可浏览。
样式和示例代码都内联在这个文件里，同目录的 `samples/` 放了两个样例。

引擎通过 jsDelivr CDN 引用 IIFE 压缩产物，加载成功后注册全局变量 `window.OFDRWViewer`：

```html
<script src="https://cdn.jsdelivr.net/npm/@ofdrw/ofdrw-viewer-engine@0.1.3/dist/ofdrw-viewer-engine.min.js"></script>
```

升级引擎时只需把 URL 中的版本号改成目标版本，然后刷新页面。

> 注意：引擎代码来自 CDN，打开页面时需要联网；离线场景请把该 `<script>` 换成本地
> `dist/ofdrw-viewer-engine.min.js` 的路径或内联内容。
