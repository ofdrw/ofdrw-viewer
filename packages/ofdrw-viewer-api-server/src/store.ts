/**
 * 作业目录存储：`meta.json` 原子读写、锁文件、目录清理。
 */

import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 作业状态。 */
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

/** `meta.json` 中的文件条目。 */
export interface JobFileEntry {
  /** 文件名，如 `p001.png`。 */
  readonly name: string;
  /** 产物类别。 */
  readonly kind: 'image' | 'text' | 'media' | 'attachment';
  /** 文件大小，单位 byte。 */
  readonly size: number;
}

/** `meta.json` 中的失败项。 */
export interface JobFailure {
  /** 页号，1 起；非页级失败为 0。 */
  readonly page: number;
  /** 错误码。 */
  readonly code: string;
  /** 错误说明。 */
  readonly message: string;
}

/** 作业元信息。 */
export interface JobMeta {
  /** 作业 ID。 */
  readonly id: string;
  /** 状态。 */
  readonly status: JobStatus;
  /** 创建时间，ISO 8601。 */
  readonly createdAt: string;
  /** 开始执行时间，ISO 8601。 */
  readonly startedAt: string | null;
  /** 结束时间，ISO 8601。 */
  readonly finishedAt: string | null;
  /** 有效期秒数；`-1` 表示永不过期。 */
  readonly ttlSec: number;
  /** 过期时间，ISO 8601；永不过期时为 null。 */
  readonly expiresAt: string | null;
  /** 创建进程信息。 */
  readonly owner: { readonly pid: number; readonly hostname: string };
  /** 请求参数。 */
  readonly params: Record<string, unknown>;
  /** 原文档信息。 */
  readonly source: { readonly name: string; readonly sizeBytes: number; readonly sha256: string };
  /** 进度。 */
  readonly progress: { readonly done: number; readonly total: number; readonly page: number };
  /** 已产出文件。 */
  readonly files: readonly JobFileEntry[];
  /** 失败项。 */
  readonly failures: readonly JobFailure[];
  /** 终止错误；未失败时为 null。 */
  readonly error: { readonly code: string; readonly message: string } | null;
}

/** 作业目录内的相对路径集合。 */
export interface JobPaths {
  /** 作业目录。 */
  readonly dir: string;
  /** 元信息文件。 */
  readonly meta: string;
  /** 原始文档。 */
  readonly source: string;
  /** 结果压缩包。 */
  readonly result: string;
}

/** 作业 ID 规则：`<YYYYMMDDHHmm>N<6 位数字>`。 */
const JOB_ID_PATTERN = /^\d{12}N\d{6}$/u;

/** 产物文件名白名单：字母数字、点、连字符、下划线。 */
const SAFE_FILE_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

/**
 * 生成作业 ID。
 *
 * @param now 当前时间
 * @returns 形如 `202611261530N482913` 的 ID
 */
export function createJobId(now: Date = new Date()): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}`;
  const random = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0');
  return `${stamp}N${random}`;
}

/**
 * 判断字符串是否为合法作业 ID。
 *
 * @param value 待判断值
 * @returns 合法时为 true
 */
export function isJobId(value: string): boolean {
  return JOB_ID_PATTERN.test(value);
}

/**
 * 判断字符串是否为可安全使用的产物文件名。
 *
 * 拒绝 `..`、路径分隔符与非法字符。
 *
 * @param value 待判断值
 * @returns 安全时为 true
 */
export function isSafeFileName(value: string): boolean {
  if (!SAFE_FILE_PATTERN.test(value)) return false;
  return !value.includes('..') && value !== '.' && value !== '..';
}

/**
 * 计算作业目录内的路径。
 *
 * @param workDir 作业根目录
 * @param id 作业 ID
 * @returns 目录与关键文件路径
 */
export function jobPaths(workDir: string, id: string): JobPaths {
  const dir = join(workDir, id);
  return {
    dir,
    meta: join(dir, 'meta.json'),
    source: join(dir, 'source.ofd'),
    result: join(dir, 'result.zip'),
  };
}

/**
 * 原子写入文件：先写同目录临时文件，`fsync` 后 `rename`。
 *
 * @param filePath 目标路径
 * @param data 内容
 */
export async function writeAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  const temp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await writeFile(temp, data);
  await rename(temp, filePath);
}

/**
 * 写入 `meta.json`。
 *
 * @param metaPath 元信息文件路径
 * @param meta 元信息
 */
export async function writeMeta(metaPath: string, meta: JobMeta): Promise<void> {
  await writeAtomic(metaPath, JSON.stringify(meta, null, 2));
}

/**
 * 读取 `meta.json`。
 *
 * @param metaPath 元信息文件路径
 * @returns 元信息；文件缺失或损坏时为 `undefined`
 */
export async function readMeta(metaPath: string): Promise<JobMeta | undefined> {
  try {
    const text = await readFile(metaPath, 'utf8');
    return JSON.parse(text) as JobMeta;
  } catch {
    return undefined;
  }
}

/**
 * 列出作业根目录下的作业目录名。
 *
 * @param workDir 作业根目录
 * @returns 合法作业 ID 列表
 */
export async function listJobDirs(workDir: string): Promise<string[]> {
  try {
    const entries = await readdir(workDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && isJobId(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 把作业目录移动到 `.trash/` 后删除。
 *
 * @param workDir 作业根目录
 * @param id 作业 ID
 */
export async function moveToTrash(workDir: string, id: string): Promise<void> {
  const trashDir = join(workDir, '.trash');
  await mkdir(trashDir, { recursive: true });
  const target = join(trashDir, `${id}-${randomBytes(3).toString('hex')}`);
  try {
    await rename(join(workDir, id), target);
  } catch {
    return;
  }
  await rm(target, { recursive: true, force: true });
}

/**
 * 获取单个作业目录的占用大小。
 *
 * @param dir 作业目录
 * @returns 字节数；目录不可读时为 0
 */
export async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(path);
    } else {
      const info = await stat(path).catch(() => undefined);
      total += info?.size ?? 0;
    }
  }
  return total;
}

/**
 * 获取作业根目录的总占用。
 *
 * @param workDir 作业根目录
 * @returns 字节数
 */
export async function workDirSize(workDir: string): Promise<number> {
  return directorySize(workDir);
}

/**
 * 判断进程是否存活。
 *
 * @param pid 进程号
 * @returns 存活时为 true
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

/**
 * 获取单实例锁。
 *
 * @param workDir 作业根目录
 * @throws Error 锁被存活进程持有时（错误码 `CLI_SERVER_LOCKED`）
 */
export async function acquireLock(workDir: string): Promise<void> {
  const lockPath = join(workDir, '.lock');
  const existing = await readFile(lockPath, 'utf8').catch(() => undefined);
  if (existing !== undefined) {
    try {
      const parsed = JSON.parse(existing) as { pid?: number };
      if (typeof parsed.pid === 'number' && parsed.pid !== process.pid && isProcessAlive(parsed.pid)) {
        const error = new Error(`作业目录已被进程 ${parsed.pid} 使用：${workDir}`);
        (error as { code?: string }).code = 'CLI_SERVER_LOCKED';
        throw error;
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'CLI_SERVER_LOCKED') throw error;
    }
  }
  await writeAtomic(
    lockPath,
    JSON.stringify({ pid: process.pid, hostname: process.env.HOSTNAME ?? '', startedAt: new Date().toISOString() }),
  );
}

/**
 * 释放单实例锁。
 *
 * @param workDir 作业根目录
 */
export async function releaseLock(workDir: string): Promise<void> {
  await rm(join(workDir, '.lock'), { force: true });
}

/**
 * 清理 `.tmp/` 与 `.trash/` 下的残留。
 *
 * @param workDir 作业根目录
 * @param maxAgeMs 保留时长，单位毫秒；`0` 表示全部删除
 */
export async function purgeTransient(workDir: string, maxAgeMs: number): Promise<void> {
  const now = Date.now();
  for (const name of ['.tmp', '.trash']) {
    const dir = join(workDir, name);
    const entries = await readdir(dir).catch(() => [] as string[]);
    for (const entry of entries) {
      const path = join(dir, entry);
      if (maxAgeMs > 0) {
        const info = await stat(path).catch(() => undefined);
        if (info !== undefined && now - info.mtimeMs < maxAgeMs) continue;
      }
      await rm(path, { recursive: true, force: true });
    }
  }
}

/**
 * 创建空文件句柄用于确认目录可写。
 *
 * @param dir 目录
 */
export async function ensureWritableDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const probe = join(dir, '.write-probe');
  const handle = await open(probe, 'w');
  await handle.close();
  await rm(probe, { force: true });
}

/**
 * 以追加模式打开文件流。
 *
 * @param filePath 文件路径
 * @returns 可写流
 */
export function openAppendStream(filePath: string): ReturnType<typeof createWriteStream> {
  return createWriteStream(filePath, { flags: 'a' });
}