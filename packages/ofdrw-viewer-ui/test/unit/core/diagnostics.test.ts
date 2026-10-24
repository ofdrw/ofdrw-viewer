/**
 * 诊断体系纯函数与打印机的单测（无 DOM 依赖）。
 *
 * 覆盖码表唯一性、码→级别映射缺省值、格式化输出、过滤先于去重、去重键与打印通道。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  DiagnosticPrinter,
  UI_WARNING_CODES,
  UI_WARNING_LEVELS,
  formatDiagnostic,
  resolveDiagnosticLevel,
  type ViewerDiagnostic,
} from '../../../src/diagnostics';

/**
 * 构造一条诊断。
 *
 * @param patch 覆盖字段。
 * @returns 归一化后的诊断。
 */
function makeDiagnostic(patch: Partial<ViewerDiagnostic> = {}): ViewerDiagnostic {
  return {
    code: 'W_GLYPH_MISSING',
    level: 'warn',
    message: '缺字',
    source: 'ui',
    ...patch,
  };
}

let warnSpy: MockInstance<typeof console.warn>;
let errorSpy: MockInstance<typeof console.error>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UI_WARNING_CODES', () => {
  it('码表冻结且无重复', () => {
    expect(Object.isFrozen(UI_WARNING_CODES)).toBe(true);
    const codes = Object.values(UI_WARNING_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.length).toBeGreaterThan(20);
  });

  it('全部以 W_ 开头，且不含引擎码 W_ORDER', () => {
    for (const code of Object.values(UI_WARNING_CODES)) expect(code.startsWith('W_')).toBe(true);
    expect(Object.values(UI_WARNING_CODES)).not.toContain('W_ORDER');
  });

  it('包含仓库实际使用的 UI 码，且不含引擎码', () => {
    const codes = Object.values(UI_WARNING_CODES);
    for (const code of [
      UI_WARNING_CODES.W_METADATA,
      UI_WARNING_CODES.W_OUTLINE,
      UI_WARNING_CODES.W_BOOKMARKS,
      UI_WARNING_CODES.W_NAV_DEST,
      UI_WARNING_CODES.W_THUMBNAIL,
      UI_WARNING_CODES.W_TEXT_UNSUPPORTED,
      UI_WARNING_CODES.W_FIND_FAILED,
      UI_WARNING_CODES.W_EXPORT_PARTIAL,
      UI_WARNING_CODES.W_SIGNATURE_ASN1,
      UI_WARNING_CODES.W_ATTACHMENT_RESOURCE,
      UI_WARNING_CODES.W_CRYPTO_VERIFY_FAILED,
      UI_WARNING_CODES.W_UI_LISTENER,
      UI_WARNING_CODES.W_QUERY_SOURCE,
      UI_WARNING_CODES.W_CANVAS_LIMIT,
    ]) {
      expect(codes).toContain(code);
    }
    // 引擎码不属于 UI 表。
    expect(codes).not.toContain('W_FONT_MISSING');
    expect(codes).not.toContain('W_GLYPH_MISSING');
  });
});

describe('级别映射', () => {
  it('未登记的码按 warn（含引擎/crypto 码与未知码）', () => {
    expect(resolveDiagnosticLevel('W_GLYPH_MISSING')).toBe('warn');
    expect(resolveDiagnosticLevel('W_CRYPTO_TRUST_UNKNOWN')).toBe('warn');
    expect(resolveDiagnosticLevel('W_NOT_REGISTERED')).toBe('warn');
    expect(UI_WARNING_LEVELS.W_GLYPH_MISSING).toBeUndefined();
  });

  it('映射冻结且登记值只允许 info/warn/error', () => {
    expect(Object.isFrozen(UI_WARNING_LEVELS)).toBe(true);
    for (const level of Object.values(UI_WARNING_LEVELS)) {
      expect(['info', 'warn', 'error']).toContain(level);
    }
  });
});

describe('formatDiagnostic', () => {
  it('label 为 [ofd-viewer] <level> <code>，context 只含 pageIndex/resourceId', () => {
    expect(
      formatDiagnostic(
        makeDiagnostic({ code: 'W_FONT_MISSING', pageIndex: 0, resourceId: '3' }),
      ),
    ).toEqual({
      label: '[ofd-viewer] warning W_FONT_MISSING',
      message: '缺字',
      context: { pageIndex: 0, resourceId: '3' },
    });
    expect(formatDiagnostic(makeDiagnostic({ level: 'error', code: 'OFD_OPEN_FAILED' }))).toEqual({
      label: '[ofd-viewer] error OFD_OPEN_FAILED',
      message: '缺字',
      context: {},
    });
  });
});

describe('DiagnosticPrinter', () => {
  it('warning 走 console.warn、error 走 console.error，保留三参数形式', () => {
    const printer = new DiagnosticPrinter();
    printer.print(makeDiagnostic({ code: 'W_METADATA', message: '大纲读取失败' }));
    printer.print(makeDiagnostic({ level: 'error', code: 'OFD_OPEN_FAILED', pageIndex: 1 }));

    expect(warnSpy).toHaveBeenCalledWith('[ofd-viewer] warning W_METADATA', '大纲读取失败', {});
    expect(errorSpy).toHaveBeenCalledWith('[ofd-viewer] error OFD_OPEN_FAILED', '缺字', {
      pageIndex: 1,
    });
  });

  it('info 默认不打印，levels 显式包含时按 console.warn 打印', () => {
    new DiagnosticPrinter().print(makeDiagnostic({ level: 'info', code: 'W_INFO' }));
    expect(warnSpy).not.toHaveBeenCalled();

    new DiagnosticPrinter({ levels: ['info'] }).print(
      makeDiagnostic({ level: 'info', code: 'W_INFO' }),
    );
    expect(warnSpy).toHaveBeenCalledWith('[ofd-viewer] info W_INFO', '缺字', {});
  });

  it('过滤先于去重：被 codes 过滤的诊断不占用去重键', () => {
    const diagnostic = makeDiagnostic({ code: 'W_GLYPH_MISSING', pageIndex: 0 });
    new DiagnosticPrinter({ codes: ['W_FONT_MISSING'] }).print(diagnostic);
    new DiagnosticPrinter({ codes: ['W_FONT_MISSING'] }).print(diagnostic);
    expect(warnSpy).not.toHaveBeenCalled();

    // 放行该码的独立实例对同一诊断仍会打印（说明过滤实例没有占用共享状态，且键未被污染）。
    new DiagnosticPrinter().print(diagnostic);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toBe('[ofd-viewer] warning W_GLYPH_MISSING');
  });

  it('过滤先于去重：levels 过滤的诊断不占用去重键', () => {
    const printer = new DiagnosticPrinter({ levels: ['warn'] });
    const errorDiagnostic = makeDiagnostic({ level: 'error', code: 'OFD_RENDER_FAILED', pageIndex: 0 });
    printer.print(errorDiagnostic);
    expect(errorSpy).not.toHaveBeenCalled();

    // 放行 error 的独立实例第一次打印即生效（前者的过滤没有写入共享去重集合）。
    new DiagnosticPrinter({ levels: ['error'] }).print(errorDiagnostic);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('同一 code+page+resource 只打印一次；page/resource 不同分别打印', () => {
    const printer = new DiagnosticPrinter();
    printer.print(makeDiagnostic({ pageIndex: 0, resourceId: 'a' }));
    printer.print(makeDiagnostic({ pageIndex: 0, resourceId: 'a' }));
    printer.print(makeDiagnostic({ pageIndex: 0, resourceId: 'b' }));
    printer.print(makeDiagnostic({ pageIndex: 1, resourceId: 'a' }));
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  it('error 去重键只用 code+pageIndex，不按 resourceId 细分', () => {
    const printer = new DiagnosticPrinter();
    printer.print(makeDiagnostic({ level: 'error', pageIndex: 0, resourceId: 'a' }));
    printer.print(makeDiagnostic({ level: 'error', pageIndex: 0, resourceId: 'b' }));
    printer.print(makeDiagnostic({ level: 'error', pageIndex: 1, resourceId: 'a' }));
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it('reset() 清空去重集合', () => {
    const printer = new DiagnosticPrinter();
    const diagnostic = makeDiagnostic({ pageIndex: 0 });
    printer.print(diagnostic);
    printer.print(diagnostic);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    printer.reset();
    printer.print(diagnostic);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('console=false 时完全不打印', () => {
    const printer = new DiagnosticPrinter({ console: false });
    printer.print(makeDiagnostic());
    printer.print(makeDiagnostic({ level: 'error', code: 'OFD_OPEN_FAILED' }));
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
