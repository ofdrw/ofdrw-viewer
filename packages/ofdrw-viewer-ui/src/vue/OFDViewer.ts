/**
 * Vue 3 薄适配（设计方案 §14.6.3）。
 *
 * 实例使用 `shallowRef` + `markRaw`，不进入响应式代理；props 变化只调用核心
 * 方法，组件本身不保存滚动/canvas 状态。
 */
import {
  defineComponent,
  h,
  markRaw,
  onBeforeUnmount,
  onMounted,
  shallowRef,
  watch,
} from 'vue';
import type { PropType } from 'vue';
import {
  OFDViewer as CoreOFDViewer,
  type ActionOutcome,
  type CertificateSource,
  type CertificateSummary,
  type ExportImageOptions,
  type ExportImageResult,
  type ExportOfdOptions,
  type ExportOfdResult,
  type FeatureState,
  type FindOptions,
  type LocalFontsStatus,
  type OFDViewerOptions,
  type VerificationReport,
  type ViewerFeature,
  type ViewerSource,
  type ViewerState,
} from '../index';
import {
  VIEWER_EVENT_BRIDGES,
  bindViewerEvents,
  isZoomMode,
  type FeatureDisplay,
  type Rotation,
  type ScaleValue,
  type SidebarView,
  type Theme,
  type VueViewerEventName,
  type ViewerFeatures,
} from '../component/support';

/** 构造选项；组件公共 props 会覆盖同名项。 */
type AdvancedOptions = Omit<OFDViewerOptions, 'container' | 'source'>;

/**
 * 阅读器尚未挂载时的本机字体状态。
 *
 * 与 Web Component / React 同义：没有实例就按「能力不可见、开关关闭、尚未表态」
 * 返回，使 `expose` 方法在挂载前调用也能拿到完整快照。
 */
const DISABLED_LOCAL_FONTS_STATUS: LocalFontsStatus = Object.freeze({
  supported: false,
  enabled: false,
  userState: 'undecided',
  permission: 'unsupported',
  visible: false,
  loading: false,
});

/**
 * Vue emits 名称。
 *
 * 由 {@link VIEWER_EVENT_BRIDGES} 派生：桥接表新增事件时自动进入 emits，不再维护
 * 第二份手抄清单。
 */
const EMITS: string[] = ['ready', ...VIEWER_EVENT_BRIDGES.map((bridge) => bridge.vue)];

/** 核心事件名到 Vue emit 名称的映射；由桥接表派生。 */
const VUE_EVENT_NAMES: ReadonlyMap<string, string> = new Map(
  VIEWER_EVENT_BRIDGES.map((bridge) => [bridge.event as string, bridge.vue]),
);

/**
 * emits 覆盖性断言（编译期）。
 *
 * 桥接表里的每个 Vue 事件名都必须出现在 {@link EMITS} 中，否则 `emit` 会被 Vue 静默
 * 丢弃；漏登记时此处的联合类型不可赋值给 `never`，typecheck 失败。
 */
type EmittedVueEventName = (typeof EMITS)[number];
type UnemittedVueEventName = Exclude<VueViewerEventName, EmittedVueEventName>;
const _assertAllVueEventsEmitted: UnemittedVueEventName extends never ? true : never = true;
void _assertAllVueEventsEmitted;

/** 执行同步/异步核心方法并吞掉受控同步错误。 */
function run(action: () => unknown): void {
  try {
    const result = action();
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // 核心通过 error 事件报告。
  }
}

/**
 * Vue 阅读器组件。
 *
 * 模板外只创建一个外层 `div`，阅读器自行在其内部建立 DOM；`expose` 提供实例与
 * 常用命令，`emits` 使用 kebab-case。
 */
export const OFDViewer = defineComponent({
  name: 'OFDViewer',
  inheritAttrs: false,
  props: {
    /** 文档来源；省略时读取页面查询参数 `?file=` / `?base64=`。 */
    source: {
      type: [String, Object] as PropType<ViewerSource>,
      default: undefined,
    },
    /** 受控页码（1-based）。 */
    page: { type: Number, default: undefined },
    /** 受控缩放。 */
    scale: {
      type: [Number, String] as PropType<ScaleValue>,
      default: undefined,
    },
    /** 受控旋转。 */
    rotation: { type: Number as PropType<Rotation>, default: undefined },
    /** 受控主题。 */
    theme: { type: String as PropType<Theme>, default: undefined },
    /** 受控语言。 */
    locale: { type: String, default: undefined },
    /** 受控侧栏；null 表示关闭。 */
    sidebar: { type: String as PropType<SidebarView | null>, default: undefined },
    /** 功能补丁。 */
    features: { type: Object as PropType<ViewerFeatures>, default: undefined },
    /** 功能展示方式。 */
    featureDisplay: {
      type: [String, Object] as PropType<FeatureDisplay>,
      default: undefined,
    },
    /** 高级构造选项；公共 props 优先。 */
    options: { type: Object as PropType<AdvancedOptions>, default: undefined },
  },
  emits: EMITS,
  setup(props, { attrs, emit, expose }) {
    const container = shallowRef<HTMLElement | null>(null);
    const viewer = shallowRef<CoreOFDViewer | null>(null);
    let lastSource: ViewerSource | undefined;

    /** 创建实例并绑定事件。 */
    function createViewer(element: HTMLElement): void {
      const advanced = props.options ?? {};
      const created = new CoreOFDViewer({
        ...advanced,
        container: element,
        ...(props.source === undefined ? {} : { source: props.source }),
        ...(props.page === undefined ? {} : { initialPage: props.page }),
        ...(props.scale === undefined ? {} : { initialScale: props.scale }),
        ...(props.rotation === undefined ? {} : { rotation: props.rotation }),
        ...(props.theme === undefined ? {} : { theme: props.theme }),
        ...(props.locale === undefined ? {} : { locale: props.locale }),
        ...(props.sidebar === undefined ? {} : { sidebar: props.sidebar }),
        ...(props.features === undefined ? {} : { features: props.features }),
        ...(props.featureDisplay === undefined
          ? {}
          : { featureDisplay: props.featureDisplay as FeatureDisplay }),
      });
      viewer.value = markRaw(created);
      lastSource = props.source;
      bindViewerEvents(created, (event, payload) => {
        const name = VUE_EVENT_NAMES.get(event);
        if (name) (emit as (event: string, ...args: unknown[]) => void)(name, payload);
      });
      void created.ready.then(
        () => {
          if (viewer.value === created) (emit as (event: string) => void)('ready');
        },
        () => undefined,
      );
    }

    onMounted(() => {
      const element = container.value;
      if (!element || viewer.value) return;
      createViewer(element);
    });

    onBeforeUnmount(() => {
      viewer.value?.destroy();
      viewer.value = null;
      lastSource = undefined;
    });

    watch(
      () => props.source,
      (source) => {
        const instance = viewer.value;
        if (!instance || source === lastSource) return;
        lastSource = source;
        void instance.open(source).catch(() => undefined);
      },
    );

    watch(
      () => props.page,
      (page) => {
        const instance = viewer.value;
        if (!instance || page === undefined || instance.getPageNumber() === page) return;
        run(() => instance.goToPage(page));
      },
    );

    watch(
      () => props.scale,
      (scale) => {
        const instance = viewer.value;
        if (!instance || scale === undefined) return;
        if (typeof scale === 'number') run(() => instance.setScale(scale));
        else if (isZoomMode(scale)) run(() => instance.setZoomMode(scale));
      },
    );

    watch(
      () => props.rotation,
      (rotation) => {
        const instance = viewer.value;
        if (!instance || rotation === undefined || instance.getRotation() === rotation) return;
        run(() => instance.setRotation(rotation));
      },
    );

    watch(
      () => props.theme,
      (theme) => {
        const instance = viewer.value;
        if (!instance || theme === undefined) return;
        run(() => instance.setTheme(theme));
      },
    );

    watch(
      () => props.locale,
      (locale) => {
        const instance = viewer.value;
        if (!instance || locale === undefined) return;
        run(() => instance.setLocale(locale));
      },
    );

    watch(
      () => props.sidebar,
      (sidebar) => {
        const instance = viewer.value;
        if (!instance || sidebar === undefined) return;
        run(() => {
          if (sidebar === null) instance.closeSidebar();
          else instance.openSidebar(sidebar);
        });
      },
    );

    watch(
      () => props.features,
      (features) => {
        const instance = viewer.value;
        if (!instance || features === undefined) return;
        run(() => instance.setFeatures(features));
      },
      { deep: true },
    );

    watch(
      () => props.featureDisplay,
      (display) => {
        const instance = viewer.value;
        if (!instance || display === undefined) return;
        run(() => instance.setFeatureDisplay(display as FeatureDisplay));
      },
    );

    expose({
      getInstance: () => viewer.value,
      getViewer: () => viewer.value,
      open: async (source?: ViewerSource) => {
        await viewer.value?.open(source);
      },
      close: async () => {
        await viewer.value?.close();
      },
      goToPage: (pageNumber: number) => {
        run(() => viewer.value?.goToPage(pageNumber));
      },
      nextPage: () => {
        run(() => viewer.value?.nextPage());
      },
      previousPage: () => {
        run(() => viewer.value?.previousPage());
      },
      setScale: (scale: number) => {
        run(() => viewer.value?.setScale(scale));
      },
      setZoomMode: (mode: ScaleValue) => {
        if (isZoomMode(mode)) run(() => viewer.value?.setZoomMode(mode));
      },
      setRotation: (rotation: Rotation) => {
        run(() => viewer.value?.setRotation(rotation));
      },
      setFeatures: (features: ViewerFeatures) => {
        run(() => viewer.value?.setFeatures(features));
      },
      find: async (query: string, options?: FindOptions) => {
        await viewer.value?.find(query, options);
      },
      print: async () => {
        await viewer.value?.print();
      },
      exportImage: async (
        options?: ExportImageOptions,
      ): Promise<ExportImageResult | null> =>
        (await viewer.value?.exportImage(options)) ?? null,
      exportOfd: async (
        options?: ExportOfdOptions,
      ): Promise<ExportOfdResult | null> =>
        (await viewer.value?.exportOfd(options)) ?? null,
      getState: (): ViewerState | null => viewer.value?.getState() ?? null,
      getFeatureState: (feature: ViewerFeature): FeatureState | null =>
        viewer.value?.getFeatureState(feature) ?? null,
      isFeatureEnabled: (feature: ViewerFeature): boolean =>
        viewer.value?.isFeatureEnabled(feature) ?? false,
      verify: async (options?: {
        readonly signatureIds?: readonly string[];
        readonly signal?: AbortSignal;
      }): Promise<VerificationReport> => {
        if (!viewer.value) throw new Error('阅读器尚未挂载');
        return viewer.value.verify(options);
      },
      getVerificationReport: (): VerificationReport | undefined =>
        viewer.value?.getVerificationReport(),
      setRootCertificates: async (
        roots: readonly CertificateSource[],
      ): Promise<readonly CertificateSummary[]> =>
        (await viewer.value?.setRootCertificates(roots)) ?? [],
      getRootCertificates: (): readonly CertificateSummary[] =>
        viewer.value?.getRootCertificates() ?? [],
      openVerificationPanel: (): void => {
        run(() => viewer.value?.openVerificationPanel());
      },
      getLocalFontsStatus: (): LocalFontsStatus =>
        viewer.value?.getLocalFontsStatus() ?? DISABLED_LOCAL_FONTS_STATUS,
      setLocalFontsEnabled: async (enabled: boolean): Promise<void> => {
        if (!viewer.value) throw new Error('阅读器尚未挂载');
        return viewer.value.setLocalFontsEnabled(enabled);
      },
      onLocalFontsStatusChange: (
        handler: (status: LocalFontsStatus) => void,
      ): (() => void) =>
        viewer.value?.onLocalFontsStatusChange(handler) ?? (() => undefined),
      /**
       * 手动执行某页的指定事件动作（UI 动作处理机制设计 §14.1）。
       *
       * @param pageIndex 页索引，0-based。
       * @param event 动作事件。
       * @param options 取消信号。
       * @returns 每个动作的执行结果。
       */
      executeActions: async (
        pageIndex: number,
        event: 'DO' | 'PO' | 'CLICK',
        options?: { readonly signal?: AbortSignal },
      ): Promise<readonly ActionOutcome[]> => {
        if (!viewer.value) throw new Error('阅读器尚未挂载');
        return viewer.value.executeActions(pageIndex, event, options);
      },
      /** 读取「自动执行文档动作」开关；动作模块未挂载时为 undefined。 */
      getAutoExecuteActions: (): boolean | undefined =>
        viewer.value?.getAutoExecuteActions(),
      /** 设置「自动执行文档动作」开关（不持久化）。 */
      setAutoExecuteActions: (enabled: boolean): void => {
        run(() => viewer.value?.setAutoExecuteActions(enabled));
      },
      /** 读取该开关是否允许用户修改；动作模块未挂载时为 undefined。 */
      getAutoExecuteActionsToggleAllowed: (): boolean | undefined =>
        viewer.value?.getAutoExecuteActionsToggleAllowed(),
    });

    return () =>
      h('div', {
        ...attrs,
        ref: container,
        style: [{ width: '100%', height: '100%' }, attrs.style as unknown],
      });
  },
});

export type { Rotation, ScaleValue, SidebarView, Theme, ViewerFeatures };