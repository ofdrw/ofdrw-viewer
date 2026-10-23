/**
 * 多用户 decryptseed：用户名匹配、歧义与错误口令。
 *
 * 仓库夹具每个加密层只有一个用户；这里用 crypto 自身的 KDF/SM4 构造包含
 * 两个口令用户的等价包，验证 `CRYPTO_USER_AMBIGUOUS` 与显式用户名匹配。
 */

import { describe, expect, it } from 'vitest';
import { zipSync, unzipSync } from 'fflate';
import {
  derivePasswordKey,
  inspect,
  openDecryptingContainer,
  sm4EncryptCbc,
  toBase64,
} from '@ofdrw/ofdrw-viewer-crypto';
import { fixtureBytes } from '../core/fixtures';

/** XML 头。 */
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';

/**
 * 构造含两个口令用户的加密包。
 *
 * @returns OFD 包字节。
 */
function buildMultiUserPackage(): Uint8Array {
  const plain = unzipSync(fixtureBytes('plain.ofd'));
  const fek = Uint8Array.from({ length: 16 }, (_, index) => 0x20 + index);
  const iv = Uint8Array.from({ length: 16 }, (_, index) => 0x30 + index);
  const kekA = derivePasswordKey('PasswordA');
  const kekB = derivePasswordKey('PasswordB');
  const files: Record<string, Uint8Array> = {};
  const entries: string[] = [];
  let index = 0;
  for (const [path, bytes] of Object.entries(plain)) {
    const ePath = `e/${index}.dat`;
    index += 1;
    files[ePath] = sm4EncryptCbc(bytes, fek, iv);
    entries.push(`<ofd:EncryptEntry Path="/${path}" EPath="/${ePath}"/>`);
  }
  const map = `${XML_HEAD}<ofd:EncryptEntries xmlns:ofd="http://www.ofdspec.org/2016" ID="1">${entries.join('')}</ofd:EncryptEntries>`;
  files['entriesmap.dat'] = sm4EncryptCbc(new TextEncoder().encode(map), fek, iv);
  const seed = `${XML_HEAD}<ofd:DecyptSeed xmlns:ofd="http://www.ofdspec.org/2016" ID="1"><ofd:UserInfo UserName="user-a"><ofd:IVValue>${toBase64(iv)}</ofd:IVValue><ofd:EncryptedWK>${toBase64(sm4EncryptCbc(fek, kekA, iv))}</ofd:EncryptedWK></ofd:UserInfo><ofd:UserInfo UserName="user-b"><ofd:IVValue>${toBase64(iv)}</ofd:IVValue><ofd:EncryptedWK>${toBase64(sm4EncryptCbc(fek, kekB, iv))}</ofd:EncryptedWK></ofd:UserInfo></ofd:DecyptSeed>`;
  files['decryptseed.dat'] = new TextEncoder().encode(seed);
  const encryptions = `${XML_HEAD}<ofd:Encryptions xmlns:ofd="http://www.ofdspec.org/2016"><ofd:EncryptInfo ID="1"><ofd:DecryptSeedLoc>/decryptseed.dat</ofd:DecryptSeedLoc><ofd:EntriesMapLoc>/entriesmap.dat</ofd:EntriesMapLoc></ofd:EncryptInfo></ofd:Encryptions>`;
  files['Encryptions.xml'] = new TextEncoder().encode(encryptions);
  return zipSync(files, { level: 0 });
}

/**
 * 捕获 CryptoError 错误码。
 *
 * @param promise 待执行 promise。
 * @returns 错误码。
 */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error && 'code' in error) return String((error as { code: unknown }).code);
    throw error;
  }
  throw new Error('promise 未按预期拒绝');
}

describe('多用户 decryptseed', () => {
  it('显式 userName 匹配正确用户', async () => {
    const data = buildMultiUserPackage();
    const result = await openDecryptingContainer({
      source: { kind: 'arraybuffer', data },
      credentials: { kind: 'password', userName: 'user-a', password: 'PasswordA' },
    });
    expect(result.layers[0].user?.userName).toBe('user-a');
    expect(result.container.has('OFD.xml')).toBe(true);
    await result.container.close();
  });

  it('未指定 userName 且存在多个兼容用户时抛 USER_AMBIGUOUS', async () => {
    const data = buildMultiUserPackage();
    expect(
      await codeOf(
        openDecryptingContainer({
          source: { kind: 'arraybuffer', data },
          credentials: { kind: 'password', password: 'PasswordA' },
        }),
      ),
    ).toBe('CRYPTO_USER_AMBIGUOUS');
  });

  it('用户名存在但口令错误返回 WRONG_PASSWORD 且不回显口令', async () => {
    const data = buildMultiUserPackage();
    let message = '';
    try {
      await openDecryptingContainer({
        source: { kind: 'arraybuffer', data },
        credentials: { kind: 'password', userName: 'user-a', password: 'PasswordB' },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('user-a');
    expect(message).not.toContain('PasswordB');
  });

  it('inspect 汇总多个用户', async () => {
    const result = await inspect({ kind: 'arraybuffer', data: buildMultiUserPackage() });
    expect(result.users.map((user) => user.userName)).toEqual(['user-a', 'user-b']);
  });
});
