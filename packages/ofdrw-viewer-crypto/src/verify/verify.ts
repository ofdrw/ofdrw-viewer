/**
 * 统一验证入口 `verifyOfd`（设计 §3.4、§5.1）。
 *
 * 约束：
 * - `source` 与 `container` 必须且只能提供一个；
 * - `container.encrypted=true` 直接拒绝，要求先 `openDecryptingContainer`；
 * - 加密 `source` 内部调用 `openDecryptingContainer`，验证后关闭临时明文容器；
 * - 只使用 `VirtualContainer.list/read` 与轻量 XML/ASN.1 解析，不打开 Canvas/字体/渲染器；
 * - 每个子项独立捕获错误并写入 `issues`，最终按 §5.7 聚合 `overall`；
 * - 时间戳只解析、不参与 `overall`。
 */

import { isOFDError, type VirtualContainer } from '@ofdrw/ofdrw-viewer-engine';
import { CryptoError, isCryptoError } from '../errors';
import { OID_SM3_WITH_SM2, oidName } from '../asn1/oid';
import type { X509Certificate } from '../asn1/x509';
import { loadCertificates } from '../cert/loader';
import { openDecryptingContainer } from '../decrypt';
import { parseSesEal } from '../seal/parse';
import { parseSesSignature, type SesSignatureDetail } from '../sign/ses';
import { parseSignatureXml, parseSignaturesXml, type SignatureRecord } from '../sign/signature-xml';
import { verifyReferences } from '../sign/references';
import { verifySesSignatureMath } from '../sign/verify';
import { listEntryPaths, findEntryBySuffix, readEntry } from '../sign/read';
import { packageDirName, resolvePackagePath } from '../sign/paths';
import { parseXml } from '../sign/xml';
import { sm3Hex } from '../sm/sm3';
import { sm2Verify } from '../sm/sm2';
import { parseTimestamp } from '../timestamp';
import type { CryptoLimits } from '../types/limits';
import type { VerificationIssue, VerificationStatus } from '../types/status';
import { bytesEqual } from '../util/bytes';
import { resolveCryptoOptions } from '../util/options';
import { createWarningCollector, type WarningCollector } from '../util/warning';
import { verifyIntegrity } from '../integrity/verify';
import { openCryptoContainer } from '../source';
import { verifyCertificateChain } from './chain';
import type {
  CertificateChainVerification,
  DecryptionReportInfo,
  IntegrityVerification,
  PackageVerificationInfo,
  SealVerification,
  SignatureVerification,
  VerificationReport,
  VerifyOfdOptions,
} from './types';

/** `verifyOfd` 参数校验。 */
function validateOptions(options: VerifyOfdOptions): void {
  if (!options || typeof options !== 'object') {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'verifyOfd 选项必须是对象');
  }
  if (options.source && options.container) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'source 与 container 只能提供一个');
  }
  if (!options.source && !options.container) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', '必须提供 source 或 container 之一');
  }
  if (options.signatureIds !== undefined) {
    if (!Array.isArray(options.signatureIds)) {
      throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'signatureIds 必须是字符串数组');
    }
    if (options.signatureIds.some((id) => typeof id !== 'string')) {
      throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'signatureIds 必须是字符串数组');
    }
  }
  if (options.roots !== undefined && !Array.isArray(options.roots)) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'roots 必须是数组');
  }
}

/**
 * 一次性验证完整性与文档签名。
 *
 * @param options 源/容器、凭据、根证书、限制。
 * @returns 分层验证报告。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT` / `CRYPTO_CREDENTIALS_REQUIRED` /
 *   `CRYPTO_INVALID_PACKAGE` / `CRYPTO_LIMIT_EXCEEDED` / `CRYPTO_ABORTED`。
 */
export async function verifyOfd(options: VerifyOfdOptions): Promise<VerificationReport> {
  validateOptions(options);
  const startedAt = new Date();
  const startedMs = Date.now();
  const resolved = resolveCryptoOptions(options);
  const collector = createWarningCollector(resolved.onWarning);
  const limits = resolved.limits;

  const roots = await loadCertificates(options.roots ?? [], {
    maxBytes: limits.maxAsn1Bytes,
    maxCertificates: Math.min(limits.maxTrustRoots, limits.maxCertificates),
    signal: resolved.signal,
    onWarning: (warning) => collector.emit(warning),
    invalidCode: 'CRYPTO_TRUST_ROOT_INVALID',
  });
  const rootsConfigured = (options.roots?.length ?? 0) > 0;

  let container: VirtualContainer;
  let ownsContainer = false;
  let decryption: DecryptionReportInfo | undefined;
  let encrypted = false;
  let decrypted = false;

  if (options.container) {
    if (options.container.encrypted) {
      throw new CryptoError(
        'CRYPTO_CREDENTIALS_REQUIRED',
        '容器仍为加密状态，请先使用 openDecryptingContainer 解密',
      );
    }
    container = options.container;
  } else {
    const opened = await openSourceContainer(options, limits, resolved.signal);
    if (!opened.container.encrypted) {
      if (options.credentials !== undefined) {
        collector.emit({
          code: 'W_CRYPTO_CREDENTIAL_IGNORED',
          message: '明文包不需要解密凭据，已忽略传入的 credentials',
        });
      }
      container = opened.container;
      ownsContainer = true;
    } else {
      await closeQuietly(opened.container);
      encrypted = true;
      const result = await openDecryptingContainer({
        source: options.source!,
        credentials: options.credentials,
        limits: options.limits,
        signal: resolved.signal,
        onWarning: (warning) => collector.emit(warning),
        sm2UserId: resolved.sm2UserId,
        now: resolved.now,
      });
      container = result.container;
      ownsContainer = true;
      decrypted = true;
      decryption = { layers: result.layers, plaintext: result.plaintext };
      for (const warning of result.warnings) collector.emit(warning);
    }
  }

  try {
    return await runVerification({
      container,
      roots,
      rootsConfigured,
      signatureIds: options.signatureIds,
      resolved,
      collector,
      encrypted,
      decrypted,
      decryption,
      startedAt,
      startedMs,
    });
  } finally {
    if (ownsContainer) await closeQuietly(container);
  }
}

/** 运行验证主流程的参数。 */
interface RunVerificationOptions {
  readonly container: VirtualContainer;
  readonly roots: readonly X509Certificate[];
  readonly rootsConfigured: boolean;
  readonly signatureIds?: readonly string[];
  readonly resolved: ReturnType<typeof resolveCryptoOptions>;
  readonly collector: WarningCollector;
  readonly encrypted: boolean;
  readonly decrypted: boolean;
  readonly decryption?: DecryptionReportInfo;
  readonly startedAt: Date;
  readonly startedMs: number;
}

/**
 * 执行验证并组装报告。
 *
 * @param options 已打开容器与配置。
 * @returns 验证报告。
 */
async function runVerification(options: RunVerificationOptions): Promise<VerificationReport> {
  const { container, resolved, collector } = options;
  const paths = listEntryPaths(container);
  const ofdXmlBytes = await readEntry('OFD.xml', {
    container,
    limits: resolved.limits,
    signal: resolved.signal,
  });
  let ofdVersion: string | undefined;
  let signaturesLoc: string | undefined;
  if (ofdXmlBytes) {
    try {
      const root = parseXml(ofdXmlBytes, {
        maxBytes: resolved.limits.maxAsn1Bytes,
        maxDepth: resolved.limits.maxAsn1Depth,
      });
      ofdVersion = root.attribute('Version');
      const declared = root.findPath('DocBody', 'Signatures')?.text;
      if (declared) signaturesLoc = resolvePackagePath('', declared);
    } catch (error) {
      collector.emit({
        code: 'W_CRYPTO_UNKNOWN_SES_VERSION',
        message: `OFD.xml 解析失败：${error instanceof Error ? error.message : '未知错误'}`,
      });
    }
  }

  const integrityResult = await verifyIntegrity({
    container,
    limits: resolved.limits,
    signal: resolved.signal,
    now: resolved.now,
    roots: options.roots,
    sm2UserId: resolved.sm2UserId,
    warnings: collector,
  });

  const signatures = await verifySignatures({
    container,
    paths,
    signaturesLoc,
    signatureIds: options.signatureIds,
    roots: options.roots,
    rootsConfigured: options.rootsConfigured,
    extraCertificates: integrityResult.certificates,
    resolved,
    collector,
  });

  const integrity = integrityResult.integrity;
  const overall = aggregateOverall(integrity, signatures);
  const packageInfo: PackageVerificationInfo = {
    ofdVersion,
    encrypted: options.encrypted,
    decrypted: options.decrypted,
    packageSize: container.packageSize,
    entryCount: paths.length,
    signatureCount: signatures.length,
    integrityPresent: integrity !== null,
  };

  return {
    overall,
    package: packageInfo,
    decryption: options.decryption,
    integrity,
    signatures,
    rootsConfigured: options.rootsConfigured,
    warnings: collector.warnings,
    startedAt: options.startedAt.toISOString(),
    durationMs: Date.now() - options.startedMs,
  };
}

/** 验证签名列表的参数。 */
interface VerifySignaturesOptions {
  readonly container: VirtualContainer;
  readonly paths: readonly string[];
  readonly signaturesLoc?: string;
  readonly signatureIds?: readonly string[];
  readonly roots: readonly X509Certificate[];
  readonly rootsConfigured: boolean;
  /** 完整性 SignedData 内嵌证书，用作签名/印章链的候选中间证书。 */
  readonly extraCertificates: readonly X509Certificate[];
  readonly resolved: ReturnType<typeof resolveCryptoOptions>;
  readonly collector: WarningCollector;
}

/**
 * 验证文档签名列表。
 *
 * @param options 容器与配置。
 * @returns 每个签名的验证结果。
 */
async function verifySignatures(
  options: VerifySignaturesOptions,
): Promise<readonly SignatureVerification[]> {
  const { container, resolved } = options;
  const signaturesLoc =
    options.signaturesLoc ??
    findEntryBySuffix(container, 'Signatures.xml', 'Signatures.xml');
  if (!signaturesLoc) return [];

  const listBytes = await readEntry(signaturesLoc, {
    container,
    limits: resolved.limits,
    signal: resolved.signal,
  });
  if (!listBytes) return [];

  let records: readonly SignatureRecord[];
  try {
    const parsed = parseSignaturesXml(listBytes, {
      maxBytes: resolved.limits.maxAsn1Bytes,
      maxDepth: resolved.limits.maxAsn1Depth,
    });
    records = parsed.signatures;
    if (records.length > resolved.limits.maxEntries) {
      throw new CryptoError(
        'CRYPTO_LIMIT_EXCEEDED',
        `签名数量 ${records.length} 超过上限 ${resolved.limits.maxEntries}`,
      );
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (isCryptoError(error) && error.code === 'CRYPTO_LIMIT_EXCEEDED') throw error;
    return [
      syntheticInvalidSignature(
        signaturesLoc,
        `Signatures.xml 解析失败：${error instanceof Error ? error.message : '未知错误'}`,
        resolved.sm2UserId,
      ),
    ];
  }

  const selected =
    options.signatureIds === undefined
      ? records
      : records.filter((record) => record.id !== undefined && options.signatureIds!.includes(record.id));
  const baseDir = packageDirName(signaturesLoc);
  const results: SignatureVerification[] = [];
  for (const record of selected) {
    results.push(
      await verifyOneSignature(record, {
        container,
        baseDir,
        roots: options.roots,
        rootsConfigured: options.rootsConfigured,
        extraCertificates: options.extraCertificates,
        resolved,
        collector: options.collector,
      }),
    );
  }
  return results;
}

/** 单个签名验证的参数。 */
interface VerifyOneOptions {
  readonly container: VirtualContainer;
  readonly baseDir: string;
  readonly roots: readonly X509Certificate[];
  readonly rootsConfigured: boolean;
  /** 完整性 SignedData 内嵌证书，用作签名/印章链的候选中间证书。 */
  readonly extraCertificates: readonly X509Certificate[];
  readonly resolved: ReturnType<typeof resolveCryptoOptions>;
  readonly collector: WarningCollector;
}

/**
 * 验证单个签名记录。
 *
 * @param record 签名记录。
 * @param options 容器与配置。
 * @returns 签名验证结果。
 */
async function verifyOneSignature(
  record: SignatureRecord,
  options: VerifyOneOptions,
): Promise<SignatureVerification> {
  const { container, resolved } = options;
  const issues: VerificationIssue[] = [];
  let baseLoc = record.baseLoc;
  let signatureDir = '';
  // 单条 BaseLoc 非法只影响该签名，不能中断其他签名。
  try {
    baseLoc = record.baseLoc.startsWith('/')
      ? resolvePackagePath('', record.baseLoc)
      : resolvePackagePath(options.baseDir, record.baseLoc);
    signatureDir = packageDirName(baseLoc);
  } catch (error) {
    issues.push(
      issue(
        'SIGNATURE_BASELOC_INVALID',
        `签名 BaseLoc 非法：${error instanceof Error ? error.message : '未知错误'}`,
        'error',
        record.baseLoc,
      ),
    );
    return baseSignatureResult(record, record.baseLoc, options, issues);
  }
  const base = baseSignatureResult(record, baseLoc, options, issues);

  try {
    const signatureXmlBytes = await readEntry(baseLoc, {
      container,
      limits: resolved.limits,
      signal: resolved.signal,
    });
    if (!signatureXmlBytes) {
      issues.push(
        issue('SIGNATURE_XML_MISSING', `缺少 Signature.xml：${baseLoc}`, 'error', baseLoc),
      );
      return base;
    }
    const signatureXml = parseSignatureXml(signatureXmlBytes, {
      maxBytes: resolved.limits.maxAsn1Bytes,
      maxDepth: resolved.limits.maxAsn1Depth,
    });
    const signedValuePath = resolvePackagePath(signatureDir, signatureXml.signedValueLoc);
    const signedValueBytes = await readEntry(signedValuePath, {
      container,
      limits: resolved.limits,
      signal: resolved.signal,
    });
    if (!signedValueBytes) {
      issues.push(
        issue(
          'SIGNED_VALUE_MISSING',
          `缺少 SignedValue.dat：${signedValuePath}`,
          'error',
          signedValuePath,
        ),
      );
      return { ...base, signedValuePath };
    }

    let ses: SesSignatureDetail;
    try {
      ses = parseSesSignature(signedValueBytes, {
        maxBytes: resolved.limits.maxAsn1Bytes,
        maxDepth: resolved.limits.maxAsn1Depth,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (isCryptoError(error) && error.code === 'CRYPTO_LIMIT_EXCEEDED') throw error;
      const unsupported =
        isCryptoError(error) && error.code === 'CRYPTO_UNSUPPORTED_SES_VERSION';
      issues.push(
        issue(
          unsupported ? 'CRYPTO_UNSUPPORTED_SES_VERSION' : 'CRYPTO_ASN1_INVALID',
          `SignedValue.dat 解析失败：${error instanceof Error ? error.message : '未知错误'}`,
          'error',
          signedValuePath,
        ),
      );
      if (unsupported) {
        return unsupportedSignatureResult(base, signedValuePath, issues, options);
      }
      return { ...base, signedValuePath };
    }

    let propertyInfoMatches = false;
    try {
      const declaredPath = ses.propertyInfo.trim().startsWith('/')
        ? resolvePackagePath('', ses.propertyInfo)
        : resolvePackagePath(signatureDir, ses.propertyInfo);
      propertyInfoMatches = declaredPath === baseLoc;
    } catch {
      propertyInfoMatches = false;
    }
    if (!propertyInfoMatches) {
      issues.push(
        issue(
          'SIGNATURE_PROPERTY_INFO_MISMATCH',
          `TBS_Sign.propertyInfo 与 Signature.xml 路径不一致：${ses.propertyInfo} != ${baseLoc}`,
          'error',
          baseLoc,
        ),
      );
    }

    const math = verifySesSignatureMath(ses, {
      sm2UserId: resolved.sm2UserId,
      maxAsn1Bytes: resolved.limits.maxAsn1Bytes,
      maxAsn1Depth: resolved.limits.maxAsn1Depth,
    });
    issues.push(...math.issues);
    const chain = verifyCertificateChain(
      math.signerCertificate,
      mergeCertificates(options.extraCertificates),
      {
        now: resolved.now,
        roots: options.roots,
        sm2UserId: resolved.sm2UserId,
        limits: resolved.limits,
      },
    );
    issues.push(...chain.issues);
    emitChainWarnings(chain.status, chain.issues, options.collector, options.rootsConfigured);

    const actualHash = sm3Hex(signatureXml.raw);
    const expectedHash = hexOf(ses.dataHash);
    const hashMatches = actualHash === expectedHash;
    if (!hashMatches) {
      issues.push(
        issue(
          'SIGNATURE_DATA_HASH_MISMATCH',
          'Signature.xml 的 SM3 与 SignedValue.dataHash 不一致（Signature.xml 可能被篡改）',
          'error',
          baseLoc,
        ),
      );
    }

    const references = await verifyReferences(signatureXml.references, {
      container,
      baseDir: signatureDir,
      checkMethod: signatureXml.checkMethod,
      limits: resolved.limits,
      signal: resolved.signal,
    });
    for (const failure of references.failures) {
      issues.push(
        issue(
          failure.reason === 'missing'
            ? 'REFERENCE_FILE_MISSING'
            : failure.reason === 'unsupported'
              ? 'REFERENCE_UNSUPPORTED'
              : 'REFERENCE_MISMATCH',
          `Reference 校验失败（${failure.reason}）：${failure.fileRef}`,
          'error',
          failure.fileRef,
        ),
      );
    }
    if (references.status === 'unsupported') {
      options.collector.emit({
        code: 'W_CRYPTO_REFERENCE_UNSUPPORTED',
        message: 'References 为空或 CheckMethod 不是 SM3，无法证明引用文件未被篡改',
        path: baseLoc,
      });
    }

    const seal = signatureXml.sealLoc
      ? await verifySeal(
          resolvePackagePath(signatureDir, signatureXml.sealLoc),
          ses,
          options,
        )
      : undefined;

    const timestamp = ses.timestampRaw
      ? parseTimestamp(ses.timestampRaw, {
          maxBytes: resolved.limits.maxAsn1Bytes,
          maxDepth: resolved.limits.maxAsn1Depth,
          signatureValue: ses.signature,
        })
      : base.timestamp;
    if (timestamp.messageImprintMatchesSignature === false) {
      options.collector.emit({
        code: 'W_CRYPTO_TIMESTAMP_IMPRINT_MISMATCH',
        message: '时间戳 messageImprint 与签章签名值不一致（仅提示，不改变时间戳状态）',
        path: baseLoc,
      });
    }
    if (timestamp.status === 'parse-error') {
      issues.push(
        timestamp.parseError ?? {
          code: 'CRYPTO_TIMESTAMP_PARSE',
          message: '时间戳解析失败',
          severity: 'warning',
        },
      );
      options.collector.emit({
        code: 'W_CRYPTO_TIMESTAMP_PARSE',
        message: '时间戳仅解析未验证，且解析失败',
        path: baseLoc,
      });
    }

    const status = aggregateSignatureStatus({
      math: math.math.status,
      dataHash: hashMatches ? 'valid' : 'invalid',
      references: references.status,
      propertyInfo: propertyInfoMatches ? 'valid' : 'invalid',
      chain: chain.status,
      rootsConfigured: options.rootsConfigured,
      seal: seal?.status,
    });
    return {
      id: record.id ?? '',
      type: record.type ?? '',
      version: ses.version,
      baseLoc,
      signedValuePath,
      status,
      signature: math.math,
      dataHash: {
        expected: expectedHash,
        actual: actualHash,
        status: hashMatches ? 'valid' : 'invalid',
      },
      references,
      certificate: chain,
      seal,
      timestamp,
      issues,
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (isCryptoError(error) && error.code === 'CRYPTO_LIMIT_EXCEEDED') throw error;
    issues.push(
      issue(
        'SIGNATURE_VERIFICATION_FAILED',
        `签名验证失败：${error instanceof Error ? error.message : '未知错误'}`,
        'error',
        baseLoc,
      ),
    );
    return base;
  }
}

/**
 * 构造“结构版本不支持”的印章证书链结果。
 *
 * @param options 验证配置。
 * @param now 校验时间。
 * @returns unsupported 链结果；不伪造 not-present。
 */
function unsupportedChain(
  options: VerifyOneOptions,
  now: Date,
): CertificateChainVerification {
  return {
    status: 'unsupported',
    trustRootConfigured: options.rootsConfigured,
    chain: [],
    currentTime: now.toISOString(),
    revocation: 'not-checked',
    issues: [],
  };
}

/**
 * 验证 Seal.esl 与 TBS_Sign 内嵌印章。
 *
 * @param eslPath Seal.esl 包内路径。
 * @param ses SignedValue 详细结构。
 * @param options 验证配置。
 * @returns 印章验证结果；Seal.esl 缺失时返回 invalid 结果。
 */
async function verifySeal(
  eslPath: string,
  ses: SesSignatureDetail,
  options: VerifyOneOptions,
): Promise<SealVerification> {
  const { container, resolved } = options;
  const issues: VerificationIssue[] = [];
  const emptyChain = verifyCertificateChain(undefined, [], {
    now: resolved.now,
    roots: options.roots,
    sm2UserId: resolved.sm2UserId,
    limits: resolved.limits,
  });
  const base: SealVerification = {
    status: 'invalid',
    version: 'unknown',
    eslPath,
    matchesSignedValue: false,
    math: { status: 'invalid', sm2UserId: resolved.sm2UserId },
    certificate: emptyChain,
    timestamp: {
      status: 'not-present',
      tokenPresent: false,
      tokenLength: 0,
      note: '已解析，未验证',
    },
    issues,
  };
  const eslBytes = await readEntry(eslPath, {
    container,
    limits: resolved.limits,
    signal: resolved.signal,
  });
  if (!eslBytes) {
    issues.push(issue('SEAL_ESL_MISSING', `缺少印章文件：${eslPath}`, 'error', eslPath));
    return base;
  }

  let sealDetail;
  try {
    sealDetail = parseSesEal(eslBytes, {
      maxBytes: resolved.limits.maxAsn1Bytes,
      maxDepth: resolved.limits.maxAsn1Depth,
      maxCertificates: resolved.limits.maxCertificates,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (isCryptoError(error) && error.code === 'CRYPTO_LIMIT_EXCEEDED') throw error;
    const unsupported =
      isCryptoError(error) && error.code === 'CRYPTO_UNSUPPORTED_SES_VERSION';
    if (unsupported) {
      issues.push(
        issue(
          'CRYPTO_UNSUPPORTED_SES_VERSION',
          `Seal.esl 结构版本不支持：${error instanceof Error ? error.message : '未知错误'}`,
          'error',
          eslPath,
        ),
      );
      return {
        status: 'unsupported',
        version: 'unknown',
        eslPath,
        matchesSignedValue: false,
        math: { status: 'unsupported', sm2UserId: resolved.sm2UserId },
        certificate: unsupportedChain(options, resolved.now),
        timestamp: base.timestamp,
        issues,
      };
    }
    issues.push(
      issue(
        'SEAL_PARSE_FAILED',
        `Seal.esl 解析失败：${error instanceof Error ? error.message : '未知错误'}`,
        'error',
        eslPath,
      ),
    );
    return base;
  }

  for (const warning of sealDetail.warnings) {
    issues.push(warning);
    options.collector.emit({
      code: 'W_CRYPTO_SEAL_PICTURE_INVALID',
      message: warning.message,
      path: eslPath,
    });
  }
  if (sealDetail.timestamp.status === 'parse-error') {
    issues.push(
      sealDetail.timestamp.parseError ?? {
        code: 'CRYPTO_TIMESTAMP_PARSE',
        message: '印章时间戳解析失败',
        severity: 'warning',
      },
    );
    options.collector.emit({
      code: 'W_CRYPTO_TIMESTAMP_PARSE',
      message: '印章时间戳仅解析未验证，且解析失败',
      path: eslPath,
    });
  }

  const matches = bytesEqual(sealDetail.raw, ses.esealRaw);
  if (!matches) {
    issues.push(
      issue(
        'SEAL_MISMATCH',
        'Seal.esl 与 SignedValue.dat 内嵌印章不一致',
        'error',
        eslPath,
      ),
    );
  }

  const algorithmName = sealDetail.signatureAlgorithmOid
    ? oidName(sealDetail.signatureAlgorithmOid)
    : undefined;
  let mathStatus: VerificationStatus = 'invalid';
  if (
    sealDetail.signatureAlgorithmOid !== OID_SM3_WITH_SM2 ||
    !sealDetail.signature ||
    !sealDetail.signedContent
  ) {
    mathStatus = 'unsupported';
    issues.push(
      issue(
        'SEAL_UNSUPPORTED',
        `不支持的印章签名算法或缺失签名值：${algorithmName ?? '未知'}`,
        'error',
        eslPath,
      ),
    );
  } else if (!sealDetail.makerCertificate) {
    issues.push(issue('SEAL_CERT_MISSING', '印章缺少制章者证书', 'error', eslPath));
  } else {
    let verified = false;
    try {
      verified = sm2Verify(
        sealDetail.signedContent,
        sealDetail.signature,
        sealDetail.makerCertificate.publicKey,
        { userId: resolved.sm2UserId },
      );
    } catch {
      verified = false;
    }
    mathStatus = verified ? 'valid' : 'invalid';
    if (!verified) {
      issues.push(issue('SEAL_SIGNATURE_INVALID', '印章签名值与印章信息不匹配', 'error', eslPath));
    }
  }

  const chain = verifyCertificateChain(
    sealDetail.makerCertificate,
    mergeCertificates(options.extraCertificates, sealDetail.certificates),
    {
      now: resolved.now,
      roots: options.roots,
      sm2UserId: resolved.sm2UserId,
      limits: resolved.limits,
    },
  );
  issues.push(...chain.issues);
  emitChainWarnings(chain.status, chain.issues, options.collector, options.rootsConfigured);

  const status = aggregateSealStatus(
    matches,
    mathStatus,
    chain.status,
    options.rootsConfigured,
  );
  return {
    status,
    version: sealDetail.version,
    esId: sealDetail.esId,
    name: sealDetail.name,
    eslPath,
    matchesSignedValue: matches,
    math: { status: mathStatus, algorithm: algorithmName, sm2UserId: resolved.sm2UserId },
    certificate: chain,
    timestamp: sealDetail.timestamp,
    issues,
  };
}

/**
 * 打开 source 对应的明文 ZIP 容器（仅用于识别是否加密）。
 *
 * @param options verify 选项。
 * @param limits 资源限制。
 * @param signal 取消信号。
 * @returns 容器（所有权归调用方）。
 */
async function openSourceContainer(
  options: VerifyOfdOptions,
  limits: CryptoLimits,
  signal?: AbortSignal,
): Promise<{ readonly container: VirtualContainer }> {
  try {
    const container = await openCryptoContainer(options.source!, limits, signal);
    if (signal?.aborted) {
      await closeQuietly(container);
      throw new CryptoError('CRYPTO_ABORTED', '操作已取消');
    }
    return { container };
  } catch (error) {
    throw mapEngineError(error);
  }
}

/**
 * 聚合单个签名状态（设计 §5.7）。
 *
 * @param statuses 子状态。
 * @returns 汇总状态。
 */
function aggregateSignatureStatus(statuses: {
  readonly math: VerificationStatus;
  readonly dataHash: VerificationStatus;
  readonly references: VerificationStatus;
  readonly propertyInfo: VerificationStatus;
  readonly chain: string;
  readonly rootsConfigured: boolean;
  readonly seal?: VerificationStatus;
}): VerificationStatus {
  const chain = mapChainStatus(statuses.chain, statuses.rootsConfigured);
  // References 无法校验时签名仍按 invalid（无法证明未篡改），沿用设计 §5.7。
  const reference = statuses.references === 'unsupported' ? 'invalid' : statuses.references;
  const all: VerificationStatus[] = [
    statuses.math,
    statuses.dataHash,
    reference,
    statuses.propertyInfo,
    chain,
    ...(statuses.seal ? [statuses.seal] : []),
  ];
  return aggregateStatuses(all);
}

/**
 * 聚合印章状态。
 *
 * @param matches Seal.esl 与内嵌印章是否一致。
 * @param math 印章签名数学验签。
 * @param chain 印章证书链状态。
 * @returns 汇总状态。
 */
function aggregateSealStatus(
  matches: boolean,
  math: VerificationStatus,
  chain: string,
  rootsConfigured: boolean,
): VerificationStatus {
  return aggregateStatuses([
    matches ? 'valid' : 'invalid',
    math,
    mapChainStatus(chain, rootsConfigured),
  ]);
}

/**
 * 聚合验证状态（invalid > unknown > unsupported > valid）。
 *
 * @param statuses 子状态。
 * @returns 汇总状态。
 */
function aggregateStatuses(statuses: readonly VerificationStatus[]): VerificationStatus {
  if (statuses.some((status) => status === 'invalid')) return 'invalid';
  if (statuses.some((status) => status === 'unknown')) return 'unknown';
  if (statuses.some((status) => status === 'unsupported')) return 'unsupported';
  if (statuses.every((status) => status === 'not-applicable')) return 'not-applicable';
  return 'valid';
}

/**
 * 聚合 overall（时间戳不参与）。
 *
 * @param integrity 完整性结果。
 * @param signatures 签名结果。
 * @returns overall。
 */
function aggregateOverall(
  integrity: IntegrityVerification | null,
  signatures: readonly SignatureVerification[],
): VerificationStatus {
  const statuses: VerificationStatus[] = [];
  if (integrity) statuses.push(integrity.status);
  for (const signature of signatures) statuses.push(signature.status);
  if (statuses.length === 0) return 'not-applicable';
  if (statuses.some((status) => status === 'invalid')) return 'invalid';
  if (statuses.some((status) => status === 'unknown')) return 'unknown';
  // 只要存在无法判定的项（integrity 或任一签名），整体即 unsupported。
  if (statuses.some((status) => status === 'unsupported')) return 'unsupported';
  return 'valid';
}

/**
 * 把证书链状态映射为验证状态（设计 §5.7）。
 *
 * @param status 链状态。
 * @returns 验证状态。
 */
function mapChainStatus(status: string, rootsConfigured: boolean): VerificationStatus {
  if (status === 'valid') return 'valid';
  if (status === 'unknown') return 'unknown';
  if (status === 'unsupported') return 'unsupported';
  // 未配置信任根时“缺中间证书”仍不可判定，整体保持 unknown；配置后才是失败。
  if (status === 'incomplete' && !rootsConfigured) return 'unknown';
  return 'invalid';
}

/**
 * 构造签名基础结果（未验证状态）。
 *
 * @param record 签名记录。
 * @param baseLoc Signature.xml 路径。
 * @param options 验证选项。
 * @param issues 问题列表。
 * @returns 基础签名结果。
 */
function baseSignatureResult(
  record: SignatureRecord,
  baseLoc: string,
  options: VerifyOneOptions,
  issues: VerificationIssue[],
): SignatureVerification {
  return {
    id: record.id ?? '',
    type: record.type ?? '',
    version: 'unknown',
    baseLoc,
    status: 'invalid',
    signature: { status: 'invalid', sm2UserId: options.resolved.sm2UserId },
    dataHash: { status: 'invalid' },
    references: { status: 'invalid', total: 0, checked: 0, failures: [] },
    certificate: verifyCertificateChain(undefined, [], {
      now: options.resolved.now,
      roots: options.roots,
      sm2UserId: options.resolved.sm2UserId,
      limits: options.resolved.limits,
    }),
    timestamp: {
      status: 'not-present',
      tokenPresent: false,
      tokenLength: 0,
      note: '已解析，未验证',
    },
    issues,
  };
}

/**
 * 构造“不支持的 SES 版本”签名结果。
 *
 * 版本未知时不构造 not-present 链，避免被聚合成 invalid。
 *
 * @param base 基础结果。
 * @param signedValuePath SignedValue.dat 路径。
 * @param issues 问题列表。
 * @param options 验证选项。
 * @returns unsupported 签名结果。
 */
function unsupportedSignatureResult(
  base: SignatureVerification,
  signedValuePath: string,
  issues: VerificationIssue[],
  options: VerifyOneOptions,
): SignatureVerification {
  return {
    ...base,
    signedValuePath,
    status: 'unsupported',
    signature: { status: 'unsupported', sm2UserId: options.resolved.sm2UserId },
    dataHash: { status: 'unsupported' },
    references: { status: 'unsupported', total: 0, checked: 0, failures: [] },
    certificate: {
      status: 'unsupported',
      trustRootConfigured: options.rootsConfigured,
      chain: [],
      currentTime: options.resolved.now.toISOString(),
      revocation: 'not-checked',
      issues: [],
    },
    issues,
  };
}

/**
 * 按 SHA-256 指纹去重合并证书列表。
 *
 * @param lists 证书列表（可多个）。
 * @returns 去重后的证书列表。
 */
function mergeCertificates(
  ...lists: readonly (readonly X509Certificate[])[]
): X509Certificate[] {
  const seen = new Set<string>();
  const merged: X509Certificate[] = [];
  for (const list of lists) {
    for (const certificate of list) {
      if (seen.has(certificate.fingerprintSha256)) continue;
      seen.add(certificate.fingerprintSha256);
      merged.push(certificate);
    }
  }
  return merged;
}

/**
 * 构造 Signatures.xml 解析失败时的签名结果。
 *
 * @param baseLoc Signatures.xml 路径。
 * @param message 失败原因。
 * @param sm2UserId SM2 userId。
 * @returns 无效签名结果。
 */
function syntheticInvalidSignature(
  baseLoc: string,
  message: string,
  sm2UserId: string,
): SignatureVerification {
  return {
    id: '',
    type: '',
    version: 'unknown',
    baseLoc,
    status: 'invalid',
    signature: { status: 'invalid', sm2UserId },
    dataHash: { status: 'invalid' },
    references: { status: 'invalid', total: 0, checked: 0, failures: [] },
    certificate: {
      status: 'not-present',
      trustRootConfigured: false,
      chain: [],
      currentTime: new Date().toISOString(),
      revocation: 'not-checked',
      issues: [],
    },
    timestamp: {
      status: 'not-present',
      tokenPresent: false,
      tokenLength: 0,
      note: '已解析，未验证',
    },
    issues: [issue('SIGNATURES_XML_INVALID', message, 'error', baseLoc)],
  };
}

/**
 * 上报证书链 warning。
 *
 * @param status 链状态。
 * @param chainIssues 链问题。
 * @param collector warning 收集器。
 */
function emitChainWarnings(
  status: string,
  chainIssues: readonly VerificationIssue[],
  collector: WarningCollector,
  rootsConfigured: boolean,
): void {
  if (
    !rootsConfigured &&
    (status === 'unknown' || status === 'incomplete' || status === 'untrusted')
  ) {
    collector.emit({
      code: 'W_CRYPTO_TRUST_UNKNOWN',
      message: '未配置信任根，证书链状态无法判定',
    });
  }
  if (chainIssues.some((item) => item.code === 'CHAIN_KEY_USAGE_MISSING')) {
    collector.emit({
      code: 'W_CRYPTO_KEY_USAGE_MISSING',
      message: '证书缺少 KeyUsage 扩展，无法确认签名用途',
    });
  }
}

/**
 * 把 engine 错误映射为 CryptoError。
 *
 * @param error 错误。
 * @returns CryptoError。
 */
function mapEngineError(error: unknown): CryptoError {
  if (isCryptoError(error)) return error;
  if (isOFDError(error)) {
    if (error.code === 'OFD_ABORTED') return new CryptoError('CRYPTO_ABORTED', '操作已取消');
    if (error.code === 'OFD_LIMIT_EXCEEDED') {
      return new CryptoError('CRYPTO_LIMIT_EXCEEDED', error.message);
    }
    return new CryptoError('CRYPTO_INVALID_PACKAGE', error.message);
  }
  return new CryptoError(
    'CRYPTO_INVALID_PACKAGE',
    error instanceof Error ? error.message : '打开 OFD 包失败',
  );
}

/**
 * 判断是否为取消错误。
 *
 * @param error 错误。
 * @returns 取消返回 true。
 */
function isAbortError(error: unknown): boolean {
  return isCryptoError(error) && error.code === 'CRYPTO_ABORTED';
}

/**
 * 静默关闭容器。
 *
 * @param container 容器。
 */
async function closeQuietly(container: VirtualContainer): Promise<void> {
  try {
    await container.close();
  } catch {
    // 关闭失败不覆盖验证结论。
  }
}

/**
 * 构造问题条目。
 *
 * @param code 问题码。
 * @param message 诊断信息。
 * @param severity 级别。
 * @param path 相关路径。
 * @returns 问题。
 */
function issue(
  code: string,
  message: string,
  severity: 'error' | 'warning',
  path?: string,
): VerificationIssue {
  return path ? { code, message, severity, path } : { code, message, severity };
}

/**
 * 字节转小写十六进制。
 *
 * @param bytes 字节。
 * @returns 小写十六进制。
 */
function hexOf(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
