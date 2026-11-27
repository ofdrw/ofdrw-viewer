/**
 * `/api/info` 响应体构建。
 *
 * 包级字段（大小、版本、加密层、用户、签名数、完整性）来自 crypto `inspect`；
 * 文档级字段来自 engine `getMetadata`/`getPageInfos`/`getAttachments`/
 * `getMediaResources`。API 服务器一律拒绝加密文档，因此 `encrypted` 固定为 false。
 */

import type {
  CryptoWarning,
  EncryptionLayerInfo,
  EncryptionUserInfo,
  OfdInspection,
} from '@ofdrw/ofdrw-viewer-crypto';
import type {
  AttachmentInfo,
  CommonDataSummary,
  DocumentHeader,
  DocumentMetadata,
  MediaResource,
  OFDDocument,
  OfdPackageInfo,
  PageInfo,
} from '@ofdrw/ofdrw-viewer-engine';
import { toAttachmentDto, toMediaDto } from './export.js';
import type { ApiAttachmentDto, ApiMediaDto } from './export.js';

/** 单页尺寸；几何单位 mm。 */
export interface InfoPageSize {
  /** 页宽，单位 mm。 */
  readonly widthMm: number;
  /** 页高，单位 mm。 */
  readonly heightMm: number;
}

/** `/api/info` 的文档元数据。 */
export interface InfoDocument {
  /** OFD 版本。 */
  readonly version: string;
  /** 页数。 */
  readonly pageCount: number;
  /** 每页尺寸，按页序；几何单位 mm。 */
  readonly pageSizes: readonly InfoPageSize[];
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
  /** 自定义元数据。 */
  readonly customData?: Readonly<Record<string, string>>;
  /** DocInfo/DocUsage，文档用途声明。 */
  readonly docUsage?: string;
  /** OFD@DocType。 */
  readonly docType?: string;
  /** Document.xml 头部声明。 */
  readonly documentHeader?: DocumentHeader;
  /** OFD 包级结构信息。 */
  readonly packageInfo?: OfdPackageInfo;
  /** CommonData 摘要。 */
  readonly commonData?: CommonDataSummary;
  /** 附件索引；无 Attachments.xml 时为空数组。 */
  readonly attachments: readonly ApiAttachmentDto[];
  /** 音视频索引；仅有文档级资源时非空。 */
  readonly media?: readonly ApiMediaDto[];
}

/** `/api/info` 响应体。 */
export interface InfoPayload {
  /** 原始包字节数，单位：byte。 */
  readonly packageSize: number;
  /** OFD 版本；不可读时省略。 */
  readonly ofdVersion?: string;
  /** 固定为 false：加密文档不进入本接口。 */
  readonly encrypted: false;
  /** 加密层；始终为空数组。 */
  readonly layers: readonly EncryptionLayerInfo[];
  /** 加密用户；始终为空数组。 */
  readonly users: readonly EncryptionUserInfo[];
  /** Signatures.xml 中的签名条目数。 */
  readonly signatureCount: number;
  /** 是否存在 OFDEntries.xml + signedvalue.dat 防夹带保护。 */
  readonly integrityPresent: boolean;
  /** 文档元数据。 */
  readonly document: InfoDocument;
  /** crypto 检测与 engine 打开阶段的 warning。 */
  readonly warnings: readonly CryptoWarning[];
}

/**
 * 构建 `/api/info` 响应体。
 *
 * @param document 已打开（明文）文档
 * @param packageSize 原始包字节数，单位：byte
 * @param inspection crypto `inspect` 结果，提供包级字段；省略时只返回包大小
 * @returns `/api/info` 响应体
 * @throws OFDError（取消/文档关闭）
 */
export async function collectInfo(
  document: OFDDocument,
  packageSize: number,
  inspection?: OfdInspection,
): Promise<InfoPayload> {
  const metadata = await document.getMetadata();
  const pageInfos = await document.getPageInfos();
  const attachments = await document.getAttachments();
  const media = await document.getMediaResources();
  const version = metadata.version || inspection?.ofdVersion;
  return {
    packageSize: inspection?.packageSize ?? packageSize,
    ...(version === undefined ? {} : { ofdVersion: version }),
    encrypted: false,
    layers: inspection?.layers ?? [],
    users: inspection?.users ?? [],
    signatureCount: inspection?.signatures.length ?? 0,
    integrityPresent: inspection?.integrityPresent ?? false,
    document: toDocumentInfo(metadata, pageInfos, attachments, media),
    warnings: inspection?.warnings ?? [],
  };
}

/**
 * 把 engine 元数据、页信息与资源索引收敛为文档信息。
 *
 * @param metadata engine 文档元数据
 * @param pageInfos engine 页尺寸列表，单位 mm
 * @param attachments engine 附件元信息，保持 XML 顺序
 * @param media engine 音视频资源，只含文档级资源
 * @returns 缺失字段省略的文档信息
 */
function toDocumentInfo(
  metadata: DocumentMetadata,
  pageInfos: readonly PageInfo[],
  attachments: readonly AttachmentInfo[],
  media: readonly MediaResource[],
): InfoDocument {
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
    ...(metadata.creationDate === undefined ? {} : { creationDate: metadata.creationDate }),
    ...(metadata.modDate === undefined ? {} : { modDate: metadata.modDate }),
    ...(metadata.creator === undefined ? {} : { creator: metadata.creator }),
    ...(metadata.creatorVersion === undefined
      ? {}
      : { creatorVersion: metadata.creatorVersion }),
    ...(metadata.keywords === undefined ? {} : { keywords: metadata.keywords }),
    ...(metadata.docId === undefined ? {} : { docId: metadata.docId }),
    ...(metadata.customData === undefined ? {} : { customData: metadata.customData }),
    ...(metadata.docUsage === undefined ? {} : { docUsage: metadata.docUsage }),
    ...(metadata.docType === undefined ? {} : { docType: metadata.docType }),
    ...(metadata.documentHeader === undefined
      ? {}
      : { documentHeader: metadata.documentHeader }),
    ...(metadata.packageInfo === undefined ? {} : { packageInfo: metadata.packageInfo }),
    ...(metadata.commonData === undefined ? {} : { commonData: metadata.commonData }),
    attachments: attachments.map(toAttachmentDto),
    ...(media.length === 0 ? {} : { media: media.map(toMediaDto) }),
  };
}
