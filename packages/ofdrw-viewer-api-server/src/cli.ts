/**
 * 子命令入口：解析 `--workdir` / `--config` / `-t`，加载配置并启动或校验服务。
 *
 * 退出码：0 成功；1 用法或配置错误；2 启动失败（端口占用、作业目录被锁等）。
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as sea from 'node:sea';
import {
  CONFIG_FILE_NAME,
  checkDirectories,
  describeConfig,
  generateDefaultConfig,
  loadConfig,
} from './config.js';
import { ApiError, toErrorBody } from './errors.js';
import { createLogger } from './logger.js';
import { startApiServer } from './server.js';
import { VERSION } from './version.js';

/** 用法说明。 */
const USAGE = `用法: ofdrw-api-server [--workdir <dir>] [--config <file>] [-t]

  --workdir <dir>   指定工作区根；省略时取配置文件的 workspace，
                    再省略取配置文件所在目录或进程工作目录
  --config <file>   指定配置文件；省略时依次查找工作区根与可执行文件同目录
  -t, --test-config 只校验配置，不启动服务
  -h, --help        显示本帮助
  -V, --version     显示版本`;

/**
 * 解析子命令参数。
 *
 * @param argv 参数数组
 * @returns 工作区根、配置路径与是否仅校验
 * @throws {ApiError} 未知参数或缺少取值时
 */
function parseArgs(argv: readonly string[]): {
  workDir?: string;
  configPath?: string;
  testOnly: boolean;
} {
  let workDir: string | undefined;
  let configPath: string | undefined;
  let testOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--workdir' || arg === '--config') {
      const next = argv[index + 1];
      if (next === undefined) throw new ApiError('CLI_USAGE', `${arg} 需要目录或文件名`, 1);
      if (arg === '--workdir') workDir = next;
      else configPath = next;
      index += 1;
      continue;
    }
    if (arg === '-t' || arg === '--test-config') {
      testOnly = true;
      continue;
    }
    throw new ApiError('CLI_USAGE', `未知参数：${arg}`, 1);
  }
  return {
    ...(workDir === undefined ? {} : { workDir }),
    ...(configPath === undefined ? {} : { configPath }),
    testOnly,
  };
}

/**
 * 取可执行文件所在目录。
 *
 * 仅 SEA 产物有此概念，此时以 `process.execPath` 的目录为准；普通 Node 运行时没有
 * 独立的可执行文件，返回 `undefined`，工作区回退到进程工作目录。
 *
 * @returns 可执行文件目录绝对路径，或 `undefined`
 */
function executableDir(): string | undefined {
  return sea.isSea() ? dirname(process.execPath) : undefined;
}

/**
 * 运行子命令。
 *
 * @param argv 不含可执行文件名的参数数组
 * @returns 进程退出码
 */
export async function runCli(argv: readonly string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (argv.includes('-V') || argv.includes('--version')) {
    process.stdout.write(`@ofdrw/ofdrw-viewer-api-server ${VERSION}\n`);
    return 0;
  }

  let parsed: { configPath?: string; testOnly: boolean };
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    const body = toErrorBody(error);
    process.stderr.write(`错误[${body.code}]：${body.message}\n${USAGE}\n`);
    return 1;
  }

  let loaded;
  try {
    const execDir = executableDir();
    loaded = await loadConfig({ ...parsed, ...(execDir === undefined ? {} : { execDir }) });
  } catch (error) {
    const body = toErrorBody(error);
    process.stderr.write(`错误[${body.code}]：${body.message}\n`);
    return 1;
  }

  if (parsed.testOnly) {
    const dirErrors = await checkDirectories(loaded.config, loaded.workspaceRoot);
    const { text, ok } = describeConfig(loaded, dirErrors);
    const pending =
      loaded.configPath === undefined
        ? `\n提示: 启动时将在 ${join(loaded.workspaceRoot, CONFIG_FILE_NAME)} 生成默认配置（校验模式不生成）`
        : '';
    process.stdout.write(`${text}${pending}\n`);
    return ok ? 0 : 1;
  }

  if (loaded.errors.length > 0) {
    const { text } = describeConfig(loaded);
    process.stderr.write(`${text}\n`);
    return 1;
  }

  // 工作区根在启动时递归创建；作业目录由作业管理器在其下创建。
  await mkdir(loaded.workspaceRoot, { recursive: true });
  // 未指定 --config 且工作区内没有配置文件时，生成一份默认配置供后续修改。
  const generatedPath = await generateDefaultConfig(loaded);
  if (generatedPath !== undefined) {
    process.stdout.write(`已生成默认配置: ${generatedPath}（修改后重新启动生效）\n`);
  }

  const serverLogger = await createLogger(loaded.config);
  const { logger } = serverLogger;

  let running;
  try {
    running = await startApiServer(loaded.config, logger, loaded.jobDir);
  } catch (error) {
    const body = toErrorBody(error);
    process.stderr.write(`错误[${body.code}]：${body.message}\n`);
    await serverLogger.close();
    return body.status === 2 ? 2 : 1;
  }

  process.stdout.write(`已启动: ${running.url}/api\n`);

  // 等待退出信号；收到后先关闭服务与日志，再由调用方写入退出码。
  await new Promise<void>((resolve) => {
    const shutdown = (signal: NodeJS.Signals): void => {
      logger.info({ signal }, '收到退出信号，开始关闭服务');
      void running.close().then(
        () => serverLogger.close().then(resolve, resolve),
        () => serverLogger.close().then(resolve, resolve),
      );
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  });
  return 0;
}