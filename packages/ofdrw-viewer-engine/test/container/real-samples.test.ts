import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ZipReader } from '../../src/container/zip-reader';
import { ArrayBufferSource } from '../../src/container/byte-source';

/** 仓库根样本目录（测试文件位于 packages/ofdrw-viewer-engine/test/container）。 */
const SAMPLE_DIR = fileURLToPath(new URL('../../../../ofd_pdf_match/', import.meta.url));

describe('container/zip-reader 真实样本', () => {
  it.skipIf(!existsSync(SAMPLE_DIR))('可打开 55 对样本中的全部 OFD 并读取入口 XML', async () => {
    const files = readdirSync(SAMPLE_DIR);
    const ofdFiles = files.filter((name) => name.toLowerCase().endsWith('.ofd')).sort();
    expect(ofdFiles.length).toBeGreaterThanOrEqual(50);

    let xmlEntries = 0;
    for (const name of ofdFiles) {
      const bytes = readFileSync(join(SAMPLE_DIR, name));
      const reader = await ZipReader.open(new ArrayBufferSource(bytes));
      const entries = reader.listEntries();
      expect(entries.length, name).toBeGreaterThan(0);
      expect(reader.hasEntry('OFD.xml'), name).toBe(true);

      const ofdXml = new TextDecoder().decode(await reader.readEntry('OFD.xml'));
      expect(ofdXml, name).toContain('OFD');
      const documentEntry = entries.find((entry) => entry.name.endsWith('/Document.xml'));
      expect(documentEntry, name).toBeDefined();
      const documentXml = new TextDecoder().decode(await reader.readEntry(documentEntry!.name));
      expect(documentXml, name).toContain('Document');
      xmlEntries += entries.filter((entry) => entry.name.endsWith('.xml')).length;
      reader.close();
    }
    expect(xmlEntries).toBeGreaterThan(50);
  });
});