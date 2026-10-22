/**
 * `Seal.esl` 的 SESeal 解码。
 *
 * 只提取静态红章图片（SES_ESPictrueInfo）；不校验证书链、签名值或时间戳。
 * 结构约定见 GMT 0031-2014 与 ofdrw-gm 的 SESeal/SES_SealInfo。
 */

import type { OFDWarning } from '../warnings';
import type { ResourceId, SealImage } from './types';
import { derInteger, derString, parseDer, type DerNode } from './asn1';
import { emitWarning } from './decode-utils';

/** Seal.esl 解码选项。 */
export interface SealDecodeOptions {
  /** warning 回调；DER 损坏、缺字段或图片格式异常时上报。 */
  onWarning?: (warning: OFDWarning) => void;
  /** 所属签章资源 ID，用于 warning 定位。 */
  resourceId?: ResourceId;
}

/** 支持的印章图片格式。 */
const SUPPORTED_TYPES = new Set(['PNG', 'GIF', 'JPG', 'JPEG', 'BMP']);

/**
 * 解码 Seal.esl 并提取内嵌印章图片。
 *
 * @param data Seal.esl 字节。
 * @param options 解码选项。
 * @returns 印章图片；DER 损坏、缺少图片节点或图片为空时返回 undefined。
 */
export function decodeSealImage(
  data: Uint8Array,
  options: SealDecodeOptions = {},
): SealImage | undefined {
  if (data.length === 0) {
    emitWarning(options, 'W_IMAGE_DECODE', 'Seal.esl 为空');
    return undefined;
  }
  let tops: DerNode[];
  try {
    tops = parseDer(data);
  } catch (error) {
    emitWarning(options, 'W_BAD_NUMBER', `Seal.esl DER 解析失败：${String(error)}`);
    return magicFallback(data, options);
  }
  const structure = findSealStructure(tops);
  if (!structure) {
    emitWarning(options, 'W_BAD_NUMBER', 'Seal.esl 结构不是已知的 v1/v4/v5 签章数据');
    return magicFallback(data, options);
  }
  const picture = findPicture(structure.sealInfo);
  if (!picture) {
    emitWarning(options, 'W_BAD_NUMBER', 'Seal.esl 缺少 SES_ESPictrueInfo');
    return undefined;
  }
  const dataNode = picture.children[1];
  const imageBytes = dataNode?.value;
  if (!imageBytes || imageBytes.length === 0) {
    emitWarning(options, 'W_IMAGE_DECODE', 'Seal.esl 印章图片数据为空');
    return undefined;
  }
  let declared = (derString(picture.children[0]) ?? '').trim().toUpperCase();
  const detected = detectImageType(imageBytes);
  if (!declared) {
    declared = detected ?? '';
    emitWarning(options, 'W_IMAGE_DECODE', 'Seal.esl 缺少图片类型，按魔术字节识别');
  } else if (!SUPPORTED_TYPES.has(declared)) {
    if (detected) {
      emitWarning(
        options,
        'W_IMAGE_DECODE',
        `Seal.esl 图片类型 ${JSON.stringify(declared)} 不支持，按魔术字节识别为 ${detected}`,
      );
      declared = detected;
    } else {
      emitWarning(options, 'W_IMAGE_DECODE', `Seal.esl 图片类型 ${JSON.stringify(declared)} 不支持`);
    }
  }
  let width = derInteger(picture.children[2]);
  let height = derInteger(picture.children[3]);
  if (width === undefined || width <= 0) {
    emitWarning(options, 'W_BAD_NUMBER', `Seal.esl 图片宽度非法：${String(width)}，按 0 mm 处理`);
    width = 0;
  }
  if (height === undefined || height <= 0) {
    emitWarning(options, 'W_BAD_NUMBER', `Seal.esl 图片高度非法：${String(height)}，按 0 mm 处理`);
    height = 0;
  }
  return {
    version: structure.version,
    type: declared || 'UNKNOWN',
    data: imageBytes,
    width,
    height,
  };
}

/** 已知的电子印章结构版本。 */
export type SealVersion = 'v1' | 'v4' | 'v5';

/** 从顶层序列推断出的签章结构。 */
export interface SealStructure {
  /** 结构版本。 */
  version: SealVersion;
  /** SESeal 序列；SESignature 时为其内嵌的 eseal。 */
  seal: DerNode;
  /** SES_SealInfo 序列。 */
  sealInfo: DerNode;
}

/**
 * 按 ofdrw-gm VersionParser 的规则推断 Seal.esl 结构版本。
 *
 * - 顶层 2 个字段：v1（SESeal 或 SESignature）；
 * - 顶层 4 个字段：读 SealInfo/Header 的 version，5 为 v5，否则 v4；
 * - 顶层 5 个字段：v5（SESeal 直连）或按内嵌 SealInfo 判 v5/v4（SESignature）；
 * - 其他：未知结构。
 *
 * @param tops DER 顶层节点。
 * @returns 结构信息；无法匹配已知版本时返回 undefined。
 */
export function findSealStructure(tops: readonly DerNode[]): SealStructure | undefined {
  let first = tops[0];
  if (!first) return undefined;
  if (first.tag === 0x04) {
    try {
      first = parseDer(first.value)[0];
    } catch {
      return undefined;
    }
  }
  if (!first || first.tag !== 0x30) return undefined;
  const children = first.children;
  const direct = children[0];
  if (direct && isSealInfo(direct)) {
    if (children.length === 2) return { version: 'v1', seal: first, sealInfo: direct };
    if (children.length === 5) return { version: 'v5', seal: first, sealInfo: direct };
    if (children.length === 4) {
      const header = sealHeaderVersion(direct);
      if (header === undefined) return undefined;
      return { version: header === 5 ? 'v5' : 'v4', seal: first, sealInfo: direct };
    }
    return undefined;
  }
  // SES_Signature：TBS_Sign[0] → eseal[1] → SealInfo[0]。
  const tbs = direct;
  const embeddedSeal = tbs?.tag === 0x30 ? tbs.children[1] : undefined;
  const embeddedInfo = isSealInfo(embeddedSeal) ? embeddedSeal : embeddedSeal?.children[0];
  if (!embeddedSeal || !embeddedInfo || !isSealInfo(embeddedInfo)) return undefined;
  if (children.length === 2) return { version: 'v1', seal: embeddedSeal, sealInfo: embeddedInfo };
  if (children.length !== 4 && children.length !== 5) return undefined;
  const header = sealHeaderVersion(embeddedInfo);
  if (header === undefined) return undefined;
  return { version: header === 5 ? 'v5' : 'v4', seal: embeddedSeal, sealInfo: embeddedInfo };
}

/** 判断节点是否为 SES_SealInfo（Header[0] 的第二项为版本整数）。 */
function isSealInfo(node: DerNode | undefined): boolean {
  if (!node || node.tag !== 0x30 || node.children.length < 3) return false;
  const header = node.children[0];
  if (!header || header.tag !== 0x30) return false;
  return derInteger(header.children[1]) !== undefined;
}

/** 读取 SES_Header 的版本号。 */
function sealHeaderVersion(sealInfo: DerNode): number | undefined {
  const header = sealInfo.children[0];
  return header?.tag === 0x30 ? derInteger(header.children[1]) : undefined;
}

/**
 * 在 SES_SealInfo 中查找 SES_ESPictrueInfo。
 *
 * @param sealInfo SES_SealInfo SEQUENCE。
 * @returns 图片信息 SEQUENCE；缺失时返回 undefined。
 */
function findPicture(sealInfo: DerNode): DerNode | undefined {
  const preferred = sealInfo.children[3];
  if (isPicture(preferred)) return preferred;
  return sealInfo.children.find((node) => isPicture(node));
}

/** 判断节点是否为 SES_ESPictrueInfo。 */
function isPicture(node: DerNode | undefined): node is DerNode {
  if (!node || node.tag !== 0x30 || node.children.length < 4) return false;
  return (
    derString(node.children[0]) !== undefined &&
    node.children[1]?.tag === 0x04 &&
    derInteger(node.children[2]) !== undefined &&
    derInteger(node.children[3]) !== undefined
  );
}

/**
 * DER 结构不可用时，按图片魔术字节兜底；尺寸未知按 0 mm。
 *
 * @param data Seal.esl 原始字节。
 * @param options 解码选项。
 * @returns 兜底图片；不是已知图片格式时返回 undefined。
 */
function magicFallback(data: Uint8Array, options: SealDecodeOptions): SealImage | undefined {
  const type = detectImageType(data);
  if (!type) return undefined;
  emitWarning(options, 'W_IMAGE_DECODE', `Seal.esl DER 结构不可用，按魔术字节识别为 ${type}，尺寸未知`);
  return { version: 'unknown', type, data, width: 0, height: 0 };
}

/**
 * 按文件头识别图片格式。
 *
 * @param data 图片字节。
 * @returns PNG/JPEG/GIF/BMP；无法识别时返回 undefined。
 */
export function detectImageType(data: Uint8Array): string | undefined {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'PNG';
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'JPEG';
  if (startsWith(data, [0x47, 0x49, 0x46, 0x38])) return 'GIF';
  if (startsWith(data, [0x42, 0x4d])) return 'BMP';
  return undefined;
}

/** 判断字节前缀是否匹配。 */
function startsWith(data: Uint8Array, prefix: readonly number[]): boolean {
  if (data.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (data[index] !== prefix[index]) return false;
  }
  return true;
}