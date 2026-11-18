#!/usr/bin/env python3
"""生成 UI 动作机制的人工验证用 OFD 样本。

以 ``ofd_pdf_match/gb-12-media.ofd`` 为基底（字体、媒体资源、页面尺寸），
替换页面动作声明，产出覆盖各动作类型与触发展开方式的样本。

用法：
    python3 scripts/make-action-samples.py [输出目录]

输出目录默认 ``ofd_pdf_match``（与其它对照样本同目录）。
"""

from __future__ import annotations

import os
import shutil
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.path.join(ROOT, "ofd_pdf_match", "gb-12-media.ofd")
DEFAULT_OUT = os.path.join(ROOT, "ofd_pdf_match")

PAGE_TMPL = """<?xml version="1.0" encoding="UTF-8"?>
<ofd:Page xmlns:ofd="http://www.ofdspec.org/2016">
  <ofd:Area>
    <ofd:PhysicalBox>0 0 297 210</ofd:PhysicalBox>
  </ofd:Area>{page_actions}
  <ofd:Content>
    <ofd:Layer ID="1">
{body}
    </ofd:Layer>
  </ofd:Content>
</ofd:Page>
"""


def text(object_id: int, x: float, y: float, size: float, content: str, color: str = "20 20 20") -> str:
    """生成一个文本图元；坐标单位 mm。"""
    width = max(6, len(content) * size)
    deltas = " ".join([f"{size:.2f}"] * len(content))
    return f"""      <ofd:TextObject ID="{object_id}" Boundary="{x:.4f} {y:.4f} {width:.4f} {size * 1.4:.4f}" Font="1" Size="{size:.4f}" Fill="true" Stroke="false">
        <ofd:FillColor Value="{color}"/>
        <ofd:TextCode X="0" Y="{size:.4f}" DeltaX="{deltas}">{content}</ofd:TextCode>
      </ofd:TextObject>"""


def button(object_id: int, x: float, y: float, w: float, h: float, fill: str, action: str) -> str:
    """生成一个带 CLICK 动作的矩形按钮图元；坐标单位 mm。"""
    return f"""      <ofd:PathObject ID="{object_id}" Boundary="{x:.4f} {y:.4f} {w:.4f} {h:.4f}" Fill="true" Stroke="false" Name="动作按钮">
        <ofd:FillColor Value="{fill}"/>
        <ofd:AbbreviatedData>M 0 0 L {w:.4f} 0 L {w:.4f} {h:.4f} L 0 {h:.4f} C</ofd:AbbreviatedData>
        <ofd:Actions>
          <ofd:Action Event="CLICK">
{action}
          </ofd:Action>
        </ofd:Actions>
      </ofd:PathObject>"""


def goto(page_id: str, top_mm: float = 0) -> str:
    """Goto 动作体：跳到指定页。"""
    return (
        f"            <ofd:Goto>\n"
        f'              <ofd:Dest Type="XYZ" PageID="{page_id}" Left="0" Top="{top_mm}" Zoom="1.0"/>\n'
        f"            </ofd:Goto>"
    )


def uri(address: str, target: str = "_blank") -> str:
    """URI 动作体；地址写在图元级 `URI` 属性上（`Target` 控制打开方式）。"""
    return f'            <ofd:URI URI="{address}" Target="{target}"/>'


def sound(resource_id: str) -> str:
    """Sound 动作体。"""
    return f'            <ofd:Sound ResourceID="{resource_id}" Volume="100" Repeat="false" Synchronous="false"/>'


def movie(resource_id: str, operator: str = "Play") -> str:
    """Movie 动作体。"""
    return f'            <ofd:Movie ResourceID="{resource_id}" Operator="{operator}"/>'


def page_actions(*actions: str) -> str:
    """生成页级 `Page/Actions` 片段；页面宿主的事件标准固定为 `PO`。"""
    if not actions:
        return ""
    body = "\n".join(
        f"""    <ofd:Action Event="PO">
{action}
    </ofd:Action>"""
        for action in actions
    )
    return f"""
  <ofd:Actions>
{body}
  </ofd:Actions>"""



def build_pages() -> dict[str, str]:
    """构造各页面的 Content.xml 内容。"""
    pages: dict[str, str] = {}

    # 第 1 页：图元 CLICK + Goto（最核心的「点击跳转」场景）。
    body1 = "\n".join(
        [
            text(301, 20, 18, 6, "动作验证 · 第 1 页", "10 10 10"),
            text(302, 20, 30, 3.5, "1) 点击蓝色按钮 → 跳到第 2 页（Goto/Dest）", "60 60 60"),
            button(303, 20, 38, 60, 14, "30 90 190", goto("2")),
            text(304, 20, 58, 3.5, "2) 点击绿色按钮 → 跳到第 3 页（Goto/Bookmark）", "60 60 60"),
            button(305, 20, 66, 60, 14, "40 140 80", '            <ofd:Goto Bookmark="第三章"/>'),
            text(306, 20, 86, 3.5, "3) 点击橙色按钮 → 打开外部链接（URI，需确认）", "60 60 60"),
            button(307, 20, 94, 60, 14, "200 120 30", uri("https://www.ofdrw.cn/")),
            text(308, 20, 114, 3.5, "4) 点击红色按钮 → 打开附件（GotoA）", "60 60 60"),
            button(309, 20, 122, 60, 14, "180 40 40", '            <ofd:GotoA AttachID="att1"/>'),
            text(310, 20, 142, 3.5, "5) 点击灰色按钮 → file: 协议被白名单拒绝（不弹框、不跳转）", "60 60 60"),
            button(311, 20, 150, 60, 14, "110 110 110", uri("file:///etc/passwd")),
            text(312, 110, 30, 3, "6) 点击紫色按钮 → 跳回本页（验证不会死循环）", "60 60 60"),
            button(313, 110, 38, 60, 14, "130 70 180", goto("1")),
            text(314, 110, 58, 3, "7) 拖动/选中文本后松手 → 不应触发动作", "60 60 60"),
            text(315, 110, 68, 3, "8) 双击图元 → 不应触发页面缩放", "60 60 60"),
        ]
    )
    pages["Page_0"] = PAGE_TMPL.format(body=body1, page_actions="")

    # 第 2 页：页面级 PO 动作 + 图元 CLICK + 媒体。
    body2 = "\n".join(
        [
            text(401, 20, 18, 6, "动作验证 · 第 2 页", "10 10 10"),
            text(402, 20, 30, 3.5, "本页声明了 PO（页面打开）动作：进入本页时按开关决定是否执行", "60 60 60"),
            text(403, 20, 40, 3.5, "1) 点击按钮 → 播放视频（Movie，内联到图元矩形）", "60 60 60"),
            button(404, 20, 48, 60, 14, "40 120 180", movie("10")),
            text(405, 20, 68, 3.5, "2) 点击按钮 → 播放音频（Sound，弹出浮层）", "60 60 60"),
            button(406, 20, 76, 60, 14, "30 140 120", sound("12")),
            text(407, 20, 96, 3.5, "3) 点击按钮 → 暂停视频（Movie/Pause，验证实例复用）", "60 60 60"),
            button(408, 20, 104, 60, 14, "120 120 60", movie("10", "Pause")),
            text(409, 20, 124, 3.5, "4) 点击按钮 → 继续视频（Movie/Resume）", "60 60 60"),
            button(410, 20, 132, 60, 14, "60 160 60", movie("10", "Resume")),
            text(411, 20, 152, 3.5, "5) 点击按钮 → 停止并销毁视频（Movie/Stop）", "60 60 60"),
            button(412, 20, 160, 60, 14, "170 70 70", movie("10", "Stop")),
            text(413, 110, 30, 3, "6) 翻到第 3 页再翻回本页 → PO 不应重复执行", "60 60 60"),
        ]
    )
    pages["Page_1"] = PAGE_TMPL.format(body=body2, page_actions=page_actions(goto("1"), sound("12")))

    # 第 3 页：书签目标页 + 文档级 DO 动作。
    body3 = "\n".join(
        [
            text(501, 20, 18, 6, "动作验证 · 第 3 页（书签「第三章」目标）", "10 10 10"),
            text(502, 20, 32, 3.5, "本页是第 1 页「Goto/Bookmark」的跳转目标", "60 60 60"),
            text(503, 20, 42, 3.5, "也是文档级 DO 动作的执行页（打开文档时按开关执行）", "60 60 60"),
            text(504, 20, 56, 3.5, "1) 点击按钮 → 回到第 1 页", "60 60 60"),
            button(505, 20, 64, 60, 14, "30 90 190", goto("1")),
        ]
    )
    pages["Page_2"] = PAGE_TMPL.format(body=body3, page_actions="")
    return pages


DOCUMENT_XML = """<?xml version="1.0" encoding="UTF-8"?>
<ofd:Document xmlns:ofd="http://www.ofdspec.org/2016">
  <ofd:CommonData>
    <ofd:MaxUnitID>9999</ofd:MaxUnitID>
    <ofd:PageArea>
      <ofd:PhysicalBox>0 0 297 210</ofd:PhysicalBox>
    </ofd:PageArea>
    <ofd:PublicRes>PublicRes.xml</ofd:PublicRes>
  </ofd:CommonData>
  <ofd:Pages>
    <ofd:Page ID="1" BaseLoc="Pages/Page_0/Content.xml"/>
    <ofd:Page ID="2" BaseLoc="Pages/Page_1/Content.xml"/>
    <ofd:Page ID="3" BaseLoc="Pages/Page_2/Content.xml"/>
  </ofd:Pages>
  <ofd:Actions>
    <ofd:Action Event="DO">
      <ofd:Goto>
        <ofd:Dest Type="XYZ" PageID="3" Left="0" Top="0" Zoom="1.0"/>
      </ofd:Goto>
    </ofd:Action>
  </ofd:Actions>
  <ofd:Outlines>
    <ofd:OutlineElem Title="第一章">
      <ofd:Actions>
        <ofd:Action Event="CLICK">
          <ofd:Goto>
            <ofd:Dest Type="XYZ" PageID="1" Left="0" Top="0" Zoom="1.0"/>
          </ofd:Goto>
        </ofd:Action>
      </ofd:Actions>
    </ofd:OutlineElem>
    <ofd:OutlineElem Title="第二章">
      <ofd:Actions>
        <ofd:Action Event="CLICK">
          <ofd:Goto>
            <ofd:Dest Type="XYZ" PageID="2" Left="0" Top="0" Zoom="1.0"/>
          </ofd:Goto>
        </ofd:Action>
      </ofd:Actions>
    </ofd:OutlineElem>
    <ofd:OutlineElem Title="第三章">
      <ofd:Actions>
        <ofd:Action Event="CLICK">
          <ofd:Goto>
            <ofd:Dest Type="XYZ" PageID="3" Left="0" Top="0" Zoom="1.0"/>
          </ofd:Goto>
        </ofd:Action>
      </ofd:Actions>
    </ofd:OutlineElem>
  </ofd:Outlines>
  <ofd:Bookmarks>
    <ofd:Bookmark Name="第一章">
      <ofd:Dest Type="XYZ" PageID="1" Left="0" Top="0" Zoom="1.0"/>
    </ofd:Bookmark>
    <ofd:Bookmark Name="第二章">
      <ofd:Dest Type="XYZ" PageID="2" Left="0" Top="0" Zoom="1.0"/>
    </ofd:Bookmark>
    <ofd:Bookmark Name="第三章">
      <ofd:Dest Type="XYZ" PageID="3" Left="0" Top="0" Zoom="1.0"/>
    </ofd:Bookmark>
  </ofd:Bookmarks>
  <ofd:Attachments>Attachments.xml</ofd:Attachments>
</ofd:Document>
"""

BOOKMARKS_XML = """<?xml version="1.0" encoding="UTF-8"?>
<ofd:Bookmarks xmlns:ofd="http://www.ofdspec.org/2016">
  <ofd:Bookmark Name="第一章" DestType="XYZ" PageID="1"/>
  <ofd:Bookmark Name="第二章" DestType="XYZ" PageID="2"/>
  <ofd:Bookmark Name="第三章" DestType="XYZ" PageID="3"/>
</ofd:Bookmarks>
"""

ATTACHMENTS_XML = """<?xml version="1.0" encoding="UTF-8"?>
<ofd:Res xmlns:ofd="http://www.ofdspec.org/2016">
  <ofd:Attachment ID="att1" Name="验证用附件.txt" Format="txt" Size="0.02" Visible="true">
    <ofd:FileLoc>Res/attach.txt</ofd:FileLoc>
  </ofd:Attachment>
</ofd:Res>
"""

OFD_XML = """<?xml version="1.0" encoding="UTF-8"?>
<ofd:OFD xmlns:ofd="http://www.ofdspec.org/2016" DocType="ofd" Version="1.1">
  <ofd:DocBody>
    <ofd:DocInfo>
      <ofd:DocID>a1b2c3d4e5f60718293a4b5c6d7e8f90</ofd:DocID>
      <ofd:Title>UI 动作处理机制 · 人工验证样本</ofd:Title>
      <ofd:Creator>ofdrw-viewer 动作验证样本生成器</ofd:Creator>
    </ofd:DocInfo>
    <ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot>
  </ofd:DocBody>
</ofd:OFD>
"""


def build_light(out_dir: str) -> str:
    """生成轻量版样本（无媒体资源），用于快速验证跳转类动作。

    @param out_dir: 输出目录。
    @returns: 生成的文件路径。
    """
    os.makedirs(out_dir, exist_ok=True)
    target = os.path.join(out_dir, "actions-verify-light.ofd")
    source = zipfile.ZipFile(BASE)
    writer = zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED)
    body1 = "\n".join(
        [
            text(301, 20, 18, 6, "动作验证（轻量版）· 第 1 页", "10 10 10"),
            text(302, 20, 30, 3.5, "1) 蓝色按钮 → 跳到第 2 页（Goto/Dest）", "60 60 60"),
            button(303, 20, 38, 60, 14, "30 90 190", goto("2")),
            text(304, 20, 58, 3.5, "2) 绿色按钮 → 跳到第 3 页（Goto/Bookmark）", "60 60 60"),
            button(305, 20, 66, 60, 14, "40 140 80", '            <ofd:Goto Bookmark="第三章"/>'),
            text(306, 20, 86, 3.5, "3) 橙色按钮 → 打开外部链接（URI，需确认框）", "60 60 60"),
            button(307, 20, 94, 60, 14, "200 120 30", uri("https://www.ofdrw.cn/")),
            text(308, 20, 114, 3.5, "4) 红色按钮 → 打开附件（GotoA）", "60 60 60"),
            button(309, 20, 122, 60, 14, "180 40 40", '            <ofd:GotoA AttachID="att1"/>'),
            text(310, 20, 142, 3.5, "5) 灰色按钮 → file: 协议被白名单拒绝（不弹框、不跳转）", "60 60 60"),
            button(311, 20, 150, 60, 14, "110 110 110", uri("file:///etc/passwd")),
            text(312, 110, 30, 3, "6) 紫色按钮 → 跳回本页（不应死循环）", "60 60 60"),
            button(313, 110, 38, 60, 14, "130 70 180", goto("1")),
            text(314, 110, 58, 3, "7) 拖动选中文本后松手 → 不应触发动作", "60 60 60"),
            text(315, 110, 68, 3, "8) 双击按钮 → 不应触发页面缩放", "60 60 60"),
        ]
    )
    body2 = "\n".join(
        [
            text(401, 20, 18, 6, "动作验证（轻量版）· 第 2 页", "10 10 10"),
            text(402, 20, 30, 3.5, "本页声明了 PO 动作：进入本页时按「关于」开关决定是否执行", "60 60 60"),
            text(403, 20, 44, 3.5, "1) 蓝色按钮 → 回到第 1 页", "60 60 60"),
            button(404, 20, 52, 60, 14, "30 90 190", goto("1")),
            text(405, 110, 44, 3, "2) 翻到第 3 页再翻回本页 → PO 不应重复执行", "60 60 60"),
            text(406, 110, 54, 3, "3) 「更多 → 关于」打开自动执行 → 观察 PO 补执行", "60 60 60"),
        ]
    )
    body3 = "\n".join(
        [
            text(501, 20, 18, 6, "动作验证（轻量版）· 第 3 页（书签目标）", "10 10 10"),
            text(502, 20, 32, 3.5, "书签「第三章」与文档级 DO 动作的目标页", "60 60 60"),
            button(505, 20, 44, 60, 14, "30 90 190", goto("1")),
        ]
    )
    try:
        for item in source.infolist():
            name = item.filename
            if name.startswith("Doc_0/Pages/"):
                continue
            if name.endswith((".mp4", ".mp3", ".png")):
                continue
            if name == "OFD.xml":
                writer.writestr(name, OFD_XML.replace("人工验证样本", "人工验证样本（轻量版）").encode("utf-8"))
            elif name == "Doc_0/Document.xml":
                writer.writestr(name, DOCUMENT_XML.encode("utf-8"))
            elif name == "Doc_0/PublicRes.xml":
                # 剔除多媒体声明，避免引用不存在的资源文件。
                text_xml = source.read(name).decode("utf-8")
                start = text_xml.find("  <ofd:MultiMedias>")
                end = text_xml.find("</ofd:MultiMedias>")
                if start != -1 and end != -1:
                    text_xml = text_xml[:start] + text_xml[end + len("</ofd:MultiMedias>") :]
                writer.writestr(name, text_xml.encode("utf-8"))
            else:
                writer.writestr(item, source.read(name))
        writer.writestr("Doc_0/Pages/Page_0/Content.xml", PAGE_TMPL.format(body=body1, page_actions="").encode("utf-8"))
        writer.writestr("Doc_0/Pages/Page_1/Content.xml", PAGE_TMPL.format(body=body2, page_actions=page_actions(goto("1"))).encode("utf-8"))
        writer.writestr("Doc_0/Pages/Page_2/Content.xml", PAGE_TMPL.format(body=body3, page_actions="").encode("utf-8"))
        writer.writestr("Doc_0/Attachments.xml", ATTACHMENTS_XML.encode("utf-8"))
        writer.writestr("Doc_0/Res/attach.txt", b"ofdrw-viewer action verify\r\n")
    finally:
        writer.close()
        source.close()
    return target


def build(out_dir: str) -> str:
    """生成样本文件并返回其路径。"""
    os.makedirs(out_dir, exist_ok=True)
    target = os.path.join(out_dir, "actions-verify.ofd")
    source = zipfile.ZipFile(BASE)
    pages = build_pages()
    writer = zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED)
    try:
        # 保留基底的字体与媒体资源（video.mp4、audio.mp3、frame.png、font.ttf）。
        for item in source.infolist():
            name = item.filename
            if name.startswith("Doc_0/Pages/"):
                continue
            if name == "OFD.xml":
                writer.writestr(name, OFD_XML.encode("utf-8"))
            elif name == "Doc_0/Document.xml":
                writer.writestr(name, DOCUMENT_XML.encode("utf-8"))
            else:
                writer.writestr(item, source.read(name))
        # 页面内容按新结构重写。
        for page_name, content in pages.items():
            writer.writestr(
                f"Doc_0/Pages/{page_name}/Content.xml",
                content.encode("utf-8"),
            )
        writer.writestr("Doc_0/Attachments.xml", ATTACHMENTS_XML.encode("utf-8"))
        writer.writestr("Doc_0/Res/attach.txt", b"ofdrw-viewer action verify\r\n")
    finally:
        writer.close()
        source.close()
    return target


def main() -> int:
    """入口：生成样本并打印结果。"""
    out_dir = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT
    if not os.path.exists(BASE):
        print(f"基底样本不存在：{BASE}", file=sys.stderr)
        return 1
    for make in (build, build_light):
        path = make(out_dir)
        size_kb = os.path.getsize(path) / 1024
        print(f"已生成：{path}（{size_kb:.0f} KB）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())