/**
 * H5 渲染器内部的径向渐变（OFD `RadialShd`，GB/T 33190—2016 §8.3.4.3 / 表 30）软件光栅化。
 *
 * 表 30 把径向渐变定义为「沿两个中心点连线的投影」上的一维参数：起始椭圆圆心处的
 * 投影为 0、结束椭圆圆心处的投影为 1，投影相同即同一圈，颜色只由该投影决定。
 * 椭圆的长半轴沿中心连线（长度即 `StartRadius`/`EndRadius`），法向半轴按离心率收缩，
 * 两椭圆离心率与倾斜角一致。该几何不是「以两圆心为焦点的放射族」，因此逐点参数
 * 取「该点到起始圆心的距离沿连线方向的投影」，而不是覆盖该点的最小椭圆参数。
 *
 * Canvas 原生 `createRadialGradient` 无法表达离心率与倾斜，这里按像素解析求值写入
 * RGBA8 缓冲，再由 `canvas2d.ts` 以「离屏画布 + clip 路径 + 贴图」方式合成。
 *
 * 架构约束：`renderer/` 不能 import `render/`（见 test/smoke/import-boundaries），
 * 本模块只依赖 `common/`，与 `mesh.ts` 同一范式。
 */

import type { ImageDataLike, Matrix, Point, RadialGradientSpec, Rgba } from '../common/types';
import { invertMatrix, scaleMatrix } from '../common/matrix';

/** 渲染器内部径向渐变光栅化请求。 */
export interface RadialRasterRequest {
  spec: RadialGradientSpec;
  /** 对象空间 → 输出像素空间的矩阵（已包含离屏画布左上角偏移）。 */
  matrix: Matrix;
  /** 输出宽度，像素。 */
  width: number;
  /** 输出高度，像素。 */
  height: number;
  /** 单图元像素上限；超过时整体降采样。 */
  maxPixels?: number;
}

/**
 * 径向渐变的解析几何（对象空间）。
 *
 * 以起始椭圆圆心为原点、中心连线方向为 `u`、法向为 `v` 建立正交基；
 * 点 `(x, y)` 的轴向投影为 `(x−start)·u`，法向投影为 `(x−start)·v`。
 */
export interface RadialGeometry {
  /** 起始椭圆圆心，对象空间单位（通常 mm）。 */
  start: Point;
  /** 结束椭圆圆心，对象空间单位（通常 mm）。 */
  end: Point;
  /** 起始椭圆长半轴，对象空间单位（通常 mm）。 */
  startRadius: number;
  /** 结束椭圆长半轴，对象空间单位（通常 mm）。 */
  endRadius: number;
  /** 短半轴与长半轴之比 `√(1−e²)`，0..1。 */
  axisRatio: number;
  /** 中心连线长度，对象空间单位（通常 mm）。 */
  centerDistance: number;
  /** 中心连线单位向量 X。 */
  ux: number;
  /** 中心连线单位向量 Y。 */
  uy: number;
  /** 法向单位向量 X（`u` 顺时针旋转 90°）。 */
  vx: number;
  /** 法向单位向量 Y。 */
  vy: number;
}

/** 颜色段；`position` 为 0..1 的单调位置。 */
interface ColorStop {
  position: number;
  color: Rgba;
}

/** 默认单图元像素上限：4 MP，与 `mesh.ts`、`fillWithShading` 的约定一致。 */
const DEFAULT_MAX_PIXELS = 4_000_000;

/** 判定几何退化的下限（对象空间长度，通常 mm）。 */
const EPSILON = 1e-9;

/**
 * 计算径向渐变的解析几何。
 *
 * 离心率 clamp 到 `[0, 0.999999]`，避免不合规输入让短半轴退化为 0；
 * 长半轴方向（`u`）恒取中心连线方向，短半轴方向（`v`）为其顺时针 90°，
 * 即椭圆在中心连线的法向上收缩。两中心点重合时没有连线方向，改用 `Angle`
 * 作为 `u`。
 *
 * @param spec 径向渐变描述；坐标与半径单位同对象空间（通常 mm），角度单位度。
 * @returns 解析几何。
 */
export function radialGeometry(spec: RadialGradientSpec): RadialGeometry {
  const dx = spec.end.x - spec.start.x;
  const dy = spec.end.y - spec.start.y;
  const centerDistance = Math.hypot(dx, dy);
  let ux: number;
  let uy: number;
  if (centerDistance > EPSILON) {
    ux = dx / centerDistance;
    uy = dy / centerDistance;
  } else {
    const degrees = Number.isFinite(spec.angle) ? (spec.angle as number) : 0;
    const radians = (degrees * Math.PI) / 180;
    ux = Math.cos(radians);
    uy = Math.sin(radians);
  }
  const eccentricity = Number.isFinite(spec.eccentricity)
    ? Math.max(0, Math.min(0.999999, spec.eccentricity as number))
    : 0;
  return {
    start: { x: spec.start.x, y: spec.start.y },
    end: { x: spec.end.x, y: spec.end.y },
    startRadius: Number.isFinite(spec.startRadius) ? Math.max(0, spec.startRadius) : 0,
    endRadius: Number.isFinite(spec.endRadius) ? Math.max(0, spec.endRadius) : 0,
    axisRatio: Math.sqrt(1 - eccentricity * eccentricity),
    centerDistance,
    ux,
    uy,
    vx: -uy,
    vy: ux,
  };
}

/**
 * 计算某点相对起始椭圆圆心的轴向投影长度。
 *
 * @param geometry 解析几何。
 * @param x 点横坐标，对象空间单位（通常 mm）。
 * @param y 点纵坐标，对象空间单位（通常 mm）。
 * @returns 投影长度，对象空间单位（通常 mm），可为负。
 */
export function radialAxisProjection(geometry: RadialGeometry, x: number, y: number): number {
  return (x - geometry.start.x) * geometry.ux + (y - geometry.start.y) * geometry.uy;
}

/**
 * 把一个渐变区间的长度换算为对象空间长度。
 *
 * 表 30：`MapType=Direct` 时一个区间为中心连线长度；其余情况一个区间为 `MapUnit`，
 * 缺省也为中心连线长度。中心连线退化时依次退回 `StartRadius + EndRadius`、1。
 *
 * @param geometry 解析几何。
 * @param mapType 映射方式。
 * @param mapUnit 一个渐变区间的长度，对象空间单位（通常 mm）。
 * @returns 一个区间的长度，对象空间单位（通常 mm），恒大于 0。
 */
export function radialMapUnitLength(
  geometry: RadialGeometry,
  mapType: RadialGradientSpec['mapType'],
  mapUnit: number | undefined,
): number {
  if (mapType !== 'Direct' && Number.isFinite(mapUnit) && (mapUnit as number) > EPSILON) {
    return mapUnit as number;
  }
  if (geometry.centerDistance > EPSILON) return geometry.centerDistance;
  const fallback = geometry.startRadius + geometry.endRadius;
  return fallback > EPSILON ? fallback : 1;
}

/**
 * 按映射规则把投影长度折叠为一个区间内的参数。
 *
 * - `Direct`：不折叠，返回 `s / L`（可越出 [0,1]，是否绘制由 `Extend` 决定）。
 * - `Repeat`：`s` 对区间长度取模。
 * - `Reflect`：三角波，每两个区间往返一次。
 *
 * @param geometry 解析几何。
 * @param mapType 映射方式。
 * @param mapUnit 一个渐变区间的长度，对象空间单位（通常 mm）。
 * @param s 投影长度，对象空间单位（通常 mm），可为负。
 * @returns 区间内参数，0..1。
 */
export function radialFoldParameter(
  geometry: RadialGeometry,
  mapType: RadialGradientSpec['mapType'],
  mapUnit: number | undefined,
  s: number,
): number {
  const unit = radialMapUnitLength(geometry, mapType, mapUnit);
  if (mapType === 'Direct') return s / unit;
  const quotient = s / unit;
  if (mapType === 'Repeat') return quotient - Math.floor(quotient);
  const wrapped = quotient - 2 * Math.floor(quotient / 2);
  return wrapped <= 1 ? wrapped : 2 - wrapped;
}

/**
 * 计算区间参数 t 处椭圆族的长半轴。
 *
 * 表 30：两椭圆离心率与倾斜角一致，长半轴沿中心连线由 `StartRadius` 线性变化到
 * `EndRadius`，因此 `r(t) = StartRadius + (EndRadius − StartRadius)·t`。
 * `StartRadius > EndRadius` 时同样按该式收缩。
 *
 * @param geometry 解析几何。
 * @param t 区间内参数，0..1（超出范围时按端点取值）。
 * @returns 长半轴，对象空间单位（通常 mm）。
 */
export function radialAxisRadius(geometry: RadialGeometry, t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return geometry.startRadius + (geometry.endRadius - geometry.startRadius) * clamped;
}

/**
 * 求解某点所处的椭圆族参数（表 30）。
 *
 * 椭圆族由参数 `t` 唯一确定（§8.3.4.3）：
 * - 圆心沿中心连线线性插值：`C(t) = StartPoint + (EndPoint − StartPoint)·t`；
 * - 长半轴同步线性插值：`r(t) = StartRadius + (EndRadius − StartRadius)·t`；
 * - 短半轴为 `r(t)·√(1 − e²)`，长短轴方向由中心连线（两圆心重合时由 `Angle`）决定。
 *
 * 参数 `t` 即为「该点落在第几圈的椭圆轮廓上」，因此求解三角方程
 * `|p − C(t)|_ellipse = r(t)`（椭圆度量下到圆心的距离等于该圈长半轴）。
 * 椭圆度量把法向分量按 `1/√(1 − e²)` 拉伸，等价于求直线 `C(t)` 与半径 `r(t)`
 * 同步变化的圆的切线交点，展开后是关于 `t` 的一元二次方程：
 * `(|v|² − dr²)·t² − 2(a·v + r0·dr)·t + (|a|² − r0²) = 0`，
 * 其中 `v = EndPoint − StartPoint`、`a` 为点相对 `StartPoint` 的向量（已折算为椭圆度量）。
 *
 * 两个根分别对应「从外侧收缩到该圈」与「从内侧扩张到该圈」，取使 `r(t) > 0` 的较小根，
 * 即该点在椭圆族中的最内圈参数：`t < 0` 表示位于起始椭圆内部，`t > 1` 表示超出结束椭圆。
 *
 * @param geometry 解析几何。
 * @param x 点横坐标，对象空间单位（通常 mm）。
 * @param y 点纵坐标，对象空间单位（通常 mm）。
 * @returns 椭圆族参数；无实数解（点不在任何一圈的椭圆度量上，例如两半径相等）时返回 `null`。
 */
export function radialEllipseParameter(
  geometry: RadialGeometry,
  x: number,
  y: number,
): number | null {
  const vx = geometry.end.x - geometry.start.x;
  const vy = geometry.end.y - geometry.start.y;
  const centerDistance = Math.hypot(vx, vy);
  const r0 = geometry.startRadius;
  const r1 = geometry.endRadius;
  const dr = r1 - r0;

  // 相对起始圆心的位移，法向分量按离心率折算到椭圆度量。
  const dx = x - geometry.start.x;
  const dy = y - geometry.start.y;
  const along = dx * geometry.ux + dy * geometry.uy;
  const across = (dx * geometry.vx + dy * geometry.vy) / geometry.axisRatio;

  // 圆心沿连线以 |v| 为步长移动，故 |a − v·t|² = (r0 + dr·t)²。
  const a = centerDistance * centerDistance - dr * dr;
  const b = -2 * (along * centerDistance + r0 * dr);
  const c = along * along + across * across - r0 * r0;

  if (Math.abs(a) <= EPSILON) {
    // 退化：圆心不动而半径同步变化，方程降为一次。
    if (Math.abs(b) <= EPSILON) return null;
    const t = -c / b;
    return r0 + dr * t > 0 ? t : null;
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) {
    // 无实根：该点不在椭圆族任何一圈的轮廓上，位于两侧楔形空档之一。
    // 以起始圆心与结束圆心的中点分界，起始侧返回 −1、结束侧返回 2，
    // 由 `resolveParameter` 按 Extend 与半径增减方向处理。
    const before = along * centerDistance <= centerDistance * centerDistance / 2;
    return before ? -1 : 2;
  }
  const sqrt = Math.sqrt(discriminant);
  const roots = [(-b - sqrt) / (2 * a), (-b + sqrt) / (2 * a)];
  // 两个根对应椭圆族在两侧各解出的一圈轮廓，取真正属于 [0,1] 区间内的那一个
  // （该点落在渐变区间内）；都在区间外时取最靠近区间者，供 Extend 判断延伸方向。
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const t of roots) {
    if (!(r0 + dr * t > 0)) continue;
    const distance = t < 0 ? -t : t > 1 ? t - 1 : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = t;
    }
  }
  return best;
}

/**
 * 判断按参数 `t` 取样的点是否应绘制，并给出最终参数。
 *
 * `t` 是该点在椭圆族中「最内覆盖圈」的参数：`t = 0` 为起始椭圆轮廓、
 * `t = 1` 为结束椭圆轮廓。绘制范围按表 30 的 `Extend` 划分：
 * - `Extend = 0`（缺省）：只绘制 `t ∈ [0, 1]` 的椭圆族环带；
 * - `Extend = 1`：向起始侧补绘空心椭圆与起始椭圆之间的方向三角，取起始色；
 * - `Extend = 2`：向结束侧延伸到整个可见范围，取结束色；
 * - `Extend = 3`：两侧都延伸。
 *
 * 无论哪种模式，`StartRadius` 以内的「空心椭圆」都不绘制（表 30 明示为空洞）。
 *
 * 延伸区的参数被夹到 `[0, 1]`，使 `MapType=Direct` 取该侧端点色，
 * 而 `Repeat`/`Reflect` 交由调用方按周期继续取值。
 *
 * @param geometry 解析几何。
 * @param spec 径向渐变描述（提供 Extend）。
 * @param t 椭圆族参数。
 * @returns 绘制用的参数；不应绘制时返回 `null`。
 */
function resolveParameter(
  geometry: RadialGeometry,
  spec: RadialGradientSpec,
  t: number,
): number | null {
  const extend = spec.extend ?? 0;
  const allowBefore = extend === 1 || extend === 3;
  const allowAfter = extend === 2 || extend === 3;
  const span = geometry.endRadius - geometry.startRadius;
  const clamp = (value: number): number => Math.max(0, Math.min(1, value));
  // 起始椭圆内部的空心区域恒不绘制（表 30 明示为空洞）。空心椭圆以内即「该点到
  // 起始圆心的距离小于 StartRadius」，对应参数恒为负，按 −r0/(r1−r0) 折算到 t。
  if (t < 0 && geometry.startRadius > EPSILON) {
    const hollow = Math.abs(span) <= EPSILON ? -1 : -geometry.startRadius / span;
    if (t <= hollow) return null;
  }
  // Extend=2 时，若椭圆族由起始侧向结束侧扩张（EndRadius > StartRadius），
  // 整个填充区都按结束色铺满（表 30「延伸到填充区投影区域为止」）。
  // 椭圆族由大收小（StartRadius > EndRadius）时结束椭圆在最内圈，
  // 外圈不再外扩：`t > 1` 表示该点在结束椭圆以外的空洞侧，不应绘制。
  if (allowAfter && extend === 2 && span > EPSILON) return 1;
  if (t < 0) return allowBefore ? clamp(t) : null;
  if (t > 1) return allowAfter && span > EPSILON ? 1 : null;
  return t;
}

/**
 * 把径向渐变光栅化为 RGBA8。
 *
 * 逐像素处理：像素中心经矩阵逆换回对象空间 → `radialEllipseParameter` 求椭圆族参数 →
 * `resolveParameter` 按表 30 的 `Extend` 决定是否绘制 → 按 MapType 映射后取色。
 *
 * 超出 `maxPixels` 时整体降采样（返回更小的宽高），由调用方按目标尺寸拉伸绘制。
 *
 * @param request 渐变描述、矩阵、输出尺寸与像素上限。
 * @returns RGBA8 像素（straight alpha）；未覆盖处为全透明。
 */
export function rasterizeRadialShadingDevice(request: RadialRasterRequest): ImageDataLike {
  const spec = request.spec;
  const requestedWidth = Math.max(1, Math.floor(request.width));
  const requestedHeight = Math.max(1, Math.floor(request.height));
  const maxPixels = Math.max(1, Math.floor(request.maxPixels ?? DEFAULT_MAX_PIXELS));

  const scale = Math.min(1, Math.sqrt(maxPixels / Math.max(1, requestedWidth * requestedHeight)));
  const width = Math.max(1, Math.floor(requestedWidth * scale));
  const height = Math.max(1, Math.floor(requestedHeight * scale));
  const matrix = scale < 1 ? scaleMatrix(request.matrix, scale, scale) : request.matrix;
  const inverse = invertMatrix(matrix);
  const data = new Uint8ClampedArray(width * height * 4);
  if (!inverse) return { width, height, data };

  const geometry = radialGeometry(spec);
  const stops = spec.segments;
  if (stops.length === 0) return { width, height, data };
  const unit = radialMapUnitLength(geometry, spec.mapType, spec.mapUnit);
  const direct = spec.mapType === 'Direct';
  const span = geometry.endRadius - geometry.startRadius;
  // 起始圆与结束圆重合（两半径相等）：椭圆族退化为单一轮廓，参数恒为 0。
  const degenerate = Math.abs(span) <= EPSILON;
  const startRadius = geometry.startRadius;
  // 延伸区取该侧端点色：表 30 的 Extend 只决定「覆盖到哪里」，不改变端点颜色；
  // 仅在 Repeat/Reflect 时延伸区仍按周期继续取值。
  const firstColor = stops[0]!.color;
  const lastColor = stops[stops.length - 1]!.color;

  for (let y = 0; y < height; y += 1) {
    const sampleY = y + 0.5;
    for (let x = 0; x < width; x += 1) {
      const sampleX = x + 0.5;
      const objectX = inverse[0] * sampleX + inverse[2] * sampleY + inverse[4];
      const objectY = inverse[1] * sampleX + inverse[3] * sampleY + inverse[5];

      let t: number | null;
      if (degenerate) {
        // 单一轮廓：椭圆内（椭圆度量下 < 半径）取起始色，轮廓外按 Extend。
        const dx = objectX - geometry.start.x;
        const dy = objectY - geometry.start.y;
        const along = dx * geometry.ux + dy * geometry.uy;
        const across = (dx * geometry.vx + dy * geometry.vy) / geometry.axisRatio;
        const inside = Math.hypot(along, across) <= startRadius ? 0 : 2;
        t = resolveParameter(geometry, spec, inside);
      } else {
        const raw = radialEllipseParameter(geometry, objectX, objectY);
        t = raw === null ? null : resolveParameter(geometry, spec, raw);
      }
      if (t === null) continue;

      // Direct 直接按椭圆族参数取色；Repeat/Reflect 把参数按 MapUnit 折叠后取色。
      let color: Rgba;
      if (direct) {
        color = t <= 0 ? firstColor : t >= 1 ? lastColor : sampleStops(stops, t);
      } else {
        // MapUnit 以对象空间长度计，故先把参数 t 折算回中心连线长度上的距离，
        // 再按 MapUnit 折叠为一个区间内的相位。
        color = sampleStops(
          stops,
          radialFoldParameter(geometry, spec.mapType, unit, t * geometry.centerDistance),
        );
      }
      const index = (y * width + x) * 4;
      data[index] = color.r;
      data[index + 1] = color.g;
      data[index + 2] = color.b;
      data[index + 3] = color.a;
    }
  }
  return { width, height, data };
}

/**
 * 在 stop 列表中按位置取色（线性插值）。
 *
 * @param stops 已归一化到 [0,1] 且单调不减的 stop。
 * @param t 位置，0..1。
 * @returns 插值颜色。
 */
function sampleStops(stops: readonly ColorStop[], t: number): Rgba {
  const position = Math.max(0, Math.min(1, t));
  let right = 0;
  while (right < stops.length && stops[right]!.position < position) right += 1;
  if (right === 0) return stops[0]!.color;
  if (right >= stops.length) return stops[stops.length - 1]!.color;
  const left = stops[right - 1]!;
  const next = stops[right]!;
  const span = next.position - left.position;
  if (!(span > 0)) return next.color;
  const ratio = (position - left.position) / span;
  return {
    r: left.color.r + (next.color.r - left.color.r) * ratio,
    g: left.color.g + (next.color.g - left.color.g) * ratio,
    b: left.color.b + (next.color.b - left.color.b) * ratio,
    a: left.color.a + (next.color.a - left.color.a) * ratio,
  };
}

/**
 * 把「对象空间 → 页面设备像素」的矩阵换算为「对象空间 → 离屏画布像素」的矩阵。
 *
 * 离屏画布只覆盖对象包围盒对应的设备像素区域，因此矩阵的输出原点要减去该区域左上角
 * 的绝对设备像素 `offsetX/offsetY`。
 *
 * `offsetX/offsetY` 与 CTM 的平移分量都是设备像素，必须直接改写 `e/f`（CTM 之后的
 * 平移），不能经 `translateMatrix` 作用在用户空间，否则会被 CTM 的缩放放大。
 *
 * @param matrix 对象空间 → 页面设备像素的矩阵。
 * @param offsetX 离屏画布左上角的绝对设备像素横坐标。
 * @param offsetY 离屏画布左上角的绝对设备像素纵坐标。
 * @returns 对象空间 → 离屏画布像素的矩阵。
 */
export function offsetRadialMatrix(matrix: Matrix, offsetX: number, offsetY: number): Matrix {
  return [matrix[0], matrix[1], matrix[2], matrix[3], matrix[4] - offsetX, matrix[5] - offsetY];
}

/**
 * 在 `offsetRadialMatrix` 基础上叠加降采样比例。
 *
 * 单图元像素超过上限时缓冲宽高按同一比例缩小，采样点需要把用户空间位置按该比例
 * 映射到缓冲像素，否则拉伸绘制时几何会整体偏移。
 *
 * @param matrix 对象空间 → 页面设备像素的矩阵。
 * @param offsetX 离屏画布左上角的绝对设备像素横坐标。
 * @param offsetY 离屏画布左上角的绝对设备像素纵坐标。
 * @param scale 缓冲尺寸与绘制尺寸之比，0..1。
 * @returns 对象空间 → 离屏画布像素的矩阵。
 */
export function scaleRadialMatrix(
  matrix: Matrix,
  offsetX: number,
  offsetY: number,
  scale: number,
): Matrix {
  return [
    matrix[0] * scale,
    matrix[1] * scale,
    matrix[2] * scale,
    matrix[3] * scale,
    (matrix[4] - offsetX) * scale,
    (matrix[5] - offsetY) * scale,
  ];
}
