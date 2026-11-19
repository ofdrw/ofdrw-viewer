/**
 * 版式排布：滚动方向（页面滚动 / 水平滚动）× 视图模式（单页 / 双页）。
 *
 * 覆盖表 9 `PageLayout` 映射、两个方向的排布、双页组内间隔、缩放与旋转。
 */
import { describe, expect, it } from 'vitest';
import {
  PageLayout,
  SPREAD_GUTTER,
  layoutConfigFromPageLayout,
  resolveLayoutConfig,
} from '../../../src/page-layout';

/** 生成 count 页 A4 页信息。 */
function a4(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    index,
    widthMm: 210,
    heightMm: 297,
  }));
}

describe('版式配置', () => {
  it('表 9 PageLayout 映射为滚动方向 + 视图模式', () => {
    expect(layoutConfigFromPageLayout('OneColumn')).toEqual({
      direction: 'page',
      viewMode: 'single',
    });
    expect(layoutConfigFromPageLayout('OnePage')).toEqual({
      direction: 'horizontal',
      viewMode: 'single',
    });
    expect(layoutConfigFromPageLayout('TwoColumnL')).toEqual({
      direction: 'page',
      viewMode: 'spread',
    });
    expect(layoutConfigFromPageLayout('TwoPageR')).toEqual({
      direction: 'horizontal',
      viewMode: 'spread',
    });
    expect(layoutConfigFromPageLayout(undefined)).toBeUndefined();
    expect(layoutConfigFromPageLayout('Unknown')).toBeUndefined();
  });

  it('默认版式为单页 + 纵向滚动；非法值回落默认', () => {
    expect(resolveLayoutConfig(undefined)).toEqual({ direction: 'page', viewMode: 'single' });
    expect(resolveLayoutConfig({ direction: 'sideways' as never })).toEqual({
      direction: 'page',
      viewMode: 'single',
    });
  });
});

describe('排布', () => {
  it('单页 + 页面滚动：逐页向下堆叠，水平居中', () => {
    const layout = new PageLayout({ pageInfos: a4(3), scale: 1, zoomMode: 'page-actual' });
    const boxes = layout.getBoxes();
    expect(boxes[1]!.top).toBeGreaterThan(boxes[0]!.top + boxes[0]!.height);
    expect(boxes[2]!.top).toBeGreaterThan(boxes[1]!.top + boxes[1]!.height);
    // 只占一列：左缘一致。
    expect(boxes.every((box) => box.left === boxes[0]!.left)).toBe(true);
    expect(layout.direction).toBe('page');
    expect(layout.viewMode).toBe('single');
    expect(layout.columns).toBe(1);
  });

  it('单页 + 水平滚动：逐页向右排开，纵向单行', () => {
    const layout = new PageLayout({
      pageInfos: a4(3),
      scale: 1,
      zoomMode: 'page-actual',
      layout: { direction: 'horizontal', viewMode: 'single' },
    });
    const boxes = layout.getBoxes();
    // 同一行：top 一致。
    expect(boxes[1]!.top).toBe(boxes[0]!.top);
    expect(boxes[2]!.top).toBe(boxes[0]!.top);
    // 向右依次排开，不重叠。
    expect(boxes[1]!.left).toBeGreaterThanOrEqual(boxes[0]!.left + boxes[0]!.width);
    expect(boxes[2]!.left).toBeGreaterThanOrEqual(boxes[1]!.left + boxes[1]!.width);
    // 内容总宽覆盖三页。
    expect(layout.totalWidth).toBeGreaterThan(boxes[2]!.left + boxes[2]!.width - 1);
    expect(layout.totalHeight).toBeLessThan(layout.totalWidth);
  });

  it('双页 + 页面滚动：每行两页，组内保留间隔', () => {
    const layout = new PageLayout({
      pageInfos: a4(4),
      scale: 1,
      zoomMode: 'page-actual',
      layout: { direction: 'page', viewMode: 'spread' },
    });
    const boxes = layout.getBoxes();
    expect(layout.columns).toBe(2);
    // 同组两页 top 一致，第二页在第一页右侧且留出间隔。
    expect(boxes[0]!.top).toBe(boxes[1]!.top);
    expect(boxes[1]!.left - (boxes[0]!.left + boxes[0]!.width)).toBeCloseTo(SPREAD_GUTTER, 0);
    // 第 3、4 页是下一组。
    expect(boxes[2]!.top).toBeGreaterThan(boxes[0]!.top + boxes[0]!.height);
    expect(boxes[2]!.top).toBe(boxes[3]!.top);
    // 组数。
    expect(layout.groupCount).toBe(2);
    expect(layout.groupRangeOf(0)).toEqual({ start: 0, end: 1 });
    expect(layout.groupRangeOf(3)).toEqual({ start: 2, end: 3 });
  });

  it('双页 + 水平滚动：每组向右排开，组内两页并排', () => {
    const layout = new PageLayout({
      pageInfos: a4(4),
      scale: 1,
      zoomMode: 'page-actual',
      layout: { direction: 'horizontal', viewMode: 'spread' },
    });
    const boxes = layout.getBoxes();
    // 第 1、2 页同一行。
    expect(boxes[0]!.top).toBe(boxes[1]!.top);
    expect(boxes[1]!.left).toBeGreaterThan(boxes[0]!.left);
    // 第 2 组排在第 1 组右侧（同一行）。
    expect(boxes[2]!.top).toBe(boxes[0]!.top);
    expect(boxes[2]!.left).toBeGreaterThanOrEqual(boxes[1]!.left + boxes[1]!.width);
  });

  it('双页组内间隔大于 0', () => {
    expect(SPREAD_GUTTER).toBeGreaterThan(0);
    const layout = new PageLayout({
      pageInfos: a4(2),
      layout: { viewMode: 'spread' },
    });
    const boxes = layout.getBoxes();
    const gap = boxes[1]!.left - (boxes[0]!.left + boxes[0]!.width);
    expect(gap).toBeGreaterThan(8);
  });

  it('缩放后页盒尺寸与组内间隔同步放大', () => {
    const layout = new PageLayout({
      pageInfos: a4(2),
      scale: 1,
      zoomMode: 'page-actual',
      layout: { viewMode: 'spread' },
    });
    const before = layout.getBoxes();
    layout.setScale(2);
    const after = layout.getBoxes();
    expect(after[0]!.width).toBeCloseTo(before[0]!.width * 2, 0);
    expect(after[0]!.height).toBeCloseTo(before[0]!.height * 2, 0);
    // 组内间隔与页面一起按倍率放大，保证整组视觉比例不变。
    const beforeGap = before[1]!.left - (before[0]!.left + before[0]!.width);
    const afterGap = after[1]!.left - (after[0]!.left + after[0]!.width);
    expect(afterGap).toBeCloseTo(beforeGap * 2, 0);
  });

  it('横向滚动缩放：页面与组内间隔按倍率放大，组间距保持固定', () => {
    const layout = new PageLayout({
      pageInfos: a4(4),
      scale: 1,
      zoomMode: 'page-actual',
      layout: { direction: 'horizontal', viewMode: 'spread' },
    });
    const beforeWidth = layout.getBoxes()[0]!.width;
    const beforeTotal = layout.totalWidth;
    layout.setScale(2);
    const after = layout.getBoxes();
    // 页面宽度严格翻倍。
    expect(after[0]!.width).toBeCloseTo(beforeWidth * 2, 0);
    // 组内间隔同样翻倍。
    const gapAfter = after[1]!.left - (after[0]!.left + after[0]!.width);
    const gapBefore = SPREAD_GUTTER;
    expect(Math.abs(gapAfter - gapBefore * 2)).toBeLessThan(1);
    // 组间距（gap）固定不缩放，因此总宽略小于两倍。
    expect(layout.totalWidth).toBeGreaterThan(beforeTotal * 2 - 100);
    expect(layout.totalWidth).toBeLessThan(beforeTotal * 2);
  });

  it('旋转 90° 后双页仍并排，页盒宽高交换', () => {
    const layout = new PageLayout({
      pageInfos: a4(2),
      rotation: 90,
      layout: { viewMode: 'spread' },
    });
    const boxes = layout.getBoxes();
    expect(boxes[0]!.width).toBeCloseTo(boxes[0]!.unitHeight, 0);
    expect(boxes[0]!.height).toBeCloseTo(boxes[0]!.unitWidth, 0);
    expect(boxes[1]!.left).toBeGreaterThan(boxes[0]!.left);
    expect(boxes[0]!.top).toBe(boxes[1]!.top);
  });

  it('可见范围按滚动方向判定：横向只返回视口内的页', () => {
    const layout = new PageLayout({
      pageInfos: a4(10),
      scale: 1,
      zoomMode: 'page-actual',
      layout: { direction: 'horizontal', viewMode: 'single' },
    });
    layout.setViewport(1265, 688);
    const boxes = layout.getBoxes();
    // 视口只覆盖第一个页宽左右：可见页不应包含全部 10 页。
    const range = layout.getVisibleRangeAlong(0, 1265, 0);
    expect(range.start).toBe(0);
    expect(range.end).toBeLessThan(2);
    // 滚到第二页起点。
    const second = boxes[1]!.left;
    const scrolled = layout.getVisibleRangeAlong(second, 1265, 0);
    expect(scrolled.start).toBe(1);
  });

  it('纵向滚动时可见范围仍按 top 判定', () => {
    const layout = new PageLayout({
      pageInfos: a4(10),
      scale: 1,
      zoomMode: 'page-actual',
      layout: { direction: 'page', viewMode: 'spread' },
    });
    layout.setViewport(1265, 688);
    const boxes = layout.getBoxes();
    const range = layout.getVisibleRangeAlong(0, 688, 0);
    // 第一组两页可见。
    expect(range.start).toBe(0);
    expect(range.end).toBe(1);
    const next = layout.getVisibleRangeAlong(boxes[2]!.top, 688, 0);
    expect(next.start).toBe(2);
  });

  it('setLayout 只改一个维度时另一维度保持不变', () => {
    const layout = new PageLayout({ pageInfos: a4(2) });
    layout.setLayout({ viewMode: 'spread' });
    expect(layout.layout).toEqual({ direction: 'page', viewMode: 'spread' });
    layout.setLayout({ direction: 'horizontal' });
    expect(layout.layout).toEqual({ direction: 'horizontal', viewMode: 'spread' });
  });
});
