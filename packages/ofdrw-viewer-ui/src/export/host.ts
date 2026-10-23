/**
 * 打印/导出模块对阅读器核心的最小依赖。
 *
 * 只声明结构接口，不运行时 import `viewer.ts`：这样输出模块可在不修改核心的
 * 前提下并行开发，也便于单元测试注入内存宿主。`OFDViewer` 结构兼容本接口。
 */

import type {
  DocumentPermissions,
  OFDSource,
  PageInfo,
} from '@ofdrw/ofdrw-viewer-engine';
import type { EnginePage } from '../document-controller';
import type { FeatureState, ViewerFeature } from '../features';
import type { ViewerOrigin } from '../state';

/** 输出模块需要的文档状态子集。 */
export interface OutputDocumentState {
  /** 文档属性；用于生成导出文件名。 */
  readonly metadata?: {
    /** 文档标题；没有 origin 时作为文件名。 */
    readonly title?: string;
  };
  /** 原始来源信息；优先用于推导文件名。 */
  readonly origin?: ViewerOrigin;
  /** 规范化来源；已不再用于命名，保留以兼容既有宿主实现。 */
  readonly source?: OFDSource | null;
}

/** 打印/导出宿主；页码均为 1-based。 */
export interface OutputHost {
  /** 总页数；未打开时为 0。 */
  getPageCount(): number;
  /** 当前页，1-based。 */
  getPageNumber(): number;
  /** 当前阅读旋转角度。 */
  getRotation(): 0 | 90 | 180 | 270;
  /** 全部页尺寸，按页索引升序。 */
  getPageInfos(): readonly PageInfo[];
  /** 读取指定页引擎对象。 */
  getPage(pageNumber: number): Promise<EnginePage>;
  /** 当前文档权限。 */
  getPermissions(): Promise<DocumentPermissions>;
  /** 单个功能的有效状态（已合并宿主配置、文档权限与引擎能力）。 */
  getFeatureState(feature: ViewerFeature): FeatureState;
  /** 读取阅读器 DOM 根节点；用于创建打印节点与下载链接。 */
  getElements(): { readonly root: HTMLElement };
  /** 状态快照；只读取文档名称相关信息。 */
  getState(): { readonly document: OutputDocumentState };
}