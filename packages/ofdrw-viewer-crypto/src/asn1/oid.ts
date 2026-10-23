/**
 * ASN.1 OID 常量与可读名称。
 *
 * 只收录 OFD 密码能力实际使用的 OID；新增 OID 应同步本文件与设计文档。
 */

// ---------------------------------------------------------------- SM / 算法
/** SM3 摘要。 */
export const OID_SM3 = '1.2.156.10197.1.401';
/** SM3withSM2 签名算法（GM/T 0006）。 */
export const OID_SM3_WITH_SM2 = '1.2.156.10197.1.501';
/** SM2 签名算法（CMS 场景，GM/T 0006 / GB/T 35275）。 */
export const OID_SM2_SIGN = '1.2.156.10197.1.301.1';
/** SM2 公钥/推荐曲线 OID。 */
export const OID_SM2_CURVE = '1.2.156.10197.1.301';
/** id-ecPublicKey。 */
export const OID_EC_PUBLIC_KEY = '1.2.840.10045.2.1';
/** SM4 分组密码。 */
export const OID_SM4 = '1.2.156.10197.1.100';
/** SM4-CBC（GM/T 0006）。 */
export const OID_SM4_CBC = '1.2.156.10197.1.104.2';

// ---------------------------------------------------------------- PKCS#7 / CMS / GM
/** GB/T 35275 数据内容。 */
export const OID_GM_DATA = '1.2.156.10197.6.1.4.2.1';
/** GB/T 35275 签名数据。 */
export const OID_GM_SIGNED_DATA = '1.2.156.10197.6.1.4.2.2';
/** PKCS#7 data。 */
export const OID_PKCS7_DATA = '1.2.840.113549.1.7.1';
/** PKCS#7 signedData。 */
export const OID_PKCS7_SIGNED_DATA = '1.2.840.113549.1.7.2';
/** RFC 3161 TSTInfo 内容类型。 */
export const OID_CT_TST_INFO = '1.2.840.113549.1.9.16.1.4';

// ---------------------------------------------------------------- PKCS#9
/** PKCS#9 contentType。 */
export const OID_PKCS9_CONTENT_TYPE = '1.2.840.113549.1.9.3';
/** PKCS#9 messageDigest。 */
export const OID_PKCS9_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
/** PKCS#9 signingTime。 */
export const OID_PKCS9_SIGNING_TIME = '1.2.840.113549.1.9.5';

// ---------------------------------------------------------------- 私钥加密
/** PBES2。 */
export const OID_PBES2 = '1.2.840.113549.1.5.13';
/** PBKDF2。 */
export const OID_PBKDF2 = '1.2.840.113549.1.5.12';
/** HMAC-SHA1（PBKDF2 默认 PRF）。 */
export const OID_HMAC_WITH_SHA1 = '1.2.840.113549.2.7';
/** HMAC-SHA256。 */
export const OID_HMAC_WITH_SHA256 = '1.2.840.113549.2.9';
/** AES-128-CBC。 */
export const OID_AES_128_CBC = '2.16.840.1.101.3.4.1.2';
/** AES-192-CBC。 */
export const OID_AES_192_CBC = '2.16.840.1.101.3.4.1.22';
/** AES-256-CBC。 */
export const OID_AES_256_CBC = '2.16.840.1.101.3.4.1.42';

// ---------------------------------------------------------------- X.509 扩展
/** BasicConstraints。 */
export const OID_BASIC_CONSTRAINTS = '2.5.29.19';
/** KeyUsage。 */
export const OID_KEY_USAGE = '2.5.29.15';
/** SubjectKeyIdentifier。 */
export const OID_SUBJECT_KEY_IDENTIFIER = '2.5.29.14';
/** AuthorityKeyIdentifier。 */
export const OID_AUTHORITY_KEY_IDENTIFIER = '2.5.29.35';
/** ExtendedKeyUsage。 */
export const OID_EXTENDED_KEY_USAGE = '2.5.29.37';
/** SubjectAltName。 */
export const OID_SUBJECT_ALT_NAME = '2.5.29.17';

// ---------------------------------------------------------------- X.500 属性
/** commonName。 */
export const OID_COMMON_NAME = '2.5.4.3';
/** countryName。 */
export const OID_COUNTRY_NAME = '2.5.4.6';
/** localityName。 */
export const OID_LOCALITY_NAME = '2.5.4.7';
/** stateOrProvinceName。 */
export const OID_STATE_OR_PROVINCE_NAME = '2.5.4.8';
/** organizationName。 */
export const OID_ORGANIZATION_NAME = '2.5.4.10';
/** organizationalUnitName。 */
export const OID_ORGANIZATIONAL_UNIT_NAME = '2.5.4.11';
/** serialNumber。 */
export const OID_SERIAL_NUMBER = '2.5.4.5';
/** surname。 */
export const OID_SURNAME = '2.5.4.4';
/** givenName。 */
export const OID_GIVEN_NAME = '2.5.4.42';
/** title。 */
export const OID_TITLE = '2.5.4.12';
/** streetAddress。 */
export const OID_STREET_ADDRESS = '2.5.4.9';
/** emailAddress。 */
export const OID_EMAIL_ADDRESS = '1.2.840.113549.1.9.1';
/** domainComponent。 */
export const OID_DOMAIN_COMPONENT = '0.9.2342.19200300.100.1.25';

/** 算法 OID → 可读名称。 */
const OID_NAMES: Readonly<Record<string, string>> = Object.freeze({
  [OID_SM3]: 'SM3',
  [OID_SM3_WITH_SM2]: 'SM3withSM2',
  [OID_SM2_SIGN]: 'SM2Sign',
  [OID_SM2_CURVE]: 'SM2',
  [OID_EC_PUBLIC_KEY]: 'EC',
  [OID_SM4]: 'SM4',
  [OID_SM4_CBC]: 'SM4-CBC',
  [OID_GM_DATA]: 'GB/T 35275 data',
  [OID_GM_SIGNED_DATA]: 'GB/T 35275 signedData',
  [OID_PKCS7_DATA]: 'PKCS#7 data',
  [OID_PKCS7_SIGNED_DATA]: 'PKCS#7 signedData',
  [OID_CT_TST_INFO]: 'TSTInfo',
  [OID_PBES2]: 'PBES2',
  [OID_PBKDF2]: 'PBKDF2',
  [OID_HMAC_WITH_SHA1]: 'hmacWithSHA1',
  [OID_HMAC_WITH_SHA256]: 'hmacWithSHA256',
  [OID_AES_128_CBC]: 'AES-128-CBC',
  [OID_AES_192_CBC]: 'AES-192-CBC',
  [OID_AES_256_CBC]: 'AES-256-CBC',
  [OID_BASIC_CONSTRAINTS]: 'basicConstraints',
  [OID_KEY_USAGE]: 'keyUsage',
  [OID_SUBJECT_KEY_IDENTIFIER]: 'subjectKeyIdentifier',
  [OID_AUTHORITY_KEY_IDENTIFIER]: 'authorityKeyIdentifier',
  [OID_EXTENDED_KEY_USAGE]: 'extendedKeyUsage',
  [OID_SUBJECT_ALT_NAME]: 'subjectAltName',
});

/** X.500 属性 OID → 短标签。 */
const DN_LABELS: Readonly<Record<string, string>> = Object.freeze({
  [OID_COMMON_NAME]: 'CN',
  [OID_COUNTRY_NAME]: 'C',
  [OID_LOCALITY_NAME]: 'L',
  [OID_STATE_OR_PROVINCE_NAME]: 'ST',
  [OID_ORGANIZATION_NAME]: 'O',
  [OID_ORGANIZATIONAL_UNIT_NAME]: 'OU',
  [OID_SERIAL_NUMBER]: 'serialNumber',
  [OID_SURNAME]: 'SN',
  [OID_GIVEN_NAME]: 'GN',
  [OID_TITLE]: 'title',
  [OID_STREET_ADDRESS]: 'street',
  [OID_EMAIL_ADDRESS]: 'emailAddress',
  [OID_DOMAIN_COMPONENT]: 'DC',
});

/**
 * 获取 OID 可读名称；未知 OID 返回原始点分字符串。
 *
 * @param oid 点分 OID。
 * @returns 可读名称。
 */
export function oidName(oid: string): string {
  return OID_NAMES[oid] ?? oid;
}

/**
 * 获取 X.500 属性短标签；未知属性返回原始点分 OID。
 *
 * @param oid 点分 OID。
 * @returns 短标签。
 */
export function dnLabel(oid: string): string {
  return DN_LABELS[oid] ?? oid;
}

/**
 * 判断签名算法 OID 是否为 SM2 系列。
 *
 * @param oid 点分 OID。
 * @returns SM3withSM2 或 SM2Sign 返回 true。
 */
export function isSm2SignatureAlgorithm(oid: string): boolean {
  return oid === OID_SM3_WITH_SM2 || oid === OID_SM2_SIGN;
}

/**
 * 判断包内容 OID 是否为受支持的 SignedData。
 *
 * @param oid 点分 OID。
 * @returns GB/T 35275 或 PKCS#7 SignedData 返回 true。
 */
export function isSignedDataContentType(oid: string): boolean {
  return oid === OID_GM_SIGNED_DATA || oid === OID_PKCS7_SIGNED_DATA;
}