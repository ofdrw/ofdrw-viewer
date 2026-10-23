# viewer-ui-react：React 19 最小接入

用 Vite + React 19 挂载 `@ofdrw/ofdrw-viewer-ui/react`，阅读器自带工具栏、侧栏、缩放、查找等功能。

## 运行

```bash
cd examples/viewer-ui-react
npm install
npm run dev
```

访问 <http://127.0.0.1:5182/>。页面自动打开 `public/samples/doc1File.ofd`（11 页），也可以
选择本地 OFD 文件。

## URI 参数预览（`?file=` / `?base64=`）

示例已支持不传 `source` 的预览：URL 带 `?file=` 或 `?base64=` 时不自动加载内置样例，由
阅读器从查询参数解析来源；显式 `source`/`open(source)` 仍优先于查询参数。

```text
# 打开示例自带的样例（相对路径按当前页面解析）
http://127.0.0.1:5182/?file=samples%2Fdoc1File.ofd

# 打开同源 API（把 /api/ofd/123.ofd 作为相对路由）
http://127.0.0.1:5182/?file=%2Fapi%2Fofd%2F123.ofd

# 打开绝对 http(s) 地址（目标服务需允许 CORS 与 Range）
http://127.0.0.1:5182/?file=https%3A%2F%2Ffiles.example.com%2Fofd%2Fdemo.ofd
```

`file` 的值必须是目标地址的 `encodeURIComponent` 结果；含中文/空格时也先编码再拼接：

```js
const target = new URL('/api/ofd/发票 2026.ofd', location.href).href;
const previewUrl = `${location.origin}${location.pathname}?file=${encodeURIComponent(target)}`;
console.log(previewUrl);
```

`?base64=` 支持纯 base64 或 `data:application/ofd;base64,...`，默认上限 64 MiB；可用下面的
命令生成链接（`demo.ofd` 换成实际文件）：

```bash
B64=$(base64 -w0 demo.ofd)
node -e 'console.log("http://127.0.0.1:5182/?base64=" + encodeURIComponent(process.argv[1]))' "$B64"
```

`file` 只接受 `http(s)`，`file://` 不支持；base64 会进入浏览器历史/服务器日志，**敏感文档
不要用查询参数预览**。完整规则见
[UI SKILL 通过 URI 参数预览](../../packages/ofdrw-viewer-ui/skills/SKILL.md#通过-uri-参数预览)。

## 关键代码

```jsx
import { OFDViewer } from '@ofdrw/ofdrw-viewer-ui/react';

const [source, setSource] = useState(null);
setSource(await (await fetch('samples/doc1File.ofd')).arrayBuffer());

return <OFDViewer source={source} />;
```

`source` 换成新的 ArrayBuffer 就会打开新文档；阅读器容器需要有确定高度，示例在
`App.jsx` 中用 `height: 100%` 占满视口。

## npm 包未发布时

`package.json` 按正式发布后的方式引用 `@ofdrw/ofdrw-viewer-ui@^0.1.0`。发布前本地调试，
把依赖临时改成：

```json
"@ofdrw/ofdrw-viewer-ui": "file:../../packages/ofdrw-viewer-ui"
```

阅读器依赖的 engine 由 UI 包自身解析。调试结束改回 npm 版本号，不要提交本地路径。