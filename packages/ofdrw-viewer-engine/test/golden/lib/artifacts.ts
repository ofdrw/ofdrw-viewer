/**
 * 测试产物目录与路径工具。
 *
 * 产物统一写仓库根 `test/.artifacts/<task>/<timestamp>/`（已在 .gitignore 中忽略），
 * 避免并行任务互相覆盖；也可用环境变量 `GOLDEN_OUT_DIR` 指定固定目录。
 */

import { mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根绝对路径。 */
export const REPO_ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));

/** 产物根目录。 */
export const ARTIFACTS_ROOT = join(REPO_ROOT, 'test', '.artifacts');

/** 当前进程默认产物目录（懒创建）。 */
let defaultArtifactsDir: string | null = null;

/**
 * 生成时间戳目录名（本地时区），格式 `YYYYMMDD-HHmmss-SSS`。
 *
 * @param date 时间；默认当前时间。
 * @returns 目录名。
 */
export function timestampSlug(date: Date = new Date()): string {
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `-${pad(date.getMilliseconds(), 3)}`
  );
}

/**
 * 创建并返回本次运行的产物目录。
 *
 * 优先级：显式参数 > 环境变量 `GOLDEN_OUT_DIR` > `test/.artifacts/<task>/<timestamp>`。
 *
 * @param task 任务名（目录层级），默认 `golden`。
 * @param explicit 显式目录（相对路径按仓库根解析）。
 * @returns 产物目录绝对路径。
 */
export function resolveArtifactsDir(task = 'golden', explicit?: string): string {
  const fromEnv = process.env.GOLDEN_OUT_DIR;
  if (explicit) {
    mkdirSync(explicit, { recursive: true });
    return explicit;
  }
  if (fromEnv && fromEnv.length > 0) {
    const target = resolve(REPO_ROOT, fromEnv);
    mkdirSync(target, { recursive: true });
    return target;
  }
  // 同一测试进程内复用同一目录，避免每个测试文件各建一个时间戳目录。
  if (!defaultArtifactsDir) {
    defaultArtifactsDir = join(ARTIFACTS_ROOT, task, timestampSlug());
  }
  mkdirSync(defaultArtifactsDir, { recursive: true });
  return defaultArtifactsDir;
}

/**
 * 确保文件所在目录存在。
 *
 * @param filePath 文件绝对路径。
 */
export function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

/**
 * 计算相对仓库根的 POSIX 路径（用于报告）。
 *
 * @param absolutePath 绝对路径。
 * @returns 仓库相对路径；不在仓库内时返回原路径。
 */
export function repoRelative(absolutePath: string): string {
  const rel = relative(REPO_ROOT, absolutePath);
  if (rel.startsWith('..')) return absolutePath;
  return rel.split(sep).join('/');
}