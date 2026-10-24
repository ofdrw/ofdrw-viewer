/**
 * 页面查询参数预览集成测试：file/base64 打开、warning、source 优先级、无来源拒绝，
 * 以及与 updateHash 的共存。
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
import type { OFDOpenOptions } from '@ofdrw/ofdrw-viewer-engine';
import { OFDViewer, readPreviewSourceFromLocation } from '../../src/index';
import { OFDViewerError } from '../../src/errors';
import { installDomEnvironment } from '../helpers/environment';
import { createMockDocument } from '../helpers/document';
import { UI_WARNING_CODES } from '../../src/diagnostics';

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

/** 最小 HEAD 响应。 */
function headResponse(contentLength: number): Response {
  return {
    status: 200,
    ok: true,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-length' ? String(contentLength) : null,
    },
    body: null,
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

/** 安装 fetch 替身并返回调用次数。 */
function installFetch(): { calls: number } {
  const record = { calls: 0 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      record.calls += 1;
      return headResponse(1024);
    }),
  );
  return record;
}

/** 设置页面地址（仅 path/search/hash，同源）。 */
function setPageUrl(search: string, hash = ''): void {
  window.history.replaceState({}, '', `/${search}${hash}`);
}

/** 取 engine 打开时传入的来源。 */
function engineSource(): unknown {
  const options = engineMocks.open.mock.calls[0]?.[0] as OFDOpenOptions;
  return options.source;
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
  setPageUrl('');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('查询参数预览', () => {
  it('查询参数解析函数从公共入口导出', () => {
    expect(typeof readPreviewSourceFromLocation).toBe('function');
    expect(
      readPreviewSourceFromLocation({
        href: 'https://example.com/app/',
        search: '?base64=aGVsbG8=',
      }),
    ).toBeInstanceOf(Uint8Array);
  });

  it('file 绝对地址：无显式 source 时按 URL 打开并保留 origin', async () => {
    const fetchRecord = installFetch();
    const url = 'https://cdn.example.com/docs/合同.ofd?token=secret';
    setPageUrl(`?file=${encodeURIComponent(url)}`);

    const viewer = new OFDViewer({ container: document.body });
    await viewer.ready;

    const source = engineSource() as { kind: string };
    expect(source.kind).toBe('custom');
    expect(fetchRecord.calls).toBe(1);
    expect(viewer.getState().document.origin).toEqual({
      kind: 'url',
      url: new URL(url).href,
    });
    viewer.destroy();
  });

  it('file 相对路径：以当前页面地址为 base 解析', async () => {
    installFetch();
    window.history.replaceState({}, '', '/app/index.html?file=docs%2Fa.ofd');

    const viewer = new OFDViewer({ container: document.body });
    await viewer.ready;

    expect(viewer.getState().document.origin).toEqual({
      kind: 'url',
      url: `${window.location.origin}/app/docs/a.ofd`,
    });
    viewer.destroy();
  });

  it('base64：解码为 arraybuffer 打开且不发起网络请求', async () => {
    const fetchRecord = installFetch();
    setPageUrl('?base64=aGVsbG8=');

    const viewer = new OFDViewer({ container: document.body });
    await viewer.ready;

    expect(engineSource()).toMatchObject({ kind: 'arraybuffer' });
    expect(fetchRecord.calls).toBe(0);
    expect(viewer.getState().document.origin).toBeUndefined();
    viewer.destroy();
  });

  it('file 与 base64 同时存在时优先 file 并触发 warning', async () => {
    installFetch();
    const onWarning = vi.fn();
    setPageUrl(`?file=docs%2Fa.ofd&base64=aGVsbG8=`);

    const viewer = new OFDViewer({ container: document.body, onWarning });
    await viewer.ready;

    expect(onWarning).toHaveBeenCalledWith(
      expect.objectContaining({ code: UI_WARNING_CODES.W_QUERY_SOURCE }),
    );
    expect(viewer.getState().document.origin).toEqual({
      kind: 'url',
      url: `${window.location.origin}/docs/a.ofd`,
    });
    viewer.destroy();
  });

  it('显式 source 优先于查询参数且不解析 base64', async () => {
    const fetchRecord = installFetch();
    const onWarning = vi.fn();
    setPageUrl('?base64=aGVsbG8=');
    const buffer = new Uint8Array([1, 2, 3]).buffer;

    const viewer = new OFDViewer({ container: document.body, source: buffer, onWarning });
    await viewer.ready;

    expect(engineSource()).toMatchObject({ kind: 'arraybuffer' });
    expect(onWarning).not.toHaveBeenCalled();
    expect(fetchRecord.calls).toBe(0);
    viewer.destroy();
  });

  it('无 source 且无查询参数时 ready 以 OFD_INVALID_OPTION 拒绝', async () => {
    const viewer = new OFDViewer({ container: document.body });
    await expect(viewer.ready).rejects.toMatchObject({
      code: 'OFD_INVALID_OPTION',
      name: 'OFDViewerError',
    });
    await expect(viewer.ready).rejects.toBeInstanceOf(OFDViewerError);
    expect(engineMocks.open).not.toHaveBeenCalled();
    viewer.destroy();
  });

  it('查询参数与 updateHash 的页码/缩放 hash 互不干扰', async () => {
    installFetch();
    setPageUrl(`?file=${encodeURIComponent('https://cdn.example.com/a.ofd')}`);

    const viewer = new OFDViewer({ container: document.body, updateHash: true });
    await viewer.ready;

    expect(window.location.search).toContain('file=');
    expect(window.location.search).toContain(encodeURIComponent('https://cdn.example.com/a.ofd'));
    expect(window.location.hash).toContain('page=1');
    expect(window.location.hash).toContain('zoom=');
    viewer.destroy();
  });
});