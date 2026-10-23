/**
 * ASN.1 基础层公共入口：严格 DER、OID、SM2Cipher 与 X.509 解析。
 */

export {
  DER_TAG,
  DerNode,
  compareBytes,
  decodeOid,
  derBitString,
  derBoolean,
  derContext,
  derGeneralizedTime,
  derInteger,
  derNull,
  derOctetString,
  derOid,
  derSequence,
  derSet,
  derUtcTime,
  derUtf8String,
  encodeDerLength,
  encodeDerTlv,
  parseDer,
  parseDerAll,
} from './der';
export type {
  DerBitString,
  DerClass,
  DerParseOptions,
  DerTag,
} from './der';

export {
  OID_AES_128_CBC,
  OID_AES_192_CBC,
  OID_AES_256_CBC,
  OID_AUTHORITY_KEY_IDENTIFIER,
  OID_BASIC_CONSTRAINTS,
  OID_COMMON_NAME,
  OID_COUNTRY_NAME,
  OID_CT_TST_INFO,
  OID_DOMAIN_COMPONENT,
  OID_EC_PUBLIC_KEY,
  OID_EMAIL_ADDRESS,
  OID_EXTENDED_KEY_USAGE,
  OID_GM_DATA,
  OID_GM_SIGNED_DATA,
  OID_HMAC_WITH_SHA1,
  OID_HMAC_WITH_SHA256,
  OID_KEY_USAGE,
  OID_LOCALITY_NAME,
  OID_ORGANIZATION_NAME,
  OID_ORGANIZATIONAL_UNIT_NAME,
  OID_PBKDF2,
  OID_PBES2,
  OID_PKCS7_DATA,
  OID_PKCS7_SIGNED_DATA,
  OID_PKCS9_CONTENT_TYPE,
  OID_PKCS9_MESSAGE_DIGEST,
  OID_PKCS9_SIGNING_TIME,
  OID_SM2_CURVE,
  OID_SM2_SIGN,
  OID_SM3,
  OID_SM3_WITH_SM2,
  OID_SM4,
  OID_SM4_CBC,
  OID_STATE_OR_PROVINCE_NAME,
  OID_SUBJECT_ALT_NAME,
  OID_SUBJECT_KEY_IDENTIFIER,
  dnLabel,
  isSignedDataContentType,
  isSm2SignatureAlgorithm,
  oidName,
} from './oid';

export {
  c1c3c2ToSm2Cipher,
  encodeSm2Cipher,
  parseSm2Cipher,
  sm2CipherToC1C3C2,
} from './sm2-cipher';
export type { C1C3C2ParseOptions, Sm2Cipher } from './sm2-cipher';

export {
  checkCertificateValidity,
  parseX509Certificate,
} from './x509';
export type {
  CertificateValidity,
  DistinguishedNameAttribute,
  X509Certificate,
  X509Extension,
} from './x509';