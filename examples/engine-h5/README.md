# engine-h5：单文件 OFD 渲染示例

一个 `index.html` 搞定，不需要服务端：双击用浏览器打开，选择本地 `.ofd` 文件即可浏览。
引擎、样式和示例代码都内联在这个文件里，同目录的 `samples/` 放了两个样例。

升级引擎时，把 `<script id="engine">` 里 `OFDRW_ENGINE_START` 与 `OFDRW_ENGINE_END`
之间的内容换成 `dist/ofdrw-viewer-engine.min.js` 原文即可（去掉末尾的 sourceMappingURL 注释）。