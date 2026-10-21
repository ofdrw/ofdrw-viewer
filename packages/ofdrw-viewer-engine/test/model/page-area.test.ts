import { describe, expect, it, vi } from 'vitest';
import { applyPageArea, isValidPageArea, resolvePageArea } from '../../src/model/page-area';

describe('resolvePageArea', () => {
  it('页面 Area 有效时优先使用', () => {
    const onWarning = vi.fn();
    const result = resolvePageArea({
      pageArea: { x: 5, y: 6, w: 100, h: 200 },
      templateAreas: [{ id: '1', area: { x: 0, y: 0, w: 10, h: 10 } }],
      commonDataArea: { x: 0, y: 0, w: 20, h: 20 },
      onWarning,
    });
    expect(result.source).toBe('page');
    expect(result.area).toEqual({ x: 5, y: 6, w: 100, h: 200 });
    expect(result.size).toEqual({ width: 100, height: 200 });
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('页面 Area 缺失/非正时按模板引用顺序取第一个有效 Area', () => {
    const result = resolvePageArea({
      pageArea: { x: 0, y: 0, w: 0, h: 300 },
      templateAreas: [
        { id: '1', area: { x: 0, y: 0, w: 0, h: 10 } },
        { id: '2', area: { x: 1, y: 2, w: 100, h: 200 } },
        { id: '3', area: { x: 0, y: 0, w: 300, h: 400 } },
      ],
      commonDataArea: { x: 0, y: 0, w: 20, h: 20 },
    });
    expect(result.source).toBe('template');
    expect(result.templateId).toBe('2');
    expect(result.area).toEqual({ x: 0, y: 0, w: 100, h: 200 });
  });

  it('模板都没有 Area 时用 CommonData/PageArea', () => {
    const result = resolvePageArea({
      templateAreas: [{ id: '1' }],
      commonDataArea: { x: 10, y: 10, w: 50, h: 60 },
    });
    expect(result.source).toBe('common-data');
    expect(result.size).toEqual({ width: 50, height: 60 });
    expect(result.area).toEqual({ x: 0, y: 0, w: 50, h: 60 });
  });

  it('全部缺失时回退 A4 并 warning', () => {
    const onWarning = vi.fn();
    const result = resolvePageArea({ onWarning });
    expect(result.source).toBe('fallback');
    expect(result.size).toEqual({ width: 210, height: 297 });
    expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({ code: 'W_BAD_NUMBER' }));
  });

  it('isValidPageArea 拒绝 NaN/零/负值', () => {
    expect(isValidPageArea({ x: 0, y: 0, w: 1, h: 1 })).toBe(true);
    expect(isValidPageArea({ x: 0, y: 0, w: 0, h: 1 })).toBe(false);
    expect(isValidPageArea({ x: 0, y: 0, w: 1, h: -1 })).toBe(false);
    expect(isValidPageArea({ x: 0, y: 0, w: Number.NaN, h: 1 })).toBe(false);
    expect(isValidPageArea(undefined)).toBe(false);
  });

  it('applyPageArea 返回新对象，不修改入参', () => {
    const page = {
      id: '1',
      area: { x: 0, y: 0, w: 0, h: 0 },
      size: { width: 0, height: 0 },
      layers: [],
      templates: [],
      pageRes: [],
    };
    const next = applyPageArea(page, {
      area: { x: 0, y: 0, w: 210, h: 297 },
      size: { width: 210, height: 297 },
      source: 'fallback',
    });
    expect(next).not.toBe(page);
    expect(next.size).toEqual({ width: 210, height: 297 });
    expect(page.size).toEqual({ width: 0, height: 0 });
  });
});