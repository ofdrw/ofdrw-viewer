import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArrayBufferSource } from '../../src/container/byte-source';
import { ZipReader } from '../../src/container/zip-reader';
import { parseXml } from '../../src/xml/parser';
import {
  decodeAnnotations,
  decodeAnnotationsIndex,
  decodeDocument,
  decodeOfdRoot,
  decodePageContent,
  decodePageResources,
} from '../../src/model/decode';
import { applyPageArea, resolvePageArea } from '../../src/model/page-area';
import type { PageModel, ResourceDefinitionSet, ResourceId } from '../../src/model/types';

import { assertSampleManifest, loadSampleManifest, SAMPLE_DIR } from '../helpers/samples';

/** 样例文件列表：按实际可识别样本动态获取（无法识别的文件由 helpers 统计）。 */
const samples = assertSampleManifest(loadSampleManifest());

/** 读取样例。 */
async function openSample(name: string): Promise<ZipReader> {
  return ZipReader.open(new ArrayBufferSource(readFileSync(join(SAMPLE_DIR, name))));
}

/** 读取并解析 XML。 */
async function readXml(zip: ZipReader, path: string) {
  return parseXml(await zip.readEntry(path));
}

describe('真实 OFD 样例解码健壮性', () => {
  it('中小样例可解码 Document/页树/每页 Content/资源/注释，不抛异常', async () => {
    expect(samples.length).toBeGreaterThanOrEqual(50);
    const failures: string[] = [];
    let decoded = 0;
    for (const name of samples) {
      // 超大页面（>300 KB）会把 saxes 解析拖到分钟级，留给 T9/QA 的渲染回归。
      if (statSync(join(SAMPLE_DIR, name)).size > 300_000) continue;
      try {
        const zip = await openSample(name);
        const info = decodeOfdRoot(parseXml(await zip.readEntry('OFD.xml')));
        const docPath = info.docRoots[0]!.endsWith('.xml')
          ? info.docRoots[0]!
          : `${info.docRoots[0]}/Document.xml`;
        const document = decodeDocument(parseXml(await zip.readEntry(docPath)), docPath);
        expect(document.pageCount, name).toBeGreaterThan(0);

        const colorSpaces = new Map<ResourceId, import('../../src/model/types').ColorSpaceDef>();
        const documentSets: ResourceDefinitionSet[] = [];
        for (const resPath of [...(document.commonData?.publicRes ?? []), ...(document.commonData?.documentRes ?? [])]) {
          const set = decodePageResources(await readXml(zip, resPath), resPath, {
            colorSpaces,
            ...(document.commonData?.defaultColorSpaceId
              ? { defaultColorSpaceId: document.commonData.defaultColorSpaceId }
              : {}),
          });
          for (const space of set.colorSpaces) colorSpaces.set(space.id, space);
          documentSets.push(set);
        }

        const templateCache = new Map<string, PageModel>();
        for (const pageRef of document.pages) {
          const page = decodePageContent(
            await readXml(zip, pageRef.loc),
            pageRef.id,
            pageRef.loc,
            { colorSpaces },
          );
          const pageSets: ResourceDefinitionSet[] = [];
          for (const resPath of page.pageRes) {
            pageSets.push(decodePageResources(await readXml(zip, resPath), resPath, { colorSpaces }));
          }
          const templateAreas: { id: ResourceId; area: PageModel['area'] }[] = [];
          for (const ref of page.templates) {
            let template = templateCache.get(ref.id);
            if (!template) {
              const def = document.templatePages[ref.id];
              if (!def) continue;
              template = decodePageContent(
                await readXml(zip, def.baseLoc),
                ref.id,
                def.baseLoc,
                { colorSpaces },
              );
              templateCache.set(ref.id, template);
            }
            if (template.area.w > 0 && template.area.h > 0) {
              templateAreas.push({ id: ref.id, area: template.area });
            }
          }
          const resolved = applyPageArea(
            page,
            resolvePageArea({
              pageArea: page.area,
              templateAreas,
              ...(document.commonData?.pageArea ? { commonDataArea: document.commonData.pageArea } : {}),
            }),
          );
          expect(resolved.size.width, `${name}:${pageRef.id}`).toBeGreaterThan(0);
          expect(resolved.size.height, `${name}:${pageRef.id}`).toBeGreaterThan(0);
          expect(pageSets.length).toBe(page.pageRes.length);
        }

        if (document.annotationsFile) {
          const annotationIndex = decodeAnnotationsIndex(
            await readXml(zip, document.annotationsFile),
            document.annotationsFile.slice(0, document.annotationsFile.lastIndexOf('/')),
          );
          for (const [pageId, file] of Object.entries(annotationIndex.pageAnnotIndex)) {
            decodeAnnotations(await readXml(zip, file), [pageId]);
          }
        }
        decoded += 1;
        expect(documentSets.length).toBe(
          (document.commonData?.publicRes?.length ?? 0) + (document.commonData?.documentRes?.length ?? 0),
        );
      } catch (error) {
        const message = (error as Error).message;
        // 声明了但 ZIP 中不存在的资源/注释/模板由 API 层降级为 warning；此处只验证解码器本身。
        if (!message.includes('ZIP 条目不存在')) failures.push(`${name}: ${message}`);
      }
    }
    expect(decoded).toBeGreaterThanOrEqual(40);
    expect(failures).toEqual([]);
  }, 60_000);
});