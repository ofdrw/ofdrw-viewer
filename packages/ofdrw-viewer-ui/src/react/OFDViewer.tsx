/**
 * React 18/19 薄适配（设计方案 §14.6.2）。
 *
 * 仅负责挂载/卸载、受控属性同步、事件映射与 ref 暴露；阅读器实例只创建一次，
 * 不在 React state 中保存滚动/canvas 等高频状态。
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import type { CSSProperties } from 'react';
import {
  OFDViewer as CoreOFDViewer,
  type ExportImageOptions,
  type ExportImageResult,
  type FeatureState,
  type FindOptions,
  type OFDViewerOptions,
  type ViewerFeature,
  type ViewerSource,
  type ViewerState,
} from '../index';
import {
  bindViewerEvents,
  findEventBridge,
  isZoomMode,
  type FeatureDisplay,
  type Rotation,
  type ScaleValue,
  type SidebarView,
  type Theme,
  type ViewerEventHandlers,
  type ViewerFeatures,
} from '../component/support';

/** React wrapper 暴露的命令句柄。 */
export interface OFDViewerHandle {
  /** 底层实例；尚未挂载时为 null。 */
  getInstance(): CoreOFDViewer | null;
  /** `getInstance` 的别名，便于与其它 wrapper 保持一致。 */
  getViewer(): CoreOFDViewer | null;
  /** 打开/切换文档。 */
  open(source: ViewerSource): Promise<void>;
  /** 关闭文档。 */
  close(): Promise<void>;
  /** 跳转到指定页（1-based）。 */
  goToPage(pageNumber: number): void;
  /** 下一页。 */
  nextPage(): void;
  /** 上一页。 */
  previousPage(): void;
  /** 设置实际缩放倍率。 */
  setScale(scale: number): void;
  /** 设置缩放模式。 */
  setZoomMode(mode: ScaleValue): void;
  /** 设置旋转角度。 */
  setRotation(rotation: Rotation): void;
  /** 合并功能开关。 */
  setFeatures(features: ViewerFeatures): void;
  /** 执行查找。 */
  find(query: string, options?: FindOptions): Promise<void>;
  /** 打印。 */
  print(): Promise<void>;
  /** 导出当前页图片。 */
  exportImage(options?: ExportImageOptions): Promise<ExportImageResult | null>;
  /** 当前状态快照。 */
  getState(): ViewerState | null;
  /** 单个功能状态。 */
  getFeatureState(feature: ViewerFeature): FeatureState | null;
  /** 功能是否可用。 */
  isFeatureEnabled(feature: ViewerFeature): boolean;
}

/** React 组件属性。 */
export interface OFDViewerProps
  extends Omit<
      OFDViewerOptions,
      | 'container'
      | 'source'
      | 'initialPage'
      | 'initialScale'
      | 'sidebar'
      | 'onWarning'
      | 'onError'
    >,
    ViewerEventHandlers {
  /** 文档来源；变化时调用 `open()`，不重建实例。 */
  readonly source: ViewerSource;
  /** 受控页码（1-based）；变化时调用 `goToPage()`。 */
  readonly page?: number;
  /** 受控缩放；数字为倍率，字符串为模式。 */
  readonly scale?: ScaleValue;
  /** 受控侧栏；null 表示关闭。 */
  readonly sidebar?: SidebarView | null;
  /** 首次打开完成回调。 */
  readonly onReady?: () => void;
  /** 外层容器 class。 */
  readonly className?: string;
  /** 外层容器样式；默认占满父容器。 */
  readonly style?: CSSProperties;
}

/** 从 props 中提取构造选项（受控属性单独同步）。 */
function createOptions(
  props: OFDViewerProps,
  container: HTMLElement,
): OFDViewerOptions {
  const {
    source,
    page,
    scale,
    sidebar,
    className: _className,
    style: _style,
    onReady: _onReady,
    onWarning: _onWarning,
    onError: _onError,
    ...rest
  } = props;
  return {
    ...(rest as Omit<OFDViewerOptions, 'container' | 'source'>),
    container,
    source,
    ...(page === undefined ? {} : { initialPage: page }),
    ...(scale === undefined ? {} : { initialScale: scale }),
    ...(sidebar === undefined ? {} : { sidebar }),
  };
}

/** 安全执行同步/异步核心方法，避免受控同步导致渲染树异常。 */
function run(action: () => unknown): void {
  try {
    const result = action();
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // 核心通过 error 事件报告；受控属性同步失败不应中断 React 渲染。
  }
}

/**
 * React 阅读器组件。
 *
 * 使用 `forwardRef` 暴露命令句柄；`source`/`features` 等 prop 变化只调用实例方法。
 */
export const OFDViewer = forwardRef<OFDViewerHandle, OFDViewerProps>(
  function OFDViewer(props, ref) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const viewerRef = useRef<CoreOFDViewer | null>(null);
    const propsRef = useRef(props);
    propsRef.current = props;
    const lastSourceRef = useRef<ViewerSource | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        getInstance: () => viewerRef.current,
        getViewer: () => viewerRef.current,
        open: async (source) => {
          await viewerRef.current?.open(source);
        },
        close: async () => {
          await viewerRef.current?.close();
        },
        goToPage: (pageNumber) => {
          run(() => viewerRef.current?.goToPage(pageNumber));
        },
        nextPage: () => {
          run(() => viewerRef.current?.nextPage());
        },
        previousPage: () => {
          run(() => viewerRef.current?.previousPage());
        },
        setScale: (scale) => {
          run(() => viewerRef.current?.setScale(scale));
        },
        setZoomMode: (mode) => {
          if (isZoomMode(mode)) run(() => viewerRef.current?.setZoomMode(mode));
        },
        setRotation: (rotation) => {
          run(() => viewerRef.current?.setRotation(rotation));
        },
        setFeatures: (features) => {
          run(() => viewerRef.current?.setFeatures(features));
        },
        find: async (query, options) => {
          await viewerRef.current?.find(query, options);
        },
        print: async () => {
          await viewerRef.current?.print();
        },
        exportImage: async (options) => (await viewerRef.current?.exportImage(options)) ?? null,
        getState: () => viewerRef.current?.getState() ?? null,
        getFeatureState: (feature) =>
          viewerRef.current?.getFeatureState(feature) ?? null,
        isFeatureEnabled: (feature) =>
          viewerRef.current?.isFeatureEnabled(feature) ?? false,
      }),
      [],
    );

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      const viewer = new CoreOFDViewer(createOptions(propsRef.current, container));
      viewerRef.current = viewer;
      lastSourceRef.current = propsRef.current.source;
      const unbind = bindViewerEvents(viewer, (event, payload) => {
        const bridge = findEventBridge(event);
        if (!bridge) return;
        const handler = (
          propsRef.current as unknown as Record<
            string,
            ((value: unknown) => void) | undefined
          >
        )[bridge.react];
        handler?.(payload);
      });
      void viewer.ready.then(
        () => {
          if (viewerRef.current === viewer) propsRef.current.onReady?.();
        },
        () => undefined,
      );
      return () => {
        unbind();
        viewer.destroy();
        viewerRef.current = null;
        lastSourceRef.current = null;
      };
    }, []);

    useEffect(() => {
      const viewer = viewerRef.current;
      if (!viewer || lastSourceRef.current === props.source) return;
      lastSourceRef.current = props.source;
      void viewer.open(props.source).catch(() => undefined);
    }, [props.source]);

    useEffect(() => {
      const viewer = viewerRef.current;
      if (!viewer || props.page === undefined) return;
      if (viewer.getPageNumber() !== props.page) run(() => viewer.goToPage(props.page!));
    }, [props.page]);

    useEffect(() => {
      const viewer = viewerRef.current;
      const scale = props.scale;
      if (!viewer || scale === undefined) return;
      if (typeof scale === 'number') run(() => viewer.setScale(scale));
      else if (isZoomMode(scale)) run(() => viewer.setZoomMode(scale));
    }, [props.scale]);

    useEffect(() => {
      const viewer = viewerRef.current;
      if (!viewer || props.rotation === undefined) return;
      if (viewer.getRotation() !== props.rotation) run(() => viewer.setRotation(props.rotation!));
    }, [props.rotation]);

    useEffect(() => {
      const viewer = viewerRef.current;
      if (!viewer || props.theme === undefined) return;
      run(() => viewer.setTheme(props.theme!));
    }, [props.theme]);

    useEffect(() => {
      const viewer = viewerRef.current;
      if (!viewer || props.locale === undefined) return;
      run(() => viewer.setLocale(props.locale!));
    }, [props.locale]);

    useEffect(() => {
      const viewer = viewerRef.current;
      if (!viewer || props.sidebar === undefined) return;
      run(() => {
        if (props.sidebar === null) viewer.closeSidebar();
        else viewer.openSidebar(props.sidebar!);
      });
    }, [props.sidebar]);

    useEffect(() => {
      const viewer = viewerRef.current;
      if (!viewer || props.features === undefined) return;
      run(() => viewer.setFeatures(props.features!));
    }, [props.features]);

    useEffect(() => {
      const viewer = viewerRef.current;
      if (!viewer || props.featureDisplay === undefined) return;
      run(() => viewer.setFeatureDisplay(props.featureDisplay as FeatureDisplay));
    }, [props.featureDisplay]);

    const { className, style } = props;
    return (
      <div
        ref={containerRef}
        className={className}
        style={{ width: '100%', height: '100%', ...style }}
      />
    );
  },
);

OFDViewer.displayName = 'OFDViewer';

export type { Rotation, ScaleValue, SidebarView, Theme, ViewerFeatures };
