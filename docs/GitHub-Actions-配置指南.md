# GitHub Actions 配置指南

> 适用仓库：`ofdrw/ofdrw-viewer`
> 撰写时间：2026-10-23。文中的 action 版本、runner 可用性、计费规则以该时间点的 GitHub 状态为准，升级前请再核对各 action 的 releases 页。

本仓库的自动化由三条独立流水线组成：日常校验（CI）、在线演示站（Pages）、版本发布（npm + GitHub Release）。代码侧已经写好，**剩下要做的是仓库设置、权限、密钥和运行环境这四类配置**。

---

## 0. 结论：必须手工完成的 6 件事

| # | 位置 | 配置项 | 缺失后果 |
| --- | --- | --- | --- |
| 1 | 本地 / GitHub | 创建仓库并添加 `origin` 远端 | 无法触发任何 workflow |
| 2 | Settings → Actions → General | Workflow permissions 设为 **Read and write** | 创建 Release 报 403 |
| 3 | Settings → Actions → General | 允许使用第三方 action | `pnpm/action-setup`、`softprops/action-gh-release` 无法拉取 |
| 4 | Settings → Pages | Source 选择 **GitHub Actions** | Pages 部署报 “Get Pages site failed” |
| 5 | Settings → Secrets and variables → Actions | 新增 `NPM_TOKEN` | npm 发布步骤直接失败 |
| 6 | npm 网站 | `@ofdrw` scope 的发布权限与 2FA 策略 | npm 发布 403 / 404 |

另外，原先存在三处会导致发布失败或产物错配的问题（`macos-13` 已退役、action 版本过旧、内部依赖写死了版本范围），**已于 2026-10-23 在本仓库修复**，详见第 7 节。

---

## 1. 现有流水线一览

| 文件 | 名称 | 触发条件 | 产物 / 动作 | 需要的权限或密钥 |
| --- | --- | --- | --- | --- |
| `.github/workflows/ci.yml` | CI | push 到 `main`、任意 PR、手动 | 类型检查、各包单测、构建全部包、构建演示站（仅验证，不发布） | 无（`contents: read`） |
| `.github/workflows/pages.yml` | 在线演示 | push 到 `main`、手动 | 构建并部署演示站到 GitHub Pages | `pages: write`、`id-token: write`；仓库需启用 Pages |
| `.github/workflows/release.yml` | 发布 | 推送 `v*` 标签、手动 | 发布 4 个 npm 包、构建 5 个平台 CLI、打 CDN 包、创建 GitHub Release | `contents: write`；`NPM_TOKEN` |

配套脚本（无需额外配置）：

- `.github/scripts/check-release-version.mjs`：校验标签与四个包版本一致。
- `.github/scripts/package-cdn-assets.mjs`：把 engine、crypto 的 IIFE 产物打成 `cdn-<version>.zip`，依赖 runner 自带的 `zip` 命令。
- `.github/scripts/generate-release-notes.mjs`：按 Conventional Commits 从提交历史生成 Release 正文。

三条流水线互不阻塞：`ci.yml` 只在 `main` 和 PR 上跑，**推标签不会触发 CI**，所以打标签前应确认 `main` 的 CI 已经是绿色。

---

## 2. 仓库准备

### 2.1 当前状态

本地仓库**还没有配置任何远端**（`git remote -v` 为空），也没有打过 tag。所有包 `package.json` 的 `repository` 字段和 README 徽章都指向 `https://github.com/ofdrw/ofdrw-viewer`，仓库必须建在这个位置，否则 npm 元数据、徽章、Release 链接都会指错。

```bash
# 在 GitHub 上创建空仓库 ofdrw/ofdrw-viewer 后：
git remote add origin git@github.com:ofdrw/ofdrw-viewer.git
git push -u origin main
```

首次 push `main` 会同时触发 CI 和 Pages 两条流水线。

### 2.2 公开还是私有

| 影响面 | 公开仓库 | 私有仓库 |
| --- | --- | --- |
| GitHub Pages | 免费 | 需要 Pro / Team 及以上 |
| `ubuntu-24.04-arm` runner | 免费（2025-08 起 GA） | 2026-01 起可用，但计入付费分钟数 |
| Actions 免费额度 | 公开仓库不计费 | 2000 分钟/月（Free），macOS 按 10 倍计 |
| npm 包 | 无差别 | 无差别 |

本项目一次发布要跑 2 个 macOS 任务（各 10–20 分钟，按 10 倍折算即 200–400 分钟额度），**私有仓库很容易把每月额度吃光**，建议用公开仓库。

### 2.3 提交前注意

当前工作区有较多未提交改动。推送前先确认这些改动是有意保留的，并按 Conventional Commits 写提交信息（`feat:` / `fix:` / `ci:` 等），否则自动生成的 Release 说明里会全部落进“未分类”。

---

## 3. GitHub 网页侧的配置

### 3.1 Actions 权限（最容易漏）

路径：**Settings → Actions → General**

1. **Actions permissions**：选择 `Allow all actions and reusable workflows`。
   组织级如果限制了“仅允许 GitHub 官方 action”，`pnpm/action-setup` 和 `softprops/action-gh-release` 会在启动时被拒绝。
2. **Workflow permissions**：选择 `Read and write permissions`。
   这一项是 token 权限的**上限**。workflow 里写的 `permissions: contents: write` 只能在此上限内收窄，不能突破。如果这里选的是只读，`release.yml` 创建 Release 时必然报 `Resource not accessible by integration`。
3. **Allow GitHub Actions to create and approve pull requests**：本项目不需要，保持关闭即可。
4. **Fork pull request workflows**：`ci.yml` 只需要读权限，保持默认（不给 fork PR 写 token）即可。

### 3.2 启用 Pages

路径：**Settings → Pages → Build and deployment**

- **Source** 选择 `GitHub Actions`，不要选 “Deploy from a branch”（仓库里没有 `gh-pages` 分支）。
- 选完后 GitHub 会自动创建 `github-pages` 环境，`pages.yml` 的 deploy job 依赖这个环境。
- **不要**给 `github-pages` 环境添加 Required reviewers，否则每次 push `main` 后部署都会停在“等待审批”。

首次部署完成后，站点地址是 `https://ofdrw.github.io/ofdrw-viewer/`（仓库名不是 `<owner>.github.io` 时，`pages.yml` 会自动把 `BASE_PATH` 算成 `/<repo>/`）。

### 3.3 配置 `NPM_TOKEN`

路径：**Settings → Secrets and variables → Actions → New repository secret**

- 名称必须严格是 `NPM_TOKEN`（`release.yml` 里写死了这个名字）。
- 放在 **Repository secrets**，不要放 Environment secrets——发布 job 没有绑定 environment，读不到环境级密钥。
- token 的生成方式见第 4 节。

### 3.4 可选：保护 `main` 和标签

- **Settings → Branches**：给 `main` 加保护，要求 `CI / 类型检查、单测与构建` 通过后再合并，避免把红着的代码打成发布标签。
- **Settings → Tags**：可对 `v*` 加规则，限制谁能推发布标签（发布标签一旦推上去就会真实发 npm，不可撤回）。

---

## 4. npm 侧准备

### 4.1 确认 scope 与权限

CI 用 `pnpm --filter <pkg> publish --access public` 发布 `@ofdrw/*`。发布账号必须是 **`@ofdrw` 这个 npm organization 的成员，且拥有写权限**。

首次发布前先在本地确认包名没被占用（返回 404 说明可用；若提示网络错误，请改用 npm 网站搜索确认）：

```bash
for p in @ofdrw/ofdrw-viewer-engine @ofdrw/ofdrw-viewer-crypto \
         @ofdrw/ofdrw-viewer-ui @ofdrw/ofdrw-viewer-cli; do
  printf '%s: ' "$p"
  npm view "$p" version 2>&1 | tail -1
done
```

### 4.2 生成 token

优先使用 **Granular Access Token**（classic token 正在被逐步淘汰）：

1. npm → 头像 → **Access Tokens** → **Generate New Token** → Granular Access Token。
2. **Packages and scopes** 选 `@ofdrw`，权限 **Read and write**。
3. 按需设置有效期（建议 90 天，并记到日历里轮换）。
4. 如果 `@ofdrw` 组织强制了 2FA，勾选 **Bypass two-factor authentication**，否则 CI 会被 2FA 拦截。

### 4.3 组织级发布策略

路径：npm → `@ofdrw` 组织 → **Settings → Publishing access**

必须允许 token 发布。如果选的是“Require two-factor authentication and disallow tokens”，CI 里的 `NPM_TOKEN` 会被拒绝，发布步骤报 403 或 `EOTP`。应选择允许 automation / granular token 的选项。

### 4.4 版本与 dist-tag 规则

- 四个包的版本必须与标签完全一致（`release.yml` 第一步就会校验，不一致直接失败）。
- 正式版（`0.1.0`）发到 `latest`，带后缀的预发布版（`0.2.0-beta.1`）自动发到 `next`。
- 已存在于 npm 的版本会被跳过，所以同一个 workflow 重跑是幂等的。

---

## 5. 运行环境与费用

| Runner | 用途 | 状态 |
| --- | --- | --- |
| `ubuntu-24.04` | CI、npm 发布、CDN 打包、Release | 可用（`ubuntu-latest` 当前指向它） |
| `ubuntu-24.04-arm` | `linux-arm64-gnu` CLI | 公开仓库免费；私有仓库需付费计划 |
| `macos-15-intel` | `darwin-x64` CLI | 可用（本仓库已从退役的 `macos-13` 迁移过来） |
| `macos-15` | `darwin-arm64` CLI | 可用（macOS 任务按 10 倍计费） |
| `windows-2022` | `win32-x64` CLI | 可用（Windows 任务按 2 倍计费） |

`macos-13` 已于 2025-12-04 退役，`macos-14` 也已进入弃用流程（macOS 镜像只保留最近两个 GA 版本），所以发布矩阵固定在 `macos-15` / `macos-15-intel` 上。私有仓库的 macOS runner 按 10 倍分钟折算，arm64 Linux runner 自 2026-01-29 起才在私有仓库可用。

---

## 6. 发布一次的标准流程

### 6.1 正式发布

```bash
# 0. 内部依赖已是 workspace:^（见 7.3），以后每次发版只需改版本号
# 1. 四个包统一改成目标版本（pnpm -r 只作用于 workspace 子包，不含根）
pnpm -r exec npm pkg set version=0.1.0

# 2. 刷新锁文件并本地跑一遍构建，避免把编译错误带到 CI
pnpm install
pnpm build

# 3. 提交到 main，确认 CI 绿
git add -A
git commit -m "chore(release): 0.1.0"
git push origin main

# 4. 打标签并推送（会触发 release.yml，真实发布 npm + Release）
git tag v0.1.0
git push origin v0.1.0
```

推送标签后依次执行：版本校验 → 类型检查 → 发布 npm（4 包）→ 并行构建 5 个平台 CLI + CDN 包 → 生成 Release 说明与 `SHA256SUMS` → 创建 Release。

### 6.2 先演练、不发布

在 **Actions → 发布 → Run workflow** 中：

- `ref` 填已存在的标签（如 `v0.1.0`）
- `publish` 保持 `false`

这样会跑完校验、构建和产物上传，但跳过 npm 发布与 Release 创建，适合验证 runner 矩阵和 SEA 打包是否正常。

### 6.3 关于标签位置

标签必须打在 `main` 的同一个提交上。打在别的分支或旧提交上虽然能通过版本校验，但 Release 内容和 npm 产物就不是你预期的代码了。

---

## 7. 已修复的三处问题（2026-10-23）

本次代码改动涉及：

- `.github/workflows/ci.yml`、`pages.yml`、`release.yml`：action 版本升级、发布矩阵换 runner。
- `packages/ofdrw-viewer-crypto/package.json`、`packages/ofdrw-viewer-ui/package.json`：内部依赖改为 `workspace:^`。
- `pnpm-lock.yaml`：同步上述依赖写法。

### 7.1 runner 退役：`macos-13`、`macos-14`

原发布矩阵里 `darwin-x64` 用 `macos-13`（2025-12-04 已退役）、`darwin-arm64` 用 `macos-14`（已进入弃用流程）。前者会让 `build-cli` 找不到 runner、并阻塞整个 Release（`release` job 依赖它）。

现已改为：

```yaml
- runner: macos-15-intel
  target: darwin-x64
  archive: tar.gz
- runner: macos-15
  target: darwin-arm64
  archive: tar.gz
```

`macos-15-intel` 是 macOS 15 的 x64 镜像，`macos-15` 是 arm64 镜像，标签可在 runner-images 仓库的 Available Images 表中核对。

### 7.2 Action 版本停留在 Node 20

原 workflow 使用的 `checkout@v4`、`setup-node@v4`、`upload-artifact@v4` 等运行在 Node 20 runtime 上。GitHub 已从 2025-09 起弃用 Node 20、并逐步强制 Node 24，继续使用会在日志里报警告，后续可能直接失败。

现已全部升级（版本为 2026-10-23 核实的最新主版本）：

| 用途 | 原版本 | 现版本 |
| --- | --- | --- |
| 检出代码 | `actions/checkout@v4` | `@v7` |
| 安装 Node | `actions/setup-node@v4` | `@v7` |
| 安装 pnpm | `pnpm/action-setup@v4` | `@v6` |
| 上传 artifact | `actions/upload-artifact@v4` | `@v7` |
| 下载 artifact | `actions/download-artifact@v4` | `@v8` |
| 配置 Pages | `actions/configure-pages@v5` | `@v6` |
| 上传站点 | `actions/upload-pages-artifact@v3` | `@v5` |
| 部署 Pages | `actions/deploy-pages@v4` | `@v5` |
| 创建 Release | `softprops/action-gh-release@v2` | `@v3` |

升级时已核对的兼容性：

- `upload-artifact@v7` 新增的 `archive: false` 是可选参数，默认仍打包 zip，`download-artifact@v8` 读取正常（两者都基于 `@actions/artifact` 6.3.1）。
- `pnpm/action-setup@v6` 正是为支持 pnpm 11 发布的，与本仓库 `pnpm@11.24.0` 匹配。
- `setup-node@v7` 新增的 `package-manager-cache` 不影响显式写 `cache: pnpm` 的用法。
- `softprops/action-gh-release@v3` 只把 runtime 从 Node 20 换到 Node 24，输入参数不变。
- `upload-pages-artifact@v5` 与 `deploy-pages@v5` 是官方配套版本。

后续维护建议：主版本号会继续滚动，更稳妥的做法是固定到具体 commit SHA，并用 Dependabot 定期升级。

### 7.3 内部依赖写死了版本范围，升级会指向旧包

`crypto` 和 `ui` 对内部包的依赖原先写成了 `workspace:^0.1.0`：

```json
// packages/ofdrw-viewer-crypto/package.json
"@ofdrw/ofdrw-viewer-engine": "workspace:^0.1.0"
```

pnpm 发布时会把 `workspace:` 协议替换成普通 semver 范围：`workspace:^0.1.0` → `^0.1.0`，**它不会跟随实际包版本**。也就是说，将来发 `0.2.0` 时，`crypto@0.2.0` 的发布产物仍会声明依赖 `engine@^0.1.0`，npm 用户安装后拿到的是旧引擎，而 `^0.1.0` 又不包含 `0.2.0`，极易出现版本错配。

已实测两种写法的发布结果：

| 声明 | 包版本 | 发布后 |
| --- | --- | --- |
| `workspace:^0.1.0` | 0.2.0 | `"@ofdrw/ofdrw-viewer-engine": "^0.1.0"`（错） |
| `workspace:^` | 0.2.0 | `"@ofdrw/ofdrw-viewer-engine": "^0.2.0"`（对） |

现已把 `packages/ofdrw-viewer-crypto/package.json` 和 `packages/ofdrw-viewer-ui/package.json` 中的内部依赖统一改成不写死版本的 `workspace:^`：

```json
"@ofdrw/ofdrw-viewer-engine": "workspace:^",
"@ofdrw/ofdrw-viewer-crypto": "workspace:^"
```

`cli` 用的是 `workspace:*`，发布时会替换成精确版本（如 `0.2.0`），CLI 与引擎强绑定，这种写法可以保留。

改完后用 `pnpm install` 同步了 `pnpm-lock.yaml`（`--frozen-lockfile` 已验证通过），并检查了发布产物：当前 `crypto@0.1.0` 的产物依赖为 `"@ofdrw/ofdrw-viewer-engine": "^0.1.0"`；以后发 `0.2.0` 时会自动变成 `^0.2.0`。

发布前也可以再自查一次产物依赖：

```bash
mkdir -p /tmp/pack-check
pnpm -C packages/ofdrw-viewer-crypto pack --pack-destination /tmp/pack-check
tar -xzf /tmp/pack-check/*.tgz -C /tmp/pack-check
grep -A3 '"dependencies"' /tmp/pack-check/package/package.json
```

---

## 8. 常见报错对照

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `Resource not accessible by integration` | token 只有读权限 | 3.1 节改成 Read and write |
| `Get Pages site failed` / `Not Found` | Pages 未启用或 Source 不是 Actions | 3.2 节 |
| `No runner matching the specified labels` | runner 标签已退役 | 已修复，见 7.1 节 |
| `Unable to resolve action ...` | 组织禁止第三方 action | 3.1 节 |
| `npm ERR! 403 ... EOTP` | 组织强制 2FA，token 未 bypass | 4.2 / 4.3 节 |
| `npm ERR! 404 Scope not found` | `@ofdrw` scope 不存在或账号无权限 | 4.1 节 |
| `标签 vX.Y.Z 与包版本不一致` | 四个包版本没统一 | 6.1 节第 1 步 |
| 用户装到旧版内部包 / 运行时报 API 缺失 | 内部依赖写死 `workspace:^0.1.0` | 已修复，见 7.3 节 |
| 发布卡住不结束 | `concurrency` 串行，或 Release job 等待 build-cli | 检查 runner 配置（7.1 节） |

---

## 9. 一页检查清单

- [ ] 仓库建在 `ofdrw/ofdrw-viewer`，本地 `origin` 已配置
- [ ] 仓库为 public（或确认私有额度足够）
- [ ] Actions：Allow all actions + Workflow permissions = Read and write
- [ ] Pages：Source = GitHub Actions，`github-pages` 环境未加审批
- [ ] Secret `NPM_TOKEN` 已添加，取自 `@ofdrw` scope 的 granular token
- [ ] npm 组织允许 token 发布，账号有写权限
- [ ] 四个包版本统一，`main` 的 CI 为绿
- [x] 内部依赖已改成 `workspace:^`（crypto、ui）
- [x] runner 已换成 `macos-15-intel` / `macos-15`
- [x] action 版本已升级到第 7.2 节的版本
- [ ] 用 `publish=false` 演练过一次
- [ ] 正式打标签发布，并核对 npm 页面、Release 附件、Pages 站点

---

## 10. 参考链接

- [macOS 13 runner 关闭公告](https://github.blog/changelog/2025-09-19-github-actions-macos-13-runner-image-is-closing-down/)
- [runner-images：可用镜像与标签](https://github.com/actions/runner-images#available-images)
- [runner-images：macOS 13 退役时间线](https://github.com/actions/runner-images/issues/13046)
- [Node 20 弃用公告](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/)
- [upload-artifact v7（ESM 与可选的直传）](https://github.com/actions/upload-artifact/releases/tag/v7.0.0)
- [arm64 runner 在公开仓库 GA](https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/)
- [arm64 runner 支持私有仓库](https://github.blog/changelog/2026-01-29-arm64-standard-runners-are-now-available-in-private-repositories/)
- [GitHub Pages 自定义 workflow 文档](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
- [使用 granular access token 发布 npm 包](https://docs.npmjs.com/creating-and-viewing-access-tokens)