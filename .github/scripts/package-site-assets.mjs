#!/usr/bin/env node
/**
 * 把演示站构建产物打成发布附件压缩包。
 *
 * 产物：`release-assets/ofdrw-viewer-ui-demo-<version>.zip`，压缩包内为站点根目录内容
 * （`index.html`、`assets/`、`samples/` 等），解压后直接作为静态站点根目录托管。
 *
 * 前置条件：已执行 `BASE_PATH=/ pnpm -C site build`（默认站点基路径为根路径），
 * 且 engine → crypto → ui 已按拓扑顺序构建。
 */

import { spawnSync } from 'node:child_process';
import { access, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录（脚本位于 `.github/scripts/`）。 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 站点构建输出目录（相对仓库根）。 */
const SITE_DIST = 'site-dist';

/** 发布附件压缩包的文件名前缀，压缩包内顶层目录同名。 */
const ARCHIVE_STEM = 'ofdrw-viewer-ui-demo';

/** 压缩包内必须存在的文件，用于确认构建产物完整。 */
const REQUIRED_FILES = ['index.html'];

/**
 * 读取 engine 包版本号，作为发布附件版本。
 *
 * @returns {Promise<string>} 版本号
 */
async function readVersion() {
  const raw = await readFile(join(REPO_ROOT, 'packages', 'ofdrw-viewer-engine', 'package.json'), 'utf8');
  return JSON.parse(raw).version;
}

/**
 * 确认站点构建产物存在且完整。
 *
 * @returns {Promise<void>}
 */
async function assertArtifacts() {
  const missing = [];
  for (const file of REQUIRED_FILES) {
    try {
      await access(join(REPO_ROOT, SITE_DIST, file));
    } catch {
      missing.push(`${SITE_DIST}/${file}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`缺少演示站构建产物，请先执行 BASE_PATH=/ pnpm -C site build：\n${missing.join('\n')}`);
  }
}

/**
 * 把站点产物复制成压缩包内的顶级目录，避免解压时文件散落到当前目录。
 *
 * @param {string} stagingDir 压缩包内顶层目录的绝对路径
 * @returns {Promise<void>}
 */
async function stageSite(stagingDir) {
  await cp(join(REPO_ROOT, SITE_DIST), stagingDir, { recursive: true });
}

/**
 * 调用系统 zip 命令打包。
 *
 * @param {string} archivePath 输出压缩包绝对路径
 * @param {string} stagingRoot 包含顶层目录的暂存目录绝对路径
 * @param {string} topDir 压缩包内顶层目录名
 * @returns {void}
 */
function createZip(archivePath, stagingRoot, topDir) {
  const result = spawnSync('zip', ['-9', '-r', '-q', archivePath, topDir], {
    cwd: stagingRoot,
    stdio: 'inherit',
  });
  if (result.error) {
    throw new Error(`调用 zip 失败：${result.error.message}；请确认 runner 已安装 zip`);
  }
  if (result.status !== 0) {
    throw new Error(`zip 打包失败，退出码 ${result.status}`);
  }
}

/**
 * 打包入口。
 *
 * @returns {Promise<void>}
 */
async function main() {
  await assertArtifacts();
  const version = await readVersion();
  const releaseDir = join(REPO_ROOT, 'release-assets');
  const archiveName = `${ARCHIVE_STEM}-${version}`;
  const archivePath = join(releaseDir, `${archiveName}.zip`);
  const topDir = archiveName;
  const stagingRoot = join(REPO_ROOT, '.site-package');
  const stagingDir = join(stagingRoot, topDir);

  await mkdir(releaseDir, { recursive: true });
  await rm(archivePath, { force: true });
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  try {
    await stageSite(stagingDir);
    createZip(archivePath, stagingRoot, topDir);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }

  console.log(`演示站产物已生成：release-assets/${archiveName}.zip`);
}

main().catch((error) => {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
