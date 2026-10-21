/**
 * DrawParam 展开、Relative 链与缓存。
 *
 * 该层是纯函数：只读资源定义，不读 ZIP、不解码图片、不调用 Canvas。
 */

import type { Paint, DrawParam, ResourceId } from '../model/types';
import type { PaintSpec } from '../common/types';
import type { ResolvedStyle } from './types';
import { normalizeResourceId } from '../model/ids';
import { resolvePaint } from './paint';

export { resolvePaint } from './paint';
export type { StyleWarningHandler } from './paint';

/** DrawParam 展开结果；未出现的字段由继承/默认值补齐。 */
export type ResolvedStylePatch = Partial<Omit<ResolvedStyle, 'fillPaint' | 'strokePaint'>> & {
  fillPaint?: PaintSpec;
  strokePaint?: PaintSpec;
};

/** DrawParam 展开选项。 */
export interface DrawParamResolveOptions {
  /** Relative 最大深度，默认 16。 */
  maxDepth?: number;
  /** 环/缺失/坏值 warning 回调。 */
  onWarning?: (code: string, message: string, resourceId?: ResourceId) => void;
}

/** 默认最大 Relative 深度。 */
const DEFAULT_MAX_DEPTH = 16;

/**
 * 把单个 DrawParam 的字段转成 patch；只复制已出现字段。
 *
 * @param param DrawParam 定义。
 * @param options warning 选项。
 * @returns 样式 patch；Alpha 从 0..255 转为 0..1。
 */
function patchOf(param: DrawParam, options?: DrawParamResolveOptions): ResolvedStylePatch {
  const patch: ResolvedStylePatch = {};
  if (param.lineWidth !== undefined) patch.lineWidth = param.lineWidth;
  if (param.cap !== undefined) patch.lineCap = param.cap;
  if (param.join !== undefined) patch.lineJoin = param.join;
  if (param.miterLimit !== undefined) patch.miterLimit = param.miterLimit;
  if (param.dashOffset !== undefined) patch.dashOffset = param.dashOffset;
  if (param.dashPattern !== undefined) patch.dashPattern = [...param.dashPattern];
  if (param.alpha !== undefined) patch.alpha = Math.max(0, Math.min(1, param.alpha / 255));
  if (param.fillColor !== undefined) {
    const fillPaint = resolvePaint(param.fillColor, options?.onWarning);
    if (fillPaint) patch.fillPaint = fillPaint;
  }
  if (param.strokeColor !== undefined) {
    const strokePaint = resolvePaint(param.strokeColor, options?.onWarning);
    if (strokePaint) patch.strokePaint = strokePaint;
  }
  return patch;
}

/**
 * 在 params 中按规范化 ID 查找 DrawParam。
 *
 * @param params 资源表。
 * @param id 规范化 ID。
 * @returns DrawParam 或 undefined。
 */
function findParam(params: ReadonlyMap<ResourceId, DrawParam>, id: ResourceId): DrawParam | undefined {
  const direct = params.get(id);
  if (direct) return direct;
  for (const [key, value] of params) {
    if (normalizeResourceId(key) === id) return value;
  }
  return undefined;
}

/**
 * 展开单个 DrawParam 的 Relative 链。
 *
 * @param params 资源 ID → DrawParam。
 * @param id 目标 DrawParam ID。
 * @param options 深度与 warning 选项。
 * @returns 合并后的样式 patch；环/缺失时返回已展开部分并 warning。
 */
export function flattenDrawParam(
  params: ReadonlyMap<ResourceId, DrawParam>,
  id: ResourceId,
  options?: DrawParamResolveOptions,
): ResolvedStylePatch {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const warn = options?.onWarning;
  const memo = new Map<ResourceId, ResolvedStylePatch>();
  const stack: ResourceId[] = [];

  /**
   * 深度优先展开。
   *
   * @param rawId 当前 DrawParam ID。
   * @param depth 当前深度，根为 0。
   * @returns 合并后的 patch。
   */
  const visit = (rawId: ResourceId, depth: number): ResolvedStylePatch => {
    const normalized = normalizeResourceId(rawId);
    if (!normalized) return {};
    const cached = memo.get(normalized);
    if (cached) return cached;
    if (depth > maxDepth) {
      warn?.('W_COMPOSITE_DEPTH', `DrawParam Relative 深度超过 ${maxDepth}，已截断`, normalized);
      return {};
    }
    if (stack.includes(normalized)) {
      warn?.('W_COMPOSITE_DEPTH', `DrawParam Relative 出现环：${[...stack, normalized].join(' → ')}`, normalized);
      return {};
    }
    stack.push(normalized);
    const param = findParam(params, normalized);
    let result: ResolvedStylePatch = {};
    if (param?.relative) {
      result = { ...visit(param.relative, depth + 1) };
    }
    if (param) {
      result = { ...result, ...patchOf(param, options) };
    } else {
      warn?.('W_BAD_NUMBER', `DrawParam 引用不存在：${normalized}`, normalized);
    }
    stack.pop();
    memo.set(normalized, result);
    return result;
  };

  return visit(id, 0);
}

/** DrawParam 图：按资源 ID 展开并缓存 partial。 */
export class DrawParamGraph {
  /** 展开缓存；同一 ID 只展开一次。 */
  private readonly cache = new Map<ResourceId, ResolvedStylePatch>();

  /**
   * @param params 资源 ID → DrawParam。
   * @param options 展开选项。
   */
  constructor(
    private readonly params: ReadonlyMap<ResourceId, DrawParam>,
    private readonly options: DrawParamResolveOptions = {},
  ) {}

  /**
   * 展开指定 DrawParam。
   *
   * @param id DrawParam ID。
   * @returns 样式 patch（同一实例内缓存）。
   */
  resolve(id: ResourceId): ResolvedStylePatch {
    const normalized = normalizeResourceId(id);
    if (!normalized) return {};
    const cached = this.cache.get(normalized);
    if (cached) return cached;
    const patch = flattenDrawParam(this.params, normalized, this.options);
    this.cache.set(normalized, patch);
    return patch;
  }

  /** 清空展开缓存。 */
  clear(): void {
    this.cache.clear();
  }
}
