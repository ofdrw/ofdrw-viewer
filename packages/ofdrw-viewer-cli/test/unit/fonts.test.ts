import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '../../src/log.js';
import {
  clearSystemFontCache,
  discoverSystemFonts,
  isCjkFontFileName,
  isFontFileName,
  loadFontInputs,
  loadSupplementaryFonts,
  mergeFontFiles,
  scanFontDirectory,
  systemFontDirectories,
} from '../../src/fonts.js';
import { createStreamCapture } from './helpers.js';
import { isPathInside } from './paths.js';

/** 仓库自带的最小合法 TTF。 */
const FIXTURE_FONT = fileURLToPath(new URL('../fixtures/minimal.ttf', import.meta.url));

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

/** 复制仓库自带的最小 TTF 到指定路径，构造真实字体文件。 */
async function createFontFixture(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await copyFile(FIXTURE_FONT, path);
}

/** 在指定目录写一个指定字节数的文件（扫描器不解析字体内容）。 */
async function createSizedFontFile(path: string, size: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.alloc(size));
}

afterEach(async () => {
  clearSystemFontCache();
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

describe('loadFontInputs', () => {
  it('按列表顺序读取字体字节并返回 data', async () => {
    const root = await createTempDir();
    const first = join(root, 'a.ttf');
    const second = join(root, 'b.otf');
    await createFontFixture(first);
    await createFontFixture(second);
    const capture = createStreamCapture();
    const logger = new Logger({ stderr: capture.stderr });

    const inputs = await loadFontInputs([{ path: first }, { path: second }], logger);

    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.data).toEqual(new Uint8Array(await readFile(first)));
    expect(inputs[1]?.data).toEqual(new Uint8Array(await readFile(second)));
    expect(capture.stderrText()).toBe('');
  });

  it('读取失败的文件跳过并发出 W_FONT_MISSING，其余照常返回', async () => {
    const root = await createTempDir();
    const available = join(root, 'a.ttf');
    await createFontFixture(available);
    const capture = createStreamCapture();
    const logger = new Logger({ stderr: capture.stderr });

    const inputs = await loadFontInputs(
      [{ path: join(root, 'missing.ttf') }, { path: available }],
      logger,
    );

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.data).toEqual(new Uint8Array(await readFile(available)));
    expect(capture.stderrText()).toContain('警告 [W_FONT_MISSING]');
    expect(logger.warningCounts().get('W_FONT_MISSING')).toBe(1);
  });

  it('空列表返回空数组且不产生 warning', async () => {
    const capture = createStreamCapture();
    const logger = new Logger({ stderr: capture.stderr });

    await expect(loadFontInputs([], logger)).resolves.toEqual([]);
    expect(capture.stderrText()).toBe('');
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
    // 扫描结果取 realpath：macOS 上 /var 会解析为 /private/var，Windows 上盘符、大小写
    // 与 `RUNNER~1` 这类 8.3 短名也会被改写，所以先对根目录取 realpath 再比较，
    // 只断言“仍位于扫描根目录之下”，不做前缀字符串比较。
    // 逐条收集命中与否，失败时能直接看到越界的路径，而不是一个布尔值。
    const realRoot = await realpath(root);
    expect(result.map((item) => [item.path, isPathInside(item.path, realRoot)])).toEqual(
      result.map((item) => [item.path, true]),
    );
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

describe('systemFontDirectories', () => {
  it('Linux 返回系统与用户白名单目录', () => {
    expect(systemFontDirectories('linux', {}, '/home/user')).toEqual([
      '/usr/share/fonts',
      '/usr/local/share/fonts',
      '/home/user/.fonts',
      '/home/user/.local/share/fonts',
    ]);
  });

  it('macOS 返回系统与用户白名单目录', () => {
    expect(systemFontDirectories('darwin', {}, '/Users/user')).toEqual([
      '/System/Library/Fonts',
      '/Library/Fonts',
      '/Users/user/Library/Fonts',
    ]);
  });

  it('Windows 使用 WINDIR 与 LOCALAPPDATA', () => {
    expect(
      systemFontDirectories('win32', {
        WINDIR: 'C:\\Windows',
        LOCALAPPDATA: 'C:\\Users\\user\\AppData\\Local',
      }),
    ).toEqual([
      'C:\\Windows\\Fonts',
      'C:\\Users\\user\\AppData\\Local\\Microsoft\\Windows\\Fonts',
    ]);
  });

  it('Windows 缺少 WINDIR 时回退 SystemRoot，缺少 LOCALAPPDATA 时跳过', () => {
    expect(systemFontDirectories('win32', { SystemRoot: 'D:\\Win' })).toEqual([
      'D:\\Win\\Fonts',
    ]);
    expect(systemFontDirectories('win32', {})).toEqual([]);
  });

  it('未知平台返回空数组，空主目录不产生相对路径', () => {
    expect(systemFontDirectories('freebsd', {}, '/home/user')).toEqual([]);
    expect(systemFontDirectories('linux', {}, '')).toEqual([
      '/usr/share/fonts',
      '/usr/local/share/fonts',
    ]);
    expect(systemFontDirectories('darwin', {}, '')).toEqual([
      '/System/Library/Fonts',
      '/Library/Fonts',
    ]);
  });
});

describe('discoverSystemFonts', () => {
  it('递归扫描注入目录、过滤扩展名并返回 realpath', async () => {
    const root = await createTempDir();
    await createFontFixture(join(root, 'a.ttf'));
    await createFontFixture(join(root, 'sub', 'B.OTF'));
    await createFontFixture(join(root, 'sub', 'deep', 'c.ttc'));
    await createFontFixture(join(root, 'd.otc'));
    await createFontFile(join(root, 'note.txt'));
    await createFontFile(join(root, 'e.woff2'));

    const result = await discoverSystemFonts({ directories: [root] });
    const realRoot = await realpath(root);
    expect(result.fonts.map((font) => basename(font.path)).sort()).toEqual([
      'B.OTF',
      'a.ttf',
      'c.ttc',
      'd.otc',
    ]);
    // 逐条收集命中与否，失败时能直接看到越界的路径，而不是一个布尔值。
    expect(result.fonts.map((font) => [font.path, isPathInside(font.path, realRoot)])).toEqual(
      result.fonts.map((font) => [font.path, true]),
    );
    expect(result.scannedFiles).toBe(4);
    const expectedBytes = (
      await Promise.all(result.fonts.map(async (font) => (await stat(font.path)).size))
    ).reduce((sum, size) => sum + size, 0);
    expect(result.scannedBytes).toBe(expectedBytes);
  });

  it('目录不存在、不是目录时返回空结果而不报错', async () => {
    const root = await createTempDir();
    const filePath = join(root, 'a.ttf');
    await createFontFixture(filePath);

    const result = await discoverSystemFonts({
      directories: [join(root, 'missing'), filePath],
    });
    expect(result).toEqual({ fonts: [], scannedFiles: 0, scannedBytes: 0 });
  });

  it('按 realpath 对符号链接去重', async () => {
    if (process.platform === 'win32') return;
    const root = await createTempDir();
    await createFontFixture(join(root, 'real.ttf'));
    await symlink(join(root, 'real.ttf'), join(root, 'alias.ttf'));

    const result = await discoverSystemFonts({ directories: [root] });
    expect(result.fonts).toHaveLength(1);
    expect(result.fonts[0]?.path).toBe(join(await realpath(root), 'real.ttf'));
  });

  it('不跟随目录符号链接逃逸白名单', async () => {
    if (process.platform === 'win32') return;
    const root = await createTempDir();
    const outside = await createTempDir();
    await createFontFixture(join(root, 'inside.ttf'));
    await createFontFixture(join(outside, 'outside.ttf'));
    await symlink(outside, join(root, 'linked-outside'));

    const result = await discoverSystemFonts({ directories: [root] });
    expect(result.fonts.map((font) => basename(font.path))).toEqual(['inside.ttf']);
  });

  it('文件符号链接指向白名单外时跳过', async () => {
    if (process.platform === 'win32') return;
    const root = await createTempDir();
    const outside = await createTempDir();
    await createFontFixture(join(root, 'inside.ttf'));
    const outsideFont = join(outside, 'outside.ttf');
    await createFontFixture(outsideFont);
    await symlink(outsideFont, join(root, 'escape.ttf'));

    const result = await discoverSystemFonts({ directories: [root] });
    expect(result.fonts.map((font) => basename(font.path))).toEqual(['inside.ttf']);
  });

  it('目录符号链接成环时跳过且不重复收集', async () => {
    if (process.platform === 'win32') return;
    const root = await createTempDir();
    await createFontFixture(join(root, 'inside.ttf'));
    await symlink(root, join(root, 'loop'));

    const result = await discoverSystemFonts({ directories: [root] });
    expect(result.fonts.map((font) => basename(font.path))).toEqual(['inside.ttf']);
    expect(result.scannedFiles).toBe(1);
  });

  it('重复注入同一目录只扫描一次', async () => {
    const root = await createTempDir();
    await createFontFixture(join(root, 'a.ttf'));

    const result = await discoverSystemFonts({ directories: [root, root] });
    expect(result.scannedFiles).toBe(1);
  });

  it('CJK 关键字字体排前，同优先级按路径字典序', async () => {
    const root = await createTempDir();
    for (const name of [
      'zeta.ttf',
      'alpha.ttf',
      'DejaVuSans.ttf',
      'SimSun.ttc',
      'NotoSansCJK-Regular.ttc',
    ]) {
      await createFontFixture(join(root, name));
    }

    const result = await discoverSystemFonts({ directories: [root] });
    expect(result.fonts.map((font) => basename(font.path))).toEqual([
      'NotoSansCJK-Regular.ttc',
      'SimSun.ttc',
      'DejaVuSans.ttf',
      'alpha.ttf',
      'zeta.ttf',
    ]);
  });

  it('maxFonts 截断扫描文件数', async () => {
    const root = await createTempDir();
    for (const name of ['a.ttf', 'b.ttf', 'c.ttf', 'd.ttf']) {
      await createFontFixture(join(root, name));
    }

    const result = await discoverSystemFonts({ directories: [root], maxFonts: 2 });
    expect(result.fonts.map((font) => basename(font.path))).toEqual(['a.ttf', 'b.ttf']);
    expect(result.scannedFiles).toBe(2);
  });

  it('maxSystemFonts 截断注入数量但保留扫描计数', async () => {
    const root = await createTempDir();
    for (const name of ['a.ttf', 'b.ttf', 'c.ttf', 'SimSun.ttc', 'NotoSansCJK.ttc']) {
      await createFontFixture(join(root, name));
    }

    const result = await discoverSystemFonts({ directories: [root], maxSystemFonts: 2 });
    expect(result.fonts.map((font) => basename(font.path))).toEqual([
      'NotoSansCJK.ttc',
      'SimSun.ttc',
    ]);
    expect(result.scannedFiles).toBe(5);
  });

  it('总字节预算在优先级排序后应用，放不下的字体跳过', async () => {
    const root = await createTempDir();
    await createSizedFontFile(join(root, 'a.ttf'), 400);
    await createSizedFontFile(join(root, 'b.ttc'), 400);
    await createSizedFontFile(join(root, 'c.ttf'), 400);

    const result = await discoverSystemFonts({ directories: [root], maxTotalBytes: 1000 });
    expect(result.fonts.map((font) => basename(font.path))).toEqual(['a.ttf', 'b.ttc']);
    expect(result.scannedFiles).toBe(3);
    expect(result.scannedBytes).toBe(800);
  });

  it('预算先于遍历顺序：CJK 路径靠后仍优先入选', async () => {
    const root = await createTempDir();
    await createSizedFontFile(join(root, 'aaa-latin.ttf'), 600);
    await createSizedFontFile(join(root, 'zzz-NotoSansCJK.ttf'), 600);

    const result = await discoverSystemFonts({ directories: [root], maxTotalBytes: 1000 });
    expect(result.fonts.map((font) => basename(font.path))).toEqual(['zzz-NotoSansCJK.ttf']);
    expect(result.scannedFiles).toBe(2);
    expect(result.scannedBytes).toBe(600);
  });

});


describe('mergeFontFiles', () => {
  it('用户字体在前、系统字体在后并按 realpath 去重', () => {
    const userFonts = [{ path: '/fonts/user.ttf' }, { path: '/fonts/shared.ttc' }];
    const systemFonts = [
      { path: '/usr/share/fonts/a.ttf' },
      { path: '/fonts/shared.ttc' },
      { path: '/usr/share/fonts/b.ttc' },
    ];

    expect(mergeFontFiles(userFonts, systemFonts)).toEqual([
      { path: '/fonts/user.ttf' },
      { path: '/fonts/shared.ttc' },
      { path: '/usr/share/fonts/a.ttf' },
      { path: '/usr/share/fonts/b.ttc' },
    ]);
  });

  it('没有系统字体时原样返回用户字体', () => {
    const userFonts = [{ path: '/fonts/user.ttf' }];
    expect(mergeFontFiles(userFonts, [])).toEqual(userFonts);
  });
});

describe('isCjkFontFileName', () => {
  it.each(['NotoSansCJK-Regular.ttc', 'simsun.ttc', 'SourceHanSans.otf', 'msyhbd.ttc'])(
    '命中 CJK 关键字：%s',
    (name) => {
      expect(isCjkFontFileName(name)).toBe(true);
    },
  );

  it.each(['DejaVuSans.ttf', 'LiberationSerif.otf', 'font.ttf'])(
    '不命中 CJK 关键字：%s',
    (name) => {
      expect(isCjkFontFileName(name)).toBe(false);
    },
  );
});
