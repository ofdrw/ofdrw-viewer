/**
 * 凭据规范化、UserInfo 匹配与 FEK 恢复（设计 §4.4–§4.6）。
 *
 * 口令/私钥只在局部变量中存在；匹配/解密失败信息只包含用户名、算法等
 * 诊断字段，不回显口令或密钥。
 */

import { CryptoError } from '../errors';
import { parseSm2Cipher, sm2CipherToC1C3C2 } from '../asn1/sm2-cipher';
import { sm2Decrypt } from '../sm/sm2';
import { derivePasswordKey } from '../sm/kdf';
import { sm4DecryptCbc } from '../sm/sm4';
import type { CryptoCredential, Sm2PrivateKeyInput } from '../types/credentials';
import type { CryptoLimits } from '../types/limits';
import type { CryptoWarningHandler } from '../types/warnings';
import { bytesEqual } from '../util/bytes';
import type { ParsedSeedUser } from '../decrypt/encryption';
import { parseSm2PrivateKeyAsync } from './pkcs8';

/** 单层凭据匹配与 FEK 恢复结果。 */
export interface RecoveredLayerKey {
  /** 命中的用户。 */
  readonly user: ParsedSeedUser;
  /** 文件密钥，16 byte。 */
  readonly fek: Uint8Array;
}

/**
 * 规范化凭据参数。
 *
 * @param input 单个/数组凭据。
 * @returns 凭据数组；未提供返回空数组。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT`。
 */
export function normalizeCredentials(
  input?: CryptoCredential | readonly CryptoCredential[],
): readonly CryptoCredential[] {
  if (input === undefined) return [];
  const list = Array.isArray(input) ? input : [input as CryptoCredential];
  for (const credential of list) {
    if (!credential || typeof credential !== 'object') {
      throw new CryptoError('CRYPTO_INVALID_ARGUMENT', '凭据必须是对象');
    }
    if (credential.kind === 'password') {
      if (typeof credential.password !== 'string' || credential.password.length === 0) {
        throw new CryptoError('CRYPTO_CREDENTIALS_REQUIRED', '口令不能为空');
      }
    } else if (credential.kind === 'private-key') {
      if (!credential.privateKey || typeof credential.privateKey !== 'object') {
        throw new CryptoError('CRYPTO_INVALID_ARGUMENT', '私钥凭据缺少 privateKey');
      }
      validatePrivateKeyInput(credential.privateKey);
    } else {
      throw new CryptoError('CRYPTO_INVALID_ARGUMENT', '未知凭据类型');
    }
    if (credential.userName !== undefined && typeof credential.userName !== 'string') {
      throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'userName 必须是字符串');
    }
  }
  return list;
}

/**
 * 校验私钥输入形态。
 *
 * @param input 私钥输入。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT`。
 */
function validatePrivateKeyInput(input: Sm2PrivateKeyInput): void {
  const hasPem = typeof input.pem === 'string';
  const hasDer = input.der instanceof Uint8Array;
  if (hasPem === hasDer) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', '私钥输入必须且只能提供 pem 或 der');
  }
  if (input.passphrase !== undefined && typeof input.passphrase !== 'string') {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', '私钥口令必须是字符串');
  }
}

/**
 * 在当前层选择匹配用户。
 *
 * @param users 当前层用户。
 * @param credential 凭据。
 * @returns 匹配用户。
 * @throws CryptoError `CRYPTO_USER_NOT_FOUND` / `CRYPTO_USER_AMBIGUOUS`。
 */
function selectUser(
  users: readonly ParsedSeedUser[],
  credential: CryptoCredential,
): ParsedSeedUser {
  const expectedMethod = credential.kind === 'password' ? 'password' : 'certificate';
  const named =
    credential.userName !== undefined
      ? users.filter((user) => user.userName === credential.userName)
      : users;
  if (named.length === 0) {
    throw new CryptoError('CRYPTO_USER_NOT_FOUND', '当前加密层没有指定用户');
  }
  const compatible = named.filter((user) => user.method === expectedMethod);
  if (compatible.length === 0) {
    throw new CryptoError('CRYPTO_USER_NOT_FOUND', '当前加密层没有与凭据类型匹配的用户');
  }
  if (credential.userName === undefined && compatible.length > 1) {
    throw new CryptoError('CRYPTO_USER_AMBIGUOUS', '当前加密层匹配多个用户，请指定 userName');
  }
  return compatible[0];
}

/**
 * 用口令恢复 FEK。
 *
 * @param user 用户。
 * @param password 口令。
 * @returns 16 byte FEK。
 * @throws CryptoError `CRYPTO_WRONG_PASSWORD`。
 */
function recoverPasswordFek(user: ParsedSeedUser, password: string): Uint8Array {
  let kek: Uint8Array;
  try {
    kek = derivePasswordKey(password);
  } catch (error) {
    if (error instanceof CryptoError && error.code === 'CRYPTO_CREDENTIALS_REQUIRED') throw error;
    throw new CryptoError('CRYPTO_WRONG_PASSWORD', `用户 ${user.userName} 的口令不正确`);
  }
  let fek: Uint8Array;
  try {
    fek = sm4DecryptCbc(user.encryptedKey, kek, user.iv);
  } catch {
    throw new CryptoError('CRYPTO_WRONG_PASSWORD', `用户 ${user.userName} 的口令不正确`);
  } finally {
    kek.fill(0);
  }
  if (fek.length !== 16) {
    fek.fill(0);
    throw new CryptoError('CRYPTO_WRONG_PASSWORD', `用户 ${user.userName} 的口令不正确`);
  }
  return fek;
}

/**
 * 用 SM2 私钥恢复 FEK。
 *
 * @param user 用户。
 * @param privateKeyInput 私钥输入。
 * @param limits ASN.1 上限。
 * @param onWarning 私钥解析 warning 回调。
 * @returns 16 byte FEK。
 * @throws CryptoError `CRYPTO_PRIVATE_KEY_*`。
 */
async function recoverPrivateKeyFek(
  user: ParsedSeedUser,
  privateKeyInput: Sm2PrivateKeyInput,
  limits: CryptoLimits,
  onWarning?: CryptoWarningHandler,
): Promise<Uint8Array> {
  const privateKey = await parseSm2PrivateKeyAsync(
    privateKeyInput,
    limits,
    onWarning ? { onWarning } : undefined,
  );
  // 私钥标量只用于本次 FEK 恢复；成功/失败都立即清零，且不再复用该对象。
  try {
    if (user.certificate) {
      if (!bytesEqual(user.certificate.publicKey, privateKey.publicKey)) {
        throw new CryptoError(
          'CRYPTO_PRIVATE_KEY_MISMATCH',
          `私钥与用户 ${user.userName} 的证书不匹配`,
        );
      }
    }
    let fek: Uint8Array;
    try {
      const cipher = parseSm2Cipher(user.encryptedKey, { maxBytes: limits.maxAsn1Bytes });
      fek = sm2Decrypt(sm2CipherToC1C3C2(cipher), privateKey.privateKey, { c1Prefix: 'present' });
    } catch (error) {
      if (error instanceof CryptoError && error.code === 'CRYPTO_LIMIT_EXCEEDED') throw error;
      throw new CryptoError(
        'CRYPTO_PRIVATE_KEY_MISMATCH',
        `私钥无法解出用户 ${user.userName} 的文件密钥`,
      );
    }
    if (fek.length !== 16) {
      fek.fill(0);
      throw new CryptoError(
        'CRYPTO_PRIVATE_KEY_MISMATCH',
        `私钥无法解出用户 ${user.userName} 的文件密钥`,
      );
    }
    return fek;
  } finally {
    privateKey.privateKey.fill(0);
  }
}

/**
 * 为当前层匹配凭据并恢复 FEK。
 *
 * @param users 当前层用户。
 * @param credentials 凭据数组。
 * @param limits ASN.1 上限。
 * @param onWarning 私钥解析 warning 回调。
 * @returns 命中用户与 FEK。
 * @throws CryptoError 无匹配/凭据错误/多凭据全部失败。
 */
export async function recoverLayerKey(
  users: readonly ParsedSeedUser[],
  credentials: readonly CryptoCredential[],
  limits: CryptoLimits,
  onWarning?: CryptoWarningHandler,
): Promise<RecoveredLayerKey> {
  if (credentials.length === 0) {
    throw new CryptoError('CRYPTO_CREDENTIALS_REQUIRED', '加密包需要至少一个凭据');
  }
  let matched = 0;
  let lastError: CryptoError | undefined;
  for (const credential of credentials) {
    let user: ParsedSeedUser;
    try {
      user = selectUser(users, credential);
    } catch (error) {
      if (error instanceof CryptoError) {
        lastError = error;
        continue;
      }
      throw error;
    }
    matched += 1;
    if (credentials.length === 1) {
      // 单凭据保留可区分错误（口令错误/私钥不匹配等）。
      if (credential.kind === 'password') {
        return { user, fek: recoverPasswordFek(user, credential.password) };
      }
      return {
        user,
        fek: await recoverPrivateKeyFek(user, credential.privateKey, limits, onWarning),
      };
    }
    try {
      if (credential.kind === 'password') {
        return { user, fek: recoverPasswordFek(user, credential.password) };
      }
      return {
        user,
        fek: await recoverPrivateKeyFek(user, credential.privateKey, limits, onWarning),
      };
    } catch (error) {
      if (
        error instanceof CryptoError &&
        (error.code === 'CRYPTO_PRIVATE_KEY_PASSPHRASE_REQUIRED' ||
          error.code === 'CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION' ||
          error.code === 'CRYPTO_PRIVATE_KEY_INVALID' ||
          error.code === 'CRYPTO_LIMIT_EXCEEDED')
      ) {
        throw error;
      }
      lastError = error instanceof CryptoError ? error : undefined;
    }
  }
  if (matched > 0) {
    throw new CryptoError('CRYPTO_DECRYPT_FAILED', '所有凭据均无法解出文件密钥');
  }
  throw lastError ?? new CryptoError('CRYPTO_USER_NOT_FOUND', '当前加密层没有匹配用户');
}
