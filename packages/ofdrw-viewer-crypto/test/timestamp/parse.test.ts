/**
 * 时间戳令牌解析：只解析不验证、固定文案、错误容错。
 */

import { describe, expect, it } from 'vitest';
import { openZipVirtualContainer } from '@ofdrw/ofdrw-viewer-engine';
import { parseDer, parseTimestamp } from '@ofdrw/ofdrw-viewer-crypto';
import { fixtureBytes } from '../core/fixtures';

/**
 * 从 SignedValue.dat 提取 [0] 时间戳令牌。
 *
 * @param file fixture 文件名。
 * @returns 时间戳 CMS 令牌字节。
 */
async function readTimestamp(file: string): Promise<Uint8Array> {
  const container = await openZipVirtualContainer({
    kind: 'arraybuffer',
    data: fixtureBytes(file),
  });
  try {
    const bytes = await container.read('Doc_0/Signs/Sign_0/SignedValue.dat');
    const root = parseDer(bytes).requireSequence();
    const context = root.children[4];
    expect(context?.isContext(0)).toBe(true);
    return context!.children[0].asBitStringOctets();
  } finally {
    await container.close();
  }
}

describe('parseTimestamp', () => {
  it('解析 CMS 时间戳令牌并固定 parsed-not-verified', async () => {
    const token = await readTimestamp('signed-sesv4.ofd');
    const parsed = parseTimestamp(token);
    expect(parsed.status).toBe('parsed-not-verified');
    expect(parsed.tokenPresent).toBe(true);
    expect(parsed.tokenLength).toBe(token.length);
    expect(parsed.version).toBe(1);
    expect(parsed.policy).toBe('1.2.156.10197.1.501.1');
    expect(parsed.hashAlgorithm).toBe('SM3');
    expect(parsed.genTime).toBe('2026-10-22T17:51:06.000Z');
    expect(parsed.messageImprint).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.serialNumber).toMatch(/^[0-9a-f]+$/);
    expect(parsed.tsa?.subject).toContain('TSA');
    expect(parsed.note).toBe('已解析，未验证');
    // 不出现任何“验证通过/有效”措辞。
    expect(JSON.stringify(parsed)).not.toMatch(/验证通过|时间戳有效/);
  });

  it('空输入返回 not-present', () => {
    const parsed = parseTimestamp(new Uint8Array());
    expect(parsed).toMatchObject({
      status: 'not-present',
      tokenPresent: false,
      tokenLength: 0,
      note: '已解析，未验证',
    });
  });

  it('非法输入返回 parse-error 而不抛错', () => {
    const parsed = parseTimestamp(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01]));
    expect(parsed.status).toBe('parse-error');
    expect(parsed.tokenPresent).toBe(true);
    expect(parsed.parseError?.severity).toBe('warning');
    expect(parsed.note).toBe('已解析，未验证');
  });

  it('超过大小上限返回 parse-error', async () => {
    const token = await readTimestamp('signed-sesv5.ofd');
    const parsed = parseTimestamp(token, { maxBytes: 16 });
    expect(parsed.status).toBe('parse-error');
    expect(parsed.tokenLength).toBe(token.length);
  });
});
