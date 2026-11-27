# ofdrw-viewer-api-server

[![npm version](https://img.shields.io/npm/v/@ofdrw/ofdrw-viewer-api-server.svg)](https://www.npmjs.com/package/@ofdrw/ofdrw-viewer-api-server)
[![GitHub release](https://img.shields.io/github/v/release/ofdrw/ofdrw-viewer)](https://github.com/ofdrw/ofdrw-viewer/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../../LICENSE)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://nodejs.org/)

📖 配置手册：[docs/CONFIG.md](docs/CONFIG.md) · 接口文档：[docs/API.md](docs/API.md)

## ✨ 功能概述

**ofdrw-viewer-api-server** 解决多种不同开发栈和应用场景下的 OFD 可视化和解析需求，把 OFD 解析能力以 HTTP 服务的形式提供：上传文档即可完成**逐页转图片**、**提取文字空间坐标**、**查询文档信息**、**验证签名与防夹带完整性**，并支持把大批量转换作为**持久化作业**提交后异步取结果。

## 📦 安装

### 二进制安装（推荐）

从 [Releases](https://github.com/ofdrw/ofdrw-viewer/releases) 下载对应平台的压缩包并解压（以 Linux x64 为例）：

```bash
tar -xzf ofdrw-viewer-api-server-0.3.0-linux-x64-gnu.tar.gz
cd ofdrw-viewer-api-server-0.3.0-linux-x64-gnu
```

macOS / Linux 首次运行如提示无执行权限，执行 `chmod +x ofdrw-api-server`。目前提供 linux-x64-gnu、linux-arm64-gnu、darwin-x64、darwin-arm64、win32-x64 五个平台产物。

验证安装，返回版本号即可认为可用：

```bash
./ofdrw-api-server --version
```

发行包内已带默认配置与文档，首次启动会在可执行文件旁自动解压运行时依赖到 `.ofdrw-cache/`（可删除，下次启动重新解压）。

### npm 安装

适合已有 **Node.js >= 22** 的环境。

```bash
npm install -g @ofdrw/ofdrw-viewer-api-server
```

全局安装后即可在任意目录调用 `ofdrw-api-server`；不想装到全局时可临时运行 `npx @ofdrw/ofdrw-viewer-api-server`。

验证安装，返回版本号即可认为可用：

```bash
ofdrw-api-server --version
```

与二进制发行版不同，**npm 安装没有独立的可执行文件目录，工作区根取进程当前工作目录，因此推荐启动时显式指定**：

```bash
ofdrw-api-server --workdir /srv/ofd
```

## 🚀 快速开始 Quick Start

装好后直接执行命令即可启动（二进制在解压目录内用 `./ofdrw-api-server`，npm 全局安装直接 `ofdrw-api-server`）。推荐显式指定工作区，作业目录 `jobs/` 与日志目录 `logs/` 都落在其中：

```bash
ofdrw-api-server --workdir /srv/ofd-inst-a
```

输出 `已启动: http://127.0.0.1:7860/api` 即启动成功。工作区根默认取进程当前工作目录，多实例并行时须各用独立工作区。

先确认服务在线：

```bash
curl http://127.0.0.1:7860/api/health
```

更多服务配置见 [配置手册](docs/CONFIG.md)。

## 🔌 如何使用服务

服务是一组 HTTP 接口，任何语言都能调用，最小示例（转第 1 页为 PNG）：

```bash
curl -s -X POST http://127.0.0.1:7860/api/convert -F file=@invoice.ofd -F pages=1 -F dpi=150 -o convert.json
```

curl、Python、JavaScript、Java、C#、Go 的完整多语言示例见 [skills/examples.md](skills/examples.md)。

## 🧭 接口

全部接口、参数、响应结构与状态码见 [接口文档](docs/API.md)，机器可读描述见 [docs/openapi.json](docs/openapi.json)（运行期同路径 `GET /api/openapi.json`）。

## 🤖 智能体 SKILL

智能体加载 SKILL 后，可以按既定流程启动服务、提交转换与查询任务、下载作业产物，并按状态码处理异常。

入口：[skills/SKILL.md](skills/SKILL.md)

## 📄 许可证

本项目采用 [MIT License](../../LICENSE) 开源。Copyright (c) 2026 Quan Guanyu