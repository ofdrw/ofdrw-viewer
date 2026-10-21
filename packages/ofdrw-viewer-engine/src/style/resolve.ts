/**
 * 样式作用域合并与最终结算（实现由 T3/dev-model 完成）。
 *
 * 优先级：继承 < DrawParam < 内联 < 子元素颜色；Fill/Stroke 不从父继承。
 * 结算结果在准备阶段写入 `PreparedPage.styles`，绘制阶段只读。
 */

import type { Paint, GraphicUnitBase, ResourceId } from '../model/types';
import type { ResolvedStyle } from './types';
import type { DrawParamGraph } from './draw-param';
import { notImplemented } from '../common/not-implemented';

/** 样式作用域；从图层到对象逐层嵌套。 */
export interface StyleScope {
  /** 作用域类型。 */
  kind: 'document' | 'layer' | 'pageblock' | 'composite' | 'annotation' | 'pattern' | 'object';
  /** 该作用域引用的 DrawParam。 */
  drawParamId?: ResourceId;
  /** 父作用域。 */
  parent?: StyleScope;
  /** 内联覆盖（来自 XML 属性）。 */
  inline?: Partial<ResolvedStyle>;
}

/** 单个对象的结算输入。 */
export interface ResolveStyleInput {
  /** 图元；提供 alpha/inline 线型/clips 等内联字段。 */
  object: GraphicUnitBase;
  /** 图元所在作用域。 */
  scope: StyleScope;
  /** 图元自己的填充色（子元素颜色优先级最高）。 */
  fillPaint?: Paint;
  /** 图元自己的描边色。 */
  strokePaint?: Paint;
}

/** 文档默认样式输入。 */
export interface DefaultStyleOptions {
  /** 默认线宽，单位 mm，默认 0.3528。 */
  lineWidth?: number;
  /** 默认填充色；缺省黑色。 */
  fillColor?: Paint;
  /** 默认描边色；缺省黑色。 */
  strokeColor?: Paint;
}

/**
 * 创建文档默认 ResolvedStyle。
 *
 * @param options 默认值覆盖。
 * @returns 不可变默认样式。
 */
export function createDefaultStyle(options?: DefaultStyleOptions): ResolvedStyle {
  void options;
  return notImplemented('style.createDefaultStyle');
}

/** 样式结算器。 */
export class StyleResolver {
  /**
   * @param drawParams 已构建的 DrawParam 图。
   * @param defaultStyle 文档默认样式。
   * @param onWarning warning 回调。
   */
  constructor(
    private readonly drawParams: DrawParamGraph,
    private readonly defaultStyle: ResolvedStyle,
    private readonly onWarning?: (code: string, message: string, resourceId?: ResourceId) => void,
  ) {
    void this.drawParams;
    void this.defaultStyle;
    void this.onWarning;
  }

  /**
   * 结算单个图元样式。
   *
   * @param input 图元、作用域与子元素颜色。
   * @returns 最终不可变样式。
   */
  resolveStyle(input: ResolveStyleInput): ResolvedStyle {
    void input;
    return notImplemented('StyleResolver.resolveStyle');
  }
}