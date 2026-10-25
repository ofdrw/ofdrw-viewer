import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ZipReader } from '../../src/container/zip-reader';
import { ArrayBufferSource } from '../../src/container/byte-source';
import { parseXml } from '../../src/xml/parser';
import {
  assertSampleManifest,
  loadSampleManifest,
  SAMPLE_DIR,
} from '../helpers/samples';

describe('xml/parser 真实样本', () => {
  it('可解析样本目录中全部可识别 OFD 的 XML 条目', async () => {
    // 样本数量随仓库演进，按实际可识别样本动态断言；无法识别的文件单独统计。
    const manifest = loadSampleManifest();
    const files = assertSampleManifest(manifest);
    let parsed = 0;
    for (const name of files) {
      const reader = await ZipReader.open(
        new ArrayBufferSource(readFileSync(join(SAMPLE_DIR, name))),
      );
      for (const entry of reader.listEntries()) {
        if (!entry.name.toLowerCase().endsWith('.xml')) continue;
        const root = parseXml(await reader.readEntry(entry.name));
        expect(root.name.length, `${name}:${entry.name}`).toBeGreaterThan(0);
        parsed += 1;
      }
      reader.close();
    }
    // 下限保护：样本目录被清空或几乎全坏时不会静默通过。
    expect(parsed).toBeGreaterThan(500);
  }, 60_000);
});
