/**
 * V-DEC 独立验收：错误凭据、损坏密文、资源上限、敏感信息与重试/并发。
 */

import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  inspect,
  openDecryptingContainer,
  type CryptoCredential,
  type CryptoError,
} from '@ofdrw/ofdrw-viewer-crypto';
import {
  PASSWORD_CREDENTIAL,
  certCredential,
  codeOf,
  decryptBytes,
  errorOf,
  fixtureBytes,
  fixtureText,
  rewriteZip,
  source,
} from './support';

/** 用于泄漏检查的口令。 */
const SECRET_PASSWORD = 'WrongSecret-9f3a-do-not-leak';

/** 读取原始包字节。 */
const PASSWORD_PACKAGE = fixtureBytes('password-encrypted.ofd');

/** 读取证书包字节。 */
const CERT_PACKAGE = fixtureBytes('cert-encrypted.ofd');

/**
 * 断言消息与堆栈不含敏感串。
 *
 * @param error 错误。
 * @param secrets 敏感串列表。
 */
function expectNoSecrets(error: CryptoError, secrets: readonly string[]): void {
  const text = `${error.message}\n${error.stack ?? ''}\n${JSON.stringify(error)}`;
  for (const secret of secrets) expect(text).not.toContain(secret);
}

describe('凭据错误可区分且不泄漏敏感信息', () => {
  it('缺失凭据、空凭据字段与非法形状', async () => {
    expect(await codeOf(openDecryptingContainer({ source: source('password-encrypted.ofd') }))).toBe(
      'CRYPTO_CREDENTIALS_REQUIRED',
    );
    expect(
      await codeOf(
        openDecryptingContainer({
          source: source('password-encrypted.ofd'),
          credentials: { kind: 'password', password: '' },
        }),
      ),
    ).toBe('CRYPTO_CREDENTIALS_REQUIRED');
    expect(
      await codeOf(
        openDecryptingContainer({
          source: source('password-encrypted.ofd'),
          credentials: { kind: 'unknown' } as unknown as CryptoCredential,
        }),
      ),
    ).toBe('CRYPTO_INVALID_ARGUMENT');
    expect(
      await codeOf(
        openDecryptingContainer({
          source: source('password-encrypted.ofd'),
          credentials: { kind: 'private-key' } as unknown as CryptoCredential,
        }),
      ),
    ).toBe('CRYPTO_INVALID_ARGUMENT');
    expect(
      await codeOf(
        openDecryptingContainer({
          source: source('password-encrypted.ofd'),
          credentials: {
            kind: 'private-key',
            privateKey: { pem: 'x', der: new Uint8Array(1) },
          },
        }),
      ),
    ).toBe('CRYPTO_INVALID_ARGUMENT');
  });

  it('错误口令/用户不存在/凭据类型不匹配返回不同错误码', async () => {
    const wrongPassword = await errorOf(
      openDecryptingContainer({
        source: source('password-encrypted.ofd'),
        credentials: { ...PASSWORD_CREDENTIAL, password: SECRET_PASSWORD } as CryptoCredential,
      }),
    );
    expect(wrongPassword.code).toBe('CRYPTO_WRONG_PASSWORD');
    expectNoSecrets(wrongPassword, [SECRET_PASSWORD, 'FixturePass123']);

    expect(
      await codeOf(
        openDecryptingContainer({
          source: source('password-encrypted.ofd'),
          credentials: { kind: 'password', userName: 'no-such-user', password: 'x' },
        }),
      ),
    ).toBe('CRYPTO_USER_NOT_FOUND');

    expect(
      await codeOf(
        openDecryptingContainer({
          source: source('cert-encrypted.ofd'),
          credentials: { kind: 'password', password: 'FixturePass123' },
        }),
      ),
    ).toBe('CRYPTO_USER_NOT_FOUND');

    expect(
      await codeOf(
        openDecryptingContainer({
          source: source('password-encrypted.ofd'),
          credentials: certCredential(),
        }),
      ),
    ).toBe('CRYPTO_USER_NOT_FOUND');
  });

  it('错误/畸形/口令保护私钥返回可区分错误且不泄漏密钥内容', async () => {
    const wrongKeyPem = fixtureText('certs', 'signer.key.pem');
    const mismatch = await errorOf(
      openDecryptingContainer({
        source: source('cert-encrypted.ofd'),
        credentials: {
          kind: 'private-key',
          userName: 'fixture-cert-user',
          privateKey: { pem: wrongKeyPem },
        },
      }),
    );
    expect(mismatch.code).toBe('CRYPTO_PRIVATE_KEY_MISMATCH');
    expectNoSecrets(mismatch, [wrongKeyPem.slice(40, 100), 'PRIVATE KEY']);

    const malformed = await errorOf(
      openDecryptingContainer({
        source: source('cert-encrypted.ofd'),
        credentials: {
          kind: 'private-key',
          userName: 'fixture-cert-user',
          privateKey: { pem: 'not a private key' },
        },
      }),
    );
    expect(malformed.code).toBe('CRYPTO_PRIVATE_KEY_INVALID');

    const encryptedPem = createPrivateKey(fixtureText('certs', 'encrypt.key.pem'))
      .export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'KeyPass123' })
      .toString();
    expect(
      await codeOf(
        openDecryptingContainer({
          source: source('cert-encrypted.ofd'),
          credentials: {
            kind: 'private-key',
            userName: 'fixture-cert-user',
            privateKey: { pem: encryptedPem },
          },
        }),
      ),
    ).toBe('CRYPTO_PRIVATE_KEY_PASSPHRASE_REQUIRED');
    const wrongPassphrase = await errorOf(
      openDecryptingContainer({
        source: source('cert-encrypted.ofd'),
        credentials: {
          kind: 'private-key',
          userName: 'fixture-cert-user',
          privateKey: { pem: encryptedPem, passphrase: 'WrongKeyPass' },
        },
      }),
    );
    expect(wrongPassphrase.code).toBe('CRYPTO_PRIVATE_KEY_INVALID');
    expectNoSecrets(wrongPassphrase, ['WrongKeyPass', 'KeyPass123', encryptedPem.slice(40, 90)]);
  });
});

describe('损坏密文与加密元数据', () => {
  it('缺少/损坏 decryptseed、entriesmap、Encryptions.xml 返回结构错误', async () => {
    expect(
      await codeOf(decryptBytes(rewriteZip(PASSWORD_PACKAGE, (entries) => {
        delete entries['decryptseed.dat'];
      }), PASSWORD_CREDENTIAL)),
    ).toBe('CRYPTO_INVALID_PACKAGE');

    expect(
      await codeOf(decryptBytes(rewriteZip(PASSWORD_PACKAGE, (entries) => {
        delete entries['entriesmap.dat'];
      }), PASSWORD_CREDENTIAL)),
    ).toBe('CRYPTO_ENTRY_MAP_INVALID');

    expect(
      await codeOf(decryptBytes(rewriteZip(PASSWORD_PACKAGE, (entries) => {
        entries['entriesmap.dat']![0] ^= 0xff;
      }), PASSWORD_CREDENTIAL)),
    ).toBe('CRYPTO_ENTRY_MAP_INVALID');

    expect(
      await codeOf(decryptBytes(rewriteZip(PASSWORD_PACKAGE, (entries) => {
        entries['decryptseed.dat']![10] ^= 0xff;
      }), PASSWORD_CREDENTIAL)),
    ).toBe('CRYPTO_INVALID_PACKAGE');

    expect(
      await codeOf(decryptBytes(rewriteZip(PASSWORD_PACKAGE, (entries) => {
        entries['Encryptions.xml'] = new TextEncoder().encode('<x');
      }), PASSWORD_CREDENTIAL)),
    ).toBe('CRYPTO_INVALID_PACKAGE');
  });

  it('截断密文条目导致条目解密失败', async () => {
    const tampered = rewriteZip(PASSWORD_PACKAGE, (entries) => {
      const target = Object.keys(entries).find(
        (path) => path.endsWith('.dat') && path !== 'decryptseed.dat' && path !== 'entriesmap.dat',
      );
      expect(target).toBeTruthy();
      entries[target as string] = entries[target as string]!.slice(0, -1);
    });
    expect(await codeOf(decryptBytes(tampered, PASSWORD_CREDENTIAL))).toBe(
      'CRYPTO_ENTRY_MAP_INVALID',
    );
  });

  it('非 ZIP / 空输入 / 非法来源返回包或来源错误', async () => {
    await expect(inspect({ kind: 'arraybuffer', data: new Uint8Array(0) })).rejects.toMatchObject({
      code: 'CRYPTO_INVALID_PACKAGE',
    });
    await expect(
      inspect({ kind: 'arraybuffer', data: new TextEncoder().encode('not a zip') }),
    ).rejects.toMatchObject({ code: 'CRYPTO_INVALID_PACKAGE' });
    await expect(
      openDecryptingContainer({ source: undefined as never }),
    ).rejects.toMatchObject({ code: 'CRYPTO_SOURCE_UNSUPPORTED' });
  });
});

describe('资源上限与取消', () => {
  it('包/条目/解压总量/XML/层数上限均有明确错误码', async () => {
    const cases: readonly [Record<string, number>, string][] = [
      [{ maxSourceBytes: 100 }, 'CRYPTO_LIMIT_EXCEEDED'],
      [{ maxEntries: 2 }, 'CRYPTO_LIMIT_EXCEEDED'],
      [{ maxEntryBytes: 20 }, 'CRYPTO_LIMIT_EXCEEDED'],
      [{ maxTotalDecryptedBytes: 100 }, 'CRYPTO_LIMIT_EXCEEDED'],
      [{ maxAsn1Bytes: 100 }, 'CRYPTO_LIMIT_EXCEEDED'],
    ];
    for (const [limits, expected] of cases) {
      expect(
        await codeOf(
          openDecryptingContainer({
            source: source('password-encrypted.ofd'),
            credentials: PASSWORD_CREDENTIAL,
            limits,
          }),
        ),
        JSON.stringify(limits),
      ).toBe(expected);
    }
    const singleLayer = await openDecryptingContainer({
      source: source('password-encrypted.ofd'),
      credentials: PASSWORD_CREDENTIAL,
      limits: { maxDecryptLayers: 1 },
    });
    expect(singleLayer.container.has('OFD.xml')).toBe(true);
    await singleLayer.container.close();
    expect(
      await codeOf(
        openDecryptingContainer({
          source: source('password-encrypted.ofd'),
          credentials: PASSWORD_CREDENTIAL,
          limits: { maxDecryptLayers: 0 },
        }),
      ),
    ).toBe('CRYPTO_INVALID_ARGUMENT');
  });

  it('已中止信号在读取前拒绝；inspect 同样支持取消', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await codeOf(
        openDecryptingContainer({
          source: source('password-encrypted.ofd'),
          credentials: PASSWORD_CREDENTIAL,
          signal: controller.signal,
        }),
      ),
    ).toBe('CRYPTO_ABORTED');
    expect(
      await codeOf(inspect(source('plain.ofd'), { signal: controller.signal })),
    ).toBe('CRYPTO_ABORTED');
  });

  it('blob 与 url 数据源可用，URL 超限被拒绝', async () => {
    const blob = new Blob([fixtureBytes('password-encrypted.ofd').buffer as ArrayBuffer]);
    const fromBlob = await openDecryptingContainer({
      source: { kind: 'blob', blob },
      credentials: PASSWORD_CREDENTIAL,
    });
    expect(fromBlob.container.has('OFD.xml')).toBe(true);
    await fromBlob.container.close();

    const url = `data:application/ofd;base64,${Buffer.from(PASSWORD_PACKAGE).toString('base64')}`;
    const fromUrl = await openDecryptingContainer({
      source: { kind: 'url', url },
      credentials: PASSWORD_CREDENTIAL,
    });
    expect(fromUrl.container.has('OFD.xml')).toBe(true);
    await fromUrl.container.close();

    expect(
      await codeOf(
        openDecryptingContainer({
          source: { kind: 'url', url },
          credentials: PASSWORD_CREDENTIAL,
          limits: { maxSourceBytes: 100 },
        }),
      ),
    ).toBe('CRYPTO_LIMIT_EXCEEDED');
  });
});

describe('重试与并发不损坏状态', () => {
  it('同一源错误口令后重试正确口令、再次重试仍成功', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        await codeOf(
          openDecryptingContainer({
            source: source('password-encrypted.ofd'),
            credentials: { ...PASSWORD_CREDENTIAL, password: SECRET_PASSWORD } as CryptoCredential,
          }),
        ),
      ).toBe('CRYPTO_WRONG_PASSWORD');
      const result = await openDecryptingContainer({
        source: source('password-encrypted.ofd'),
        credentials: PASSWORD_CREDENTIAL,
      });
      expect(result.container.has('OFD.xml')).toBe(true);
      await result.container.close();
    }
  });

  it('并发解密同一/不同样例互不干扰', async () => {
    const jobs: Promise<unknown>[] = [];
    for (let index = 0; index < 4; index += 1) {
      jobs.push(
        openDecryptingContainer({
          source: source('password-encrypted.ofd'),
          credentials: PASSWORD_CREDENTIAL,
        }),
      );
      jobs.push(
        openDecryptingContainer({
          source: source('cert-encrypted.ofd'),
          credentials: certCredential(),
        }),
      );
    }
    const results = await Promise.all(jobs);
    try {
      for (const result of results as Awaited<ReturnType<typeof openDecryptingContainer>>[]) {
        expect(result.container.has('OFD.xml')).toBe(true);
        const [first, second] = await Promise.all([
          result.container.read('OFD.xml'),
          result.container.read('OFD.xml'),
        ]);
        expect(first).toEqual(second);
      }
    } finally {
      await Promise.all(
        (results as Awaited<ReturnType<typeof openDecryptingContainer>>[]).map((result) =>
          result.container.close(),
        ),
      );
    }
  });

  it('并发读取返回独立副本，关闭后读取明确失败', async () => {
    const result = await openDecryptingContainer({
      source: source('password-encrypted.ofd'),
      credentials: PASSWORD_CREDENTIAL,
    });
    const [left, right] = await Promise.all([
      result.container.read('OFD.xml'),
      result.container.read('OFD.xml'),
    ]);
    expect(left).toEqual(right);
    expect(await result.container.read('OFD.xml')).toEqual(left);
    left[0] = 0xff;
    expect((await result.container.read('OFD.xml'))[0]).not.toBe(0xff);
    await result.container.close();
    await result.container.close();
    expect(result.container.has('OFD.xml')).toBe(false);
    expect(result.container.stat('OFD.xml')).toBeUndefined();
    expect(() => result.container.list()).toThrowError();
    await expect(result.container.read('OFD.xml')).rejects.toMatchObject({ code: 'OFD_CLOSED' });
  });
});
