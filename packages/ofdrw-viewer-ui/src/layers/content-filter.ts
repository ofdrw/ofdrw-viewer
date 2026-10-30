/**
 * 图层可见性模型（设计方案 §B / §C / §I）。
 *
 * 六项可见性 → 引擎 `PageContentFilter`：四层各写 `{ page, templates }`（同值），
 * `signatures` 直映射，`annotations` 为“总开关 + 类型白名单”（§I.4）：
 * - 总开关关闭或零勾选 → `annotations: false` 且不写 `annotationTypes`；
 * - 总开关打开且列出类型全勾 → `annotations: true` 且不写 `annotationTypes`；
 * - 总开关打开且部分取消 → `annotations: true` + `annotationTypes` 白名单；
 * - 与“全画”等价时不传过滤（签名 `all`）。
 *
 * 本模块是纯数据层，不访问 DOM，可在模块顶层安全导入。签名（key）由本模块自行计算，
 * 不依赖引擎未导出的 `resolveContentFilter()`，规则与引擎保持一致（单测逐一对拍）。
 */

import {
  KNOWN_ANNOTATION_TYPES,
  type AnnotationType,
  type PageContentFilter,
} from '@ofdrw/ofdrw-viewer-engine';
import { objectFromEntries } from '../compat';

/** 图层可见性键；顺序即界面自上而下的视觉层级。 */
export const PAGE_LAYER_KEYS = [
  'signatures',
  'annotations',
  'custom',
  'foreground',
  'body',
  'background',
] as const;

/** 图层键。 */
export type LayerKey = (typeof PAGE_LAYER_KEYS)[number];

/** 注释类型键（引擎原值；界面只对常见五类本地化，§I.6）。 */
export type AnnotationTypeKey = AnnotationType;

/** 注释类型勾选表；只记录与“勾选”不同的类型（缺失 = 勾选）。 */
export type AnnotationTypeSelection = Partial<Record<AnnotationTypeKey, boolean>>;

/** 注释项的可见性：总开关 + 类型勾选表（§I.8）。 */
export interface LayerAnnotationVisibility {
  /** 注释总开关；缺省 true。关闭时类型表保留，重新打开即恢复（§I.2）。 */
  readonly enabled?: boolean;
  /** 类型勾选表，只记录 `false` 项；缺省 = 全部勾选。 */
  readonly types?: AnnotationTypeSelection;
}

/**
 * 六项可见性（对外入参形状）。
 *
 * `annotations` 可传布尔（`false` ≡ `{ enabled: false }`）或对象；其余五项只接受布尔，
 * 缺失/非法按可见处理。
 */
export interface LayerVisibility {
  readonly signatures?: boolean;
  readonly annotations?: boolean | LayerAnnotationVisibility;
  readonly custom?: boolean;
  readonly foreground?: boolean;
  readonly body?: boolean;
  readonly background?: boolean;
}

/** 注释项的归一化结果。 */
export interface ResolvedAnnotationVisibility {
  /** 注释总开关。 */
  readonly enabled: boolean;
  /** 类型勾选表（冻结；只含 `false` 项）。 */
  readonly types: Readonly<Record<string, boolean>>;
}

/** 归一化后的六项可见性（对外快照形状）。 */
export interface ResolvedLayerVisibility {
  readonly signatures: boolean;
  readonly annotations: ResolvedAnnotationVisibility;
  readonly custom: boolean;
  readonly foreground: boolean;
  readonly body: boolean;
  readonly background: boolean;
}

/** 六项全可见时的规范化签名。 */
export const ALL_LAYERS_KEY = 'all';

/** 注释总开关的默认类型表（空表 = 全部勾选）。 */
const EMPTY_TYPES: Readonly<Record<string, boolean>> = Object.freeze({});

/**
 * 探测“本页实际出现的注释类型”时使用的候选常量（§I.3）。
 *
 * 引擎没有公开的“本页注释类型列表”接口，UI 只能用白名单试探；候选固定为
 * `KNOWN_ANNOTATION_TYPES` 加本常量，**不在跨页累积**，保证各页结果可预测。
 */
export const ANNOTATION_TYPE_PROBE_CANDIDATES: readonly AnnotationType[] = Object.freeze([
  'Signature',
  'Note',
  'Comment',
  'FreeText',
  'TextBox',
  'Square',
  'Circle',
  'Underline',
  'StrikeOut',
  'Squiggly',
  'Caret',
  'Ink',
  'Polygon',
  'PolyLine',
  'Line',
  'Redact',
  'HighlightText',
]);

/** 每页覆盖快照（`state.ui.layers` 的类型）。 */
export interface PageLayerState {
  /** 文档会话标识；每次 open/close 递增，用于丢弃迟到写入。 */
  readonly sessionId: number;
  /** 归一化后的默认可见性（来自 `layerPanel.defaultVisibility`）。 */
  readonly defaults: ResolvedLayerVisibility;
  /** 页索引（0-based）→ 该页可见性（至少一项与 defaults 不同）。 */
  readonly pages: Readonly<Record<number, ResolvedLayerVisibility>>;
}

/** 图层侧栏配置（`OFDViewerOptions.layerPanel`）。 */
export interface LayerPanelOptions {
  /** 是否渲染“图层”tab；默认 true。false 时 tab 不渲染，`openSidebar('layers')` 抛 `OFD_FEATURE_DISABLED`。 */
  readonly enabled?: boolean;
  /** 是否禁用（保留 tab、禁用交互并给出原因提示）；默认 false。 */
  readonly disabled?: boolean;
  /**
   * 每页可见性的默认值；缺省为六项全开且注释类型全勾。
   *
   * `annotations` 接受布尔或 `{ enabled?, types? }`（§C.2）。
   */
  readonly defaultVisibility?: LayerVisibility;
}

/** 解析后的图层侧栏配置。 */
export interface ResolvedLayerPanelOptions {
  /** 是否渲染 tab。 */
  readonly enabled: boolean;
  /** 是否禁用交互。 */
  readonly disabled: boolean;
  /** 归一化后的默认可见性。 */
  readonly defaultVisibility: ResolvedLayerVisibility;
}

/**
 * 总项状态汇总。
 *
 * 六项三态沿用布尔口径：`annotations` 的“开”指总开关打开且至少有一个列出类型被勾选
 * （与 §I.4.1 的零勾选合并一致）。注释类型只在每页显示，总项不做跨页三态（§I.5）。
 */
export interface LayerSummary {
  /** 六项各自是否“所有页都开”。 */
  readonly allKeysOn: Readonly<Record<LayerKey, boolean>>;
  /** 六项各自是否“所有页都关”（用于半选判定）。 */
  readonly allKeysOff: Readonly<Record<LayerKey, boolean>>;
  /** 总项自身复选框：'on' 全部页六项全开；'off' 全部页六项全关；'mixed' 其余。 */
  readonly state: 'on' | 'off' | 'mixed';
}

/**
 * 创建默认注释可见性：总开关开、类型全勾。
 *
 * @returns 冻结的注释可见性。
 */
export function createDefaultAnnotationVisibility(): ResolvedAnnotationVisibility {
  return Object.freeze({ enabled: true, types: EMPTY_TYPES });
}

/**
 * 创建六项全可见的可见性。
 *
 * @returns 六项齐全、全部可见的新对象。
 */
export function createDefaultVisibility(): ResolvedLayerVisibility {
  return Object.freeze({
    signatures: true,
    annotations: createDefaultAnnotationVisibility(),
    custom: true,
    foreground: true,
    body: true,
    background: true,
  });
}

/**
 * 归一化注释可见性。
 *
 * 规则（§I.2）：布尔按总开关处理；对象里的 `enabled` 非布尔按 true；`types` 只保留
 * 字符串键与布尔值，其余丢弃；总开关关闭时**保留**类型表。
 *
 * @param value 宿主/调用方传入的注释可见性。
 * @returns 冻结的归一化结果。
 */
export function normalizeAnnotationVisibility(
  value?: unknown,
): ResolvedAnnotationVisibility {
  if (typeof value === 'boolean') {
    return value ? createDefaultAnnotationVisibility() : Object.freeze({ enabled: false, types: EMPTY_TYPES });
  }
  if (typeof value !== 'object' || value === null) return createDefaultAnnotationVisibility();
  const source = value as Record<string, unknown>;
  const enabled = source['enabled'] !== false;
  const rawTypes = source['types'];
  const types: Record<string, boolean> = {};
  let hasTypes = false;
  if (typeof rawTypes === 'object' && rawTypes !== null) {
    for (const [type, flag] of Object.entries(rawTypes as Record<string, unknown>)) {
      if (typeof flag !== 'boolean') continue;
      const name = type.trim();
      if (name.length === 0) continue;
      types[name] = flag;
      hasTypes = true;
    }
  }
  return Object.freeze({ enabled, types: hasTypes ? Object.freeze(types) : EMPTY_TYPES });
}

/**
 * 归一化可见性：五项只接受布尔（缺失按 true），`annotations` 走注解规则。
 *
 * @param visibility 宿主/调用方传入的可见性。
 * @returns 六项齐全的新对象。
 */
export function normalizeLayerVisibility(
  visibility?: LayerVisibility | null,
): ResolvedLayerVisibility {
  const source: Record<string, unknown> =
    typeof visibility === 'object' && visibility !== null
      ? (visibility as unknown as Record<string, unknown>)
      : {};
  return Object.freeze({
    signatures: source['signatures'] !== false,
    annotations: normalizeAnnotationVisibility(source['annotations']),
    custom: source['custom'] !== false,
    foreground: source['foreground'] !== false,
    body: source['body'] !== false,
    background: source['background'] !== false,
  });
}

/**
 * 判断两项可见性是否完全相同（深比较注释类型表）。
 *
 * @param a 左侧可见性。
 * @param b 右侧可见性。
 * @returns 完全相同时 true。
 */
export function layerVisibilityEquals(
  a: LayerVisibility | ResolvedLayerVisibility,
  b: LayerVisibility | ResolvedLayerVisibility,
): boolean {
  const left = normalizeLayerVisibility(a as LayerVisibility);
  const right = normalizeLayerVisibility(b as LayerVisibility);
  for (const key of PAGE_LAYER_KEYS) {
    if (key !== 'annotations' && left[key] !== right[key]) return false;
  }
  return annotationVisibilityEquals(left.annotations, right.annotations);
}

/**
 * 判断注释可见性是否相同（比较总开关与类型表键值集合）。
 *
 * @param a 左侧。
 * @param b 右侧。
 * @returns 相同返回 true。
 */
export function annotationVisibilityEquals(
  a: ResolvedAnnotationVisibility,
  b: ResolvedAnnotationVisibility,
): boolean {
  if (a.enabled !== b.enabled) return false;
  const left = Object.keys(a.types);
  const right = Object.keys(b.types);
  if (left.length !== right.length) return false;
  for (const key of left) {
    if (!Object.prototype.hasOwnProperty.call(b.types, key)) return false;
    if (a.types[key] !== b.types[key]) return false;
  }
  return true;
}

/**
 * 读取单项可见性（仅五项布尔项）。
 *
 * @param visibility 可见性。
 * @param key 图层键；传 `'annotations'` 时返回总开关。
 * @returns 是否可见。
 */
export function readLayerFlag(visibility: LayerVisibility, key: LayerKey): boolean {
  if (key === 'annotations') return readAnnotationEnabled(visibility.annotations);
  return visibility[key] !== false;
}

/**
 * 读取注释总开关；缺失按 true。
 *
 * @param value 注释可见性。
 * @returns 总开关。
 */
export function readAnnotationEnabled(
  value?: boolean | LayerAnnotationVisibility,
): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'object' || value === null) return true;
  return value.enabled !== false;
}

/**
 * 读取某类型的勾选；缺失按 true。
 *
 * @param value 注释可见性。
 * @param type 类型名（引擎原值）。
 * @returns 是否勾选。
 */
export function readAnnotationType(
  value: boolean | LayerAnnotationVisibility | undefined,
  type: AnnotationType,
): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'object' || value === null) return true;
  const types = value.types;
  if (typeof types !== 'object' || types === null) return true;
  return (types as Record<string, boolean>)[type] !== false;
}

/**
 * 列出“勾选的类型”（按类型列表顺序，去重）。
 *
 * @param value 注释可见性。
 * @param types 该页列出的类型。
 * @returns 勾选的类型。
 */
export function selectedAnnotationTypes(
  value: boolean | LayerAnnotationVisibility | undefined,
  types: readonly AnnotationType[],
): AnnotationType[] {
  const result: AnnotationType[] = [];
  for (const type of types) {
    if (result.indexOf(type) >= 0) continue;
    if (readAnnotationType(value, type)) result.push(type);
  }
  return result;
}

/**
 * 注释项是否“有效可见”：总开关打开，且该页列出的类型至少有一个仍勾选。
 *
 * 图层面板的行三态、总项汇总与 `resolveAnnotationFilter()` 的 A 分支必须共用这一
 * 判定，否则“面板显示开、实际过滤关闭”（或相反）会出现口径漂移。
 *
 * @param value 注释可见性。
 * @param types 该页列出的类型。
 * @returns 有效可见时 true。
 */
export function isAnnotationsEffectivelyVisible(
  value: boolean | LayerAnnotationVisibility | undefined,
  types: readonly AnnotationType[],
): boolean {
  if (!readAnnotationEnabled(value)) return false;
  return selectedAnnotationTypes(value, types).length > 0;
}

/**
 * 计算注释项的生效形态（§I.4 的 A/B/C 三分支，零勾选并入 A）。
 *
 * @param value 注释可见性。
 * @param types 该页列出的类型。
 * @returns 生效总开关、写入 `annotationTypes` 的白名单（undefined 表示不写）与是否等价全画。
 */
export function resolveAnnotationFilter(
  value: boolean | LayerAnnotationVisibility | undefined,
  types: readonly AnnotationType[],
): {
  readonly enabled: boolean;
  readonly types: readonly AnnotationType[] | undefined;
  readonly all: boolean;
} {
  const listed = dedupeTypes(types);
  // A：总开关关闭，或零勾选（打开但列出类型一个都没勾）→ 关闭且不写白名单。
  if (!isAnnotationsEffectivelyVisible(value, listed)) {
    return { enabled: false, types: undefined, all: false };
  }
  // 白名单 = 候选全集 ∪ 该页列出类型 中所有“未被显式取消”的类型（§I.4.2）。
  //
  // 引擎白名单语义（`isAnnotationTypeVisible()`）：写出 `annotationTypes` 后，
  // `filter.annotationTypes.has(type)` 之外的注释**一律不画**，包括界面上从未列出的类型。
  // 因此只写“勾选类型”会误伤探测不到的追加类型；这里按“只排除用户明确取消的类型”
  // 计算白名单，看不见的类型默认保持可见。顺序取候选全集（常见五类在前）再接追加类型，
  // 使签名只取决于“取消了哪些类型”，与该页列出的顺序无关。
  const universe = dedupeTypes([...annotationTypeProbeCandidates(), ...listed]);
  const whitelist = universe.filter((type) => readAnnotationType(value, type));
  // B：没有任何显式取消 → 不写白名单（等价全画）。
  if (whitelist.length === universe.length) {
    return { enabled: true, types: undefined, all: true };
  }
  // C：至少一个类型被取消 → 写白名单。
  return { enabled: true, types: whitelist, all: false };
}

/** 四层在签名中的单字母代号；顺序固定 background/body/foreground/custom。 */
const KEY_LAYER_CODES: ReadonlyArray<readonly [LayerKey, string]> = Object.freeze([
  ['background', 'b'],
  ['body', 'o'],
  ['foreground', 'f'],
  ['custom', 'c'],
]);

/**
 * 六项可见性 → 引擎过滤白名单。
 *
 * @param visibility 六项可见性，缺失按 true。
 * @param types 该页列出的注释类型（常见五类 + 该页追加类型，§I.1）；省略按 `[]`。
 * @returns 过滤配置；与全画等价时返回 undefined（不传过滤）。
 */
export function toPageContentFilter(
  visibility: LayerVisibility,
  types: readonly AnnotationType[] = knownAnnotationTypes(),
): PageContentFilter | undefined {
  if (contentFilterKey(visibility, types) === ALL_LAYERS_KEY) return undefined;
  const annotations = resolveAnnotationFilter(visibility.annotations, types);
  const filter: PageContentFilter = {
    layers: {
      background: layerSelection(visibility, 'background'),
      body: layerSelection(visibility, 'body'),
      foreground: layerSelection(visibility, 'foreground'),
      custom: layerSelection(visibility, 'custom'),
    },
    annotations: annotations.enabled,
    signatures: readLayerFlag(visibility, 'signatures'),
  };
  if (annotations.types !== undefined) filter.annotationTypes = annotations.types;
  return filter;
}

/**
 * 过滤签名（与引擎 `resolveContentFilter().key` 同规则）。
 *
 * 形如 `all` / `none` / `layers=b:11,o:11,f:00,c:00;annotations=1;types=Link,Stamp;signatures=0`，
 * 层顺序固定 background/body/foreground/custom（b/o/f/c），每层两位 page/templates
 * （custom 的 templates 恒为 0）；`types=` 为空串表示“全部类型”。
 *
 * @param visibility 六项可见性，缺失按 true。
 * @param types 该页列出的注释类型；省略按 `[]`。
 * @returns 稳定签名。
 */
export function contentFilterKey(
  visibility: LayerVisibility,
  types: readonly AnnotationType[] = knownAnnotationTypes(),
): string {
  return keyOf(normalizeLayerVisibility(visibility), types);
}

/**
 * 该页是否“与全画等价”（不传过滤即可）。
 *
 * @param visibility 六项可见性。
 * @param types 该页列出的注释类型。
 * @returns 等价全画时 true。
 */
export function isAllVisible(
  visibility: LayerVisibility,
  types: readonly AnnotationType[] = knownAnnotationTypes(),
): boolean {
  return contentFilterKey(visibility, types) === ALL_LAYERS_KEY;
}

/**
 * 归一化后的可见性 → 稳定签名。
 *
 * @param visibility 归一化可见性。
 * @param types 该页列出的注释类型。
 * @returns 稳定签名。
 */
function keyOf(visibility: ResolvedLayerVisibility, types: readonly AnnotationType[]): string {
  const annotations = resolveAnnotationFilter(visibility.annotations, types);
  const allLayerFlags =
    visibility.signatures &&
    visibility.custom &&
    visibility.foreground &&
    visibility.body &&
    visibility.background;
  if (allLayerFlags && annotations.all) return ALL_LAYERS_KEY;
  // 与全关等价：四层与注释、签章都不画，引擎把这种配置规范化为 `none`（§B.3）。
  if (allLayersHidden(visibility) && !annotations.enabled && !visibility.signatures) return 'none';
  const layerPart = KEY_LAYER_CODES.map(([key, code]) => {
    const on = visibility[key];
    const templates = on && key !== 'custom' ? '1' : '0';
    return `${code}:${on ? '1' : '0'}${templates}`;
  }).join(',');
  const typesPart = annotations.types === undefined ? '' : annotations.types.join(',');
  return `layers=${layerPart};annotations=${annotations.enabled ? '1' : '0'};types=${typesPart};signatures=${
    visibility.signatures ? '1' : '0'
  }`;
}

/**
 * 四层是否全都不画（只看页面位；模板位与页面位同值，custom 的模板位引擎忽略）。
 *
 * @param visibility 归一化可见性。
 * @returns 四层页面内容全部关闭时 true。
 */
function allLayersHidden(visibility: ResolvedLayerVisibility): boolean {
  return KEY_LAYER_CODES.every(([key]) => !visibility[key]);
}

/**
 * 去重并丢弃空类型名，保留首次出现顺序。
 *
 * @param types 类型列表。
 * @returns 去重后的类型列表。
 */
export function dedupeTypes(types: readonly AnnotationType[]): AnnotationType[] {
  const seen: AnnotationType[] = [];
  for (const raw of types) {
    if (typeof raw !== 'string') continue;
    const type = raw.trim();
    if (type.length === 0) continue;
    if (seen.indexOf(type) >= 0) continue;
    seen.push(type);
  }
  return seen;
}

/**
 * 常见五类（顺序即引擎常量顺序）。
 *
 * @returns 常见类型列表的副本。
 */
export function knownAnnotationTypes(): AnnotationType[] {
  return [...KNOWN_ANNOTATION_TYPES];
}

/**
 * 计算某组的类型列表：常见五类 + 追加类型（字典序，§I.1）。
 *
 * @param extra 该组实际出现的追加类型（引擎原值）。
 * @returns 类型列表；追加部分按 `sort()` 默认比较（UTF-16 码元序、区分大小写）。
 */
export function annotationTypesForGroup(extra: readonly AnnotationType[]): AnnotationType[] {
  const known = knownAnnotationTypes();
  const extras: AnnotationType[] = [];
  for (const raw of dedupeTypes(extra)) {
    if (known.indexOf(raw) >= 0) continue;
    extras.push(raw);
  }
  extras.sort();
  return known.concat(extras);
}

/**
 * 判断类型是否属于常见五类。
 *
 * @param type 类型名。
 * @returns 常见类型返回 true。
 */
export function isKnownAnnotationType(type: AnnotationType): boolean {
  return (KNOWN_ANNOTATION_TYPES as readonly string[]).indexOf(type) >= 0;
}

/**
 * 探测用的候选类型：常见五类 + 探测常量（去重）。
 *
 * @returns 候选类型列表。
 */
export function annotationTypeProbeCandidates(): AnnotationType[] {
  return dedupeTypes([...KNOWN_ANNOTATION_TYPES, ...ANNOTATION_TYPE_PROBE_CANDIDATES]);
}

/**
 * 单层选择：页面与模板同值；custom 的模板位恒为 false（引擎忽略）。
 *
 * @param visibility 可见性。
 * @param key 图层键。
 * @returns 该层选择。
 */
function layerSelection(
  visibility: LayerVisibility,
  key: LayerKey,
): { readonly page: boolean; readonly templates: boolean } {
  const on = readLayerFlag(visibility, key);
  return { page: on, templates: key === 'custom' ? false : on };
}

/**
 * 按页取签名。
 *
 * @param keyOf 由页索引（0-based）读取签名的函数。
 * @param index 页索引，0-based。
 * @returns 该页签名。
 */
export function layerSignature(keyOf: (index: number) => string, index: number): string {
  return keyOf(index);
}

/**
 * 页索引 → 过滤签名；未出现的页等于默认签名。
 *
 * 覆盖表只保存与默认值不同的页，改回默认值的页会被直接删除。
 */
export class PageLayerOverrides {
  /** 默认可见性（归一化）。 */
  private defaultVisibility: ResolvedLayerVisibility;
  /** 页索引（0-based）→ 归一化的覆盖值。 */
  private readonly pages = new Map<number, ResolvedLayerVisibility>();

  /**
   * 创建覆盖表。
   *
   * @param defaults 默认可见性；缺失按可见。
   */
  constructor(defaults: LayerVisibility = createDefaultVisibility()) {
    this.defaultVisibility = normalizeLayerVisibility(defaults);
  }

  /**
   * 默认签名；因签名依赖“列出的类型”，未给类型时按“无追加类型”计算。
   *
   * @returns 默认签名。
   */
  get defaultKey(): string {
    return contentFilterKey(this.defaultVisibility);
  }

  /** 默认可见性（归一化）。 */
  get defaults(): ResolvedLayerVisibility {
    return this.defaultVisibility;
  }

  /**
   * 第 `index` 页（0-based）的过滤签名。
   *
   * 传 `-1` 表示“未覆盖页的签名”（即以默认可见性与空类型表计算），供差异判断使用。
   *
   * @param index 页索引，0-based。
   * @param types 该页列出的注释类型；省略按 `[]`。
   * @returns 签名；未覆盖时使用默认可见性。
   */
  keyAt(index: number, types: readonly AnnotationType[] = knownAnnotationTypes()): string {
    return contentFilterKey(this.visibilityAt(index), types);
  }

  /**
   * 第 `index` 页的过滤配置。
   *
   * @param index 页索引，0-based。
   * @param types 该页列出的注释类型；省略按 `[]`。
   * @returns 过滤配置；等价全画时为 undefined。
   */
  filterAt(index: number, types: readonly AnnotationType[] = knownAnnotationTypes()): PageContentFilter | undefined {
    return toPageContentFilter(this.visibilityAt(index), types);
  }

  /**
   * 第 `index` 页的签名（与 `keyAt` 同义，语义化别名）。
   *
   * @param index 页索引，0-based。
   * @param types 该页列出的注释类型。
   * @returns 签名。
   */
  keyWith(index: number, types: readonly AnnotationType[]): string {
    return this.keyAt(index, types);
  }

  /**
   * 第 `index` 页的过滤配置（与 `filterAt` 同义，语义化别名）。
   *
   * @param index 页索引，0-based。
   * @param types 该页列出的注释类型。
   * @returns 过滤配置；等价全画时为 undefined。
   */
  filterWith(
    index: number,
    types: readonly AnnotationType[],
  ): PageContentFilter | undefined {
    return this.filterAt(index, types);
  }

  /**
   * 第 `index` 页的可见性。
   *
   * 未覆盖（或传 `-1`）时返回冻结的默认值；只读使用，修改请通过 `set()`。
   *
   * @param index 页索引，0-based。
   * @returns 归一化可见性。
   */
  visibilityAt(index: number): ResolvedLayerVisibility {
    return this.pages.get(index) ?? this.defaultVisibility;
  }

  /**
   * 写入一页可见性；与默认值相同的页直接删除覆盖。
   *
   * @param index 页索引，0-based。
   * @param visibility 目标可见性（只覆盖给出的键）；`annotations` 对象里的 `types`
   *   与当前表按键合并（`true` 表示删除该键）。
   * @param types 该页列出的注释类型，用于判断签名是否变化；省略按 `[]`。
   * @returns 签名是否变化。
   */
  set(
    index: number,
    visibility: LayerVisibility,
    types: readonly AnnotationType[] = knownAnnotationTypes(),
  ): boolean {
    const before = this.keyAt(index, types);
    // 未给出的键保留该页当前值（覆盖值或默认值），部分写入不会重置其它项。
    const next = mergeVisibility(this.visibilityAt(index), visibility);
    if (layerVisibilityEquals(next, this.defaultVisibility)) {
      this.pages.delete(index);
    } else {
      this.pages.set(index, next);
    }
    return this.keyAt(index, types) !== before;
  }

  /**
   * 删除一页覆盖。
   *
   * @param index 页索引，0-based。
   * @param types 该页列出的注释类型；省略按 `[]`。
   * @returns 签名是否变化。
   */
  delete(index: number, types: readonly AnnotationType[] = knownAnnotationTypes()): boolean {
    const before = this.keyAt(index, types);
    this.pages.delete(index);
    return this.keyAt(index, types) !== before;
  }

  /** 全部覆盖页索引（升序）。 */
  indices(): number[] {
    return [...this.pages.keys()].sort((a, b) => a - b);
  }

  /**
   * 与指定签名不一致的覆盖页索引（升序）。
   *
   * @param key 目标签名。
   * @param typesOf 按页返回“该页列出的类型”的函数。
   * @returns 页索引列表。
   */
  indicesWhereKeyDiffers(
    key: string,
    typesOf: (index: number) => readonly AnnotationType[] = () => knownAnnotationTypes(),
  ): number[] {
    return this.indices().filter((index) => this.keyAt(index, typesOf(index)) !== key);
  }

  /**
   * 替换默认可见性；与默认值完全相同的覆盖页被删除。
   *
   * @param defaults 新默认可见性。
   * @param typesOf 按页返回“该页列出的类型”的函数；用于判断覆盖页是否真的等价默认值。
   * @returns 是否有页的签名变化。
   */
  setDefaults(
    defaults: LayerVisibility,
    typesOf: (index: number) => readonly AnnotationType[] = () => knownAnnotationTypes(),
  ): boolean {
    const next = normalizeLayerVisibility(defaults);
    // 所有页（含未覆盖页）的签名都依赖默认值，先记下旧签名。
    const previousKeys = new Map<number, string>();
    for (const index of this.pages.keys()) previousKeys.set(index, this.keyAt(index, typesOf(index)));
    const previousDefaultKey = this.keyAt(-1, knownAnnotationTypes());
    this.defaultVisibility = next;
    for (const [index, page] of [...this.pages]) {
      if (layerVisibilityEquals(page, this.defaultVisibility)) this.pages.delete(index);
    }
    if (this.keyAt(-1, knownAnnotationTypes()) !== previousDefaultKey) return true;
    for (const [index, key] of previousKeys) {
      if (this.keyAt(index, typesOf(index)) !== key) return true;
    }
    return false;
  }

  /**
   * 清空全部覆盖。
   *
   * @returns 是否存在被删除的覆盖（覆盖值必然与默认值不同，删除即签名变化）。
   */
  clear(): boolean {
    if (this.pages.size === 0) return false;
    this.pages.clear();
    return true;
  }

  /**
   * 生成对外快照（深拷贝，可安全交给宿主）。
   *
   * @param sessionId 文档会话标识。
   * @returns 冻结的每页覆盖快照。
   */
  clone(sessionId = 0): PageLayerState {
    const pages = objectFromEntries(
      this.indices().map((index): [number, ResolvedLayerVisibility] => [
        index,
        cloneVisibility(this.pages.get(index)!),
      ]),
    ) as Record<number, ResolvedLayerVisibility>;
    return Object.freeze({
      sessionId,
      defaults: cloneVisibility(this.defaultVisibility),
      pages: Object.freeze(pages),
    });
  }
}

/**
 * 深拷贝可见性（注释类型表也复制一份并冻结）。
 *
 * @param visibility 归一化可见性。
 * @returns 新的冻结副本。
 */
export function cloneVisibility(
  visibility: ResolvedLayerVisibility,
): ResolvedLayerVisibility {
  return Object.freeze({
    signatures: visibility.signatures,
    annotations: Object.freeze({
      enabled: visibility.annotations.enabled,
      types: Object.freeze({ ...visibility.annotations.types }),
    }),
    custom: visibility.custom,
    foreground: visibility.foreground,
    body: visibility.body,
    background: visibility.background,
  });
}

/**
 * 合并可见性：未给出的键保留当前值。
 *
 * 五项只接受布尔；`annotations` 接受布尔（直接替换总开关，类型表保留）或对象
 * （`enabled` 覆盖总开关，`types` 按键合并，`true` 表示删除该键）。
 *
 * @param current 该页当前可见性。
 * @param patch 待写入的可见性。
 * @returns 归一化的新对象。
 */
function mergeVisibility(
  current: ResolvedLayerVisibility,
  patch: LayerVisibility,
): ResolvedLayerVisibility {
  const source: Record<string, unknown> =
    typeof patch === 'object' && patch !== null ? (patch as unknown as Record<string, unknown>) : {};
  const result = {
    signatures: current.signatures,
    annotations: current.annotations,
    custom: current.custom,
    foreground: current.foreground,
    body: current.body,
    background: current.background,
  };
  for (const key of PAGE_LAYER_KEYS) {
    if (key === 'annotations') continue;
    const value = source[key];
    if (typeof value === 'boolean') result[key] = value;
  }
  const annotations = source['annotations'];
  if (typeof annotations === 'boolean') {
    result.annotations = Object.freeze({ enabled: annotations, types: current.annotations.types });
  } else if (typeof annotations === 'object' && annotations !== null) {
    const patchValue = annotations as Record<string, unknown>;
    const enabled =
      typeof patchValue['enabled'] === 'boolean'
        ? patchValue['enabled']
        : current.annotations.enabled;
    const types: Record<string, boolean> = { ...current.annotations.types };
    const patchTypes = patchValue['types'];
    if (typeof patchTypes === 'object' && patchTypes !== null) {
      for (const [type, flag] of Object.entries(patchTypes as Record<string, unknown>)) {
        if (typeof flag !== 'boolean') continue;
        const name = type.trim();
        if (name.length === 0) continue;
        if (flag) delete types[name];
        else types[name] = false;
      }
    }
    result.annotations = Object.freeze({ enabled, types: Object.freeze(types) });
  }
  return Object.freeze(result);
}

/**
 * 解析并校验 `layerPanel`：非法输入按默认值处理，不抛错。
 *
 * `enabled`/`disabled` 同时为 true 时 disabled 优先（tab 可见但禁用）；
 * `defaultVisibility` 的五项只接受布尔，`annotations` 接受布尔或对象（§C.2）。
 *
 * @param options 宿主传入的配置。
 * @returns 解析后的配置。
 */
export function resolveLayerPanelOptions(
  options?: LayerPanelOptions | null,
): ResolvedLayerPanelOptions {
  const source: Record<string, unknown> =
    typeof options === 'object' && options !== null
      ? (options as unknown as Record<string, unknown>)
      : {};
  const enabled = typeof source['enabled'] === 'boolean' ? source['enabled'] : true;
  const disabled = typeof source['disabled'] === 'boolean' ? source['disabled'] : false;
  const visibility =
    typeof source['defaultVisibility'] === 'object' && source['defaultVisibility'] !== null
      ? (source['defaultVisibility'] as LayerVisibility)
      : undefined;
  return Object.freeze({
    enabled,
    disabled,
    defaultVisibility: normalizeLayerVisibility(visibility),
  });
}
