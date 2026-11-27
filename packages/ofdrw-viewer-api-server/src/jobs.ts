/**
 * 作业管理：创建、排队执行、进度持久化、取消、过期清理与重启恢复。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { openDocumentFromBytes, runJob } from './engine/index.js';
import type { FontFile, JobOp } from './engine/index.js';
import { ApiError } from './errors.js';
import type { JobParams } from './jobs-types.js';
import {
  acquireLock,
  createJobId,
  isJobId,
  isProcessAlive,
  isSafeFileName,
  jobPaths,
  listJobDirs,
  moveToTrash,
  purgeTransient,
  readMeta,
  releaseLock,
  workDirSize,
  writeAtomic,
  writeMeta,
} from './store.js';
import type { JobFileEntry, JobMeta, JobStatus } from './store.js';

/** 作业管理选项。 */
export interface JobManagerOptions {
  /** 作业根目录绝对路径。 */
  readonly workDir: string;
  /** 单作业超时，单位秒；`0` 表示不限制。 */
  readonly timeoutSec: number;
  /** 默认有效期，单位秒。 */
  readonly defaultTtlSec: number;
  /** 同时执行的作业数上限，单位个；`0` 表示不限制。 */
  readonly maxConcurrentJobs: number;
  /** 作业根目录占用上限，单位 byte；`0` 表示不限制。 */
  readonly maxTotalBytes: number;
  /** 单作业页数上限。 */
  readonly maxJobPages: number;
  /** 作业默认字体。 */
  readonly fontFiles: readonly FontFile[];
  /** 日志器。 */
  readonly logger: Logger;
}

/** 创建作业的输入。 */
export interface CreateJobInput {
  /** 原文档文件名。 */
  readonly fileName: string;
  /** 原文档字节。 */
  readonly data: Uint8Array;
  /** 归一化后的作业参数。 */
  readonly params: JobParams;
}

/** 运行中的作业上下文。 */
interface RunningJob {
  /** 取消控制器。 */
  readonly controller: AbortController;
}

/** 作业管理器。 */
export class JobManager {
  readonly #options: JobManagerOptions;
  readonly #running = new Map<string, RunningJob>();
  readonly #queue: Array<{ id: string; meta: JobMeta }> = [];
  #activeCount = 0;
  #timer: NodeJS.Timeout | undefined;
  #closed = false;

  /** @param options 作业管理选项 */
  constructor(options: JobManagerOptions) {
    this.#options = options;
  }

  /** 作业根目录。 */
  get workDir(): string {
    return this.#options.workDir;
  }

  /**
   * 启动管理器：加锁、恢复既有作业、开始巡检。
   *
   * @returns 启动完成的 Promise
   */
  async start(): Promise<void> {
    const { workDir, logger } = this.#options;
    await mkdir(workDir, { recursive: true });
    await acquireLock(workDir);
    await purgeTransient(workDir, 0);
    await this.#recover();
    this.#timer = setInterval(() => {
      void this.#sweep();
    }, 10_000);
    this.#timer.unref();
    logger.info({ workDir }, '作业管理器已启动');
  }

  /**
   * 恢复既有作业：损坏目录删除、失效运行态置为 interrupted、过期目录删除。
   *
   * @returns 恢复完成的 Promise
   */
  async #recover(): Promise<void> {
    const { workDir, logger } = this.#options;
    for (const id of await listJobDirs(workDir)) {
      const paths = jobPaths(workDir, id);
      const meta = await readMeta(paths.meta);
      if (meta === undefined) {
        logger.warn({ jobId: id }, '作业元信息缺失或损坏，移入回收站');
        await moveToTrash(workDir, id);
        continue;
      }
      if (this.#isExpired(meta)) {
        await moveToTrash(workDir, id);
        continue;
      }
      if (meta.status === 'queued' || meta.status === 'running') {
        const alive = meta.owner.pid === process.pid || isProcessAlive(meta.owner.pid);
        if (!alive || meta.owner.hostname !== hostname()) {
          await this.#finish(id, meta, 'interrupted', {
            code: 'CLI_JOB_INTERRUPTED',
            message: '服务重启时作业未完成',
          });
          logger.warn({ jobId: id }, '作业因服务重启被标记为 interrupted');
        }
      }
    }
  }

  /**
   * 判断作业是否已过期。
   *
   * @param meta 作业元信息
   * @returns 已过期时为 true
   */
  #isExpired(meta: JobMeta): boolean {
    if (meta.expiresAt === null) return false;
    return Date.parse(meta.expiresAt) <= Date.now();
  }

  /**
   * 创建并排队作业。
   *
   * @param input 原文档与参数
   * @returns 作业元信息
   * @throws {ApiError} 页数超限或存储已满时
   */
  async create(input: CreateJobInput): Promise<JobMeta> {
    const { workDir, maxJobPages, maxTotalBytes, logger } = this.#options;
    const pages = input.params.pages;
    if (pages !== undefined && pages.length > maxJobPages) {
      throw new ApiError(
        'CLI_JOB_TOO_MANY_PAGES',
        `作业页数 ${pages.length} 超过上限 ${maxJobPages}`,
      );
    }
    if (maxTotalBytes > 0) {
      const used = await workDirSize(workDir);
      if (used + input.data.byteLength > maxTotalBytes) {
        throw new ApiError(
          'CLI_JOB_STORAGE_FULL',
          `作业目录已用 ${used} byte，新增作业将超过上限 ${maxTotalBytes} byte`,
        );
      }
    }

    // 先用内存打开确认页数与页码范围，避免创建后才失败。
    const opened = await openDocumentFromBytes({
      data: input.data,
      fontFiles: this.#options.fontFiles,
    });
    try {
      if (pages !== undefined && pages.some((page) => page > opened.pageCount)) {
        const out = pages.filter((page) => page > opened.pageCount);
        throw new ApiError(
          'CLI_INVALID_PAGES',
          `页码越界：${out.join(', ')}（文档共 ${opened.pageCount} 页）`,
        );
      }
      if (pages === undefined && opened.pageCount > maxJobPages) {
        throw new ApiError(
          'CLI_JOB_TOO_MANY_PAGES',
          `文档页数 ${opened.pageCount} 超过上限 ${maxJobPages}`,
        );
      }
    } finally {
      await opened.close();
    }

    const id = await this.#allocateId();
    const paths = jobPaths(workDir, id);
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.source, input.data);

    const now = new Date().toISOString();
    const meta: JobMeta = {
      id,
      status: 'queued',
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      ttlSec: input.params.ttlSec,
      expiresAt: null,
      owner: { pid: process.pid, hostname: hostname() },
      params: {
        ops: input.params.ops,
        pages: input.params.pages === undefined ? null : [...input.params.pages],
        dpi: input.params.dpi,
        format: input.params.format,
        quality: input.params.quality,
        ...(input.params.mediaKind === undefined ? {} : { mediaKind: input.params.mediaKind }),
        ...(input.params.mediaId === undefined ? {} : { mediaId: input.params.mediaId }),
        ttlSec: input.params.ttlSec,
      },
      source: {
        name: input.fileName,
        sizeBytes: input.data.byteLength,
        sha256: createHash('sha256').update(input.data).digest('hex'),
      },
      progress: { done: 0, total: 0, page: 0 },
      files: [],
      failures: [],
      error: null,
    };
    await writeMeta(paths.meta, meta);
    this.#queue.push({ id, meta });
    logger.info({ jobId: id, ops: input.params.ops }, '作业已创建');
    this.#drain();
    return meta;
  }

  /**
   * 分配未占用的作业 ID。
   *
   * @returns 作业 ID
   */
  async #allocateId(): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const id = createJobId();
      const existing = await readMeta(jobPaths(this.#options.workDir, id).meta);
      if (existing === undefined) return id;
    }
    throw new ApiError('CLI_UNEXPECTED', '无法分配作业 ID');
  }

  /**
   * 启动排队中的作业：未设上限时全部启动，设了上限则只启动到互不超限为止。
   */
  #drain(): void {
    const { maxConcurrentJobs } = this.#options;
    while (
      !this.#closed
      && (maxConcurrentJobs === 0 || this.#activeCount < maxConcurrentJobs)
    ) {
      const next = this.#queue.shift();
      if (next === undefined) return;
      this.#activeCount += 1;
      void this.#execute(next.id, next.meta).finally(() => {
        this.#activeCount -= 1;
        this.#drain();
      });
    }
  }

  /**
   * 执行单个作业。
   *
   * @param id 作业 ID
   * @param meta 初始元信息
   */
  async #execute(id: string, meta: JobMeta): Promise<void> {
    const { workDir, timeoutSec, logger } = this.#options;
    const paths = jobPaths(workDir, id);
    const controller = new AbortController();
    this.#running.set(id, { controller });
    const timeout =
      timeoutSec > 0
        ? setTimeout(() => controller.abort(new Error('job timeout')), timeoutSec * 1000)
        : undefined;

    let current: JobMeta = {
      ...meta,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    await writeMeta(paths.meta, current);
    logger.info({ jobId: id }, '作业开始执行');

    try {
      const params = current.params as {
        ops: JobOp[];
        dpi: number;
        format: 'png' | 'jpeg' | 'webp';
        quality: number;
        mediaKind?: 'video' | 'audio';
        mediaId?: string;
        pages: number[] | null;
      };
      const pageList = params.pages === null ? undefined : params.pages;

      await runJob(
        {
          sourcePath: paths.source,
          outDir: paths.dir,
          fonts: this.#options.fontFiles,
          params: {
            ops: params.ops,
            ...(pageList === undefined ? {} : { pages: pageList }),
            dpi: params.dpi,
            format: params.format,
            quality: params.quality,
            ...(params.mediaKind === undefined ? {} : { mediaKind: params.mediaKind }),
            ...(params.mediaId === undefined ? {} : { mediaId: params.mediaId }),
          },
        },
        {
          signal: controller.signal,
          onProgress: async (progress) => {
            current = { ...current, progress };
            await writeMeta(paths.meta, current);
          },
          onFile: async (name, kind, size) => {
            current = {
              ...current,
              files: [...current.files, { name, kind, size } as JobFileEntry],
            };
            await writeMeta(paths.meta, current);
          },
          onFailure: async (failure) => {
            current = {
              ...current,
              failures: [...current.failures, failure],
            };
            await writeMeta(paths.meta, current);
          },
        },
      );
      await this.#finish(id, current, 'done', null);
    } catch (error) {
      const aborted = controller.signal.aborted;
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code: unknown }).code)
          : 'CLI_UNEXPECTED';
      const message = error instanceof Error ? error.message : String(error);
      if (aborted && timeout === undefined) {
        await this.#finish(id, current, 'cancelled', { code: 'CLI_JOB_CANCELLED', message: '作业已取消' });
      } else if (aborted) {
        await this.#finish(id, current, 'failed', { code: 'CLI_JOB_TIMEOUT', message: `作业超时（${timeoutSec}s）` });
      } else {
        logger.error({ jobId: id, code, message }, '作业执行失败');
        await this.#finish(id, current, 'failed', { code, message });
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      this.#running.delete(id);
    }
  }

  /**
   * 结束作业并写入终态。
   *
   * @param id 作业 ID
   * @param meta 当前元信息
   * @param status 终态
   * @param error 终止错误；成功时为 null
   */
  async #finish(
    id: string,
    meta: JobMeta,
    status: JobStatus,
    error: { code: string; message: string } | null,
  ): Promise<void> {
    const paths = jobPaths(this.#options.workDir, id);
    const finishedAt = new Date().toISOString();
    const expiresAt =
      meta.ttlSec < 0
        ? null
        : new Date(Date.parse(finishedAt) + meta.ttlSec * 1000).toISOString();
    const next: JobMeta = { ...meta, status, finishedAt, expiresAt, error };
    await writeMeta(paths.meta, next);
    this.#options.logger.info({ jobId: id, status }, '作业结束');
  }

  /**
   * 读取作业元信息。
   *
   * @param id 作业 ID
   * @returns 元信息
   * @throws {ApiError} ID 非法、作业不存在或已过期时
   */
  async requireMeta(id: string): Promise<JobMeta> {
    if (!isJobId(id)) throw new ApiError('CLI_JOB_NOT_FOUND', `作业不存在：${id}`);
    const paths = jobPaths(this.#options.workDir, id);
    const meta = await readMeta(paths.meta);
    if (meta === undefined) throw new ApiError('CLI_JOB_NOT_FOUND', `作业不存在：${id}`);
    if (this.#isExpired(meta)) throw new ApiError('CLI_JOB_EXPIRED', `作业已过期：${id}`);
    return meta;
  }

  /**
   * 列出作业。
   *
   * @param query 过滤条件
   * @returns 按创建时间倒序的摘要数组
   */
  async list(query: { limit?: number; status?: readonly string[] }): Promise<
    Array<{ id: string; status: JobStatus; createdAt: string; fileCount: number; progress: JobMeta['progress'] }>
  > {
    const { workDir } = this.#options;
    const result: Array<{
      id: string;
      status: JobStatus;
      createdAt: string;
      fileCount: number;
      progress: JobMeta['progress'];
    }> = [];
    for (const id of await listJobDirs(workDir)) {
      const meta = await readMeta(jobPaths(workDir, id).meta);
      if (meta === undefined || this.#isExpired(meta)) continue;
      if (query.status !== undefined && !query.status.includes(meta.status)) continue;
      result.push({
        id: meta.id,
        status: meta.status,
        createdAt: meta.createdAt,
        fileCount: meta.files.length,
        progress: meta.progress,
      });
    }
    result.sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
    return query.limit === undefined ? result : result.slice(0, query.limit);
  }

  /**
   * 获取作业产物文件路径。
   *
   * @param id 作业 ID
   * @param name 文件名
   * @returns 绝对路径
   * @throws {ApiError} 文件不存在时
   */
  async requireFilePath(id: string, name: string): Promise<string> {
    if (!isSafeFileName(name)) {
      throw new ApiError('CLI_JOB_NOT_FOUND', `文件名非法：${name}`);
    }
    const meta = await this.requireMeta(id);
    if (!meta.files.some((file) => file.name === name)) {
      throw new ApiError('CLI_JOB_NOT_FOUND', `作业中没有文件：${name}`);
    }
    const path = join(jobPaths(this.#options.workDir, id).dir, name);
    try {
      await readFile(path);
    } catch {
      throw new ApiError('CLI_JOB_NOT_FOUND', `文件已不存在：${name}`);
    }
    return path;
  }

  /**
   * 取消并删除作业。
   *
   * @param id 作业 ID
   * @returns 删除完成的 Promise
   */
  async remove(id: string): Promise<void> {
    const meta = await this.requireMeta(id);
    const running = this.#running.get(id);
    if (running !== undefined) {
      running.controller.abort();
      this.#running.delete(id);
    }
    await rm(jobPaths(this.#options.workDir, id).result, { force: true });
    await moveToTrash(this.#options.workDir, id);
    this.#options.logger.info({ jobId: id, status: meta.status }, '作业已删除');
  }

  /**
   * 巡检过期作业与存储上限。
   */
  async #sweep(): Promise<void> {
    if (this.#closed) return;
    const { workDir, maxTotalBytes, logger } = this.#options;
    await purgeTransient(workDir, 3_600_000);
    for (const id of await listJobDirs(workDir)) {
      const meta = await readMeta(jobPaths(workDir, id).meta);
      if (meta === undefined) {
        await moveToTrash(workDir, id);
        continue;
      }
      if (this.#isExpired(meta)) {
        await moveToTrash(workDir, id);
        logger.info({ jobId: id }, '作业过期已删除');
      }
    }
    if (maxTotalBytes > 0) {
      let used = await workDirSize(workDir);
      if (used <= maxTotalBytes) return;
      const candidates: Array<{ id: string; createdAt: string }> = [];
      for (const id of await listJobDirs(workDir)) {
        const meta = await readMeta(jobPaths(workDir, id).meta);
        if (meta !== undefined && meta.status !== 'running' && meta.status !== 'queued') {
          candidates.push({ id, createdAt: meta.createdAt });
        }
      }
      candidates.sort((left, right) => (left.createdAt < right.createdAt ? -1 : 1));
      for (const candidate of candidates) {
        if (used <= maxTotalBytes) break;
        const size = await import('./store.js').then((mod) => mod.directorySize(jobPaths(workDir, candidate.id).dir));
        await moveToTrash(workDir, candidate.id);
        used -= size;
        logger.warn({ jobId: candidate.id }, '作业目录超出上限，已删除最旧作业');
      }
    }
  }

  /**
   * 返回作业统计。
   *
   * @returns 各状态计数
   */
  async stats(): Promise<{ queued: number; running: number; total: number }> {
    const all = await this.list({});
    return {
      queued: all.filter((job) => job.status === 'queued').length,
      running: all.filter((job) => job.status === 'running').length,
      total: all.length,
    };
  }

  /**
   * 关闭管理器：中止运行中的作业并释放锁。
   */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    for (const [, running] of this.#running) running.controller.abort();
    this.#running.clear();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await releaseLock(this.#options.workDir);
    this.#options.logger.info('作业管理器已关闭');
  }

  /**
   * 写入临时文件并返回路径，供同步接口短暂使用。
   *
   * @param bytes 文件字节
   * @param suffix 文件名后缀
   * @returns 临时文件绝对路径
   */
  async writeTemp(bytes: Uint8Array, suffix = '.ofd'): Promise<string> {
    const dir = join(this.#options.workDir, '.tmp');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `sync-${Date.now()}-${Math.random().toString(16).slice(2)}${suffix}`);
    await writeAtomic(path, bytes);
    return path;
  }
}