/**
 * T17f 公开签章 XML API：只读 XML、SignedValue 原始字节与错误边界。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ZipReader } from '../../src/container/zip-reader';
import { isOFDError } from '../../src/errors';
import type { ImageDecoderPlugin } from '../../src/platform/image-decoder';
import type { OFDWarning } from '../../src/warnings';
import { buildFixtureOfd, openTestDocument } from './helpers';

/** 取错误码。 */
function errorCode(error: unknown): string | undefined {
  return isOFDError(error) ? error.code : undefined;
}

/** 捕获 promise 拒绝。 */
async function rejectOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('promise 未按预期拒绝');
}

/** 测试用 SignedValue.dat 字节。 */
const SIGNED_VALUE = new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01]);

/** 签名 XML 头部。 */
const NS = 'xmlns:ofd="http://www.ofdspec.org/2016"';

/** 索引 XML。 */
function indexXml(entries: Array<{ id: string; type: string; path: string }>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Signatures ${NS}>${entries
    .map((entry) => `<ofd:Signature ID="${entry.id}" Type="${entry.type}" BaseLoc="${entry.path}"/>`)
    .join('')}</ofd:Signatures>`;
}

/** 基础 Signature.xml。 */
function signatureXml(options: {
  id?: string;
  signedValue?: string;
  stamps?: string;
  provider?: string;
} = {}): string {
  const stamps = options.stamps ?? '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Signature ${NS}>
  <ofd:SignedInfo>
    ${options.provider ?? ''}
    <ofd:SignatureDateTime>2026-01-02 03:04:05</ofd:SignatureDateTime>
    <ofd:References><ofd:Reference FileRef="/OFD.xml"/><ofd:Reference FileRef="/Doc_0/Document.xml"/></ofd:References>
    ${stamps}
  </ofd:SignedInfo>
  ${options.signedValue === undefined ? '' : `<ofd:SignedValue>${options.signedValue}</ofd:SignedValue>`}
</ofd:Signature>`;
}

/** 构造带 4 个签章的包；s3 声明但缺失 dat，s4 含无效戳记。 */
function buildSignaturePackage(): Uint8Array {
  const index = indexXml([
    { id: 's1', type: 'Seal', path: '/Doc_0/Signs/S1/Signature.xml' },
    { id: 's2', type: 'Sign', path: '/Doc_0/Signs/S2/Signature.xml' },
    { id: 's3', type: 'Seal', path: '/Doc_0/Signs/S3/Signature.xml' },
    { id: 's4', type: 'Seal', path: '/Doc_0/Signs/S4/Signature.xml' },
  ]);
  return buildFixtureOfd({
    pages: [
      { id: 1, objects: [] },
      { id: 2, objects: [] },
    ],
    extraEntries: [
      { name: 'Doc_0/Signs/Signatures.xml', data: index },
      {
        name: 'Doc_0/Signs/S1/Signature.xml',
        data: signatureXml({
          provider:
            '<ofd:Provider ProviderName="provider-a" Company="company-a" Version="1.0"/>',
          signedValue: '/Doc_0/Signs/../Signs/S1/SignedValue.dat',
          stamps:
            '<ofd:StampAnnot ID="a1" PageRef="1" Boundary="1 2 30 40" Clip="2 3 20 30"/><ofd:StampAnnot ID="a2" PageRef="2" Boundary="5 6 7 8"/>',
        }),
      },
      {
        name: 'Doc_0/Signs/S1/SignedValue.dat',
        data: SIGNED_VALUE,
      },
      {
        name: 'Doc_0/Signs/S2/Signature.xml',
        data: signatureXml({
          provider: '<ofd:Provider ProviderName="provider-b"/>',
          stamps: '<ofd:StampAnnot ID="b1" PageRef="1" Boundary="10 20 30 40"/>',
        }),
      },
      {
        name: 'Doc_0/Signs/S3/Signature.xml',
        data: signatureXml({ signedValue: '/Doc_0/Signs/S3/SignedValue.dat' }),
      },
      {
        name: 'Doc_0/Signs/S4/Signature.xml',
        data: signatureXml({
          stamps:
            '<ofd:StampAnnot ID="a4" PageRef="99" Boundary="1 2 3 4"/><ofd:StampAnnot ID="a5" PageRef="1" Boundary="bad"/><ofd:StampAnnot ID="a6" PageRef="1" Boundary="5 6 7 8"/>',
        }),
      },
    ],
  });
}

describe('getSignatureEntries / getSignedValue', () => {
  it('按 XML 顺序返回元数据，只读 XML，SignedValue 返回原始字节', async () => {
    const warnings: OFDWarning[] = [];
    const doc = await openTestDocument(buildSignaturePackage(), {
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      const readEntry = vi.spyOn(ZipReader.prototype, 'readEntry');
      const entries = await doc.getSignatureEntries();
      const readPaths = readEntry.mock.calls.map(([path]) => path);
      expect(entries.map((entry) => entry.id)).toEqual(['s1', 's2', 's3', 's4']);
      expect(readPaths.some((path) => /\.(dat|esl)$/i.test(path))).toBe(false);
      expect(readPaths).toEqual(
        expect.arrayContaining([
          'Doc_0/Signs/Signatures.xml',
          'Doc_0/Signs/S1/Signature.xml',
        ]),
      );

      const s1 = entries[0]!;
      expect(s1).toMatchObject({
        id: 's1',
        type: 'Seal',
        baseLoc: 'Doc_0/Signs/S1/Signature.xml',
        provider: { name: 'provider-a', company: 'company-a', version: '1.0' },
        signatureDateTime: '2026-01-02 03:04:05',
        references: [{ fileRef: '/OFD.xml' }, { fileRef: '/Doc_0/Document.xml' }],
        signedValuePath: 'Doc_0/Signs/S1/SignedValue.dat',
        hasSignedValue: true,
      });
      expect(s1.stamps).toEqual([
        expect.objectContaining({
          id: 'a1',
          pageId: '1',
          pageIndex: 0,
          boundary: { x: 1, y: 2, w: 30, h: 40 },
          clip: { x: 2, y: 3, w: 20, h: 30 },
        }),
        expect.objectContaining({ id: 'a2', pageId: '2', pageIndex: 1 }),
      ]);

      const s2 = entries[1]!;
      expect(s2.hasSignedValue).toBe(false);
      expect(s2.signedValuePath).toBeUndefined();
      expect(s2.stamps[0]).toMatchObject({ pageId: '1', pageIndex: 0 });

      const s4 = entries[3]!;
      expect(s4.stamps.map((stamp) => stamp.id)).toEqual(['a4', 'a6']);
      expect(s4.stamps[0]?.pageIndex).toBeUndefined();
      expect(s4.stamps[1]?.pageIndex).toBe(0);
      expect(
        warnings.some((warning) => warning.code === 'W_BAD_PATH' && /99/.test(warning.message)),
      ).toBe(true);
      expect(
        warnings.some(
          (warning) => warning.code === 'W_BAD_NUMBER' && /a5|Boundary/.test(warning.message),
        ),
      ).toBe(true);

      const second = await doc.getSignatureEntries();
      expect(second).toBe(entries);
      expect(readEntry.mock.calls.filter(([path]) => /Signature\.xml$/.test(path))).toHaveLength(4);
      readEntry.mockRestore();

      const valueRead = vi.spyOn(ZipReader.prototype, 'readEntry');
      const value = await doc.getSignedValue('s1');
      expect(valueRead.mock.calls.map(([path]) => path)).toEqual([
        'Doc_0/Signs/S1/SignedValue.dat',
      ]);
      valueRead.mockRestore();
      expect(value).toMatchObject({
        signatureId: 's1',
        path: 'Doc_0/Signs/S1/SignedValue.dat',
        byteLength: SIGNED_VALUE.byteLength,
      });
      expect(Array.from(value!.data)).toEqual(Array.from(SIGNED_VALUE));
      const beforeUndeclared = warnings.length;
      expect(await doc.getSignedValue('s2')).toBeUndefined();
      expect(warnings.length).toBe(beforeUndeclared);
      const beforeMissing = warnings.length;
      expect(await doc.getSignedValue('s3')).toBeUndefined();
      expect(
        warnings.slice(beforeMissing).some((warning) => warning.code === 'W_SIGNATURE_RESOURCE'),
      ).toBe(true);
      expect(await doc.getSignedValue('missing')).toBeUndefined();
    } finally {
      await doc.close();
    }
  });

  it('重复 ID 先到先得，坏 Signature.xml 跳过并 warning；索引损坏返回空', async () => {
    const warnings: OFDWarning[] = [];
    const index = indexXml([
      { id: 's1', type: 'Seal', path: '/Doc_0/Signs/Good/Signature.xml' },
      { id: 's1', type: 'Seal', path: '/Doc_0/Signs/Duplicate/Signature.xml' },
      { id: 'bad', type: 'Seal', path: '/Doc_0/Signs/Bad/Signature.xml' },
      { id: 's2', type: 'Sign', path: '/Doc_0/Signs/Second/Signature.xml' },
    ]);
    const bytes = buildFixtureOfd({
      pages: [{ id: 1, objects: [] }],
      extraEntries: [
        { name: 'Doc_0/Signs/Signatures.xml', data: index },
        {
          name: 'Doc_0/Signs/Good/Signature.xml',
          data: signatureXml({ provider: '<ofd:Provider ProviderName="good"/>' }),
        },
        {
          name: 'Doc_0/Signs/Duplicate/Signature.xml',
          data: signatureXml({ provider: '<ofd:Provider ProviderName="duplicate"/>' }),
        },
        { name: 'Doc_0/Signs/Bad/Signature.xml', data: '<ofd:Signature' },
        {
          name: 'Doc_0/Signs/Second/Signature.xml',
          data: signatureXml({ provider: '<ofd:Provider ProviderName="second"/>' }),
        },
      ],
    });
    const doc = await openTestDocument(bytes, {
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      const entries = await doc.getSignatureEntries();
      expect(entries.map((entry) => entry.id)).toEqual(['s1', 's2']);
      expect(entries[0]?.provider?.name).toBe('good');
      expect(warnings.some((warning) => warning.code === 'W_DUPLICATE_RESOURCE')).toBe(true);
      expect(warnings.some((warning) => /bad/.test(warning.message))).toBe(true);
    } finally {
      await doc.close();
    }

    const badIndex = buildFixtureOfd({
      pages: [{ id: 1, objects: [] }],
      extraEntries: [{ name: 'Doc_0/Signs/Signatures.xml', data: '<ofd:Signatures' }],
    });
    const badDoc = await openTestDocument(badIndex, {
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      expect(await badDoc.getSignatureEntries()).toEqual([]);
    } finally {
      await badDoc.close();
    }
    expect(warnings.some((warning) => /签章索引/.test(warning.message))).toBe(true);
  });

  it('只有 Seal.esl 时 hasSignedValue=false，不回退读取 Seal', async () => {
    const warnings: OFDWarning[] = [];
    const bytes = buildFixtureOfd({
      pages: [{ id: 1, objects: [] }],
      extraEntries: [
        {
          name: 'Doc_0/Signs/Signatures.xml',
          data: indexXml([{ id: 's1', type: 'Seal', path: '/Doc_0/Signs/S1/Signature.xml' }]),
        },
        {
          name: 'Doc_0/Signs/S1/Signature.xml',
          data: `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Signature ${NS}><ofd:SignedInfo><ofd:Seal><ofd:BaseLoc>/Doc_0/Signs/S1/Seal.esl</ofd:BaseLoc></ofd:Seal></ofd:SignedInfo></ofd:Signature>`,
        },
        { name: 'Doc_0/Signs/S1/Seal.esl', data: new Uint8Array([1, 2, 3]) },
      ],
    });
    const doc = await openTestDocument(bytes, {
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      const entries = await doc.getSignatureEntries();
      expect(entries[0]?.hasSignedValue).toBe(false);
      expect(entries[0]?.signedValuePath).toBeUndefined();
      const readEntry = vi.spyOn(ZipReader.prototype, 'readEntry');
      expect(await doc.getSignedValue('s1')).toBeUndefined();
      expect(readEntry).not.toHaveBeenCalled();
      expect(warnings.some((warning) => warning.code === 'W_SIGNATURE_RESOURCE')).toBe(false);
      readEntry.mockRestore();
    } finally {
      await doc.close();
    }
  });

  it('abort/close 拒绝；close 清理条目缓存', async () => {
    const doc = await openTestDocument(buildSignaturePackage());
    try {
      await doc.getSignatureEntries();
      const controller = new AbortController();
      controller.abort();
      expect(errorCode(await rejectOf(doc.getSignatureEntries({ signal: controller.signal })))).toBe(
        'OFD_ABORTED',
      );
      expect(
        errorCode(
          await rejectOf(doc.getSignedValue('s1', { signal: controller.signal })),
        ),
      ).toBe('OFD_ABORTED');
      await doc.close();
      expect(errorCode(await rejectOf(doc.getSignatureEntries()))).toBe('OFD_CLOSED');
      expect(errorCode(await rejectOf(doc.getSignedValue('s1')))).toBe('OFD_CLOSED');
    } finally {
      await doc.close();
    }
  });

  it('100 个签章只读 XML，缓存后不重复读取', async () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({
      id: `s${index + 1}`,
      type: 'Seal',
      path: `/Doc_0/Signs/S${index + 1}/Signature.xml`,
    }));
    const extraEntries = [
      { name: 'Doc_0/Signs/Signatures.xml', data: indexXml(entries) },
      ...entries.map((entry) => ({
        name: entry.path.replace(/^\//, ''),
        data: signatureXml({ provider: `<ofd:Provider ProviderName="p${entry.id}"/>` }),
      })),
    ];
    const bytes = buildFixtureOfd({
      pages: [{ id: 1, objects: [] }],
      extraEntries,
    });
    const doc = await openTestDocument(bytes);
    try {
      const readEntry = vi.spyOn(ZipReader.prototype, 'readEntry');
      const started = performance.now();
      const result = await doc.getSignatureEntries();
      const elapsed = performance.now() - started;
      expect(result).toHaveLength(100);
      const reads = readEntry.mock.calls.length;
      expect(elapsed).toBeLessThan(100);
      expect(readEntry.mock.calls.some(([path]) => /\.(dat|esl)$/i.test(path))).toBe(false);
      await doc.getSignatureEntries();
      expect(readEntry.mock.calls.length).toBe(reads);
      readEntry.mockRestore();
    } finally {
      await doc.close();
    }
  });

  it('真实 v1/v4/v5 样本：只读 XML，返回条目且不读 SignedValue/Seal', async () => {
    for (const name of ['n.ofd', 'v4signed.ofd', 'h.ofd']) {
      const path = fileURLToPath(new URL(`../../../../ofd_pdf_match/${name}`, import.meta.url));
      const doc = await openTestDocument(new Uint8Array(readFileSync(path)));
      const readEntry = vi.spyOn(ZipReader.prototype, 'readEntry');
      try {
        const entries = await doc.getSignatureEntries();
        expect(entries.length).toBeGreaterThan(0);
        expect(entries.every((entry) => entry.id && entry.type !== undefined)).toBe(true);
        expect(readEntry.mock.calls.some(([entryPath]) => /\.(dat|esl)$/i.test(entryPath))).toBe(
          false,
        );
      } finally {
        readEntry.mockRestore();
        await doc.close();
      }
    }
  });
});
