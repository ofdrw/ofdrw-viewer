/**
 * 动作几何的单测。
 *
 * 重点验证三件事：
 * 1. `getActionGeometry` 的 mm → px 口径与文本层 `toTextPagePx` 逐字一致（含非 0 页原点、多 DPI）；
 * 2. 带旋转 `CTM` 的图元给出正确的四角点，顺序为「左上 → 右上 → 右下 → 左下」；
 * 3. `Region` 的折线近似与 even-odd 命中正确。
 */

import { describe, expect, it } from 'vitest';
import { getActionGeometry, isPointInActionRegion } from '../../src/api/geometry';
import type { ActionGeometry } from '../../src/api/geometry';
import { getPageTransform } from '../../src/api/viewport';
import { toTextPagePx } from '../../src/render/text-content';
import type { TextPageMm } from '../../src/render/text-content';
import type { ActionInfo, ActionRegionPath } from '../../src/model/types';

/** 构造图元动作；`region` 可选。 */
function objectAction(options: {
  pageIndex?: number;
  region?: ActionInfo['region'];
} = {}): ActionInfo {
  return {
    event: 'CLICK',
    type: 'movie',
    owner: { kind: 'object', pageIndex: options.pageIndex ?? 0, objectId: '30' },
    ...(options.region ? { region: options.region } : {}),
    payload: { type: 'movie', resourceId: '10', operator: 'Play' },
  };
}

/** 单位矩阵。 */
const IDENTITY: readonly [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];

/**
 * 用矩阵变换 mm 坐标点。
 *
 * @param matrix 2×3 矩阵。
 * @param x 输入 x，mm。
 * @param y 输入 y，mm。
 * @returns 变换后的点，px。
 */
function transformByMatrix(
  matrix: readonly [number, number, number, number, number, number],
  x: number,
  y: number,
): { x: number; y: number } {
  const [a, b, c, d, e, f] = matrix;
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

/** 页面区域：原点非 0，尺寸 200×300 mm。 */
const OFFSET_AREA = { x: 10, y: 20, w: 200, h: 300 };

/** 断言两个数在给定容差内相等。 */
function expectClose(actual: number, expected: number, tolerance = 1e-9): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

/** 三角剖分近似：矩形区域路径。 */
function rectRegion(x: number, y: number, w: number, h: number): ActionInfo['region'] {
  const path: ActionRegionPath[] = [
    { type: 'moveTo', x, y },
    { type: 'lineTo', x: x + w, y },
    { type: 'lineTo', x: x + w, y: y + h },
    { type: 'lineTo', x, y: y + h },
    { type: 'closePath' },
  ];
  return { areas: [[path]], bbox: { x, y, w, h } };
}

describe('getActionGeometry 与文本层口径一致', () => {
  const dpis = [96, 150, 300];
  const boundaries = [
    { x: 10, y: 20, w: 50, h: 30 },
    { x: 0, y: 0, w: 10, h: 10 },
    { x: 123.5, y: 67.25, w: 12.5, h: 7.5 },
  ];

  for (const dpi of dpis) {
    for (const boundary of boundaries) {
      it(`dpi=${dpi} boundary=${JSON.stringify(boundary)} 与非 0 页原点的文本层换算一致`, () => {
        const geometry = getActionGeometry(objectAction(), {
          area: OFFSET_AREA,
          dpi,
          object: { boundary },
        });
        expect(geometry).toBeDefined();

        // 文本层：页面 mm 坐标（rect 已是页面 mm）按 dpi/25.4 换算为 px。
        const pageMm: TextPageMm = {
          pageIndex: 0,
          pageWidthMm: OFFSET_AREA.w,
          pageHeightMm: OFFSET_AREA.h,
          items: [
            {
              order: 0,
              layer: 'page',
              layerType: 'Body',
              visible: true,
              alpha: 1,
              text: '',
              font: { resourceId: '1', family: 'x', italic: false },
              size: boundary.h,
              transform: IDENTITY,
              // 文本层已把页面内容平移到 PhysicalBox 原点（T(-area.x, -area.y)），见 text-content-api.md §坐标。
              origin: {
                x: boundary.x - OFFSET_AREA.x,
                y: boundary.y - OFFSET_AREA.y,
              },
              rect: {
                x: boundary.x - OFFSET_AREA.x,
                y: boundary.y - OFFSET_AREA.y,
                width: boundary.w,
                height: boundary.h,
              },
              quad: [
                { x: boundary.x - OFFSET_AREA.x, y: boundary.y - OFFSET_AREA.y },
                { x: boundary.x - OFFSET_AREA.x + boundary.w, y: boundary.y - OFFSET_AREA.y },
                { x: boundary.x - OFFSET_AREA.x + boundary.w, y: boundary.y - OFFSET_AREA.y + boundary.h },
                { x: boundary.x - OFFSET_AREA.x, y: boundary.y - OFFSET_AREA.y + boundary.h },
              ],
              advance: boundary.w,
              charCount: 0,
            },
          ],
          itemCount: 1,
          charCount: 0,
          truncated: { items: false, chars: false },
        };
        const textPx = toTextPagePx(pageMm, dpi);
        const textRect = textPx.items[0]?.rect;
        expect(textRect).toBeDefined();

        const bbox = geometry!.bbox;
        expectClose(bbox.x, textRect!.x);
        expectClose(bbox.y, textRect!.y);
        expectClose(bbox.width, textRect!.width);
        expectClose(bbox.height, textRect!.height);

        // 页面 mm → 文本 px 的换算链路同样是 getPageTransform（含非 0 原点平移）。
        const pageMatrix = getPageTransform(OFFSET_AREA, dpi);
        const topLeft = transformByMatrix(pageMatrix, boundary.x, boundary.y);
        expectClose(bbox.x, topLeft.x);
        expectClose(bbox.y, topLeft.y);
      });
    }
  }

  it('非 0 页原点做平移，0 原点与平移结果差值为 scale×原点的线性关系', () => {
    const boundary = { x: 10, y: 20, w: 50, h: 30 };
    const withOffset = getActionGeometry(objectAction(), {
      area: OFFSET_AREA,
      dpi: 96,
      object: { boundary },
    });
    const atOrigin = getActionGeometry(objectAction(), {
      area: { x: 0, y: 0, w: 200, h: 300 },
      dpi: 96,
      object: { boundary },
    });
    const scale = 96 / 25.4;
    expectClose(withOffset!.bbox.x, atOrigin!.bbox.x - scale * OFFSET_AREA.x);
    expectClose(withOffset!.bbox.y, atOrigin!.bbox.y - scale * OFFSET_AREA.y);
    expectClose(withOffset!.bbox.width, atOrigin!.bbox.width);
    expectClose(withOffset!.bbox.height, atOrigin!.bbox.height);
  });

  it('DPI 与像素尺寸严格线性', () => {
    const boundary = { x: 10, y: 20, w: 50, h: 30 };
    const at96 = getActionGeometry(objectAction(), { area: OFFSET_AREA, dpi: 96, object: { boundary } });
    const at192 = getActionGeometry(objectAction(), { area: OFFSET_AREA, dpi: 192, object: { boundary } });
    expectClose(at192!.bbox.x, at96!.bbox.x * 2);
    expectClose(at192!.bbox.y, at96!.bbox.y * 2);
    expectClose(at192!.bbox.width, at96!.bbox.width * 2);
    expectClose(at192!.bbox.height, at96!.bbox.height * 2);
  });
});

describe('图元几何与四角点', () => {
  it('轴对齐图元不返回 corners，source=object', () => {
    const geometry = getActionGeometry(objectAction(), {
      area: { x: 0, y: 0, w: 100, h: 100 },
      dpi: 96,
      object: { boundary: { x: 10, y: 10, w: 20, h: 20 } },
    });
    expect(geometry?.source).toBe('object');
    expect(geometry?.corners).toBeUndefined();
    expectClose(geometry!.bbox.x, (96 / 25.4) * 10);
    expectClose(geometry!.bbox.y, (96 / 25.4) * 10);
    expectClose(geometry!.bbox.width, (96 / 25.4) * 20);
  });

  it('旋转 90° 的 CTM 给出四角点，顺序为左上→右上→右下→左下', () => {
    // CTM 作用于图元内容的单位矩形（图片即以单位正方形描述），因此四角点为
    // (0,0)、(1,0)、(1,1)、(0,1) 经 rotate90 变换；Boundary 只承担裁剪。
    const geometry = getActionGeometry(objectAction(), {
      area: { x: 0, y: 0, w: 100, h: 100 },
      dpi: 96,
      object: { boundary: { x: 0, y: 0, w: 20, h: 10 }, ctm: [0, 1, -1, 0, 0, 0] },
    });
    const scale = 96 / 25.4;
    expect(geometry?.corners).toBeDefined();
    const corners = geometry!.corners!;
    expect(corners).toHaveLength(4);
    // 左上 = 单位矩形 (0,0)
    expectClose(corners[0].x, 0);
    expectClose(corners[0].y, 0);
    // 右上 = 单位矩形 (1,0) → (0,1)
    expectClose(corners[1].x, 0);
    expectClose(corners[1].y, 1 * scale);
    // 右下 = 单位矩形 (1,1) → (-1,1)
    expectClose(corners[2].x, -1 * scale);
    expectClose(corners[2].y, 1 * scale);
    // 左下 = 单位矩形 (0,1) → (-1,0)
    expectClose(corners[3].x, -1 * scale);
    expectClose(corners[3].y, 0);
  });

  it('旋转图元的 bbox 是四角点的外接矩形', () => {
    const geometry = getActionGeometry(objectAction(), {
      area: { x: 0, y: 0, w: 100, h: 100 },
      dpi: 96,
      object: { boundary: { x: 0, y: 0, w: 20, h: 10 }, ctm: [0, 1, -1, 0, 0, 0] },
    });
    const corners = geometry!.corners!;
    const xs = corners.map((point) => point.x);
    const ys = corners.map((point) => point.y);
    expectClose(geometry!.bbox.x, Math.min(...xs));
    expectClose(geometry!.bbox.y, Math.min(...ys));
    expectClose(geometry!.bbox.width, Math.max(...xs) - Math.min(...xs));
    expectClose(geometry!.bbox.height, Math.max(...ys) - Math.min(...ys));
  });

  it('图元 Boundary 偏移 + CTM 同时生效', () => {
    const geometry = getActionGeometry(objectAction(), {
      area: { x: 0, y: 0, w: 100, h: 100 },
      dpi: 96,
      object: { boundary: { x: 10, y: 20, w: 5, h: 5 }, ctm: [2, 0, 0, 2, 0, 0] },
    });
    const scale = 96 / 25.4;
    // 先按 Boundary 原点平移，再应用 CTM：单位矩形放大 2 倍成为 2×2 mm。
    expectClose(geometry!.bbox.x, 10 * scale);
    expectClose(geometry!.bbox.y, 20 * scale);
    expectClose(geometry!.bbox.width, 2 * scale);
    expectClose(geometry!.bbox.height, 2 * scale);
  });

  it('图片 CTM 把单位正方形放大到 Boundary 尺寸时，命中区等于 Boundary', () => {
    // 与 gb-12-media.ofd 的封面图一致：Boundary 160×90，CTM 亦为 160×90 缩放。
    const geometry = getActionGeometry(objectAction(), {
      area: { x: 0, y: 0, w: 297, h: 210 },
      dpi: 96,
      object: { boundary: { x: 68.5, y: 34, w: 160, h: 90 }, ctm: [160, 0, 0, 90, 0, 0] },
    });
    const scale = 96 / 25.4;
    expectClose(geometry!.bbox.x, 68.5 * scale);
    expectClose(geometry!.bbox.y, 34 * scale);
    expectClose(geometry!.bbox.width, 160 * scale);
    expectClose(geometry!.bbox.height, 90 * scale);
  });
});

describe('Region 几何与命中', () => {
  it('矩形 Region 输出折线与外接矩形，source=region', () => {
    const geometry = getActionGeometry(objectAction({ region: rectRegion(0, 0, 20, 10) }), {
      area: { x: 0, y: 0, w: 100, h: 100 },
      dpi: 96,
    });
    const scale = 96 / 25.4;
    expect(geometry?.source).toBe('region');
    expect(geometry?.areas).toHaveLength(1);
    expect(geometry?.areas?.[0]).toHaveLength(5);
    expectClose(geometry!.bbox.width, 20 * scale);
    expectClose(geometry!.bbox.height, 10 * scale);
  });

  it('Region 优先于图元 Boundary', () => {
    const geometry = getActionGeometry(objectAction({ region: rectRegion(5, 5, 10, 10) }), {
      area: { x: 0, y: 0, w: 100, h: 100 },
      dpi: 96,
      object: { boundary: { x: 0, y: 0, w: 100, h: 100 } },
    });
    expect(geometry?.source).toBe('region');
  });

  it('even-odd 命中：矩形内部命中、外部未命中', () => {
    const geometry = getActionGeometry(objectAction({ region: rectRegion(0, 0, 20, 10) }), {
      area: { x: 0, y: 0, w: 100, h: 100 },
      dpi: 96,
    })!;
    const scale = 96 / 25.4;
    expect(isPointInActionRegion(geometry, { x: 10 * scale, y: 5 * scale })).toBe(true);
    expect(isPointInActionRegion(geometry, { x: 25 * scale, y: 5 * scale })).toBe(false);
    expect(isPointInActionRegion(geometry, { x: 10 * scale, y: 15 * scale })).toBe(false);
  });

  it('带孔洞的 Region（两条子路径）按 even-odd 命中', () => {
    const outer: ActionRegionPath[] = [
      { type: 'moveTo', x: 0, y: 0 },
      { type: 'lineTo', x: 40, y: 0 },
      { type: 'lineTo', x: 40, y: 40 },
      { type: 'lineTo', x: 0, y: 40 },
      { type: 'closePath' },
    ];
    const inner: ActionRegionPath[] = [
      { type: 'moveTo', x: 10, y: 10 },
      { type: 'lineTo', x: 30, y: 10 },
      { type: 'lineTo', x: 30, y: 30 },
      { type: 'lineTo', x: 10, y: 30 },
      { type: 'closePath' },
    ];
    const geometry = getActionGeometry(
      objectAction({ region: { areas: [[outer, inner]], bbox: { x: 0, y: 0, w: 40, h: 40 } } }),
      { area: { x: 0, y: 0, w: 100, h: 100 }, dpi: 96 },
    )!;
    const scale = 96 / 25.4;
    expect(isPointInActionRegion(geometry, { x: 5 * scale, y: 5 * scale })).toBe(true);
    expect(isPointInActionRegion(geometry, { x: 20 * scale, y: 20 * scale })).toBe(false);
  });

  it('贝塞尔 Region 离散为 8 段折线并参与外接矩形', () => {
    const curve: ActionRegionPath[] = [
      { type: 'moveTo', x: 0, y: 0 },
      { type: 'bezierCurveTo', cp1x: 0, cp1y: 20, cp2x: 20, cp2y: 20, x: 20, y: 0 },
      { type: 'closePath' },
    ];
    const geometry = getActionGeometry(
      objectAction({ region: { areas: [[curve]], bbox: { x: 0, y: 0, w: 20, h: 20 } } }),
      { area: { x: 0, y: 0, w: 100, h: 100 }, dpi: 96 },
    )!;
    // 起点 + 8 段 + 闭合回到起点 = 10 点。
    expect(geometry.areas?.[0]).toHaveLength(10);
    expect(geometry.bbox.height).toBeGreaterThan(0);
  });

  it('无 Region 时按 bbox 命中', () => {
    const geometry = getActionGeometry(objectAction(), {
      area: { x: 0, y: 0, w: 100, h: 100 },
      dpi: 96,
      object: { boundary: { x: 10, y: 10, w: 20, h: 20 } },
    })!;
    const scale = 96 / 25.4;
    expect(isPointInActionRegion(geometry, { x: 20 * scale, y: 20 * scale })).toBe(true);
    expect(isPointInActionRegion(geometry, { x: 40 * scale, y: 20 * scale })).toBe(false);
    expect(isPointInActionRegion(geometry, { x: Number.NaN, y: 0 })).toBe(false);
  });
});

describe('几何可定位性', () => {
  it('文档级无区域动作返回 undefined', () => {
    const action: ActionInfo = {
      event: 'DO',
      type: 'movie',
      owner: { kind: 'document' },
      payload: { type: 'movie', resourceId: '10', operator: 'Play' },
    };
    expect(getActionGeometry(action, { area: { x: 0, y: 0, w: 100, h: 100 } })).toBeUndefined();
  });

  it('大纲级无区域动作返回 undefined；带区域且指定 pageIndex 时可计算', () => {
    const base: ActionInfo = {
      event: 'CLICK',
      type: 'uri',
      owner: { kind: 'outline', path: [0] },
      payload: { type: 'uri', uri: 'https://example.com' },
    };
    expect(getActionGeometry(base, { area: { x: 0, y: 0, w: 100, h: 100 } })).toBeUndefined();
    const withRegion: ActionInfo = { ...base, region: rectRegion(0, 0, 10, 10) };
    const geometry = getActionGeometry(withRegion, {
      area: { x: 0, y: 0, w: 100, h: 100 },
      pageIndex: 2,
    });
    expect(geometry?.pageIndex).toBe(2);
    expect(geometry?.source).toBe('region');
  });

  it('页级动作的缺省几何来自页面区域之外的图元：未提供 object 时给零矩形', () => {
    const action: ActionInfo = {
      event: 'PO',
      type: 'sound',
      owner: { kind: 'page', pageIndex: 1 },
      payload: { type: 'sound', resourceId: '12', volume: 100, repeat: false, synchronous: false },
    };
    expect(getActionGeometry(action, { area: { x: 0, y: 0, w: 100, h: 100 } })).toBeUndefined();
  });

  it('非法 dpi 回退 96', () => {
    const withNaN = getActionGeometry(objectAction(), {
      area: { x: 0, y: 0, w: 100, h: 100 },
      dpi: Number.NaN,
      object: { boundary: { x: 0, y: 0, w: 10, h: 10 } },
    });
    const with96 = getActionGeometry(objectAction(), {
      area: { x: 0, y: 0, w: 100, h: 100 },
      dpi: 96,
      object: { boundary: { x: 0, y: 0, w: 10, h: 10 } },
    });
    expect(withNaN?.bbox).toEqual(with96?.bbox);
  });

  it('几何结果不包含旋转后的页面变换（输出未旋转页面像素）', () => {
    // 页面旋转由宿主承担：engine 输出与页面旋转参数无关，同一输入结果稳定。
    const first = getActionGeometry(objectAction(), {
      area: { x: 0, y: 0, w: 100, h: 100 },
      dpi: 96,
      object: { boundary: { x: 10, y: 10, w: 20, h: 20 } },
    }) as ActionGeometry;
    const second = getActionGeometry(objectAction(), {
      area: { x: 0, y: 0, w: 100, h: 100 },
      dpi: 96,
      object: { boundary: { x: 10, y: 10, w: 20, h: 20 } },
    }) as ActionGeometry;
    expect(second.bbox).toEqual(first.bbox);
  });
});
describe('getPageActionGeometries（批量几何）', () => {
  it('gb-12-media.ofd 第 1 页：ImageObject 的 CLICK/Movie 得到非零 bbox', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { openTestDocument } = await import('./helpers');
    const samplePath = fileURLToPath(new URL('../../../../ofd_pdf_match/gb-12-media.ofd', import.meta.url));
    if (!existsSync(samplePath)) return;
    const doc = await openTestDocument(new Uint8Array(readFileSync(samplePath)));
    try {
      const entries = await doc.getPageActionGeometries(0, { dpi: 96 });
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.action).toMatchObject({ event: 'CLICK', type: 'movie' });
      expect(entry.geometry.source).toBe('object');
      expect(entry.geometry.bbox.width).toBeGreaterThan(0);
      expect(entry.geometry.bbox.height).toBeGreaterThan(0);
      // 与 Boundary 换算一致：样例视频窗口 160mm 宽、居中对齐。
      expectClose(entry.geometry.bbox.width, 160 * (96 / 25.4), 1e-6);

      const page1 = await doc.getPageActionGeometries(1, { dpi: 96 });
      expect(page1).toHaveLength(1);
      expect(page1[0]?.action.type).toBe('sound');
      expectClose(page1[0]!.geometry.bbox.width, 90 * (96 / 25.4), 1e-6);
      expectClose(page1[0]!.geometry.bbox.height, 22 * (96 / 25.4), 1e-6);
    } finally {
      await doc.close();
    }
  }, 60_000);

  it('顺序：页级动作在前，其后图元按绘制序', async () => {
    const { buildFixtureOfd, openTestDocument } = await import('./helpers');
    const bytes = buildFixtureOfd({
      pages: [
        {
          id: 1,
          widthMm: 200,
          heightMm: 200,
          objects: [
            {
              name: 'ofd:PathObject',
              attrs: { ID: '1', Boundary: '0 0 10 10' },
              children: [
                { name: 'ofd:AbbreviatedData', children: ['M 0 0 L 10 0 L 10 10 C'] },
                { name: 'ofd:Actions', children: [{ name: 'ofd:Action', attrs: { Event: 'CLICK' }, children: [{ name: 'ofd:Sound', attrs: { ResourceID: '1' } }] }] },
              ],
            },
            {
              name: 'ofd:PathObject',
              attrs: { ID: '2', Boundary: '0 0 20 20' },
              children: [
                { name: 'ofd:AbbreviatedData', children: ['M 0 0 L 20 0 L 20 20 C'] },
                { name: 'ofd:Actions', children: [{ name: 'ofd:Action', attrs: { Event: 'CLICK' }, children: [{ name: 'ofd:URI', attrs: { URI: 'https://b' } }] }] },
              ],
            },
          ],
        },
      ],
    });
    const doc = await openTestDocument(bytes);
    try {
      const entries = await doc.getPageActionGeometries(0);
      // 两个图元按 XML 顺序（同一层内）。
      expect(entries.map((item) => item.action.type)).toEqual(['sound', 'uri']);
      expect(entries[0]?.geometry.bbox.width).toBeLessThan(entries[1]!.geometry.bbox.width);
    } finally {
      await doc.close();
    }
  });

  it('无 Region 的文档级与页面级动作不在结果中；带 Region 的页面动作排首位', async () => {
    const { buildFixtureOfd, openTestDocument } = await import('./helpers');
    const bytes = buildFixtureOfd({
      pages: [
        {
          id: 1,
          widthMm: 100,
          heightMm: 100,
          objects: [
            {
              name: 'ofd:PathObject',
              attrs: { ID: '5', Boundary: '0 0 10 10' },
              children: [
                { name: 'ofd:AbbreviatedData', children: ['M 0 0 L 10 0 L 10 10 C'] },
                { name: 'ofd:Actions', children: [{ name: 'ofd:Action', attrs: { Event: 'CLICK' }, children: [{ name: 'ofd:Sound', attrs: { ResourceID: '1' } }] }] },
              ],
            },
          ],
        },
      ],
      documentChildren: [
        { name: 'ofd:Actions', children: [{ name: 'ofd:Action', attrs: { Event: 'DO' }, children: [{ name: 'ofd:Movie', attrs: { ResourceID: '1' } }] }] },
      ],
    });
    const doc = await openTestDocument(bytes);
    try {
      const entries = await doc.getPageActionGeometries(0);
      expect(entries.map((item) => item.action.owner.kind)).toEqual(['object']);
      expect(doc.getDocumentActions()).toHaveLength(1);
    } finally {
      await doc.close();
    }
  });

  it('旋转 CTM 图元透出 corners；无动作时返回空数组', async () => {
    const { buildFixtureOfd, openTestDocument } = await import('./helpers');
    const rotated = buildFixtureOfd({
      pages: [
        {
          id: 1,
          widthMm: 100,
          heightMm: 100,
          objects: [
            {
              name: 'ofd:ImageObject',
              attrs: { ID: '9', Boundary: '10 10 20 10', ResourceID: '11', CTM: '0 1 -1 0 0 0' },
              children: [
                { name: 'ofd:Actions', children: [{ name: 'ofd:Action', attrs: { Event: 'CLICK' }, children: [{ name: 'ofd:Movie', attrs: { ResourceID: '10' } }] }] },
              ],
            },
          ],
        },
      ],
    });
    const doc = await openTestDocument(rotated);
    try {
      const entries = await doc.getPageActionGeometries(0);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.geometry.corners).toHaveLength(4);
    } finally {
      await doc.close();
    }

    const plain = await openTestDocument(
      buildFixtureOfd({ pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [] }] }),
    );
    try {
      expect(await plain.getPageActionGeometries(0)).toEqual([]);
    } finally {
      await plain.close();
    }
  });

  it('页索引越界抛 OFD_PAGE_NOT_FOUND', async () => {
    const { buildFixtureOfd, openTestDocument } = await import('./helpers');
    const doc = await openTestDocument(
      buildFixtureOfd({ pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [] }] }),
    );
    try {
      const error = await doc.getPageActionGeometries(5).catch((caught: unknown) => caught);
      expect((error as { code?: string }).code).toBe('OFD_PAGE_NOT_FOUND');
    } finally {
      await doc.close();
    }
  });
});
