/**
 * `FontSourceResolver` 的 `{ local }` 来源测试（设计 §3.1、§6.2，REQ-0170/0180，§10 T-R1~T-R6）。
 *
 * 桩化 `window.queryLocalFonts` 与 `navigator.permissions.query`：断言查询是**定向**的
 * （一次声明一次调用、实参恒为 `{ postscriptNames }`）、命中后 `FontInput.family` 取文档
 * 声明名、权限失败静默、关开关清缓存、中止不写结果。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FONT_ALIASES } from '@ofdrw/ofdrw-viewer-engine';
import { FontSourceResolver, type FontSource } from '../../../src/font';

/** 字体字节（非空即可，resolver 不解析内容）。 */
const FONT_BYTES = new Uint8Array([0, 1, 0, 0, 0, 10]);

/**
 * 构造 `FontData` 结构替身。
 *
 * @param postscriptName PostScript 名。
 * @param bytes 字节；空数组模拟空字体文件。
 * @returns 仅含查询所需字段的替身。
 */
function makeFontData(postscriptName: string, bytes: Uint8Array = FONT_BYTES) {
  return {
    postscriptName,
    fullName: postscriptName,
    family: postscriptName,
    style: 'Regular',
    blob: vi.fn(async () => new Blob([bytes as unknown as BlobPart])),
  };
}

/**
 * 安装 `queryLocalFonts` 替身（大小写敏感精确匹配，与 Chrome 一致）。
 *
 * @param installed 已安装字体：PostScript 名 → 字节。
 * @returns 查询替身，可直接断言调用次数与实参。
 */
function stubLocalFonts(installed: Record<string, Uint8Array | undefined>) {
  const query = vi.fn(async (options?: { postscriptNames?: readonly string[] }) => {
    const names = options?.postscriptNames ?? [];
    return names
      .filter((name) => installed[name] !== undefined)
      .map((name) => makeFontData(name, installed[name]));
  });
  vi.stubGlobal('queryLocalFonts', query);
  return query;
}

/**
 * 安装权限查询替身。
 *
 * @param state `granted` / `denied` / `prompt`。
 * @returns 权限查询替身。
 */
function stubPermissions(state: 'granted' | 'denied' | 'prompt') {
  const query = vi.fn(async () => ({ state, onchange: null }));
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    writable: true,
    value: { query },
  });
  return query;
}

/**
 * 构造已开启本地字体的 resolver。
 *
 * @param options.enabled 开关初值；默认开启。
 * @returns resolver。
 */
function makeResolver(options: { enabled?: boolean } = {}): FontSourceResolver {
  return new FontSourceResolver({ localFonts: { enabled: options.enabled ?? true } });
}

/** 以中文字体名声明一个 `{ local }` 来源。 */
function localSource(fontName: string, family?: string): FontSource {
  return { local: { fontName }, ...(family ? { family } : {}) } as unknown as FontSource;
}

beforeEach(() => {
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    writable: true,
    value: undefined,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('FontSourceResolver { local } 查询（T-R1~T-R4）', () => {
  it('T-R1 未启用时 { local } 被跳过并回调 onError，不发起任何查询', async () => {
    const query = stubLocalFonts({ SimSun: FONT_BYTES });
    stubPermissions('granted');
    const resolver = makeResolver({ enabled: false });
    const errors: unknown[] = [];
    const inputs = await resolver.resolve([localSource('宋体')], undefined, (_source, error) =>
      errors.push(error),
    );
    expect(inputs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(query, 'enabled=false 时调用次数必须为 0').not.toHaveBeenCalled();
  });

  it('T-R2 桩化 queryLocalFonts 命中：产出 FontInput，family 为文档声明名', async () => {
    const query = stubLocalFonts({ SimSun: FONT_BYTES });
    stubPermissions('granted');
    const resolver = makeResolver();
    const errors: unknown[] = [];
    const inputs = await resolver.resolve([localSource('宋体')], undefined, (_s, error) =>
      errors.push(error),
    );
    expect(errors).toEqual([]);
    expect(inputs).toHaveLength(1);
    // F6：family 取文档声明的 FontName，不是本机字体的 family。
    expect(inputs[0]?.family).toBe('宋体');
    expect(inputs[0]?.data.byteLength).toBe(FONT_BYTES.byteLength);
    // 定向查询：实参恒为 { postscriptNames }，一次声明只调用一次。
    expect(query).toHaveBeenCalledTimes(1);
    const options = query.mock.calls[0]?.[0];
    expect(Object.keys(options ?? {})).toEqual(['postscriptNames']);
    expect(options?.postscriptNames).toContain('SimSun');
    // 候选全部为 ASCII，且不超过单次查询名数上限。
    expect((options?.postscriptNames ?? []).length).toBeLessThanOrEqual(6);
    expect((options?.postscriptNames ?? []).every((name) => !/[^\x00-\x7f]/.test(name))).toBe(true);
  });

  it('T-R2b 一次声明只发起一次调用，候选整批传入', async () => {
    // 变体词写在文档声明里（不是来源 family），只有第二个候选存在。
    const query = stubLocalFonts({ SimSunBold: FONT_BYTES });
    stubPermissions('granted');
    const resolver = makeResolver();
    const inputs = await resolver.resolve(
      [{ local: { fontName: '宋体 Bold' } } as unknown as FontSource],
      undefined,
      () => undefined,
    );
    expect(inputs).toHaveLength(1);
    expect(query, '一次声明一次调用').toHaveBeenCalledTimes(1);
    // 命中的是中英混排声明：family 仍取文档声明名。
    expect(inputs[0]?.family).toBe('宋体 Bold');
    const names = query.mock.calls[0]?.[0]?.postscriptNames ?? [];
    expect(names).toContain('SimSunBold');
  });

  it('T-R2c 命中多个候选时只取优先级最高的那一个', async () => {
    // 基础名与变体名都“安装”了：应取候选顺序里靠前的那一个（变体在基础名之前）。
    stubLocalFonts({ SimSun: new Uint8Array([0, 0, 0]), 'SimSun-Bold': new Uint8Array([9, 9]) });
    stubPermissions('granted');
    const resolver = makeResolver();
    const inputs = await resolver.resolve(
      [{ local: { fontName: '宋体 Bold' } } as unknown as FontSource],
      undefined,
      () => undefined,
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.data.byteLength).toBe(2);
  });

  it('T-R3 本机未安装时跳过并回调 onError，查询确实发生过', async () => {
    const query = stubLocalFonts({});
    stubPermissions('prompt');
    const resolver = makeResolver();
    const errors: unknown[] = [];
    const inputs = await resolver.resolve([localSource('宋体')], undefined, (_s, error) =>
      errors.push(error),
    );
    expect(inputs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('T-R4 NotAllowedError 与 SecurityError 静默：不抛到宿主，只走 onError', async () => {
    for (const name of ['NotAllowedError', 'SecurityError']) {
      const error = new Error('权限不足');
      error.name = name;
      vi.stubGlobal('queryLocalFonts', vi.fn(async () => Promise.reject(error)));
      stubPermissions('prompt');
      const resolver = makeResolver();
      const reported: unknown[] = [];
      const inputs = await resolver.resolve([localSource('宋体')], undefined, (_s, caught) =>
        reported.push(caught),
      );
      expect(inputs, name).toEqual([]);
      expect(reported, name).toHaveLength(1);
    }
  });

  it('denied 权限态：不发起查询，直接跳过并回调 onError', async () => {
    const query = stubLocalFonts({ SimSun: FONT_BYTES });
    stubPermissions('denied');
    const resolver = makeResolver();
    const errors: unknown[] = [];
    const inputs = await resolver.resolve([localSource('宋体')], undefined, (_s, error) =>
      errors.push(error),
    );
    expect(inputs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(query, '权限已拒绝时不得再查询').not.toHaveBeenCalled();
  });

  it('浏览器不支持时跳过并回调 onError，不产生未捕获异常', async () => {
    vi.stubGlobal('queryLocalFonts', undefined);
    stubPermissions('granted');
    const resolver = makeResolver();
    const errors: unknown[] = [];
    const inputs = await resolver.resolve([localSource('宋体')], undefined, (_s, error) =>
      errors.push(error),
    );
    expect(inputs).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('来源自带 family 时覆盖声明名', async () => {
    stubLocalFonts({ SimSun: FONT_BYTES });
    stubPermissions('granted');
    const resolver = makeResolver();
    const inputs = await resolver.resolve([localSource('宋体', '自定义族名')], undefined, () => undefined);
    expect(inputs[0]?.family).toBe('自定义族名');
  });

  it('宿主直接写 PostScript 名时按原样查询（大小写敏感）', async () => {
    const query = stubLocalFonts({ 'FZSTK--GBK1-0': FONT_BYTES });
    stubPermissions('granted');
    const resolver = makeResolver();
    const inputs = await resolver.resolve(
      [{ local: 'FZSTK--GBK1-0' } as unknown as FontSource],
      undefined,
      () => undefined,
    );
    expect(inputs).toHaveLength(1);
    expect(query.mock.calls[0]?.[0]?.postscriptNames).toContain('FZSTK--GBK1-0');
  });

  it('local 为空字符串或空数组时回调 onError 且不查询', async () => {
    const query = stubLocalFonts({ SimSun: FONT_BYTES });
    stubPermissions('granted');
    const resolver = makeResolver();
    const errors: unknown[] = [];
    const inputs = await resolver.resolve(
      [{ local: '' }, { local: [] }] as unknown as FontSource[],
      undefined,
      (_s, error) => errors.push(error),
    );
    expect(inputs).toEqual([]);
    expect(errors).toHaveLength(2);
    expect(query).not.toHaveBeenCalled();
  });

  it('空字体文件（blob 为空）按读取失败处理', async () => {
    vi.stubGlobal(
      'queryLocalFonts',
      vi.fn(async () => [makeFontData('SimSun', new Uint8Array(0))]),
    );
    stubPermissions('granted');
    const resolver = makeResolver();
    const errors: unknown[] = [];
    const inputs = await resolver.resolve([localSource('宋体')], undefined, (_s, error) =>
      errors.push(error),
    );
    expect(inputs).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('内置别名参与候选展开：中文声明查询的是真实 PostScript 写法', async () => {
    const query = stubLocalFonts({ SimSun: FONT_BYTES });
    stubPermissions('granted');
    const resolver = new FontSourceResolver({
      localFonts: { enabled: true, aliases: DEFAULT_FONT_ALIASES },
    });
    await resolver.resolve([localSource('宋体')], undefined, () => undefined);
    const names = query.mock.calls[0]?.[0]?.postscriptNames ?? [];
    expect(names[0]).toBe('SimSun');
    expect(names).not.toContain('Simsun');
    expect(names).not.toContain('宋体');
  });
});

describe('FontSourceResolver { local } 缓存与取消（T-R5、T-R6）', () => {
  it('T-R5 关开关清空缓存：再次开启会重新查询', async () => {
    const query = stubLocalFonts({ SimSun: FONT_BYTES });
    stubPermissions('granted');
    const resolver = makeResolver();
    const source = localSource('宋体');
    expect(await resolver.resolve([source], undefined, () => undefined)).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(1);

    // 同一文档重开不重复查询（实例级缓存）。
    expect(await resolver.resolve([source], undefined, () => undefined)).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(1);

    // 关闭再开启：缓存被清空，必须重新查询。
    resolver.setLocalFontsEnabled(false);
    resolver.setLocalFontsEnabled(true);
    expect(await resolver.resolve([source], undefined, () => undefined)).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('T-R5b 关闭开关后同一来源被跳过且不再查询', async () => {
    const query = stubLocalFonts({ SimSun: FONT_BYTES });
    stubPermissions('granted');
    const resolver = makeResolver();
    const source = localSource('宋体');
    await resolver.resolve([source], undefined, () => undefined);
    resolver.setLocalFontsEnabled(false);
    const errors: unknown[] = [];
    const inputs = await resolver.resolve([source], undefined, (_s, error) => errors.push(error));
    expect(inputs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('T-R5c 未安装（空结果）被缓存，重开不重复查询', async () => {
    const query = stubLocalFonts({});
    stubPermissions('granted');
    const resolver = makeResolver();
    const source = localSource('宋体');
    await resolver.resolve([source], undefined, () => undefined);
    await resolver.resolve([source], undefined, () => undefined);
    expect(query, '未安装结果应命中缓存').toHaveBeenCalledTimes(1);
  });

  it('prompt 未授权（空结果）不缓存：下一次 resolve 重新查询（C12）', async () => {
    const query = stubLocalFonts({});
    stubPermissions('prompt');
    const resolver = makeResolver();
    const source = localSource('宋体');
    await resolver.resolve([source], undefined, () => undefined);
    await resolver.resolve([source], undefined, () => undefined);
    // 权限是可变用户决定：未授权不写缓存，允许用户授权后立即恢复。
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('T-R6 signal 中止不写入结果', async () => {
    let resolveQuery: ((value: unknown[]) => void) | undefined;
    const query = vi.fn(
      () =>
        new Promise<unknown[]>((resolve) => {
          resolveQuery = resolve;
        }),
    );
    vi.stubGlobal('queryLocalFonts', query);
    stubPermissions('granted');
    const resolver = makeResolver();
    const controller = new AbortController();
    const source = localSource('宋体');
    const pending = resolver.resolve([source], controller.signal, () => undefined);
    controller.abort();
    resolveQuery?.([makeFontData('SimSun')]);
    expect(await pending).toEqual([]);

    // 中止不写缓存：下一次 resolve 需要重新查询。
    stubLocalFonts({ SimSun: FONT_BYTES });
    const after = await resolver.resolve([source], undefined, () => undefined);
    expect(after).toHaveLength(1);
  });

  it('dispose() 之后不再读取本地字体', async () => {
    const query = stubLocalFonts({ SimSun: FONT_BYTES });
    stubPermissions('granted');
    const resolver = makeResolver();
    const source = localSource('宋体');
    await resolver.resolve([source], undefined, () => undefined);
    resolver.dispose();
    const inputs = await resolver.resolve([source], undefined, () => undefined);
    expect(inputs).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
