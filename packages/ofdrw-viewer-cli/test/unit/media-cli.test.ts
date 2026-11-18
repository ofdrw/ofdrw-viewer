/**
 * `--media` 参数解析与端到端导出。
 *
 * 覆盖：三组标志的组合校验、非法 `--media-id`、`--media` 单独使用时触发的
 * 跳过渲染（只产出音视频文件）、按 kind/id 过滤，以及文件命名安全性。
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { main, parseCliArgs } from '../../src/cli.js';
import { existsSync } from 'node:fs';
import { CliError } from '../../src/errors.js';
import { createStreamCapture } from './helpers.js';

/** 样例 OFD：含 Video(10)、Image(11)、Audio(12)。 */
const MEDIA_SAMPLE = fileURLToPath(
  new URL('../../../../ofd_pdf_match/gb-12-media.ofd', import.meta.url),
);

/** 样例由 engine 的样例导出测试生成；未生成时跳过依赖它的用例。 */
const hasMediaSample = existsSync(MEDIA_SAMPLE);

/** 本次测试创建的临时目录，供 afterEach 清理。 */
const tempDirs: string[] = [];

/**
 * 创建临时目录并登记清理。
 *
 * @returns 临时目录绝对路径
 */
async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ofdrw-cli-media-cli-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * 捕获解析阶段的 CliError。
 *
 * @param action 待执行动作
 * @returns 抛出的 CliError
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
 * 以注入的 stdout/stderr 运行 main。
 *
 * @param argv 参数
 * @param cwd 工作目录
 * @returns 退出码与输出文本
 */
async function runMain(
  argv: readonly string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string; capture: ReturnType<typeof createStreamCapture> }> {
  const capture = createStreamCapture();
  const code = await main(argv, { cwd, stdout: capture.stdout, stderr: capture.stderr });
  return { code, stdout: capture.stdoutText(), stderr: capture.stderrText(), capture };
}

describe('--media 参数解析', () => {
  it('--media 单独出现时启用媒体导出且不设过滤', () => {
    const parsed = parseCliArgs(['in.ofd', '--media'], '/tmp');
    expect(parsed.command).toMatchObject({
      kind: 'convert',
      options: { media: { kind: undefined, id: undefined } },
    });
  });

  it('--media --media-kind video 解析为视频过滤', () => {
    const parsed = parseCliArgs(['in.ofd', '--media', '--media-kind', 'video'], '/tmp');
    expect(parsed.command).toMatchObject({
      kind: 'convert',
      options: { media: { kind: 'video', id: undefined } },
    });
  });

  it('--media-kind 大小写不敏感', () => {
    const parsed = parseCliArgs(['in.ofd', '--media', '--media-kind', 'AUDIO'], '/tmp');
    expect(parsed.command).toMatchObject({ options: { media: { kind: 'audio' } } });
  });

  it('--media --media-id 解析为 ID 过滤', () => {
    const parsed = parseCliArgs(['in.ofd', '--media', '--media-id', '12'], '/tmp');
    expect(parsed.command).toMatchObject({
      options: { media: { kind: undefined, id: '12' } },
    });
  });

  it('未使用 --media 时不设置 media 字段（既有行为不变）', () => {
    const parsed = parseCliArgs(['in.ofd'], '/tmp');
    const command = parsed.command;
    if (command?.kind !== 'convert') throw new Error('预期 convert');
    expect('media' in command.options).toBe(false);
  });

  it('--media-kind 缺少 --media 时报用法错误', () => {
    const error = captureCliError(() => parseCliArgs(['in.ofd', '--media-kind', 'video'], '/tmp'));
    expect(error.code).toBe('CLI_USAGE');
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain('--media');
  });

  it('--media-id 缺少 --media 时报用法错误', () => {
    const error = captureCliError(() => parseCliArgs(['in.ofd', '--media-id', '1'], '/tmp'));
    expect(error.code).toBe('CLI_USAGE');
    expect(error.exitCode).toBe(1);
  });

  it('--media-kind 非法取值报 CLI_INVALID_MEDIA_KIND', () => {
    const error = captureCliError(() =>
      parseCliArgs(['in.ofd', '--media', '--media-kind', 'image'], '/tmp'),
    );
    expect(error.code).toBe('CLI_INVALID_MEDIA_KIND');
    expect(error.exitCode).toBe(1);
  });

  it('--media-id 非十进制时报用法错误，不再静默变成 0', () => {
    for (const id of ['abc', '../etc', '1.5', '']) {
      const error = captureCliError(() => parseCliArgs(['in.ofd', '--media', '--media-id', id], '/tmp'));
      expect(error.code).toBe('CLI_USAGE');
      expect(error.exitCode).toBe(1);
    }
  });

  it('info/verify 拒绝 --media 系列参数', () => {
    expect(() => parseCliArgs(['info', 'in.ofd', '--media'], '/tmp')).toThrow(CliError);
    expect(() => parseCliArgs(['verify', 'in.ofd', '--media'], '/tmp')).toThrow(CliError);
  });

  it('--help 列出 --media 三组标志', async () => {
    const result = await runMain(['--help'], '/tmp');
    expect(result.code).toBe(0);
    for (const flag of ['--media', '--media-kind', '--media-id']) {
      expect(result.stdout).toContain(flag);
    }
  });
});

describe.skipIf(!hasMediaSample)('--media 端到端导出', () => {
  it('--media 单独使用时只产出音视频文件，不做页面渲染', async () => {
    const out = await createTempDir();
    const result = await runMain([MEDIA_SAMPLE, '--media', '-o', out], '/tmp');

    expect(result.code).toBe(0);
    const files = (await readdir(out)).sort();
    expect(files).toEqual(['media-10.mp4', 'media-12.mp3']);
    // 跳过渲染：不应出现任何页面图片。
    expect(files.some((name) => /-p\d+\.(png|jpg|jpeg|webp)$/u.test(name))).toBe(false);
    expect(result.stdout).toContain('多媒体 2 个');
  });

  it('--media-kind video 只导出视频', async () => {
    const out = await createTempDir();
    const result = await runMain([MEDIA_SAMPLE, '--media', '--media-kind', 'video', '-o', out], '/tmp');

    expect(result.code).toBe(0);
    expect(await readdir(out)).toEqual(['media-10.mp4']);
  });

  it('--media-kind audio 只导出音频', async () => {
    const out = await createTempDir();
    const result = await runMain([MEDIA_SAMPLE, '--media', '--media-kind', 'audio', '-o', out], '/tmp');

    expect(result.code).toBe(0);
    expect(await readdir(out)).toEqual(['media-12.mp3']);
  });

  it('--media-id 只导出指定资源', async () => {
    const out = await createTempDir();
    const result = await runMain([MEDIA_SAMPLE, '--media', '--media-id', '12', '-o', out], '/tmp');

    expect(result.code).toBe(0);
    expect(await readdir(out)).toEqual(['media-12.mp3']);
  });

  it('--media-id 指向图片资源时报 CLI_MEDIA_UNSUPPORTED_TYPE', async () => {
    const out = await createTempDir();
    // 样例中的 ID 11 是 Type="Image" 的静态帧，不是音视频。
    const result = await runMain([MEDIA_SAMPLE, '--media', '--media-id', '11', '-o', out], '/tmp');

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('CLI_MEDIA_UNSUPPORTED_TYPE');
    expect(result.stderr).toContain('是图片而非音视频');
    expect(await readdir(out)).toEqual([]);
  });

  it('--media-id 不存在时退出 1 且不写文件', async () => {
    const out = await createTempDir();
    const result = await runMain([MEDIA_SAMPLE, '--media', '--media-id', '99999', '-o', out], '/tmp');

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('CLI_MEDIA_NOT_FOUND');
    expect(await readdir(out)).toEqual([]);
  });

  it('--media 与图片同时启用时两者都导出', async () => {
    const out = await createTempDir();
    const result = await runMain([MEDIA_SAMPLE, '--media', '-p', '1', '-o', out], '/tmp');

    expect(result.code).toBe(0);
    const files = (await readdir(out)).sort();
    expect(files).toContain('media-10.mp4');
    expect(files).toContain('media-12.mp3');
    expect(files.some((name) => /-p001\.png$/u.test(name))).toBe(true);
  });

  it('同目录已有同名文件时不覆盖，改用 -2 序号', async () => {
    const out = await createTempDir();
    await runMain([MEDIA_SAMPLE, '--media', '--media-id', '12', '-o', out], '/tmp');
    const second = await runMain([MEDIA_SAMPLE, '--media', '--media-id', '12', '-o', out], '/tmp');

    expect(second.code).toBe(0);
    expect((await readdir(out)).sort()).toEqual(['media-12-2.mp3', 'media-12.mp3']);
  });

  it('--media 默认输出目录为 cwd/<输入 stem>/', async () => {
    const cwd = await createTempDir();
    const result = await runMain([MEDIA_SAMPLE, '--media', '--media-id', '10'], cwd);

    expect(result.code).toBe(0);
    const files = await readdir(join(cwd, 'gb-12-media'));
    expect(files).toEqual(['media-10.mp4']);
  });
});