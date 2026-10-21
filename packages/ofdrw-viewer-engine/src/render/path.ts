/**
 * 路径解析与绘制。
 *
 * 路径命令全部通过 Renderer 立即路径 API 输出，不依赖 Path2D；
 * Boundary/Clips/CTM 的责任划分见设计方案 10.3、10.4.1。
 */

import type { AxialGradientSpec, Box, PathCommand, Point, ResolvedPaint } from '../common/types';
import type { PathObject } from '../model/types';
import type { ResolvedStyle } from '../style/types';
import type { Renderer } from '../renderer/types';
import type { PaintBinder } from './paint';
import { getAveragePaintColor, getAxialExtendBand } from './paint';
import { normalizeDrawStyle } from './display-list';

/** 单次构建/绘制的最大路径命令数；超过后按子路径边界分块，避免单次路径过大。 */
export const PATH_CHUNK_SIZE = 50_000;

/** 路径绘制上下文。 */
export interface PathDrawContext {
  renderer: Renderer;
  binder: PaintBinder;
  /** warning 回调；坏路径命令使用 `W_BAD_PATH`。 */
  onWarning?: (code: string, message: string, objectId?: string) => void;
  /** 页索引，仅用于 warning。 */
  pageIndex?: number;
}

/** 词法单元：命令、数值或无法解析的字符。 */
type Token =
  | { kind: 'command'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bad'; value: string };

/** 数字匹配（sticky）；支持 `+1`、`-.5`、`1.`、`1e-3` 等写法。 */
const NUMBER_PATTERN = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;

/**
 * 把 AbbreviatedData 切成词法单元。
 *
 * 分隔符为空白/逗号；字母视为命令并统一转大写（操作符大小写不敏感）；
 * 无法识别的字符保留为 `bad`，由解析器跳过并 warning。
 *
 * @param data 路径原文。
 * @returns 词法单元序列。
 */
function tokenize(data: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < data.length) {
    const char = data[index]!;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
      index += 1;
      continue;
    }
    if (/[A-Za-z]/.test(char)) {
      tokens.push({ kind: 'command', value: char.toUpperCase() });
      index += 1;
      continue;
    }
    NUMBER_PATTERN.lastIndex = index;
    const match = NUMBER_PATTERN.exec(data);
    if (match) {
      const value = Number(match[0]);
      if (Number.isFinite(value)) {
        tokens.push({ kind: 'number', value });
      } else {
        tokens.push({ kind: 'bad', value: match[0] });
      }
      index += match[0].length;
      continue;
    }
    tokens.push({ kind: 'bad', value: char });
    index += 1;
  }
  return tokens;
}

/**
 * 解析 OFD AbbreviatedData。
 *
 * 命令集合：`S/M`（moveTo）、`L`、`Q`、`B`、`A`（椭圆弧转三次贝塞尔）、`C`（closePath）。
 * 参数不足时跳过该命令但保留已解析部分；多余参数忽略并 warning；坏字符跳过并 warning。
 *
 * @param data AbbreviatedData 原文。
 * @param onWarning warning 回调；code 固定为 `W_BAD_PATH`。
 * @returns 目标无关路径命令。
 */
export function parseAbbreviatedData(
  data: string,
  onWarning?: (code: string, message: string) => void,
): PathCommand[] {
  const warn = (message: string): void => {
    onWarning?.('W_BAD_PATH', message);
  };
  const tokens = tokenize(data);
  const commands: PathCommand[] = [];
  let index = 0;
  let current: Point = { x: 0, y: 0 };
  let subpathStart: Point = { x: 0, y: 0 };
  let started = false;

  /** 读取 count 个数值；遇到命令或数据结束时返回 null（不消费该命令）。 */
  const readNumbers = (count: number): number[] | null => {
    const values: number[] = [];
    while (values.length < count && index < tokens.length) {
      const token = tokens[index]!;
      if (token.kind === 'number') {
        values.push(token.value);
        index += 1;
      } else if (token.kind === 'bad') {
        warn(`忽略无法解析的路径 token "${token.value}"`);
        index += 1;
      } else {
        break;
      }
    }
    return values.length === count ? values : null;
  };

  /** 忽略当前命令之后、下一个命令之前的数值（OFD 不支持隐式重复）。 */
  const skipExtraNumbers = (command: string): void => {
    while (index < tokens.length && tokens[index]!.kind !== 'command') {
      const token = tokens[index]!;
      warn(`命令 ${command} 的多余参数已忽略`);
      void token;
      index += 1;
    }
  };

  const ensureStarted = (): void => {
    if (started) return;
    warn('路径未以 M/S 开始，已按 (0,0) 隐式起点处理');
    current = { x: 0, y: 0 };
    subpathStart = { ...current };
    commands.push({ type: 'moveTo', x: 0, y: 0 });
    started = true;
  };

  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.kind !== 'command') {
      if (token.kind === 'bad') warn(`忽略无法解析的路径 token "${token.value}"`);
      else warn('路径中的数值缺少前导命令，已忽略');
      index += 1;
      continue;
    }
    const command = token.value;
    index += 1;

    switch (command) {
      case 'S':
      case 'M': {
        const values = readNumbers(2);
        if (!values) {
          warn(`命令 ${command} 参数不足，已跳过`);
          break;
        }
        current = { x: values[0]!, y: values[1]! };
        subpathStart = { ...current };
        started = true;
        commands.push({ type: 'moveTo', x: current.x, y: current.y });
        skipExtraNumbers(command);
        break;
      }
      case 'L': {
        const values = readNumbers(2);
        if (!values) {
          warn('命令 L 参数不足，已跳过');
          break;
        }
        ensureStarted();
        current = { x: values[0]!, y: values[1]! };
        commands.push({ type: 'lineTo', x: current.x, y: current.y });
        skipExtraNumbers(command);
        break;
      }
      case 'Q': {
        const values = readNumbers(4);
        if (!values) {
          warn('命令 Q 参数不足，已跳过');
          break;
        }
        ensureStarted();
        commands.push({
          type: 'quadraticCurveTo',
          cpx: values[0]!,
          cpy: values[1]!,
          x: values[2]!,
          y: values[3]!,
        });
        current = { x: values[2]!, y: values[3]! };
        skipExtraNumbers(command);
        break;
      }
      case 'B': {
        const values = readNumbers(6);
        if (!values) {
          warn('命令 B 参数不足，已跳过');
          break;
        }
        ensureStarted();
        commands.push({
          type: 'bezierCurveTo',
          cp1x: values[0]!,
          cp1y: values[1]!,
          cp2x: values[2]!,
          cp2y: values[3]!,
          x: values[4]!,
          y: values[5]!,
        });
        current = { x: values[4]!, y: values[5]! };
        skipExtraNumbers(command);
        break;
      }
      case 'A': {
        const values = readNumbers(7);
        if (!values) {
          warn('命令 A 参数不足，已跳过');
          break;
        }
        ensureStarted();
        const end: Point = { x: values[5]!, y: values[6]! };
        appendArc(
          commands,
          current,
          values[0]!,
          values[1]!,
          values[2]!,
          values[3] !== 0,
          values[4] !== 0,
          end,
        );
        current = end;
        skipExtraNumbers(command);
        break;
      }
      case 'C': {
        if (!started) {
          warn('命令 C 没有可闭合的子路径，已忽略');
          break;
        }
        commands.push({ type: 'closePath' });
        current = { ...subpathStart };
        break;
      }
      default:
        warn(`未知路径命令 ${command}，已跳过`);
        break;
    }
  }
  return commands;
}

/**
 * 把椭圆弧（SVG 端点参数化）追加为若干三次贝塞尔段。
 *
 * 退化情形按设计方案 11.1 处理：`rx/ry` 为 0 或起终点重合时退化为直线。
 * 每段不超过 90°，使用标准的三次贝塞尔近似系数 `4/3·tan(Δθ/4)`。
 *
 * @param commands 输出命令数组。
 * @param start 当前点。
 * @param rx X 半径，对象空间单位。
 * @param ry Y 半径，对象空间单位。
 * @param angleDeg 椭圆旋转角，单位度，正值顺时针。
 * @param largeArc 是否取大弧。
 * @param sweep 是否顺时针扫掠。
 * @param end 终点，对象空间单位。
 */
function appendArc(
  commands: PathCommand[],
  start: Point,
  rx: number,
  ry: number,
  angleDeg: number,
  largeArc: boolean,
  sweep: boolean,
  end: Point,
): void {
  const { x: x1, y: y1 } = start;
  const { x: x2, y: y2 } = end;
  let radiusX = Math.abs(rx);
  let radiusY = Math.abs(ry);
  // 半径为零、起终点重合 → 直线（表 42 异常处理）。
  if (radiusX === 0 || radiusY === 0 || (x1 === x2 && y1 === y2)) {
    commands.push({ type: 'lineTo', x: x2, y: y2 });
    return;
  }

  const phi = (((angleDeg % 360) + 360) % 360) * (Math.PI / 180);
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  // 端点差转到未旋转的椭圆坐标系。
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  // 半径不足以容纳两端点时按比例放大。
  const lambda = (x1p * x1p) / (radiusX * radiusX) + (y1p * y1p) / (radiusY * radiusY);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    radiusX *= scale;
    radiusY *= scale;
  }

  // 求旋转坐标系下的椭圆中心。
  const denominator =
    radiusX * radiusX * y1p * y1p + radiusY * radiusY * x1p * x1p;
  const numerator =
    radiusX * radiusX * radiusY * radiusY -
    radiusX * radiusX * y1p * y1p -
    radiusY * radiusY * x1p * x1p;
  let coefficient = denominator > 0 ? Math.sqrt(Math.max(0, numerator / denominator)) : 0;
  if (largeArc === sweep) coefficient = -coefficient;
  const cxp = (coefficient * radiusX * y1p) / radiusY;
  const cyp = (-coefficient * radiusY * x1p) / radiusX;
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  const ux = (x1p - cxp) / radiusX;
  const uy = (y1p - cyp) / radiusY;
  const vx = (-x1p - cxp) / radiusX;
  const vy = (-y1p - cyp) / radiusY;
  const vectorAngle = (ax: number, ay: number, bx: number, by: number): number => {
    const dot = ax * bx + ay * by;
    const length = Math.sqrt((ax * ax + ay * ay) * (bx * bx + by * by));
    if (length === 0) return 0;
    const value = Math.max(-1, Math.min(1, dot / length));
    const signed = ax * by - ay * bx < 0 ? -Math.acos(value) : Math.acos(value);
    return signed;
  };
  const theta1 = vectorAngle(1, 0, ux, uy);
  let deltaTheta = vectorAngle(ux, uy, vx, vy);
  if (!sweep && deltaTheta > 0) deltaTheta -= Math.PI * 2;
  else if (sweep && deltaTheta < 0) deltaTheta += Math.PI * 2;
  if (!Number.isFinite(deltaTheta) || deltaTheta === 0) {
    commands.push({ type: 'lineTo', x: x2, y: y2 });
    return;
  }

  const segments = Math.max(1, Math.ceil(Math.abs(deltaTheta) / (Math.PI / 2)));
  const delta = deltaTheta / segments;
  const handle = (4 / 3) * Math.tan(delta / 4);

  const pointAt = (theta: number): Point => {
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const ex = radiusX * cos;
    const ey = radiusY * sin;
    return {
      x: cx + cosPhi * ex - sinPhi * ey,
      y: cy + sinPhi * ex + cosPhi * ey,
    };
  };
  const derivativeAt = (theta: number): Point => {
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const ex = -radiusX * sin;
    const ey = radiusY * cos;
    return {
      x: cosPhi * ex - sinPhi * ey,
      y: sinPhi * ex + cosPhi * ey,
    };
  };

  let theta = theta1;
  for (let segment = 0; segment < segments; segment += 1) {
    const nextTheta = theta + delta;
    const from = pointAt(theta);
    const to = pointAt(nextTheta);
    const fromDerivative = derivativeAt(theta);
    const toDerivative = derivativeAt(nextTheta);
    // 最后一段吸附到精确终点，避免三角计算误差让折线闭合处出现缝隙。
    const isLast = segment === segments - 1;
    const endX = isLast ? x2 : to.x;
    const endY = isLast ? y2 : to.y;
    commands.push({
      type: 'bezierCurveTo',
      cp1x: from.x + handle * fromDerivative.x,
      cp1y: from.y + handle * fromDerivative.y,
      cp2x: endX - handle * toDerivative.x,
      cp2y: endY - handle * toDerivative.y,
      x: endX,
      y: endY,
    });
    theta = nextTheta;
  }
}

/**
 * 把路径命令输出到渲染器。
 *
 * 调用方负责在调用前 `beginPath()`；本函数不重置路径，便于把多段几何合并到同一路径。
 *
 * @param renderer 目标渲染器。
 * @param commands 路径命令。
 */
export function emitPathCommands(renderer: Renderer, commands: readonly PathCommand[]): void {
  for (const command of commands) {
    switch (command.type) {
      case 'moveTo':
        renderer.moveTo(command.x, command.y);
        break;
      case 'lineTo':
        renderer.lineTo(command.x, command.y);
        break;
      case 'quadraticCurveTo':
        renderer.quadraticCurveTo(command.cpx, command.cpy, command.x, command.y);
        break;
      case 'bezierCurveTo':
        renderer.cubicCurveTo(
          command.cp1x,
          command.cp1y,
          command.cp2x,
          command.cp2y,
          command.x,
          command.y,
        );
        break;
      case 'closePath':
        renderer.closePath();
        break;
      default: {
        const exhaustive: never = command;
        void exhaustive;
      }
    }
  }
}

/**
 * 计算路径命令的轴对齐包围盒。
 *
 * 控制点也计入范围，得到的是保守包围盒（贝塞尔曲线不会超出控制点凸包）。
 *
 * @param commands 路径命令。
 * @returns 包围盒，单位与命令坐标一致（通常 mm）；空路径返回零矩形。
 */
export function getPathBounds(commands: readonly PathCommand[]): Box {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const include = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const command of commands) {
    switch (command.type) {
      case 'moveTo':
      case 'lineTo':
        include(command.x, command.y);
        break;
      case 'quadraticCurveTo':
        include(command.cpx, command.cpy);
        include(command.x, command.y);
        break;
      case 'bezierCurveTo':
        include(command.cp1x, command.cp1y);
        include(command.cp2x, command.cp2y);
        include(command.x, command.y);
        break;
      case 'closePath':
        break;
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** 已解析路径命令缓存；模型对象不可变，同一个 PathObject 只解析一次。 */
const PATH_COMMAND_CACHE = new WeakMap<PathObject, readonly PathCommand[]>();

/**
 * 取 PathObject 的解析结果（带缓存）。
 *
 * @param object 路径对象。
 * @param onWarning warning 回调。
 * @returns 路径命令。
 */
function getPathCommands(
  object: PathObject,
  onWarning?: (code: string, message: string, objectId?: string) => void,
): readonly PathCommand[] {
  const cached = PATH_COMMAND_CACHE.get(object);
  if (cached) return cached;
  const commands = parseAbbreviatedData(object.data, (code, message) =>
    onWarning?.(code, message, object.id),
  );
  PATH_COMMAND_CACHE.set(object, commands);
  return commands;
}

/**
 * 判断 Paint 是否有可见像素；纯透明色/空底纹按“不画”处理。
 *
 * @param paint 已绑定 Paint。
 * @returns 是否可能产生可见输出。
 */
function isVisiblePaint(paint: ResolvedPaint): boolean {
  switch (paint.kind) {
    case 'color':
      return paint.rgba.a > 0;
    case 'gradient':
      return paint.spec.segments.some((stop) => stop.color.a > 0);
    case 'pattern':
      return paint.tile.commands.length > 0;
    case 'shading':
      return paint.spec.points.length > 0;
  }
}

/**
 * 判断已绑定 Paint 是否为需要按 Extend 裁剪 band 的轴向渐变。
 *
 * @param paint 已绑定 Paint。
 * @returns 轴向渐变描述或 null。
 */
function getAxialPaint(paint: ResolvedPaint | undefined): AxialGradientSpec | null {
  if (!paint || paint.kind !== 'gradient') return null;
  return paint.spec.kind === 'axial' ? paint.spec : null;
}

/**
 * 拆分为不超过 chunkSize 的若干段，拆分点优先选在 moveTo（子路径起点）。
 *
 * @param commands 路径命令。
 * @param chunkSize 单段最大命令数。
 * @returns 路径命令分段。
 */
function splitPathCommands(
  commands: readonly PathCommand[],
  chunkSize: number,
): readonly (readonly PathCommand[])[] {
  if (commands.length <= chunkSize) return [commands];
  const chunks: PathCommand[][] = [];
  let chunk: PathCommand[] = [];
  let lastX = 0;
  let lastY = 0;
  const flush = (): void => {
    if (chunk.length > 0) chunks.push(chunk);
    chunk = [];
  };
  for (const command of commands) {
    if (command.type === 'moveTo') {
      if (chunk.length >= chunkSize) flush();
      chunk.push(command);
      lastX = command.x;
      lastY = command.y;
      continue;
    }
    if (chunk.length >= chunkSize) {
      // 在子路径中间切开时补一个 moveTo，避免新块从 (0,0) 拉出错误连线。
      flush();
      chunk.push({ type: 'moveTo', x: lastX, y: lastY });
    }
    chunk.push(command);
    switch (command.type) {
      case 'lineTo':
        lastX = command.x;
        lastY = command.y;
        break;
      case 'quadraticCurveTo':
        lastX = command.x;
        lastY = command.y;
        break;
      case 'bezierCurveTo':
        lastX = command.x;
        lastY = command.y;
        break;
      case 'closePath':
        break;
    }
  }
  flush();
  return chunks;
}

/**
 * 绘制路径对象（填充/描边/规则）。
 *
 * 调用方负责 Boundary 平移、Clips 与对象 CTM；本函数只处理路径数据与最终样式。
 * 轴向渐变的 Extend band 裁剪在这里用路径包围盒构造裁剪区，保证 `Extend=0/1/2`
 * 不会把不该延伸的一侧也填上。
 *
 * @param context 渲染器与 PaintBinder。
 * @param object 路径对象。
 * @param style 已结算样式。
 */
export function drawPathObject(
  context: PathDrawContext,
  object: PathObject,
  style: ResolvedStyle,
): void {
  const commands = getPathCommands(object, context.onWarning);
  if (commands.length === 0) return;
  const bounds = getPathBounds(commands);
  const drawStyle = normalizeDrawStyle(style);

  const fillPaint =
    style.fill && style.fillPaint
      ? context.binder.bind(style.fillPaint, bounds)
      : undefined;
  let strokePaint =
    style.stroke && style.strokePaint ? context.binder.bind(style.strokePaint, bounds) : undefined;
  if (strokePaint && (strokePaint.kind === 'gradient' || strokePaint.kind === 'pattern')) {
    // v1 不支持渐变/底纹描边（需要描边掩码）；按设计方案 13.6 用平均色近似。
    context.onWarning?.(
      'W_UNSUPPORTED_PAINT',
      '渐变/底纹描边 v1 不支持，已降级为平均色',
      object.id,
    );
    strokePaint = { kind: 'color', rgba: getAveragePaintColor(strokePaint) };
  }
  const visibleFill = fillPaint && isVisiblePaint(fillPaint) ? fillPaint : undefined;
  const visibleStroke = strokePaint && isVisiblePaint(strokePaint) ? strokePaint : undefined;
  if (style.fill && !visibleFill) {
    // 透明/无法绑定的填充按设计“缺失 FillColor = 不画”处理，不报错。
  }
  if (style.stroke && !visibleStroke) {
    context.onWarning?.('W_UNSUPPORTED_PAINT', '描边 Paint 不可用，已跳过描边', object.id);
  }

  const axial = getAxialPaint(visibleFill);
  const band = axial ? getAxialExtendBand(axial, bounds) : null;

  if (band) {
    context.renderer.save();
    context.renderer.beginPath();
    emitPathCommands(context.renderer, polygonToCommands(band));
    context.renderer.clip('nonzero');
  }

  const chunks = splitPathCommands(commands, PATH_CHUNK_SIZE);
  if (chunks.length > 1) {
    context.onWarning?.(
      'W_BAD_PATH',
      `路径命令数 ${commands.length} 超过 ${PATH_CHUNK_SIZE}，已分块绘制`,
      object.id,
    );
  }
  for (const chunk of chunks) {
    context.renderer.beginPath();
    emitPathCommands(context.renderer, chunk);
    if (visibleFill) {
      context.renderer.fill(drawStyle, visibleFill, style.fillRule);
    }
    if (visibleStroke) {
      context.renderer.stroke(drawStyle, visibleStroke);
    }
  }

  if (band) context.renderer.restore();
}

/**
 * 把多边形顶点转为闭合路径命令。
 *
 * @param points 顶点序列；至少 3 个点。
 * @returns moveTo/lineTo/closePath 命令。
 */
function polygonToCommands(points: readonly Point[]): PathCommand[] {
  const commands: PathCommand[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    if (index === 0) commands.push({ type: 'moveTo', x: point.x, y: point.y });
    else commands.push({ type: 'lineTo', x: point.x, y: point.y });
  }
  commands.push({ type: 'closePath' });
  return commands;
}