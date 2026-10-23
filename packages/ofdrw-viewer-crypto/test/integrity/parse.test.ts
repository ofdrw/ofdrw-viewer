/**
 * OFDEntries.xml 清单解析：两种根元素/文件列表写法与错误输入。
 */

import { describe, expect, it } from 'vitest';
import { openZipVirtualContainer } from '@ofdrw/ofdrw-viewer-engine';
import { CryptoError, parseOfdEntriesXml } from '@ofdrw/ofdrw-viewer-crypto';
import { fixtureBytes } from '../core/fixtures';

/**
 * 读取 fixture 包内条目。
 *
 * @param file fixture 文件名。
 * @param path 包内路径。
 * @returns 条目字节。
 */
async function readEntry(file: string, path: string): Promise<Uint8Array> {
  const container = await openZipVirtualContainer({
    kind: 'arraybuffer',
    data: fixtureBytes(file),
  });
  try {
    return await container.read(path);
  } finally {
    await container.close();
  }
}

describe('parseOfdEntriesXml', () => {
  it('解析 ofdrw DocEntries/FileList', async () => {
    const bytes = await readEntry('integrity.ofd', 'OFDEntries.xml');
    const entries = parseOfdEntriesXml(bytes);
    expect(entries.id).toBe('1');
    expect(entries.creatorName).toBe('ofdrw-crypto');
    expect(entries.version).toBe('2.4.0');
    expect(entries.signedValueLoc).toBe('/signedvalue.dat');
    expect(entries.files).toEqual([
      'OFD.xml',
      'Doc_0/PublicRes.xml',
      'Doc_0/Pages/Page_1/Content.xml',
      'Doc_0/Pages/Page_0/Content.xml',
      'Doc_0/Document.xml',
    ]);
    expect(entries.raw).toEqual(bytes);
  });

  it('解析 OFDEntries/Entries 写法', () => {
    const xml = new TextEncoder().encode(
      '<?xml version="1.0"?><OFDEntries><SignedValueLoc>/sig.dat</SignedValueLoc>' +
        '<Entries><Entry Path="/A.xml"/><Entry Path="B/C.xml"/></Entries></OFDEntries>',
    );
    const entries = parseOfdEntriesXml(xml);
    expect(entries.signedValueLoc).toBe('/sig.dat');
    expect(entries.files).toEqual(['A.xml', 'B/C.xml']);
  });

  it('根元素不匹配抛 CRYPTO_INVALID_PACKAGE', () => {
    try {
      parseOfdEntriesXml(new TextEncoder().encode('<?xml version="1.0"?><Root/>'));
      throw new Error('未抛错');
    } catch (error) {
      expect((error as CryptoError).code).toBe('CRYPTO_INVALID_PACKAGE');
    }
  });

  it('非法 XML 抛 CRYPTO_INVALID_PACKAGE', () => {
    try {
      parseOfdEntriesXml(new TextEncoder().encode('<OFDEntries><FileList>'));
      throw new Error('未抛错');
    } catch (error) {
      expect((error as CryptoError).code).toBe('CRYPTO_INVALID_PACKAGE');
    }
  });
});
