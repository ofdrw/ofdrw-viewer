/**
 * 统一验证报告类型（对应设计方案 §3.6）。
 *
 * `verifyOfd` 只产出报告，不抛验证失败异常；只有入口参数/容器/凭据/包结构
 * 错误才抛 `CryptoError`。
 */

import type { VirtualContainer } from '@ofdrw/ofdrw-viewer-engine';
import type { DecryptionLayerSummary } from '../decrypt';
import type { CertificateDer, CertificateSummary } from '../types/certificate';
import type { CryptoCredential } from '../types/credentials';
import type { CryptoOptions } from '../types/options';
import type { CryptoSource } from '../types/source';
import type {
  ChainStatus,
  TimestampStatus,
  VerificationIssue,
  VerificationStatus,
} from '../types/status';
import type { CryptoWarning } from '../types/warnings';
import type { ReferenceCheckResult, SignatureMathResult } from '../sign/types';
import type { SesVersion } from '../seal/parse';
import type { TimestampParseResult } from '../timestamp/types';

/** 证书链校验结果。 */
export interface CertificateChainVerification {
  /** 链状态；未配置信任根且未发现错误时为 `unknown`。 */
  readonly status: ChainStatus;
  /** 本次是否配置了信任根。 */
  readonly trustRootConfigured: boolean;
  /** 待验证的签名者证书。 */
  readonly signer?: CertificateSummary;
  /** 命中的信任根证书。 */
  readonly trustAnchor?: CertificateSummary;
  /** 从签名者到信任锚的证书链（摘要形式）。 */
  readonly chain: readonly CertificateSummary[];
  /** 校验使用的当前时间（ISO 8601）。 */
  readonly currentTime: string;
  /** 吊销状态；当前实现不检查 CRL/OCSP。 */
  readonly revocation: 'not-checked';
  /** 问题列表。 */
  readonly issues: readonly VerificationIssue[];
}

/** 电子印章校验结果。 */
export interface SealVerification {
  /** 汇总状态。 */
  readonly status: VerificationStatus;
  /** 印章结构版本。 */
  readonly version: SesVersion;
  /** 印章标识。 */
  readonly esId?: string;
  /** 印章名称。 */
  readonly name?: string;
  /** Seal.esl 包内路径。 */
  readonly eslPath?: string;
  /** Seal.esl 与 TBS_Sign 内嵌 SESeal 的 DER 是否逐字节一致（不等于验签通过）。 */
  readonly matchesSignedValue: boolean;
  /** 制章人签名数学验签结果。 */
  readonly math: SignatureMathResult;
  /** 制章者证书链。 */
  readonly certificate: CertificateChainVerification;
  /** 时间戳解析（只解析不验证，不参与 overall）。 */
  readonly timestamp: TimestampParseResult;
  /** 问题列表。 */
  readonly issues: readonly VerificationIssue[];
}

/** 数据摘要比对结果。 */
export interface DataHashVerification {
  /** 期望值（SignedValue.TBS_Sign.dataHash，小写十六进制）。 */
  readonly expected?: string;
  /** 实际值（Signature.xml 字节的 SM3，小写十六进制）。 */
  readonly actual?: string;
  /** 比对状态。 */
  readonly status: VerificationStatus;
}

/** 单个文档签名校验结果。 */
export interface SignatureVerification {
  /** 签名 ID。 */
  readonly id: string;
  /** 签名类型：Seal / Sign。 */
  readonly type: string;
  /** SignedValue 结构版本。 */
  readonly version: SesVersion;
  /** Signature.xml 包内路径。 */
  readonly baseLoc: string;
  /** SignedValue.dat 包内路径。 */
  readonly signedValuePath?: string;
  /** 汇总状态。 */
  readonly status: VerificationStatus;
  /** 签名数学验签结果。 */
  readonly signature: SignatureMathResult;
  /** dataHash 比对结果。 */
  readonly dataHash: DataHashVerification;
  /** Reference CheckValue 校验结果。 */
  readonly references: ReferenceCheckResult;
  /** 签章者证书链。 */
  readonly certificate: CertificateChainVerification;
  /** 印章校验；无 Seal 节点时省略。 */
  readonly seal?: SealVerification;
  /** 时间戳解析（永不参与 overall）。 */
  readonly timestamp: TimestampParseResult;
  /** 问题列表。 */
  readonly issues: readonly VerificationIssue[];
}

/** 防夹带完整性校验结果。 */
export interface IntegrityVerification {
  /** 汇总状态。 */
  readonly status: VerificationStatus;
  /** `OFDEntries.xml` 包内路径。 */
  readonly entriesPath: string;
  /** `signedvalue.dat` 包内路径。 */
  readonly signedValuePath: string;
  /** FileList 登记文件数。 */
  readonly fileListCount: number;
  /** 包内实际文件数（不含 OFDEntries.xml 与 signedvalue.dat）。 */
  readonly actualFileCount: number;
  /** 清单登记但包内缺失的文件。 */
  readonly missingFiles: readonly string[];
  /** 包内存在但清单未登记的夹带文件。 */
  readonly extraFiles: readonly string[];
  /** 签名是否包含 authenticatedAttributes。 */
  readonly authenticatedAttributes: boolean;
  /** 完整性签名数学验签结果。 */
  readonly signature: SignatureMathResult;
  /** 完整性签名证书链。 */
  readonly certificate: CertificateChainVerification;
  /** 问题列表。 */
  readonly issues: readonly VerificationIssue[];
}

/** 包级信息。 */
export interface PackageVerificationInfo {
  /** OFD.xml@Version。 */
  readonly ofdVersion?: string;
  /** 原始包是否为加密包。 */
  readonly encrypted: boolean;
  /** verifyOfd 内部是否执行了解密。 */
  readonly decrypted: boolean;
  /** 包大小，单位 byte。 */
  readonly packageSize: number;
  /** 文件条目数。 */
  readonly entryCount: number;
  /** 签名数量。 */
  readonly signatureCount: number;
  /** 是否存在完整性保护（OFDEntries.xml + signedvalue.dat）。 */
  readonly integrityPresent: boolean;
}

/** 解密报告信息。 */
export interface DecryptionReportInfo {
  /** 逐层解密摘要。 */
  readonly layers: readonly DecryptionLayerSummary[];
  /** 验证使用的容器是否为明文。 */
  readonly plaintext: boolean;
}

/** 统一验证报告。 */
export interface VerificationReport {
  /** 汇总状态（时间戳不参与）。 */
  readonly overall: VerificationStatus;
  /** 包级信息。 */
  readonly package: PackageVerificationInfo;
  /** 加密源内部解密时的摘要；明文容器时省略。 */
  readonly decryption?: DecryptionReportInfo;
  /** 完整性校验；无完整性保护时为 null。 */
  readonly integrity: IntegrityVerification | null;
  /** 每个签名的校验结果。 */
  readonly signatures: readonly SignatureVerification[];
  /** 是否配置了信任根。 */
  readonly rootsConfigured: boolean;
  /** 本次验证产生的全部 warning。 */
  readonly warnings: readonly CryptoWarning[];
  /** 开始时间（ISO 8601）。 */
  readonly startedAt: string;
  /** 耗时，单位毫秒。 */
  readonly durationMs: number;
}

/** `verifyOfd` 选项。 */
export interface VerifyOfdOptions extends CryptoOptions {
  /** 与 `container` 二选一；加密源会自动调用 `openDecryptingContainer`。 */
  readonly source?: CryptoSource;
  /** 已解密的容器；`encrypted=true` 时拒绝。 */
  readonly container?: VirtualContainer;
  /** 解密凭据；仅加密 `source` 使用。 */
  readonly credentials?: CryptoCredential | readonly CryptoCredential[];
  /** 信任根；每项一张证书 DER；空数组/省略 = 未配置，链状态 unknown。 */
  readonly roots?: readonly CertificateDer[];
  /** 只验证指定签名 ID；省略验证全部。 */
  readonly signatureIds?: readonly string[];
}

/** 时间戳状态再导出，方便 UI 直接使用。 */
export type { TimestampStatus };