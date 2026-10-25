# ofdrw-viewer-cli

[![npm version](https://img.shields.io/npm/v/@ofdrw/ofdrw-viewer-cli)](https://www.npmjs.com/package/@ofdrw/ofdrw-viewer-cli)
[![GitHub release](https://img.shields.io/github/v/release/ofdrw/ofdrw-viewer)](https://github.com/ofdrw/ofdrw-viewer/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-green)](https://nodejs.org/)

[![Linux x86_64](https://img.shields.io/badge/Linux-x86__64-FCC624?logo=linux&logoColor=black)](https://github.com/ofdrw/ofdrw-viewer/releases)
[![Linux ARM64](https://img.shields.io/badge/Linux-ARM64-FCC624?logo=linux&logoColor=black)](https://github.com/ofdrw/ofdrw-viewer/releases)
[![macOS x86_64](https://img.shields.io/badge/macOS-x86__64-000000?logo=apple&logoColor=white)](https://github.com/ofdrw/ofdrw-viewer/releases)
[![macOS ARM64](https://img.shields.io/badge/macOS-ARM64-000000?logo=apple&logoColor=white)](https://github.com/ofdrw/ofdrw-viewer/releases)
[![Windows x86_64](https://img.shields.io/badge/Windows-x86__64-0078D4?logo=windows&logoColor=white)](https://github.com/ofdrw/ofdrw-viewer/releases)
[![Windows ARM64](https://img.shields.io/badge/Windows-ARM64-0078D4?logo=windows&logoColor=white)](https://github.com/ofdrw/ofdrw-viewer/releases)

## ✨ 功能概述

**ofdrw-viewer-cli** 面向终端与自动化场景，将 OFD 文档转换为 **PNG / JPEG / WebP** 图片，支持**加密文档转换**、**文档信息查询**与**签名/完整性验证**，还可按需导出**页面文字空间坐标**，便于脚本与智能体处理 OFD 文档。

![ofdrw-viewer-cli 演示](docs/img/demo.gif)

## 📦 安装

### npm 安装

若您已经具有Node运行环境那么可以直接安装工具：（*运行环境 Node.js >= 22*）

```bash
npm install -g @ofdrw/ofdrw-viewer-cli
```


验证安装：

```bash
ofdrw-viewer-cli --version
```

返回版本号就可认为安装成功。排查问题时可运行 `ofdrw-viewer-cli version`，查看 CLI 自身版本、平台与 Node.js 版本（加 `--json` 输出机器可读结构）。

### 二进制安装

若您没有Node.js环境，可以选择与构建版本二进制安装，方法如下

从 [Releases](https://github.com/ofdrw/ofdrw-viewer/releases) 下载对应平台的压缩包，解压后即可直接运行：

验证工具是否可用：

```bash
./ofdrw-viewer-cli --version
```


## 🚀 如何使用 Quick Start

直接传入 OFD 文件即可按页导出图片：

```bash
ofdrw-viewer-cli input.ofd
```

运行后页导PNG图片至输出工作目录的 `./input/` 。


您还可以指定页码、格式与清晰度，并导出每页文字坐标：

```bash
ofdrw-viewer-cli input.ofd -o out --pages 1-3 --format jpeg --dpi 300 --text
```

可以用 `-o` 指定目录，用 `--pages`、`--format`、`--dpi` 控制页码、格式与清晰度；加 `--text` 会额外导出带像素坐标的页面文字 JSON。

更多参数可以运行 `ofdrw-viewer-cli --help`，请查看 [SKILL.md 命令与参数](skills/SKILL.md#子命令与参数)。

遇到加密文档，或需要查询文档信息、验证签名与完整性时，请参考 [SKILL.md](skills/SKILL.md) 中的对应说明。

## 🤖 智能体 SKILL

智能体加载 SKILL 后，可以按既定流程完成 OFD 转图片、导出文字坐标、处理加密文档、查询文档信息与验证签名，并根据输出和退出码处理异常。

入口：[SKILL.md](skills/SKILL.md)

## 📄 许可证

本项目采用 [MIT License](../../LICENSE) 开源。Copyright (c) 2026 Quan Guanyu