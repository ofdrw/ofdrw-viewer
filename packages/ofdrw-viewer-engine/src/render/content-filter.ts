/**
 * 页级绘制内容过滤（白名单）的公共类型与规范化。
 *
 * 语义：不传过滤配置表示全部绘制；传了配置则只绘制配置中显式启用的内容。
 * 本文件只做纯数据判定，无 I/O、不依赖 DOM/Node，绘制、导出与文本收集共用同一组判定函数。
 */

/** 页面图层类型；顺序即默认绘制顺序（Background → Body → Foreground → Custom）。 */
type ContentLayer = 'Background' | 'Body' | 'Foreground' | 'Custom';

/** 所有内容层，按绘制顺序排列。 */
const CONTENT_LAYERS: readonly ContentLayer[] = ['Background', 'Body', 'Foreground', 'Custom'];

/** 层在稳定签名中的单字母代号：b/o/f/c 依次为 background/body/foreground/custom。 */
const LAYER_KEY_LETTERS: Readonly<Record<ContentLayer, string>> = {
  Background: 'b',
  Body: 'o',
  Foreground: 'f',
  Custom: 'c',
};

/**
 * 层配置的规范化结果。
 *
 * @property page 是否绘制该层的页面自身内容。
 * @property templates 是否绘制归属于该层的模板内容；Custom 层恒为 false。
 */
type LayerSelection = { page: boolean; templates: boolean };

/** OFD 规范中的常见注释类型。 */
export const KNOWN_ANNOTATION_TYPES = Object.freeze([
  'Link',
  'Path',
  'Highlight',
  'Stamp',
  'Watermark',
] as const);

/** 常见注释类型。 */
export type KnownAnnotationType = (typeof KNOWN_ANNOTATION_TYPES)[number];

/** 注释类型：常见类型有字面量提示，同时允许宿主自定义扩展。 */
export type AnnotationType = KnownAnnotationType | (string & {});

/** 单个内容层的白名单配置；字段缺省表示不绘制该来源。 */
export interface DrawLayerOptions {
  /** 是否绘制该层中页面自身的内容，缺省 false。 */
  page?: boolean;
  /** 是否绘制该层中的模板内容，缺省 false；Custom 层没有模板归属，忽略。 */
  templates?: boolean;
}

/** 页级绘制内容白名单；不传 filter 表示全部绘制。 */
export interface PageContentFilter {
  /**
   * 各内容层配置。出现即参与白名单；未出现的层不绘制。
   * 布尔 true 等价于 { page: true, templates: true }，false 等价于不绘制。
   */
  layers?: {
    background?: boolean | DrawLayerOptions;
    body?: boolean | DrawLayerOptions;
    foreground?: boolean | DrawLayerOptions;
    custom?: boolean | DrawLayerOptions;
  };
  /**
   * 是否绘制注释，缺省 false。
   * 为 false 时 annotationTypes 被忽略。
   */
  annotations?: boolean;
  /**
   * 只绘制这些注释类型；出现时即使 annotations 未显式 true，也按白名单绘制。
   * 空数组表示不绘制任何注释。
   */
  annotationTypes?: readonly AnnotationType[];
  /** 是否绘制签章戳记，缺省 false。签章不是注释，单独控制。 */
  signatures?: boolean;
}

/** 规范化后的过滤结果；不导出。 */
export interface ResolvedContentFilter {
  /** 未传 filter，全部绘制。 */
  all: boolean;
  /** 每层白名单；all=true 时无意义。 */
  layers: Record<ContentLayer, LayerSelection>;
  /** 是否绘制注释。 */
  annotations: boolean;
  /** 注释类型白名单；null 表示全部类型。 */
  annotationTypes: ReadonlySet<string> | null;
  /** 是否绘制签章。 */
  signatures: boolean;
  /** 稳定签名，供文本缓存与 UI 重绘判断。 */
  key: string;
}

/** 层配置键到内容层的映射；层键书写顺序不影响规范化结果。 */
const LAYER_KEYS: ReadonlyArray<readonly [keyof NonNullable<PageContentFilter['layers']>, ContentLayer]> = [
  ['background', 'Background'],
  ['body', 'Body'],
  ['foreground', 'Foreground'],
  ['custom', 'Custom'],
];

/** 不画任何层的层配置。 */
function emptyLayers(): Record<ContentLayer, LayerSelection> {
  return {
    Background: { page: false, templates: false },
    Body: { page: false, templates: false },
    Foreground: { page: false, templates: false },
    Custom: { page: false, templates: false },
  };
}

/**
 * 把单个层配置值规范化为来源开关。
 *
 * 非法值（非布尔、非对象、非 true 的字段值）按“未指定”处理，即不绘制；Custom 层忽略模板位。
 *
 * @param value 宿主传入的层配置值。
 * @param layer 该配置对应的内容层。
 * @returns 该层的页面/模板来源开关。
 */
function normalizeLayerValue(value: unknown, layer: ContentLayer): LayerSelection {
  const allowsTemplates = layer !== 'Custom';
  if (value === true) return { page: true, templates: allowsTemplates };
  if (typeof value === 'object' && value !== null) {
    const options = value as Record<string, unknown>;
    return { page: options['page'] === true, templates: allowsTemplates && options['templates'] === true };
  }
  return { page: false, templates: false };
}

/**
 * 规范化注释类型白名单。
 *
 * 非数组按“未指定”处理（返回 null）；数组内的非字符串项忽略，字符串 trim 后去重并保持首次出现顺序，
 * 匹配区分大小写。
 *
 * @param value 宿主传入的注释类型数组。
 * @returns 去重后的顺序列表；未指定返回 null。
 */
function normalizeAnnotationTypes(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  for (const item of value as unknown[]) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    seen.add(trimmed);
  }
  return [...seen];
}

/**
 * 生成稳定签名；语义相同而字段书写顺序不同的配置得到同一个 key。
 *
 * @param layers 每层来源开关。
 * @param annotations 是否绘制注释。
 * @param annotationTypes 注释类型白名单（已去重、trim）；null 为全部类型。
 * @param signatures 是否绘制签章。
 * @returns 形如 `none` / `layers=...;annotations=...;types=...;signatures=...` 的签名。
 */
function buildFilterKey(
  layers: Record<ContentLayer, LayerSelection>,
  annotations: boolean,
  annotationTypes: readonly string[] | null,
  signatures: boolean,
): string {
  const layerPart = CONTENT_LAYERS.map((layer) => {
    const selection = layers[layer];
    const flag = `${selection.page ? '1' : '0'}${selection.templates ? '1' : '0'}`;
    return `${LAYER_KEY_LETTERS[layer]}:${flag}`;
  }).join(',');
  const typesPart = annotationTypes === null ? '' : annotationTypes.join(',');
  const key = `layers=${layerPart};annotations=${annotations ? '1' : '0'};types=${typesPart};signatures=${signatures ? '1' : '0'}`;
  const drawingNothing =
    !annotations && !signatures && CONTENT_LAYERS.every((layer) => {
      const selection = layers[layer];
      return !selection.page && !selection.templates;
    });
  return drawingNothing && typesPart === '' ? 'none' : key;
}

/**
 * 规范化过滤配置；未传返回“全画”。
 *
 * 未传 filter（含 undefined/null）或与全画等价的配置归一化为 `all`；什么都不画的配置归一化为 `none`；
 * 其余配置生成稳定 key。非法输入不抛错，按“未指定”处理。
 *
 * @param filter 宿主传入的过滤配置；缺省表示全部绘制。
 * @returns 规范化后的过滤结果。
 */
export function resolveContentFilter(filter?: PageContentFilter): ResolvedContentFilter {
  if (filter === undefined || filter === null || typeof filter !== 'object') {
    return {
      all: true,
      layers: { Background: { page: true, templates: true }, Body: { page: true, templates: true }, Foreground: { page: true, templates: true }, Custom: { page: true, templates: false } },
      annotations: true,
      annotationTypes: null,
      signatures: true,
      key: 'all',
    };
  }

  const layers = emptyLayers();
  const rawLayers = (filter as PageContentFilter).layers;
  if (typeof rawLayers === 'object' && rawLayers !== null) {
    for (const [property, layer] of LAYER_KEYS) {
      const value = (rawLayers as Record<string, unknown>)[property];
      if (value === undefined) continue;
      layers[layer] = normalizeLayerValue(value, layer);
    }
  }

  const rawAnnotations = (filter as PageContentFilter).annotations;
  const rawSignatures = (filter as PageContentFilter).signatures;
  const rawTypes = (filter as PageContentFilter).annotationTypes;
  const parsedTypes = normalizeAnnotationTypes(rawTypes);
  // annotationTypes 出现即按白名单开启注释；annotations 显式 false 时忽略类型列表。
  const annotations = rawAnnotations === false ? false : rawAnnotations === true || parsedTypes !== null;
  const annotationTypes = annotations && parsedTypes !== null ? new Set(parsedTypes) : null;
  // 被忽略的类型列表不进入签名，保证“annotations:false + 任意类型”得到同一个 key。
  const effectiveTypes = annotations ? parsedTypes : null;
  const signatures = rawSignatures === true;

  if (annotationTypes === null && isAllVisible(layers, annotations, signatures)) {
    return {
      all: true,
      layers: { Background: { page: true, templates: true }, Body: { page: true, templates: true }, Foreground: { page: true, templates: true }, Custom: { page: true, templates: false } },
      annotations: true,
      annotationTypes: null,
      signatures: true,
      key: 'all',
    };
  }
  const key = buildFilterKey(layers, annotations, effectiveTypes, signatures);
  return { all: false, layers, annotations, annotationTypes, signatures, key };
}

/**
 * 判断配置是否与“全画”等价；调用方需先确认注释没有类型白名单。
 *
 * @param layers 每层来源开关。
 * @param annotations 是否绘制注释。
 * @param signatures 是否绘制签章。
 * @returns 与全画等价返回 true。
 */
function isAllVisible(
  layers: Record<ContentLayer, LayerSelection>,
  annotations: boolean,
  signatures: boolean,
): boolean {
  if (!annotations || !signatures) return false;
  return CONTENT_LAYERS.every((layer) => {
    const selection = layers[layer];
    const templatesExpected = layer !== 'Custom';
    return selection.page && selection.templates === templatesExpected;
  });
}

/**
 * 判断页面自身的某个内容层是否绘制。
 *
 * @param filter 规范化后的过滤结果。
 * @param layer 页面图层类型。
 * @returns 绘制返回 true。
 */
export function isPageLayerVisible(filter: ResolvedContentFilter, layer: ContentLayer): boolean {
  if (filter.all) return true;
  const selection: LayerSelection | undefined = filter.layers[layer];
  return selection !== undefined && selection.page;
}

/**
 * 判断归属某个内容层的模板是否绘制。
 *
 * 模板按 `Template/@ZOrder` 归属过滤，不按模板内部 `Layer/@Type` 过滤；
 * 传入 Custom 没有模板归属，恒返回 false。
 *
 * @param filter 规范化后的过滤结果。
 * @param layer 模板归属的内容层。
 * @returns 绘制返回 true。
 */
export function isTemplateLayerVisible(
  filter: ResolvedContentFilter,
  layer: ContentLayer,
): boolean {
  if (filter.all) return true;
  if (layer === 'Custom') return false;
  const selection: LayerSelection | undefined = filter.layers[layer];
  return selection !== undefined && selection.templates;
}

/**
 * 判断注释类型是否通过白名单。
 *
 * 类型使用 `Annotation.type` 原值匹配，区分大小写；白名单模式下类型缺失视为不匹配。
 *
 * @param filter 规范化后的过滤结果。
 * @param type 注释类型；缺省视为未知类型。
 * @returns 绘制返回 true。
 */
export function isAnnotationTypeVisible(
  filter: ResolvedContentFilter,
  type: string | undefined,
): boolean {
  if (filter.all) return true;
  if (!filter.annotations) return false;
  if (filter.annotationTypes === null) return true;
  if (typeof type !== 'string') return false;
  return filter.annotationTypes.has(type);
}

/**
 * 判断签章是否绘制。
 *
 * @param filter 规范化后的过滤结果。
 * @returns 绘制返回 true。
 */
export function isSignatureVisible(filter: ResolvedContentFilter): boolean {
  return filter.all || filter.signatures;
}
