import { describe, expect, it, vi } from 'vitest';
import { ZipReader } from '../../src/container/zip-reader';
import { ArrayBufferSource } from '../../src/container/byte-source';
import { OFDError } from '../../src/errors';
import type { OFDWarning } from '../../src/warnings';
import { buildZip, CountingSource } from './zip-fixture';

/** 期望抛指定错误码。 */
async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`应当抛出 ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(OFDError);
    expect((error as OFDError).code).toBe(code);
  }
}

/** UTF-8 字节。 */
function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('container/zip-reader', () => {
  it('读取 stored 与 deflate 条目，保留中文路径', async () => {
    const zip = buildZip([
      { name: 'Doc_0/stored.txt', data: 'hello', method: 0 },
      { name: 'Doc_0/压缩.xml', data: '<root>中文</root>', method: 8 },
      { name: 'Doc_0/Res/image.png', data: utf8('PNG-DATA') },
    ]);
    const reader = await ZipReader.open(new ArrayBufferSource(zip));
    expect(reader.listEntries().map((entry) => entry.name)).toEqual([
      'Doc_0/stored.txt',
      'Doc_0/压缩.xml',
      'Doc_0/Res/image.png',
    ]);
    expect(new TextDecoder().decode(await reader.readEntry('Doc_0/stored.txt'))).toBe('hello');
    expect(new TextDecoder().decode(await reader.readEntry('Doc_0/压缩.xml'))).toBe(
      '<root>中文</root>',
    );
    expect(reader.hasEntry('Doc_0/Res/image.png')).toBe(true);
    expect(reader.getEntry('Doc_0/missing.xml')).toBeUndefined();
    reader.close();
    expect(reader.listEntries()).toHaveLength(0);
    await expectCode(reader.readEntry('Doc_0/stored.txt'), 'OFD_CLOSED');
  });

  it('支持 ZIP64 EOCD/entry extra', async () => {
    const zip = buildZip(
      [
        { name: 'Doc_0/Document.xml', data: '<Document/>' },
        { name: 'Doc_0/Res/big.bin', data: new Uint8Array(1024).fill(7), method: 0 },
      ],
      { zip64: true },
    );
    const reader = await ZipReader.open(new ArrayBufferSource(zip));
    expect(reader.listEntries()).toHaveLength(2);
    expect(new TextDecoder().decode(await reader.readEntry('Doc_0/Document.xml'))).toBe(
      '<Document/>',
    );
    expect((await reader.readEntry('Doc_0/Res/big.bin')).byteLength).toBe(1024);
  });

  it('解压大型 deflate 条目不会因读写背压死锁', async () => {
    const data = new Uint8Array(1024 * 1024);
    for (let index = 0; index < data.length; index += 1) data[index] = (index * 31) % 251;
    const zip = buildZip([{ name: 'Doc_0/Res/big.bin', data, method: 8 }]);
    // 重复模式压缩比很高，关闭压缩比限制以单独验证解压路径。
    const reader = await ZipReader.open(new ArrayBufferSource(zip), { maxCompressionRatio: 0 });
    const output = await reader.readEntry('Doc_0/Res/big.bin');
    expect(output.byteLength).toBe(data.byteLength);
    expect(output[0]).toBe(data[0]);
    expect(output[output.length - 1]).toBe(data[data.length - 1]);
  }, 30_000);

  it('DecompressionStream 不可用时回退 fflate 流式解压并限制输出', async () => {
    const globalObject = globalThis as unknown as { DecompressionStream?: unknown };
    const original = globalObject.DecompressionStream;
    Reflect.deleteProperty(globalThis, 'DecompressionStream');
    try {
      const data = 'fallback-deflate-'.repeat(64 * 1024);
      const zip = buildZip([{ name: 'Doc_0/f.xml', data, method: 8 }]);
      const reader = await ZipReader.open(new ArrayBufferSource(zip), { maxCompressionRatio: 0 });
      expect(new TextDecoder().decode(await reader.readEntry('Doc_0/f.xml'))).toBe(data);

      // 中央目录谎报小尺寸，实际解压超过 readEntry 上限时必须中止。
      const bomb = buildZip([
        { name: 'bomb.txt', data: 'a'.repeat(200_000), method: 8, uncompressedSizeOverride: 100 },
      ]);
      const bombReader = await ZipReader.open(new ArrayBufferSource(bomb), {
        maxCompressionRatio: 0,
      });
      await expectCode(bombReader.readEntry('bomb.txt', { maxBytes: 1_000 }), 'OFD_LIMIT_EXCEEDED');
    } finally {
      if (original !== undefined) globalObject.DecompressionStream = original;
    }
  });

  it('data descriptor 以中央目录大小为准', async () => {
    const data = 'data-descriptor-content';
    const zip = buildZip([
      { name: 'Doc_0/dd.xml', data, method: 8, useDataDescriptor: true },
    ]);
    const reader = await ZipReader.open(new ArrayBufferSource(zip));
    expect(new TextDecoder().decode(await reader.readEntry('Doc_0/dd.xml'))).toBe(data);
  });

  it('支持 EOCD 注释（最多 64KB 回退扫描）', async () => {
    const comment = 'x'.repeat(1024);
    const zip = buildZip([{ name: 'OFD.xml', data: '<OFD/>' }], { comment });
    const reader = await ZipReader.open(new ArrayBufferSource(zip));
    expect(new TextDecoder().decode(await reader.readEntry('OFD.xml'))).toBe('<OFD/>');
  });

  it('拒绝路径穿越与重复规范化路径', async () => {
    await expectCode(
      ZipReader.open(new ArrayBufferSource(buildZip([{ name: '../evil.txt', data: 'x' }]))),
      'OFD_INVALID_PACKAGE',
    );
    await expectCode(
      ZipReader.open(
        new ArrayBufferSource(
          buildZip([
            { name: 'Doc_0//a.xml', data: '1' },
            { name: 'Doc_0/a.xml', data: '2' },
          ]),
        ),
      ),
      'OFD_INVALID_PACKAGE',
    );
    // 目录项也不能用 `../` 绕过检查。
    await expectCode(
      ZipReader.open(
        new ArrayBufferSource(
          buildZip([{ name: '../', data: '', externalAttributes: 0x10 }]),
        ),
      ),
      'OFD_INVALID_PACKAGE',
    );
  });

  it('拒绝加密条目与不支持的压缩方法', async () => {
    await expectCode(
      ZipReader.open(
        new ArrayBufferSource(
          buildZip([{ name: 'Doc_0/secret.xml', data: 'x', flags: 0x0001 }]),
        ),
      ),
      'OFD_ENCRYPTED',
    );
    const unsupported = buildZip([{ name: 'Doc_0/a.bin', data: 'x', method: 12 }]);
    await expectCode(ZipReader.open(new ArrayBufferSource(unsupported)), 'OFD_UNSUPPORTED_COMPRESSION');
  });

  it('CRC32 失败只 warning，不丢数据', async () => {
    const warnings: OFDWarning[] = [];
    const zip = buildZip([{ name: 'Doc_0/bad.xml', data: 'payload', crcOverride: 0x12345678 }]);
    const reader = await ZipReader.open(new ArrayBufferSource(zip));
    expect(
      new TextDecoder().decode(
        await reader.readEntry('Doc_0/bad.xml', { onWarning: (warning) => warnings.push(warning) }),
      ),
    ).toBe('payload');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe('W_BAD_NUMBER');
    expect(warnings[0]!.message).toContain('CRC32');
  });

  it('拒绝超过包大小/条目数/单条目/总解压/压缩比限制的 ZIP', async () => {
    const twoEntries = buildZip([
      { name: 'a.txt', data: 'aaaa', method: 0 },
      { name: 'b.txt', data: 'bbbb', method: 0 },
    ]);
    await expectCode(
      ZipReader.open(new ArrayBufferSource(twoEntries), { maxPackageBytes: 10 }),
      'OFD_LIMIT_EXCEEDED',
    );
    await expectCode(
      ZipReader.open(new ArrayBufferSource(twoEntries), { maxEntries: 1 }),
      'OFD_LIMIT_EXCEEDED',
    );
    await expectCode(
      ZipReader.open(new ArrayBufferSource(twoEntries), { maxEntryBytes: 3 }),
      'OFD_LIMIT_EXCEEDED',
    );
    await expectCode(
      ZipReader.open(new ArrayBufferSource(twoEntries), { maxTotalUncompressedBytes: 7 }),
      'OFD_LIMIT_EXCEEDED',
    );
    const compressible = buildZip([
      { name: 'bomb.txt', data: 'abababababababababababababababababababab', method: 8 },
    ]);
    await expectCode(
      ZipReader.open(new ArrayBufferSource(compressible), { maxTotalUncompressedBytes: 0, maxCompressionRatio: 1.1 }),
      'OFD_LIMIT_EXCEEDED',
    );
  });

  it('readEntry 的 maxBytes 不能突破打开时的全局上限', async () => {
    const zip = buildZip([{ name: 'a.txt', data: 'abcdefghij', method: 0 }]);
    const reader = await ZipReader.open(new ArrayBufferSource(zip), { maxEntryBytes: 10 });
    await expectCode(reader.readEntry('a.txt', { maxBytes: 5 }), 'OFD_LIMIT_EXCEEDED');
  });

  it('缺少 EOCD 或损坏结构时抛 OFD_INVALID_PACKAGE', async () => {
    await expectCode(
      ZipReader.open(new ArrayBufferSource(new Uint8Array(64).fill(1))),
      'OFD_INVALID_PACKAGE',
    );
    await expectCode(
      ZipReader.open(new ArrayBufferSource(new Uint8Array(0))),
      'OFD_INVALID_PACKAGE',
    );
  });

  it('打开只读尾部与中央目录，不整包读取/解压', async () => {
    // 大文件使用 stored，确保 open 不需要读取其内容。
    const bigData = new Uint8Array(200_000);
    for (let index = 0; index < bigData.length; index += 1) bigData[index] = index % 251;
    const zip = buildZip([
      { name: 'Doc_0/small.xml', data: '<Document/>' },
      { name: 'Doc_0/Res/big.bin', data: bigData, method: 0 },
      { name: 'OFD.xml', data: '<OFD/>' },
    ]);
    const source = new CountingSource(zip);
    const reader = await ZipReader.open(source);
    expect(zip.byteLength).toBeGreaterThan(200_000);
    expect(source.bytesRead).toBeLessThan(100_000);
    expect(source.readCalls).toBeLessThanOrEqual(3);

    const before = source.bytesRead;
    expect(new TextDecoder().decode(await reader.readEntry('OFD.xml'))).toBe('<OFD/>');
    expect(source.bytesRead - before).toBeLessThan(100);
    // 没有读取大条目的数据区间。
    expect(source.bytesRead).toBeLessThan(100_000);

    expect((await reader.readEntry('Doc_0/Res/big.bin')).byteLength).toBe(bigData.length);
  });

  it('不信任局部头大小：以中央目录为准', async () => {
    const zip = buildZip([{ name: 'a.txt', data: 'content', method: 0, useDataDescriptor: true }]);
    const reader = await ZipReader.open(new ArrayBufferSource(zip));
    expect(new TextDecoder().decode(await reader.readEntry('a.txt'))).toBe('content');
  });

  it('warning 回调缺省时静默', async () => {
    const zip = buildZip([{ name: 'a.txt', data: 'payload', crcOverride: 1 }]);
    const reader = await ZipReader.open(new ArrayBufferSource(zip));
    await expect(reader.readEntry('a.txt')).resolves.toBeInstanceOf(Uint8Array);
  });

  it('getEntry 对非法路径返回 undefined 而不抛错', async () => {
    const zip = buildZip([{ name: 'a.txt', data: 'x' }]);
    const reader = await ZipReader.open(new ArrayBufferSource(zip));
    expect(reader.getEntry('../a.txt')).toBeUndefined();
    const warn = vi.fn();
    expect(reader.hasEntry('a.txt')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});