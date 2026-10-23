/**
 * `info` 子命令：只查询包信息与明文文档元数据，不解密、不验签。
 *
 * 先调用 crypto `inspect` 获取加密层/用户/签名/完整性摘要；明文包再用
 * engine 只读打开，读取 `getMetadata`/`getPageInfos`。加密包不自动解密，
 * 元数据标记为不可用，但仍以退出码 0 返回包级信息。
 */

import { inspect } from '@ofdrw/ofdrw-viewer-crypto';
import type {
  CryptoWarning,
  EncryptionLayerInfo,
  EncryptionUserInfo,
  OfdInspection,
} from '@ofdrw/ofdrw-viewer-crypto';
import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';
import type { DocumentMetadata, OFDWarning, PageInfo } from '@ofdrw/ofdrw-viewer-engine';
import { closeCryptoByteSource, openCryptoSource } from './credentials.js';
import { EXIT_CODES, errorMessage } from './errors.js';
import type { Logger } from './log.js';
import { reportCryptoWarnings } from './crypto-output.js';
import { sanitizeDisplayText } from './safe-text.js';
import type { NodeFileByteSource } from './node-file-source.js';

/** 文本页面尺寸摘要最多展示的页数。 */
const INFO_TEXT_PAGE_LIMIT = 5;

/** 单页尺寸，几何单位 mm。 */
export interface CliPageSize {
  /** 页宽，mm。 */
  readonly widthMm: number;
  /** 页高，mm。 */
  readonly heightMm: number;
}

/** `info --json` 的明文文档元数据；加密无凭据时整体省略。 */
export interface CliDocumentInfo {
  /** OFD 版本，与顶层 `ofdVersion` 同源。 */
  readonly version: string;
  /** 页数。 */
  readonly pageCount: number;
  /** 每页尺寸，按页序；几何单位 mm。 */
  readonly pageSizes: readonly CliPageSize[];
  /** DocInfo/Title。 */
  readonly title?: string;
  /** DocInfo/Author。 */
  readonly author?: string;
  /** DocInfo/Subject。 */
  readonly subject?: string;
  /** DocInfo/Abstract。 */
  readonly abstract?: string;
  /** DocInfo/CreationDate 原文。 */
  readonly creationDate?: string;
  /** DocInfo/ModDate 原文。 */
  readonly modDate?: string;
  /** DocInfo/Creator。 */
  readonly creator?: string;
  /** DocInfo/CreatorVersion。 */
  readonly creatorVersion?: string;
  /** DocInfo/Keywords。 */
  readonly keywords?: readonly string[];
  /** DocInfo/DocID。 */
  readonly docId?: string;
  /** 自定义元数据；键值均为字符串。 */
  readonly customData?: Readonly<Record<string, string>>;
}

/** `info --json` 的固定输出结构（设计 §14.2）。 */
export interface CliInfoJson {
  /** 固定为 `info`。 */
  readonly command: 'info';
  /** 输入文件绝对路径。 */
  readonly input: string;
  /** 原始包字节数，单位 byte。 */
  readonly packageSize: number;
  /** OFD 版本；明文优先取 `document.version`，否则取 `inspect`；不可读时省略。 */
  readonly ofdVersion?: string;
  /** 是否为加密包。 */
  readonly encrypted: boolean;
  /** 从外到内的加密层；明文为空数组。 */
  readonly layers: readonly EncryptionLayerInfo[];
  /** 全部加密层用户去重后的视图。 */
  readonly users: readonly EncryptionUserInfo[];
  /** Signatures.xml 中的签名条目数。 */
  readonly signatureCount: number;
  /** 是否存在 OFDEntries.xml + signedvalue.dat 防夹带保护。 */
  readonly integrityPresent: boolean;
  /** 明文文档元数据；加密文档无凭据时省略。 */
  readonly document?: CliDocumentInfo;
  /** inspect 产生的 warning。 */
  readonly warnings: readonly CryptoWarning[];
}

/** `info` 子命令参数。 */
export interface InfoCommandOptions {
  /** 输入 OFD 文件绝对路径。 */
  readonly inputPath: string;
  /** 是否输出 JSON。 */
  readonly json: boolean;
}

/** `info` 子命令的可注入运行环境。 */
export interface InfoCommandRuntime {
  /** 日志器。 */
  readonly logger: Logger;
  /** 取消信号；SIGINT 时由 CLI 主流程触发。 */
  readonly signal?: AbortSignal;
}

/**
 * 执行 `info` 查询。
 *
 * @param options 输入与输出格式
 * @param runtime 日志器与取消信号
 * @returns 进程退出码：查询成功固定 0
 * @throws {CryptoError | OFDError} 输入无法读取、包结构非法或 engine 打开失败时抛出（由调用方映射退出码）
 */
export async function runInfo(
  options: InfoCommandOptions,
  runtime: InfoCommandRuntime,
): Promise<number> {
  const opened = await openCryptoSource(options.inputPath);
  let inspection: OfdInspection;
  let document: CliDocumentInfo | undefined;
  try {
    inspection = await inspect(opened.source, {
      ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
    });
    reportCryptoWarnings(runtime.logger, inspection.warnings);
    if (!inspection.encrypted) {
      document = await readDocumentInfo(opened.byteSource, runtime);
    }
  } finally {
    // crypto/engine 只借用 byte-source；文档关闭后由 CLI 释放文件句柄。
    await closeCryptoByteSource(opened.byteSource, runtime.logger);
  }

  const version = document?.version ?? inspection.ofdVersion;
  const payload: CliInfoJson = {
    command: 'info',
    input: options.inputPath,
    packageSize: inspection.packageSize,
    ...(version === undefined ? {} : { ofdVersion: version }),
    encrypted: inspection.encrypted,
    layers: inspection.layers,
    users: inspection.users,
    signatureCount: inspection.signatures.length,
    integrityPresent: inspection.integrityPresent,
    ...(document === undefined ? {} : { document }),
    warnings: inspection.warnings,
  };

  runtime.logger.info(
    options.json ? JSON.stringify(payload, null, 2) : formatInfoText(payload),
  );
  runtime.logger.flushWarningSummary();
  return EXIT_CODES.OK;
}

/**
 * 用 engine 只读打开明文文档，读取元数据与页尺寸。
 *
 * 不渲染页面；文档在使用结束后关闭（关闭失败只给 warning），文件句柄
 * 由 `runInfo` 的外层 finally 统一释放。
 *
 * @param byteSource 已打开的输入源
 * @param runtime 日志器与取消信号
 * @returns 文档元数据、页数与每页尺寸（mm）
 * @throws {OFDError} 包损坏、加密或取消时
 */
async function readDocumentInfo(
  byteSource: NodeFileByteSource,
  runtime: InfoCommandRuntime,
): Promise<CliDocumentInfo> {
  let document: OFDDocument | undefined;
  const signalOptions =
    runtime.signal === undefined ? {} : { signal: runtime.signal };
  try {
    document = await OFDDocument.open({
      source: { kind: 'custom', source: byteSource },
      onWarning: (warning: OFDWarning) => {
        const pageNumber =
          warning.pageIndex === undefined ? undefined : warning.pageIndex + 1;
        runtime.logger.warn(warning.code, warning.message, pageNumber);
      },
    });
    const metadata = await document.getMetadata(signalOptions);
    const pageInfos = await document.getPageInfos(signalOptions);
    return toDocumentInfo(metadata, pageInfos);
  } finally {
    if (document !== undefined) {
      try {
        await document.close();
      } catch (error) {
        runtime.logger.warn('W_DOC_CLOSE_FAILED', `关闭文档失败：${errorMessage(error)}`);
      }
    }
  }
}

/**
 * 将 engine 元数据与页信息收敛为 info 的稳定 JSON 结构。
 *
 * @param metadata engine 文档元数据
 * @param pageInfos engine 页尺寸列表，单位 mm
 * @returns 缺失字段省略的文档信息
 */
function toDocumentInfo(
  metadata: DocumentMetadata,
  pageInfos: readonly PageInfo[],
): CliDocumentInfo {
  return {
    version: metadata.version,
    pageCount: metadata.pageCount,
    pageSizes: pageInfos.map((page) => ({
      widthMm: page.widthMm,
      heightMm: page.heightMm,
    })),
    ...(metadata.title === undefined ? {} : { title: metadata.title }),
    ...(metadata.author === undefined ? {} : { author: metadata.author }),
    ...(metadata.subject === undefined ? {} : { subject: metadata.subject }),
    ...(metadata.abstract === undefined ? {} : { abstract: metadata.abstract }),
    ...(metadata.creationDate === undefined
      ? {}
      : { creationDate: metadata.creationDate }),
    ...(metadata.modDate === undefined ? {} : { modDate: metadata.modDate }),
    ...(metadata.creator === undefined ? {} : { creator: metadata.creator }),
    ...(metadata.creatorVersion === undefined
      ? {}
      : { creatorVersion: metadata.creatorVersion }),
    ...(metadata.keywords === undefined ? {} : { keywords: metadata.keywords }),
    ...(metadata.docId === undefined ? {} : { docId: metadata.docId }),
    ...(metadata.customData === undefined ? {} : { customData: metadata.customData }),
  };
}

/**
 * 生成 `info` 的文本输出。
 *
 * @param info 固定 JSON 结构
 * @returns 多行文本
 */
export function formatInfoText(info: CliInfoJson): string {
  const lines = [
    `文件: ${sanitizeDisplayText(info.input)}`,
    `大小: ${info.packageSize} B`,
    `OFD 版本: ${sanitizeDisplayText(info.ofdVersion ?? '未知')}`,
    `加密: ${info.encrypted ? `是（${info.layers.length} 层）` : '否'}`,
    `用户: ${formatUsers(info.users)}`,
    `签名: ${info.signatureCount}`,
    `完整性: ${info.integrityPresent ? '有' : '无'}`,
  ];
  if (info.document === undefined) {
    // 明文路径总会带 document；只有加密包无凭据时明确提示不可用。
    if (info.encrypted) lines.push('元数据不可用（加密文档，需凭据）');
    return lines.join('\n');
  }
  const document = info.document;
  lines.push(
    `标题: ${sanitizeDisplayText(document.title ?? '无')}`,
    `作者: ${sanitizeDisplayText(document.author ?? '无')}`,
    `主题: ${sanitizeDisplayText(document.subject ?? '无')}`,
    `创建时间: ${sanitizeDisplayText(document.creationDate ?? '无')}`,
    `修改时间: ${sanitizeDisplayText(document.modDate ?? '无')}`,
    `创建工具: ${formatCreator(document)}`,
    `页数: ${document.pageCount}`,
    `页面尺寸: ${formatPageSizes(document.pageSizes)}`,
  );
  return lines.join('\n');
}

/**
 * 格式化创建工具与版本。
 *
 * @param document 文档信息
 * @returns `creator（version）`；两者都缺失时为 `无`
 */
function formatCreator(document: CliDocumentInfo): string {
  if (document.creator === undefined && document.creatorVersion === undefined) {
    return '无';
  }
  const creator = sanitizeDisplayText(document.creator ?? '未知');
  if (document.creatorVersion === undefined) return creator;
  return `${creator}（${sanitizeDisplayText(document.creatorVersion)}）`;
}

/**
 * 生成页面尺寸摘要；文本只展示前若干页，完整列表保留在 JSON。
 *
 * @param pageSizes 每页尺寸（mm）
 * @returns 单行摘要
 */
function formatPageSizes(pageSizes: readonly CliPageSize[]): string {
  if (pageSizes.length === 0) return '无';
  const parts = pageSizes
    .slice(0, INFO_TEXT_PAGE_LIMIT)
    .map(
      (page, index) =>
        `第 ${index + 1} 页 ${formatMillimeters(page.widthMm)}×${formatMillimeters(page.heightMm)} mm`,
    );
  if (pageSizes.length > INFO_TEXT_PAGE_LIMIT) {
    parts.push(`…（共 ${pageSizes.length} 页，完整尺寸见 --json）`);
  }
  return parts.join('；');
}

/**
 * 格式化毫米值，最多保留两位小数并去掉无意义的尾零。
 *
 * @param value 毫米值
 * @returns 数值文本；非有限值返回 `-`
 */
function formatMillimeters(value: number): string {
  if (!Number.isFinite(value)) return '-';
  return String(Number(value.toFixed(2)));
}

/**
 * 生成用户列表文本。
 *
 * @param users 用户摘要
 * @returns `无` 或 `name (method)` 形式，多项以逗号分隔
 */
function formatUsers(users: readonly EncryptionUserInfo[]): string {
  if (users.length === 0) return '无';
  return users
    .map((user) => `${sanitizeDisplayText(user.userName)} (${user.method})`)
    .join('、');
}