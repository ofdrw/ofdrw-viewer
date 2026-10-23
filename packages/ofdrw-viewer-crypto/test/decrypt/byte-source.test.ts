/**
 * `byte-source`：随机访问文件源、按需读取、所有权与 arraybuffer 结果一致性。
 */

import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  inspect,
  openDecryptingContainer,
  readCryptoSource,
  verifyOfd,
  type ByteSource,
  type CryptoSource,
  type CryptoCredential,
} from '@ofdrw/ofdrw-viewer-crypto';
import { fixtureBytes } from '../core/fixtures';

/** 口令凭据。 */
const PASSWORD: CryptoCredential = {
  kind: 'password',
  userName: 'fixture-password-user',
  password: 'FixturePass123',
};

/** 记录读取量与关闭次数的随机访问源。 */
class CountingByteSource implements ByteSource {
  /** 完整字节。 */
  readonly data: Uint8Array;
  /** source.size。 */
  readonly size: number;
  /** read 调用次数。 */
  reads = 0;
  /** 累计读取字节数。 */
  bytesRead = 0;
  /** close 调用次数。 */
  closeCalls = 0;

  /**
   * @param data 完整字节。
   */
  constructor(data: Uint8Array) {
    this.data = data;
    this.size = data.length;
  }

  /**
   * 读取区间。
   *
   * @param offset 起始偏移，单位 byte。
   * @param length 读取长度，单位 byte。
   * @returns 字节。
   */
  async read(offset: number, length: number): Promise<Uint8Array> {
    this.reads += 1;
    const start = Math.max(0, Math.min(this.size, Math.floor(offset)));
    const end = Math.min(this.size, start + Math.max(0, Math.floor(length)));
    const bytes = this.data.slice(start, end);
    this.bytesRead += bytes.length;
    return bytes;
  }

  /** 模拟可关闭句柄；crypto 不应调用。 */
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

/**
 * 在 fixture 中追加一个未使用的大条目，模拟 Node 大文件。
 *
 * @param name fixture 名。
 * @param size 大条目字节数。
 * @returns 新包字节。
 */
function withLargeEntry(name: string, size = 512 * 1024): Uint8Array {
  const files = unzipSync(fixtureBytes(name));
  const large = new Uint8Array(size);
  for (let index = 0; index < large.length; index += 1) {
    large[index] = (index * 31 + 7) & 0xff;
  }
  files['unused-large.bin'] = large;
  return zipSync(files, { level: 0 });
}

/**
 * 构造随机访问源。
 *
 * @param data 包字节。
 * @returns crypto 来源。
 */
function byteSource(data: Uint8Array): { kind: 'byte-source'; source: CountingByteSource } {
  return { kind: 'byte-source', source: new CountingByteSource(data) };
}

/**
 * 比较报告时去掉时间字段。
 *
 * @param report verify 报告。
 * @returns 可比较的报告。
 */
function withoutTiming<T extends { startedAt: string; durationMs: number }>(report: T): Omit<T, 'startedAt' | 'durationMs'> {
  const { startedAt: _startedAt, durationMs: _durationMs, ...rest } = report;
  return rest;
}

/**
 * 读取容器全部条目为路径→字节。
 *
 * @param container 容器。
 * @returns 条目表。
 */
async function readAll(container: {
  list(): readonly { path: string }[];
  read(path: string): Promise<Uint8Array>;
}): Promise<Map<string, Uint8Array>> {
  const result = new Map<string, Uint8Array>();
  for (const meta of container.list()) result.set(meta.path, await container.read(meta.path));
  return result;
}

describe('byte-source 随机访问', () => {
  it('inspect 与 arraybuffer 逐字段一致且不读取大条目', async () => {
    const data = withLargeEntry('signed-sesv4.ofd');
    const counting = new CountingByteSource(data);
    const viaByte = await inspect({ kind: 'byte-source', source: counting });
    const viaArray = await inspect({ kind: 'arraybuffer', data });
    expect(viaByte).toEqual(viaArray);
    expect(counting.bytesRead).toBeLessThan(data.length / 5);
    expect(counting.closeCalls).toBe(0);
  });

  it('明文 open 返回 source-backed 容器并保留调用方 ByteSource', async () => {
    const data = withLargeEntry('plain.ofd');
    const counting = new CountingByteSource(data);
    const result = await openDecryptingContainer({
      source: { kind: 'byte-source', source: counting },
    });
    const viaArray = await openDecryptingContainer({
      source: { kind: 'arraybuffer', data },
    });
    expect(result.plaintext).toBe(true);
    expect(result.inspection).toEqual(viaArray.inspection);
    expect(result.warnings).toEqual(viaArray.warnings);
    expect(result.container.packageSize).toBe(data.length);
    expect(result.container.has('OFD.xml')).toBe(true);
    expect(counting.bytesRead).toBeLessThan(data.length / 5);
    expect(counting.closeCalls).toBe(0);
    await result.container.close();
    await viaArray.container.close();
    expect(counting.closeCalls).toBe(0);
  });

  it('verify 与 arraybuffer 报告一致且只读取签名相关条目', async () => {
    const data = withLargeEntry('signed-sesv4.ofd');
    const counting = new CountingByteSource(data);
    const now = new Date('2026-10-23T00:00:00.000Z');
    const viaByte = await verifyOfd({
      source: { kind: 'byte-source', source: counting },
      now,
    });
    const viaArray = await verifyOfd({
      source: { kind: 'arraybuffer', data },
      now,
    });
    expect(withoutTiming(viaByte)).toEqual(withoutTiming(viaArray));
    expect(counting.bytesRead).toBeLessThan(data.length / 2);
    expect(counting.closeCalls).toBe(0);
  });

  it('加密 open 结果与 arraybuffer 一致且不关闭调用方 ByteSource', async () => {
    const data = fixtureBytes('password-encrypted.ofd');
    const counting = new CountingByteSource(data);
    const viaByte = await openDecryptingContainer({
      source: { kind: 'byte-source', source: counting },
      credentials: PASSWORD,
    });
    const viaArray = await openDecryptingContainer({
      source: { kind: 'arraybuffer', data },
      credentials: PASSWORD,
    });
    expect(viaByte.plaintext).toBe(false);
    expect(viaByte.layers).toEqual(viaArray.layers);
    expect(viaByte.inspection).toEqual(viaArray.inspection);
    const byteEntries = await readAll(viaByte.container);
    const arrayEntries = await readAll(viaArray.container);
    expect([...byteEntries.keys()]).toEqual([...arrayEntries.keys()]);
    for (const [path, bytes] of byteEntries) {
      expect(Buffer.compare(Buffer.from(bytes), Buffer.from(arrayEntries.get(path)!))).toBe(0);
    }
    expect(counting.closeCalls).toBe(0);
    await viaByte.container.close();
    await viaArray.container.close();
    expect(counting.closeCalls).toBe(0);
  });

  it('加密包 inspect/verify 经 byte-source 与 arraybuffer 一致', async () => {
    const data = fixtureBytes('password-encrypted.ofd');
    const counting = new CountingByteSource(data);
    const byteInspection = await inspect({ kind: 'byte-source', source: counting });
    const arrayInspection = await inspect({ kind: 'arraybuffer', data });
    expect(byteInspection).toEqual(arrayInspection);
    expect(counting.closeCalls).toBe(0);

    const now = new Date('2026-10-23T00:00:00.000Z');
    const viaByte = await verifyOfd({
      source: { kind: 'byte-source', source: counting },
      credentials: PASSWORD,
      now,
    });
    const viaArray = await verifyOfd({
      source: { kind: 'arraybuffer', data },
      credentials: PASSWORD,
      now,
    });
    expect(withoutTiming(viaByte)).toEqual(withoutTiming(viaArray));
    expect(counting.closeCalls).toBe(0);
  });

  it('source.size 超限在读取前拒绝；取消不触发读取', async () => {
    const data = withLargeEntry('plain.ofd');
    const counting = new CountingByteSource(data);
    await expect(
      inspect({ kind: 'byte-source', source: counting }, {
        limits: { maxSourceBytes: data.length - 1 },
      }),
    ).rejects.toMatchObject({ code: 'CRYPTO_LIMIT_EXCEEDED' });
    expect(counting.reads).toBe(0);

    const aborted = new CountingByteSource(data);
    await expect(
      inspect({ kind: 'byte-source', source: aborted }, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'CRYPTO_ABORTED' });
    expect(aborted.reads).toBe(0);
  });

  it('readCryptoSource 仍可完整读取 byte-source 并执行上限校验', async () => {
    const data = withLargeEntry('plain.ofd');
    const counting = new CountingByteSource(data);
    const source: CryptoSource = { kind: 'byte-source', source: counting };
    await expect(readCryptoSource(source)).resolves.toEqual(data);
    const limited = new CountingByteSource(data);
    await expect(
      readCryptoSource({ kind: 'byte-source', source: limited }, { maxBytes: 32 }),
    ).rejects.toMatchObject({ code: 'CRYPTO_LIMIT_EXCEEDED' });
    expect(limited.reads).toBe(0);
  });
});
