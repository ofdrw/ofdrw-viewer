/**
 * CLI 参数解析、帮助/版本、运行时编排与退出码。
 *
 * 参数与路径校验通过后，把控制权交给 `convert.ts`；转换期间监听一次
 * SIGINT，通过 AbortSignal 取消当前页导出并以 130 退出。
 */

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { convertDocument } from './convert.js';
import {
  CliError,
  EXIT_CODES,
  errorMessage,
  isCliError,
  isErrnoError,
  toCliError,
} from './errors.js';
import { loadSupplementaryFonts } from './fonts.js';
import { Logger } from './log.js';
import type { OutputStream } from './log.js';
import {
  IMAGE_FORMATS,
  prepareOutputDirectory,
  resolveDefaultOutputDir,
} from './output.js';
import type { ImageFormat } from './output.js';
import { parsePageRanges } from './pages.js';

export { parsePageRanges, resolvePageNumbers, validatePageNumbers } from './pages.js';

/** 命令名，同时用作包名与 bin 名。 */
export const CLI_NAME = 'ofdrw-viewer-cli';

/** CLI 版本，与 package.json 保持一致。 */
export const CLI_VERSION = '0.1.0';

/** 默认输出 DPI。 */
export const DEFAULT_DPI = 96;

/** 超过该 DPI 时给出 warning，但仍继续执行。 */
export const HIGH_DPI_WARNING_THRESHOLD = 1200;

/** 一行用法提示。 */
export const USAGE_LINE = `用法: ${CLI_NAME} <input.ofd> [options]`;

/** `--help` 的完整输出。 */
export const HELP_TEXT = `${USAGE_LINE}

参数:
  <input>               本地 OFD 文件路径（必填）
  -o, --out <dir>       输出目录；默认 ./<输入文件名>/
  -f, --format <fmt>    图片格式：png | jpeg | webp（默认 png）
  -d, --dpi <n>         输出 DPI，正整数（默认 96；超过 ${HIGH_DPI_WARNING_THRESHOLD} 给 warning）
  -p, --pages <ranges>  页码范围，1 起闭区间，如 1-3,5（默认全部页）
      --font-dir <dir>  补充字体目录；递归扫描 ttf/otf/ttc/otc
  -h, --help            显示本帮助
  -V, --version         显示版本与平台

输出命名: <out>/<stem>-p<NNN>.<ext>（页号至少 3 位）
退出码: 0 成功；1 用法错误；2 文档级失败；3 页级失败；130 用户中断`;

/** 解析并归一化后的 CLI 参数；路径均为绝对路径。 */
export interface CliOptions {
  /** 输入 OFD 文件绝对路径。 */
  readonly inputPath: string;
  /** 输出目录绝对路径。 */
  readonly outDir: string;
  /** 图片格式。 */
  readonly format: ImageFormat;
  /** 输出 DPI，与后续空间文本共用。 */
  readonly dpi: number;
  /** 选中的页号（1 起、升序去重）；`undefined` 表示全部页。 */
  readonly pageNumbers: readonly number[] | undefined;
  /** 补充字体目录绝对路径；未提供时为 `undefined`。 */
  readonly fontDir: string | undefined;
}

/** `parseCliArgs` 的结果。 */
export interface ParsedCliArgs {
  /** 是否请求帮助。 */
  readonly help: boolean;
  /** 是否请求版本。 */
  readonly version: boolean;
  /** 转换参数；`help`/`version` 为 true 时不存在。 */
  readonly options?: CliOptions;
}

/** `main` 的可注入运行环境，供单元测试捕获输出与固定平台信息。 */
export interface CliRuntime {
  /** 相对路径的基准目录，默认 `process.cwd()`。 */
  readonly cwd?: string;
  /** 普通信息输出流，默认 `process.stdout`。 */
  readonly stdout?: OutputStream;
  /** 错误/warning 输出流，默认 `process.stderr`。 */
  readonly stderr?: OutputStream;
  /** 平台名，默认 `process.platform`。 */
  readonly platform?: string;
  /** CPU 架构，默认 `process.arch`。 */
  readonly arch?: string;
  /**
   * 测试注入的取消信号；提供时不再注册 SIGINT 监听。
   *
   * 生产环境由 CLI 主流程创建 AbortController 并在 SIGINT 时触发。
   */
  readonly signal?: AbortSignal;
}

/**
 * 解析命令行参数。
 *
 * `--help` / `--version` 优先于输入校验：即使缺少 `<input>` 也返回成功，
 * 由调用方打印对应信息。其余情况严格校验参数集合与取值。
 *
 * @param argv 不含 node 与脚本路径的参数数组
 * @param cwd 相对路径基准目录，默认 `process.cwd()`
 * @throws {CliError} 未知参数、缺少输入、参数值非法时抛出（退出码 1）
 */
export function parseCliArgs(
  argv: readonly string[],
  cwd: string = process.cwd(),
): ParsedCliArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        out: { type: 'string', short: 'o' },
        format: { type: 'string', short: 'f' },
        dpi: { type: 'string', short: 'd' },
        pages: { type: 'string', short: 'p' },
        'font-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'V' },
      },
    });
  } catch (error) {
    throw new CliError('CLI_USAGE', formatParseArgsError(error), EXIT_CODES.USAGE);
  }

  const { values, positionals } = parsed;
  if (values.help === true) return { help: true, version: false };
  if (values.version === true) return { help: false, version: true };

  if (positionals.length === 0) {
    throw new CliError('CLI_USAGE', '缺少输入文件', EXIT_CODES.USAGE);
  }
  if (positionals.length > 1) {
    throw new CliError(
      'CLI_USAGE',
      `一次只接受一个输入文件，收到 ${positionals.length} 个`,
      EXIT_CODES.USAGE,
    );
  }

  const inputPath = resolve(cwd, positionals[0]);
  const outDir =
    values.out === undefined
      ? resolveDefaultOutputDir(inputPath, cwd)
      : resolvePathOption(values.out, cwd, '--out');
  const fontDir =
    values['font-dir'] === undefined
      ? undefined
      : resolvePathOption(values['font-dir'], cwd, '--font-dir');

  return {
    help: false,
    version: false,
    options: {
      inputPath,
      outDir,
      format: parseImageFormat(values.format),
      dpi: parseDpi(values.dpi),
      pageNumbers: values.pages === undefined ? undefined : parsePageRanges(values.pages),
      fontDir,
    },
  };
}

/**
 * 把 Node `parseArgs` 的英文错误映射为简体中文。
 *
 * @param error `parseArgs` 抛出的错误；其他异常按通用参数错误处理
 * @returns 面向用户的中文错误信息
 */
function formatParseArgsError(error: unknown): string {
  const message = errorMessage(error);
  switch (parseArgsErrorCode(error)) {
    case 'ERR_PARSE_ARGS_UNKNOWN_OPTION': {
      const option = /Unknown option '([^']+)'/.exec(message)?.[1];
      return option === undefined ? '存在未知参数' : `未知参数：${option}`;
    }
    case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE': {
      const option =
        /Option '([^']+)'/.exec(message)?.[1]?.replace(/\s*<[^>]*>/g, '') ?? '参数';
      if (message.includes('argument missing')) return `缺少参数值：${option}`;
      if (message.includes('does not take an argument')) return `参数不接受值：${option}`;
      return `参数值无效：${option}`;
    }
    case 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL': {
      const argument = /Unexpected argument '([^']+)'/.exec(message)?.[1];
      return argument === undefined ? '存在不支持的参数' : `不支持的参数：${argument}`;
    }
    default:
      return '参数解析失败';
  }
}

/** 读取 `parseArgs` 错误对象上的字符串 `code`。 */
function parseArgsErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * 校验输入文件存在且为普通文件。
 *
 * @param inputPath 输入文件绝对路径
 * @throws {CliError} 不存在、不是文件或不可读取时抛出（退出码 1）
 */
export async function validateInputFile(inputPath: string): Promise<void> {
  try {
    const info = await stat(inputPath);
    if (!info.isFile()) {
      throw new CliError(
        'CLI_INPUT_NOT_FILE',
        `输入路径不是文件：${inputPath}`,
        EXIT_CODES.USAGE,
      );
    }
  } catch (error) {
    if (isCliError(error)) throw error;
    if (isErrnoError(error, 'ENOENT')) {
      throw new CliError(
        'CLI_INPUT_NOT_FOUND',
        `输入文件不存在：${inputPath}`,
        EXIT_CODES.USAGE,
      );
    }
    throw new CliError(
      'CLI_INPUT_UNREADABLE',
      `无法读取输入文件：${inputPath}（${errorMessage(error)}）`,
      EXIT_CODES.USAGE,
    );
  }
}

/**
 * CLI 主流程：解析参数、校验路径、准备输出并调用图片转换。
 *
 * @param argv 不含 node 与脚本路径的参数数组
 * @param runtime 可注入的运行环境（测试用）
 * @returns 进程退出码，调用方应写入 `process.exitCode`
 */
export async function main(
  argv: readonly string[],
  runtime: CliRuntime = {},
): Promise<number> {
  const logger = new Logger({ stdout: runtime.stdout, stderr: runtime.stderr });

  try {
    const parsed = parseCliArgs(argv, runtime.cwd ?? process.cwd());
    if (parsed.help) {
      logger.info(HELP_TEXT);
      return EXIT_CODES.OK;
    }
    if (parsed.version) {
      logger.info(
        formatVersion(runtime.platform ?? process.platform, runtime.arch ?? process.arch),
      );
      return EXIT_CODES.OK;
    }

    const options = parsed.options;
    if (options === undefined) {
      throw new CliError('CLI_UNEXPECTED', '参数解析结果缺少选项', EXIT_CODES.DOCUMENT);
    }
    if (options.dpi > HIGH_DPI_WARNING_THRESHOLD) {
      logger.warn(
        'W_DPI_HIGH',
        `--dpi ${options.dpi} 超过建议上限 ${HIGH_DPI_WARNING_THRESHOLD}，可能占用大量内存`,
      );
    }

    await validateInputFile(options.inputPath);
    const fontFiles =
      options.fontDir === undefined
        ? []
        : await loadSupplementaryFonts(options.fontDir, logger);
    await prepareOutputDirectory(options.outDir);

    // SIGINT 只触发一次取消，由 convert 内的 AbortSignal 通知当前页导出。
    const controller = new AbortController();
    const signal = runtime.signal ?? controller.signal;
    let interruptedBySignal = false;
    const handleSigint = (): void => {
      interruptedBySignal = true;
      controller.abort();
    };
    const listenForSigint = runtime.signal === undefined;
    if (listenForSigint) process.once('SIGINT', handleSigint);

    try {
      const summary = await convertDocument(
        { ...options, fontFiles },
        { logger, signal },
      );
      logger.info(summary.message);
      logger.flushWarningSummary();
      if (summary.interrupted || interruptedBySignal) return EXIT_CODES.INTERRUPTED;
      return summary.failedPages > 0 ? EXIT_CODES.PAGE : EXIT_CODES.OK;
    } finally {
      if (listenForSigint) process.off('SIGINT', handleSigint);
    }
  } catch (error) {
    const failure = toCliError(error);
    logger.error(failure.code, failure.message);
    if (failure.code === 'CLI_USAGE') {
      logger.detail(`${USAGE_LINE}\n运行 ${CLI_NAME} --help 查看全部参数。`);
    }
    if (failure.stack !== undefined) logger.detail(failure.stack);
    logger.flushWarningSummary();
    return failure.exitCode;
  }
}

/**
 * 生成 `--version` 输出。
 *
 * @param platform 平台名，如 `linux`
 * @param arch CPU 架构，如 `x64`
 */
export function formatVersion(platform: string, arch: string): string {
  return `${CLI_NAME} ${CLI_VERSION} (${platform}-${arch})`;
}

/** 解析并校验 `--format`；缺省为 png。 */
function parseImageFormat(raw: string | undefined): ImageFormat {
  if (raw === undefined) return 'png';
  const normalized = raw.trim().toLowerCase();
  if ((IMAGE_FORMATS as readonly string[]).includes(normalized)) {
    return normalized as ImageFormat;
  }
  throw new CliError(
    'CLI_INVALID_FORMAT',
    `--format 只支持 ${IMAGE_FORMATS.join(' / ')}，收到：${raw}`,
    EXIT_CODES.USAGE,
  );
}

/** 解析并校验 `--dpi`；缺省为 96，必须为正整数。 */
function parseDpi(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_DPI;
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value) || value < 1) {
    throw new CliError(
      'CLI_INVALID_DPI',
      `--dpi 必须为正整数，收到：${raw}`,
      EXIT_CODES.USAGE,
    );
  }
  return value;
}

/** 解析路径选项；拒绝空值。 */
function resolvePathOption(raw: string, cwd: string, optionName: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new CliError('CLI_USAGE', `${optionName} 不能为空`, EXIT_CODES.USAGE);
  }
  return resolve(cwd, trimmed);
}
