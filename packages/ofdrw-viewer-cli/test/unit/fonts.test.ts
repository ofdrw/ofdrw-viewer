import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '../../src/log.js';
import {
  isFontFileName,
  loadSupplementaryFonts,
  scanFontDirectory,
} from '../../src/fonts.js';
import { createStreamCapture } from './helpers.js';

const tempDirs: string[] = [];

/** 创建并登记一个临时目录，测试结束后统一清理。 */
async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ofdrw-cli-fonts-'));
  tempDirs.push(dir);
  return dir;
}

/** 在指定目录写一个空文件（扫描器不解析字体内容）。 */
async function createFontFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('isFontFileName', () => {
  it.each(['a.ttf', 'A.OTF', 'b.ttc', 'C.Otc'])('识别 %s', (name) => {
    expect(isFontFileName(name)).toBe(true);
  });

  it.each(['a.txt', 'a.ttf.bak', 'a', 'a.woff2'])('忽略 %s', (name) => {
    expect(isFontFileName(name)).toBe(false);
  });
});

describe('scanFontDirectory', () => {
  it('递归扫描字体并过滤扩展名', async () => {
    const root = await createTempDir();
    const fonts = join(root, 'fonts');
    await createFontFile(join(fonts, 'A.TTF'));
    await createFontFile(join(fonts, 'note.txt'));
    await createFontFile(join(fonts, 'sub', 'B.otf'));
    await createFontFile(join(fonts, 'sub', 'deep', 'C.TTC'));
    await createFontFile(join(fonts, 'D.otc'));

    const result = await scanFontDirectory(fonts);
    expect(result.map((item) => basename(item.path)).sort()).toEqual([
      'A.TTF',
      'B.otf',
      'C.TTC',
      'D.otc',
    ]);
    expect(result.every((item) => item.path.startsWith(root))).toBe(true);
  });

  it('按路径字典序返回', async () => {
    const root = await createTempDir();
    await createFontFile(join(root, 'b.ttf'));
    await createFontFile(join(root, 'a.ttf'));
    await createFontFile(join(root, 'c', 'd.ttf'));
    const result = await scanFontDirectory(root);
    const paths = result.map((item) => item.path);
    expect(paths).toEqual([...paths].sort());
  });

  it('目录不存在时抛出退出码 1 的错误', async () => {
    const root = await createTempDir();
    await expect(scanFontDirectory(join(root, 'nope'))).rejects.toMatchObject({
      code: 'CLI_FONT_DIR_INVALID',
      exitCode: 1,
    });
  });

  it('路径不是目录时抛出退出码 1 的错误', async () => {
    const root = await createTempDir();
    const filePath = join(root, 'a.ttf');
    await createFontFile(filePath);
    await expect(scanFontDirectory(filePath)).rejects.toMatchObject({
      code: 'CLI_FONT_DIR_INVALID',
      exitCode: 1,
    });
  });

  it('空目录返回空数组', async () => {
    const root = await createTempDir();
    await expect(scanFontDirectory(root)).resolves.toEqual([]);
  });

  it('通过 realpath 对符号链接去重', async () => {
    if (process.platform === 'win32') return;
    const root = await createTempDir();
    await createFontFile(join(root, 'real.ttf'));
    await symlink(join(root, 'real.ttf'), join(root, 'alias.ttf'));

    const result = await scanFontDirectory(root);
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe(join(await realpath(root), 'real.ttf'));
  });

  it('跟随符号链接目录，并按 realpath 避免重复', async () => {
    if (process.platform === 'win32') return;
    const root = await createTempDir();
    const fonts = join(root, 'fonts');
    const external = join(root, 'external');
    await createFontFile(join(fonts, 'a.ttf'));
    await createFontFile(join(external, 'b.ttf'));
    await symlink(external, join(fonts, 'linked'));
    // 同一真实目录再链一次，验证 visitedDirectories 去重。
    await symlink(external, join(fonts, 'linked-again'));

    const result = await scanFontDirectory(fonts);
    expect(result.map((item) => basename(item.path)).sort()).toEqual(['a.ttf', 'b.ttf']);
  });
});

describe('loadSupplementaryFonts', () => {
  it('空目录打印 warning 并继续', async () => {
    const root = await createTempDir();
    const capture = createStreamCapture();
    const logger = new Logger({ stdout: capture.stdout, stderr: capture.stderr });

    const result = await loadSupplementaryFonts(root, logger);
    expect(result).toEqual([]);
    expect(capture.stderrText()).toContain('警告 [W_FONT_DIR_EMPTY]');
    expect(logger.warningCounts().get('W_FONT_DIR_EMPTY')).toBe(1);
  });

  it('有字体时不打印 warning', async () => {
    const root = await createTempDir();
    await createFontFile(join(root, 'a.ttf'));
    const capture = createStreamCapture();
    const logger = new Logger({ stdout: capture.stdout, stderr: capture.stderr });

    const result = await loadSupplementaryFonts(root, logger);
    expect(result).toHaveLength(1);
    expect(capture.stderrText()).toBe('');
  });
});