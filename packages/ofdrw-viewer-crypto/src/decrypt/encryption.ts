/**
 * `Encryptions.xml` / `decryptseed.dat` 解析（设计 §4.2/§4.3）。
 *
 * 只解析结构与凭据元数据，不做任何解密；密码学操作在 `layer.ts` 中完成。
 */

import { CryptoError } from '../errors';
import { parseCertificate } from '../cert/parse';
import type { X509Certificate } from '../asn1/x509';
import { fromBase64 } from '../util/bytes';
import { resolveVirtualPath } from '../container/paths';
import type { XmlElement } from './xml';
import { decodeUtf8Strict, parseXml, xmlAttr, xmlChildText, xmlFind, xmlChildren } from './xml';
import type { CryptoLimits } from '../types/limits';

/** 单个 `EncryptInfo` 解析结果。 */
export interface ParsedEncryptionLayer {
  /** 从 0 开始的层号。 */
  readonly layer: number;
  /** 层 ID。 */
  readonly id: string;
  /** 加密时间（ISO 文本）。 */
  readonly encryptDate?: string;
  /** 加密范围（诊断字段）。 */
  readonly encryptScope?: string;
  /** 解密种子路径，规范化后无前导 `/`。 */
  readonly decryptSeedPath: string;
  /** 条目映射路径，规范化后无前导 `/`。 */
  readonly entriesMapPath: string;
}

/** `UserInfo` 解析结果。 */
export interface ParsedSeedUser {
  /** 用户名。 */
  readonly userName: string;
  /** 由 `UserCert` 是否存在判定。 */
  readonly method: 'password' | 'certificate';
  /** 证书（仅 certificate）。 */
  readonly certificate?: X509Certificate;
  /** SM4-CBC IV，16 byte。 */
  readonly iv: Uint8Array;
  /** 被包裹的 FEK（口令为 SM4 密文，证书为 SM2Cipher DER）。 */
  readonly encryptedKey: Uint8Array;
}

/**
 * 读取并严格解析 XML 条目。
 *
 * @param read 条目读取函数。
 * @param path 包内路径。
 * @param limits crypto 限制。
 * @param signal 取消信号。
 * @returns 根元素；条目不存在返回 undefined。
 */
export async function readXmlElement(
  read: (path: string, maxBytes: number, signal?: AbortSignal) => Promise<Uint8Array>,
  path: string,
  limits: CryptoLimits,
  signal?: AbortSignal,
): Promise<XmlElement | undefined> {
  const bytes = await read(path, limits.maxAsn1Bytes, signal);
  return parseXml(decodeUtf8Strict(bytes), {
    maxBytes: limits.maxAsn1Bytes,
    maxDepth: limits.maxAsn1Depth,
  });
}

/**
 * 解析 `Encryptions.xml`。
 *
 * @param root 根元素。
 * @param maxLayers 最大层数。
 * @returns 层数组；无 `EncryptInfo` 时返回空数组。
 * @throws CryptoError `CRYPTO_DECRYPT_LAYER_LIMIT` / `CRYPTO_INVALID_PACKAGE`。
 */
export function parseEncryptions(
  root: XmlElement,
  maxLayers: number,
): ParsedEncryptionLayer[] {
  const container = root.localName === 'Encryptions' ? root : xmlFind(root, 'Encryptions');
  if (!container) {
    throw new CryptoError('CRYPTO_INVALID_PACKAGE', 'Encryptions.xml 根元素非法');
  }
  const infos = xmlChildren(container, 'EncryptInfo');
  if (infos.length > maxLayers) {
    throw new CryptoError(
      'CRYPTO_DECRYPT_LAYER_LIMIT',
      `加密层数 ${infos.length} 超过上限 ${maxLayers}`,
    );
  }
  return infos.map((info, index) => {
    const id = xmlAttr(info, 'ID')?.trim() || `layer-${index + 1}`;
    const seed = xmlChildText(info, 'DecryptSeedLoc') ?? '/decryptseed.dat';
    const map = xmlChildText(info, 'EntriesMapLoc') ?? '/entriesmap.dat';
    let decryptSeedPath: string;
    let entriesMapPath: string;
    try {
      decryptSeedPath = resolveVirtualPath('', seed);
      entriesMapPath = resolveVirtualPath('', map);
    } catch {
      throw new CryptoError('CRYPTO_INVALID_PACKAGE', `加密层 ${id} 的路径非法`);
    }
    if (decryptSeedPath.length === 0 || entriesMapPath.length === 0) {
      throw new CryptoError('CRYPTO_INVALID_PACKAGE', `加密层 ${id} 的路径为空`);
    }
    return {
      layer: index,
      id,
      encryptDate: xmlChildText(info, 'EncryptDate'),
      encryptScope: xmlChildText(info, 'EncryptScope'),
      decryptSeedPath,
      entriesMapPath,
    };
  });
}

/**
 * 解析 `decryptseed.dat`。
 *
 * @param root 根元素。
 * @param limits ASN.1/XML 大小上限。
 * @returns 用户数组。
 * @throws CryptoError `CRYPTO_INVALID_PACKAGE` / `CRYPTO_CERTIFICATE_INVALID`。
 */
export function parseDecryptSeed(root: XmlElement, limits: CryptoLimits): ParsedSeedUser[] {
  const seed =
    root.localName === 'DecyptSeed' || root.localName === 'DecryptSeed'
      ? root
      : xmlFind(root, 'DecyptSeed') ?? xmlFind(root, 'DecryptSeed');
  if (!seed) {
    throw new CryptoError('CRYPTO_INVALID_PACKAGE', 'decryptseed.dat 根元素非法');
  }
  const infos = collectDescendants(seed, 'UserInfo');
  return infos.map((info) => {
    const userName = xmlAttr(info, 'UserName')?.trim();
    if (!userName) {
      throw new CryptoError('CRYPTO_INVALID_PACKAGE', 'UserInfo 缺少 UserName');
    }
    const ivText = xmlChildText(info, 'IVValue');
    const keyText = xmlChildText(info, 'EncryptedWK');
    if (!ivText || !keyText) {
      throw new CryptoError('CRYPTO_INVALID_PACKAGE', `用户 ${userName} 缺少 IVValue/EncryptedWK`);
    }
    let iv: Uint8Array;
    let encryptedKey: Uint8Array;
    try {
      iv = fromBase64(ivText);
      encryptedKey = fromBase64(keyText);
    } catch {
      throw new CryptoError('CRYPTO_INVALID_PACKAGE', `用户 ${userName} 的加密参数不是合法 Base64`);
    }
    if (iv.length !== 16) {
      throw new CryptoError('CRYPTO_INVALID_PACKAGE', `用户 ${userName} 的 IV 长度不是 16 byte`);
    }
    if (encryptedKey.length === 0) {
      throw new CryptoError('CRYPTO_INVALID_PACKAGE', `用户 ${userName} 的 EncryptedWK 为空`);
    }
    const certElement = xmlFind(info, 'UserCert');
    if (!certElement) {
      // 口令用户的 EncryptedWK 是 SM4-CBC 密文，必须是完整分组。
      if (encryptedKey.length % 16 !== 0) {
        throw new CryptoError(
          'CRYPTO_INVALID_PACKAGE',
          `用户 ${userName} 的 EncryptedWK 长度不是 16 byte 的倍数`,
        );
      }
      return { userName, method: 'password', iv, encryptedKey };
    }
    const certText = certElement.text.trim();
    if (!certText) {
      throw new CryptoError('CRYPTO_INVALID_PACKAGE', `用户 ${userName} 的 UserCert 为空`);
    }
    let certDer: Uint8Array;
    try {
      certDer = fromBase64(certText);
    } catch {
      throw new CryptoError('CRYPTO_INVALID_PACKAGE', `用户 ${userName} 的 UserCert 不是合法 Base64`);
    }
    let certificate: X509Certificate;
    try {
      certificate = parseCertificate(certDer, { maxBytes: limits.maxAsn1Bytes });
    } catch (error) {
      if (error instanceof CryptoError && error.code === 'CRYPTO_LIMIT_EXCEEDED') throw error;
      throw new CryptoError('CRYPTO_CERTIFICATE_INVALID', `用户 ${userName} 的 UserCert 非法`);
    }
    return { userName, method: 'certificate', certificate, iv, encryptedKey };
  });
}

/**
 * 递归收集指定本地名的后代元素。
 *
 * @param element 根元素。
 * @param localName 本地名。
 * @returns 元素数组。
 */
function collectDescendants(element: XmlElement, localName: string): XmlElement[] {
  const result: XmlElement[] = [];
  for (const child of element.children) {
    if (child.localName === localName) result.push(child);
    result.push(...collectDescendants(child, localName));
  }
  return result;
}
