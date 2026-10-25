/**
 * `@ofdrw/ofdrw-viewer-ui` 公共入口。
 *
 * 加载顺序约定：
 * 1. 先安装内置 UI 外壳扩展；
 * 2. 再加载各能力模块的副作用入口，模块顶层会调用 `registerViewerExtension`。
 *
 * ES 模块的静态 import 会先于模块体执行，因此这里保留显式的“安装 UI → 副作用
 * import”源码顺序；各模块的注册本身是幂等的，且导航模块会在 UI 外壳尚未就绪时
 * 延迟绑定，不依赖 import 的求值顺序。
 *
 * 核心入口只导出框架无关的阅读器与类型，不 import React/Vue。框架适配器分别通过
 * `./react`、`./vue`、`./element` 子路径接入。
 */

import './compat';

import { registerViewerExtension } from './viewer';
import { installUIShell } from './ui';

// 内置工具栏/侧栏/查找栏等 UI 外壳。
installUIShell(registerViewerExtension);

// 能力模块：顶层 registerViewerExtension 注册文本/查找、导航、签章、打印、导出。
import './text/index';
import './views/nav';
import './views/signatures';
import './print/index';
import './export/index';

// ---------------------------------------------------------------------------
// 核心实例与扩展 API
// ---------------------------------------------------------------------------
export { OFDViewer, registerViewerExtension } from './viewer';
export type { ViewerExtension } from './viewer';

// ---------------------------------------------------------------------------
// 构造选项
// ---------------------------------------------------------------------------
export type {
  CertificateInputLoader,
  CertificateSource,
  CryptoViewerOptions,
  DebugViewerOptions,
  OFDViewerOptions,
  ResolvedViewerOptions,
} from './options';
export type {
  CertificateSummary,
  CryptoCredential,
  CryptoOptions,
  OfdInspection,
  SignatureVerification,
  VerificationReport,
  VerificationStatus,
} from '@ofdrw/ofdrw-viewer-crypto';

// ---------------------------------------------------------------------------
// 诊断体系：UI 码表、级别映射、格式化与控制台打印机
// ---------------------------------------------------------------------------
export {
  DiagnosticPrinter,
  UI_WARNING_CODES,
  UI_WARNING_LEVELS,
  formatDiagnostic,
  resolveDiagnosticLevel,
} from './diagnostics';
export type {
  DiagnosticLevel,
  DiagnosticPrinterOptions,
  DiagnosticSource,
  ViewerDiagnostic,
  UIWarningCode,
} from './diagnostics';

// ---------------------------------------------------------------------------
// 字体配置：来源、解析器与引擎字体类型
// ---------------------------------------------------------------------------
export { FontSourceResolver, composeFontAliases } from './font';
export type {
  FontSource,
  FontSourceLoader,
  FontSourceResolverOptions,
  LocalFontDeclaration,
  LocalFontsOptions,
  ViewerFontOptions,
} from './font';
export type {
  FontAliasTable,
  FontInput,
  FontMatchRequest,
  FontProvider,
} from '@ofdrw/ofdrw-viewer-engine';

// ---------------------------------------------------------------------------
// 本机字体（queryLocalFonts）：状态类型与开关配置
// ---------------------------------------------------------------------------
export type {
  LocalFontStatus,
  LocalFontsStatus,
} from './local-fonts-state';
export type { LocalFontsChangeEvent } from './types';

// ---------------------------------------------------------------------------
// 公共类型：来源、状态、功能、事件、导出/打印/签章选项与详情
// ---------------------------------------------------------------------------
export type * from './types';
export type { UIDialogAction, UIDialogOptions } from './ui/types';

// ---------------------------------------------------------------------------
// 错误类型与工具
// ---------------------------------------------------------------------------
export * from './errors';

// ---------------------------------------------------------------------------
// 网络获取委托：宿主可复用的 HTTP Range 字节源
// ---------------------------------------------------------------------------
export { HttpByteSource } from './source/http-byte-source';
export type { HttpByteSourceOptions } from './source/http-byte-source';

// ---------------------------------------------------------------------------
// 页面查询参数预览：?file= / ?base64=
// ---------------------------------------------------------------------------
export {
  DEFAULT_MAX_BASE64_BYTES,
  readPreviewSourceFromLocation,
} from './source/query-source';
export type { PreviewLocation, PreviewSourceOptions } from './source/query-source';

// ---------------------------------------------------------------------------
// 版本
// ---------------------------------------------------------------------------
export { VERSION, getVersions } from './version';
export type { ViewerVersions } from './version';
