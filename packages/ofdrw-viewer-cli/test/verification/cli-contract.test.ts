/**
 * V-CLI 独立验证：参数、帮助、子命令、退出码与向后兼容。
 *
 * 解析层直接调用 `parseCliArgs`，端到端只经 `main`；不复用 unit 测试的
 * 断言，覆盖旧转图片用法与新子命令的边界。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import {
  HELP_TEXT,
  main,
  parseCliArgs,
} from '../../src/cli.js';
import { CliError } from '../../src/errors.js';
import { cleanupTempDirs, createTempDir, fixture, PASSWORD, runMain } from './support.js';

afterEach(cleanupTempDirs);

/** 捕获解析错误。 */
function captureCliError(action: () => unknown): CliError {
  try {
    action();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error('预期抛出 CliError，但调用成功');
}

describe('V-CLI 参数与向后兼容', () => {
  it('旧用法 <input.ofd> [options] 仍解析为 convert，默认值不变', () => {
    const cwd = '/tmp/v-cli-cwd';
    const parsed = parseCliArgs(['发票.ofd'], cwd);
    expect(parsed.command).toMatchObject({
      kind: 'convert',
      options: {
        inputPath: join(cwd, '发票.ofd'),
        outDir: join(cwd, '发票'),
        format: 'png',
        dpi: 96,
        pageNumbers: undefined,
        fontDir: undefined,
        text: false,
        credentials: {},
      },
    });
  });

  it('旧用法全部转图片参数仍可解析，--text 保持开关语义', () => {
    const cwd = '/tmp/v-cli-cwd';
    const parsed = parseCliArgs(
      ['in.ofd', '-o', 'out', '-f', 'WEBP', '-d', '144', '-p', '2,1-2', '--text', '--font-dir', 'fonts'],
      cwd,
    );
    expect(parsed.command).toMatchObject({
      kind: 'convert',
      options: {
        inputPath: join(cwd, 'in.ofd'),
        outDir: join(cwd, 'out'),
        format: 'webp',
        dpi: 144,
        pageNumbers: [1, 2],
        fontDir: join(cwd, 'fonts'),
        text: true,
      },
    });
  });

  it('--help 优先于输入校验，列出新旧用法、凭据与退出码', async () => {
    const result = await runMain(['--help'], '/tmp');
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('用法: ofdrw-viewer-cli <input.ofd> [options]');
    expect(result.stdout).toContain('ofdrw-viewer-cli info <input.ofd> [--json]');
    expect(result.stdout).toContain('ofdrw-viewer-cli verify <input.ofd>');
    for (const flag of [
      '--out',
      '--format',
      '--dpi',
      '--pages',
      '--text',
      '--user',
      '--password',
      '--key',
      '--key-passphrase',
      '--root',
      '--sm2-user-id',
      '--json',
    ]) {
      expect(result.stdout).toContain(flag);
    }
    expect(result.stdout).toContain('4 加密/凭据失败');
    expect(result.stdout).toContain('5 验证未通过');
    expect(result.stdout).not.toContain('ofdrw-viewer-cli decrypt');
  });

  it('--version 不要求输入并注入平台/架构', async () => {
    const result = await runMain(['--version'], '/tmp');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/ofdrw-viewer-cli \d+\.\d+\.\d+ \(verification-os-verification-arch\)/);
  });

  it('未知参数、多输入、info/verify 缺输入均退出 1 且给用法提示', async () => {
    const cases: { args: string[]; message: string }[] = [
      { args: ['--unknown'], message: '未知参数：--unknown' },
      { args: [fixture('plain.ofd'), '--unknown'], message: '未知参数：--unknown' },
      { args: [fixture('plain.ofd'), fixture('plain.ofd')], message: '一次只接受一个输入文件' },
      { args: ['info'], message: 'info 缺少输入文件' },
      { args: ['verify'], message: 'verify 缺少输入文件' },
      { args: ['frobnicate', 'a.ofd'], message: '一次只接受一个输入文件' },
    ];
    const cwd = await createTempDir();
    for (const item of cases) {
      const result = await runMain(item.args, cwd);
      expect(result.code, item.args.join(' ')).toBe(1);
      expect(result.stderr, item.args.join(' ')).toContain(item.message);
      expect(result.stderr).toContain('用法: ofdrw-viewer-cli');
      expect(result.stdout).toBe('');
    }
  });

  it('未知子命令单独出现时按输入路径处理，不崩溃且退出 1', async () => {
    const cwd = await createTempDir();
    const result = await runMain(['frobnicate'], cwd);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('CLI_INPUT_NOT_FOUND');
    expect(result.stderr).toContain('输入文件不存在');
  });

  it('info 拒绝凭据、根证书与转图片参数，错误不回显值', async () => {
    const cwd = await createTempDir();
    const secret = 'ShouldNotLeakInfoPass';
    for (const args of [
      ['--user', 'u'],
      ['--password', secret],
      ['--key', 'k.pem'],
      ['--key-passphrase', secret],
      ['--root', 'root.pem'],
      ['--out', 'out'],
      ['--format', 'png'],
      ['--dpi', '96'],
      ['--pages', '1'],
      ['--font-dir', 'fonts'],
      ['--text'],
      ['--sm2-user-id', 'id'],
    ]) {
      const result = await runMain(['info', fixture('plain.ofd'), ...args], cwd);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.stderr, args.join(' ')).toContain('info 不接受参数');
      expect(result.stderr, args.join(' ')).not.toContain(secret);
    }
  });

  it('verify 拒绝转图片参数，保留凭据/根/JSON 参数', async () => {
    const cwd = await createTempDir();
    for (const args of [
      ['--out', 'out'],
      ['--format', 'png'],
      ['--dpi', '96'],
      ['--pages', '1'],
      ['--font-dir', 'fonts'],
      ['--text'],
    ]) {
      const result = await runMain(['verify', fixture('plain.ofd'), ...args], cwd);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.stderr, args.join(' ')).toContain('verify 不接受参数');
    }

    const ok = await runMain(['verify', fixture('plain.ofd'), '--json'], cwd);
    expect(ok.code).toBe(5); // 无签名/完整性 → not-applicable，不是用法错误
    expect(ok.stderr).not.toContain('不接受参数');
  });

  it('转图片拒绝 --root/--sm2-user-id/--json，旧参数仍可用', async () => {
    const cwd = await createTempDir();
    for (const args of [
      ['--root', 'root.pem'],
      ['--sm2-user-id', 'id'],
      ['--json'],
    ]) {
      const result = await runMain([fixture('plain.ofd'), ...args], cwd);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.stderr, args.join(' ')).toContain('转图片不接受');
    }
    const parsed = parseCliArgs([fixture('plain.ofd'), '--pages', '1', '--text'], cwd);
    expect(parsed.command).toMatchObject({ kind: 'convert', options: { pageNumbers: [1], text: true } });
  });

  it('凭据组合冲突/不完整以及 decrypt 均退出 1，且不泄漏 argv 秘密', async () => {
    const cwd = await createTempDir();
    const secret = 'ArgvSecret_987654';
    const errors = [
      [['verify', fixture('plain.ofd'), '--password', secret, '--key', 'k.pem'], 'CLI_CREDENTIALS_CONFLICT'],
      [['verify', fixture('plain.ofd'), '--key-passphrase', secret], 'CLI_CREDENTIALS_INCOMPLETE'],
      [['verify', fixture('plain.ofd'), '--user', 'u'], 'CLI_CREDENTIALS_INCOMPLETE'],
      [['verify', fixture('plain.ofd'), '--user', ''], '--user 不能为空'],
      [['verify', fixture('plain.ofd'), '--sm2-user-id', '  '], '--sm2-user-id 不能为空'],
    ] as const;
    for (const [args, expected] of errors) {
      const result = await runMain(args, cwd);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.stderr, args.join(' ')).toContain(expected);
      expect(result.stderr, args.join(' ')).not.toContain(secret);
      expect(result.stdout).toBe('');
    }

    const decrypt = await runMain(['decrypt', fixture('plain.ofd')], cwd);
    expect(decrypt.code).toBe(1);
    expect(decrypt.stderr).toContain('不提供 decrypt 子命令');
    expect(decrypt.stderr).toContain('verify');
  });

  it('parseCliArgs 的 -h/-V 短选项等价于 --help/--version', () => {
    const cwd = '/tmp';
    expect(parseCliArgs(['-h'], cwd)).toEqual({ help: true, version: false });
    expect(parseCliArgs(['-V'], cwd)).toEqual({ help: false, version: true });
    expect(HELP_TEXT).toContain('--json');
  });
});

describe('V-CLI 源码边界（复用 crypto）', () => {
  it('info 只 import inspect；verify 只 import verifyOfd；convert 只 import 解密入口', () => {
    const read = (name: string): string =>
      readFileSync(new URL(`../../src/${name}`, import.meta.url), 'utf8');
    const info = read('info.ts');
    expect(info).toContain("import { inspect } from '@ofdrw/ofdrw-viewer-crypto'");
    expect(info).not.toContain('verifyOfd');
    expect(info).not.toContain('openDecryptingContainer');

    const verify = read('verify.ts');
    expect(verify).toContain("import { verifyOfd } from '@ofdrw/ofdrw-viewer-crypto'");
    expect(verify).not.toContain("from 'sm-crypto'");

    const convert = read('convert.ts');
    expect(convert).toContain("import { openDecryptingContainer }");
    expect(convert).not.toContain("from 'sm-crypto'");
  });

  it('CLI 不引入 sm-crypto，也不实现 SM3/SM4 原语', async () => {
    const names = ['cli.ts', 'convert.ts', 'credentials.ts', 'info.ts', 'verify.ts'];
    for (const name of names) {
      const source = readFileSync(new URL(`../../src/${name}`, import.meta.url), 'utf8');
      expect(source, name).not.toMatch(/from ['"]sm-crypto['"]/);
      expect(source, name).not.toMatch(/function\s+(sm3|sm4|sm2)\b/i);
      expect(source, name).not.toMatch(/SM4-CBC|EncryptedWK/);
    }
  });
});
