/**
 * 图片 CLI 黑盒验收（真实进程）。
 *
 * 全部用例只通过 `dist/bin.js` 子进程观察 CLI 行为：
 * 参数、页码范围、输出目录、格式、DPI、字体目录、退出码、SIGINT、
 * 覆盖写与原子写残留。engine 公共 API 仅用于计算期望的 viewport 尺寸。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLI_BIN,
  HELLO_OFD,
  MULTI_OFD,
  cleanupTempDirs,
  copyFontInto,
  createTempDir,
  findAvailableFont,
  findTempArtifacts,
  inspectImage,
  listFiles,
  readHexPrefix,
  readSamplePageCount,
  readViewport,
  runCli,
} from './helpers.js';

/** PNG 文件头（8 字节）。 */
const PNG_MAGIC = '89504e470d0a1a0a';

/** JPEG 文件头（3 字节）。 */
const JPEG_MAGIC = 'ffd8ff';

/** WebP 的 RIFF 头前 4 字节。 */
const RIFF_MAGIC = '52494646';

/** 本机可用字体；缺失时跳过对应的 `--font-dir` 用例并在报告中说明。 */
const AVAILABLE_FONT = findAvailableFont();

afterEach(cleanupTempDirs);

describe('图片 CLI 黑盒验收：帮助与版本', () => {
  it('--help 退出 0 并列出用法与全部图片期参数', async () => {
    const cwd = await createTempDir();
    const result = await runCli(['--help'], { cwd });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('用法: ofdrw-viewer-cli <input.ofd> [options]');
    for (const option of ['--out', '--format', '--dpi', '--pages', '--font-dir']) {
      expect(result.stdout).toContain(option);
    }
    expect(result.stderr).toBe('');
  });

  it('--version 退出 0 并包含版本与平台', async () => {
    const cwd = await createTempDir();
    const result = await runCli(['--version'], { cwd });

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/ofdrw-viewer-cli 0\.1\.0 \(.+\)/);
    expect(result.stdout).toContain(`${process.platform}-${process.arch}`);
  });
});

describe('图片 CLI 黑盒验收：图片导出', () => {
  it('单页默认 PNG：命名、magic、尺寸与 getViewport 一致、白底且非空白', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const viewport = await readViewport(HELLO_OFD, 0, 96);

    const result = await runCli([HELLO_OFD, '-o', outDir], { cwd });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('完成：1/1 页');
    expect(await listFiles(outDir)).toEqual(['helloworld-p001.png']);
    expect(await readHexPrefix(join(outDir, 'helloworld-p001.png'), 8)).toBe(PNG_MAGIC);

    const image = await inspectImage(join(outDir, 'helloworld-p001.png'));
    expect({ width: image.width, height: image.height }).toEqual({
      width: Math.ceil(viewport.width),
      height: Math.ceil(viewport.height),
    });
    expect(image.cornerIsWhite).toBe(true);
    // helloworld 的文字字体缺失，页面本身为空白；非空白与内容绘制改由 999 样本验证。
    expect(await findTempArtifacts(outDir)).toEqual([]);
    // 本期不生成 JSON。
    expect((await listFiles(outDir)).some((name) => name.endsWith('.json'))).toBe(false);
  });

  it('多页文档默认导出全部页并保持页号命名', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const pageCount = await readSamplePageCount(MULTI_OFD);

    const result = await runCli([MULTI_OFD, '-o', outDir], { cwd });

    expect(pageCount).toBe(5);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('完成：5/5 页');
    const files = await listFiles(outDir);
    expect(files).toEqual([
      '999-p001.png',
      '999-p002.png',
      '999-p003.png',
      '999-p004.png',
      '999-p005.png',
    ]);
    for (const name of files) {
      const image = await inspectImage(join(outDir, name));
      expect(image.width).toBeGreaterThan(0);
      expect(image.height).toBeGreaterThan(0);
      expect(image.bytes.subarray(0, 8).toString('hex')).toBe(PNG_MAGIC);
      expect(image.nonWhiteSamples).toBeGreaterThan(0);
    }
    expect(await findTempArtifacts(outDir)).toEqual([]);
  });

  it('--pages 只输出选中页，并支持乱序与重复输入', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');

    const result = await runCli([MULTI_OFD, '-o', outDir, '--pages', '3,1,3'], { cwd });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('完成：2/2 页');
    expect(await listFiles(outDir)).toEqual(['999-p001.png', '999-p003.png']);
  });

  it('--dpi 改变输出尺寸且仍与 getViewport 取整一致', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const viewport = await readViewport(HELLO_OFD, 0, 150);

    const result = await runCli([HELLO_OFD, '-o', outDir, '--dpi', '150'], { cwd });

    expect(result.code).toBe(0);
    const image = await inspectImage(join(outDir, 'helloworld-p001.png'));
    expect({ width: image.width, height: image.height }).toEqual({
      width: Math.ceil(viewport.width),
      height: Math.ceil(viewport.height),
    });
  });

  it('--format jpeg 生成 .jpg、JPEG magic、白底与非空白', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const viewport = await readViewport(MULTI_OFD, 0, 96);

    const result = await runCli(
      [MULTI_OFD, '-o', outDir, '--pages', '1', '--format', 'jpeg'],
      { cwd },
    );

    expect(result.code).toBe(0);
    expect(await listFiles(outDir)).toEqual(['999-p001.jpg']);
    expect(await readHexPrefix(join(outDir, '999-p001.jpg'), 3)).toBe(JPEG_MAGIC);
    const image = await inspectImage(join(outDir, '999-p001.jpg'), 235);
    expect({ width: image.width, height: image.height }).toEqual({
      width: Math.ceil(viewport.width),
      height: Math.ceil(viewport.height),
    });
    expect(image.cornerIsWhite).toBe(true);
    expect(image.nonWhiteSamples).toBeGreaterThan(0);
  });

  it('--format webp 生成 .webp、RIFF/WEBP magic 与非空白', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const viewport = await readViewport(MULTI_OFD, 0, 96);

    const result = await runCli(
      [MULTI_OFD, '-o', outDir, '--pages', '1', '--format', 'webp'],
      { cwd },
    );

    expect(result.code).toBe(0);
    expect(await listFiles(outDir)).toEqual(['999-p001.webp']);
    const filePath = join(outDir, '999-p001.webp');
    const prefix = await readHexPrefix(filePath, 12);
    expect(prefix.slice(0, 8)).toBe(RIFF_MAGIC);
    expect(prefix.slice(16, 24)).toBe('57454250');
    const image = await inspectImage(filePath, 235);
    expect({ width: image.width, height: image.height }).toEqual({
      width: Math.ceil(viewport.width),
      height: Math.ceil(viewport.height),
    });
    expect(image.nonWhiteSamples).toBeGreaterThan(0);
  });

  it('未指定 -o 时输出到 cwd/<输入 stem>/', async () => {
    const cwd = await createTempDir();

    const result = await runCli([HELLO_OFD], { cwd });

    expect(result.code).toBe(0);
    expect(await listFiles(join(cwd, 'helloworld'))).toEqual(['helloworld-p001.png']);
  });

  it('-o 指向不存在的嵌套目录时自动递归创建', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'a', 'b', 'out');

    const result = await runCli([HELLO_OFD, '-o', outDir], { cwd });

    expect(result.code).toBe(0);
    expect(await listFiles(outDir)).toEqual(['helloworld-p001.png']);
  });

  it.skipIf(AVAILABLE_FONT === undefined)(
    '--font-dir 递归扫描子目录并正常出图',
    async () => {
      const cwd = await createTempDir();
      const fontDir = join(cwd, 'fonts');
      const outDir = join(cwd, 'out');
      expect(AVAILABLE_FONT).toBeDefined();
      await copyFontInto(AVAILABLE_FONT as string, fontDir, join('nested', 'sub'));

      const result = await runCli([HELLO_OFD, '-o', outDir, '--font-dir', fontDir], { cwd });

      expect(result.code).toBe(0);
      expect(await listFiles(outDir)).toEqual(['helloworld-p001.png']);
      expect(await findTempArtifacts(outDir)).toEqual([]);
    },
  );

  it('覆盖写：已存在的同名图片被完整替换且不残留临时文件', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const target = join(outDir, 'helloworld-p001.png');
    await mkdir(outDir, { recursive: true });
    await writeFile(target, 'OLD-CONTENT');

    const result = await runCli([HELLO_OFD, '-o', outDir], { cwd });

    expect(result.code).toBe(0);
    const image = await inspectImage(target);
    expect(image.bytes.subarray(0, 8).toString('hex')).toBe(PNG_MAGIC);
    expect(image.width).toBe(794);
    expect(await findTempArtifacts(outDir)).toEqual([]);
  });

  it('原子替换：转换期间旧文件保持完整，结束后一次性变为新 PNG', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    await mkdir(outDir, { recursive: true });
    const target = join(outDir, '999-p001.png');
    await writeFile(target, 'OLD-CONTENT');

    // 使用 600 DPI 的多页样本拉长转换窗口，观察目标文件从未出现半截内容。
    const child = spawn(
      process.execPath,
      [CLI_BIN, MULTI_OFD, '-o', outDir, '--dpi', '600'],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.resume();
    child.stderr.resume();

    let samples = 0;
    let sawOldContent = false;
    let sawPartialContent = false;
    const timer = setInterval(() => {
      void readFile(target)
        .then((data) => {
          samples += 1;
          if (data.toString('utf8') === 'OLD-CONTENT') {
            sawOldContent = true;
          } else if (data.subarray(0, 8).toString('hex') !== PNG_MAGIC) {
            sawPartialContent = true;
          }
        })
        .catch(() => undefined);
    }, 20);

    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => resolve(exitCode));
    });
    clearInterval(timer);
    // 等待时间窗口内最后一次异步读取落定。
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(code).toBe(0);
    expect(samples).toBeGreaterThan(0);
    expect(sawOldContent).toBe(true);
    expect(sawPartialContent).toBe(false);
    expect(await readHexPrefix(target, 8)).toBe(PNG_MAGIC);
    expect(await findTempArtifacts(outDir)).toEqual([]);
  });
});

describe('图片 CLI 黑盒验收：退出码与错误信息', () => {
  it.each([
    { name: '缺少输入文件', args: [], expected: '缺少输入文件', showsUsage: true },
    { name: '多个输入文件', args: [HELLO_OFD, HELLO_OFD], expected: '一次只接受一个输入文件', showsUsage: true },
    { name: '未知参数', args: [HELLO_OFD, '--unknown'], expected: '未知参数：--unknown', showsUsage: true },
    { name: '非法格式', args: [HELLO_OFD, '--format', 'gif'], expected: '--format 只支持 png / jpeg / webp', showsUsage: false },
    { name: 'DPI 为 0', args: [HELLO_OFD, '--dpi', '0'], expected: '--dpi 必须为正整数', showsUsage: false },
    { name: 'DPI 非数字', args: [HELLO_OFD, '--dpi', 'abc'], expected: '--dpi 必须为正整数', showsUsage: false },
    { name: '页码为 0', args: [HELLO_OFD, '--pages', '0'], expected: '--pages 语法非法', showsUsage: false },
    { name: '页码区间倒置', args: [HELLO_OFD, '--pages', '3-1'], expected: '--pages 语法非法', showsUsage: false },
    { name: '缺少 -o 参数值', args: [HELLO_OFD, '-o'], expected: '缺少参数值', showsUsage: true },
  ])('参数错误：$name 退出 1 且不创建输出目录', async ({ args, expected, showsUsage }) => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const cliArgs =
      args.at(-1) === '-o' ? [...args] : [...args, '-o', outDir];

    const result = await runCli(cliArgs, { cwd });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(expected);
    if (showsUsage) expect(result.stderr).toContain('用法:');
    expect(existsSync(outDir)).toBe(false);
  });

  it('--text 在本期作为未知参数退出 1，不输出 JSON', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');

    const result = await runCli([HELLO_OFD, '-o', outDir, '--text'], { cwd });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('未知参数：--text');
    expect(result.stderr).not.toContain('Unknown option');
    expect(existsSync(outDir)).toBe(false);
  });

  it('输入文件不存在退出 1', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');

    const result = await runCli([join(cwd, 'missing.ofd'), '-o', outDir], { cwd });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('输入文件不存在');
    expect(existsSync(outDir)).toBe(false);
  });

  it('输入路径是目录退出 1', async () => {
    const cwd = await createTempDir();
    const input = join(cwd, 'dir.ofd');
    const outDir = join(cwd, 'out');
    await mkdir(input);

    const result = await runCli([input, '-o', outDir], { cwd });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('不是文件');
    expect(existsSync(outDir)).toBe(false);
  });

  it('输出路径已存在且不是目录退出 1', async () => {
    const cwd = await createTempDir();
    const outPath = join(cwd, 'out');
    await writeFile(outPath, 'not-a-directory');

    const result = await runCli([HELLO_OFD, '-o', outPath], { cwd });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('输出路径不是目录');
  });

  it('--font-dir 不存在退出 1', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');

    const result = await runCli(
      [HELLO_OFD, '-o', outDir, '--font-dir', join(cwd, 'no-fonts')],
      { cwd },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('字体目录不存在');
    expect(existsSync(outDir)).toBe(false);
  });

  it('页码越界退出 1 且不写图片', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');

    const result = await runCli([HELLO_OFD, '-o', outDir, '--pages', '9'], { cwd });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('页码越界');
    expect(await listFiles(outDir)).toEqual([]);
  });

  it('坏 OFD 退出 2 且输出 OFD_* 错误码', async () => {
    const cwd = await createTempDir();
    const input = join(cwd, 'bad.ofd');
    const outDir = join(cwd, 'out');
    await writeFile(input, 'not-an-ofd-package');

    const result = await runCli([input, '-o', outDir], { cwd });

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/错误\[OFD_[A-Z_]+\]/);
    expect(await listFiles(outDir)).toEqual([]);
  });

  it('部分页失败退出 3，保留成功页且不残留临时文件', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    await mkdir(outDir, { recursive: true });
    // 用同名目录制造第 3 页写入失败，其余页应继续成功。
    const blocked = join(outDir, '999-p003.png');
    await mkdir(blocked);

    const result = await runCli([MULTI_OFD, '-o', outDir], { cwd });

    expect(result.code).toBe(3);
    expect(result.stdout).toContain('完成：4/5 页，1 页失败');
    expect(result.stderr).toContain('页面 3/5 失败');
    expect((await stat(blocked)).isDirectory()).toBe(true);
    expect(await listFiles(outDir)).toEqual([
      '999-p001.png',
      '999-p002.png',
      '999-p004.png',
      '999-p005.png',
    ]);
    for (const name of await listFiles(outDir)) {
      const image = await inspectImage(join(outDir, name));
      expect(image.bytes.subarray(0, 8).toString('hex')).toBe(PNG_MAGIC);
    }
    expect(await findTempArtifacts(outDir)).toEqual([]);
  });

  it('全部页失败仍退出 3', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    await mkdir(outDir, { recursive: true });
    await mkdir(join(outDir, 'helloworld-p001.png'));

    const result = await runCli([HELLO_OFD, '-o', outDir], { cwd });

    expect(result.code).toBe(3);
    expect(result.stdout).toContain('完成：0/1 页，1 页失败');
    expect(await listFiles(outDir)).toEqual([]);
    expect(await findTempArtifacts(outDir)).toEqual([]);
  });
});

describe('图片 CLI 黑盒验收：SIGINT', () => {
  it('导出中收到 SIGINT 退出 130、输出取消摘要且无 .tmp 残留', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');

    const result = await runCli([MULTI_OFD, '-o', outDir, '--dpi', '600'], {
      cwd,
      sigintAfterMs: 700,
      timeoutMs: 60_000,
    });

    expect(result.code).toBe(130);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain('已取消：');
    expect(await findTempArtifacts(outDir)).toEqual([]);
    // 已写出的页必须是完整图片。
    for (const name of await listFiles(outDir)) {
      const image = await inspectImage(join(outDir, name));
      expect(image.bytes.subarray(0, 8).toString('hex')).toBe(PNG_MAGIC);
    }
  });
});