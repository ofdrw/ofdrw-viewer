import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ZipReader } from '../../src/container/zip-reader';
import { ArrayBufferSource } from '../../src/container/byte-source';
import { parseXml } from '../../src/xml/parser';

/** 仓库根样本目录。 */
const SAMPLE_DIR = fileURLToPath(new URL('../../../../ofd_pdf_match/', import.meta.url));

describe('xml/parser 真实样本', () => {
  it.skipIf(!existsSync(SAMPLE_DIR))('可解析 55 对样本中的全部 XML 条目', async () => {
    const files = readdirSync(SAMPLE_DIR).filter((name) => name.toLowerCase().endsWith('.ofd'));
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
    expect(parsed).toBeGreaterThan(500);
  }, 30_000);
});
