import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLI_VERSION,
  DEFAULT_DPI,
  HELP_TEXT,
  USAGE_LINE,
  createProgressReporter,
  formatVersion,
  main,
  parseCliArgs,
  parsePageRanges,
  resolvePageNumbers,
  validatePageNumbers,
} from '../../src/cli.js';
import { CliError } from '../../src/errors.js';
import { createStreamCapture } from './helpers.js';

/** 执行并返回抛出的 CliError，便于断言错误码与退出码。 */
function captureCliError(action: () => unknown): CliError {
  try {
    action();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error('预期抛出 CliError，但调用成功');
}

describe('parseCliArgs', () => {
  const cwd = process.cwd();

  it('解析必填输入并应用默认值', () => {
    const parsed = parseCliArgs(['发票示例.ofd'], cwd);
    expect(parsed.help).toBe(false);
    expect(parsed.version).toBe(false);
    expect(parsed.command).toMatchObject({
      kind: 'convert',
      options: {
        inputPath: resolve(cwd, '发票示例.ofd'),
        outDir: resolve(cwd, '发票示例'),
        format: 'png',
        dpi: DEFAULT_DPI,
        pageNumbers: undefined,
        fontDir: undefined,
        systemFonts: true,
        text: false,
      },
    });
  });

  it('--no-system-fonts 关闭系统字体自动发现', () => {
    expect(parseCliArgs(['input.ofd'], cwd).command).toMatchObject({
      kind: 'convert',
      options: { systemFonts: true },
    });
    expect(parseCliArgs(['input.ofd', '--no-system-fonts'], cwd).command).toMatchObject({
      kind: 'convert',
      options: { systemFonts: false },
    });
  });

  it.each(['info', 'verify'])('%s 拒绝 --no-system-fonts', (subcommand) => {
    const error = captureCliError(() =>
      parseCliArgs([subcommand, 'input.ofd', '--no-system-fonts'], cwd),
    );
    expect(error.code).toBe('CLI_USAGE');
    expect(error.message).toContain('--no-system-fonts');
  });

  it('解析全部参数', () => {
    const parsed = parseCliArgs(
      [
        'input.ofd',
        '-o',
        'out',
        '-f',
        'JPEG',
        '-d',
        '300',
        '-p',
        '1-3,5',
        '--font-dir',
        'fonts',
        '--no-system-fonts',
        '--text',
      ],
      cwd,
    );
    expect(parsed.command).toMatchObject({
      kind: 'convert',
      options: {
        inputPath: resolve(cwd, 'input.ofd'),
        outDir: resolve(cwd, 'out'),
        format: 'jpeg',
        dpi: 300,
        pageNumbers: [1, 2, 3, 5],
        fontDir: resolve(cwd, 'fonts'),
        systemFonts: false,
        text: true,
      },
    });
  });

  it('--help / -V 优先于输入校验', () => {
    expect(parseCliArgs(['--help'], cwd)).toEqual({ help: true, version: false });
    expect(parseCliArgs(['-h'], cwd)).toEqual({ help: true, version: false });
    expect(parseCliArgs(['-V'], cwd)).toEqual({ help: false, version: true });
    expect(parseCliArgs(['--version'], cwd)).toEqual({ help: false, version: true });
  });

  it('缺少输入时抛出用法错误', () => {
    const error = captureCliError(() => parseCliArgs([], cwd));
    expect(error.code).toBe('CLI_USAGE');
    expect(error.exitCode).toBe(1);
  });

  it('未知参数时抛出用法错误', () => {
    const error = captureCliError(() => parseCliArgs(['input.ofd', '--nope'], cwd));
    expect(error.code).toBe('CLI_USAGE');
    expect(error.exitCode).toBe(1);
  });

  it('缺少选项值时抛出用法错误', () => {
    const error = captureCliError(() => parseCliArgs(['input.ofd', '--out'], cwd));
    expect(error.code).toBe('CLI_USAGE');
    expect(error.exitCode).toBe(1);
  });

  it('多个位置参数时抛出用法错误', () => {
    const error = captureCliError(() => parseCliArgs(['a.ofd', 'b.ofd'], cwd));
    expect(error.code).toBe('CLI_USAGE');
    expect(error.message).toContain('2');
  });

  it.each(['gif', 'jpg', ''])('非法 format %j 被拒绝', (format) => {
    const error = captureCliError(() =>
      parseCliArgs(['input.ofd', `--format=${format}`], cwd),
    );
    expect(error.code).toBe('CLI_INVALID_FORMAT');
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain('png');
  });

  it.each(['0', '-1', '1.5', 'abc', ''])('非法 dpi %j 被拒绝', (dpi) => {
    const error = captureCliError(() =>
      parseCliArgs(['input.ofd', `--dpi=${dpi}`], cwd),
    );
    expect(error.code).toBe('CLI_INVALID_DPI');
    expect(error.exitCode).toBe(1);
  });

  it.each(['', '0', '-1', 'a', '1,,2', '1-', '3-1', '1.5'])(
    '非法 pages %j 被拒绝',
    (pages) => {
      const error = captureCliError(() =>
        parseCliArgs(['input.ofd', `--pages=${pages}`], cwd),
      );
      expect(error.code).toBe('CLI_INVALID_PAGES');
      expect(error.exitCode).toBe(1);
    },
  );

  it('拒绝空的路径选项', () => {
    expect(captureCliError(() => parseCliArgs(['input.ofd', '--out='], cwd)).code).toBe(
      'CLI_USAGE',
    );
    expect(
      captureCliError(() => parseCliArgs(['input.ofd', '--font-dir='], cwd)).code,
    ).toBe('CLI_USAGE');
  });
});

describe('parsePageRanges', () => {
  it('解析闭区间与单页', () => {
    expect(parsePageRanges('1-3,5')).toEqual([1, 2, 3, 5]);
  });

  it('去重、排序并合并重叠区间', () => {
    expect(parsePageRanges('5,2,2,1-3')).toEqual([1, 2, 3, 5]);
    expect(parsePageRanges('1-3,2-4')).toEqual([1, 2, 3, 4]);
  });

  it('容忍连字符与逗号两侧空白', () => {
    expect(parsePageRanges(' 1 - 3 , 5 ')).toEqual([1, 2, 3, 5]);
    expect(parsePageRanges('7')).toEqual([7]);
  });

  it.each(['', '0', '3-1', 'a', '1,,2', '1-', '-2'])('拒绝非法范围 %j', (raw) => {
    expect(captureCliError(() => parsePageRanges(raw)).code).toBe('CLI_INVALID_PAGES');
  });

  it('超大单段在展开前快速失败', () => {
    const startedAt = performance.now();
    const error = captureCliError(() => parsePageRanges('1-999999999'));
    expect(error.code).toBe('CLI_INVALID_PAGES');
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain('范围过大');
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it('合并后总页数超限时快速失败', () => {
    const error = captureCliError(() => parsePageRanges('1-60000,60001-120000'));
    expect(error.code).toBe('CLI_INVALID_PAGES');
    expect(error.message).toContain('范围过大');
  });

  it('重叠区间合并后不重复计数', () => {
    expect(parsePageRanges('1-100000,1-100000')).toHaveLength(100000);
  });
});

describe('页码越界校验', () => {
  it('页号在范围内时通过', () => {
    expect(() => validatePageNumbers([1, 3], 3)).not.toThrow();
  });

  it('页号越界时抛出用法错误', () => {
    const error = captureCliError(() => validatePageNumbers([1, 4], 3));
    expect(error.code).toBe('CLI_INVALID_PAGES');
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain('4');
  });

  it('未指定页范围时展开为全部页', () => {
    expect(resolvePageNumbers(undefined, 3)).toEqual([1, 2, 3]);
  });

  it('文档页数超过上限时在展开前失败', () => {
    const error = captureCliError(() => resolvePageNumbers(undefined, 100001));
    expect(error.code).toBe('CLI_INVALID_PAGES');
    expect(error.message).toContain('页数过大');
  });

  it('指定页范围时校验、去重并升序返回', () => {
    const selected = [2, 1, 2];
    expect(resolvePageNumbers(selected, 3)).toEqual([1, 2]);
    expect(selected).toEqual([2, 1, 2]);
    expect(captureCliError(() => resolvePageNumbers([4], 3)).code).toBe(
      'CLI_INVALID_PAGES',
    );
  });
});

describe('main 帮助/版本与退出码', () => {
  it('--help 输出用法与全部参数并返回 0', async () => {
    const capture = createStreamCapture();
    const code = await main(['--help'], {
      stdout: capture.stdout,
      stderr: capture.stderr,
    });
    expect(code).toBe(0);
    const output = capture.stdoutText();
    expect(output).toContain(USAGE_LINE);
    for (const flag of [
      '-o, --out',
      '-f, --format',
      '-d, --dpi',
      '-p, --pages',
      '--font-dir',
      '--text',
      '-h, --help',
      '-V, --version',
    ]) {
      expect(output).toContain(flag);
    }
    expect(HELP_TEXT).toContain('退出码');
    expect(capture.stderrText()).toBe('');
  });

  it('--version 输出版本与平台并返回 0', async () => {
    const capture = createStreamCapture();
    const code = await main(['--version'], {
      stdout: capture.stdout,
      stderr: capture.stderr,
      platform: 'testos',
      arch: 'testarch',
    });
    expect(code).toBe(0);
    expect(capture.stdoutText()).toBe(`${formatVersion('testos', 'testarch')}\n`);
    expect(capture.stdoutText()).toContain('0.1.0');
    expect(capture.stdoutText()).toContain('testos-testarch');
  });

  it('缺少输入时返回 1 并打印用法', async () => {
    const capture = createStreamCapture();
    const code = await main([], { stdout: capture.stdout, stderr: capture.stderr });
    expect(code).toBe(1);
    expect(capture.stderrText()).toContain('错误[CLI_USAGE]');
    expect(capture.stderrText()).toContain('缺少输入文件');
    expect(capture.stderrText()).toContain(USAGE_LINE);
  });

  it('未知参数返回 1', async () => {
    const capture = createStreamCapture();
    const code = await main(['input.ofd', '--nope'], {
      stdout: capture.stdout,
      stderr: capture.stderr,
    });
    expect(code).toBe(1);
    expect(capture.stderrText()).toContain('CLI_USAGE');
    expect(capture.stderrText()).toContain(USAGE_LINE);
  });

  it('非法 format/dpi/pages 返回 1', async () => {
    for (const [args, code] of [
      [['input.ofd', '--format=gif'], 'CLI_INVALID_FORMAT'],
      [['input.ofd', '--dpi=0'], 'CLI_INVALID_DPI'],
      [['input.ofd', '--pages=3-1'], 'CLI_INVALID_PAGES'],
    ] as const) {
      const capture = createStreamCapture();
      expect(
        await main([...args], { stdout: capture.stdout, stderr: capture.stderr }),
      ).toBe(1);
      expect(capture.stderrText()).toContain(code);
    }
  });

  it('输入文件不存在返回 1', async () => {
    const capture = createStreamCapture();
    const missing = resolve(process.cwd(), 'no-such-file-ofdrw-cli.ofd');
    const code = await main([missing], {
      stdout: capture.stdout,
      stderr: capture.stderr,
    });
    expect(code).toBe(1);
    expect(capture.stderrText()).toContain('CLI_INPUT_NOT_FOUND');
  });
});


describe('CLI 版本与 TTY 进度', () => {
  it('CLI_VERSION 与 package.json 一致，--version 使用该版本', async () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(CLI_VERSION).toBe(pkg.version);

    const capture = createStreamCapture();
    const code = await main(['--version'], {
      stdout: capture.stdout,
      stderr: capture.stderr,
      platform: 'testos',
      arch: 'testarch',
    });
    expect(code).toBe(0);
    expect(capture.stdoutText()).toContain(`ofdrw-viewer-cli ${pkg.version}`);
  });

  it('TTY 进度写 stderr 并清理，非 TTY 保持安静', () => {
    const ttyWrites: string[] = [];
    const tty = createProgressReporter(
      { write: (chunk) => { ttyWrites.push(String(chunk)); return true; } },
      true,
    );
    tty.onProgress?.(1, 2);
    tty.onProgress?.(2, 2);
    tty.onProgressEnd?.();
    expect(ttyWrites).toEqual([
      '\r[1/2]',
      '\r[2/2]',
      `\r${' '.repeat(32)}\r`,
    ]);

    const quietWrites: string[] = [];
    const quiet = createProgressReporter(
      { write: (chunk) => { quietWrites.push(String(chunk)); return true; } },
      false,
    );
    expect(quiet).toEqual({});
    quiet.onProgress?.(1, 2);
    quiet.onProgressEnd?.();
    expect(quietWrites).toEqual([]);
  });
});
