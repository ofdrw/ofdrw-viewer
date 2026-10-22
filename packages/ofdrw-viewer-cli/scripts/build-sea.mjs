#!/usr/bin/env node
/**
 * 构建 Node SEA 自包含可执行文件。
 *
 * 流程：
 * 1. 用 esbuild 把 CLI（含 engine 与字体/压缩依赖）打包成单个 ESM 文件；
 * 2. 收集 `@napi-rs/canvas` 的 JS 与当前平台 `.node` 到 SEA assets；
 * 3. 生成资产清单与 `sea-config.json`；
 * 4. 校验 `--target` 与当前构建机一致后，运行 `node --build-sea` 生成可执行文件；
 * 5. 在隔离的临时目录中做冷启动、二次启动与真实 OFD 转换冒烟。
 *
 * 构建机要求 Node >= 25.5（`node --build-sea`），推荐 Node 26.10。
 * macOS 只生成产物，不做签名/公证；Windows 不做代码签名。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 构建脚本所在目录。 */
const scriptDir = dirname(fileURLToPath(import.meta.url));

/** CLI 包根目录。 */
const cliDir = resolve(scriptDir, '..');

/** monorepo 根目录。 */
const repoDir = resolve(cliDir, '..', '..');

/** 构建输出目录。 */
const seaDir = join(cliDir, 'dist', 'sea');

/** SEA 内嵌资产暂存目录。 */
const assetsDir = join(seaDir, 'assets');

/** 清单格式版本，与 src/sea.ts 保持一致。 */
const MANIFEST_SCHEMA_VERSION = 1;

/**
 * 发布矩阵：目标键到运行平台、架构与 canvas 原生包的映射。
 *
 * Linux 只支持 glibc；musl、LoongArch 等不在当前矩阵内。
 */
const TARGETS = {
  'linux-x64-gnu': {
    platform: 'linux',
    arch: 'x64',
    nativePackage: '@napi-rs/canvas-linux-x64-gnu',
  },
  'linux-arm64-gnu': {
    platform: 'linux',
    arch: 'arm64',
    nativePackage: '@napi-rs/canvas-linux-arm64-gnu',
  },
  'darwin-x64': {
    platform: 'darwin',
    arch: 'x64',
    nativePackage: '@napi-rs/canvas-darwin-x64',
  },
  'darwin-arm64': {
    platform: 'darwin',
    arch: 'arm64',
    nativePackage: '@napi-rs/canvas-darwin-arm64',
  },
  'win32-x64': {
    platform: 'win32',
    arch: 'x64',
    nativePackage: '@napi-rs/canvas-win32-x64-msvc',
  },
  'win32-arm64': {
    platform: 'win32',
    arch: 'arm64',
    nativePackage: '@napi-rs/canvas-win32-arm64-msvc',
  },
};

/** 可执行文件在 Windows 上的扩展名。 */
const EXECUTABLE_EXT = process.platform === 'win32' ? '.exe' : '';

/**
 * 构建入口。
 *
 * @returns 构建完成的 Promise
 */
async function main() {
  assertNodeVersion();
  const target = resolveTarget();
  assertNativeTarget(target);
  await rm(seaDir, { recursive: true, force: true });
  await mkdir(seaDir, { recursive: true });

  const cliPackage = await readJson(join(cliDir, 'package.json'));
  const canvasInfo = await resolveCanvasAssets(target);
  const assetMap = await collectAssets(canvasInfo);
  const manifest = await writeManifest(cliPackage, canvasInfo, assetMap);
  assetMap['canvas-manifest.json'] = join(assetsDir, 'canvas-manifest.json');

  const bundlePath = await bundleMain();
  await assertCanvasExternal(bundlePath);

  const executablePath = join(seaDir, `ofdrw-viewer-cli${EXECUTABLE_EXT}`);
  await buildSeaExecutable(bundlePath, executablePath, assetMap);
  if (process.platform !== 'win32') await chmod(executablePath, 0o755);

  const smoke = await runSmoke(executablePath, cliPackage.version);
  await printSummary(executablePath, manifest, smoke, target);
}

/**
 * 解析 `--target`，未指定时使用当前平台的默认目标。
 *
 * @returns 发布目标键与目标配置
 * @throws {Error} 目标未知或缺少参数时抛出
 */
function resolveTarget() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const index = args.indexOf('--target');
  if (index === -1) {
    const current = Object.entries(TARGETS).find(
      ([, target]) => target.platform === process.platform && target.arch === process.arch,
    );
    if (!current) {
      throw new Error(
        `当前平台 ${process.platform}-${process.arch} 不在发布矩阵内；支持：${Object.keys(TARGETS).join(', ')}`,
      );
    }
    return { key: current[0], ...current[1] };
  }

  const key = args[index + 1];
  if (!key || key.startsWith('--')) {
    throw new Error('--target 缺少目标值；示例：--target linux-x64-gnu');
  }
  const target = TARGETS[key];
  if (!target) {
    throw new Error(`未知目标 ${key}；支持：${Object.keys(TARGETS).join(', ')}`);
  }
  return { key, ...target };
}

/**
 * 确认目标与当前构建机一致，避免交叉构建产生错误平台产物。
 *
 * @param target 发布目标
 * @throws {Error} 目标与当前平台/架构不一致时抛出
 */
function assertNativeTarget(target) {
  if (target.platform !== process.platform || target.arch !== process.arch) {
    throw new Error(
      `不支持交叉构建：目标 ${target.platform}-${target.arch}，当前构建机 ${process.platform}-${process.arch}；请在目标平台原生 runner 上构建`,
    );
  }
}

/**
 * 检查 Node 版本是否支持 `--build-sea`。
 */
function assertNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 25 || (major === 25 && minor < 5)) {
    throw new Error(
      `构建 SEA 需要 Node >= 25.5，当前为 ${process.versions.node}；推荐使用 Node 26.10`,
    );
  }
}

/**
 * 定位 `@napi-rs/canvas` 的 JS 包与目标平台原生包。
 *
 * @param target 发布目标
 * @returns canvas 包目录、平台包目录、原生模块文件名与版本
 */
async function resolveCanvasAssets(target) {
  const require = createRequire(import.meta.url);
  let canvasPackageJson;
  try {
    canvasPackageJson = require.resolve('@napi-rs/canvas/package.json');
  } catch (error) {
    throw new Error(
      `未找到 @napi-rs/canvas，请先在 packages/ofdrw-viewer-cli 安装依赖：${error.message}`,
      { cause: error },
    );
  }

  const canvasDir = dirname(canvasPackageJson);
  const canvasPackage = await readJson(canvasPackageJson);
  const nativePackage = target.nativePackage;

  const canvasRequire = createRequire(canvasPackageJson);
  let nativePackageJson;
  try {
    nativePackageJson = canvasRequire.resolve(`${nativePackage}/package.json`);
  } catch (error) {
    throw new Error(
      `未找到平台原生包 ${nativePackage}，请确认依赖安装完整（Linux 仅支持 glibc）：${error.message}`,
      { cause: error },
    );
  }

  const nativeDir = dirname(nativePackageJson);
  const nodeFile = (await readdir(nativeDir)).find((file) => file.endsWith('.node'));
  if (!nodeFile) {
    throw new Error(`平台原生包 ${nativePackage} 中没有 .node 文件：${nativeDir}`);
  }

  return {
    canvasDir,
    canvasVersion: canvasPackage.version,
    nativeDir,
    nativePackage,
    nativeVersion: (await readJson(nativePackageJson)).version,
    nodeFile,
  };
}

/**
 * 把 canvas JS 与平台 `.node` 复制到 assets 暂存目录。
 *
 * @param canvasInfo `resolveCanvasAssets` 的结果
 * @returns 资产键到源文件绝对路径的映射
 */
async function collectAssets(canvasInfo) {
  const canvasAssetsDir = join(assetsDir, 'canvas');
  const nativeAssetsDir = join(assetsDir, 'native');
  await mkdir(canvasAssetsDir, { recursive: true });
  await mkdir(nativeAssetsDir, { recursive: true });

  const assets = {};
  for (const file of await readdir(canvasInfo.canvasDir)) {
    if (!file.endsWith('.js') && file !== 'package.json') continue;
    const target = join(canvasAssetsDir, file);
    await copyFile(join(canvasInfo.canvasDir, file), target);
    assets[`canvas/${file}`] = target;
  }

  for (const file of [canvasInfo.nodeFile, 'package.json']) {
    const target = join(nativeAssetsDir, file);
    await copyFile(join(canvasInfo.nativeDir, file), target);
    assets[`native/${file}`] = target;
  }

  return assets;
}

/**
 * 计算资产摘要并写入 `canvas-manifest.json`。
 *
 * 摘要按资产键排序后逐项哈希，保证同一输入的缓存目录可复用。
 *
 * @param cliPackage CLI 的 package.json 内容
 * @param canvasInfo `resolveCanvasAssets` 的结果
 * @param assets 资产键到源文件路径的映射
 * @returns 写入的内嵌资产清单
 */
async function writeManifest(cliPackage, canvasInfo, assets) {
  const hash = createHash('sha256');
  for (const key of Object.keys(assets).sort()) {
    hash.update(key);
    hash.update('\0');
    hash.update(await readFile(assets[key]));
  }
  const digest = hash.digest('hex').slice(0, 16);

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    cliVersion: cliPackage.version,
    platform: process.platform,
    arch: process.arch,
    canvasVersion: canvasInfo.canvasVersion,
    nativePackage: canvasInfo.nativePackage,
    nativeVersion: canvasInfo.nativeVersion,
    nodeFile: canvasInfo.nodeFile,
    digest,
  };
  await writeFile(
    join(assetsDir, 'canvas-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

/**
 * 用 esbuild 打包 SEA 主模块。
 *
 * 生成一个启动包装：先准备 SEA 内嵌资产，再动态导入真实 CLI 入口，
 * 从而不必修改普通 Node 的 `bin.ts`。
 *
 * @returns 打包产物绝对路径
 */
async function bundleMain() {
  const esbuild = loadEsbuild();
  const entryPath = join(seaDir, 'sea-entry.mjs');
  const entrySource = [
    '// 本文件由 scripts/build-sea.mjs 生成，请勿手工修改。',
    '',
    '// Node 26.10 的 SEA 在 import.meta 只被嵌套函数引用时不会初始化它；',
    '// 在入口顶层引用一次并校验，确保 canvas.ts 的 createRequire(import.meta.url) 可用。',
    'const entryUrl = import.meta.url;',
    "if (typeof entryUrl !== 'string' || entryUrl.length === 0) {",
    "  console.error('错误[CLI_SEA_ENTRY_URL]：SEA 入口无法获取 import.meta.url');",
    '  process.exit(2);',
    '}',
    '',
    "import { prepareSeaAssets } from '../../src/sea.ts';",
    '',
    'try {',
    '  await prepareSeaAssets();',
    '} catch (error) {',
    '  const message = error instanceof Error ? error.message : String(error);',
    '  console.error(`错误[CLI_SEA_EXTRACT_FAILED]：${message}`);',
    '  process.exit(2);',
    '}',
    '',
    "await import('../../src/bin.ts');",
    '',
  ].join('\n');
  await writeFile(entryPath, entrySource);

  const outfile = join(seaDir, 'bin-sea.mjs');
  await esbuild.build({
    entryPoints: [entryPath],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: ['@napi-rs/canvas'],
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
  });
  return outfile;
}

/**
 * 解析 esbuild。
 *
 * 优先使用 CLI 直接依赖；否则从 workspace 根的工具链（vitest → vite →
 * esbuild）解析，最后兼容通过 tsup 间接安装的场景，避免为构建脚本新增依赖。
 *
 * @returns esbuild 模块
 */
function loadEsbuild() {
  const require = createRequire(import.meta.url);
  try {
    return require('esbuild');
  } catch {
    // 继续尝试 workspace 工具链。
  }

  try {
    const vitestDir = realpathSync(join(repoDir, 'node_modules', 'vitest'));
    const vitestRequire = createRequire(join(vitestDir, 'package.json'));
    const viteRequire = createRequire(vitestRequire.resolve('vite'));
    return viteRequire('esbuild');
  } catch {
    // 继续尝试 tsup。
  }

  try {
    const tsupRequire = createRequire(require.resolve('tsup'));
    return tsupRequire('esbuild');
  } catch {
    throw new Error(
      '未找到 esbuild；构建 SEA 需要 workspace 根安装 vitest（提供 vite/esbuild）或为 CLI 安装 esbuild',
    );
  }
}

/**
 * 确认 bundle 没有留下对 `@napi-rs/canvas` 的静态导入。
 *
 * SEA 中该模块来自解压目录，静态导入会在启动时直接失败。
 *
 * @param bundlePath bundle 绝对路径
 * @returns 检查完成的 Promise
 */
async function assertCanvasExternal(bundlePath) {
  const bundle = await readFile(bundlePath, 'utf8');
  if (/from\s*['"]@napi-rs\/canvas['"]/.test(bundle)) {
    throw new Error(
      'bundle 中仍存在对 @napi-rs/canvas 的静态导入；canvas.ts 必须通过 createRequire 动态加载，才能从 SEA 解压目录读取',
    );
  }
}

/**
 * 调用 Node 的 SEA 构建能力生成可执行文件。
 *
 * @param bundlePath SEA 主模块绝对路径
 * @param executablePath 输出可执行文件绝对路径
 * @param assets 资产键到文件绝对路径的映射
 * @returns 构建完成的 Promise
 */
async function buildSeaExecutable(bundlePath, executablePath, assets) {
  const configPath = join(seaDir, 'sea-config.json');
  const config = {
    main: bundlePath,
    output: executablePath,
    mainFormat: 'module',
    disableExperimentalSEAWarning: true,
    assets,
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const result = spawnSync(process.execPath, ['--build-sea', configPath], {
    cwd: cliDir,
    stdio: 'inherit',
  });
  if (result.error) {
    throw new Error(`无法执行 node --build-sea：${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(`node --build-sea 失败，退出码 ${result.status}`);
  }
}

/**
 * 在隔离临时目录中执行冷启动、二次启动与真实 OFD 转换冒烟。
 *
 * @param executablePath 可执行文件绝对路径
 * @param version CLI 版本
 * @returns 冒烟结果，包含耗时与转换产物路径
 */
async function runSmoke(executablePath, version) {
  const smokeTmp = join(seaDir, 'smoke-tmp');
  await rm(smokeTmp, { recursive: true, force: true });
  await mkdir(smokeTmp, { recursive: true });
  const env = { ...process.env, TMPDIR: smokeTmp, TEMP: smokeTmp, TMP: smokeTmp };

  const coldStartMs = measure(() =>
    runExecutable(executablePath, ['--version'], env, version),
  );
  const warmStartMs = measure(() =>
    runExecutable(executablePath, ['--version'], env, version),
  );
  runExecutable(executablePath, ['--help'], env);

  const sample = join(repoDir, 'ofd_pdf_match', 'helloworld.ofd');
  let convertedFile;
  if (await pathExists(sample)) {
    const outDir = join(seaDir, 'smoke-out');
    await rm(outDir, { recursive: true, force: true });
    runExecutable(executablePath, [sample, '-o', outDir], env);
    convertedFile = join(outDir, 'helloworld-p001.png');
    if (!(await pathExists(convertedFile))) {
      throw new Error(`SEA 转换冒烟未生成 PNG：${convertedFile}`);
    }
  }

  await rm(smokeTmp, { recursive: true, force: true });
  return { coldStartMs, warmStartMs, convertedFile };
}

/**
 * 运行可执行文件并校验退出码。
 *
 * @param executablePath 可执行文件绝对路径
 * @param args 命令行参数
 * @param env 子进程环境变量
 * @param expectedVersion 期望出现在 `--version` 输出中的版本号
 * @returns 子进程执行结果
 */
function runExecutable(executablePath, args, env, expectedVersion) {
  const result = spawnSync(executablePath, args, { env, encoding: 'utf8' });
  if (result.error) {
    throw new Error(`无法运行 ${executablePath}：${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(
      `SEA 冒烟失败（参数：${args.join(' ')}，退出码：${result.status}）：${result.stderr ?? ''}`,
    );
  }
  if (expectedVersion && !result.stdout.includes(expectedVersion)) {
    throw new Error(
      `--version 输出不包含版本 ${expectedVersion}：${result.stdout.trim()}`,
    );
  }
  return result;
}

/**
 * 测量同步操作耗时。
 *
 * @param operation 待执行的操作
 * @returns 耗时毫秒数
 */
function measure(operation) {
  const startedAt = performance.now();
  operation();
  return Math.round(performance.now() - startedAt);
}

/**
 * 输出构建摘要。
 *
 * @param executablePath 可执行文件绝对路径
 * @param manifest 资产清单
 * @param smoke 冒烟结果
 * @param target 发布目标
 * @returns 输出完成的 Promise
 */
async function printSummary(executablePath, manifest, smoke, target) {
  const { size } = await stat(executablePath);
  const sizeMb = (size / 1024 / 1024).toFixed(1);
  console.log('');
  console.log('SEA 构建完成');
  console.log(`  目标：${target.key}（${target.platform}-${target.arch}）`);
  console.log(`  可执行文件：${executablePath}（${sizeMb} MB）`);
  console.log(
    `  canvas：${manifest.canvasVersion} / ${manifest.nativePackage} / ${manifest.nodeFile}`,
  );
  console.log(`  冷启动（--version）：${smoke.coldStartMs} ms`);
  console.log(`  二次启动（--version）：${smoke.warmStartMs} ms`);
  if (smoke.convertedFile) {
    console.log(`  转换冒烟：${smoke.convertedFile}`);
  } else {
    console.log('  转换冒烟：跳过（未找到 ofd_pdf_match/helloworld.ofd）');
  }
}

/**
 * 读取并解析 JSON 文件。
 *
 * @param filePath JSON 文件绝对路径
 * @returns 解析后的对象
 */
async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

/**
 * 判断路径是否存在。
 *
 * @param filePath 待检查路径
 * @returns 存在时为 `true`
 */
async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(`SEA 构建失败：${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exitCode = 1;
});