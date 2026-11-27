---
name: ofdrw-viewer-api-server
description: Serve OFD parsing and verification over HTTP with the ofdrw-api-server executable. Upload a document to convert pages to PNG/JPEG/WebP, extract pixel-coordinate text, read package metadata, page sizes, outline, attachments and embedded media, and verify anti-smuggling integrity plus signatures. Use sync endpoints for small work (max 10 pages, no disk writes) and persistent jobs with TTL for large or tracked work. Use when a frontend, script, or service needs OFD rendering or verification without the command line. Covers request formats (multipart or JSON+base64), response formats, status codes, and the unsupported case of encrypted documents.
---

# OFD HTTP 解析服务（ofdrw-viewer-api-server）

上传 OFD 即可转图片、提取文字坐标、查询文档信息、下载附件与音视频、验证签名与完整性。批量或耗时转换提交为**持久化作业**，作业目录保留原文档、`meta.json` 与全部产物。

三条硬约束，先记住再动手：

1. **加密文档不受支持**：返回 `415 OFD_ENCRYPTED`，改用 `ofdrw-viewer-cli`。
2. **同步转图不限页数**：`/api/convert` 一次可转整本文档，页数多时响应体很大，需要进度或控制资源时改用作业（作业受 `maxJobPages` 限制，超出返回 `400 CLI_JOB_TOO_MANY_PAGES`）。服务端不主动因超时断开连接，客户端需自行设置超时。
3. **无鉴权**：默认只监听 `127.0.0.1`，对局域网开放前须由外层网关控制访问。

## 启动

```bash
ofdrw-api-server                     # 读默认配置
ofdrw-api-server --config ./c.yaml   # 指定配置
ofdrw-api-server -t                  # 只校验配置，不启动
```

启动后输出 `已启动: http://127.0.0.1:7860/api`，后续请求以此为 `BASE`。

配置为 YAML；字符串值可写 `${VAR}` 与 `${VAR:-默认值}` 从环境变量取值，出厂配置本身全部是固定值。工作区根依次取 `--workdir` → 配置里的 `workspace` → 配置文件所在目录 → 进程工作目录，作业目录固定为 `<工作区>/jobs`。未指定 `--workdir` 且工作区里没有配置文件时，启动会自动生成一份 `api-server-config.yaml`（`-t` 不生成）。

找不到可执行文件时，按顺序试：`$OFDRW_VIEWER_API_SERVER` → `command -v ofdrw-api-server` → `packages/ofdrw-viewer-api-server/dist/bin.js`。都没有就让用户安装 `@ofdrw/ofdrw-viewer-api-server`（Node.js >= 22），不要下载来源不明的二进制。

## 请求与响应约定

所有摄取文档的接口均为 `POST`，两种格式等价、参数一致：

- **表单**：`file` 字段携带文档，其余参数平铺；
- **JSON**：`{ "file": { "name": "...", "base64": "..." }, "params": { ... } }`。

响应由请求参数 `output` 决定（可被配置 `output.format` 设为默认）：`json`（默认，二进制转 base64 内嵌）、`zip`、`multipart`。单文件接口（附件、媒体、单页图片、作业产物）默认返回二进制流，带 `Content-Disposition`；加 `Accept: application/json` 时返回 `{ id, name, mime, size, base64 }`。

错误体固定为 `{ "code": "...", "message": "...", "traceId": "..." }`，分支判断用 `code`。

## 接口清单

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/version`、`/api/health` | 版本；存活与作业目录可用空间 |
| `GET` | `/api/openapi.json` | OpenAPI 3.1 描述 |
| `POST` | `/api/convert` | 转图片，不限页数 |
| `POST` | `/api/text` | 文字包围盒（px） |
| `POST` | `/api/info` | 页数、版本、签名数、加密标志 |
| `POST` | `/api/outline` | 目录与书签 |
| `POST` | `/api/pages` | 不带 `page` 返回页尺寸；带 `page` 返回该页图片 |
| `POST` | `/api/attachments` | 不带 `id` 返回索引；`/api/attachments/{id}` 取字节 |
| `POST` | `/api/media` | 不带 `id` 返回索引；`/api/media/{id}` 取字节 |
| `POST` | `/api/verify` | 签名与防夹带完整性 |
| `POST` | `/api/jobs` | 创建作业（`201`） |
| `GET` | `/api/jobs` | 作业摘要列表（`limit`、`status` 过滤） |
| `GET` | `/api/jobs/{id}/meta.json` | 状态、进度、产物清单 |
| `GET` | `/api/jobs/{id}/files/{name}` | 单个产物，如 `p001.png` |
| `GET` | `/api/jobs/{id}/result` | 整包 ZIP |
| `DELETE` | `/api/jobs/{id}` | 取消并删除（`204`） |

## 路由规则

| 情况 | 做法 |
| --- | --- |
| 结果即时返回、无需落盘 | 同步接口，零磁盘占用（页数多时响应体较大） |
| 页数更多，或需要进度与持久化 | `POST /api/jobs`，`ops` 取 `images`/`text`/`media`/`attachments`/`all`，`ttlSec` 默认 300、`-1` 永不过期 |
| 只做验签 | `POST /api/verify`，HTTP 恒为 `200` |
| 文档已加密 | 不用本服务，改用 `ofdrw-viewer-cli` |

作业轮询间隔 1–2 秒，看 `status` 进入 `done`/`failed`/`cancelled`/`interrupted` 即停；进度看 `progress.done` 与 `progress.total`（已处理页数）。用完 `DELETE` 释放空间。

`/api/verify` 结论看 `overall`：`valid` 通过；`unknown` 表示签名数学上通过但未配置信任根（需传 `roots` 或配置 `verify.roots`）；`invalid` 失败。

## 错误处理

| 状态码 | 处理 |
| --- | --- |
| `400` | 参数错误：检查页码、DPI、格式 |
| `404` | 路径或作业不存在 |
| `410` | 作业已过期，重新提交 |
| `412` | 作业存储已满，先删旧作业 |
| `413` | 超过上传上限（默认 256 MiB） |
| `415` | 加密文档或请求体格式不支持 |
| `422` | 文档损坏或不是 OFD |
| `500` | 记录 `traceId` 反馈给用户 |
| `503` | 并发已满，稍后重试 |

`207` 表示部分页面失败，看响应体 `failures`。服务端不接收任何口令或私钥，日志不记录文档与产物内容。

## 调用示例

多语言完整示例见 [examples.md](./examples.md)：curl、Python、JavaScript/TypeScript、Java、C#、Go，均用标准库，覆盖转图、取文字坐标、作业提交与轮询、验签。

```bash
BASE=http://127.0.0.1:7860/api
curl -s "$BASE/health"
curl -s -X POST "$BASE/convert" -F file=@input.ofd -F pages=1-5 -F dpi=150   # 图片在 pages[].image
curl -s -X POST "$BASE/info"    -F file=@input.ofd
curl -s -X POST "$BASE/jobs"    -F file=@input.ofd -F ops=images,text -F ttlSec=3600
curl -s -X POST "$BASE/verify"  -F file=@signed.ofd -F roots=@root-ca.pem
```

## 参考

- 全部字段、响应样例、状态码：[API.md](../docs/API.md)
- 安装、启动、工作空间说明：[README.md](../README.md)
- 配置项与部署场景：[CONFIG.md](../docs/CONFIG.md)
- 加密文档与单机转换：[ofdrw-viewer-cli](../../ofdrw-viewer-cli/skills/SKILL.md)