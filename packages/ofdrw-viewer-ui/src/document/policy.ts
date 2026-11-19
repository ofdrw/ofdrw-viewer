/**
 * 文档声明应用策略：宿主对视图首选项与权限声明的开关。
 *
 * 阅读器默认按文档声明初始化视图并按权限声明门控入口；宿主可通过
 * `documentPolicy` 关掉其中一侧，便于企业站点统一外观或调试。
 */

/** 文档声明应用策略（宿主配置）。 */
export interface DocumentPolicyOptions {
  /** 是否应用视图首选项；默认 true。 */
  readonly viewPreferences?: boolean;
  /**
   * 是否按权限声明门控入口（打印/导出/复制/签章）；默认 true。
   *
   * 只影响阅读器是否**限制**入口，不影响属性面板展示文档原声明。
   */
  readonly permissions?: boolean;
}

/** 展开默认值后的策略。 */
export interface ResolvedDocumentPolicyOptions {
  /** 是否应用视图首选项。 */
  readonly viewPreferences: boolean;
  /** 是否按权限声明门控入口。 */
  readonly permissions: boolean;
}

/**
 * 合并策略与默认值。
 *
 * @param options 宿主配置。
 * @returns 两侧均开启的策略。
 */
export function resolveDocumentPolicyOptions(
  options: DocumentPolicyOptions | undefined,
): ResolvedDocumentPolicyOptions {
  return {
    viewPreferences: options?.viewPreferences !== false,
    permissions: options?.permissions !== false,
  };
}
