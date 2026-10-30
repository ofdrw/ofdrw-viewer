/**
 * React 子路径入口 `@ofdrw/ofdrw-viewer-ui/react`。
 *
 * 通过公共入口导入 `OFDViewer`，确保使用方只引入 React 子路径时也会触发
 * 公共入口的模块注册（内置 UI / 文本 / 导航 / 签章 / 打印 / 导出）。
 */

import '../compat';
export { OFDViewer } from './OFDViewer';
export type { OFDViewerHandle, OFDViewerProps } from './OFDViewer';
export type {
  FeatureDisplay,
  Rotation,
  ScaleValue,
  SidebarView,
  Theme,
  ViewerEventHandlers,
  ViewerFeatures,
} from '../component/support';
// 构造选项随 props 透传给核心，超采样预设与图层侧栏配置类型一并再导出，
// 避免使用方回到核心入口取。
export type { LayerPanelOptions, OFDViewerOptions, SupersamplePreset } from '../options';

// 显式引用公共入口：构建时保留该依赖，运行时不重复实现阅读器。
import '../index';