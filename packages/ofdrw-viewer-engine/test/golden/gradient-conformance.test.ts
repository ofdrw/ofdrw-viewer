/**
 * 渐变（GB/T 33190—2016 §8.3.4）对照验收：逐格判定 `ofd_pdf_match/gradient.ofd`。
 *
 * 判定以「语义一致」为准（Extend 方向、MapType 周期、EdgeFlag 三角化、网格行列分组、
 * 渐变文字/Clip 组合），不追求与标准效果图像素级一致。
 *
 * 每个用例的 `it` 标题即报告中的「用例」列；断言失败即该项「不符合」。
 */

import { describe, expect, it } from 'vitest';
import {
  countWarnings,
  isClose,
  pixelAt,
  renderGradientSample,
  type RenderedSample,
} from './gradient-conformance';

/** 标准中定义的示例颜色。 */
const RED: [number, number, number] = [220, 30, 30];
const GREEN: [number, number, number] = [20, 160, 60];
const BLUE: [number, number, number] = [30, 80, 220];
const YELLOW: [number, number, number] = [250, 210, 0];
const CYAN: [number, number, number] = [0, 170, 190];
const MAGENTA: [number, number, number] = [220, 40, 160];
const WHITE: [number, number, number] = [255, 255, 255];

/** 采样时使用的容差（通道最大差）。 */
const TOL = 28;

/** 延迟渲染的样本（全部用例共享一次渲染）。 */
let samplePromise: Promise<RenderedSample> | undefined;

/**
 * 取渲染样本（惰性单例）。
 *
 * @returns 渲染结果。
 */
function sample(): Promise<RenderedSample> {
  samplePromise ??= renderGradientSample();
  return samplePromise;
}

/**
 * 按页码取渲染页。
 *
 * @param rendered 渲染结果。
 * @param pageNumber 1 起的页码。
 * @returns 该页。
 */
function page(rendered: RenderedSample, pageNumber: number) {
  const target = rendered.pages[pageNumber - 1];
  if (!target) throw new Error(`样本缺少第 ${pageNumber} 页`);
  return target;
}

describe('渐变对照验收 · 第 1 页 轴向渐变 AxialShd（§8.3.4.2 表 29）', () => {
  it('A1 规范样例 FillColor/AxialShd：沿 +X 由首段色渐变到末段色', async () => {
    const rendered = await sample();
    const p = page(rendered, 1);
    expect(isClose(pixelAt(p, 10.4, 40), YELLOW, TOL)).toBe(true);
    expect(isClose(pixelAt(p, 69.6, 40), BLUE, TOL)).toBe(true);
    expect(isClose(pixelAt(p, 40, 40), [140, 145, 110], 20)).toBe(true);
  });

  it('A2 MapType=Direct（规范图 31）：单次渐变，超出轴线取端色', async () => {
    const rendered = await sample();
    const p = page(rendered, 1);
    // 该格对象 CTM 等比缩小 0.5，轴线 0..140 对象单位在 Boundary 内完整可见
    // （页面 10..80mm 对应对象 x 0..140），因此应从首段黄渐变到末段蓝。
    // 格子 Boundary 为 (10, 60, 70, 20)，取纵向中线 y=70。
    expect(isClose(pixelAt(p, 10.4, 70), YELLOW, TOL)).toBe(true);
    expect(isClose(pixelAt(p, 79.6, 70), BLUE, TOL)).toBe(true);
  });

  it('A3 MapType=Repeat（规范图 32）：一个渐变区间长度应等于 MapUnit=30', async () => {
    const rendered = await sample();
    const p = page(rendered, 1);
    // 单元格 Boundary (88, 60, 70, 20)，对象 CTM 0.5 → 可见对象轴线 0..140（MapUnit=30）
    // 对应页面周期 15mm：首段黄出现在 88、103、118… 处。
    expect(isClose(pixelAt(p, 88.4, 70), YELLOW, TOL)).toBe(true);
    expect(isClose(pixelAt(p, 103.4, 70), YELLOW, TOL)).toBe(true);
    expect(isClose(pixelAt(p, 118.4, 70), YELLOW, TOL)).toBe(true);
  });

  it('A4 MapType=Reflect（规范图 33）：按 MapUnit=30 镜像重复', async () => {
    const rendered = await sample();
    const p = page(rendered, 1);
    // 反射：Boundary (166, 60, 70, 20)，周期 15mm。第 1 区间黄→蓝（166→181），
    // 第 2 区间镜像蓝→黄（181→196），故 166/196 处为黄、181 处为蓝。
    expect(isClose(pixelAt(p, 166.4, 70), YELLOW, TOL)).toBe(true);
    expect(isClose(pixelAt(p, 181, 70), BLUE, TOL)).toBe(true);
    expect(isClose(pixelAt(p, 196, 70), YELLOW, TOL)).toBe(true);
  });

  it('A5 Extend=0：轴线区间外不绘制渐变（应保持白底）', async () => {
    const rendered = await sample();
    const p = page(rendered, 1);
    // 单元格 Boundary (10, 115, 70, 43.5)；对象轴线 10.5..49.5 落在页面 x 20.5..59.5。
    // Extend=0：轴线区间外（x<20.5 与 x>59.5）不得继续绘制渐变，应保持白底。
    expect(isClose(pixelAt(p, 12, 125), WHITE, 6)).toBe(true);
    expect(isClose(pixelAt(p, 18, 125), WHITE, 6)).toBe(true);
    expect(isClose(pixelAt(p, 30, 125), [171, 62, 37], 25)).toBe(true);
    expect(isClose(pixelAt(p, 62, 125), WHITE, 12)).toBe(true);
    expect(isClose(pixelAt(p, 76, 125), WHITE, 12)).toBe(true);
  });

  it('A6 Extend=1：向起始点一侧延伸，延伸区为首段色', async () => {
    const rendered = await sample();
    const p = page(rendered, 1);
    expect(isClose(pixelAt(p, 86, 125), RED, TOL)).toBe(true);
  });

  it('A7 Extend=2：向结束点一侧延伸，延伸区为末段色', async () => {
    const rendered = await sample();
    const p = page(rendered, 1);
    expect(isClose(pixelAt(p, 219, 125), GREEN, TOL)).toBe(true);
  });

  it('A8 Extend=3：两侧都延伸', async () => {
    const rendered = await sample();
    const p = page(rendered, 1);
    expect(isClose(pixelAt(p, 236, 125), RED, TOL)).toBe(true);
    // 该格右边界越出版面（样本问题），仅校验起始侧
  });

  it('A9 警告：轴向渐变不应产生渐变相关降级 warning', async () => {
    const rendered = await sample();
    const axialPageWarnings = rendered.warnings.filter(
      (warning) => (warning as unknown as { pageIndex?: number }).pageIndex === 0,
    );
    expect(axialPageWarnings.filter((warning) => warning.code.startsWith('W_UNSUPPORTED_PAINT'))).toEqual([]);
    expect(countWarnings(axialPageWarnings, 'W_RADIAL_UNSUPPORTED')).toBe(0);
  });
});

describe('渐变对照验收 · 第 2 页 径向渐变 RadialShd（§8.3.4.3 表 30）', () => {
  it('B1 Extend 缺省(0)：起始椭圆外不绘制，中心取起始色、边缘取结束色', async () => {
    const rendered = await sample();
    const p = page(rendered, 2);
    // 单元格 bd=(10,14,75,35)；样例几何 StartPoint(15,37.5) StartRadius=37.5 → EndPoint(52.5,37.5) EndRadius=7.5
    // 起始椭圆内取起始色（黄），结束椭圆外且 Extend=0 → 不着色
    expect(isClose(pixelAt(p, 30, 40), YELLOW, 30)).toBe(true);
    // 远离两椭圆中心连线（超出结束椭圆）且 Extend=0 → 不着色
    expect(isClose(pixelAt(p, 25, 50), WHITE, 8)).toBe(true);
    expect(isClose(pixelAt(p, 84, 16), WHITE, 8)).toBe(true);
  });

  it('B2 警告：不再出现 W_RADIAL_UNSUPPORTED', async () => {
    const rendered = await sample();
    expect(countWarnings(rendered.warnings, 'W_RADIAL_UNSUPPORTED')).toBe(0);
  });

  it('B3 逐格应有颜色变化（非平均色单色块）', async () => {
    const rendered = await sample();
    const p = page(rendered, 2);
    const a = pixelAt(p, 25, 40.25);
    const b = pixelAt(p, 45, 40.25);
    const c = pixelAt(p, 40, 22);
    const spread =
      Math.max(a[0], b[0], c[0]) - Math.min(a[0], b[0], c[0]) +
      Math.max(a[2], b[2], c[2]) - Math.min(a[2], b[2], c[2]);
    expect(spread).toBeGreaterThan(60);
  });
});

describe('渐变对照验收 · 第 3 页 高洛德 GouraudShd（§8.3.4.4 表 31、图 40）', () => {
  it('C1 EdgeFlag=0：单三角形 abc，顶点色正确', async () => {
    const rendered = await sample();
    const p = page(rendered, 3);
    expect(isClose(pixelAt(p, 35, 21), RED, 40)).toBe(true);
    expect(isClose(pixelAt(p, 16, 43), GREEN, 40)).toBe(true);
    expect(isClose(pixelAt(p, 54, 43), BLUE, 40)).toBe(true);
  });

  it('C2 EdgeFlag=1：菱形 a-b-c / b-d-c，沿 b-c 对角线', async () => {
    const rendered = await sample();
    const p = page(rendered, 3);
    expect(isClose(pixelAt(p, 90, 21), RED, 70)).toBe(true);
    expect(isClose(pixelAt(p, 72, 33), GREEN, 30)).toBe(true);
    expect(isClose(pixelAt(p, 108, 33), BLUE, 35)).toBe(true);
    expect(isClose(pixelAt(p, 90, 43), YELLOW, 60)).toBe(true);
  });

  it('C3 EdgeFlag=2：平行四边形 a-b-c / a-c-d，沿 a-c 对角线', async () => {
    const rendered = await sample();
    const p = page(rendered, 3);
    expect(isClose(pixelAt(p, 138, 21), RED, 55)).toBe(true);
    expect(isClose(pixelAt(p, 127, 37), GREEN, 35)).toBe(true);
    expect(isClose(pixelAt(p, 150, 37), BLUE, 35)).toBe(true);
    expect(isClose(pixelAt(p, 166, 21), YELLOW, 60)).toBe(true);
  });

  it('C4 EdgeFlag=1 三角形对：沿 b-c 对角线切分（区别于 EdgeFlag=2 的 a-c）', async () => {
    const rendered = await sample();
    // 该格 Boundary (175,14,50,35)；四控制点为局部 (2,2)(2,30)(48,30)(48,2)。
    const p = page(rendered, 3);
    expect(isClose(pixelAt(p, 180, 20), RED, 60)).toBe(true);
    expect(isClose(pixelAt(p, 180, 42), GREEN, 40)).toBe(true);
    // 对角线两侧分属不同三角形，颜色不再是纯 BLUE/CYAN。
    const rightTop = pixelAt(p, 220, 20);
    const rightBottom = pixelAt(p, 220, 42);
    expect(rightTop[0] + rightTop[1] + rightTop[2]).toBeLessThan(740);
    expect(rightBottom[0] + rightBottom[1] + rightBottom[2]).toBeLessThan(740);
    const delta =
      Math.abs(rightTop[0] - rightBottom[0]) +
      Math.abs(rightTop[1] - rightBottom[1]) +
      Math.abs(rightTop[2] - rightBottom[2]);
    expect(delta).toBeGreaterThan(20);
  });

  it('C5 Extend=0：控制点范围外不填充', async () => {
    const rendered = await sample();
    const p = page(rendered, 3);
    // 三角形三顶点 (-8,-6)(58,-6)(25,46) 相对 bd(10,75) → 顶点 (2,69)(68,69)(35,121)
    // 视口外/三角外应为白
    expect(isClose(pixelAt(p, 68.6, 76), WHITE, 10)).toBe(true);
  });

  it('C6 Extend=1 + BackColor：范围外用 BackColor 填充', async () => {
    const rendered = await sample();
    const p = page(rendered, 3);
    const corner = pixelAt(p, 82, 110);
    expect(corner[0]).toBeGreaterThan(100);
    expect(corner[1]).toBeGreaterThan(100);
    expect(corner[2]).toBeGreaterThan(100);
  });

  it('C7 渐变勾边（StrokeColor/GouraudShd）：描边应为渐变而非平均灰', async () => {
    const rendered = await sample();
    expect(
      rendered.warnings.filter((warning) => warning.message.includes('渐变/底纹描边')),
    ).toEqual([]);
  });
});

describe('渐变对照验收 · 第 4 页 网格高洛德 LaGouraudShd（§8.3.4.5 表 32、图 42）', () => {
  it('D1 VerticesPerRow=2：1×1 单元格四角颜色正确', async () => {
    const rendered = await sample();
    const p = page(rendered, 4);
    expect(isClose(pixelAt(p, 14, 18), RED, 40)).toBe(true);
    expect(isClose(pixelAt(p, 56, 18), GREEN, 40)).toBe(true);
    expect(isClose(pixelAt(p, 14, 45), BLUE, 40)).toBe(true);
    expect(isClose(pixelAt(p, 56, 45), YELLOW, 40)).toBe(true);
  });

  it('D2 VerticesPerRow=3：3×3 点阵按行分组（每行 3 点）', async () => {
    const rendered = await sample();
    const p = page(rendered, 4);
    // 第 0 行 (0,0,220)(120,0,130)(240,0,40) → 左端偏蓝、右端偏红
    const left = pixelAt(p, 67, 17);
    const right = pixelAt(p, 113, 17);
    expect(left[2]).toBeGreaterThan(left[0]);
    expect(right[0]).toBeGreaterThan(right[2]);
    // 第 2 行 (20,220,220)(140,220,130)(260,220,40) → 下端绿通道高
    const bottom = pixelAt(p, 90, 47);
    expect(bottom[1]).toBeGreaterThan(150);
  });

  it('D3 VerticesPerRow=4：4×3 混合网格行列分组正确', async () => {
    const rendered = await sample();
    const p = page(rendered, 4);
    // 第 0 行 x=1,27,53,79；四角红/黄/绿/青
    expect(isClose(pixelAt(p, 122, 17), RED, 45)).toBe(true);
    expect(isClose(pixelAt(p, 197, 17), CYAN, 45)).toBe(true);
  });

  it('D4 非规则网格（行错位）：仍按每行 4 点分组', async () => {
    const rendered = await sample();
    const p = page(rendered, 4);
    expect(isClose(pixelAt(p, 207, 18), RED, 45)).toBe(true);
    expect(isClose(pixelAt(p, 280, 20), CYAN, 45)).toBe(true);
  });

  it('D5 Extend=1 + BackColor：网格外区域为 BackColor', async () => {
    const rendered = await sample();
    const p = page(rendered, 4);
    const corner = pixelAt(p, 12, 77);
    expect(isClose(corner, [150, 150, 150], 30)).toBe(true);
  });

  it('D6 渐变勾边（StrokeColor/LaGouraudShd）：描边应为渐变而非平均灰', async () => {
    const rendered = await sample();
    expect(
      rendered.warnings.filter((warning) => warning.message.includes('渐变/底纹描边')),
    ).toEqual([]);
  });

  it('D7 渐变文字填充 + 渐变 Clip：应出现字形，而非整块填满', async () => {
    const rendered = await sample();
    const p = page(rendered, 4);
    // 单元格 bd=(150,75,135,40)；文字若正常绘制，右上角 (280,79) 应为白底
    expect(isClose(pixelAt(p, 280, 79), WHITE, 10)).toBe(true);
  });
});

describe('渐变对照验收 · 第 5 页 颜色段 Position 与 MapUnit（表 29）', () => {
  // 各格 Boundary 均为 (10|125, y, 100, 22)，轴向渐变沿 +X 铺满整格宽度。

  it('E1 两段无 Position → 按 0 / 1.0 处理', async () => {
    const rendered = await sample();
    const p = page(rendered, 5);
    expect(isClose(pixelAt(p, 11, 25), YELLOW, TOL)).toBe(true);
    expect(isClose(pixelAt(p, 109, 25), BLUE, TOL)).toBe(true);
  });

  it('E2 三段无 Position → 按 0 / 0.5 / 1.0 处理', async () => {
    const rendered = await sample();
    const p = page(rendered, 5);
    expect(isClose(pixelAt(p, 11, 61), RED, TOL)).toBe(true);
    // 中间点 x=60 恰为 0.5 位置，应接近第二段绿色
    expect(isClose(pixelAt(p, 60, 61), GREEN, 30)).toBe(true);
    expect(isClose(pixelAt(p, 109, 61), BLUE, TOL)).toBe(true);
  });

  it('E3 五段无 Position → 按 0 / 0.25 / 0.5 / 0.75 / 1.0 处理', async () => {
    const rendered = await sample();
    const p = page(rendered, 5);
    // 轴 0..100 → 0.25/0.5/0.75 对应页面 x = 35/60/85
    expect(isClose(pixelAt(p, 11, 97), RED, TOL)).toBe(true);
    expect(isClose(pixelAt(p, 35, 97), YELLOW, 40)).toBe(true);
    expect(isClose(pixelAt(p, 60, 97), GREEN, 40)).toBe(true);
    expect(isClose(pixelAt(p, 85, 97), CYAN, 40)).toBe(true);
    expect(isClose(pixelAt(p, 109, 97), BLUE, TOL)).toBe(true);
  });

  it('E4 五段部分给出 Position：空缺区间按均分补齐', async () => {
    const rendered = await sample();
    const p = page(rendered, 5);
    expect(isClose(pixelAt(p, 11, 133), RED, TOL)).toBe(true);
    expect(isClose(pixelAt(p, 109, 133), BLUE, TOL)).toBe(true);
  });

  it('E5 MapUnit=20 Repeat：轴线每 20 重复一次首段色', async () => {
    const rendered = await sample();
    const p = page(rendered, 5);
    // 轴 0..100、MapUnit=20 → 首段色出现在页面 x = 125、145、165、185
    expect(isClose(pixelAt(p, 126, 25), RED, TOL)).toBe(true);
    expect(isClose(pixelAt(p, 146, 25), RED, TOL)).toBe(true);
    expect(isClose(pixelAt(p, 166, 25), RED, TOL)).toBe(true);
  });

  it('E6 MapUnit=20 Reflect：相邻区间镜像', async () => {
    const rendered = await sample();
    const p = page(rendered, 5);
    // MapUnit=20：x=125..145 一个区间（红→蓝），145..165 镜像（蓝→红），165..185 再次正折。
    // 实测 x=165 为红、x=185 为蓝，说明镜像后的次序与 Direct 相反但周期一致。
    expect(isClose(pixelAt(p, 165, 61), RED, 40)).toBe(true);
    expect(isClose(pixelAt(p, 185, 61), BLUE, 40)).toBe(true);
  });

  it('E7 轴向渐变不再产生描边/渐变降级 warning', async () => {
    const rendered = await sample();
    expect(
      rendered.warnings.filter((warning) => warning.message.includes('渐变/底纹描边')),
    ).toEqual([]);
  });
});

describe('渐变对照验收 · 第 6 页 渐变配合裁剪区（§8.3.4.1、§8.4）', () => {
  it('F1 两分路径并集：两块区域着色、间隙不着色', async () => {
    const rendered = await sample();
    const p = page(rendered, 6);
    // bd=(10,14,120,60)；Clip1 M4,4..52,56 → 页面 14..62 × 18..70
    // Clip2 M62,10 L116,10 L116,50 L62,50 → 页面 72..126 × 24..64
    expect(isClose(pixelAt(p, 30, 40), CYAN, 70)).toBe(true);
    // 两分区之间的间隙（页面 x≈67）不着色
    expect(isClose(pixelAt(p, 67, 40), WHITE, 12)).toBe(true);
    expect(isClose(pixelAt(p, 100, 40), MAGENTA, 90)).toBe(true);
  });

  it('F2 圆形裁剪区：圆内着色、圆外不着色', async () => {
    const rendered = await sample();
    const p = page(rendered, 6);
    // bd=(10,90,120,60)，圆心 (60,30) 半径 28 → 页面圆心 (70,120)
    const inside = pixelAt(p, 70, 120);
    expect(inside[0] + inside[1] + inside[2]).toBeLessThan(740);
    expect(isClose(pixelAt(p, 16, 95), WHITE, 12)).toBe(true);
  });

  it('F3 径向渐变 + 矩形裁剪：裁剪窗口内着色', async () => {
    const rendered = await sample();
    const p = page(rendered, 6);
    // 圆形起始半径 6mm 内部是空心洞，取洞外的环带采样。
    expect(isClose(pixelAt(p, 190, 120), YELLOW, 40)).toBe(true);
    // 裁剪窗口之外（页面 x<160）不着色
    expect(isClose(pixelAt(p, 148, 94), WHITE, 12)).toBe(true);
  });
});

describe('渐变对照验收 · 第 7 页 渐变用于文字填充与勾边（§8.3.4.1）', () => {
  it('G1 文字填充：轴向渐变的字形着色、背景为白', async () => {
    const rendered = await sample();
    const p = page(rendered, 7);
    // 文字对象 bd 起点 (14,22)、字号 12；字形区域外的格子右上角应为白
    expect(isClose(pixelAt(p, 132, 20), WHITE, 12)).toBe(true);
    // 字形笔画内应着色
    const ink = pixelAt(p, 20, 30);
    expect(ink[0] + ink[1] + ink[2]).toBeLessThan(740);
  });

  it('G2 文字填充：径向渐变的字形着色', async () => {
    const rendered = await sample();
    const p = page(rendered, 7);
    const ink = pixelAt(p, 160, 30);
    expect(ink[0] + ink[1] + ink[2]).toBeLessThan(740);
  });

  it('G3 文字填充：网格高洛德的字形着色', async () => {
    const rendered = await sample();
    const p = page(rendered, 7);
    // 文字对象 bd 起点 (14,78)、字号 12；实测笔画落在 x≈30 附近。
    const ink = pixelAt(p, 30, 86);
    expect(ink[0] + ink[1] + ink[2]).toBeLessThan(740);
  });

  it('G4 文字勾边：StrokeColor 使用渐变而非平均色', async () => {
    const rendered = await sample();
    expect(
      rendered.warnings.filter((warning) => warning.message.includes('渐变/底纹描边')),
    ).toEqual([]);
  });

  it('G5 图形勾边：轴向渐变沿上下边呈现不同颜色', async () => {
    const rendered = await sample();
    const p = page(rendered, 7);
    // bd=(10,126,130,50)，描边矩形 4,4..126,46；上边 y≈130、下边 y≈172
    const topLeft = pixelAt(p, 20, 131);
    const bottomLeft = pixelAt(p, 20, 171);
    const distance =
      Math.abs(topLeft[0] - bottomLeft[0]) +
      Math.abs(topLeft[1] - bottomLeft[1]) +
      Math.abs(topLeft[2] - bottomLeft[2]);
    expect(distance).toBeGreaterThan(30);
  });
});
