/**
 * DrawParam 展开、Relative 链与缓存（实现由 T3/dev-model 完成）。
 *
 * 该层是纯函数：只读资源定义，不读 ZIP、不解码图片、不调用 Canvas。
 */

import type { Paint, DrawParam, ResourceId } from '../model/types';
import type { PaintSpec } from '../common/types';
import type { ResolvedStyle } from './types';
import { notImplemented } from '../common/not-implemented';

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

/**
 * 展开单个 DrawParam 的 Relative 链（按 ID 缓存 partial）。
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
  void params;
  void id;
  void options;
  return notImplemented('style.flattenDrawParam');
}

/**
 * 把模型层 Paint 归一化为渲染器可绑定的 PaintSpec。
 *
 * 径向渐变 v1 降级：由实现返回平均色并上报 `W_RADIAL_UNSUPPORTED`；
 * 底纹在此只生成 PatternSpec，tile 由 PaintBinder 填充。
 *
 * @param paint 模型 Paint。
 * @param onWarning warning 回调。
 * @returns PaintSpec；无法表达时返回 undefined。
 */
export function resolvePaint(
  paint: Paint,
  onWarning?: (code: string, message: string) => void,
): PaintSpec | undefined {
  void paint;
  void onWarning;
  return notImplemented('style.resolvePaint');
}

/** DrawParam 图：按资源 ID 展开并缓存 partial。 */
export class DrawParamGraph {
  /**
   * @param params 资源 ID → DrawParam。
   * @param options 展开选项。
   */
  constructor(
    private readonly params: ReadonlyMap<ResourceId, DrawParam>,
    private readonly options: DrawParamResolveOptions = {},
  ) {
    void this.params;
    void this.options;
  }

  /**
   * 展开指定 DrawParam。
   *
   * @param id DrawParam ID。
   * @returns 样式 patch。
   */
  resolve(id: ResourceId): ResolvedStylePatch {
    void id;
    return notImplemented('DrawParamGraph.resolve');
  }

  /** 清空展开缓存。 */
  clear(): void {
    return notImplemented('DrawParamGraph.clear');
  }
}