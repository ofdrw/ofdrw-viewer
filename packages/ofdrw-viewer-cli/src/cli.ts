/**
 * CLI 参数解析、帮助/版本、子命令分派与退出码。
 *
 * 三种入口：
 * - 无子命令：`<input.ofd> [转图片选项] [加密凭据]`，保持既有转图片行为；
 * - `info <input> [--json]`：只查询包结构，不解密、不验签；
 * - `verify <input> [凭据] [--root]... [--sm2-user-id] [--json]`：
 *   一次性完成防夹带完整性与全部签名验证。
 *
 * 转换/查询/验证期间监听一次 SIGINT，通过 AbortSignal 取消并以 130 退出。
 */

import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { convertDocument } from './convert.js';
import { buildCryptoCredential } from './credentials.js';
import type { CliCredentialOptions } from './credentials.js';
import {
  CliError,
  EXIT_CODES,
  errorMessage,
  isCliError,
  isErrnoError,
  toCliError,
} from './errors.js';
import { loadSupplementaryFonts, loadSystemFonts } from './fonts.js';
import type { FontFile } from './fonts.js';
import { runInfo } from './info.js';
import { Logger } from './log.js';
import type { OutputStream } from './log.js';
import {
  IMAGE_FORMATS,
  prepareOutputDirectory,
  resolveDefaultOutputDir,
} from './output.js';
import type { ImageFormat } from './output.js';
import { parsePageRanges } from './pages.js';
import { runVerify } from './verify.js';

export { parsePageRanges, resolvePageNumbers, validatePageNumbers } from './pages.js';

/** 命令名，同时用作包名与 bin 名。 */
export const CLI_NAME = 'ofdrw-viewer-cli';

/**
 * CLI 版本。
 *
 * 普通 Node 下从 package.json 读取；SEA 启动时由 `sea.ts` 从内嵌清单写入
 * `OFDRW_CLI_VERSION`，避免在可执行文件内依赖 package.json 文件。
 */
export const CLI_VERSION = process.env.OFDRW_CLI_VERSION ?? readPackageVersion();

/** 默认输出 DPI。 */
export const DEFAULT_DPI = 96;

/** 超过该 DPI 时给出 warning，但仍继续执行。 */
export const HIGH_DPI_WARNING_THRESHOLD = 1200;

/** 一行用法提示（保持既有转图片用法兼容）。 */
export const USAGE_LINE = `用法: ${CLI_NAME} <input.ofd> [options]`;

/** 子命令用法提示。 */
export const SUBCOMMAND_USAGE = `${CLI_NAME} info <input.ofd> [--json]
${CLI_NAME} verify <input.ofd> [凭据选项] [--root <file>]... [--sm2-user-id <id>] [--json]`;

/** 凭据选项说明，`verify` 与转图片共用。 */
const CREDENTIAL_HELP = `      --user <name>       加密文档用户名（verify 与转图片）
      --password <password>     口令（仅 password 用户）
      --key <path>        SM2 私钥文件（PEM/DER/PKCS#8）
      --key-passphrase <text>  加密 PKCS#8 私钥口令`;

/** `--help` 的完整输出。 */
export const HELP_TEXT = `${USAGE_LINE}
       ${CLI_NAME} info <input.ofd> [--json]
       ${CLI_NAME} verify <input.ofd> [凭据选项] [--root <file>]... [--sm2-user-id <id>] [--json]

子命令:
  info                    只查询包信息（不解密、不验签）
  verify                  一次性验证防夹带完整性与全部签名

参数:
  <input>                 本地 OFD 文件路径（必填）
  -o, --out <dir>         输出目录；默认 ./<输入文件名>/
  -f, --format <fmt>      图片格式：png | jpeg | webp（默认 png）
  -d, --dpi <n>           输出 DPI，正整数（默认 96；超过 ${HIGH_DPI_WARNING_THRESHOLD} 给 warning）
  -p, --pages <ranges>    页码范围，1 起闭区间，如 1-3,5（默认全部页）
      --font-dir <dir>    补充字体目录；递归扫描 ttf/otf/ttc/otc
      --no-system-fonts   关闭系统字体自动发现，仅使用 --font-dir
      --text              每页额外导出空间文本 JSON（<stem>-p<NNN>.json）
${CREDENTIAL_HELP}
      --root <file>       信任根证书（PEM/DER/CER，可重复；仅 verify）
      --sm2-user-id <id>  自定义 SM2 签名 userId（仅 verify）
      --json              以 JSON 输出（仅 info/verify）
  -h, --help              显示本帮助
  -V, --version           显示版本与平台

输出命名: <out>/<stem>-p<NNN>.<ext>（页号至少 3 位）
退出码: 0 成功；1 用法错误；2 文档级失败；3 页级失败；4 加密/凭据失败；5 验证未通过；130 用户中断
文件名: 输入文件名恰为 info/verify 时请写成 ./info 或 ./verify，避免被识别为子命令
安全提示: --password/--key-passphrase 可能出现在 shell 历史与进程列表，请使用安全方式传递。`;

/** 解析并归一化后的转图片参数；路径均为绝对路径。 */
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
  /** 是否自动发现系统字体；`--no-system-fonts` 时为 false。 */
  readonly systemFonts: boolean;
  /** 是否额外导出空间文本 JSON。 */
  readonly text: boolean;
  /** 加密凭据原始参数；未提供时为 `undefined`。 */
  readonly credentials: CliCredentialOptions | undefined;
}

/** 解析并归一化后的 `info` 参数。 */
export interface InfoCliOptions {
  /** 输入 OFD 文件绝对路径。 */
  readonly inputPath: string;
  /** 是否输出 JSON。 */
  readonly json: boolean;
}

/** 解析并归一化后的 `verify` 参数。 */
export interface VerifyCliOptions {
  /** 输入 OFD 文件绝对路径。 */
  readonly inputPath: string;
  /** 是否输出 JSON。 */
  readonly json: boolean;
  /** 加密凭据原始参数。 */
  readonly credentials: CliCredentialOptions;
  /** 信任根证书文件绝对路径。 */
  readonly rootPaths: readonly string[];
  /** 自定义 SM2 userId；省略时使用标准值。 */
  readonly sm2UserId: string | undefined;
}

/** 解析后的命令。 */
export type CliCommand =
  | { readonly kind: 'convert'; readonly options: CliOptions }
  | { readonly kind: 'info'; readonly options: InfoCliOptions }
  | { readonly kind: 'verify'; readonly options: VerifyCliOptions };

/** `parseCliArgs` 的结果。 */
export interface ParsedCliArgs {
  /** 是否请求帮助。 */
  readonly help: boolean;
  /** 是否请求版本。 */
  readonly version: boolean;
  /** 命令；`help`/`version` 为 true 时不存在。 */
  readonly command?: CliCommand;
}

/** `main` 的可注入运行环境，供单元测试捕获输出与固定平台信息。 */
export interface CliRuntime {
  /** 相对路径的基准目录，默认 `process.cwd()`。 */
  readonly cwd?: string;
  /** 普通信息输出流，默认 `process.stdout`。 */
  readonly stdout?: OutputStream;
  /** 错误/warning 输出流，默认 `process.stderr`。 */
  readonly stderr?: OutputStream;
  /**
   * stderr 是否为 TTY；默认读取 `process.stderr.isTTY`。
   *
   * 为 true 时向 stderr 输出单行逐页进度，重定向/管道保持安静。
   */
  readonly stderrIsTTY?: boolean;
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

/** 逐页进度回调；TTY 与非 TTY 都由 `convert.ts` 统一调用。 */
export interface ProgressReporter {
  /** 更新当前页进度；`current` 为页号（1 起），`total` 为计划总页数。 */
  onProgress?: (current: number, total: number) => void;
  /** 清理进度行。 */
  onProgressEnd?: () => void;
}

/** 一次命令执行的取消作用域。 */
interface InterruptScope {
  /** 传给转换/crypto 的取消信号。 */
  readonly signal: AbortSignal;
  /** 是否已收到 SIGINT（或注入信号已中止）。 */
  interrupted(): boolean;
  /** 移除 SIGINT 监听；重复调用安全。 */
  dispose(): void;
}

/**
 * 创建取消作用域。
 *
 * 提供 `runtime.signal` 时不注册 SIGINT，便于单元测试注入；否则注册一次
 * `SIGINT` 并在首次触发时 abort。
 *
 * @param runtime CLI 运行环境
 * @returns 取消作用域
 */
function createInterruptScope(runtime: CliRuntime): InterruptScope {
  const controller = new AbortController();
  const signal = runtime.signal ?? controller.signal;
  const listen = runtime.signal === undefined;
  let interrupted = false;
  const handleSigint = (): void => {
    interrupted = true;
    controller.abort();
  };
  if (listen) process.once('SIGINT', handleSigint);
  return {
    signal,
    interrupted: () => interrupted || runtime.signal?.aborted === true,
    dispose: () => {
      if (listen) process.off('SIGINT', handleSigint);
    },
  };
}

/**
 * 创建逐页进度输出器。
 *
 * @param stream 目标输出流（stderr）
 * @param enabled 是否为 TTY；false 时返回空实现
 * @returns 进度回调
 */
export function createProgressReporter(
  stream: OutputStream,
  enabled: boolean,
): ProgressReporter {
  if (!enabled) return {};
  return {
    onProgress(current: number, total: number): void {
      stream.write(`\r[${current}/${total}]`);
    },
    onProgressEnd(): void {
      // 用空格覆盖整行后回到行首，避免残留字符；不依赖 ANSI 控制序列。
      stream.write(`\r${' '.repeat(32)}\r`);
    },
  };
}

/**
 * 从 package.json 读取版本。
 *
 * 源码与 dist 都位于包根下一层，因此 `../package.json` 在两种布局下均成立。
 *
 * @returns 版本字符串；读取失败时回退 `0.0.0`
 */
function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.length > 0
      ? pkg.version
      : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** `parseArgs` 的选项定义。 */
const PARSE_OPTIONS = {
  out: { type: 'string', short: 'o' },
  format: { type: 'string', short: 'f' },
  dpi: { type: 'string', short: 'd' },
  pages: { type: 'string', short: 'p' },
  'font-dir': { type: 'string' },
  'no-system-fonts': { type: 'boolean' },
  text: { type: 'boolean' },
  user: { type: 'string' },
  password: { type: 'string' },
  key: { type: 'string' },
  'key-passphrase': { type: 'string' },
  root: { type: 'string', multiple: true },
  'sm2-user-id': { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'V' },
} as const;

/** `parseArgs` 返回值中本文件使用的字段。 */
interface RawCliValues {
  readonly out?: string;
  readonly format?: string;
  readonly dpi?: string;
  readonly pages?: string;
  readonly 'font-dir'?: string;
  readonly 'no-system-fonts'?: boolean;
  readonly text?: boolean;
  readonly user?: string;
  readonly password?: string;
  readonly key?: string;
  readonly 'key-passphrase'?: string;
  readonly root?: readonly string[];
  readonly 'sm2-user-id'?: string;
  readonly json?: boolean;
  readonly help?: boolean;
  readonly version?: boolean;
}

/**
 * 解析命令行参数。
 *
 * `--help` / `--version` 优先于输入校验：即使缺少 `<input>` 也返回成功，
 * 由调用方打印对应信息。第一个位置参数严格等于 `info`/`verify`/`decrypt`
 * 时进入子命令分支；文件名恰好为这些词时请写成 `./info`。
 *
 * @param argv 不含 node 与脚本路径的参数数组
 * @param cwd 相对路径基准目录，默认 `process.cwd()`
 * @throws {CliError} 未知参数、缺少输入、参数非法或子命令参数冲突时抛出（退出码 1）
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
      options: PARSE_OPTIONS,
    });
  } catch (error) {
    throw new CliError('CLI_USAGE', formatParseArgsError(error), EXIT_CODES.USAGE);
  }

  const values = parsed.values as RawCliValues;
  const positionals = parsed.positionals;
  if (values.help === true) return { help: true, version: false };
  if (values.version === true) return { help: false, version: true };

  const first = positionals[0];
  if (first === 'decrypt') {
    throw new CliError(
      'CLI_USAGE',
      '不提供 decrypt 子命令；请使用 verify 或带凭据的转图片命令',
      EXIT_CODES.USAGE,
    );
  }
  const subcommand: 'info' | 'verify' | undefined =
    first === 'info' || first === 'verify' ? first : undefined;
  const inputs = subcommand === undefined ? positionals : positionals.slice(1);

  if (inputs.length === 0) {
    throw new CliError(
      'CLI_USAGE',
      subcommand === undefined ? '缺少输入文件' : `${subcommand} 缺少输入文件`,
      EXIT_CODES.USAGE,
    );
  }
  if (inputs.length > 1) {
    throw new CliError(
      'CLI_USAGE',
      `一次只接受一个输入文件，收到 ${inputs.length} 个`,
      EXIT_CODES.USAGE,
    );
  }
  const inputPath = resolve(cwd, inputs[0]!);

  if (subcommand === 'info') {
    assertOptionsAbsent(values, 'info', [
      ['out', '--out'],
      ['format', '--format'],
      ['dpi', '--dpi'],
      ['pages', '--pages'],
      ['font-dir', '--font-dir'],
      ['no-system-fonts', '--no-system-fonts'],
      ['text', '--text'],
      ['user', '--user'],
      ['password', '--password'],
      ['key', '--key'],
      ['key-passphrase', '--key-passphrase'],
      ['root', '--root'],
      ['sm2-user-id', '--sm2-user-id'],
    ], 'info 只查询，不解密、不验证；如需凭据/验签请使用 verify');
    return {
      help: false,
      version: false,
      command: { kind: 'info', options: { inputPath, json: values.json === true } },
    };
  }

  if (subcommand === 'verify') {
    assertOptionsAbsent(values, 'verify', [
      ['out', '--out'],
      ['format', '--format'],
      ['dpi', '--dpi'],
      ['pages', '--pages'],
      ['font-dir', '--font-dir'],
      ['no-system-fonts', '--no-system-fonts'],
      ['text', '--text'],
    ], 'verify 不接受转图片参数；需要导出图片时请不要使用 verify 子命令');
    return {
      help: false,
      version: false,
      command: {
        kind: 'verify',
        options: {
          inputPath,
          json: values.json === true,
          credentials: parseCredentialOptions(values, cwd),
          rootPaths: parseRootPaths(values.root, cwd),
          sm2UserId: parseSm2UserId(values['sm2-user-id']),
        },
      },
    };
  }

  assertOptionsAbsent(values, 'convert', [
    ['root', '--root'],
    ['sm2-user-id', '--sm2-user-id'],
    ['json', '--json'],
  ], '转图片不接受该参数；验证请使用 verify 子命令');

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
    command: {
      kind: 'convert',
      options: {
        inputPath,
        outDir,
        format: parseImageFormat(values.format),
        dpi: parseDpi(values.dpi),
        pageNumbers: values.pages === undefined ? undefined : parsePageRanges(values.pages),
        fontDir,
        systemFonts: values['no-system-fonts'] !== true,
        text: values.text === true,
        credentials: parseCredentialOptions(values, cwd),
      },
    },
  };
}

/**
 * 生成凭据选项列表；`--password` 与 `--key` 互斥。
 *
 * @param values 原始参数
 * @param cwd 相对路径基准目录
 * @returns 凭据原始参数；未提供任何凭据字段时全部为 `undefined`
 * @throws {CliError} 凭据组合非法或路径为空时抛出（退出码 1）
 */
function parseCredentialOptions(
  values: RawCliValues,
  cwd: string,
): CliCredentialOptions {
  const user = values.user;
  if (user !== undefined && user.trim().length === 0) {
    throw new CliError('CLI_USAGE', '--user 不能为空', EXIT_CODES.USAGE);
  }
  if (values.password !== undefined && values.key !== undefined) {
    throw new CliError(
      'CLI_CREDENTIALS_CONFLICT',
      '--password 与 --key 不能同时使用',
      EXIT_CODES.USAGE,
    );
  }
  if (values['key-passphrase'] !== undefined && values.key === undefined) {
    throw new CliError(
      'CLI_CREDENTIALS_INCOMPLETE',
      '--key-passphrase 需要与 --key 一起使用',
      EXIT_CODES.USAGE,
    );
  }
  if (
    user !== undefined &&
    values.password === undefined &&
    values.key === undefined
  ) {
    throw new CliError(
      'CLI_CREDENTIALS_INCOMPLETE',
      '--user 需要与 --password 或 --key 一起使用',
      EXIT_CODES.USAGE,
    );
  }
  const keyPath =
    values.key === undefined ? undefined : resolvePathOption(values.key, cwd, '--key');
  return {
    ...(user === undefined ? {} : { user }),
    ...(values.password === undefined ? {} : { password: values.password }),
    ...(keyPath === undefined ? {} : { keyPath }),
    ...(values['key-passphrase'] === undefined
      ? {}
      : { keyPassphrase: values['key-passphrase'] }),
  };
}

/**
 * 解析可重复的 `--root` 路径并去重。
 *
 * @param raw 原始值
 * @param cwd 相对路径基准目录
 * @returns 绝对路径数组；未提供时为空数组
 * @throws {CliError} 路径为空时抛出（退出码 1）
 */
function parseRootPaths(raw: readonly string[] | undefined, cwd: string): readonly string[] {
  if (raw === undefined) return [];
  const paths = raw.map((path) => resolvePathOption(path, cwd, '--root'));
  return [...new Set(paths)];
}

/**
 * 校验 `--sm2-user-id`。
 *
 * @param raw 原始值
 * @returns 去除首尾空白后的 userId；未提供时为 `undefined`
 * @throws {CliError} 值为空时抛出（退出码 1）
 */
function parseSm2UserId(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new CliError('CLI_USAGE', '--sm2-user-id 不能为空', EXIT_CODES.USAGE);
  }
  return trimmed;
}

/**
 * 拒绝当前子命令不支持的参数。
 *
 * 只列出参数名，不回显参数值，避免把口令/私钥写进错误信息。
 *
 * @param values 原始参数
 * @param command 子命令名（仅用于提示）
 * @param checks 参数键与展示名的列表
 * @param reason 统一的提示语
 * @throws {CliError} 任一参数出现时抛出（退出码 1）
 */
function assertOptionsAbsent(
  values: RawCliValues,
  command: string,
  checks: readonly (readonly [keyof RawCliValues, string])[],
  reason: string,
): void {
  const present: string[] = [];
  for (const [key, flag] of checks) {
    const value = values[key];
    if (value !== undefined && value !== false) present.push(flag);
  }
  if (present.length === 0) return;
  throw new CliError(
    'CLI_USAGE',
    `${command} 不接受参数 ${present.join('、')}；${reason}`,
    EXIT_CODES.USAGE,
  );
}

/**
 * 把 Node `parseArgs` 的英文错误映射为简体中文。
 *
 * 只提取参数名，不回显参数值（例如 `--password` 的值）。
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
        /Option '([^']+)'/.exec(message)?.[1]?.replace(/\s*<[^>]*>/g, '').trim() ??
        '参数';
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
 * 合并用户补充字体与自动发现的系统字体。
 *
 * `--font-dir` 扫描结果在前、系统字体在后，按 realpath 去重（两者返回值均
 * 已规范化），因此用户显式提供的字体会优先参与 engine 的字体匹配。
 *
 * @param options 转图片参数
 * @param logger 日志器
 * @returns 注入 engine `supplementaryFonts` 的字体列表
 */
async function collectFontFiles(
  options: CliOptions,
  logger: Logger,
): Promise<FontFile[]> {
  const fontFiles =
    options.fontDir === undefined ? [] : await loadSupplementaryFonts(options.fontDir, logger);
  if (!options.systemFonts) return fontFiles;

  const systemFonts = await loadSystemFonts(logger);
  const seen = new Set(fontFiles.map((font) => font.path));
  const merged = [...fontFiles];
  for (const font of systemFonts) {
    if (seen.has(font.path)) continue;
    seen.add(font.path);
    merged.push(font);
  }
  return merged;
}

/**
 * CLI 主流程：解析参数、分派子命令并计算退出码。
 *
 * @param argv 不含 node 与脚本路径的参数数组
 * @param runtime 可注入的运行环境（测试用）
 * @returns 进程退出码，调用方应写入 `process.exitCode`
 */
export async function main(
  argv: readonly string[],
  runtime: CliRuntime = {},
): Promise<number> {
  const stderr = runtime.stderr ?? process.stderr;
  const logger = new Logger({ stdout: runtime.stdout, stderr });
  const progress = createProgressReporter(
    stderr,
    runtime.stderrIsTTY ?? process.stderr.isTTY === true,
  );

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

    const command = parsed.command;
    if (command === undefined) {
      throw new CliError('CLI_UNEXPECTED', '参数解析结果缺少命令', EXIT_CODES.DOCUMENT);
    }

    const interrupt = createInterruptScope(runtime);
    try {
      await validateInputFile(command.options.inputPath);

      if (command.kind === 'info') {
        const code = await runInfo(command.options, {
          logger,
          signal: interrupt.signal,
        });
        return interrupt.interrupted() ? EXIT_CODES.INTERRUPTED : code;
      }

      if (command.kind === 'verify') {
        const code = await runVerify(command.options, {
          logger,
          signal: interrupt.signal,
        });
        return interrupt.interrupted() ? EXIT_CODES.INTERRUPTED : code;
      }

      const options = command.options;
      if (options.dpi > HIGH_DPI_WARNING_THRESHOLD) {
        logger.warn(
          'W_DPI_HIGH',
          `--dpi ${options.dpi} 超过建议上限 ${HIGH_DPI_WARNING_THRESHOLD}，可能占用大量内存`,
        );
      }
      const fontFiles = await collectFontFiles(options, logger);
      await prepareOutputDirectory(options.outDir);

      const { credentials: credentialOptions, ...convertOptions } = options;
      const credentials = await buildCryptoCredential(credentialOptions);
      const summary = await convertDocument(
        {
          ...convertOptions,
          fontFiles,
          ...(credentials === undefined ? {} : { credentials }),
        },
        { logger, signal: interrupt.signal, ...progress },
      );
      logger.info(summary.message);
      logger.flushWarningSummary();
      if (summary.interrupted || interrupt.interrupted()) return EXIT_CODES.INTERRUPTED;
      return summary.failedPages > 0 ? EXIT_CODES.PAGE : EXIT_CODES.OK;
    } finally {
      interrupt.dispose();
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