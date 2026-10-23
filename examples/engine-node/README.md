# engine-node：Node.js 逐页导出 PNG

用 `@napi-rs/canvas` 提供 Canvas 和图片解码，把 OFD 每一页导出为 PNG。

## 运行

```bash
cd examples/engine-node
npm install
npm run dev
```

默认读取 `samples/doc1File.ofd`（11 页），输出到 `out/page-1.png` … `out/page-11.png`。

自定义输入/输出：

```bash
node render.mjs samples/dense-text-perf.ofd out
node render.mjs /path/to/input.ofd /path/to/output
```

输出固定为 144 DPI。

## 关键代码

```js
const doc = await OFDDocument.open({
  source: { kind: 'arraybuffer', data },
  createCanvas,                    // @napi-rs/canvas
  imageDecoders,                   // PNG/JPEG 解码
  encodeImage: (canvas) => canvas.toBuffer('image/png'),
});

for (let i = 0; i < doc.pageCount; i += 1) {
  const result = await (await doc.getPage(i)).exportImage({ dpi: 144 });
  await writeFile(`out/page-${i + 1}.png`, result.data);
}
await doc.close();
```

## npm 包未发布时

`package.json` 按正式发布后的方式引用 `@ofdrw/ofdrw-viewer-engine@^0.1.0`。发布前本地调试，
把依赖临时改成：

```json
"@ofdrw/ofdrw-viewer-engine": "file:../../packages/ofdrw-viewer-engine"
```

安装完成后即可运行；调试结束改回 npm 版本号，不要提交本地路径。