import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ArrayBufferSource } from '../../src/container/byte-source';
import { ZipReader } from '../../src/container/zip-reader';
import { parseXml } from '../../src/xml/parser';
import { decodeAnnotations, decodeAnnotationsIndex, decodeDocument, decodeOfdRoot, decodePageContent, decodePageResources } from '../../src/model/decode';
import { buildDocumentResourceIndex, resourceSetToIndex, ResourceStore } from '../../src/resource/store';
import { applyPageArea, resolvePageArea } from '../../src/model/page-area';
import type { ColorSpaceDef, ResourceDefinitionSet, ResourceId } from '../../src/model/types';

/** 读取仓库根下的真实样例。 */
function samplePath(name: string): string {
  return fileURLToPath(new URL(`../../../../ofd_pdf_match/${name}`, import.meta.url));
}

/** 解析样例并返回 ZIP 读取器。 */
async function openSample(name: string): Promise<ZipReader> {
  const data = readFileSync(samplePath(name));
  return ZipReader.open(new ArrayBufferSource(data));
}

/** 依次读取并解析 XML。 */
async function readXml(zip: ZipReader, path: string) {
  const bytes = await zip.readEntry(path);
  return parseXml(bytes);
}

describe('真实 OFD 样例解码（T3 + T2 集成）', () => {
  it('hello.ofd：OFD/Document/页树/资源/Content 全链路可解码', async () => {
    const zip = await openSample('hello.ofd');
    const warnings: string[] = [];
    const options = { onWarning: (warning: { code: string }) => warnings.push(warning.code) };
    const ofdRoot = parseXml(await zip.readEntry('OFD.xml'));
    const info = decodeOfdRoot(ofdRoot);
    expect(info.docRoots).toEqual(['Doc_0/Document.xml']);
    const docPath = info.docRoots[0]!.endsWith('.xml') ? info.docRoots[0]! : `${info.docRoots[0]}/Document.xml`;
    const document = decodeDocument(
      parseXml(await zip.readEntry(docPath)),
      docPath,
      options,
    );
    expect(document.pageCount).toBe(2);
    expect(document.pages[0]?.loc).toBe('Doc_0/Pages/Page_0/Content.xml');

    const colorSpaces = new Map<ResourceId, ColorSpaceDef>();
    const sets: ResourceDefinitionSet[] = [];
    for (const resPath of [
      ...(document.commonData?.publicRes ?? []),
      ...(document.commonData?.documentRes ?? []),
    ]) {
      const set = decodePageResources(await readXml(zip, resPath), resPath, {
        ...options,
        colorSpaces,
        ...(document.commonData?.defaultColorSpaceId
          ? { defaultColorSpaceId: document.commonData.defaultColorSpaceId }
          : {}),
      });
      for (const space of set.colorSpaces) colorSpaces.set(space.id, space);
      sets.push(set);
    }
    const index = buildDocumentResourceIndex({
      publicRes: document.commonData?.publicRes ?? [],
      documentRes: document.commonData?.documentRes ?? [],
      sets,
      ...(document.commonData?.defaultColorSpaceId
        ? { defaultColorSpace: document.commonData.defaultColorSpaceId }
        : {}),
    });
    const store = new ResourceStore(index);
    const page = decodePageContent(
      await readXml(zip, document.pages[0]!.loc),
      '1',
      document.pages[0]!.loc,
      { ...options, colorSpaces },
    );
    expect(page.layers.length).toBeGreaterThan(0);
    const resolved = applyPageArea(
      page,
      resolvePageArea({
        pageArea: page.area,
        ...(document.commonData?.pageArea ? { commonDataArea: document.commonData.pageArea } : {}),
      }),
    );
    expect(resolved.size).toEqual({ width: 210, height: 297 });

    // 页面资源单独建作用域。
    const pageSets: ResourceDefinitionSet[] = [];
    for (const resPath of page.pageRes) {
      pageSets.push(decodePageResources(await readXml(zip, resPath), resPath, { ...options, colorSpaces }));
    }
    const scope = store.createPageScope({
      page,
      document: index,
      pageResources: pageSets.map((set) => resourceSetToIndex(set)),
    });
    expect(scope.pageId).toBe('1');
    expect(scope.templateIds).toEqual([]);
    expect(warnings.every((code) => typeof code === 'string')).toBe(true);
  });

  it('发票样例：注释索引/外观与图片资源可解码', async () => {
    const zip = await openSample('发票监制章-数科.ofd');
    const document = decodeDocument(
      parseXml(await zip.readEntry('Doc_0/Document.xml')),
      'Doc_0/Document.xml',
    );
    expect(document.annotationsFile).toBe('Doc_0/Annotations.xml');
    const index = decodeAnnotationsIndex(
      await readXml(zip, document.annotationsFile!),
      'Doc_0',
    );
    expect(Object.keys(index.pageAnnotIndex).length).toBe(1);
    const annotationFile = index.pageAnnotIndex['1'];
    expect(annotationFile).toBe('Doc_0/Pages/Page_0/Annotation.xml');
    const annotations = decodeAnnotations(
      await readXml(zip, annotationFile!),
      ['1'],
    );
    expect(annotations.length).toBeGreaterThan(0);
    expect(annotations[0]?.appearance).toBeDefined();

    const page = decodePageContent(
      await readXml(zip, 'Doc_0/Pages/Page_0/Content.xml'),
      '0',
      'Doc_0/Pages/Page_0/Content.xml',
    );
    expect(page.layers.length).toBeGreaterThan(0);
  });
});