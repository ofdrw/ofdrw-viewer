# OFD API 服务器（ofdrw-viewer-api-server）设计方案

定义 `@ofdrw/ofdrw-viewer-api-server` 如何把 OFD 转图片、空间文本、音视频与附件导出、`info` 查询、`verify` 验签包装成 HTTP 服务。

接口字段与示例见 [`docs/API.md`](../packages/ofdrw-viewer-api-server/docs/API.md)，调用方使用说明见 [`skills/SKILL.md`](../packages/ofdrw-viewer-api-server/skills/SKILL.md)。

## 1. 范围

### 1.1 能力

- 同步接口：转图片、空间文本、`info`、`verify`、目录、页尺寸、附件与媒体列表及单文件下载；只在内存处理，不落盘；
- 异步作业：逐页图片、文本、音视频、附件导出，结果持久化到作业目录；
- 配置：YAML 文件，支持环境变量插值；
- 作业有效期：指定秒数或 `-1` 永不过期。

### 1.2 非目标

- 加密文档：一律拒绝，返回 `415 OFD_ENCRYPTED`，不接收任何凭据；
- 鉴权、多租户、配额、审计；
- 数据库、消息队列、分布式部署；
- 断点续传、分片上传、目录批量、URL 输入、webhook；
- 服务端浏览界面。

## 2. 子包组织

```text
packages/ofdrw-viewer-api-server/
├── package.json             @ofdrw/ofdrw-viewer-api-server
├── api-server-config.yaml   出厂默认配置
├── src/
│   ├── index.ts             入口：startApiServer / loadConfig / runCli
│   ├── cli.ts               子命令参数解析（--config / -t）
│   ├── config.ts            配置结构、YAML 加载、环境变量插值、zod 校验
│   ├── server.ts            Fastify 装配、插件注册、错误处理、优雅退出
│   ├── fastify-app.ts       Fastify 实例类型别名
│   ├── routes/
│   │   ├── index.ts         路由注册与请求上下文
│   │   ├── system.ts        version / health / openapi.json
│   │   ├── documents.ts     convert / text / info / verify / outline
│   │   │                    pages / attachments / media
│   │   └── jobs.ts          作业创建、列表、元信息、文件、ZIP、删除
│   ├── engine/              对接 engine 与 crypto 的适配层
│   │   ├── open.ts          打开文档、拒绝加密包、资源生命周期
│   │   ├── export.ts        单页图片、文本、页尺寸、目录、附件、媒体
│   │   ├── info.ts          包级摘要与文档元数据
│   │   ├── verify.ts        签名与完整性验证
│   │   ├── jobs.ts          作业逐页导出与原子写
│   │   ├── canvas.ts        @napi-rs/canvas 加载与 Canvas/编码适配
│   │   ├── decoder.ts       PNG/JPEG/WebP 解码插件
│   │   ├── fonts.ts         字体目录扫描、系统字体发现、字节读取
│   │   └── source.ts        基于 fs.FileHandle 的只读 ByteSource
│   ├── input.ts             请求解析：JSON(base64) 与 multipart
│   ├── params.ts            参数校验（zod）
│   ├── output.ts            json / zip / multipart 序列化（zip 用 fflate）
│   ├── jobs.ts              作业队列、执行、进度持久化、取消、清理
│   ├── store.ts             作业目录布局、meta.json 原子读写、锁文件
│   ├── logger.ts            pino + pino-roll 日志与访问日志
│   ├── openapi.ts           OpenAPI 3.1 描述
│   ├── errors.ts            错误码 → HTTP 状态码
│   └── version.ts           包版本号
├── docs/API.md              接口文档
├── skills/SKILL.md          调用方 Skill
└── test/                    单元测试与 e2e
```

子包不依赖 `@ofdrw/ofdrw-viewer-cli`；CLI 以 workspace 依赖调用 `startApiServer()`，依赖方向为 `cli → api-server`。子包也可独立运行。

| 依赖 | 用途 |
| --- | --- |
| `@ofdrw/ofdrw-viewer-engine` | 文档打开、页渲染、空间文本、多媒体与附件、目录、动作 |
| `@ofdrw/ofdrw-viewer-crypto` | `inspect` 包级摘要、`verifyOfd` 验签、加密包检测 |
| `@napi-rs/canvas` | 离屏画布、图片编码与解码 |
| `fastify` | HTTP 服务、路由、错误处理、流式响应 |
| `@fastify/multipart` | 流式 multipart 上传解析 |
| `@fastify/cors` | 跨域响应头 |
| `zod` | 配置与请求参数校验 |
| `fflate` | ZIP 打包 |
| `yaml` | 配置解析 |
| `pino`、`pino-roll` | 分级日志与按天轮转 |

## 3. 路由

不需要文档的接口用 `GET`；需要从文档取信息的接口一律 `POST` 并在请求体携带文档；作业创建 `POST`，查询与下载 `GET`，取消 `DELETE`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/version` | CLI / engine / crypto 版本、Node 版本、平台、API 版本 |
| `GET` | `/api/health` | 并发占用、作业数、作业目录路径与可用空间 |
| `GET` | `/api/openapi.json` | OpenAPI 3.1 描述 |
| `POST` | `/api/convert` | 转图片，限 1–10 页，内存中完成 |
| `POST` | `/api/text` | 提取空间文本，返回 JSON |
| `POST` | `/api/info` | 包级摘要与文档元数据 |
| `POST` | `/api/verify` | 完整性 + 签名 + 证书链，返回 `VerificationReport` |
| `POST` | `/api/outline` | 目录树与书签 |
| `POST` | `/api/pages` | 不带 `page` 返回页尺寸列表；带 `page` 返回该页图片 |
| `POST` | `/api/attachments` | 返回附件索引列表 |
| `POST` | `/api/attachments/{id}` | 直接流式返回附件字节 |
| `POST` | `/api/media` | 返回音视频索引列表 |
| `POST` | `/api/media/{id}` | 直接流式返回媒体字节 |
| `POST` | `/api/jobs` | 创建作业，返回 `jobId` |
| `GET` | `/api/jobs` | 作业列表，支持 `?limit=`、`?status=` |
| `GET` | `/api/jobs/{id}/meta.json` | 作业信息 |
| `GET` | `/api/jobs/{id}/files/{name}` | 单个产物文件，流式 |
| `GET` | `/api/jobs/{id}/result` | 作业目录 ZIP |
| `DELETE` | `/api/jobs/{id}` | 取消并删除作业目录 |

未列出的路径返回 `404`，方法不匹配返回 `405` 并带 `Allow` 头。

### 3.1 单文件结果

`/api/attachments/{id}`、`/api/media/{id}`、`/api/pages`（带 `page`）与作业文件下载：

- 默认直接返回二进制流，带 `Content-Type`、`Content-Length`、`Content-Disposition`；
- `Accept` 含 `application/json` 时返回 `{ id, name, mime, size, base64 }`。

### 3.2 各接口响应体

**`/api/text`**

```json
{
  "dpi": 96,
  "pages": [
    { "page": 1, "width": 1240, "height": 1754,
      "items": [ { "text": "发票代码", "x": 40, "y": 32, "w": 96, "h": 16 } ] }
  ],
  "warnings": []
}
```

参数：`file`、`pages`、`dpi`、`includeChars`、`includeInvisible`、`includeAnnotations`。`items` 坐标为 px，保持 engine 返回顺序并跳过空文本；`includeChars` 为 true 时每项附加 `chars`；`width`/`height` 为该 `dpi` 下的设备像素尺寸。返回固定 `application/json`，不受 `output.format` 影响。

**`/api/info`**

```json
{
  "packageSize": 17210, "ofdVersion": "1.0",
  "encrypted": false,
  "layers": [], "users": [], "signatureCount": 0, "integrityPresent": false,
  "document": { "version": "1.0", "pageCount": 3, "pageSizes": [{ "widthMm": 210, "heightMm": 297 }] },
  "warnings": []
}
```

**`/api/verify`** 返回 `VerificationReport`，结论看 `report.overall`，HTTP 状态固定 `200`。

**`/api/outline`**

```json
{ "outline": [ { "title": "第一章", "children": [], "dest": { "pageIndex": 0 } } ],
  "bookmarks": [ { "name": "书签1", "dest": { "pageIndex": 2 } } ],
  "warnings": [] }
```

`outline` 为 engine `OutlineNode` 树，不扁平化。

**`/api/pages`**（不带 `page`）

```json
{ "pageCount": 3, "pages": [ { "page": 1, "widthMm": 210, "heightMm": 297 } ], "warnings": [] }
```

**`/api/attachments`**

```json
{ "attachments": [ { "id": "3", "name": "发票.xml", "format": "xml", "size": 2048, "mimeType": "text/xml" } ], "warnings": [] }
```

**`/api/media`**

```json
{ "media": [ { "id": "12", "kind": "video", "mimeType": "video/mp4", "format": "mp4", "sizeBytes": 1048576, "scope": "document" } ], "warnings": [] }
```

## 4. 请求格式

`POST` 接口支持两种 `Content-Type`，解析后归一为同一内部结构。

JSON，文档走 base64：

```json
{ "file": { "name": "invoice.ofd", "base64": "UEsDBBQ..." },
  "params": { "dpi": 150, "format": "png", "pages": "1-3,5" } }
```

表单，文档走 `file` 字段，其余字段平铺：

```text
file=@invoice.ofd
dpi=150
format=png
pages=1-3,5
```

表单布尔值接受 `true`/`false`/`1`/`0`，数字接受十进制整数，无法解析返回 `400`。

### 4.1 大小限制

- 单请求体上限 `limits.maxUploadBytes`（默认 256 MiB），超限 `413 CLI_UPLOAD_TOO_LARGE`；
- JSON 按 base64 解码后的字节数判定，表单按文件字段字节数判定，其他字段合计上限 1 MiB。

### 4.2 加密文档

文件落盘前检查包结构，存在 `Encryptions.xml` 即返回 `415 OFD_ENCRYPTED`，不创建作业目录、不保留上传文件。

## 5. 响应格式

### 5.1 约定

- 状态码表达结果，不使用 `ok` 包装字段；
- 成功响应体即业务对象，不嵌套 `data`；
- 错误响应体统一为问题详情：

```json
{ "code": "OFD_ENCRYPTED", "message": "文档已加密，API 服务器不支持加密文档", "traceId": "a1b2c3d4" }
```

`code` 沿用 engine、crypto 与 CLI 的错误码；`traceId` 同时写入日志行。

### 5.2 输出格式

由 `output.format` 决定，可被请求参数 `output` 覆盖：

| 值 | Content-Type | 结构 |
| --- | --- | --- |
| `json`（默认） | `application/json` | 二进制内容以 base64 放入对象数组 |
| `zip` | `application/zip` | ZIP 内 `meta.json` 与产物文件 |
| `multipart` | `multipart/mixed` | 首 part 为 JSON 元数据，后续 part 为二进制 |

`/api/convert` 的 `json` 响应体：

```json
{ "pages": [ { "page": 1, "width": 1240, "height": 1754, "image": "<base64>" } ], "failures": [] }
```

`zip` 与 `multipart` 的 `meta.json` 内容与 `json` 响应体一致。

### 5.3 状态码

| 状态码 | 语义 | 错误码 |
| --- | --- | --- |
| `200` | 成功 | — |
| `201` | 作业创建成功 | — |
| `204` | 删除成功，无响应体 | — |
| `207` | 部分页失败，其余成功 | `failures[]` 非空 |
| `400` | 参数或页码非法、同步页数超限 | `CLI_USAGE`、`CLI_INVALID_PAGES`、`CLI_INVALID_DPI`、`CLI_SYNC_PAGE_LIMIT`、`CLI_JOB_TOO_MANY_PAGES` |
| `404` | 路径或作业不存在 | `CLI_JOB_NOT_FOUND` |
| `405` | 方法不允许 | `CLI_METHOD_NOT_ALLOWED` |
| `410` | 作业已过期 | `CLI_JOB_EXPIRED` |
| `412` | 作业存储已满 | `CLI_JOB_STORAGE_FULL` |
| `413` | 上传超限 | `CLI_UPLOAD_TOO_LARGE` |
| `415` | 加密文档或请求体格式不支持 | `OFD_ENCRYPTED`、`CLI_UNSUPPORTED_MEDIA_TYPE` |
| `422` | 文档级失败 | `OFD_INVALID_PACKAGE`、`CRYPTO_INVALID_PACKAGE` |
| `500` | 未知异常 | `CLI_UNEXPECTED` |
| `503` | 并发已满 | `CLI_SERVER_BUSY` |

`verify` 结论不映射为 HTTP 错误。

### 5.4 同步接口约束

- `/api/convert` 单次最多 10 页（`limits.maxSyncPages`），超限返回 `400 CLI_SYNC_PAGE_LIMIT` 并提示改用 `/api/jobs`；
- 其余同步接口不设页数上限；
- 客户端断开时通过 `AbortController` 立即中止渲染并释放内存与句柄；
- 同步接口不限流，并发控制只作用于作业。

## 6. 工作区

工作区是 API 服务器运行所需的完整目录，包含可执行程序、配置文件、日志与作业数据。工作区根按以下顺序确定：`--config` 指定文件所在目录 → 进程的工作目录（`process.cwd()`）；配置中的相对路径一律相对工作区根解析。默认布局：

```text
<工作区>/
├── api-server[.exe]              可执行程序；随包发布的默认配置置于同目录
├── api-server-config.yaml        配置文件，启动时自动发现
├── jobs/                         作业目录（jobs.workDir），持久化作业数据
│   ├── .lock                     单实例锁
│   ├── .tmp/                     写入中转
│   ├── .trash/                   待删除
│   └── <作业ID>/                 见 §6.3
└── logs/                         日志目录（logging.dir）
    ├── api-server.2026-11-26.log
    └── api-server.2026-11-25.log
```

| 内容 | 位置 | 归属 | 说明 |
| --- | --- | --- | --- |
| 可执行程序 | 工作区根，或与工作区根同级的安装目录 | 部署方 | 只读；启动时不改写自身 |
| 配置文件 | 工作区根 `api-server-config.yaml` | 部署方 | 只读；`--config` 可指向任意路径 |
| 作业目录 | `jobs.workDir`，默认 `<工作区>/jobs` | 服务独占 | 读写；按作业有效期清理 |
| 日志目录 | `logging.dir`，默认 `<工作区>/logs` | 服务独占 | 只写；按天轮转并保留 `keepDays` 天 |

规则：

- 工作区根一旦确定不再变化，配置中的相对路径（`jobs.workDir`、`logging.dir`、`render.fontDir`、`verify.roots`）都相对它解析，绝对路径原样使用；
- 作业目录与日志目录由服务独占，二者不得互相包含；
- 服务只写作业目录与日志目录；可执行程序与配置文件只读；
- 同步接口只在内存处理，不在工作区留下任何文件。

### 6.1 配置文件与启动

```bash
ofdrw-viewer-cli api-server                       # 读默认配置
ofdrw-viewer-cli api-server --config ./prod.yaml  # 指定配置
ofdrw-viewer-cli api-server -t                    # 只校验配置，不启动
```

- 配置只从 YAML 读取；查找顺序为 `--config` 指定路径 → 工作区根 `api-server-config.yaml` → 可执行文件同目录 `api-server-config.yaml` → 内置默认；
- `--config` 指定文件不存在为错误（退出 1）；
- 端口被占用直接报错退出（`CLI_SERVER_PORT_IN_USE`，退出码 2），不顺延；
- 启动后打印一行 `已启动: http://<host>:<port>/api`。

### 6.2 配置项

```yaml
server:
  host: ${OFDRW_VIEWER_API_HOST:-127.0.0.1}
  port: ${OFDRW_VIEWER_API_PORT:-7860}
  maxConcurrency: 4
  requestTimeoutSec: 120
limits:
  maxUploadBytes: 268435456
  maxJobPages: 5000
  maxSyncPages: 10
jobs:
  workDir: ./jobs
  timeoutSec: 600
  ttlSec: 300
  maxConcurrentJobs: 2
  maxTotalBytes: 21474836480
output:
  format: json
render:
  format: png
  dpi: 96
  fontDir: null
  systemFonts: true
verify:
  roots: []
  sm2UserId: null
logging:
  level: info
  dir: ./logs
  keepDays: 7
  accessLog: true
```

环境变量插值：允许 `${VAR}` 与 `${VAR:-默认值}`，前者在变量未设置时报 `CLI_CONFIG_ENV_MISSING`，后者在未设置或为空时取默认值。仅对字符串标量插值，插值结果按字段类型转换。

### 6.3 作业目录内容

作业目录由 `jobs.workDir` 指定，是唯一持久化作业数据的位置：

```text
<工作区>/
└── jobs/
    ├── .lock                      单实例锁
    ├── .tmp/                      写入中转
    ├── .trash/                    待删除
    └── <作业ID>/
        ├── meta.json
        ├── source.ofd
        ├── p001.png
        ├── p001.json
        ├── media-12.mp4
        ├── attachment-3.xml
        └── result.zip
```

| 文件 | 产生时机 | 内容 | 生命周期 |
| --- | --- | --- | --- |
| `.lock` | 服务启动 | `{ pid, hostname, startedAt }` | 进程退出时删除，启动时校验 pid |
| `.tmp/` | 运行期 | 上传中转、zip 生成中的临时文件 | 成功后 `rename` 到目标；启动时清空，巡检清理超过 1 小时的残留 |
| `.trash/` | 清理时 | 待删除的作业目录 | 删除完成后移除；启动时清空 |
| `meta.json` | 创建时写入，状态与进度变化时原子更新 | 作业信息（§7.3） | 与作业目录同寿命 |
| `source.ofd` | 创建时 | 上传的原始文档，文件名固定 | 与作业目录同寿命，作业结束后保留 |
| `p<NNN>.<ext>` | `ops` 含 `images` | 逐页图片 | 与作业目录同寿命 |
| `p<NNN>.json` | `ops` 含 `text` | 该页文本数组，与 `/api/text` 的 `items` 同构 | 与作业目录同寿命 |
| `media-<id>.<ext>` | `ops` 含 `media` | 音视频字节 | 与作业目录同寿命 |
| `attachment-<id>.<ext>` | `ops` 含 `attachments` | 附件字节 | 与作业目录同寿命 |
| `result.zip` | 首次 `GET /result` | 作业目录快照，不含自身 | 文件列表变化后失效，下次请求重建 |

- 目录不存在时递归创建，不可写则启动失败（`CLI_CONFIG_WORKDIR`）；
- 由服务独占使用，启动时无法识别为作业的子目录只记日志、不删除；
- 总占用受 `jobs.maxTotalBytes` 约束，超出时按创建时间从旧到新删除已结束作业，仍不足则拒绝新作业（`412 CLI_JOB_STORAGE_FULL`）；
- 文件名只由服务端生成，字符集 `[A-Za-z0-9._-]`，不使用客户端名称；
- 上传先写入 `.tmp/`，校验通过后 `rename` 为 `<id>/source.ofd`；删除统一走“移入 `.trash/` → 异步删除”。

### 6.4 日志目录内容

日志目录由 `logging.dir` 指定，与作业目录严格分离：

- 不存在时递归创建，不可写则启动失败（`CLI_CONFIG_LOGDIR`）；运行期单次写入失败则告警并降级为仅 stdout；
- 文件名为 `api-server.<YYYY-MM-DD>.log`，不做按大小切分；
- 跨天自动切换；启动时扫描 `api-server.*.log`，删除修改时间早于 `keepDays` 的文件，其他文件不动；
- 文件内为 JSON 行，含 `time`/`level`/`traceId`/`msg` 与结构化字段；stdout 输出人类可读版本；
- POSIX 下目录 `0700`、文件 `0640`；
- 多实例需各自配置不同的工作区或至少不同的 `jobs.workDir`、`logging.dir`。

### 6.5 校验

`-t` 与启动执行同一套校验：YAML 语法、未知字段、字段类型、取值范围、工作区根、作业目录与日志目录可写性。

```text
配置来源: /abs/api-server/api-server-config.yaml（含 2 个环境变量插值）
工作区: /abs/api-server（相对路径基准）
服务器: http://127.0.0.1:7860（并发 4，请求超时 120s）
上传上限: 256 MiB
作业目录: /abs/api-server/jobs（超时 600s，默认有效期 300s，并发 2，上限 20 GiB）
输出: json
日志目录: /abs/api-server/logs（级别 info，保留 7 天，访问日志开）
校验结果: 通过
```

校验失败逐条输出错误并退出 1。

### 6.6 日志内容

访问日志，每请求一行：

```json
{ "traceId": "a1b2c3d4", "method": "POST", "path": "/api/convert", "status": 200,
  "durationMs": 1830, "bytesIn": 17210, "bytesOut": 482113, "ip": "127.0.0.1" }
```

接口事件日志：路由开始、结束与失败记录 `operation`、`traceId`、耗时与错误码；engine 与 crypto 的 warning 以 `warn` 级记录。

运行过程日志：启动与关闭、作业生命周期、目录清理、并发变化。

不记录文档内容、产物内容与凭据。

## 7. 作业

### 7.1 作业 ID

格式 `<YYYYMMDDHHmm>N<随机数>`，随机数 6 位十进制，同一分钟内碰撞则递增重试。字符集为 `[0-9]` 与固定大写 `N`。

```text
202611261530N482913
```

### 7.2 创建参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `file` | 文件 / base64 | 必填 | OFD 原始文档 |
| `ops` | 数组或逗号串 | `["images"]` | `images`、`text`、`media`、`attachments`、`all` |
| `pages` | 字符串 | 全部页 | 如 `1-3,5` |
| `dpi` | 整数 | `render.dpi` | 正整数，超过 1200 产生 warning |
| `format` | 枚举 | `render.format` | `png` / `jpeg` / `webp` |
| `quality` | 0–1 | 0.9 | JPEG/WebP 质量 |
| `mediaKind` | 枚举 | null | `video` / `audio`，需 `ops` 含 `media` |
| `mediaId` | 十进制串 | null | 只导出指定资源，需 `ops` 含 `media` |
| `ttlSec` | 整数 | `jobs.ttlSec` | 有效期秒数，`-1` 永不过期 |

`text`、`media` 接受布尔平铺写法，等价于加入 `ops`。

### 7.3 `meta.json`

```json
{
  "id": "202611261530N482913",
  "status": "done",
  "createdAt": "2026-11-26T15:30:00.000Z",
  "startedAt": "2026-11-26T15:30:00.120Z",
  "finishedAt": "2026-11-26T15:31:02.400Z",
  "ttlSec": 300,
  "expiresAt": "2026-11-26T15:36:02.400Z",
  "owner": { "pid": 41233, "hostname": "ofd-host" },
  "params": { "ops": ["images", "text"], "dpi": 150, "format": "png", "pages": "1-3" },
  "source": { "name": "invoice.ofd", "sizeBytes": 17210, "sha256": "..." },
  "progress": { "done": 3, "total": 3, "page": 3 },
  "files": [
    { "name": "p001.png", "kind": "image", "size": 123456 },
    { "name": "p001.json", "kind": "text", "size": 2048 }
  ],
  "failures": [ { "page": 2, "code": "OFD_RENDER_FAILED", "message": "..." } ],
  "error": null
}
```

- `status`：`queued` | `running` | `done` | `failed` | `cancelled` | `interrupted`；
- `ttlSec: -1` 时 `expiresAt` 为 `null`；
- `owner` 用于重启后识别失效作业；
- 状态与进度变化后原子更新（临时文件 + `rename`）。

### 7.4 执行

- 创建时校验页数超过 `limits.maxJobPages` 返回 `400 CLI_JOB_TOO_MANY_PAGES`，占用超过 `jobs.maxTotalBytes` 返回 `412 CLI_JOB_STORAGE_FULL`；
- 作业进入 FIFO 队列，最多 `jobs.maxConcurrentJobs` 个同时执行；
- 单作业超时 `jobs.timeoutSec`，超时中止并以 `failed` + `CLI_JOB_TIMEOUT` 结束；
- 页面串行处理，进度按页写回 `meta.json`；
- `DELETE` 通过 `AbortController` 中止并置为 `cancelled`。

### 7.5 列表

`GET /api/jobs` 返回 `meta.json` 摘要数组，按 `createdAt` 倒序，支持 `limit`（正整数）与 `status`（逗号分隔）过滤。

### 7.6 重启与清理

启动时：

1. 获取 `jobs/.lock`，被活跃进程持有则拒绝启动（`CLI_SERVER_LOCKED`），pid 失效则接管；
2. 扫描子目录：`meta.json` 缺失或损坏的移入 `.trash/` 后删除；`status` 为 `queued`/`running` 且 `owner.pid` 失效的置为 `interrupted`（`CLI_JOB_INTERRUPTED`）；`expiresAt` 已过的删除。

运行期每 10 秒巡检一次过期作业。

进程退出（`SIGINT`/`SIGTERM`）时中止运行中作业并写回 `interrupted`，不删除作业目录。

### 7.7 过期

- 作业结束（`done`/`failed`/`cancelled`/`interrupted`）时计算 `expiresAt = finishedAt + ttlSec × 1000`；
- 过期目录删除后，`meta.json`、`files`、`result` 返回 `410 CLI_JOB_EXPIRED`。

## 8. 与 CLI 的一致性

- 产物语义一致：图片按指定格式与 DPI 白底导出，文本项为 `text`/`x`/`y`/`w`/`h`（px），媒体与附件按 `<kind>-<id>.<ext>` 命名；
- 错误码沿用 engine、crypto 与 CLI 的原始码；
- CLI 退出码在 HTTP 中改用状态码表达（§5.3）；
- warning 通过响应体 `warnings` 返回，不改变状态码。

## 9. 验证方式

- 单元测试：配置加载与插值、字段校验、请求解析、三种输出、作业 ID、`meta.json` 读写、过期与恢复判定、日志轮转；
- e2e：以配置 `port: 0` 起服务并读取启动日志中的实际端口，覆盖各路由成功与失败、加密文档拒绝、同步页数上限、作业创建→轮询→取文件→下载 ZIP→删除；
- 独立性：子包不得 import `@ofdrw/ofdrw-viewer-cli`。

```bash
pnpm -C packages/ofdrw-viewer-api-server typecheck
pnpm -C packages/ofdrw-viewer-api-server test
```