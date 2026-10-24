/**
 * CLI 密码能力：参数解析、`info`/`verify` 输出、退出码与敏感信息边界。
 *
 * 直接调用源码中的 `runInfo`/`runVerify`/`main`，使用 crypto 共用夹具；
 * 黑盒子进程行为由 `test/acceptance/crypto.acceptance.ts` 覆盖。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CryptoError } from '@ofdrw/ofdrw-viewer-crypto';
import {
  HELP_TEXT,
  main,
  parseCliArgs,
} from '../../src/cli.js';
import { CliError } from '../../src/errors.js';
import { formatInfoText, runInfo, type CliInfoJson } from '../../src/info.js';
import { Logger } from '../../src/log.js';
import { formatVerifyText, runVerify, type CliVerifyJson } from '../../src/verify.js';
import { createStreamCapture } from './helpers.js';

/** crypto 共用夹具目录。 */
const FIXTURES = fileURLToPath(
  new URL('../../../ofdrw-viewer-crypto/test/fixtures/crypto/', import.meta.url),
);

/** 夹具口令。 */
const PASSWORD = 'FixturePass123';

/** 夹具用户名。 */
const PASSWORD_USER = 'fixture-password-user';

/** 夹具根证书。 */
const ROOT = join(FIXTURES, 'certs', 'root-ca.crt.pem');

/** 夹具签名私钥（仅用于断言不泄露）。 */
const SIGNER_KEY = join(FIXTURES, 'certs', 'signer.key.pem');

/** 临时目录登记。 */
const tempDirs: string[] = [];

/**
 * 创建并登记临时目录。
 *
 * @returns 目录绝对路径
 */
async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ofdrw-cli-crypto-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

/**
 * 捕获 CryptoError。
 *
 * @param promise 待执行 promise
 * @returns CryptoError
 */
async function captureCryptoError(promise: Promise<unknown>): Promise<CryptoError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CryptoError) return error;
    throw error;
  }
  throw new Error('预期抛出 CryptoError，但调用成功');
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

describe('runInfo', () => {
  it('明文包 JSON 固定字段', async () => {
    const { logger, capture } = createLogger();
    const code = await runInfo(
      { inputPath: join(FIXTURES, 'plain.ofd'), json: true },
      { logger },
    );
    expect(code).toBe(0);
    const info = JSON.parse(capture.stdoutText()) as CliInfoJson;
    expect(info).toMatchObject({
      command: 'info',
      input: join(FIXTURES, 'plain.ofd'),
      encrypted: false,
      layers: [],
      users: [],
      signatureCount: 0,
      integrityPresent: false,
      warnings: [],
    });
    expect(info.packageSize).toBeGreaterThan(0);
    expect(info.ofdVersion).toBe('1.0');
  });

  it('口令加密包文本输出层数与用户，退出 0 且无凭据要求', async () => {
    const { logger, capture } = createLogger();
    const code = await runInfo(
      { inputPath: join(FIXTURES, 'password-encrypted.ofd'), json: false },
      { logger },
    );
    expect(code).toBe(0);
    const text = capture.stdoutText();
    expect(text).toContain('加密: 是（1 层）');
    expect(text).toContain(`用户: ${PASSWORD_USER} (password)`);
    expect(text).not.toContain('EncryptedWK');
    expect(capture.stderrText()).toBe('');
  });

  it('签名与完整性存在性来自摘要而非验签', async () => {
    const { logger, capture } = createLogger();
    await runInfo(
      { inputPath: join(FIXTURES, 'signed-sesv4.ofd'), json: true },
      { logger },
    );
    const signed = JSON.parse(capture.stdoutText()) as CliInfoJson;
    expect(signed.signatureCount).toBe(1);
    expect(signed.integrityPresent).toBe(false);

    const second = createLogger();
    await runInfo(
      { inputPath: join(FIXTURES, 'combined-signed-integrity.ofd'), json: true },
      { logger: second.logger },
    );
    const combined = JSON.parse(second.capture.stdoutText()) as CliInfoJson;
    expect(combined.integrityPresent).toBe(true);
    expect(combined.signatureCount).toBe(1);
  });

  it('非法包抛 CryptoError', async () => {
    const dir = await createTempDir();
    const input = join(dir, 'bad.ofd');
    await writeFile(input, 'not a zip');
    const { logger } = createLogger();
    await expect(
      runInfo({ inputPath: input, json: true }, { logger }),
    ).rejects.toMatchObject({ code: 'CRYPTO_INVALID_PACKAGE' });
  });
});

describe('runVerify', () => {
  it('配置根证书后有效签名退出 0，JSON 结构固定', async () => {
    const { logger, capture } = createLogger();
    const code = await runVerify(
      {
        inputPath: join(FIXTURES, 'signed-sesv4.ofd'),
        json: true,
        credentials: {},
        rootPaths: [ROOT],
      },
      { logger },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(capture.stdoutText()) as CliVerifyJson;
    expect(payload).toMatchObject({
      command: 'verify',
      input: join(FIXTURES, 'signed-sesv4.ofd'),
      report: {
        overall: 'valid',
        package: {
          ofdVersion: '1.0',
          encrypted: false,
          signatureCount: 1,
          integrityPresent: false,
        },
        integrity: null,
        rootsConfigured: true,
      },
    });
    expect(payload.report.signatures[0]).toMatchObject({
      id: 's001',
      version: 'v4',
      status: 'valid',
      timestamp: { status: 'parsed-not-verified', note: '已解析，未验证' },
    });
    // stdout 只有 JSON，不含 PEM/私钥。
    expect(capture.stdoutText()).not.toContain('BEGIN');
    expect(capture.stdoutText()).not.toContain('PRIVATE KEY');
  });

  it('未配置根证书时链 unknown 但 overall=valid，退出 0', async () => {
    const { logger, capture } = createLogger();
    const code = await runVerify(
      {
        inputPath: join(FIXTURES, 'signed-sesv4.ofd'),
        json: true,
        credentials: {},
        rootPaths: [],
      },
      { logger },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(capture.stdoutText()) as CliVerifyJson;
    expect(payload.report.overall).toBe('valid');
    expect(payload.report.rootsConfigured).toBe(false);
    expect(payload.report.signatures[0]?.status).toBe('valid');
    expect(payload.report.signatures[0]?.certificate.status).toBe('unknown');
    expect(capture.stderrText()).toContain('W_CRYPTO_TRUST_UNKNOWN');
  });

  it('内容篡改与夹带均判定 invalid 并退出 5', async () => {
    for (const [file, expected] of [
      ['negative-tampered-content.ofd', '签名'],
      ['negative-extra-file.ofd', '完整性'],
    ] as const) {
      const { logger, capture } = createLogger();
      const code = await runVerify(
        {
          inputPath: join(FIXTURES, file),
          json: true,
          credentials: {},
          rootPaths: [ROOT],
        },
        { logger },
      );
      expect(code).toBe(5);
      const payload = JSON.parse(capture.stdoutText()) as CliVerifyJson;
      expect(payload.report.overall).toBe('invalid');
      if (expected === '完整性') {
        expect(payload.report.integrity?.status).toBe('invalid');
        expect(payload.report.integrity?.extraFiles.length).toBeGreaterThan(0);
      } else {
        expect(payload.report.signatures[0]?.status).toBe('invalid');
      }
    }
  });

  it('加密文档用口令解密后完成验证', async () => {
    const { logger, capture } = createLogger();
    const code = await runVerify(
      {
        inputPath: join(FIXTURES, 'combined-password-encrypted.ofd'),
        json: true,
        credentials: { user: PASSWORD_USER, password: PASSWORD },
        rootPaths: [ROOT],
      },
      { logger },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(capture.stdoutText()) as CliVerifyJson;
    expect(payload.report.overall).toBe('valid');
    expect(payload.report.package).toMatchObject({ encrypted: true, decrypted: true });
    expect(payload.report.decryption?.layers.length).toBe(1);
  });

  it('证书加密文档可用私钥验证（无签名时 not-applicable）', async () => {
    const { logger } = createLogger();
    const code = await runVerify(
      {
        inputPath: join(FIXTURES, 'cert-encrypted.ofd'),
        json: false,
        credentials: {
          user: 'fixture-cert-user',
          keyPath: join(FIXTURES, 'certs', 'encrypt.key.pem'),
        },
        rootPaths: [],
      },
      { logger },
    );
    expect(code).toBe(5);
  });

  it('缺少凭据 / 口令错误返回可分类 CryptoError 且不回显敏感信息', async () => {
    const missing = await captureCryptoError(
      runVerify(
        {
          inputPath: join(FIXTURES, 'password-encrypted.ofd'),
          json: true,
          credentials: {},
          rootPaths: [],
        },
        { logger: createLogger().logger },
      ),
    );
    expect(missing.code).toBe('CRYPTO_CREDENTIALS_REQUIRED');

    const secret = 'WrongPassword123';
    const wrong = await captureCryptoError(
      runVerify(
        {
          inputPath: join(FIXTURES, 'password-encrypted.ofd'),
          json: true,
          credentials: { user: PASSWORD_USER, password: secret },
          rootPaths: [],
        },
        { logger: createLogger().logger },
      ),
    );
    expect(wrong.code).toBe('CRYPTO_WRONG_PASSWORD');
    expect(wrong.message).not.toContain(secret);
  });

  it('自定义 SM2 userId 导致签名 invalid', async () => {
    const { logger, capture } = createLogger();
    const code = await runVerify(
      {
        inputPath: join(FIXTURES, 'signed-sesv4.ofd'),
        json: true,
        credentials: {},
        rootPaths: [ROOT],
        sm2UserId: 'not-the-default-id',
      },
      { logger },
    );
    expect(code).toBe(5);
    const payload = JSON.parse(capture.stdoutText()) as CliVerifyJson;
    expect(payload.report.overall).toBe('invalid');
  });

  it('文本输出包含结果、完整性、签名、时间戳与根证书', async () => {
    const { logger, capture } = createLogger();
    const code = await runVerify(
      {
        inputPath: join(FIXTURES, 'signed-sesv4.ofd'),
        json: false,
        credentials: {},
        rootPaths: [ROOT],
      },
      { logger },
    );
    expect(code).toBe(0);
    const text = capture.stdoutText();
    expect(text).toContain('验证结果: valid');
    expect(text).toContain('完整性: 未保护');
    expect(text).toContain('签名 1: s001 valid（SESv4');
    expect(text).toContain('时间戳: parsed-not-verified（已解析，未验证）');
    expect(text).toContain('根证书: 已配置 1 / 链 valid');
    expect(text).not.toContain(PASSWORD);
    // 私钥文件内容不得出现在任何输出。
    expect(text).not.toContain('BEGIN PRIVATE KEY');
    expect(capture.stderrText()).not.toContain('BEGIN PRIVATE KEY');
  });
});

describe('main 子命令分派与退出码', () => {
  it('info 子命令成功并输出 JSON', async () => {
    const capture = createStreamCapture();
    const code = await main(['info', join(FIXTURES, 'plain.ofd'), '--json'], {
      stdout: capture.stdout,
      stderr: capture.stderr,
    });
    expect(code).toBe(0);
    expect((JSON.parse(capture.stdoutText()) as CliInfoJson).command).toBe('info');
  });

  it('decrypt 固定返回 1 并打印用法', async () => {
    const capture = createStreamCapture();
    const code = await main(['decrypt', join(FIXTURES, 'plain.ofd')], {
      stdout: capture.stdout,
      stderr: capture.stderr,
    });
    expect(code).toBe(1);
    expect(capture.stderrText()).toContain('CLI_USAGE');
    expect(capture.stderrText()).toContain('不提供 decrypt 子命令');
    expect(capture.stderrText()).toContain('运行 ofdrw-viewer-cli --help');
  });

  it('info 带凭据返回 1', async () => {
    const capture = createStreamCapture();
    const code = await main(
      ['info', join(FIXTURES, 'plain.ofd'), '--password', PASSWORD],
      { stdout: capture.stdout, stderr: capture.stderr },
    );
    expect(code).toBe(1);
    expect(capture.stderrText()).toContain('info 只查询');
  });

  it('加密文档 verify 无凭据返回 4', async () => {
    const capture = createStreamCapture();
    const code = await main(
      ['verify', join(FIXTURES, 'password-encrypted.ofd'), '--json'],
      { stdout: capture.stdout, stderr: capture.stderr },
    );
    expect(code).toBe(4);
    expect(capture.stderrText()).toContain('CRYPTO_CREDENTIALS_REQUIRED');
    expect(capture.stdoutText()).toBe('');
  });

  it('明文无签名 verify 返回 5（not-applicable）', async () => {
    const capture = createStreamCapture();
    const code = await main(
      ['verify', join(FIXTURES, 'plain.ofd'), '--json'],
      { stdout: capture.stdout, stderr: capture.stderr },
    );
    expect(code).toBe(5);
    expect((JSON.parse(capture.stdoutText()) as CliVerifyJson).report.overall).toBe(
      'not-applicable',
    );
  });

  it('转图片带 --root 返回 1', async () => {
    const capture = createStreamCapture();
    const code = await main(
      [join(FIXTURES, 'plain.ofd'), '--root', ROOT],
      { stdout: capture.stdout, stderr: capture.stderr },
    );
    expect(code).toBe(1);
    expect(capture.stderrText()).toContain('转图片不接受');
  });

  it('注入取消信号时 info 返回 130', async () => {
    const capture = createStreamCapture();
    const code = await main(['info', join(FIXTURES, 'plain.ofd')], {
      stdout: capture.stdout,
      stderr: capture.stderr,
      signal: AbortSignal.abort(),
    });
    expect(code).toBe(130);
  });
});

describe('敏感信息边界', () => {
  it('main 的用法错误不回显 argv 中的口令', async () => {
    const secret = 'ArgvSecretPassw0rd';
    const capture = createStreamCapture();
    const code = await main(
      [
        'verify',
        join(FIXTURES, 'password-encrypted.ofd'),
        '--password',
        secret,
        '--key',
        'unused.pem',
      ],
      { stdout: capture.stdout, stderr: capture.stderr },
    );
    expect(code).toBe(1);
    expect(capture.stderrText()).toContain('CLI_CREDENTIALS_CONFLICT');
    expect(capture.stderrText()).not.toContain(secret);
    expect(capture.stdoutText()).not.toContain(secret);
  });

  it('私钥文件内容不进入 info/verify 输出或错误', async () => {
    const { logger, capture } = createLogger();
    await runVerify(
      {
        inputPath: join(FIXTURES, 'cert-encrypted.ofd'),
        json: true,
        credentials: { keyPath: SIGNER_KEY },
        rootPaths: [],
      },
      { logger },
    ).catch(() => undefined);
    const combined = `${capture.stdoutText()}\n${capture.stderrText()}`;
    expect(combined).not.toContain('BEGIN PRIVATE KEY');
    expect(combined).not.toContain('BEGIN EC PRIVATE KEY');
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
