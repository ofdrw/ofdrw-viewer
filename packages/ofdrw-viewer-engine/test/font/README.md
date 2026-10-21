# 字体与文字测试 fixture 说明

本目录与 `test/text-layout/` 的测试不提交任何版权字体。`fixtures.ts` 在运行时准备
`test/.fixtures/fonts/`（已被根 `.gitignore` 忽略），来源缺失时相关用例显式 `skip`，
不会因为环境缺少系统字体而伪造通过。

| fixture | 用途 | 来源 | 缺失时 |
| --- | --- | --- | --- |
| `DejaVuSans.ttf` | 正常 TTF、拉丁字形/advance | 系统 `/usr/share/fonts/.../dejavu` | skip |
| `DejaVuSans-Bold.ttf` | 字体自带粗体判定 | 同上 | skip |
| `DejaVuSans-Oblique.ttf` | 字体自带斜体判定 | 同上 | skip |
| `NotoSerifCJK-Bold.ttc` | TTC 多字体面选择、CFF CID | 系统 Noto CJK TTC | skip |
| `NotoSerifCJKsc-Regular.otf` | 单字体 CFF CID（可选） | 仓库 `references/ofdrw/...` | skip |
| `stripped-nocmap.otf` | 无 cmap/name/OS2 剥离子集，按显式 gid 取字 | `ofd_pdf_match/doc1File.ofd` 内嵌字体 | skip |
| `broken.ttf` | 损坏字体容错（扩展名与内容不符） | `ofd_pdf_match/intro-数科.ofd` 内嵌字体 | skip |
| `simsun-extracted.ttf` | 真实 OFD 内嵌 CJK 子集 | `ofd_pdf_match/ano.ofd` 内嵌字体 | skip |

运行：

```bash
pnpm -C packages/ofdrw-viewer-engine exec vitest run test/font test/text-layout
```

`test/.artifacts/t4/` 为测试产物目录（同样被忽略）。Delta 相关用例覆盖
`g <count> <value>`（含 `0 g 3 5 2` → `0,5,5,5,2`），并断言 `g` 不占字符位。