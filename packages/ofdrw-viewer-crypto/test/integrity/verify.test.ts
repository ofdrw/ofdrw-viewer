/**
 * 完整性清单定位：根清单优先于同名嵌套清单。
 */

import { describe, expect, it } from 'vitest';
import { verifyOfd } from '@ofdrw/ofdrw-viewer-crypto';
import {
  mergeEntries,
  readFixtureEntries,
  wrapEntries,
  type EntryMap,
} from '../verify/builders';

/**
 * 以条目表运行 verifyOfd 并返回完整性 entriesPath。
 *
 * @param entries 条目表。
 * @returns 清单路径。
 */
async function entriesPathOf(entries: EntryMap): Promise<string | undefined> {
  const container = wrapEntries(entries);
  try {
    const report = await verifyOfd({ container });
    return report.integrity?.entriesPath;
  } finally {
    await container.close();
  }
}

describe('verifyIntegrity OFDEntries.xml 定位', () => {
  it('根清单与嵌套清单同时存在时优先根 OFDEntries.xml', async () => {
    const base = await readFixtureEntries('integrity.ofd');
    const rootEntries = base.get('OFDEntries.xml')!;
    const entries = mergeEntries(
      base,
      new Map([['sub/OFDEntries.xml', { bytes: rootEntries.bytes }]]),
    );
    await expect(entriesPathOf(entries)).resolves.toBe('OFDEntries.xml');
  });

  it('SignedValueLoc 越界 → 完整性 invalid，不抛未捕获异常', async () => {
    const base = await readFixtureEntries('integrity.ofd');
    const original = new TextDecoder().decode(base.get('OFDEntries.xml')!.bytes);
    const xml = original.replace('/signedvalue.dat', '../x');
    const entries = mergeEntries(
      base,
      new Map([['OFDEntries.xml', { bytes: new TextEncoder().encode(xml) }]]),
    );
    const container = wrapEntries(entries);
    try {
      const report = await verifyOfd({ container });
      expect(report.integrity?.status).toBe('invalid');
      expect(report.integrity?.issues.map((item) => item.code)).toContain(
        'INTEGRITY_SIGNED_VALUE_LOC_INVALID',
      );
      expect(report.overall).toBe('invalid');
    } finally {
      await container.close();
    }
  });

  it('仅存在嵌套清单时按 /OFDEntries.xml 后缀匹配', async () => {
    const base = await readFixtureEntries('integrity.ofd');
    const rootEntries = base.get('OFDEntries.xml')!;
    const entries = new Map(base);
    entries.delete('OFDEntries.xml');
    entries.set('nested/dir/OFDEntries.xml', { bytes: rootEntries.bytes });
    await expect(entriesPathOf(entries)).resolves.toBe('nested/dir/OFDEntries.xml');
  });
});
