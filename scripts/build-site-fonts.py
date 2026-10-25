#!/usr/bin/env python3
"""生成在线演示站（site/public/fonts）的本地兜底字体。

产物（写入 site/public/fonts/）：
- source-han-serif-sc.woff2：思源宋体（Noto Serif CJK SC），对应文档声明的「宋体/SimSun」等衬线字体；
- source-han-sans-sc.woff2：思源黑体（Noto Sans CJK SC），对应文档声明的「黑体/SimHei/微软雅黑」等无衬线字体。

处理流程：
1. 从系统 TTC 中按索引抽出单个字体面（TTC 各面共享表数据，需按该面的表目录重建独立 sfnt）；
2. 用 fonttools 的 subset 做子集化：只保留 CJK 基本区 U+4E00–9FFF、CJK 标点/全角/基本拉丁/常用符号；
3. 以 woff2 输出（fonttools 需要 brotli 支持）。

依赖（建议在 Python 虚拟环境中安装）：

    python3 -m venv .venv-fonts
    .venv-fonts/bin/pip install "fonttools[woff]" brotli

用法（在仓库根目录执行）：

    python3 scripts/build-site-fonts.py

输入文件默认取系统字体路径，可用 --serif-ttc / --sans-ttc 覆盖；
环境变量 FONTSUBSET 可指定 pyftsubset 可执行文件（默认使用 PATH 中的 pyftsubset）。
"""

from __future__ import annotations

import argparse
import hashlib
import os
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

# 默认系统字体路径（Debian/Ubuntu 的 fonts-noto-cjk 包）。
DEFAULT_SERIF_TTC = "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc"
DEFAULT_SANS_TTC = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"

# Noto CJK TTC 中简体中文面的索引（0=JP、1=KR、2=SC、3=TC、4=HK）。
NOTO_SC_FACE_INDEX = 2

# 子集保留的 Unicode 范围：CJK 基本区 + 扩展标点 + 全角 + 基本拉丁 + 常用符号。
# 不含 ExtA–E（U+3400–4DBF、U+20000 以上）与部首扩展块。
SUBSET_UNICODES = (
    "U+0020-007E,"  # 基本拉丁
    "U+00A0-00FF,"  # 拉丁补充（®°× 等）
    "U+2000-206F,"  # 常用标点
    "U+20A0-20CF,"  # 货币符号
    "U+2100-214F,"  # 类字母符号
    "U+2190-21FF,"  # 箭头
    "U+2200-22FF,"  # 数学运算符
    "U+2460-24FF,"  # 带圈数字
    "U+2500-257F,"  # 制表符
    "U+25A0-25FF,"  # 几何图形
    "U+3000-303F,"  # CJK 符号与标点
    "U+FF00-FFEF,"  # 全角字符
    "U+4E00-9FFF"  # CJK 统一表意文字基本区
)


def extract_ttc_face(source: Path, index: int, target: Path) -> int:
    """从 TTC 中抽出指定索引的字体面，写成独立 sfnt 文件。

    TTC 结构为文件头 + 各面的 sfnt 偏移；各面共享表数据。这里按该面的表目录重新
    计算表偏移、按 tag 排序并 4 字节对齐，输出可独立使用的 TTF/OTF。

    Args:
        source: TTC 文件路径。
        index: 字体面索引（0-based）。
        target: 输出文件路径。

    Returns:
        写出的字节数，单位 byte。
    """
    data = source.read_bytes()
    tag, _version, num_fonts = struct.unpack(">4sII", data[:12])
    if tag != b"ttcf":
        raise SystemExit(f"{source} 不是 TTC 文件")
    if index >= num_fonts:
        raise SystemExit(f"{source} 只有 {num_fonts} 个字体面，索引 {index} 越界")
    offsets = struct.unpack(f">{num_fonts}I", data[12 : 12 + 4 * num_fonts])
    offset = offsets[index]
    sfnt_version, num_tables = struct.unpack(">IH", data[offset : offset + 6])
    tables: list[tuple[bytes, int, int, int]] = []
    for i in range(num_tables):
        record = offset + 12 + i * 16
        table_tag = data[record : record + 4]
        checksum, table_offset, table_length = struct.unpack(
            ">III", data[record + 4 : record + 16]
        )
        tables.append((table_tag, checksum, table_offset, table_length))
    tables.sort(key=lambda item: item[0])

    header_size = 12 + num_tables * 16
    output = bytearray(struct.pack(">IHHHH", sfnt_version, num_tables, 0, 0, 0))
    body = bytearray()
    cursor = header_size
    directory = bytearray()
    for table_tag, checksum, table_offset, table_length in tables:
        directory += struct.pack(">4sIII", table_tag, checksum, cursor, table_length)
        padding = (4 - table_length % 4) % 4
        body += data[table_offset : table_offset + table_length] + b"\0" * padding
        cursor += table_length + padding
    output += directory + body
    target.write_bytes(output)
    return len(output)


def subset_to_woff2(source: Path, target: Path) -> None:
    """把字体子集化并输出 woff2。

    Args:
        source: 输入字体文件（TTF/OTF）。
        target: 输出 woff2 路径。
    """
    subsetter = os.environ.get("FONTSUBSET", "pyftsubset")
    command = [
        subsetter,
        str(source),
        f"--unicodes={SUBSET_UNICODES}",
        "--layout-features=*",
        "--name-IDs=*",
        "--name-languages=*",
        "--notdef-outline",
        "--recalc-bounds",
        f"--flavor=woff2",
        f"--output-file={target}",
    ]
    subprocess.run(command, check=True)


def _finalize(face: Path, out_dir: Path, stem: str) -> Path:
    """把字体面子集化并输出为带内容哈希的 woff2，同时清理同名的旧版本。

    Args:
        face: 已抽取的单一字体面路径。
        out_dir: 输出目录。
        stem: 文件名主干，例如 ``source-han-serif-sc``。

    Returns:
        生成的 woff2 文件路径。
    """
    raw = out_dir / f"{stem}.raw.woff2"
    subset_to_woff2(face, raw)
    digest = hashlib.sha256(raw.read_bytes()).hexdigest()[:8]
    target = out_dir / f"{stem}.{digest}.woff2"
    raw.replace(target)
    # 删除同一字体主干下旧哈希版本，避免仓库不断累积历史字体。
    for stale in out_dir.glob(f"{stem}.*.woff2"):
        if stale != target:
            stale.unlink()
    return target


def main() -> int:
    """生成两个兜底字体。

    Returns:
        进程退出码；0 表示成功。
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serif-ttc", default=DEFAULT_SERIF_TTC, help="思源宋体 TTC 路径")
    parser.add_argument("--sans-ttc", default=DEFAULT_SANS_TTC, help="思源黑体 TTC 路径")
    parser.add_argument(
        "--out-dir",
        default=str(Path(__file__).resolve().parent.parent / "site" / "public" / "fonts"),
        help="输出目录（默认 site/public/fonts）",
    )
    args = parser.parse_args()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    generated: list[Path] = []
    with tempfile.TemporaryDirectory(prefix="site-fonts-") as work:
        work_dir = Path(work)
        noto_serif_face = work_dir / "NotoSerifCJK-SC.otf"
        noto_sans_face = work_dir / "NotoSansCJK-SC.otf"
        print(f"抽取思源宋体面 {NOTO_SC_FACE_INDEX} → {noto_serif_face}")
        extract_ttc_face(Path(args.serif_ttc), NOTO_SC_FACE_INDEX, noto_serif_face)
        print(f"抽取思源黑体面 {NOTO_SC_FACE_INDEX} → {noto_sans_face}")
        extract_ttc_face(Path(args.sans_ttc), NOTO_SC_FACE_INDEX, noto_sans_face)

        generated.append(_finalize(noto_serif_face, out_dir, "source-han-serif-sc"))
        generated.append(_finalize(noto_sans_face, out_dir, "source-han-sans-sc"))

    for path in generated:
        print(f"{path}: {path.stat().st_size} bytes")
    print()
    print("字体文件名含内容哈希；如哈希有变化，请同步更新 site/main.ts 的")
    print("LOCAL_SERIF_FILE / LOCAL_SANS_FILE 常量。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
