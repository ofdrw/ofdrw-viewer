/**
 * H5 Canvas2D 默认渲染器与内部 CanvasFactory。
 *
 * 设计要点：
 * - 不直接依赖 DOM：临时画布通过宿主注入的 `createCanvas` 或浏览器默认工厂获取；
 *   默认工厂只在 `globalThis.document` 存在时启用，Worker 可回退 `OffscreenCanvas`。
 * - 不在本层绘制文字；文字由上层转成字形路径。
 * - 不向 engine 暴露 scratch/pattern/tile surface；所有临时画布由本类内部创建与销毁。
 * - engine/绘制管线只能通过 `Renderer` 方法改变画布状态；本类自维护
 *   CTM/alpha/composite/clip 栈，用于 group AABB、底纹像素密度与 shading 光栅化。
 */

import { OFDError } from '../errors';
import {
  IDENTITY_MATRIX,
  invertMatrix,
  multiplyMatrix,
  normalizeBox,
  scaleMatrix,
  translateMatrix,
  transformPoint,
} from '../common/matrix';
import type {
  AxialGradientSpec,
  Box,
  CanvasImageSourceLike,
  DecodedImage,
  DrawStyle,
  FillRule,
  GradientSpec,
  ImageDataLike,
  ImageHandle,
  Matrix,
  MeshShadingSpec,
  PatternPaint,
  RadialGradientSpec,
  ResolvedPaint,
  Rgba,
  Viewport,
} from '../common/types';
import type { DisplayList } from '../common/display-list';
import type {
  Canvas2DLike,
  CanvasFactory,
  CanvasFactoryEntry,
  CanvasRenderingContext2DLike,
  CompositeMode,
  GroupOptions,
  H5Canvas2DRendererOptions,
  Renderer,
} from './types';
import { rasterizeMeshShadingDevice } from './mesh';
import { offsetRadialMatrix, rasterizeRadialShadingDevice, scaleRadialMatrix } from './radial';

/** 当前绘制状态。 */
interface DrawState {
  /** 当前用户空间 → 设备像素的矩阵。 */
  ctm: Matrix;
  /** 当前累积透明度，0..1。 */
  alpha: number;
  /** 当前合成模式。 */
  composite: CompositeMode;
  /** 已应用的裁剪层数；仅用于状态完整性诊断。 */
  clipDepth: number;
}

/** 路径命令（比公共 `PathCommand` 多一个 `rect`）。 */
type PathOp =
  | { type: 'moveTo'; x: number; y: number }
  | { type: 'lineTo'; x: number; y: number }
  | { type: 'quadraticCurveTo'; cpx: number; cpy: number; x: number; y: number }
  | {
      type: 'cubicCurveTo';
      cp1x: number;
      cp1y: number;
      cp2x: number;
      cp2y: number;
      x: number;
      y: number;
    }
  | { type: 'rect'; x: number; y: number; w: number; h: number }
  | { type: 'closePath' };

/** group 合成帧；嵌套时逐层压栈。 */
interface GroupFrame {
  entry: CanvasFactoryEntry;
  parentContext: CanvasRenderingContext2DLike;
  /** 进入 group 前的状态快照。 */
  parentState: DrawState;
  /** 进入 group 前状态栈深度；endGroup 时丢弃 group 内未配对的 save。 */
  parentStateDepth: number;
  /** scratch 左上角在父目标中的设备像素偏移。 */
  offsetX: number;
  offsetY: number;
  /** 组透明度，0..1；在 endGroup 时整体应用一次。 */
  alpha: number;
  /** 组合成模式。 */
  composite: CompositeMode;
  /** 是否隔离合成；当前实现始终使用独立 scratch。 */
  isolated: boolean;
}

/** 本渲染器创建的图像句柄；带内部可绘制源。 */
class H5ImageHandle implements ImageHandle {
  /**
   * @param width 图像宽，像素。
   * @param height 图像高，像素。
   * @param source 平台可绘制源。
   * @param scratch 若由 RGBA 像素创建，对应的内部画布条目。
   */
  constructor(
    readonly width: number,
    readonly height: number,
    readonly source: CanvasImageSourceLike,
    readonly scratch: CanvasFactoryEntry | null,
  ) {}
}

/** 路径记录器；用于求 bbox 与在 band clip 后重放当前路径。 */
class PathRecorder {
  /** 当前路径命令。 */
  ops: PathOp[] = [];
  /** 路径在用户空间的保守边界（曲线包含控制点）。 */
  bounds: Box | null = null;

  /** 开始一条新路径。 */
  begin(): void {
    this.ops = [];
    this.bounds = null;
  }

  /**
   * 扩展路径边界。
   *
   * @param x 点的 X 坐标，当前用户空间。
   * @param y 点的 Y 坐标，当前用户空间。
   */
  private extend(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!this.bounds) {
      this.bounds = { x, y, w: 0, h: 0 };
      return;
    }
    const right = Math.max(this.bounds.x + this.bounds.w, x);
    const bottom = Math.max(this.bounds.y + this.bounds.h, y);
    this.bounds.x = Math.min(this.bounds.x, x);
    this.bounds.y = Math.min(this.bounds.y, y);
    this.bounds.w = right - this.bounds.x;
    this.bounds.h = bottom - this.bounds.y;
  }

  /**
   * 记录 `moveTo`。
   *
   * @param x X 坐标，当前用户空间。
   * @param y Y 坐标，当前用户空间。
   */
  moveTo(x: number, y: number): void {
    this.ops.push({ type: 'moveTo', x, y });
    this.extend(x, y);
  }

  /**
   * 记录 `lineTo`。
   *
   * @param x X 坐标，当前用户空间。
   * @param y Y 坐标，当前用户空间。
   */
  lineTo(x: number, y: number): void {
    this.ops.push({ type: 'lineTo', x, y });
    this.extend(x, y);
  }

  /**
   * 记录二次曲线。
   *
   * @param cpx 控制点 X 坐标。
   * @param cpy 控制点 Y 坐标。
   * @param x 终点 X 坐标。
   * @param y 终点 Y 坐标。
   */
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.ops.push({ type: 'quadraticCurveTo', cpx, cpy, x, y });
    this.extend(cpx, cpy);
    this.extend(x, y);
  }

  /**
   * 记录三次曲线。
   *
   * @param cp1x 控制点 1 X 坐标。
   * @param cp1y 控制点 1 Y 坐标。
   * @param cp2x 控制点 2 X 坐标。
   * @param cp2y 控制点 2 Y 坐标。
   * @param x 终点 X 坐标。
   * @param y 终点 Y 坐标。
   */
  cubicCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): void {
    this.ops.push({ type: 'cubicCurveTo', cp1x, cp1y, cp2x, cp2y, x, y });
    this.extend(cp1x, cp1y);
    this.extend(cp2x, cp2y);
    this.extend(x, y);
  }

  /**
   * 记录矩形。
   *
   * @param x 左上角 X 坐标。
   * @param y 左上角 Y 坐标。
   * @param w 宽，当前用户空间单位。
   * @param h 高，当前用户空间单位。
   */
  rect(x: number, y: number, w: number, h: number): void {
    this.ops.push({ type: 'rect', x, y, w, h });
    this.extend(x, y);
    this.extend(x + w, y + h);
  }

  /** 记录闭合路径。 */
  closePath(): void {
    this.ops.push({ type: 'closePath' });
  }

  /**
   * 把记录的命令重放到上下文。
   *
   * @param context 目标上下文；重放前会调用 `beginPath`。
   */
  replay(context: CanvasRenderingContext2DLike): void {
    context.beginPath();
    for (const op of this.ops) {
      switch (op.type) {
        case 'moveTo':
          context.moveTo(op.x, op.y);
          break;
        case 'lineTo':
          context.lineTo(op.x, op.y);
          break;
        case 'quadraticCurveTo':
          context.quadraticCurveTo(op.cpx, op.cpy, op.x, op.y);
          break;
        case 'cubicCurveTo':
          context.bezierCurveTo(op.cp1x, op.cp1y, op.cp2x, op.cp2y, op.x, op.y);
          break;
        case 'rect':
          context.rect(op.x, op.y, op.w, op.h);
          break;
        case 'closePath':
          context.closePath();
          break;
      }
    }
  }
}

/**
 * 默认临时画布工厂。
 *
 * 仅供 H5Canvas2DRenderer 与仓内测试使用；不从包根导出，engine 不能创建/持有 surface。
 */
export class H5CanvasFactory implements CanvasFactory {
  /**
   * @param options 宿主 createCanvas 与 HWA 选项。
   */
  constructor(private readonly options: H5Canvas2DRendererOptions) {}

  /** @inheritdoc */
  create(width: number, height: number): CanvasFactoryEntry {
    const pixelWidth = Math.max(1, Math.ceil(width));
    const pixelHeight = Math.max(1, Math.ceil(height));
    let canvas: Canvas2DLike;

    if (this.options.createCanvas) {
      canvas = this.options.createCanvas(pixelWidth, pixelHeight);
      // 宿主的 createCanvas 可能忽略尺寸，这里统一设置。
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    } else {
      const documentLike = (
        globalThis as {
          document?: { createElement(tag: string): Canvas2DLike };
        }
      ).document;
      if (documentLike && typeof documentLike.createElement === 'function') {
        canvas = documentLike.createElement('canvas');
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      } else {
        const offscreen = (
          globalThis as {
            OffscreenCanvas?: new (width: number, height: number) => Canvas2DLike;
          }
        ).OffscreenCanvas;
        if (typeof offscreen === 'function') {
          canvas = new offscreen(pixelWidth, pixelHeight);
        } else {
          throw new OFDError(
            'OFD_RENDERER_UNSUPPORTED',
            'H5Canvas2DRenderer 需要临时画布：请通过 createCanvas 注入，或运行在支持 document/OffscreenCanvas 的环境',
          );
        }
      }
    }

    const context = canvas.getContext('2d', {
      alpha: true,
      willReadFrequently: !this.options.enableHWA,
    });
    if (!context) {
      throw new OFDError('OFD_RENDERER_UNSUPPORTED', '无法获取临时画布的 2D 上下文');
    }
    return { canvas, context };
  }

  /** @inheritdoc */
  reset(entry: CanvasFactoryEntry, width: number, height: number): void {
    entry.canvas.width = Math.max(1, Math.ceil(width));
    entry.canvas.height = Math.max(1, Math.ceil(height));
    entry.context.setTransform(1, 0, 0, 1, 0, 0);
    entry.context.globalAlpha = 1;
    entry.context.globalCompositeOperation = 'source-over';
    entry.context.setLineDash([]);
  }

  /** @inheritdoc */
  destroy(entry: CanvasFactoryEntry): void {
    entry.canvas.width = 0;
    entry.canvas.height = 0;
  }
}

/** 透明色。 */
const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

/** 单次填充最多平铺的 tile 数。 */
const MAX_PATTERN_TILES = 10_000;

/** 嵌套 pattern tile 的最大递归深度。 */
const MAX_PATTERN_DEPTH = 8;

/** 单个 tile 画布的像素上限。 */
const MAX_TILE_PIXELS = 8_000_000;

/** 径向渐变单图元像素上限；与 Gouraud 光栅化及 `mesh.ts` 保持一致。 */
const RADIAL_MAX_PIXELS = 4_000_000;

/** 描边掩码离屏画布的边长像素上限；超出时按该边长裁剪，避免细长路径撑爆内存。 */
const STROKE_MASK_MAX_PIXELS = 4_000_000;

/** 默认 H5 Canvas2D 渲染器；内部管理 scratch/pattern/group 画布。 */
export class H5Canvas2DRenderer implements Renderer {
  private readonly options: H5Canvas2DRendererOptions;
  private factory: CanvasFactory | null = null;
  private mainContext: CanvasRenderingContext2DLike | null = null;
  private viewport: Viewport | null = null;
  private states: DrawState[] = [];
  private groups: GroupFrame[] = [];
  private readonly path = new PathRecorder();
  private readonly images = new Set<H5ImageHandle>();
  private readonly warnedCodes = new Set<string>();
  /** `CanvasPattern.setTransform` 是否真正生效；null 表示尚未探测。 */
  private patternTransformSupport: boolean | null = null;
  private pageActive = false;
  private closed = false;

  /**
   * 可选 warning 回调；不属于 Renderer 契约，供 engine/宿主接收渲染器内部降级
   * （`W_GOURAUD_APPROX`、`W_PATTERN_LIMIT`）。
   */
  onWarning?: (code: string, message: string) => void;

  /**
   * 自持画布工厂；仅 `beginPageFresh` 使用，页面渲染仍走 `canvasFactory`（宿主画布工厂）。
   * 宿主可注入尺寸相同的画布工厂，用于引擎内部重采样这类需要读回像素的临时绘制。
   */
  private surfaceFactory: CanvasFactory | null;

  /**
   * @param options 宿主 createCanvas 与 HWA 选项；Node/小程序必须传 createCanvas。
   * @param surfaceFactory 可选的临时画布工厂，仅用于 `beginPageFresh`。
   */
  constructor(options: H5Canvas2DRendererOptions = {}, surfaceFactory?: CanvasFactory) {
    this.options = options;
    this.surfaceFactory = surfaceFactory ?? null;
  }

  /** 当前合成模式；供内部/测试断言使用。 */
  get compositeMode(): CompositeMode {
    const group = this.groups[this.groups.length - 1];
    if (group) return group.composite;
    return this.states[this.states.length - 1]?.composite ?? 'source-over';
  }

  /** 当前目标上下文：group 内为 scratch，否则为主画布。 */
  private get context(): CanvasRenderingContext2DLike {
    const group = this.groups[this.groups.length - 1];
    if (group) return group.entry.context;
    if (this.mainContext) return this.mainContext;
    throw new OFDError('OFD_RENDERER_UNSUPPORTED', '渲染器尚未 beginPage');
  }

  /** 当前绘制状态。 */
  private get state(): DrawState {
    const state = this.states[this.states.length - 1];
    if (!state) throw new OFDError('OFD_RENDERER_UNSUPPORTED', '渲染器尚未 beginPage');
    return state;
  }

  /** 当前目标允许 restore 到的最小状态栈深度。 */
  private get minimumStateDepth(): number {
    const group = this.groups[this.groups.length - 1];
    return group ? group.parentStateDepth + 1 : 1;
  }

  /** 懒创建的临时画布工厂。 */
  private get canvasFactory(): CanvasFactory {
    if (!this.factory) this.factory = new H5CanvasFactory(this.options);
    return this.factory;
  }

  /**
   * 上报一次 warning（同一 code 只报一次，避免逐对象刷屏）。
   *
   * @param code 警告码。
   * @param message 说明。
   */
  private warnOnce(code: string, message: string): void {
    if (this.warnedCodes.has(code)) return;
    this.warnedCodes.add(code);
    this.onWarning?.(code, message);
  }

  /**
   * 探测当前 Canvas 实现的 `CanvasPattern.setTransform` 是否真正改变图案相位。
   *
   * 某些实现（例如 @napi-rs/canvas）接受调用但不生效；若不探测会导致 Pattern.CTM
   * 在 Node 黄金图中错位。探测只执行一次，失败时调用方改用手动平铺。
   *
   * @returns 支持且生效时返回 true。
   */
  private supportsPatternTransform(): boolean {
    if (this.patternTransformSupport !== null) return this.patternTransformSupport;

    let tileEntry: CanvasFactoryEntry | null = null;
    let probeEntry: CanvasFactoryEntry | null = null;
    let supported = false;
    try {
      tileEntry = this.canvasFactory.create(1, 1);
      const tileContext = tileEntry.context;
      tileContext.setTransform(1, 0, 0, 1, 0, 0);
      tileContext.fillStyle = rgbaToCss({ r: 255, g: 0, b: 0, a: 255 });
      tileContext.fillRect(0, 0, 1, 1);

      probeEntry = this.canvasFactory.create(2, 2);
      const probeContext = probeEntry.context;
      probeContext.setTransform(1, 0, 0, 1, 0, 0);
      const pattern = probeContext.createPattern(tileEntry.canvas, 'repeat');
      if (pattern && applyPatternTransform(pattern, [1, 0, 0, 1, 1, 0])) {
        probeContext.fillStyle = pattern;
        probeContext.fillRect(0, 0, 2, 2);
        const reader = probeContext as CanvasRenderingContext2DLike & {
          getImageData?(x: number, y: number, w: number, h: number): ImageDataLike;
        };
        if (typeof reader.getImageData === 'function') {
          const data = reader.getImageData(0, 0, 2, 2).data;
          supported = data[3] === 0 && (data[7] ?? 0) > 0;
        }
      }
    } catch {
      supported = false;
    } finally {
      if (tileEntry) this.canvasFactory.destroy(tileEntry);
      if (probeEntry) this.canvasFactory.destroy(probeEntry);
    }

    this.patternTransformSupport = supported;
    return supported;
  }

  /**
   * 确认渲染器处于可绘制状态。
   *
   * @throws OFDError `OFD_CLOSED` 或 `OFD_RENDERER_UNSUPPORTED`。
   */
  private ensurePage(): void {
    if (this.closed) throw new OFDError('OFD_CLOSED', '渲染器已关闭');
    if (!this.mainContext) {
      throw new OFDError('OFD_RENDERER_UNSUPPORTED', '渲染器尚未 beginPage');
    }
  }

  /** @inheritdoc */
  beginPage(context: CanvasRenderingContext2DLike, viewport: Viewport): void {
    if (this.closed) throw new OFDError('OFD_CLOSED', '渲染器已关闭');
    if (this.pageActive) this.endPage();

    this.mainContext = context;
    this.viewport = viewport;
    this.pageActive = true;
    this.states = [{ ctm: IDENTITY_MATRIX, alpha: 1, composite: 'source-over', clipDepth: 0 }];
    this.groups = [];
    this.path.begin();

    // 接管状态：建立基准 save，重置变换/alpha/composite/虚线；不设置宽高、不清屏。
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    context.setLineDash([]);
  }

  /** @inheritdoc */
  endPage(): void {
    if (!this.pageActive) return;
    while (this.groups.length > 0) {
      this.endGroup();
    }
    if (this.mainContext) {
      try {
        this.mainContext.restore();
      } catch {
        // 宿主上下文可能已失效，关闭路径上不抛出。
      }
    }
    this.mainContext = null;
    this.viewport = null;
    this.pageActive = false;
    this.states = [];
    this.path.begin();
  }

  /** @inheritdoc */
  save(): void {
    this.ensurePage();
    this.context.save();
    this.states.push({ ...this.state });
  }

  /** @inheritdoc */
  restore(): void {
    this.ensurePage();
    if (this.states.length <= this.minimumStateDepth) return;
    this.context.restore();
    this.states.pop();
  }

  /** @inheritdoc */
  setTransform(m: Matrix): void {
    this.ensurePage();
    this.state.ctm = m;
    this.context.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  }

  /** @inheritdoc */
  transform(m: Matrix): void {
    this.ensurePage();
    this.state.ctm = multiplyMatrix(this.state.ctm, m);
    this.context.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  }

  /** @inheritdoc */
  translate(x: number, y: number): void {
    this.ensurePage();
    this.state.ctm = translateMatrix(this.state.ctm, x, y);
    this.context.translate(x, y);
  }

  /** @inheritdoc */
  multiplyAlpha(alpha: number): void {
    this.ensurePage();
    this.state.alpha = clampUnit(this.state.alpha * clampUnit(alpha));
    this.context.globalAlpha = this.state.alpha;
  }

  /** @inheritdoc */
  clear(): void {
    this.ensurePage();
    // 契约：clear 只清理内部 scratch，不清除主画布。
    if (this.groups.length === 0) return;
    const context = this.context;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, context.canvas.width, context.canvas.height);
    context.restore();
  }

  /** @inheritdoc */
  beginPath(): void {
    this.ensurePage();
    this.path.begin();
    this.context.beginPath();
  }

  /** @inheritdoc */
  moveTo(x: number, y: number): void {
    this.ensurePage();
    this.path.moveTo(x, y);
    this.context.moveTo(x, y);
  }

  /** @inheritdoc */
  lineTo(x: number, y: number): void {
    this.ensurePage();
    this.path.lineTo(x, y);
    this.context.lineTo(x, y);
  }

  /** @inheritdoc */
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.ensurePage();
    this.path.quadraticCurveTo(cpx, cpy, x, y);
    this.context.quadraticCurveTo(cpx, cpy, x, y);
  }

  /** @inheritdoc */
  cubicCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void {
    this.ensurePage();
    this.path.cubicCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
    this.context.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
  }

  /** @inheritdoc */
  rect(x: number, y: number, w: number, h: number): void {
    this.ensurePage();
    this.path.rect(x, y, w, h);
    this.context.rect(x, y, w, h);
  }

  /** @inheritdoc */
  closePath(): void {
    this.ensurePage();
    this.path.closePath();
    this.context.closePath();
  }

  /** @inheritdoc */
  clip(rule: FillRule): void {
    this.ensurePage();
    this.context.clip(rule);
    this.state.clipDepth += 1;
  }

  /** @inheritdoc */
  fill(style: DrawStyle, paint: ResolvedPaint, rule: FillRule): void {
    void style;
    this.ensurePage();
    const context = this.context;
    applyState(context, this.state);
    this.fillWithPaint(context, this.state, paint, rule, this.path, 0);
  }

  /** @inheritdoc */
  stroke(style: DrawStyle, paint: ResolvedPaint): void {
    this.ensurePage();
    const context = this.context;
    applyState(context, this.state);
    applyStrokeStyle(context, style, this.state.ctm);
    this.strokeWithPaint(context, this.state, paint, this.path, style);
  }

  /** @inheritdoc */
  createImage(image: DecodedImage): ImageHandle {
    if (this.closed) throw new OFDError('OFD_CLOSED', '渲染器已关闭');
    const width = Math.max(1, Math.ceil(image.width));
    const height = Math.max(1, Math.ceil(image.height));

    if (isImageDataLike(image.data) || image.kind === 'imagedata') {
      if (!isImageDataLike(image.data)) {
        throw new OFDError('OFD_RENDERER_UNSUPPORTED', 'createImage 缺少 RGBA 像素数据');
      }
      const entry = this.canvasFactory.create(width, height);
      const context = entry.context;
      if (
        typeof context.createImageData !== 'function' ||
        typeof context.putImageData !== 'function'
      ) {
        this.canvasFactory.destroy(entry);
        throw new OFDError(
          'OFD_RENDERER_UNSUPPORTED',
          '当前 Canvas2D 实现缺少 createImageData/putImageData，无法绘制像素图像',
        );
      }
      const imageData = context.createImageData(width, height);
      const copyLength = Math.min(imageData.data.length, image.data.data.length);
      imageData.data.set(image.data.data.subarray(0, copyLength));
      context.putImageData(imageData, 0, 0);
      const handle = new H5ImageHandle(width, height, entry.canvas, entry);
      this.images.add(handle);
      return handle;
    }

    const handle = new H5ImageHandle(width, height, image.data as CanvasImageSourceLike, null);
    this.images.add(handle);
    return handle;
  }

  /** @inheritdoc */
  drawImage(
    image: ImageHandle,
    transform: Matrix,
    alpha: number,
    smoothing: boolean,
    mask?: ImageHandle,
    blendMode?: 'multiply',
  ): void {
    this.ensurePage();
    const context = this.context;
    applyState(context, this.state);
    const entry = this.resolveImage(image);
    const maskEntry = mask ? this.resolveImage(mask) : null;
    this.drawImageEntry(
      context,
      this.state,
      entry,
      transform,
      alpha,
      smoothing,
      maskEntry,
      blendMode,
    );
  }

  /**
   * 用渲染器自己创建的临时画布开始一页（画布由本渲染器持有）。
   *
   * 供签章印章重采样使用：核心层拿不到渲染器内部画布的生命周期，若由宿主
   * `createCanvas` 提供画布，渲染器关闭时会把它释放为 0×0，像素无法读回。
   * 这里用渲染器的画布工厂（与传入尺寸相同）创建画布，页面结束后画布仍有效。
   *
   * @param viewport 目标像素尺寸与 DPI。
   * @returns 该画布的 2D 上下文，可直接 `getImageData`。
   */
  beginPageFresh(viewport: Viewport): CanvasRenderingContext2DLike {
    if (this.closed) throw new OFDError('OFD_CLOSED', '渲染器已关闭');
    const created = this.surfaceFactory ?? this.canvasFactory;
    const entry = created.create(viewport.width, viewport.height);
    this.beginPage(entry.context, viewport);
    return entry.context;
  }

  /** @inheritdoc */
  beginGroup(options: GroupOptions): void {
    this.ensurePage();
    const context = this.context;

    // 1) bounds × matrix 求设备空间 AABB；clamp 到主画布可见区域，避免超大 scratch。
    const bounds = normalizeBox(options.bounds);
    const matrix = options.matrix;
    const corners = [
      transformPoint(matrix, { x: bounds.x, y: bounds.y }),
      transformPoint(matrix, { x: bounds.x + bounds.w, y: bounds.y }),
      transformPoint(matrix, { x: bounds.x, y: bounds.y + bounds.h }),
      transformPoint(matrix, { x: bounds.x + bounds.w, y: bounds.y + bounds.h }),
    ];
    let minX = Math.floor(Math.min(...corners.map((corner) => corner.x)));
    let minY = Math.floor(Math.min(...corners.map((corner) => corner.y)));
    let maxX = Math.ceil(Math.max(...corners.map((corner) => corner.x)));
    let maxY = Math.ceil(Math.max(...corners.map((corner) => corner.y)));

    const canvasWidth = this.mainContext?.canvas.width ?? 0;
    const canvasHeight = this.mainContext?.canvas.height ?? 0;
    if (canvasWidth > 0 && canvasHeight > 0) {
      minX = Math.max(0, Math.min(minX, canvasWidth));
      minY = Math.max(0, Math.min(minY, canvasHeight));
      maxX = Math.min(canvasWidth, Math.max(maxX, minX));
      maxY = Math.min(canvasHeight, Math.max(maxY, minY));
    }
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const offsetX = Number.isFinite(minX) ? minX : 0;
    const offsetY = Number.isFinite(minY) ? minY : 0;

    // 2) 创建 scratch；Node/小程序没有默认工厂时在这里抛 OFD_RENDERER_UNSUPPORTED。
    const entry = this.canvasFactory.create(width, height);

    // 3) 保存父目标状态，切换到 scratch；group 内从 group 坐标自己的单位开始。
    context.save();
    const parentState = { ...this.state };
    const parentStateDepth = this.states.length;
    this.states.push({ ctm: IDENTITY_MATRIX, alpha: 1, composite: 'source-over', clipDepth: 0 });

    const scratchCtm: Matrix = [
      matrix[0],
      matrix[1],
      matrix[2],
      matrix[3],
      matrix[4] - offsetX,
      matrix[5] - offsetY,
    ];
    const scratch = entry.context;
    scratch.setTransform(
      scratchCtm[0],
      scratchCtm[1],
      scratchCtm[2],
      scratchCtm[3],
      scratchCtm[4],
      scratchCtm[5],
    );
    scratch.globalAlpha = 1;
    scratch.globalCompositeOperation = 'source-over';
    scratch.setLineDash([]);
    this.state.ctm = scratchCtm;

    this.groups.push({
      entry,
      parentContext: context,
      parentState,
      parentStateDepth,
      offsetX,
      offsetY,
      alpha: clampUnit(options.alpha),
      composite: options.composite ?? 'source-over',
      isolated: options.isolated ?? false,
    });
  }

  /** @inheritdoc */
  endGroup(): void {
    this.ensurePage();
    const frame = this.groups.pop();
    if (!frame) {
      throw new OFDError('OFD_RENDERER_UNSUPPORTED', 'endGroup 没有对应的 beginGroup');
    }

    // 丢弃 group 内未配对的 save，恢复父状态栈。
    this.states.length = frame.parentStateDepth;
    frame.parentContext.restore();

    // matrix 是 group 坐标 → device 坐标；嵌套装回父 scratch 时要减去父偏移。
    const parentGroup = this.groups[this.groups.length - 1];
    const destinationX = frame.offsetX - (parentGroup?.offsetX ?? 0);
    const destinationY = frame.offsetY - (parentGroup?.offsetY ?? 0);

    try {
      if (frame.alpha > 0 && frame.entry.canvas.width > 0 && frame.entry.canvas.height > 0) {
        frame.parentContext.save();
        frame.parentContext.setTransform(1, 0, 0, 1, 0, 0);
        frame.parentContext.globalAlpha = clampUnit(frame.parentState.alpha * frame.alpha);
        frame.parentContext.globalCompositeOperation = frame.composite;
        frame.parentContext.imageSmoothingEnabled = true;
        frame.parentContext.drawImage(
          frame.entry.canvas,
          destinationX,
          destinationY,
          frame.entry.canvas.width,
          frame.entry.canvas.height,
        );
        frame.parentContext.restore();
      }
    } finally {
      this.canvasFactory.destroy(frame.entry);
    }
  }

  /** @inheritdoc */
  close(): void {
    if (this.closed) return;
    try {
      while (this.groups.length > 0) this.endGroup();
    } catch {
      // group 恢复失败不阻塞资源释放。
    }
    if (this.pageActive) {
      try {
        this.endPage();
      } catch {
        // 同上。
      }
    }
    if (this.factory) {
      for (const image of this.images) {
        if (image.scratch) {
          try {
            this.factory.destroy(image.scratch);
          } catch {
            // 忽略单个资源释放失败。
          }
        }
      }
    }
    this.images.clear();
    this.factory = null;
    this.mainContext = null;
    this.viewport = null;
    this.pageActive = false;
    this.states = [];
    this.groups = [];
    this.path.begin();
    this.closed = true;
  }

  /**
   * 把图像句柄解析为本渲染器的内部句柄。
   *
   * @param handle 外部传入的句柄。
   * @returns 内部图像句柄。
   */
  private resolveImage(handle: ImageHandle): H5ImageHandle {
    if (handle instanceof H5ImageHandle) return handle;
    throw new OFDError(
      'OFD_RENDERER_UNSUPPORTED',
      'drawImage 只接受本渲染器 createImage 返回的句柄',
    );
  }

  /**
   * 在指定上下文绘制图像（可带蒙版）。
   *
   * @param context 目标上下文。
   * @param state 目标状态。
   * @param image 内部图像句柄。
   * @param transform 图像单位空间 → 当前空间的矩阵。
   * @param alpha 额外透明度，0..1。
   * @param smoothing 是否启用平滑。
   * @param mask 可选蒙版句柄。
   * @param blendMode 可选合成模式；缺省使用当前状态的 composite。
   */
  private drawImageEntry(
    context: CanvasRenderingContext2DLike,
    state: DrawState,
    image: H5ImageHandle,
    transform: Matrix,
    alpha: number,
    smoothing: boolean,
    mask: H5ImageHandle | null,
    blendMode?: 'multiply',
  ): void {
    let source = image.source;
    let compositeEntry: CanvasFactoryEntry | null = null;

    if (mask) {
      const width = Math.max(1, Math.ceil(image.width));
      const height = Math.max(1, Math.ceil(image.height));
      compositeEntry = this.canvasFactory.create(width, height);
      const maskContext = compositeEntry.context;
      maskContext.setTransform(1, 0, 0, 1, 0, 0);
      // 中间画布按不透明画布处理：1:1 贴图、关闭 alpha 乘算，避免把主图自身的 alpha
      // 叠加到结果（否则 mask 只保留 alpha 交集时会被二次衰减）。
      maskContext.globalAlpha = 1;
      maskContext.globalCompositeOperation = 'source-over';
      maskContext.drawImage(source, 0, 0, width, height);
      // destination-in：保留主图 alpha 与蒙版 alpha 的交集。
      maskContext.globalCompositeOperation = 'destination-in';
      maskContext.drawImage(mask.source, 0, 0, width, height);
      source = compositeEntry.canvas;
    }

    try {
      context.save();
      try {
        context.globalAlpha = clampUnit(state.alpha * clampUnit(alpha));
        // 签章白底使用 multiply；其他图片缺省沿用当前 composite（通常 source-over）。
        context.globalCompositeOperation = blendMode ?? state.composite;
        context.imageSmoothingEnabled = smoothing;
        // 图片缩放需要面积采样：缺省双线性会把 1px 细线（如签章掩码章的框线）压成稀疏点。
        // 只在真正缩放时提升质量，1:1 贴图保持平台默认，避免改变既有像素结果。
        const scaleX = Math.hypot(transform[0], transform[1]);
        const scaleY = Math.hypot(transform[2], transform[3]);
        if (smoothing && (Math.abs(scaleX - 1) > 1e-6 || Math.abs(scaleY - 1) > 1e-6)) {
          context.imageSmoothingQuality = 'high';
        }
        context.transform(
          transform[0],
          transform[1],
          transform[2],
          transform[3],
          transform[4],
          transform[5],
        );
        context.drawImage(source, 0, 0, 1, 1);
      } finally {
        // 保证 multiply 不泄漏到后续绘制。
        context.restore();
      }
    } finally {
      if (compositeEntry) this.canvasFactory.destroy(compositeEntry);
    }
  }

  /**
   * 按 ResolvedPaint 填充当前路径。
   *
   * @param context 目标上下文。
   * @param state 目标状态。
   * @param paint 已绑定 Paint。
   * @param rule 填充规则。
   * @param path 当前路径记录器。
   * @param depth 嵌套 pattern 深度。
   */
  private fillWithPaint(
    context: CanvasRenderingContext2DLike,
    state: DrawState,
    paint: ResolvedPaint,
    rule: FillRule,
    path: PathRecorder,
    depth: number,
  ): void {
    switch (paint.kind) {
      case 'color':
        context.fillStyle = rgbaToCss(paint.rgba);
        context.fill(rule);
        return;
      case 'gradient': {
        const spec = paint.spec;
        if (spec.kind === 'radial') {
          this.fillWithRadial(context, state, spec, rule, path);
          return;
        }
        const gradient = createAxialGradient(context, spec, path.bounds);
        if (!gradient) {
          context.fillStyle = spec.segments[0]
            ? rgbaToCss(spec.segments[0].color)
            : 'rgba(0,0,0,0)';
          context.fill(rule);
          return;
        }
        context.fillStyle = gradient;
        // Extend 的裁剪带在渲染器内完成：渐变坐标与当前用户空间（对象空间）一致，
        // 因此直接用 spec.start/end 构造半平面裁剪即可（§8.3.4.2 表 29 Extend）。
        const band = gradientBand(spec);
        if (!band.needStart && !band.needEnd) {
          context.fill(rule);
          return;
        }
        context.save();
        applyGradientBand(context, spec, path.bounds, band.needStart, band.needEnd);
        path.replay(context);
        context.fill(rule);
        context.restore();
        return;
      }
      case 'pattern':
        this.fillWithPattern(context, state, paint, rule, path, depth);
        return;
      case 'shading':
        this.fillWithShading(context, state, paint.spec, rule, path);
        return;
    }
  }

  /**
   * 用底纹填充当前路径。
   *
   * @param context 目标上下文。
   * @param state 目标状态。
   * @param paint 底纹绑定结果。
   * @param rule 填充规则。
   * @param path 当前路径记录器。
   * @param depth 嵌套深度。
   */
  private fillWithPattern(
    context: CanvasRenderingContext2DLike,
    state: DrawState,
    paint: PatternPaint,
    rule: FillRule,
    path: PathRecorder,
    depth: number,
  ): void {
    if (depth >= MAX_PATTERN_DEPTH || !paint.tile || paint.tile.commands.length === 0) {
      context.fillStyle = rgbaToCss(estimateDisplayListColor(paint.tile));
      context.fill(rule);
      return;
    }

    const width = Math.max(1e-6, paint.width);
    const height = Math.max(1e-6, paint.height);
    const xStep = Math.max(paint.xStep, width);
    const yStep = Math.max(paint.yStep, height);

    // 当前对象空间 → 设备像素的近似比例，用于确定 tile 分辨率。
    const patternMatrix = multiplyMatrix(state.ctm, paint.ctm);
    const determinant = Math.abs(
      patternMatrix[0] * patternMatrix[3] - patternMatrix[1] * patternMatrix[2],
    );
    const pxPerUnit = Math.sqrt(Number.isFinite(determinant) ? determinant : 1);
    let tileWidth = Math.max(1, Math.ceil(width * pxPerUnit));
    let tileHeight = Math.max(1, Math.ceil(height * pxPerUnit));
    if (tileWidth * tileHeight > MAX_TILE_PIXELS) {
      const shrink = Math.sqrt(MAX_TILE_PIXELS / (tileWidth * tileHeight));
      tileWidth = Math.max(1, Math.floor(tileWidth * shrink));
      tileHeight = Math.max(1, Math.floor(tileHeight * shrink));
    }

    const entry = this.canvasFactory.create(tileWidth, tileHeight);
    try {
      const tileContext = entry.context;
      const tileScale: Matrix = [tileWidth / width, 0, 0, tileHeight / height, 0, 0];
      tileContext.setTransform(
        tileScale[0],
        tileScale[1],
        tileScale[2],
        tileScale[3],
        tileScale[4],
        tileScale[5],
      );
      this.replayDisplayList(entry, paint.tile, depth + 1, tileScale);

      const native = paint.reflect === 'Normal' && approx(xStep, width) && approx(yStep, height);
      if (native) {
        const patternTransform = multiplyMatrix(paint.ctm, [
          width / tileWidth,
          0,
          0,
          height / tileHeight,
          0,
          0,
        ]);
        const transformIsIdentity = isIdentityMatrix(patternTransform);
        if (transformIsIdentity || this.supportsPatternTransform()) {
          const pattern = context.createPattern(entry.canvas, 'repeat');
          if (
            pattern &&
            (transformIsIdentity || applyPatternTransform(pattern, patternTransform))
          ) {
            context.fillStyle = pattern;
            context.fill(rule);
            return;
          }
        }
      }

      this.fillPatternManual(
        context,
        state,
        paint,
        rule,
        path,
        entry,
        width,
        height,
        xStep,
        yStep,
      );
    } finally {
      this.canvasFactory.destroy(entry);
    }
  }

  /**
   * 手动平铺底纹（处理 ReflectMethod、XStep/YStep 间隙与 pattern.setTransform 缺失）。
   *
   * @param context 目标上下文。
   * @param state 目标状态。
   * @param paint 底纹绑定结果。
   * @param rule 填充规则。
   * @param path 当前路径记录器。
   * @param entry tile 画布。
   * @param width tile 宽（对象空间单位）。
   * @param height tile 高（对象空间单位）。
   * @param xStep 水平步进（对象空间单位）。
   * @param yStep 垂直步进（对象空间单位）。
   */
  private fillPatternManual(
    context: CanvasRenderingContext2DLike,
    state: DrawState,
    paint: PatternPaint,
    rule: FillRule,
    path: PathRecorder,
    entry: CanvasFactoryEntry,
    width: number,
    height: number,
    xStep: number,
    yStep: number,
  ): void {
    const inverse = invertMatrix(paint.ctm);
    const bounds = path.bounds;
    if (!inverse || !bounds || bounds.w <= 0 || bounds.h <= 0) {
      context.fillStyle = rgbaToCss(estimateDisplayListColor(paint.tile));
      context.fill(rule);
      return;
    }

    // 把对象空间 bbox 变到 tile 空间，据此确定平铺范围。
    const corners = [
      transformPoint(inverse, { x: bounds.x, y: bounds.y }),
      transformPoint(inverse, { x: bounds.x + bounds.w, y: bounds.y }),
      transformPoint(inverse, { x: bounds.x, y: bounds.y + bounds.h }),
      transformPoint(inverse, { x: bounds.x + bounds.w, y: bounds.y + bounds.h }),
    ];
    const minX = Math.min(...corners.map((corner) => corner.x));
    const minY = Math.min(...corners.map((corner) => corner.y));
    const maxX = Math.max(...corners.map((corner) => corner.x));
    const maxY = Math.max(...corners.map((corner) => corner.y));

    const startColumn = Math.floor(minX / xStep);
    const endColumn = Math.ceil(maxX / xStep) - 1;
    const startRow = Math.floor(minY / yStep);
    const endRow = Math.ceil(maxY / yStep) - 1;
    const columns = Math.max(0, endColumn - startColumn + 1);
    const rows = Math.max(0, endRow - startRow + 1);

    if (columns * rows > MAX_PATTERN_TILES) {
      this.warnOnce(
        'W_PATTERN_LIMIT',
        `底纹平铺数量 ${columns * rows} 超过上限 ${MAX_PATTERN_TILES}，按纯色近似`,
      );
      context.fillStyle = rgbaToCss(estimateDisplayListColor(paint.tile));
      context.fill(rule);
      return;
    }

    context.save();
    path.replay(context);
    context.clip(rule);
    context.transform(
      paint.ctm[0],
      paint.ctm[1],
      paint.ctm[2],
      paint.ctm[3],
      paint.ctm[4],
      paint.ctm[5],
    );
    context.globalAlpha = clampUnit(state.alpha);
    context.globalCompositeOperation = state.composite;

    for (let row = startRow; row <= endRow; row += 1) {
      for (let column = startColumn; column <= endColumn; column += 1) {
        const flipX = paint.reflect === 'Column' || paint.reflect === 'RowAndColumn';
        const flipY = paint.reflect === 'Row' || paint.reflect === 'RowAndColumn';
        const flipHorizontal = flipX && Math.abs(column % 2) === 1;
        const flipVertical = flipY && Math.abs(row % 2) === 1;
        const x = column * xStep;
        const y = row * yStep;

        if (!flipHorizontal && !flipVertical) {
          context.drawImage(entry.canvas, x, y, width, height);
          continue;
        }
        context.save();
        context.translate(x + (flipHorizontal ? width : 0), y + (flipVertical ? height : 0));
        context.scale(flipHorizontal ? -1 : 1, flipVertical ? -1 : 1);
        context.drawImage(entry.canvas, 0, 0, width, height);
        context.restore();
      }
    }
    context.restore();
  }

  /**
   * 用径向渐变（OFD `RadialShd`）填充当前路径。
   *
   * Canvas 原生 `createRadialGradient` 无法表达离心率与倾斜，因此走与 Gouraud 相同的
   * 「软件光栅化 + 离屏画布 clip 路径 + 贴图」路线：先在对象包围盒的设备像素范围内
   * 逐像素求解颜色，再以 `path` 裁剪后贴回。
   *
   * @param context 目标上下文。
   * @param state 目标状态。
   * @param spec 径向渐变描述；坐标与半径位于当前用户空间（通常 mm），角度单位度。
   * @param rule 填充规则。
   * @param path 当前路径记录器。
   */
  private fillWithRadial(
    context: CanvasRenderingContext2DLike,
    state: DrawState,
    spec: RadialGradientSpec,
    rule: FillRule,
    path: PathRecorder,
  ): void {
    const bounds = path.bounds;
    if (!bounds || bounds.w <= 0 || bounds.h <= 0) return;
    if (!spec.segments || spec.segments.length === 0) return;

    const corners = [
      transformPoint(state.ctm, { x: bounds.x, y: bounds.y }),
      transformPoint(state.ctm, { x: bounds.x + bounds.w, y: bounds.y }),
      transformPoint(state.ctm, { x: bounds.x, y: bounds.y + bounds.h }),
      transformPoint(state.ctm, { x: bounds.x + bounds.w, y: bounds.y + bounds.h }),
    ];
    const offsetX = Math.floor(Math.min(...corners.map((corner) => corner.x)));
    const offsetY = Math.floor(Math.min(...corners.map((corner) => corner.y)));
    const width = Math.max(1, Math.ceil(Math.max(...corners.map((corner) => corner.x))) - offsetX);
    const height = Math.max(1, Math.ceil(Math.max(...corners.map((corner) => corner.y))) - offsetY);

    const canWritePixels =
      typeof context.createImageData === 'function' && typeof context.putImageData === 'function';
    if (!canWritePixels) {
      this.degradeRadial(context, spec, rule);
      return;
    }

    // 单图元像素上限：超出时按比例缩小缓冲，最后由 drawImage 拉伸回目标尺寸。
    const scale = Math.min(1, Math.sqrt(RADIAL_MAX_PIXELS / Math.max(1, width * height)));
    const rasterWidth = Math.max(1, Math.floor(width * scale));
    const rasterHeight = Math.max(1, Math.floor(height * scale));
    if (scale < 1) {
      this.warnOnce('W_UNSUPPORTED_PAINT', `径向渐变 bbox ${width}×${height}px 超过 4MP，降采样后拉伸绘制`);
    }

    let scratch: CanvasFactoryEntry;
    try {
      scratch = this.canvasFactory.create(rasterWidth, rasterHeight);
    } catch {
      this.degradeRadial(context, spec, rule);
      return;
    }

    try {
      const scratchContext = scratch.context;
      if (
        typeof scratchContext.createImageData !== 'function' ||
        typeof scratchContext.putImageData !== 'function'
      ) {
        this.degradeRadial(context, spec, rule);
        return;
      }

      const raster = rasterizeRadialShadingDevice({
        spec,
        // 光栅化矩阵的输出原点必须是离屏画布左上角：CTM 的平移分量是页面绝对设备像素，
        // 这里再减去 offsetX/offsetY，并叠加降采样比例。这些都是设备像素，直接改写 e/f
        // （CTM 之后的平移），不能经 translateMatrix 作用在用户空间，否则会被 CTM 放大。
        matrix: scaleRadialMatrix(state.ctm, offsetX, offsetY, scale),
        width: rasterWidth,
        height: rasterHeight,
        maxPixels: RADIAL_MAX_PIXELS,
      });
      const imageData = scratchContext.createImageData(raster.width, raster.height);
      imageData.data.set(raster.data);
      scratchContext.putImageData(imageData, 0, 0);

      context.save();
      context.globalAlpha = clampUnit(state.alpha);
      context.globalCompositeOperation = state.composite;
      path.replay(context);
      context.clip(rule);
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.imageSmoothingEnabled = true;
      context.drawImage(scratch.canvas, offsetX, offsetY, width, height);
      context.restore();
    } finally {
      this.canvasFactory.destroy(scratch);
    }
  }

  /**
   * 径向渐变无法光栅化时的降级：按段平均色填充。
   *
   * @param context 目标上下文。
   * @param spec 径向渐变描述。
   * @param rule 填充规则。
   */
  private degradeRadial(
    context: CanvasRenderingContext2DLike,
    spec: RadialGradientSpec,
    rule: FillRule,
  ): void {
    this.warnOnce('W_UNSUPPORTED_PAINT', '当前 Canvas2D 缺少像素读写能力，径向渐变按平均色降级');
    context.fillStyle = averageColorCss(spec.segments);
    context.fill(rule);
  }

  /**
   * 用 Gouraud/LaGouraud 填充当前路径。
   *
   * @param context 目标上下文。
   * @param state 目标状态。
   * @param spec 网格渐变描述。
   * @param rule 填充规则。
   * @param path 当前路径记录器。
   */
  private fillWithShading(
    context: CanvasRenderingContext2DLike,
    state: DrawState,
    spec: MeshShadingSpec,
    rule: FillRule,
    path: PathRecorder,
  ): void {
    const bounds = path.bounds;
    if (!bounds || bounds.w <= 0 || bounds.h <= 0) return;

    if (!spec.points || spec.points.length < 3) {
      this.warnOnce('W_GOURAUD_APPROX', 'Gouraud 控制点少于 3 个，按透明处理');
      return;
    }
    if (spec.kind === 'lagouraud') {
      const verticesPerRow = Math.floor(spec.verticesPerRow ?? 0);
      const rows = verticesPerRow > 0 ? Math.ceil(spec.points.length / verticesPerRow) : 0;
      if (verticesPerRow < 2 || rows * verticesPerRow !== spec.points.length) {
        this.warnOnce('W_GOURAUD_APPROX', 'LaGouraud 网格点不完整，跳过缺失单元');
      }
    }

    const corners = [
      transformPoint(state.ctm, { x: bounds.x, y: bounds.y }),
      transformPoint(state.ctm, { x: bounds.x + bounds.w, y: bounds.y }),
      transformPoint(state.ctm, { x: bounds.x, y: bounds.y + bounds.h }),
      transformPoint(state.ctm, { x: bounds.x + bounds.w, y: bounds.y + bounds.h }),
    ];
    const offsetX = Math.floor(Math.min(...corners.map((corner) => corner.x)));
    const offsetY = Math.floor(Math.min(...corners.map((corner) => corner.y)));
    const width = Math.max(1, Math.ceil(Math.max(...corners.map((corner) => corner.x))) - offsetX);
    const height = Math.max(1, Math.ceil(Math.max(...corners.map((corner) => corner.y))) - offsetY);
    if (width * height > 4_000_000) {
      this.warnOnce(
        'W_GOURAUD_APPROX',
        `网格渐变 bbox ${width}×${height}px 超过 4MP，降采样后拉伸绘制`,
      );
    }

    const canWritePixels =
      typeof context.createImageData === 'function' && typeof context.putImageData === 'function';
    if (!canWritePixels) {
      this.degradeShading(context, spec, rule);
      return;
    }

    let scratch: CanvasFactoryEntry;
    try {
      scratch = this.canvasFactory.create(width, height);
    } catch {
      this.degradeShading(context, spec, rule);
      return;
    }

    try {
      const scratchContext = scratch.context;
      if (
        typeof scratchContext.createImageData !== 'function' ||
        typeof scratchContext.putImageData !== 'function'
      ) {
        this.degradeShading(context, spec, rule);
        return;
      }

      const raster = rasterizeMeshShadingDevice({
        spec,
        // offsetX/offsetY 是设备像素，必须作为 CTM 之后的平移（先 CTM 再平移），
        // 不能经 translateMatrix 作用在用户空间，否则会被 CTM 的缩放放大。
        matrix: [
          state.ctm[0],
          state.ctm[1],
          state.ctm[2],
          state.ctm[3],
          state.ctm[4] - offsetX,
          state.ctm[5] - offsetY,
        ],
        width,
        height,
        maxPixels: 4_000_000,
      });
      const imageData = scratchContext.createImageData(raster.width, raster.height);
      imageData.data.set(raster.data);
      scratchContext.putImageData(imageData, 0, 0);

      context.save();
      context.globalAlpha = clampUnit(state.alpha);
      context.globalCompositeOperation = state.composite;
      path.replay(context);
      context.clip(rule);
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.imageSmoothingEnabled = true;
      context.drawImage(scratch.canvas, offsetX, offsetY, width, height);
      context.restore();
    } finally {
      this.canvasFactory.destroy(scratch);
    }
  }

  /**
   * shading 无法光栅化时的降级：平均色填充 + W_GOURAUD_APPROX。
   *
   * @param context 目标上下文。
   * @param spec 网格渐变描述。
   * @param rule 填充规则。
   */
  private degradeShading(
    context: CanvasRenderingContext2DLike,
    spec: MeshShadingSpec,
    rule: FillRule,
  ): void {
    this.warnOnce(
      'W_GOURAUD_APPROX',
      '当前 Canvas2D 缺少像素读写能力，网格渐变按平均色降级',
    );
    context.fillStyle = rgbaToCss(averageMeshColor(spec));
    context.fill(rule);
  }

  /**
   * 按 ResolvedPaint 描边当前路径。
   *
   * 渐变（轴向/径向）与网格渐变（Gouraud/LaGouraud）走 `strokeWithMask`：先把描边区域
   * 栅格化为掩码，再用渐变填充掩码（GB/T 33190—2016 §8.3.4.1 允许渐变勾边）。
   * 底纹描边需要逐像素平铺，仍按设计方案 13.6 用 tile 的估算主色近似。
   *
   * @param context 目标上下文。
   * @param state 目标状态。
   * @param paint 已绑定 Paint。
   * @param path 当前路径记录器。
   * @param style 最终线型；掩码路径需要自行应用线宽/端点/虚线。
   */
  private strokeWithPaint(
    context: CanvasRenderingContext2DLike,
    state: DrawState,
    paint: ResolvedPaint,
    path: PathRecorder,
    style: DrawStyle,
  ): void {
    switch (paint.kind) {
      case 'color':
        context.strokeStyle = rgbaToCss(paint.rgba);
        context.stroke();
        return;
      case 'gradient':
        this.strokeWithMask(context, state, paint, path, style);
        return;
      case 'pattern':
        this.strokeAverage(context, estimateDisplayListColor(paint.tile));
        return;
      case 'shading':
        this.strokeWithMask(context, state, paint, path, style);
        return;
    }
  }

  /**
   * 用渐变或网格渐变描边当前路径。
   *
   * 描边区域没有一个可直接裁剪的形状：描边像素落在路径外侧，用路径做 `clip()` 会把它们
   * 裁掉。因此把描边区域先栅格化成 alpha 掩码，再用渐变填充掩码：
   * ① 离屏画布按设备空间把路径描边掩码的包围盒（路径 bbox 外扩）铺上渐变/网格渐变；
   * ② 用 `destination-in` 把描边形状（白色描边，已裁到包围盒内）与渐变层相乘；
   * ③ 以设备坐标把结果贴回主目标，`globalAlpha`/`globalCompositeOperation` 由主目标
   *    当前状态决定，与纯色描边一致。
   *
   * 掩码合成在离屏画布内完成，不经过主目标的裁剪栈，因此不会破坏已有的 Clip 与组透明度。
   *
   * @param context 目标上下文。
   * @param state 目标状态。
   * @param paint 渐变或网格渐变 Paint；`strokeBounds` 是采样范围（对象空间，通常 mm）。
   * @param path 当前路径记录器。
   * @param style 最终线型；线宽/端点/拐角/虚线均在此应用。
   */
  private strokeWithMask(
    context: CanvasRenderingContext2DLike,
    state: DrawState,
    paint: Extract<ResolvedPaint, { kind: 'gradient' } | { kind: 'shading' }>,
    path: PathRecorder,
    style: DrawStyle,
  ): void {
    // 水平/竖直线段的包围盒有一个维度为 0，描边仍有像素，因此只看非零面积以外的情况。
    const bounds = path.bounds;
    if (!bounds || (bounds.w <= 0 && bounds.h <= 0)) return;
    if (paint.kind === 'shading') {
      if (paint.spec.points.length < 3) {
        this.warnOnce('W_GOURAUD_APPROX', 'Gouraud 控制点少于 3 个，描边按透明处理');
        return;
      }
    } else if (paint.spec.segments.length === 0) {
      return;
    }

    // 用户空间线宽：hairline 与 applyStrokeStyle 一致，按 CTM 换算成 1 像素。
    const deviceScale = matrixScale(state.ctm);
    const lineWidth = style.lineWidth > 0 ? style.lineWidth : 1 / deviceScale;
    // 斜接拐角最多伸出 min(miterLimit, 1/sin(θ/2)) 倍线宽；取上限 32 覆盖极端形状。
    const miterLimit =
      Number.isFinite(style.miterLimit) && style.miterLimit > 0 ? style.miterLimit : 10;
    const joinReach =
      style.lineJoin === 'Miter' ? lineWidth * Math.max(1, Math.min(miterLimit, 32)) : lineWidth;
    // 描边区域的设备像素包围盒 = 路径 bbox 的设备包围盒外扩描边伸出量（像素）。
    const padding = Math.max(2, Math.ceil(transformRadius(state.ctm, joinReach)) + 1);
    const corners = [
      transformPoint(state.ctm, { x: bounds.x, y: bounds.y }),
      transformPoint(state.ctm, { x: bounds.x + bounds.w, y: bounds.y }),
      transformPoint(state.ctm, { x: bounds.x, y: bounds.y + bounds.h }),
      transformPoint(state.ctm, { x: bounds.x + bounds.w, y: bounds.y + bounds.h }),
    ];
    const left = Math.floor(Math.min(...corners.map((corner) => corner.x))) - padding;
    const top = Math.floor(Math.min(...corners.map((corner) => corner.y))) - padding;
    const right = Math.ceil(Math.max(...corners.map((corner) => corner.x))) + padding;
    const bottom = Math.ceil(Math.max(...corners.map((corner) => corner.y))) + padding;

    // 离屏像素 (0,0) 的设备中心是 (left + 0.5, top + 0.5)。几何按 left/top 整数平移，
    // 设备坐标 d 就落在离屏的 d - left 处；贴回时平移 left/top 完全还原，不做半像素插值。
    const offsetX = left;
    const offsetY = top;
    // 设备像素偏移只能作为 CTM 之后的平移，不能经 translateMatrix 作用在用户空间。
    const localMatrix = offsetRadialMatrix(state.ctm, offsetX, offsetY);
    // 单图元像素上限：宽高同比例缩小，保持描边形状比例不被拉伸。
    const rawWidth = Math.max(1, right - left);
    const rawHeight = Math.max(1, bottom - top);
    const shrink = Math.min(1, Math.sqrt(STROKE_MASK_MAX_PIXELS / (rawWidth * rawHeight)));
    const width = Math.max(1, Math.round(rawWidth * shrink));
    const height = Math.max(1, Math.round(rawHeight * shrink));
    const matrix = shrink < 1 ? scaleMatrix(localMatrix, shrink, shrink) : localMatrix;

    let mask: CanvasFactoryEntry | null = null;
    let layer: CanvasFactoryEntry | null = null;
    try {
      mask = this.canvasFactory.create(width, height);
      layer = this.canvasFactory.create(width, height);

      // ① 描边掩码：白色实心描边；离屏上下文不带主目标状态，线型必须显式应用。
      const maskContext = mask.context;
      maskContext.setTransform(
        matrix[0],
        matrix[1],
        matrix[2],
        matrix[3],
        matrix[4],
        matrix[5],
      );
      applyStrokeStyle(maskContext, style, state.ctm);
      path.replay(maskContext);
      maskContext.strokeStyle = '#ffffff';
      maskContext.stroke();
      // 只保留描边包围盒内的部分（虚线/端点可能把像素画到格子之外）。
      maskContext.setTransform(1, 0, 0, 1, 0, 0);
      maskContext.globalCompositeOperation = 'destination-in';
      maskContext.fillStyle = '#ffffff';
      maskContext.fillRect(0, 0, width, height);
      maskContext.globalCompositeOperation = 'source-over';

      // ② 渐变层：铺满整个描边包围盒，再与描边掩码相乘。
      const layerContext = layer.context;
      layerContext.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
      if (paint.kind === 'shading') {
        this.drawShadingLayer(layerContext, matrix, paint.spec, width, height);
      } else {
        drawGradientLayer(
          layerContext,
          matrix,
          paint.spec,
          paint.strokeBounds ?? bounds,
          width,
          height,
        );
      }
      // destination-in：保留渐变层中与描边掩码 alpha 重叠的部分，得到描边形状内的渐变。
      layerContext.setTransform(1, 0, 0, 1, 0, 0);
      layerContext.globalCompositeOperation = 'destination-in';
      layerContext.drawImage(mask.canvas, 0, 0);
      layerContext.globalCompositeOperation = 'source-over';
      // ③ 贴回主目标：设备坐标 + 当前 alpha/composite，与纯色描边同一套合成语义。
      context.save();
      context.globalAlpha = clampUnit(state.alpha);
      context.globalCompositeOperation = state.composite;
      // 设备坐标：把离屏图按原始像素尺寸贴到 (left, top)，再用线性变换补上降采样比例。
      context.imageSmoothingEnabled = true;
      context.setTransform(
        rawWidth / width,
        0,
        0,
        rawHeight / height,
        left + (rawWidth - width) / 2,
        top + (rawHeight - height) / 2,
      );
      context.drawImage(layer.canvas, 0, 0, width, height);
      context.restore();
    } finally {
      if (layer) this.canvasFactory.destroy(layer);
      if (mask) this.canvasFactory.destroy(mask);
    }
  }

  /**
   * 在离屏上下文中绘制网格渐变层（描边掩码用）。
   *
   * 网格只覆盖三角形/网格单元本身：`Extend=0` 时单元之外的描边像素保持透明，
   * `Extend=1` 时由 `rasterizeMeshShadingDevice` 预先铺满 `BackColor`（GB/T 33190—2016
   * §8.3.4.4 表 31）。这与填充的语义一致，不做额外外推。
   *
   * @param layer 渐变层上下文，已设置为描边掩码的本地矩阵。
   * @param localMatrix 用户空间 → 渐变层像素的矩阵。
   * @param spec 网格渐变描述。
   * @param width 渐变层宽，像素。
   * @param height 渐变层高，像素。
   */
  private drawShadingLayer(
    layer: CanvasRenderingContext2DLike,
    localMatrix: Matrix,
    spec: MeshShadingSpec,
    width: number,
    height: number,
  ): void {
    const canRasterize =
      typeof layer.createImageData === 'function' && typeof layer.putImageData === 'function';
    if (!canRasterize) {
      layer.fillStyle = rgbaToCss(averageMeshColor(spec));
      layer.fillRect(0, 0, width, height);
      return;
    }
    const raster = rasterizeMeshShadingDevice({
      spec,
      matrix: localMatrix,
      width,
      height,
      maxPixels: STROKE_MASK_MAX_PIXELS,
    });
    const createImageData = layer.createImageData;
    const putImageData = layer.putImageData;
    if (typeof createImageData !== 'function' || typeof putImageData !== 'function') return;
    const imageData = createImageData.call(layer, raster.width, raster.height);
    imageData.data.set(raster.data);
    layer.setTransform(1, 0, 0, 1, 0, 0);
    putImageData.call(layer, imageData, 0, 0);
  }

  /**
   * 渐变/网格渐变描边无法绘制时的降级：纯色描边 + warning。
   *
   * @param context 目标上下文。
   * @param paint 渐变或网格渐变 Paint。
   */
  private degradeStroke(
    context: CanvasRenderingContext2DLike,
    paint: Extract<ResolvedPaint, { kind: 'gradient' } | { kind: 'shading' }>,
  ): void {
    this.warnOnce('W_UNSUPPORTED_PAINT', '无法创建离屏画布，渐变描边按平均色降级');
    if (paint.kind === 'shading') {
      this.strokeAverage(context, averageMeshColor(paint.spec));
      return;
    }
    this.strokeAverage(
      context,
      paint.spec.kind === 'radial'
        ? averageRadialColor(paint.spec)
        : parseRgbaCss(averageColorCss(paint.spec.segments)),
    );
  }

  /**
   * 用纯色描边当前路径。
   *
   * @param context 目标上下文。
   * @param color 描边颜色。
   */
  private strokeAverage(context: CanvasRenderingContext2DLike, color: Rgba): void {
    context.strokeStyle = rgbaToCss(color);
    context.stroke();
  }

  /**
   * 回放目标无关显示列表；用于底纹 tile。
   *
   * @param entry 目标画布条目。
   * @param list 显示列表。
   * @param depth 嵌套 pattern 深度。
   * @param baseMatrix 回放前已应用的基准变换（tile 像素缩放）。
   */
  private replayDisplayList(
    entry: CanvasFactoryEntry,
    list: DisplayList,
    depth: number,
    baseMatrix: Matrix,
  ): void {
    const context = entry.context;
    const state: DrawState = {
      ctm: baseMatrix,
      alpha: 1,
      composite: 'source-over',
      clipDepth: 0,
    };
    const stack: DrawState[] = [];
    const path = new PathRecorder();

    for (const command of list.commands) {
      switch (command.op) {
        case 'save':
          context.save();
          stack.push({ ...state });
          break;
        case 'restore':
          if (stack.length > 0) {
            context.restore();
            Object.assign(state, stack.pop()!);
          }
          break;
        case 'setTransform': {
          const ctm = multiplyMatrix(baseMatrix, command.matrix);
          state.ctm = ctm;
          context.setTransform(ctm[0], ctm[1], ctm[2], ctm[3], ctm[4], ctm[5]);
          break;
        }
        case 'transform':
          state.ctm = multiplyMatrix(state.ctm, command.matrix);
          context.transform(
            command.matrix[0],
            command.matrix[1],
            command.matrix[2],
            command.matrix[3],
            command.matrix[4],
            command.matrix[5],
          );
          break;
        case 'translate':
          state.ctm = translateMatrix(state.ctm, command.x, command.y);
          context.translate(command.x, command.y);
          break;
        case 'multiplyAlpha':
          state.alpha = clampUnit(state.alpha * clampUnit(command.alpha));
          context.globalAlpha = state.alpha;
          break;
        case 'beginPath':
          path.begin();
          context.beginPath();
          break;
        case 'moveTo':
          path.moveTo(command.x, command.y);
          context.moveTo(command.x, command.y);
          break;
        case 'lineTo':
          path.lineTo(command.x, command.y);
          context.lineTo(command.x, command.y);
          break;
        case 'quadraticCurveTo':
          path.quadraticCurveTo(command.cpx, command.cpy, command.x, command.y);
          context.quadraticCurveTo(command.cpx, command.cpy, command.x, command.y);
          break;
        case 'cubicCurveTo':
          path.cubicCurveTo(
            command.cp1x,
            command.cp1y,
            command.cp2x,
            command.cp2y,
            command.x,
            command.y,
          );
          context.bezierCurveTo(
            command.cp1x,
            command.cp1y,
            command.cp2x,
            command.cp2y,
            command.x,
            command.y,
          );
          break;
        case 'rect':
          path.rect(command.x, command.y, command.w, command.h);
          context.rect(command.x, command.y, command.w, command.h);
          break;
        case 'closePath':
          path.closePath();
          context.closePath();
          break;
        case 'clip':
          context.clip(command.rule);
          state.clipDepth += 1;
          break;
        case 'fill':
          applyState(context, state);
          this.fillWithPaint(context, state, command.paint, command.rule, path, depth);
          break;
        case 'stroke':
          applyState(context, state);
          applyStrokeStyle(context, command.style, state.ctm);
          this.strokeWithPaint(context, state, command.paint, path, command.style);
          break;
        case 'drawImage': {
          const image = this.resolveImage(command.image);
          const mask = command.mask ? this.resolveImage(command.mask) : null;
          applyState(context, state);
          this.drawImageEntry(
            context,
            state,
            image,
            command.transform,
            command.alpha,
            command.smoothing,
            mask,
          );
          break;
        }
        case 'clear':
          context.save();
          context.setTransform(1, 0, 0, 1, 0, 0);
          context.clearRect(0, 0, context.canvas.width, context.canvas.height);
          context.restore();
          break;
      }
    }
  }
}

/**
 * 把状态应用到上下文。
 *
 * @param context 目标上下文。
 * @param state 绘制状态。
 */
function applyState(context: CanvasRenderingContext2DLike, state: DrawState): void {
  context.globalAlpha = clampUnit(state.alpha);
  context.globalCompositeOperation = state.composite;
}

/**
 * 应用描边样式。
 *
 * @param context 目标上下文。
 * @param style 最终线型。
 * @param ctm 当前变换，用于 hairline 线宽换算。
 */
function applyStrokeStyle(
  context: CanvasRenderingContext2DLike,
  style: DrawStyle,
  ctm: Matrix,
): void {
  const determinant = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
  const deviceScale = Math.sqrt(Number.isFinite(determinant) ? determinant : 1);
  context.lineWidth = style.lineWidth > 0 ? style.lineWidth : deviceScale > 0 ? 1 / deviceScale : 1;
  context.lineCap =
    style.lineCap === 'Round' ? 'round' : style.lineCap === 'Square' ? 'square' : 'butt';
  context.lineJoin =
    style.lineJoin === 'Round' ? 'round' : style.lineJoin === 'Bevel' ? 'bevel' : 'miter';
  context.miterLimit =
    Number.isFinite(style.miterLimit) && style.miterLimit > 0 ? style.miterLimit : 10;
  context.setLineDash(style.dashPattern.length > 0 ? style.dashPattern.slice() : []);
  const withDashOffset = context as CanvasRenderingContext2DLike & { lineDashOffset?: number };
  if ('lineDashOffset' in withDashOffset) {
    withDashOffset.lineDashOffset = style.dashOffset;
  }
}

/**
 * 计算渐变需要裁剪的端点。
 *
 * @param spec 轴向渐变描述。
 * @returns 是否需要起点/终点裁剪。
 */
function gradientBand(spec: AxialGradientSpec): {
  needStart: boolean;
  needEnd: boolean;
} {
  switch (spec.extend) {
    case 0:
      return { needStart: true, needEnd: true };
    case 1:
      // 标准 Extend=1：只接受 t≤1，起点外侧按起始色延伸。
      return { needStart: false, needEnd: true };
    case 2:
      // 标准 Extend=2：只接受 t≥0，终点外侧按结束色延伸。
      return { needStart: true, needEnd: false };
    default:
      return { needStart: false, needEnd: false };
  }
}

/**
 * 裁剪渐变允许的 band。
 *
 * @param context 目标上下文。
 * @param spec 轴向渐变描述。
 * @param bounds 当前路径边界（用户空间）。
 * @param needStart 是否裁剪 t<0。
 * @param needEnd 是否裁剪 t>1。
 */
function applyGradientBand(
  context: CanvasRenderingContext2DLike,
  spec: AxialGradientSpec,
  bounds: Box | null,
  needStart: boolean,
  needEnd: boolean,
): void {
  const dx = spec.end.x - spec.start.x;
  const dy = spec.end.y - spec.start.y;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length < 1e-9) return;
  const ux = dx / length;
  const uy = dy / length;
  const nx = -uy;
  const ny = ux;
  const extent = Math.max(bounds?.w ?? 0, bounds?.h ?? 0) * 4 + length * 4 + 1024;
  if (needStart) {
    clipHalfPlane(context, spec.start, ux, uy, nx, ny, 1, extent);
  }
  if (needEnd) {
    clipHalfPlane(context, spec.end, ux, uy, nx, ny, -1, extent);
  }
}

/**
 * 用一条垂直于渐变轴的半平面裁剪上下文。
 *
 * @param context 目标上下文。
 * @param point 半平面经过的点。
 * @param ux 轴单位向量 X。
 * @param uy 轴单位向量 Y。
 * @param nx 法线 X。
 * @param ny 法线 Y。
 * @param direction 1=保留沿轴正方向，-1=保留沿轴负方向。
 * @param extent 裁剪矩形半边长，用户空间单位。
 */
function clipHalfPlane(
  context: CanvasRenderingContext2DLike,
  point: { x: number; y: number },
  ux: number,
  uy: number,
  nx: number,
  ny: number,
  direction: 1 | -1,
  extent: number,
): void {
  const farX = point.x + ux * extent * direction;
  const farY = point.y + uy * extent * direction;
  context.beginPath();
  context.moveTo(point.x - nx * extent, point.y - ny * extent);
  context.lineTo(farX - nx * extent, farY - ny * extent);
  context.lineTo(farX + nx * extent, farY + ny * extent);
  context.lineTo(point.x + nx * extent, point.y + ny * extent);
  context.closePath();
  context.clip('nonzero');
}

/**
 * 把渐变 Paint 画满一整个离屏画布（用于描边掩码的渐变层）。
 *
 * 轴向渐变直接创建 Canvas 线性渐变；径向渐变交给 `fillWithRadial` 的软件光栅化。
 * 采样范围取 `strokeBounds`（路径 bbox 外扩线宽），保证 Repeat/Reflect 在描边像素上
 * 仍有完整周期，而不是在路径外侧被 clamp 成端点色。
 *
 * @param layer 渐变层上下文，矩阵已设为 `localMatrix`。
 * @param localMatrix 用户空间 → 渐变层像素的矩阵。
 * @param spec 渐变描述；坐标位于当前用户空间（通常 mm）。
 * @param area 渐变采样范围，当前用户空间单位（通常 mm）。
 * @param width 渐变层宽，像素。
 * @param height 渐变层高，像素。
 */
function drawGradientLayer(
  layer: CanvasRenderingContext2DLike,
  localMatrix: Matrix,
  spec: GradientSpec,
  area: Box,
  width: number,
  height: number,
): void {
  if (spec.kind === 'radial') {
    fillRadialOnLayer(layer, localMatrix, spec, width, height);
    return;
  }
  // 渐变按「当前用户空间」创建：它绑定的是创建时的 CTM，因此必须先设置好矩阵再用它填充。
  const gradient = createAxialGradient(layer, spec, area);
  const band = gradientBand(spec);
  layer.save();
  if (gradient && (band.needStart || band.needEnd)) {
    // Extend=0/1/2 的 band 裁剪与填充一致，同样作用于描边像素。
    applyGradientBand(layer, spec, area, band.needStart, band.needEnd);
  }
  layer.fillStyle = gradient ?? averageColorCss(spec.segments);
  // 铺满整块离屏画布：渐变对象绑定创建时的 CTM，铺底范围必须换算回该坐标系，
  // 直接填 0..width 在旋转/缩放下只会覆盖画布一角。
  const inverse = invertMatrix(localMatrix);
  if (inverse) {
    const corners = [
      transformPoint(inverse, { x: 0, y: 0 }),
      transformPoint(inverse, { x: width, y: 0 }),
      transformPoint(inverse, { x: 0, y: height }),
      transformPoint(inverse, { x: width, y: height }),
    ];
    const minX = Math.min(...corners.map((corner) => corner.x));
    const minY = Math.min(...corners.map((corner) => corner.y));
    const maxX = Math.max(...corners.map((corner) => corner.x));
    const maxY = Math.max(...corners.map((corner) => corner.y));
    layer.fillRect(minX, minY, maxX - minX, maxY - minY);
  } else {
    layer.fillRect(area.x, area.y, area.w, area.h);
  }
  layer.restore();
}

/**
 * 把径向渐变光栅化后写入离屏渐变层。
 *
 * @param layer 渐变层上下文。
 * @param localMatrix 用户空间 → 渐变层像素的矩阵。
 * @param spec 径向渐变描述；坐标与半径位于当前用户空间（通常 mm），角度单位度。
 * @param width 渐变层宽，像素。
 * @param height 渐变层高，像素。
 */
function fillRadialOnLayer(
  layer: CanvasRenderingContext2DLike,
  localMatrix: Matrix,
  spec: RadialGradientSpec,
  width: number,
  height: number,
): void {
  if (typeof layer.createImageData !== 'function' || typeof layer.putImageData !== 'function') {
    layer.fillStyle = averageColorCss(spec.segments);
    layer.fillRect(0, 0, width, height);
    return;
  }
  const raster = rasterizeRadialShadingDevice({
    spec,
    matrix: localMatrix,
    width,
    height,
    maxPixels: STROKE_MASK_MAX_PIXELS,
  });
  const imageData = layer.createImageData(raster.width, raster.height);
  imageData.data.set(raster.data);
  layer.setTransform(1, 0, 0, 1, 0, 0);
  layer.putImageData(imageData, 0, 0);
}

/**
 * 计算矩阵平均缩放系数（面积比开方），用于把用户空间长度换算成像素。
 *
 * @param matrix 用户空间 → 设备像素的矩阵。
 * @returns 平均缩放系数（无量纲）；矩阵退化时返回 1。
 */
function matrixScale(matrix: Matrix): number {
  const determinant = Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]);
  return Number.isFinite(determinant) && determinant > 0 ? Math.sqrt(determinant) : 1;
}

/**
 * 把用户空间长度按矩阵换算成设备像素长度。
 *
 * @param matrix 用户空间 → 设备像素的矩阵。
 * @param length 长度，当前用户空间单位（通常 mm）。
 * @returns 长度，像素。
 */
function transformRadius(matrix: Matrix, length: number): number {
  return length * matrixScale(matrix);
}

/**
 * 解析 `rgba(r,g,b,a)` 字符串。
 *
 * @param css `rgba(r,g,b,a)` 形式的颜色；a 为 0..1。
 * @returns RGBA8；解析失败时返回透明。
 */
function parseRgbaCss(css: string): Rgba {
  const match = /rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/.exec(
    css,
  );
  if (!match) return TRANSPARENT;
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: Math.round(Number(match[4]) * 255),
  };
}

/**
 * 创建轴向渐变。
 *
 * @param context 目标上下文。
 * @param spec 轴向渐变描述。
 * @param bounds 当前路径边界，用于 Repeat/Reflect 的扩展范围。
 * @returns Canvas 渐变；退化时返回 null。
 */
function createAxialGradient(
  context: CanvasRenderingContext2DLike,
  spec: AxialGradientSpec,
  bounds: Box | null,
): ReturnType<CanvasRenderingContext2DLike['createLinearGradient']> | null {
  const segments = spec.segments;
  if (!segments || segments.length === 0) return null;
  const dx = spec.end.x - spec.start.x;
  const dy = spec.end.y - spec.start.y;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length < 1e-9) return null;

  // Stop 的 MapUnit 展开由样式/绑定层（render/paint.ts resolveAxialGradient）负责，
  // 它产出覆盖整条轴线的 position∈[0,1] 最终 stop。渲染器只有在拿到**未展开** stop
  // （直接构造 ResolvedPaint 的调用方）时才自行按 MapUnit 展开，判据是「非 Direct 且
  // stop 的间距没有体现 MapUnit 周期」。两处都展开会造成周期被压缩为 1/periods。
  const mapUnit = spec.mapUnit && spec.mapUnit > 0 ? spec.mapUnit : length;
  const expanded =
    spec.mapType === 'Direct' || isMapUnitExpanded(segments, length, mapUnit);
  const axisEnd = expanded
    ? spec.end
    : extendAxis(spec, length, bounds, mapUnit);
  const gradient = context.createLinearGradient(
    spec.start.x,
    spec.start.y,
    axisEnd.x,
    axisEnd.y,
  );
  if (expanded) {
    for (const segment of segments) {
      gradient.addColorStop(clamp01(segment.position), rgbaToCss(segment.color));
    }
    return gradient;
  }
  // 未展开：把原始 stop 按 MapUnit 的周期数重铺（Repeat 正向、Reflect 镜像）。
  return addPeriodStops(gradient, segments, length, mapUnit, spec.mapType);
}

/**
 * 判断 stop 列表是否已按 MapUnit 展开到整条轴线。
 *
 * 上游展开后，相邻 stop 的最小间距应等于 `MapUnit / 轴长`（归一化后的周期长度）；
 * 若最小间距明显更大，说明是未展开的原始 stop，需要渲染器展开。
 *
 * @param segments 渐变 stop。
 * @param axisLength 轴线长度，用户空间单位。
 * @param mapUnit 一个渐变区间的长度，用户空间单位。
 * @returns 是否已展开。
 */
function isMapUnitExpanded(
  segments: readonly { position: number }[],
  axisLength: number,
  mapUnit: number,
): boolean {
  // 至少两个周期才算「已展开」；单个区间（最小 stop 间距≈1）说明是原始 stop。
  if (segments.length <= 1 || mapUnit <= 0 || axisLength <= 0) return false;
  const period = mapUnit / axisLength;
  if (!Number.isFinite(period) || period <= 0 || period >= 1) return false;
  if (axisLength / mapUnit <= 1.5) return false;
  let smallest = Infinity;
  for (let index = 1; index < segments.length; index += 1) {
    const gap = segments[index]!.position - segments[index - 1]!.position;
    if (gap > 1e-9) smallest = Math.min(smallest, gap);
  }
  return Number.isFinite(smallest) && smallest <= period * 1.5;
}

/**
 * 计算 Repeat/Reflect 需要覆盖到的轴线终点。
 *
 * @param spec 轴向渐变描述。
 * @param length 轴线长度，用户空间单位。
 * @param bounds 当前路径边界，用户空间单位。
 * @param mapUnit 一个渐变区间的长度，用户空间单位。
 * @returns 轴线终点坐标。
 */
function extendAxis(
  spec: AxialGradientSpec,
  length: number,
  bounds: Box | null,
  mapUnit: number,
): { x: number; y: number } {
  const ux = (spec.end.x - spec.start.x) / length;
  const uy = (spec.end.y - spec.start.y) / length;
  // 需要覆盖的轴向范围：轴线终点到路径 bbox 在轴方向上的最远投影。
  const corners = bounds
    ? [
        { x: bounds.x, y: bounds.y },
        { x: bounds.x + bounds.w, y: bounds.y },
        { x: bounds.x, y: bounds.y + bounds.h },
        { x: bounds.x + bounds.w, y: bounds.y + bounds.h },
      ]
    : [{ x: spec.end.x, y: spec.end.y }];
  let longest = length;
  for (const corner of corners) {
    const projection = (corner.x - spec.start.x) * ux + (corner.y - spec.start.y) * uy;
    if (Number.isFinite(projection)) longest = Math.max(longest, projection);
  }
  const periods = Math.max(1, Math.ceil(longest / mapUnit));
  return {
    x: spec.start.x + ux * mapUnit * periods,
    y: spec.start.y + uy * mapUnit * periods,
  };
}

/**
 * 把未展开的 stop 按 MapUnit 周期重铺到整条渐变轴。
 *
 * @param gradient Canvas 线性渐变。
 * @param segments 原始 stop，position∈[0,1] 表示一个区间内的位置。
 * @param axisLength 轴线长度，用户空间单位。
 * @param mapUnit 一个渐变区间的长度，用户空间单位。
 * @param mapType 映射方式。
 * @returns 同一个渐变对象。
 */
function addPeriodStops(
  gradient: ReturnType<CanvasRenderingContext2DLike['createLinearGradient']>,
  segments: readonly { position: number; color: Rgba }[],
  axisLength: number,
  mapUnit: number,
  mapType: AxialGradientSpec['mapType'],
): ReturnType<CanvasRenderingContext2DLike['createLinearGradient']> {
  if (mapType === 'Direct') return gradient;
  const periods = Math.min(512, Math.max(1, axisLength / mapUnit));
  for (let period = 0; period < periods; period += 1) {
    const reflect = mapType === 'Reflect' && Math.round(period) % 2 === 1;
    for (const segment of segments) {
      const position = reflect ? 1 - segment.position : segment.position;
      gradient.addColorStop(clamp01((period + position) / periods), rgbaToCss(segment.color));
    }
  }
  return gradient;
}

/**
 * 尝试给 CanvasPattern 设置变换。
 *
 * @param pattern CanvasPattern。
 * @param matrix tile 空间 → 对象空间的矩阵。
 * @returns 是否成功；不支持时返回 false，由调用方改为手动平铺。
 */
function applyPatternTransform(
  pattern: { setTransform?(matrix: unknown): void },
  matrix: Matrix,
): boolean {
  if (typeof pattern.setTransform !== 'function') return false;
  const [a, b, c, d, e, f] = matrix;
  try {
    pattern.setTransform({ a, b, c, d, e, f });
    return true;
  } catch {
    try {
      const domMatrix = (globalThis as { DOMMatrix?: new (init: number[]) => unknown }).DOMMatrix;
      if (domMatrix) {
        pattern.setTransform(new domMatrix([a, b, c, d, e, f]));
        return true;
      }
    } catch {
      // 回退手动平铺。
    }
    return false;
  }
}

/**
 * 估算显示列表的主色，用于 v1 底纹降级。
 *
 * @param list 显示列表。
 * @returns 估算颜色；没有可识别颜色时返回透明。
 */
function estimateDisplayListColor(list: DisplayList | undefined): Rgba {
  if (!list) return TRANSPARENT;
  for (const command of list.commands) {
    if (command.op === 'fill' || command.op === 'stroke') {
      const paint = command.paint;
      if (paint.kind === 'color') return paint.rgba;
      if (paint.kind === 'gradient') {
        return paint.spec.segments[0]?.color ?? TRANSPARENT;
      }
      if (paint.kind === 'shading') {
        return paint.spec.points[0]?.color ?? TRANSPARENT;
      }
    }
  }
  return TRANSPARENT;
}

/**
 * 计算渐变段的平均色。
 *
 * @param segments 渐变段。
 * @returns 平均色。
 */
function averageColorCss(segments: { color: Rgba }[]): string {
  if (!segments || segments.length === 0) return 'rgba(0,0,0,0)';
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (const segment of segments) {
    r += segment.color.r;
    g += segment.color.g;
    b += segment.color.b;
    a += segment.color.a;
  }
  const count = segments.length;
  return rgbaToCss({ r: r / count, g: g / count, b: b / count, a: a / count });
}

/**
 * 计算径向渐变的平均色，用于径向渐变描边降级。
 *
 * @param spec 径向渐变描述。
 * @returns 平均色；无颜色段时返回透明。
 */
function averageRadialColor(spec: RadialGradientSpec): Rgba {
  const segments = spec.segments;
  if (!segments || segments.length === 0) return TRANSPARENT;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (const segment of segments) {
    r += segment.color.r;
    g += segment.color.g;
    b += segment.color.b;
    a += segment.color.a;
  }
  const count = segments.length;
  return { r: r / count, g: g / count, b: b / count, a: a / count };
}

/**
 * 计算网格顶点的平均色。
 *
 * @param spec 网格渐变描述。
 * @returns 平均色。
 */
function averageMeshColor(spec: MeshShadingSpec): Rgba {
  const points = spec.points;
  if (!points || points.length === 0) return TRANSPARENT;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (const point of points) {
    r += point.color.r;
    g += point.color.g;
    b += point.color.b;
    a += point.color.a;
  }
  const count = points.length;
  return { r: r / count, g: g / count, b: b / count, a: a / count };
}

/**
 * 把 RGBA 转成 CSS 颜色字符串。
 *
 * @param color RGBA 颜色，通道 0..255。
 * @returns `rgba(r,g,b,a)` 字符串。
 */
function rgbaToCss(color: Rgba): string {
  const r = clampChannel(color.r);
  const g = clampChannel(color.g);
  const b = clampChannel(color.b);
  const a = Math.round(clampChannel(color.a)) / 255;
  return `rgba(${r},${g},${b},${Number(a.toFixed(4))})`;
}

/**
 * 通道值 clamp 到 0..255 的整数。
 *
 * @param value 通道值。
 * @returns 0..255 的整数。
 */
function clampChannel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * clamp 到 0..1。
 *
 * @param value 输入值。
 * @returns 0..1。
 */
function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * clamp 到 0..1。
 *
 * @param value 输入值。
 * @returns 0..1。
 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * 判断是否 RGBA 像素数据。
 *
 * @param value 待判断值。
 * @returns 是否为 ImageDataLike。
 */
function isImageDataLike(value: unknown): value is ImageDataLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ImageDataLike>;
  return (
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    candidate.data instanceof Uint8ClampedArray
  );
}

/**
 * 判断两个数是否近似相等。
 *
 * @param a 数值 A。
 * @param b 数值 B。
 * @returns 相对误差小于 1e-6 时返回 true。
 */
function approx(a: number, b: number): boolean {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= scale * 1e-6;
}

/**
 * 判断矩阵是否近似单位矩阵。
 *
 * @param matrix 待判断矩阵。
 * @returns 是否为 identity。
 */
function isIdentityMatrix(matrix: Matrix): boolean {
  return (
    approx(matrix[0], 1) &&
    approx(matrix[1], 0) &&
    approx(matrix[2], 0) &&
    approx(matrix[3], 1) &&
    approx(matrix[4], 0) &&
    approx(matrix[5], 0)
  );
}