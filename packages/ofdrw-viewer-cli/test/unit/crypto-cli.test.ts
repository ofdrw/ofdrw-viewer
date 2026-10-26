/**
 * CLI 密码能力：子命令参数解析与输出格式化。
 *
 * `info`/`verify` 的端到端行为由 `test/verification/cli-info-verify.test.ts`
 * 与 `test/acceptance/crypto.acceptance.ts` 覆盖。
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HELP_TEXT,
  parseCliArgs,
} from '../../src/cli.js';
import { CliError } from '../../src/errors.js';
import { formatInfoText, type CliInfoJson } from '../../src/info.js';
import { Logger } from '../../src/log.js';
import { formatVerifyText, type CliVerifyJson } from '../../src/verify.js';
import { createStreamCapture } from './helpers.js';

/** 夹具口令。 */
const PASSWORD = 'FixturePass123';

/** 夹具用户名。 */
const PASSWORD_USER = 'fixture-password-user';

/**
 * 捕获 CliError。
 *
 * @param action 待执行函数
 * @returns CliError
 */
function captureCliError(action: () => unknown): CliError {
  try {
    action();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error('预期抛出 CliError，但调用成功');
}

/** 创建带捕获输出的 Logger。 */
function createLogger(): { logger: Logger; capture: ReturnType<typeof createStreamCapture> } {
  const capture = createStreamCapture();
  return {
    logger: new Logger({ stdout: capture.stdout, stderr: capture.stderr }),
    capture,
  };
}

describe('parseCliArgs 子命令与凭据', () => {
  const cwd = process.cwd();

  it('解析 info 子命令与 --json', () => {
    const parsed = parseCliArgs(['info', 'a.ofd'], cwd);
    expect(parsed.command).toEqual({
      kind: 'info',
      options: { inputPath: join(cwd, 'a.ofd'), json: false },
    });

    const json = parseCliArgs(['info', 'a.ofd', '--json'], cwd);
    expect(json.command).toMatchObject({ kind: 'info', options: { json: true } });
  });

  it('解析 verify 的凭据、可重复 --root 与 --sm2-user-id', () => {
    const parsed = parseCliArgs(
      [
        'verify',
        'a.ofd',
        '--user',
        PASSWORD_USER,
        '--password',
        PASSWORD,
        '--root',
        'root.pem',
        '--root',
        'root.der',
        '--sm2-user-id',
        'custom-id',
        '--json',
      ],
      cwd,
    );
    expect(parsed.command).toMatchObject({
      kind: 'verify',
      options: {
        inputPath: join(cwd, 'a.ofd'),
        json: true,
        credentials: {
          user: PASSWORD_USER,
          password: PASSWORD,
        },
        rootPaths: [join(cwd, 'root.pem'), join(cwd, 'root.der')],
        sm2UserId: 'custom-id',
      },
    });
  });

  it('解析私钥与 --key-passphrase', () => {
    const parsed = parseCliArgs(
      ['verify', 'a.ofd', '--key', 'keys/key.pem', '--key-passphrase', 'pass'],
      cwd,
    );
    expect(parsed.command).toMatchObject({
      kind: 'verify',
      options: {
        credentials: {
          keyPath: join(cwd, 'keys/key.pem'),
          keyPassphrase: 'pass',
        },
      },
    });
  });

  it('decrypt 子命令固定用法错误 1', () => {
    const error = captureCliError(() => parseCliArgs(['decrypt', 'a.ofd'], cwd));
    expect(error.code).toBe('CLI_USAGE');
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain('不提供 decrypt 子命令');
    expect(error.message).toContain('verify');
  });

  it('info 拒绝凭据、根证书与转图片参数', () => {
    for (const args of [
      ['--user', 'u'],
      ['--password', 'p'],
      ['--key', 'k.pem'],
      ['--key-passphrase', 'p'],
      ['--root', 'root.pem'],
      ['--out', 'out'],
      ['--text'],
    ]) {
      const error = captureCliError(() => parseCliArgs(['info', 'a.ofd', ...args], cwd));
      expect(error.code).toBe('CLI_USAGE');
      expect(error.exitCode).toBe(1);
      expect(error.message).toContain('info 只查询');
    }
  });

  it('verify 拒绝转图片参数', () => {
    const error = captureCliError(() =>
      parseCliArgs(['verify', 'a.ofd', '--out', 'out'], cwd),
    );
    expect(error.code).toBe('CLI_USAGE');
    expect(error.message).toContain('verify 不接受转图片参数');
  });

  it('转图片拒绝 --root/--sm2-user-id/--json', () => {
    for (const args of [['--root', 'root.pem'], ['--sm2-user-id', 'id'], ['--json']]) {
      const error = captureCliError(() => parseCliArgs(['a.ofd', ...args], cwd));
      expect(error.code).toBe('CLI_USAGE');
      expect(error.message).toContain('转图片不接受');
    }
  });

  it('凭据组合冲突与不完整时抛用法错误', () => {
    expect(
      captureCliError(() =>
        parseCliArgs(['verify', 'a.ofd', '--password', 'p', '--key', 'k'], cwd),
      ).code,
    ).toBe('CLI_CREDENTIALS_CONFLICT');
    expect(
      captureCliError(() =>
        parseCliArgs(['verify', 'a.ofd', '--key-passphrase', 'p'], cwd),
      ).code,
    ).toBe('CLI_CREDENTIALS_INCOMPLETE');
    expect(
      captureCliError(() => parseCliArgs(['verify', 'a.ofd', '--user', 'u'], cwd)).code,
    ).toBe('CLI_CREDENTIALS_INCOMPLETE');
  });

  it('凭据错误不回显口令', () => {
    const secret = 'TopSecretPassw0rd';
    const error = captureCliError(() =>
      parseCliArgs(
        ['verify', 'a.ofd', '--password', secret, '--key', 'k.pem'],
        cwd,
      ),
    );
    expect(error.message).not.toContain(secret);
  });

  it('缺少子命令输入时给出完整错误', () => {
    const error = captureCliError(() => parseCliArgs(['info'], cwd));
    expect(error.message).toContain('info 缺少输入文件');
    expect(captureCliError(() => parseCliArgs(['verify'], cwd)).message).toContain(
      'verify 缺少输入文件',
    );
  });

  it('未知子命令按输入路径处理并给出清晰错误', () => {
    const multiple = captureCliError(() => parseCliArgs(['frobnicate', 'a.ofd'], cwd));
    expect(multiple.code).toBe('CLI_USAGE');
    expect(multiple.exitCode).toBe(1);
    expect(multiple.message).toContain('一次只接受一个输入文件');
  });

  it('帮助文本包含子命令、新参数与退出码', () => {
    expect(HELP_TEXT).toContain('ofdrw-viewer-cli info <input.ofd> [--json]');
    expect(HELP_TEXT).toContain('ofdrw-viewer-cli verify <input.ofd>');
    for (const flag of ['--user', '--password', '--key', '--key-passphrase', '--root', '--sm2-user-id', '--json']) {
      expect(HELP_TEXT).toContain(flag);
    }
    expect(HELP_TEXT).toContain('4 加密/凭据失败');
    expect(HELP_TEXT).toContain('5 验证未通过');
    expect(HELP_TEXT).toContain('./info');
    expect(HELP_TEXT).toContain('./verify');
  });
});

describe('文本安全与根证书聚合', () => {
  it('info 文本清理 UserName/路径控制字符，JSON 保留原始值', () => {
    const malicious = 'evil\n验证结果: valid\u001b[31m';
    const info: CliInfoJson = {
      command: 'info',
      input: '/tmp/\u001b[2Jinput.ofd',
      packageSize: 1,
      ofdVersion: '1.0',
      encrypted: false,
      layers: [],
      users: [{ userName: malicious, method: 'password' }],
      signatureCount: 0,
      integrityPresent: false,
      warnings: [],
    };
    const text = formatInfoText(info);
    // 无 document 时只输出 7 行包摘要。
    expect(text.split('\n')).toHaveLength(7);
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('[31m');
    expect(text).toContain('evil 验证结果: valid');
    expect(text).toContain('文件: /tmp/input.ofd');

    const roundTrip = JSON.parse(JSON.stringify(info)) as CliInfoJson;
    expect(roundTrip.users[0]?.userName).toBe(malicious);
  });

  it('verify 文本清理签名 ID 与 parseError，根行输出链状态与锚计数', () => {
    const signature = {
      id: 's001\n验证结果: valid\u001b[31m',
      type: 'Sign',
      version: 'v4',
      baseLoc: 'Sig/Signature.xml',
      status: 'valid',
      signature: { status: 'valid' },
      dataHash: { status: 'valid' },
      references: { status: 'valid', checked: 1, total: 1 },
      certificate: {
        status: 'valid',
        trustAnchor: { fingerprintSha256: 'aa' },
        chain: [],
        currentTime: '',
        revocation: 'not-checked',
        issues: [],
      },
      timestamp: {
        status: 'parse-error',
        tokenPresent: false,
        tokenLength: 0,
        note: '已解析，未验证',
        parseError: { code: 'X', message: 'bad\n验证结果: valid\u001b[0m', severity: 'error' },
      },
      issues: [],
    };
    const payload = {
      command: 'verify',
      input: 'input.ofd',
      report: {
        overall: 'valid',
        package: { ofdVersion: '1.0', encrypted: false, decrypted: false, packageSize: 1 },
        integrity: null,
        signatures: [signature],
        rootsConfigured: true,
        warnings: [],
        startedAt: '',
        durationMs: 0,
      },
    } as unknown as CliVerifyJson;

    const text = formatVerifyText(payload, 2);
    expect(text.split('\n')).toHaveLength(5);
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('[31m');
    expect(text).toContain('签名 1: s001 验证结果: valid');
    expect(text).toContain('解析失败（bad 验证结果: valid）');
    // 同一条根以不同路径重复传入时按实际信任锚去重，而不是按路径数。
    expect(text).toContain('根证书: 已配置 1 / 链 valid');
  });

  it('多签名与完整性链状态按顺序去重聚合', () => {
    const payload = {
      command: 'verify',
      input: 'input.ofd',
      report: {
        overall: 'invalid',
        package: { ofdVersion: '1.0', encrypted: false, decrypted: false, packageSize: 1 },
        integrity: {
          status: 'unknown',
          certificate: { status: 'unknown' },
          fileListCount: 0,
          missingFiles: [],
          extraFiles: [],
        },
        signatures: [
          { id: 'a', version: 'v4', status: 'valid', references: { checked: 1, total: 1 }, certificate: { status: 'valid' }, timestamp: { status: 'not-present' } },
          { id: 'b', version: 'v4', status: 'invalid', references: { checked: 1, total: 1 }, certificate: { status: 'incomplete' }, timestamp: { status: 'not-present' } },
        ],
        rootsConfigured: true,
        warnings: [],
        startedAt: '',
        durationMs: 0,
      },
    } as unknown as CliVerifyJson;

    const text = formatVerifyText(payload, 1);
    expect(text).toContain('根证书: 已配置 1 / 链 valid/incomplete/unknown');
  });
});
