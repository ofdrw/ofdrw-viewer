/**
 * V-CLI 独立验证：旧转图片路径与加密文档口令/私钥两条路径。
 *
 * 加密文档必须经 crypto 解密后交给 engine；本文件只观察 CLI 产物、退出码
 * 与敏感信息边界，不直接调用 crypto 解密实现。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CERT_USER,
  ENCRYPT_KEY,
  FIXTURES,
  FONT_FILE,
  PASSWORD,
  PASSWORD_USER,
  SIGNER_KEY,
  cleanupTempDirs,
  createFontDir,
  createTempDir,
  fixture,
  inspectPng,
  listFiles,
  readText,
  runMain,
} from './support.js';

afterEach(cleanupTempDirs);

describe('V-CLI 转图片：旧用法兼容', () => {
  it.skipIf(FONT_FILE === null)('旧用法默认 PNG、页码与命名保持原行为', async () => {
    const cwd = await createTempDir();
    const out = join(cwd, 'out');
    const fontDir = (await createFontDir())!;
    const result = await runMain(
      [fixture('plain.ofd'), '-o', out, '--pages', '2', '--font-dir', fontDir],
      cwd,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('错误[');
    expect(result.stdout).toContain('完成：1/1 页');
    expect(await listFiles(out)).toEqual(['plain-p002.png']);
    const image = await inspectPng(join(out, 'plain-p002.png'));
    expect(image.width).toBeGreaterThan(0);
    expect(image.height).toBeGreaterThan(0);
  });

  it.skipIf(FONT_FILE === null)('旧用法 --text 同时产出 PNG 与五字段文本 JSON', async () => {
    const cwd = await createTempDir();
    const out = join(cwd, 'out');
    const fontDir = (await createFontDir())!;
    const result = await runMain(
      [fixture('plain.ofd'), '-o', out, '--pages', '1', '--text', '--font-dir', fontDir],
      cwd,
    );
    expect(result.code).toBe(0);
    expect(await listFiles(out)).toEqual(['plain-p001.json', 'plain-p001.png']);
    const records = await readText(join(out, 'plain-p001.json'));
    expect(records.length).toBeGreaterThan(0);
    expect(result.stdout).toContain('图片 + 文本');
  });

  it('页码越界仍退出 1，且不写出图片', async () => {
    const cwd = await createTempDir();
    const out = join(cwd, 'out');
    const result = await runMain(
      [fixture('plain.ofd'), '-o', out, '--pages', '99'],
      cwd,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('CLI_INVALID_PAGES');
    const files = (await listFiles(out).catch(() => [] as string[])).filter((name) =>
      name.endsWith('.png'),
    );
    expect(files).toEqual([]);
  });
});

describe('V-CLI 转图片：加密文档凭据路径', () => {
  it.skipIf(FONT_FILE === null)('口令路径导出 PNG + 文本，保留 --pages/--text 语义且不泄漏口令', async () => {
    const cwd = await createTempDir();
    const out = join(cwd, 'out');
    const fontDir = (await createFontDir())!;
    const result = await runMain(
      [
        fixture('password-encrypted.ofd'),
        '-o',
        out,
        '--pages',
        '2',
        '--text',
        '--font-dir',
        fontDir,
        '--user',
        PASSWORD_USER,
        '--password',
        PASSWORD,
      ],
      cwd,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('完成：1/1 页（图片 + 文本）');
    expect(await listFiles(out)).toEqual([
      'password-encrypted-p002.json',
      'password-encrypted-p002.png',
    ]);
    const image = await inspectPng(join(out, 'password-encrypted-p002.png'));
    expect(image.width).toBeGreaterThan(0);
    expect(image.height).toBeGreaterThan(0);
    const records = await readText(join(out, 'password-encrypted-p002.json'));
    expect(records.length).toBeGreaterThan(0);
    expect(result.stdout).not.toContain(PASSWORD);
    expect(result.stderr).not.toContain(PASSWORD);
    expect(result.stdout).not.toContain('EncryptedWK');
  });

  it.skipIf(FONT_FILE === null)('私钥路径导出 PNG + 文本，支持 DER 私钥且不输出 PEM 内容', async () => {
    const cwd = await createTempDir();
    const out = join(cwd, 'out');
    const fontDir = (await createFontDir())!;
    const result = await runMain(
      [
        fixture('cert-encrypted.ofd'),
        '-o',
        out,
        '--pages',
        '1',
        '--text',
        '--font-dir',
        fontDir,
        '--user',
        CERT_USER,
        '--key',
        join(FIXTURES, 'certs', 'encrypt.key.der'),
      ],
      cwd,
    );
    expect(result.code).toBe(0);
    expect(await listFiles(out)).toEqual([
      'cert-encrypted-p001.json',
      'cert-encrypted-p001.png',
    ]);
    const image = await inspectPng(join(out, 'cert-encrypted-p001.png'));
    expect(image.width).toBeGreaterThan(0);
    expect(image.height).toBeGreaterThan(0);
    await expect(readText(join(out, 'cert-encrypted-p001.json'))).resolves.toBeInstanceOf(Array);
    expect(result.stdout).not.toContain('BEGIN PRIVATE KEY');
    expect(result.stderr).not.toContain('BEGIN PRIVATE KEY');
  });

  it('缺少凭据退出 4 且不产页', async () => {
    const cwd = await createTempDir();
    const out = join(cwd, 'out');
    const result = await runMain([fixture('password-encrypted.ofd'), '-o', out], cwd);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('CLI_CREDENTIALS_REQUIRED');
    expect(await listFiles(out)).toEqual([]);
  });

  it('错误口令退出 4 且不产页、不回显口令', async () => {
    const cwd = await createTempDir();
    const out = join(cwd, 'out');
    const secret = 'WrongConvertSecret_123';
    const result = await runMain(
      [
        fixture('password-encrypted.ofd'),
        '-o',
        out,
        '--user',
        PASSWORD_USER,
        '--password',
        secret,
      ],
      cwd,
    );
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('CRYPTO_WRONG_PASSWORD');
    expect(result.stderr).not.toContain(secret);
    expect(result.stdout).not.toContain(secret);
    expect(await listFiles(out)).toEqual([]);
  });

  it('错误私钥退出 4 且不产页、不泄漏私钥内容', async () => {
    const cwd = await createTempDir();
    const out = join(cwd, 'out');
    const result = await runMain(
      [
        fixture('cert-encrypted.ofd'),
        '-o',
        out,
        '--user',
        CERT_USER,
        '--key',
        SIGNER_KEY,
      ],
      cwd,
    );
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('CRYPTO_PRIVATE_KEY_MISMATCH');
    expect(result.stderr).not.toContain('BEGIN PRIVATE KEY');
    expect(result.stdout).not.toContain('BEGIN PRIVATE KEY');
    expect(await listFiles(out)).toEqual([]);
  });

  it('明文文档带凭据时忽略凭据并保持旧输出', async () => {
    const cwd = await createTempDir();
    const out = join(cwd, 'out');
    const result = await runMain(
      [
        fixture('plain.ofd'),
        '-o',
        out,
        '--pages',
        '1',
        '--user',
        PASSWORD_USER,
        '--password',
        PASSWORD,
      ],
      cwd,
    );
    expect(result.code).toBe(0);
    expect(await listFiles(out)).toEqual(['plain-p001.png']);
    expect(result.stderr).toContain('W_CRYPTO_CREDENTIAL_IGNORED');
  });

  it('加密文档 --format jpeg 仍输出 JPEG 且不出现 PNG 扩展名', async () => {
    const cwd = await createTempDir();
    const out = join(cwd, 'out');
    const result = await runMain(
      [
        fixture('password-encrypted.ofd'),
        '-o',
        out,
        '--pages',
        '2',
        '--format',
        'jpeg',
        '--user',
        PASSWORD_USER,
        '--password',
        PASSWORD,
      ],
      cwd,
    );
    expect(result.code).toBe(0);
    expect(await listFiles(out)).toEqual(['password-encrypted-p002.jpg']);
    const bytes = await readFile(join(out, 'password-encrypted-p002.jpg'));
    expect(bytes.subarray(0, 3).toString('hex')).toBe('ffd8ff');
  });

  it('加密文档不提供独立 decrypt 路径；凭据只随转图片使用', async () => {
    const cwd = await createTempDir();
    const result = await runMain(
      [
        'decrypt',
        fixture('password-encrypted.ofd'),
        '--user',
        PASSWORD_USER,
        '--password',
        PASSWORD,
      ],
      cwd,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('不提供 decrypt 子命令');
    expect(result.stderr).not.toContain(PASSWORD);
  });
});
