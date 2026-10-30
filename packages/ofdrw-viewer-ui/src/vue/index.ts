/**
 * Vue 子路径入口 `@ofdrw/ofdrw-viewer-ui/vue`。
 *
 * 通过公共入口导入 `OFDViewer`，确保单独引入 Vue 子路径时也执行公共入口注册。
 */

import '../compat';
export { OFDViewer } from './OFDViewer';
export type {
  FeatureDisplay,
  Rotation,
  ScaleValue,
  SidebarView,
  Theme,
  ViewerFeatures,
} from '../component/support';
// 构造选项随 props 透传给核心，超采样预设与图层侧栏配置类型一并再导出，
// 避免使用方回到核心入口取。
export type { LayerPanelOptions, OFDViewerOptions, SupersamplePreset } from '../options';
// 显式引用公共入口，保持与 React/Web Component 一致的注册触发方式。
import '../index';