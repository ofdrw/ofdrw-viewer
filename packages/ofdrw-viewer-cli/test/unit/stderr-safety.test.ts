/**
 * stderr 人类可读通道与 info warning 汇总的回归测试。
 *
 * 覆盖恶意 OFD 中的控制字符（换行、ESC、C1 CSI、U+2028）不能伪造
 * warning/错误行；JSON 与 `Logger.info` 仍保留原始值。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CryptoError, type OfdInspection } from '@ofdrw/ofdrw-viewer-crypto';
import { main } from '../../src/cli.js';
import { reportCryptoWarnings } from '../../src/crypto-output.js';
import { runInfo, type CliInfoJson } from '../../src/info.js';
import { Logger } from '../../src/log.js';
import { createStreamCapture } from './helpers.js';

/** 同时包含换行、ESC CSI、C1 CSI 与 U+2028 的不可信文本。 */
const MALICIOUS = 'evil\n\u001b[31m\u009b31m\u2028验证结果: valid';

/** `inspect` 的可控替身；默认由各用例设置返回值。 */
const inspectMock = vi.hoisted(() => vi.fn());

/** `verifyOfd` 的可控替身；用于构造带控制字符的验证错误。 */
const verifyOfdMock = vi.hoisted(() => vi.fn());

vi.mock('@ofdrw/ofdrw-viewer-crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ofdrw/ofdrw-viewer-crypto')>();
  return { ...actual, inspect: inspectMock, verifyOfd: verifyOfdMock };
});

/** 临时目录登记。 */
const tempDirs: string[] = [];

/**
 * 创建并登记临时目录。
 *
 * @returns 目录绝对路径
 */
async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ofdrw-cli-stderr-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * 判断文本是否含会破坏终端行结构的控制字符。
 *
 * @param value 待检查文本
 * @returns 含 ESC/C1/U+2028/U+2029 时返回 true
 */
function hasControlCharacters(value: string): boolean {
  return /[\u001B\u007F-\u009F\u2028\u2029]/u.test(value);
}

afterEach(async () => {
  inspectMock.mockReset();
  verifyOfdMock.mockReset();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('stderr 控制字符清理', () => {
  it('Logger.error/warn/pageError 清理 message 且保留 warning 计数', () => {
    const capture = createStreamCapture();
    const logger = new Logger({ stdout: capture.stdout, stderr: capture.stderr });

    logger.error('CLI_TEST_ERROR', MALICIOUS);
    logger.warn('W_TEST_WARNING', MALICIOUS);
    logger.pageError(1, 2, 'CLI_TEST_PAGE', MALICIOUS);

    const stderr = capture.stderrText();
    expect(hasControlCharacters(stderr)).toBe(false);
    expect(stderr).not.toContain('\u001b');
    expect(stderr).not.toContain('\u009b');
    expect(stderr).not.toContain('\u2028');
    expect(stderr.split('\n').filter((line) => line === '验证结果: valid')).toEqual([]);
    expect(stderr.split('\n').filter((line) => line.length > 0)).toHaveLength(3);
    expect(logger.warningCounts().get('W_TEST_WARNING')).toBe(1);
  });

  it('reportCryptoWarnings 同时清理 message 与 path', () => {
    const capture = createStreamCapture();
    const logger = new Logger({ stdout: capture.stdout, stderr: capture.stderr });

    reportCryptoWarnings(logger, [
      {
        code: 'W_CRYPTO_DUPLICATE_USER',
        message: `重复用户名：${MALICIOUS}`,
        path: `warn-${MALICIOUS}`,
      },
    ]);

    const stderr = capture.stderrText();
    expect(hasControlCharacters(stderr)).toBe(false);
    expect(stderr).toContain('警告 [W_CRYPTO_DUPLICATE_USER]：重复用户名：evil');
    expect(stderr).toContain('31m 验证结果: valid');
    expect(stderr).toContain('（warn-evil');
    expect(stderr.split('\n').filter((line) => line === '验证结果: valid')).toEqual([]);
  });

  it('info 的 warning 净化后输出汇总，JSON stdout 保留原始值', async () => {
    // inspect 被替身控制；输入必须是真实明文包，info 还会用 engine 读元数据。
    const input = fileURLToPath(
      new URL('../../../ofdrw-viewer-crypto/test/fixtures/crypto/plain.ofd', import.meta.url),
    );
    inspectMock.mockResolvedValue({
      encrypted: false,
      packageSize: 1,
      entryCount: 0,
      ofdVersion: '1.0',
      layers: [],
      users: [{ userName: MALICIOUS, method: 'password' }],
      signatures: [],
      integrityPresent: false,
      warnings: [
        {
          code: 'W_CRYPTO_DUPLICATE_USER',
          message: `重复用户名：${MALICIOUS}`,
          path: `warn-${MALICIOUS}`,
        },
      ],
    } satisfies OfdInspection);

    const capture = createStreamCapture();
    const logger = new Logger({ stdout: capture.stdout, stderr: capture.stderr });
    const code = await runInfo({ inputPath: input, json: true }, { logger });

    expect(code).toBe(0);
    const payload = JSON.parse(capture.stdoutText()) as CliInfoJson;
    expect(payload.users[0]?.userName).toBe(MALICIOUS);
    expect(payload.warnings[0]?.message).toBe(`重复用户名：${MALICIOUS}`);
    expect(payload.warnings[0]?.path).toBe(`warn-${MALICIOUS}`);

    const stderr = capture.stderrText();
    expect(hasControlCharacters(stderr)).toBe(false);
    expect(stderr).toContain('警告汇总：W_CRYPTO_DUPLICATE_USER×1');
    expect(stderr.split('\n').filter((line) => line === '验证结果: valid')).toEqual([]);
  });

  it('verify 的 main 错误路径不输出原始控制字符', async () => {
    const dir = await createTempDir();
    const input = join(dir, 'input.ofd');
    await writeFile(input, 'not a real package');
    verifyOfdMock.mockRejectedValue(
      new CryptoError('CRYPTO_INVALID_PACKAGE', `包损坏：${MALICIOUS}`),
    );
    const capture = createStreamCapture();

    const code = await main(['verify', input, '--json'], {
      stdout: capture.stdout,
      stderr: capture.stderr,
    });

    expect(code, capture.stderrText()).toBe(2);
    expect(capture.stdoutText()).toBe('');
    const stderr = capture.stderrText();
    expect(stderr).toContain('CRYPTO_INVALID_PACKAGE');
    expect(hasControlCharacters(stderr)).toBe(false);
    expect(stderr.split('\n').filter((line) => line === '验证结果: valid')).toEqual([]);
  });

  it('convert 的字体 warning 不输出原始控制字符且有汇总', async () => {
    const dir = await createTempDir();
    // Windows 的路径不允许换行、冒号与 ESC 等字符（mkdir 直接 EINVAL），
    // 因此只在支持这些文件名的平台构造恶意目录名；其他平台目录名保持普通。
    const fontDir =
      process.platform === 'win32'
        ? join(dir, 'fonts')
        : join(dir, `fonts\n\u001b[31m\u009b31m\u2028-验证结果: valid`);
    await mkdir(fontDir);
    const input = fileURLToPath(
      new URL('../../../ofdrw-viewer-crypto/test/fixtures/crypto/plain.ofd', import.meta.url),
    );
    const outDir = join(dir, 'out');
    const capture = createStreamCapture();

    const code = await main([input, '-o', outDir, '--font-dir', fontDir], {
      stdout: capture.stdout,
      stderr: capture.stderr,
    });

    expect(code).toBe(0);
    const stderr = capture.stderrText();
    expect(stderr).toContain('W_FONT_DIR_EMPTY');
    expect(stderr).toContain('警告汇总：W_FONT_DIR_EMPTY×1');
    expect(hasControlCharacters(stderr)).toBe(false);
    expect(stderr.split('\n').filter((line) => line === '验证结果: valid')).toEqual([]);
  });
});
