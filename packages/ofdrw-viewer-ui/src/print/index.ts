/**
 * 打印模块入口。
 *
 * 模块加载时向阅读器注册 `PrintService`：`viewer.print()` 由此可用。
 * t9 入口会 side-effect import 本文件。
 */

import { registerViewerExtension } from '../viewer';
import { PrintService } from './print-service';

/** 将打印服务挂到阅读器实例。 */
registerViewerExtension((viewer) => viewer.attachPrintService(new PrintService(viewer)));

export { PrintService } from './print-service';
export type { PrintRequestOptions } from './print-service';
export {
  buildPrintCss,
  collectSizeGroups,
  preparePrintDocument,
  printPreparedDocument,
} from './print-document';
export type {
  PreparePrintOptions,
  PreparedPrintDocument,
  PreparedPrintPage,
} from './print-document';