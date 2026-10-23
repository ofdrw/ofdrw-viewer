/**
 * `info` 子命令：只查询包信息，不解密、不验签。
 *
 * 仅调用 crypto 的 `inspect`；加密包同样返回成功（退出码 0），因为查询本身
 * 不需要凭据，也不产生明文。
 */

import { inspect } from '@ofdrw/ofdrw-viewer-crypto';
import type {
  CryptoWarning,
  EncryptionLayerInfo,
  EncryptionUserInfo,
  OfdInspection,
} from '@ofdrw/ofdrw-viewer-crypto';
import { closeCryptoByteSource, openCryptoSource } from './credentials.js';
import { EXIT_CODES } from './errors.js';
import type { Logger } from './log.js';
import { reportCryptoWarnings } from './crypto-output.js';
import { sanitizeDisplayText } from './safe-text.js';

/** `info --json` 的固定输出结构（设计 §7.2）。 */
export interface CliInfoJson {
  /** 固定为 `info`。 */
  readonly command: 'info';
  /** 输入文件绝对路径。 */
  readonly input: string;
  /** 原始包字节数，单位 byte。 */
  readonly packageSize: number;
  /** OFD.xml@Version；不可读时省略。 */
  readonly ofdVersion?: string;
  /** 是否为加密包。 */
  readonly encrypted: boolean;
  /** 从外到内的加密层；明文为空数组。 */
  readonly layers: readonly EncryptionLayerInfo[];
  /** 全部加密层用户去重后的视图。 */
  readonly users: readonly EncryptionUserInfo[];
  /** Signatures.xml 中的签名条目数。 */
  readonly signatureCount: number;
  /** 是否存在 OFDEntries.xml + signedvalue.dat 防夹带保护。 */
  readonly integrityPresent: boolean;
  /** inspect 产生的 warning。 */
  readonly warnings: readonly CryptoWarning[];
}

/** `info` 子命令参数。 */
export interface InfoCommandOptions {
  /** 输入 OFD 文件绝对路径。 */
  readonly inputPath: string;
  /** 是否输出 JSON。 */
  readonly json: boolean;
}

/** `info` 子命令的可注入运行环境。 */
export interface InfoCommandRuntime {
  /** 日志器。 */
  readonly logger: Logger;
  /** 取消信号；SIGINT 时由 CLI 主流程触发。 */
  readonly signal?: AbortSignal;
}

/**
 * 执行 `info` 查询。
 *
 * @param options 输入与输出格式
 * @param runtime 日志器与取消信号
 * @returns 进程退出码：查询成功固定 0
 * @throws {CryptoError} 输入无法读取/包结构非法时抛出（由调用方映射退出码）
 */
export async function runInfo(
  options: InfoCommandOptions,
  runtime: InfoCommandRuntime,
): Promise<number> {
  const opened = await openCryptoSource(options.inputPath);
  let inspection: OfdInspection;
  try {
    inspection = await inspect(opened.source, {
      ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
    });
  } finally {
    // crypto 只借用 byte-source，不关闭调用方文件句柄；查询结束立即释放。
    await closeCryptoByteSource(opened.byteSource, runtime.logger);
  }
  reportCryptoWarnings(runtime.logger, inspection.warnings);

  const payload: CliInfoJson = {
    command: 'info',
    input: options.inputPath,
    packageSize: inspection.packageSize,
    ...(inspection.ofdVersion === undefined
      ? {}
      : { ofdVersion: inspection.ofdVersion }),
    encrypted: inspection.encrypted,
    layers: inspection.layers,
    users: inspection.users,
    signatureCount: inspection.signatures.length,
    integrityPresent: inspection.integrityPresent,
    warnings: inspection.warnings,
  };

  runtime.logger.info(
    options.json ? JSON.stringify(payload, null, 2) : formatInfoText(payload),
  );
  runtime.logger.flushWarningSummary();
  return EXIT_CODES.OK;
}

/**
 * 生成 `info` 的文本输出。
 *
 * @param info 固定 JSON 结构
 * @returns 多行文本
 */
export function formatInfoText(info: CliInfoJson): string {
  const lines = [
    `文件: ${sanitizeDisplayText(info.input)}`,
    `大小: ${info.packageSize} B`,
    `OFD 版本: ${sanitizeDisplayText(info.ofdVersion ?? '未知')}`,
    `加密: ${info.encrypted ? `是（${info.layers.length} 层）` : '否'}`,
    `用户: ${formatUsers(info.users)}`,
    `签名: ${info.signatureCount}`,
    `完整性: ${info.integrityPresent ? '有' : '无'}`,
  ];
  return lines.join('\n');
}

/**
 * 生成用户列表文本。
 *
 * @param users 用户摘要
 * @returns `无` 或 `name (method)` 形式，多项以逗号分隔
 */
function formatUsers(users: readonly EncryptionUserInfo[]): string {
  if (users.length === 0) return '无';
  return users
    .map((user) => `${sanitizeDisplayText(user.userName)} (${user.method})`)
    .join('、');
}