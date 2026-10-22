# 测试字体夹具

`minimal.ttf` 由 fontTools `FontBuilder` 合成，仅包含 `.notdef`、空格与 `A`
三个字形，无第三方字体数据。用于 `--font-dir` 等需要真实 TTF 的用例，
避免测试依赖本机系统字体或被 `.gitignore` 忽略的运行时夹具。
