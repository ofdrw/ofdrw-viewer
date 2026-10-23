import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  bytesEqual,
  concatBytes,
  constantTimeEqual,
  copyBytes,
  fromBase64,
  fromHex,
  leftPadBytes,
  looksLikePem,
  parsePemBlocks,
  sha256,
  sha256Hex,
  toBase64,
  toHex,
  toUint8Array,
  tryFromBase64,
  utf8Decode,
  utf8Encode,
  zeroize,
} from '@ofdrw/ofdrw-viewer-crypto';

describe('bytes 编码工具', () => {
  it('hex 往返并拒绝非法输入', () => {
    const bytes = Uint8Array.of(0x00, 0x0f, 0xff, 0x10);
    expect(toHex(bytes)).toBe('000fff10');
    expect(fromHex('000fff10')).toEqual(bytes);
    expect(() => fromHex('abc')).toThrowError(/十六进制/);
    expect(() => fromHex('zz')).toThrowError(/十六进制/);
    expect(() => fromHex('0x00')).toThrowError(/十六进制/);
  });

  it('Base64 与 Node Buffer 结果一致', () => {
    for (let length = 0; length <= 20; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) & 0xff);
      const encoded = toBase64(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
      expect(fromBase64(encoded)).toEqual(bytes);
    }
  });

  it('严格拒绝非法 Base64 与 URL-safe 变体', () => {
    expect(tryFromBase64('')).toEqual(new Uint8Array(0));
    expect(tryFromBase64('A')).toBeNull();
    expect(tryFromBase64('AA=A')).toBeNull();
    expect(tryFromBase64('****')).toBeNull();
    expect(tryFromBase64('-_8=')).toBeNull();
    expect(() => fromBase64('A')).toThrowError(/Base64/);
  });

  it('utf8 编解码中文与 emoji', () => {
    const text = 'OFD 加密文档 🚀';
    expect(utf8Decode(utf8Encode(text))).toBe(text);
  });

  it('字节比较与常量时间比较', () => {
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3))).toBe(false);
    expect(constantTimeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(constantTimeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(constantTimeEqual(Uint8Array.of(1, 2), Uint8Array.of(1))).toBe(false);
  });

  it('拼接、复制、补零与清零', () => {
    expect(toHex(concatBytes(Uint8Array.of(1), Uint8Array.of(2, 3)))).toBe('010203');
    const source = Uint8Array.of(9, 8);
    const copy = copyBytes(source);
    copy[0] = 0;
    expect(source[0]).toBe(9);
    expect(toHex(leftPadBytes(Uint8Array.of(0xaa), 3))).toBe('0000aa');
    const secret = Uint8Array.of(1, 2, 3);
    zeroize(secret);
    expect(toHex(secret)).toBe('000000');
  });

  it('toUint8Array 接受 ArrayBuffer 与 Uint8Array', () => {
    const bytes = Uint8Array.of(1, 2, 3);
    expect(toUint8Array(bytes)).toBe(bytes);
    expect(toUint8Array(bytes.buffer)).toEqual(bytes);
    expect(() => toUint8Array('x' as unknown as Uint8Array)).toThrowError(/ArrayBuffer/);
  });
});

describe('SHA-256', () => {
  it('匹配标准向量', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(utf8Encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('与 node:crypto 在多分组/非对齐长度上一致', () => {
    for (const length of [1, 55, 56, 63, 64, 65, 127, 128, 1000]) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 131 + 7) & 0xff);
      const expected = createHash('sha256').update(bytes).digest('hex');
      expect(sha256Hex(bytes)).toBe(expected);
    }
    expect(sha256(utf8Encode('abc'))).toHaveLength(32);
  });
});

describe('PEM 块解析', () => {
  it('解析多块并忽略标签外文本', () => {
    const pem = [
      '说明文本',
      '-----BEGIN CERTIFICATE-----',
      toBase64(Uint8Array.of(1, 2, 3, 4)),
      '-----END CERTIFICATE-----',
      '-----BEGIN EC PRIVATE KEY-----',
      toBase64(Uint8Array.of(5, 6, 7)),
      '-----END EC PRIVATE KEY-----',
    ].join('\n');
    expect(looksLikePem(pem)).toBe(true);
    const blocks = parsePemBlocks(pem);
    expect(blocks.map((block) => block.type)).toEqual(['CERTIFICATE', 'EC PRIVATE KEY']);
    expect(toHex(blocks[0].der)).toBe('01020304');
    expect(toHex(blocks[1].der)).toBe('050607');
  });

  it('缺少结束标记时不产生块，非法 Base64 抛错', () => {
    expect(parsePemBlocks('-----BEGIN CERTIFICATE-----\nAQID\n')).toEqual([]);
    expect(() =>
      parsePemBlocks('-----BEGIN CERTIFICATE-----\n****\n-----END CERTIFICATE-----'),
    ).toThrowError(/Base64/);
  });
});