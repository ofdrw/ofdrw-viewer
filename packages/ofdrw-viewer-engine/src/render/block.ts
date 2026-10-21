/**
 * 独立空间块构建与绘制。
 *
 * 注释/复合对象/底纹 cell 统一为 IndependentBlock；显示列表与放置分离，
 * 平移不改变缓存内容（设计方案 11.7）。块内容在构建阶段完成样式结算并记录为
 * 目标无关 DisplayList，绘制阶段只负责裁剪、group 与回放。
 */

import type { DisplayList } from '../common/display-list';
import type { Box, Matrix } from '../common/types';
import type { IndependentBlock, PageBlock } from '../model/types';
import type { ResolvedStyle } from '../style/types';
import type { CompositeMode, Renderer } from '../renderer/types';
import type { PaintBinder } from './paint';
import { IDENTITY_MATRIX } from '../common/matrix';
import { replayDisplayList } from './display-list';

/** 独立块最大递归深度（设计方案 9.4/11.7）。 */
export const MAX_BLOCK_DEPTH = 16;

/** 已构建显示列表的独立块；`displayList` 必填。 */
export type PreparedBlock = IndependentBlock & { displayList: DisplayList };

/** 独立块构建输入。 */
export interface BuildBlockInput {
  id?: string;
  source: IndependentBlock['source'];
  /** 块内坐标尺寸，单位 mm。 */
  space: { width: number; height: number };
  content: PageBlock;
  styleRoot: ResolvedStyle;
  /** 注释块为 Appearance.Boundary，单位 mm。 */
  boundary?: Box;
  cacheKey: string;
}

/** 独立块构建选项；由 T10 的递归构建过程传入。 */
export interface BlockBuildOptions {
  /** 当前嵌套深度；根块为 0。 */
  depth?: number;
  /** 祖先块 cacheKey 栈，用于循环检测。 */
  ancestors?: readonly string[];
  /** warning 回调；超深/循环使用 `W_COMPOSITE_DEPTH`。 */
  onWarning?: (code: string, message: string, objectId?: string) => void;
}

/** 独立块绘制上下文。 */
export interface BlockDrawContext {
  renderer: Renderer;
  binder: PaintBinder;
  /** 组透明度 0..1，默认 1；只在 group 结束乘一次。 */
  alpha?: number;
  /** 是否需要隔离组。 */
  isolated?: boolean;
  /** 组合成模式，默认 `source-over`。 */
  composite?: CompositeMode;
  /**
   * group 坐标 → 当前目标 device 坐标的矩阵，仅在需要 group 时生效。
   *
   * 非 group 回放直接使用调用方已设置好的当前变换，不需要该矩阵。
   */
  matrix?: Matrix;
  onWarning?: (code: string, message: string, objectId?: string) => void;
}

/**
 * 构建一个空的显示列表，用于超深/循环/空块降级。
 *
 * @param space 块坐标尺寸，单位 mm。
 * @returns 空 DisplayList。
 */
function emptyDisplayList(space: { width: number; height: number }): DisplayList {
  return {
    commands: [],
    bounds: { x: 0, y: 0, w: space.width, h: space.height },
  };
}

/**
 * 构建独立块显示列表；函数内部不得套用块的放置平移。
 *
 * 超过 `MAX_BLOCK_DEPTH` 或 cacheKey 已在祖先栈中时，返回空 displayList 并上报
 * `W_COMPOSITE_DEPTH`，由上层继续绘制其他对象。
 *
 * @param input 块定义。
 * @param buildDisplayList 由 T10 提供的块内容构建函数。
 * @param options 深度/祖先栈/warning 回调。
 * @returns 带 displayList 的块。
 */
export function buildIndependentBlock(
  input: BuildBlockInput,
  buildDisplayList: (input: BuildBlockInput) => DisplayList,
  options: BlockBuildOptions = {},
): PreparedBlock {
  const depth = options.depth ?? 0;
  const ancestors = options.ancestors ?? [];
  const warn = (message: string): void => {
    options.onWarning?.('W_COMPOSITE_DEPTH', message, input.id);
  };
  if (depth > MAX_BLOCK_DEPTH) {
    warn(`独立块递归深度超过 ${MAX_BLOCK_DEPTH}，已跳过内容`);
    return { ...input, displayList: emptyDisplayList(input.space) };
  }
  if (ancestors.includes(input.cacheKey)) {
    warn('独立块出现循环引用，已跳过内容');
    return { ...input, displayList: emptyDisplayList(input.space) };
  }
  const displayList = buildDisplayList(input);
  return { ...input, displayList };
}

/**
 * 独立块缓存。
 *
 * 按 `cacheKey` 复用已构建的显示列表；底纹 cell 额外按 patternId 索引，供
 * PaintBinder 的 `resolvePatternTile` 使用。缓存的 block 与放置位置无关。
 */
export class BlockStore implements Pick<import('./paint').PatternTileResolver, 'resolvePatternTile'> {
  private readonly byKey = new Map<string, PreparedBlock>();
  private readonly byPatternId = new Map<string, PreparedBlock>();

  /** 已缓存的块数量。 */
  get size(): number {
    return this.byKey.size;
  }

  /**
   * 按 cacheKey 取块。
   *
   * @param cacheKey 块缓存键。
   * @returns 已构建块或 undefined。
   */
  get(cacheKey: string): PreparedBlock | undefined {
    return this.byKey.get(cacheKey);
  }

  /**
   * 写入块；同 key 覆盖旧值。
   *
   * @param block 已构建块。
   */
  set(block: PreparedBlock): void {
    this.byKey.set(block.cacheKey, block);
    if (block.source === 'pattern-cell' && block.id) {
      this.byPatternId.set(block.id, block);
    }
  }

  /**
   * 按底纹资源 ID 取 tile 显示列表。
   *
   * @param patternId 底纹资源 ID。
   * @returns tile DisplayList 或 undefined。
   */
  getPatternTile(patternId: string): DisplayList | undefined {
    return this.byPatternId.get(patternId)?.displayList;
  }

  /**
   * 实现 PatternTileResolver。
   *
   * @param patternId 底纹资源 ID。
   * @returns tile DisplayList 或 undefined。
   */
  resolvePatternTile(patternId: string): DisplayList | undefined {
    return this.getPatternTile(patternId);
  }

  /** 清空缓存与索引。 */
  clear(): void {
    this.byKey.clear();
    this.byPatternId.clear();
  }
}

/**
 * 绘制独立块：在当前（块）空间裁剪块范围并回放 displayList。
 *
 * 调用方负责块的放置平移：注释/复合对象应先 `save()`、`translate(boundary.x,boundary.y)`
 * （复合对象还需应用 CTM），再调用本函数。非 group 回放不会重置当前变换；需要 group
 * 时由 `context.matrix` 提供 group 坐标到 device 的映射。
 *
 * @param context 渲染器、PaintBinder、组参数。
 * @param block 独立块。
 */
export function drawIndependentBlock(context: BlockDrawContext, block: IndependentBlock): void {
  const warn = (code: string, message: string): void => {
    context.onWarning?.(code, message, block.id);
  };
  const displayList = block.displayList;
  if (!displayList || displayList.commands.length === 0) {
    warn('W_ANNOT_EMPTY', '独立块显示列表为空，已跳过');
    return;
  }
  const width = block.space.width;
  const height = block.space.height;
  if (!(width > 0) || !(height > 0)) {
    warn('W_ZERO_BOUNDARY', '独立块空间尺寸非正，已跳过');
    return;
  }
  const alpha = Math.max(0, Math.min(1, context.alpha ?? 1));
  if (alpha === 0) return;
  const isolated = context.isolated ?? false;
  const composite = context.composite ?? 'source-over';
  const needGroup = alpha < 1 || isolated || composite !== 'source-over';

  const { renderer } = context;
  renderer.save();
  try {
    renderer.beginPath();
    renderer.rect(0, 0, width, height);
    renderer.clip('nonzero');
    if (needGroup) {
      renderer.beginGroup({
        bounds: { x: 0, y: 0, w: width, h: height },
        matrix: context.matrix ?? IDENTITY_MATRIX,
        alpha,
        isolated,
        composite,
      });
      try {
        replayDisplayList(renderer, displayList);
      } finally {
        // 组透明度只在 endGroup 乘一次；即使回放异常也必须关闭组。
        renderer.endGroup();
      }
    } else {
      replayDisplayList(renderer, displayList);
    }
  } catch (error) {
    warn('W_UNSUPPORTED_PAINT', `独立块回放失败：${String(error)}`);
  } finally {
    renderer.restore();
  }
}

/**
 * 按 PageAnnot 顺序绘制注释/签章外观块。
 *
 * 每个块独立 save/restore；`boundary` 是 Appearance.Boundary，单位为 mm。
 * 空外观块会由 `drawIndependentBlock` 上报并跳过，不影响后续块。
 *
 * @param renderer 目标渲染器。
 * @param binder Paint 绑定器。
 * @param blocks 注释外观块（按文件顺序）。
 * @param onWarning warning 回调。
 */
export function drawAnnotationBlocks(
  renderer: Renderer,
  binder: PaintBinder,
  blocks: readonly IndependentBlock[],
  onWarning?: (code: string, message: string, objectId?: string) => void,
): void {
  for (const block of blocks) {
    renderer.save();
    try {
      if (block.boundary) renderer.translate(block.boundary.x, block.boundary.y);
      drawIndependentBlock({ renderer, binder, onWarning }, block);
    } catch (error) {
      onWarning?.('W_UNSUPPORTED_PAINT', `注释块绘制失败：${String(error)}`, block.id);
    } finally {
      renderer.restore();
    }
  }
}