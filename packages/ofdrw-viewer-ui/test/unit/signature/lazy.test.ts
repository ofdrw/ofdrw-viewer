/**
 * 动态加载测试：首屏不得静态加载 asn1js/@peculiar 解析器。
 */

import { describe, expect, it, vi } from 'vitest';

const parserMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/signature/asn1-parser', () => ({
  parseSignedValueBytes: parserMock,
}));

import { parseSignedValue } from '../../../src/signature/asn1';

describe('parseSignedValue 动态加载', () => {
  it('调用前不加载 asn1-parser 模块，调用后才加载', async () => {
    parserMock.mockReturnValue({ version: 'v1', warnings: [] });
    expect(parserMock).not.toHaveBeenCalled();

    const result = await parseSignedValue(new Uint8Array([0x30, 0x00]));

    expect(parserMock).toHaveBeenCalledTimes(1);
    expect(result.version).toBe('v1');
  });

  it('文件大小超限时在动态加载前拒绝', async () => {
    parserMock.mockClear();
    await expect(
      parseSignedValue(new Uint8Array(8), { limits: { maxBytes: 4 } }),
    ).rejects.toMatchObject({ code: 'W_SIGNATURE_LIMIT' });
    expect(parserMock).not.toHaveBeenCalled();
  });
});