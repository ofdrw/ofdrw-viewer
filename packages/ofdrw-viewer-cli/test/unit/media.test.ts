/**
 * 音视频导出：MIME→扩展名推导、安全命名、序号避让与整块写入。
 *
 * 只测 CLI 自身的命名与写盘策略，不依赖 engine 行为；engine 侧媒体 API 由
 * engine 包的测试覆盖。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OFDError } from '@ofdrw/ofdrw-viewer-engine';
import { CliError } from '../../src/errors.js';
import {
  MEDIA_FALLBACK_EXTENSION,
  buildMediaFileName,
  exportMediaFile,
  isValidMediaId,
  mediaExtensionOfMime,
  reserveMediaFilePath,
} from '../../src/media.js';

/** 本次测试创建的临时目录，供 afterEach 清理。 */
const tempDirs: string[] = [];

/**
 * 创建临时目录。
 *
 * @returns 临时目录绝对路径
 */
async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ofdrw-cli-media-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * 捕获 CliError。
 *
 * @param action 待执行的动作
 * @returns 抛出的 CliError
 */
async function captureCliError(action: () => unknown): Promise<CliError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error('预期抛出 CliError，但调用成功');
}

describe('MIME 到扩展名推导', () => {
  it('常见音视频 MIME 映射到惯用扩展名', () => {
    expect(mediaExtensionOfMime('video/mp4')).toBe('mp4');
    expect(mediaExtensionOfMime('audio/mpeg')).toBe('mp3');
    expect(mediaExtensionOfMime('video/webm')).toBe('webm');
    expect(mediaExtensionOfMime('audio/ogg')).toBe('ogg');
    expect(mediaExtensionOfMime('video/x-msvideo')).toBe('avi');
  });

  it('大小写不敏感且忽略 MIME 参数', () => {
    expect(mediaExtensionOfMime('VIDEO/MP4')).toBe('mp4');
    expect(mediaExtensionOfMime('audio/mpeg; charset=binary')).toBe('mp3');
    expect(mediaExtensionOfMime('  video/mp4  ')).toBe('mp4');
  });

  it('无法判定时回退 bin', () => {
    expect(mediaExtensionOfMime('application/octet-stream')).toBe(MEDIA_FALLBACK_EXTENSION);
    expect(mediaExtensionOfMime('')).toBe(MEDIA_FALLBACK_EXTENSION);
    expect(mediaExtensionOfMime('not-a-mime')).toBe(MEDIA_FALLBACK_EXTENSION);
  });
});

describe('音视频文件名生成', () => {
  it('使用 media-<id>.<ext> 形态', () => {
    expect(buildMediaFileName('12', 'video/mp4')).toBe('media-12.mp4');
    expect(buildMediaFileName('7', 'audio/mpeg')).toBe('media-7.mp3');
  });

  it('无法推导扩展名时使用 bin', () => {
    expect(buildMediaFileName('3', 'application/octet-stream')).toBe('media-3.bin');
  });

  it('冲突序号从 2 起追加，1 与 undefined 不追加', () => {
    expect(buildMediaFileName('12', 'video/mp4', 1)).toBe('media-12.mp4');
    expect(buildMediaFileName('12', 'video/mp4', 2)).toBe('media-12-2.mp4');
    expect(buildMediaFileName('12', 'video/mp4', 10)).toBe('media-12-10.mp4');
  });

  it('非法 ID 一律拒绝，不产生路径分隔符', () => {
    for (const id of ['../etc/passwd', 'a/b', '12;rm -rf', '', '1 2', '\u001b[31m']) {
      expect(() => buildMediaFileName(id, 'video/mp4')).toThrow(CliError);
    }
  });

  it('ID 合法性判定只接受十进制数字', () => {
    expect(isValidMediaId('0')).toBe(true);
    expect(isValidMediaId('1234567890')).toBe(true);
    expect(isValidMediaId('1.5')).toBe(false);
    expect(isValidMediaId('-1')).toBe(false);
    expect(isValidMediaId('0x10')).toBe(false);
    expect(isValidMediaId('')).toBe(false);
  });
});

describe('输出路径避让', () => {
  it('目录为空时使用默认名', async () => {
    const dir = await createTempDir();
    const taken = new Set<string>();
    expect(reserveMediaFilePath(dir, '12', 'video/mp4', taken)).toBe(join(dir, 'media-12.mp4'));
  });

  it('磁盘上已存在同名文件时改用 -2 序号，不覆盖既有文件', async () => {
    const dir = await createTempDir();
    const existing = join(dir, 'media-12.mp4');
    await writeFile(existing, 'old');

    const taken = new Set<string>();
    const path = reserveMediaFilePath(dir, '12', 'video/mp4', taken);
    expect(path).toBe(join(dir, 'media-12-2.mp4'));
    expect(await readFile(existing, 'utf8')).toBe('old');
  });

  it('同一批次内重复 ID 也递增序号', async () => {
    const dir = await createTempDir();
    const taken = new Set<string>();
    const first = reserveMediaFilePath(dir, '5', 'audio/mpeg', taken);
    const second = reserveMediaFilePath(dir, '5', 'audio/mpeg', taken);
    expect(first).toBe(join(dir, 'media-5.mp3'));
    expect(second).toBe(join(dir, 'media-5-2.mp3'));
  });

  it('连续多个同名文件依次递增', async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, 'media-9.mp4'), 'a');
    await writeFile(join(dir, 'media-9-2.mp4'), 'b');
    const taken = new Set<string>();
    expect(reserveMediaFilePath(dir, '9', 'video/mp4', taken)).toBe(join(dir, 'media-9-3.mp4'));
  });

  it('文件名永不越出输出目录', async () => {
    const dir = await createTempDir();
    const taken = new Set<string>();
    const path = reserveMediaFilePath(dir, '12', 'video/mp4', taken);
    expect(path.startsWith(dir)).toBe(true);
    expect(path).not.toContain('..');
  });
});

describe('音视频整块写入', () => {
  it('读取成功后原子写入并返回字节数', async () => {
    const dir = await createTempDir();
    const filePath = join(dir, 'media-1.bin');
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const written = await exportMediaFile(
      { id: '1', kind: 'video', mimeType: 'video/mp4', filePath },
      async () => bytes,
    );
    expect(written).toBe(5);
    expect(new Uint8Array(await readFile(filePath))).toEqual(bytes);
  });

  it('资源不可用（读取返回 undefined）时报 CLI_MEDIA_NOT_FOUND', async () => {
    const dir = await createTempDir();
    const error = await captureCliError(() =>
      exportMediaFile({ id: '4', kind: 'audio', mimeType: 'audio/mpeg', filePath: join(dir, 'x') }, async () => undefined),
    );
    expect(error.code).toBe('CLI_MEDIA_NOT_FOUND');
    expect(error.exitCode).toBe(1);
  });

  it('engine 超限抛错转为 CLI_MEDIA_TOO_LARGE（退出码 2）', async () => {
    const dir = await createTempDir();
    const error = await captureCliError(() =>
      exportMediaFile({ id: '8', kind: 'video', mimeType: 'video/mp4', filePath: join(dir, 'x') }, async () => {
        throw new OFDError('OFD_LIMIT_EXCEEDED', '大小超过上限');
      }),
    );
    expect(error.code).toBe('CLI_MEDIA_TOO_LARGE');
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain('超过单个资源大小上限');
  });

  it('写盘失败报 CLI_MEDIA_WRITE_FAILED（退出码 2）', async () => {
    const dir = await createTempDir();
    // 目标目录不存在时，同目录临时文件创建失败，写入必然失败。
    const error = await captureCliError(() =>
      exportMediaFile(
        {
          id: '1',
          kind: 'video',
          mimeType: 'video/mp4',
          filePath: join(dir, 'missing', 'media-1.mp4'),
        },
        async () => new Uint8Array([1]),
      ),
    );
    expect(error.code).toBe('CLI_MEDIA_WRITE_FAILED');
    expect(error.exitCode).toBe(2);
  });

  it('其他 engine 错误原样透传', async () => {
    const dir = await createTempDir();
    await expect(
      exportMediaFile({ id: '1', kind: 'video', mimeType: 'video/mp4', filePath: join(dir, 'x') }, async () => {
        throw new OFDError('OFD_ABORTED', '已取消');
      }),
    ).rejects.toBeInstanceOf(OFDError);
  });
});