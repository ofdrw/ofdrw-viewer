/**
 * V-ENG 独立验收 1：默认 source 行为回归。
 *
 * 不依赖实现者自测结论：
 * - 页数/页尺寸/包大小/凭证字段由独立 ZIP 解析器 + 原始 XML 计算；
 * - 页面渲染结果用像素摘要比较重复渲染与不同打开入口；
 * - 签名条目与 SignedValue 与原始 ZIP 条目逐字节比对；
 * - 既有行为（改造前）由未修改的 `test/api` 回归用例另行执行。
 */

import { describe, expect, it } from 'vitest';
import { OFDDocument, openZipVirtualContainer } from '@ofdrw/ofdrw-viewer-engine';
import type { OFDOpenOptions } from '@ofdrw/ofdrw-viewer-engine';
import { nodeImageDecoders } from '../helpers/node-image-decoder';
import { createTestRenderer, renderPage } from '../api/helpers';
import {
  RecordingContainer,
  buildVerificationPackage,
  canvasStats,
  hasSample,
  matchXml,
  rawEntryMap,
  readSample,
} from './support';

/** 每次打开使用独立渲染器：`doc.close()` 会关闭注入的渲染器。 */
function nodeOptions(): Omit<
  Partial<OFDOpenOptions>,
  'source' | 'container' | 'containerFactory'
> {
  return {
    renderer: createTestRenderer(),
    imageDecoders: [...nodeImageDecoders],
  };
}

/** UTF-8 解码。 */
function text(bytes: Uint8Array | undefined): string {
  return bytes ? new TextDecoder().decode(bytes) : '';
}

/** 默认 source 打开。 */
async function openDefault(bytes: Uint8Array): Promise<OFDDocument> {
  // 展开 Partial 会把 source 拓宽为可选；基础 source 始终存在，按 OFDOpenOptions 收窄。
  return OFDDocument.open({
    source: { kind: 'arraybuffer', data: bytes },
    ...nodeOptions(),
  } as OFDOpenOptions);
}

/** 显式注入默认 ZIP 容器打开（借用容器）。 */
async function openWithContainer(bytes: Uint8Array): Promise<{
  doc: OFDDocument;
  container: Awaited<ReturnType<typeof openZipVirtualContainer>>;
}> {
  const container = await openZipVirtualContainer({ kind: 'arraybuffer', data: bytes });
  const doc = await OFDDocument.open({ container, ...nodeOptions() });
  return { doc, container };
}

/** 工厂入口打开（engine 拥有容器）。 */
async function openWithFactory(bytes: Uint8Array): Promise<OFDDocument> {
  return OFDDocument.open({
    source: { kind: 'arraybuffer', data: bytes },
    containerFactory: (source) => openZipVirtualContainer(source),
    ...nodeOptions(),
  });
}

/**
 * 文档快照：元数据、页尺寸、附件、签名条目与逐页渲染摘要。
 *
 * @param doc 已打开文档。
 * @returns 可 JSON 序列化快照。
 */
async function snapshot(doc: OFDDocument): Promise<unknown> {
  const metadata = await doc.getMetadata();
  const pageInfos = await doc.getPageInfos();
  const attachments = await doc.getAttachments();
  const signatures = await doc.getSignatureEntries();
  const signedValues: Array<{ id: string; byteLength: number; data: number[] }> = [];
  for (const signature of signatures) {
    const value = await doc.getSignedValue(signature.id);
    if (value) {
      signedValues.push({
        id: value.signatureId,
        byteLength: value.byteLength,
        data: [...value.data],
      });
    }
  }
  const renders: Array<{ index: number; stats: ReturnType<typeof canvasStats> }> = [];
  for (let index = 0; index < doc.pageCount; index += 1) {
    const page = await doc.getPage(index);
    renders.push({ index, stats: canvasStats((await renderPage(page, { dpi: 72 })).canvas) });
  }
  return { metadata, pageInfos, attachments, signatures, signedValues, renders };
}

describe('V-ENG 默认行为回归', () => {
  it.skipIf(!hasSample('hello.ofd'))(
    'hello.ofd：页数/元数据/页尺寸与独立 ZIP 解析一致且重复渲染稳定',
    async () => {
      const bytes = readSample('hello.ofd');
      const raw = rawEntryMap(bytes);
      const ofdXml = text(raw.get('OFD.xml'));
      const documentXml = text(raw.get('Doc_0/Document.xml'));
      const expectedPageCount = [...documentXml.matchAll(/<ofd:Page\s[^>]*\/>/g)].length;
      const expectedVersion = matchXml(ofdXml, /Version="([^"]+)"/);
      const expectedDocId = matchXml(ofdXml, /<ofd:DocID>([^<]+)<\/ofd:DocID>/);
      expect(expectedPageCount).toBeGreaterThan(0);
      expect(expectedVersion).toBeTruthy();
      expect(expectedDocId).toBeTruthy();

      const doc = await openDefault(bytes);
      try {
        const metadata = await doc.getMetadata();
        expect(metadata.pageCount).toBe(expectedPageCount);
        expect(metadata.packageSize).toBe(bytes.byteLength);
        expect(metadata.version).toBe(expectedVersion);
        expect(metadata.docId).toBe(expectedDocId);

        // 页尺寸独立来自页 Content.xml；无页级 Area 时回退 Document/PageArea。
        const commonArea = /<ofd:PageArea>\s*<ofd:PhysicalBox>\s*0 0 ([\d.]+) ([\d.]+)\s*<\/ofd:PhysicalBox>/.exec(
          documentXml,
        );
        expect(commonArea).toBeTruthy();
        const pageInfos = await doc.getPageInfos();
        expect(pageInfos).toHaveLength(expectedPageCount);
        for (const info of pageInfos) {
          const content = text(raw.get(`Doc_0/Pages/Page_${info.index}/Content.xml`));
          const pageBox = /<ofd:PhysicalBox>\s*0 0 ([\d.]+) ([\d.]+)\s*<\/ofd:PhysicalBox>/.exec(
            content,
          );
          const box = pageBox ?? commonArea;
          expect(box).toBeTruthy();
          expect(info.widthMm).toBeCloseTo(Number(box?.[1]), 6);
          expect(info.heightMm).toBeCloseTo(Number(box?.[2]), 6);
        }

        // 同一页连续渲染结果逐像素一致（默认路径未引入容器相关抖动）。
        const first = canvasStats((await renderPage(await doc.getPage(0), { dpi: 72 })).canvas);
        const second = canvasStats((await renderPage(await doc.getPage(0), { dpi: 72 })).canvas);
        expect(first.width).toBe(second.width);
        expect(first.height).toBe(second.height);
        expect(first.digest).toBe(second.digest);
      } finally {
        await doc.close();
      }
    },
  );

  it.skipIf(!hasSample('SESV4SignDoc.ofd'))(
    'SESV4SignDoc.ofd：签名条目/SignedValue 与原始 ZIP 逐字节一致，Seal 经容器读取并参与渲染',
    async () => {
      const bytes = readSample('SESV4SignDoc.ofd');
      const raw = rawEntryMap(bytes);
      const signaturesXml = text(raw.get('Doc_0/Signs/Signatures.xml'));
      const signatureXml = text(raw.get('Doc_0/Signs/Sign_0/Signature.xml'));
      const expectedId = matchXml(signaturesXml, /<ofd:Signature\s+ID="([^"]+)"/);
      const expectedBaseLoc = matchXml(signaturesXml, /BaseLoc="([^"]+)"/);
      const expectedValuePath = matchXml(signatureXml, /<ofd:SignedValue>([^<]+)<\/ofd:SignedValue>/);
      const rawSignedValue = raw.get('Doc_0/Signs/Sign_0/SignedValue.dat');
      expect(expectedId).toBeTruthy();
      expect(expectedBaseLoc).toBeTruthy();
      expect(expectedValuePath).toBeTruthy();
      expect(rawSignedValue).toBeDefined();

      const inner = await openZipVirtualContainer({ kind: 'arraybuffer', data: bytes });
      const container = new RecordingContainer(inner);
      const doc = await OFDDocument.open({ container, ...nodeOptions() });
      try {
        const entries = await doc.getSignatureEntries();
        expect(entries).toHaveLength(1);
        const entry = entries[0]!;
        expect(entry.id).toBe(expectedId);
        expect(entry.type).toBe('Seal');
        expect(entry.baseLoc).toBe(String(expectedBaseLoc).replace(/^\//, ''));
        expect(entry.signedValuePath).toBe(String(expectedValuePath).replace(/^\//, ''));
        expect(entry.hasSignedValue).toBe(true);
        expect(entry.provider).toMatchObject({ name: 'ofdrw-sign', company: 'ofdrw' });
        expect(entry.stamps[0]).toMatchObject({
          pageId: '1',
          pageIndex: 0,
          boundary: { x: 50, y: 50, w: 40, h: 40 },
        });

        const value = await doc.getSignedValue(String(expectedId));
        expect(value?.byteLength).toBe(rawSignedValue?.byteLength);
        expect(value ? [...value.data] : []).toEqual([...rawSignedValue!]);

        const stats = canvasStats((await renderPage(await doc.getPage(0), { dpi: 72 })).canvas);
        expect(stats.ink).toBeGreaterThan(1000);
        // 显式容器打开时审计读取路径，确认 Seal.esl/SignedValue 没有绕过容器。
        expect(container.readPaths).toEqual(
          expect.arrayContaining([
            'Doc_0/Signs/Signatures.xml',
            'Doc_0/Signs/Sign_0/Signature.xml',
            'Doc_0/Signs/Sign_0/Seal.esl',
            'Doc_0/Signs/Sign_0/SignedValue.dat',
          ]),
        );
      } finally {
        await doc.close();
        await container.close();
      }
    },
  );

  it.skipIf(!hasSample('SESV4SignDoc.ofd'))(
    '三种打开入口（source / 借用容器 / 工厂）的快照完全一致',
    async () => {
      for (const name of ['hello.ofd', '文字横向-数科.ofd', 'SESV4SignDoc.ofd']) {
        if (!hasSample(name)) continue;
        const bytes = readSample(name);

        const defaultDoc = await openDefault(bytes);
        let defaultSnapshot: unknown;
        try {
          defaultSnapshot = await snapshot(defaultDoc);
        } finally {
          await defaultDoc.close();
        }

        const borrowed = await openWithContainer(bytes);
        let containerSnapshot: unknown;
        try {
          containerSnapshot = await snapshot(borrowed.doc);
        } finally {
          await borrowed.doc.close();
          await borrowed.container.close();
        }

        const factoryDoc = await openWithFactory(bytes);
        let factorySnapshot: unknown;
        try {
          factorySnapshot = await snapshot(factoryDoc);
        } finally {
          await factoryDoc.close();
        }

        expect(containerSnapshot, name).toEqual(defaultSnapshot);
        expect(factorySnapshot, name).toEqual(defaultSnapshot);
      }
    },
  );

  it('综合夹具：默认 source 的页数/图片/附件/签章全部可读，渲染有墨迹', async () => {
    const bytes = buildVerificationPackage();
    const doc = await openDefault(bytes);
    try {
      const metadata = await doc.getMetadata();
      expect(metadata.pageCount).toBe(2);
      expect(metadata.packageSize).toBe(bytes.byteLength);

      const attachments = await doc.getAttachments();
      expect(attachments.map((item) => item.id)).toEqual(['1']);
      expect(await doc.getAttachmentData('1')).toEqual(Uint8Array.from([9, 8, 7, 6, 5]));

      const signatures = await doc.getSignatureEntries();
      expect(signatures.map((item) => item.id)).toEqual(['1']);
      const value = await doc.getSignedValue('1');
      expect(value ? [...value.data] : []).toEqual([0x30, 0x03, 0x02, 0x01, 0x01]);

      const pageInfo = await doc.getPageInfos();
      expect(pageInfo.map((info) => [info.widthMm, info.heightMm])).toEqual([
        [120, 90],
        [100, 100],
      ]);

      const stats = canvasStats((await renderPage(await doc.getPage(0), { dpi: 72 })).canvas);
      expect(stats.ink).toBeGreaterThan(0);
    } finally {
      await doc.close();
    }
  });
});