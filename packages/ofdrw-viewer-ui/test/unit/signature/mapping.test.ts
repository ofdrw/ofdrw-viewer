/**
 * 签章解析 → UI 展示模型：确保 SignedValue 内嵌印章图片字节不被丢弃。
 */

import { describe, expect, it } from 'vitest';
import { parseSignedValue } from '@ofdrw/ofdrw-viewer-crypto';
import { toSealInfo } from '../../../src/signature/mapping';
import { readSignedValueFixture } from './fixtures';

describe('toSealInfo', () => {
  it('V4 真实签章保留 picture.data 原始字节、格式与 mm 尺寸', () => {
    const parsed = parseSignedValue(readSignedValueFixture('SignedValueV4.dat'));
    expect(parsed.seal?.picture?.data?.byteLength).toBeGreaterThan(0);
    const info = toSealInfo(parsed.seal);
    expect(info?.image).toBeDefined();
    expect(info?.image?.format.toLowerCase()).toBe(parsed.seal?.picture?.type.toLowerCase());
    expect(info?.image?.widthMm).toBe(parsed.seal?.picture?.widthMm);
    expect(info?.image?.heightMm).toBe(parsed.seal?.picture?.heightMm);
    expect(info?.image?.data).toBe(parsed.seal?.picture?.data);
  });

  it('无解析结果时返回 undefined', () => {
    expect(toSealInfo(undefined)).toBeUndefined();
  });
});