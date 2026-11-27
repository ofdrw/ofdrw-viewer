# @ofdrw/ofdrw-viewer-api-server

[![npm version](https://img.shields.io/npm/v/@ofdrw/ofdrw-viewer-api-server.svg)](https://www.npmjs.com/package/@ofdrw/ofdrw-viewer-api-server)
[![GitHub release](https://img.shields.io/github/v/release/ofdrw/ofdrw-viewer)](https://github.com/ofdrw/ofdrw-viewer/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../../LICENSE)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://nodejs.org/)

📖 配置手册：[docs/CONFIG.md](docs/CONFIG.md) · 接口文档：[docs/API.md](docs/API.md)

## ✨ 功能概述

**ofdrw-viewer-api-server** 把 OFD 解析能力以 HTTP 服务的形式提供：上传文档即可完成**逐页转图片**、**提取文字空间坐标**、**查询文档信息**、**验证签名与防夹带完整性**，并支持把大批量转换作为**持久化作业**提交后异步取结果。

服务不依赖命令行工具，直接对接 [@ofdrw/ofdrw-viewer-engine](../ofdrw-viewer-engine/README.md) 与 [@ofdrw/ofdrw-viewer-crypto](../ofdrw-viewer-crypto/README.md)，默认仅监听本机，启动零配置。

## 📦 安装

两种安装方式，装好后都以同一个命令 `ofdrw-api-server` 启动：

| 方式 | 适用场景 | 需要 Node.js |
| --- | --- | --- |
| 离线二进制 | 内网/离线环境、不想装运行时，解压即用 | 否 |
| npm 全局安装 | 已有 Node.js 环境、需要作为脚本或服务集成 | **>= 22** |

### 离线二进制安装（推荐）

从 [Releases](https://github.com/ofdrw/ofdrw-viewer/releases) 下载与系统匹配的压缩包并解压：

| 平台 | 产物 |
| --- | --- |
| Linux x64 | `ofdrw-viewer-api-server-<版本>-linux-x64-gnu.tar.gz` |
| Linux arm64 | `ofdrw-viewer-api-server-<版本>-linux-arm64-gnu.tar.gz` |
| macOS x64 | `ofdrw-viewer-api-server-<版本>-darwin-x64.tar.gz` |
| macOS arm64 | `ofdrw-viewer-api-server-<版本>-darwin-arm64.tar.gz` |
| Windows x64 | `ofdrw-viewer-api-server-<版本>-win32-x64.zip` |

```bash
tar -xzf ofdrw-viewer-api-server-0.3.0-linux-x64-gnu.tar.gz
cd ofdrw-viewer-api-server-0.3.0-linux-x64-gnu
./ofdrw-api-server --version
```

返回版本号即可认为可用。macOS / Linux 首次运行如提示无执行权限，执行 `chmod +x ofdrw-api-server`。

发行包内已带上默认配置与文档，首次启动会在可执行文件旁自动解压运行时依赖到 `.ofdrw-cache/`（约 80 MB，之后复用）：

```text
ofdrw-viewer-api-server-0.3.0-linux-x64-gnu/
├── ofdrw-api-server[.exe]    可执行文件
├── api-server-config.yaml    出厂默认配置
├── README.md / LICENSE
├── docs/、skills/            接口文档、OpenAPI 描述与调用示例
└── .ofdrw-cache/             首次启动自动创建：解压的运行时依赖（勿手工修改）
```

停止运行后可直接删除 `.ofdrw-cache/`，下次启动会重新解压；升级到新版本时缓存目录按版本区分，可一并清理。

### npm 安装

适合已有 Node.js 环境（**Node.js >= 22**）或需要在应用中内嵌服务的场景。

```bash
npm install -g @ofdrw/ofdrw-viewer-api-server
ofdrw-api-server --version
```

全局安装后可在任意目录直接调用 `ofdrw-api-server`。不想装到全局时也可临时运行：

```bash
npx @ofdrw/ofdrw-viewer-api-server --version
```

需要说明的是，`npm install -g` 没有独立的"可执行文件目录"，服务会把**进程当前工作目录**作为工作区根；库文件与文档位于 `npm root -g` 下的包目录，可只读查看：

```bash
ls "$(npm root -g)/@ofdrw/ofdrw-viewer-api-server"   # dist/、docs/、skills/、api-server-config.yaml
```

#### 作为依赖使用

```bash
npm install @ofdrw/ofdrw-viewer-api-server
```

```ts
import { createLogger, loadConfig, startApiServer } from '@ofdrw/ofdrw-viewer-api-server';

// loadConfig 只解析配置，不创建目录；返回的 config 为生效配置
const loaded = await loadConfig();
if (loaded.errors.length > 0) throw new Error(loaded.errors.join('\n'));

const { logger, close: closeLogger } = await createLogger(loaded.config);
const server = await startApiServer(loaded.config, logger);
console.log(`已启动: ${server.url}`);

// 退出时依次关闭服务与日志
await server.close();
await closeLogger();
```

## 🚀 快速开始 Quick Start

装好后直接执行命令即可启动：

```bash
# 二进制解压目录内
./ofdrw-api-server
# npm 全局安装
ofdrw-api-server
```

输出 `已启动: http://127.0.0.1:7860/api` 即启动成功。

**工作区根默认取进程当前工作目录**，作业目录 `jobs/`、日志目录 `logs/` 都落在其中，与安装方式无关。因此推荐始终显式指定工作区，多实例并行时尤其需要：

```bash
ofdrw-api-server --workdir /srv/ofd-inst-a
```

未指定 `--workdir` 且工作区内没有配置文件时，服务按内置默认值启动，并在工作区根**自动生成一份 `api-server-config.yaml`**（全部为固定取值），同时打印生成的路径。二进制发行包内自带同名配置，会优先被使用。

先确认服务在线：

```bash
curl http://127.0.0.1:7860/api/health
```

停止服务按 `Ctrl+C`（等价 `SIGINT`），服务会中止运行中的作业并优雅退出。

## 🔌 如何使用服务

服务是一组 HTTP 接口，任何能发 HTTP 请求的语言都能调用。所有上传文档的接口都是 `POST`，两种请求格式等价、参数一致：

| 格式 | `Content-Type` | 文档位置 | 适用场景 |
| --- | --- | --- | --- |
| 表单 | `multipart/form-data` | `file` 字段携带文件，其余参数平铺 | curl、脚本、浏览器表单 |
| JSON | `application/json` | `{"file":{"name":"...","base64":"..."},"params":{...}}` | 无文件流 API 的语言与前端 |

响应默认 `json`，二进制内容以 base64 内嵌；可切换为 `zip` 或 `multipart/mixed`。全部参数与字段见 [接口文档](docs/API.md)。

### curl 调用

```bash
BASE=http://127.0.0.1:7860/api

# 健康检查：存活、作业数与作业目录可用空间
curl -s "$BASE/health"

# 转前 3 页为 PNG（表单模式，参数平铺）
curl -s -X POST "$BASE/convert" -F file=@invoice.ofd -F pages=1-3 -F dpi=150 -o convert.json

# 单页图片直接写盘为二进制流
curl -s -X POST "$BASE/pages" -F file=@invoice.ofd -F page=1 -F dpi=150 -o p001.png

# 提取全文文字坐标，单位 px
curl -s -X POST "$BASE/text" -F file=@invoice.ofd > text.json

# 文档信息：页数、版本、加密标志、签名数量
curl -s -X POST "$BASE/info" -F file=@invoice.ofd

# 提交作业（大文档、需要进度或持久化时用）
JOB=$(curl -s -X POST "$BASE/jobs" -F file=@invoice.ofd -F ops=images,text -F ttlSec=3600 \
  | sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p')

# 轮询状态，建议每 1–2 秒一次，status 进入 done/failed/cancelled/interrupted 即停
curl -s "$BASE/jobs/$JOB/meta.json"

# 下载整包并释放空间
curl -s -o "$JOB.zip" "$BASE/jobs/$JOB/result"
curl -s -X DELETE "$BASE/jobs/$JOB"
```

同步接口 `/api/convert` 不限页数，一次可转换整本文档；页数多时响应体较大，需要进度或限制资源时改用作业接口，作业受 `limits.maxJobPages`（默认 5000 页）限制。服务端不主动因超时断开连接，请由调用方设置客户端超时。

### 多语言调用

各语言示例只依赖标准库，覆盖转图、取文字坐标、作业提交与轮询、下载产物、验签：

| 语言 | 入口 |
| --- | --- |
| curl | [examples.md § curl](skills/examples.md#curl) |
| Python | [examples.md § Python](skills/examples.md#python) |
| JavaScript / TypeScript | [examples.md § JavaScript / TypeScript](skills/examples.md#javascript--typescript) |
| Java | [examples.md § Java](skills/examples.md#java) |
| C# | [examples.md § C#](skills/examples.md#c) |
| Go | [examples.md § Go](skills/examples.md#go) |

完整示例文件见 [skills/examples.md](skills/examples.md)，其中也说明了 JSON + base64 与表单两种模式如何互换。

### 错误处理

错误响应体固定为：

```json
{ "code": "CLI_INVALID_PAGES", "message": "页码越界：13（文档共 11 页）", "traceId": "a1b2c3d4" }
```

分支判断请用 `code`；排查问题时把 `traceId` 与服务端日志对照。状态码与错误码对照见 [接口文档 § 状态码](docs/API.md#14-状态码) 与 [智能体 SKILL](skills/SKILL.md#错误处理)。

## 🗂️ 工作空间说明

服务工作在一个**工作区**内：工作区是解析配置、存放作业与写入日志的根目录。

### 工作区根如何确定

| 启动方式 | 工作区根 |
| --- | --- |
| `--workdir /srv/ofd` | `/srv/ofd`（命令行指定，优先级最高） |
| 配置文件里写 `workspace: ./inst-a` | 进程当前工作目录下的 `inst-a` |
| `--config /srv/ofd/api-server-config.yaml` | `/srv/ofd`（配置文件所在目录） |
| 不带以上参数启动，当前目录下有 `api-server-config.yaml` | 进程当前工作目录 |
| 二进制发行包内启动（包内自带配置） | 可执行文件所在目录（配置文件同目录） |
| npm 全局安装、未指定 `--workdir` | 进程当前工作目录（推荐显式写 `--workdir`） |

工作区根一旦确定，本次运行内不再变化；作业目录固定为 `<工作区>/jobs`，配置中的相对路径（`logging.dir`、`render.fontDir`、`verify.roots`）都相对它解析，绝对路径原样使用。`-t` 校验输出会标明工作区的来源。

### 默认布局

```text
<工作区>/
├── api-server-config.yaml    配置文件，启动时自动发现；缺失时首次启动自动生成
├── .ofdrw-cache/             运行时依赖（仅二进制发行版；可删除，下次启动重新解压）
├── jobs/                     作业目录：原始文档、meta.json 与全部产物
│   ├── .lock                 单实例锁
│   ├── .tmp/                 写入中转（用到时创建）
│   ├── .trash/               待删除
│   └── <作业ID>/             单个作业，见下
└── logs/                     日志目录：按天轮转
    ├── api-server.2026-11-27.1.log
    └── api-server.2026-11-26.1.log
```

单个作业目录：

```text
jobs/202611261530N482913/
├── meta.json          作业状态、进度与产物清单
├── source.ofd         上传的原始文档
├── p001.png           逐页图片（ops 含 images）
├── p001.json          该页文字坐标（ops 含 text）
├── media-12.mp4       音视频（ops 含 media）
├── attachment-3.xml   附件（ops 含 attachments）
└── result.zip         首次下载整包时生成
```

### 归属与读写规则

| 内容 | 位置 | 归属 | 说明 |
| --- | --- | --- | --- |
| 可执行文件 | 工作区根或独立安装目录 | 部署方 | 只读；启动时不改写自身 |
| 配置文件 | 工作区根 `api-server-config.yaml` | 部署方 | 只读；`--config` 可指向任意路径 |
| 作业目录 | 固定 `<工作区>/jobs` | 服务独占 | 读写；按作业有效期清理 |
| 日志目录 | `logging.dir`，默认 `<工作区>/logs` | 服务独占 | 只写；按天轮转并保留 `keepDays` 天 |

- 作业目录与日志目录由服务独占，二者不得互相包含，多实例部署须各用独立工作区（`--workdir` 或配置里的 `workspace`）；
- 作业按 `ttlSec` 计算过期时间，运行期每 10 秒巡检删除过期作业；`ttlSec: -1` 永不过期，需自行 `DELETE`；
- 作业目录总占用受 `jobs.maxTotalBytes` 约束，超出时先删最早结束的作业；
- **同步接口只在内存处理**，不写盘、不在工作区留下任何文件；
- 服务不记录文档内容、产物内容与任何凭据。

各目录的详细文件清单、清理策略与部署场景见 [配置手册 § 作业目录与日志](docs/CONFIG.md#6-作业目录与日志)。

## 🧭 接口

### OpenAPI 描述

| 入口 | 说明 |
| --- | --- |
| [docs/openapi.json](docs/openapi.json) | 静态 OpenAPI 3.1 文件，随版本更新，可直接导入 Swagger UI、Postman、Insomnia 或用于生成客户端代码 |
| `GET http://127.0.0.1:7860/api/openapi.json` | 运行期描述，`servers` 为本次实际监听地址与端口 |

### 接口文档

全部字段、请求体结构、响应样例与错误码见 **[docs/API.md](docs/API.md)**；智能体调用流程见 [skills/SKILL.md](skills/SKILL.md)。

### 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/version` | 版本与平台信息 |
| `GET` | `/api/health` | 存活、作业数与作业目录可用空间 |
| `GET` | `/api/openapi.json` | OpenAPI 3.1 描述 |
| `POST` | `/api/convert` | 转图片，不限页数 |
| `POST` | `/api/text` | 提取文字空间坐标 |
| `POST` | `/api/info` | 文档信息与包级摘要 |
| `POST` | `/api/verify` | 签名、证书链与完整性验证 |
| `POST` | `/api/outline` | 目录与书签 |
| `POST` | `/api/pages` | 页尺寸列表或单页图片 |
| `POST` | `/api/attachments` | 附件列表或单文件下载 |
| `POST` | `/api/media` | 音视频列表或单文件下载 |
| `POST` | `/api/jobs` | 创建作业 |
| `GET` | `/api/jobs` | 作业摘要列表 |
| `GET` | `/api/jobs/{id}/meta.json` | 作业状态与文件列表 |
| `GET` | `/api/jobs/{id}/files/{name}` | 单个产物文件 |
| `GET` | `/api/jobs/{id}/result` | 作业目录 ZIP |
| `DELETE` | `/api/jobs/{id}` | 取消并删除作业 |

### 限制

- 加密文档不受支持，上传即返回 `415 OFD_ENCRYPTED`；需要处理加密文档请使用 [ofdrw-viewer-cli](../ofdrw-viewer-cli/README.md)；
- 单请求体上限 `limits.maxUploadBytes`，默认 256 MiB；
- 服务不内建鉴权，默认只监听 `127.0.0.1`；对局域网开放前须由外层网关负责访问控制。

## 🤖 智能体 SKILL

智能体加载 SKILL 后，可以按既定流程启动服务、提交转换与查询任务、下载作业产物，并按状态码处理异常。

入口：[skills/SKILL.md](skills/SKILL.md)

## 🔗 相关链接

- 配置手册：[docs/CONFIG.md](docs/CONFIG.md)
- 接口文档：[docs/API.md](docs/API.md)
- OpenAPI 描述：[docs/openapi.json](docs/openapi.json)
- 调用示例：[skills/examples.md](skills/examples.md)
- 设计方案：[docs/API服务器设计方案.md](../../docs/API服务器设计方案.md)
- 命令行工具：[ofdrw-viewer-cli](../ofdrw-viewer-cli/README.md)
- 渲染引擎：[ofdrw-viewer-engine](../ofdrw-viewer-engine/README.md)
- 密码能力：[ofdrw-viewer-crypto](../ofdrw-viewer-crypto/README.md)

## 📄 许可证

本项目采用 [MIT License](../../LICENSE) 开源。Copyright (c) 2026 Quan Guanyu