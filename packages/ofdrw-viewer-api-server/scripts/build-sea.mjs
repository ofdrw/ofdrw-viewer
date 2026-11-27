#!/usr/bin/env node
/**
 * 构建 Node SEA 自包含可执行文件。
 *
 * 流程：
 * 1. 用 esbuild 把 api-server 自身源码打成单个 IIFE 脚本，第三方依赖保持外部导入
 *    （CJS 格式会把 import 提升成文件顶部的 require，在依赖解压前就解析而失败）；
 * 2. 收集 `@napi-rs/canvas` 的 JS 与当前平台 `.node`、第三方依赖闭包，连同 IIFE 脚本
 *    一并写入 SEA assets；
 * 3. 生成资产清单与 `sea-config.json`（入口模块由 buildSeaEntrySource 生成）；
 * 4. 校验 `--target` 与当前构建机一致后，运行 `node --build-sea` 生成可执行文件；
 * 5. 在隔离的临时目录中做冷启动、配置校验与真实服务启动冒烟。
 *
 * 构建机要求 Node >= 25.5（`node --build-sea`），推荐 Node 26.10。
 * 可执行文件启动时先解压依赖与 canvas 资产到可执行文件同级的 `.ofdrw-cache/`，
 * 再把内嵌的 `api-server-config.yaml`、README 与 docs/skills 落地到可执行文件所在目录
 * （已存在则跳过），与发行压缩包内的目录结构一致。
 * macOS 只生成产物，不做签名/公证；Windows 不做代码签名。
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
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

/** api-server 包根目录。 */
const serverDir = resolve(scriptDir, '..');

/** monorepo 根目录。 */
const repoDir = resolve(serverDir, '..', '..');

/**
 * SEA 构建输出目录。
 *
 * 放在 `dist` 之外：`prepack` 会触发 `build`，而 `build` 会清空 `dist`，
 * 若产物位于 `dist/sea` 会被打包流程误删。
 */
const seaDir = join(serverDir, 'out', 'sea');

/** SEA 内嵌资源暂存目录。 */
const assetsDir = join(seaDir, 'assets');

/** 可执行文件名（不含扩展名）。 */
const EXECUTABLE_BASE_NAME = 'ofdrw-api-server';

/** 业务主体（IIFE bundle）在 SEA 资产中的键名。 */
const BODY_ASSET_KEY = 'sea-body.js';

/** 清单格式版本，与 src/sea.ts 保持一致。 */
const MANIFEST_SCHEMA_VERSION = 1;

/**
 * 不参与打包、由 SEA 运行时解压目录解析的直接依赖。
 *
 * 除 `@napi-rs/canvas`（单独收集 JS 与原生模块）外，其余依赖整棵安装树原样
 * 内嵌，以保证 CommonJS 包内部的动态 require 可以正常工作。
 */
const EXTERNAL_PACKAGES = [
  '@napi-rs/canvas',
  '@fastify/cors',
  '@fastify/multipart',
  '@ofdrw/ofdrw-viewer-crypto',
  '@ofdrw/ofdrw-viewer-engine',
  'fastify',
  'fflate',
  'pino',
  'pino-roll',
  'yaml',
  'zod',
];

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

  const serverPackage = await readJson(join(serverDir, 'package.json'));
  const canvasInfo = await resolveCanvasAssets(target);
  const assetMap = await collectAssets(canvasInfo);
  const manifest = await writeManifest(serverPackage, canvasInfo, assetMap);
  assetMap['canvas-manifest.json'] = join(assetsDir, 'canvas-manifest.json');

  const dependencyKeys = await collectDependencyClosure(assetMap);

  const { bundlePath, tempPath } = await bundleMain(assetMap);
  await assertCanvasExternal(bundlePath);

  const executablePath = join(seaDir, `${EXECUTABLE_BASE_NAME}${EXECUTABLE_EXT}`);
  await buildSeaExecutable(bundlePath, executablePath, assetMap);
  if (process.platform !== 'win32') await chmod(executablePath, 0o755);

  const smoke = await runSmoke(executablePath, serverPackage.version);
  // 业务主体已内嵌进产物，可在构建完成（含冒烟）后清理。
  await rm(tempPath, { force: true });

  await printSummary(executablePath, manifest, dependencyKeys, smoke, target);
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
      `未找到 @napi-rs/canvas，请先在 packages/ofdrw-viewer-api-server 安装依赖：${error.message}`,
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
 * @param serverPackage 包的 package.json 内容
 * @param canvasInfo `resolveCanvasAssets` 的结果
 * @param assets 资产键到源文件路径的映射
 * @returns 写入的内嵌资产清单
 */
async function writeManifest(serverPackage, canvasInfo, assets) {
  const hash = createHash('sha256');
  for (const key of Object.keys(assets).sort()) {
    hash.update(key);
    hash.update('\0');
    hash.update(await readFile(assets[key]));
  }
  const digest = hash.digest('hex').slice(0, 16);

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    cliVersion: serverPackage.version,
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
 * 收集第三方依赖闭包，按 `node_modules/<包名>/<相对路径>` 作为资产键。
 *
 * 从直接依赖出发，沿每个包的 `dependencies`/`optionalDependencies` 补齐整棵树；
 * 只收集会执行或被读取的文件（js/mjs/cjs/json/wasm/node），跳过源码、类型与文档。
 * 原生模块 `.node` 只收集 `@napi-rs/canvas` 平台包在构建机上的那一份，
 * `@napi-rs/canvas` 自身的 JS 与原生模块由 canvas 资产单独提供。
 *
 * @param assetMap 已收集的 canvas 资产映射，新资产会追加进来
 * @returns 依赖资产键列表
 */
async function collectDependencyClosure(assetMap) {
  const collected = [];
  const queue = [...EXTERNAL_PACKAGES];
  const seen = new Set();
  /** 已登记的依赖中，属于 optionalDependencies 的包名。 */
  const optionalDependencies = new Set();
  const lookup = await createPackageLookup();

  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);

    const optional = optionalDependencies.has(name);
    const packageDir = lookup.get(name);
    if (packageDir === undefined) {
      // 可选依赖（如其他平台的 canvas 原生包）未安装时跳过。
      if (optional) continue;
      throw new Error(`未找到依赖 ${name}，请先在 packages/ofdrw-viewer-api-server 安装依赖`);
    }

    if (name !== '@napi-rs/canvas') {
      for (const relative of await listDependencyFiles(packageDir)) {
        const key = `node_modules/${name}/${relative}`;
        if (assetMap[key] !== undefined) continue;
        const target = join(assetsDir, key);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(packageDir, relative), target);
        assetMap[key] = target;
        collected.push(key);
      }
    }

    const manifest = await readJson(join(packageDir, 'package.json'));
    for (const dep of Object.keys(manifest.optionalDependencies ?? {})) optionalDependencies.add(dep);
    for (const dep of [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]) {
      queue.push(dep);
    }
  }
  return collected;
}

/**
 * 建立包名到物理目录的映射，供依赖闭包遍历使用。
 *
 * pnpm 严格隔离下各包依赖位于其自身 node_modules：先从本包依赖入口解析，
 * 再把每个已解析包目录作为新的查找位置，覆盖嵌套与 peer 依赖。
 *
 * @returns 带惰性查找的映射（`get(name)`）
 */
async function createPackageLookup() {
  const cache = new Map();
  const heads = [serverDir];
  return {
    get(name) {
      const cached = cache.get(name);
      if (cached !== undefined) return cached;
      for (const head of heads) {
        try {
          const resolved = createRequire(join(head, 'package.json')).resolve(name);
          const directory = findPackageRoot(dirname(realpathSync(resolved)));
          cache.set(name, directory);
          heads.push(directory);
          return directory;
        } catch {
          // 换下一个查找位置。
        }
      }
      return undefined;
    },
  };
}

/**
 * 自某个文件目录向上查找最近的 package.json 所在目录。
 *
 * @param directory 起始目录
 * @returns 包根目录；向上到文件系统根仍未找到时返回起始目录
 */
function findPackageRoot(directory) {
  let current = directory;
  for (;;) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) return directory;
    current = parent;
  }
}

/**
 * 列出包内需要内嵌的文件（相对路径，使用 `/` 分隔）。
 *
 * @param directory 包目录绝对路径
 * @returns 相对文件路径列表
 */
async function listDependencyFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const child of await listDependencyFiles(full)) result.push(`${entry.name}/${child}`);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(?:js|mjs|cjs|json|wasm|node)$/.test(entry.name)) continue;
    result.push(entry.name);
  }
  return result;
}

/**
 * 用 esbuild 打包 SEA 主模块。
 *
 * 生成一个启动包装：先准备 SEA 内嵌资产，再把发行文件落地到可执行文件目录，
 * 最后动态导入真实入口，从而不必修改普通 Node 的 `bin.ts`。
 *
 * @returns 打包产物绝对路径
 */
async function bundleMain(assetMap) {
  const esbuild = loadEsbuild();

  // 打包为 IIFE：SEA 只运行内嵌的入口模块，相对路径等子模块都无法解析，因此把整棵源码
  // 打成一个脚本，由入口在资源解压后用指向解压目录的 require 求值执行。
  // 不用 CommonJS：它会把 import 提升成文件顶部的 require，在依赖解压前就解析而失败。
  const common = {
    bundle: true,
    format: 'iife',
    platform: 'node',
    target: 'node22',
    external: EXTERNAL_PACKAGES,
    plugins: [externalPackagesPlugin],
    // 保留 `import.meta` 原样：esbuild 输出空对象，源码中的 `?? __filename` 负责兜底。
    supported: { 'import-meta': true },
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
  };
  const bodyPath = join(seaDir, 'sea-body.js');
  await esbuild.build({ ...common, entryPoints: [join(serverDir, 'src', 'bin.ts')], outfile: bodyPath });
  // 去掉入口自带的 shebang：主体以 new Function 执行，shebang 不能出现在其中。
  const bodySource = (await readFile(bodyPath, 'utf8')).replace(/^#![^\n]*\n/, '');
  await writeFile(bodyPath, bodySource);
  assetMap[BODY_ASSET_KEY] = bodyPath;

  const entryPath = join(seaDir, 'bin-sea.mjs');
  await writeFile(entryPath, buildSeaEntrySource());
  // 入口本身就是最终产物，只做语法检查，不再二次打包（二次打包会把 import 改写成 require）。
  const outfile = join(seaDir, 'bin-sea.mjs');
  spawnSync(process.execPath, ['--check', outfile], { stdio: 'inherit' });
  return { bundlePath: outfile, tempPath: bodyPath };
}

/**
 * 生成 SEA 入口模块源码。
 *
 * 入口负责：读取内嵌的业务主体、建立指向解压目录的依赖解析、执行主体。
 * 依赖解析通过 `Module._resolveFilename` 钩子实现，覆盖 `require()` 与
 * `createRequire()` 两条路径，同时保留 `@napi-rs/canvas` 的原生模块加载。
 *
 * @returns 入口模块源码
 */
function buildSeaEntrySource() {
  return [
    '// 本文件由 scripts/build-sea.mjs 生成，请勿手工修改。',
    '//',
    '// 执行顺序：解压内嵌资源 → 用解压目录的 require 执行业务主体。',
    "import { Module, createRequire } from 'node:module';",
    "import * as seaApi from 'node:sea';",
    '',
    '// Node 26.10 的 SEA 在 import.meta 只被嵌套函数引用时不会初始化它；这里在顶层引用一次，',
    '// 保证 createRequire(import.meta.url) 与内嵌路径可用。',
    'const entryUrl = import.meta.url;',
    "if (typeof entryUrl !== 'string' || entryUrl.length === 0) {",
    "  console.error('错误[CLI_SEA_ENTRY_URL]：SEA 入口无法获取 import.meta.url');",
    '  process.exit(2);',
    '}',
    '',
    '// 缓存根与 src/sea.ts 的布局一致：<可执行文件目录>/.ofdrw-cache/<u<uid>|win>。',
    '// 手工拼接路径，避免与业务主体内的符号重名。',
    "const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;",
    "const execDir = process.execPath.split(/[\\/]/).slice(0, -1).join('/');",
    'const cacheDir = `${execDir}/.ofdrw-cache/${uid === undefined ? \'win\' : \'u\' + uid}`;',
    '// 缓存目录只允许当前用户访问：目录 0700、文件 0600（与 src/sea.ts 的校验一致）。',
    "const fs = createRequire(import.meta.url)('node:fs');",
    'const path = createRequire(import.meta.url)(\'node:path\');',
    'fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });',
    'try { fs.chmodSync(cacheDir, 0o700); } catch { /* Windows 忽略 */ }',
    '',
    '// 1. 解压内嵌资源：第三方依赖与 canvas 原生模块（主体代码内嵌在内存中，无需落盘）。',
    '// 依赖落在 <cache>/node_modules，canvas 与原生模块落在 <cache>/<版本摘要>/。',
    "const moduleRequire = createRequire(cacheDir + '/node_modules/index.js');",
    "process.env.OFDRW_SEA_NODE_MODULES = cacheDir + '/node_modules';",
    "const manifest = JSON.parse(new TextDecoder().decode(seaApi.getRawAsset('canvas-manifest.json')));",
    "const cacheSubdir = `${uid === undefined ? 'win' : 'u' + uid}-${manifest.cliVersion}-${manifest.platform}-${manifest.arch}-${manifest.digest}`;",
    'const assetsDir = `${cacheDir}/${cacheSubdir}`;',
    'fs.mkdirSync(assetsDir, { recursive: true, mode: 0o700 });',
    'try { fs.chmodSync(assetsDir, 0o700); } catch { /* Windows 忽略 */ }',
    "for (const key of seaApi.getAssetKeys()) {",
    "  if (!key.startsWith('node_modules/') && !key.startsWith('canvas/') && !key.startsWith('native/')) continue;",
    '  const relative = key.startsWith(\'node_modules/\') ? key.slice(\'node_modules/\'.length) : key;',
    '  const target = key.startsWith(\'node_modules/\') ? `${cacheDir}/node_modules/${relative}` : `${assetsDir}/${relative}`;',
    '  // 已存在则跳过：同一产物重复启动无需再次写盘。',
    '  if (fs.existsSync(target)) continue;',
    '  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });',
    "  fs.writeFileSync(target, Buffer.from(seaApi.getRawAsset(key)), { mode: 0o600 });",
    '}',
    'process.env.OFDRW_CANVAS_DIR = assetsDir;',
    '',
    '// 2. 执行业务主体：内嵌的 IIFE 脚本，用指向解压目录的 require 求值。',
    "const bodySource = new TextDecoder().decode(seaApi.getRawAsset('sea-body.js'));",
    "const shell = new Module(`${execDir}/ofdrw-api-server-entry.js`);",
    'shell.filename = `${execDir}/ofdrw-api-server-entry.js`;',
    '// 查找路径按解压目录计算，主体内嵌套依赖随之解析到同一棵树。',
    'const nodeModulePaths = Module._nodeModulePaths;',
    'shell.paths = nodeModulePaths(cacheDir + \'/node_modules\');',
    "const runBody = new Function('exports', 'require', 'module', '__filename', '__dirname', bodySource);",
    'runBody(shell.exports, moduleRequire, shell, shell.filename, cacheDir);',
    '',
  ].join('\n');
}

/**
 * esbuild 插件：让全部第三方依赖保持外部导入。
 *
 * 只打包相对路径入口与本地源码；裸包名（含 `@ofdrw/*` 工作区包）一律 external，
 * 发布产物里由解压出的 `node_modules` 提供。
 */
const externalPackagesPlugin = {
  name: 'external-packages',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (
        args.kind === 'entry-point' ||
        args.path.startsWith('.') ||
        args.path.startsWith('/') ||
        args.path.startsWith('node:')
      ) {
        return undefined;
      }
      return { path: args.path, external: true };
    });
  },
};

/**
 * esbuild 插件：`ofdrw-seapkg/*` 前缀说明符保持外部，由 SEA 解析钩子处理。
 */
const externalSeapkgPlugin = {
  name: 'external-seapkg',
  setup(build) {
    build.onResolve({ filter: /^ofdrw-seapkg\// }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

/**
 * 解析 esbuild。
 *
 * 优先使用包直接依赖；否则从 workspace 根的工具链（vitest → vite → esbuild）
 * 解析，最后兼容通过 tsup 间接安装的场景，避免为构建脚本新增依赖。
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
      '未找到 esbuild；构建 SEA 需要 workspace 根安装 vitest（提供 vite/esbuild）或为包安装 esbuild',
    );
  }
}

/**
 * 确认 bundle 没有留下静态导入的原生模块。
 *
 * SEA 中 `@napi-rs/canvas` 来自解压目录，静态导入会在启动时直接失败。
 *
 * @param bundlePath bundle 绝对路径
 * @returns 检查完成的 Promise
 */
async function assertCanvasExternal(bundlePath) {
  const bundle = await readFile(bundlePath, 'utf8');
  if (/from\s*['"]@napi-rs\/canvas['"]/.test(bundle)) {
    throw new Error(
      'bundle 中仍存在对 @napi-rs/canvas 的静态导入；engine/canvas.ts 必须通过 createRequire 动态加载，才能从 SEA 解压目录读取',
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
    cwd: serverDir,
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
 * 在隔离临时目录中执行冷启动、配置校验、文件落地与真实服务启动冒烟。
 *
 * @param executablePath 可执行文件绝对路径
 * @param version 包版本
 * @returns 冒烟结果，包含耗时与健康检查响应
 */
async function runSmoke(executablePath, version) {
  const smokeTmp = join(seaDir, 'smoke-tmp');
  await rm(smokeTmp, { recursive: true, force: true });
  await mkdir(smokeTmp, { recursive: true });

  // 目标平台与构建机一致，可把可执行文件复制到临时目录模拟“解压即用”。
  const isolatedPath = join(smokeTmp, `${EXECUTABLE_BASE_NAME}${EXECUTABLE_EXT}`);
  await copyFile(executablePath, isolatedPath);
  if (process.platform !== 'win32') await chmod(isolatedPath, 0o755);

  const env = {
    ...process.env,
    TMPDIR: join(smokeTmp, 'tmp'),
    TEMP: join(smokeTmp, 'tmp'),
    TMP: join(smokeTmp, 'tmp'),
  };
  await mkdir(env.TMPDIR, { recursive: true });

  const coldStartMs = measure(() => runExecutable(isolatedPath, ['--version'], env, version));
  const warmStartMs = measure(() => runExecutable(isolatedPath, ['--version'], env, version));
  runExecutable(isolatedPath, ['--help'], env);

  const workspace = join(smokeTmp, 'workspace');
  // `-t` 只校验、不创建目录，因此预先建好工作区与日志目录，模拟部署后的真实布局。
  await mkdir(join(workspace, 'logs'), { recursive: true });
  runExecutable(isolatedPath, ['--workdir', workspace, '-t'], env);

  const health = await startAndProbe(isolatedPath, workspace, env);

  await rm(smokeTmp, { recursive: true, force: true });
  return { coldStartMs, warmStartMs, health };
}

/**
 * 启动服务并请求健康检查后关闭。
 *
 * 端口取工作区配置（自动生成的默认配置为 7860）；冒烟环境为隔离临时目录，
 * 若端口被占用会直接失败，而不是顺延。
 *
 * @param executablePath 可执行文件绝对路径
 * @param workspace 工作区根绝对路径
 * @param env 子进程环境变量
 * @returns 健康检查响应摘要
 */
async function startAndProbe(executablePath, workspace, env) {
  const child = spawn(executablePath, ['--workdir', workspace], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const exited = new Promise((resolveExit) => {
    child.once('exit', (code) => resolveExit(code));
    child.once('error', () => resolveExit(-1));
  });

  try {
    const url = await waitForStartedUrl(() => stdout, () => child.exitCode, 60_000);
    const response = await fetch(`${url}/api/health`);
    if (!response.ok) {
      throw new Error(`SEA 服务冒烟失败：/api/health 返回 ${response.status}`);
    }
    const body = await response.json();
    return { url, ok: body.status === 'ok' };
  } finally {
    child.kill('SIGTERM');
    const code = await Promise.race([exited, delay(15_000).then(() => 'timeout')]);
    if (code === 'timeout') {
      child.kill('SIGKILL');
      throw new Error(`SEA 服务冒烟失败：SIGTERM 后未在 15 秒内退出\n${stderr}`);
    }
    if (code !== 0) {
      throw new Error(`SEA 服务冒烟失败：服务退出码 ${code}\n${stdout}\n${stderr}`);
    }
    if (stderr.includes('错误[')) {
      throw new Error(`SEA 服务冒烟失败：${stderr}`);
    }
  }
}

/**
 * 等待启动输出中出现 `已启动: http://host:port/api` 并返回基址。
 *
 * @param readStdout 读取当前 stdout 的函数
 * @param readExitCode 读取退出码的函数；非 null 表示进程已退出
 * @param timeoutMs 最长等待时间，单位毫秒
 * @returns 服务基址，如 `http://127.0.0.1:7860`
 */
async function waitForStartedUrl(readStdout, readExitCode, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = readStdout().match(/已启动:\s*(http:\/\/[^\s]+?)\/api/);
    if (match) return match[1];
    const code = readExitCode();
    if (code !== null) {
      throw new Error(`SEA 服务冒烟失败：服务提前退出（退出码 ${code}）\n${readStdout()}`);
    }
    await delay(200);
  }
  throw new Error(`SEA 服务冒烟失败：${timeoutMs / 1000} 秒内未输出启动地址\n${readStdout()}`);
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
  const result = spawnSync(executablePath, args, { env, encoding: 'utf8', timeout: 120_000 });
  if (result.error) {
    throw new Error(`无法运行 ${executablePath}：${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(
      `SEA 冒烟失败（参数：${args.join(' ')}，退出码：${result.status}）：${result.stderr ?? ''}`,
    );
  }
  if (expectedVersion && !result.stdout.includes(expectedVersion)) {
    throw new Error(`--version 输出不包含版本 ${expectedVersion}：${result.stdout.trim()}`);
  }
  return result;
}

/**
 * 等待指定毫秒数。
 *
 * @param ms 等待时间，单位毫秒
 * @returns 等待完成的 Promise
 */
function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
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
 * @param dependencyKeys 随包依赖文件键
 * @param smoke 冒烟结果
 * @param target 发布目标
 * @returns 输出完成的 Promise
 */
async function printSummary(executablePath, manifest, dependencyKeys, smoke, target) {
  const { size } = await stat(executablePath);
  const sizeMb = (size / 1024 / 1024).toFixed(1);
  console.log('');
  console.log('SEA 构建完成');
  console.log(`  目标：${target.key}（${target.platform}-${target.arch}）`);
  console.log(`  可执行文件：${executablePath}（${sizeMb} MB）`);
  console.log(
    `  canvas：${manifest.canvasVersion} / ${manifest.nativePackage} / ${manifest.nodeFile}`,
  );
  console.log(`  随包依赖：${dependencyKeys.length} 个文件（node_modules/*）`);
  console.log(`  冷启动（--version）：${smoke.coldStartMs} ms`);
  console.log(`  二次启动（--version）：${smoke.warmStartMs} ms`);
  console.log(`  服务冒烟：${smoke.health.url}/api/health ok=${smoke.health.ok}`);
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