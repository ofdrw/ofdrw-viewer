#!/usr/bin/env node
/**
 * 把 SEA 可执行文件打包成本平台离线发布产物。
 *
 * 产物：`out/release/ofdrw-viewer-api-server-<version>-<target>.tar.gz`
 * （Windows 为 `.zip`），同目录写 `<产物>.sha256`。压缩包内含可执行文件、
 * `api-server-config.yaml`、`README.md`、`LICENSE`、`docs/` 与 `skills/`，
 * 解压后无需 Node.js 与网络即可运行 `ofdrw-api-server`。
 *
 * 仅支持在当前平台打包当前平台产物；跨平台构建/打包请使用对应原生 runner。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 打包脚本所在目录。 */
const scriptDir = dirname(fileURLToPath(import.meta.url));

/** api-server 包根目录。 */
const serverDir = resolve(scriptDir, '..');

/** monorepo 根目录。 */
const repoDir = resolve(serverDir, '..', '..');

/** SEA 产物目录；与 scripts/build-sea.mjs 保持一致。 */
const seaDir = join(serverDir, 'out', 'sea');

/** 离线发布产物目录。 */
const releaseDir = join(serverDir, 'out', 'release');

/** 可执行文件名（不含扩展名）。 */
const EXECUTABLE_BASE_NAME = 'ofdrw-api-server';

/** 发布目标：平台、架构与产物后缀。 */
const TARGETS = {
  'linux-x64-gnu': { platform: 'linux', arch: 'x64' },
  'linux-arm64-gnu': { platform: 'linux', arch: 'arm64' },
  'darwin-x64': { platform: 'darwin', arch: 'x64' },
  'darwin-arm64': { platform: 'darwin', arch: 'arm64' },
  'win32-x64': { platform: 'win32', arch: 'x64' },
};

/**
 * 打包入口。
 *
 * @returns 打包完成的 Promise
 */
async function main() {
  const target = resolveTarget();
  const serverPackage = await readJson(join(serverDir, 'package.json'));
  const executableName = target.platform === 'win32' ? `${EXECUTABLE_BASE_NAME}.exe` : EXECUTABLE_BASE_NAME;
  const executablePath = join(seaDir, executableName);
  await assertExists(executablePath);

  const archiveExt = target.platform === 'win32' ? 'zip' : 'tar.gz';
  const name = `ofdrw-viewer-api-server-${serverPackage.version}-${target.key}`;
  const archivePath = join(releaseDir, `${name}.${archiveExt}`);
  const stageDir = join(releaseDir, name);

  await rm(stageDir, { recursive: true, force: true });
  await rm(archivePath, { force: true });
  await mkdir(stageDir, { recursive: true });
  await copyFile(executablePath, join(stageDir, executableName));
  await copyIfExists(join(serverDir, 'api-server-config.yaml'), join(stageDir, 'api-server-config.yaml'));
  await copyIfExists(join(serverDir, 'README.md'), join(stageDir, 'README.md'));
  await copyIfExists(join(repoDir, 'LICENSE'), join(stageDir, 'LICENSE'));
  for (const directory of ['docs', 'skills']) {
    await copyTree(join(serverDir, directory), join(stageDir, directory));
  }

  if (target.platform === 'win32') {
    await createZip(stageDir, archivePath);
  } else {
    await createTarGz(stageDir, archivePath);
  }

  const digest = await sha256(archivePath);
  const checksumPath = `${archivePath}.sha256`;
  await writeFile(checksumPath, `${digest}  ${basename(archivePath)}\n`, 'utf8');

  const { size } = await stat(archivePath);
  console.log('离线发布产物已生成');
  console.log(`  目标：${target.key}`);
  console.log(`  压缩包：${archivePath}（${(size / 1024 / 1024).toFixed(1)} MB）`);
  console.log(`  校验文件：${checksumPath}`);
}

/**
 * 解析 `--target`，未指定时使用当前平台。
 *
 * @returns 发布目标键与配置
 * @throws {Error} 目标未知、缺少参数或与当前平台不一致时抛出
 */
function resolveTarget() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const index = args.indexOf('--target');
  let key;

  if (index === -1) {
    const current = Object.entries(TARGETS).find(
      ([, target]) => target.platform === process.platform && target.arch === process.arch,
    );
    if (!current) {
      throw new Error(
        `当前平台 ${process.platform}-${process.arch} 不在发布矩阵内；支持：${Object.keys(TARGETS).join(', ')}`,
      );
    }
    key = current[0];
  } else {
    key = args[index + 1];
    if (!key || key.startsWith('--')) {
      throw new Error('--target 缺少目标值；示例：--target linux-x64-gnu');
    }
  }

  const target = TARGETS[key];
  if (!target) {
    throw new Error(`未知目标 ${key}；支持：${Object.keys(TARGETS).join(', ')}`);
  }
  if (target.platform !== process.platform || target.arch !== process.arch) {
    throw new Error(
      `不支持跨平台打包：目标 ${target.platform}-${target.arch}，当前 ${process.platform}-${process.arch}`,
    );
  }
  return { key, ...target };
}

/**
 * 创建 tar.gz。
 *
 * @param stageDir 待打包目录
 * @param archivePath 输出文件
 * @returns 打包完成的 Promise
 */
async function createTarGz(stageDir, archivePath) {
  const result = spawnSync('tar', ['-czf', archivePath, '-C', stageDir, '.'], {
    stdio: 'inherit',
  });
  if (result.error) {
    throw new Error(`无法执行 tar：${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(`tar 打包失败，退出码 ${result.status}`);
  }
}

/**
 * 创建 zip（Windows）。
 *
 * @param stageDir 待打包目录
 * @param archivePath 输出文件
 * @returns 打包完成的 Promise
 */
async function createZip(stageDir, archivePath) {
  const escapedStage = stageDir.replaceAll("'", "''");
  const escapedArchive = archivePath.replaceAll("'", "''");
  const command =
    `Compress-Archive -Path '${escapedStage}\\*' ` +
    `-DestinationPath '${escapedArchive}' -Force`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
    stdio: 'inherit',
  });
  if (result.error) {
    throw new Error(`无法执行 PowerShell Compress-Archive：${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(`Compress-Archive 打包失败，退出码 ${result.status}`);
  }
}

/**
 * 递归复制目录，忽略隐藏文件、`node_modules` 与 `dist`。
 *
 * @param source 源目录
 * @param target 目标目录
 * @returns 复制完成的 Promise
 */
async function copyTree(source, target) {
  try {
    await access(source);
  } catch {
    return;
  }
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
      continue;
    }
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await copyFile(from, to);
  }
}

/**
 * 计算文件 SHA-256。
 *
 * @param filePath 文件路径
 * @returns 十六进制摘要
 */
async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

/**
 * 复制存在的可选文件。
 *
 * @param source 源路径
 * @param target 目标路径
 * @returns 复制完成的 Promise
 */
async function copyIfExists(source, target) {
  try {
    await access(source);
    await copyFile(source, target);
  } catch {
    // 可选文件缺失时跳过，不阻断产物生成。
  }
}

/**
 * 断言文件存在。
 *
 * @param filePath 文件路径
 * @returns 存在时 resolve
 * @throws {Error} 文件不存在时抛出
 */
async function assertExists(filePath) {
  try {
    await access(filePath);
  } catch {
    throw new Error(`未找到 SEA 产物：${filePath}；请先执行 build:sea`);
  }
}

/**
 * 读取并解析 JSON。
 *
 * @param filePath JSON 路径
 * @returns 解析后的对象
 */
async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

main().catch((error) => {
  console.error(`打包失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});