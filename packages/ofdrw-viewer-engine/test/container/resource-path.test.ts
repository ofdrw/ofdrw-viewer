import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ArrayBufferSource } from '../../src/container/byte-source';
import { resolvePackagePath } from '../../src/container/path';
import { ZipReader } from '../../src/container/zip-reader';
import { buildZip } from './zip-fixture';

/** 仓库根样本目录。 */
const SAMPLE_DIR = fileURLToPath(new URL('../../../../ofd_pdf_match/', import.meta.url));

/** 从 PublicRes XML 提取 BaseLoc 与首个 MediaFile。 */
function readBaseLocAndMediaFile(xml: string): { baseLoc: string; mediaFile: string } {
  const baseLoc = /<ofd:Res[^>]*\bBaseLoc="([^"]*)"/.exec(xml)?.[1] ?? '';
  const mediaFile = /<ofd:MediaFile>\s*([^<]+?)\s*<\/ofd:MediaFile>/.exec(xml)?.[1] ?? '';
  return { baseLoc, mediaFile };
}

describe('container 资源路径', () => {
  it('BaseLoc="/" 下的 MediaFile 大小写不匹配时仍按唯一条目读取', async () => {
    const zip = buildZip([
      { name: 'DOC_0/Res/2.GIF', data: Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) },
      {
        name: 'Doc_0/PublicRes.xml',
        data: '<ofd:Res BaseLoc="/"><ofd:MediaFile>/doc_0/res/2.gif</ofd:MediaFile></ofd:Res>',
      },
    ]);
    const reader = await ZipReader.open(new ArrayBufferSource(zip));
    const { baseLoc, mediaFile } = readBaseLocAndMediaFile(
      new TextDecoder().decode(await reader.readEntry('Doc_0/PublicRes.xml')),
    );
    const resolved = resolvePackagePath(resolvePackagePath('Doc_0', baseLoc), mediaFile);
    expect(resolved).toBe('doc_0/res/2.gif');
    const bytes = await reader.readEntry(resolved);
    expect(new TextDecoder().decode(bytes)).toBe('GIF89a');
    reader.close();
  });

  it.skipIf(!existsSync(join(SAMPLE_DIR, '不规范资源路径.ofd')))(
    '不规范资源路径：BaseLoc="/" 与 /Doc_0/Res/2.gif 可定位并读取',
    async () => {
      const bytes = readFileSync(join(SAMPLE_DIR, '不规范资源路径.ofd'));
      const reader = await ZipReader.open(new ArrayBufferSource(bytes));
      const publicRes = new TextDecoder().decode(await reader.readEntry('Doc_0/PublicRes.xml'));
      const { baseLoc, mediaFile } = readBaseLocAndMediaFile(publicRes);
      expect(baseLoc).toBe('/');
      expect(mediaFile).toBe('/Doc_0/Res/2.gif');
      const resolved = resolvePackagePath(resolvePackagePath('Doc_0', baseLoc), mediaFile);
      expect(resolved).toBe('Doc_0/Res/2.gif');
      const image = await reader.readEntry(resolved);
      expect(image.byteLength).toBe(616673);
      expect(new TextDecoder().decode(image.subarray(0, 6))).toBe('GIF89a');
      reader.close();
    },
  );
});
