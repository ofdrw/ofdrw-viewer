/**
 * 证书链、信任根、有效期与 KeyUsage 校验（设计 §5.4）。
 *
 * 关键语义：
 * - 未配置信任根（roots 为空）时，证书结构/签名/有效期通过即判 `unknown`，
 *   不把“无法确定信任锚”当作失败，也不把缺 issuer 记成 incomplete。
 * - 配置信任根后，链必须锚定到根；链断为 `incomplete`，锚不是根为 `untrusted`。
 * - 证书签名算法仅支持 SM3withSM2；其他算法判 `unsupported`。
 * - 不检查 CRL/OCSP，`revocation` 固定 `not-checked`。
 */

import { OID_SM3_WITH_SM2, oidName } from '../asn1/oid';
import {
  checkCertificateValidity,
  type DistinguishedNameAttribute,
  type X509Certificate,
} from '../asn1/x509';
import { toCertificateSummary } from '../cert/summary';
import { sm2Verify } from '../sm/sm2';
import type { CertificateSummary } from '../types/certificate';
import type { CryptoLimits } from '../types/limits';
import type { ChainStatus, VerificationIssue } from '../types/status';
import type { CertificateChainVerification } from './types';

/** 证书链校验选项。 */
export interface VerifyChainOptions {
  /** 校验时间。 */
  readonly now: Date;
  /** 信任根证书；空数组表示未配置。 */
  readonly roots: readonly X509Certificate[];
  /** SM2 userId。 */
  readonly sm2UserId: string;
  /** 资源限制。 */
  readonly limits: CryptoLimits;
}

/** 链构建内部状态。 */
interface ChainBuildResult {
  readonly chain: readonly X509Certificate[];
  readonly anchor?: X509Certificate;
  readonly issues: VerificationIssue[];
  readonly expired: boolean;
  readonly notYetValid: boolean;
  readonly invalid: boolean;
  readonly unsupported: boolean;
  readonly incomplete: boolean;
  readonly untrusted: boolean;
}

/** 最大链长度（含叶与根）。 */
const MAX_CHAIN_LENGTH = 8;

/**
 * 校验证书链。
 *
 * @param signer 签名者证书；缺失时返回 `not-present`。
 * @param intermediates 中间/候选证书（不含 roots）。
 * @param options 时间/信任根/userId/限制。
 * @returns 证书链结果（不抛异常）。
 */
export function verifyCertificateChain(
  signer: X509Certificate | undefined,
  intermediates: readonly X509Certificate[],
  options: VerifyChainOptions,
): CertificateChainVerification {
  const trustRootConfigured = options.roots.length > 0;
  const currentTime = options.now.toISOString();
  if (!signer) {
    return {
      status: 'not-present',
      trustRootConfigured,
      chain: [],
      currentTime,
      revocation: 'not-checked',
      issues: [
        {
          code: 'CHAIN_NOT_PRESENT',
          message: '缺少签名者证书',
          severity: 'error',
        },
      ],
    };
  }

  const build = buildChain(signer, intermediates, options);
  const status = decideChainStatus(build, trustRootConfigured);
  return {
    status,
    trustRootConfigured,
    signer: toCertificateSummary(signer),
    trustAnchor: build.anchor ? toCertificateSummary(build.anchor) : undefined,
    chain: build.chain.map((certificate) => toCertificateSummary(certificate)),
    currentTime,
    revocation: 'not-checked',
    issues: build.issues,
  };
}

/**
 * 构建证书链并收集问题。
 *
 * @param signer 签名者证书。
 * @param intermediates 候选证书。
 * @param options 校验选项。
 * @returns 链构建结果。
 */
function buildChain(
  signer: X509Certificate,
  intermediates: readonly X509Certificate[],
  options: VerifyChainOptions,
): ChainBuildResult {
  const issues: VerificationIssue[] = [];
  const chain: X509Certificate[] = [signer];
  const seen = new Set<string>([signer.fingerprintSha256]);
  const candidates = [...intermediates, ...options.roots];
  let anchor: X509Certificate | undefined;
  let invalid = false;
  let unsupported = false;
  let incomplete = false;
  let untrusted = false;
  let expired = false;
  let notYetValid = false;

  const checkValidity = (certificate: X509Certificate, label: string): void => {
    let validity;
    try {
      validity = checkCertificateValidity(certificate, options.now);
    } catch {
      invalid = true;
      issues.push(issue('CHAIN_INVALID', `${label}证书有效期非法`, 'error'));
      return;
    }
    if (validity === 'expired') {
      expired = true;
      issues.push(
        issue('CHAIN_EXPIRED', `${label}证书已过期（${certificate.notAfterISO}）`, 'error'),
      );
    } else if (validity === 'not-yet-valid') {
      notYetValid = true;
      issues.push(
        issue(
          'CHAIN_NOT_YET_VALID',
          `${label}证书尚未生效（${certificate.notBeforeISO}）`,
          'error',
        ),
      );
    }
  };

  checkValidity(signer, '签名者');
  if (checkKeyUsage(signer, '签名者', true, issues) === 'invalid') invalid = true;

  if (options.roots.some((root) => sameCertificate(root, signer))) {
    anchor = signer;
    if (checkKeyUsage(signer, '信任根', false, issues) === 'invalid') invalid = true;
  } else {
    // 没有信任根时也尽量构建链，以便发现结构/签名/有效期问题；最终状态仍为 unknown。
    const result = walkChain(signer, candidates, options, issues, chain, seen);
    anchor = result.anchor;
    invalid = invalid || result.invalid;
    unsupported = result.unsupported;
    incomplete = result.incomplete;
    untrusted = result.untrusted;
    expired = expired || result.expired;
    notYetValid = notYetValid || result.notYetValid;
  }

  if (options.roots.length > 0 && !anchor && !invalid && !unsupported) {
    // 没有走到信任根：链断（缺中间）优先于锚不在根集合。
    if (!untrusted) incomplete = true;
  }

  return {
    chain,
    anchor,
    issues,
    expired,
    notYetValid,
    invalid,
    unsupported,
    incomplete,
    untrusted,
  };
}

/** `walkChain` 结果。 */
interface WalkResult {
  readonly anchor?: X509Certificate;
  readonly invalid: boolean;
  readonly unsupported: boolean;
  readonly incomplete: boolean;
  readonly untrusted: boolean;
  readonly expired: boolean;
  readonly notYetValid: boolean;
}

/**
 * 从签名者逐级向信任根遍历。
 *
 * @param signer 签名者证书。
 * @param candidates 候选证书（含 roots）。
 * @param options 校验选项。
 * @param issues 问题收集器。
 * @param chain 链（原地追加）。
 * @param seen 已访问证书指纹。
 * @returns 遍历结果。
 */
function walkChain(
  signer: X509Certificate,
  candidates: readonly X509Certificate[],
  options: VerifyChainOptions,
  issues: VerificationIssue[],
  chain: X509Certificate[],
  seen: Set<string>,
): WalkResult {
  let current = signer;
  let invalid = false;
  let unsupported = false;
  let incomplete = false;
  let untrusted = false;
  let expired = false;
  let notYetValid = false;

  for (let depth = 0; depth < MAX_CHAIN_LENGTH; depth += 1) {
    // 原始 DER 命中优先；DN 编码差异时同时接受语义相同的候选，最终仍以签名验证为准。
    const issuers = candidates.filter(
      (candidate) =>
        !sameCertificate(candidate, current) &&
        (sameRawBytes(candidate.subjectDer, current.issuerDer) ||
          sameDistinguishedName(candidate.subjectAttributes, current.issuerAttributes)),
    );
    if (issuers.length === 0) {
      if (isSelfSigned(current)) {
        untrusted = true;
        issues.push(issue('CHAIN_UNTRUSTED', '证书链止于自签名证书且不在信任根集合', 'error'));
      } else if (options.roots.length > 0) {
        // 未配置信任根时无法判断终点，保持 unknown；配置后缺 issuer 才是链不完整。
        incomplete = true;
        issues.push(issue('CHAIN_INCOMPLETE', '证书链缺少颁发者证书，无法到达信任根', 'error'));
      }
      break;
    }

    let issuer: X509Certificate | undefined;
    let sawInvalidSignature = false;
    for (const candidate of issuers) {
      if (current.signatureAlgorithm !== OID_SM3_WITH_SM2) {
        unsupported = true;
        issues.push(
          issue(
            'CHAIN_UNSUPPORTED',
            `不支持的证书签名算法：${oidName(current.signatureAlgorithm)}`,
            'error',
          ),
        );
        continue;
      }
      if (!candidate.isCA) {
        invalid = true;
        sawInvalidSignature = true;
        issues.push(
          issue('CHAIN_ISSUER_NOT_CA', '颁发者证书不是 CA（BasicConstraints.cA=false）', 'error'),
        );
        continue;
      }
      if (checkKeyUsage(candidate, '颁发者', false, issues) === 'invalid') {
        invalid = true;
        sawInvalidSignature = true;
        continue;
      }
      if (verifyCertificateSignature(current, candidate, options.sm2UserId)) {
        issuer = candidate;
        break;
      }
      sawInvalidSignature = true;
    }
    if (!issuer) {
      if (sawInvalidSignature) {
        invalid = true;
        issues.push(issue('CHAIN_SIGNATURE_INVALID', '证书签名与其颁发者公钥不匹配', 'error'));
      }
      break;
    }

    chain.push(issuer);
    const validity = checkCertificateValidity(issuer, options.now);
    if (validity === 'expired') {
      expired = true;
      issues.push(
        issue('CHAIN_EXPIRED', `证书已过期（${issuer.notAfterISO}）`, 'error'),
      );
    } else if (validity === 'not-yet-valid') {
      notYetValid = true;
      issues.push(
        issue('CHAIN_NOT_YET_VALID', `证书尚未生效（${issuer.notBeforeISO}）`, 'error'),
      );
    }
    if (!issuer.isCA) {
      invalid = true;
      issues.push(issue('CHAIN_ISSUER_NOT_CA', '链中证书不是 CA', 'error'));
      break;
    }
    if (
      issuer.pathLenConstraint !== undefined &&
      chain.length - 2 > issuer.pathLenConstraint
    ) {
      invalid = true;
      issues.push(
        issue(
          'CHAIN_PATH_LEN_EXCEEDED',
          `证书 pathLenConstraint=${issuer.pathLenConstraint}，但链中存在 ${chain.length - 2} 个中间 CA`,
          'error',
        ),
      );
    }

    if (options.roots.some((root) => sameCertificate(root, issuer))) {
      return { anchor: issuer, invalid, unsupported, incomplete, untrusted, expired, notYetValid };
    }
    if (isSelfSigned(issuer)) {
      untrusted = true;
      issues.push(issue('CHAIN_UNTRUSTED', '证书链止于非信任根的自签名证书', 'error'));
      break;
    }
    if (seen.has(issuer.fingerprintSha256)) {
      invalid = true;
      issues.push(issue('CHAIN_INVALID', '证书链存在循环', 'error'));
      break;
    }
    seen.add(issuer.fingerprintSha256);
    current = issuer;
    if (depth === MAX_CHAIN_LENGTH - 1 && options.roots.length > 0) {
      // 未配置 roots 时链终点不可判定，超长不能升级为 incomplete。
      incomplete = true;
      issues.push(issue('CHAIN_INCOMPLETE', '证书链长度超过上限', 'error'));
    }
  }

  return { invalid, unsupported, incomplete, untrusted, expired, notYetValid };
}

/**
 * 校验证书签名。
 *
 * @param certificate 子证书。
 * @param issuer 颁发者。
 * @param sm2UserId SM2 userId。
 * @returns 签名正确返回 true。
 */
function verifyCertificateSignature(
  certificate: X509Certificate,
  issuer: X509Certificate,
  sm2UserId: string,
): boolean {
  try {
    return sm2Verify(certificate.tbsDer, certificate.signature, issuer.publicKey, {
      userId: sm2UserId,
    });
  } catch {
    return false;
  }
}

/**
 * 判断是否自签名。
 *
 * @param certificate 证书。
 * @returns subject==issuer 且自签名验签通过。
 */
function isSelfSigned(certificate: X509Certificate): boolean {
  if (!sameDistinguishedName(certificate.subjectAttributes, certificate.issuerAttributes)) {
    return false;
  }
  try {
    return sm2Verify(certificate.tbsDer, certificate.signature, certificate.publicKey);
  } catch {
    return false;
  }
}

/**
 * 比较原始字节。
 *
 * @param a 字节 A。
 * @param b 字节 B。
 * @returns 相同返回 true。
 */
function sameRawBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * 比较 DER 证书是否一致。
 *
 * @param a 证书 A。
 * @param b 证书 B。
 * @returns 指纹相同返回 true。
 */
function sameCertificate(a: X509Certificate, b: X509Certificate): boolean {
  return a.fingerprintSha256 === b.fingerprintSha256;
}

/**
 * 比较两个 DN 的属性序列。
 *
 * @param a 属性序列 A。
 * @param b 属性序列 B。
 * @returns 完全一致返回 true。
 */
function sameDistinguishedName(
  a: readonly DistinguishedNameAttribute[],
  b: readonly DistinguishedNameAttribute[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((attribute, index) => {
    const other = b[index];
    return attribute.oid === other.oid && attribute.value === other.value;
  });
}

/**
 * 校验证书 KeyUsage。
 *
 * 叶证书需允许 digitalSignature 或 nonRepudiation；CA 需允许 keyCertSign。
 * KeyUsage 扩展缺失只记 warning；扩展存在但用途不符则阻断链。
 *
 * @param certificate 证书。
 * @param label 角色名。
 * @param leaf 是否叶证书。
 * @param issues 问题收集器。
 * @returns `ok` / `missing` / `invalid`。
 */
function checkKeyUsage(
  certificate: X509Certificate,
  label: string,
  leaf: boolean,
  issues: VerificationIssue[],
): 'ok' | 'missing' | 'invalid' {
  const usage = certificate.keyUsage;
  if (!usage) {
    issues.push(
      issue('CHAIN_KEY_USAGE_MISSING', `${label}证书缺少 KeyUsage 扩展`, 'warning'),
    );
    return 'missing';
  }
  const required = leaf ? ['digitalSignature', 'nonRepudiation'] : ['keyCertSign'];
  if (required.some((item) => (usage as readonly string[]).includes(item))) return 'ok';
  issues.push(
    issue(
      'CHAIN_KEY_USAGE_INVALID',
      `${label}证书 KeyUsage 未包含 ${required.join('/')}`,
      'error',
    ),
  );
  return 'invalid';
}

/**
 * 根据构建结果决定链状态。
 *
 * @param build 构建结果。
 * @param trustRootConfigured 是否配置信任根。
 * @returns 链状态。
 */
function decideChainStatus(
  build: ChainBuildResult,
  trustRootConfigured: boolean,
): ChainStatus {
  if (build.expired) return 'expired';
  if (build.notYetValid) return 'not-yet-valid';
  if (build.invalid) return 'invalid';
  if (build.unsupported) return 'unsupported';
  // 缺颁发者证书是确定的链不完整事实，先于“未配置信任根”的 unknown 报告。
  if (build.incomplete) return 'incomplete';
  if (!trustRootConfigured) return 'unknown';
  if (build.untrusted) return 'untrusted';
  if (build.anchor) return 'valid';
  return 'incomplete';
}

/**
 * 构造问题条目。
 *
 * @param code 问题码。
 * @param message 诊断信息。
 * @param severity 级别。
 * @returns 问题。
 */
function issue(
  code: string,
  message: string,
  severity: 'error' | 'warning',
): VerificationIssue {
  return { code, message, severity };
}
