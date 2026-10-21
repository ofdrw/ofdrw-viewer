import { describe, expect, it, vi } from 'vitest';
import {
  MAX_EXPANDED_ARRAY_LENGTH,
  toBoolean,
  toNumber,
  toNumberArray,
} from '../../src/xml/numbers';

describe('xml/numbers', () => {
  it('toNumber 支持空白、科学计数法与负数', () => {
    expect(toNumber(' 1.5 ', 0)).toBe(1.5);
    expect(toNumber('1.2e3', 0)).toBe(1200);
    expect(toNumber('-0.25', 0)).toBe(-0.25);
    expect(toNumber('+7', 0)).toBe(7);
  });

  it('toNumber 对缺失静默回退，对非法值回调', () => {
    expect(toNumber(undefined, 9)).toBe(9);
    const onBad = vi.fn();
    expect(toNumber('', 9, onBad)).toBe(9);
    expect(onBad).toHaveBeenCalledTimes(1);
    expect(toNumber('abc', 9, onBad)).toBe(9);
    expect(toNumber('Infinity', 9, onBad)).toBe(9);
    expect(toNumber('NaN', 9, onBad)).toBe(9);
    expect(onBad).toHaveBeenCalledTimes(4);
  });

  it('toNumberArray 支持空白/逗号分隔并跳过坏 token', () => {
    expect(toNumberArray('1 2,3\t4', [])).toEqual([1, 2, 3, 4]);
    expect(toNumberArray(undefined, [7, 8])).toEqual([7, 8]);
    expect(toNumberArray('  ', [7])).toEqual([7]);
    const onBad = vi.fn();
    expect(toNumberArray('1 x 3', [], onBad)).toEqual([1, 3]);
    expect(onBad).toHaveBeenCalledTimes(1);
  });

  it('toNumberArray 展开 g 压缩组', () => {
    expect(toNumberArray('g 3 3.1305', [])).toEqual([3.1305, 3.1305, 3.1305]);
    expect(toNumberArray('0 g 3 5 2', [])).toEqual([0, 5, 5, 5, 2]);
    expect(toNumberArray('1 g 2 5 9', [])).toEqual([1, 5, 5, 9]);
    expect(toNumberArray('g 1 -2', [])).toEqual([-2]);
  });

  it('toNumberArray 对非法 g 组跳过并回调', () => {
    const onBad = vi.fn();
    expect(toNumberArray('g 0 5 7', [], onBad)).toEqual([7]);
    expect(toNumberArray('g x 5 7', [], onBad)).toEqual([7]);
    expect(toNumberArray('g 2 y 7', [], onBad)).toEqual([7]);
    expect(onBad.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('toNumberArray 的展开长度有上限', () => {
    const onBad = vi.fn();
    const values = toNumberArray(`g ${MAX_EXPANDED_ARRAY_LENGTH + 10} 1`, [], onBad);
    expect(values).toHaveLength(MAX_EXPANDED_ARRAY_LENGTH);
    expect(onBad).toHaveBeenCalled();
  });

  it('toBoolean 识别 true/1/yes 与 false/0/no', () => {
    for (const raw of ['true', '1', 'YES', ' True ']) expect(toBoolean(raw, false)).toBe(true);
    for (const raw of ['false', '0', 'no', ' No ']) expect(toBoolean(raw, true)).toBe(false);
    expect(toBoolean(undefined, true)).toBe(true);
    const onBad = vi.fn();
    expect(toBoolean('maybe', false, onBad)).toBe(false);
    expect(onBad).toHaveBeenCalledTimes(1);
  });
});