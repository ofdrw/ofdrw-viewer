import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ZipReader } from '../../src/container/zip-reader';
import { ArrayBufferSource } from '../../src/container/byte-source';

/** 仓库根样本目录（测试文件位于 packages/ofdrw-viewer-engine/test/container）。 */
const SAMPLE_DIR = fileURLToPath(new URL('../../../../ofd_pdf_match/', import.meta.url));

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

  it.skipIf(!existsSync(join(SAMPLE_DIR, '96d93ac858b444c1b914707872dbd645.ofd')))(
    'BUG-V2-01：96d93a 原始字节带 MIME 包装，仍可打开并解出 2 页文档',
    async () => {
      // 必须使用原始样本字节：文件前 172B 为 MIME multipart 头，EOCD 后还有 47B 结束边界。
      const bytes = readFileSync(join(SAMPLE_DIR, '96d93ac858b444c1b914707872dbd645.ofd'));
      const reader = await ZipReader.open(new ArrayBufferSource(bytes));
      expect(reader.listEntries()).toHaveLength(12);
      expect(reader.hasEntry('OFD.xml')).toBe(true);
      const documentXml = new TextDecoder().decode(await reader.readEntry('Doc_0/Document.xml'));
      expect(documentXml.match(/<ofd:Page\b/g)).toHaveLength(2);
      // 条目数据必须按 base 修正后读取成功（内容以 XML 声明开头）。
      expect(documentXml.trimStart().startsWith('<?xml')).toBe(true);
      reader.close();
    },
  );

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