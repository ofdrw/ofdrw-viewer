#!/usr/bin/env python3
"""生成用于测试密集文本渲染的 OFD 样本。

样本特征：
- A4 纵向，默认 10 页；8pt 正文（行距 3.6mm）、6pt/5pt 高密度小块；
- 中文、英文、数字、标点混排，包含字符覆盖页、易混淆字、长 URL、代码片段；
- 表格页、两栏页、多字号彩色文字页；
- 内嵌宋体子集，避免转 PDF 时因目标环境缺少宋体而替换字体。

只依赖 fontTools（读取字体度量并子集化）。

用法：
    python3 scripts/samples/generate_dense_text_ofd.py \
        --out test/.artifacts/dense-text/dense-text.ofd

    # 指定字体（TTC 用 --font-number 选择索引）
    python3 scripts/samples/generate_dense_text_ofd.py --font ~/fonts/SimSun.ttc --font-number 0
"""

from __future__ import annotations

import argparse
import io
import random
import re
import uuid
import zipfile
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

# ---------------------------------------------------------------------------
# 版面常量（单位：mm）
# ---------------------------------------------------------------------------


def pt(value: float) -> float:
    """把磅值换算为 OFD 使用的毫米。

    @param value 磅值。
    @returns 毫米值。
    """
    return value * 25.4 / 72.0


PAGE_W = 210.0
PAGE_H = 297.0
MARGIN = 15.0
CONTENT_W = PAGE_W - MARGIN * 2

HEADER_Y = 8.0
HEADER_SIZE = pt(7.0)
RULE_Y = 17.0
BODY_TOP = 22.0
BODY_BOTTOM = 274.0
FOOTER_Y = 282.0
FOOTER_SIZE = pt(6.0)

FONT_ID = 1
FONT_FILE_NAME = "SimSun.ttf"
FONT_NAME = "SimSun"
FONT_FAMILY = "宋体"

OFD_NS = "http://www.ofdspec.org/2016"

# 行首禁则：断行时这些字符不允许出现在行首
NO_LINE_START = set("，。、；：？！）〕］｝〉》」』】…—～·,.;:?!)]}")

# ---------------------------------------------------------------------------
# 文本素材
# ---------------------------------------------------------------------------

CHAPTERS = [
    "1 页面模型与坐标",
    "2 文字对象与字体资源",
    "3 渲染流程与缓存",
    "4 坐标变换与边界",
    "5 字体子集与转换",
    "6 版面密度",
    "7 对齐与断行",
    "8 表格与数字",
    "9 复制与检索",
    "10 性能与内存",
    "11 兼容性",
    "12 归档与长期保存",
]

CN_PARAGRAPHS = [
    "版式文档把每一页视为一块固定尺寸的画布，文字、图形与图像都落在精确的坐标上。"
    "与流式文档不同，页面不会因为阅读窗口的宽窄而重新排列，因此同一份文件在不同设备上"
    "应当呈现出完全一致的版面效果。正因如此，版式文档适合承载合同、票据、公文、说明书"
    "等对格式有严格要求的材料。页面的物理尺寸通常以毫米为单位描述，而字体大小沿用磅值，"
    "二者之间的换算关系是一磅约等于零点三五二八毫米。坐标原点位于页面左上角，横轴向右"
    "为正，纵轴向下为正，这与常见的桌面排版系统一致。",

    "文字对象是页面内容中出现频率最高的元素。一个文字对象由字体引用、字号、颜色以及一个"
    "或多个文本片段组成。每个文本片段除了字符内容之外，还可以携带逐字的水平或垂直步进值，"
    "用来描述字间距、两端对齐、竖排方向等细节。渲染器读取这些信息后，先按照字体文件中的"
    "字符映射找到对应字形，再根据步进值依次摆放，最后把轮廓填充到画布上。如果字体缺少"
    "某个字形，渲染器需要按照回退链选择替代字体，并记录一条告警，避免整页内容因为个别"
    "缺字而无法显示。",

    "打开一份 OFD 文件通常要经历解包、解析文档结构、解析公共资源、解析页面内容这几个步骤。"
    "为了提高翻页速度，成熟的实现会把解析结果缓存起来，并按需加载页面。渲染一页时，引擎"
    "先结算绘制参数，再依次处理文字、图形、图像与注释对象，最后统一提交给画布。描边、"
    "填充、裁剪、透明度和混合模式都在这一步生效。如果页面中包含大量小字号文字，字形查找"
    "和路径构建会成为主要开销，因此字形轮廓缓存和字体回退缓存对性能影响很大。",

    "每个页面对象都有自己的边界框，边界框的坐标相对于页面原点。对象内部还可以嵌套变换"
    "矩阵，用于旋转、缩放、镜像或平移。文字对象内部的文本片段坐标相对于对象边界框，而"
    "字形轮廓又相对于自身字体坐标系。多层变换叠加时，顺序不能颠倒，否则会出现位置偏移"
    "或方向反转。对称、旋转九十度、负坐标边界等情形在实际文件中并不罕见，渲染器需要对"
    "它们逐一处理。测试样本应当覆盖这些边界情况，并给出可以复核的页面尺寸与内容位置。",

    "OFD 允许把字体文件一并打包，也允许只声明字体名称、由阅读器在本机查找。内嵌字体可以"
    "保证转换和打印结果稳定，但会显著增加文件体积；非内嵌字体体积小，却依赖运行环境。"
    "为了兼顾两者，常见做法是对内嵌字体做子集化，只保留文档实际使用的字形。子集化之后的"
    "字体仍然保留字符映射表，阅读器可以正常定位字形。需要注意的是，某些转换工具对子集"
    "字体的名称表和度量表比较敏感，测试时应当同时验证渲染、复制和转 PDF 三条链路。",

    "密集文本测试关注的是单位面积内文字的数量与排布。常见参数包括字号、行距、字距、页边距、"
    "分栏数量和表格密度。八磅正文配三点六毫米行距，在 A4 纸上每页可以排下六十余行；六磅"
    "文字配二点九毫米行距，则可以排下八十余行。字号越小，字形轮廓的细节越容易被抗锯齿"
    "吞掉，笔画之间的间隙也越窄。渲染器和转换器都需要在小字号下保持字形的可辨识度，不能"
    "因为取样误差把相邻笔画粘连在一起。",

    "两端对齐是正式文档最常用的排版方式。实现时先按自然字宽把文字排入一行，再计算剩余"
    "空间，平均分配到各个字符之间。中文可以在任意字符之间断行，英文则通常以单词为单位"
    "断行，长单词或网址需要强制拆分。行首不能出现句号、逗号、右括号等收尾标点，行尾也不能"
    "出现左括号、左引号等起始标点。这些规则看似琐碎，却直接影响版面的观感。测试样本中"
    "应当同时包含纯中文、纯英文、中英混排、长网址和连续标点，以便观察断行结果。",

    "表格是密集文本的另一类典型场景。单元格里的数字通常右对齐，文字左对齐，表头居中；"
    "列宽需要根据内容分配，过窄会导致换行，过宽会浪费版面。金额、日期、编号等字段还要"
    "考虑等宽对齐，避免小数点错位。表格线可以用矢量路径绘制，也可以只保留横线，减少视觉"
    "噪音。当表格跨页时，表头应当重复出现，页脚则要标注续页信息。测试样本中的表格同时"
    "包含中文、英文、数字和百分比，用于检查混合内容的对齐效果。",

    "版式文档不仅要显示正确，还要支持文字选择、复制和全文检索。文字选择依赖字符在页面上的"
    "位置与顺序，如果一行文字被拆成多个对象，选择时可能出现顺序错乱。因此生成样本时，"
    "同一行文字应尽量放在同一个文本片段中，只有在需要精确控制字距或颜色时才拆分。检索"
    "则依赖字符编码与字形的映射，内嵌子集字体必须保留完整的字符映射表，否则复制出来的"
    "文字会变成空白或乱码。测试时可以把页面文字复制到文本编辑器，检查标点、数字和英文"
    "是否完整。",

    "密集文本页面会放大渲染器的性能问题。一页六十行、每行六十个字符，意味着一页就有三千"
    "六百次字形查找；如果每个字符都单独建对象，对象数量还会成倍增加。常见优化包括字形"
    "轮廓缓存、按字体缓存度量、延迟解析页面以及复用画布。测试时应当记录打开耗时、首页"
    "渲染耗时、连续翻页耗时和内存占用，并在不同字号、不同字体、不同对齐方式下分别取样。"
    "只有在数据稳定之后，性能对比才有意义。",

    "不同工具生成的 OFD 在细节上存在差异。有的工具省略命名空间前缀，有的把资源放在公共"
    "资源目录，有的把页面内容拆成多层。渲染器不能假设文件一定符合某一种写法，而应当按"
    "规范宽松解析，遇到不认识的元素时跳过并记录告警。对于缺失的字体、损坏的图片、越界的"
    "坐标，也应当以可恢复的方式处理，不能直接崩溃。测试样本应当包含一些不那么规范的"
    "结构，用来验证容错能力。",

    "版式文档常用于电子归档，要求内容在多年之后仍然可以准确呈现。为此，文件应当尽量内嵌"
    "字体和颜色描述，减少对外部环境的依赖。文字应当使用标准编码，避免私有字符集；图像"
    "应当采用通用格式，并保留足够的分辨率。归档系统还需要记录文件的完整性信息，例如摘要"
    "和签名，防止内容被篡改。测试样本可以模拟这些要求，检查阅读器在断网、缺少字体、"
    "字体被替换等条件下的表现。",
]

EN_PARAGRAPHS = [
    "A dense text fixture stresses every stage of the text pipeline. Shaping, glyph lookup, "
    "line breaking, justification and rasterization all run once per line, and a single page "
    "may contain several thousand characters. The renderer must keep the output stable while "
    "the input grows, and it must not degrade into quadratic behavior when the same glyph "
    "appears again and again. Cache design matters more than raw speed here.",

    "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. "
    "How vexingly quick daft zebras jump! Sphinx of black quartz, judge my vow. These pangrams "
    "exercise most of the Latin alphabet, including uppercase and lowercase forms, punctuation "
    "and spacing between words.",

    "When a document is converted to PDF, the converter has to decide how to embed fonts and "
    "how to position each glyph. If the original file uses per-character deltas, the converter "
    "can reproduce the layout exactly; if it relies on font metrics, small differences in font "
    "version may shift the line width. Both behaviors are acceptable as long as the text "
    "remains legible and the page structure is preserved.",

    "Numbers deserve special attention: 0.00, 1,234.56, -78.90, +12.5%, 3.1415926535, "
    "2.7182818284, 1e-9, 0x7F, 2026-10-21T16:54:23+08:00. A proportional font gives each "
    "digit a slightly different width, while a tabular figure setting keeps them aligned. "
    "Dense reports usually prefer the latter.",
]

MIXED_PARAGRAPHS = [
    "OFD（Open Fixed-layout Document）是一种开放版式文档格式，核心目标是保证版面在不同平台"
    "上的一致性。它使用 ZIP 容器组织内容，文档结构、页面内容、资源文件分别存放在不同的 XML "
    "条目中。一个典型的包包含 OFD.xml、Doc_0/Document.xml、Doc_0/Pages/Page_N/Content.xml "
    "以及可选的 PublicRes.xml。",

    "渲染器读取 TextObject 时，需要同时处理 Font、Size、Boundary、FillColor 等属性，以及 "
    "TextCode 的 X、Y、DeltaX、DeltaY。示例：Size=8.0、DeltaX=g 12 2.822，表示每个字符步进 "
    "2.822 毫米。若 DeltaX 缺失，则使用字体度量估算步进。",

    "在实际项目中，文本常常与数字、英文缩写和符号混排，例如：合同编号 HT-2026-1021-003，"
    "金额 ¥1,234,567.89，占比 98.7%，温度 -12.5℃，误差 ±0.02 mm。两类字符的宽度不同，断行"
    "和两端对齐都要分别计算。",

    "测试口令：请朗读下列句子 —— 红鲤鱼与绿鲤鱼与驴，黑化肥发灰会挥发，灰化肥挥发会发黑。"
    "绕口令可以检验字形相似度和渲染清晰度，也能暴露字体缺字或回退错误。",
]

CODE_LINES = [
    "https://example.com/ofd/viewer?page=12&zoom=150&mode=text#section-3",
    "file:///home/user/ofd-samples/dense-text/fixture-2026-10-21.ofd",
    "/var/lib/ofd/archive/2026/10/dense-text-v1.ofd",
    "user.name+ofd-test@example.com",
    "const page = await doc.getPage(0);",
    "const viewport = getPageViewport(page.getSize(), { dpi: 96 });",
    "await page.render({ canvasContext: ctx, viewport });",
    "if (glyph === undefined) { fallback.push(codepoint); }",
    "for (const [index, ch] of Array.from(text).entries()) { pen += deltaX[index]; }",
    "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
]

COVERAGE_LINES = [
    ("ASCII 可打印字符", "".join(chr(code) for code in range(0x20, 0x7F))),
    ("全角 ASCII", "".join(chr(code) for code in range(0xFF01, 0xFF5F))),
    ("中文标点", "、。〃〈〉《》「」『』【】〔〕〖〗〘〙〚〛〜〝〞〟〰〾〿…‥‧﹏"),
    ("数学与单位", "±×÷≈≠≤≥∞∝∑∏∫√∠⊥∥△▲◇◆○●★☆→←↑↓↔↕℃℉‰％§¶†‡"),
    ("易混淆汉字", "己已巳未末土士日曰目自木本八入人人力刀干于千戊戌戍候侯拨拔辨辩账帐"),
    ("数字串", "0123456789 9876543210 12345678901234567890 3.141592653589793 2.718281828459045"),
    ("拉丁字母", "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz"),
    ("希腊字母", "ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ αβγδεζηθικλμνξοπρστυφχψω"),
    ("重复汉字", "密集" * 30),
    ("重复标点", "。，、；：？！“”‘’（）【】《》〈〉「」『』…—－～" * 2),
    ("连续数字", "1234567890" * 8),
    ("混合符号", "→←↑↓↔↕⇒⇐⇔※§¶†‡•·…‰℃℉Ω±×÷≤≥≠≈"),
]

TABLE_HEADERS = ["序号", "名称", "数量", "单价", "金额", "时间戳", "批次号", "备注"]
TABLE_WIDTHS = [14.0, 30.0, 14.0, 18.0, 22.0, 30.0, 28.0, 24.0]
TABLE_ROWS = [
    ("01", "版式文档 A", "120", "36.50", "4,380.00", "2026-10-21 09:12:33", "HT-2026-1021-001", "正常"),
    ("02", "版式文档 B", "8", "1,280.00", "10,240.00", "2026-10-21 09:35:07", "HT-2026-1021-002", "加急"),
    ("03", "密集文本样本", "256", "12.80", "3,276.80", "2026-10-21 10:02:44", "HT-2026-1021-003", "测试"),
    ("04", "表格排版", "64", "88.00", "5,632.00", "2026-10-21 10:18:19", "HT-2026-1021-004", "—"),
    ("05", "字符覆盖", "1", "0.00", "0.00", "2026-10-21 10:40:02", "HT-2026-1021-005", "参考"),
    ("06", "字体子集", "3", "150.00", "450.00", "2026-10-21 11:05:56", "HT-2026-1021-006", "内嵌"),
    ("07", "两栏排版", "12", "66.60", "799.20", "2026-10-21 11:22:31", "HT-2026-1021-007", "正常"),
    ("08", "性能基线", "99", "9.99", "989.01", "2026-10-21 11:48:10", "HT-2026-1021-008", "基线"),
    ("09", "渲染回归", "48", "24.00", "1,152.00", "2026-10-21 12:03:27", "HT-2026-1021-009", "回归"),
    ("10", "转换验证", "7", "70.00", "490.00", "2026-10-21 12:29:45", "HT-2026-1021-010", "通过"),
    ("11", "归档样本", "100", "3.00", "300.00", "2026-10-21 12:55:08", "HT-2026-1021-011", "归档"),
    ("12", "汇总", "629", "—", "27,410.01", "2026-10-21 13:20:00", "HT-2026-1021-012", "合计"),
]

# ---------------------------------------------------------------------------
# 字体度量
# ---------------------------------------------------------------------------


@dataclass
class FontMetrics:
    """字体度量与子集化所需的信息。"""

    path: Path
    font_number: int
    ttfont: TTFont
    cmap: dict[int, str]
    hmtx: object
    upem: int

    @classmethod
    def load(cls, path: Path, font_number: int = 0) -> "FontMetrics":
        """读取字体，返回字符映射、水平度量与 em 尺寸。

        @param path 字体文件路径。
        @param font_number TTC 内的字体索引，TTF 固定为 0。
        @returns 字体度量对象。
        """
        ttfont = TTFont(path, fontNumber=font_number, lazy=False)
        cmap = ttfont.getBestCmap() or {}
        if not cmap:
            raise ValueError(f"字体没有可用的 Unicode cmap：{path}")
        return cls(
            path=path,
            font_number=font_number,
            ttfont=ttfont,
            cmap=cmap,
            hmtx=ttfont["hmtx"],
            upem=ttfont["head"].unitsPerEm,
        )

    def advance(self, char: str, size_mm: float) -> float:
        """返回单个字符在指定字号下的步进宽度。

        @param char 单个字符（按 Unicode 码点）。
        @param size_mm 字号，单位 mm。
        @returns 步进宽度，单位 mm。
        """
        glyph = self.cmap.get(ord(char))
        if glyph is None:
            raise KeyError(f"字体缺少字符 U+{ord(char):04X}（{char!r}）")
        advance_units = self.hmtx[glyph][0]
        return advance_units / self.upem * size_mm

    def measure(self, text: str, size_mm: float) -> float:
        """返回整串文字的自然宽度。

        @param text 文字内容。
        @param size_mm 字号，单位 mm。
        @returns 自然宽度，单位 mm。
        """
        return sum(self.advance(char, size_mm) for char in text)

    def subset_bytes(self, characters: set[str]) -> bytes:
        """把字体子集化为只包含指定字符的 TTF 字节。

        @param characters 需要保留的字符集合。
        @returns 子集字体文件字节。
        """
        font = TTFont(self.path, fontNumber=self.font_number, lazy=False)
        options = Options()
        options.name_IDs = ["*"]
        options.name_languages = ["*"]
        options.notdef_outline = True
        options.recalc_bounds = True
        options.recalc_timestamp = False
        subsetter = Subsetter(options=options)
        subsetter.populate(unicodes={ord(char) for char in characters})
        subsetter.subset(font)
        buffer = io.BytesIO()
        font.save(buffer)
        return buffer.getvalue()


# ---------------------------------------------------------------------------
# XML 与页面构建
# ---------------------------------------------------------------------------


def fmt(value: float, digits: int = 4) -> str:
    """格式化数值，去掉多余的零。

    @param value 待格式化的数值。
    @param digits 小数位数。
    @returns 适合写入 XML 属性或内容的字符串。
    """
    text = f"{value:.{digits}f}".rstrip("0").rstrip(".")
    if text in ("", "-0"):
        return "0"
    return text


def color_text(rgb: tuple[int, int, int]) -> str:
    """把 RGB 三元组转成 OFD 颜色值。

    @param rgb 0-255 的 RGB 分量。
    @returns 形如 "10 20 30" 的颜色字符串。
    """
    return f"{rgb[0]} {rgb[1]} {rgb[2]}"


def delta_x_attr(deltas: list[float]) -> str:
    """把逐字步进格式化为 TextCode 的 DeltaX 属性值。

    这里刻意使用展开形式而不使用 g 压缩组，优先保证第三方转换器兼容性。

    @param deltas 每个字符的步进，单位 mm。
    @returns 空格分隔的步进列表。
    """
    return " ".join(fmt(delta) for delta in deltas)


class PageWriter:
    """收集一页的绘制元素并生成 Content.xml。"""

    def __init__(self, builder: "DenseOfdBuilder"):
        self.builder = builder
        self.items: list[str] = []

    def _next_id(self) -> int:
        """分配文档内唯一的对象 ID。"""
        object_id = self.builder.next_id
        self.builder.next_id += 1
        return object_id

    def text(
        self,
        x: float,
        y: float,
        content: str,
        size: float,
        color: tuple[int, int, int] = (0, 0, 0),
        width: float | None = None,
        justify: bool = False,
        height: float | None = None,
    ) -> None:
        """追加一个单文本片段的 TextObject。

        @param x 边界框左边，单位 mm。
        @param y 边界框上边，单位 mm。
        @param content 文字内容；行尾空白会被去掉。
        @param size 字号，单位 mm。
        @param color 文字颜色，0-255。
        @param width 目标行宽（两端对齐时使用），单位 mm。
        @param justify 是否两端对齐。
        @param height 边界框高度，单位 mm；默认字号的一点二五倍。
        """
        content = content.rstrip()
        if not content:
            return
        self.builder.chars.update(content)

        font = self.builder.font
        advance_list = [font.advance(char, size) for char in content]
        natural = sum(advance_list)
        if justify and width is not None and len(advance_list) > 1 and natural < width:
            extra = (width - natural) / (len(advance_list) - 1)
            deltas = [advance + extra for advance in advance_list[:-1]] + [advance_list[-1]]
        else:
            deltas = advance_list
        box_width = width if (justify and width is not None) else natural
        box_height = height if height is not None else size * 1.25

        parts = [
            f'<ofd:TextObject ID="{self._next_id()}" '
            f'Boundary="{fmt(x)} {fmt(y)} {fmt(box_width)} {fmt(box_height)}" '
            f'Font="{FONT_ID}" Size="{fmt(size)}">'
        ]
        if color != (0, 0, 0):
            parts.append(f'<ofd:FillColor Value="{color_text(color)}"/>')
        parts.append(
            f'<ofd:TextCode X="0" Y="{fmt(size)}" DeltaX="{delta_x_attr(deltas)}">'
            f"{escape(content)}</ofd:TextCode>"
        )
        parts.append("</ofd:TextObject>")
        self.items.append("".join(parts))

    def cell(
        self,
        x: float,
        y: float,
        content: str,
        size: float,
        cell_width: float,
        align: str = "left",
        color: tuple[int, int, int] = (0, 0, 0),
    ) -> None:
        """追加一个用于表格单元格的 TextObject。

        @param x 单元格左边，单位 mm。
        @param y 单元格上边，单位 mm。
        @param content 单元格文字。
        @param size 字号，单位 mm。
        @param cell_width 单元格宽度，单位 mm。
        @param align 水平对齐：left/center/right。
        @param color 文字颜色。
        """
        content = content.rstrip()
        if not content:
            return
        self.builder.chars.update(content)
        font = self.builder.font
        deltas = [font.advance(char, size) for char in content]
        natural = sum(deltas)
        if align == "right":
            offset = max(0.0, cell_width - natural - 1.0)
        elif align == "center":
            offset = max(0.0, (cell_width - natural) / 2.0)
        else:
            offset = 1.0
        parts = [
            f'<ofd:TextObject ID="{self._next_id()}" '
            f'Boundary="{fmt(x)} {fmt(y)} {fmt(cell_width)} {fmt(size * 1.3)}" '
            f'Font="{FONT_ID}" Size="{fmt(size)}">'
        ]
        if color != (0, 0, 0):
            parts.append(f'<ofd:FillColor Value="{color_text(color)}"/>')
        parts.append(
            f'<ofd:TextCode X="{fmt(offset)}" Y="{fmt(size)}" '
            f'DeltaX="{delta_x_attr(deltas)}">{escape(content)}</ofd:TextCode>'
        )
        parts.append("</ofd:TextObject>")
        self.items.append("".join(parts))

    def line(
        self,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        width: float = 0.15,
        color: tuple[int, int, int] = (170, 170, 170),
    ) -> None:
        """追加一条直线路径。

        @param x1 起点 X，单位 mm。
        @param y1 起点 Y，单位 mm。
        @param x2 终点 X，单位 mm。
        @param y2 终点 Y，单位 mm。
        @param width 线宽，单位 mm。
        @param color 线颜色，0-255。
        """
        x = min(x1, x2) - width
        y = min(y1, y2) - width
        box_w = abs(x2 - x1) + width * 2
        box_h = abs(y2 - y1) + width * 2
        data = (
            f"M {fmt(x1 - x)} {fmt(y1 - y)} "
            f"L {fmt(x2 - x)} {fmt(y2 - y)}"
        )
        self.items.append(
            f'<ofd:PathObject ID="{self._next_id()}" '
            f'Boundary="{fmt(x)} {fmt(y)} {fmt(box_w)} {fmt(box_h)}" '
            f'LineWidth="{fmt(width)}" Stroke="true" Fill="false">'
            f'<ofd:StrokeColor Value="{color_text(color)}"/>'
            f"<ofd:AbbreviatedData>{data}</ofd:AbbreviatedData>"
            "</ofd:PathObject>"
        )

    def rect(
        self,
        x: float,
        y: float,
        width: float,
        height: float,
        fill: tuple[int, int, int],
    ) -> None:
        """追加一个填充矩形（用于表头底色、代码块底色）。

        @param x 左边，单位 mm。
        @param y 上边，单位 mm。
        @param width 宽，单位 mm。
        @param height 高，单位 mm。
        @param fill 填充颜色，0-255。
        """
        self.items.append(
            f'<ofd:PathObject ID="{self._next_id()}" '
            f'Boundary="{fmt(x)} {fmt(y)} {fmt(width)} {fmt(height)}" '
            f'Stroke="false" Fill="true">'
            f'<ofd:FillColor Value="{color_text(fill)}"/>'
            f"<ofd:AbbreviatedData>M 0 0 L {fmt(width)} 0 L {fmt(width)} {fmt(height)} "
            f"L 0 {fmt(height)} Z</ofd:AbbreviatedData>"
            "</ofd:PathObject>"
        )

    def xml(self) -> str:
        """生成该页的 Content.xml 文本。"""
        return (
            '<?xml version="1.0" encoding="UTF-8"?>'
            f'<ofd:Page xmlns:ofd="{OFD_NS}">'
            f"<ofd:Area><ofd:PhysicalBox>0 0 {fmt(PAGE_W)} {fmt(PAGE_H)}</ofd:PhysicalBox></ofd:Area>"
            '<ofd:Content><ofd:Layer ID="1">'
            + "".join(self.items)
            + "</ofd:Layer></ofd:Content></ofd:Page>"
        )


# ---------------------------------------------------------------------------
# 文本断行
# ---------------------------------------------------------------------------


def tokenize(text: str) -> list[str]:
    """把文字切成排版单元：中文按单字，英文/数字按词，空白单独保留。

    @param text 原始文字。
    @returns 排版单元列表。
    """
    tokens: list[str] = []
    for part in re.split(r"(\s+)", text):
        if not part:
            continue
        if part.isspace():
            tokens.append(part)
            continue
        buffer = ""
        for char in part:
            # 中文、全角符号与 CJK 标点按单字成 token，便于任意位置断行
            if ord(char) >= 0x2E80:
                if buffer:
                    tokens.append(buffer)
                    buffer = ""
                tokens.append(char)
            else:
                buffer += char
        if buffer:
            tokens.append(buffer)
    return tokens


def wrap_text(
    text: str,
    size: float,
    width: float,
    font: FontMetrics,
    first_width: float | None = None,
) -> list[str]:
    """按目标宽度把段落折成多行。

    @param text 段落文字。
    @param size 字号，单位 mm。
    @param width 后续行的可用宽度，单位 mm。
    @param font 字体度量。
    @param first_width 首行可用宽度，单位 mm；默认与 width 相同。
    @returns 折行后的文字行列表。
    """
    tokens = tokenize(text)
    lines: list[str] = []
    current: list[str] = []
    current_width = 0.0
    limit = first_width if first_width is not None else width

    def flush() -> None:
        """把当前行去尾空白后收行，并重置行宽限制。"""
        nonlocal current, current_width, limit
        while current and current[-1].isspace():
            current_width -= font.measure(current[-1], size)
            current.pop()
        if current:
            lines.append("".join(current))
        current = []
        current_width = 0.0
        limit = width

    for token in tokens:
        if not current and token.isspace():
            continue
        token_width = font.measure(token, size)
        if token_width > limit:
            # 超宽单词或长串：按字符强制拆分，避免整行溢出页面
            for char in token:
                char_width = font.measure(char, size)
                if current and current_width + char_width > limit:
                    flush()
                current.append(char)
                current_width += char_width
            continue
        if current and current_width + token_width > limit:
            # 行首禁则：收尾标点跟随上一行，允许小幅悬挂
            if token[0] in NO_LINE_START:
                current.append(token)
                current_width += token_width
                continue
            flush()
            if token.isspace():
                continue
        current.append(token)
        current_width += token_width
    if current:
        while current and current[-1].isspace():
            current.pop()
        if current:
            lines.append("".join(current))
    return lines


# ---------------------------------------------------------------------------
# 页面布局
# ---------------------------------------------------------------------------


class DenseOfdBuilder:
    """负责组织页面、分配 ID、收集字符集并输出 OFD 包。"""

    def __init__(self, font: FontMetrics, page_count: int, created: str, title: str):
        """初始化生成器。

        @param font 字体度量。
        @param page_count 页数。
        @param created 创建日期，YYYY-MM-DD。
        @param title 文档标题。
        """
        self.font = font
        self.page_count = page_count
        self.created = created
        self.title = title
        self.next_id = 100
        self.chars: set[str] = set()
        self.pages: list[PageWriter] = []

    # -- 通用元素 ---------------------------------------------------------

    def new_page(self) -> PageWriter:
        """创建一页并返回写入器。"""
        page = PageWriter(self)
        self.pages.append(page)
        return page

    def add_header(self, page: PageWriter, page_no: int) -> None:
        """绘制页眉与页眉分隔线。

        @param page 页面写入器。
        @param page_no 当前页码，从 1 开始。
        """
        page.text(
            MARGIN,
            HEADER_Y,
            "OFD 密集文本渲染测试样本 · Dense Text Fixture v1",
            HEADER_SIZE,
            color=(105, 105, 105),
        )
        right = f"PAGE {page_no:02d} / {self.page_count:02d}"
        right_width = self.font.measure(right, HEADER_SIZE)
        page.text(
            PAGE_W - MARGIN - right_width,
            HEADER_Y,
            right,
            HEADER_SIZE,
            color=(105, 105, 105),
        )
        page.line(MARGIN, RULE_Y, PAGE_W - MARGIN, RULE_Y, 0.12, (185, 185, 185))

    def add_footer(self, page: PageWriter, page_no: int) -> None:
        """绘制页脚。

        @param page 页面写入器。
        @param page_no 当前页码，从 1 开始。
        """
        left = (
            f"生成：{self.created} · 用途：文字渲染 / 版面 / 性能回归 · "
            "内嵌宋体子集（仅含本文用字）"
        )
        page.text(MARGIN, FOOTER_Y, left, FOOTER_SIZE, color=(120, 120, 120))
        right = f"Page {page_no:02d} of {self.page_count:02d} · A4 210×297 mm"
        right_width = self.font.measure(right, FOOTER_SIZE)
        page.text(
            PAGE_W - MARGIN - right_width,
            FOOTER_Y,
            right,
            FOOTER_SIZE,
            color=(120, 120, 120),
        )

    def add_chapter(self, page: PageWriter, title: str, y: float) -> float:
        """绘制章节标题，返回其后内容的起始 Y。

        @param page 页面写入器。
        @param title 章节标题。
        @param y 标题上边，单位 mm。
        @returns 正文起始 Y，单位 mm。
        """
        page.text(MARGIN, y, title, pt(10.5), color=(0, 60, 120))
        return y + 6.5

    def fill_paragraphs(
        self,
        page: PageWriter,
        y: float,
        bottom: float,
        paragraphs: list[str],
        start: int,
        size: float = pt(8.0),
        pitch: float = 3.6,
        width: float = CONTENT_W,
        x: float = MARGIN,
        indent: bool = True,
        color: tuple[int, int, int] = (0, 0, 0),
    ) -> float:
        """用段落流填满页面剩余空间。

        @param page 页面写入器。
        @param y 起始 Y，单位 mm。
        @param bottom 内容区下边界，单位 mm。
        @param paragraphs 段落池。
        @param start 段落池起始下标。
        @param size 字号，单位 mm。
        @param pitch 行距，单位 mm。
        @param width 栏宽，单位 mm。
        @param x 栏左边，单位 mm。
        @param indent 是否首行缩进两个字符。
        @param color 文字颜色。
        @returns 实际结束的 Y，单位 mm。
        """
        index = start
        while y + size * 1.2 < bottom:
            paragraph = paragraphs[index % len(paragraphs)]
            index += 1
            first_width = width - (size * 2) if indent else width
            lines = wrap_text(paragraph, size, width, self.font, first_width)
            for line_index, line in enumerate(lines):
                if y + size * 1.2 > bottom:
                    break
                line_x = x
                if indent and line_index == 0:
                    # 首行缩进两个字符，可用宽度同步收窄
                    line_x = x + size * 2
                target_width = width - (line_x - x)
                is_last = line_index == len(lines) - 1
                page.text(
                    line_x,
                    y,
                    line,
                    size,
                    color=color,
                    width=target_width,
                    justify=not is_last,
                )
                y += pitch
            y += pitch * 0.35
        return y

    # -- 各类页面 ---------------------------------------------------------

    def build_title_page(self, page_no: int) -> None:
        """第 1 页：大标题、摘要与正文。"""
        page = self.new_page()
        self.add_header(page, page_no)
        page.text(MARGIN, 30, "OFD 密集文本", pt(24), color=(0, 40, 90))
        page.text(MARGIN, 42, "渲染测试样本 · DENSE TEXT FIXTURE", pt(12), color=(0, 90, 150))
        page.line(MARGIN, 49, MARGIN + 120, 49, 0.4, (0, 90, 150))
        page.text(
            MARGIN,
            54,
            "本样本用于检查 OFD 阅读器与转换器在密集中文、英文、数字混排下的"
            "版面还原、断行、对齐、字形回退和渲染性能。",
            pt(8),
            color=(60, 60, 60),
        )
        page.text(
            MARGIN,
            63,
            "样本内嵌宋体子集；页面包含正文、页眉页脚、表格、两栏、代码行、"
            "字符覆盖区以及多字号彩色文字。",
            pt(8),
            color=(60, 60, 60),
        )
        y = self.add_chapter(page, "0 样本说明", 76)
        y = self.fill_paragraphs(
            page,
            y,
            BODY_BOTTOM,
            CN_PARAGRAPHS,
            start=0,
            size=pt(8.0),
            pitch=3.6,
        )
        self.add_footer(page, page_no)

    def build_plain_page(self, page_no: int, chapter: str, paragraphs: list[str], start: int) -> None:
        """普通正文页：章节标题 + 段落流。

        @param page_no 页码。
        @param chapter 章节标题。
        @param paragraphs 段落池。
        @param start 段落池起始下标。
        """
        page = self.new_page()
        self.add_header(page, page_no)
        y = self.add_chapter(page, chapter, BODY_TOP)
        self.fill_paragraphs(page, y, BODY_BOTTOM, paragraphs, start)
        self.add_footer(page, page_no)

    def build_dense_small_page(self, page_no: int) -> None:
        """第 6 页：8pt / 6pt / 5pt 三级密度对照。"""
        page = self.new_page()
        self.add_header(page, page_no)
        y = self.add_chapter(page, "6 版面密度：8pt / 6pt / 5pt", BODY_TOP)
        y = self.fill_paragraphs(
            page, y, 92, CN_PARAGRAPHS, start=5, size=pt(8.0), pitch=3.6
        )
        page.text(MARGIN, y + 1, "6.1 六磅正文（行距 2.9 mm）", pt(7), color=(0, 60, 120))
        y += 5.0
        y = self.fill_paragraphs(
            page, y, 218, CN_PARAGRAPHS, start=0, size=pt(6.0), pitch=2.9
        )
        page.text(MARGIN, y + 1, "6.2 五磅注释（行距 2.4 mm）", pt(6), color=(0, 60, 120))
        y += 4.0
        note = (
            "五磅文字常用于票据附注、合同小字和表格脚注。此区域用于观察笔画粘连、"
            "抗锯齿灰度与行距压缩后的可读性。0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ "
            "abcdefghijklmnopqrstuvwxyz。"
        )
        lines = wrap_text(note * 3, pt(5.0), CONTENT_W, self.font)
        for line in lines:
            if y + 4.0 > BODY_BOTTOM:
                break
            page.text(MARGIN, y, line, pt(5.0), color=(55, 55, 55))
            y += 2.4
        self.add_footer(page, page_no)

    def build_coverage_page(self, page_no: int) -> None:
        """第 7 页：字符覆盖与容易混淆的字形。"""
        page = self.new_page()
        self.add_header(page, page_no)
        y = self.add_chapter(page, "7 字符覆盖与易混淆字形", BODY_TOP)
        for label, chars in COVERAGE_LINES:
            available = "".join(char for char in chars if ord(char) in self.font.cmap)
            if not available:
                continue
            line_text = f"{label}：{available}"
            for line in wrap_text(line_text, pt(7.0), CONTENT_W, self.font):
                if y + 3.5 > BODY_BOTTOM - 20:
                    break
                page.text(MARGIN, y, line, pt(7.0), color=(0, 0, 0))
                self.chars.update(line)
                y += 5.0
            y += 0.2
            if y > BODY_BOTTOM - 20:
                break
        page.text(MARGIN, y + 2, "说明：以上字符均来自内嵌宋体子集，缺失字符已省略。", pt(6), color=(90, 90, 90))
        y += 8
        self.fill_paragraphs(page, y, BODY_BOTTOM, CN_PARAGRAPHS, start=8, size=pt(8.0), pitch=3.6)
        self.add_footer(page, page_no)

    def build_code_page(self, page_no: int) -> None:
        """第 8 页：长 URL、文件路径与代码片段。"""
        page = self.new_page()
        self.add_header(page, page_no)
        y = self.add_chapter(page, "8 长 URL、路径与代码行", BODY_TOP)
        code_size = pt(6.8)
        code_pitch = 4.6
        block_top = y
        page.rect(MARGIN - 1, block_top - 1, CONTENT_W + 2, code_pitch * (len(CODE_LINES) + 1), (242, 244, 247))
        y += 1.5
        for line in CODE_LINES:
            page.text(MARGIN, y, line, code_size, color=(30, 30, 30))
            y += code_pitch
        y += 4
        page.text(MARGIN, y, "8.1 混排段落与网址断行", pt(7), color=(0, 60, 120))
        y += 5
        y = self.fill_paragraphs(page, y, BODY_BOTTOM - 6, MIXED_PARAGRAPHS + EN_PARAGRAPHS, start=0, size=pt(8.0), pitch=3.6)
        self.add_footer(page, page_no)

    def build_table_page(self, page_no: int) -> None:
        """第 9 页：数字与文本混合表格。"""
        page = self.new_page()
        self.add_header(page, page_no)
        y = self.add_chapter(page, "9 表格：数字右对齐与混合内容", BODY_TOP)
        table_x = MARGIN
        table_y = y
        header_h = 7.5
        row_h = 7.0
        total_w = sum(TABLE_WIDTHS)

        page.rect(table_x, table_y, total_w, header_h, (225, 234, 244))
        column_x = table_x
        for title, column_w in zip(TABLE_HEADERS, TABLE_WIDTHS):
            page.cell(column_x, table_y, title, pt(7.0), column_w, "center", (0, 45, 90))
            column_x += column_w

        data_top = table_y + header_h
        for row_index, row in enumerate(TABLE_ROWS):
            row_y = data_top + row_index * row_h
            if row_index % 2 == 1:
                page.rect(table_x, row_y, total_w, row_h, (247, 249, 252))
            column_x = table_x
            for column_index, (value, column_w) in enumerate(zip(row, TABLE_WIDTHS)):
                align = "right" if column_index in (2, 3, 4) else "left"
                page.cell(column_x, row_y, value, pt(6.8), column_w, align)
                column_x += column_w
            page.line(table_x, row_y + row_h, table_x + total_w, row_y + row_h, 0.1, (210, 215, 222))

        table_bottom = data_top + len(TABLE_ROWS) * row_h
        page.line(table_x, table_y, table_x + total_w, table_y, 0.2, (120, 140, 160))
        page.line(table_x, table_bottom, table_x + total_w, table_bottom, 0.2, (120, 140, 160))
        page.line(table_x, table_y, table_x, table_bottom, 0.2, (120, 140, 160))
        page.line(table_x + total_w, table_y, table_x + total_w, table_bottom, 0.2, (120, 140, 160))

        note_y = table_bottom + 4
        note = (
            "表 1：测试表格。金额列按右对齐处理，数量与单价使用等宽数字；"
            "时间戳和批次号包含连字符与数字，用于检查混排断行。"
        )
        page.text(MARGIN, note_y, note, pt(6.0), color=(90, 90, 90))
        self.chars.update(note)
        self.fill_paragraphs(page, note_y + 9, BODY_BOTTOM, CN_PARAGRAPHS, start=7, size=pt(8.0), pitch=3.6)
        self.add_footer(page, page_no)

    def build_mixed_page(self, page_no: int) -> None:
        """第 10 页：两栏、彩色文字、大字与 5pt 密集块。"""
        page = self.new_page()
        self.add_header(page, page_no)
        y = self.add_chapter(page, "10 两栏与多字号混排", BODY_TOP)

        left_x, left_w = MARGIN, 86.0
        right_x, right_w = MARGIN + left_w + 8.0, CONTENT_W - left_w - 8.0
        column_bottom = 148.0
        self.fill_paragraphs(
            page, y, column_bottom, CN_PARAGRAPHS, start=2, size=pt(7.2), pitch=3.3,
            width=left_w, x=left_x,
        )
        page.line(right_x - 4, y - 4, right_x - 4, column_bottom, 0.1, (215, 215, 215))
        self.fill_paragraphs(
            page, y, column_bottom, MIXED_PARAGRAPHS + EN_PARAGRAPHS, start=0, size=pt(7.2), pitch=3.3,
            width=right_w, x=right_x,
        )

        y = 152
        page.text(MARGIN, y, "10.1 五磅密集块（行距 2.35 mm）", pt(6), color=(0, 60, 120))
        y += 3.5
        dense_note = (
            "密集文本块用于测试最小字号下的排版稳定性。中文：版式文档、字形轮廓、"
            "字符映射、两端对齐、字体回退、抗锯齿、透明度、裁剪区域。英文："
            "glyph outline, character map, justification, fallback, antialiasing. "
            "数字：1024 2048 4096 8192 16384 32768 65536。"
        )
        lines = wrap_text(dense_note * 2, pt(5.0), CONTENT_W, self.font)
        for line in lines:
            if y + 3.0 > 205:
                break
            page.text(MARGIN, y, line, pt(5.0), color=(40, 40, 40))
            y += 2.35

        page.text(MARGIN, 210, "密集文本 Dense Text 0123456789", pt(20), color=(0, 40, 90))
        page.text(MARGIN, 222, "红色文字：渲染测试 Red", pt(9), color=(190, 30, 30))
        page.text(MARGIN, 228, "蓝色文字：字形回退 Blue", pt(9), color=(20, 60, 180))
        page.text(MARGIN, 234, "绿色文字：对齐检查 Green", pt(9), color=(20, 130, 70))
        page.text(MARGIN, 240, "灰色文字：注释说明 Gray 0123456789", pt(9), color=(120, 120, 120))
        page.text(
            MARGIN,
            250,
            "页脚上方保留多行 6pt 文字，用于检查页面底部的内容边界："
            "页面尺寸、页边距、行距与文字基线之间应当保持一致。",
            pt(6.0),
            color=(60, 60, 60),
        )
        footer_note = (
            "0101010101 密 密密 密密密 密密密密 密密密密密 密密密密密密 "
            "A1B2C3D4E5F6 9876543210"
        )
        lines = wrap_text(footer_note * 3, pt(6.0), CONTENT_W, self.font)
        y = 257
        for line in lines:
            if y + 3.2 > BODY_BOTTOM:
                break
            page.text(MARGIN, y, line, pt(6.0), color=(80, 80, 80))
            y += 3.2
        self.add_footer(page, page_no)

    # -- 打包 -------------------------------------------------------------

    def build(self) -> bytes:
        """生成所有页面并返回 OFD 文件的 ZIP 字节。"""
        # 固定随机顺序，保证每次生成的内容一致
        rng = random.Random(20261021)
        cn_order = CN_PARAGRAPHS[:]
        mixed_order = MIXED_PARAGRAPHS + EN_PARAGRAPHS
        rng.shuffle(mixed_order)

        paragraph_cursor = 0
        for page_index in range(self.page_count):
            page_no = page_index + 1
            if page_no == 1:
                self.build_title_page(page_no)
            elif page_no == 6:
                self.build_dense_small_page(page_no)
            elif page_no == 7:
                self.build_coverage_page(page_no)
            elif page_no == 8:
                self.build_code_page(page_no)
            elif page_no == 9:
                self.build_table_page(page_no)
            elif page_no == 10:
                self.build_mixed_page(page_no)
            else:
                # 普通页在中文、混排、英文之间轮换
                if page_no % 3 == 0:
                    paragraphs = EN_PARAGRAPHS + CN_PARAGRAPHS
                elif page_no % 3 == 1:
                    paragraphs = mixed_order
                else:
                    paragraphs = cn_order
                chapter = CHAPTERS[(page_no - 2) % len(CHAPTERS)]
                self.build_plain_page(page_no, chapter, paragraphs, paragraph_cursor)
                paragraph_cursor += 4

        # 所有页面都建好后，再统一子集化字体并写 ZIP
        subset = self.font.subset_bytes(self.chars)
        return self.write_package(subset)

    def write_package(self, font_bytes: bytes) -> bytes:
        """把页面 XML、资源与字体写入 ZIP 容器。

        @param font_bytes 子集字体字节。
        @returns 完整 OFD 文件字节。
        """
        pages_xml: list[str] = []
        for page in self.pages:
            pages_xml.append(page.xml())

        page_entries = []
        for index in range(self.page_count):
            page_entries.append(
                f'<ofd:Page ID="{index + 1}" BaseLoc="Pages/Page_{index}/Content.xml"/>'
            )

        doc_xml = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            f'<ofd:Document xmlns:ofd="{OFD_NS}">'
            "<ofd:CommonData>"
            f"<ofd:MaxUnitID>{self.next_id - 1}</ofd:MaxUnitID>"
            f"<ofd:PageArea><ofd:PhysicalBox>0 0 {fmt(PAGE_W)} {fmt(PAGE_H)}</ofd:PhysicalBox>"
            f"<ofd:ApplicationBox>0 0 {fmt(PAGE_W)} {fmt(PAGE_H)}</ofd:ApplicationBox></ofd:PageArea>"
            "<ofd:PublicRes>PublicRes.xml</ofd:PublicRes>"
            "</ofd:CommonData>"
            "<ofd:Pages>" + "".join(page_entries) + "</ofd:Pages>"
            "</ofd:Document>"
        )

        public_res_xml = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            f'<ofd:Res xmlns:ofd="{OFD_NS}" BaseLoc="Res">'
            "<ofd:Fonts>"
            f'<ofd:Font ID="{FONT_ID}" FontName="{quoteattr(FONT_NAME)[1:-1]}" '
            f'FamilyName="{quoteattr(FONT_FAMILY)[1:-1]}" Charset="unicode">'
            f"<ofd:FontFile>{FONT_FILE_NAME}</ofd:FontFile>"
            "</ofd:Font>"
            "</ofd:Fonts>"
            "</ofd:Res>"
        )

        doc_id = uuid.uuid5(uuid.NAMESPACE_URL, f"dense-text-{self.created}").hex
        ofd_xml = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            f'<ofd:OFD xmlns:ofd="{OFD_NS}" Version="1.0" DocType="OFD">'
            "<ofd:DocBody><ofd:DocInfo>"
            f"<ofd:DocID>{doc_id}</ofd:DocID>"
            f"<ofd:Title>{escape(self.title)}</ofd:Title>"
            "<ofd:Creator>ofdrw-viewer dense-text fixture</ofd:Creator>"
            "<ofd:CreatorVersion>1.0</ofd:CreatorVersion>"
            f"<ofd:CreationDate>{self.created}</ofd:CreationDate>"
            "</ofd:DocInfo>"
            "<ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot>"
            "</ofd:DocBody></ofd:OFD>"
        )

        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            def put(name: str, data: str | bytes) -> None:
                archive.writestr(name, data.encode("utf-8") if isinstance(data, str) else data)

            put("OFD.xml", ofd_xml)
            put("Doc_0/Document.xml", doc_xml)
            put("Doc_0/PublicRes.xml", public_res_xml)
            put(f"Doc_0/Res/{FONT_FILE_NAME}", font_bytes)
            for index, xml in enumerate(pages_xml):
                put(f"Doc_0/Pages/Page_{index}/Content.xml", xml)
        return buffer.getvalue()


# ---------------------------------------------------------------------------
# 命令行入口
# ---------------------------------------------------------------------------


def default_font_path() -> tuple[Path, int]:
    """按优先级查找可用的中文字体。

    @returns (字体路径, TTC 索引)。
    """
    repo_root = Path(__file__).resolve().parents[2]
    candidates: list[tuple[Path, int]] = [
        (repo_root / "references" / "ofd.js" / "src" / "assets" / "simsun.ttf", 0),
        (Path.home() / ".local" / "share" / "fonts" / "SimSun.ttc", 0),
        (Path("/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf"), 0),
    ]
    for path, index in candidates:
        if path.exists():
            return path, index
    raise FileNotFoundError(
        "未找到可用中文字体，请用 --font 指定 SimSun 或其他中文字体文件"
    )


def main() -> int:
    """解析参数、生成 OFD 并输出摘要。

    @returns 进程退出码，0 表示成功。
    """
    parser = argparse.ArgumentParser(description="生成密集文本 OFD 测试样本")
    parser.add_argument(
        "--out",
        default="test/.artifacts/dense-text/dense-text.ofd",
        help="输出文件路径（默认 test/.artifacts/dense-text/dense-text.ofd）",
    )
    parser.add_argument("--pages", type=int, default=10, help="页数，默认 10")
    parser.add_argument("--font", default=None, help="字体文件路径（TTF/TTC）")
    parser.add_argument("--font-number", type=int, default=0, help="TTC 内的字体索引")
    parser.add_argument(
        "--date",
        default=date.today().isoformat(),
        help="文档创建日期，默认当天",
    )
    parser.add_argument(
        "--title",
        default="OFD 密集文本渲染测试样本",
        help="文档标题",
    )
    args = parser.parse_args()

    if args.pages < 1:
        parser.error("--pages 必须大于 0")

    if args.font:
        font_path, font_number = Path(args.font), args.font_number
    else:
        font_path, font_number = default_font_path()

    font = FontMetrics.load(font_path, font_number)
    builder = DenseOfdBuilder(font, args.pages, args.date, args.title)
    data = builder.build()

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(data)

    print(f"已生成：{out_path}")
    print(f"页数：{args.pages}，大小：{len(data) / 1024:.1f} KB")
    print(f"字体：{font_path}（index={font_number}，upem={font.upem}）")
    print(f"用字：{len(builder.chars)} 个不同字符")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())