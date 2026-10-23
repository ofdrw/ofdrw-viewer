/**
 * 防夹带完整性校验编排（设计 §5.5）。
 *
 * 输入必须是已解密的明文容器；校验内容：
 * 1. 定位 `OFDEntries.xml` 与其 `signedvalue.dat`（缺一视为未保护）；
 * 2. 用 GB/T 35275 验证签名（含 authenticatedAttributes / messageDigest）；
 * 3. 按 FileList 核对包内文件，识别缺失与新增夹带；
 * 4. 校验证书链（信任根由调用方提供）。
 */

import type { VirtualContainer } from '@ofdrw/ofdrw-viewer-engine';
import type { X509Certificate } from '../asn1/x509';
import type { CryptoLimits } from '../types/limits';
import type {
  ChainStatus,
  VerificationIssue,
  VerificationStatus,
} from '../types/status';
import type { WarningCollector } from '../util/warning';
import { listEntryPaths, readEntry } from '../sign/read';
import { normalizePackagePath, resolvePackagePath } from '../sign/paths';
import { verifyCertificateChain } from '../verify/chain';
import type { IntegrityVerification } from '../verify/types';
import { parseOfdEntriesXml } from './parse';
import { verifyGbt35275SignedData } from './signeddata';

/** 完整性校验选项。 */
export interface VerifyIntegrityOptions {
  /** 明文容器。 */
  readonly container: VirtualContainer;
  /** 资源限制。 */
  readonly limits: CryptoLimits;
  /** 取消信号。 */
  readonly signal?: AbortSignal;
  /** 当前时间。 */
  readonly now: Date;
  /** 信任根；空数组表示未配置。 */
  readonly roots: readonly X509Certificate[];
  /** SM2 userId。 */
  readonly sm2UserId: string;
  /** warning 收集器。 */
  readonly warnings: WarningCollector;
}

/** 完整性校验内部结果。 */
export interface IntegrityCheckResult {
  /** 完整性结果；无保护时为 null。 */
  readonly integrity: IntegrityVerification | null;
  /** 证书（供上层复用/展示）。 */
  readonly certificate?: X509Certificate;
  /** SignedData 内嵌的全部证书（供签名链补链）。 */
  readonly certificates: readonly X509Certificate[];
}

/** 清单签名值默认路径。 */
const DEFAULT_SIGNED_VALUE = 'signedvalue.dat';

/**
 * 校验防夹带完整性。
 *
 * @param options 容器/限制/信任根等。
 * @returns 完整性结果；无完整性保护时为 null。
 * @throws CryptoError `CRYPTO_INVALID_PACKAGE` / `CRYPTO_LIMIT_EXCEEDED` / `CRYPTO_ABORTED`。
 */
export async function verifyIntegrity(
  options: VerifyIntegrityOptions,
): Promise<IntegrityCheckResult> {
  const paths = listEntryPaths(options.container);
  const entriesPath = findEntriesPath(paths);
  if (!entriesPath) return { integrity: null, certificates: [] };
  const entriesBytes = await readEntry(entriesPath, {
    container: options.container,
    limits: options.limits,
    signal: options.signal,
  });
  if (!entriesBytes) return { integrity: null, certificates: [] };

  let entries;
  try {
    entries = parseOfdEntriesXml(entriesBytes, {
      maxBytes: options.limits.maxAsn1Bytes,
      maxDepth: options.limits.maxAsn1Depth,
    });
  } catch (error) {
    return {
      certificates: [],
      integrity: buildInvalid(
        entriesPath,
        DEFAULT_SIGNED_VALUE,
        0,
        countActualFiles(paths, entriesPath, DEFAULT_SIGNED_VALUE),
        [],
        [],
        options,
        [
          {
            code: 'INTEGRITY_ENTRIES_INVALID',
            message: error instanceof Error ? error.message : 'OFDEntries.xml 解析失败',
            severity: 'error',
            path: entriesPath,
          },
        ],
      ),
    };
  }

  let signedValuePath = DEFAULT_SIGNED_VALUE;
  try {
    if (entries.signedValueLoc) {
      signedValuePath = resolvePackagePath('', entries.signedValueLoc);
    }
  } catch (error) {
    return {
      certificates: [],
      integrity: buildInvalid(
        entriesPath,
        entries.signedValueLoc ?? DEFAULT_SIGNED_VALUE,
        entries.files.length,
        countActualFiles(paths, entriesPath, DEFAULT_SIGNED_VALUE),
        [],
        [],
        options,
        [
          {
            code: 'INTEGRITY_SIGNED_VALUE_LOC_INVALID',
            message: `SignedValueLoc 路径非法：${
              error instanceof Error ? error.message : '未知错误'
            }`,
            severity: 'error',
            path: entriesPath,
          },
        ],
      ),
    };
  }
  const signedValueBytes = await readEntry(signedValuePath, {
    container: options.container,
    limits: options.limits,
    signal: options.signal,
  });
  if (!signedValueBytes) {
    // 设计 §5.5：清单与签名值缺一 → 不伪造 valid，返回 null（未保护/不完整）。
    return { integrity: null, certificates: [] };
  }

  const signedData = verifyGbt35275SignedData(signedValueBytes, entriesBytes, {
    maxAsn1Bytes: options.limits.maxAsn1Bytes,
    maxAsn1Depth: options.limits.maxAsn1Depth,
    maxCertificates: options.limits.maxCertificates,
    sm2UserId: options.sm2UserId,
  });

  const certificate = signedData.certificate;
  const certificates = signedData.certificates;
  const intermediates = certificates.filter(
    (item) => certificate === undefined || item.fingerprintSha256 !== certificate.fingerprintSha256,
  );
  const chain = verifyCertificateChain(certificate, intermediates, {
    now: options.now,
    roots: options.roots,
    sm2UserId: options.sm2UserId,
    limits: options.limits,
  });
  emitChainWarnings(chain.status, chain.issues, options.warnings, options.roots.length > 0);

  const actualPaths = listEntryPaths(options.container).filter(
    (path) => path !== entriesPath && path !== signedValuePath,
  );
  const declared = new Set(entries.files.map((path) => normalizePackagePath(path)));
  const actual = new Set(actualPaths);
  const missingFiles = [...declared].filter((path) => !actual.has(path)).sort();
  const extraFiles = [...actual].filter((path) => !declared.has(path)).sort();

  const issues: VerificationIssue[] = [...signedData.issues];
  if (missingFiles.length > 0) {
    issues.push({
      code: 'INTEGRITY_FILE_MISSING',
      message: `清单登记但包内缺失 ${missingFiles.length} 个文件`,
      severity: 'error',
    });
  }
  if (extraFiles.length > 0) {
    issues.push({
      code: 'INTEGRITY_EXTRA_FILE',
      message: `包内存在 ${extraFiles.length} 个未登记的夹带文件`,
      severity: 'error',
      path: extraFiles[0],
    });
  }
  issues.push(...chain.issues);

  const status = aggregateIntegrityStatus(
    signedData.status,
    chain.status,
    missingFiles.length,
    extraFiles.length,
    options.roots.length > 0,
  );
  return {
    integrity: {
      status,
      entriesPath,
      signedValuePath,
      fileListCount: entries.files.length,
      actualFileCount: actualPaths.length,
      missingFiles,
      extraFiles,
      authenticatedAttributes: signedData.authenticatedAttributes,
      signature: {
        status: signedData.status,
        sm2UserId: options.sm2UserId,
      },
      certificate: chain,
      issues,
    },
    certificate,
    certificates,
  };
}

/**
 * 聚合完整性状态（设计 §5.7）。
 *
 * @param signatureStatus 签名状态。
 * @param chainStatus 证书链状态。
 * @param missingCount 缺失文件数。
 * @param extraCount 夹带文件数。
 * @param rootsConfigured 是否配置了信任根。
 * @returns 汇总状态。
 */
function aggregateIntegrityStatus(
  signatureStatus: VerificationStatus,
  chainStatus: ChainStatus,
  missingCount: number,
  extraCount: number,
  rootsConfigured: boolean,
): VerificationStatus {
  // 签名值本身不支持时，缺少可匹配证书不应把状态升级为 invalid。
  if (signatureStatus === 'unsupported' && chainStatus === 'not-present') {
    return 'unsupported';
  }
  if (
    signatureStatus === 'invalid' ||
    missingCount > 0 ||
    extraCount > 0 ||
    ['expired', 'not-yet-valid', 'untrusted', 'invalid', 'not-present'].includes(chainStatus)
  ) {
    return 'invalid';
  }
  // 无信任根时 incomplete 只说明链终点不可判定，不能把完整性判成 invalid。
  if (!rootsConfigured && chainStatus === 'incomplete') return 'unknown';
  if (signatureStatus === 'unknown' || chainStatus === 'unknown') return 'unknown';
  if (chainStatus === 'incomplete') return 'invalid';
  if (signatureStatus === 'unsupported' || chainStatus === 'unsupported') return 'unsupported';
  return 'valid';
}

/**
 * 查找 OFDEntries.xml 路径。
 *
 * @param paths 容器路径列表。
 * @returns 包内路径；不存在时 undefined。
 */
function findEntriesPath(paths: readonly string[]): string | undefined {
  // 根清单优先：避免同名嵌套清单抢先命中。
  if (paths.includes('OFDEntries.xml')) return 'OFDEntries.xml';
  const nested = paths
    .filter((path) => path.endsWith('/OFDEntries.xml'))
    .sort();
  return nested[0];
}

/**
 * 统计实际文件数（解析失败时用于报告）。
 *
 * @param paths 全部路径。
 * @param entriesPath 清单路径。
 * @param signedValuePath 签名值路径。
 * @returns 文件数。
 */
function countActualFiles(
  paths: readonly string[],
  entriesPath: string,
  signedValuePath: string,
): number {
  return paths.filter((path) => path !== entriesPath && path !== signedValuePath).length;
}

/**
 * 构造解析失败时的完整性结果。
 *
 * @param entriesPath 清单路径。
 * @param signedValuePath 签名值路径。
 * @param fileListCount 清单文件数。
 * @param actualFileCount 实际文件数。
 * @param missingFiles 缺失文件。
 * @param extraFiles 夹带文件。
 * @param _certificate 未使用。
 * @param options 校验选项。
 * @param issues 问题列表。
 * @returns 无效的完整性结果。
 */
function buildInvalid(
  entriesPath: string,
  signedValuePath: string,
  fileListCount: number,
  actualFileCount: number,
  missingFiles: readonly string[],
  extraFiles: readonly string[],
  options: VerifyIntegrityOptions,
  issues: readonly VerificationIssue[],
): IntegrityVerification {
  return {
    status: 'invalid',
    entriesPath,
    signedValuePath,
    fileListCount,
    actualFileCount,
    missingFiles,
    extraFiles,
    authenticatedAttributes: false,
    signature: { status: 'invalid', sm2UserId: options.sm2UserId },
    certificate: verifyCertificateChain(undefined, [], {
      now: options.now,
      roots: options.roots,
      sm2UserId: options.sm2UserId,
      limits: options.limits,
    }),
    issues,
  };
}

/**
 * 上报证书链相关 warning。
 *
 * @param status 链状态。
 * @param issues 链问题。
 * @param warnings warning 收集器。
 */
function emitChainWarnings(
  status: ChainStatus,
  issues: readonly VerificationIssue[],
  warnings: WarningCollector,
  rootsConfigured: boolean,
): void {
  if (
    !rootsConfigured &&
    (status === 'unknown' || status === 'incomplete' || status === 'untrusted')
  ) {
    warnings.emit({
      code: 'W_CRYPTO_TRUST_UNKNOWN',
      message: '未配置信任根，证书链状态无法判定',
    });
  }
  if (issues.some((item) => item.code === 'CHAIN_KEY_USAGE_MISSING')) {
    warnings.emit({
      code: 'W_CRYPTO_KEY_USAGE_MISSING',
      message: '证书缺少 KeyUsage 扩展，无法确认签名用途',
    });
  }
}