/**
 * 日志：pino 分级输出到 stdout 与按天轮转的文件。
 *
 * 文件名 `api-server.<YYYY-MM-DD>.<序号>.log`；启动时删除修改时间早于
 * `keepDays` 的文件；POSIX 下目录 `0700`、文件 `0640`。
 */

import { chmod, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import pino from 'pino';
import type { Logger } from 'pino';
import roll from 'pino-roll';
import type { ApiServerConfig } from './config.js';

/** 日志文件名前缀。 */
const LOG_BASENAME = 'api-server';

/** 本服务日志文件的匹配规则。 */
const LOG_FILE_PATTERN = /^api-server\..+\.log$/u;

/** 创建日志器。 */
export interface ServerLogger {
  /** pino 实例。 */
  readonly logger: Logger;
  /** 文件轮转流；不可用时为 undefined。 */
  readonly stream: { end(callback?: () => void): unknown } | undefined;
  /** 关闭文件流。 */
  close(): Promise<void>;
}

/**
 * 删除超期日志文件。
 *
 * 只处理本服务命名规则的文件，其他文件不动。
 *
 * @param dir 日志目录
 * @param keepDays 保留天数，单位天
 * @returns 删除的文件数
 */
export async function purgeOldLogs(dir: string, keepDays: number): Promise<number> {
  const cutoff = Date.now() - keepDays * 86_400_000;
  const entries = await readdir(dir).catch(() => [] as string[]);
  let removed = 0;
  for (const name of entries) {
    if (!LOG_FILE_PATTERN.test(name)) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => undefined);
    if (info === undefined || info.mtimeMs >= cutoff) continue;
    await rm(path, { force: true });
    removed += 1;
  }
  return removed;
}

/**
 * 创建日志目录并修正权限。
 *
 * @param dir 日志目录
 */
export async function prepareLogDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dir, 0o700).catch(() => undefined);
}

/**
 * 创建服务器日志器。
 *
 * 文件输出写 JSON 行，stdout 同时输出人类可读版本。
 *
 * @param config 生效配置
 * @returns 日志器与关闭钩子
 */
export async function createLogger(config: ApiServerConfig): Promise<ServerLogger> {
  const { level, dir, keepDays } = config.logging;
  await prepareLogDir(dir);
  await purgeOldLogs(dir, keepDays);

  const destinations: pino.DestinationStream[] = [pino.destination(1)];
  let stream: Awaited<ReturnType<typeof roll>> | undefined;
  try {
    stream = await roll({
      file: join(dir, LOG_BASENAME),
      frequency: 'daily',
      dateFormat: 'yyyy-MM-dd',
      extension: 'log',
      limit: { count: keepDays },
      mkdir: true,
      mode: 0o640,
    });
    destinations.push(stream);
  } catch {
    process.stderr.write(`警告 [W_LOG_FILE]：无法写入日志目录 ${dir}，仅输出到 stdout\n`);
  }

  const logger = pino(
    {
      level,
      base: { pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(destinations.map((destination) => ({ stream: destination }))),
  );

  return {
    logger,
    stream,
    async close(): Promise<void> {
      if (stream === undefined) return;
      await new Promise<void>((resolve) => {
        stream.end(() => resolve());
      });
    },
  };
}