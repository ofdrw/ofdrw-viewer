/**
 * 引擎打开时注入虚拟容器：默认 ZIP 回归、借用/工厂所有权、模拟解密容器、
 * 全部读取路径经容器与关闭语义。
 */

import { describe, expect, it } from 'vitest';
import { OFDDocument, OFDError, openZipVirtualContainer } from '@ofdrw/ofdrw-viewer-engine';
import type {
  OFDOpenOptions,
  VirtualContainer,
  VirtualReadOptions,
} from '@ofdrw/ofdrw-viewer-engine';
import type { ByteSource } from '../../src/platform/byte-source';
import type { OFDWarning } from '../../src/warnings';
import { ArrayBufferSource } from '../../src/container/byte-source';
import { ZipVirtualContainer } from '../../src/container/zip-container';
import { buildXmlDocument } from '../fixtures/xml';
import type { XmlElementSpec } from '../fixtures/xml';
import { nodeImageDecoders } from '../helpers/node-image-decoder';
import type { FixturePage } from './helpers';
import {
  OFD_NS,
  buildFixtureOfd,
  createPng,
  createTestCanvas,
  createTestRenderer,
  renderPage,
} from './helpers';

/** 读取错误码。 */
function codeOf(error: unknown): string | undefined {
  return error instanceof OFDError ? error.code : undefined;
}

/** 捕获拒绝并返回错误。 */
async function rejectOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('promise 未按预期拒绝');
}

/** 轮询等待条件成立（用于确认读取已进入挂起点）。 */
async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 包内路径规范化（与容器约定一致：去前导 `/`、折叠 `.`）。 */
function normalize(path: string): string {
  const segments: string[] = [];
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/** 合成明文容器：模拟 crypto 解密后的内存容器。 */
class MemoryContainer implements VirtualContainer {
  readonly packageSize: number;
  readonly encrypted: boolean;
  readonly files: Map<string, Uint8Array>;
  /** read 调用路径。 */
  readonly readPaths: string[] = [];
  /** close 调用次数。 */
  closeCalls = 0;
  closed = false;

  /**
   * @param files 包内路径 → 明文字节。
   * @param options 包大小与加密标记。
   */
  constructor(
    files: Iterable<readonly [string, Uint8Array]>,
    options: { packageSize?: number; encrypted?: boolean } = {},
  ) {
    this.files = new Map(
      [...files].map(([path, bytes]) => [normalize(path), bytes.slice()] as const),
    );
    const total = [...this.files.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
    this.packageSize = options.packageSize ?? total;
    this.encrypted = options.encrypted ?? false;
  }

  /** 列出文件，按路径升序。 */
  list(): readonly {
    readonly path: string;
    readonly size: number;
    readonly origin: 'decrypted';
  }[] {
    this.assertOpen();
    return [...this.files.entries()]
      .map(([path, bytes]) => ({ path, size: bytes.byteLength, origin: 'decrypted' as const }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  }

  /**
   * @param path 包内路径。
   * @returns 是否存在。
   */
  has(path: string): boolean {
    if (this.closed) return false;
    return this.files.has(normalize(path));
  }

  /**
   * @param path 包内路径。
   * @returns 文件元数据。
   */
  stat(path: string): { readonly path: string; readonly size: number } | undefined {
    if (this.closed) return undefined;
    const normalized = normalize(path);
    const bytes = this.files.get(normalized);
    return bytes ? { path: normalized, size: bytes.byteLength } : undefined;
  }

  /**
   * 读取明文条目。
   *
   * @param path 包内路径。
   * @param options 读取选项。
   * @returns 明文字节副本。
   */
  async read(path: string, options: VirtualReadOptions = {}): Promise<Uint8Array> {
    this.assertOpen();
    if (options.signal?.aborted) throw new OFDError('OFD_ABORTED', '读取已取消');
    const normalized = normalize(path);
    const bytes = this.files.get(normalized);
    if (!bytes) throw new OFDError('OFD_ENTRY_NOT_FOUND', `条目不存在：${path}`);
    if (options.maxBytes !== undefined && bytes.byteLength > options.maxBytes) {
      throw new OFDError('OFD_LIMIT_EXCEEDED', `条目 ${path} 超过读取上限 ${options.maxBytes}`);
    }
    this.readPaths.push(normalized);
    return bytes.slice();
  }

  /** 幂等关闭。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeCalls += 1;
  }

  /** 断言容器仍可用。 */
  private assertOpen(): void {
    if (this.closed) throw new OFDError('OFD_CLOSED', '容器已关闭');
  }
}

/** 记录读取路径并委托给默认 ZIP 容器。 */
class RecordingContainer implements VirtualContainer {
  /** read 调用路径。 */
  readonly readPaths: string[] = [];
  /** has 调用路径。 */
  readonly hasPaths: string[] = [];
  /** close 调用次数。 */
  closeCalls = 0;

  /**
   * @param inner 被包装的默认 ZIP 容器。
   */
  constructor(private readonly inner: VirtualContainer) {}

  /** 原始包字节数，单位 byte。 */
  get packageSize(): number {
    return this.inner.packageSize;
  }

  /** 是否为未解密的加密包。 */
  get encrypted(): boolean {
    return this.inner.encrypted;
  }

  /** @returns 文件元数据。 */
  list(): ReturnType<VirtualContainer['list']> {
    return this.inner.list();
  }

  /** @param path 包内路径。 @returns 是否存在。 */
  has(path: string): boolean {
    this.hasPaths.push(path);
    return this.inner.has(path);
  }

  /** @param path 包内路径。 @returns 文件元数据。 */
  stat(path: string): ReturnType<VirtualContainer['stat']> {
    return this.inner.stat(path);
  }

  /**
   * @param path 包内路径。
   * @param options 读取选项。
   * @returns 明文字节。
   */
  read(path: string, options?: VirtualReadOptions): Promise<Uint8Array> {
    this.readPaths.push(path);
    return this.inner.read(path, options);
  }

  /** 关闭被包装容器。 */
  async close(): Promise<void> {
    this.closeCalls += 1;
    await this.inner.close();
  }
}

/** 读取 ZIP 包全部条目为内存映射。 */
async function readAllEntries(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const zip = await ZipVirtualContainer.open(new ArrayBufferSource(bytes));
  try {
    const map = new Map<string, Uint8Array>();
    for (const meta of zip.list()) map.set(meta.path, await zip.read(meta.path));
    return map;
  } finally {
    await zip.close();
  }
}

/** 单页最小文档。 */
function onePage(): FixturePage[] {
  return [{ id: 1, widthMm: 100, heightMm: 100, objects: [] }];
}

/** 签名索引 XML。 */
function signaturesIndexXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Signatures ${'xmlns:ofd="http://www.ofdspec.org/2016"'}>
  <ofd:Signature ID="s1" Type="Sign" BaseLoc="/Doc_0/Signs/S1/Signature.xml"/>
</ofd:Signatures>`;
}

/** 单个 Signature.xml。 */
function signatureXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Signature xmlns:ofd="http://www.ofdspec.org/2016">
  <ofd:SignedInfo>
    <ofd:SignatureDateTime>2026-01-02 03:04:05</ofd:SignatureDateTime>
    <ofd:References><ofd:Reference FileRef="/OFD.xml"/></ofd:References>
  </ofd:SignedInfo>
  <ofd:SignedValue>/Doc_0/Signs/S1/SignedValue.dat</ofd:SignedValue>
</ofd:Signature>`;
}

/** 构造包含图片、附件与签章的回归包。 */
function buildRichPackage(): Uint8Array {
  const imageXml: XmlElementSpec = {
    name: 'ofd:ImageObject',
    attrs: { ID: 11, Boundary: '10 10 10 10', ResourceID: '10', CTM: '10 0 0 10 0 0' },
  };
  return buildFixtureOfd({
    pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [imageXml] }],
    publicRes: [
      {
        path: 'Doc_0/Res/Res.xml',
        children: [
          {
            name: 'ofd:MultiMedias',
            children: [
              {
                name: 'ofd:MultiMedia',
                attrs: { ID: 10, Type: 'Image', Format: 'PNG' },
                children: [{ name: 'ofd:MediaFile', children: ['image.png'] }],
              },
            ],
          },
        ],
      },
    ],
    documentChildren: [{ name: 'ofd:Attachments', children: ['Attachments.xml'] }],
    extraEntries: [
      { name: 'Doc_0/Res/image.png', data: createPng() },
      {
        name: 'Doc_0/Attachments.xml',
        data: buildXmlDocument({
          name: 'ofd:Attachments',
          attrs: { 'xmlns:ofd': OFD_NS },
          children: [
            {
              name: 'ofd:Attachment',
              attrs: { ID: '1', Name: 'a.bin' },
              children: [{ name: 'ofd:FileLoc', children: ['/Doc_0/Res/a.bin'] }],
            },
          ],
        }),
      },
      { name: 'Doc_0/Res/a.bin', data: Uint8Array.from([1, 2, 3, 4]) },
      { name: 'Doc_0/Signs/Signatures.xml', data: signaturesIndexXml() },
      { name: 'Doc_0/Signs/S1/Signature.xml', data: signatureXml() },
      {
        name: 'Doc_0/Signs/S1/SignedValue.dat',
        data: Uint8Array.from([0x30, 0x03, 0x02, 0x01, 0x01]),
      },
    ],
  });
}

/** 构造带 Encryptions.xml 的“加密”包（仅用于打开路径测试）。 */
function buildEncryptedPackage(): Uint8Array {
  return buildFixtureOfd({
    pages: onePage(),
    extraEntries: [{ name: 'Encryptions.xml', data: '<ofd:Encryptions/>' }],
  });
}

/** 多文档 OFD.xml。 */
function multiDocumentOfdXml(): string {
  return buildXmlDocument({
    name: 'ofd:OFD',
    attrs: { 'xmlns:ofd': OFD_NS, DocType: 'ofd', Version: '1.3' },
    children: [
      {
        name: 'ofd:DocBody',
        children: [
          {
            name: 'ofd:DocInfo',
            children: [
              { name: 'ofd:DocID', children: ['first-id'] },
              { name: 'ofd:Title', children: ['第一份'] },
            ],
          },
          { name: 'ofd:DocRoot', children: ['Doc_0/Document.xml'] },
        ],
      },
      {
        name: 'ofd:DocBody',
        children: [
          {
            name: 'ofd:DocInfo',
            children: [
              { name: 'ofd:DocID', children: ['second-id'] },
              { name: 'ofd:Title', children: ['第二份'] },
            ],
          },
          { name: 'ofd:DocRoot', children: ['Doc_1/Document.xml'] },
        ],
      },
    ],
  });
}

/** 第二份文档的 Document.xml。 */
function secondDocumentXml(): string {
  return buildXmlDocument({
    name: 'ofd:Document',
    attrs: { 'xmlns:ofd': OFD_NS, Version: '1.3' },
    children: [
      {
        name: 'ofd:Pages',
        children: [{ name: 'ofd:Page', attrs: { ID: 2, BaseLoc: 'Pages/Page_0/Content.xml' } }],
      },
    ],
  });
}

/** 带 close 计数的字节源。 */
class ClosableSource implements ByteSource {
  /** close 调用次数。 */
  closeCalls = 0;
  readonly size: number;

  private readonly inner: ArrayBufferSource;

  /**
   * @param bytes 完整字节。
   */
  constructor(bytes: Uint8Array) {
    this.inner = new ArrayBufferSource(bytes);
    this.size = this.inner.size;
  }

  /** @param offset 起始偏移，byte。 @param length 长度，byte。 @returns 字节。 */
  read(offset: number, length: number): Promise<Uint8Array> {
    return this.inner.read(offset, length);
  }

  /** 记录关闭。 */
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

/** 在指定条目上挂起，直到 signal 中止；用于验证 engine 透传取消信号。 */
class HangingContainer extends MemoryContainer {
  /** 挂起读取收到的 signal。 */
  hangSignal: AbortSignal | undefined;

  /**
   * @param files 包内路径 → 明文字节。
   * @param hangPath 需要挂起的包内路径。
   */
  constructor(
    files: Iterable<readonly [string, Uint8Array]>,
    private readonly hangPath: string,
  ) {
    super(files);
  }

  /**
   * 目标条目挂起等待 signal 中止；其余条目委托给内存容器。
   *
   * @param path 包内路径。
   * @param options 读取选项。
   * @returns 目标条目永不 resolve；中止时抛 OFD_ABORTED。
   */
  override async read(path: string, options: VirtualReadOptions = {}): Promise<Uint8Array> {
    if (normalize(path) !== this.hangPath) return super.read(path, options);
    const signal = options.signal;
    this.hangSignal = signal;
    return new Promise<Uint8Array>((_resolve, reject) => {
      if (!signal) {
        reject(new Error('挂起读取缺少 signal'));
        return;
      }
      const onAbort = (): void => reject(new OFDError('OFD_ABORTED', '读取已取消'));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

describe('OFDDocument 容器注入', () => {
  it('默认 source 路径行为不变：容器字节数进入 metadata.packageSize', async () => {
    const bytes = buildRichPackage();
    const doc = await OFDDocument.open({
      source: { kind: 'arraybuffer', data: bytes },
      renderer: createTestRenderer(),
      imageDecoders: [...nodeImageDecoders],
    });
    try {
      const metadata = await doc.getMetadata();
      expect(metadata.packageSize).toBe(bytes.byteLength);
      expect(metadata.pageCount).toBe(1);
      const page = await doc.getPage(0);
      const { canvas } = await renderPage(page);
      expect(canvas.canvas.width).toBeGreaterThan(0);
    } finally {
      await doc.close();
    }
  });

  it('注入借用容器：XML/页/图片/附件/签章读取全部经容器，close 不关闭容器', async () => {
    const bytes = buildRichPackage();
    const inner = await ZipVirtualContainer.open(new ArrayBufferSource(bytes));
    const container = new RecordingContainer(inner);
    const doc = await OFDDocument.open({
      container,
      renderer: createTestRenderer(),
      imageDecoders: [...nodeImageDecoders],
    });
    try {
      expect((await doc.getMetadata()).packageSize).toBe(bytes.byteLength);

      const page = await doc.getPage(0);
      await renderPage(page);

      const attachments = await doc.getAttachments();
      expect(attachments.map((item) => item.id)).toEqual(['1']);
      expect(await doc.getAttachmentData('1')).toEqual(Uint8Array.from([1, 2, 3, 4]));

      const signatures = await doc.getSignatureEntries();
      expect(signatures.map((item) => item.id)).toEqual(['s1']);
      const signedValue = await doc.getSignedValue('s1');
      expect(signedValue?.signatureId).toBe('s1');
    } finally {
      await doc.close();
    }

    // 借用容器归宿主所有：doc.close 不关闭它。
    expect(container.closeCalls).toBe(0);
    expect(container.readPaths).toEqual(
      expect.arrayContaining([
        'OFD.xml',
        'Doc_0/Document.xml',
        'Doc_0/Pages/Page_1/Content.xml',
        'Doc_0/Res/Res.xml',
        'Doc_0/Res/image.png',
        'Doc_0/Attachments.xml',
        'Doc_0/Res/a.bin',
        'Doc_0/Signs/Signatures.xml',
        'Doc_0/Signs/S1/Signature.xml',
        'Doc_0/Signs/S1/SignedValue.dat',
      ]),
    );
    expect(container.hasPaths).toEqual(
      expect.arrayContaining(['Doc_0/Signs/Signatures.xml']),
    );

    await container.close();
    expect(container.closeCalls).toBe(1);
  });

  it('模拟解密容器：加密包默认拒绝，注入明文容器后可打开并保留原始包大小', async () => {
    const encryptedBytes = buildEncryptedPackage();
    const rejected = await rejectOf(
      OFDDocument.open({
        source: { kind: 'arraybuffer', data: encryptedBytes },
        renderer: createTestRenderer(),
      }),
    );
    expect(codeOf(rejected)).toBe('OFD_ENCRYPTED');

    // 模拟 crypto：去掉加密元数据，返回 encrypted=false、packageSize 保留加密源大小。
    const plainFiles = await readAllEntries(encryptedBytes);
    plainFiles.delete('Encryptions.xml');
    const container = new MemoryContainer(plainFiles, {
      packageSize: encryptedBytes.byteLength,
      encrypted: false,
    });

    const doc = await OFDDocument.open({
      container,
      renderer: createTestRenderer(),
      imageDecoders: [...nodeImageDecoders],
    });
    try {
      const metadata = await doc.getMetadata();
      expect(metadata.packageSize).toBe(encryptedBytes.byteLength);
      const page = await doc.getPage(0);
      expect(page.getSize()).toEqual({ width: 100, height: 100 });
    } finally {
      await doc.close();
    }
    expect(container.closeCalls).toBe(0);
    expect(container.readPaths).toEqual(
      expect.arrayContaining(['OFD.xml', 'Doc_0/Document.xml', 'Doc_0/Pages/Page_1/Content.xml']),
    );
  });

  it('containerFactory：工厂拿到 source，返回容器归 engine 并在 close 时只关闭一次', async () => {
    const bytes = buildRichPackage();
    const files = await readAllEntries(bytes);
    const containers: MemoryContainer[] = [];
    let receivedSource: unknown;
    const doc = await OFDDocument.open({
      source: { kind: 'arraybuffer', data: bytes },
      containerFactory: async (source) => {
        receivedSource = source;
        const container = new MemoryContainer(files, { packageSize: bytes.byteLength });
        containers.push(container);
        return container;
      },
      renderer: createTestRenderer(),
      imageDecoders: [...nodeImageDecoders],
    });
    expect(receivedSource).toEqual({ kind: 'arraybuffer', data: bytes });
    await doc.close();
    await doc.close();
    expect(containers).toHaveLength(1);
    expect(containers[0]?.closeCalls).toBe(1);
    expect(containers[0]?.closed).toBe(true);
  });

  it('containerFactory 打开失败时关闭工厂容器；借用容器失败时不关闭', async () => {
    const incomplete = new Map<string, Uint8Array>([
      ['Document.xml', new TextEncoder().encode('<ofd:Document/>')],
    ]);
    const owned = new MemoryContainer(incomplete);
    const factoryError = await rejectOf(
      OFDDocument.open({
        source: { kind: 'arraybuffer', data: new Uint8Array([1, 2, 3]) },
        containerFactory: async () => owned,
      }),
    );
    expect(codeOf(factoryError)).toBe('OFD_INVALID_PACKAGE');
    expect(owned.closeCalls).toBe(1);

    const borrowed = new MemoryContainer(incomplete);
    const borrowedError = await rejectOf(
      OFDDocument.open({ container: borrowed }),
    );
    expect(codeOf(borrowedError)).toBe('OFD_INVALID_PACKAGE');
    expect(borrowed.closeCalls).toBe(0);
  });

  it('container+source 同时提供时不打开 source（无效来源也不影响）', async () => {
    const bytes = buildRichPackage();
    const container = new MemoryContainer(await readAllEntries(bytes));
    const doc = await OFDDocument.open({ container, source: { kind: 'node-file', path: '/nope.ofd' } });
    try {
      expect(doc.pageCount).toBe(1);
    } finally {
      await doc.close();
    }
    expect(container.closeCalls).toBe(0);
  });

  it('已关闭容器打开抛 OFD_CLOSED；encrypted=true 的借用容器抛 OFD_ENCRYPTED 且不关闭', async () => {
    const files = await readAllEntries(buildRichPackage());
    const closed = new MemoryContainer(files);
    await closed.close();
    const closedError = await rejectOf(OFDDocument.open({ container: closed }));
    expect(codeOf(closedError)).toBe('OFD_CLOSED');

    const encrypted = new MemoryContainer(files, { encrypted: true });
    const encryptedError = await rejectOf(OFDDocument.open({ container: encrypted }));
    expect(codeOf(encryptedError)).toBe('OFD_ENCRYPTED');
    expect(encrypted.closeCalls).toBe(0);
  });

  it('参数冲突/缺少来源/缺少必需条目返回 OFD_INVALID_PACKAGE', async () => {
    const files = await readAllEntries(buildRichPackage());
    const container = new MemoryContainer(files);
    const conflict = await rejectOf(
      OFDDocument.open({
        source: { kind: 'arraybuffer', data: buildRichPackage() },
        container,
        containerFactory: async () => container,
      }),
    );
    expect(codeOf(conflict)).toBe('OFD_INVALID_PACKAGE');

    const factoryWithoutSource = await rejectOf(
      // 运行时非法参数：类型层走收窄断言，验证 engine 的错误码。
      OFDDocument.open({
        containerFactory: async () => container,
      } as unknown as OFDOpenOptions),
    );
    expect(codeOf(factoryWithoutSource)).toBe('OFD_INVALID_PACKAGE');

    const nothing = await rejectOf(OFDDocument.open({} as unknown as OFDOpenOptions));
    expect(codeOf(nothing)).toBe('OFD_INVALID_PACKAGE');

    const noOfdXml = new MemoryContainer([['Document.xml', new Uint8Array([1])]]);
    const missing = await rejectOf(OFDDocument.open({ container: noOfdXml }));
    expect(codeOf(missing)).toBe('OFD_INVALID_PACKAGE');
  });

  it('多文档包按 documentIndex 经同一容器选择文档', async () => {
    const bytes = buildFixtureOfd({
      pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [] }],
      ofdXml: multiDocumentOfdXml(),
      extraEntries: [{ name: 'Doc_1/Document.xml', data: secondDocumentXml() }],
    });
    const container = new RecordingContainer(
      await ZipVirtualContainer.open(new ArrayBufferSource(bytes)),
    );
    const doc = await OFDDocument.open({ container, documentIndex: 1 });
    try {
      const metadata = await doc.getMetadata();
      expect(metadata.title).toBe('第二份');
      expect(metadata.docId).toBe('second-id');
    } finally {
      await doc.close();
    }
    expect(container.readPaths).toContain('Doc_1/Document.xml');
    await container.close();
  });

  it('默认容器 owns 来源：打开失败与正常关闭都会释放字节源', async () => {
    const failedSource = new ClosableSource(buildEncryptedPackage());
    const failure = await rejectOf(
      OFDDocument.open({
        source: { kind: 'custom', source: failedSource },
        renderer: createTestRenderer(),
      }),
    );
    expect(codeOf(failure)).toBe('OFD_ENCRYPTED');
    expect(failedSource.closeCalls).toBe(1);

    const okSource = new ClosableSource(buildRichPackage());
    const doc = await OFDDocument.open({
      source: { kind: 'custom', source: okSource },
      renderer: createTestRenderer(),
      imageDecoders: [...nodeImageDecoders],
    });
    await doc.close();
    await doc.close();
    expect(okSource.closeCalls).toBe(1);
  });

  it('openZipVirtualContainer 公开构造器返回明文容器，读取超限抛 OFD_LIMIT_EXCEEDED', async () => {
    const bytes = buildFixtureOfd({ pages: onePage() });
    const container = await openZipVirtualContainer({ kind: 'arraybuffer', data: bytes });
    try {
      expect(container.encrypted).toBe(false);
      expect(container.has('OFD.xml')).toBe(true);
      const warnings: OFDWarning[] = [];
      const xml = await container.read('OFD.xml', { onWarning: (warning) => warnings.push(warning) });
      expect(new TextDecoder().decode(xml)).toContain('ofd:OFD');

      const limitError = await rejectOf(container.read('OFD.xml', { maxBytes: 4 }));
      expect(codeOf(limitError)).toBe('OFD_LIMIT_EXCEEDED');
    } finally {
      await container.close();
    }
    const closedError = await rejectOf(container.read('OFD.xml'));
    expect(codeOf(closedError)).toBe('OFD_CLOSED');
  });
});
describe('OFDDocument 读取取消（AbortSignal 透传）', () => {
  /** 默认渲染器与 Node 图片解码器。 */
  const openOptions = {
    renderer: createTestRenderer(),
    imageDecoders: [...nodeImageDecoders],
  };

  it('getPageInfos 的 signal 透传到 Content.xml 读取并中止进行中的读取', async () => {
    const container = new HangingContainer(
      await readAllEntries(buildRichPackage()),
      'Doc_0/Pages/Page_1/Content.xml',
    );
    const doc = await OFDDocument.open({ container, ...openOptions });
    const controller = new AbortController();
    try {
      const promise = doc.getPageInfos({ signal: controller.signal });
      await waitForCondition(() => container.hangSignal !== undefined);
      controller.abort();
      expect(container.hangSignal?.aborted).toBe(true);
      expect(codeOf(await rejectOf(promise))).toBe('OFD_ABORTED');
    } finally {
      await doc.close();
    }
  });

  it('render 的 signal 透传到图片读取并中止进行中的解码', async () => {
    const container = new HangingContainer(
      await readAllEntries(buildRichPackage()),
      'Doc_0/Res/image.png',
    );
    const doc = await OFDDocument.open({ container, ...openOptions });
    const controller = new AbortController();
    try {
      const page = await doc.getPage(0);
      const viewport = page.getViewport({ dpi: 72 });
      const canvas = createTestCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const task = page.render({
        canvasContext: canvas.context,
        viewport: {
          width: viewport.width,
          height: viewport.height,
          dpi: viewport.dpi,
        },
        signal: controller.signal,
      });
      await waitForCondition(() => container.hangSignal !== undefined);
      controller.abort();
      expect(container.hangSignal?.aborted).toBe(true);
      expect(codeOf(await rejectOf(task.promise))).toBe('OFD_ABORTED');
    } finally {
      await doc.close();
    }
  });

  it('getAttachmentData 的 signal 透传到附件读取并中止进行中的读取', async () => {
    const container = new HangingContainer(
      await readAllEntries(buildRichPackage()),
      'Doc_0/Res/a.bin',
    );
    const doc = await OFDDocument.open({ container, ...openOptions });
    const controller = new AbortController();
    try {
      await doc.getAttachments();
      const promise = doc.getAttachmentData('1', { signal: controller.signal });
      await waitForCondition(() => container.hangSignal !== undefined);
      controller.abort();
      expect(codeOf(await rejectOf(promise))).toBe('OFD_ABORTED');
    } finally {
      await doc.close();
    }
  });

  it('getSignedValue 的 signal 透传到 SignedValue 读取并中止进行中的读取', async () => {
    const container = new HangingContainer(
      await readAllEntries(buildRichPackage()),
      'Doc_0/Signs/S1/SignedValue.dat',
    );
    const doc = await OFDDocument.open({ container, ...openOptions });
    const controller = new AbortController();
    try {
      const promise = doc.getSignedValue('s1', { signal: controller.signal });
      await waitForCondition(() => container.hangSignal !== undefined);
      controller.abort();
      expect(codeOf(await rejectOf(promise))).toBe('OFD_ABORTED');
    } finally {
      await doc.close();
    }
  });

  it('openZipVirtualContainer 对加密包返回 raw 容器：encrypted=true 且 read 为存仓字节', async () => {
    const bytes = buildEncryptedPackage();
    const container = await openZipVirtualContainer({ kind: 'arraybuffer', data: bytes });
    try {
      expect(container.encrypted).toBe(true);
      const raw = await container.read('Encryptions.xml');
      const inner = await ZipVirtualContainer.open(new ArrayBufferSource(bytes));
      try {
        expect(raw).toEqual(await inner.read('Encryptions.xml'));
      } finally {
        await inner.close();
      }
      // raw 容器不得注入 engine：engine 在解析 XML 前拒绝。
      const error = await rejectOf(OFDDocument.open({ container }));
      expect(codeOf(error)).toBe('OFD_ENCRYPTED');
    } finally {
      await container.close();
    }
  });
});

/** 可放行的挂起容器：目标读取停在闸门前，收到 signal 中止时拒绝。 */
class GatedContainer extends MemoryContainer {
  /** 目标读取是否已开始。 */
  started = false;
  /** 目标读取收到的内部 signal。 */
  targetSignal: AbortSignal | undefined;
  private releaseGate!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });
  private active: boolean;

  /**
   * @param files 包内路径 → 明文字节。
   * @param gatePath 需要挂起的包内路径。
   * @param initiallyActive 是否立即挂起；false 时先用 activate() 启用。
   */
  constructor(
    files: Iterable<readonly [string, Uint8Array]>,
    private readonly gatePath: string,
    initiallyActive = true,
  ) {
    super(files);
    this.active = initiallyActive;
  }

  /** 启用目标读取挂起。 */
  activate(): void {
    this.active = true;
  }

  /** 放行目标读取。 */
  release(): void {
    this.releaseGate();
  }

  /**
   * 目标条目等待闸门；signal 中止时按取消拒绝。
   *
   * @param path 包内路径。
   * @param options 读取选项。
   * @returns 目标条目字节。
   */
  override async read(path: string, options: VirtualReadOptions = {}): Promise<Uint8Array> {
    if (!this.active || normalize(path) !== this.gatePath) return super.read(path, options);
    this.started = true;
    this.targetSignal = options.signal;
    const signal = options.signal;
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(new OFDError('OFD_ABORTED', '读取已取消'));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      void this.gate.then(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      });
    });
    return super.read(path, options);
  }
}

describe('OFDDocument 共享加载取消隔离', () => {
  const openOptions = {
    renderer: createTestRenderer(),
    imageDecoders: [...nodeImageDecoders],
  };

  /**
   * 断言取消一路不影响另一路：底层内部 signal 不中止，另一路正常完成。
   *
   * @param first 第一路 promise。
   * @param second 第二路 promise。
   * @param container 挂起容器。
   * @param firstSignal 第一路 signal。
   * @param secondSignal 第二路 signal。
   */
  async function expectFirstCanceled<T>(
    first: Promise<unknown>,
    second: Promise<T>,
    container: GatedContainer,
    firstSignal: AbortController,
    secondSignal: AbortSignal,
  ): Promise<T> {
    firstSignal.abort();
    expect(codeOf(await rejectOf(first))).toBe('OFD_ABORTED');
    expect(container.targetSignal?.aborted).toBe(false);
    expect(secondSignal.aborted).toBe(false);
    container.release();
    return second;
  }

  it('两个调用方并发读取页信息，仅取消其一，另一路正常完成', async () => {
    const container = new GatedContainer(
      await readAllEntries(buildRichPackage()),
      'Doc_0/Pages/Page_1/Content.xml',
    );
    const doc = await OFDDocument.open({ container, ...openOptions });
    const first = new AbortController();
    const second = new AbortController();
    try {
      const firstPromise = doc.getPageInfos({ signal: first.signal });
      await waitForCondition(() => container.started);
      const secondPromise = doc.getPageInfos({ signal: second.signal });
      const infos = await expectFirstCanceled(
        firstPromise,
        secondPromise,
        container,
        first,
        second.signal,
      );
      expect(infos).toHaveLength(1);
    } finally {
      await doc.close();
    }
  });

  it('两个调用方并发读取附件，仅取消其一，另一路正常完成', async () => {
    const container = new GatedContainer(
      await readAllEntries(buildRichPackage()),
      'Doc_0/Attachments.xml',
    );
    const doc = await OFDDocument.open({ container, ...openOptions });
    const first = new AbortController();
    const second = new AbortController();
    try {
      const firstPromise = doc.getAttachments({ signal: first.signal });
      await waitForCondition(() => container.started);
      const secondPromise = doc.getAttachments({ signal: second.signal });
      const attachments = await expectFirstCanceled(
        firstPromise,
        secondPromise,
        container,
        first,
        second.signal,
      );
      expect(attachments.map((item) => item.id)).toEqual(['1']);
    } finally {
      await doc.close();
    }
  });

  it('两个调用方并发读取签章 XML，仅取消其一，另一路正常完成', async () => {
    const container = new GatedContainer(
      await readAllEntries(buildRichPackage()),
      'Doc_0/Signs/Signatures.xml',
    );
    const doc = await OFDDocument.open({ container, ...openOptions });
    const first = new AbortController();
    const second = new AbortController();
    try {
      const firstPromise = doc.getSignatureEntries({ signal: first.signal });
      await waitForCondition(() => container.started);
      const secondPromise = doc.getSignatureEntries({ signal: second.signal });
      const entries = await expectFirstCanceled(
        firstPromise,
        secondPromise,
        container,
        first,
        second.signal,
      );
      expect(entries.map((entry) => entry.id)).toEqual(['s1']);
    } finally {
      await doc.close();
    }
  });

  it('准备与签章条目并发读取同一 Signatures.xml，仅取消准备一路，条目正常返回', async () => {
    const container = new GatedContainer(
      await readAllEntries(buildRichPackage()),
      'Doc_0/Signs/Signatures.xml',
    );
    const doc = await OFDDocument.open({ container, ...openOptions });
    const first = new AbortController();
    const second = new AbortController();
    try {
      const page = await doc.getPage(0);
      const firstPromise = page.prepare({ signal: first.signal });
      await waitForCondition(() => container.started);
      const secondPromise = doc.getSignatureEntries({ signal: second.signal });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const entries = await expectFirstCanceled(
        firstPromise,
        secondPromise,
        container,
        first,
        second.signal,
      );
      expect(entries.map((entry) => entry.id)).toEqual(['s1']);
    } finally {
      await doc.close();
    }
  });

  it('淘汰页入口缓存后同页并发 render，仅取消其一，另一路正常完成', async () => {
    const bytes = buildFixtureOfd({
      pages: [
        { id: 1, objects: [] },
        { id: 2, objects: [] },
      ],
    });
    const container = new GatedContainer(
      await readAllEntries(bytes),
      'Doc_0/Pages/Page_1/Content.xml',
      false,
    );
    const doc = await OFDDocument.open({
      container,
      renderer: createTestRenderer(),
      imageDecoders: [...nodeImageDecoders],
      cache: { pageModels: 1, xmlBytes: 1 },
    });
    const first = new AbortController();
    const second = new AbortController();
    try {
      const page = await doc.getPage(0);
      // pageModels=1：加载第 2 页后第 1 页入口被淘汰，render 会重新读取 Content.xml。
      await doc.getPage(1);
      container.activate();
      const viewport = page.getViewport({ dpi: 72 });
      const firstCanvas = createTestCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      const secondCanvas = createTestCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      const params = (canvasContext: typeof firstCanvas.context) => ({
        canvasContext,
        viewport: {
          width: viewport.width,
          height: viewport.height,
          dpi: viewport.dpi,
        },
      });
      const firstTask = page.render({ ...params(firstCanvas.context), signal: first.signal });
      await waitForCondition(() => container.started);
      const secondTask = page.render({ ...params(secondCanvas.context), signal: second.signal });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const result = await expectFirstCanceled(
        firstTask.promise,
        secondTask.promise,
        container,
        first,
        second.signal,
      );
      await result;
      expect(secondCanvas.canvas.width).toBeGreaterThan(0);
    } finally {
      await doc.close();
    }
  });

  it('借用容器 close 后清空引用，再次读取抛 OFD_CLOSED 且不关闭容器', async () => {
    const container = new MemoryContainer(await readAllEntries(buildRichPackage()));
    const doc = await OFDDocument.open({ container, ...openOptions });
    const handle = doc as unknown as { container?: VirtualContainer };
    expect(handle.container).toBe(container);
    await doc.close();
    expect(handle.container).toBeUndefined();
    expect(container.closeCalls).toBe(0);
    expect(codeOf(await rejectOf(doc.getAttachments()))).toBe('OFD_CLOSED');
  });
});
