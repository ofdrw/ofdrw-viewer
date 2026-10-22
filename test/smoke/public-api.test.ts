/**
 * 公共 API smoke 测试。
 *
 * 只验证 T1 冻结的导出形状与少量纯函数/工具行为，不测试业务渲染。
 */

import { describe, expect, it } from 'vitest';
import * as engine from 'ofdrw-viewer-engine';
import {
  DEFAULT_CACHE_OPTIONS,
  DEFAULT_DPI,
  DEFAULT_RESOURCE_LIMITS,
  MM_PER_INCH,
  OFDError,
  WarningCollector,
  getPageTransform,
  getPageViewport,
  isOFDError,
} from 'ofdrw-viewer-engine';

describe('public API surface', () => {
  it('导出 15.1 要求的公共类与函数', () => {
    expect(typeof engine.OFDDocument).toBe('function');
    expect(typeof engine.OFDPage).toBe('function');
    expect(typeof engine.RenderTask).toBe('function');
    expect(typeof engine.H5Canvas2DRenderer).toBe('function');
    expect(typeof engine.OFDError).toBe('function');
    expect(typeof engine.getPageViewport).toBe('function');
    expect(typeof engine.getPageTransform).toBe('function');
  });

  it('默认资源限制与设计方案 7.4 一致', () => {
    expect(DEFAULT_RESOURCE_LIMITS.maxPackageBytes).toBe(256 * 1024 * 1024);
    expect(DEFAULT_RESOURCE_LIMITS.maxEntries).toBe(20_000);
    expect(DEFAULT_RESOURCE_LIMITS.maxEntryBytes).toBe(64 * 1024 * 1024);
    expect(DEFAULT_RESOURCE_LIMITS.maxTotalUncompressedBytes).toBe(512 * 1024 * 1024);
    expect(DEFAULT_RESOURCE_LIMITS.maxCompressionRatio).toBe(200);
    expect(DEFAULT_RESOURCE_LIMITS.maxCanvasPixels).toBe(64_000_000);
    expect(DEFAULT_CACHE_OPTIONS.pageModels).toBe(8);
    expect(Object.isFrozen(DEFAULT_RESOURCE_LIMITS)).toBe(true);
  });

  it('viewport 与页面变换按 10.6 公式计算', () => {
    expect(DEFAULT_DPI).toBe(96);
    expect(MM_PER_INCH).toBe(25.4);
    const viewport = getPageViewport({ width: 210, height: 297 }, { dpi: 96 });
    expect(viewport.dpi).toBe(96);
    // t61 起 viewport 像素按 0.001px 归一化；A4@96 的精确归一处为 793.701/1122.52。
    expect(viewport.width).toBe(793.701);
    expect(viewport.height).toBe(1122.52);
    const matrix = getPageTransform({ x: 0, y: 0, w: 210, h: 297 }, 96);
    const scale = 96 / 25.4;
    expect(matrix[0]).toBeCloseTo(scale, 12);
    expect(matrix[3]).toBeCloseTo(scale, 12);
    expect(matrix[4]).toBe(0);
    expect(matrix[5]).toBe(0);
  });

  it('OFDError 携带 code/cause，且 isOFDError 可识别', () => {
    const cause = new Error('boom');
    const error = new OFDError('OFD_INVALID_PACKAGE', 'bad zip', { cause });
    expect(error.code).toBe('OFD_INVALID_PACKAGE');
    expect(error.cause).toBe(cause);
    expect(error.name).toBe('OFDError');
    expect(isOFDError(error)).toBe(true);
    expect(isOFDError(new Error('x'))).toBe(false);
  });

  it('WarningCollector 按 (code,page,object) 去重并转发', () => {
    const received: string[] = [];
    const collector = new WarningCollector((warning) => received.push(warning.code));
    collector.warn('W_BAD_NUMBER', 'a', { pageIndex: 0, objectId: '1' });
    collector.warn('W_BAD_NUMBER', 'b', { pageIndex: 0, objectId: '1' });
    collector.warn('W_BAD_NUMBER', 'c', { pageIndex: 1, objectId: '1' });
    expect(collector.warnings).toHaveLength(2);
    expect(received).toEqual(['W_BAD_NUMBER', 'W_BAD_NUMBER']);
    expect(engine.WARNING_CODES).toContain('W_RADIAL_UNSUPPORTED');
  });
});