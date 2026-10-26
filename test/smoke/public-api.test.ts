/**
 * 公共 API smoke 测试。
 *
 * 只验证 T1 冻结的导出形状与少量纯函数/工具行为，不测试业务渲染。
 */

import { describe, expect, it } from 'vitest';
import * as engine from '@ofdrw/ofdrw-viewer-engine';
import {
  DEFAULT_CACHE_OPTIONS,
  DEFAULT_RESOURCE_LIMITS,
  WarningCollector,
} from '@ofdrw/ofdrw-viewer-engine';

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