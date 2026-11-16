/**
 * 生成 CTM / Boundary / 裁剪区 的可视化对照图（人工确认用）。
 *
 * 每个单元格渲染一份独立的合成 OFD，并在图下方标注用例名称与 CTM 取值，
 * 灰色虚线框标出 `Boundary` 外接矩形，便于人工比对字形落位与裁剪结果。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { H5Canvas2DRenderer, OFDDocument, getPageViewport } from '@ofdrw/ofdrw-viewer-engine';
import type { Canvas2DLike, CanvasRenderingContext2DLike } from '@ofdrw/ofdrw-viewer-engine';
import { buildCtmOfd, type CtmClipSpec } from '../fixtures/ctm-ofd';
import { findSystemCjkFont } from '../fixtures/fonts';
import { nodeImageDecoders } from '../helpers/node-image-decoder';

/** 2×3 仿射矩阵。 */
type Affine = [number, number, number, number, number, number];

/** 标签用中文字体族名；注册失败时回退到 Canvas 默认字体。 */
const LABEL_FONT = registerLabelFont();

/**
 * 注册标签用中文字体，避免中文标注渲染成方框。
 *
 * @returns 字体族名；未注册成功时返回 `sans-serif`。
 */
function registerLabelFont(): string {
  const candidates = [
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
    '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
  ];
  for (const path of candidates) {
    try {
      if (GlobalFonts.registerFromPath(path, 'MatrixLabel')) return 'MatrixLabel';
    } catch {
      // 单个候选失败时继续尝试下一个。
    }
  }
  return 'sans-serif';
}

/** 单个对照单元。 */
interface Cell {
  /** 分组名。 */
  group: string;
  /** 用例名。 */
  name: string;
  /** 对象变换矩阵。 */
  ctm?: Affine;
  /** 外接矩形，单位 mm。 */
  boundary: [number, number, number, number];
  /** 首个 TextCode 的 X，对象空间 mm。 */
  codeX: number;
  /** 首个 TextCode 的 Y（基线），对象空间 mm。 */
  codeY: number;
  /** 字号，单位 mm。 */
  size: number;
  /** 裁剪区。 */
  clips?: readonly CtmClipSpec[];
  /** 本单元里的文字内容，缺省 ABC。 */
  text?: string;
}

/** 输出 DPI。 */
const DPI = 96;

/** 单元格内容尺寸，单位像素。 */
const CELL = 320;

/** 单元格标签高度，单位像素。 */
const LABEL = 52;

/** 每行列数。 */
const COLUMNS = 3;

/** 页面尺寸，单位 mm；与 `renderTexts` 一致，聚焦 Boundary 附近区域。 */
const PAGE = { width: 240, height: 200 };

/** 默认裁剪窗口：覆盖宽松 Boundary 附近，单位 mm。 */
const DEFAULT_CROP = { x: 22, y: 22, w: 120, h: 88 };

/**
 * 计算单元裁剪窗口：以 Boundary 为中心并留出余量，使裁剪用例的边界可见。
 *
 * @param cell 对照单元。
 * @returns 裁剪窗口，单位 mm。
 */
function cropOf(cell: Cell): { x: number; y: number; w: number; h: number } {
  const [bx, by, bw, bh] = cell.boundary;
  // 窄窗用例围绕窗本身取景，宽松窗用例按 Boundary 全貌取景。
  const marginX = bw < 40 ? 30 : 14;
  const marginY = bh < 40 ? 26 : 14;
  const width = Math.min(PAGE.width - 4, bw + marginX * 2);
  const height = Math.min(PAGE.height - 4, bh + marginY * 2);
  return {
    x: Math.max(2, Math.min(PAGE.width - width - 2, bx - marginX)),
    y: Math.max(2, Math.min(PAGE.height - height - 2, by - marginY)),
    w: width,
    h: height,
  };
}

/** 旋转矩阵（度）；正角方向为 X 轴转向 Y 轴。 */
function rotation(degrees: number, tx = 0, ty = 0): Affine {
  const radians = (degrees * Math.PI) / 180;
  const cos = Number(Math.cos(radians).toFixed(6));
  const sin = Number(Math.sin(radians).toFixed(6));
  return [cos, sin, -sin, cos, tx, ty];
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

/** 宽松 Boundary。 */
const ROOMY: [number, number, number, number] = [30, 30, 120, 80];

/** 与字形同尺度的 Boundary，用于裁剪类用例。 */
const CLIP_BOX: [number, number, number, number] = [30, 30, 40, 24];

/** 把对象空间点对齐到 Boundary 内部目标位置的平移补偿。 */
function fitInside(base: Affine, sx: number, sy: number, tx = 40, ty = 40): Affine {
  const mappedX = base[0] * sx + base[2] * sy;
  const mappedY = base[1] * sx + base[3] * sy;
  return [base[0], base[1], base[2], base[3], tx - mappedX, ty - mappedY];
}

/**
 * 渲染单个单元为画布。
 *
 * @param cell 对照单元。
 * @returns 渲染后的画布。
 */
async function renderCell(cell: Cell) {
  const font = findSystemCjkFont();
  if (!font) throw new Error('缺少系统 CJK 字体');
  const bytes = buildCtmOfd({
    page: PAGE,
    fontData: font.data,
    guides: [{ id: 800, boundary: cell.boundary }],
    texts: [
      {
        id: 1,
        boundary: cell.boundary,
        ...(cell.ctm ? { ctm: cell.ctm } : {}),
        size: cell.size,
        text: cell.text ?? 'ABC',
        codeX: cell.codeX,
        codeY: cell.codeY,
        ...(cell.clips ? { clips: cell.clips } : {}),
      },
    ],
  });
  const renderer = new H5Canvas2DRenderer({
    createCanvas: (width, height) => createCanvas(width, height) as unknown as Canvas2DLike,
  });
  const document = await OFDDocument.open({
    source: { kind: 'arraybuffer', data: bytes },
    renderer,
    imageDecoders: [...nodeImageDecoders],
  });
  try {
    const page = await document.getPage(0);
    const viewport = getPageViewport(page.getSize(), { dpi: DPI });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    await page
      .render({
        canvasContext: context as unknown as CanvasRenderingContext2DLike,
        viewport: { width, height, dpi: DPI },
      })
      .promise;
    return { canvas, context };
  } finally {
    await document.close();
  }
}

/**
 * 构造全部对照单元。
 *
 * @returns 单元列表。
 */
function buildCells(): Cell[] {
  const size = 12;
  const baseX = 40;
  const baseY = 60;

  return [
    { group: '基础变换', name: '无 CTM', boundary: ROOMY, codeX: baseX, codeY: baseY, size },
    { group: '基础变换', name: '平移 +Y 10', ctm: fitInside([1, 0, 0, 1, 0, 10], baseX, baseY), boundary: ROOMY, codeX: baseX, codeY: baseY, size },
    { group: '基础变换', name: '缩放 50%', ctm: fitInside([0.5, 0, 0, 0.5, 0, 0], baseX, baseY), boundary: ROOMY, codeX: baseX, codeY: baseY, size },
    { group: '基础变换', name: '非等比缩放 2×1', ctm: fitInside([2, 0, 0, 1, 0, 0], baseX, baseY), boundary: ROOMY, codeX: baseX, codeY: baseY, size },
    { group: '基础变换', name: '旋转 15°', ctm: fitInside(rotation(15), baseX, baseY), boundary: ROOMY, codeX: baseX, codeY: baseY, size },
    { group: '基础变换', name: '旋转 45°', ctm: fitInside(rotation(45), baseX, baseY), boundary: ROOMY, codeX: baseX, codeY: baseY, size },
    { group: '基础变换', name: '旋转 90°', ctm: fitInside(rotation(90), baseX, baseY), boundary: ROOMY, codeX: baseX, codeY: baseY, size },
    { group: '基础变换', name: '旋转 180°', ctm: fitInside(rotation(180), baseX, baseY), boundary: ROOMY, codeX: baseX, codeY: baseY, size },
    { group: '基础变换', name: '斜切 β=30°', ctm: fitInside([1, 0, Math.tan((30 * Math.PI) / 180), 1, 0, 0], baseX, baseY), boundary: ROOMY, codeX: baseX, codeY: baseY, size },
    { group: '基础变换', name: '斜切 α=30°', ctm: fitInside([1, Math.tan((30 * Math.PI) / 180), 0, 1, 0, 0], baseX, baseY), boundary: ROOMY, codeX: baseX, codeY: baseY, size },
    { group: '基础变换', name: '镜像 X', ctm: fitInside([-1, 0, 0, 1, 0, 0], -baseX, baseY), boundary: ROOMY, codeX: -baseX, codeY: baseY, size },
    { group: '基础变换', name: '镜像 Y', ctm: fitInside([1, 0, 0, -1, 0, 0], baseX, -baseY), boundary: ROOMY, codeX: baseX, codeY: -baseY, size },
    {
      group: '复合变换',
      name: '旋转45° 后平移',
      ctm: fitInside(rotation(45), baseX, baseY),
      boundary: ROOMY,
      codeX: baseX,
      codeY: baseY,
      size,
    },
    {
      group: '复合变换',
      name: '缩放0.6 后旋转30°',
      ctm: fitInside(multiply(rotation(30), [0.6, 0, 0, 0.6, 0, 0]), baseX, baseY),
      boundary: ROOMY,
      codeX: baseX,
      codeY: baseY,
      size,
    },
    {
      group: '复合变换',
      name: '旋转30° 后缩放0.6',
      ctm: fitInside(multiply([0.6, 0, 0, 0.6, 0, 0], rotation(30)), baseX, baseY),
      boundary: ROOMY,
      codeX: baseX,
      codeY: baseY,
      size,
    },
    {
      group: '复合变换',
      name: '斜切20° + 旋转20°',
      ctm: fitInside(multiply(rotation(20), [1, 0, Math.tan((20 * Math.PI) / 180), 1, 0, 0]), baseX, baseY),
      boundary: ROOMY,
      codeX: baseX,
      codeY: baseY,
      size,
    },
    {
      group: '复合变换',
      name: '旋转90° + 非等比(1.5,0.7)',
      ctm: fitInside(multiply(rotation(90), [1.5, 0, 0, 0.7, 0, 0]), baseX, baseY),
      boundary: ROOMY,
      codeX: baseX,
      codeY: baseY,
      size,
    },
    {
      group: '复合变换',
      name: '三重：旋转60°×斜切15°×缩放0.9',
      ctm: fitInside(
        multiply(multiply(rotation(60), [1, 0, Math.tan((15 * Math.PI) / 180), 1, 0, 0]), [0.9, 0, 0, 0.9, 0, 0]),
        baseX,
        baseY,
      ),
      boundary: ROOMY,
      codeX: baseX,
      codeY: baseY,
      size,
    },
    { group: 'Boundary 裁剪', name: '窗恰好容纳（60×20）', boundary: [30, 30, 60, 20], codeX: 2, codeY: 16, size },
    { group: 'Boundary 裁剪', name: '窗高 6mm（裁下沿）', boundary: [30, 30, 60, 6], codeX: 2, codeY: 12, size },
    { group: 'Boundary 裁剪', name: '窗宽 14mm（裁右侧）', boundary: [30, 30, 14, 20], codeX: 2, codeY: 16, size },
    {
      group: 'Boundary 裁剪',
      name: 'CTM 推出窗外（不可见）',
      ctm: [1, 0, 0, 1, 0, 100],
      boundary: [30, 30, 60, 20],
      codeX: 2,
      codeY: 16,
      size,
    },
    {
      group: 'Boundary 裁剪',
      name: 'CTM 移入窗内（可见）',
      ctm: [1, 0, 0, 1, 0, 20],
      boundary: [30, 30, 60, 20],
      codeX: 2,
      codeY: -4,
      size,
    },
    // 裁剪类用例改用与字形同尺度的 Boundary，便于在对照图中辨认裁剪效果。
    { group: '裁剪区', name: '无裁剪（对照）', boundary: CLIP_BOX, codeX: 2, codeY: 16, size },
    {
      group: '裁剪区',
      name: '裁剪窄带 X∈[0,10]',
      boundary: CLIP_BOX,
      codeX: 2,
      codeY: 16,
      size,
      clips: [{ rect: [0, 0, 10, 24] }],
    },
    {
      group: '裁剪区',
      name: '两区取交集',
      boundary: CLIP_BOX,
      codeX: 2,
      codeY: 16,
      size,
      clips: [{ rect: [0, 0, 10, 24] }, { rect: [0, 0, 10, 8] }],
    },
    {
      group: '裁剪区',
      name: '裁剪区自带 CTM（右移 20）',
      boundary: [50, 30, 40, 24],
      codeX: 22,
      codeY: 16,
      size,
      clips: [{ rect: [0, 0, 10, 24], ctm: [1, 0, 0, 1, 20, 0] }],
    },
    {
      group: '裁剪区',
      name: 'TransFlag=true（裁不到）',
      boundary: CLIP_BOX,
      codeX: 2,
      codeY: 16,
      size,
      clips: [{ rect: [0, 0, 10, 24], transFlag: true }],
    },
  ];
}

/**
 * 生成对照图。
 *
 * @param outputPath 输出 PNG 路径。
 */
export async function renderMatrixImage(outputPath: string): Promise<void> {
  const cells = buildCells();
  const rows = Math.ceil(cells.length / COLUMNS);
  const width = COLUMNS * CELL;
  const height = rows * (CELL + LABEL) + 40;
  const sheet = createCanvas(width, height);
  const sheetContext = sheet.getContext('2d');
  sheetContext.fillStyle = '#ffffff';
  sheetContext.fillRect(0, 0, width, height);
  sheetContext.fillStyle = '#111111';
  sheetContext.font = `bold 17px ${LABEL_FONT}`;
  sheetContext.fillText('OFD 引擎：CTM / Boundary / Clips 渲染对照（灰色虚线框 = Boundary 外接矩形）', 12, 28);

  for (const [index, cell] of cells.entries()) {
    const column = index % COLUMNS;
    const row = Math.floor(index / COLUMNS);
    const originX = column * CELL;
    const originY = row * (CELL + LABEL) + 40;

    const { canvas: source } = await renderCell(cell);
    const crop = cropOf(cell);
    const sourceX = crop.x * (DPI / 25.4);
    const sourceY = crop.y * (DPI / 25.4);
    const sourceW = crop.w * (DPI / 25.4);
    const sourceH = crop.h * (DPI / 25.4);
    // 等比缩放到单元格内（contain），保持字形比例不失真。
    const scale = Math.min(CELL / sourceW, CELL / sourceH);
    const drawW = sourceW * scale;
    const drawH = sourceH * scale;
    const offsetX = originX + (CELL - drawW) / 2;
    const offsetY = originY + (CELL - drawH) / 2;

    sheetContext.save();
    sheetContext.beginPath();
    sheetContext.rect(originX, originY, CELL, CELL);
    sheetContext.clip();
    sheetContext.fillStyle = '#ffffff';
    sheetContext.fillRect(originX, originY, CELL, CELL);
    sheetContext.drawImage(source, sourceX, sourceY, sourceW, sourceH, offsetX, offsetY, drawW, drawH);
    sheetContext.restore();

    sheetContext.strokeStyle = '#cccccc';
    sheetContext.lineWidth = 1;
    sheetContext.strokeRect(originX + 0.5, originY + 0.5, CELL - 1, CELL - 1);

    const ctmText = cell.ctm ? `CTM ${cell.ctm.map((value) => Number(value.toFixed(3))).join(' ')}` : 'CTM 无';
    sheetContext.fillStyle = '#111111';
    sheetContext.font = `bold 13px ${LABEL_FONT}`;
    sheetContext.fillText(cell.name, originX + 5, originY + CELL + 17);
    sheetContext.fillStyle = '#666666';
    sheetContext.font = '10px monospace';
    const lines = wrapText(ctmText, 46);
    for (const [lineIndex, line] of lines.entries()) {
      sheetContext.fillText(line, originX + 5, originY + CELL + 31 + lineIndex * 11);
    }
  }

  const bytes = sheet.toBuffer('image/png');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, bytes);
}

/**
 * 按字符数折行。
 *
 * @param text 原始文本。
 * @param perLine 每行字符数。
 * @returns 行数组。
 */
function wrapText(text: string, perLine: number): string[] {
  const lines: string[] = [];
  for (let index = 0; index < text.length; index += perLine) {
    lines.push(text.slice(index, index + perLine));
  }
  return lines;
}

/**
 * 生成对照图到默认路径。
 */
export async function writeMatrixImage(): Promise<string> {
  const outputDir = resolve(process.cwd(), '.tmp/ctm-matrix');
  mkdirSync(outputDir, { recursive: true });
  const outputPath = resolve(outputDir, 'ctm-matrix.png');
  await renderMatrixImage(outputPath);
  return outputPath;
}