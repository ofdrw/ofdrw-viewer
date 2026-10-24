/**
 * OFD 数据模型。
 *
 * 模型是普通只读数据，由解码层从 XML 直接产出；不得引用 render/renderer/Canvas。
 * `PreparedPage` / `IndependentBlock` 通过 `import type` 引用样式层最终类型，
 * 该引用在运行时被完全擦除，不构成 model → style 的运行时依赖。
 */

import type { Box, LineCap, LineJoin, Matrix, Rgba, PathCommand } from '../common/types';
import type { DisplayList } from '../common/display-list';
import type { ResolvedStyle } from '../style/types';

/** 资源 ID 统一使用十进制文本，避免精度/非数字问题。 */
export type ResourceId = string;

/** 页引用；`loc` 已解析为包内绝对路径。 */
export interface PageRef {
  id: ResourceId;
  loc: string;
}

/** 页尺寸，单位 mm。 */
export interface PageSize {
  width: number;
  height: number;
}

/** 模板页引用；`loc` 已解析为包内路径。 */
export interface TemplateRef {
  id: ResourceId;
  loc?: string;
  /** 页面引用缺省 Background；Body 仅在显式出现时使用。 */
  zOrder?: 'Background' | 'Body' | 'Foreground';
}

/** 一个裁剪项；同一 Clip 内多个 area 取并集，多个 Clip 之间取交集。 */
export interface Clip {
  /** 对整个裁剪区生效的矩阵。 */
  ctm?: Matrix;
  /** 裁剪区自己的 DrawParam；已由样式层结算前保留引用。 */
  drawParam?: ResourceId;
  /**
   * 裁剪区域是否受外部 CTM 影响；来自 `Clips@TransFlag`，缺省 false。
   */
  transFlag?: boolean;
  /** 同一 Clip 内的裁剪区域，取并集。 */
  areas: ClipArea[];
}

/** 裁剪区域：路径或文字轮廓。 */
export type ClipArea =
  | { kind: 'path'; path: PathObject }
  | { kind: 'text'; text: TextObject };

/** 图片边框；长度单位 mm，`lineWidth=0` 表示不画。 */
export interface ImageBorder {
  /** 边框线宽，mm；0 表示不画。 */
  lineWidth: number;
  /** 圆角水平半径，mm。 */
  horizontalRadius: number;
  /** 圆角垂直半径，mm。 */
  verticalRadius: number;
  /** 虚线偏移，mm。 */
  dashOffset: number;
  /** 虚线段数组，mm。 */
  dashPattern: number[];
  /** 边框颜色。 */
  color: Rgba;
}

/** 所有图元的公共字段；坐标/长度位于对象空间（通常 mm）。 */
export interface GraphicUnitBase {
  id?: ResourceId;
  /** 图元边界，对象空间单位（通常 mm）。 */
  boundary: Box;
  /** 图元局部变换。 */
  ctm?: Matrix;
  /** 内联 DrawParam 引用。 */
  drawParam?: ResourceId;
  /** 对象透明度，0..255，默认 255。 */
  alpha: number;
  /** 是否参与绘制。 */
  visible: boolean;
  /** 线宽，对象空间单位（通常 mm）。 */
  lineWidth?: number;
  /** 端点样式。 */
  cap?: LineCap;
  /** 连接样式。 */
  join?: LineJoin;
  /** 斜接限制，无量纲。 */
  miterLimit?: number;
  /** 虚线偏移，对象空间单位（通常 mm）。 */
  dashOffset?: number;
  /** 虚线段数组，对象空间单位（通常 mm）。 */
  dashPattern?: number[];
  /** 对象空间裁剪区。 */
  clips?: Clip[];
}

/** 一段文字编码；`text` 已解码 `\XXXX` 转义。 */
export interface TextCode {
  /** 已解码的字符序列，按 Unicode 码点处理。 */
  text: string;
  /** 第一个字符的 X 坐标，对象空间单位。 */
  x?: number;
  /** 第一个字符的 Y 坐标，对象空间单位。 */
  y?: number;
  /** 逐字符 X 步进，对象空间单位；已展开 `g` 压缩组。 */
  deltaX: number[];
  /** 逐字符 Y 步进，对象空间单位；已展开 `g` 压缩组。 */
  deltaY: number[];
  /** 字符编码到字形的映射。 */
  cgTransforms: CgTransform[];
}

/** CGTransform：一段字符到一段字形序列的映射。 */
export interface CgTransform {
  /** 当前 TextCode 内的字符起始位置，按码点计。 */
  codePosition: number;
  /** 字符数量。 */
  codeCount: number;
  /** 字形数量，仅用于诊断。 */
  glyphCount: number;
  /** 字形 ID 序列，按绘制顺序排列。 */
  glyphs: number[];
}

/** 文字对象。 */
export interface TextObject extends GraphicUnitBase {
  kind: 'text';
  /** 字体资源 ID。 */
  font: ResourceId;
  /** 字号，对象空间单位（通常 mm）。 */
  size: number;
  /** 水平缩放，1 表示正常。 */
  hScale: number;
  /** 阅读方向，决定 pen 步进方向。 */
  readDirection: 0 | 90 | 180 | 270;
  /** 字符方向，决定字形旋转。 */
  charDirection: 0 | 90 | 180 | 270;
  /** 字重，通常 400/700。 */
  weight: number;
  /** 是否斜体。 */
  italic: boolean;
  /** 是否填充。 */
  fill: boolean;
  /** 是否描边。 */
  stroke: boolean;
  /** 填充 Paint。 */
  fillColor?: Paint;
  /** 描边 Paint。 */
  strokeColor?: Paint;
  /** 文字编码段。 */
  codes: TextCode[];
}

/** 路径对象；`data` 为 AbbreviatedData 原文。 */
export interface PathObject extends GraphicUnitBase {
  kind: 'path';
  /** OFD 缩写路径数据原文。 */
  data: string;
  /** 是否填充。 */
  fill: boolean;
  /** 是否描边。 */
  stroke: boolean;
  /** 填充规则。 */
  rule: 'nonzero' | 'evenodd';
  /** 填充 Paint。 */
  fillColor?: Paint;
  /** 描边 Paint。 */
  strokeColor?: Paint;
}

/** 图片对象；图片局部空间为单位正方形，实际位置由 CTM 决定。 */
export interface ImageObject extends GraphicUnitBase {
  kind: 'image';
  /** 图片资源 ID。 */
  resourceId: ResourceId;
  /** 高分辨率替换图资源 ID（XML `Substitution`，ST_RefID）；缺省表示无替换图。 */
  substitution?: ResourceId;
  /** 蒙版图片资源 ID（XML `ImageMask`，ST_RefID）；缺省表示无蒙版。 */
  imageMask?: ResourceId;
  /** 可选边框。 */
  border?: ImageBorder;
}

/** 复合对象；内容来自 CompositeGraphicUnit 资源。 */
export interface CompositeObject extends GraphicUnitBase {
  kind: 'composite';
  /** 复合资源 ID。 */
  resourceId: ResourceId;
}

/** 可绘制对象联合。 */
export type PageObject = PageBlock | TextObject | PathObject | ImageObject | CompositeObject;

/** 页面块；只作为容器，没有独立边界。 */
export interface PageBlock {
  kind: 'block';
  id?: ResourceId;
  children: PageObject[];
}

/** 页面图层。 */
export interface Layer {
  type: 'Background' | 'Body' | 'Foreground' | 'Custom';
  drawParam?: ResourceId;
  children: PageObject[];
}

/** 页面模型。 */
export interface PageModel {
  id: ResourceId;
  /** PhysicalBox，保留 x/y 原点与宽高，单位 mm。 */
  area: Box;
  /** 由 area 归一化得到的页尺寸，单位 mm。 */
  size: PageSize;
  layers: Layer[];
  templates: TemplateRef[];
  /** 页面资源文件路径列表。 */
  pageRes: string[];
  /** 分页注释文件，已解析为包内路径。 */
  annotationFile?: string;
}

/**
 * 准备阶段产物。
 *
 * `styles` 必须覆盖页面上所有可绘制对象（包括不可见对象），绘制阶段只读。
 */
export interface PreparedPage {
  page: PageModel;
  styles: WeakMap<GraphicUnitBase, ResolvedStyle>;
  /** 注释外观的独立块；没有注释时为空。 */
  annotationBlocks: IndependentBlock[];
}

/** 注释模型；engine 只渲染 Appearance，不处理阅读器提示与签名验证。 */
export interface Annotation {
  id: ResourceId;
  type: 'Link' | 'Path' | 'Highlight' | 'Stamp' | 'Watermark' | string;
  /** 是否显示，默认 true。 */
  visible: boolean;
  /** 注释外观；为空时跳过。 */
  appearance?: PageBlock;
  /** Appearance 的 Boundary，单位 mm。 */
  boundary?: Box;
}

/** Signs/Signatures.xml 中的签章索引项。 */
export interface SignatureEntry {
  /** Signature ID。 */
  id: ResourceId;
  /** 签章类型，例如 `Seal`/`Sign`。 */
  type: string;
  /** Signature.xml 的包内路径。 */
  baseLoc: string;
}

/** 签章图片/矢量章来源。 */
export type SealImageSource = 'seal-esl' | 'signed-value';

/** Seal.esl 或 SignedValue.dat 内嵌的印章图片/矢量章。 */
export interface SealImage {
  /** 识别出的签章结构版本；仅魔术字节兜底时为 unknown。 */
  version: 'v1' | 'v4' | 'v5' | 'unknown';
  /** 图片/矢量章来源；旧调用方构造 SealImage 时可能缺省。 */
  source?: SealImageSource;
  /** 稳定缓存 key；相同来源与字节内容可复用。 */
  cacheKey?: string;
  /** 图片格式或矢量章标记，例如 `PNG`/`JPEG`/`GIF`/`BMP`/`OFD`。 */
  type: string;
  /** 图片原始字节。 */
  data: Uint8Array;
  /** 显示宽度，单位 mm。 */
  width: number;
  /** 显示高度，单位 mm。 */
  height: number;
}

/** 页面上的签章戳记；由 Signature.xml 的 StampAnnot 解码。 */
export interface SignatureStamp {
  /** StampAnnot ID。 */
  id?: ResourceId;
  /** 页面 ID（PageRef），不是页索引。 */
  pageId: ResourceId;
  /** 页索引；PageRef 未匹配页面时缺省。 */
  pageIndex?: number;
  /** 戳记边界，单位 mm。 */
  boundary: Box;
  /** 裁剪区域，单位 mm。 */
  clip?: Box;
}

/** Signature.xml 的 Provider 信息。 */
export interface SignatureProvider {
  /** ProviderName 或 Provider@ProviderName。 */
  name?: string;
  /** Company 或 Provider@Company。 */
  company?: string;
  /** Version 或 Provider@Version。 */
  version?: string;
}

/** Signature.xml 的保护范围引用。 */
export interface SignatureReference {
  /** Reference@FileRef，保持 XML 原文。 */
  fileRef: string;
}

/** 单个签章；只描述静态外观所需信息，不含签名值验证。 */
export interface SignatureModel {
  /** Signature ID。 */
  id: ResourceId;
  /** 签章类型，例如 `Seal`/`Sign`。 */
  type: string;
  /** Signature.xml 的包内路径。 */
  baseLoc: string;
  /** Seal.esl 的包内路径。 */
  sealFile?: string;
  /** SignedValue.dat 的包内路径；无 Seal.esl 时作为图片兜底。 */
  signedValueFile?: string;
  /** SignedValue.dat 的规范化包内路径；与 signedValueFile 同步。 */
  signedValuePath?: string;
  /** 是否声明并成功解析出 SignedValue.dat 路径。 */
  hasSignedValue: boolean;
  /** Signature.xml 的 Provider 信息；无有效字段时省略。 */
  provider?: SignatureProvider;
  /** SignatureDateTime 原文；不转换时区。 */
  signatureDateTime?: string;
  /** References/Reference@FileRef，保持 XML 顺序。 */
  references: SignatureReference[];
  /** Seal.esl/SignedValue.dat 解码出的印章图片；损坏时为缺省。 */
  seal?: SealImage;
  /** 该签章的所有戳记，保持 XML 顺序。 */
  stamps: SignatureStamp[];
}

/** 文档签章集合与按页索引。 */
export interface SignatureBundle {
  /** Signatures.xml 中的索引项，保持 XML 顺序。 */
  entries: SignatureEntry[];
  /** 成功解码的签章。 */
  signatures: SignatureModel[];
  /** 页索引 → 该页戳记；同一页按签章/戳记顺序。 */
  pageIndex: Record<number, SignatureStamp[]>;
}

/** 独立空间块：复合对象、注释外观、底纹 cell、普通 PageBlock 的统一表示。 */
export interface IndependentBlock {
  id?: ResourceId;
  source: 'composite' | 'annotation' | 'pattern-cell' | 'pageblock';
  /** 块内坐标尺寸，单位 mm（Composite 已按 0.3528 换算）。 */
  space: { width: number; height: number };
  content: PageBlock;
  /** 块内对象继承的起点。 */
  styleRoot: ResolvedStyle;
  /** 资源 ID + 内容哈希 + styleRoot 哈希 + DrawParam 哈希。 */
  cacheKey: string;
  /**
   * 块在父空间中的放置边界，单位 mm。
   * 注释块使用 `Appearance.Boundary`，对应 `M_annot = M_page × T(boundary.x, boundary.y)`；
   * 复合对象/底纹 tile 的放置由引用方决定，可省略。
   */
  boundary?: Box;
  /**
   * 准备阶段构建的目标无关绘制命令；平移/放置不写入显示列表，绘制时再套用。
   * 该字段是 11.7 的公共形状，所有 IndependentBlock 都必须携带。
   */
  displayList: DisplayList;
  /** 注释类型；仅 `source === 'annotation'` 时填充，内部字段，不进入公共 API。 */
  annotationType?: string;
}

/** 轴向渐变资源。 */
export interface AxialShade {
  start: { x: number; y: number };
  end: { x: number; y: number };
  mapType: 'Direct' | 'Repeat' | 'Reflect';
  mapUnit?: number;
  /** 0=两端裁剪，1=终点外延伸，2=起点外延伸，3=不裁剪。 */
  extend: 0 | 1 | 2 | 3;
  segments: { position: number; color: Rgba }[];
}

/** 径向渐变资源；v1 不实现绘制，仅保留模型。 */
export interface RadialShade {
  start: { x: number; y: number };
  startRadius: number;
  end: { x: number; y: number };
  endRadius: number;
  mapType: 'Direct' | 'Repeat' | 'Reflect';
  mapUnit?: number;
  /** 0=两端裁剪，1=终点外延伸，2=起点外延伸，3=不裁剪。 */
  extend: 0 | 1 | 2 | 3;
  segments: { position: number; color: Rgba }[];
}

/** Gouraud/LaGouraud 资源。 */
export interface GouraudShade {
  points: { x: number; y: number; color: Rgba; edgeFlag?: 0 | 1 | 2 }[];
  /** LaGouraud 必填；每行顶点数（不是格子数）。 */
  verticesPerRow?: number;
  extend: 0 | 1;
  backColor?: Rgba;
}

/** 底纹资源；`cell` 为 CellContent 页面块。 */
export interface Pattern {
  /** 底纹资源 ID；内联底纹未写 ID 时缺省。 */
  id?: ResourceId;
  /** tile 宽度，对象空间单位（通常 mm）。 */
  width: number;
  /** tile 高度，对象空间单位（通常 mm）。 */
  height: number;
  /** 水平步进，对象空间单位（通常 mm）。 */
  xStep: number;
  /** 垂直步进，对象空间单位（通常 mm）。 */
  yStep: number;
  reflectMethod: 'Normal' | 'Column' | 'Row' | 'RowAndColumn';
  relativeTo: 'Object' | 'Page';
  ctm?: Matrix;
  cell: PageBlock;
}

/** 颜色空间定义；`CV` 为调色板颜色值列表。 */
export interface ColorSpaceDef {
  id: ResourceId;
  type: 'GRAY' | 'RGB' | 'CMYK';
  /** 每通道位数，1/2/4/8/16。 */
  bitsPerComponent: number;
  /** 调色板；仅 Index 颜色使用。 */
  palette?: Rgba[];
}

/** 单个资源 XML 解码后的定义集合；资源层负责建立索引与作用域。 */
export interface ResourceDefinitionSet {
  fonts: FontResource[];
  images: ImageResource[];
  drawParams: DrawParam[];
  compositeGraphicUnits: CompositeGraphicUnit[];
  colorSpaces: ColorSpaceDef[];
  /** 底纹内联在 DrawParam/Paint 中，按资源 ID 收集。 */
  patterns: Map<ResourceId, Pattern>;
}

/** 模型层 Paint：尚未归一化为 PaintSpec。 */
export type Paint =
  | { type: 'color'; color: Rgba }
  | { type: 'axial'; shade: AxialShade }
  | { type: 'radial'; shade: RadialShade }
  | { type: 'pattern'; pattern: Pattern }
  | { type: 'gouraud'; shade: GouraudShade };

/** DrawParam 资源；所有字段都是可继承/可覆盖的 partial。 */
export interface DrawParam {
  id?: ResourceId;
  /** Relative 引用的父 DrawParam。 */
  relative?: ResourceId;
  /** 线宽，对象空间单位（通常 mm）。 */
  lineWidth?: number;
  cap?: LineCap;
  join?: LineJoin;
  miterLimit?: number;
  dashOffset?: number;
  dashPattern?: number[];
  /** 透明度，0..255。 */
  alpha?: number;
  fillColor?: Paint;
  strokeColor?: Paint;
}

/** 字体资源。 */
export interface FontResource {
  id: ResourceId;
  fontName: string;
  familyName?: string;
  /** unicode/prc/big5/symbol。 */
  charset: string;
  serif: boolean;
  bold: boolean;
  italic: boolean;
  fixedSize: boolean;
  /** 包内字体文件路径；缺失时依赖 FontProvider。 */
  fontFile?: string;
}

/** 图片格式。 */
export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'bmp' | 'tiff' | 'jbig2' | 'unknown';

/** 图片资源。 */
export interface ImageResource {
  id: ResourceId;
  /** 包内图片文件路径。 */
  mediaFile: string;
  format: ImageFormat;
}

/** 复合图形资源；Width/Height 使用 0.3528 mm 单位。 */
export interface CompositeGraphicUnit {
  id: ResourceId;
  /** 内容宽度，0.3528 mm 单位。 */
  width: number;
  /** 内容高度，0.3528 mm 单位。 */
  height: number;
  content: PageBlock;
}

/** 模板页定义（CommonData/TemplatePage）；`baseLoc` 已解析为包内路径。 */
export interface TemplatePageDef {
  id: ResourceId;
  /** 模板页内容文件，包内绝对路径。 */
  baseLoc: string;
  /** 默认 ZOrder；缺省 Background。 */
  zOrder?: 'Background' | 'Body' | 'Foreground';
}

/** 文档级公共数据。 */
export interface CommonData {
  /** 默认页区域，单位 mm。 */
  pageArea?: Box;
  publicRes?: string[];
  documentRes?: string[];
  defaultRes?: string;
  maxUnitId?: ResourceId;
  /** DefaultCS 颜色空间资源 ID；缺省回退 RGB。 */
  defaultColorSpaceId?: ResourceId;
  /** 模板页定义表；用于解析 PageModel.templates 的 loc。 */
  templatePages?: Record<ResourceId, TemplatePageDef>;
}

/** OFD 跳转目标类型。 */
export type DocumentDestinationType = 'XYZ' | 'Fit' | 'FitH' | 'FitV' | 'FitR';

/** 文档跳转目标；坐标单位 mm，页索引从 0 开始。 */
export interface DocumentDestination {
  /** OFD Dest@Type。 */
  type: DocumentDestinationType;
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

/** 大纲节点；children 保持 XML 顺序与层级。 */
export interface OutlineNode {
  /** 标题。 */
  title: string;
  /** OFD Expanded；缺省表示未声明。 */
  expanded?: boolean;
  /** 子节点，保持 XML 顺序。 */
  children: OutlineNode[];
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

/** OFD.xml 的 DocInfo 文档属性。 */
export interface DocInfo {
  /** DocInfo/DocID。 */
  docId?: string;
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
  /** DocInfo/Keywords，按空白/逗号切分。 */
  keywords?: string[];
  /** CustomDatas 的 Name → 文本。 */
  customData?: Record<string, string>;
  /** DocInfo/DocUsage。 */
  docUsage?: string;
}

/** Document.xml 权限声明模型；布尔项缺省均为 true。 */
export interface PermissionModel {
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
  /** 有效期；未声明表示不受限，日期保留 XML 原文。 */
  validPeriod?: {
    /** 开始日期原文。 */
    start?: string;
    /** 结束日期原文。 */
    end?: string;
  };
}

/** Attachments.xml 中的附件条目；尺寸按 GB/T 33190 的 KB 原文换算为 byte。 */
export interface AttachmentModel {
  /** Attachment@ID，已按资源 ID 规则规范化。 */
  id: ResourceId;
  /** Attachment@Name。 */
  name: string;
  /** Attachment@Format；未声明时省略。 */
  format?: string;
  /** 附件大小，byte；由 Attachment@Size（KB）换算，未声明时省略。 */
  size?: number;
  /** Attachment@CreationDate 原文。 */
  creationDate?: string;
  /** Attachment@ModDate 原文。 */
  modDate?: string;
  /** Attachment@Visible；缺省 true。 */
  visible: boolean;
  /** Attachment@Usage；缺省 `none`。 */
  usage: string;
  /** FileLoc 解析后的包内路径；未声明或路径非法时省略。 */
  fileLoc?: string;
}

/** 文档模型；打开文档后页数与页引用即固定。 */
export interface DocumentModel {
  id: ResourceId;
  /** OFD 版本，例如 `1.0`。 */
  version: string;
  /** 文档根目录，包内绝对路径。 */
  docRoot: string;
  /** OFD.xml 路径，包内绝对路径。 */
  ofdFile: string;
  /** 按前序遍历展开的页引用。 */
  pages: PageRef[];
  /** 页数，打开后不再变化。 */
  pageCount: number;
  commonData?: CommonData;
  /** 文档级模板索引：模板 ID → 定义；由 Document.xml/CommonData 解码时建立。 */
  templatePages: Record<ResourceId, TemplatePageDef>;
  /** 文档级注释索引文件 Annotations.xml 的包内路径；无注释时缺省。 */
  annotationsFile?: string;
  /** 页 ID → 分页注释文件路径；T10 按 page.id 懒加载。 */
  pageAnnotIndex: Record<ResourceId, string>;
  /** Document.xml 大纲树；无大纲时为空数组。 */
  outlines?: readonly OutlineNode[];
  /** Document.xml 书签列表；无书签时为空数组。 */
  bookmarks?: readonly BookmarkItem[];
  /** Document.xml 权限声明；无 Permissions 时使用默认全 true。 */
  permissions: PermissionModel;
  /** Document.xml 声明的附件列表 Attachments.xml 包内路径；无附件时缺省。 */
  attachmentsFile?: string;
}

/** 页树前序遍历结果。 */
export interface PageTree {
  pages: PageRef[];
  pageCount: number;
}

/** 轮廓缓存条目：字形 ID + 字体单位下的路径。 */
export interface CachedGlyphOutline {
  glyphId: number;
  advanceWidth: number;
  path: PathCommand[];
}