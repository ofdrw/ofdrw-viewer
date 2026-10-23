/**
 * V-ENG 独立验收工具（测试专用）。
 *
 * 与实现者自测（`test/api/container-injection.test.ts`、`test/container/zip-container.test.ts`）
 * 相互独立：这里自带内存/包装容器、可关闭字节源、原始 ZIP 预期值解析与画布摘要，
 * 只通过包根公共 API 驱动 engine。
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  OFDError,
  isOFDError,
} from '@ofdrw/ofdrw-viewer-engine';
import type {
  ByteSource,
  VirtualContainer,
  VirtualFileMeta,
  VirtualReadOptions,
} from '@ofdrw/ofdrw-viewer-engine';
import type { TestCanvas } from '../api/helpers';
import { buildFixtureOfd, createPng, OFD_NS } from '../api/helpers';
import { buildXmlDocument } from '../fixtures/xml';
import { readZipEntries } from '../fixtures/zip-inspector';
import { buildZip } from '../container/zip-fixture';

/** 仓库根目录（本文件位于 packages/ofdrw-viewer-engine/test/verification）。 */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** 真实 OFD 样本目录。 */
export const SAMPLE_DIR = `${REPO_ROOT}ofd_pdf_match/`;

/**
 * 样本是否存在。
 *
 * @param name `ofd_pdf_match` 下的文件名。
 * @returns 存在时为 true。
 */
export function hasSample(name: string): boolean {
  return existsSync(`${SAMPLE_DIR}${name}`);
}

/**
 * 读取真实样本。
 *
 * @param name `ofd_pdf_match` 下的文件名。
 * @returns 文件字节。
 */
export function readSample(name: string): Uint8Array {
  return new Uint8Array(readFileSync(`${SAMPLE_DIR}${name}`));
}

/**
 * 用独立 ZIP 解析器读取全部条目。
 *
 * @param bytes ZIP 字节。
 * @returns 包内路径 → 解压后字节。
 */
export function rawEntryMap(bytes: Uint8Array): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  for (const entry of readZipEntries(bytes)) map.set(entry.name, entry.data);
  return map;
}

/**
 * 从原始 XML 字符串提取第一个匹配内容。
 *
 * @param xml XML 文本。
 * @param pattern 正则（需包含第一个捕获组）。
 * @returns 捕获内容；未匹配时 undefined。
 */
export function matchXml(xml: string, pattern: RegExp): string | undefined {
  return pattern.exec(xml)?.[1];
}

/**
 * 包内路径规范化（与容器契约一致：去前导 `/`、折叠 `.`、处理 `..`）。
 *
 * @param path 原始路径。
 * @returns 规范化路径。
 */
export function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/**
 * 取 OFDError 错误码。
 *
 * @param error 任意错误。
 * @returns 错误码；非 OFDError 时 undefined。
 */
export function codeOf(error: unknown): string | undefined {
  return isOFDError(error) ? error.code : undefined;
}

/**
 * 等待 promise 拒绝并返回错误对象。
 *
 * @param promise 预期拒绝的 promise。
 * @returns 拒绝原因。
 */
export async function rejectOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('promise 未按预期拒绝');
}

/** 内存容器选项。 */
export interface MemoryContainerOptions {
  /** 包大小，byte；默认全部文件字节数之和。 */
  packageSize?: number;
  /** 是否标记为未解密的加密包，默认 false。 */
  encrypted?: boolean;
  /** 文件来源标记，默认 `decrypted`。 */
  origin?: VirtualFileMeta['origin'];
  /** `close()` 抛出的错误；用于验证关闭失败不阻塞文档关闭。 */
  closeError?: Error;
  /** 指定路径的读取错误（键为规范化路径）。 */
  readErrors?: ReadonlyMap<string, unknown>;
  /** 指定路径读取时通过 `onWarning` 发出的 warning。 */
  readWarnings?: ReadonlyMap<string, { code: string; message: string }>;
}

/**
 * 内存明文容器：模拟 crypto 解密后的容器，全部实现独立于 engine 容器实现。
 */
export class MemoryContainer implements VirtualContainer {
  readonly packageSize: number;
  readonly encrypted: boolean;
  readonly files: Map<string, Uint8Array>;
  /** `read()` 调用过的规范化路径。 */
  readonly readPaths: string[] = [];
  /** `has()` 调用过的路径。 */
  readonly hasPaths: string[] = [];
  /** `close()` 调用次数（含幂等重复调用）。 */
  closeCalls = 0;
  /** 是否已关闭。 */
  closed = false;

  private readonly origin: VirtualFileMeta['origin'];
  private readonly closeError: Error | undefined;
  private readonly readErrors: ReadonlyMap<string, unknown>;
  private readonly readWarnings: ReadonlyMap<string, { code: string; message: string }>;

  /**
   * @param files 包内路径 → 明文字节。
   * @param options 包大小/加密标记/错误注入。
   */
  constructor(
    files: Iterable<readonly [string, Uint8Array]>,
    options: MemoryContainerOptions = {},
  ) {
    this.files = new Map(
      [...files].map(([path, bytes]) => [normalizePath(path), bytes.slice()] as const),
    );
    const total = [...this.files.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
    this.packageSize = options.packageSize ?? total;
    this.encrypted = options.encrypted ?? false;
    this.origin = options.origin ?? 'decrypted';
    this.closeError = options.closeError;
    this.readErrors = options.readErrors ?? new Map();
    this.readWarnings = options.readWarnings ?? new Map();
  }

  /** @returns 按路径升序的文件元数据。 */
  list(): readonly VirtualFileMeta[] {
    this.assertOpen();
    return [...this.files.entries()]
      .map(([path, bytes]) => ({
        path,
        size: bytes.byteLength,
        origin: this.origin,
      }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  }

  /**
   * @param path 包内路径。
   * @returns 是否存在（关闭后返回 false）。
   */
  has(path: string): boolean {
    if (this.closed) return false;
    const normalized = normalizePath(path);
    this.hasPaths.push(normalized);
    return this.files.has(normalized);
  }

  /**
   * @param path 包内路径。
   * @returns 文件元数据（关闭后返回 undefined）。
   */
  stat(path: string): VirtualFileMeta | undefined {
    if (this.closed) return undefined;
    const normalized = normalizePath(path);
    const bytes = this.files.get(normalized);
    return bytes ? { path: normalized, size: bytes.byteLength, origin: this.origin } : undefined;
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
    if (options.signal?.aborted) throw new OFDError('OFD_ABORTED', '容器读取已取消');
    const normalized = normalizePath(path);
    const injected = this.readErrors.get(normalized);
    if (injected !== undefined) throw injected;
    const bytes = this.files.get(normalized);
    if (!bytes) throw new OFDError('OFD_ENTRY_NOT_FOUND', `条目不存在：${path}`);
    if (options.maxBytes !== undefined && bytes.byteLength > options.maxBytes) {
      throw new OFDError('OFD_LIMIT_EXCEEDED', `条目 ${path} 超过读取上限 ${options.maxBytes}`);
    }
    const warning = this.readWarnings.get(normalized);
    if (warning) options.onWarning?.(warning);
    this.readPaths.push(normalized);
    return bytes.slice();
  }

  /** 幂等关闭；可注入关闭错误。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeCalls += 1;
    if (this.closeError) throw this.closeError;
  }

  /** 断言容器仍打开。 */
  private assertOpen(): void {
    if (this.closed) throw new OFDError('OFD_CLOSED', '容器已关闭');
  }
}

/**
 * 包装容器：记录读取路径并委托给内部容器（用于审计默认 ZIP 容器）。
 */
export class RecordingContainer implements VirtualContainer {
  /** `read()` 路径。 */
  readonly readPaths: string[] = [];
  /** `has()` 路径。 */
  readonly hasPaths: string[] = [];
  /** `close()` 调用次数。 */
  closeCalls = 0;

  /**
   * @param inner 被包装容器。
   */
  constructor(private readonly inner: VirtualContainer) {}

  /** 原始包字节数，byte。 */
  get packageSize(): number {
    return this.inner.packageSize;
  }

  /** 是否未解密。 */
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

  /** @param path 包内路径。 @returns 元数据。 */
  stat(path: string): VirtualFileMeta | undefined {
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

  /** 关闭内部容器。 */
  async close(): Promise<void> {
    this.closeCalls += 1;
    await this.inner.close();
  }
}

/** 可关闭的内存字节源（ByteSource 本身没有 close，关闭由容器/工厂负责）。 */
export class ClosableSource implements ByteSource {
  /** 总字节数，byte。 */
  readonly size: number;
  /** `close()` 调用次数。 */
  closeCalls = 0;
  /** `read()` 调用次数。 */
  readCalls = 0;
  /** 注入的关闭错误。 */
  closeError: Error | undefined;

  private readonly bytes: Uint8Array;

  /**
   * @param bytes 完整字节。
   * @param closeError 可选关闭错误。
   */
  constructor(bytes: Uint8Array, closeError?: Error) {
    this.bytes = bytes.slice();
    this.size = bytes.byteLength;
    this.closeError = closeError;
  }

  /**
   * @param offset 起始偏移，byte。
   * @param length 读取长度，byte。
   * @returns 区间字节（越界截断）。
   */
  async read(offset: number, length: number): Promise<Uint8Array> {
    this.readCalls += 1;
    const start = Math.max(0, offset);
    return this.bytes.slice(start, start + Math.max(0, length));
  }

  /** 记录关闭；可抛错。 */
  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError) throw this.closeError;
  }
}

/** 画布统计。 */
export interface CanvasStats {
  /** 宽度，像素。 */
  readonly width: number;
  /** 高度，像素。 */
  readonly height: number;
  /** 非白像素数。 */
  readonly ink: number;
  /** RGBA 字节的 FNV-1a 摘要，用于跨打开入口逐像素比较。 */
  readonly digest: string;
}

/**
 * 统计画布非白像素并计算像素摘要。
 *
 * @param target 渲染结果。
 * @returns 尺寸、墨迹与摘要。
 */
export function canvasStats(target: TestCanvas): CanvasStats {
  const context = target.context as unknown as {
    getImageData(x: number, y: number, width: number, height: number): {
      data: Uint8ClampedArray;
    };
  };
  const width = target.canvas.width;
  const height = target.canvas.height;
  const { data } = context.getImageData(0, 0, width, height);
  let ink = 0;
  let hash = 0x811c9dc5;
  for (let index = 0; index < data.length; index += 4) {
    const red = data[index] ?? 255;
    const green = data[index + 1] ?? 255;
    const blue = data[index + 2] ?? 255;
    if (red < 245 || green < 245 || blue < 245) ink += 1;
    hash ^= red;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= green;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= blue;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= data[index + 3] ?? 255;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return { width, height, ink, digest: hash.toString(16).padStart(8, '0') };
}

/**
 * 构造本轮独立验收用综合明文包：两页、图片、附件、签章。
 *
 * @returns OFD ZIP 字节。
 */
export function buildVerificationPackage(): Uint8Array {
  return buildFixtureOfd({
    pages: [
      {
        id: 1,
        widthMm: 120,
        heightMm: 90,
        objects: [
          {
            name: 'ofd:PathObject',
            attrs: {
              ID: 11,
              Boundary: '10 10 40 20',
              Fill: 'true',
              Stroke: 'false',
            },
            children: [
              {
                name: 'ofd:AbbreviatedData',
                children: ['M 0 0 L 40 0 L 40 20 L 0 20 Z'],
              },
              { name: 'ofd:FillColor', attrs: { Value: '0 128 255' } },
            ],
          },
          {
            name: 'ofd:ImageObject',
            attrs: { ID: 12, Boundary: '60 10 20 20', ResourceID: '20', CTM: '20 0 0 20 0 0' },
          },
        ],
      },
      { id: 2, widthMm: 100, heightMm: 100, objects: [] },
    ],
    publicRes: [
      {
        path: 'Doc_0/Res/Res.xml',
        children: [
          {
            name: 'ofd:MultiMedias',
            children: [
              {
                name: 'ofd:MultiMedia',
                attrs: { ID: 20, Type: 'Image', Format: 'PNG' },
                children: [{ name: 'ofd:MediaFile', children: ['image.png'] }],
              },
            ],
          },
        ],
      },
    ],
    documentChildren: [{ name: 'ofd:Attachments', children: ['Attachments.xml'] }],
    extraEntries: [
      { name: 'Doc_0/Res/image.png', data: createPng('#00ff00') },
      {
        name: 'Doc_0/Attachments.xml',
        data: buildXmlDocument({
          name: 'ofd:Attachments',
          attrs: { 'xmlns:ofd': OFD_NS },
          children: [
            {
              name: 'ofd:Attachment',
              attrs: { ID: '1', Name: 'note.bin' },
              children: [{ name: 'ofd:FileLoc', children: ['/Doc_0/Res/note.bin'] }],
            },
          ],
        }),
      },
      { name: 'Doc_0/Res/note.bin', data: Uint8Array.from([9, 8, 7, 6, 5]) },
      {
        name: 'Doc_0/Signs/Signatures.xml',
        data: buildXmlDocument({
          name: 'ofd:Signatures',
          attrs: { 'xmlns:ofd': OFD_NS },
          children: [
            {
              name: 'ofd:Signature',
              attrs: { ID: '1', Type: 'Seal', BaseLoc: '/Doc_0/Signs/Sign_0/Signature.xml' },
            },
          ],
        }),
      },
      {
        name: 'Doc_0/Signs/Sign_0/Signature.xml',
        data: buildXmlDocument({
          name: 'ofd:Signature',
          attrs: { 'xmlns:ofd': OFD_NS },
          children: [
            {
              name: 'ofd:SignedValue',
              children: ['/Doc_0/Signs/Sign_0/SignedValue.dat'],
            },
            {
              name: 'ofd:SignedInfo',
              children: [
                {
                  name: 'ofd:Provider',
                  attrs: { ProviderName: 'verify-provider', Company: 'QA', Version: '1.0' },
                },
                { name: 'ofd:SignatureDateTime', children: ['2026-01-02 03:04:05'] },
              ],
            },
          ],
        }),
      },
      {
        name: 'Doc_0/Signs/Sign_0/SignedValue.dat',
        data: Uint8Array.from([0x30, 0x03, 0x02, 0x01, 0x01]),
      },
    ],
  });
}

/**
 * 在 ZIP 中篡改指定条目的中央目录 CRC，用于验证 warning 透传。
 *
 * @param bytes 原始 ZIP 字节。
 * @param targetPath 需要篡改 CRC 的包内路径。
 * @returns 重新打包后的 ZIP 字节。
 */
export function withCorruptCrc(bytes: Uint8Array, targetPath: string): Uint8Array {
  const entries = readZipEntries(bytes).map((entry) => ({
    name: entry.name,
    data: entry.data,
    method: entry.method,
    ...(entry.name === targetPath ? { crcOverride: (entry.crc32 ^ 0xffffffff) >>> 0 } : {}),
  }));
  return buildZip(entries);
}

/**
 * 构造多文档包（Doc_0 / Doc_1）。
 *
 * @returns OFD ZIP 字节。
 */
export function buildMultiDocumentPackage(): Uint8Array {
  const ofdXml = buildXmlDocument({
    name: 'ofd:OFD',
    attrs: { 'xmlns:ofd': OFD_NS, DocType: 'ofd', Version: '1.3' },
    children: [
      {
        name: 'ofd:DocBody',
        children: [
          {
            name: 'ofd:DocInfo',
            children: [
              { name: 'ofd:DocID', children: ['doc-first'] },
              { name: 'ofd:Title', children: ['第一份文档'] },
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
              { name: 'ofd:DocID', children: ['doc-second'] },
              { name: 'ofd:Title', children: ['第二份文档'] },
            ],
          },
          { name: 'ofd:DocRoot', children: ['Doc_1/Document.xml'] },
        ],
      },
    ],
  });
  const secondDocument = buildXmlDocument({
    name: 'ofd:Document',
    attrs: { 'xmlns:ofd': OFD_NS, Version: '1.3' },
    children: [
      {
        name: 'ofd:Pages',
        children: [
          { name: 'ofd:Page', attrs: { ID: 7, BaseLoc: 'Pages/Page_0/Content.xml' } },
        ],
      },
    ],
  });
  const secondContent = buildXmlDocument({
    name: 'ofd:Page',
    attrs: { 'xmlns:ofd': OFD_NS },
    children: [
      {
        name: 'ofd:Area',
        children: [{ name: 'ofd:PhysicalBox', children: ['0 0 50 60'] }],
      },
      { name: 'ofd:Content', children: [{ name: 'ofd:Layer', attrs: { ID: 1 } }] },
    ],
  });
  return buildFixtureOfd({
    pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [] }],
    ofdXml,
    extraEntries: [
      { name: 'Doc_1/Document.xml', data: secondDocument },
      { name: 'Doc_1/Pages/Page_0/Content.xml', data: secondContent },
    ],
  });
}
/**
 * 在明文 ZIP 末尾追加 `Encryptions.xml`，模拟未解密加密包。
 *
 * @param bytes 明文 ZIP 字节。
 * @returns 带加密标记的 ZIP 字节。
 */
export function withEncryptionMarker(bytes: Uint8Array): Uint8Array {
  return buildZip([
    ...readZipEntries(bytes).map((entry) => ({
      name: entry.name,
      data: entry.data,
      method: entry.method,
    })),
    { name: 'Encryptions.xml', data: '<ofd:Encryptions/>' },
  ]);
}
