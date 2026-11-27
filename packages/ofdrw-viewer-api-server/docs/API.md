# @ofdrw/ofdrw-viewer-api-server 接口文档

本文列出全部接口、请求参数、响应结构与状态码。安装、启动与工作空间说明见 [README.md](../README.md)，配置项见 [配置手册](CONFIG.md)，机器可读描述见 [openapi.json](openapi.json)，设计方案见 [`docs/API服务器设计方案.md`](../../../docs/API服务器设计方案.md)。

## 1. 通用约定

### 1.1 请求

需要文档的接口一律 `POST`，支持两种 `Content-Type`：

**JSON**，文档以 base64 携带：

```http
POST /api/convert HTTP/1.1
Content-Type: application/json

{
  "file": { "name": "invoice.ofd", "base64": "UEsDBBQ..." },
  "params": { "pages": "1-3", "dpi": 150, "format": "png" }
}
```

**表单**，文档以 `file` 字段携带，参数平铺：

```http
POST /api/convert HTTP/1.1
Content-Type: multipart/form-data; boundary=...

file=@invoice.ofd
pages=1-3
dpi=150
format=png
```

表单中布尔值接受 `true`/`false`/`1`/`0`，数字接受十进制整数；无法解析返回 `400 CLI_USAGE`。

### 1.2 响应

- 状态码表达结果；成功响应体即业务对象，不嵌套包装层；
- 错误响应体：

```json
{ "code": "OFD_ENCRYPTED", "message": "文档已加密，API 服务器不支持加密文档", "traceId": "a1b2c3d4" }
```

- `traceId` 与服务端日志行对应，便于排查。

### 1.3 输出格式

由配置 `output.format` 决定，可被请求参数 `output` 覆盖：

| `output` | Content-Type | 说明 |
| --- | --- | --- |
| `json`（默认） | `application/json` | 二进制内容以 base64 内嵌 |
| `zip` | `application/zip` | ZIP 内含 `meta.json` 与产物文件 |
| `multipart` | `multipart/mixed` | 首 part 为 JSON 元数据，后续 part 为二进制 |

单文件接口（附件、媒体、单页图片、作业文件）默认直接返回二进制流，带 `Content-Type`、`Content-Length` 与 `Content-Disposition`；`Accept: application/json` 时返回 `{ id, name, mime, size, base64 }`。

### 1.4 状态码

| 状态码 | 语义 | 错误码 |
| --- | --- | --- |
| `200` | 成功 | — |
| `201` | 作业已创建 | — |
| `204` | 删除成功 | — |
| `207` | 部分页面失败 | `failures` 非空 |
| `400` | 参数非法、页码越界 | `CLI_USAGE`、`CLI_INVALID_PAGES`、`CLI_INVALID_DPI`、`CLI_JOB_TOO_MANY_PAGES` |
| `404` | 路径或作业不存在 | `CLI_JOB_NOT_FOUND` |
| `405` | 方法不允许 | `CLI_METHOD_NOT_ALLOWED` |
| `410` | 作业已过期 | `CLI_JOB_EXPIRED` |
| `412` | 作业存储已满 | `CLI_JOB_STORAGE_FULL` |
| `413` | 上传超限 | `CLI_UPLOAD_TOO_LARGE` |
| `415` | 加密文档或请求体格式不支持 | `OFD_ENCRYPTED`、`CLI_UNSUPPORTED_MEDIA_TYPE` |
| `422` | 文档级失败 | `OFD_INVALID_PACKAGE`、`CRYPTO_INVALID_PACKAGE` |
| `500` | 未知异常 | `CLI_UNEXPECTED` |
| `503` | 并发已满 | `CLI_SERVER_BUSY` |

`/api/verify` 的验证结论不映射为 HTTP 错误，固定返回 `200`，结论看响应体的 `overall`。

## 2. 系统接口

### 2.1 `GET /api/version`

```json
{
  "cli": "0.2.1",
  "engine": "0.2.1",
  "crypto": "0.2.1",
  "node": "v22.14.0",
  "platform": "linux-x64",
  "apiVersion": "1",
  "uptimeSec": 42
}
```

### 2.2 `GET /api/health`

```json
{
  "status": "ok",
  "maxConcurrency": 4,
  "jobs": { "queued": 0, "running": 1, "total": 6 },
  "jobDir": { "path": "/abs/run/jobs", "freeBytes": 10737418240, "usedBytes": 20971520 }
}
```

### 2.3 `GET /api/openapi.json`

返回 OpenAPI 3.1 描述，可直接导入 Swagger UI、Insomnia 等工具。

## 3. 图片转换

### 3.1 `POST /api/convert`

转图片，不限页数，只在内存中处理。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `file` | 文件 / base64 | 必填 | OFD 文档 |
| `pages` | 字符串 | 全部页 | 1 起闭区间，如 `1-3,5` |
| `dpi` | 整数 | `render.dpi`（96） | 正整数 |
| `format` | 枚举 | `render.format`（png） | `png` / `jpeg` / `webp` |
| `quality` | 0–1 | 0.9 | JPEG/WebP 质量 |

响应（`output=json`）：

```json
{
  "pages": [
    { "page": 1, "width": 1240, "height": 1754, "image": "<base64>" }
  ],
  "failures": []
}
```

页数较多时响应体随之增大；需要进度或限制资源时请改用 `/api/jobs`。

## 4. 文字提取

### 4.1 `POST /api/text`

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `file` | 文件 / base64 | 必填 | OFD 文档 |
| `pages` | 字符串 | 全部页 | 1 起闭区间 |
| `dpi` | 整数 | `render.dpi` | 坐标换算精度 |
| `includeChars` | 布尔 | `false` | 是否返回逐字符明细 |
| `includeInvisible` | 布尔 | `false` | 是否包含不可见文字 |
| `includeAnnotations` | 布尔 | `false` | 是否包含注释文字 |

响应固定 `application/json`：

```json
{
  "dpi": 96,
  "pages": [
    {
      "page": 1,
      "width": 1240,
      "height": 1754,
      "items": [
        { "text": "发票代码", "x": 40, "y": 32, "w": 96, "h": 16 }
      ]
    }
  ],
  "warnings": []
}
```

`x`/`y`/`w`/`h` 为包围盒左上角与宽高，单位 px。

## 5. 文档信息

### 5.1 `POST /api/info`

只接收 `file`。

```json
{
  "packageSize": 17210,
  "ofdVersion": "1.0",
  "encrypted": false,
  "layers": [],
  "users": [],
  "signatureCount": 0,
  "integrityPresent": false,
  "document": {
    "version": "1.0",
    "pageCount": 3,
    "pageSizes": [{ "widthMm": 210, "heightMm": 297 }]
  },
  "warnings": []
}
```

### 5.2 `POST /api/outline`

```json
{
  "outline": [ { "title": "第一章", "children": [], "dest": { "pageIndex": 0 } } ],
  "bookmarks": [ { "name": "书签1", "dest": { "pageIndex": 2 } } ],
  "warnings": []
}
```

### 5.3 `POST /api/pages`

不带 `page` 时返回页尺寸列表：

```json
{ "pageCount": 3, "pages": [ { "page": 1, "widthMm": 210, "heightMm": 297 } ], "warnings": [] }
```

带 `page` 时返回该页图片，参数含 `page`、`dpi`、`format`、`quality`，结果为二进制流。

## 6. 附件与媒体

### 6.1 `POST /api/attachments`

不带 `id` 返回索引：

```json
{ "attachments": [ { "id": "3", "name": "发票.xml", "format": "xml", "size": 2048, "mimeType": "text/xml" } ], "warnings": [] }
```

### 6.2 `POST /api/attachments/{id}`

返回附件字节，流式输出。

### 6.3 `POST /api/media`

不带 `id` 返回索引：

```json
{ "media": [ { "id": "12", "kind": "video", "mimeType": "video/mp4", "format": "mp4", "sizeBytes": 1048576, "scope": "document" } ], "warnings": [] }
```

### 6.4 `POST /api/media/{id}`

返回媒体字节，流式输出。

## 7. 签名验证

### 7.1 `POST /api/verify`

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `file` | 文件 / base64 | 必填 | OFD 文档 |
| `roots` | 可重复字段 | `verify.roots` | 信任根证书，PEM 文本 |
| `sm2UserId` | 字符串 | `verify.sm2UserId` | 自定义 SM2 签名 userId |

响应为 `VerificationReport`，结论看 `overall`（`valid`/`invalid`/`unknown`/`unsupported`/`not-applicable`）：

```json
{
  "overall": "valid",
  "package": { "packageSize": 17210, "entryCount": 24 },
  "integrity": { "status": "valid", "fileListCount": 24, "missingFiles": [], "extraFiles": [] },
  "signatures": [],
  "rootsConfigured": false,
  "warnings": [],
  "startedAt": "2026-11-26T15:30:00.000Z",
  "durationMs": 128
}
```

## 8. 作业

### 8.1 `POST /api/jobs`

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `file` | 文件 / base64 | 必填 | OFD 文档 |
| `ops` | 逗号串或数组 | `images` | `images`、`text`、`media`、`attachments`、`all` |
| `pages` | 字符串 | 全部页 | 1 起闭区间 |
| `dpi` | 整数 | `render.dpi` | 正整数 |
| `format` | 枚举 | `render.format` | `png` / `jpeg` / `webp` |
| `quality` | 0–1 | 0.9 | JPEG/WebP 质量 |
| `mediaKind` | 枚举 | 全部 | `video` / `audio`，需 `ops` 含 `media` |
| `mediaId` | 十进制串 | 全部 | 只导出指定资源，需 `ops` 含 `media` |
| `ttlSec` | 整数 | `jobs.ttlSec`（300） | 有效期秒数，`-1` 永不过期 |

返回 `201`：

```json
{
  "jobId": "202611261530N482913",
  "status": "queued",
  "createdAt": "2026-11-26T15:30:00.000Z",
  "expiresAt": "2026-11-26T15:35:00.000Z",
  "metaUrl": "/api/jobs/202611261530N482913/meta.json",
  "resultUrl": "/api/jobs/202611261530N482913/result"
}
```

页数超过 `limits.maxJobPages` 返回 `400 CLI_JOB_TOO_MANY_PAGES`；作业目录占用超过上限返回 `412 CLI_JOB_STORAGE_FULL`。

### 8.2 `GET /api/jobs`

返回作业摘要数组，按创建时间倒序。查询参数 `limit`（正整数）与 `status`（逗号分隔，如 `running,failed`）。

```json
[ { "id": "202611261530N482913", "status": "done", "createdAt": "...", "fileCount": 2 } ]
```

### 8.3 `GET /api/jobs/{id}/meta.json`

```json
{
  "id": "202611261530N482913",
  "status": "done",
  "createdAt": "2026-11-26T15:30:00.000Z",
  "startedAt": "2026-11-26T15:30:00.120Z",
  "finishedAt": "2026-11-26T15:31:02.400Z",
  "ttlSec": 300,
  "expiresAt": "2026-11-26T15:36:02.400Z",
  "params": { "ops": ["images", "text"], "dpi": 150, "format": "png", "pages": "1-3" },
  "source": { "name": "invoice.ofd", "sizeBytes": 17210, "sha256": "..." },
  "progress": { "done": 3, "total": 3, "page": 3 },
  "files": [ { "name": "p001.png", "kind": "image", "size": 123456 } ],
  "failures": [],
  "error": null
}
```

`status` 取值：`queued`、`running`、`done`、`failed`、`cancelled`、`interrupted`。

### 8.4 `GET /api/jobs/{id}/files/{name}`

取单个产物文件，如 `p001.png`、`p001.json`、`media-12.mp4`、`attachment-3.xml`，流式输出。

### 8.5 `GET /api/jobs/{id}/result`

返回作业目录的 ZIP，内含 `meta.json` 与全部产物。

### 8.6 `DELETE /api/jobs/{id}`

取消运行中的作业并删除作业目录，返回 `204`。

作业过期或不存在时，第 8.3–8.5 接口返回 `410 CLI_JOB_EXPIRED` 或 `404 CLI_JOB_NOT_FOUND`。

## 9. 限制与约束

- 加密文档不受支持，上传即返回 `415 OFD_ENCRYPTED`；
- 单请求体上限 `limits.maxUploadBytes`，默认 256 MiB；
- `/api/convert` 不限页数，页数多时响应体较大；
- 同步接口不限流，并发控制只作用于作业；
- 客户端断开时同步请求立即中止并释放资源；
- 服务端不主动因超时断开连接，超时由调用方控制。