/**
 * OFD `Signatures.xml` / `Signature.xml` 解析。
 *
 * 只做结构解析，不做任何摘要/签名验证；遇到缺失必需字段时抛
 * `CRYPTO_INVALID_PACKAGE` typed error，由验证层转换为报告 issue。
 */

import { CryptoError } from '../errors';
import type { ParseOptions } from '../types/options';
import { copyBytes } from '../util/bytes';
import { parseXml, type XmlElement } from './xml';

/** 签名列表中的一条记录。 */
export interface SignatureRecord {
  /** 签名 ID。 */
  readonly id?: string;
  /** 签名类型：`Seal` / `Sign`。 */
  readonly type?: string;
  /** Signature.xml 路径原文；绝对/相对路径由验证层按引用规则解析。 */
  readonly baseLoc: string;
}

/** Signatures.xml 解析结果。 */
export interface SignaturesXml {
  /** 签名记录；顺序与 XML 一致。 */
  readonly signatures: readonly SignatureRecord[];
  /** MaxSignId 文本。 */
  readonly maxSignId?: string;
}

/** 签章外观注释。 */
export interface StampAnnotInfo {
  /** 注释 ID。 */
  readonly id?: string;
  /** 边界：`x y w h`。 */
  readonly boundary?: string;
  /** 引用页面。 */
  readonly pageRef?: string;
}

/** Signature.xml 中的一条 Reference。 */
export interface SignatureReferenceXml {
  /** 引用文件路径原文（可能为绝对或相对路径）。 */
  readonly fileRef: string;
  /** CheckValue 文本原文（Base64；兼容历史十六进制）。 */
  readonly checkValue: string;
}

/** Signature.xml 解析结果。 */
export interface SignatureXml {
  /** SignedValue 路径原文。 */
  readonly signedValueLoc: string;
  /** Seal 路径原文（可选）。 */
  readonly sealLoc?: string;
  /** 签名方法 OID 文本。 */
  readonly signatureMethod?: string;
  /** 签名时间文本（`yyyy-MM-dd HH:mm:ss`）。 */
  readonly signatureDateTime?: string;
  /** 签名模块提供者信息。 */
  readonly provider?: {
    readonly providerName?: string;
    readonly company?: string;
    readonly version?: string;
  };
  /** References 的 CheckMethod 属性。 */
  readonly checkMethod?: string;
  /** Reference 列表。 */
  readonly references: readonly SignatureReferenceXml[];
  /** 签章外观注释列表。 */
  readonly stampAnnots: readonly StampAnnotInfo[];
  /** 原始 XML 字节。 */
  readonly raw: Uint8Array;
}

/**
 * 解析 Signatures.xml。
 *
 * @param data XML 字节。
 * @param options 大小/深度上限。
 * @returns 签名记录列表；单条记录缺少/空 BaseLoc 时保留空字符串，由验证层记录 issue。
 * @throws CryptoError `CRYPTO_INVALID_PACKAGE`：XML 根元素/整体结构非法。
 */
export function parseSignaturesXml(
  data: Uint8Array,
  options?: ParseOptions,
): SignaturesXml {
  const root = requireRoot(parseXml(data, toXmlOptions(options)), 'Signatures');
  const signatures: SignatureRecord[] = [];
  for (const element of root.findAll('Signature')) {
    signatures.push({
      id: element.attribute('ID'),
      type: element.attribute('Type'),
      // 单条记录缺 BaseLoc 不能中断整份签名列表解析。
      baseLoc: readLocOptional(element),
    });
  }
  return { signatures, maxSignId: root.textOf('MaxSignId') };
}

/**
 * 解析 Signature.xml。
 *
 * @param data XML 字节。
 * @param options 大小/深度上限。
 * @returns Signature.xml 结构。
 * @throws CryptoError `CRYPTO_INVALID_PACKAGE`：XML 非法或缺少 SignedValue。
 */
export function parseSignatureXml(data: Uint8Array, options?: ParseOptions): SignatureXml {
  const bytes = copyBytes(data);
  const root = requireRoot(parseXml(bytes, toXmlOptions(options)), 'Signature');
  const signedValue = root.find('SignedValue');
  if (!signedValue) {
    throw new CryptoError('CRYPTO_INVALID_PACKAGE', 'Signature.xml 缺少 SignedValue');
  }
  const signedInfo = root.find('SignedInfo');
  const seal = signedInfo?.find('Seal');
  const referencesNode = signedInfo?.find('References');
  const references = referencesNode
    ? referencesNode.findAll('Reference').map((reference) => {
        const fileRef = reference.attribute('FileRef');
        if (!fileRef || fileRef.trim().length === 0) {
          throw new CryptoError('CRYPTO_INVALID_PACKAGE', 'Reference 缺少 FileRef');
        }
        return {
          fileRef: fileRef.trim(),
          checkValue: reference.textOf('CheckValue')?.trim() ?? '',
        };
      })
    : [];
  const stampAnnots = (signedInfo?.findAll('StampAnnot') ?? []).map((annot) => ({
    id: annot.attribute('ID'),
    boundary: annot.attribute('Boundary'),
    pageRef: annot.attribute('PageRef'),
  }));
  const providerNode = signedInfo?.find('Provider');
  const provider = providerNode
    ? {
        providerName: providerNode.attribute('ProviderName'),
        company: providerNode.attribute('Company'),
        version: providerNode.attribute('Version'),
      }
    : undefined;

  return {
    signedValueLoc: readLoc(signedValue),
    sealLoc: seal ? readLoc(seal) : undefined,
    signatureMethod: signedInfo?.textOf('SignatureMethod'),
    signatureDateTime: signedInfo?.textOf('SignatureDateTime'),
    provider,
    checkMethod: referencesNode?.attribute('CheckMethod'),
    references,
    stampAnnots,
    raw: bytes,
  };
}

/**
 * 读取路径元素（`BaseLoc` 属性或元素文本）。
 *
 * @param element 路径元素。
 * @returns 去除首尾空白的路径文本。
 * @throws CryptoError `CRYPTO_INVALID_PACKAGE`：路径为空。
 */
function readLoc(element: XmlElement): string {
  const value = element.find('BaseLoc')?.text ?? element.attribute('BaseLoc') ?? element.text;
  if (!value || value.trim().length === 0) {
    throw new CryptoError('CRYPTO_INVALID_PACKAGE', `${element.name} 路径为空`);
  }
  return value.trim();
}

/**
 * 读取可缺省的路径元素（用于 Signatures.xml 的逐条记录）。
 *
 * @param element 路径元素。
 * @returns 去除首尾空白的路径文本；缺失/空返回空字符串。
 */
function readLocOptional(element: XmlElement): string {
  const value = element.find('BaseLoc')?.text ?? element.attribute('BaseLoc') ?? element.text;
  return value?.trim() ?? '';
}

/**
 * 校验 XML 根元素名称。
 *
 * @param root 根元素。
 * @param expected 期望本地名。
 * @returns 根元素。
 * @throws CryptoError `CRYPTO_INVALID_PACKAGE`：根元素不匹配。
 */
function requireRoot(root: XmlElement, expected: string): XmlElement {
  if (root.name !== expected) {
    throw new CryptoError(
      'CRYPTO_INVALID_PACKAGE',
      `XML 根元素应为 ${expected}，实际为 ${root.name}`,
    );
  }
  return root;
}

/**
 * 转换为 XML 解析选项。
 *
 * @param options 解析选项。
 * @returns XML 解析选项。
 */
function toXmlOptions(options?: ParseOptions): { maxBytes?: number; maxDepth?: number } {
  return { maxBytes: options?.maxBytes, maxDepth: options?.maxDepth };
}