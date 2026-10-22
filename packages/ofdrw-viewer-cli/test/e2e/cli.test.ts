import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadImage } from '@napi-rs/canvas';
import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';
import { main } from '../../src/cli.js';
import { EXIT_CODES } from '../../src/errors.js';
import { NodeFileByteSource } from '../../src/node-file-source.js';
import { createStreamCapture } from '../unit/helpers.js';

/** 仓库根目录。 */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** 仓库示例目录。 */
const SAMPLE_DIR = join(REPO_ROOT, 'ofd_pdf_match');

/** 合成的最小合法 TTF，避免依赖本机/不可提交的系统字体。 */
const FIXTURE_FONT = fileURLToPath(new URL('../fixtures/minimal.ttf', import.meta.url));

const tempDirs: string[] = [];

/** 创建并登记临时目录，测试结束后统一清理。 */
async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ofdrw-cli-e2e-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** CLI 运行结果。 */
interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** 在内存流中运行 CLI。 */
async function runCli(
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
  stderrIsTTY?: boolean,
): Promise<CliResult> {
  const capture = createStreamCapture();
  const code = await main(args, {
    cwd,
    stdout: capture.stdout,
    stderr: capture.stderr,
    ...(signal === undefined ? {} : { signal }),
    ...(stderrIsTTY === undefined ? {} : { stderrIsTTY }),
  });
  return { code, stdout: capture.stdoutText(), stderr: capture.stderrText() };
}

/** 读取图片尺寸。 */
async function imageSize(filePath: string): Promise<{ width: number; height: number }> {
  const image = await loadImage(await readFile(filePath));
  return { width: image.width, height: image.height };
}

/** 递归列出目录内所有文件与子目录的相对路径。 */
async function listEntries(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).sort();
}

/** 断言目录内没有原子写遗留的临时文件。 */
async function expectNoTempFiles(dir: string): Promise<void> {
  const entries = await listEntries(dir);
  expect(entries.filter((entry) => entry.includes('.tmp-'))).toEqual([]);
}

/** 断言目录内没有 JSON 输出。 */
async function expectNoJson(dir: string): Promise<void> {
  const entries = await listEntries(dir);
  expect(entries.filter((entry) => entry.endsWith('.json'))).toEqual([]);
}

/** 空间文本 JSON 记录，用于与 engine oracle 比较。 */
interface TextRecord {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * 直接用 engine 读取一页文本作为 oracle。
 *
 * 独立于 CLI 的 `buildTextRecords` 做映射，避免同一实现掩盖字段错误。
 */
async function readTextOracle(
  inputPath: string,
  pageIndex: number,
  dpi: number,
): Promise<TextRecord[]> {
  const source = await NodeFileByteSource.open(inputPath);
  const document = await OFDDocument.open({
    source: { kind: 'custom', source },
  });
  try {
    const page = await document.getPage(pageIndex);
    const content = await page.getTextContent({ dpi, includeChars: false });
    return content.items
      .filter((item) => item.text.length > 0)
      .map((item) => ({
        text: item.text,
        x: item.rect.x,
        y: item.rect.y,
        w: item.rect.width,
        h: item.rect.height,
      }));
  } finally {
    await document.close().catch(() => undefined);
    await source.close();
  }
}

/** 读取并解析 CLI 写出的 JSON。 */
async function readTextJson(filePath: string): Promise<TextRecord[]> {
  return JSON.parse(await readFile(filePath, 'utf8')) as TextRecord[];
}

/** 断言每条记录只有 text/x/y/w/h 五个键。 */
function expectRecordShape(records: readonly TextRecord[]): void {
  for (const record of records) {
    expect(Object.keys(record)).toEqual(['text', 'x', 'y', 'w', 'h']);
    expect(record.text.length).toBeGreaterThan(0);
    for (const value of [record.x, record.y, record.w, record.h]) {
      expect(Number.isFinite(value)).toBe(true);
    }
  }
}

describe('CLI 图片导出 e2e', () => {
  it('单页 PNG：默认 96 DPI、白底、A4 尺寸与命名', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const input = join(SAMPLE_DIR, 'helloworld.ofd');

    const result = await runCli([input, '-o', outDir], cwd);

    expect(result.code).toBe(EXIT_CODES.OK);
    expect(result.stdout).toContain('完成：1/1 页');
    expect(result.stderr).toContain('W_FONT_MISSING');
    const filePath = join(outDir, 'helloworld-p001.png');
    expect(await imageSize(filePath)).toEqual({ width: 794, height: 1123 });
    const bytes = await readFile(filePath);
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(await listEntries(outDir)).toEqual(['helloworld-p001.png']);
    await expectNoTempFiles(outDir);
    await expectNoJson(outDir);
  });

  it('多页文档配合 --pages 只输出选中页', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const input = join(SAMPLE_DIR, '999.ofd');

    const result = await runCli([input, '-o', outDir, '--pages', '2-3'], cwd);

    expect(result.code).toBe(EXIT_CODES.OK);
    expect(result.stdout).toContain('完成：2/2 页');
    expect(await listEntries(outDir)).toEqual(['999-p002.png', '999-p003.png']);
    for (const name of ['999-p002.png', '999-p003.png']) {
      const size = await imageSize(join(outDir, name));
      expect(size.width).toBeGreaterThan(0);
      expect(size.height).toBeGreaterThan(0);
    }
    await expectNoTempFiles(outDir);
  });

  it('JPEG 输出扩展名 .jpg 且质量参数可用', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const input = join(SAMPLE_DIR, 'helloworld.ofd');

    const result = await runCli([input, '-o', outDir, '--format', 'jpeg'], cwd);

    expect(result.code).toBe(EXIT_CODES.OK);
    const filePath = join(outDir, 'helloworld-p001.jpg');
    const bytes = await readFile(filePath);
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(await imageSize(filePath)).toEqual({ width: 794, height: 1123 });
  });

  it('WebP 输出扩展名 .webp 且 RIFF 魔数正确', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const input = join(SAMPLE_DIR, 'helloworld.ofd');

    const result = await runCli([input, '-o', outDir, '--format', 'webp'], cwd);

    expect(result.code).toBe(EXIT_CODES.OK);
    const filePath = join(outDir, 'helloworld-p001.webp');
    const bytes = await readFile(filePath);
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString('ascii')).toBe('WEBP');
    expect(await imageSize(filePath)).toEqual({ width: 794, height: 1123 });
  });

  it('未指定 -o 时输出到 cwd/<输入 stem>/', async () => {
    const cwd = await createTempDir();
    const input = join(SAMPLE_DIR, 'helloworld.ofd');

    const result = await runCli([input], cwd);

    expect(result.code).toBe(EXIT_CODES.OK);
    expect(await listEntries(join(cwd, 'helloworld'))).toEqual(['helloworld-p001.png']);
  });

  it('--font-dir 注入补充字体后仍正常出图', async () => {
    const cwd = await createTempDir();
    const fontDir = join(cwd, 'fonts');
    const outDir = join(cwd, 'out');
    await mkdir(fontDir);
    await copyFile(FIXTURE_FONT, join(fontDir, 'fallback.ttf'));

    const result = await runCli(
      [join(SAMPLE_DIR, 'helloworld.ofd'), '-o', outDir, '--font-dir', fontDir],
      cwd,
    );

    expect(result.code).toBe(EXIT_CODES.OK);
    expect(await listEntries(outDir)).toEqual(['helloworld-p001.png']);
    expect(result.stdout).toContain('完成：1/1 页');
  });

  it('坏文件返回文档级失败 2', async () => {
    const cwd = await createTempDir();
    const input = join(cwd, 'bad.ofd');
    const outDir = join(cwd, 'out');
    await writeFile(input, 'not-an-ofd');

    const result = await runCli([input, '-o', outDir], cwd);

    expect(result.code).toBe(EXIT_CODES.DOCUMENT);
    expect(result.stderr).toContain('错误[OFD_');
    expect(await listEntries(outDir)).toEqual([]);
  });

  it('输入文件不存在返回用法错误 1', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');

    const result = await runCli([join(cwd, 'missing.ofd'), '-o', outDir], cwd);

    expect(result.code).toBe(EXIT_CODES.USAGE);
    expect(result.stderr).toContain('输入文件不存在');
    expect(existsSync(outDir)).toBe(false);
  });

  it('输入路径不是文件返回用法错误 1', async () => {
    const cwd = await createTempDir();
    const input = join(cwd, 'directory.ofd');
    await mkdir(input);
    const outDir = join(cwd, 'out');

    const result = await runCli([input, '-o', outDir], cwd);

    expect(result.code).toBe(EXIT_CODES.USAGE);
    expect(result.stderr).toContain('不是文件');
    expect(existsSync(outDir)).toBe(false);
  });

  it('TTY 时 stderr 输出逐页进度并清理，非 TTY 保持安静', async () => {
    const cwd = await createTempDir();
    const input = join(SAMPLE_DIR, 'helloworld.ofd');

    const tty = await runCli([input, '-o', join(cwd, 'tty')], cwd, undefined, true);
    expect(tty.code).toBe(EXIT_CODES.OK);
    expect(tty.stderr).toContain('\r[1/1]');
    expect(tty.stderr).toContain(`\r${' '.repeat(32)}\r`);

    const quiet = await runCli([input, '-o', join(cwd, 'quiet')], cwd, undefined, false);
    expect(quiet.code).toBe(EXIT_CODES.OK);
    expect(quiet.stderr).not.toContain('[1/1]');
  });

  it('超大 --pages 区间快速退出 1 且不创建输出目录', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const input = join(SAMPLE_DIR, 'helloworld.ofd');

    const result = await runCli([input, '-o', outDir, '--pages', '1-999999999'], cwd);

    expect(result.code).toBe(EXIT_CODES.USAGE);
    expect(result.stderr).toContain('范围过大');
    expect(existsSync(outDir)).toBe(false);
  });

  it('页码越界返回用法错误 1', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const input = join(SAMPLE_DIR, 'helloworld.ofd');

    const result = await runCli([input, '-o', outDir, '--pages', '9'], cwd);

    expect(result.code).toBe(EXIT_CODES.USAGE);
    expect(result.stderr).toContain('页码越界');
    expect(await listEntries(outDir)).toEqual([]);
  });

  it('单页失败继续其它页，最终退出 3 且不残留临时文件', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const input = join(SAMPLE_DIR, '999.ofd');
    await mkdir(outDir);
    // 用同名目录制造第 3 页写入失败，其余页仍应成功。
    await mkdir(join(outDir, '999-p003.png'));

    const result = await runCli([input, '-o', outDir], cwd);

    expect(result.code).toBe(EXIT_CODES.PAGE);
    expect(result.stdout).toContain('完成：4/5 页，1 页失败');
    expect(result.stderr).toContain('页面 3/5 失败 [CLI_IMAGE_WRITE_FAILED]');
    expect(await listEntries(outDir)).toEqual([
      '999-p001.png',
      '999-p002.png',
      '999-p003.png',
      '999-p004.png',
      '999-p005.png',
    ]);
    await expectNoTempFiles(outDir);
  });

  it('全部页失败仍返回页级失败 3', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const input = join(SAMPLE_DIR, 'helloworld.ofd');
    await mkdir(outDir);
    await mkdir(join(outDir, 'helloworld-p001.png'));

    const result = await runCli([input, '-o', outDir], cwd);

    expect(result.code).toBe(EXIT_CODES.PAGE);
    expect(result.stdout).toContain('完成：0/1 页，1 页失败');
    expect(await listEntries(outDir)).toEqual(['helloworld-p001.png']);
    await expectNoTempFiles(outDir);
  });

  it('--text 生成第 1 页图片与空间文本 JSON，坐标与 engine oracle 一致', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const input = join(SAMPLE_DIR, 'dense-text-perf.ofd');

    const result = await runCli([input, '-o', outDir, '--text', '--pages', '1'], cwd);

    expect(result.code).toBe(EXIT_CODES.OK);
    expect(result.stdout).toContain('完成：1/1 页（图片 + 文本）');
    expect(await listEntries(outDir)).toEqual([
      'dense-text-perf-p001.json',
      'dense-text-perf-p001.png',
    ]);
    const records = await readTextJson(join(outDir, 'dense-text-perf-p001.json'));
    const oracle = await readTextOracle(input, 0, 96);
    expect(records).toEqual(oracle);
    expect(records.length).toBeGreaterThan(0);
    expect(records[0]?.text).toContain('OFD 密集文本性能测试样本');
    expectRecordShape(records);
    await expectNoTempFiles(outDir);
  });

  it('第 2 页大量文本按 items 顺序写出，字段精简且原子写', async () => {
    const startedAt = Date.now();
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const input = join(SAMPLE_DIR, 'dense-text-perf.ofd');

    const result = await runCli([input, '-o', outDir, '--text', '--pages', '2'], cwd);

    expect(result.code).toBe(EXIT_CODES.OK);
    const records = await readTextJson(join(outDir, 'dense-text-perf-p002.json'));
    const oracle = await readTextOracle(input, 1, 96);
    expect(records).toHaveLength(oracle.length);
    expect(records.length).toBeGreaterThan(1000);
    expect(records[0]).toEqual(oracle[0]);
    expect(records.at(-1)).toEqual(oracle.at(-1));
    for (const index of [1, Math.floor(records.length / 2), records.length - 2]) {
      expect(records[index]).toEqual(oracle[index]);
    }
    expectRecordShape(records);
    expect(await listEntries(outDir)).toEqual([
      'dense-text-perf-p002.json',
      'dense-text-perf-p002.png',
    ]);
    await expectNoTempFiles(outDir);
    // 8k+ 项 JSON 的写出与解析应远低于该上限；用于防止原子写或序列化退化。
    expect(Date.now() - startedAt).toBeLessThan(30_000);
  }, 30_000);

  it('--text 全量 2 页时每页都生成图片与 JSON', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const input = join(SAMPLE_DIR, 'dense-text-perf.ofd');

    const result = await runCli([input, '-o', outDir, '--text'], cwd);

    expect(result.code).toBe(EXIT_CODES.OK);
    expect(result.stdout).toContain('完成：2/2 页（图片 + 文本）');
    expect(await listEntries(outDir)).toEqual([
      'dense-text-perf-p001.json',
      'dense-text-perf-p001.png',
      'dense-text-perf-p002.json',
      'dense-text-perf-p002.png',
    ]);
    await expectNoTempFiles(outDir);
  });

  it('--text 未指定 -o 时 JSON 与图片共用 cwd/<stem>/ 默认目录', async () => {
    const cwd = await createTempDir();
    const input = join(SAMPLE_DIR, 'dense-text-perf.ofd');

    const result = await runCli([input, '--text', '--pages', '1'], cwd);

    expect(result.code).toBe(EXIT_CODES.OK);
    expect(await listEntries(join(cwd, 'dense-text-perf'))).toEqual([
      'dense-text-perf-p001.json',
      'dense-text-perf-p001.png',
    ]);
  });

  it('helloworld 空文本页写 []，仍输出图片', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const input = join(SAMPLE_DIR, 'helloworld.ofd');

    const result = await runCli([input, '-o', outDir, '--text'], cwd);

    expect(result.code).toBe(EXIT_CODES.OK);
    expect(result.stdout).toContain('（图片 + 文本）');
    expect(await readFile(join(outDir, 'helloworld-p001.json'), 'utf8')).toBe('[]');
    expect(existsSync(join(outDir, 'helloworld-p001.png'))).toBe(true);
    await expectNoTempFiles(outDir);
  });

  it.each(['jpeg', 'webp'] as const)(
    '--text 与 %s、--dpi 144 组合时 JSON 坐标随 DPI 变化',
    async (format) => {
      const cwd = await createTempDir();
      const outDir = join(cwd, 'out');
      const input = join(SAMPLE_DIR, 'dense-text-perf.ofd');

      const result = await runCli(
        [input, '-o', outDir, '--text', '--pages', '1', '--format', format, '--dpi', '144'],
        cwd,
      );

      expect(result.code).toBe(EXIT_CODES.OK);
      const extension = format === 'jpeg' ? 'jpg' : 'webp';
      expect(existsSync(join(outDir, `dense-text-perf-p001.${extension}`))).toBe(true);
      const records = await readTextJson(join(outDir, 'dense-text-perf-p001.json'));
      expect(records).toEqual(await readTextOracle(input, 0, 144));
      await expectNoTempFiles(outDir);
    },
    30_000,
  );

  it('图片写盘失败不阻止文本，退出 3 且保留 JSON', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const input = join(SAMPLE_DIR, '999.ofd');
    await mkdir(outDir);
    await mkdir(join(outDir, '999-p003.png'));

    const result = await runCli([input, '-o', outDir, '--text', '--pages', '3'], cwd);

    expect(result.code).toBe(EXIT_CODES.PAGE);
    expect(result.stdout).toContain('完成：0/1 页（图片 + 文本），1 页失败');
    expect(result.stderr).toContain('CLI_IMAGE_WRITE_FAILED');
    expect(existsSync(join(outDir, '999-p003.json'))).toBe(true);
    expect(await readTextJson(join(outDir, '999-p003.json'))).toBeInstanceOf(Array);
    await expectNoTempFiles(outDir);
  });

  it('文本写盘失败不阻止图片，退出 3 且保留 PNG', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const input = join(SAMPLE_DIR, '999.ofd');
    await mkdir(outDir);
    await mkdir(join(outDir, '999-p003.json'));

    const result = await runCli([input, '-o', outDir, '--text', '--pages', '3'], cwd);

    expect(result.code).toBe(EXIT_CODES.PAGE);
    expect(result.stdout).toContain('完成：0/1 页（图片 + 文本），1 页失败');
    expect(result.stderr).toContain('CLI_TEXT_WRITE_FAILED');
    expect(existsSync(join(outDir, '999-p003.png'))).toBe(true);
    expect(await imageSize(join(outDir, '999-p003.png'))).toMatchObject({
      width: expect.any(Number),
      height: expect.any(Number),
    });
    await expectNoTempFiles(outDir);
  });

  it.each([
    { name: '缺少参数值', arg: '--out', expected: '缺少参数值：-o, --out' },
    { name: '布尔参数带值', arg: '--help=yes', expected: '参数不接受值：-h, --help' },
  ])('参数错误中文化：$name', async ({ arg, expected }) => {
    const cwd = await createTempDir();
    const input = join(SAMPLE_DIR, 'helloworld.ofd');

    const result = await runCli([input, arg], cwd);

    expect(result.code).toBe(EXIT_CODES.USAGE);
    expect(result.stderr).toContain(expected);
    expect(result.stderr).toContain('用法:');
    expect(result.stderr).not.toMatch(/Unknown option|argument missing|does not take an argument/);
  });

  it('已取消信号返回 130 且不写图片', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const input = join(SAMPLE_DIR, 'helloworld.ofd');
    const controller = new AbortController();
    controller.abort();

    const result = await runCli([input, '-o', outDir], cwd, controller.signal);

    expect(result.code).toBe(EXIT_CODES.INTERRUPTED);
    expect(result.stdout).toContain('已取消：0/1 页');
    expect(await listEntries(outDir)).toEqual([]);
  });

  it('导出过程中取消当前页并返回 130', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const input = join(SAMPLE_DIR, '999.ofd');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      const result = await runCli([input, '-o', outDir, '--dpi', '600', '--text'], cwd, controller.signal);
      expect(result.code).toBe(EXIT_CODES.INTERRUPTED);
      expect(result.stdout).toContain('已取消：');
      await expectNoTempFiles(outDir);
    } finally {
      clearTimeout(timer);
    }
  });
});
