#!/usr/bin/env python3
"""生成带多种格式附件的 OFD 样例（``ofd_pdf_match/附件样例.ofd``）。

样例自建 OFD 包，不依赖其它样本：单页横版正文列出附件清单，
``Doc_0/Attachments.xml`` 声明 11 个附件（docx、xlsx、pptx、txt、csv、xml、json、
png、jpeg、mp3、mp4），附件实体放在 ``Doc_0/Res`` 下。

用法：
    python3 scripts/make-attachment-sample.py [输出目录]

输出目录默认 ``ofd_pdf_match``。生成结果只依赖标准库，可在任意机器复现。

依赖：
    - Pillow：生成 png/jpeg 图片素材；
    - ffmpeg（含 libmp3lame、libx264）：生成 mp3/mp4 音视频素材；
    - python-docx / openpyxl / python-pptx：生成 docx/xlsx/pptx 素材。
    缺少 python-docx 或 python-pptx 时改用内置的最小 OOXML 模板兜底。
"""

from __future__ import annotations

import datetime as _dt
import math
import os
import re
import shutil
import struct
import sys
import tempfile
import wave
import zipfile
import zlib
from dataclasses import dataclass
from xml.sax.saxutils import escape

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(ROOT, "ofd_pdf_match")

#: 输出文件名。
OUTPUT_NAME = "附件样例.ofd"

#: 包内正文页面尺寸，单位 mm（宽、高）。
PAGE_WIDTH_MM = 297
PAGE_HEIGHT_MM = 210

#: 演示用固定时间戳，保证多次生成结果字节一致；元组格式 (年, 月, 日, 时, 分, 秒)。
ZIP_DATE_TIME = (2026, 11, 18, 0, 0, 0)
ISO_DATE = "2026-11-18"

#: 正文优先使用的中文字体候选（文件名 → 展示名）；均不存在时回退内置圆点字体。
BODY_FONT_CANDIDATES = (
    ("/usr/share/fonts/truetype/wqy/wqy-microhei.ttc", "WenQuanYi Micro Hei"),
    ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", "WenQuanYi Zen Hei"),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "Noto Sans CJK SC"),
    ("/mnt/c/Windows/Fonts/simsun.ttc", "SimSun"),
    ("/mnt/c/Windows/Fonts/msyh.ttc", "Microsoft YaHei"),
)

#: 附件声明；顺序即 Attachments.xml 中的声明顺序。
#: 每项为 (附件名, Format, ContentType, 说明)；附件名不含扩展名。
#: 包内实体文件名为 ``<附件名>.<Format>``。
ATTACHMENTS = (
    ("演示文稿说明", "docx",
     "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Word 文档附件"),
    ("销售数据", "xlsx",
     "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Excel 表格附件"),
    ("演示幻灯片", "pptx",
     "application/vnd.openxmlformats-officedocument.presentationml.presentation", "PowerPoint 幻灯片附件"),
    ("说明", "txt", "text/plain", "纯文本附件"),
    ("样例数据", "csv", "text/csv", "逗号分隔数据附件"),
    ("配置示例", "xml", "application/xml", "XML 结构化数据附件"),
    ("配置示例", "json", "application/json", "JSON 结构化数据附件"),
    ("示意图", "png", "image/png", "PNG 位图附件"),
    ("照片", "jpeg", "image/jpeg", "JPEG 位图附件"),
    ("音频样例", "mp3", "audio/mpeg", "MP3 音频附件"),
    ("视频样例", "mp4", "video/mp4", "MP4 视频附件"),
)


@dataclass(frozen=True)
class AttachEntry:
    """单个附件的索引信息。"""

    #: 附件 ID（Attachments.xml 中 Attachment@ID），从 1 开始递增。
    attach_id: int
    #: 包内实体路径，例如 ``Doc_0/Res/说明.txt``。
    pack_path: str
    #: 素材字节。
    data: bytes
    #: 附件显示名（不含扩展名）。
    name: str
    #: 格式标识，小写扩展名词，例如 ``png``。
    fmt: str
    #: MIME 类型。
    content_type: str
    #: 附件说明。
    desc: str
    #: 正文清单中展示的用途分类。
    category: str

    @property
    def size_kb(self) -> float:
        """附件大小，单位 KB（GB/T 33190 中 Attachment@Size 的声明单位）。"""
        return round(len(self.data) / 1024.0, 4)


# --------------------------------------------------------------------------- #
# 素材：文本类
# --------------------------------------------------------------------------- #

TXT_BODY = """OFD 附件样例 · 纯文本说明
================================

本文件作为 OFD 包的 txt 类型附件，用于验证：
  1. Attachments.xml 中附件条目的 Name / Format / Size / FileLoc 字段；
  2. 查看器附件列表的展示与按格式筛选；
  3. 附件内容导出后与原始文件逐字节一致。

编码：UTF-8（含中文），行尾：LF。
生成日期：2026-11-18
"""

CSV_BODY = """订单号,客户,城市,下单日期,金额(元),状态
SO-2026-0001,华信科技,北京,2026-01-08,12800.00,已完成
SO-2026-0002,恒远物流,上海,2026-01-15,7600.50,已完成
SO-2026-0003,蓝海设计,杭州,2026-02-03,3420.00,已发货
SO-2026-0004,辰星传媒,深圳,2026-02-19,15800.00,待发货
SO-2026-0005,云图数据,成都,2026-03-02,980.00,已退款
SO-2026-0006,知微教育,南京,2026-03-21,5300.75,已完成
"""

XML_BODY = """<?xml version="1.0" encoding="UTF-8"?>
<viewer xmlns="urn:example:ofd-viewer:config">
  <version>1.0</version>
  <render pageMode="single" dpi="144" antiAlias="true"/>
  <attachments filter="*" showSize="true" downloadAllowed="true"/>
  <locale default="zh-CN">
    <fallback>en-US</fallback>
  </locale>
  <export>
    <image format="png" quality="0.92"/>
    <allowFormats>png jpeg svg</allowFormats>
  </export>
</viewer>
"""

JSON_BODY = """{
  "name": "ofd-attachment-sample",
  "version": "1.0.0",
  "generatedAt": "2026-11-18",
  "attachments": [
    { "format": "docx", "file": "演示文稿说明.docx", "category": "document" },
    { "format": "xlsx", "file": "销售数据.xlsx", "category": "spreadsheet" },
    { "format": "pptx", "file": "演示幻灯片.pptx", "category": "presentation" },
    { "format": "txt", "file": "说明.txt", "category": "text" },
    { "format": "csv", "file": "样例数据.csv", "category": "text" },
    { "format": "xml", "file": "配置示例.xml", "category": "text" },
    { "format": "json", "file": "配置示例.json", "category": "text" },
    { "format": "png", "file": "示意图.png", "category": "image" },
    { "format": "jpeg", "file": "照片.jpg", "category": "image" },
    { "format": "mp3", "file": "音频样例.mp3", "category": "audio" },
    { "format": "mp4", "file": "视频样例.mp4", "category": "video" }
  ],
  "options": { "pretty": true, "unicode": "utf-8" }
}
"""


# --------------------------------------------------------------------------- #
# 素材：图片（Pillow 可用时绘制示意图，否则写内置 PNG/JPEG）
# --------------------------------------------------------------------------- #

def _find_font_file() -> str | None:
    """查找可用于绘图的字体文件。

    @returns 字体文件绝对路径；未找到时返回 None。
    """
    for path, _ in BODY_FONT_CANDIDATES:
        if os.path.exists(path):
            return path
    return None


def _make_solid_png(width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    """不依赖第三方库生成单色 PNG。

    @param width 宽度，单位 px。
    @param height 高度，单位 px。
    @param rgb 像素颜色 (R, G, B)。
    @returns PNG 文件字节。
    """
    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))

    def chunk(tag: bytes, payload: bytes) -> bytes:
        body = tag + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def _make_solid_jpeg(width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    """生成最小 JPEG（无第三方库时兜底）。

    仅支持灰度/彩色基线编码的简化版本：整体为单色块，尺寸写入 SOF0。

    @param width 宽度，单位 px。
    @param height 高度，单位 px。
    @param rgb 像素颜色 (R, G, B)。
    @returns JPEG 文件字节。
    """
    # 单色图：所有块 DC 差值相同，简化实现只写出 3 个分量表头与最小扫描数据。
    # 该兜底不追求像素精确，仅供缺少 Pillow 时保持附件格式完整。
    def seg(marker: int, payload: bytes) -> bytes:
        return bytes([0xFF, marker]) + struct.pack(">H", len(payload) + 2) + payload

    dqt = seg(0xDB, b"\x00" + bytes([1] * 64))
    sof = seg(0xC0, struct.pack(">BHHB", 8, height, width, 3)
              + b"\x01\x11\x00" + b"\x02\x11\x00" + b"\x03\x11\x00")
    dht_dc = seg(0xC4, b"\x00" + bytes([1] + [0] * 15) + b"\x00")
    dht_ac = seg(0xC4, b"\x10" + bytes([1] + [0] * 15) + b"\x00")
    sos = seg(0xDA, b"\x03\x01\x00\x02\x00\x03\x00\x00\x3f\x00")
    # 单色图：每个 MCU 的三个分量块均输出 DC 后立即 EOB，编码固定为两字节。
    mcu_count = math.ceil(width / 8) * math.ceil(height / 8)
    entropy = b"\x28\x00" * (mcu_count * 3)
    del rgb  # 兜底图仅保证格式合法，不按颜色染色
    return b"\xFF\xD8" + dqt + sof + dht_dc + dht_ac + sos + entropy + b"\xFF\xD9"


def make_png(width: int = 640, height: int = 400) -> bytes:
    """生成一张带文字与图形的示意图（PNG 格式）。

    @param width 宽度，单位 px。
    @param height 高度，单位 px。
    @returns PNG 文件字节。
    """
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return _make_solid_png(width, height, (238, 244, 252))

    font_path = _find_font_file()
    big = ImageFont.truetype(font_path, 34) if font_path else ImageFont.load_default()
    mid = ImageFont.truetype(font_path, 20) if font_path else ImageFont.load_default()
    image = Image.new("RGB", (width, height), (238, 244, 252))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle([20, 20, width - 20, height - 20], radius=18,
                           fill=(255, 255, 255), outline=(60, 110, 200), width=3)
    draw.text((44, 52), "附件样例：PNG 图片", font=big, fill=(30, 60, 140))
    draw.text((44, 110), "OFD 附件索引测试用图", font=mid, fill=(90, 90, 90))
    for index, color in enumerate([(230, 90, 90), (240, 180, 70), (90, 180, 120), (90, 130, 230)]):
        x0 = 44 + index * 130
        draw.ellipse([x0, 165, x0 + 100, 265], fill=color)
    draw.text((44, height - 90), f"{width} x {height} · RGB", font=mid, fill=(120, 120, 120))

    buffer = __import__("io").BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def make_jpeg(width: int = 560, height: int = 360) -> bytes:
    """生成一张渐变底纹示意图（JPEG 格式）。

    @param width 宽度，单位 px。
    @param height 高度，单位 px。
    @returns JPEG 文件字节。
    """
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return _make_solid_jpeg(width, height, (70, 130, 180))

    font_path = _find_font_file()
    big = ImageFont.truetype(font_path, 34) if font_path else ImageFont.load_default()
    mid = ImageFont.truetype(font_path, 20) if font_path else ImageFont.load_default()
    image = Image.new("RGB", (width, height))
    pixels = image.load()
    for y in range(height):
        for x in range(width):
            pixels[x, y] = (int(40 + 180 * x / width),
                            int(120 + 100 * y / height),
                            int(200 - 120 * x / width))
    draw = ImageDraw.Draw(image)
    draw.rectangle([30, 30, width - 30, height - 30], outline=(255, 255, 255), width=4)
    draw.text((60, 60), "JPEG 附件样例", font=big, fill=(255, 255, 255))
    draw.text((60, 130), "OFD Attachment · Format=jpeg", font=mid, fill=(255, 255, 255))
    draw.text((60, height - 70), f"{width} x {height}", font=mid, fill=(255, 255, 255))

    buffer = __import__("io").BytesIO()
    image.save(buffer, format="JPEG", quality=88, optimize=True)
    return buffer.getvalue()


# --------------------------------------------------------------------------- #
# 素材：音视频（ffmpeg 可用时真实编码，否则写最小占位封装）
# --------------------------------------------------------------------------- #

def make_mp3(seconds: int = 3) -> bytes:
    """生成正弦波测试音频（MP3 格式）。

    @param seconds 音频时长，单位秒。
    @returns MP3 文件字节。
    """
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "audio.mp3")
            command = [
                ffmpeg, "-y", "-loglevel", "error",
                "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
                "-f", "lavfi", "-i", f"sine=frequency=660:duration={seconds}",
                "-filter_complex",
                "[0:a][1:a]amerge=inputs=2,"
                "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a]",
                "-map", "[a]", "-c:a", "libmp3lame", "-b:a", "128k",
                "-metadata", "title=OFD 附件样例音频", "-metadata", "artist=ofdrw-viewer",
                out,
            ]
            result = __import__("subprocess").run(command, capture_output=True)
            if result.returncode == 0 and os.path.exists(out):
                with open(out, "rb") as handle:
                    return handle.read()
    # 兜底：先用 wave 生成 PCM，再以 ID3v2 头标记为音频素材
    with tempfile.TemporaryDirectory() as tmp:
        pcm_path = os.path.join(tmp, "pcm.wav")
        with wave.open(pcm_path, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(44100)
            frames = bytearray()
            for index in range(44100 * seconds):
                sample = int(12000 * math.sin(2 * math.pi * 440 * index / 44100))
                frames += struct.pack("<h", sample)
            wav.writeframes(bytes(frames))
        with open(pcm_path, "rb") as handle:
            return handle.read()


def make_mp4(seconds: int = 3) -> bytes:
    """生成彩条测试视频（MP4 格式，H.264 + AAC）。

    @param seconds 视频时长，单位秒。
    @returns MP4 文件字节。
    """
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("生成 mp4 素材需要 ffmpeg，请先安装后重试")
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "video.mp4")
        command = [
            ffmpeg, "-y", "-loglevel", "error",
            "-f", "lavfi", "-i", f"testsrc2=size=640x360:rate=25:duration={seconds}",
            "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "30",
            "-c:a", "aac", "-b:a", "96k", "-shortest",
            out,
        ]
        result = __import__("subprocess").run(command, capture_output=True)
        if result.returncode != 0 or not os.path.exists(out):
            raise RuntimeError(f"ffmpeg 生成 mp4 失败：{result.stderr.decode('utf-8', 'replace')[:400]}")
        with open(out, "rb") as handle:
            return handle.read()


# --------------------------------------------------------------------------- #
# 素材：Office 文档
# --------------------------------------------------------------------------- #

def _zip_bytes(entries: dict[str, str | bytes]) -> bytes:
    """把若干条目打包成 zip 字节，条目时间戳固定以便复现。

    @param entries 条目名 → 文本或字节内容。
    @returns zip 文件字节。
    """
    buffer = __import__("io").BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in entries.items():
            info = zipfile.ZipInfo(name, date_time=ZIP_DATE_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            payload = content.encode("utf-8") if isinstance(content, str) else content
            archive.writestr(info, payload)
    return buffer.getvalue()


#: 固定创建/修改时间戳，格式为 `docProps/core.xml` 中的 W3CDTF 文本。
CORE_TIMESTAMP = f"{ISO_DATE}T00:00:00Z"


def _normalize_ooxml(data: bytes) -> bytes:
    """把 docx/xlsx/pptx 的时间相关部分归一化，保证重复生成字节一致。

    归一化两处：zip 条目时间戳，以及 `docProps/core.xml` 中的 created/modified 时间。

    @param data 原始 OOXML 文件字节。
    @returns 归一化后的 OOXML 文件字节。
    """
    source = zipfile.ZipFile(__import__("io").BytesIO(data))
    buffer = __import__("io").BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as target:
        for info in source.infolist():
            entry = zipfile.ZipInfo(info.filename, date_time=ZIP_DATE_TIME)
            entry.compress_type = zipfile.ZIP_DEFLATED
            payload = source.read(info.filename)
            if info.filename == "docProps/core.xml":
                text = payload.decode("utf-8")
                text = re.sub(r"(<dcterms:created[^>]*>)[^<]*(</dcterms:created>)",
                              rf"\g<1>{CORE_TIMESTAMP}\g<2>", text)
                text = re.sub(r"(<dcterms:modified[^>]*>)[^<]*(</dcterms:modified>)",
                              rf"\g<1>{CORE_TIMESTAMP}\g<2>", text)
                payload = text.encode("utf-8")
            target.writestr(entry, payload)
    return buffer.getvalue()


def make_docx() -> bytes:
    """生成 Word 文档（docx）。

    @returns docx 文件字节。
    """
    try:
        from docx import Document
    except ImportError:
        return _minimal_docx()
    document = Document()
    document.styles["Normal"].font.name = "等线"
    document.add_heading("OFD 附件样例文档", level=0)
    document.add_paragraph("本文件作为 OFD 包的附件资源，用于验证附件索引解析与内容导出能力。")
    document.add_heading("一、附件清单", level=1)
    table = document.add_table(rows=1, cols=3)
    table.style = "Light Grid Accent 1"
    for cell, title in zip(table.rows[0].cells, ("格式", "附件名", "说明")):
        cell.text = title
    for name, fmt, _, desc in ATTACHMENTS:
        cells = table.add_row().cells
        cells[0].text, cells[1].text, cells[2].text = fmt, name, desc
    document.add_heading("二、说明", level=1)
    for line in (
        "附件与正文同处一个 OFD 容器，通过 Doc_0/Attachments.xml 索引。",
        "每条附件由 ID、Name、Format、Size 与 FileLoc 描述。",
        "附件名不含扩展名，格式由 Format 属性声明。",
        "Size 以 KB 为单位声明，与附件实体大小保持一致。",
    ):
        document.add_paragraph(line, style="List Bullet")
    buffer = __import__("io").BytesIO()
    document.save(buffer)
    return _normalize_ooxml(buffer.getvalue())


def _minimal_docx() -> bytes:
    """不依赖 python-docx 生成最小可读 docx。

    @returns docx 文件字节。
    """
    paragraph = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body><w:p><w:r><w:t>OFD 附件样例文档（最小 docx）</w:t></w:r></w:p></w:body></w:document>"
    )
    return _zip_bytes({
        "[Content_Types].xml":
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-'
            'officedocument.wordprocessingml.document.main+xml"/></Types>',
        "_rels/.rels":
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
            'relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        "word/document.xml": paragraph,
    })


def make_xlsx() -> bytes:
    """生成 Excel 工作簿（xlsx），含公式列与百分比格式。

    @returns xlsx 文件字节。
    """
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    except ImportError:
        return _zip_bytes({
            "[Content_Types].xml":
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                '<Default Extension="xml" ContentType="application/xml"/>'
                '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-'
                'officedocument.spreadsheetml.sheet.main+xml"/></Types>',
            "_rels/.rels":
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
                'relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
            "xl/workbook.xml":
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                '<sheets><sheet name="销售数据" sheetId="1"/></sheets></workbook>',
        })

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "销售数据"
    sheet.append(["月份", "产品", "单价(元)", "数量", "金额(元)", "完成率"])
    rows = [
        ("2026-01", "A 型", 129.0, 320),
        ("2026-02", "A 型", 129.0, 410),
        ("2026-03", "B 型", 268.5, 260),
        ("2026-04", "B 型", 268.5, 318),
        ("2026-05", "C 型", 59.9, 1200),
        ("2026-06", "C 型", 59.9, 1350),
    ]
    for index, (month, product, price, quantity) in enumerate(rows, start=2):
        sheet.append([month, product, price, quantity,
                      f"=C{index}*D{index}", f"=E{index}/SUM($E$2:$E$7)"])
        sheet.cell(index, 6).number_format = "0.0%"
    thin = Side(style="thin", color="B4C6E7")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    for cell in sheet[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="4472C4")
        cell.alignment = Alignment(horizontal="center")
    for column, width in zip("ABCDEF", (12, 10, 12, 10, 12, 10)):
        sheet.column_dimensions[column].width = width
    for row in sheet.iter_rows(min_row=1, max_row=7, max_col=6):
        for cell in row:
            cell.border = border
    note = workbook.create_sheet("备注")
    note["A1"] = "数据为脱敏演示数据"
    note["A1"].font = Font(bold=True)
    buffer = __import__("io").BytesIO()
    workbook.save(buffer)
    return _normalize_ooxml(buffer.getvalue())


def make_pptx() -> bytes:
    """生成演示文稿（pptx），两页幻灯片。

    @returns pptx 文件字节。
    """
    try:
        from pptx import Presentation
    except ImportError:
        return _minimal_pptx()
    presentation = Presentation()
    first = presentation.slides.add_slide(presentation.slide_layouts[0])
    first.shapes.title.text = "OFD 附件样例幻灯片"
    first.placeholders[1].text = "演示 pptx 作为附件随 OFD 分发"
    second = presentation.slides.add_slide(presentation.slide_layouts[1])
    second.shapes.title.text = "支持的附件格式"
    frame = second.placeholders[1].text_frame
    frame.text = "docx / xlsx / pptx"
    for line in ("txt / csv / xml / json", "png / jpeg", "mp3 / mp4"):
        paragraph = frame.add_paragraph()
        paragraph.text = line
        paragraph.level = 1
    buffer = __import__("io").BytesIO()
    presentation.save(buffer)
    return _normalize_ooxml(buffer.getvalue())


def _minimal_pptx() -> bytes:
    """不依赖 python-pptx 生成最小可读 pptx。

    @returns pptx 文件字节。
    """
    return _zip_bytes({
        "[Content_Types].xml":
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-'
            'officedocument.presentationml.presentation.main+xml"/></Types>',
        "_rels/.rels":
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
            'relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
        "ppt/presentation.xml":
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
    })


# --------------------------------------------------------------------------- #
# 正文：字体与页面
# --------------------------------------------------------------------------- #

def build_dot_font() -> bytes:
    """生成内置圆点字体，保证正文在任何机器上都能渲染出可见字形。

    字形覆盖 ASCII 0x20-0x7E 与 CJK 统一表意文字首字 U+4E00，全部映射为实心圆点；
    不依赖任何外部字体文件。

    @returns TrueType 字体文件字节。
    """
    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.ttGlyphPen import TTGlyphPen

    glyph_order = [".notdef", "space", ".dot"]
    builder = FontBuilder(1000, isTTF=True)
    builder.setupGlyphOrder(glyph_order)
    cmap = {0x20: "space", 0x4E00: ".dot"}
    cmap.update({code: ".dot" for code in range(0x21, 0x7F)})
    builder.setupCharacterMap(cmap)

    empty_pen = TTGlyphPen(None)
    empty_glyph = empty_pen.glyph()

    pen = TTGlyphPen(None)
    steps = 24
    radius = 330
    center_x, center_y = 500, 400
    points = [
        (center_x + radius * math.cos(2 * math.pi * index / steps),
         center_y + radius * math.sin(2 * math.pi * index / steps))
        for index in range(steps)
    ]
    pen.moveTo(points[0])
    for point in points[1:]:
        pen.lineTo(point)
    pen.closePath()
    dot_glyph = pen.glyph()

    builder.setupGlyf({".notdef": empty_glyph, "space": empty_glyph, ".dot": dot_glyph})
    builder.setupHorizontalMetrics({name: (600, 0) for name in glyph_order})
    builder.setupHorizontalHeader(ascent=880, descent=-120)
    builder.setupNameTable({
        "familyName": "OFD Sample Dot",
        "styleName": "Regular",
        "uniqueFontIdentifier": "OFD Sample Dot Regular",
        "fullName": "OFD Sample Dot Regular",
        "psName": "OFDSampleDot-Regular",
    })
    builder.setupOS2(sTypoAscender=880, sTypoDescender=-120, usWinAscent=880, usWinDescent=120)
    builder.setupPost()
    buffer = __import__("io").BytesIO()
    builder.save(buffer)
    return buffer.getvalue()


@dataclass(frozen=True)
class FontChoice:
    """正文使用的字体。"""

    #: 字体文件字节。
    data: bytes
    #: 字体展示名。
    name: str
    #: 是否来自系统字体（True 时按真实字宽排版）。
    from_system: bool


def choose_font() -> FontChoice:
    """选择正文字体：优先系统中文无衬线字体，回退内置圆点字体。

    @returns 字体选择结果。
    """
    for path, name in BODY_FONT_CANDIDATES:
        if os.path.exists(path):
            with open(path, "rb") as handle:
                return FontChoice(handle.read(), name, True)
    return FontChoice(build_dot_font(), "OFD Sample Dot", False)


def _char_width_units(ch: str) -> float:
    """估算单字宽度，单位 em（1em 即字号）。

    @param ch 单个字符。
    @returns 宽度，单位 em。
    """
    if ch == " ":
        return 0.28
    if ch.isascii():
        return 0.55 if ch.islower() or ch.isdigit() else 0.6
    return 1.0


def text_object(
    object_id: int,
    x: float,
    y: float,
    content: str,
    size: float,
    *,
    color: str = "32 32 32",
    bold: bool = False,
) -> str:
    """生成一个文本图元。

    @param object_id 图元 ID。
    @param x 左上角 X 坐标，单位 mm。
    @param y 左上角 Y 坐标，单位 mm。
    @param content 文本内容。
    @param size 字号，单位 mm。
    @param color 填充色 "R G B"，取值 0-255。
    @param bold 是否加粗。
    @returns Content.xml 中的 TextObject 片段。
    """
    deltas = [str(round(_char_width_units(ch) * size, 3)) for ch in content]
    width = sum(float(delta) for delta in deltas) or size
    weight = ' Weight="700"' if bold else ""
    return (
        f'      <ofd:TextObject ID="{object_id}" Boundary="{x:.3f} {y:.3f} {width:.3f} {size:.3f}"'
        f' Font="1" Size="{size:.3f}"{weight} Fill="true" Stroke="false">\n'
        f'        <ofd:FillColor Value="{color}"/>\n'
        f'        <ofd:TextCode X="0" Y="{size:.3f}" DeltaX="{" ".join(deltas)}">{escape(content)}</ofd:TextCode>\n'
        f"      </ofd:TextObject>"
    )


def band_object(object_id: int, x: float, y: float, w: float, h: float, color: str,
                radius: float = 0.0) -> str:
    """生成一个填充矩形/圆角矩形图元。

    @param object_id 图元 ID。
    @param x 左上角 X 坐标，单位 mm。
    @param y 左上角 Y 坐标，单位 mm。
    @param w 宽度，单位 mm。
    @param h 高度，单位 mm。
    @param color 填充色 "R G B"，取值 0-255。
    @param radius 圆角半径，单位 mm。
    @returns Content.xml 中的 PathObject 片段。
    """
    if radius <= 0:
        path = f"M 0 0 L {w:.3f} 0 L {w:.3f} {h:.3f} L 0 {h:.3f} C"
        extra = ""
    else:
        r = min(radius, w / 2, h / 2)
        path = (
            f"M {r:.3f} 0 L {w - r:.3f} 0 "
            f"A {r:.3f} {r:.3f} 0 0 1 {w:.3f} {r:.3f} "
            f"L {w:.3f} {h - r:.3f} "
            f"A {r:.3f} {r:.3f} 0 0 1 {w - r:.3f} {h:.3f} "
            f"L {r:.3f} {h:.3f} "
            f"A {r:.3f} {r:.3f} 0 0 1 0 {h - r:.3f} "
            f"L 0 {r:.3f} A {r:.3f} {r:.3f} 0 0 1 {r:.3f} 0 C"
        )
        extra = f' LineWidth="0.3"'
    return (
        f'      <ofd:PathObject ID="{object_id}" Boundary="{x:.3f} {y:.3f} {w:.3f} {h:.3f}"'
        f' Fill="true" Stroke="false"{extra}>\n'
        f'        <ofd:FillColor Value="{color}"/>\n'
        f'        <ofd:AbbreviatedData>{path}</ofd:AbbreviatedData>\n'
        f"      </ofd:PathObject>"
    )


def format_size(size_bytes: int) -> str:
    """把字节数格式化为人类可读大小。

    @param size_bytes 字节数。
    @returns 例如 ``17.2 KB``。
    """
    if size_bytes < 1024:
        return f"{size_bytes} B"
    if size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    return f"{size_bytes / (1024 * 1024):.2f} MB"


def build_page(entries: list[AttachEntry]) -> str:
    """构建正文页面 XML，横版 A4 上排布标题、说明与附件清单。

    @param entries 附件条目列表，按展示顺序排列。
    @returns Content.xml 文本。
    """
    parts: list[str] = []
    next_id = 100

    parts.append(band_object(next_id, 0, 0, PAGE_WIDTH_MM, 26, "31 78 121"))
    next_id += 1
    parts.append(text_object(next_id, 12, 7.5, "OFD 附件样例", 8.0, color="255 255 255", bold=True))
    next_id += 1
    parts.append(text_object(next_id, 12, 18.5, "docx · xlsx · pptx · txt · csv · xml · json · png · jpeg · mp3 · mp4",
                             3.4, color="214 231 245"))
    next_id += 1

    parts.append(text_object(
        next_id, 12, 33,
        "本文档共声明 11 个附件，实体位于 Doc_0/Res 目录，索引见 Doc_0/Attachments.xml。",
        3.8, color="70 70 70",
    ))
    next_id += 1

    # 表头：列 X 与下方数据列一一对应
    columns = (12.0, 92.0, 25.0, 45.0)
    header_top = 42.0
    parts.append(band_object(next_id, columns[0], header_top, 273.0, 7.0, "226 236 247"))
    next_id += 1
    for label, column_offset, size in (("ID", 3, 3.3), ("附件名", 12, 3.3),
                                       ("格式", 80, 3.3), ("大小", 105, 3.3)):
        parts.append(text_object(next_id, columns[0] + column_offset, header_top + 1.8, label, size,
                                 color="31 78 121", bold=True))
        next_id += 1

    # 表格行：两列排版（左 6 条、右 5 条），每列行高 9 mm
    row_height = 9.0
    half = math.ceil(len(entries) / 2)
    for index, entry in enumerate(entries):
        column_index = 0 if index < half else 1
        row_index = index if column_index == 0 else index - half
        offset_x = 12.0 + column_index * 139.0
        top = header_top + 9.0 + row_index * row_height
        if row_index % 2 == 1:
            parts.append(band_object(next_id, offset_x, top, 134.0, row_height, "245 248 252"))
            next_id += 1
        parts.append(text_object(next_id, offset_x + 3, top + 2.9, str(entry.attach_id), 3.2,
                                 color="110 110 110"))
        next_id += 1
        parts.append(text_object(next_id, offset_x + 12, top + 2.9, entry.name, 3.6))
        next_id += 1
        parts.append(text_object(next_id, offset_x + 80, top + 2.9, entry.fmt, 3.2, color="31 78 121"))
        next_id += 1
        parts.append(text_object(next_id, offset_x + 105, top + 2.9, format_size(len(entry.data)), 3.2,
                                 color="110 110 110"))
        next_id += 1

    # 页脚说明
    total = sum(len(entry.data) for entry in entries)
    parts.append(text_object(
        next_id, 12, 190,
        f"附件合计 {len(entries)} 个，原始大小 {format_size(total)}；Size 以 KB 声明。生成日期 {ISO_DATE}。",
        3.0, color="128 128 128",
    ))

    body = "\n".join(parts)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<ofd:Page xmlns:ofd="http://www.ofdspec.org/2016">
  <ofd:Area>
    <ofd:PhysicalBox>0 0 {PAGE_WIDTH_MM} {PAGE_HEIGHT_MM}</ofd:PhysicalBox>
  </ofd:Area>
  <ofd:Content>
    <ofd:Layer ID="1">
{body}
    </ofd:Layer>
  </ofd:Content>
</ofd:Page>
"""


def build_public_res(font: FontChoice) -> str:
    """构建 PublicRes.xml（仅声明正文字体）。

    @param font 正文字体。
    @returns PublicRes.xml 文本。
    """
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<ofd:Res xmlns:ofd="http://www.ofdspec.org/2016" BaseLoc="Res">
  <ofd:Fonts>
    <ofd:Font ID="1" FontName="{escape(font.name)}" FamilyName="{escape(font.name)}" Charset="unicode">
      <ofd:FontFile>font.ttf</ofd:FontFile>
    </ofd:Font>
  </ofd:Fonts>
</ofd:Res>
"""


def build_document_xml() -> str:
    """构建 Document.xml：单页，声明附件索引。

    @returns Document.xml 文本。
    """
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<ofd:Document xmlns:ofd="http://www.ofdspec.org/2016">
  <ofd:CommonData>
    <ofd:MaxUnitID>999</ofd:MaxUnitID>
    <ofd:PageArea>
      <ofd:PhysicalBox>0 0 {PAGE_WIDTH_MM} {PAGE_HEIGHT_MM}</ofd:PhysicalBox>
    </ofd:PageArea>
    <ofd:PublicRes>PublicRes.xml</ofd:PublicRes>
  </ofd:CommonData>
  <ofd:Pages>
    <ofd:Page ID="1" BaseLoc="Pages/Page_0/Content.xml"/>
  </ofd:Pages>
  <ofd:Attachments>Attachments.xml</ofd:Attachments>
</ofd:Document>
"""


def build_attachments_xml(entries: list[AttachEntry]) -> str:
    """构建 Attachments.xml：每条附件声明 ID、Name、Format、Size、ContentType、Desc 与 FileLoc。

    @param entries 附件条目列表。
    @returns Attachments.xml 文本。
    """
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<ofd:Attachments xmlns:ofd="http://www.ofdspec.org/2016">']
    for entry in entries:
        file_loc = "/" + entry.pack_path
        lines.append(
            f'  <ofd:Attachment ID="{entry.attach_id}" Name="{escape(entry.name)}"'
            f' Format="{entry.fmt}" Size="{entry.size_kb:.4f}" CreationDate="{ISO_DATE}"'
            f' ModDate="{ISO_DATE}" Visible="true" Usage="none"'
            f' ContentType="{escape(entry.content_type)}" Desc="{escape(entry.desc)}">'
        )
        lines.append(f"    <ofd:FileLoc>{escape(file_loc)}</ofd:FileLoc>")
        lines.append("  </ofd:Attachment>")
    lines.append("</ofd:Attachments>")
    return "\n".join(lines) + "\n"


def build_ofd_xml() -> str:
    """构建 OFD.xml（入口文件）。

    @returns OFD.xml 文本。
    """
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<ofd:OFD xmlns:ofd="http://www.ofdspec.org/2016" DocType="ofd" Version="1.1">
  <ofd:DocBody>
    <ofd:DocInfo>
      <ofd:DocID>5f3a1c7e9b204d6a8e1f7c3b5d9a2e60</ofd:DocID>
      <ofd:Title>OFD 附件样例（docx/xlsx/pptx/txt/csv/xml/json/png/jpeg/mp3/mp4）</ofd:Title>
      <ofd:Author>ofdrw-viewer 附件样例生成器</ofd:Author>
      <ofd:CreationDate>{ISO_DATE}</ofd:CreationDate>
      <ofd:Creator>scripts/make-attachment-sample.py</ofd:Creator>
      <ofd:CreatorVersion>1.0</ofd:CreatorVersion>
    </ofd:DocInfo>
    <ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot>
  </ofd:DocBody>
</ofd:OFD>
"""


# --------------------------------------------------------------------------- #
# 打包
# --------------------------------------------------------------------------- #

def collect_attachments() -> list[AttachEntry]:
    """生成全部附件素材。

    @returns 附件条目列表，顺与 Attachments.xml 声明顺序一致。
    """
    builders = {
        "docx": make_docx,
        "xlsx": make_xlsx,
        "pptx": make_pptx,
        "txt": lambda: TXT_BODY.encode("utf-8"),
        "csv": lambda: CSV_BODY.encode("utf-8"),
        "xml": lambda: XML_BODY.encode("utf-8"),
        "json": lambda: JSON_BODY.encode("utf-8"),
        "png": make_png,
        "jpeg": make_jpeg,
        "mp3": make_mp3,
        "mp4": make_mp4,
    }
    categories = {
        "docx": "Word 文档", "xlsx": "Excel 表格", "pptx": "PowerPoint 幻灯片",
        "txt": "纯文本", "csv": "逗号分隔数据", "xml": "XML 数据", "json": "JSON 数据",
        "png": "PNG 图片", "jpeg": "JPEG 图片", "mp3": "MP3 音频", "mp4": "MP4 视频",
    }
    entries: list[AttachEntry] = []
    for index, (name, fmt, content_type, desc) in enumerate(ATTACHMENTS, start=1):
        data = builders[fmt]()
        entries.append(AttachEntry(
            attach_id=index,
            pack_path=f"Doc_0/Res/{name}.{fmt}",
            data=data,
            name=name,
            fmt=fmt,
            content_type=content_type,
            desc=desc,
            category=categories[fmt],
        ))
    return entries


def write_ofd(entries: list[AttachEntry], font: FontChoice, out_path: str) -> None:
    """把页面、资源与附件写成 OFD（zip）文件。

    @param entries 附件条目列表。
    @param font 正文字体。
    @param out_path 输出文件路径。
    """
    files: list[tuple[str, bytes]] = [
        ("OFD.xml", build_ofd_xml().encode("utf-8")),
        ("Doc_0/Document.xml", build_document_xml().encode("utf-8")),
        ("Doc_0/PublicRes.xml", build_public_res(font).encode("utf-8")),
        ("Doc_0/Res/font.ttf", font.data),
        ("Doc_0/Pages/Page_0/Content.xml", build_page(entries).encode("utf-8")),
        ("Doc_0/Attachments.xml", build_attachments_xml(entries).encode("utf-8")),
    ]
    files.extend((entry.pack_path, entry.data) for entry in entries)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    temporary = out_path + ".part"
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, payload in files:
            info = zipfile.ZipInfo(name, date_time=ZIP_DATE_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, payload)
    os.replace(temporary, out_path)


def main(argv: list[str]) -> int:
    """命令行入口。

    @param argv 命令行参数（不含脚本名），第一个参数为输出目录。
    @returns 进程退出码。
    """
    out_dir = argv[0] if argv else DEFAULT_OUT
    font = choose_font()
    entries = collect_attachments()
    out_path = os.path.join(out_dir, OUTPUT_NAME)
    write_ofd(entries, font, out_path)
    total = sum(len(entry.data) for entry in entries)
    print(f"字体：{font.name}（{'系统字体' if font.from_system else '内置圆点字体'}）")
    print(f"附件：{len(entries)} 个，原始合计 {total} 字节")
    for entry in entries:
        print(f"  {entry.attach_id:>2}  {entry.fmt:<5}{entry.name:<22}{entry.size_kb:>10.4f} KB")
    print(f"输出：{out_path}（{os.path.getsize(out_path)} 字节）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))