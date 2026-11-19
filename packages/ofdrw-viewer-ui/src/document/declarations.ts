/**
 * Document.xml 声明补全：视图首选项（VPreferences）与权限声明（Permissions）。
 *
 * 引擎目前只解码 Document.xml 的页树、公共数据、大纲、书签、基础权限与少量头部
 * 字段，`VPreferences` 与 `Permissions` 的若干子项不在其中。本模块按
 * GB/T 33190-2016 §7.5 表 8/表 9 补齐这两部分，供阅读器应用初始视图并对权限做
 * 入口门控。
 *
 * 读取对象是原始包字节经 `openZipVirtualContainer()` 打开的虚拟容器：明文文档直接
 * 传入来源，加密文档传入宿主已解密的容器。任何失败都降级为“无声明”，不阻断打开。
 */

import { openZipVirtualContainer } from '@ofdrw/ofdrw-viewer-engine';

import type { DocumentPermissions, OFDSource, VirtualContainer } from '@ofdrw/ofdrw-viewer-engine';
import { MM_TO_CSS_PX } from '../page-layout';
import {
  readViewPreferences,
  resolvePermissionEffects,
  resolveViewPreferenceIntents,
  type PermissionEffectsInput,
  type ViewPreferences,
  type ViewPreferenceIntents,
} from './view-preferences';
import { parseDocumentXml } from './xml-parse';
import { childNode, nodeAttr, nodeText, type DeclarationsXmlNode } from './xml-node';

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

/** 文档声明汇总；引擎字段与补全结果合并后的结果。 */
export interface DocumentDeclarations {
  /** 视图首选项；文档未声明该节点或节点内无有效字段时 undefined。 */
  readonly viewPreferences?: ViewPreferences;
  /** 权限声明（表 8 全部子项）；文档未声明该节点时 undefined。 */
  readonly permissions?: DocumentPermissions;
  /**
   * 文档声明的物理页面区，单位 px。
   *
   * 取自 `CommonData/PageArea/PhysicalBox`（缺失时取 `Document/PageArea`），用于
   * 无页面时建立初始排版。
   */
  readonly pageAreaPx?: { readonly width: number; readonly height: number };
}

/**
 * 文档声明中阅读器实际采用的配置。
 *
 * 视图首选项已换算为阅读器状态；权限已换算为入口门控结论。
 */
export interface ResolvedDocumentPolicy {
  /** 视图首选项原文；供属性面板展示。 */
  readonly viewPreferences?: ViewPreferences;
  /** 文档声明的物理页面区，单位 px；未声明时 undefined。 */
  readonly pageAreaPx?: { readonly width: number; readonly height: number };
  /** 视图首选项换算出的初始视图要求。 */
  readonly intents: ViewPreferenceIntents;
  /** 权限声明原文；供属性面板展示。 */
  readonly permissions?: PermissionEffectsInput;
  /** 宿主是否应用视图首选项（`documentPolicy.viewPreferences`）。 */
  readonly applyViewPreferences: boolean;
  /** 宿主是否按权限声明门控入口（`documentPolicy.permissions`）。 */
  readonly applyPermissions: boolean;
  /** 入口门控结论。 */
  readonly permissionEffects: ReturnType<typeof resolvePermissionEffects>;
}

/** 声明读取来源。 */
export type DeclarationSource =
  /** 已打开的虚拟容器；由调用方负责关闭。 */
  | { readonly kind: 'container'; readonly container: VirtualContainer }
  /** 引擎来源；由本模块打开并关闭容器。 */
  | { readonly kind: 'source'; readonly source: OFDSource };

/** 读取选项。 */
export interface DocumentDeclarationsOptions {
  /** Document.xml 的包内路径；省略时从容器条目表中定位。 */
  readonly documentPath?: string;
  /** warning 回调；只用于非法字段提示。 */
  readonly onWarning?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

/**
 * 读取 Document.xml 的视图首选项、权限声明与页面区。
 *
 * @param source 声明来源；undefined 时返回空声明。
 * @param options 读取选项。
 * @returns 声明汇总；来源不可用或解析失败时为空对象。
 */
export async function readDocumentDeclarations(
  source: DeclarationSource | undefined,
  options: DocumentDeclarationsOptions = {},
): Promise<DocumentDeclarations> {
  if (!source) return {};
  const owned = source.kind === 'source';
  let container: VirtualContainer | undefined;
  try {
    container =
      source.kind === 'container'
        ? source.container
        : await openZipVirtualContainer(source.source);
    // 容器惰性读取：单条目异常（CRC/大小不符）只推迟到读取条目时抛出，因此
    // “找不到 Document.xml”属于正常情况（无声明），不产生诊断。
    const root = await readDocumentRoot(container, options.documentPath);
    return root ? readDeclarationsFromRoot(root, options) : {};
  } catch {
    // 读取失败只降级为“无声明”，不产生诊断：非法包由引擎在打开阶段报告。
    return {};
  } finally {
    if (owned && container) {
      try {
        await container.close();
      } catch {
        // 关闭失败不覆盖读取结果。
      }
    }
  }
}

/**
 * 从已解析的 Document.xml 根节点读出声明。
 *
 * @param root Document.xml 根节点。
 * @param options warning 回调。
 * @returns 声明汇总。
 */
export function readDeclarationsFromRoot(
  root: DeclarationsXmlNode | undefined,
  options: { readonly onWarning?: (message: string) => void } = {},
): DocumentDeclarations {
  if (!root) return {};
  const warn = options.onWarning;
  const viewNode = childNode(root, 'VPreferences');
  const permNode = childNode(root, 'Permissions');
  const viewPreferences = readViewPreferences(viewNode, {
    ...(warn ? { onWarning: warn } : {}),
  });
  const permissions = readPermissions(permNode, { ...(warn ? { onWarning: warn } : {}) });
  const commonData = childNode(root, 'CommonData');
  const pageAreaNode = childNode(commonData, 'PageArea') ?? childNode(root, 'PageArea');
  const pageAreaPx = readPageAreaViewport(pageAreaNode);
  return {
    ...(viewPreferences ? { viewPreferences } : {}),
    ...(permissions ? { permissions } : {}),
    ...(pageAreaPx ? { pageAreaPx } : {}),
  };
}

/**
 * 把文档声明换算为阅读器实际采用的配置。
 *
 * @param declarations 文档声明汇总。
 * @param options 文档是否有标题、宿主策略与当前时间。
 * @returns 阅读器配置。
 */
export function resolveDocumentPolicy(
  declarations: DocumentDeclarations,
  options: {
    /** 文档是否存在 `DocInfo/Title`（`TabDisplay=DocTitle` 需要）。 */
    readonly hasTitle: boolean;
    /** 是否应用视图首选项；默认 true。 */
    readonly applyViewPreferences?: boolean;
    /** 是否按权限声明门控入口；默认 true。 */
    readonly applyPermissions?: boolean;
    /** 当前时间，单位毫秒；用于判断有效期。默认 `Date.now()`。 */
    readonly now?: number;
  } = { hasTitle: false },
): ResolvedDocumentPolicy {
  const applyViewPreferences = options.applyViewPreferences !== false;
  const applyPermissions = options.applyPermissions !== false;
  const now = options.now ?? Date.now();
  return {
    applyViewPreferences,
    applyPermissions,
    ...(declarations.viewPreferences ? { viewPreferences: declarations.viewPreferences } : {}),
    ...(declarations.pageAreaPx ? { pageAreaPx: declarations.pageAreaPx } : {}),
    intents: resolveViewPreferenceIntents(
      applyViewPreferences ? declarations.viewPreferences : undefined,
      options.hasTitle,
    ),
    ...(declarations.permissions
      ? { permissions: toPermissionInput(declarations.permissions) }
      : {}),
    permissionEffects: resolvePermissionEffects(
      // 未声明 `Permissions` 节点时按“全部允许”处理；声明了但不含 `Print` 时同样视为
      // 可打印，因此这里只在声明缺失时才取 undefined。
      declarations.permissions ? toPermissionInput(declarations.permissions) : undefined,
      now,
    ),
  };
}

/** 把引擎权限类型收窄为生效判定所需的输入子集。 */
function toPermissionInput(permissions: DocumentPermissions): PermissionEffectsInput {
  return {
    ...(permissions.print ? { print: permissions.print } : {}),
    printScreen: permissions.printScreen,
    signature: permissions.signature,
    watermark: permissions.watermark,
    ...(permissions.validPeriod ? { validPeriod: permissions.validPeriod } : {}),
  };
}

/** 读取 Document.xml 根节点。 */
async function readDocumentRoot(
  container: VirtualContainer,
  explicitPath: string | undefined,
): Promise<DeclarationsXmlNode | undefined> {
  for (const path of await documentPathCandidates(container, explicitPath)) {
    const bytes = await readEntry(container, path);
    if (!bytes || bytes.byteLength === 0) continue;
    try {
      return parseDocumentXml(bytes);
    } catch {
      // 解析失败：继续尝试下一个候选路径。
    }
  }
  return undefined;
}

/** 读取容器条目字节；不存在或失败返回 undefined。 */
async function readEntry(
  container: VirtualContainer,
  path: string,
): Promise<Uint8Array | undefined> {
  try {
    const value: unknown = await container.read(path);
    return toByteView(value);
  } catch {
    return undefined;
  }
}

/**
 * 把容器读到的值统一为字节视图。
 *
 * `instanceof` 在跨 realm 时失效（测试环境与 Node 全局对象不同），因此按
 * `ArrayBuffer.isView()` / 内部槽判别，并复制到本 realm 的 `Uint8Array`。
 *
 * @param value 容器返回值。
 * @returns 字节视图；不支持的类型返回 undefined。
 */
function toByteView(value: unknown): Uint8Array | undefined {
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  const tag = Object.prototype.toString.call(value);
  if (tag === '[object ArrayBuffer]') return new Uint8Array(value as ArrayBuffer);
  return undefined;
}

/**
 * 列出候选的 Document.xml 包内路径。
 *
 * 容器能列举条目时取唯一的 `Document.xml`（按目录深度升序）；否则回落到约定位置。
 *
 * @param container 虚拟容器。
 * @param explicit 显式路径。
 * @returns 按优先级排列的候选路径。
 */
async function documentPathCandidates(
  container: VirtualContainer,
  explicit: string | undefined,
): Promise<readonly string[]> {
  if (explicit) return [explicit];
  const names = listEntryNames(container);
  if (names.length > 0) {
    const matches = names
      .filter((name) => /(^|\/)Document\.xml$/i.test(name))
      .sort((a, b) => depthOf(a) - depthOf(b) || a.length - b.length);
    if (matches.length > 0) return matches;
  }
  return ['Doc_0/Document.xml', 'Docs/0/Document.xml', 'Document.xml'];
}

/** 列举容器条目名；容器不提供列举时返回空数组。 */
function listEntryNames(container: VirtualContainer): readonly string[] {
  const candidate = container as unknown as {
    readonly entries?: readonly string[];
    readonly names?: readonly string[];
    readonly list?: () => readonly string[];
  };
  if (Array.isArray(candidate.entries)) return candidate.entries;
  if (Array.isArray(candidate.names)) return candidate.names;
  if (typeof candidate.list === 'function') {
    try {
      return candidate.list();
    } catch {
      return [];
    }
  }
  return [];
}

/** 包内路径的目录层数。 */
function depthOf(path: string): number {
  return path.split('/').length - 1;
}

// ---------------------------------------------------------------------------
// 权限声明（表 8）
// ---------------------------------------------------------------------------

/**
 * 解码 `Permissions` 节点（GB/T 33190-2016 表 8）。
 *
 * 缺省语义按标准：六项布尔权限缺失按 `true`；`Print` 缺失表示可打印且份数不限；
 * `ValidPeriod` 缺失表示有效期不受限。`Print@Copies` 为负数表示份数不限（省略），
 * `0` 表示不允许打印。
 *
 * @param node `Permissions` 节点。
 * @param options warning 回调。
 * @returns 权限声明；节点为空时 undefined。
 */
export function readPermissions(
  node: DeclarationsXmlNode | undefined,
  options: { readonly onWarning?: (message: string) => void } = {},
): DocumentPermissions | undefined {
  if (!node) return undefined;
  const warn = options.onWarning;
  const result: DocumentPermissions = {
    edit: readBooleanChild(node, 'Edit', warn),
    annot: readBooleanChild(node, 'Annot', warn),
    export: readBooleanChild(node, 'Export', warn),
    signature: readBooleanChild(node, 'Signature', warn),
    watermark: readBooleanChild(node, 'Watermark', warn),
    printScreen: readBooleanChild(node, 'PrintScreen', warn),
  };
  const printNode = childNode(node, 'Print');
  if (printNode) {
    const print: NonNullable<DocumentPermissions['print']> = {
      printable: parseBoolean(
        nodeAttr(printNode, 'Printable') ?? nodeText(childNode(printNode, 'Printable')),
        'Permissions.Print.Printable',
        true,
        warn,
      ),
    };
    const copies = readPrintCopies(printNode, warn);
    if (copies !== undefined) print.copies = copies;
    result.print = print;
  }
  const validNode = childNode(node, 'ValidPeriod');
  if (validNode) {
    const start = nodeAttr(validNode, 'StartDate') ?? nodeText(childNode(validNode, 'StartDate'));
    const end = nodeAttr(validNode, 'EndDate') ?? nodeText(childNode(validNode, 'EndDate'));
    if (start || end) {
      result.validPeriod = {
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
      };
    }
  }
  return result;
}

/** 读取布尔子节点；缺失按 true。 */
function readBooleanChild(
  node: DeclarationsXmlNode,
  name: string,
  onWarning: ((message: string) => void) | undefined,
): boolean {
  return parseBoolean(nodeText(childNode(node, name)), `Permissions.${name}`, true, onWarning);
}

/**
 * 读取 `Print@Copies`。
 *
 * @param printNode `Print` 节点。
 * @param onWarning warning 回调。
 * @returns 份数；未声明或负数（不限）时 undefined。
 */
function readPrintCopies(
  printNode: DeclarationsXmlNode,
  onWarning: ((message: string) => void) | undefined,
): number | undefined {
  const raw = nodeAttr(printNode, 'Copies') ?? nodeText(childNode(printNode, 'Copies'));
  if (raw === '') return undefined;
  if (!/^[+-]?\d+$/.test(raw)) {
    onWarning?.(`Permissions.Print.Copies 非法：${JSON.stringify(raw)}，按不限处理`);
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    onWarning?.(`Permissions.Print.Copies 超出范围：${JSON.stringify(raw)}，按不限处理`);
    return undefined;
  }
  return value < 0 ? undefined : value;
}

/** 解析布尔文本；缺失返回 fallback，非法上报后返回 fallback。 */
function parseBoolean(
  raw: string,
  field: string,
  fallback: boolean,
  onWarning: ((message: string) => void) | undefined,
): boolean {
  const value = raw.trim().toLowerCase();
  if (value === '') return fallback;
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  onWarning?.(`${field} 取值非法：${JSON.stringify(raw)}，按 ${String(fallback)} 处理`);
  return fallback;
}

// ---------------------------------------------------------------------------
// 页面区
// ---------------------------------------------------------------------------

/**
 * 读取 `PageArea/PhysicalBox` 并换算为像素尺寸。
 *
 * 坐标单位为 mm，按 96 DPI 换算为 CSS px（与页面排版单位一致）。
 *
 * @param pageArea `PageArea` 节点。
 * @returns 宽高，单位 px；缺失/非法/非正尺寸时 undefined。
 */
function readPageAreaViewport(
  pageArea: DeclarationsXmlNode | undefined,
): { readonly width: number; readonly height: number } | undefined {
  const box = childNode(pageArea, 'PhysicalBox');
  if (!box) return undefined;
  const values = nodeText(box)
    .split(/[\s,]+/)
    .filter((part) => part !== '')
    .map(Number);
  if (values.length < 4 || values.some((value) => !Number.isFinite(value))) return undefined;
  const width = Math.abs(values[2]! - values[0]!) * MM_TO_CSS_PX;
  const height = Math.abs(values[3]! - values[1]!) * MM_TO_CSS_PX;
  return width > 0 && height > 0 ? { width, height } : undefined;
}

// ---------------------------------------------------------------------------
// 来源
// ---------------------------------------------------------------------------

/**
 * 由引擎规范化来源构造声明来源；容器由本模块打开并关闭。
 *
 * 所有 `OFDSource` 类型（arraybuffer/blob/随机读源）都支持，URL 来源不会额外请求
 * 第二遍完整文件以外的数据（容器读取按需）。
 *
 * @param source 引擎规范化来源。
 * @returns 声明来源；来源为空时 undefined。
 */
export function declarationSourceOf(
  source: OFDSource | null | undefined,
): DeclarationSource | undefined {
  return source ? { kind: 'source', source } : undefined;
}

/**
 * 由已解密的明文容器构造声明来源；容器由调用方负责关闭。
 *
 * @param container 已解密容器。
 * @returns 声明来源。
 */
export function declarationSourceOfContainer(container: VirtualContainer): DeclarationSource {
  return { kind: 'container', container };
}
