/**
 * “图层”侧栏接线（设计方案 §E.5 / §F / §I）。
 *
 * 把阅读器实例适配成 `layers/layer-panel.ts` 的 `LayerPanelHost`。面板只调用这些
 * 方法，不直接改引擎调用点；宿主的快照、重绘、文本层/查找/缩略图/导出/打印联动
 * 由核心（`OFDViewer`）在 `viewer.ts` 中实现。
 *
 * 核心尚未提供对应能力时（例如只挂 UI 外壳的测试替身）退化为只读：勾选不生效，
 * 面板仍按“全部可见”渲染，注释类型只列常见五类。
 */

import { KNOWN_ANNOTATION_TYPES, type AnnotationType } from '@ofdrw/ofdrw-viewer-engine';
import type { MessageKey, Translator } from '../i18n';
import type { LayerKey, LayerPanelHost, LayerSummary } from '../layers/layer-panel';
import {
  PAGE_LAYER_KEYS,
  annotationTypesForGroup,
  createDefaultVisibility,
  isAnnotationsEffectivelyVisible,
  isKnownAnnotationType,
  type ResolvedLayerVisibility,
} from '../layers/content-filter';
import type { PageLayerState, ViewerState } from '../state';
import type { OFDViewer } from '../viewer';

/** 图层键 → 文案键。 */
const LAYER_LABEL_KEYS: Readonly<Record<LayerKey, MessageKey>> = Object.freeze({
  signatures: 'layers.signatures',
  annotations: 'layers.annotations',
  custom: 'layers.custom',
  foreground: 'layers.foreground',
  body: 'layers.body',
  background: 'layers.background',
});

/** 常见五类 → 文案键（§I.6；禁止用字符串拼接动态生成 `MessageKey`）。 */
const TYPE_LABEL_KEYS: Readonly<Record<string, MessageKey>> = Object.freeze({
  Link: 'layers.type.link',
  Path: 'layers.type.path',
  Highlight: 'layers.type.highlight',
  Stamp: 'layers.type.stamp',
  Watermark: 'layers.type.watermark',
});

/**
 * 六项全可见（含注释全开、类型全勾）。
 *
 * @returns 默认可见性。
 */
function allVisible(): ResolvedLayerVisibility {
  return createDefaultVisibility();
}

/**
 * 生成六项同值的布尔表（总项汇总初值）。
 *
 * @param value 初值。
 * @returns 六项同值的布尔表。
 */
function booleanFlags(value: boolean): Record<LayerKey, boolean> {
  return {
    signatures: value,
    annotations: value,
    custom: value,
    foreground: value,
    body: value,
    background: value,
  };
}

/** 核心可选的图层能力；`OFDViewer` 结构兼容，测试替身可省略。 */
interface LayerCapableViewer {
  readonly getState: () => ViewerState;
  readonly on: OFDViewer['on'];
  readonly getLayerPanelState?: () => PageLayerState;
  readonly resetLayerVisibility?: () => void;
  readonly setPageLayer?: (pageIndex: number, key: LayerKey, value: boolean) => void;
  readonly setLayerForAllPages?: (key: LayerKey, value: boolean) => void;
  readonly setAllLayersVisible?: (visible: boolean) => void;
  readonly setAllLayersVisibleForPage?: (pageIndex: number, visible: boolean) => void;
  readonly setAnnotationTypeForPage?: (
    pageIndex: number,
    type: AnnotationType,
    value: boolean,
  ) => void;
  readonly getExtraAnnotationTypes?: (pageNumber: number) => readonly AnnotationType[];
  readonly ensureAnnotationTypesLoaded?: (pageNumbers: readonly number[]) => Promise<void>;
  readonly readAnnotationTypesInUse?: (group: 'all' | number) => ReadonlySet<string>;
}

/**
 * 读取某页可见性（未覆盖时等于默认值）。
 *
 * 快照只保存与默认值不同的页，其余页等于默认值。
 *
 * @param state 每页覆盖快照。
 * @param pageIndex 页索引，0-based。
 * @returns 归一化可见性。
 */
function pageVisibility(state: PageLayerState, pageIndex: number): ResolvedLayerVisibility {
  return state.pages[pageIndex] ?? state.defaults;
}

/**
 * 创建图层面板的宿主适配器。
 *
 * @param viewer 阅读器实例（或结构兼容的替身）。
 * @param getTranslator 读取当前翻译器。
 * @returns 面板宿主。
 */
export function layerPanelHost(
  viewer: OFDViewer,
  getTranslator: () => Translator,
): LayerPanelHost {
  const host = viewer as unknown as LayerCapableViewer;
  /** 读取快照；核心未提供时返回 undefined。 */
  const snapshot = (): PageLayerState | undefined => host.getLayerPanelState?.();
  /** 读取某页追加类型（未探测时为空）。 */
  const extrasOf = (pageNumber: number): readonly AnnotationType[] =>
    host.getExtraAnnotationTypes ? host.getExtraAnnotationTypes(pageNumber) : [];
  /** 某页应列出的类型：常见五类 + 该页追加类型（核心未实现探测能力时只列常见五类）。 */
  const listedTypes = (pageIndex: number): readonly string[] =>
    annotationTypesForGroup(extrasOf(pageIndex + 1));
  /** 触发懒加载（核心未实现时直接返回）：探测该页与当前页的类型。 */
  const ensureLoaded = (pageIndex: number): void => {
    if (!host.ensureAnnotationTypesLoaded) return;
    const current = host.getState().view.pageNumber;
    const wanted = [pageIndex + 1].concat(current > 0 ? [current] : []);
    void host.ensureAnnotationTypesLoaded(wanted);
  };
  return {
    getState: () => host.getState(),
    readAllState: (): LayerSummary => {
      const state = snapshot();
      const pageCount = host.getState().document.pageCount;
      const allKeysOn: Record<LayerKey, boolean> = booleanFlags(true);
      const allKeysOff: Record<LayerKey, boolean> = booleanFlags(true);
      const everyOn: Record<LayerKey, boolean> = booleanFlags(true);
      for (let index = 0; index < pageCount; index += 1) {
        const page = state ? pageVisibility(state, index) : allVisible();
        // 注释项按“有效开”计数；与过滤层共用同一判定，避免口径漂移（§I.4.1）。
        const annotationsOn = isAnnotationsEffectivelyVisible(page.annotations, listedTypes(index));
        for (const key of PAGE_LAYER_KEYS) {
          const visible = key === 'annotations' ? annotationsOn : page[key];
          if (!visible) allKeysOn[key] = false;
          else allKeysOff[key] = false;
          if (index === 0) everyOn[key] = visible;
          else everyOn[key] = everyOn[key] && visible;
        }
      }
      const values = PAGE_LAYER_KEYS.map((key) => everyOn[key]);
      const summary =
        values.every(Boolean) ? 'on' : values.every((value) => !value) ? 'off' : 'mixed';
      return { allKeysOn, allKeysOff, state: summary };
    },
    readPageState: (pageIndex: number) => {
      const state = snapshot();
      return state ? pageVisibility(state, pageIndex) : allVisible();
    },
    setPageLayer: (pageIndex, key, value) => host.setPageLayer?.(pageIndex, key, value),
    setLayerForAllPages: (key, value) => host.setLayerForAllPages?.(key, value),
    setAllLayersVisible: (visible) => host.setAllLayersVisible?.(visible),
    setAllLayersVisibleForPage: (pageIndex, visible) =>
      host.setAllLayersVisibleForPage?.(pageIndex, visible),
    resetLayerVisibility: () => host.resetLayerVisibility?.(),
    onStateChange: (handler) => host.on('statechange', (state) => handler(state)),
    isDisabled: () => false,
    getDisabledReason: () => getTranslator().t('layers.disabled'),
    getTranslator,
    getLayerLabel: (key) => getTranslator().t(LAYER_LABEL_KEYS[key]),
    getAnnotationTypeLabel: (type) => {
      const key = TYPE_LABEL_KEYS[type];
      // 常见五类本地化；追加类型不翻译，直接显示引擎原值（§I.6）。
      if (key !== undefined && isKnownAnnotationType(type)) return getTranslator().t(key);
      return type;
    },
    readAnnotationTypes: (pageIndex) => {
      ensureLoaded(pageIndex);
      return listedTypes(pageIndex);
    },
    readAnnotationTypesInUse: (pageIndex) => {
      if (host.readAnnotationTypesInUse) return host.readAnnotationTypesInUse(pageIndex);
      return new Set(extrasOf(pageIndex + 1));
    },
    setAnnotationTypeForPage: (pageIndex, type, value) =>
      host.setAnnotationTypeForPage?.(pageIndex, type, value),
  };
}

/** 常见五类（供测试与外壳复用）。 */
export const KNOWN_TYPES: readonly AnnotationType[] = KNOWN_ANNOTATION_TYPES;
