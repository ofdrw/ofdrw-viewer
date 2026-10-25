# 站点内置字体说明

本目录下的字体文件随演示站分发，用于在 OFD 文档没有内嵌字体时兜底显示中文。
两个文件都不依赖外部 CDN，构建时由 Vite 从 `site/public/` 原样复制到产物根目录。

## 字体清单

| 文件 | 字体 | 真实 family 名 | 授权 | 体积 |
| --- | --- | --- | --- | --- |
| `source-han-serif-sc.<hash>.woff2` | 思源宋体（Noto Serif CJK SC） | `Noto Serif CJK SC` | SIL Open Font License 1.1 | 11 098 716 B（约 10.6 MiB） |
| `source-han-sans-sc.<hash>.woff2` | 思源黑体（Noto Sans CJK SC） | `Noto Sans CJK SC` | SIL Open Font License 1.1 | 7 817 104 B（约 7.5 MiB） |

文件名中的 8 位十六进制是该文件 `sha256` 的前缀：内容一变文件名就变，因此可以设置
`Cache-Control: immutable` 长期缓存（见 `site/public/_headers`）。修改字体后需同步更新
`site/main.ts` 的 `LOCAL_SERIF_FILE` / `LOCAL_SANS_FILE` 常量。

## 子集范围

两个字体都由完整字体抽取单一字体面后做同规格子集，仅保留：

- CJK 统一表意文字基本区 `U+4E00–U+9FFF`（20992 字，常用汉字全覆盖）
- CJK 标点 `U+3000–U+303F`、全角形式 `U+FF00–U+FFEF`、兼容标点 `U+FE10–FE4F`
- 基本拉丁与扩展拉丁 `U+0020–U+024F`、常用标点 `U+2000–U+206F`
- 带圈数字、箭头、数学符号、制表符、几何图形、杂项符号

**不含** CJK 扩展区 `ExtA–ExtE`（`U+3400–U+4DBF` 及更高平面）与部首补充等
生僻区块：这些字仍会触发 `W_GLYPH_MISSING`，属于已知边界。

## 授权与来源

### 思源宋体（Noto Serif CJK SC）

- 上游：Adobe Source Han Serif / Google Noto Serif CJK，二者为同一套字形。
- 授权：SIL Open Font License 1.1，允许再分发与子集化。
- 本次来源：系统包 `fonts-noto-cjk` 的 `/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc`，
  抽取第 2 面（`Noto Serif CJK SC`）。
- 版权：Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'.

### 思源黑体（Noto Sans CJK SC）

- 上游：Adobe Source Han Sans / Google Noto Sans CJK，二者为同一套字形。
- 授权：SIL Open Font License 1.1，允许再分发与子集化。
- 本次来源：系统包 `fonts-noto-cjk` 的 `/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc`，
  抽取第 2 面（`Noto Sans CJK SC`）。
- 版权：Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'.

## 重新生成

字体文件由脚本生成，可复现子集范围与输出：

```bash
# 需要 Python 3.10+、fonttools 与 brotli：
#   python3 -m venv .venv-fonts && .venv-fonts/bin/pip install fonttools brotli
.venv-fonts/bin/python scripts/build-site-fonts.py
```

脚本会打印新的哈希文件名；请同步更新 `site/main.ts` 的常量与
`site/test/site-fonts.test.ts` 中的体积断言。

输出体积明显小于原字体，是因为只保留了上述区块，并非压缩了字库质量。
