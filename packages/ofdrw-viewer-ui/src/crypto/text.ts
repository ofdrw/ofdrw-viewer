/**
 * 密码能力 UI 文案。
 *
 * 覆盖凭据弹窗、验证面板、签章详情与印章浮层；工具栏/功能名仍使用全局 i18n 字典。
 */

/** 密码 UI 文案键。 */
export interface CryptoText {
  /** 凭据弹窗标题。 */
  readonly credentialTitle: string;
  /** 凭据弹窗说明。 */
  readonly credentialDescription: string;
  /** 用户选择。 */
  readonly credentialUser: string;
  /** 用户占位提示。 */
  readonly credentialUserPlaceholder: string;
  /** 凭据方式。 */
  readonly credentialMode: string;
  /** 口令。 */
  readonly credentialPassword: string;
  /** 私钥文件。 */
  readonly credentialPrivateKey: string;
  /** 私钥文件提示。 */
  readonly credentialPrivateKeyHint: string;
  /** 私钥口令。 */
  readonly credentialPassphrase: string;
  /** 打开按钮。 */
  readonly credentialSubmit: string;
  /** 取消按钮。 */
  readonly credentialCancel: string;
  /** 解密中。 */
  readonly credentialLoading: string;
  /** 缺少凭据。 */
  readonly credentialRequired: string;
  /** 口令错误。 */
  readonly credentialWrongPassword: string;
  /** 私钥不可用。 */
  readonly credentialPrivateKeyInvalid: string;
  /** 私钥需要口令。 */
  readonly credentialPassphraseRequired: string;
  /** 解密失败。 */
  readonly credentialDecryptFailed: string;
  /** 未选择用户。 */
  readonly credentialUserRequired: string;
  /** 未填写口令。 */
  readonly credentialPasswordRequired: string;
  /** 未选择私钥。 */
  readonly credentialKeyRequired: string;
  /** 加密文档不支持。 */
  readonly cryptoUnsupported: string;
  /** 取消打开。 */
  readonly cryptoCancelled: string;
  /** 验证面板标题。 */
  readonly panelTitle: string;
  /** 验证面板加载。 */
  readonly panelLoading: string;
  /** 尚未验证。 */
  readonly panelNotVerified: string;
  /** 重新验证。 */
  readonly panelReverify: string;
  /** 签发时间。 */
  readonly signingTime: string;
  /** 签发时间未提供。 */
  readonly signingTimeMissing: string;
  /** 总体状态。 */
  readonly overall: string;
  /** 包信息。 */
  readonly packageInfo: string;
  /** 是否加密。 */
  readonly packageEncrypted: string;
  /** 是否已解密。 */
  readonly packageDecrypted: string;
  /** 页数。 */
  readonly packagePages: string;
  /** 签名数。 */
  readonly packageSignatures: string;
  /** 完整性保护。 */
  readonly packageIntegrity: string;
  /** 有完整性保护 / 未保护。 */
  readonly present: string;
  readonly absent: string;
  /** 完整性卡片。 */
  readonly integrity: string;
  /** 文件清单数量。 */
  readonly integrityFiles: string;
  /** 缺失文件。 */
  readonly integrityMissing: string;
  /** 夹带文件。 */
  readonly integrityExtra: string;
  /** 签名卡片。 */
  readonly signatureCard: string;
  /** SES 版本。 */
  readonly sesVersion: string;
  /** dataHash。 */
  readonly dataHash: string;
  /** Reference。 */
  readonly references: string;
  /** 数学签名。 */
  readonly math: string;
  /** 证书链。 */
  readonly chain: string;
  /** 证书链独立说明。 */
  readonly chainIndependent: string;
  /** 证书链独立验证栏标题。 */
  readonly chainSectionTitle: string;
  /** 链状态。 */
  readonly chainStatus: string;
  /** 是否配置信任根。 */
  readonly chainRootsConfigured: string;
  /** 是。 */
  readonly yes: string;
  /** 否。 */
  readonly no: string;
  /** 签名者证书。 */
  readonly chainSignerCertificate: string;
  /** 信任锚。 */
  readonly chainTrustAnchor: string;
  /** 未找到信任锚。 */
  readonly chainTrustAnchorMissing: string;
  /** 链成员。 */
  readonly chainMembers: string;
  /** 无报告时链未验证说明。 */
  readonly chainNotVerified: string;
  /** 证书链不影响签名/完整性结果。 */
  readonly chainIndependentNote: string;
  /** 印章。 */
  readonly seal: string;
  /** 时间戳。 */
  readonly timestamp: string;
  /** 无。 */
  readonly none: string;
  /** 根证书区。 */
  readonly roots: string;
  /** 未配置根证书。 */
  readonly rootsNone: string;
  /** 根证书提示。 */
  readonly rootsHint: string;
  /** 添加根证书。 */
  readonly rootsAdd: string;
  /** 删除。 */
  readonly rootsRemove: string;
  /** 根证书主题。 */
  readonly rootsSubject: string;
  /** 根证书颁发者。 */
  readonly rootsIssuer: string;
  /** 根证书序列号。 */
  readonly rootsSerial: string;
  /** 根证书指纹。 */
  readonly rootsFingerprint: string;
  /** 根证书有效期。 */
  readonly rootsValidity: string;
  /** 根证书解析失败。 */
  readonly rootsInvalid: string;
  /** 根证书已添加。 */
  readonly rootsAdded: string;
  /** 未配置根证书时链状态说明。 */
  readonly rootsUnknownNote: string;
  /** 验证问题。 */
  readonly issues: string;
  /** 可信。 */
  readonly trusted: string;
  /** 可信状态未知。 */
  readonly trustUnknown: string;
  /** 下载证书。 */
  readonly downloadCertificate: string;
  /** 签章者证书。 */
  readonly signerCertificate: string;
  /** 未找到签章者证书。 */
  readonly signerCertificateMissing: string;
  /** 查看签章详情。 */
  readonly viewDetails: string;
  /** 关闭。 */
  readonly close: string;
  /** 未验证（印章浮层）。 */
  readonly notVerified: string;
  /** 已解析，未验证。 */
  readonly timestampParsedNotVerified: string;
  /** 时间戳不参与总体状态。 */
  readonly timestampNotInOverall: string;
  /** 生成时间（UTC+8）。 */
  readonly timestampGenTime: string;
  /** TSA 主体。 */
  readonly timestampTsa: string;
  /** 时间戳序列号。 */
  readonly timestampSerial: string;
  /** 时间戳策略。 */
  readonly timestampPolicy: string;
  /** 未包含时间戳。 */
  readonly timestampMissing: string;
  /** 未配置与签章链匹配的信任根。 */
  readonly trustRootMissing: string;
  /** 导入根证书引导。 */
  readonly trustRootGuidance: string;
  /** 信任根与签章链不匹配。 */
  readonly trustRootMismatch: string;
  /** 不匹配根的处理引导。 */
  readonly trustRootMismatchGuidance: string;
  /** 数学签名有效不等于总体有效。 */
  readonly signatureMathNotTrust: string;
  /** 时间戳不可解析。 */
  readonly timestampUnparsable: string;
  /** 签名者。 */
  readonly signer: string;
  /** 验签状态。 */
  readonly overallValid: string;
  readonly overallInvalid: string;
  readonly overallUnknown: string;
  readonly overallNotApplicable: string;
  readonly overallUnsupported: string;
  /** 链状态。 */
  readonly chainExpired: string;
  readonly chainNotYetValid: string;
  readonly chainUntrusted: string;
  readonly chainIncomplete: string;
  readonly chainNotPresent: string;
  /** 验证失败。 */
  readonly verifyFailed: string;
  /** 文档未打开。 */
  readonly notOpened: string;
  /** 密码能力已禁用。 */
  readonly cryptoDisabled: string;
  /** 凭据方式名称。 */
  readonly methodPassword: string;
  readonly methodCertificate: string;
  readonly methodUnknown: string;
}

/** 简体中文文案。 */
const ZH: CryptoText = {
  credentialTitle: '打开加密文档',
  credentialDescription: '文档已加密，请选择用户并提供凭据。',
  credentialUser: '用户',
  credentialUserPlaceholder: '请选择用户',
  credentialMode: '凭据方式',
  credentialPassword: '口令',
  credentialPrivateKey: 'SM2 私钥文件',
  credentialPrivateKeyHint: '支持 .pem/.der/.key/.pk8；私钥仅在本页内存中使用',
  credentialPassphrase: '私钥口令（可选）',
  credentialSubmit: '打开',
  credentialCancel: '取消',
  credentialLoading: '正在解密…',
  credentialRequired: '该文档已加密，需要提供凭据',
  credentialWrongPassword: '口令错误或用户不匹配',
  credentialPrivateKeyInvalid: '私钥无法用于该用户',
  credentialPassphraseRequired: '该私钥已加密，请输入私钥口令',
  credentialDecryptFailed: '解密失败，请检查凭据后重试',
  credentialUserRequired: '请选择用户',
  credentialPasswordRequired: '请输入口令',
  credentialKeyRequired: '请选择私钥文件',
  cryptoUnsupported: '当前未启用密码能力，无法打开加密文档',
  cryptoCancelled: '已取消打开加密文档',
  panelTitle: '验证结果',
  panelLoading: '正在验证…',
  panelNotVerified: '尚未验证本文档',
  panelReverify: '重新验证',
  signingTime: '签发时间',
  signingTimeMissing: '未提供',
  overall: '总体状态',
  packageInfo: '文档信息',
  packageEncrypted: '是否加密',
  packageDecrypted: '是否已解密',
  packagePages: '页数',
  packageSignatures: '签名数',
  packageIntegrity: '完整性保护',
  present: '有',
  absent: '未保护',
  integrity: '防夹带完整性',
  integrityFiles: '清单文件数',
  integrityMissing: '缺失文件',
  integrityExtra: '夹带文件',
  signatureCard: '签名',
  sesVersion: 'SES 版本',
  dataHash: 'dataHash',
  references: 'Reference',
  math: '数学签名',
  chain: '证书链',
  chainIndependent: '证书链（不影响总体状态）',
  chainSectionTitle: '根证书链验证',
  chainStatus: '链状态',
  chainRootsConfigured: '是否配置信任根',
  yes: '是',
  no: '否',
  chainSignerCertificate: '签名者证书',
  chainTrustAnchor: '信任锚',
  chainTrustAnchorMissing: '未找到信任锚',
  chainMembers: '链成员',
  chainNotVerified: '未验证：尚未生成验证报告，证书链未校验。',
  chainIndependentNote: '证书链结果独立展示，不影响签名/完整性验证结果。',
  seal: '印章',
  timestamp: '时间戳',
  none: '无',
  roots: '信任根证书',
  rootsNone: '未配置根证书',
  rootsHint: '根证书只用于验证信任锚，不会上传或写入文档',
  rootsAdd: '配置根证书',
  rootsRemove: '删除',
  rootsSubject: '主题',
  rootsIssuer: '颁发者',
  rootsSerial: '序列号',
  rootsFingerprint: '指纹',
  rootsValidity: '有效期',
  rootsInvalid: '根证书解析失败，已忽略',
  rootsAdded: '根证书已添加',
  rootsUnknownNote: '未配置根证书，证书链状态 unknown',
  issues: '问题',
  trusted: '可信',
  trustUnknown: '可信状态未知',
  downloadCertificate: '下载证书 (.der)',
  signerCertificate: '签章者证书',
  signerCertificateMissing: '未找到签章者证书',
  viewDetails: '查看签章详情',
  close: '关闭',
  notVerified: '未验证',
  timestampParsedNotVerified: '已解析，未验证',
  timestampNotInOverall: '不参与总体状态',
  timestampGenTime: '生成时间（UTC+8）',
  timestampTsa: 'TSA',
  timestampSerial: '序列号',
  timestampPolicy: '策略',
  timestampMissing: '未包含',
  trustRootMissing: '未配置与签章链匹配的信任根，证书链无法建立信任',
  trustRootGuidance:
    '请向签发方获取签发该文档的根证书，在“信任根”中导入后重新验证；证书链结果独立展示，不改变签名/完整性总体状态。',
  trustRootMismatch: '当前信任根与签章链不匹配（CHAIN_SIGNATURE_INVALID）',
  trustRootMismatchGuidance:
    '请改用签发方根证书；证书链结果独立展示，不要将其解释为签名/完整性总体无效。',
  signatureMathNotTrust:
    '签名数学、数据哈希、引用完整性与印章结构/数学可独立判定；证书链未建立信任只影响链状态，不改变总体状态。',
  timestampUnparsable: '不可解析',
  signer: '签名者',
  overallValid: '有效',
  overallInvalid: '无效',
  overallUnknown: '未知',
  overallNotApplicable: '不适用',
  overallUnsupported: '不支持',
  chainExpired: '证书已过期',
  chainNotYetValid: '证书尚未生效',
  chainUntrusted: '证书链不受信任',
  chainIncomplete: '证书链不完整',
  chainNotPresent: '未找到证书',
  verifyFailed: '验证失败',
  notOpened: '文档尚未打开',
  cryptoDisabled: '密码能力未启用',
  methodPassword: '口令',
  methodCertificate: 'SM2 私钥',
  methodUnknown: '未知',
};

/** English strings. */
const EN: CryptoText = {
  credentialTitle: 'Open encrypted document',
  credentialDescription: 'This document is encrypted. Select a user and provide credentials.',
  credentialUser: 'User',
  credentialUserPlaceholder: 'Select a user',
  credentialMode: 'Credential type',
  credentialPassword: 'Password',
  credentialPrivateKey: 'SM2 private key',
  credentialPrivateKeyHint: 'Supports .pem/.der/.key/.pk8; the key stays in memory on this page',
  credentialPassphrase: 'Private key passphrase (optional)',
  credentialSubmit: 'Open',
  credentialCancel: 'Cancel',
  credentialLoading: 'Decrypting…',
  credentialRequired: 'This document is encrypted and requires credentials',
  credentialWrongPassword: 'Incorrect password or mismatched user',
  credentialPrivateKeyInvalid: 'The private key cannot be used for this user',
  credentialPassphraseRequired: 'This private key is encrypted; enter its passphrase',
  credentialDecryptFailed: 'Decryption failed; check the credentials and retry',
  credentialUserRequired: 'Select a user',
  credentialPasswordRequired: 'Enter a password',
  credentialKeyRequired: 'Select a private key file',
  cryptoUnsupported: 'Cryptographic support is disabled; cannot open the encrypted document',
  cryptoCancelled: 'Opening the encrypted document was cancelled',
  panelTitle: 'Verification result',
  panelLoading: 'Verifying…',
  panelNotVerified: 'This document has not been verified',
  panelReverify: 'Verify again',
  signingTime: 'Signing time',
  signingTimeMissing: 'Not provided',
  overall: 'Overall',
  packageInfo: 'Document',
  packageEncrypted: 'Encrypted',
  packageDecrypted: 'Decrypted',
  packagePages: 'Pages',
  packageSignatures: 'Signatures',
  packageIntegrity: 'Integrity protection',
  present: 'Yes',
  absent: 'Not protected',
  integrity: 'Anti-tampering integrity',
  integrityFiles: 'Listed files',
  integrityMissing: 'Missing files',
  integrityExtra: 'Extra files',
  signatureCard: 'Signature',
  sesVersion: 'SES version',
  dataHash: 'dataHash',
  references: 'References',
  math: 'Signature math',
  chain: 'Certificate chain',
  chainIndependent: 'Certificate chain (does not affect overall status)',
  chainSectionTitle: 'Root certificate chain verification',
  chainStatus: 'Chain status',
  chainRootsConfigured: 'Trust roots configured',
  yes: 'Yes',
  no: 'No',
  chainSignerCertificate: 'Signer certificate',
  chainTrustAnchor: 'Trust anchor',
  chainTrustAnchorMissing: 'No trust anchor found',
  chainMembers: 'Chain members',
  chainNotVerified: 'Not verified: no verification report yet; the certificate chain has not been checked.',
  chainIndependentNote:
    'The certificate chain result is shown separately and does not affect signature/integrity verification results.',
  seal: 'Seal',
  timestamp: 'Timestamp',
  none: 'None',
  roots: 'Trust roots',
  rootsNone: 'No trust roots configured',
  rootsHint: 'Trust roots are only used as trust anchors; they are never uploaded or written',
  rootsAdd: 'Configure trust root',
  rootsRemove: 'Remove',
  rootsSubject: 'Subject',
  rootsIssuer: 'Issuer',
  rootsSerial: 'Serial number',
  rootsFingerprint: 'Fingerprint',
  rootsValidity: 'Validity',
  rootsInvalid: 'Failed to parse the trust root; ignored',
  rootsAdded: 'Trust root added',
  rootsUnknownNote: 'No trust roots configured; certificate chain status is unknown',
  issues: 'Issues',
  trusted: 'Trusted',
  trustUnknown: 'Trust status unknown',
  downloadCertificate: 'Download certificate (.der)',
  signerCertificate: 'Signer certificate',
  signerCertificateMissing: 'Signer certificate not found',
  viewDetails: 'View signature details',
  close: 'Close',
  notVerified: 'Not verified',
  timestampParsedNotVerified: 'Parsed, not verified',
  timestampNotInOverall: 'not part of the overall status',
  timestampGenTime: 'Generation time (UTC+8)',
  timestampTsa: 'TSA',
  timestampSerial: 'Serial number',
  timestampPolicy: 'Policy',
  timestampMissing: 'Not present',
  trustRootMissing: 'No trust root matching this signature chain is configured; the chain cannot be trusted',
  trustRootGuidance:
    'Obtain the issuer root certificate from the signer, import it under Trust roots and verify again; the chain result is shown separately and does not change signature/integrity overall status.',
  trustRootMismatch: 'The configured trust root does not match this signature chain (CHAIN_SIGNATURE_INVALID)',
  trustRootMismatchGuidance:
    'Use the issuer root certificate; the chain result is shown separately, so do not treat it as a signature/integrity overall failure.',
  signatureMathNotTrust:
    'Signature math, data hash, references and seal structure/math are evaluated independently; an untrusted chain only changes the chain status, not the overall status.',
  timestampUnparsable: 'Unparsable',
  signer: 'Signer',
  overallValid: 'Valid',
  overallInvalid: 'Invalid',
  overallUnknown: 'Unknown',
  overallNotApplicable: 'Not applicable',
  overallUnsupported: 'Unsupported',
  chainExpired: 'Certificate expired',
  chainNotYetValid: 'Certificate not yet valid',
  chainUntrusted: 'Certificate chain untrusted',
  chainIncomplete: 'Certificate chain incomplete',
  chainNotPresent: 'Certificate not found',
  verifyFailed: 'Verification failed',
  notOpened: 'Document is not open',
  cryptoDisabled: 'Cryptographic support is disabled',
  methodPassword: 'Password',
  methodCertificate: 'SM2 private key',
  methodUnknown: 'Unknown',
};

/**
 * 按语言读取文案。
 *
 * @param locale 语言标签；`en*` 使用英文，其余使用中文。
 * @returns 文案字典。
 */
export function createCryptoText(locale: string | undefined): CryptoText {
  return locale?.toLowerCase().startsWith('en') ? EN : ZH;
}

/**
 * 证书链状态文案。
 *
 * @param text 文案字典。
 * @param status 链状态。
 * @returns 人类可读状态。
 */
export function chainStatusText(text: CryptoText, status: string | undefined): string {
  switch (status) {
    case 'valid':
      return text.overallValid;
    case 'invalid':
      return text.overallInvalid;
    case 'expired':
      return text.chainExpired;
    case 'not-yet-valid':
      return text.chainNotYetValid;
    case 'untrusted':
      return text.chainUntrusted;
    case 'incomplete':
      return text.chainIncomplete;
    case 'unsupported':
      return text.overallUnsupported;
    case 'not-present':
      return text.chainNotPresent;
    default:
      return text.overallUnknown;
  }
}

/**
 * 签名/完整性总体状态文案。
 *
 * @param text 文案字典。
 * @param status 验证状态。
 * @returns 人类可读状态。
 */
export function verificationStatusText(text: CryptoText, status: string | undefined): string {
  switch (status) {
    case 'valid':
      return text.overallValid;
    case 'invalid':
      return text.overallInvalid;
    case 'not-applicable':
      return text.overallNotApplicable;
    case 'unsupported':
      return text.overallUnsupported;
    default:
      return text.overallUnknown;
  }
}