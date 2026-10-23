/**
 * `entriesmap.dat` 解析与条目映射（设计 §4.7）。
 *
 * 兼容两种形态：先用本层 FEK/IV 做 SM4-CBC 解密并严格解析 XML（encrypted），
 * 失败时把原始字节按 UTF-8 XML 解析（plaintext，产生 warning）。映射结果
 * 只描述 Path/EPath，不读取文件内容。
 */

import { CryptoError } from '../errors';
import { sm4DecryptCbc } from '../sm/sm4';
import type { CryptoLimits } from '../types/limits';
import { normalizeVirtualPath } from '../container/paths';
import { decodeUtf8Strict, parseXml, xmlAttr, xmlChildren, xmlFind } from './xml';

/** 一条 EPath → Path 映射。 */
export interface EntryMapping {
  /** 明文目标路径（规范化、无前导 `/`）。 */
  readonly path: string;
  /** 密文条目路径（规范化、无前导 `/`）。 */
  readonly ePath: string;
}

/** entriesmap 解析结果。 */
export interface ParsedEntriesMap {
  /** 密文形态或明文形态。 */
  readonly mode: 'encrypted' | 'plaintext';
  /** 映射列表。 */
  readonly mappings: readonly EntryMapping[];
}

/** 加密元数据条目，输出容器必须隐藏。 */
const RESERVED_PATHS = new Set([
  'Encryptions.xml',
  'decryptseed.dat',
  'entriesmap.dat',
]);

/**
 * 解析 entriesmap 字节。
 *
 * @param bytes 原始 entriesmap 字节（可能加密）。
 * @param fek 本层文件密钥，16 byte。
 * @param iv 本层 IV，16 byte。
 * @param limits XML 上限。
 * @returns 解析结果。
 * @throws CryptoError `CRYPTO_ENTRY_MAP_INVALID`。
 */
export function parseEntriesMap(
  bytes: Uint8Array,
  fek: Uint8Array,
  iv: Uint8Array,
  limits: CryptoLimits,
): ParsedEntriesMap {
  let decrypted: Uint8Array | undefined;
  try {
    decrypted = sm4DecryptCbc(bytes, fek, iv);
  } catch {
    decrypted = undefined;
  }
  if (decrypted) {
    try {
      const mappings = readMappings(decrypted, limits);
      return { mode: 'encrypted', mappings };
    } catch (error) {
      if (error instanceof CryptoError && error.code === 'CRYPTO_LIMIT_EXCEEDED') throw error;
      // 继续尝试明文形态。
    }
  }
  try {
    const mappings = readMappings(bytes, limits);
    return { mode: 'plaintext', mappings };
  } catch (error) {
    if (error instanceof CryptoError && error.code === 'CRYPTO_LIMIT_EXCEEDED') throw error;
    throw new CryptoError('CRYPTO_ENTRY_MAP_INVALID', 'entriesmap.dat 无法解析');
  }
}

/**
 * 解析明文 XML 映射。
 *
 * @param bytes XML 字节。
 * @param limits XML 上限。
 * @returns 映射列表。
 * @throws CryptoError `CRYPTO_ENTRY_MAP_INVALID`。
 */
function readMappings(bytes: Uint8Array, limits: CryptoLimits): EntryMapping[] {
  const text = decodeUtf8Strict(bytes);
  const root = parseXml(text, { maxBytes: limits.maxAsn1Bytes, maxDepth: limits.maxAsn1Depth });
  const container =
    root.localName === 'EncryptEntries' || root.localName === 'Entries'
      ? root
      : xmlFind(root, 'EncryptEntries') ?? xmlFind(root, 'Entries');
  if (!container) throw new CryptoError('CRYPTO_ENTRY_MAP_INVALID', 'entriesmap 根元素非法');
  const entries = [
    ...xmlChildren(container, 'EncryptEntry'),
    ...xmlChildren(container, 'Entry'),
  ];
  if (entries.length === 0) {
    throw new CryptoError('CRYPTO_ENTRY_MAP_INVALID', 'entriesmap 没有条目');
  }
  const seenPath = new Set<string>();
  const seenEPath = new Set<string>();
  return entries.map((entry, index) => {
    const rawPath = xmlAttr(entry, 'Path')?.trim();
    const rawEPath = xmlAttr(entry, 'EPath')?.trim();
    if (!rawPath || !rawEPath) {
      throw new CryptoError('CRYPTO_ENTRY_MAP_INVALID', `entriesmap 第 ${index + 1} 条缺少 Path/EPath`);
    }
    let path: string;
    let ePath: string;
    try {
      path = normalizeVirtualPath(rawPath);
      ePath = normalizeVirtualPath(rawEPath);
    } catch {
      throw new CryptoError('CRYPTO_ENTRY_MAP_INVALID', `entriesmap 第 ${index + 1} 条路径非法`);
    }
    if (path.length === 0 || ePath.length === 0) {
      throw new CryptoError('CRYPTO_ENTRY_MAP_INVALID', `entriesmap 第 ${index + 1} 条路径为空`);
    }
    if (RESERVED_PATHS.has(path)) {
      throw new CryptoError('CRYPTO_ENTRY_MAP_INVALID', `entriesmap 输出路径覆盖加密元数据：${path}`);
    }
    if (seenPath.has(path) || seenEPath.has(ePath)) {
      throw new CryptoError('CRYPTO_ENTRY_MAP_INVALID', `entriesmap 路径重复：${path}`);
    }
    seenPath.add(path);
    seenEPath.add(ePath);
    return { path, ePath };
  });
}
