# ofdrw-viewer-cli 构建与发布

本文说明如何为各平台构建 `ofdrw-viewer-cli` 自包含可执行文件。发布矩阵、Node 版本和平台限制以本文为准。

## 1. 结论

- 采用 Node SEA（Single Executable Application）：每个产物内嵌 Node 运行时、CLI/engine JS 与当前平台的 `@napi-rs/canvas` 原生模块。
- 一平台一架构一产物，不做 universal binary，不做跨平台交叉构建。
- 支持矩阵固定为 6 个目标；国产 Linux ARM64 复用 `linux-arm64-gnu` 产物，但需在目标发行版上验收。
- 所有 ARM 目标均为 ARM64（aarch64）；不提供 32 位 ARM / ARMv7 / armhf 产物。
- 不支持 LoongArch（龙芯）：Node 与 canvas 生态均缺少可用预编译/稳定 SEA 支持。
- macOS 与 Windows 暂不签名、不公证。

## 2. 支持矩阵

| 目标 | 产物后缀 | 构建 runner | 说明 |
|---|---|---|---|
| Linux x86_64 glibc | `linux-x64-gnu` | `ubuntu-24.04` | GitHub 托管 x64 runner |
| Linux ARM64 glibc | `linux-arm64-gnu` | `ubuntu-24.04-arm` | 国产 ARM64 Linux 使用同一 ABI，需在麒麟/UOS/openEuler 验收 |
| macOS Intel | `darwin-x64` | `macos-13` | 不签名、不公证 |
| macOS Apple Silicon | `darwin-arm64` | `macos-14` | 不签名、不公证 |
| Windows x64 | `win32-x64` | `windows-2022` | 不签名 |
| Windows ARM64 | `win32-arm64` | `windows-11-arm` | 必须原生构建，不能用 x64 冒充 |

明确不支持：

- LoongArch64 / 龙芯；
- 32 位 ARM（ARMv7 / armhf）；所有 ARM 产物均为 ARM64；
- Linux musl（Alpine）、RISC-V；
- macOS universal binary；
- 在 x64 机器上直接生成 arm64 SEA。

## 3. Node 版本

### 3.1 运行时

CLI 包声明的运行时下限是 **Node.js >=22**。普通 Node 运行 `dist/bin.js` 时不需要 SEA。

### 3.2 构建 SEA

当前构建脚本使用 `node --build-sea`，该能力要求 **Node >=25.5**，推荐 **Node 26.10**。

这意味着：

- 最终用户不需要安装 Node；
- 构建机需要 Node 26.10（或至少 25.5）；
- 在 Node 22 上执行 `pnpm cli:build:sea` 会在版本检查处失败。

### 3.3 如果必须用 Node 22 构建

当前尚未实现 Node 22 的 SEA 构建路径。需要额外完成：

1. 使用 `node --experimental-sea-config` + `postject`，而不是 `--build-sea`；
2. Node 22 的 SEA 入口需按 CommonJS 处理（当前配置是 `mainFormat: "module"`），需要额外生成 CJS bundle 和启动包装；
3. 验证 `node:sea` 的 `getRawAsset` / `getAssetKeys` 与 assets 在 Node 22 上可用；注意 `getAssetKeys` 在 Node **22.20.0** 才加入，22.16 需要回退实现或提高构建下限；
4. 在 Node 22 上跑冷启动、缓存、真实 OFD 转换与 `--text` 冒烟。

在该路径完成前，文档中的构建要求以 Node 26.10 为准。

## 4. 本地构建

前置：

- Node 26.10；
- pnpm（仓库使用 `pnpm@11.24.0`）；
- 已安装依赖；
- 当前平台在支持矩阵内。

```bash
pnpm install
pnpm -C packages/ofdrw-viewer-engine build
pnpm -C packages/ofdrw-viewer-cli build
pnpm cli:typecheck
pnpm cli:test
pnpm cli:build:sea
pnpm cli:package:sea
```

也可以直接进入 CLI 包目录执行同名脚本。`build:sea` 与 `package:sea` 都支持 `--target`，但目标必须与当前平台一致：

```bash
pnpm -C packages/ofdrw-viewer-cli build:sea -- --target linux-x64-gnu
pnpm -C packages/ofdrw-viewer-cli package:sea -- --target linux-x64-gnu
```

产物：

```text
packages/ofdrw-viewer-cli/dist/sea/ofdrw-viewer-cli
packages/ofdrw-viewer-cli/dist/sea/ofdrw-viewer-cli.exe   # Windows
packages/ofdrw-viewer-cli/dist/release/ofdrw-viewer-cli-<version>-<target>.tar.gz
packages/ofdrw-viewer-cli/dist/release/ofdrw-viewer-cli-<version>-<target>.zip
packages/ofdrw-viewer-cli/dist/release/*.sha256
```

`build:sea` 会执行：

1. esbuild 打包 CLI/engine；
2. 收集 `@napi-rs/canvas` JS 与目标平台 `.node`；
3. 生成 `canvas-manifest.json`；
4. 调用 `node --build-sea`；
5. 在隔离临时目录执行冷启动、热启动与真实 OFD 冒烟。

`package:sea` 会把可执行文件、根目录 `README.md` 与 `LICENSE` 打进归档，并生成对应的 `.sha256`。压缩包不包含 `skills/`、源码或 `.node` 文件。

本地只能构建当前平台。`--target` 只用于显式校验目标，不会启用交叉构建；不要用本机产物冒充其他平台。

## 5. GitHub Actions

仓库使用 `.github/workflows/release-cli.yml`，在原生 runner 矩阵上构建：

```yaml
strategy:
  fail-fast: false
  matrix:
    include:
      - runner: ubuntu-24.04
        target: linux-x64-gnu
      - runner: ubuntu-24.04-arm
        target: linux-arm64-gnu
      - runner: macos-13
        target: darwin-x64
      - runner: macos-14
        target: darwin-arm64
      - runner: windows-2022
        target: win32-x64
      - runner: windows-11-arm
        target: win32-arm64
```

触发方式：

- 推送 `cli-v*` 标签；
- 或手动 `workflow_dispatch`，填写 `tag` 才会创建 Release，留空只构建并保留 artifact。

每个 job：

1. checkout；
2. 安装 Node 26.10、pnpm；
3. `pnpm install --frozen-lockfile`；
4. 构建 engine、CLI 并执行类型检查/测试；
5. `build:sea -- --target <target>`；
6. 去掉 PATH 中的 Node 后执行 `--version`、`--help`、真实 OFD 图片与 `--text` 冒烟；
7. `package:sea -- --target <target>` 打包并上传 artifact；
8. release job 汇总产物并生成 `SHA256SUMS`。

注意：

- `windows-11-arm` 与 `macos-13` 的可用性以 GitHub 当时状态为准；
- 没有对应原生 runner 时，不要用其他架构模拟；
- 所有 action 建议 pin 到 commit SHA。

## 6. 产物命名

```text
ofdrw-viewer-cli-<version>-linux-x64-gnu.tar.gz
ofdrw-viewer-cli-<version>-linux-arm64-gnu.tar.gz
ofdrw-viewer-cli-<version>-darwin-x64.tar.gz
ofdrw-viewer-cli-<version>-darwin-arm64.tar.gz
ofdrw-viewer-cli-<version>-win32-x64.zip
ofdrw-viewer-cli-<version>-win32-arm64.zip
*.sha256
SHA256SUMS
```

压缩包内只放可执行文件、`README.md` 与 `LICENSE`，不放 `skills/`、源码或 `.node` 文件。每个单平台产物同时生成 `.sha256`；Release 中的 `SHA256SUMS` 由 CI 汇总重新生成。

## 7. 平台注意事项

### Linux

- 产物面向 glibc；不要宣称支持 musl；
- GitHub 托管的 Linux arm64 runner 目前是 Ubuntu 24.04；若目标环境的 glibc 更老，需在更老容器或自建 runner 上重建并验证；
- 若需支持麒麟 V10 / UOS 等较老环境，构建环境的 glibc 不能高于目标；
- canvas `.node` 的 glibc 要求通常低于 Node，主要限制来自 Node 官方二进制。

### macOS

- 不签名、不公证；
- 下载后可能被 Gatekeeper 隔离，需要用户手动执行 `xattr -d com.apple.quarantine <file>`；
- 不要宣称“双击即用”。

### Windows

- 不签名，可能触发 SmartScreen；
- Windows ARM64 必须使用 ARM64 runner 和 `@napi-rs/canvas-win32-arm64-msvc`。

## 8. SEA 缓存

首次运行会把 canvas 资产解压到：

```text
<tmpdir>/ofdrw-viewer-cli-u<uid>/u<uid>-<version>-<platform>-<arch>-<digest>/
```

Windows 无 uid 时为：

```text
%TEMP%\ofdrw-viewer-cli\win-<version>-<platform>-<arch>-<digest>\
```

缓存目录 0700、文件 0600；复用前校验属主、符号链接和全资产摘要。未知/被篡改的缓存会 fail-closed，不会加载。

## 9. 故障排查

| 现象 | 排查 |
|---|---|
| `build:sea` 提示 Node 版本过低 | 使用 Node 26.10；当前脚本要求 >=25.5 |
| 找不到 `@napi-rs/canvas-*` | 当前平台不在矩阵内，或依赖未完整安装 |
| 产物启动报 `CLI_SEA_EXTRACT_FAILED` | 检查 TMPDIR 可写、缓存属主/权限、磁盘空间 |
| macOS 提示无法验证开发者 | 按 §7 移除 quarantine，或后续做签名/公证 |
| Windows 提示 SmartScreen | 当前未签名，属于预期 |
| 产物在旧 Linux 报 GLIBC 错误 | 在更老 glibc 环境重建 |

## 10. 明确不支持

- LoongArch64：Node 与 canvas 缺少稳定、可复现的构建链，当前不进入发布矩阵；
- 交叉构建：不支持在 x64 上生成 arm64、在 Linux 上生成 macOS/Windows；
- 单文件 universal：不提供；
- 构建期签名：v1 不做。

如果需要新增架构，先验证 Node 运行时与 canvas 原生模块都能在目标架构构建和运行，再讨论 CI 与发布。