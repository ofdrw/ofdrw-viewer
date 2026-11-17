/**
 * 生成 `ofd_pdf_match/ctm-matrix.ofd` 样例文档（CTM / Boundary / Clips 对照页）。
 *
 * 每格放置一个独立的 TextObject，覆盖平移、缩放、旋转、斜切、镜像、复合变换、
 * Boundary 裁剪与 Clips 裁剪的组合。格子外周绘制灰色虚线参考框标出 Boundary，
 * 格子上方用无 CTM 的小号文字标注用例名，便于与 PDF 参考件逐格比对。
 *
 * 内嵌文泉驿微米黑：同时覆盖中文与拉丁字形，确保标注与文字内容在任意平台一致。
 *
 * 关键设计：每个格子的 CTM 平移量由「基础变换后的字形范围」反推，
 * 使字形在任何旋转/斜切下都精确落在格子内部，Boundary 再按字形范围外扩。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildCtmOfd, type CtmClipSpec } from '../fixtures/ctm-ofd';

/** 2×3 仿射矩阵。 */
type Affine = [number, number, number, number, number, number];

/** 页面区域，单位 mm。 */
type Box = [number, number, number, number];

/** 矩形的左右上下边界，单位 mm。 */
interface Bounds {
  /** 左边界，单位 mm。 */
  x0: number;
  /** 上边界，单位 mm。 */
  y0: number;
  /** 右边界，单位 mm。 */
  x1: number;
  /** 下边界，单位 mm。 */
  y1: number;
}

/** 单个对照格。 */
interface Cell {
  /** 用例名称（中文），绘制在格子顶部。 */
  name: string;
  /** 对象变换矩阵（不含摆放平移，由生成器补齐）。 */
  ctm?: Affine;
  /** 固定外接矩形（格子局部坐标），单位 mm；缺省按字形范围自动计算。 */
  boundary?: Box;
  /** 文字内容，缺省 `变形文字`。 */
  text?: string;
  /** 裁剪区。 */
  clips?: readonly CtmClipSpec[];
  /** 是否按固定 Boundary 裁剪（不自动外扩）。 */
  fixedBoundary?: boolean;
  /** 覆盖默认基线 Y，对象空间 mm；用于「CTM 移入窗内」等需要改变起始基线的用例。 */
  codeYOverride?: number;
}

/** 页面尺寸，单位 mm（A4 横向）。 */
const PAGE = { width: 297, height: 210 };

/** 网格列数。 */
const COLUMNS = 4;

/** 网格步进，单位 mm。 */
const GAP_X = 70;
const GAP_Y = 32;

/** 网格原点，单位 mm。 */
const ORIGIN_X = 10;
const ORIGIN_Y = 14;

/** 格子尺寸，单位 mm；用于把字形限制在格子内部。 */
const CELL_W = 64;
const CELL_H = 26;

/** Boundary 窗口在格子内的摆放边距，单位 mm。 */
const CELL_PAD_X = 4;
const CELL_PAD_Y = 6;

/** 内嵌字体路径：文泉驿微米黑，覆盖中文与拉丁字形。 */
const FONT_PATH = '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc';

/** 字体族名，写入 OFD 字体资源。 */
const FONT_FAMILY = 'WenQuanYi Micro Hei';

/** 默认文字内容（4 字）。 */
const DEFAULT_TEXT = '变形文字';

/** 旋转/镜像等用例使用的短文字（2 字），便于观察方向。 */
const SHORT_TEXT = '变形';

/** 字号，单位 mm。 */
const FONT_SIZE = 9;

/** 文字基线起点（对象空间），单位 mm。 */
const CODE_X = 0;
const CODE_Y = FONT_SIZE;

/** 旋转矩阵（度）；正角方向为 X 轴转向 Y 轴。 */
function rotation(degrees: number): Affine {
  const radians = (degrees * Math.PI) / 180;
  const cos = Number(Math.cos(radians).toFixed(6));
  const sin = Number(Math.sin(radians).toFixed(6));
  return [cos, sin, -sin, cos, 0, 0];
}

/** 矩阵乘法：先应用 b，再应用 a。 */
function multiply(a: Affine, b: Affine): Affine {
  const [a1, b1, c1, d1, e1, f1] = a;
  const [a2, b2, c2, d2, e2, f2] = b;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/**
 * 计算文字在对象空间（CTM 之后，不含摆放平移）的包围盒。
 *
 * 中文字形按方形近似：宽 = 字号 × 字数，基线以上 1 个字号，基线以下 0.25 个字号。
 *
 * @param ctm 对象变换矩阵（不含平移）。
 * @param charCount 字符数。
 * @returns 包围盒，单位 mm。
 */
function textBounds(ctm: Affine, charCount: number): Bounds {
  const width = FONT_SIZE * charCount;
  const corners: [number, number][] = [
    [CODE_X, CODE_Y - FONT_SIZE],
    [CODE_X + width, CODE_Y - FONT_SIZE],
    [CODE_X + width, CODE_Y + FONT_SIZE * 0.25],
    [CODE_X, CODE_Y + FONT_SIZE * 0.25],
  ];
  const points = corners.map(([x, y]) => ({
    x: ctm[0] * x + ctm[2] * y + ctm[4],
    y: ctm[1] * x + ctm[3] * y + ctm[5],
  }));
  return {
    x0: Math.min(...points.map((point) => point.x)),
    y0: Math.min(...points.map((point) => point.y)),
    x1: Math.max(...points.map((point) => point.x)),
    y1: Math.max(...points.map((point) => point.y)),
  };
}

/**
 * 构造全部对照格。
 *
 * @returns 格子列表（按绘制顺序）。
 */
function buildCells(): Cell[] {
  const tan20 = Number(Math.tan((20 * Math.PI) / 180).toFixed(6));

  return [
    { name: '无 CTM' },
    { name: '平移 Y+4', ctm: [1, 0, 0, 1, 0, 4] },
    { name: '缩放 50%', ctm: [0.5, 0, 0, 0.5, 0, 0] },
    { name: '非等比缩放 2×1', ctm: [2, 0, 0, 1, 0, 0] },

    { name: '旋转 15°', ctm: rotation(15), text: SHORT_TEXT },
    { name: '旋转 45°', ctm: rotation(45), text: SHORT_TEXT },
    { name: '旋转 90°', ctm: rotation(90), text: SHORT_TEXT },
    { name: '旋转 180°', ctm: rotation(180), text: SHORT_TEXT },

    { name: '斜切 β=30°', ctm: [1, 0, tan20, 1, 0, 0], text: SHORT_TEXT },
    { name: '斜切 α=30°', ctm: [1, tan20, 0, 1, 0, 0], text: SHORT_TEXT },
    { name: '镜像 X', ctm: [-1, 0, 0, 1, 0, 0], text: SHORT_TEXT },
    { name: '镜像 Y', ctm: [1, 0, 0, -1, 0, 0], text: SHORT_TEXT },

    {
      name: '缩放0.6 后旋转30°',
      ctm: multiply(rotation(30), [0.6, 0, 0, 0.6, 0, 0]),
      text: SHORT_TEXT,
    },
    {
      name: '旋转30° 后缩放0.6',
      ctm: multiply([0.6, 0, 0, 0.6, 0, 0], rotation(30)),
      text: SHORT_TEXT,
    },
    {
      name: '斜切20° + 旋转20°',
      ctm: multiply(rotation(20), [1, 0, tan20, 1, 0, 0]),
      text: SHORT_TEXT,
    },
    {
      name: '旋转90° + 非等比1.5×0.7',
      ctm: multiply(rotation(90), [1.5, 0, 0, 0.7, 0, 0]),
      text: SHORT_TEXT,
    },

    // 以下为裁剪用例：Boundary 固定，用于观察裁剪效果。
    { name: '窗恰好容纳', boundary: [0, 0, 38, 11], fixedBoundary: true },
    { name: '窗高不足（裁下沿）', boundary: [0, 0, 40, 5], fixedBoundary: true },
    { name: '窗宽不足（裁右侧）', boundary: [0, 0, 12, 11], fixedBoundary: true },
    {
      name: 'CTM 推出窗外',
      // 字形基线在 Y=9，下推 40mm 后完全落在 11mm 高的窗外。
      ctm: [1, 0, 0, 1, 0, 40],
      boundary: [0, 0, 38, 11],
      fixedBoundary: true,
    },

    {
      name: 'CTM 移入窗内',
      // 字形基线移到 -30mm，上提 30mm 后落入窗内。
      ctm: [1, 0, 0, 1, 0, -30],
      codeYOverride: 30,
      boundary: [0, 0, 38, 11],
      fixedBoundary: true,
    },
    { name: '无裁剪（对照）' },
    {
      // 纵向窄带只保留左侧一个字：X∈[0,9]。
      name: '裁剪窄带 X∈[0,9]',
      clips: [{ rect: [0, -4, 9, 18] }],
    },
    {
      // 两区取交集：全幅纵向带 ∩ 仅保留字形上 2/3（Y∈[-2,8]）。
      // 字形基线在 Y=9、上伸约 7mm，该交集能保留大部分笔画。
      name: '两区取交集（裁下半）',
      clips: [
        { rect: [0, -4, 60, 18] },
        { rect: [0, -4, 60, 12] },
      ],
    },
  ];
}

/**
 * 构造等宽逐字偏移队列。
 *
 * 按表 46，队列第 i 项是后一个字相对前一个字的 X 偏移；等宽字距时每项都等于字宽。
 *
 * @param charCount 字符数。
 * @param advance 单字宽度，单位 mm。
 * @returns 长度为 `charCount - 1` 的偏移队列。
 */
function uniformDelta(charCount: number, advance: number): number[] {
  return Array.from({ length: Math.max(0, charCount - 1) }, () => advance);
}

/**
 * 把格子局部坐标转换为页面坐标。
 *
 * @param index 格子序号。
 * @param localX 格子局部 X，单位 mm。
 * @param localY 格子局部 Y，单位 mm。
 * @returns 页面坐标，单位 mm。
 */
function toPage(index: number, localX: number, localY: number): { x: number; y: number } {
  const column = index % COLUMNS;
  const row = Math.floor(index / COLUMNS);
  return {
    x: ORIGIN_X + column * GAP_X + localX,
    y: ORIGIN_Y + row * GAP_Y + localY,
  };
}

/**
 * 计算格子内实际使用的 Boundary 与 CTM。
 *
 * 自动模式下，先算基础变换后的字形范围，再把平移量并入 CTM，使字形左上角落在
 * 格子局部 `(MARGIN, MARGIN)`，Boundary 按字形范围外扩 `PAD`；这样字形始终在格内。
 *
 * @param cell 对照格。
 * @returns Boundary（格子局部）与最终 CTM（对象空间）。
 */
function resolveGeometry(cell: Cell): { boundary: Box; ctm?: Affine } {
  const content = cell.text ?? DEFAULT_TEXT;
  const base: Affine = cell.ctm ?? [1, 0, 0, 1, 0, 0];

  // Boundary 裁剪窗以对象空间原点为左上角，范围固定为 [0,Bw]×[0,Bh]；
  // 因此必须先把字形（经基础变换后）平移到对象空间原点附近，再确定窗口尺寸。
  if (cell.fixedBoundary && cell.boundary) {
    // 固定 Boundary 用例：完全按用例给定的 CTM 与窗口绘制，不参与自动摆放，
    // 以便真实呈现「CTM 把字形推入/推出裁剪窗」的效果。
    return {
      boundary: cell.boundary,
      ...(cell.ctm ? { ctm: base } : {}),
    };
  }

  const raw = textBounds(base, content.length);
  const pad = 2;
  const placed: Affine = [
    base[0],
    base[1],
    base[2],
    base[3],
    base[4] + (pad - raw.x0),
    base[5] + (pad - raw.y0),
  ];
  const placedBounds = textBounds(placed, content.length);

  // 自动模式：Boundary 覆盖字形经 CTM 后的完整落点范围。
  const boxW = placedBounds.x1 - placedBounds.x0 + pad * 2;
  const boxH = placedBounds.y1 - placedBounds.y0 + pad * 2;
  // 超出格子可用区域时整体等比缩小，避免压到相邻格子。
  const fit = Math.min(1, CELL_W / boxW, CELL_H / boxH);
  if (fit < 1) {
    const scaled: Affine = [
      placed[0] * fit,
      placed[1] * fit,
      placed[2] * fit,
      placed[3] * fit,
      placed[4] * fit,
      placed[5] * fit,
    ];
    return {
      boundary: [0, 0, Number((boxW * fit).toFixed(2)), Number((boxH * fit).toFixed(2))],
      ...(cell.ctm ? { ctm: scaled } : {}),
    };
  }
  return {
    boundary: [0, 0, Number(boxW.toFixed(2)), Number(boxH.toFixed(2))],
    ...(cell.ctm ? { ctm: placed } : {}),
  };
}

/**
 * 生成 `ctm-matrix.ofd` 文件。
 *
 * @param outputPath 输出路径。
 * @returns 写入的字节数。
 */
export function writeCtmMatrixOfd(outputPath: string): number {
  const fontData = new Uint8Array(readFileSync(FONT_PATH));
  const cells = buildCells();

  const labels = cells.map((cell, index) => {
    const position = toPage(index, 0, 4);
    return {
      id: 101 + index * 2,
      boundary: [position.x, position.y - 4, 64, 5] as Box,
      size: 3,
      text: cell.name,
      codeX: 0.5,
      codeY: 3.2,
      // 表 46：多字符需显式给出逐字偏移，否则全部叠在同一位置。
      ...(cell.name.length > 1 ? { deltaX: uniformDelta(cell.name.length, 3) } : {}),
      fillColor: [70, 70, 70] as [number, number, number],
    };
  });

  const texts = cells.map((cell, index) => {
    const content = cell.text ?? DEFAULT_TEXT;
    const geometry = resolveGeometry(cell);
    // 格子内留出边距摆放 Boundary 窗口。
    const position = toPage(index, CELL_PAD_X, CELL_PAD_Y);
    return {
      id: 100 + index * 2,
      boundary: [
        position.x,
        position.y,
        geometry.boundary[2],
        geometry.boundary[3],
      ] as Box,
      ...(geometry.ctm ? { ctm: geometry.ctm } : {}),
      size: FONT_SIZE,
      text: content,
      codeX: CODE_X,
      codeY: cell.codeYOverride ?? CODE_Y,
      // 表 46：按字号等宽逐字给出 DeltaX，字形框首尾相接。
      ...(content.length > 1 ? { deltaX: uniformDelta(content.length, FONT_SIZE) } : {}),
      ...(cell.clips ? { clips: cell.clips } : {}),
    };
  });

  const guides = cells.map((cell, index) => {
    const geometry = resolveGeometry(cell);
    const position = toPage(index, CELL_PAD_X, CELL_PAD_Y);
    return {
      id: 900 + index,
      boundary: [position.x, position.y, geometry.boundary[2], geometry.boundary[3]] as Box,
    };
  });

  const bytes = buildCtmOfd({
    page: PAGE,
    fontData,
    familyName: FONT_FAMILY,
    texts: [...labels, ...texts],
    guides,
  });

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, bytes);
  return bytes.length;
}