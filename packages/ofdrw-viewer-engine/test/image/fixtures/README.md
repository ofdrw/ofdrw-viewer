# 图片解码测试 fixture

- `1-image_78.jb2`：从 `ofd_pdf_match/1.ofd` 的 `Doc_0/Res/image_78.jb2` 原样提取。
- `no_page_container-image_100.jb2`：从 `ofd_pdf_match/no_page_container.ofd` 的 `Doc_0/image_100.jb2` 提取。
- `signedFile-image_80.jb2`：从 `ofd_pdf_match/signedFile.ofd` 的 `Doc_0/Res/image_80.jb2` 提取。

仅用于验证解析器可处理真实 OFD 中的 JBIG2 文件头/页面信息/通用区域；业务文件本身不提交。
无头嵌入式段由测试在运行时去掉 13 字节文件头生成，不额外存放二进制。
TIFF fixture 全部由 `test/image/tiff-fixture.ts` 合成，不依赖外部图片。
