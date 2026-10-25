import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ZipReader } from '../../src/container/zip-reader';
import { ArrayBufferSource } from '../../src/container/byte-source';
import { assertSampleManifest, loadSampleManifest, SAMPLE_DIR } from '../helpers/samples';

describe('container/zip-reader 真实样本', () => {
  it.skipIf(!existsSync(join(SAMPLE_DIR, 'containsJPEG.ofd')))(
    'containsJPEG 的 DOC_0/Res 路径可通过大小写唯一回退读取',
    async () => {
      const bytes = readFileSync(join(SAMPLE_DIR, 'containsJPEG.ofd'));
      const reader = await ZipReader.open(new ArrayBufferSource(bytes));
      expect(reader.listEntries().some((entry) => entry.name === 'DOC_0/Res/Image_4.JPEG')).toBe(true);
      const data = await reader.readEntry('Doc_0/Res/Image_4.JPEG');
      expect(data[0]).toBe(0xff);
      expect(data[1]).toBe(0xd8);
      reader.close();
    },
  );

  it('可打开样本目录中全部可识别 OFD 并读取入口 XML', async () => {
    // 样本数量随仓库演进，按实际可识别样本动态断言；无法识别的文件由 helpers 统计并校验比例。
    const manifest = loadSampleManifest();
    const ofdFiles = assertSampleManifest(manifest);

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
    // 下限保护：样本被清空或几乎全坏时不会静默通过。
    expect(xmlEntries).toBeGreaterThan(50);
  });
});
