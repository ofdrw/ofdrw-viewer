# 黄金图基线（人工确认后提交）

本目录保存**人工审核通过**的引擎输出基线，用于捕捉“相对已确认版本”的回归。
PDF 参考图只验证版式/位置，不能代替基线（字体替换、抗锯齿会造成系统性差异）。

## 目录约定

```
baseline/
  <sample>/
    page-001.png
    page-002.png
```

- `<sample>` 为样本名（不含扩展名），文件名中的空白/非法字符替换为 `_`（见 `run-all.e2e.test.ts` 的 `fileSafe`）。
- 页号 3 位补零，从 1 开始。
- 只保存需要长期锁定的页；未保存的页不参与基线比较（不算失败）。
- 图片为白底 PNG，尺寸必须与 `page.getViewport({ dpi })` 一致（现行 DPI=96）。

## 更新流程（禁止盲目更新）

1. 运行 `node scripts/golden/run-all.mjs`，打开 `test/.artifacts/golden/<timestamp>/report.html`。
2. 对每一页差异，人工对比 `*-engine.png`、`*-ref.png`、`*-diff.png`，确认差异属于“预期改进”而非回归。
3. 在 PR/评审记录中写明：样本、页号、变更原因、审核人。
4. 仅将审核通过的 PNG 复制到本目录对应位置；Commit message 使用
   `test(golden): approve baseline update <sample>/<page> (<reason>)`。
5. 重新运行 `node scripts/golden/run-all.mjs`，确认基线比较全部通过。

## 禁止事项

- 禁止用脚本自动覆盖基线（不提供 `--update` 自动更新开关）。
- 禁止在未查看 diff 的情况下批量替换。
- 禁止把业务原件或包含敏感信息的页面提交到本目录（用合成 fixture 或脱敏样本）。

## T8 状态

T8 阶段引擎尚未实现，本目录只有本说明文件；基线由 T9/T11 在引擎可渲染后
按上述流程逐步建立。