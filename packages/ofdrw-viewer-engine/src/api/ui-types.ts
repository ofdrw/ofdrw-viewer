/**
 * @ofdrw/ofdrw-viewer-ui 所需引擎 API 的公共类型（契约 r9）。
 *
 * 本文件只定义类型与 API 形状，不包含 XML/ASN.1 解析或读取实现。实现分别由
 * t67/t68/t70/t71 落到 `OFDDocument`/`OFDPage`；ASN.1、证书和 `Seal.esl` 的
 * 公开边界见 `docs/CONTRACTS.md` §5.3。
 */

import type { Box, Matrix } from '../common/types';
import type { PageContentFilter } from '../render/content-filter';

/** 页面信息查询参数。 */
export interface PageInfoOptions {
  /** 起始页索引，从 0 开始；默认 0。 */
  start?: number;
  /** 返回页数，默认剩余全部；0 表示空。 */
  count?: number;
  /** 取消信号；中止后 promise 以 `OFD_ABORTED` 拒绝。 */
  signal?: AbortSignal;
}

/** 单页尺寸信息；几何单位 mm。 */
export interface PageInfo {
  /** 页索引，从 0 开始。 */
  index: number;
  /** 页宽，mm。 */
  widthMm: number;
  /** 页高，mm。 */
  heightMm: number;
  /** PhysicalBox 原点 x，mm；可选。 */
  xMm?: number;
  /** PhysicalBox 原点 y，mm；可选。 */
  yMm?: number;
  /** 页尺寸来源；P1 可选信息。 */
  source?: 'page' | 'template' | 'default';
}

/** OFD 跳转目标类型。 */
export type DestinationType = 'XYZ' | 'Fit' | 'FitH' | 'FitV' | 'FitR';

/** 文档跳转目标；坐标单位 mm。 */
export interface DocumentDestination {
  /** OFD Dest@Type。 */
  type: DestinationType;
  /** 目标页索引，从 0 开始。 */
  pageIndex: number;
  /** 目标区域左边界，mm；按 Type 可选。 */
  leftMm?: number;
  /** 目标区域上边界，mm；按 Type 可选。 */
  topMm?: number;
  /** 目标区域右边界，mm；按 Type 可选。 */
  rightMm?: number;
  /** 目标区域下边界，mm；按 Type 可选。 */
  bottomMm?: number;
  /** XYZ 的缩放倍率；1 = 100%。 */
  zoom?: number;
}

/** 大纲节点；保持 XML 顺序与层级。 */
export interface OutlineNode {
  /** 标题。 */
  title: string;
  /** OFD Expanded；缺省由 UI 决定。 */
  expanded?: boolean;
  /** 子节点，保持 XML 顺序。 */
  children: readonly OutlineNode[];
  /** 跳转目标；无效或缺失时省略。 */
  dest?: DocumentDestination;
}

/** 书签条目。 */
export interface BookmarkItem {
  /** Bookmark@Name。 */
  name: string;
  /** 跳转目标；无效或缺失时省略。 */
  dest?: DocumentDestination;
}

/** 签章提供者信息（Signature.xml 的 Provider 字段）。 */
export interface SignatureProvider {
  /** Provider@ProviderName。 */
  name?: string;
  /** Provider@Company。 */
  company?: string;
  /** Provider@Version。 */
  version?: string;
}

/** 签章保护范围引用。 */
export interface SignatureReferenceInfo {
  /** Reference@FileRef。 */
  fileRef: string;
}

/** 签章在页面上的戳记位置；几何单位 mm。 */
export interface SignatureStampInfo {
  /** StampAnnot@ID。 */
  id?: string;
  /** StampAnnot@PageRef，页 ID。 */
  pageId: string;
  /** 页索引，从 0 开始；PageRef 未匹配时省略。 */
  pageIndex?: number;
  /** 戳记边界，mm。 */
  boundary: Box;
  /** 裁剪区域，mm；可选。 */
  clip?: Box;
}

/**
 * 签章 XML 条目信息。
 *
 * 只包含 Signature.xml 的元数据与资源路径；不解析 SignedValue.dat 的 ASN.1，
 * 也不解析证书、签名值或印章内容。
 */
export interface SignatureEntryInfo {
  /** Signature@ID。 */
  id: string;
  /** Signature@Type，例如 `Seal`/`Sign`。 */
  type: string;
  /** Signature.xml 的包内路径。 */
  baseLoc: string;
  /** Provider 信息。 */
  provider?: SignatureProvider;
  /** SignatureDateTime 原文；不转换时区。 */
  signatureDateTime?: string;
  /** 保护范围。 */
  references: readonly SignatureReferenceInfo[];
  /** 页面戳记，保持 XML 顺序。 */
  stamps: readonly SignatureStampInfo[];
  /** SignedValue.dat 包内路径；未声明时省略。 */
  signedValuePath?: string;
  /** 是否声明了 SignedValue.dat。 */
  hasSignedValue: boolean;
}

/** SignedValue.dat 原始资源。 */
export interface SignedValueFile {
  /** 所属签章 ID。 */
  signatureId: string;
  /** SignedValue.dat 包内路径。 */
  path: string;
  /** 原始字节；调用方拥有，引擎不解释内容。 */
  data: Uint8Array;
  /** 字节长度。 */
  byteLength: number;
}

/** 文档属性；日期保留 OFD 原文。 */
export interface DocumentMetadata {
  /** OFD 版本，例如 `1.0`。 */
  version: string;
  /** 页数。 */
  pageCount: number;
  /** 源文件字节数；未知时省略。 */
  packageSize?: number;
  /** DocInfo/Title。 */
  title?: string;
  /** DocInfo/Author。 */
  author?: string;
  /** DocInfo/Subject。 */
  subject?: string;
  /** DocInfo/Abstract。 */
  abstract?: string;
  /** DocInfo/CreationDate 原文。 */
  creationDate?: string;
  /** DocInfo/ModDate 原文。 */
  modDate?: string;
  /** DocInfo/Creator。 */
  creator?: string;
  /** DocInfo/CreatorVersion。 */
  creatorVersion?: string;
  /** DocInfo/Keywords。 */
  keywords?: readonly string[];
  /** DocInfo/DocID。 */
  docId?: string;
  /** 自定义元数据；键值均为字符串。 */
  customData?: Readonly<Record<string, string>>;

  // —— 新增字段，全部可选；缺失即省略 ——
  /** DocInfo/DocUsage，文档用途声明。 */
  docUsage?: string;
  /** OFD@DocType，例如 `OFD`/`Render`/`None`。 */
  docType?: string;
  /** Document.xml 头部声明。 */
  documentHeader?: DocumentHeader;
  /** OFD 包级结构信息。 */
  packageInfo?: OfdPackageInfo;
  /** CommonData 摘要。 */
  commonData?: CommonDataSummary;
}

/**
 * Document.xml 头部声明。
 *
 * 几何字段单位为 mm（与 PageInfo、SignatureStampInfo 的坐标约定一致），
 * 同时保留 XML 原文能力由包内路径字段体现。
 */
export interface DocumentHeader {
  /** Document@DocID。 */
  docId?: string;
  /** Document@Version。 */
  version?: string;
  /** Document@MaxUnitID。 */
  maxUnitId?: number;
  /** 页面区声明。 */
  pageArea?: DocumentPageArea;
  /** PublicRes 包内路径列表（已规范化）；无声明时省略。 */
  publicRes?: readonly string[];
  /** DocumentRes 包内路径列表（已规范化）；无声明时省略。 */
  documentRes?: readonly string[];
  /** TemplatePageRes 包内路径列表（已规范化）；无声明时省略。 */
  templatePageRes?: readonly string[];
  /** DefaultCS 颜色空间 ID。 */
  defaultCs?: string;
  /** Document@DocUsage。 */
  docUsage?: string;
}

/**
 * 页面区三组矩形；几何单位 mm。
 *
 * 页面区声明来自 Document.xml 的 `PageArea` 或 `CommonData/PageArea`，
 * 三组矩形均归一化保留原值（不交换宽高）。
 */
export interface DocumentPageArea {
  /** 物理页面区。 */
  physicalBox?: Box;
  /** 显示区。 */
  applicationBox?: Box;
  /** 出血区。 */
  bleedBox?: Box;
}

/** OFD 包级结构信息。 */
export interface OfdPackageInfo {
  /** 选中文档根目录，包内绝对路径，已去掉前导 `/`。 */
  docRoot: string;
  /** 选中文档的 DocBody@MaxUnitID。 */
  maxUnitId?: number;
  /** OFD.xml 声明的 DocBody 数量。 */
  docBodyCount: number;
}

/** CommonData 摘要。 */
export interface CommonDataSummary {
  /** 公共页面区，mm。 */
  pageArea?: DocumentPageArea;
  /** 默认颜色空间 ID。 */
  defaultColorSpaceId?: string;
  /** Document.xml@Version。 */
  documentVersion?: string;
  /** 数据目录，包内路径；已规范化。 */
  dataDir?: string;
}

/** 文档权限声明；字段缺省值按 OFD 规格回退。 */
export interface DocumentPermissions {
  /** 是否允许编辑，默认 true。 */
  edit: boolean;
  /** 是否允许添加/修改标注，默认 true。 */
  annot: boolean;
  /** 是否允许导出，默认 true。 */
  export: boolean;
  /** 是否允许数字签名，默认 true。 */
  signature: boolean;
  /** 是否允许添加水印，默认 true。 */
  watermark: boolean;
  /** 是否允许截屏，默认 true。 */
  printScreen: boolean;
  /** 打印权限；未声明表示可打印且份数不限。 */
  print?: {
    /** 是否允许打印，默认 true。 */
    printable: boolean;
    /** 允许份数；未声明表示不限。 */
    copies?: number;
  };
  /** 访问有效期；未声明表示不受限，日期保留 XML 原文。 */
  validPeriod?: {
    /** 开始日期原文。 */
    start?: string;
    /** 结束日期原文。 */
    end?: string;
  };
}

/** 附件元信息；只描述 Attachments.xml，不包含附件内容。 */
export interface AttachmentInfo {
  /** Attachment@ID，已规范化。 */
  id: string;
  /** Attachment@Name。 */
  name: string;
  /** Attachment@Format；未声明时省略。 */
  format?: string;
  /** 附件大小，byte；由 XML 的 KB 值换算，未声明时省略。 */
  size?: number;
  /** Attachment@CreationDate 原文。 */
  creationDate?: string;
  /** Attachment@ModDate 原文。 */
  modDate?: string;
  /** Attachment@Visible；缺省 true。 */
  visible?: boolean;
  /** Attachment@Usage；缺省 `none`。 */
  usage?: string;
  /** MIME 类型；由 Attachment@ContentType 或 format 推断，未声明时省略。 */
  contentType?: string;
  /** Attachment@Desc。 */
  description?: string;
  /** Attachment@SubmissionDate 原文。 */
  submissionDate?: string;
  /** 是否加密存储；未声明时省略。 */
  isEncrypted?: boolean;
}

/**
 * 附件分块写出回调。
 *
 * 引擎按包内字节顺序调用，每次给出一个非空 chunk；实现可同步或异步，
 * 抛错时 `saveAttachment` 原样向上抛出且不再继续读取。
 *
 * @param chunk 本次字节块；调用方应在回调返回前完成拷贝（引擎可能复用缓冲区）。
 * @returns 可为 Promise；引擎会等待其完成后再写下一块。
 */
export type AttachmentSink = (chunk: Uint8Array) => void | Promise<void>;

/** 附件查询/读取参数。 */
export interface AttachmentOperationOptions {
  /** 取消信号；中止后 promise 以 `OFD_ABORTED` 拒绝。 */
  signal?: AbortSignal;
  /**
   * 分块写入时的单块字节数，byte；默认 65536，非法值回退默认值。
   *
   * 只在 `saveAttachment` 生效；内存中整块回调实现按整块给出。
   */
  chunkSize?: number;
}

/** 页面预取参数。 */
export interface PagePrepareOptions {
  /** 取消信号；中止后 promise 以 `OFD_ABORTED` 拒绝。 */
  signal?: AbortSignal;
}

/** 文本坐标单位：px，原点为页面 PhysicalBox 左上角，y 向下。 */
export type TextUnit = 'px';

/** 二维点，单位 px。 */
export interface TextPoint {
  /** x 坐标，px。 */
  x: number;
  /** y 坐标，px。 */
  y: number;
}

/** 轴对齐矩形，单位 px；x/y 为左上角。 */
export interface TextRect {
  /** 左上角 x，px。 */
  x: number;
  /** 左上角 y，px。 */
  y: number;
  /** 宽，px。 */
  width: number;
  /** 高，px。 */
  height: number;
}

/**
 * 字形单元四边形，单位 px。
 *
 * 顺序固定为：左上、右上、右下、左下（相对于字形/字符方向）。
 * 旋转文字下“上”指字形自身方向，不是页面 y 方向。
 */
export type TextQuad = readonly [TextPoint, TextPoint, TextPoint, TextPoint];

/** 字体元信息；主字体来自 TextObject.font。 */
export interface TextFontInfo {
  /** 字体资源 ID（TextObject.font）。 */
  resourceId: string;
  /** 字体族名。 */
  family: string;
  /** PostScript 名（若存在）。 */
  postscriptName?: string;
  /** OS/2 weightClass（若存在）。 */
  weightClass?: number;
  /** 字体本身是否斜体。 */
  italic: boolean;
}

/** 文本项所在层。 */
export type TextLayer = 'template' | 'page' | 'annotation';

/** 单个 TextObject 的阅读器文本项。 */
export interface TextItem {
  /** 绘制顺序下标，从 0 递增；与 layerOrder 一致。 */
  order: number;
  /** TextObject.id；匿名对象为 undefined。 */
  objectId?: string;
  /** 模板时给出模板页 ID。 */
  templateId?: string;
  /** 注释时给出注释 ID。 */
  annotationId?: string;
  /** 所在复合块 ID；顶层为 undefined。 */
  blockId?: string;
  /** 所在层。 */
  layer: TextLayer;
  /** 所在图层类型；复合块继承外层。 */
  layerType: 'Background' | 'Body' | 'Foreground' | 'Custom';
  /** 有效模板 ZOrder；非模板 undefined。 */
  zOrder?: 'Background' | 'Body' | 'Foreground';
  /** 是否参与绘制；includeInvisible=false 时恒为 true。 */
  visible: boolean;
  /** 对象 alpha，0..1（仅对象自身；不含父块 group alpha）。 */
  alpha: number;
  /** 原始文本（按 TextCode 顺序拼接，保留空白/换行）。 */
  text: string;
  /** 主字体信息。 */
  font: TextFontInfo;
  /** 字号，单位 px。 */
  size: number;
  /** 布局局部 mm → 页面 px 的矩阵；列向量约定。 */
  transform: Matrix;
  /** 首字符 baseline 起点，单位 px。 */
  origin: TextPoint;
  /** 轴对齐包围盒，单位 px。 */
  rect: TextRect;
  /** 外接四边形，单位 px；旋转/多 run 时可能大于单字符范围。 */
  quad: TextQuad;
  /** 沿阅读方向的总推进量，单位 px；始终非负。 */
  advance: number;
  /** 文本字符数（按 Unicode 码点计，含缺失字形）。 */
  charCount: number;
  /** 字符级数据；includeChars=false 时省略。 */
  chars?: TextChar[];
}

/** 单个 Unicode 码点的字符项。 */
export interface TextChar {
  /** 该码点的文本（可能是代理对的两个 UTF-16 单元）。 */
  text: string;
  /** Unicode 码点。 */
  codePoint: number;
  /** 实际使用的字形 ID；缺字时为 undefined。 */
  glyphId?: number;
  /** 实际字体面 key；缺字时为 undefined。 */
  faceKey?: string;
  /** 是否使用回退字体（非主字体）。 */
  fallback: boolean;
  /** 字符起点（baseline），单位 px。 */
  origin: TextPoint;
  /** 该字符的推进量，单位 px；缺失字形为 0。 */
  advance: number;
  /** 轴对齐包围盒，单位 px；缺失字形时宽高为 0。 */
  rect: TextRect;
  /** 字符单元四边形，单位 px；缺失字形时四点为 origin。 */
  quad: TextQuad;
  /** 是否由近似映射得到（多字形 run 与字符数不一致）。 */
  approximate: boolean;
}

/** 一页的阅读器文本内容。 */
export interface TextContent {
  /** 页索引，从 0 开始。 */
  pageIndex: number;
  /** 输出 DPI；px 换算依据。 */
  dpi: number;
  /** 坐标单位，固定 `px`。 */
  unit: TextUnit;
  /** 页面可视宽高，单位 px。 */
  pageWidth: number;
  pageHeight: number;
  /** 按绘制顺序的文本项。 */
  items: TextItem[];
  /** 包含的 TextItem 数。 */
  itemCount: number;
  /** 包含的字符数（即使 includeChars=false 也统计）。 */
  charCount: number;
  /** 是否发生截断。 */
  truncated: {
    /** 达到 maxTextItems。 */
    items: boolean;
    /** 达到 maxTextChars。 */
    chars: boolean;
  };
}

/** 文本内容查询参数。 */
export interface TextContentOptions {
  /** 输出 DPI，默认 96；非法值回退 96。 */
  dpi?: number;
  /** 是否返回 chars，默认 true。 */
  includeChars?: boolean;
  /** 是否包含注释 Appearance 文字，默认 false。 */
  includeAnnotations?: boolean;
  /**
   * 页级绘制内容白名单；不传表示全部绘制。
   *
   * 与 `page.render` 使用同一语义：被隐藏的层/模板/注释不会进入文本层，
   * 且不同过滤各自使用独立的文本缓存。只作用于本次查询，不继承上一次 `render` 的过滤。
   */
  contentFilter?: PageContentFilter;
  /** 是否包含不可见文字，默认 false。 */
  includeInvisible?: boolean;
  /** 图层顺序；缺省沿用打开时的 layerOrder。 */
  layerOrder?: 'document' | 'type';
  /** 取消信号；中止后 promise 以 `OFD_ABORTED` 拒绝。 */
  signal?: AbortSignal;
  /** 文本项上限，默认 20,000；0 表示不限。 */
  maxTextItems?: number;
  /** 字符上限，默认 500,000；0 表示不限。 */
  maxTextChars?: number;
}

/**
 * 文档声明的字体资源（只读快照）。
 *
 * 数据来自打开阶段已解析的 `PublicRes.xml` / `DocumentRes.xml` 索引，读取时不访问容器、
 * 不加载页面，也不反映后续渲染阶段的字体解析或回退结果。只包含文档级声明：页面级
 * `PageRes.xml` 中的字体不进入本清单。
 */
export interface DocumentFontResource {
  /** 资源 ID（OFD `Font@ID`，归一化后的十进制字符串）。 */
  readonly id: string;
  /** OFD `FontName`；文档声明的主字体名。 */
  readonly fontName: string;
  /** OFD `FamilyName`；文档未声明时省略该字段（不写 `undefined`）。 */
  readonly familyName?: string;
  /** 字符集声明：unicode / prc / big5 / symbol。 */
  readonly charset: string;
  /** 是否声明为衬线字体。 */
  readonly serif: boolean;
  /** 是否声明为粗体。 */
  readonly bold: boolean;
  /** 是否声明为斜体。 */
  readonly italic: boolean;
  /** 是否声明为等宽字体。 */
  readonly fixedSize: boolean;
  /** 包内字体文件路径；省略表示没有内嵌字体，需要宿主提供字体。 */
  readonly fontFile?: string;
  /** 是否属于文档级资源；来自 `PublicRes`/`DocumentRes` 时为 `true`。 */
  readonly documentLevel: boolean;
}

/** 文档字体资源查询参数。 */
export interface DocumentFontResourcesOptions {
  /** 取消信号；已中止时以 `OFD_ABORTED` 拒绝。 */
  signal?: AbortSignal;
}

/**
 * 文档级 UI API 形状。
 *
 * 仅声明签名；实现由 t67/t68/t70/t71 落到 `OFDDocument`。所有 IO 型方法
 * 在取消时以 `OFD_ABORTED` 拒绝，在文档关闭后以 `OFD_CLOSED` 拒绝。
 */
export interface OFDDocumentApi {
  /**
   * 读取文档声明的字体资源清单；不加载页面、不解析字体。
   *
   * 用于宿主按文档实际字体声明准备替代字体（例如按需加载本机字体）。
   */
  getFontResources(
    options?: DocumentFontResourcesOptions,
  ): Promise<readonly DocumentFontResource[]>;
  /** 批量读取页面尺寸信息；不加载页面内容、字体或图片。 */
  getPageInfos(options?: PageInfoOptions): Promise<readonly PageInfo[]>;
  /** 读取大纲树；无大纲返回空数组。 */
  getOutline(options?: { signal?: AbortSignal }): Promise<readonly OutlineNode[]>;
  /** 读取书签列表；无书签返回空数组。 */
  getBookmarks(options?: { signal?: AbortSignal }): Promise<readonly BookmarkItem[]>;
  /** 读取签章 XML 元数据；不解析 ASN.1、不读取 SignedValue.dat 内容。 */
  getSignatureEntries(
    options?: { signal?: AbortSignal },
  ): Promise<readonly SignatureEntryInfo[]>;
  /** 读取 SignedValue.dat 原始字节；未声明或文件缺失时返回 undefined。 */
  getSignedValue(
    signatureId: string,
    options?: { signal?: AbortSignal },
  ): Promise<SignedValueFile | undefined>;
  /** 读取文档属性；无 DocInfo 时仍返回版本与页数。 */
  getMetadata(options?: { signal?: AbortSignal }): Promise<DocumentMetadata>;
  /** 读取文档权限声明；只读，不执行 DRM 强制。 */
  getPermissions(options?: { signal?: AbortSignal }): Promise<DocumentPermissions>;
  /** 读取附件元信息；无 Attachments.xml 返回空数组。 */
  getAttachments(options?: { signal?: AbortSignal }): Promise<readonly AttachmentInfo[]>;
  /** 按名称精确查找；重名时返回第一个并上报 `W_DUPLICATE_RESOURCE`。 */
  getAttachmentByName(
    name: string,
    options?: { signal?: AbortSignal },
  ): Promise<AttachmentInfo | undefined>;
  /** 按格式（大小写不敏感）筛选，保持 XML 顺序。 */
  getAttachmentsByFormat(
    format: string,
    options?: { signal?: AbortSignal },
  ): Promise<readonly AttachmentInfo[]>;
  /** 读取附件声明的大小，byte；未声明或附件不存在时返回 undefined。 */
  getAttachmentSize(
    attachmentId: string,
    options?: { signal?: AbortSignal },
  ): Promise<number | undefined>;
  /** 流式写出附件内容；返回写入字节总数（byte）。 */
  saveAttachment(
    attachmentId: string,
    sink: AttachmentSink,
    options?: AttachmentOperationOptions,
  ): Promise<number>;
  /** 读取附件原始字节；附件不存在或内容缺失时返回 undefined。 */
  getAttachmentData(
    attachmentId: string,
    options?: { signal?: AbortSignal },
  ): Promise<Uint8Array | undefined>;
}

/**
 * 页面级 UI API 形状。
 *
 * 仅声明签名；实现由 t68/t71 落到 `OFDPage`。
 */
export interface OFDPageApi {
  /** 读取阅读器文本层；不调用 Canvas 文字 API。 */
  getTextContent(options?: TextContentOptions): Promise<TextContent>;
  /** 预取页面模型/字体/图片，不创建 canvas、不绘制。 */
  prepare(options?: PagePrepareOptions): Promise<void>;
}