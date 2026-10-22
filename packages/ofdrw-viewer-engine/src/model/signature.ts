/**
 * 电子签章静态外观的模型解码。
 *
 * 只解析 `Signs/Signatures.xml`、`Signature.xml` 的 StampAnnot/Seal 路径，
 * 以及 `Seal.esl` 中的印章图片；不读取 SignedValue、不校验证书链或签名值。
 */

import type { XmlNode } from '../xml/types';
import type { OFDWarning } from '../warnings';
import type {
  ResourceId,
  SealImage,
  SignatureBundle,
  SignatureEntry,
  SignatureModel,
  SignatureStamp,
} from './types';
import { dirnameOf, resolvePackagePath } from '../container/path';
import { parseXml } from '../xml/parser';
import { attr, child, childText, children, emitWarning, normalizePathSeparators, parseBox } from './decode-utils';
import { normalizeResourceId } from './ids';
import { decodeSealImage } from './seal';

/** 签章目录相对文档目录的位置。 */
const SIGNATURES_RELATIVE_PATH = 'Signs/Signatures.xml';

/** 单次签章解码选项。 */
export interface SignatureDecodeOptions {
  /** warning 回调。 */
  onWarning?: (warning: OFDWarning) => void;
  /** 页 ID 列表（前序），用于 PageRef → 页索引。 */
  pageIds?: readonly ResourceId[];
  /** 覆盖 Signature ID（来自 Signatures.xml 索引）。 */
  id?: ResourceId;
  /** 覆盖签章类型（来自 Signatures.xml 索引）。 */
  type?: string;
}

/** 完整签章集合解码输入。 */
export interface SignatureBundleInput {
  /** Signs/Signatures.xml 根节点。 */
  index: XmlNode;
  /** Signs/Signatures.xml 的包内路径。 */
  indexFilePath: string;
  /** 页 ID 列表（前序）。 */
  pageIds: readonly ResourceId[];
  /** 按包内路径读取文件；通常由 API 层包装 ZIP 读取。 */
  readFile: (path: string) => Promise<Uint8Array> | Uint8Array;
}

/**
 * 推导文档的 Signatures.xml 包内路径。
 *
 * @param documentPath Document.xml 的包内路径，或 DocRoot 目录。
 * @returns `Doc_0/Signs/Signatures.xml` 形式的路径。
 */
export function signaturesFilePath(documentPath: string): string {
  const normalized = normalizePathSeparators(documentPath).replace(/^\/+|\/+$/g, '');
  const baseDir = /\.xml$/i.test(normalized) ? dirnameOf(normalized) : normalized;
  return resolvePackagePath(baseDir, SIGNATURES_RELATIVE_PATH);
}

/**
 * 解码 Signs/Signatures.xml 的索引项。
 *
 * @param root Signatures.xml 根节点。
 * @param filePath Signatures.xml 的包内路径。
 * @param options 解码选项。
 * @returns 索引项；缺少 ID/BaseLoc 的条目会 warning 后跳过。
 */
export function decodeSignaturesIndex(
  root: XmlNode,
  filePath: string,
  options: SignatureDecodeOptions = {},
): SignatureEntry[] {
  const baseDir = dirnameOf(filePath);
  const seen = new Set<ResourceId>();
  const result: SignatureEntry[] = [];
  for (const node of children(root, 'Signature')) {
    const id = normalizeResourceId(attr(node, 'ID'));
    if (!id) {
      emitWarning(options, 'W_BAD_NUMBER', 'Signature 缺少 ID，已跳过');
      continue;
    }
    if (seen.has(id)) {
      emitWarning(options, 'W_DUPLICATE_RESOURCE', `Signature ID 重复：${id}，先到先得`, { resourceId: id });
      continue;
    }
    const rawBaseLoc = (attr(node, 'BaseLoc') ?? '').trim() || childText(node, 'BaseLoc');
    if (!rawBaseLoc) {
      emitWarning(options, 'W_BAD_NUMBER', `Signature ${id} 缺少 BaseLoc，已跳过`, { resourceId: id });
      continue;
    }
    const baseLoc = resolveSignaturePath(baseDir, rawBaseLoc, options, id);
    if (!baseLoc) continue;
    seen.add(id);
    result.push({
      id,
      type: (attr(node, 'Type') ?? '').trim(),
      baseLoc,
    });
  }
  return result;
}

/**
 * 解码单个 Signature.xml。
 *
 * @param root Signature.xml 根节点。
 * @param filePath Signature.xml 的包内路径。
 * @param options 解码选项；`id`/`type` 通常来自 Signatures.xml 索引。
 * @returns 签章模型；Seal.esl 尚未读取，`seal` 由调用方填充。
 */
export function decodeSignature(
  root: XmlNode,
  filePath: string,
  options: SignatureDecodeOptions = {},
): SignatureModel {
  const id = normalizeResourceId(options.id ?? attr(root, 'ID'));
  const type = (options.type ?? attr(root, 'Type') ?? '').trim();
  const baseDir = dirnameOf(filePath);
  const model: SignatureModel = {
    id,
    type,
    baseLoc: filePath,
    stamps: decodeStampAnnots(root, options),
  };
  const signedInfo = child(root, 'SignedInfo');
  const sealNode = child(root, 'Seal') ?? (signedInfo ? child(signedInfo, 'Seal') : undefined);
  if (sealNode) {
    const rawSeal = childText(sealNode, 'BaseLoc') ?? (attr(sealNode, 'BaseLoc') ?? '').trim();
    if (!rawSeal) {
      emitWarning(options, 'W_BAD_NUMBER', `Signature ${id} 的 Seal 缺少 BaseLoc`, { resourceId: id });
    } else {
      const sealFile = resolveSignaturePath(baseDir, rawSeal, options, id);
      if (sealFile) model.sealFile = sealFile;
    }
  }
  return model;
}

/**
 * 读取并解码所有 Signature.xml 与 Seal.esl，生成按页索引。
 *
 * @param input 索引、页 ID 与文件读取器。
 * @param options 解码选项。
 * @returns 签章集合；单个签章/印章损坏时 warning 后继续。
 */
export async function decodeSignatureBundle(
  input: SignatureBundleInput,
  options: SignatureDecodeOptions = {},
): Promise<SignatureBundle> {
  const entries = decodeSignaturesIndex(input.index, input.indexFilePath, options);
  const signatures: SignatureModel[] = [];
  for (const entry of entries) {
    let model: SignatureModel;
    try {
      const bytes = await input.readFile(entry.baseLoc);
      model = decodeSignature(parseXml(bytes), entry.baseLoc, {
        ...options,
        id: entry.id,
        type: entry.type,
        pageIds: input.pageIds,
      });
    } catch (error) {
      emitWarning(options, 'W_BAD_NUMBER', `Signature ${entry.id} 读取/解析失败：${String(error)}`, {
        resourceId: entry.id,
      });
      continue;
    }
    if (model.sealFile) {
      try {
        const bytes = await input.readFile(model.sealFile);
        const seal: SealImage | undefined = decodeSealImage(bytes, {
          ...(options.onWarning ? { onWarning: options.onWarning } : {}),
          resourceId: model.id,
        });
        if (seal) model.seal = seal;
      } catch (error) {
        emitWarning(options, 'W_IMAGE_DECODE', `Seal.esl 读取失败：${String(error)}`, {
          resourceId: model.id,
        });
      }
    }
    signatures.push(model);
  }
  return {
    entries,
    signatures,
    pageIndex: buildSignaturePageIndex(signatures, input.pageIds, options),
  };
}

/**
 * 建立页索引 → 戳记列表，并补齐 PageRef 到页索引的映射。
 *
 * @param signatures 签章模型。
 * @param pageIds 页 ID 列表（前序）；不传时只使用已填的 `pageIndex`。
 * @param options 解码选项。
 * @returns 按页索引分组的戳记。
 */
export function buildSignaturePageIndex(
  signatures: readonly SignatureModel[],
  pageIds?: readonly ResourceId[],
  options: SignatureDecodeOptions = {},
): Record<number, SignatureStamp[]> {
  const normalizedPageIds = pageIds?.map((id) => normalizeResourceId(id));
  const result: Record<number, SignatureStamp[]> = {};
  for (const signature of signatures) {
    for (const stamp of signature.stamps) {
      if (stamp.pageIndex === undefined && normalizedPageIds) {
        const index = normalizedPageIds.indexOf(normalizeResourceId(stamp.pageId));
        if (index >= 0) {
          stamp.pageIndex = index;
        } else {
          emitWarning(
            options,
            'W_BAD_PATH',
            `StampAnnot ${stamp.id ?? ''} 的 PageRef ${stamp.pageId} 未匹配页面`,
            { resourceId: signature.id },
          );
        }
      }
      if (stamp.pageIndex === undefined) continue;
      (result[stamp.pageIndex] ??= []).push(stamp);
    }
  }
  return result;
}

/**
 * 解码所有 StampAnnot；兼容 SignedInfo 下与 Signature 直接子节点两种布局。
 *
 * @param root Signature.xml 根节点。
 * @param options 解码选项。
 * @returns 戳记数组，保持 XML 顺序。
 */
function decodeStampAnnots(root: XmlNode, options: SignatureDecodeOptions): SignatureStamp[] {
  const nodes: XmlNode[] = [];
  collectNodes(root, 'StampAnnot', nodes, 0);
  const normalizedPageIds = options.pageIds?.map((id) => normalizeResourceId(id));
  const result: SignatureStamp[] = [];
  for (const node of nodes) {
    const pageId = normalizeResourceId(attr(node, 'PageRef'));
    if (!pageId) {
      emitWarning(options, 'W_BAD_NUMBER', 'StampAnnot 缺少 PageRef，已跳过');
      continue;
    }
    const boundary = parseBox(attr(node, 'Boundary'), options, 'StampAnnot.Boundary');
    if (!boundary) {
      emitWarning(options, 'W_BAD_NUMBER', `StampAnnot ${attr(node, 'ID') ?? ''} 缺少 Boundary，已跳过`);
      continue;
    }
    const stamp: SignatureStamp = {
      pageId,
      boundary,
      ...(attr(node, 'ID') ? { id: normalizeResourceId(attr(node, 'ID')) } : {}),
    };
    const clip = parseBox(attr(node, 'Clip'), options, 'StampAnnot.Clip');
    if (clip) stamp.clip = clip;
    const pageIndex = normalizedPageIds?.indexOf(pageId);
    if (pageIndex !== undefined && pageIndex >= 0) stamp.pageIndex = pageIndex;
    result.push(stamp);
  }
  return result;
}

/** 递归收集指定 local name 的节点。 */
function collectNodes(node: XmlNode, name: string, out: XmlNode[], depth: number): void {
  if (depth > 32) return;
  for (const item of node.children) {
    if (item.name === name) {
      out.push(item);
      continue;
    }
    collectNodes(item, name, out, depth + 1);
  }
}

/** 解析签章相关相对路径。 */
function resolveSignaturePath(
  baseDir: string,
  raw: string,
  options: SignatureDecodeOptions,
  resourceId: ResourceId,
): string | undefined {
  try {
    return resolvePackagePath(baseDir, normalizePathSeparators(raw.trim()));
  } catch (error) {
    emitWarning(options, 'W_BAD_PATH', `签章路径非法：${JSON.stringify(raw)}（${String(error)}）`, {
      resourceId,
    });
    return undefined;
  }
}

