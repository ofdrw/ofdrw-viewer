/**
 * URL 来源集成测试：单次规范化、crypto 与 engine 共用字节源、origin 命名、
 * 取消与加密路径生命周期。
 *
 * 引擎与 crypto 公共 API 用可编程替身隔离；HTTP 由 fetch 替身驱动，不访问网络。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cryptoMocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  open: vi.fn(),
  verify: vi.fn(),
}));

vi.mock('@ofdrw/ofdrw-viewer-crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ofdrw/ofdrw-viewer-crypto')>();
  return {
    ...actual,
    inspect: cryptoMocks.inspect,
    openDecryptingContainer: cryptoMocks.open,
    verifyOfd: cryptoMocks.verify,
  };
});

const engineMocks = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('@ofdrw/ofdrw-viewer-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ofdrw/ofdrw-viewer-engine')>();
  return {
    ...actual,
    OFDDocument: { ...actual.OFDDocument, open: engineMocks.open },
  };
});

import type { OfdInspection } from '@ofdrw/ofdrw-viewer-crypto';
import type { ByteSource, OFDOpenOptions, VirtualContainer } from '@ofdrw/ofdrw-viewer-engine';
import { OFDViewer } from '../../src/index';
import type { HttpByteSource } from '../../src/source/http-byte-source';
import { installDomEnvironment } from '../helpers/environment';
import { createMockDocument } from '../helpers/document';

const URL_A = 'https://example.com/docs/合同.ofd?token=secret';
const URL_B = 'https://example.com/docs/附件.ofd';

/** 明文包检测结果。 */
function plainInspection(): OfdInspection {
  return {
    encrypted: false,
    packageSize: 1024,
    ofdVersion: '1.0',
    users: [],
    layers: [],
    signatures: [],
    integrityPresent: false,
    warnings: [],
  } as unknown as OfdInspection;
}

/** 加密包检测结果。 */
function encryptedInspection(): OfdInspection {
  return {
    ...plainInspection(),
    encrypted: true,
    users: [{ userName: 'user', method: 'password' }],
  } as unknown as OfdInspection;
}

/** 明文容器替身。 */
function makeContainer(close: () => Promise<void>): VirtualContainer {
  return {
    encrypted: false,
    list: async () => ['OFD.xml'],
    has: async () => true,
    stat: async () => ({ size: 8, isDirectory: false }),
    read: async () => new TextEncoder().encode('<?xml version="1.0"?><ofd:OFD/>'),
    close,
  } as unknown as VirtualContainer;
}

/** 最小 HEAD 响应。 */
function headResponse(contentLength: number): Response {
  return {
    status: 200,
    ok: true,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-length' ? String(contentLength) : null),
    },
    body: null,
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

/** fetch 请求记录。 */
interface FetchCall {
  readonly method: string;
  readonly signal: AbortSignal | undefined;
}

/** 安装 fetch 替身；HEAD 立即成功。 */
function installFetch(): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', signal: init?.signal ?? undefined });
      if (init?.signal?.aborted) throw abortError();
      return headResponse(1024);
    }),
  );
  return calls;
}

/** 创建取消错误。 */
function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

/** 从 engine 打开参数中取出本次字节源。 */
function sourceOf(options: OFDOpenOptions): HttpByteSource {
  if (options.source?.kind !== 'custom') throw new Error('期望 custom 来源');
  return options.source.source as HttpByteSource;
}

beforeEach(() => {
  document.body.innerHTML = '';
  installDomEnvironment();
  engineMocks.open.mockReset();
  engineMocks.open.mockImplementation(async () => createMockDocument({ pageCount: 1 }));
  cryptoMocks.inspect.mockReset();
  cryptoMocks.inspect.mockResolvedValue(plainInspection());
  cryptoMocks.open.mockReset();
  cryptoMocks.verify.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('URL 文档打开', () => {
  it('只规范化一次：crypto 与 engine 共用同一 HttpByteSource，且只探测一次', async () => {
    const calls = installFetch();
    const viewer = new OFDViewer({ container: document.body, source: URL_A });
    await viewer.ready;

    expect(engineMocks.open).toHaveBeenCalledTimes(1);
    const engineOptions = engineMocks.open.mock.calls[0]?.[0] as OFDOpenOptions;
    const engineSource = sourceOf(engineOptions);
    const inspectSource = cryptoMocks.inspect.mock.calls[0]?.[0] as {
      kind: string;
      source: HttpByteSource;
    };
    expect(inspectSource.kind).toBe('byte-source');
    expect(inspectSource.source).toBe(engineSource);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('HEAD');
    expect(engineOptions.signal?.aborted).toBe(false);

    expect(viewer.getState().document.origin).toEqual({ kind: 'url', url: URL_A });
    viewer.destroy();
  });

  it('取消打开会中止进行中的 HTTP 探测', async () => {
    let seenSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: string, init?: RequestInit) => {
        seenSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
        });
      }),
    );
    // crypto inspect 等待字节源就绪，确保取消发生在 HTTP 探测阶段。
    cryptoMocks.inspect.mockImplementation(async (source: { kind: string; source: ByteSource }) => {
      await source.source.ready?.();
      return plainInspection();
    });
    const viewer = new OFDViewer({ container: document.body, source: URL_A });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await viewer.close();
    // 取消是正常结束：open() 吞掉 AbortError 并回到空态。
    await expect(viewer.ready).resolves.toBeUndefined();
    expect(seenSignal?.aborted).toBe(true);
    expect(viewer.getState().document.status).toBe('closed');
    viewer.destroy();
  });

  it('加密 URL 文档关闭时先关容器再关 UI 持有的字节源，幂等且不影响 engine 明文路径', async () => {
    installFetch();
    cryptoMocks.inspect.mockResolvedValue(encryptedInspection());
    const order: string[] = [];
    const container = makeContainer(async () => {
      order.push('container');
    });
    cryptoMocks.open.mockResolvedValue({
      container,
      inspection: encryptedInspection(),
      plaintext: true,
      layers: [],
      warnings: [],
    });
    const viewer = new OFDViewer({
      container: document.body,
      source: URL_A,
      crypto: { credentials: { kind: 'password', userName: 'user', password: 'pass' } },
    });
    await viewer.ready;
    const engineOptions = engineMocks.open.mock.calls[0]?.[0] as OFDOpenOptions;
    const httpSource = sourceOf(engineOptions);
    const originalClose = httpSource.close.bind(httpSource);
    const closeSpy = vi.spyOn(httpSource, 'close').mockImplementation(async () => {
      order.push('source');
      await originalClose();
    });

    await viewer.close();
    expect(order).toEqual(['container', 'source']);
    await expect(httpSource.read(0, 1)).rejects.toMatchObject({ code: 'OFD_CLOSED' });
    // 幂等：再次关闭不抛错。
    await viewer.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    viewer.destroy();
  });

  it('切换文档时关闭上一个加密 URL 的字节源', async () => {
    installFetch();
    cryptoMocks.inspect.mockResolvedValue(encryptedInspection());
    cryptoMocks.open.mockImplementation(async () => ({
      container: makeContainer(async () => undefined),
      inspection: encryptedInspection(),
      plaintext: true,
      layers: [],
      warnings: [],
    }));
    const viewer = new OFDViewer({
      container: document.body,
      source: URL_A,
      crypto: { credentials: { kind: 'password', userName: 'user', password: 'pass' } },
    });
    await viewer.ready;
    const first = sourceOf(engineMocks.open.mock.calls[0]?.[0] as OFDOpenOptions);

    await viewer.open(URL_B);
    const second = sourceOf(engineMocks.open.mock.calls[1]?.[0] as OFDOpenOptions);
    expect(second).not.toBe(first);
    await expect(first.read(0, 1)).rejects.toMatchObject({ code: 'OFD_CLOSED' });
    await expect(second.ready()).resolves.toBeUndefined();
    viewer.destroy();
  });

  it('打开失败时关闭本次创建的字节源', async () => {
    installFetch();
    cryptoMocks.inspect.mockImplementation(async (source: { kind: string; source: ByteSource }) => {
      captured = source.source as HttpByteSource;
      throw new Error('inspect failed');
    });
    let captured: HttpByteSource | undefined;
    const viewer = new OFDViewer({ container: document.body, source: URL_A });
    await expect(viewer.ready).rejects.toMatchObject({ code: 'OFD_CRYPTO_FAILED' });
    expect(captured).toBeDefined();
    await expect(captured!.read(0, 1)).rejects.toMatchObject({ code: 'OFD_CLOSED' });
    expect(engineMocks.open).not.toHaveBeenCalled();
    viewer.destroy();
  });
});