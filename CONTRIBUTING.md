# 参与贡献

感谢参与 OFDRW-Viewer。本文说明开发环境、提交前检查与必须遵守的规则入口。

## 环境

- Node.js >= 22
- pnpm 11（`corepack enable` 后使用仓库声明的版本）

```bash
pnpm install
pnpm build        # 构建全部包
pnpm typecheck    # 全仓类型检查
pnpm test         # engine 单测（根级入口）
```

## 提交前必须通过

```bash
pnpm -r --if-present run typecheck
pnpm -C packages/ofdrw-viewer-ui exec vitest run
pnpm -C packages/ofdrw-viewer-engine exec vitest run
pnpm -C packages/ofdrw-viewer-cli test
```

任一失败不要提交。测试失败需保留样本名、页号、命令、环境与产物路径，不能只写“测试失败”。

## 必须遵守的规则

| 主题 | 文档 |
| --- | --- |
| 本地构建、安装、测试、各模块开发环境 | [本地开发与构建指南](../BUILD.md) |
| 兼容性、过时标记、破坏性变更 | [开发与兼容性规则](docs/开发与兼容性规则.md) |
| 包归属、依赖方向、公共入口、诊断码 | [跨包契约](docs/CONTRACTS.md) |
| 测试目录、夹具、命令、CI、产物 | [测试方案](docs/测试方案.md) |
| 各包 API 与用法 | 各包 `skills/API.md`、`skills/SKILL.md` |

其中兼容性规则是硬性要求：**不得删除或重命名已公开的导出、码值、事件与参数名**；确需变更时按该文档的过时标记与迁移流程处理。

## 代码约定

- 公开函数、变量必须写注释：说明、参数、返回值；带单位的数值注明单位。
- 避免过度封装；一个函数只被一处调用时不要额外抽层。
- 注释只写代码意图与逻辑，不写实现过程的心路。

## 测试约定

- 新增或变更公开 API 时必须附带测试用例，覆盖输入、输出、默认值与错误分支；缺陷修复必须先补能复现失败的用例，再修到通过。
- 回归以 vitest 为主，覆盖可确定性验证的逻辑。
- Playwright 仅用于本地开发与调试期间的一次性验证，**不得提交**测试文件、配置、夹具或产物；详见 [测试方案 §1.4](docs/测试方案.md)。

## 禁止事项

- 未经明确许可不得执行 `git push`
- 不得提交浏览器自动化测试与其产物
- 不得删除未跟踪的既有文件
- 不得在没有迁移方案的情况下破坏公开 API

## 反馈问题

提交 issue 时请附：复现样本（或最小构造）、命令与版本、实际结果与预期结果。涉及渲染差异请附截图与对比页号。