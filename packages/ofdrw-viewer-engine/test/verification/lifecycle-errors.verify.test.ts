/**
 * V-ENG 独立验收 3：生命周期、资源限制与错误语义。
 *
 * 关注 source / container 所有权、打开失败与重复关闭、documentIndex、packageSize，
 * 以及限流、缺失条目、容器异常与 warning 传递的公共错误码。
 */

import { describe, expect, it } from 'vitest';
import { OFDError, OFDDocument, openZipVirtualContainer } from '@ofdrw/ofdrw-viewer-engine';
import type { OFDOpenOptions, OFDWarning } from '@ofdrw/ofdrw-viewer-engine';
import { createTestRenderer, renderPage } from '../api/helpers';
import { nodeImageDecoders } from '../helpers/node-image-decoder';
import { buildZip } from '../container/zip-fixture';
import {
  ClosableSource,
  MemoryContainer,
  buildMultiDocumentPackage,
  buildVerificationPackage,
  canvasStats,
  codeOf,
  rawEntryMap,
  readSample,
  rejectOf,
  withCorruptCrc,
  withEncryptionMarker,
} from './support';

/** 每次打开使用独立渲染器。 */
function nodeOptions(): Omit<
  Partial<OFDOpenOptions>,
  'source' | 'container' | 'containerFactory'
> {
  return {
    renderer: createTestRenderer(),
    imageDecoders: [...nodeImageDecoders],
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

describe('V-ENG 生命周期与所有权', () => {
  it('默认 source：成功关闭幂等，source 只释放一次，关闭后 API 抛 OFD_CLOSED', async () => {
    const bytes = buildVerificationPackage();
    const source = new ClosableSource(bytes);
    const doc = await OFDDocument.open({
      source: { kind: 'custom', source },
      ...nodeOptions(),
    });
    expect(source.readCalls).toBeGreaterThan(0);
    expect((await doc.getMetadata()).pageCount).toBe(2);

    await doc.close();
    await doc.close();
    expect(source.closeCalls).toBe(1);
    expect(codeOf(await rejectOf(doc.getMetadata()))).toBe('OFD_CLOSED');
    expect(codeOf(await rejectOf(doc.getPage(0)))).toBe('OFD_CLOSED');
    expect(codeOf(await rejectOf(doc.getAttachments()))).toBe('OFD_CLOSED');
    expect(codeOf(await rejectOf(doc.getSignatureEntries()))).toBe('OFD_CLOSED');
    await expect(doc.close()).resolves.toBeUndefined();
  });

  it('默认 source：加密/缺 OFD.xml/超限等打开失败均释放 source 且只释放一次', async () => {
    const encrypted = new ClosableSource(withEncryptionMarker(buildVerificationPackage()));
    const encryptedError = await rejectOf(
      OFDDocument.open({ source: { kind: 'custom', source: encrypted }, ...nodeOptions() }),
    );
    expect(codeOf(encryptedError)).toBe('OFD_ENCRYPTED');
    expect(encrypted.closeCalls).toBe(1);

    const noOfdXmlBytes = buildZip([
      { name: 'Document.xml', data: '<ofd:Document xmlns:ofd="http://www.ofdspec.org/2016"/>' },
    ]);
    const missingSource = new ClosableSource(noOfdXmlBytes);
    const missingError = await rejectOf(
      OFDDocument.open({ source: { kind: 'custom', source: missingSource }, ...nodeOptions() }),
    );
    expect(codeOf(missingError)).toBe('OFD_INVALID_PACKAGE');
    expect(missingSource.closeCalls).toBe(1);

    const bytes = buildVerificationPackage();
    const packageSource = new ClosableSource(bytes);
    const packageError = await rejectOf(
      OFDDocument.open({
        source: { kind: 'custom', source: packageSource },
        limits: { maxPackageBytes: bytes.byteLength - 1 },
        ...nodeOptions(),
      }),
    );
    expect(codeOf(packageError)).toBe('OFD_LIMIT_EXCEEDED');
    expect(packageSource.closeCalls).toBe(1);

    const xmlSource = new ClosableSource(bytes);
    const xmlError = await rejectOf(
      OFDDocument.open({
        source: { kind: 'custom', source: xmlSource },
        limits: { maxXmlBytes: 8 },
        ...nodeOptions(),
      }),
    );
    expect(codeOf(xmlError)).toBe('OFD_LIMIT_EXCEEDED');
    expect(xmlSource.closeCalls).toBe(1);
  });

  it('借用容器：成功/失败/加密/已关闭均不由 engine 关闭', async () => {
    const bytes = buildVerificationPackage();
    const files = rawEntryMap(bytes);

    const success = new MemoryContainer(files, { packageSize: bytes.byteLength });
    const doc = await OFDDocument.open({ container: success, ...nodeOptions() });
    await doc.close();
    await doc.close();
    expect(success.closeCalls).toBe(0);
    await success.close();

    const invalid = new MemoryContainer([['Document.xml', new TextEncoder().encode('<x/>')]]);
    const invalidError = await rejectOf(OFDDocument.open({ container: invalid }));
    expect(codeOf(invalidError)).toBe('OFD_INVALID_PACKAGE');
    expect(invalid.closeCalls).toBe(0);

    const encrypted = new MemoryContainer(files, { encrypted: true });
    const encryptedError = await rejectOf(OFDDocument.open({ container: encrypted }));
    expect(codeOf(encryptedError)).toBe('OFD_ENCRYPTED');
    expect(encrypted.closeCalls).toBe(0);

    const closed = new MemoryContainer(files);
    await closed.close();
    const closedError = await rejectOf(OFDDocument.open({ container: closed }));
    expect(codeOf(closedError)).toBe('OFD_CLOSED');
    expect(closed.closeCalls).toBe(1);
  });

  it('工厂容器：打开失败由 engine 关闭；关闭抛错不阻塞 doc.close 且不重复调用', async () => {
    const owned = new MemoryContainer([['Document.xml', new TextEncoder().encode('<x/>')]]);
    const invalidError = await rejectOf(
      OFDDocument.open({
        source: { kind: 'arraybuffer', data: new Uint8Array([1, 2, 3]) },
        containerFactory: async () => owned,
        ...nodeOptions(),
      }),
    );
    expect(codeOf(invalidError)).toBe('OFD_INVALID_PACKAGE');
    expect(owned.closeCalls).toBe(1);

    const files = rawEntryMap(buildVerificationPackage());
    const throwing = new MemoryContainer(files, {
      closeError: new Error('容器关闭失败（模拟）'),
    });
    const doc = await OFDDocument.open({
      source: { kind: 'arraybuffer', data: new Uint8Array([1, 2, 3]) },
      containerFactory: async () => throwing,
      ...nodeOptions(),
    });
    await doc.close();
    await doc.close();
    expect(throwing.closeCalls).toBe(1);
    expect(throwing.closed).toBe(true);
    expect(codeOf(await rejectOf(doc.getMetadata()))).toBe('OFD_CLOSED');

    const factoryError = await rejectOf(
      OFDDocument.open({
        source: { kind: 'arraybuffer', data: new Uint8Array([1, 2, 3]) },
        containerFactory: async () => {
          throw new Error('工厂失败（模拟）');
        },
        ...nodeOptions(),
      }),
    );
    expect(codeOf(factoryError)).toBe('OFD_INVALID_PACKAGE');

    // 互斥/缺少 source 的参数错误不触发容器构造。
    const conflictContainer = new MemoryContainer(files);
    const conflictError = await rejectOf(
      OFDDocument.open({
        source: { kind: 'arraybuffer', data: new Uint8Array([1, 2, 3]) },
        container: conflictContainer,
        containerFactory: async () => conflictContainer,
        ...nodeOptions(),
      }),
    );
    expect(codeOf(conflictError)).toBe('OFD_INVALID_PACKAGE');
    expect(conflictContainer.closeCalls).toBe(0);

    const noSource = await rejectOf(
      OFDDocument.open({
        containerFactory: async () => new MemoryContainer(files),
        ...nodeOptions(),
      } as unknown as OFDOpenOptions),
    );
    expect(codeOf(noSource)).toBe('OFD_INVALID_PACKAGE');

    const nothing = await rejectOf(OFDDocument.open({} as unknown as OFDOpenOptions));
    expect(codeOf(nothing)).toBe('OFD_INVALID_PACKAGE');

    const negativeIndex = await rejectOf(
      OFDDocument.open({ container: new MemoryContainer(files), documentIndex: -1 }),
    );
    expect(codeOf(negativeIndex)).toBe('OFD_INVALID_PACKAGE');
  });

  it('默认容器关闭时 source.close 抛错仍完成关闭，后续 API 报 OFD_CLOSED', async () => {
    const bytes = buildVerificationPackage();
    const source = new ClosableSource(bytes, new Error('source.close 失败（模拟）'));
    const doc = await OFDDocument.open({
      source: { kind: 'custom', source },
      ...nodeOptions(),
    });
    await doc.close();
    expect(source.closeCalls).toBe(1);
    expect(codeOf(await rejectOf(doc.getMetadata()))).toBe('OFD_CLOSED');
  });

  it('packageSize 取容器值；多文档包 documentIndex 经同一容器选择文档', async () => {
    const bytes = buildMultiDocumentPackage();
    const files = rawEntryMap(bytes);
    const container = new MemoryContainer(files, { packageSize: 4242 });
    const doc = await OFDDocument.open({ container, documentIndex: 1, ...nodeOptions() });
    try {
      const metadata = await doc.getMetadata();
      expect(metadata.title).toBe('第二份文档');
      expect(metadata.docId).toBe('doc-second');
      expect(metadata.packageSize).toBe(4242);
      expect(metadata.pageCount).toBe(1);
      const info = (await doc.getPageInfos())[0];
      expect([info?.widthMm, info?.heightMm]).toEqual([50, 60]);
      expect(container.readPaths).toContain('Doc_1/Document.xml');
      expect(container.readPaths).toContain('Doc_1/Pages/Page_0/Content.xml');
    } finally {
      await doc.close();
    }
    expect(container.closeCalls).toBe(0);

    const owned = new MemoryContainer(files);
    const indexError = await rejectOf(
      OFDDocument.open({
        source: { kind: 'arraybuffer', data: new Uint8Array([1]) },
        containerFactory: async () => owned,
        documentIndex: 2,
        ...nodeOptions(),
      }),
    );
    expect(codeOf(indexError)).toBe('OFD_INVALID_PACKAGE');
    expect(owned.closeCalls).toBe(1);

    const defaultDoc = await openDefault(bytes);
    try {
      expect((await defaultDoc.getMetadata()).title).toBe('第一份文档');
      expect((await defaultDoc.getMetadata()).packageSize).toBe(bytes.byteLength);
    } finally {
      await defaultDoc.close();
    }
  });
});

describe('V-ENG 限制、错误与 warning', () => {
  it('缺失必需条目/容器抛普通错误/容器抛 OFD 错误分别映射为合理错误码', async () => {
    const missing = new MemoryContainer([['Document.xml', new TextEncoder().encode('<x/>')]]);
    const missingError = await rejectOf(OFDDocument.open({ container: missing }));
    expect(codeOf(missingError)).toBe('OFD_INVALID_PACKAGE');
    expect(missing.closeCalls).toBe(0);

    const files = rawEntryMap(buildVerificationPackage());
    const boom = new MemoryContainer(files, {
      readErrors: new Map([['OFD.xml', new Error('容器内部异常（模拟）')]]),
    });
    const boomError = await rejectOf(OFDDocument.open({ container: boom }));
    expect(codeOf(boomError)).toBe('OFD_INVALID_PACKAGE');
    expect(boom.closeCalls).toBe(0);

    const limited = new MemoryContainer(files, {
      readErrors: new Map([['OFD.xml', new OFDError('OFD_LIMIT_EXCEEDED', '模拟读取超限')]]),
    });
    const limitedError = await rejectOf(OFDDocument.open({ container: limited }));
    expect(codeOf(limitedError)).toBe('OFD_LIMIT_EXCEEDED');
    expect(limited.closeCalls).toBe(0);
  });

  it('容器读取超限/已关闭/取消返回 OFD_LIMIT_EXCEEDED / OFD_CLOSED / OFD_ABORTED', async () => {
    const bytes = buildVerificationPackage();
    const container = await openZipVirtualContainer({ kind: 'arraybuffer', data: bytes });
    const limitError = await rejectOf(container.read('OFD.xml', { maxBytes: 4 }));
    expect(codeOf(limitError)).toBe('OFD_LIMIT_EXCEEDED');

    const controller = new AbortController();
    controller.abort();
    const abortError = await rejectOf(container.read('OFD.xml', { signal: controller.signal }));
    expect(codeOf(abortError)).toBe('OFD_ABORTED');

    await container.close();
    await container.close();
    expect(codeOf(await rejectOf(container.read('OFD.xml')))).toBe('OFD_CLOSED');
    expect(() => container.list()).toThrowError(OFDError);
    expect(() => container.list()).toThrow(/已关闭/);
    expect(container.has('OFD.xml')).toBe(false);
    expect(container.stat('OFD.xml')).toBeUndefined();
  });

  it('openZipVirtualContainer 构造失败关闭已打开来源，超限返回 OFD_LIMIT_EXCEEDED', async () => {
    const bytes = buildVerificationPackage();
    const source = new ClosableSource(bytes);
    const error = await rejectOf(
      openZipVirtualContainer(
        { kind: 'custom', source },
        { limits: { maxPackageBytes: bytes.byteLength - 1 } },
      ),
    );
    expect(codeOf(error)).toBe('OFD_LIMIT_EXCEEDED');
    expect(source.closeCalls).toBe(1);

    const encrypted = await openZipVirtualContainer({
      kind: 'arraybuffer',
      data: withEncryptionMarker(bytes),
    });
    try {
      expect(encrypted.encrypted).toBe(true);
      expect(encrypted.packageSize).toBe(withEncryptionMarker(bytes).byteLength);
    } finally {
      await encrypted.close();
    }
  });

  it('warning 透传：容器 warning 进入打开回调，真实 ZIP CRC 错误不阻断打开', async () => {
    const bytes = buildVerificationPackage();
    const files = rawEntryMap(bytes);
    const container = new MemoryContainer(files, {
      readWarnings: new Map([
        ['OFD.xml', { code: 'W_BAD_NUMBER', message: '模拟容器 warning' }],
      ]),
    });
    const injectedWarnings: OFDWarning[] = [];
    const doc = await OFDDocument.open({
      container,
      onWarning: (warning) => injectedWarnings.push(warning),
      ...nodeOptions(),
    });
    try {
      expect(injectedWarnings.some((warning) => /模拟容器 warning/.test(warning.message))).toBe(
        true,
      );
    } finally {
      await doc.close();
    }

    const corrupted = withCorruptCrc(bytes, 'OFD.xml');
    const crcWarnings: OFDWarning[] = [];
    const crcDoc = await openDefault(corrupted, {
      onWarning: (warning) => crcWarnings.push(warning),
    });
    try {
      expect(crcDoc.pageCount).toBe(2);
      expect(crcWarnings.map((warning) => warning.code)).toContain('W_BAD_NUMBER');
      expect(crcWarnings.some((warning) => /CRC32/.test(warning.message))).toBe(true);
    } finally {
      await crcDoc.close();
    }
  });

  it('附件/SignedValue 读取失败仅 warning 并返回 undefined；超限错误原样抛出', async () => {
    const bytes = buildVerificationPackage();
    const files = rawEntryMap(bytes);
    const warnings: OFDWarning[] = [];
    const container = new MemoryContainer(files, {
      readErrors: new Map([
        ['Doc_0/Res/note.bin', new OFDError('OFD_ENTRY_NOT_FOUND', '模拟附件缺失')],
        [
          'Doc_0/Signs/Sign_0/SignedValue.dat',
          new OFDError('OFD_ENTRY_NOT_FOUND', '模拟签名值缺失'),
        ],
      ]),
    });
    const doc = await OFDDocument.open({
      container,
      onWarning: (warning) => warnings.push(warning),
      ...nodeOptions(),
    });
    try {
      expect(await doc.getAttachments()).toHaveLength(1);
      expect(await doc.getAttachmentData('1')).toBeUndefined();
      expect(await doc.getSignedValue('1')).toBeUndefined();
      expect(warnings.some((warning) => warning.code === 'W_ATTACHMENT_RESOURCE')).toBe(true);
      expect(warnings.some((warning) => warning.code === 'W_SIGNATURE_RESOURCE')).toBe(true);
    } finally {
      await doc.close();
    }

    const limitContainer = new MemoryContainer(files, {
      readErrors: new Map([
        ['Doc_0/Res/note.bin', new OFDError('OFD_LIMIT_EXCEEDED', '模拟附件超限')],
      ]),
    });
    const limitDoc = await OFDDocument.open({ container: limitContainer, ...nodeOptions() });
    try {
      const error = await rejectOf(limitDoc.getAttachmentData('1'));
      expect(codeOf(error)).toBe('OFD_LIMIT_EXCEEDED');
    } finally {
      await limitDoc.close();
    }
  });

  it('默认路径渲染仍可完成（错误路径不污染后续实例）', async () => {
    // 真实样本回归：上一条用例的失败容器不应影响新建默认实例。
    const bytes = readSample('hello.ofd');
    const doc = await openDefault(bytes);
    try {
      const stats = canvasStats((await renderPage(await doc.getPage(0), { dpi: 72 })).canvas);
      expect(stats.width).toBeGreaterThan(0);
      expect(stats.height).toBeGreaterThan(0);
    } finally {
      await doc.close();
    }
  });
});