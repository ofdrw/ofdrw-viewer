/**
 * V-NODE 独立验证：crypto 的 Node 随机访问 byte-source 不整包读取，结果与
 * arraybuffer 完全一致，且生命周期/错误/取消语义不回归。
 *
 * 只使用公开 API、已提交夹具与 engine 的 ByteSource 接口；不引用实现内部模块。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  inspect,
  openDecryptingContainer,
  verifyOfd,
  type ByteSource,
  type CryptoCredential,
  type VerificationReport,
} from '@ofdrw/ofdrw-viewer-crypto';

/** 夹具目录。 */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/crypto');

/** 夹具口令。 */
const PASSWORD: CryptoCredential = {
  kind: 'password',
  userName: 'fixture-password-user',
  password: 'FixturePass123',
};

/** 记录每次读取区间、单次最大请求、累计读取、close 次数。 */
class CountingByteSource implements ByteSource {
  readonly data: Uint8Array;
  readonly size: number;
  reads = 0;
  bytesRead = 0;
  maxReadLength = 0;
  closeCalls = 0;

  /**
   * @param data 完整包字节。
   */
  constructor(data: Uint8Array) {
    this.data = data;
    this.size = data.length;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    this.reads += 1;
    this.maxReadLength = Math.max(this.maxReadLength, length);
    const start = Math.max(0, Math.min(this.size, Math.floor(offset)));
    const end = Math.min(this.size, start + Math.max(0, Math.floor(length)));
    const bytes = this.data.slice(start, end);
    this.bytesRead += bytes.length;
    return bytes;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

/** 读取夹具包。 */
function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

/**
 * 给真实 ZIP/OFD 追加一个未使用的大条目，模拟 Node 大文件；不改变 OFD 内容。
 *
 * @param name 夹具名。
 * @param size 大条目字节数，单位 byte。
 * @returns 新包字节。
 */
function withUnusedEntry(name: string, size = 512 * 1024): Uint8Array {
  const entries = unzipSync(fixture(name));
  entries['unused-large.bin'] = new Uint8Array(size).fill(0x5a);
  return zipSync(entries, { level: 0 });
}

/** 去掉报告的时间字段，便于逐字段比较。 */
function withoutTiming(report: VerificationReport): Omit<VerificationReport, 'startedAt' | 'durationMs'> {
  const { startedAt: _startedAt, durationMs: _durationMs, ...rest } = report;
  return rest;
}

/** 读取容器全部条目。 */
async function entriesOf(container: { list(): readonly { path: string }[]; read(path: string): Promise<Uint8Array> }): Promise<Map<string, Uint8Array>> {
  const result = new Map<string, Uint8Array>();
  for (const meta of container.list()) result.set(meta.path, await container.read(meta.path));
  return result;
}

describe('crypto byte-source 随机访问', () => {
  it('大签名包 inspect/verify 与 arraybuffer 逐字段一致，读取量远小于整包', async () => {
    const data = withUnusedEntry('signed-sesv4.ofd');
    const source = new CountingByteSource(data);
    const byteInspection = await inspect({ kind: 'byte-source', source });
    const arrayInspection = await inspect({ kind: 'arraybuffer', data });
    expect(byteInspection).toEqual(arrayInspection);
    expect(source.bytesRead).toBeLessThan(data.length / 5);
    expect(source.maxReadLength).toBeLessThan(data.length / 2);
    expect(source.reads).toBeGreaterThan(1);
    expect(source.closeCalls).toBe(0);

    const rootDer = new Uint8Array(readFileSync(join(FIXTURES, 'certs', 'root-ca.crt.der')));
    const now = new Date('2026-10-23T00:00:00.000Z');
    const byteReport = await verifyOfd({
      source: { kind: 'byte-source', source },
      roots: [rootDer],
      now,
    });
    const arrayReport = await verifyOfd({
      source: { kind: 'arraybuffer', data },
      roots: [rootDer],
      now,
    });
    expect(withoutTiming(byteReport)).toEqual(withoutTiming(arrayReport));
    expect(byteReport.overall).toBe('valid');
    expect(source.bytesRead).toBeLessThan(data.length / 2);
    expect(source.maxReadLength).toBeLessThan(data.length / 2);
    expect(source.closeCalls).toBe(0);
  });

  it('大明文包 open 返回 source-backed 容器，不整包读取且不关闭调用方源', async () => {
    const data = withUnusedEntry('plain.ofd');
    const source = new CountingByteSource(data);
    const opened = await openDecryptingContainer({
      source: { kind: 'byte-source', source },
    });
    const oracle = await openDecryptingContainer({
      source: { kind: 'arraybuffer', data },
    });
    try {
      expect(opened.plaintext).toBe(true);
      expect(opened.inspection).toEqual(oracle.inspection);
      expect(opened.container.packageSize).toBe(data.length);
      expect(opened.container.list().map((item) => item.path)).toEqual(
        oracle.container.list().map((item) => item.path),
      );
      const openedBytesRead = source.bytesRead;
      const openedMaxRead = source.maxReadLength;
      const entries = await entriesOf(opened.container);
      const oracleEntries = await entriesOf(oracle.container);
      for (const [path, bytes] of entries) {
        expect(Buffer.compare(Buffer.from(bytes), Buffer.from(oracleEntries.get(path)!))).toBe(0);
      }
      // 断言 open 本身只读必要区间；后续 entriesOf 是验证测试主动读取全部条目。
      expect(openedBytesRead).toBeLessThan(data.length / 5);
      expect(openedMaxRead).toBeLessThan(data.length / 2);
      expect(source.closeCalls).toBe(0);
    } finally {
      await opened.container.close();
      await oracle.container.close();
    }
    expect(source.closeCalls).toBe(0);
  });

  it('大加密包 inspect/open/verify 经 byte-source 与 arraybuffer 一致', async () => {
    const data = withUnusedEntry('password-encrypted.ofd');
    const source = new CountingByteSource(data);
    const byteInspection = await inspect({ kind: 'byte-source', source });
    const arrayInspection = await inspect({ kind: 'arraybuffer', data });
    expect(byteInspection).toEqual(arrayInspection);
    expect(source.bytesRead).toBeLessThan(data.length / 4);

    const opened = await openDecryptingContainer({
      source: { kind: 'byte-source', source },
      credentials: PASSWORD,
    });
    const oracle = await openDecryptingContainer({
      source: { kind: 'arraybuffer', data },
      credentials: PASSWORD,
    });
    try {
      expect(opened.plaintext).toBe(false);
      expect(opened.inspection).toEqual(oracle.inspection);
      expect(opened.layers).toEqual(oracle.layers);
      expect(Buffer.compare(
        Buffer.from(await opened.container.read('OFD.xml')),
        Buffer.from(await oracle.container.read('OFD.xml')),
      )).toBe(0);
    } finally {
      await opened.container.close();
      await oracle.container.close();
    }

    const now = new Date('2026-10-23T00:00:00.000Z');
    const byteReport = await verifyOfd({
      source: { kind: 'byte-source', source },
      credentials: PASSWORD,
      now,
    });
    const arrayReport = await verifyOfd({
      source: { kind: 'arraybuffer', data },
      credentials: PASSWORD,
      now,
    });
    expect(withoutTiming(byteReport)).toEqual(withoutTiming(arrayReport));
    expect(byteReport.overall).toBe('not-applicable');
    // 不允许单次请求整个文件；ZIP 可按需读取大条目，但读取请求必须小于包大小。
    expect(source.maxReadLength).toBeLessThan(data.length);
    expect(source.reads).toBeGreaterThan(5);
    expect(source.closeCalls).toBe(0);
  });

  it('错误凭据、取消与超限不整包读取，且源仍由调用方拥有', async () => {
    const wrong = new CountingByteSource(fixture('password-encrypted.ofd'));
    await expect(
      openDecryptingContainer({
        source: { kind: 'byte-source', source: wrong },
        credentials: { kind: 'password', userName: 'fixture-password-user', password: 'wrong' },
      }),
    ).rejects.toMatchObject({ code: 'CRYPTO_WRONG_PASSWORD' });
    expect(wrong.closeCalls).toBe(0);

    const aborted = new CountingByteSource(fixture('signed-sesv4.ofd'));
    await expect(
      inspect(
        { kind: 'byte-source', source: aborted },
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toMatchObject({ code: 'CRYPTO_ABORTED' });
    expect(aborted.reads).toBe(0);
    expect(aborted.closeCalls).toBe(0);

    const limited = new CountingByteSource(fixture('signed-sesv4.ofd'));
    await expect(
      inspect(
        { kind: 'byte-source', source: limited },
        { limits: { maxSourceBytes: limited.size - 1 } },
      ),
    ).rejects.toMatchObject({ code: 'CRYPTO_LIMIT_EXCEEDED' });
    expect(limited.reads).toBe(0);
    expect(limited.closeCalls).toBe(0);
  });
});
