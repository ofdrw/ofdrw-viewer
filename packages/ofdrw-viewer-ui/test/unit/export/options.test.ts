/**
 * 范围解析、自动 DPI、旋转尺寸与文件名工具测试。
 */

import { describe, expect, it } from 'vitest';
import {
  AUTO_DPI_LARGE,
  AUTO_DPI_MEDIUM,
  AUTO_DPI_SMALL,
  computeOutputSize,
  normalizePageNumber,
  parseRangeText,
  resolveAutoDpi,
  resolveBackground,
  resolveDpi,
  resolveImageFormat,
  resolvePageRange,
  resolveQuality,
} from '../../../src/export/options';
import {
  buildImageFilename,
  buildZipFilename,
  extensionForFormat,
  sanitizeFileName,
  uniqueEntryName,
} from '../../../src/export/filename';
import { isOFDViewerError } from '../../../src/errors';

/** 断言调用抛出指定错误码的 OFDViewerError。 */
function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error('应当抛出');
  } catch (error) {
    expect(isOFDViewerError(error)).toBe(true);
    expect((error as { code: string }).code).toBe(code);
  }
}

describe('页码范围解析', () => {
  it('current 解析为当前页，all 解析为全部页', () => {
    expect(resolvePageRange('current', 3, 10)).toEqual([3]);
    expect(resolvePageRange('all', 3, 4)).toEqual([1, 2, 3, 4]);
    expect(resolvePageRange(undefined, 2, 5)).toEqual([2]);
  });

  it('{from,to} 为 1-based 闭区间', () => {
    expect(resolvePageRange({ from: 2, to: 4 }, 1, 10)).toEqual([2, 3, 4]);
    expect(resolvePageRange({ from: 5, to: 5 }, 1, 10)).toEqual([5]);
  });

  it('数组去重并升序', () => {
    expect(resolvePageRange([5, 2, 2, 9], 1, 10)).toEqual([2, 5, 9]);
  });

  it('自定义范围文本支持 1-3,5、-3、5-', () => {
    expect(resolvePageRange('1-3,5', 1, 10)).toEqual([1, 2, 3, 5]);
    expect(parseRangeText('-3', 10)).toEqual([1, 2, 3]);
    expect(parseRangeText('8-', 10)).toEqual([8, 9, 10]);
    expect(parseRangeText('3，4、5', 10)).toEqual([3, 4, 5]);
  });

  it('非法范围报 OFD_INVALID_OPTION', () => {
    const cases: Array<() => unknown> = [
      () => resolvePageRange({ from: 0, to: 3 }, 1, 10),
      () => resolvePageRange({ from: 4, to: 3 }, 1, 10),
      () => resolvePageRange({ from: 1, to: 11 }, 1, 10),
      () => resolvePageRange([1, 11], 1, 10),
      () => resolvePageRange([], 1, 10),
      () => resolvePageRange('abc', 1, 10),
      () => resolvePageRange('0-2', 1, 10),
      () => resolvePageRange('5-3', 1, 10),
      () => resolvePageRange('1-11', 1, 10),
    ];
    for (const run of cases) {
      try {
        run();
        throw new Error('应当抛出');
      } catch (error) {
        expect(isOFDViewerError(error)).toBe(true);
        expect((error as { code: string }).code).toBe('OFD_INVALID_OPTION');
      }
    }
  });

  it('未打开文档时报 OFD_NOT_OPENED', () => {
    expectCode(() => resolvePageRange('all', 1, 0), 'OFD_NOT_OPENED');
  });

  it('单页页码越界报 OFD_INVALID_PAGE', () => {
    expectCode(() => normalizePageNumber(0, 3), 'OFD_INVALID_PAGE');
    expect(normalizePageNumber(2, 3)).toBe(2);
  });
});

describe('自适应 DPI', () => {
  it('≤50 页 200，51–200 页 150，>200 页 96', () => {
    expect(resolveAutoDpi(1)).toBe(AUTO_DPI_SMALL);
    expect(resolveAutoDpi(50)).toBe(200);
    expect(resolveAutoDpi(51)).toBe(AUTO_DPI_MEDIUM);
    expect(resolveAutoDpi(200)).toBe(150);
    expect(resolveAutoDpi(201)).toBe(AUTO_DPI_LARGE);
    expect(resolveAutoDpi(1000)).toBe(96);
  });

  it('显式 DPI 覆盖自动值，非法 DPI 报错', () => {
    expect(resolveDpi(300, 1000)).toBe(300);
    expect(resolveDpi('auto', 80)).toBe(150);
    expectCode(() => resolveDpi(0, 1), 'OFD_INVALID_OPTION');
    expectCode(() => resolveDpi(-96, 1), 'OFD_INVALID_OPTION');
  });

  it('格式、质量与背景规则', () => {
    expect(resolveImageFormat(undefined)).toBe('png');
    expect(resolveImageFormat('jpeg')).toBe('jpeg');
    expectCode(() => resolveImageFormat('gif' as never), 'OFD_INVALID_OPTION');
    expect(resolveQuality(undefined)).toBe(0.92);
    expect(resolveQuality(0.5)).toBe(0.5);
    expectCode(() => resolveQuality(1.2), 'OFD_INVALID_OPTION');
    expect(resolveBackground(null, 'png')).toBeNull();
    expect(resolveBackground(undefined, 'png')).toBe('#ffffff');
    expect(resolveBackground('#000000', 'png')).toBe('#000000');
    expect(resolveBackground(null, 'jpeg')).toBe('#ffffff');
    expect(resolveBackground('#000000', 'webp')).toBe('#ffffff');
  });
});

describe('旋转尺寸', () => {
  it('90/270 交换宽高，0/180 保持', () => {
    const natural = computeOutputSize(210, 297, 96, 0);
    expect(natural).toEqual({ width: 794, height: 1123 });
    expect(computeOutputSize(210, 297, 96, 90)).toEqual({
      width: natural.height,
      height: natural.width,
    });
    expect(computeOutputSize(210, 297, 96, 180)).toEqual(natural);
    expect(computeOutputSize(210, 297, 96, 270)).toEqual({
      width: natural.height,
      height: natural.width,
    });
  });
});

describe('导出文件名', () => {
  it('清洗非法字符并避免空名', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(sanitizeFileName('  ..标题..  ')).toBe('标题');
    expect(sanitizeFileName('   ')).toBe('');
  });

  it('单页文件名包含页码，自定义名覆盖默认', () => {
    expect(
      buildImageFilename({ documentName: '合同', pageNumber: 3, format: 'png' }),
    ).toBe('合同-p3.png');
    expect(
      buildImageFilename({ documentName: '合同', pageNumber: 3, format: 'jpeg' }),
    ).toBe('合同-p3.jpg');
    expect(
      buildImageFilename({
        documentName: '合同',
        pageNumber: 3,
        format: 'webp',
        customName: '封面',
      }),
    ).toBe('封面.webp');
    expect(extensionForFormat('jpeg')).toBe('jpg');
  });

  it('ZIP 文件名与内部重名处理', () => {
    expect(buildZipFilename({ documentName: '合同' })).toBe('合同-images.zip');
    expect(buildZipFilename({ documentName: '合同', customName: '导出.zip' })).toBe('导出.zip');
    expect(buildZipFilename({ documentName: '合同', customName: '导出' })).toBe('导出.zip');
    const used = new Set<string>(['合同-p1.png']);
    expect(uniqueEntryName('合同-p1.png', used)).toBe('合同-p1-2.png');
  });
});