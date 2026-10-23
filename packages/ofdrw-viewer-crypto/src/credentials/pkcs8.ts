/**
 * 加密 PKCS#8（PBES2）私钥解析。
 *
 * 支持范围（设计 §3.1）：
 * - `PBES2 + PBKDF2(HMAC-SHA1/HMAC-SHA256) + AES-128/192/256-CBC`；
 * - 其他 PBES2 算法返回 `CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION`；
 * - 口令错误/解密结果不是合法 PKCS#8 返回 `CRYPTO_PRIVATE_KEY_INVALID`。
 *
 * 口令与派生密钥只在本次调用内存在；错误信息不包含口令、PEM 或密钥字节。
 */

import { CryptoError } from '../errors';
import { parseDer } from '../asn1/der';
import {
  OID_AES_128_CBC,
  OID_AES_192_CBC,
  OID_AES_256_CBC,
  OID_HMAC_WITH_SHA1,
  OID_HMAC_WITH_SHA256,
  OID_PBES2,
  OID_PBKDF2,
} from '../asn1/oid';
import { parseSm2PrivateKey, type Sm2PrivateKey } from '../sm/private-key';
import type { Sm2PrivateKeyInput } from '../types/credentials';
import type { CryptoLimits } from '../types/limits';
import type { CryptoWarningHandler } from '../types/warnings';
import { zeroize } from '../util/bytes';
import { parsePemBlocks } from '../util/pem';

/**
 * 把字节视图转为 WebCrypto 的 BufferSource。
 *
 * @param bytes 字节视图。
 * @returns BufferSource。
 */
function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

/** PBKDF2 迭代次数上限（设计冻结）。 */
const MAX_ITERATIONS = 10_000_000n;

/**
 * 判断 DER 是否为 EncryptedPrivateKeyInfo（PBES2）。
 *
 * @param der DER 字节。
 * @param maxBytes ASN.1 大小上限。
 * @returns 是加密结构返回 true。
 */
function isEncryptedPrivateKeyInfo(der: Uint8Array, maxBytes: number): boolean {
  try {
    const root = parseDer(der, { maxBytes });
    if (!root.isUniversal(0x10) || root.children.length !== 2) return false;
    const algorithm = root.children[0];
    if (!algorithm?.isUniversal(0x10)) return false;
    const oid = algorithm.children[0];
    return Boolean(oid?.isUniversal(0x06) && oid.asOid() === OID_PBES2);
  } catch {
    return false;
  }
}

/**
 * 解密 EncryptedPrivateKeyInfo。
 *
 * @param der 加密 PKCS#8 DER。
 * @param passphrase 口令。
 * @param limits ASN.1 上限。
 * @returns 未加密 PKCS#8 DER。
 * @throws CryptoError 口令缺失、算法不支持或解密失败。
 */
async function decryptPrivateKeyInfo(
  der: Uint8Array,
  passphrase: string | undefined,
  limits: CryptoLimits,
): Promise<Uint8Array> {
  if (passphrase === undefined || passphrase.length === 0) {
    throw new CryptoError('CRYPTO_PRIVATE_KEY_PASSPHRASE_REQUIRED', '加密 PKCS#8 私钥需要口令');
  }
  const parsed = parseDer(der, { maxBytes: limits.maxAsn1Bytes }).requireSequence(
    'EncryptedPrivateKeyInfo',
  );
  if (parsed.children.length !== 2) {
    throw new CryptoError('CRYPTO_PRIVATE_KEY_INVALID', '加密 PKCS#8 字段数量非法');
  }
  const algorithm = parsed.children[0].requireSequence('PBES2');
  const algorithmOid = algorithm.children[0]?.asOid();
  if (algorithmOid !== OID_PBES2) {
    throw new CryptoError('CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION', '不是 PBES2 加密私钥');
  }
  const parameters = algorithm.children[1]?.requireSequence('PBES2 parameters');
  if (!parameters || parameters.children.length < 2) {
    throw new CryptoError('CRYPTO_PRIVATE_KEY_INVALID', 'PBES2 参数不足');
  }
  const kdfAlgorithm = parameters.children[0].requireSequence('PBKDF2');
  if (kdfAlgorithm.children[0]?.asOid() !== OID_PBKDF2) {
    throw new CryptoError(
      'CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION',
      'PBES2 仅支持 PBKDF2',
    );
  }
  const kdfParameters = kdfAlgorithm.children[1]?.requireSequence('PBKDF2 parameters');
  if (!kdfParameters || kdfParameters.children.length < 2) {
    throw new CryptoError('CRYPTO_PRIVATE_KEY_INVALID', 'PBKDF2 参数不足');
  }
  const salt = kdfParameters.children[0].asOctets();
  const iterationBig = kdfParameters.children[1].asInteger();
  if (salt.length < 8 || salt.length > 64) {
    throw new CryptoError('CRYPTO_PRIVATE_KEY_INVALID', 'PBKDF2 salt 长度必须在 8..64 byte');
  }
  if (iterationBig < 1n || iterationBig > MAX_ITERATIONS) {
    throw new CryptoError('CRYPTO_PRIVATE_KEY_INVALID', 'PBKDF2 迭代次数超出 1..10000000');
  }
  let index = 2;
  let keyLength: number | undefined;
  if (kdfParameters.children[index]?.isUniversal(0x02)) {
    const value = kdfParameters.children[index].asInteger();
    if (value < 1n || value > 64n) {
      throw new CryptoError('CRYPTO_PRIVATE_KEY_INVALID', 'PBKDF2 keyLength 非法');
    }
    keyLength = Number(value);
    index += 1;
  }
  let prfOid = OID_HMAC_WITH_SHA1;
  const prfNode = kdfParameters.children[index];
  if (prfNode) {
    const prf = prfNode.requireSequence('PBKDF2 PRF');
    const oid = prf.children[0]?.asOid();
    if (oid !== OID_HMAC_WITH_SHA1 && oid !== OID_HMAC_WITH_SHA256) {
      throw new CryptoError(
        'CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION',
        'PBKDF2 仅支持 HMAC-SHA1/HMAC-SHA256',
      );
    }
    prfOid = oid;
  }

  const cipherAlgorithm = parameters.children[1].requireSequence('PBES2 cipher');
  const cipherOid = cipherAlgorithm.children[0]?.asOid();
  let cipherKeyLength: number;
  switch (cipherOid) {
    case OID_AES_128_CBC:
      cipherKeyLength = 16;
      break;
    case OID_AES_192_CBC:
      cipherKeyLength = 24;
      break;
    case OID_AES_256_CBC:
      cipherKeyLength = 32;
      break;
    default:
      throw new CryptoError(
        'CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION',
        'PBES2 仅支持 AES-128/192/256-CBC',
      );
  }
  if (keyLength !== undefined && keyLength !== cipherKeyLength) {
    throw new CryptoError('CRYPTO_PRIVATE_KEY_INVALID', 'PBKDF2 keyLength 与 AES 密钥长度不一致');
  }
  const iv = cipherAlgorithm.children[1]?.asOctets();
  if (!iv || iv.length !== 16) {
    throw new CryptoError('CRYPTO_PRIVATE_KEY_INVALID', 'PBES2 IV 必须是 16 byte');
  }
  const encrypted = parsed.children[1].asOctets();
  if (encrypted.length === 0 || encrypted.length % 16 !== 0) {
    throw new CryptoError('CRYPTO_PRIVATE_KEY_INVALID', '加密 PKCS#8 密文长度非法');
  }

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new CryptoError(
      'CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION',
      '当前环境缺少 WebCrypto，无法解密 PKCS#8',
    );
  }
  const passwordBytes = new TextEncoder().encode(passphrase);
  let derived: ArrayBuffer | undefined;
  try {
    const baseKey = await subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveBits']);
    derived = await subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: asBufferSource(salt),
        iterations: Number(iterationBig),
        hash: prfOid === OID_HMAC_WITH_SHA256 ? 'SHA-256' : 'SHA-1',
      },
      baseKey,
      cipherKeyLength * 8,
    );
    const aesKey = await subtle.importKey(
      'raw',
      new Uint8Array(derived),
      { name: 'AES-CBC' },
      false,
      ['decrypt'],
    );
    const plaintext = await subtle.decrypt(
      { name: 'AES-CBC', iv: asBufferSource(iv) },
      aesKey,
      asBufferSource(encrypted),
    );
    return new Uint8Array(plaintext);
  } catch (error) {
    if (error instanceof CryptoError) throw error;
    throw new CryptoError('CRYPTO_PRIVATE_KEY_INVALID', '加密 PKCS#8 口令错误或内容损坏');
  } finally {
    zeroize(passwordBytes);
    if (derived) zeroize(new Uint8Array(derived));
  }
}

/**
 * 异步解析 SM2 私钥，支持口令保护的 PKCS#8。
 *
 * @param input 私钥输入（PEM/DER + 可选口令）。
 * @param limits ASN.1 上限。
 * @param options warning 回调；未加密私钥带 passphrase 时透传给同步解析器。
 * @returns 私钥。
 * @throws CryptoError 口令缺失/错误、算法不支持或私钥非法。
 */
export async function parseSm2PrivateKeyAsync(
  input: Sm2PrivateKeyInput,
  limits: CryptoLimits,
  options?: { readonly onWarning?: CryptoWarningHandler },
): Promise<Sm2PrivateKey> {
  if (!input || typeof input !== 'object') {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', '私钥输入必须是对象');
  }
  const syncOptions = {
    maxBytes: limits.maxAsn1Bytes,
    ...(options?.onWarning ? { onWarning: options.onWarning } : {}),
  };
  if (typeof input.pem === 'string') {
    let blocks;
    try {
      blocks = parsePemBlocks(input.pem);
    } catch (error) {
      if (error instanceof CryptoError && error.code === 'CRYPTO_LIMIT_EXCEEDED') throw error;
      throw new CryptoError('CRYPTO_PRIVATE_KEY_INVALID', 'PEM 解析失败', { cause: error });
    }
    const encrypted = blocks.find((block) => block.type === 'ENCRYPTED PRIVATE KEY');
    if (encrypted) {
      if (encrypted.der.length > limits.maxAsn1Bytes) {
        throw new CryptoError('CRYPTO_LIMIT_EXCEEDED', '加密 PKCS#8 私钥超过大小上限');
      }
      const der = await decryptPrivateKeyInfo(encrypted.der, input.passphrase, limits);
      try {
        return parseSm2PrivateKey({ der }, { maxBytes: limits.maxAsn1Bytes });
      } finally {
        zeroize(der);
      }
    }
    return parseSm2PrivateKey(input, syncOptions);
  }
  if (input.der instanceof Uint8Array) {
    if (input.der.length > limits.maxAsn1Bytes) {
      throw new CryptoError('CRYPTO_LIMIT_EXCEEDED', '私钥 DER 超过大小上限');
    }
    if (isEncryptedPrivateKeyInfo(input.der, limits.maxAsn1Bytes)) {
      const der = await decryptPrivateKeyInfo(input.der, input.passphrase, limits);
      try {
        return parseSm2PrivateKey({ der }, { maxBytes: limits.maxAsn1Bytes });
      } finally {
        zeroize(der);
      }
    }
    return parseSm2PrivateKey(input, syncOptions);
  }
  throw new CryptoError('CRYPTO_INVALID_ARGUMENT', '私钥输入必须提供 pem 或 der');
}
