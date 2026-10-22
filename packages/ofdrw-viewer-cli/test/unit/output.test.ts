import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CliError } from '../../src/errors.js';
import {
  buildImageFileName,
  buildImagePath,
  buildTextJsonPath,
  getImageExtension,
  pageNumberWidth,
  prepareOutputDirectory,
  resolveDefaultOutputDir,
  writeFileAtomic,
} from '../../src/output.js';

const tempDirs: string[] = [];

/** 创建并登记一个临时目录，测试结束后统一清理。 */
async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ofdrw-cli-output-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('页号与文件名', () => {
  it('页号至少 3 位，并按总页数位数扩展', () => {
    expect(pageNumberWidth(1)).toBe(3);
    expect(pageNumberWidth(999)).toBe(3);
    expect(pageNumberWidth(1000)).toBe(4);
    expect(pageNumberWidth(12345)).toBe(5);
  });

  it('拒绝非法总页数', () => {
    expect(() => pageNumberWidth(0)).toThrow(RangeError);
    expect(() => pageNumberWidth(-1)).toThrow(RangeError);
    expect(() => pageNumberWidth(1.5)).toThrow(RangeError);
  });

  it('格式扩展名正确', () => {
    expect(getImageExtension('png')).toBe('png');
    expect(getImageExtension('jpeg')).toBe('jpg');
    expect(getImageExtension('webp')).toBe('webp');
  });

  it('图片命名为 <stem>-p<NNN>.<ext> 并保留中文与空格', () => {
    expect(buildImageFileName('发票示例', 1, 'png', 12)).toBe('发票示例-p001.png');
    expect(buildImageFileName('my doc', 12, 'webp', 12)).toBe('my doc-p012.webp');
    expect(buildImageFileName('long', 1000, 'jpeg', 1000)).toBe('long-p1000.jpg');
  });

  it('图片路径使用输出目录', () => {
    expect(buildImagePath('/out', '发票示例', 2, 'png', 12)).toBe(
      join('/out', '发票示例-p002.png'),
    );
  });

  it('未来 JSON 与同页图片同 stem、同页号', () => {
    expect(buildTextJsonPath('/out', '发票示例', 2, 12)).toBe(
      join('/out', '发票示例-p002.json'),
    );
  });

  it('默认输出目录为 cwd 下的输入 stem', () => {
    expect(resolveDefaultOutputDir('/some/where/发票示例.ofd', '/work')).toBe(
      resolve('/work', '发票示例'),
    );
  });

  it('拒绝非法页号', () => {
    expect(() => buildImageFileName('x', 0, 'png', 10)).toThrow(RangeError);
    expect(() => buildTextJsonPath('/out', 'x', -1, 10)).toThrow(RangeError);
  });
});

describe('prepareOutputDirectory', () => {
  it('递归创建不存在的输出目录', async () => {
    const root = await createTempDir();
    const outDir = join(root, 'a', 'b');
    await prepareOutputDirectory(outDir);
    expect((await stat(outDir)).isDirectory()).toBe(true);
  });

  it('已存在的目录直接通过', async () => {
    const root = await createTempDir();
    await expect(prepareOutputDirectory(root)).resolves.toBeUndefined();
  });

  it('输出路径是文件时抛出退出码 1 的错误', async () => {
    const root = await createTempDir();
    const filePath = join(root, 'file');
    await writeFile(filePath, 'x');
    await expect(prepareOutputDirectory(filePath)).rejects.toMatchObject({
      code: 'CLI_OUTPUT_NOT_DIRECTORY',
      exitCode: 1,
    });
  });
});

describe('writeFileAtomic', () => {
  it('写入新文件且不残留临时文件', async () => {
    const root = await createTempDir();
    const target = join(root, 'a.png');
    await writeFileAtomic(target, new Uint8Array([1, 2, 3]));
    expect([...await readFile(target)]).toEqual([1, 2, 3]);
    expect(await readdir(root)).toEqual(['a.png']);
  });

  it('覆盖已有文件', async () => {
    const root = await createTempDir();
    const target = join(root, 'a.json');
    await writeFile(target, 'old');
    await writeFileAtomic(target, 'new');
    expect(await readFile(target, 'utf8')).toBe('new');
    expect(await readdir(root)).toEqual(['a.json']);
  });

  it('rename 失败时清理临时文件', async () => {
    const root = await createTempDir();
    // 目标为目录时 rename 必然失败，用于验证临时文件被清理。
    const target = join(root, 'target');
    await mkdir(target);
    await expect(writeFileAtomic(target, 'data')).rejects.toBeInstanceOf(Error);
    expect(await readdir(root)).toEqual(['target']);
  });

  it('目标目录不存在时失败且不创建文件', async () => {
    const root = await createTempDir();
    const target = join(root, 'missing', 'a.png');
    await expect(writeFileAtomic(target, 'data')).rejects.toBeInstanceOf(Error);
    expect(await readdir(root)).toEqual([]);
  });

  it('错误类型保持为 CliError 之外的原始系统错误', async () => {
    const root = await createTempDir();
    let caught: unknown;
    try {
      await writeFileAtomic(join(root, 'missing', 'a.png'), 'data');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(CliError);
  });
});