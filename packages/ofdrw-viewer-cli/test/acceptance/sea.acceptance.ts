/**
 * SEA 自包含可执行文件黑盒验收。
 *
 * 在 PATH 只含空目录、TMPDIR 指向隔离临时目录的环境中运行 SEA 产物，
 * 验证无 Node 依赖、冷/热启动、图片/文本转换与缓存命中。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CLI_DIR,
  DENSE_OFD,
  HELLO_OFD,
  MULTI_OFD,
  SEA_BIN,
  cleanupTempDirs,
  createTempDir,
  findTempArtifacts,
  inspectImage,
  listFiles,
  readHexPrefix,
  readTextJson,
  readTextOracle,
  runSea,
} from './helpers.js';

/** SEA 隔离运行环境。 */
interface SeaIsolation {
  /** 本次隔离的根目录。 */
  readonly root: string;
  /** 空的 PATH 目录（确保找不到 node）。 */
  readonly emptyBin: string;
  /** 隔离的 TMPDIR。 */
  readonly tmpDir: string;
  /** 隔离的工作目录。 */
  readonly cwd: string;
  /** 传给 SEA 的环境变量。 */
  readonly env: NodeJS.ProcessEnv;
}

/**
 * 创建隔离运行环境。
 *
 * @returns 隔离环境描述
 */
async function createIsolation(): Promise<SeaIsolation> {
  const root = await createTempDir('ofdrw-cli-sea-');
  const emptyBin = join(root, 'empty-bin');
  const tmpDir = join(root, 'tmp');
  const cwd = join(root, 'cwd');
  await mkdir(emptyBin);
  await mkdir(tmpDir);
  await mkdir(cwd);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: emptyBin,
    TMPDIR: tmpDir,
    TEMP: tmpDir,
    TMP: tmpDir,
    HOME: cwd,
  };
  delete env.OFDRW_CANVAS_DIR;
  delete env.NAPI_RS_NATIVE_LIBRARY_PATH;
  delete env.NODE_OPTIONS;
  return { root, emptyBin, tmpDir, cwd, env };
}

/**
 * 断言隔离环境中无法解析到 Node。
 *
 * @param env 隔离环境变量
 */
function expectNodeUnavailable(env: NodeJS.ProcessEnv): void {
  const probe = spawnSync('node', ['--version'], { env, encoding: 'utf8' });
  expect(probe.error ?? probe.stderr).toBeTruthy();
}

beforeAll(async () => {
  if (existsSync(SEA_BIN)) return;
  // 直接运行验收测试时兜底构建；通过 `pnpm test:acceptance` 运行时已提前构建。
  const build = spawnSync(
    process.execPath,
    [join(CLI_DIR, 'scripts', 'build-sea.mjs')],
    { cwd: CLI_DIR, encoding: 'utf8', timeout: 600_000 },
  );
  if (build.error) throw build.error;
  if (build.status !== 0) {
    throw new Error(`SEA 构建失败（退出码 ${build.status}）：\n${build.stdout}\n${build.stderr}`);
  }
}, 600_000);

afterEach(cleanupTempDirs);

describe('图片 CLI 黑盒验收：SEA 无 Node 运行', () => {
  it('PATH 不含 node 时 --version 与 --help 均成功', async () => {
    const iso = await createIsolation();
    expectNodeUnavailable(iso.env);

    const version = await runSea(['--version'], {
      cwd: iso.cwd,
      env: iso.env,
      timeoutMs: 120_000,
    });
    expect(version.code).toBe(0);
    expect(version.stdout).toContain('ofdrw-viewer-cli 0.1.5');
    expect(version.stdout).toContain(`${process.platform}-${process.arch}`);

    const help = await runSea(['--help'], {
      cwd: iso.cwd,
      env: iso.env,
      timeoutMs: 120_000,
    });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('用法: ofdrw-viewer-cli');
    expect(help.stdout).toContain('--pages');
  });

  it('PATH 不含 node 时完成 OFD→PNG，二次启动命中缓存', async () => {
    const iso = await createIsolation();
    expectNodeUnavailable(iso.env);

    // 第一次（冷启动）：解包 canvas 资产并转换含图文的 999 第 1 页。
    const out1 = join(iso.root, 'out1');
    const first = await runSea([MULTI_OFD, '-o', out1, '--pages', '1'], {
      cwd: iso.cwd,
      env: iso.env,
      timeoutMs: 180_000,
    });
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('完成：1/1 页');

    const png1 = join(out1, '999-p001.png');
    expect(await readHexPrefix(png1, 8)).toBe('89504e470d0a1a0a');
    const image = await inspectImage(png1);
    expect({ width: image.width, height: image.height }).toEqual({ width: 794, height: 530 });
    expect(image.cornerIsWhite).toBe(true);
    expect(image.nonWhiteSamples).toBeGreaterThan(0);
    expect(await findTempArtifacts(out1)).toEqual([]);

    // 在隔离 TMPDIR 中按前缀发现唯一缓存根，不写死根路径。
    const cacheRoots = (await readdir(iso.tmpDir)).filter((name) =>
      /^ofdrw-viewer-cli(?:-u\d+)?$/.test(name),
    );
    expect(cacheRoots).toHaveLength(1);
    const cacheRoot = join(iso.tmpDir, cacheRoots[0] as string);
    if (process.platform !== 'win32' && process.getuid !== undefined) {
      expect(cacheRoots[0]).toBe(`ofdrw-viewer-cli-u${process.getuid()}`);
      expect(existsSync(join(iso.tmpDir, 'ofdrw-viewer-cli'))).toBe(false);
    }
    const coldEntries = await readdir(cacheRoot);
    expect(coldEntries).toHaveLength(1);
    const cacheDir = join(cacheRoot, coldEntries[0] as string);
    const markerPath = join(cacheDir, '.complete');
    const coldMarker = await stat(markerPath);
    expect((await stat(cacheRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(cacheDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(cacheDir, 'native'))).mode & 0o777).toBe(0o700);

    // 第二次（热启动）：不得重建缓存目录或重写完成标记；继续验证默认 A4 输出。
    const out2 = join(iso.root, 'out2');
    const second = await runSea([HELLO_OFD, '-o', out2], {
      cwd: iso.cwd,
      env: iso.env,
      timeoutMs: 180_000,
    });
    expect(second.code).toBe(0);
    const helloPng = join(out2, 'helloworld-p001.png');
    expect(existsSync(helloPng)).toBe(true);
    const helloImage = await inspectImage(helloPng);
    expect({ width: helloImage.width, height: helloImage.height }).toEqual({
      width: 794,
      height: 1123,
    });
    expect(await readdir(cacheRoot)).toEqual(coldEntries);
    const warmMarker = await stat(markerPath);
    expect(warmMarker.mtimeMs).toBe(coldMarker.mtimeMs);
    expect(await findTempArtifacts(cacheRoot)).toEqual([]);
  });


  it('PATH 不含 node 时 --text 导出 dense 第 1 页，PNG 与 JSON 坐标一致', async () => {
    const iso = await createIsolation();
    expectNodeUnavailable(iso.env);
    const outDir = join(iso.root, 'out-text');

    const result = await runSea([DENSE_OFD, '-o', outDir, '--text', '--pages', '1'], {
      cwd: iso.cwd,
      env: iso.env,
      timeoutMs: 180_000,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('完成：1/1 页（图片 + 文本）');
    expect(await listFiles(outDir)).toEqual([
      'dense-text-perf-p001.json',
      'dense-text-perf-p001.png',
    ]);
    const { records } = await readTextJson(join(outDir, 'dense-text-perf-p001.json'));
    const oracle = await readTextOracle(DENSE_OFD, 0, 96);
    expect(records).toHaveLength(147);
    expect(records).toEqual(oracle);

    const image = await inspectImage(join(outDir, 'dense-text-perf-p001.png'));
    expect({ width: image.width, height: image.height }).toEqual({
      width: 794,
      height: 1123,
    });
    expect(image.nonWhiteSamples).toBeGreaterThan(0);
    expect(await findTempArtifacts(outDir)).toEqual([]);
  });

  it('TMPDIR 不可用时退出 2 并给出 CLI_SEA_EXTRACT_FAILED', async () => {
    const iso = await createIsolation();
    const badTmp = join(iso.root, 'not-a-dir');
    await writeFile(badTmp, 'x');
    const env: NodeJS.ProcessEnv = {
      ...iso.env,
      TMPDIR: badTmp,
      TEMP: badTmp,
      TMP: badTmp,
    };

    const result = await runSea(['--version'], {
      cwd: iso.cwd,
      env,
      timeoutMs: 60_000,
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('CLI_SEA_EXTRACT_FAILED');
  });
});