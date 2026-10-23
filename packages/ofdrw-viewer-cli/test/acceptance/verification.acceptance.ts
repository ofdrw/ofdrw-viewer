/**
 * V-CLI 独立黑盒验收：构建后的 dist/bin.js 与 SEA 可执行文件。
 *
 * 与既有 crypto.acceptance.ts 的场景分开，独立观察帮助、info/verify、
 * 加密转换和错误凭据；SEA 额外覆盖新增 crypto 子命令与加密转换。
 */

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
  readHexPrefix,
  runCli,
  runSea,
} from './helpers.js';

/** 夹具路径。 */
function fixture(name: string): string {
  return join(CRYPTO_FIXTURES, name);
}

afterEach(cleanupTempDirs);

describe('V-CLI 构建产物验收：帮助与子命令边界', () => {
  it('帮助含新旧用法与退出码；decrypt 明确拒绝', async () => {
    const cwd = await createTempDir();
    const help = await runCli(['--help'], { cwd });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('用法: ofdrw-viewer-cli <input.ofd> [options]');
    expect(help.stdout).toContain('ofdrw-viewer-cli info <input.ofd> [--json]');
    expect(help.stdout).toContain('ofdrw-viewer-cli verify <input.ofd>');
    expect(help.stdout).toContain('4 加密/凭据失败');
    expect(help.stdout).toContain('5 验证未通过');
    expect(help.stdout).toContain('./info');
    expect(help.stdout).toContain('./verify');
    expect(help.stdout).not.toContain('ofdrw-viewer-cli decrypt');

    const decrypt = await runCli(['decrypt', fixture('plain.ofd')], { cwd });
    expect(decrypt.code).toBe(1);
    expect(decrypt.stderr).toContain('不提供 decrypt 子命令');
    expect(decrypt.stdout).toBe('');
  });

  it('未知参数/多输入返回 1，旧转图片参数仍可解析', async () => {
    const cwd = await createTempDir();
    const unknown = await runCli([fixture('plain.ofd'), '--unknown'], { cwd });
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('未知参数');

    const multiple = await runCli(['frobnicate', fixture('plain.ofd')], { cwd });
    expect(multiple.code).toBe(1);
    expect(multiple.stderr).toContain('一次只接受一个输入文件');

    const out = join(cwd, 'out');
    const legacy = await runCli(
      [fixture('plain.ofd'), '-o', out, '--pages', '1', '--text'],
      { cwd },
    );
    expect(legacy.code).toBe(0);
    expect(await listFiles(out)).toEqual(['plain-p001.json', 'plain-p001.png']);
  });
});

describe('V-CLI 构建产物验收：info 与 verify', () => {
  it('info 加密包无需凭据、JSON 字段固定且文本说明加密状态', async () => {
    const cwd = await createTempDir();
    const json = await runCli(
      ['info', fixture('password-encrypted.ofd'), '--json'],
      { cwd },
    );
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.stdout) as {
      command: string;
      encrypted: boolean;
      layers: unknown[];
      users: { userName: string; method: string }[];
      signatureCount: number;
      integrityPresent: boolean;
    };
    expect(payload).toMatchObject({
      command: 'info',
      encrypted: true,
      signatureCount: 0,
      integrityPresent: false,
    });
    expect(payload.layers).toHaveLength(1);
    expect(payload.users[0]).toMatchObject({
      userName: CRYPTO_PASSWORD_USER,
      method: 'password',
    });

    const text = await runCli(['info', fixture('password-encrypted.ofd')], { cwd });
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('加密: 是（1 层）');
    expect(text.stdout).toContain(`用户: ${CRYPTO_PASSWORD_USER} (password)`);
    expect(text.stdout).not.toContain('EncryptedWK');
    expect(text.stderr).toBe('');
  });

  it('verify 配根证书 valid、无根 unknown、篡改 invalid，JSON/文本一致', async () => {
    const cwd = await createTempDir();
    const valid = await runCli(
      ['verify', fixture('signed-sesv4.ofd'), '--root', CRYPTO_ROOT, '--json'],
      { cwd },
    );
    expect(valid.code).toBe(0);
    expect(valid.stderr).toBe('');
    const validPayload = JSON.parse(valid.stdout) as {
      report: { overall: string; rootsConfigured: boolean; signatures: { timestamp: { status: string; note: string } }[] };
    };
    expect(validPayload.report.overall).toBe('valid');
    expect(validPayload.report.rootsConfigured).toBe(true);
    expect(validPayload.report.signatures[0]?.timestamp).toMatchObject({
      status: 'parsed-not-verified',
      note: '已解析，未验证',
    });
    expect(valid.stdout).not.toContain('验证通过');

    const unknown = await runCli(
      ['verify', fixture('signed-sesv4.ofd'), '--json'],
      { cwd },
    );
    expect(unknown.code).toBe(5);
    const unknownPayload = JSON.parse(unknown.stdout) as {
      report: { overall: string; rootsConfigured: boolean };
    };
    expect(unknownPayload.report).toMatchObject({
      overall: 'unknown',
      rootsConfigured: false,
    });
    expect(unknown.stderr).toContain('W_CRYPTO_TRUST_UNKNOWN');

    const invalid = await runCli(
      ['verify', fixture('negative-tampered-content.ofd'), '--root', CRYPTO_ROOT, '--json'],
      { cwd },
    );
    expect(invalid.code).toBe(5);
    expect((JSON.parse(invalid.stdout) as { report: { overall: string } }).report.overall).toBe(
      'invalid',
    );

    const text = await runCli(
      ['verify', fixture('negative-tampered-content.ofd'), '--root', CRYPTO_ROOT],
      { cwd },
    );
    expect(text.code).toBe(5);
    expect(text.stdout).toContain('验证结果: invalid');
  });

  it('加密文档 verify 需凭据；缺凭据退出 4 且无报告', async () => {
    const cwd = await createTempDir();
    const missing = await runCli(
      ['verify', fixture('password-encrypted.ofd'), '--json'],
      { cwd },
    );
    expect(missing.code).toBe(4);
    expect(missing.stderr).toContain('CRYPTO_CREDENTIALS_REQUIRED');
    expect(missing.stdout).toBe('');
  });
});

describe('V-CLI 构建产物验收：加密文档转图片', () => {
  it('口令路径与私钥路径均成功导出图片', async () => {
    const cwd = await createTempDir();
    const passwordOut = join(cwd, 'password-out');
    const password = await runCli(
      [
        fixture('password-encrypted.ofd'),
        '-o',
        passwordOut,
        '--user',
        CRYPTO_PASSWORD_USER,
        '--password',
        CRYPTO_PASSWORD,
      ],
      { cwd },
    );
    expect(password.code).toBe(0);
    expect(await listFiles(passwordOut)).toEqual([
      'password-encrypted-p001.png',
      'password-encrypted-p002.png',
    ]);
    expect(await readHexPrefix(join(passwordOut, 'password-encrypted-p001.png'), 8)).toBe(
      '89504e470d0a1a0a',
    );
    expect(password.stdout).not.toContain(CRYPTO_PASSWORD);

    const certOut = join(cwd, 'cert-out');
    const cert = await runCli(
      [
        fixture('cert-encrypted.ofd'),
        '-o',
        certOut,
        '--user',
        CRYPTO_CERT_USER,
        '--key',
        join(CRYPTO_FIXTURES, 'certs', 'encrypt.key.pem'),
      ],
      { cwd },
    );
    expect(cert.code).toBe(0);
    expect(await listFiles(certOut)).toEqual([
      'cert-encrypted-p001.png',
      'cert-encrypted-p002.png',
    ]);
    expect(await readHexPrefix(join(certOut, 'cert-encrypted-p001.png'), 8)).toBe(
      '89504e470d0a1a0a',
    );
    expect(cert.stdout).not.toContain('BEGIN PRIVATE KEY');
  });

  it('错误凭据退出 4、不产页且不回显秘密', async () => {
    const cwd = await createTempDir();
    const out = join(cwd, 'out');
    const secret = 'WrongAcceptanceSecret_42';
    const result = await runCli(
      [
        fixture('password-encrypted.ofd'),
        '-o',
        out,
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
    expect(result.stdout).not.toContain(secret);
    expect(await listFiles(out)).toEqual([]);
  });
});

describe('V-CLI SEA 验收：新增子命令与加密转换', () => {
  it('SEA info 可查询加密包，verify 可用根证书验证', async () => {
    const cwd = await createTempDir();
    const info = await runSea(['info', fixture('password-encrypted.ofd'), '--json'], {
      cwd,
      timeoutMs: 120_000,
    });
    expect(info.code).toBe(0);
    expect(JSON.parse(info.stdout)).toMatchObject({
      command: 'info',
      encrypted: true,
      users: [{ userName: CRYPTO_PASSWORD_USER, method: 'password' }],
    });

    const verify = await runSea(
      ['verify', fixture('signed-sesv4.ofd'), '--root', CRYPTO_ROOT, '--json'],
      { cwd, timeoutMs: 120_000 },
    );
    expect(verify.code).toBe(0);
    expect(JSON.parse(verify.stdout)).toMatchObject({
      command: 'verify',
      report: { overall: 'valid', rootsConfigured: true },
    });
  });

  it('SEA 可用口令解密并导出一页图片', async () => {
    const cwd = await createTempDir();
    const out = join(cwd, 'out');
    const result = await runSea(
      [
        fixture('password-encrypted.ofd'),
        '-o',
        out,
        '--pages',
        '1',
        '--user',
        CRYPTO_PASSWORD_USER,
        '--password',
        CRYPTO_PASSWORD,
      ],
      { cwd, timeoutMs: 180_000 },
    );
    expect(result.code).toBe(0);
    expect(await listFiles(out)).toEqual(['password-encrypted-p001.png']);
    expect(await readHexPrefix(join(out, 'password-encrypted-p001.png'), 8)).toBe(
      '89504e470d0a1a0a',
    );
    expect(result.stdout).not.toContain(CRYPTO_PASSWORD);
  });
});
