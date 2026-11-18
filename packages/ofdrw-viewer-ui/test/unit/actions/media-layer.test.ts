/**
 * 媒体层 DOM 与双击缩放防误触单测（音视频与动作方案设计 §7.1 / §7.2 / §7.12）。
 */
import { describe, expect, it } from 'vitest';
import { PageView } from '../../../src/page-view';

/** 构造一个最小页视图。 */
function createPageView(): PageView {
  return new PageView({
    pageNumber: 1,
    pageIndex: 0,
    pageInfo: { index: 0, widthMm: 210, heightMm: 297 },
    totalPages: 1,
  });
}

/** 96 DPI 下 A4 的页面尺寸，单位 px。 */
const A4_WIDTH_PX = (210 * 96) / 25.4;
const A4_HEIGHT_PX = (297 * 96) / 25.4;

describe('媒体层 DOM 结构', () => {
  it('插入在文字层之后、签章层之前', () => {
    const view = createPageView();
    const children = [...view.surface.children];
    const textIndex = children.indexOf(view.textLayer);
    const mediaIndex = children.indexOf(view.mediaLayer);
    const signatureIndex = children.indexOf(view.signatureLayer);
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(mediaIndex).toBeGreaterThan(textIndex);
    expect(signatureIndex).toBeGreaterThan(mediaIndex);
    view.destroy();
  });

  it('pointer-events 为 none，子元素才能各自开启命中', () => {
    const view = createPageView();
    expect(view.mediaLayer.style.pointerEvents).toBe('none');
    view.destroy();
  });

  it('初始为空容器', () => {
    const view = createPageView();
    expect(view.mediaLayer.childElementCount).toBe(0);
    view.releaseMediaLayer();
    expect(view.mediaLayer.childElementCount).toBe(0);
    view.destroy();
  });
});

describe('媒体层定位模型', () => {
  it('布局框按「纸面尺寸 / 布局倍率」设置并以 scale 放大（与文本层同构）', () => {
    const view = createPageView();
    const scale = 2;
    view.setLayout({
      box: {
        index: 0,
        pageNumber: 1,
        top: 0,
        left: 0,
        width: A4_WIDTH_PX * scale,
        height: A4_HEIGHT_PX * scale,
        surfaceWidth: A4_WIDTH_PX * scale,
        surfaceHeight: A4_HEIGHT_PX * scale,
        widthMm: 210,
        heightMm: 297,
        unitWidth: A4_WIDTH_PX,
        unitHeight: A4_HEIGHT_PX,
      },
      rotation: 0,
      scale,
      devicePixelRatio: 1,
    });
    // 布局框 = 纸面尺寸 / 倍率 = 96 DPI 单位尺寸。
    expect(Number.parseFloat(view.mediaLayer.style.width)).toBeCloseTo(A4_WIDTH_PX, 1);
    expect(Number.parseFloat(view.mediaLayer.style.height)).toBeCloseTo(A4_HEIGHT_PX, 1);
    // 再由 transform 放大回纸面尺寸。
    expect(view.mediaLayer.style.transform).toBe(`scale(${scale})`);
    expect(view.mediaLayer.style.transformOrigin).toBe('0 0');
    view.destroy();
  });

  it('缩放只改这一个 transform，不改子元素几何', () => {
    const view = createPageView();
    const box = {
      index: 0,
      pageNumber: 1,
      top: 0,
      left: 0,
      width: A4_WIDTH_PX,
      height: A4_HEIGHT_PX,
      surfaceWidth: A4_WIDTH_PX,
      surfaceHeight: A4_HEIGHT_PX,
      widthMm: 210,
      heightMm: 297,
      unitWidth: A4_WIDTH_PX,
      unitHeight: A4_HEIGHT_PX,
    };
    view.setLayout({ box, rotation: 0, scale: 1, devicePixelRatio: 1 });
    const child = document.createElement('video');
    child.className = 'ofd-media';
    child.style.left = '10px';
    child.style.top = '20px';
    child.style.width = '100px';
    child.style.height = '50px';
    view.mediaLayer.appendChild(child);

    view.setScaleVariable(3);
    // 子元素 96 DPI 几何保持不变，仅容器 transform 变化。
    expect(child.style.left).toBe('10px');
    expect(child.style.width).toBe('100px');
    expect(view.mediaLayer.style.transform).toBe('scale(3)');
    // 纸面尺寸按设备像素网格向上取整后除以倍率，因此与理论值有不足 0.5px 的取整差。
    expect(Number.parseFloat(view.mediaLayer.style.width)).toBeCloseTo(A4_WIDTH_PX, 0);
    view.destroy();
  });
});

describe('媒体层清理', () => {
  it('releaseMediaLayer 与 destroy 都会清空子节点', () => {
    const view = createPageView();
    view.mediaLayer.appendChild(document.createElement('video'));
    view.releaseMediaLayer();
    expect(view.mediaLayer.childElementCount).toBe(0);
    view.mediaLayer.appendChild(document.createElement('video'));
    view.destroy();
    expect(view.mediaLayer.childElementCount).toBe(0);
  });
});