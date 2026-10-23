/**
 * `OFDEntries.xml` 解析（防夹带完整性清单）。
 *
 * 兼容两种写法：
 * - `<OFDEntries>/<SignedValueLoc>/…</SignedValueLoc><FileList><File FileLoc="/x"/></FileList>`
 * - `<DocEntries>/…/<Entries><Entry Path="/x"/></Entries>`（ofdrw 2.x 输出）
 *
 * 清单路径统一规范化为无前导 `/` 的包内路径，与 `VirtualContainer.list()` 对齐。
 */

import { CryptoError } from '../errors';
import type { ParseOptions } from '../types/options';
import { copyBytes } from '../util/bytes';
import { normalizePackagePath, resolvePackagePath } from '../sign/paths';
import { parseXml, type XmlElement } from '../sign/xml';

/** OFDEntries.xml 解析结果。 */
export interface OfdEntriesInfo {
  /** 清单元数据 ID。 */
  readonly id?: string;
  /** 创建者名称。 */
  readonly creatorName?: string;
  /** 清单版本。 */
  readonly version?: string;
  /** 创建日期文本。 */
  readonly creationDate?: string;
  /** 签名值路径（原样文本）。 */
  readonly signedValueLoc?: string;
  /** 清单登记的包内文件路径（规范化、无前导 `/`）。 */
  readonly files: readonly string[];
  /** 原始 XML 字节。 */
  readonly raw: Uint8Array;
}

/** 允许的根元素名称。 */
const ENTRY_ROOT_NAMES = new Set(['OFDEntries', 'DocEntries', 'Entries']);

/**
 * 解析 OFDEntries.xml。
 *
 * @param data XML 字节。
 * @param options 大小/深度上限。
 * @returns 清单信息。
 * @throws CryptoError `CRYPTO_INVALID_PACKAGE`：XML 非法或根元素不可识别。
 */
export function parseOfdEntriesXml(
  data: Uint8Array,
  options?: ParseOptions,
): OfdEntriesInfo {
  const bytes = copyBytes(data);
  const root = parseXml(bytes, {
    maxBytes: options?.maxBytes,
    maxDepth: options?.maxDepth,
  });
  if (!ENTRY_ROOT_NAMES.has(root.name)) {
    throw new CryptoError(
      'CRYPTO_INVALID_PACKAGE',
      `OFDEntries.xml 根元素应为 ofd:DocEntries/OFDEntries，实际为 ${root.name}`,
    );
  }
  const signedValueLoc = root.textOf('SignedValueLoc');
  const files = collectFilePaths(root);
  return {
    id: root.attribute('ID'),
    creatorName: root.attribute('CreatorName'),
    version: root.attribute('Version'),
    creationDate: root.attribute('CreationDate'),
    signedValueLoc,
    files,
    raw: bytes,
  };
}

/**
 * 收集清单文件路径。
 *
 * @param root 根元素。
 * @returns 规范化路径列表。
 */
function collectFilePaths(root: XmlElement): readonly string[] {
  const fileList = root.find('FileList');
  const entries = root.find('Entries');
  const paths: string[] = [];
  if (fileList) {
    for (const file of fileList.findAll('File')) {
      const loc = file.attribute('FileLoc');
      if (loc && loc.trim().length > 0) paths.push(resolvePackagePath('', loc));
    }
  }
  if (entries) {
    for (const entry of entries.findAll('Entry')) {
      const path = entry.attribute('Path') ?? entry.text;
      if (path && path.trim().length > 0) paths.push(resolvePackagePath('', path));
    }
  }
  return paths.map((path) => normalizePackagePath(path));
}