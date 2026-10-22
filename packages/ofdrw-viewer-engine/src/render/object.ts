/**
 * 对象绘制分发。
 *
 * 严格按设计方案 10.3：save → Boundary translate/clip → Clips（CTM 前）→ CTM →
 * multiplyAlpha → 按 kind 分发 → restore（finally）。对象样式来自准备阶段结算的
 * `WeakMap`；本模块不解析 DrawParam、不查 XML，只消费模型与绘制资源。
 */

import type {
  Box,
  DecodedImage,
  DrawStyle,
  FillRule,
  ImageHandle,
  Matrix,
  ResolvedPaint,
  Viewport,
} from '../common/types';
import type {
  CompositeObject,
  GraphicUnitBase,
  ImageObject,
  IndependentBlock,
  PageObject,
  PageBlock,
  PreparedPage,
  ResourceId,
  TextObject,
} from '../model/types';
import type {
  CanvasRenderingContext2DLike,
  CompositeMode,
  GroupOptions,
  Renderer,
} from '../renderer/types';
import type { ResolvedStyle } from '../style/types';
import type { PreparedPageBundle } from './prepare';
import type { PaintBinder } from './paint';
import { applyClips } from './clip';
import { DisplayListBuilder, replayDisplayList } from './display-list';
import { drawImageObject } from './image';
import type { ImageSubstitutionMode } from './image';
import { drawPathObject } from './path';
import { buildTextPath, drawTextObject } from './text';
import { IDENTITY_MATRIX, multiplyMatrix, normalizeBox, translateMatrix } from '../common/matrix';

/** 独立块内容最大递归深度（PageBlock 规则）。 */
export const MAX_OBJECT_BLOCK_DEPTH = 32;

/** 已结算样式的稳定缓存键；按对象身份分配，同一准备周期内稳定。 */
const RESOLVED_STYLE_KEYS = new WeakMap<ResolvedStyle, string>();
let resolvedStyleKeySequence = 0;

/**
 * 取已结算样式的缓存键。
 *
 * @param style 准备阶段结算出的最终样式。
 * @returns 稳定字符串键（在同一进程内单调递增）。
 */
export function resolvedStyleCacheKey(style: ResolvedStyle): string {
  let key = RESOLVED_STYLE_KEYS.get(style);
  if (!key) {
    resolvedStyleKeySequence += 1;
    key = `s${resolvedStyleKeySequence}`;
    RESOLVED_STYLE_KEYS.set(style, key);
  }
  return key;
}

/**
 * 复合独立块的 variant 键：资源 ID + styleRoot（内含 DrawParam 结算结果）。
 *
 * @param id 复合资源 ID。
 * @param style 引用该复合对象的已结算样式。
 * @returns 块缓存键。
 */
export function compositeBlockCacheKey(id: string, style: ResolvedStyle): string {
  return `composite:${id}:${resolvedStyleCacheKey(style)}`;
}

/** 对象绘制上下文。 */
export interface DrawObjectContext {
  /** 准备阶段产物（页面/模板/字体/图片/独立块）。 */
  prepared: PreparedPageBundle;
  renderer: Renderer;
  binder: PaintBinder;
  /** 当前对象的样式映射；页面绘制用 `prepared.page.styles`，块递归用块内样式。 */
  styles: WeakMap<GraphicUnitBase, ResolvedStyle>;
  /** 当前空间 → device 的矩阵（页面为 M_page）。 */
  deviceMatrix: Matrix;
  /** 图片缺 CTM 时是否严格 identity，默认 true。 */
  strictImageCtm: boolean;
  /** 输出精度，单位 DPI；用于替换图选择与 warning。 */
  dpi?: number;
  /** 页索引，从 0 开始；仅用于 warning。 */
  pageIndex?: number;
  /** 是否把图片句柄记录为准备阶段占位句柄。 */
  deferredImages?: boolean;
  /** 替换图选择模式，默认 auto。 */
  substitutionMode?: ImageSubstitutionMode;
  /** 设置当前对象空间 → device 矩阵；供底纹 RelativeTo=Page 使用。 */
  setObjectMatrix?: (matrix: Matrix | null) => void;
  /** 构建显示列表时的回调；存在时 composite 走 flatten/动态标记而不是立即绘制。 */
  build?: BlockBuildCallbacks;
  /** 取消信号；每个对象检查一次。 */
  signal?: AbortSignal;
  /** warning 回调；对象失败后继续下一个对象。 */
  onWarning?: (code: string, message: string, objectId?: string) => void;
}

/** 构建独立块显示列表所需的回调。 */
export interface BlockBuildCallbacks {
  /** 取已构建的复合块；用于 alpha=255 时 flatten。 */
  resolveComposite(object: CompositeObject): IndependentBlock | undefined;
  /** 当前块需要绘制期递归（嵌套 composite 需要 group）。 */
  markDynamic(): void;
}

/** 图片占位计划；只在 render 内部使用，不进入公共类型。 */
interface DeferredImagePlan {
  object: ImageObject;
  role: 'main' | 'substitution' | 'mask';
  /** 构建期替换图选择模式；绘制期按该模式物化。 */
  mode: ImageSubstitutionMode;
}

/** 占位句柄 → 图片计划。 */
const DEFERRED_IMAGE_PLANS = new WeakMap<ImageHandle, DeferredImagePlan>();

/** 每个渲染器已物化的图片句柄。 */
const IMAGE_HANDLES = new WeakMap<Renderer, Map<string, ImageHandle>>();

/** 块内样式；绘制期递归需要按对象取样式。 */
const BLOCK_STYLES = new WeakMap<IndependentBlock, WeakMap<GraphicUnitBase, ResolvedStyle>>();

/** 需要绘制期递归的块。 */
const DYNAMIC_BLOCKS = new WeakSet<IndependentBlock>();

/**
 * 记录块内对象样式。
 *
 * @param block 已构建独立块。
 * @param styles 块内样式映射。
 */
export function setBlockStyles(
  block: IndependentBlock,
  styles: WeakMap<GraphicUnitBase, ResolvedStyle>,
): void {
  BLOCK_STYLES.set(block, styles);
}

/**
 * 取块内对象样式。
 *
 * @param block 独立块。
 * @returns 块内样式映射或 undefined。
 */
export function getBlockStyles(
  block: IndependentBlock,
): WeakMap<GraphicUnitBase, ResolvedStyle> | undefined {
  return BLOCK_STYLES.get(block);
}

/**
 * 标记块包含必须绘制期递归的嵌套 group。
 *
 * @param block 独立块。
 */
export function markBlockDynamic(block: IndependentBlock): void {
  DYNAMIC_BLOCKS.add(block);
}

/**
 * 判断块是否需要绘制期递归（不能直接回放显示列表）。
 *
 * @param block 独立块。
 * @returns 需要递归时返回 true。
 */
export function isBlockDynamic(block: IndependentBlock): boolean {
  return DYNAMIC_BLOCKS.has(block);
}

/**
 * 创建一个准备阶段的图片占位句柄。
 *
 * @param object 图片来源对象。
 * @param image 已解码图片（只取宽高，单位像素）。
 * @param role 句柄用途。
 * @returns 带有效宽高的占位句柄。
 */
export function createDeferredImageHandle(
  object: ImageObject,
  image: DecodedImage,
  role: DeferredImagePlan['role'],
  mode: ImageSubstitutionMode = 'auto',
): ImageHandle {
  const handle: ImageHandle = {
    width: Math.max(1, Math.ceil(image.width)),
    height: Math.max(1, Math.ceil(image.height)),
  };
  DEFERRED_IMAGE_PLANS.set(handle, { object, role, mode });
  return handle;
}

/**
 * 判断句柄是否为准备阶段占位句柄。
 *
 * @param handle 图片句柄。
 * @returns 占位句柄返回 true。
 */
export function isDeferredImageHandle(handle: ImageHandle): boolean {
  return DEFERRED_IMAGE_PLANS.has(handle);
}

/**
 * 取渲染器缓存中的图片句柄；同一资源只创建一次。
 *
 * @param renderer 目标渲染器。
 * @param resourceId 图片资源 ID。
 * @param image 解码结果。
 * @returns 渲染器内部句柄。
 */
function getImageHandle(
  renderer: Renderer,
  resourceId: ResourceId,
  image: DecodedImage,
): ImageHandle {
  let cache = IMAGE_HANDLES.get(renderer);
  if (!cache) {
    cache = new Map();
    IMAGE_HANDLES.set(renderer, cache);
  }
  const cached = cache.get(resourceId);
  if (cached) return cached;
  const handle = renderer.createImage(image);
  cache.set(resourceId, handle);
  return handle;
}

/**
 * 按 Substitution 规则选择主图/替换图资源。
 *
 * @param object 图片对象。
 * @param dpi 输出精度，单位 DPI。
 * @returns 选中的资源 ID。
 */
function selectImageResource(object: ImageObject, dpi: number): ResourceId {
  if (!object.substitution) return object.resourceId;
  if (dpi > 200) return object.substitution;
  return object.resourceId;
}

/**
 * 绘制期把显示列表中的占位句柄物化为当前渲染器的真实句柄。
 *
 * @param renderer 目标渲染器。
 * @param prepared 准备阶段产物。
 * @param handle 显示列表中的句柄。
 * @param role 主图或蒙版。
 * @param dpi 输出精度，单位 DPI。
 * @returns 可传给渲染器的句柄。
 */
export function resolveDisplayImage(
  renderer: Renderer,
  prepared: PreparedPageBundle,
  handle: ImageHandle,
  role: 'image' | 'mask',
  dpi: number,
): ImageHandle {
  const plan = DEFERRED_IMAGE_PLANS.get(handle);
  if (!plan) return handle;
  const object = plan.object;
  let resourceId: ResourceId;
  if (plan.role === 'mask' || role === 'mask') {
    if (!object.imageMask) return handle;
    resourceId = object.imageMask;
  } else if (plan.mode === 'always') {
    resourceId = object.substitution ?? object.resourceId;
  } else if (plan.mode === 'never') {
    resourceId = object.resourceId;
  } else {
    resourceId = selectImageResource(object, dpi);
  }
  const decoded = prepared.images.get(resourceId);
  if (!decoded) {
    throw new Error(`图片资源 ${resourceId} 未解码`);
  }
  return getImageHandle(renderer, resourceId, decoded);
}

/**
 * 按顺序绘制一组对象。
 *
 * @param context 绘制上下文。
 * @param objects 对象列表。
 */
export function drawObjects(context: DrawObjectContext, objects: readonly PageObject[]): void {
  for (const object of objects) {
    if (context.signal?.aborted) return;
    if (object.kind === 'block') {
      drawPageBlock(context, object, MAX_OBJECT_BLOCK_DEPTH);
      continue;
    }
    const style = context.styles.get(object);
    if (!style) {
      context.onWarning?.(
        'W_UNSUPPORTED_PAINT',
        `对象 ${object.id ?? '(anonymous)'} 缺少结算样式，已跳过`,
        object.id,
      );
      continue;
    }
    drawObject(context, object, style);
  }
}

/**
 * 判断对象是否声明裁剪区受外部对象 CTM 影响。
 *
 * `Clips@TransFlag=true` 是兼容扩展：裁剪区在对象 CTM 之后应用；缺省/false
 * 保持标准对象空间路径，在对象 CTM 之前应用。
 *
 * @param object 图元对象。
 * @returns 存在 true 标记时返回 true。
 */
function clipsFollowObjectCtm(object: GraphicUnitBase): boolean {
  return (object.clips ?? []).some((clip) => clip.transFlag === true);
}

/**
 * 判断图片 Clips 是否使用图片 CTM 的逆矩阵编码。
 *
 * 标准 ImageObject 的 Clips 位于对象空间，必须在对象 CTM 之前应用；manual 等
 * 生产工具会把 Clips 预先乘上图片 CTM 的逆矩阵，使裁剪路径在页面坐标系中
 * 表达。若 Clips 面积矩阵与图片 CTM 的面积比在 0.2..5 内（矩阵互逆时约 1），
 * 则判定为逆矩阵编码。该兼容路径仅在未声明 TransFlag=true 时生效。
 *
 * @param object 图片对象。
 * @returns 需要在对象 CTM 之后应用 Clips 时返回 true。
 */
function imageClipsUseInverseCtm(object: ImageObject): boolean {
  if (!object.ctm || !object.clips || object.clips.length === 0) return false;
  const ctmDet = Math.abs(
    object.ctm[0] * object.ctm[3] - object.ctm[1] * object.ctm[2],
  );
  if (!(ctmDet > 0)) return false;
  let checked = 0;
  for (const clip of object.clips) {
    for (const area of clip.areas ?? []) {
      const localCtm = area.kind === 'path' ? area.path.ctm : area.text.ctm;
      const clipCtm = clip.ctm;
      const clipDet = clipCtm
        ? Math.abs(clipCtm[0] * clipCtm[3] - clipCtm[1] * clipCtm[2])
        : 1;
      const localDet = localCtm
        ? Math.abs(localCtm[0] * localCtm[3] - localCtm[1] * localCtm[2])
        : 1;
      if (!(clipDet > 0) || !(localDet > 0)) continue;
      const areaRatio = ctmDet * clipDet * localDet;
      if (areaRatio < 0.2 || areaRatio > 5) return false;
      checked += 1;
    }
  }
  return checked > 0;
}

/**
 * 兼容负宽 Boundary 归一化后的右对齐文本。
 *
 * GB/T 33190 要求 ST_Box 宽高大于 0；部分生产工具用
 * `Boundary="right y -w h"` + `TextCode X="-w"` 表示右对齐。模型层会把
 * 负宽归一化为左上角（x+w），此时对象空间原点应仍在右边界、裁剪区覆盖
 * [-w,0]，否则整列字形会落在裁剪区外。
 *
 * @param object 待绘制对象。
 * @param boundary 已归一化的对象外接矩形。
 * @returns 需要右边界锚定时的原点与裁剪起点；否则 undefined。
 */
function negativeBoundaryTextAnchor(
  object: PageObject,
  boundary: Box,
): { originX: number; clipX: number } | undefined {
  if (object.kind !== 'text' || !(boundary.w > 0)) return undefined;
  const codes = object.codes;
  if (codes.length === 0) return undefined;
  let minX = 0;
  let hasPositiveX = false;
  for (const code of codes) {
    const x = code.x ?? 0;
    minX = Math.min(minX, x);
    if (x > 0) hasPositiveX = true;
  }
  if (hasPositiveX || !(minX < 0)) return undefined;
  if (Math.abs(minX + boundary.w) > 1e-6) return undefined;
  return { originX: boundary.x + boundary.w, clipX: -boundary.w };
}

/**
 * 绘制单个对象/块。
 *
 * @param context 绘制上下文。
 * @param object 对象。
 * @param style 已结算样式；调用方应传当前样式映射中的值。
 */
export function drawObject(
  context: DrawObjectContext,
  object: PageObject,
  style: ResolvedStyle,
): void {
  if (object.kind === 'block') {
    drawPageBlock(context, object, MAX_OBJECT_BLOCK_DEPTH);
    return;
  }

  if (!object.visible || object.alpha === 0) return;
  const boundary = normalizeBox(object.boundary);
  if (!(boundary.w > 0) || !(boundary.h > 0)) {
    context.onWarning?.('W_ZERO_BOUNDARY', '对象 Boundary 宽高非正，已跳过', object.id);
    return;
  }
  if (boundary.x !== object.boundary.x || boundary.y !== object.boundary.y) {
    context.onWarning?.(
      'W_NEGATIVE_BOUNDARY',
      '对象 Boundary 宽高为负，已归一化到左上角',
      object.id,
    );
  }

  const textAnchor = negativeBoundaryTextAnchor(object, boundary);
  const originX = textAnchor?.originX ?? boundary.x;
  const objectMatrix = multiplyMatrix(
    multiplyMatrix(context.deviceMatrix, translateMatrix(IDENTITY_MATRIX, originX, boundary.y)),
    object.ctm ?? IDENTITY_MATRIX,
  );
  const { renderer } = context;
  const textPath = textPathProvider(context);
  // 标准对象空间的 Clips 在 CTM 之前；TransFlag=true 的兼容裁剪区在 CTM 之后。
  // 图片另有 manual 的逆 CTM 编码兼容路径，仅在未声明 true 时生效。
  const hasTransFlag = clipsFollowObjectCtm(object);
  const clipsAfterCtm =
    hasTransFlag ||
    (object.kind === 'image' && !hasTransFlag && imageClipsUseInverseCtm(object));
  const applyObjectClips = (): void => {
    applyClips(
      {
        renderer,
        ...(context.onWarning ? { onWarning: context.onWarning } : {}),
        textPath,
      },
      object.clips,
    );
  };
  renderer.save();
  try {
    renderer.translate(originX, boundary.y);
    renderer.beginPath();
    renderer.rect(textAnchor?.clipX ?? 0, 0, boundary.w, boundary.h);
    renderer.clip('nonzero');
    if (!clipsAfterCtm) applyObjectClips();
    if (object.ctm) renderer.transform(object.ctm);
    if (clipsAfterCtm) applyObjectClips();
    if (object.kind !== 'composite') {
      renderer.multiplyAlpha(object.alpha / 255);
    }
    context.setObjectMatrix?.(objectMatrix);

    switch (object.kind) {
      case 'path':
        drawPathObject(
          {
            renderer,
            binder: context.binder,
            ...(context.onWarning ? { onWarning: context.onWarning } : {}),
            ...(context.pageIndex !== undefined ? { pageIndex: context.pageIndex } : {}),
          },
          object,
          style,
        );
        break;
      case 'text':
        drawText(context, object, style);
        break;
      case 'image':
        drawImage(context, object, style);
        break;
      case 'composite':
        drawComposite(context, object, style, objectMatrix);
        break;
      default: {
        const exhaustive: never = object;
        void exhaustive;
      }
    }
  } catch (error) {
    context.onWarning?.(
      'W_UNSUPPORTED_PAINT',
      `对象绘制失败：${error instanceof Error ? error.message : String(error)}`,
      object.id,
    );
  } finally {
    context.setObjectMatrix?.(null);
    try {
      renderer.restore();
    } catch {
      // restore 失败不应阻断后续对象。
    }
  }
}

/**
 * 递归绘制 PageBlock；块本身没有边界/变换。
 *
 * @param context 绘制上下文。
 * @param block 页面块。
 * @param depth 剩余递归深度。
 */
function drawPageBlock(context: DrawObjectContext, block: PageBlock, depth: number): void {
  if (depth <= 0) {
    context.onWarning?.('W_COMPOSITE_DEPTH', 'PageBlock 递归深度超过上限，已跳过', block.id);
    return;
  }
  for (const child of block.children) {
    if (context.signal?.aborted) return;
    if (child.kind === 'block') {
      drawPageBlock(context, child, depth - 1);
      continue;
    }
    const style = context.styles.get(child);
    if (!style) {
      context.onWarning?.(
        'W_UNSUPPORTED_PAINT',
        `块内对象 ${child.id ?? '(anonymous)'} 缺少结算样式，已跳过`,
        child.id,
      );
      continue;
    }
    drawObject(context, child, style);
  }
}

/**
 * 创建文字裁剪轮廓提供者。
 *
 * @param context 绘制上下文。
 * @param style 当前对象样式。
 * @returns Text 裁剪轮廓函数；字体缺失时返回 undefined。
 */
function textPathProvider(
  context: DrawObjectContext,
): (text: TextObject) => ReturnType<typeof buildTextPath> {
  return (text) => {
    const faces = context.prepared.fonts.get(text.font);
    if (!faces) {
      context.onWarning?.('W_UNSUPPORTED_CLIP', `字体 ${text.font} 未加载，文字裁剪已忽略`, text.id);
      return [];
    }
    return buildTextPath(text, faces);
  };
}

/**
 * 绘制文字对象。
 *
 * @param context 绘制上下文。
 * @param object 文字对象。
 * @param style 已结算样式。
 */
function drawText(context: DrawObjectContext, object: TextObject, style: ResolvedStyle): void {
  const faces = context.prepared.fonts.get(object.font);
  if (!faces) {
    context.onWarning?.('W_FONT_MISSING', `字体 ${object.font} 未加载，已跳过文字`, object.id);
    return;
  }
  drawTextObject(
    {
      renderer: context.renderer,
      binder: context.binder,
      faces,
      ...(context.onWarning ? { onWarning: context.onWarning } : {}),
    },
    object,
    style,
  );
}

/**
 * 绘制图片对象。
 *
 * @param context 绘制上下文。
 * @param object 图片对象。
 * @param style 已结算样式。
 */
function drawImage(context: DrawObjectContext, object: ImageObject, style: ResolvedStyle): void {
  const decoded = context.prepared.images.get(object.resourceId);
  if (!decoded) {
    context.onWarning?.('W_IMAGE_DECODE', `图片 ${object.resourceId} 未解码，已跳过`, object.id);
    return;
  }
  const substitution = object.substitution
    ? context.prepared.images.get(object.substitution)
    : undefined;
  const mask = object.imageMask ? context.prepared.images.get(object.imageMask) : undefined;
  if (object.imageMask && !mask) {
    context.onWarning?.('W_IMAGE_DECODE', `图片蒙版 ${object.imageMask} 未解码，已忽略`, object.id);
  }

  const substitutionMode = context.substitutionMode ?? 'auto';
  const mainHandle = context.deferredImages
    ? createDeferredImageHandle(object, decoded, 'main', substitutionMode)
    : getImageHandle(context.renderer, object.resourceId, decoded);
  const substitutionHandle =
    context.deferredImages && substitution
      ? createDeferredImageHandle(object, substitution, 'substitution', substitutionMode)
      : substitution
        ? getImageHandle(context.renderer, object.substitution!, substitution)
        : undefined;
  const maskHandle =
    context.deferredImages && mask
      ? createDeferredImageHandle(object, mask, 'mask', substitutionMode)
      : mask
        ? getImageHandle(context.renderer, object.imageMask!, mask)
        : undefined;

  drawImageObject(
    {
      renderer: context.renderer,
      image: mainHandle,
      ...(maskHandle ? { mask: maskHandle } : {}),
      ...(substitutionHandle ? { substitutionImage: substitutionHandle } : {}),
      substitutionMode,
      dpi: context.dpi ?? 96,
      strictImageCtm: context.strictImageCtm,
      ...(context.onWarning ? { onWarning: context.onWarning } : {}),
    },
    object,
    style,
  );
}

/**
 * 绘制复合对象：块内容整体映射到对象空间。
 *
 * @param context 绘制上下文。
 * @param object 复合对象。
 * @param style 已结算样式。
 * @param objectMatrix 块空间 → device 的矩阵。
 */
function drawComposite(
  context: DrawObjectContext,
  object: CompositeObject,
  style: ResolvedStyle,
  objectMatrix: Matrix,
): void {
  if (context.build) {
    flattenComposite(context, object);
    return;
  }
  const block =
    context.prepared.blocks.get(compositeBlockCacheKey(object.resourceId, style)) ??
    context.prepared.blocks.get(object.resourceId);
  if (!block) {
    context.onWarning?.(
      'W_COMPOSITE_DEPTH',
      `复合资源 ${object.resourceId} 缺少独立块，已跳过`,
      object.id,
    );
    return;
  }
  drawBlock(
    {
      renderer: context.renderer,
      binder: context.binder,
      prepared: context.prepared,
      matrix: objectMatrix,
      alpha: object.alpha / 255,
      ...(context.substitutionMode ? { substitutionMode: context.substitutionMode } : {}),
      ...(context.setObjectMatrix ? { setObjectMatrix: context.setObjectMatrix } : {}),
      strictImageCtm: context.strictImageCtm,
      ...(context.dpi !== undefined ? { dpi: context.dpi } : {}),
      ...(context.onWarning ? { onWarning: context.onWarning } : {}),
    },
    block,
  );
}

/**
 * 构建阶段把 alpha=255 的嵌套 composite flatten 到父显示列表。
 *
 * @param context 绘制上下文。
 * @param object 复合对象。
 */
function flattenComposite(context: DrawObjectContext, object: CompositeObject): void {
  const child = context.build!.resolveComposite(object);
  if (!child || isBlockDynamic(child)) {
    context.build!.markDynamic();
    return;
  }
  if (object.alpha < 255) {
    // alpha 必须整体乘一次，不能拆成子命令；交给绘制期递归 group。
    context.build!.markDynamic();
    return;
  }
  // drawObject 已在分派前完成 Boundary 平移、裁剪与对象 CTM；这里只回放子块，
  // 否则 CompositeObject 的 CTM 会被重复应用（发票监制章右下红章缩小 1/0.3528）。
  replayDisplayList(context.renderer, child.displayList);
}

/**
 * 块绘制上下文。
 */
export interface BlockDrawResources {
  renderer: Renderer;
  binder: PaintBinder;
  prepared: PreparedPageBundle;
  /** 块空间 → device 矩阵，用于 group。 */
  matrix: Matrix;
  /** 组透明度 0..1；只在 group 结束时乘一次。 */
  alpha?: number;
  isolated?: boolean;
  composite?: CompositeMode;
  /** 替换图选择模式，默认 auto。 */
  substitutionMode?: ImageSubstitutionMode;
  /** 图片缺 CTM 时是否严格 identity。 */
  strictImageCtm?: boolean;
  /** 设置当前对象空间 → device 矩阵；供底纹 RelativeTo=Page 使用。 */
  setObjectMatrix?: (matrix: Matrix | null) => void;
  dpi?: number;
  onWarning?: (code: string, message: string, objectId?: string) => void;
}

/**
 * 绘制已准备独立块：裁剪块空间、按需开 group、回放显示列表。
 *
 * @param context 渲染器、binder、放置矩阵与组参数。
 * @param block 独立块。
 */
export function drawBlock(context: BlockDrawResources, block: IndependentBlock): void {
  const warn = context.onWarning;
  if (isBlockDynamic(block)) {
    drawDynamicBlock(context, block);
    return;
  }
  const { renderer } = context;
  if (!(block.space.width > 0) || !(block.space.height > 0)) {
    warn?.('W_ZERO_BOUNDARY', '独立块空间尺寸非正，已跳过', block.id);
    return;
  }
  const alpha = Math.max(0, Math.min(1, context.alpha ?? 1));
  if (alpha === 0) return;
  const needGroup = alpha < 1 || context.isolated === true || (context.composite ?? 'source-over') !== 'source-over';
  renderer.save();
  try {
    renderer.beginPath();
    renderer.rect(0, 0, block.space.width, block.space.height);
    renderer.clip('nonzero');
    if (needGroup) {
      renderer.beginGroup({
        bounds: { x: 0, y: 0, w: block.space.width, h: block.space.height },
        matrix: context.matrix,
        alpha,
        isolated: context.isolated ?? false,
        composite: context.composite ?? 'source-over',
      });
      try {
        replayDisplayList(renderer, block.displayList, (handle, role) =>
          resolveDisplayImage(renderer, context.prepared, handle, role, context.dpi ?? 96),
        );
      } finally {
        renderer.endGroup();
      }
    } else {
      replayDisplayList(renderer, block.displayList, (handle, role) =>
        resolveDisplayImage(renderer, context.prepared, handle, role, context.dpi ?? 96),
      );
    }
  } catch (error) {
    warn?.(
      'W_UNSUPPORTED_PAINT',
      `独立块回放失败：${error instanceof Error ? error.message : String(error)}`,
      block.id,
    );
  } finally {
    try {
      renderer.restore();
    } catch {
      // 忽略 restore 失败，继续后续块。
    }
  }
}

/**
 * 绘制含嵌套 group 的块：直接递归块内容，alpha 在 endGroup 一次应用。
 *
 * @param context 块绘制上下文。
 * @param block 独立块。
 */
function drawDynamicBlock(context: BlockDrawResources, block: IndependentBlock): void {
  const styles = getBlockStyles(block);
  if (!styles) {
    context.onWarning?.('W_UNSUPPORTED_PAINT', '动态块缺少样式，已跳过', block.id);
    return;
  }
  const alpha = Math.max(0, Math.min(1, context.alpha ?? 1));
  if (alpha === 0) return;
  const { renderer } = context;
  const groupNeeded =
    alpha < 1 || context.isolated === true || (context.composite ?? 'source-over') !== 'source-over';
  renderer.save();
  try {
    renderer.beginPath();
    renderer.rect(0, 0, block.space.width, block.space.height);
    renderer.clip('nonzero');
    if (groupNeeded) {
      renderer.beginGroup({
        bounds: { x: 0, y: 0, w: block.space.width, h: block.space.height },
        matrix: context.matrix,
        alpha,
        isolated: context.isolated ?? false,
        composite: context.composite ?? 'source-over',
      });
    }
    try {
      drawObjects(
        {
          prepared: context.prepared,
          renderer,
          binder: context.binder,
          styles,
          deviceMatrix: context.matrix,
          strictImageCtm: context.strictImageCtm ?? true,
          ...(context.substitutionMode ? { substitutionMode: context.substitutionMode } : {}),
          ...(context.setObjectMatrix ? { setObjectMatrix: context.setObjectMatrix } : {}),
          ...(context.dpi !== undefined ? { dpi: context.dpi } : {}),
          ...(context.onWarning ? { onWarning: context.onWarning } : {}),
        },
        block.content.children,
      );
    } finally {
      if (groupNeeded) renderer.endGroup();
    }
  } catch (error) {
    context.onWarning?.(
      'W_UNSUPPORTED_PAINT',
      `动态块绘制失败：${error instanceof Error ? error.message : String(error)}`,
      block.id,
    );
  } finally {
    try {
      renderer.restore();
    } catch {
      // 忽略 restore 失败。
    }
  }
}

/**
 * 构建独立块内容的显示列表。
 *
 * 不套用块放置变换；图片使用占位句柄，绘制期由 `resolveDisplayImage` 物化。
 *
 * @param space 块空间尺寸，单位 mm。
 * @param content 块内容。
 * @param context 构建上下文。
 * @returns 目标无关显示列表。
 */
export function buildBlockDisplayList(
  space: { width: number; height: number },
  content: PageBlock,
  context: {
    prepared: PreparedPageBundle;
    binder: PaintBinder;
    styles: WeakMap<GraphicUnitBase, ResolvedStyle>;
    strictImageCtm: boolean;
    substitutionMode?: ImageSubstitutionMode;
    dpi?: number;
    onWarning?: (code: string, message: string, objectId?: string) => void;
    resolveComposite(object: CompositeObject): IndependentBlock | undefined;
    markDynamic(): void;
  },
): import('../common/display-list').DisplayList {
  const builder = new DisplayListBuilder({ x: 0, y: 0, w: space.width, h: space.height });
  const renderer = new DisplayListRenderer(builder);
  const drawContext: DrawObjectContext = {
    prepared: context.prepared,
    renderer,
    binder: context.binder,
    styles: context.styles,
    deviceMatrix: IDENTITY_MATRIX,
    strictImageCtm: context.strictImageCtm,
    deferredImages: true,
    ...(context.substitutionMode ? { substitutionMode: context.substitutionMode } : {}),
    ...(context.dpi !== undefined ? { dpi: context.dpi } : {}),
    ...(context.onWarning ? { onWarning: context.onWarning } : {}),
    build: {
      resolveComposite: context.resolveComposite,
      markDynamic: context.markDynamic,
    },
  };
  drawObjects(drawContext, content.children);
  return builder.build();
}

/**
 * 只记录绘制命令的 Renderer 适配器；用于准备阶段构建显示列表。
 */
class DisplayListRenderer implements Renderer {
  /**
   * @param builder 目标显示列表构建器。
   */
  constructor(private readonly builder: DisplayListBuilder) {}

  /** 页面级操作在显示列表中无意义。 */
  beginPage(context: CanvasRenderingContext2DLike, viewport: Viewport): void {
    void context;
    void viewport;
  }

  /** 页面级操作在显示列表中无意义。 */
  endPage(): void {}

  save(): void {
    this.builder.save();
  }

  restore(): void {
    this.builder.restore();
  }

  setTransform(m: Matrix): void {
    this.builder.setTransform(m);
  }

  transform(m: Matrix): void {
    this.builder.transform(m);
  }

  translate(x: number, y: number): void {
    this.builder.translate(x, y);
  }

  multiplyAlpha(alpha: number): void {
    this.builder.multiplyAlpha(alpha);
  }

  clear(): void {
    this.builder.clear();
  }

  beginPath(): void {
    this.builder.beginPath();
  }

  moveTo(x: number, y: number): void {
    this.builder.moveTo(x, y);
  }

  lineTo(x: number, y: number): void {
    this.builder.lineTo(x, y);
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.builder.quadraticCurveTo(cpx, cpy, x, y);
  }

  cubicCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): void {
    this.builder.cubicCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.builder.rect(x, y, w, h);
  }

  closePath(): void {
    this.builder.closePath();
  }

  clip(rule: FillRule): void {
    this.builder.clip(rule);
  }

  fill(style: DrawStyle, paint: ResolvedPaint, rule: FillRule): void {
    this.builder.fill(style, paint, rule);
  }

  stroke(style: DrawStyle, paint: ResolvedPaint): void {
    this.builder.stroke(style, paint);
  }

  /** 构建期间不创建真实图片句柄；调用方应使用占位句柄。 */
  createImage(image: DecodedImage): ImageHandle {
    return { width: image.width, height: image.height };
  }

  drawImage(
    image: ImageHandle,
    transform: Matrix,
    alpha: number,
    smoothing: boolean,
    mask?: ImageHandle,
  ): void {
    this.builder.drawImage(image, transform, alpha, smoothing, mask);
  }

  /** 显示列表不支持 group；嵌套 group 由调用方标记为动态块。 */
  beginGroup(options: GroupOptions): void {
    throw new Error(`独立块显示列表不支持 group：${JSON.stringify(options.bounds)}`);
  }

  /** 显示列表不支持 group。 */
  endGroup(): void {
    throw new Error('独立块显示列表不支持 endGroup');
  }

  close(): void {}
}

/**
 * 从 PreparedPage 取样式；缺失时返回 undefined。
 *
 * @param prepared 准备阶段产物。
 * @param object 图元。
 * @returns 最终样式或 undefined。
 */
export function getPreparedStyle(
  prepared: PreparedPage,
  object: GraphicUnitBase,
): ResolvedStyle | undefined {
  return prepared.styles.get(object);
}

/**
 * 取对象包围盒（已归一化）；供准备阶段构建独立块时复用。
 *
 * @param boundary 原始边界。
 * @returns 归一化边界，单位与输入一致。
 */
export function normalizedBoundary(boundary: Box): Box {
  return normalizeBox(boundary);
}