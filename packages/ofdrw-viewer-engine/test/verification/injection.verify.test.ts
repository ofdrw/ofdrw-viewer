/**
 * V-ENG 独立验收 2：VirtualContainer 注入能力。
 *
 * 覆盖内存容器、包装容器、工厂容器与“模拟解密容器”；
 * 通过容器读取日志确认渲染、字体、图片、附件、签章全部经容器，且只消费明文。
 */

import { describe, expect, it } from 'vitest';
import { OFDDocument, openZipVirtualContainer } from '@ofdrw/ofdrw-viewer-engine';
import type { OFDOpenOptions, OFDSource, VirtualContainer } from '@ofdrw/ofdrw-viewer-engine';
import { createTestRenderer, renderPage } from '../api/helpers';
import { nodeImageDecoders } from '../helpers/node-image-decoder';
import {
  ClosableSource,
  MemoryContainer,
  RecordingContainer,
  buildVerificationPackage,
  canvasStats,
  codeOf,
  hasSample,
  rawEntryMap,
  readSample,
  rejectOf,
  withEncryptionMarker,
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

/**
 * 文档可观测结果：元数据、页尺寸、附件、签章、SignedValue 与逐页像素摘要。
 *
 * @param doc 已打开文档。
 * @returns 可比较快照。
 */
async function observable(doc: OFDDocument): Promise<unknown> {
  const renders: unknown[] = [];
  for (let index = 0; index < doc.pageCount; index += 1) {
    renders.push(canvasStats((await renderPage(await doc.getPage(index), { dpi: 72 })).canvas));
  }
  const signatures = await doc.getSignatureEntries();
  const signedValues: unknown[] = [];
  for (const entry of signatures) {
    const value = await doc.getSignedValue(entry.id);
    signedValues.push(value ? { id: value.signatureId, data: [...value.data] } : null);
  }
  return {
    metadata: await doc.getMetadata(),
    pageInfos: await doc.getPageInfos(),
    attachments: await doc.getAttachments(),
    attachmentData: await doc.getAttachmentData('1'),
    signatures,
    signedValues,
    renders,
  };
}

/** 默认 source 打开。 */
async function openDefault(
  bytes: Uint8Array,
  options: Partial<OFDOpenOptions> = {},
): Promise<OFDDocument> {
  // 展开 Partial 会把 source 拓宽为可选；基础 source 始终存在，按 OFDOpenOptions 收窄。
  return OFDDocument.open({
    source: { kind: 'arraybuffer', data: bytes },
    ...nodeOptions(),
    ...options,
  } as OFDOpenOptions);
}

describe('V-ENG 容器注入', () => {
  it('内存明文容器替换全部读取：渲染/图片/附件/签章与默认路径一致', async () => {
    const bytes = buildVerificationPackage();
    const files = rawEntryMap(bytes);
    expect([...files.keys()]).toEqual(
      expect.arrayContaining([
        'OFD.xml',
        'Doc_0/Document.xml',
        'Doc_0/Pages/Page_1/Content.xml',
        'Doc_0/Res/Res.xml',
        'Doc_0/Res/image.png',
        'Doc_0/Attachments.xml',
        'Doc_0/Res/note.bin',
        'Doc_0/Signs/Signatures.xml',
        'Doc_0/Signs/Sign_0/Signature.xml',
        'Doc_0/Signs/Sign_0/SignedValue.dat',
      ]),
    );

    const warnings: string[] = [];
    const container = new MemoryContainer(files, { packageSize: bytes.byteLength });
    const doc = await OFDDocument.open({
      container,
      onWarning: (warning) => warnings.push(warning.code),
      ...nodeOptions(),
    });
    let injectedObservable: unknown;
    try {
      injectedObservable = await observable(doc);
      expect(container.readPaths).toEqual(
        expect.arrayContaining([
          'OFD.xml',
          'Doc_0/Document.xml',
          'Doc_0/Pages/Page_1/Content.xml',
          'Doc_0/Pages/Page_2/Content.xml',
          'Doc_0/Res/Res.xml',
          'Doc_0/Res/image.png',
          'Doc_0/Attachments.xml',
          'Doc_0/Res/note.bin',
          'Doc_0/Signs/Signatures.xml',
          'Doc_0/Signs/Sign_0/Signature.xml',
          'Doc_0/Signs/Sign_0/SignedValue.dat',
        ]),
      );
      expect(container.hasPaths).toEqual(expect.arrayContaining(['Doc_0/Signs/Signatures.xml']));
      expect(container.list().every((meta) => meta.origin === 'decrypted')).toBe(true);
      expect(warnings).not.toContain('W_IMAGE_DECODE');
    } finally {
      await doc.close();
    }
    // 借用容器：文档关闭不关闭容器，宿主仍可继续读取。
    expect(container.closeCalls).toBe(0);
    expect(container.closed).toBe(false);
    expect(container.has('OFD.xml')).toBe(true);

    // 与默认 source 路径的可观测结果完全一致。
    const defaultDoc = await openDefault(bytes);
    try {
      expect(await observable(defaultDoc)).toEqual(injectedObservable);
    } finally {
      await defaultDoc.close();
    }

    await container.close();
    expect(container.closeCalls).toBe(1);
    expect(container.closed).toBe(true);
    expect(container.has('OFD.xml')).toBe(false);
  });

  it('模拟解密容器：加密包默认拒绝，去加密标记后明文容器可渲染且保留原包大小', async () => {
    const plainBytes = buildVerificationPackage();
    const encryptedBytes = withEncryptionMarker(plainBytes);

    const rejected = await rejectOf(openDefault(encryptedBytes));
    expect(codeOf(rejected)).toBe('OFD_ENCRYPTED');

    const defaultZip = await openZipVirtualContainer({
      kind: 'arraybuffer',
      data: encryptedBytes,
    });
    try {
      expect(defaultZip.encrypted).toBe(true);
    } finally {
      await defaultZip.close();
    }

    const files = rawEntryMap(encryptedBytes);
    expect(files.delete('Encryptions.xml')).toBe(true);
    const container = new MemoryContainer(files, {
      encrypted: false,
      packageSize: encryptedBytes.byteLength,
    });
    const doc = await OFDDocument.open({ container, ...nodeOptions() });
    try {
      expect(container.readPaths).not.toContain('Encryptions.xml');
      expect(container.readPaths).toEqual(
        expect.arrayContaining(['OFD.xml', 'Doc_0/Document.xml']),
      );
      const metadata = await doc.getMetadata();
      expect(metadata.packageSize).toBe(encryptedBytes.byteLength);
      expect(metadata.pageCount).toBe(2);

      const stats = canvasStats((await renderPage(await doc.getPage(0), { dpi: 72 })).canvas);
      expect(stats.ink).toBeGreaterThan(0);
      expect(container.readPaths).toEqual(
        expect.arrayContaining(['Doc_0/Pages/Page_1/Content.xml', 'Doc_0/Res/Res.xml']),
      );
    } finally {
      await doc.close();
    }
    expect(container.closeCalls).toBe(0);
    await container.close();
  });

  it('containerFactory：收到原始 source、返回容器归 engine，关闭时只关闭一次并释放来源', async () => {
    const bytes = buildVerificationPackage();
    const sourceBytes = new ClosableSource(bytes);
    const source: OFDSource = { kind: 'custom', source: sourceBytes };
    const received: OFDSource[] = [];
    const containers: RecordingContainer[] = [];

    const doc = await OFDDocument.open({
      source,
      containerFactory: async (factorySource): Promise<VirtualContainer> => {
        received.push(factorySource);
        const container = new RecordingContainer(await openZipVirtualContainer(factorySource));
        containers.push(container);
        return container;
      },
      ...nodeOptions(),
    });
    try {
      expect(received).toHaveLength(1);
      expect(received[0]).toBe(source);
      expect((await doc.getMetadata()).packageSize).toBe(bytes.byteLength);
      const stats = canvasStats((await renderPage(await doc.getPage(0), { dpi: 72 })).canvas);
      expect(stats.ink).toBeGreaterThan(0);
    } finally {
      await doc.close();
      await doc.close();
    }

    expect(containers).toHaveLength(1);
    expect(containers[0]?.closeCalls).toBe(1);
    // 容器拥有 byte source：工厂路径下由容器 close 释放，engine 不重复关闭。
    expect(sourceBytes.closeCalls).toBe(1);
    expect(sourceBytes.readCalls).toBeGreaterThan(0);
    expect(codeOf(await rejectOf(doc.getMetadata()))).toBe('OFD_CLOSED');
  });

  it.skipIf(!hasSample('文字横向-数科.ofd'))(
    '包装容器审计：渲染读取 Content/PublicRes 与内嵌字体，结果与默认路径逐像素一致',
    async () => {
      const bytes = readSample('文字横向-数科.ofd');
      const defaultDoc = await openDefault(bytes);
      let defaultStats: ReturnType<typeof canvasStats>;
      try {
        defaultStats = canvasStats(
          (await renderPage(await defaultDoc.getPage(0), { dpi: 72 })).canvas,
        );
      } finally {
        await defaultDoc.close();
      }

      const container = new RecordingContainer(
        await openZipVirtualContainer({ kind: 'arraybuffer', data: bytes }),
      );
      const doc = await OFDDocument.open({ container, ...nodeOptions() });
      try {
        const stats = canvasStats((await renderPage(await doc.getPage(0), { dpi: 72 })).canvas);
        expect(stats).toEqual(defaultStats);

        expect(container.readPaths).toEqual(
          expect.arrayContaining([
            'OFD.xml',
            'Doc_0/Document.xml',
            'Doc_0/PublicRes.xml',
            'Doc_0/Pages/Page_0/Content.xml',
          ]),
        );
        // 内嵌字体必须经容器读取，而不是绕过容器直读 ZIP。
        expect(container.readPaths.some((path) => /\.(ttf|otf|ttc)$/i.test(path))).toBe(true);
      } finally {
        await doc.close();
      }
      expect(container.closeCalls).toBe(0);
      await container.close();
      expect(container.closeCalls).toBe(1);
    },
  );
});