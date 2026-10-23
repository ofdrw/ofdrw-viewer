/**
 * `verify` 子命令：一次性完成防夹带完整性与全部签名验证。
 *
 * 加密文档由 crypto 的 `verifyOfd` 在内部解密；CLI 不落盘明文、不提供
 * 独立 decrypt 子命令。结果为 `valid` 时退出 0，其余状态退出 5。
 */

import { verifyOfd } from '@ofdrw/ofdrw-viewer-crypto';
import type {
  ChainStatus,
  IntegrityVerification,
  SignatureVerification,
  TimestampParseResult,
  VerificationReport,
} from '@ofdrw/ofdrw-viewer-crypto';
import {
  buildCryptoCredential,
  closeCryptoByteSource,
  openCryptoSource,
  readTrustRoots,
  type CliCredentialOptions,
} from './credentials.js';
import { reportCryptoWarnings } from './crypto-output.js';
import { EXIT_CODES } from './errors.js';
import type { Logger } from './log.js';
import { sanitizeDisplayText } from './safe-text.js';

/** `verify --json` 的固定输出结构（设计 §7.3）。 */
export interface CliVerifyJson {
  /** 固定为 `verify`。 */
  readonly command: 'verify';
  /** 输入文件绝对路径。 */
  readonly input: string;
  /** 统一验证报告。 */
  readonly report: VerificationReport;
}

/** `verify` 子命令参数。 */
export interface VerifyCommandOptions {
  /** 输入 OFD 文件绝对路径。 */
  readonly inputPath: string;
  /** 是否输出 JSON。 */
  readonly json: boolean;
  /** 加密凭据原始参数。 */
  readonly credentials: CliCredentialOptions;
  /** 信任根证书文件绝对路径；空数组表示未配置。 */
  readonly rootPaths: readonly string[];
  /** 自定义 SM2 userId；省略时使用标准值。 */
  readonly sm2UserId?: string;
}

/** `verify` 子命令的可注入运行环境。 */
export interface VerifyCommandRuntime {
  /** 日志器。 */
  readonly logger: Logger;
  /** 取消信号；SIGINT 时由 CLI 主流程触发。 */
  readonly signal?: AbortSignal;
}

/**
 * 执行 `verify`。
 *
 * @param options 输入、凭据、根证书与输出格式
 * @param runtime 日志器与取消信号
 * @returns 进程退出码：`overall=valid` 为 0，其余验证状态为 5
 * @throws {CryptoError} 入口参数/凭据/包结构错误时抛出（由调用方映射退出码）
 */
export async function runVerify(
  options: VerifyCommandOptions,
  runtime: VerifyCommandRuntime,
): Promise<number> {
  const opened = await openCryptoSource(options.inputPath);
  let report: VerificationReport;
  try {
    // 凭据/根证书都是小文件；输入 OFD 已作为随机访问源打开，不整包读取。
    const [credentials, roots] = await Promise.all([
      buildCryptoCredential(options.credentials),
      readTrustRoots(options.rootPaths),
    ]);
    report = await verifyOfd({
      source: opened.source,
      ...(credentials === undefined ? {} : { credentials }),
      ...(roots.length === 0 ? {} : { roots }),
      ...(options.sm2UserId === undefined ? {} : { sm2UserId: options.sm2UserId }),
      ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
    });
  } finally {
    // verifyOfd 只借用 byte-source，不关闭调用方文件句柄；成功/失败/取消都释放。
    await closeCryptoByteSource(opened.byteSource, runtime.logger);
  }

  reportCryptoWarnings(runtime.logger, report.warnings);

  const payload: CliVerifyJson = {
    command: 'verify',
    input: options.inputPath,
    report,
  };
  runtime.logger.info(
    options.json
      ? JSON.stringify(payload, null, 2)
      : formatVerifyText(payload, options.rootPaths.length),
  );
  runtime.logger.flushWarningSummary();
  return report.overall === 'valid' ? EXIT_CODES.OK : EXIT_CODES.VERIFY_FAILED;
}

/**
 * 生成 `verify` 的文本输出。
 *
 * @param payload 固定 JSON 结构
 * @param rootCount 本次配置的去重根路径数；仅在报告未命中任何信任锚时作为回退
 * @returns 多行文本
 */
export function formatVerifyText(payload: CliVerifyJson, rootCount?: number): string {
  const { report } = payload;
  const lines = [`验证结果: ${report.overall}`];
  if (report.decryption !== undefined && report.decryption.layers.length > 0) {
    lines.push(`解密: 已解密（${report.decryption.layers.length} 层）`);
  }
  lines.push(`完整性: ${formatIntegrity(report.integrity)}`);
  if (report.signatures.length === 0) {
    lines.push('签名: 无');
  } else {
    report.signatures.forEach((signature, index) => {
      lines.push(`签名 ${index + 1}: ${formatSignature(signature)}`);
      const timestamp = formatTimestamp(signature.timestamp);
      if (timestamp !== undefined) lines.push(`  时间戳: ${timestamp}`);
    });
  }
  const anchorCount = countTrustAnchors(report);
  // 优先展示命中的信任锚数量；一个 PEM bundle 含多张证书或同一根以不同
  // 路径重复传入时，按路径计数会偏大。未命中任何锚（如根不匹配）时回退
  // 到本次配置的去重路径数，避免显示“已配置 0”。
  const configuredCount =
    anchorCount > 0 ? anchorCount : Math.max(1, rootCount ?? 0);
  lines.push(
    report.rootsConfigured
      ? `根证书: 已配置 ${configuredCount} / 链 ${formatChainStatus(report)}`
      : `根证书: 未配置 / 链 ${formatChainStatus(report)}`,
  );
  return lines.join('\n');
}

/**
 * 统计报告中的信任根数量。
 *
 * 报告本身不保存根证书列表，仅记录是否配置；这里用签名与完整性链中
 * 命中的 `trustAnchor` 指纹去重计数，一个 PEM bundle 或多路径重复传入
 * 都不会放大数量。
 *
 * @param report 验证报告
 * @returns 命中的信任锚数量；可能为 0
 */
function countTrustAnchors(report: VerificationReport): number {
  const anchors = new Set<string>();
  for (const signature of report.signatures) {
    const anchor = signature.certificate.trustAnchor;
    if (anchor !== undefined) anchors.add(anchor.fingerprintSha256);
  }
  const integrityAnchor = report.integrity?.certificate.trustAnchor;
  if (integrityAnchor !== undefined) anchors.add(integrityAnchor.fingerprintSha256);
  return anchors.size;
}

/**
 * 汇总多签名与完整性的证书链状态。
 *
 * 按“签名顺序 + 完整性”顺序去重后以 `/` 连接，例如 `valid/incomplete`；
 * 没有任何证书链子项时显示 `unknown`。不做状态降级或改写，避免隐藏单个
 * 签名的问题。
 *
 * @param report 验证报告
 * @returns 展示用链状态文本
 */
function formatChainStatus(report: VerificationReport): string {
  const statuses = new Set<ChainStatus>();
  for (const signature of report.signatures) {
    statuses.add(signature.certificate.status);
  }
  if (report.integrity !== null) {
    statuses.add(report.integrity.certificate.status);
  }
  return statuses.size === 0 ? 'unknown' : [...statuses].join('/');
}

/**
 * 生成完整性文本。
 *
 * @param integrity 完整性结果；null 表示未保护
 * @returns 面向用户的单行文本
 */
function formatIntegrity(integrity: IntegrityVerification | null): string {
  if (integrity === null) return '未保护';
  return `${integrity.status}（FileList ${integrity.fileListCount}，缺失 ${integrity.missingFiles.length}，额外 ${integrity.extraFiles.length}）`;
}

/**
 * 生成单个签名文本。
 *
 * @param signature 签名结果
 * @returns 状态、SES 版本、引用与证书链摘要
 */
function formatSignature(signature: SignatureVerification): string {
  const id =
    signature.id.length === 0 ? '' : `${sanitizeDisplayText(signature.id)} `;
  const seal = signature.seal === undefined ? '' : `，印章 ${signature.seal.status}`;
  return `${id}${signature.status}（${formatSesVersion(signature.version)}，引用 ${signature.references.checked}/${signature.references.total}，证书链 ${signature.certificate.status}${seal}）`;
}

/**
 * 生成时间戳文本。
 *
 * @param timestamp 时间戳解析结果
 * @returns 文本；`not-present` 时返回 `undefined`
 */
function formatTimestamp(timestamp: TimestampParseResult): string | undefined {
  if (timestamp.status === 'not-present') return undefined;
  if (timestamp.status === 'parse-error') {
    const detail = timestamp.parseError?.message;
    return detail === undefined
      ? '解析失败'
      : `解析失败（${sanitizeDisplayText(detail)}）`;
  }
  const time =
    timestamp.genTime === undefined
      ? ''
      : `（${sanitizeDisplayText(timestamp.genTime)}）`;
  return `parsed-not-verified（${timestamp.note}）${time}`;
}

/**
 * 把 SES 版本代码转成展示名。
 *
 * @param version `v1`/`v4`/`v5`/`unknown`
 * @returns 展示名
 */
function formatSesVersion(version: SignatureVerification['version']): string {
  switch (version) {
    case 'v1':
    case 'v4':
    case 'v5':
      return `SES${version}`;
    default:
      return 'SES 未知';
  }
}