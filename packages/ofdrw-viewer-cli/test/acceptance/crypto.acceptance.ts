/**
 * CLI 密码能力黑盒验收（真实进程）。
 *
 * 覆盖 `info`/`verify` 子命令、加密文档转图片、退出码与敏感信息边界；
 * 所有用例只通过 `dist/bin.js` 子进程观察行为。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CRYPTO_CERT_USER,
  CRYPTO_FIXTURES,
  CRYPTO_PASSWORD,
  CRYPTO_PASSWORD_USER,
  CRYPTO_ROOT,
  cleanupTempDirs,
  createTempDir,
  listFiles,
  runCli,
} from './helpers.js';

/** 夹具文件绝对路径。 */
function fixture(name: string): string {
  return join(CRYPTO_FIXTURES, name);
}

/** 夹具证书绝对路径。 */
function cert(name: string): string {
  return join(CRYPTO_FIXTURES, 'certs', name);
}

afterEach(cleanupTempDirs);

describe('密码 CLI 验收：帮助与用法', () => {
  it('--help 列出 info/verify 子命令、凭据参数与新退出码', async () => {
    const cwd = await createTempDir();
    const result = await runCli(['--help'], { cwd });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ofdrw-viewer-cli info <input.ofd> [--json]');
    expect(result.stdout).toContain('ofdrw-viewer-cli verify <input.ofd>');
    for (const option of [
      '--user',
      '--password',
      '--key',
      '--key-passphrase',
      '--root',
      '--sm2-user-id',
      '--json',
    ]) {
      expect(result.stdout).toContain(option);
    }
    expect(result.stdout).toContain('4 加密/凭据失败');
    expect(result.stdout).toContain('5 验证未通过');
    expect(result.stderr).toBe('');
  });

  it('decrypt 子命令固定用法错误 1 且提示 verify', async () => {
    const cwd = await createTempDir();
    const result = await runCli(['decrypt', fixture('plain.ofd')], { cwd });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('CLI_USAGE');
    expect(result.stderr).toContain('不提供 decrypt 子命令');
    expect(result.stderr).toContain('verify');
  });

  it('info 缺少输入返回 1', async () => {
    const cwd = await createTempDir();
    const result = await runCli(['info'], { cwd });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('info 缺少输入文件');
    expect(result.stderr).toContain('用法: ofdrw-viewer-cli');
  });
});

describe('密码 CLI 验收：info 仅查询', () => {
  it('明文包 --json 输出固定字段且退出 0', async () => {
    const cwd = await createTempDir();
    const result = await runCli(['info', fixture('plain.ofd'), '--json'], { cwd });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      command: 'info',
      input: fixture('plain.ofd'),
      encrypted: false,
      layers: [],
      users: [],
      signatureCount: 0,
      integrityPresent: false,
      warnings: [],
    });
    expect(payload.packageSize).toBeGreaterThan(0);
    expect(payload.ofdVersion).toBe('1.0');
  });

  it('明文包 JSON 携带文档元数据/页尺寸，文本输出元数据摘要', async () => {
    const cwd = await createTempDir();
    const result = await runCli(['info', fixture('plain.ofd'), '--json'], { cwd });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const payload = JSON.parse(result.stdout) as {
      document?: {
        version: string;
        pageCount: number;
        pageSizes: Array<{ widthMm: number; heightMm: number }>;
        creationDate?: string;
        creator?: string;
        creatorVersion?: string;
      };
      ofdVersion?: string;
    };
    expect(payload.document).toMatchObject({
      version: '1.0',
      pageCount: 2,
      pageSizes: [
        { widthMm: 210, heightMm: 297 },
        { widthMm: 210, heightMm: 297 },
      ],
      creationDate: '2021-06-02',
      creator: 'OFD R&W',
      creatorVersion: '1.9.8',
    });
    expect(payload.document).not.toHaveProperty('title');
    expect(payload.ofdVersion).toBe(payload.document?.version);

    const text = await runCli(['info', fixture('plain.ofd')], { cwd });
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('标题: 无');
    expect(text.stdout).toContain('页数: 2');
    expect(text.stdout).toContain('页面尺寸: 第 1 页 210×297 mm');
    expect(text.stdout).toContain('创建工具: OFD R&W（1.9.8）');
  });

  it('加密包无需凭据也退出 0，文本展示层数与用户并提示元数据不可用', async () => {
    const cwd = await createTempDir();
    const result = await runCli(['info', fixture('password-encrypted.ofd')], { cwd });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('加密: 是（1 层）');
    expect(result.stdout).toContain(`用户: ${CRYPTO_PASSWORD_USER} (password)`);
    expect(result.stdout).toContain('完整性: 无');
    expect(result.stdout).toContain('元数据不可用（加密文档，需凭据）');
    expect(result.stdout).not.toContain('EncryptedWK');
    expect(result.stderr).toBe('');
  });

  it('签名与完整性只读摘要', async () => {
    const cwd = await createTempDir();
    const signed = await runCli(['info', fixture('signed-sesv4.ofd'), '--json'], {
      cwd,
    });
    expect(signed.code).toBe(0);
    expect(JSON.parse(signed.stdout)).toMatchObject({
      signatureCount: 1,
      integrityPresent: false,
    });

    const combined = await runCli(
      ['info', fixture('combined-signed-integrity.ofd'), '--json'],
      { cwd },
    );
    expect(combined.code).toBe(0);
    expect(JSON.parse(combined.stdout)).toMatchObject({
      signatureCount: 1,
      integrityPresent: true,
    });
  });

  it('info 带凭据或根证书固定退出 1', async () => {
    const cwd = await createTempDir();
    for (const args of [
      ['--user', CRYPTO_PASSWORD_USER],
      ['--password', 'whatever'],
      ['--key', cert('encrypt.key.pem')],
      ['--root', CRYPTO_ROOT],
    ]) {
      const result = await runCli(['info', fixture('plain.ofd'), ...args], { cwd });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('info 只查询');
      expect(result.stderr).not.toContain('whatever');
    }
  });

  it('非法包返回文档级失败 2', async () => {
    const cwd = await createTempDir();
    const bad = join(cwd, 'bad.ofd');
    await writeFile(bad, 'not a zip');
    const result = await runCli(['info', bad, '--json'], { cwd });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('CRYPTO_INVALID_PACKAGE');
    expect(result.stdout).toBe('');
  });
});

describe('密码 CLI 验收：verify 一次性验证', () => {
  it('配置根证书的有效签名退出 0，JSON 含报告与时间戳解析', async () => {
    const cwd = await createTempDir();
    const result = await runCli(
      [
        'verify',
        fixture('signed-sesv4.ofd'),
        '--root',
        CRYPTO_ROOT,
        '--json',
      ],
      { cwd },
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const payload = JSON.parse(result.stdout) as {
      command: string;
      input: string;
      report: {
        overall: string;
        rootsConfigured: boolean;
        signatures: { status: string; timestamp: { status: string; note: string } }[];
      };
    };
    expect(payload.command).toBe('verify');
    expect(payload.input).toBe(fixture('signed-sesv4.ofd'));
    expect(payload.report.overall).toBe('valid');
    expect(payload.report.rootsConfigured).toBe(true);
    expect(payload.report.signatures[0]).toMatchObject({
      status: 'valid',
      timestamp: { status: 'parsed-not-verified', note: '已解析，未验证' },
    });
    expect(result.stdout).not.toContain('BEGIN');
    expect(result.stdout).not.toContain(CRYPTO_PASSWORD);
    expect(result.stdout).not.toContain('EncryptedWK');
  });

  it('未配置根证书为 unknown 并退出 5', async () => {
    const cwd = await createTempDir();
    const result = await runCli(
      ['verify', fixture('signed-sesv4.ofd'), '--json'],
      { cwd },
    );

    expect(result.code).toBe(5);
    expect(JSON.parse(result.stdout)).toMatchObject({
      report: { overall: 'unknown', rootsConfigured: false },
    });
    expect(result.stderr).toContain('W_CRYPTO_TRUST_UNKNOWN');
  });

  it('重复 --root 且混用 PEM/DER 仍判定 valid', async () => {
    const cwd = await createTempDir();
    const result = await runCli(
      [
        'verify',
        fixture('signed-sesv4.ofd'),
        '--root',
        CRYPTO_ROOT,
        '--root',
        cert('root-ca.crt.der'),
        '--root',
        CRYPTO_ROOT,
        '--json',
      ],
      { cwd },
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      report: { overall: 'valid', rootsConfigured: true },
    });
  });

  it('篡改内容与夹带文件均退出 5 且状态 invalid', async () => {
    const cwd = await createTempDir();
    for (const [file, key] of [
      ['negative-tampered-content.ofd', 'signatures'],
      ['negative-extra-file.ofd', 'integrity'],
    ] as const) {
      const result = await runCli(
        ['verify', fixture(file), '--root', CRYPTO_ROOT, '--json'],
        { cwd },
      );
      expect(result.code).toBe(5);
      const payload = JSON.parse(result.stdout) as {
        report: { overall: string; integrity: { status: string } | null };
      };
      expect(payload.report.overall).toBe('invalid');
      if (key === 'integrity') {
        expect(payload.report.integrity?.status).toBe('invalid');
      }
    }
  });

  it('口令加密的签名+完整性包可用凭据完成验证', async () => {
    const cwd = await createTempDir();
    const result = await runCli(
      [
        'verify',
        fixture('combined-password-encrypted.ofd'),
        '--user',
        CRYPTO_PASSWORD_USER,
        '--password',
        CRYPTO_PASSWORD,
        '--root',
        CRYPTO_ROOT,
        '--json',
      ],
      { cwd },
    );

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      report: {
        overall: string;
        package: { encrypted: boolean; decrypted: boolean };
        decryption?: { layers: unknown[] };
      };
    };
    expect(payload.report.overall).toBe('valid');
    expect(payload.report.package).toMatchObject({ encrypted: true, decrypted: true });
    expect(payload.report.decryption?.layers.length).toBe(1);
    expect(result.stdout).not.toContain(CRYPTO_PASSWORD);
    expect(result.stderr).not.toContain(CRYPTO_PASSWORD);
  });

  it('加密包缺少凭据退出 4，不输出报告', async () => {
    const cwd = await createTempDir();
    const result = await runCli(
      ['verify', fixture('password-encrypted.ofd'), '--json'],
      { cwd },
    );

    expect(result.code).toBe(4);
    expect(result.stderr).toContain('CRYPTO_CREDENTIALS_REQUIRED');
    expect(result.stdout).toBe('');
  });

  it('错误口令退出 4 且不回显口令', async () => {
    const cwd = await createTempDir();
    const secret = 'WrongFixturePass456';
    const result = await runCli(
      [
        'verify',
        fixture('password-encrypted.ofd'),
        '--user',
        CRYPTO_PASSWORD_USER,
        '--password',
        secret,
        '--json',
      ],
      { cwd },
    );

    expect(result.code).toBe(4);
    expect(result.stderr).toContain('CRYPTO_WRONG_PASSWORD');
    expect(result.stderr).not.toContain(secret);
    expect(result.stdout).not.toContain(secret);
  });

  it('自定义 SM2 userId 使签名 invalid 并退出 5', async () => {
    const cwd = await createTempDir();
    const result = await runCli(
      [
        'verify',
        fixture('signed-sesv4.ofd'),
        '--root',
        CRYPTO_ROOT,
        '--sm2-user-id',
        'not-default-id',
        '--json',
      ],
      { cwd },
    );

    expect(result.code).toBe(5);
    expect(JSON.parse(result.stdout)).toMatchObject({
      report: { overall: 'invalid' },
    });
  });

  it('verify 不接受转图片参数', async () => {
    const cwd = await createTempDir();
    const result = await runCli(
      ['verify', fixture('plain.ofd'), '--out', join(cwd, 'out')],
      { cwd },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('verify 不接受转图片参数');
  });
});

describe('密码 CLI 验收：加密文档转图片', () => {
  it('口令加密文档用 --user/--password 转出 PNG', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const result = await runCli(
      [
        fixture('password-encrypted.ofd'),
        '-o',
        outDir,
        '--user',
        CRYPTO_PASSWORD_USER,
        '--password',
        CRYPTO_PASSWORD,
      ],
      { cwd },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('完成：2/2 页');
    expect(await listFiles(outDir)).toEqual([
      'password-encrypted-p001.png',
      'password-encrypted-p002.png',
    ]);
    expect((await readFile(join(outDir, 'password-encrypted-p001.png'))).subarray(0, 8).toString('hex')).toBe(
      '89504e470d0a1a0a',
    );
    expect(result.stdout).not.toContain(CRYPTO_PASSWORD);
    expect(result.stderr).not.toContain(CRYPTO_PASSWORD);
  });

  it('证书加密文档用 --key 转出 PNG', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const result = await runCli(
      [
        fixture('cert-encrypted.ofd'),
        '-o',
        outDir,
        '--user',
        CRYPTO_CERT_USER,
        '--key',
        cert('encrypt.key.pem'),
      ],
      { cwd },
    );

    expect(result.code).toBe(0);
    expect(await listFiles(outDir)).toEqual([
      'cert-encrypted-p001.png',
      'cert-encrypted-p002.png',
    ]);
    expect(result.stdout).not.toContain('BEGIN PRIVATE KEY');
    expect(result.stderr).not.toContain('BEGIN PRIVATE KEY');
  });

  it('缺少凭据时退出 4 且不产出页', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const result = await runCli(
      [fixture('password-encrypted.ofd'), '-o', outDir],
      { cwd },
    );

    expect(result.code).toBe(4);
    expect(result.stderr).toContain('CLI_CREDENTIALS_REQUIRED');
    expect(await listFiles(outDir)).toEqual([]);
  });

  it('错误口令退出 4 且不产出页', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const secret = 'WrongConvertPass789';
    const result = await runCli(
      [
        fixture('password-encrypted.ofd'),
        '-o',
        outDir,
        '--user',
        CRYPTO_PASSWORD_USER,
        '--password',
        secret,
      ],
      { cwd },
    );

    expect(result.code).toBe(4);
    expect(result.stderr).toContain('CRYPTO_WRONG_PASSWORD');
    expect(result.stderr).not.toContain(secret);
    expect(await listFiles(outDir)).toEqual([]);
  });

  it('转图片不接受 --root（用法错误 1）', async () => {
    const cwd = await createTempDir();
    const result = await runCli(
      [fixture('plain.ofd'), '-o', join(cwd, 'out'), '--root', CRYPTO_ROOT],
      { cwd },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('转图片不接受');
  });

  it('明文文档带凭据时忽略凭据并保持原有输出', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const result = await runCli(
      [
        fixture('plain.ofd'),
        '-o',
        outDir,
        '--user',
        CRYPTO_PASSWORD_USER,
        '--password',
        CRYPTO_PASSWORD,
      ],
      { cwd },
    );

    expect(result.code).toBe(0);
    expect(await listFiles(outDir)).toEqual(['plain-p001.png', 'plain-p002.png']);
    expect(result.stderr).toContain('W_CRYPTO_CREDENTIAL_IGNORED');
  });

  it('加密文档转换保留 --pages/--format/--text 语义', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const result = await runCli(
      [
        fixture('password-encrypted.ofd'),
        '-o',
        outDir,
        '--pages',
        '2',
        '--format',
        'jpeg',
        '--text',
        '--user',
        CRYPTO_PASSWORD_USER,
        '--password',
        CRYPTO_PASSWORD,
      ],
      { cwd },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('完成：1/1 页（图片 + 文本）');
    expect(await listFiles(outDir)).toEqual([
      'password-encrypted-p002.jpg',
      'password-encrypted-p002.json',
    ]);
  });
});