/**
 * 黄金图 harness 的公共类型与默认容差。
 *
 * 口径来自《OFD渲染引擎设计方案》19.2：
 * - 版式偏差 ≤ 0.5 mm 或 1 设备像素（取较宽者）；
 * - 关键色 ΔE2000 ≤ 5；
 * - 抗锯齿边缘不计入差异；
 * - SSIM/像素差只作辅助指标。
 */

/** 一个像素缓冲（RGBA8，行优先，长度 = width × height × 4）。 */
export interface ImageLike {
  /** 宽度，像素。 */
  width: number;
  /** 高度，像素。 */
  height: number;
  /** RGBA8 像素数据。 */
  data: Uint8Array;
}

/** 比较容差。 */
export interface Tolerance {
  /** 版式（内容 bbox）容差，单位 mm；默认 0.5。 */
  layoutMm: number;
  /** 页面尺寸容差，单位 mm；默认 0.5。 */
  sizeMm: number;
  /** 关键色最大 ΔE2000；默认 5。 */
  colorDeltaE: number;
  /** 关键色占比最大差（0..1）；默认 0.2。 */
  colorCoverageDelta: number;
  /** 抗锯齿边缘判定阈值（Sobel 梯度，0..255）；默认 48。 */
  aaEdgeThreshold: number;
  /** pixelmatch 颜色阈值（0..1，越小越严格）；默认 0.1。 */
  pixelmatchThreshold: number;
  /** 与白色的通道差超过该值才算“内容”；默认 8（0..255）。 */
  backgroundDistance: number;
  /** 参与颜色/内容统计的最小 alpha（0..255）；默认 8。 */
  minAlpha: number;
  /** 区域对比的网格边长（3 表示 3×3）；默认 3。 */
  regionGrid: number;
  /** 判定为文字页所需的抗锯齿边缘密度下限（边缘像素/内容像素）；默认 1.2。 */
  textEdgeDensity: number;
  /** 文字页参与 SSIM 下限；默认 0.6。 */
  textSsimMin: number;
  /** 文字页只统计暗墨主色的最大亮度（0..255）；默认 100。 */
  textInkMaxLuminance: number;
  /** 墨迹掩码亮度上限（0..255）；默认 200，用于 inkDiffRatio。 */
  inkMaxLuminance: number;
  /** 文字页允许的主色占比差；默认 0.9（字形抗锯齿/字重差异）。 */
  textCoverageDelta: number;
  /** 文字页暗墨主色最大 ΔE2000；默认 6。 */
  textColorDeltaE: number;
  /** 文字页内容 bbox 容差，mm；默认 2（仅文字页，普通页仍 0.5）。 */
  textLayoutMm: number;
}

/** 默认容差。 */
export const DEFAULT_TOLERANCE: Readonly<Tolerance> = Object.freeze({
  layoutMm: 0.5,
  sizeMm: 0.5,
  colorDeltaE: 5,
  colorCoverageDelta: 0.2,
  aaEdgeThreshold: 48,
  pixelmatchThreshold: 0.1,
  backgroundDistance: 8,
  minAlpha: 8,
  regionGrid: 3,
  textEdgeDensity: 1.2,
  textSsimMin: 0.6,
  textInkMaxLuminance: 100,
  inkMaxLuminance: 200,
  textCoverageDelta: 0.9,
  textColorDeltaE: 6,
  textLayoutMm: 2,
});

/** 像素坐标 bbox。 */
export interface BBoxPx {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 毫米坐标 bbox。 */
export interface BBoxMm {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 单个区域的差异指标。 */
export interface RegionMetric {
  /** 行号，从 0 开始。 */
  row: number;
  /** 列号，从 0 开始。 */
  col: number;
  /** 区域内（排除抗锯齿边缘）的像素差异比例，0..1。 */
  pixelDiffRatio: number;
  /** 内容覆盖率之差（actual - expected），-1..1。 */
  coverageDelta: number;
}

/** 一次图像比较的指标。 */
export interface CompareMetrics {
  /** 实际图宽高，像素。 */
  actualSize: { width: number; height: number };
  /** 参考图宽高，像素。 */
  expectedSize: { width: number; height: number };
  /** 尺寸差（actual - expected），像素。 */
  sizeDeltaPx: { width: number; height: number };
  /** 尺寸差，mm。 */
  sizeDeltaMm: { width: number; height: number };
  /** 内容 bbox（actual），毫米。 */
  actualBBoxMm: BBoxMm | null;
  /** 内容 bbox（expected），毫米。 */
  expectedBBoxMm: BBoxMm | null;
  /** bbox 最大边偏差，mm；两者内容存在性不一致时为 null。 */
  layoutDeltaMm: number | null;
  /** 关键色最大 ΔE2000（双方各取前 5 个主色，最近邻匹配）。 */
  keyColorMaxDE: number;
  /** 关键色占比最大差（最近邻匹配对的占比差，0..1）。 */
  keyColorCoverageDelta: number;
  /** 颜色样本 ΔE2000 的 95 分位（辅助指标）。 */
  colorP95DE: number;
  /** 全部共同内容像素（不排除抗锯齿边缘）的 ΔE2000 95 分位；用于捕获渐变/整体着色差异。 */
  colorP95DEAll: number;
  /** 分块内 ΔE2000 95 分位的最大值（3×3 网格）；用于捕获局部渐变/着色差异。 */
  blockColorP95DE: number;
  /** 墨迹掩码（亮度 ≤ inkMaxLuminance）异或并集比，0..1；墨迹形状/覆盖差异。 */
  inkDiffRatio: number;
  /** 共同内容像素中 ΔE2000 > 10 的比例，0..1；用于解释低 SSIM 的内容差异。 */
  contentDiffRatio: number;
  /** 参与颜色统计的样本数。 */
  colorSampleCount: number;
  /** 结构相似度（灰度、全局近似，辅助指标）。 */
  ssim: number;
  /** 排除抗锯齿边缘后的像素差异比例，0..1。 */
  pixelDiffRatio: number;
  /** 3×3 区域指标。 */
  regions: RegionMetric[];
  /** 抗锯齿边缘密度（边缘像素/内容像素），用于判定文字页。 */
  edgeDensity: number;
}

/** 比较结论。 */
export type CompareStatus = 'pass' | 'size-mismatch' | 'layout-mismatch' | 'color-mismatch';

/** 一次比较的结果。 */
export interface CompareResult {
  /** 结论。 */
  status: CompareStatus;
  /** 是否通过。 */
  ok: boolean;
  /** 失败原因（人类可读）。 */
  reasons: string[];
  /** 指标。 */
  metrics: CompareMetrics;
  /** diff 叠加图 PNG；未请求或无法生成时为 undefined。 */
  diffPng?: Uint8Array;
}

/** 可序列化的 warning。 */
export interface PortableWarning {
  /** warning 码。 */
  code: string;
  /** 诊断信息。 */
  message: string;
  /** 页索引，从 0 开始。 */
  pageIndex?: number;
  /** 对象 ID。 */
  objectId?: string;
  /** 资源 ID。 */
  resourceId?: string;
}

/** 单页比较状态。 */
export type PageStatus =
  | CompareStatus
  | 'engine-unavailable'
  | 'engine-error'
  | 'reference-missing'
  | 'skipped';

/** 单页比较记录。 */
export interface PageComparisonRecord {
  /** 样本名（不含扩展名）。 */
  sample: string;
  /** 页号，从 1 开始（与 pdftoppm 一致）。 */
  page: number;
  /** 结论。 */
  status: PageStatus;
  /** 输出图宽，像素。 */
  width: number | null;
  /** 输出图高，像素。 */
  height: number | null;
  /** 页面尺寸，mm。 */
  sizeMm: { width: number; height: number } | null;
  /** 引擎输出 PNG 相对路径。 */
  enginePng: string | null;
  /** PDF 参考 PNG 相对路径。 */
  referencePng: string | null;
  /** 基线 PNG 相对路径。 */
  baselinePng: string | null;
  /** 差异叠加 PNG 相对路径。 */
  diffPng: string | null;
  /** 与 PDF 参考比较的指标。 */
  metrics: CompareMetrics | null;
  /** 与基线的比较指标（若有基线）。 */
  baselineMetrics: CompareMetrics | null;
  /** 引擎渲染耗时，ms。 */
  renderMs: number | null;
  /** PDF 参考渲染耗时，ms。 */
  referenceMs: number | null;
  /** 该页收集到的 warning。 */
  warnings: PortableWarning[];
  /** 错误信息。 */
  error: { code?: string; message: string } | null;
  /** 备注。 */
  notes: string[];
}

/** 人工确认的已知容差页。 */
export interface KnownTolerancePage {
  /** 页号，从 1 开始（与 pdftoppm 一致）。 */
  page: number;
  /** 该页允许的最大关键色 ΔE2000。 */
  maxDeltaE: number;
  /** 该页允许的最大关键色占比差（0..1）；省略时只校验 maxDeltaE。 */
  maxCoverageDelta?: number;
  /** 容差原因；仅记录，不改变全局阈值。 */
  reason: string;
}

/** 单页参考覆盖：用人工权威图替代 PDF 参考，仅影响指定页。 */
export interface ReferenceOverride {
  /** 页号，从 1 开始。 */
  page: number;
  /** 权威图仓库相对路径或绝对路径。 */
  path: string;
  /** 归一化目标宽度，像素。 */
  width: number;
  /** 归一化目标高度，像素。 */
  height: number;
  /** 目标内容 bbox（像素）；声明时按内容区对齐，否则整页等比缩放。 */
  targetContentBBoxPx?: { x: number; y: number; width: number; height: number };
  /** 覆盖原因。 */
  reason: string;
}

/** 负样本期望：页面应产生的 warning 与内容存活条件。 */
export interface NegativeSampleExpectation {
  /** 负样本页号（1 起）；这些页允许比较失败。 */
  pages: number[];
  /** 页面必须出现的 warning 码（页级或样本级至少出现一次）。 */
  expectedWarnings: string[];
  /** 是否要求页面仍有可识别内容（非空白）；默认 true。 */
  requireContent?: boolean;
  /** 负样本原因。 */
  reason: string;
}

/** 单样本结果。 */
export interface SampleReport {
  /** 样本名（不含扩展名）。 */
  name: string;
  /** 分组（可多组）。 */
  groups: string[];
  /** 优先级。 */
  priority: 'P0' | 'P1';
  /** 本地样本是否存在（manual 为可选样本）。 */
  available: boolean;
  /** 是否为可选样本（不提交仓库）。 */
  optional: boolean;
  /** OFD 路径（仓库相对）。 */
  ofdPath: string | null;
  /** PDF 路径（仓库相对）。 */
  pdfPath: string | null;
  /** PDF 页数。 */
  pdfPages: number | null;
  /** OFD 包内 Document.xml 声明的页数（扫描自 ZIP）。 */
  ofdDeclaredPages: number | null;
  /** 引擎报告的页数。 */
  ofdPages: number | null;
  /** 首屏页尺寸，mm。 */
  sizeMm: { width: number; height: number } | null;
  /** 是否含内嵌字体。 */
  embeddedFonts: boolean;
  /** 字体条目数。 */
  fontEntries: number;
  /** 图片条目数。 */
  imageEntries: number;
  /** JBIG2 条目数。 */
  jb2Entries: number;
  /** 仅对这些页做黄金图（1 起）；空表示全部页。 */
  goldenPages: number[];
  /** 引擎打开状态。 */
  engineStatus: 'ok' | 'unavailable' | 'error' | 'skipped';
  /** 引擎耗时，ms。 */
  openMs: number | null;
  /** 总耗时，ms。 */
  totalMs: number;
  /** 字体缺失 warning 数。 */
  fontMissingCount: number;
  /** warning 汇总（去重后）。 */
  warnings: PortableWarning[];
  /** 单页结果。 */
  pages: PageComparisonRecord[];
  /** 备注。 */
  notes: string[];
  /** 人工确认的参考配对不匹配页（1 起）；这些页不记为引擎缺陷。 */
  referenceMismatchPages?: number[];
  /** 参考配对不匹配原因。 */
  referenceMismatchReason?: string;
  /** 人工确认的 known tolerance 页；这些页不记为引擎失败。 */
  knownTolerancePages?: KnownTolerancePage[];
  /** 负样本期望；满足时单列 expected-negative，不记为引擎失败。 */
  negativeSample?: NegativeSampleExpectation;
  /** 单页参考覆盖（人工权威图）；仅该页使用。 */
  referenceOverride?: ReferenceOverride;
}

/** 汇总计数。 */
export interface GoldenSummary {
  /** 样本总数（含不可用/跳过）。 */
  samples: number;
  /** 样本通过数。 */
  samplesPassed: number;
  /** 样本失败数。 */
  samplesFailed: number;
  /** 样本跳过数。 */
  samplesSkipped: number;
  /** 引擎不可用样本数。 */
  samplesUnavailable: number;
  /** 页总数。 */
  pages: number;
  /** 页通过数。 */
  pagesPassed: number;
  /** 页失败数。 */
  pagesFailed: number;
  /** 页跳过数。 */
  pagesSkipped: number;
  /** 样本的参考配对不匹配数（不计引擎失败）。 */
  samplesReferenceMismatch: number;
  /** 参考配对不匹配页数（不计引擎失败）。 */
  pagesReferenceMismatch: number;
  /** known tolerance 样本数（不计引擎失败）。 */
  samplesKnownTolerance: number;
  /** known tolerance 页数（不计引擎失败）。 */
  pagesKnownTolerance: number;
  /** 负样本（满足期望）的样本数（不计引擎失败）。 */
  samplesExpectedNegative: number;
  /** 负样本（满足期望）的页数（不计引擎失败）。 */
  pagesExpectedNegative: number;
  /** 总耗时，ms。 */
  durationMs: number;
}

/** 黄金图报告。 */
export interface GoldenReport {
  /** 报告 schema 版本。 */
  schemaVersion: 1;
  /** 报告类型。 */
  kind: 'golden-report' | 'mock-selfcheck';
  /** 生成时间（ISO 8601）。 */
  createdAt: string;
  /** 输出 DPI。 */
  dpi: number;
  /** 运行环境。 */
  environment: { node: string; platform: string; arch: string };
  /** 产物目录（绝对路径）。 */
  artifactsDir: string;
  /** 使用的容差。 */
  tolerance: Tolerance;
  /** 模式。 */
  mode: 'engine' | 'mock' | 'mixed';
  /** 汇总。 */
  summary: GoldenSummary;
  /** 样本结果。 */
  samples: SampleReport[];
}

/** 比较选项。 */
export interface CompareOptions {
  /** DPI，用于 mm/px 换算；默认 96。 */
  dpi?: number;
  /** 容差覆盖。 */
  tolerance?: Partial<Tolerance>;
  /** 是否生成 diff PNG；默认 true。 */
  computeDiff?: boolean;
}