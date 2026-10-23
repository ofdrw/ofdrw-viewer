/**
 * V-NODE 独立验证：CLI 对真实文件使用 NodeFileByteSource 随机访问，
 * info/verify/加密 convert 不走整包 readFile，并覆盖错误、取消与句柄关闭。
 *
 * 通过 `main` 源码入口观察真实 CLI 行为；读取计数只统计 CLI 文件源的
 * 实际 read() 请求，不 mock crypto 或 engine 的密码能力。
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../../src/cli.js';
import type { OutputStream } from '../../../src/log.js';
import { NodeFileByteSource } from '../../../src/node-file-source.js';

/** crypto 受保护夹具目录。 */
const FIXTURES = fileURLToPath(
  new URL('../../../../ofdrw-viewer-crypto/test/fixtures/crypto/', import.meta.url),
);

/** 真实大 OFD（627,373 B）；若缺失则跳过该条大文件断言。 */
const LARGE_REAL = fileURLToPath(
  new URL('../../../../../ofd_pdf_match/不规范资源路径.ofd', import.meta.url),
);

/** 口令用户名/口令（仅验证夹具）。 */
const USER = 'fixture-password-user';
const PASSWORD = 'FixturePass123';

/** 根证书。 */
const ROOT = join(FIXTURES, 'certs', 'root-ca.crt.pem');

/** 临时文件/目录登记。 */
const tempPaths: string[] = [];

/** 创建临时目录。 */
async function tempDir(): Promise<string> {
  const dir = join(tmpdir(), `ofdrw-vnode-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  tempPaths.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  const { rm } = await import('node:fs/promises');
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** 捕获 stdout/stderr。 */
function capture(): { stdout: OutputStream; stderr: OutputStream; out(): string; err(): string } {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
    stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
    out: () => stdout,
    err: () => stderr,
  };
}

/** main 运行结果。 */
interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 调用 CLI 源码入口。
 *
 * @param args 参数
 * @param cwd 工作目录
 * @param signal 可选取消信号（模拟 SIGINT 路径）
 */
async function run(args: string[], cwd: string, signal?: AbortSignal): Promise<RunResult> {
  const output = capture();
  const code = await main(args, {
    cwd,
    stdout: output.stdout,
    stderr: output.stderr,
    ...(signal === undefined ? {} : { signal }),
  });
  return { code, stdout: output.out(), stderr: output.err() };
}

/** 读取夹具。 */
function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES, name));
}

/** 在 ZIP EOCD 上添加合法注释，形成“大文件”而不改变 OFD 内容。 */
function withZipComment(name: string, commentBytes = 60_000): Buffer {
  const original = fixture(name);
  const eocd = original.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error(`夹具不是 ZIP：${name}`);
  const result = Buffer.concat([original, Buffer.alloc(commentBytes, 0x20)]);
  result.writeUInt16LE(commentBytes, eocd + 20);
  return result;
}

/** 记录单个测试的读取统计。 */
interface ReadStats {
  reads: number;
  bytesRead: number;
  maxReadLength: number;
  closes: number;
}

/**
 * 拦截 CLI 的 NodeFileByteSource，统计真实读取请求。
 *
 * @returns 可变的统计对象
 */
function instrument(): ReadStats {
  const stats: ReadStats = { reads: 0, bytesRead: 0, maxReadLength: 0, closes: 0 };
  const originalRead = NodeFileByteSource.prototype.read;
  const originalClose = NodeFileByteSource.prototype.close;
  vi.spyOn(NodeFileByteSource.prototype, 'read').mockImplementation(async function (
    this: NodeFileByteSource,
    offset: number,
    length: number,
  ) {
    stats.reads += 1;
    stats.maxReadLength = Math.max(stats.maxReadLength, length);
    const bytes = await originalRead.call(this, offset, length);
    stats.bytesRead += bytes.length;
    return bytes;
  });
  vi.spyOn(NodeFileByteSource.prototype, 'close').mockImplementation(async function (
    this: NodeFileByteSource,
  ) {
    stats.closes += 1;
    return originalClose.call(this);
  });
  return stats;
}

describe('CLI 随机访问文件源', () => {
  it('info 对大真实文件只读取必要区间，JSON 包大小正确且关闭句柄', async () => {
    expect(existsSync(LARGE_REAL), `缺少大文件夹具：${LARGE_REAL}`).toBe(true);
    const stats = instrument();
    const result = await run(['info', LARGE_REAL, '--json'], await tempDir());
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as { packageSize: number; command: string };
    expect(payload.command).toBe('info');
    expect(payload.packageSize).toBe((await stat(LARGE_REAL)).size);
    expect(stats.reads).toBeGreaterThan(1);
    expect(stats.bytesRead).toBeLessThan(payload.packageSize / 4);
    expect(stats.maxReadLength).toBeLessThan(payload.packageSize);
    expect(stats.closes).toBeGreaterThanOrEqual(1);
  });

  it('info 对大签名包只读取必要区间，不整包读取', async () => {
    const dir = await tempDir();
    const file = join(dir, 'large-signed.ofd');
    const bytes = withZipComment('signed-sesv4.ofd');
    await writeFile(file, bytes);
    const stats = instrument();
    const result = await run(['info', file, '--json'], dir);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as { packageSize: number };
    expect(payload.packageSize).toBe(bytes.length);
    expect(stats.reads).toBeGreaterThan(1);
    expect(stats.maxReadLength).toBeLessThan(bytes.length);
    expect(stats.closes).toBeGreaterThanOrEqual(1);
  });

  it('verify 对签名包经由随机访问源读根验证并关闭句柄', async () => {
    const dir = await tempDir();
    const file = join(dir, 'large-signed.ofd');
    const bytes = withZipComment('signed-sesv4.ofd');
    await writeFile(file, bytes);
    const stats = instrument();
    const result = await run(['verify', file, '--root', ROOT, '--json'], dir);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as { command: string; report: { overall: string } };
    expect(payload.command).toBe('verify');
    expect(payload.report.overall).toBe('valid');
    expect(stats.reads).toBeGreaterThan(1);
    expect(stats.maxReadLength).toBeLessThan(bytes.length);
    expect(stats.closes).toBeGreaterThanOrEqual(1);
  });

  it('加密 verify 经随机访问源解密、验签并关闭句柄', async () => {
    const dir = await tempDir();
    const file = join(dir, 'large-combined.ofd');
    const bytes = withZipComment('combined-password-encrypted.ofd');
    await writeFile(file, bytes);
    const stats = instrument();
    const result = await run(
      ['verify', file, '--user', USER, '--password', PASSWORD, '--root', ROOT, '--json'],
      dir,
    );
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      command: string;
      report: { overall: string; decryption?: { layers: unknown[] } };
    };
    expect(payload.command).toBe('verify');
    expect(payload.report.overall).toBe('valid');
    expect(payload.report.decryption?.layers).toHaveLength(1);
    expect(stats.reads).toBeGreaterThan(1);
    expect(stats.maxReadLength).toBeLessThan(bytes.length);
    expect(stats.closes).toBeGreaterThanOrEqual(1);
  });

  it('加密 convert 使用随机访问源导出图片并关闭句柄', async () => {
    const dir = await tempDir();
    const file = join(dir, 'large-encrypted.ofd');
    const bytes = withZipComment('password-encrypted.ofd');
    await writeFile(file, bytes);
    const out = join(dir, 'out');
    const stats = instrument();
    const result = await run(
      [
        file,
        '--user',
        USER,
        '--password',
        PASSWORD,
        '--out',
        out,
        '--pages',
        '1',
      ],
      dir,
    );
    expect(result.code).toBe(0);
    const png = await readFile(join(out, 'large-encrypted-p001.png'));
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(stats.reads).toBeGreaterThan(1);
    expect(stats.maxReadLength).toBeLessThan(bytes.length);
    expect(stats.closes).toBeGreaterThanOrEqual(1);
  });

  it('错误凭据/损坏包/取消均返回契约退出码且关闭句柄，且不泄漏凭据', async () => {
    const dir = await tempDir();
    const encrypted = join(dir, 'encrypted.ofd');
    await writeFile(encrypted, fixture('password-encrypted.ofd'));
    let stats = instrument();
    const wrong = await run(
      ['verify', encrypted, '--user', USER, '--password', 'WrongSecret42', '--root', ROOT, '--json'],
      dir,
    );
    expect(wrong.code).toBe(4);
    expect(wrong.stderr).not.toContain('WrongSecret42');
    expect(stats.closes).toBeGreaterThanOrEqual(1);
    vi.restoreAllMocks();

    const bad = join(dir, 'bad.ofd');
    await writeFile(bad, 'not a zip');
    stats = instrument();
    const damaged = await run(['info', bad, '--json'], dir);
    expect(damaged.code).toBe(2);
    expect(stats.closes).toBeGreaterThanOrEqual(1);
    vi.restoreAllMocks();

    stats = instrument();
    const cancelled = await run(['info', encrypted, '--json'], dir, AbortSignal.abort());
    expect(cancelled.code).toBe(130);
    expect(stats.closes).toBeGreaterThanOrEqual(1);
  });
});
