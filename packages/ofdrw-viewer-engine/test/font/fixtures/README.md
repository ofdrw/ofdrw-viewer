# 裸 CFF 字体测试 fixture

以下字体从 `ofd_pdf_match/case_font/1_dfd.ofd` 原样提取，未做任何字节修改：

| fixture | 原始内部路径 | 字节数 | 结构 |
| --- | --- | --- | --- |
| `dfd-font-5.otf` | `Doc_0/Res/font_5.otf` | 288 | 非 CID 裸 CFF，4 个字形（`.notdef`、`G21`、`G22`、`G23`） |
| `dfd-font-4.otf` | `Doc_0/Res/font_4.otf` | 13123 | 非 CID 裸 CFF，31 个字形（`.notdef`、`G21`…`G3E`） |
| `dfd-font-1.otf` | `Doc_0/Res/font_1.otf` | 70486 | CFF CID（ROS=`Founder`/`PKU2`），2 个字形（`.notdef`、`cid05505`） |

提取命令：

```bash
unzip -p ofd_pdf_match/case_font/1_dfd.ofd Doc_0/Res/font_5.otf > test/font/fixtures/dfd-font-5.otf
```

## 为什么需要这些样本

这三个文件虽然扩展名为 `.otf`，但**不是 OpenType/sfnt 容器**：文件开头是 4 字节私有头
`01 00 04 03`（sfnt 版本 0x00010000 + `04 03`），其后直接是 CFF 的 Header 与 Name INDEX，
没有表目录（Table Directory）、没有 `cmap`/`head`/`hhea`/`maxp`/`hmtx`/`name`/`OS/2`，
也没有插槽头 `OTTO`。因此 fontkit 对三者一律抛 `Unknown font format`。

这正是 OFD 实际业务文档中常见的"裸 CFF 内嵌字体"形态，需要由字体层的裸 CFF 适配器
包成 fontkit 可解析的字体面。样本覆盖三条分支：

- `dfd-font-5.otf`：最小样本，可完整核对解析结果（单位、字形数、advance）与字形轮廓；
- `dfd-font-4.otf`：多字形、大量曲线命令，验证轮廓转换在真实字形上不走样；
- `dfd-font-1.otf`：CID 字体（ROS 存在），验证 CID-keyed CharStrings 与非 CID 分支的差异。

只用内嵌字体、不依赖系统字体，因此无字体环境也可运行。

## 使用方式

`test/font/bare-cff.test.ts` 通过 `new URL('./fixtures/dfd-font-N.otf', import.meta.url)` 读取，
样本始终在仓库内，不经过 `test/.fixtures/`（该目录被根 `.gitignore` 忽略，不会入库）。

仅用于回归字体解析与字形轮廓；业务 OFD 文件本身不提交。
