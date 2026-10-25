/**
 * 本地字体读取测试（设计 §1.1、§1.4、§6、REQ-0100~REQ-0160）。
 *
 * 覆盖三条实测约束：
 * - 一次声明只发起**一次** `queryLocalFonts`（首次调用约 870–950 ms，禁止逐名串行）；
 * - 浏览器返回顺序不保证等于传入顺序，必须按候选优先级重排；
 * - `denied` 与「未安装」都返回 `[]`，必须靠 `navigator.permissions` 区分。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { supportsLocalFonts, queryLocalFontFaces, queryLocalFontsPermission, readLocalFontInput } from '../../../src/local-fonts';
import type { LocalFontFace } from '../../../src/local-fonts';

/** 构造字体面替身；`blob()` 返回指定字节。 */
function makeFace(postscriptName: string, bytes = new Uint8Array([1, 2, 3])): LocalFontFace {
  return {
    postscriptName,
    fullName: `${postscriptName} Full`,
    family: `${postscriptName} Family`,
    style: 'Regular',
    blob: async () => new Blob([bytes]),
  };
}

/**
 * 安装 `queryLocalFonts` 与 `navigator.permissions` 替身。
 *
 * @param options.queryFonts `queryLocalFonts` 实现。
 * @param options.permission 权限状态；`null` 表示不安装 permissions。
 * @returns `queryFonts` 的 spy。
 */
function install(options: {
  queryFonts?: (init?: { postscriptNames?: readonly string[] }) => Promise<readonly LocalFontFace[]>;
  permission?: 'granted' | 'denied' | 'prompt' | null;
}): ReturnType<typeof vi.fn> {
  const spy = vi.fn(options.queryFonts ?? (async () => []));
  vi.stubGlobal('queryLocalFonts', spy);
  if (options.permission !== null) {
    const state = options.permission ?? 'granted';
    vi.stubGlobal('navigator', {
      permissions: {
        query: async () => ({ state }),
      },
    });
  } else {
    vi.stubGlobal('navigator', {});
  }
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('supportsLocalFonts', () => {
  it('只有存在 queryLocalFonts 函数时才视为支持', () => {
    vi.stubGlobal('queryLocalFonts', undefined);
    expect(supportsLocalFonts()).toBe(false);
    vi.stubGlobal('queryLocalFonts', async () => []);
    expect(supportsLocalFonts()).toBe(true);
  });
});

describe('queryLocalFontsPermission', () => {
  it('缺失 API 时为 unsupported', async () => {
    vi.stubGlobal('queryLocalFonts', undefined);
    await expect(queryLocalFontsPermission()).resolves.toBe('unsupported');
  });

  it('permissions 返回 granted / denied 时如实上报', async () => {
    install({ permission: 'granted' });
    await expect(queryLocalFontsPermission()).resolves.toBe('granted');
    install({ permission: 'denied' });
    await expect(queryLocalFontsPermission()).resolves.toBe('denied');
  });

  it('permissions 抛错或不可用时回落 prompt，不得回落 denied', async () => {
    vi.stubGlobal('queryLocalFonts', async () => []);
    vi.stubGlobal('navigator', {
      permissions: {
        query: async () => {
          throw new TypeError("'local-fonts' is not a valid PermissionName");
        },
      },
    });
    await expect(queryLocalFontsPermission()).resolves.toBe('prompt');

    vi.stubGlobal('navigator', {});
    await expect(queryLocalFontsPermission()).resolves.toBe('prompt');
  });
});

describe('queryLocalFontFaces 单次定向查询', () => {
  it('一组候选名只发起一次 queryLocalFonts 调用', async () => {
    const spy = install({
      permission: 'granted',
      queryFonts: async () => [makeFace('SimHei')],
    });
    await queryLocalFontFaces(['SimSun', 'SimSun-Bold', 'SimHei']);
    // 首次调用开销约 870–950 ms，逐名串行会把开销成倍放大。
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toEqual({
      postscriptNames: ['SimSun', 'SimSun-Bold', 'SimHei'],
    });
  });

  it('浏览器乱序返回时按候选优先级重排', async () => {
    install({
      permission: 'granted',
      // 故意倒序返回，模拟浏览器不保证顺序。
      queryFonts: async () => [makeFace('MicrosoftYaHei'), makeFace('SimSun')],
    });
    const result = await queryLocalFontFaces(['SimSun', 'SimSun-Bold', 'MicrosoftYaHei']);
    expect(result.faces.map((hit) => hit.name)).toEqual(['SimSun', 'MicrosoftYaHei']);
    expect(result.state).toBe('granted');
    expect(result.triedNames).toEqual(['SimSun', 'SimSun-Bold', 'MicrosoftYaHei']);
  });

  it('候选为空时不发起调用（避免首次初始化开销）', async () => {
    const spy = install({ permission: 'granted' });
    const result = await queryLocalFontFaces([]);
    expect(spy).not.toHaveBeenCalled();
    expect(result.faces).toEqual([]);
    expect(result.triedNames).toEqual([]);
  });

  it('denied 与 unsupported 不发调用且 faces 为空，靠 state 区分而非当作未安装', async () => {
    const spy = install({ permission: 'denied' });
    const denied = await queryLocalFontFaces(['SimSun']);
    expect(spy).not.toHaveBeenCalled();
    expect(denied.state).toBe('denied');
    expect(denied.faces).toEqual([]);

    vi.stubGlobal('queryLocalFonts', undefined);
    const unsupported = await queryLocalFontFaces(['SimSun']);
    expect(unsupported.state).toBe('unsupported');
    expect(unsupported.faces).toEqual([]);
  });

  it('本机未安装时 faces 为空但状态仍是 granted', async () => {
    install({ permission: 'granted', queryFonts: async () => [] });
    const result = await queryLocalFontFaces(['SimSun']);
    expect(result.state).toBe('granted');
    expect(result.faces).toEqual([]);
  });

  it('无用户手势的 SecurityError 不抛出，状态回落 prompt', async () => {
    install({
      permission: 'prompt',
      queryFonts: async () => {
        const error = new Error('User activation is required.');
        error.name = 'SecurityError';
        throw error;
      },
    });
    const result = await queryLocalFontFaces(['SimSun']);
    expect(result.faces).toEqual([]);
    expect(result.state).toBe('prompt');
  });

  it('signal 已中止时不发起调用', async () => {
    const spy = install({ permission: 'granted', queryFonts: async () => [makeFace('SimSun')] });
    const controller = new AbortController();
    controller.abort();
    const result = await queryLocalFontFaces(['SimSun'], { signal: controller.signal });
    expect(spy).not.toHaveBeenCalled();
    expect(result.faces).toEqual([]);
  });
});

describe('readLocalFontInput', () => {
  it('经 compat.readBlobBytes 读取字节，family 取调用方给出的声明名', async () => {
    const input = await readLocalFontInput(makeFace('SimSun', new Uint8Array([9, 8, 7])), '宋体');
    expect(input?.family).toBe('宋体');
    expect(input?.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(input?.data as Uint8Array)).toEqual([9, 8, 7]);
  });

  it('未给出 family 时退回字体面自身的 family', async () => {
    const input = await readLocalFontInput(makeFace('SimSun'));
    expect(input?.family).toBe('SimSun Family');
  });

  it('空字体文件返回 undefined（跳过该字体面）', async () => {
    const face = makeFace('SimSun');
    await expect(
      readLocalFontInput({ ...face, blob: async () => new Blob([]) }),
    ).resolves.toBeUndefined();
  });
});
