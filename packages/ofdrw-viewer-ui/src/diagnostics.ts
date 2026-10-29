/**
 * 诊断体系：UI 自有 warning 码表、级别映射、格式化与控制台打印（警告与错误日志方案设计 §2~§4）。
 *
 * 本模块只做“归一化 → 过滤 → 去重 → 打印”，不改变 `onWarning`/`onError` 回调与
 * `warning`/`error` 事件语义：回调与事件每次都触发，去重只影响控制台输出。
 *
 * 码表归属见设计文档 §2.1：`W_` 前缀的引擎码（`W_FONT_MISSING`、`W_GLYPH_MISSING` 等）与
 * crypto 码（`W_CRYPTO_*`）由引擎/密码能力包提供，不在本表内；`W_CRYPTO_VERIFICATION_CALLBACK`
 * 等 UI 在调用密码能力时自行产生的码属于 UI 自有码，登记在本表。
 */

/**
 * UI 自有 warning 码常量（键与值相同，按主题分组；键顺序即文档 §2.3 表的顺序）。
 *
 * 以 `UI_WARNING_CODES.W_XXX` 引用，拼错会被类型系统发现；`Object.values()` 得到完整码表。
 * 未登记的码（引擎/crypto 码、宿主扩展码）不在本表内，级别按 {@link resolveDiagnosticLevel}
 * 的缺省规则处理。
 */
export const UI_WARNING_CODES = Object.freeze({
  // 文档信息
  W_METADATA: 'W_METADATA',
  W_OUTLINE: 'W_OUTLINE',
  W_BOOKMARKS: 'W_BOOKMARKS',
  // 导航
  W_NAV_DEST: 'W_NAV_DEST',
  W_NAV_JUMP: 'W_NAV_JUMP',
  W_NAV_ZOOM: 'W_NAV_ZOOM',
  // 缩略图
  W_THUMBNAIL: 'W_THUMBNAIL',
  W_THUMBNAIL_JUMP: 'W_THUMBNAIL_JUMP',
  // 文本与选区
  W_TEXT_LOAD: 'W_TEXT_LOAD',
  W_TEXT_EMPTY: 'W_TEXT_EMPTY',
  W_TEXT_UNSUPPORTED: 'W_TEXT_UNSUPPORTED',
  W_TEXT_LAYER_CAP: 'W_TEXT_LAYER_CAP',
  /**
   * @deprecated 单页文本层节点上限的旧码，已改名为 {@link UI_WARNING_CODES.W_TEXT_LAYER_CAP}。
   *
   * 保留该成员仅为兼容按旧码过滤告警的调用方：两者取值不同，因此旧码不会再由
   * 文本层发出。需要按码判断时请改用 `W_TEXT_LAYER_CAP`；计划在 1.0.0 移除。
   */
  W_TEXT_LAYER_LIMIT: 'W_TEXT_LAYER_LIMIT',
  W_SELECTION_RENDER: 'W_SELECTION_RENDER',
  W_SELECTION_EVICTED: 'W_SELECTION_EVICTED',
  W_SELECTION_UNPINNABLE: 'W_SELECTION_UNPINNABLE',
  // 查找
  W_FIND_FAILED: 'W_FIND_FAILED',
  W_FIND_LIMIT: 'W_FIND_LIMIT',
  W_FIND_PAGE: 'W_FIND_PAGE',
  W_FIND_PAGE_LIMIT: 'W_FIND_PAGE_LIMIT',
  // 导出打印
  W_EXPORT_PARTIAL: 'W_EXPORT_PARTIAL',
  W_EXPORT_PAGE: 'W_EXPORT_PAGE',
  W_OUTPUT_LARGE_TASK: 'W_OUTPUT_LARGE_TASK',
  W_OUTPUT_DPI_REDUCED: 'W_OUTPUT_DPI_REDUCED',
  // 签名与附件
  W_SIGNATURE_ASN1: 'W_SIGNATURE_ASN1',
  W_SIGNATURE_RESOURCE: 'W_SIGNATURE_RESOURCE',
  W_SIGNATURE_TIMESTAMP: 'W_SIGNATURE_TIMESTAMP',
  W_SIGNATURE_ENTRIES: 'W_SIGNATURE_ENTRIES',
  W_ATTACHMENT_RESOURCE: 'W_ATTACHMENT_RESOURCE',
  // 密码能力
  W_CRYPTO_VERIFICATION_CALLBACK: 'W_CRYPTO_VERIFICATION_CALLBACK',
  W_CRYPTO_VERIFY_FAILED: 'W_CRYPTO_VERIFY_FAILED',
  W_CRYPTO_CERT_SOURCE_UNSUPPORTED: 'W_CRYPTO_CERT_SOURCE_UNSUPPORTED',
  // 界面
  W_UI_LISTENER: 'W_UI_LISTENER',
  W_UI_CLEANUP: 'W_UI_CLEANUP',
  W_ENGINE_EVENT: 'W_ENGINE_EVENT',
  W_FULLSCREEN_FALLBACK: 'W_FULLSCREEN_FALLBACK',
  // 来源
  W_QUERY_SOURCE: 'W_QUERY_SOURCE',
  // 资源限制
  W_CANVAS_LIMIT: 'W_CANVAS_LIMIT',
} as const);

/** UI 自有 warning 码类型。 */
export type UIWarningCode = keyof typeof UI_WARNING_CODES;

/**
 * 诊断级别。
 *
 * - `info`：有诊断价值但不异常，默认**不打印**到控制台（预留级别）；
 * - `warn`：可容忍、影响部分内容，默认 `console.warn`；
 * - `error`：阻断或操作失败，默认 `console.error`。
 */
export type DiagnosticLevel = 'info' | 'warn' | 'error';

/** 诊断来源包。 */
export type DiagnosticSource = 'engine' | 'crypto' | 'ui';

/**
 * 归一化后的诊断（设计文档 §4.1）。
 *
 * `source`/`cause` 为向前兼容的预留字段：当前打印不使用，宿主需要堆栈时用
 * `onError` 回调的 `cause`。
 */
export interface ViewerDiagnostic {
  /** 诊断码；见 {@link UI_WARNING_CODES} 与设计文档 §2 码表。 */
  readonly code: string;
  /** 级别；未登记码按 `warn`。 */
  readonly level: DiagnosticLevel;
  /** 人类可读信息；不得包含字节日志或凭据。 */
  readonly message: string;
  /** 关联页索引，0-based；与页面无关时省略。 */
  readonly pageIndex?: number;
  /** 关联资源/对象 ID（引擎 `OFDWarning.resourceId`）。 */
  readonly resourceId?: string;
  /** 产生该诊断的包。 */
  readonly source: DiagnosticSource;
  /** 原始错误；当前不打印。 */
  readonly cause?: unknown;
}

/**
 * 码 → 级别的显式登记。
 *
 * 设计文档 §3.1：级别由码类别决定而非调用点。当前 UI 自有码全部为 `warn`；这里只登记
 * 需要覆盖缺省值的码（`info` 预留、`error` 留给确属致命的自有码），其余按
 * {@link resolveDiagnosticLevel} 的缺省规则（`warn`）处理。
 */
export const UI_WARNING_LEVELS: Readonly<Partial<Record<string, DiagnosticLevel>>> =
  Object.freeze({});

/**
 * 解析诊断级别。
 *
 * @param code 诊断码；可为引擎/crypto 码或未登记的新码。
 * @returns 登记的级别；未登记（含 UI 之外来源的码）时返回 `warn`。
 */
export function resolveDiagnosticLevel(code: string): DiagnosticLevel {
  return UI_WARNING_LEVELS[code] ?? 'warn';
}

/**
 * 级别 → 控制台标签。
 *
 * `warn` 输出为 `warning`：设计文档 §4.4 的格式 `[ofd-viewer] <level> <code>` 与 P0 已上线
 * 的 `[ofd-viewer] warning <code>` 保持一致（该前缀已被 e2e 与宿主日志过滤规则依赖）。
 */
const DIAGNOSTIC_LABELS: Readonly<Record<DiagnosticLevel, string>> = Object.freeze({
  info: 'info',
  warn: 'warning',
  error: 'error',
});

/**
 * 把诊断格式化为控制台三参数（设计文档 §4.4）。
 *
 * @param diagnostic 归一化后的诊断。
 * @returns `label` 为 `[ofd-viewer] <warning|error|info> <code>`（`warn` 级别输出为 `warning`，
 *   与 P0 已上线的控制台格式保持一致）；`message` 原样；`context` 只含 `pageIndex`
 *   （0-based）与 `resourceId`，两者都缺失时为空对象。
 */
export function formatDiagnostic(diagnostic: ViewerDiagnostic): {
  readonly label: string;
  readonly message: string;
  readonly context: Readonly<Record<string, unknown>>;
} {
  const label = `[ofd-viewer] ${DIAGNOSTIC_LABELS[diagnostic.level]} ${diagnostic.code}`;
  const context: Record<string, unknown> = {};
  if (diagnostic.pageIndex !== undefined) context.pageIndex = diagnostic.pageIndex;
  if (diagnostic.resourceId !== undefined) context.resourceId = diagnostic.resourceId;
  return { label, message: diagnostic.message, context };
}

/** `DiagnosticPrinter` 选项。 */
export interface DiagnosticPrinterOptions {
  /** 是否打印到控制台；默认 true（`debug.console: false` 时整体关闭）。 */
  readonly console?: boolean;
  /** 只打印这些级别；缺省时按级别默认行为（`info` 不打印，`warn`/`error` 打印）。 */
  readonly levels?: readonly DiagnosticLevel[];
  /** 只打印这些码；缺省时不过滤码。 */
  readonly codes?: readonly string[];
}

/**
 * 控制台诊断打印机：过滤 → 去重 → 打印。
 *
 * 过滤在去重之前判断，被过滤的诊断不占用去重键（设计文档 §4.4）；去重只在当前文档
 * 会话内生效，`open()` 时由调用方 {@link DiagnosticPrinter.reset} 清空。
 */
export class DiagnosticPrinter {
  private readonly enabled: boolean;
  private readonly levels: ReadonlySet<DiagnosticLevel> | null;
  private readonly codes: ReadonlySet<string> | null;
  /** 已打印的诊断去重键（`code:pageIndex:resourceId` / `code:pageIndex`）。 */
  private readonly printed = new Set<string>();

  /**
   * @param options 控制台开关、级别与码白名单；都不传时按级别默认输出。
   */
  constructor(options: DiagnosticPrinterOptions = {}) {
    this.enabled = options.console !== false;
    this.levels = options.levels ? new Set(options.levels) : null;
    this.codes = options.codes ? new Set(options.codes) : null;
  }

  /**
   * 打印一条诊断；被过滤或重复的诊断不输出。
   *
   * @param diagnostic 归一化后的诊断。
   */
  print(diagnostic: ViewerDiagnostic): void {
    if (this.enabled === false) return;
    // 过滤先于去重：被过滤的诊断不得占用去重键，否则后续放行时会被误判为重复。
    if (!this.acceptsLevel(diagnostic.level)) return;
    if (this.codes && !this.codes.has(diagnostic.code)) return;
    const key = dedupeKey(diagnostic);
    if (this.printed.has(key)) return;
    this.printed.add(key);
    const { label, message, context } = formatDiagnostic(diagnostic);
    if (diagnostic.level === 'error') console.error(label, message, context);
    else console.warn(label, message, context);
  }

  /** 清空去重集合；切换/重新打开文档时调用。 */
  reset(): void {
    this.printed.clear();
  }

  /**
   * 判断级别是否允许打印。
   *
   * @param level 诊断级别。
   * @returns 显式 `levels` 包含该级别时为 true；未配置时 `info` 不打印，`warn`/`error` 打印。
   */
  private acceptsLevel(level: DiagnosticLevel): boolean {
    if (this.levels) return this.levels.has(level);
    return level !== 'info';
  }
}

/**
 * 生成去重键（设计文档 §3.2）。
 *
 * warning 按资源细分（`code:pageIndex:resourceId`），error 只按页（`code:pageIndex`）。
 *
 * @param diagnostic 归一化后的诊断。
 * @returns 去重键字符串。
 */
function dedupeKey(diagnostic: ViewerDiagnostic): string {
  if (diagnostic.level === 'error') {
    return `${diagnostic.code}:${diagnostic.pageIndex ?? ''}`;
  }
  return `${diagnostic.code}:${diagnostic.pageIndex ?? ''}:${diagnostic.resourceId ?? ''}`;
}
