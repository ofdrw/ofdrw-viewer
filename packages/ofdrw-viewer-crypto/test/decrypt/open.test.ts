/**
 * `openDecryptingContainer`：口令/证书解密、明文透传、错误凭据、路径映射、
 * engine 对接与关闭语义。
 */

import { createPrivateKey } from 'node:crypto';
import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';
import {
  CryptoError,
  openDecryptingContainer,
  type CryptoCredential,
} from '@ofdrw/ofdrw-viewer-crypto';
import { fixtureBytes, fixtureText } from '../core/fixtures';

/** 口令凭据。 */
const PASSWORD: CryptoCredential = {
  kind: 'password',
  userName: 'fixture-password-user',
  password: 'FixturePass123',
};

/** 证书用户私钥凭据。 */
function certCredential(
  pem = fixtureText('certs', 'encrypt.key.pem'),
  userName = 'fixture-cert-user',
): CryptoCredential {
  return { kind: 'private-key', userName, privateKey: { pem } };
}

/**
 * 以数组缓冲构造输入。
 *
 * @param name fixture 名。
 * @returns CryptoSource。
 */
function source(name: string): { kind: 'arraybuffer'; data: Uint8Array } {
  return { kind: 'arraybuffer', data: fixtureBytes(name) };
}

/**
 * 断言解密容器与基准 OFD 逐文件逐字节一致。
 *
 * @param container 解密容器。
 * @param expectedName 基准 fixture 名。
 */
async function expectSamePackage(
  container: { list(): readonly { path: string }[]; read(path: string): Promise<Uint8Array> },
  expectedName: string,
): Promise<void> {
  const expected = unzipSync(fixtureBytes(expectedName));
  const expectedPaths = Object.keys(expected).filter((path) => !path.endsWith('/'));
  const actualPaths = container.list().map((meta) => meta.path);
  expect([...actualPaths].sort()).toEqual([...expectedPaths].sort());
  for (const path of expectedPaths) {
    expect(Buffer.compare(Buffer.from(await container.read(path)), Buffer.from(expected[path] as Uint8Array))).toBe(0);
  }
}

/**
 * 捕获 CryptoError 并返回错误码。
 *
 * @param promise 待执行 promise。
 * @returns 错误码。
 */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CryptoError) return error.code;
    throw error;
  }
  throw new Error('promise 未按预期拒绝');
}

describe('openDecryptingContainer', () => {
  it('口令解密并映射为明文容器', async () => {
    const result = await openDecryptingContainer({
      source: source('password-encrypted.ofd'),
      credentials: PASSWORD,
    });
    expect(result.plaintext).toBe(false);
    expect(result.container.encrypted).toBe(false);
    expect(result.container.packageSize).toBe(fixtureBytes('password-encrypted.ofd').length);
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0]).toMatchObject({
      id: '1',
      decryptedEntries: 5,
      entriesMapMode: 'encrypted',
      user: { userName: 'fixture-password-user', method: 'password' },
    });
    expect(result.layers[0].removedMetadata).toEqual(
      expect.arrayContaining(['Encryptions.xml', 'decryptseed.dat', 'entriesmap.dat']),
    );
    const paths = result.container.list().map((meta) => meta.path);
    expect(paths).toEqual(
      expect.arrayContaining(['OFD.xml', 'Doc_0/Document.xml', 'Doc_0/Pages/Page_0/Content.xml']),
    );
    expect(paths.some((path) => path.toLowerCase().endsWith('.dat'))).toBe(false);
    expect(result.container.has('Encryptions.xml')).toBe(false);
    expect(result.container.has('entriesmap.dat')).toBe(false);
    const ofd = new TextDecoder().decode(await result.container.read('OFD.xml'));
    expect(ofd).toContain('<ofd:OFD');
    expect(ofd).not.toContain('EncryptedWK');
    await result.container.close();
  });

  it('口令/证书解密结果与明文基准逐文件一致', async () => {
    const password = await openDecryptingContainer({
      source: source('password-encrypted.ofd'),
      credentials: PASSWORD,
    });
    await expectSamePackage(password.container, 'plain.ofd');
    await password.container.close();
    const cert = await openDecryptingContainer({
      source: source('cert-encrypted.ofd'),
      credentials: certCredential(),
    });
    await expectSamePackage(cert.container, 'plain.ofd');
    await cert.container.close();
  });

  it('证书加密可用 SM2 私钥解密', async () => {
    const result = await openDecryptingContainer({
      source: source('cert-encrypted.ofd'),
      credentials: certCredential(),
    });
    expect(result.plaintext).toBe(false);
    expect(result.layers[0].user).toMatchObject({
      userName: 'fixture-cert-user',
      method: 'certificate',
    });
    expect(result.container.has('OFD.xml')).toBe(true);
    await result.container.close();
  });

  it('证书加密可用 PKCS#8 DER 私钥解密', async () => {
    const result = await openDecryptingContainer({
      source: source('cert-encrypted.ofd'),
      credentials: {
        kind: 'private-key',
        userName: 'fixture-cert-user',
        privateKey: { der: fixtureBytes('certs', 'encrypt.key.der') },
      },
    });
    expect(result.container.has('OFD.xml')).toBe(true);
    await result.container.close();
  });

  it('支持口令保护的 PKCS#8 私钥', async () => {
    const encrypted = createPrivateKey(fixtureText('certs', 'encrypt.key.pem'))
      .export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'KeyPass123' })
      .toString();
    const result = await openDecryptingContainer({
      source: source('cert-encrypted.ofd'),
      credentials: {
        kind: 'private-key',
        userName: 'fixture-cert-user',
        privateKey: { pem: encrypted, passphrase: 'KeyPass123' },
      },
    });
    expect(result.container.has('OFD.xml')).toBe(true);
    await result.container.close();
  });

  it('加密 PKCS#8 缺少/错误口令可区分且不泄漏口令', async () => {
    const encrypted = createPrivateKey(fixtureText('certs', 'encrypt.key.pem'))
      .export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'KeyPass123' })
      .toString();
    const base = {
      kind: 'private-key' as const,
      userName: 'fixture-cert-user',
      privateKey: { pem: encrypted },
    };
    expect(await codeOf(openDecryptingContainer({
      source: source('cert-encrypted.ofd'),
      credentials: base,
    }))).toBe('CRYPTO_PRIVATE_KEY_PASSPHRASE_REQUIRED');
    const wrong = {
      ...base,
      privateKey: { pem: encrypted, passphrase: 'WrongPass' },
    };
    let message = '';
    try {
      await openDecryptingContainer({ source: source('cert-encrypted.ofd'), credentials: wrong });
    } catch (error) {
      expect(error).toBeInstanceOf(CryptoError);
      message = (error as CryptoError).message;
    }
    expect(message).toBeTruthy();
    expect(message).not.toContain('WrongPass');
    expect(message).not.toContain('KeyPass123');
  });

  it('组合包解密后可见签名与完整性', async () => {
    const result = await openDecryptingContainer({
      source: source('combined-password-encrypted.ofd'),
      credentials: PASSWORD,
    });
    expect(result.inspection.encrypted).toBe(true);
    expect(result.inspection.signatures).toHaveLength(1);
    expect(result.inspection.integrityPresent).toBe(true);
    expect(result.container.has('Doc_0/Signs/Sign_0/SignedValue.dat')).toBe(true);
    await expectSamePackage(result.container, 'combined-signed-integrity.ofd');
    await result.container.close();
  });

  it('非根签名清单的相对 BaseLoc 在 open 结果中可解析', async () => {
    const files = unzipSync(fixtureBytes('plain.ofd'));
    files['Doc_0/Signatures.xml'] = new TextEncoder().encode(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<ofd:Signatures xmlns:ofd="http://www.ofdspec.org/2016">' +
        '<ofd:Signature ID="nested" Type="Seal" BaseLoc="Sign_0/Signature.xml"/>' +
        '</ofd:Signatures>',
    );
    files['Doc_0/Sign_0/SignedValue.dat'] = Uint8Array.of(1);
    const result = await openDecryptingContainer({
      source: { kind: 'arraybuffer', data: zipSync(files, { level: 0 }) },
    });
    expect(result.plaintext).toBe(true);
    expect(result.inspection.signatures[0]?.signedValuePath).toBe(
      'Doc_0/Sign_0/SignedValue.dat',
    );
    await result.container.close();
  });

  it('明文分支 onWarning 取消后拒绝且不返回容器', async () => {
    const controller = new AbortController();
    await expect(
      openDecryptingContainer({
        source: source('plain.ofd'),
        credentials: PASSWORD,
        signal: controller.signal,
        onWarning: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ code: 'CRYPTO_ABORTED' });
  });

  it('明文包原样透传并忽略凭据', async () => {
    const result = await openDecryptingContainer({
      source: source('plain.ofd'),
      credentials: PASSWORD,
    });
    expect(result.plaintext).toBe(true);
    expect(result.layers).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).toContain('W_CRYPTO_CREDENTIAL_IGNORED');
    expect(result.container.packageSize).toBe(fixtureBytes('plain.ofd').length);
    expect(result.container.has('OFD.xml')).toBe(true);
    await result.container.close();
  });

  it('加密包缺少凭据 / 用户名不存在 / 口令错误返回可区分错误', async () => {
    expect(await codeOf(openDecryptingContainer({ source: source('password-encrypted.ofd') }))).toBe(
      'CRYPTO_CREDENTIALS_REQUIRED',
    );
    expect(
      await codeOf(
        openDecryptingContainer({
          source: source('password-encrypted.ofd'),
          credentials: { ...PASSWORD, userName: 'no-such-user' },
        }),
      ),
    ).toBe('CRYPTO_USER_NOT_FOUND');
    expect(
      await codeOf(
        openDecryptingContainer({
          source: source('password-encrypted.ofd'),
          credentials: { ...PASSWORD, password: 'WrongPass' },
        }),
      ),
    ).toBe('CRYPTO_WRONG_PASSWORD');
  });

  it('证书私钥不匹配抛 PRIVATE_KEY_MISMATCH', async () => {
    expect(
      await codeOf(
        openDecryptingContainer({
          source: source('cert-encrypted.ofd'),
          credentials: certCredential(fixtureText('certs', 'signer.key.pem')),
        }),
      ),
    ).toBe('CRYPTO_PRIVATE_KEY_MISMATCH');
  });

  it('唯一用户可省略 userName 自动匹配', async () => {
    const password = await openDecryptingContainer({
      source: source('password-encrypted.ofd'),
      credentials: { kind: 'password', password: 'FixturePass123' },
    });
    expect(password.container.has('OFD.xml')).toBe(true);
    await password.container.close();
    const cert = await openDecryptingContainer({
      source: source('cert-encrypted.ofd'),
      credentials: { kind: 'private-key', privateKey: { pem: fixtureText('certs', 'encrypt.key.pem') } },
    });
    expect(cert.container.has('OFD.xml')).toBe(true);
    await cert.container.close();
  });

  it('多凭据按顺序尝试，错误口令后继续', async () => {
    const result = await openDecryptingContainer({
      source: source('password-encrypted.ofd'),
      credentials: [{ ...PASSWORD, password: 'WrongPass' }, PASSWORD],
    });
    expect(result.container.has('OFD.xml')).toBe(true);
    await result.container.close();
  });

  it('解密后可由 engine 打开并完成元数据/页面准备', async () => {
    const result = await openDecryptingContainer({
      source: source('combined-password-encrypted.ofd'),
      credentials: PASSWORD,
    });
    const doc = await OFDDocument.open({ container: result.container });
    try {
      const metadata = await doc.getMetadata();
      expect(metadata.pageCount).toBeGreaterThan(0);
      const pages = await doc.getPageInfos();
      expect(pages.length).toBe(metadata.pageCount);
      const page = await doc.getPage(0);
      await page.prepare();
      expect(page.getSize().width).toBeGreaterThan(0);
      expect(page.getSize().height).toBeGreaterThan(0);
    } finally {
      await doc.close();
      await result.container.close();
    }
  });

  it('容器关闭后 engine 读取抛 OFD_CLOSED，重复关闭幂等', async () => {
    const result = await openDecryptingContainer({
      source: source('password-encrypted.ofd'),
      credentials: PASSWORD,
    });
    await result.container.close();
    await result.container.close();
    expect(() => result.container.list()).toThrow();
    await expect(result.container.read('OFD.xml')).rejects.toMatchObject({ code: 'OFD_CLOSED' });
  });
  it('未加密私钥带 passphrase 时产生 warning 并继续解密', async () => {
    const result = await openDecryptingContainer({
      source: source('cert-encrypted.ofd'),
      credentials: certCredential(fixtureText('certs', 'encrypt.key.pem'), 'fixture-cert-user'),
    });
    // 先确认基线无 warning，再用同一私钥附加无用 passphrase。
    expect(result.warnings).toEqual([]);
    await result.container.close();
    const withPassphrase = await openDecryptingContainer({
      source: source('cert-encrypted.ofd'),
      credentials: {
        kind: 'private-key',
        userName: 'fixture-cert-user',
        privateKey: {
          pem: fixtureText('certs', 'encrypt.key.pem'),
          passphrase: 'unused-passphrase',
        },
      },
    });
    expect(withPassphrase.warnings.map((warning) => warning.code)).toContain(
      'W_CRYPTO_CREDENTIAL_IGNORED',
    );
    expect(withPassphrase.container.has('OFD.xml')).toBe(true);
    await withPassphrase.container.close();
  });

  it('同一私钥凭据可重复解密，不依赖已清零的私钥对象', async () => {
    const credential = {
      kind: 'private-key' as const,
      userName: 'fixture-cert-user',
      privateKey: { pem: fixtureText('certs', 'encrypt.key.pem') },
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await openDecryptingContainer({
        source: source('cert-encrypted.ofd'),
        credentials: credential,
      });
      expect(result.container.has('OFD.xml')).toBe(true);
      await result.container.close();
    }
  });

  it('坏 Base64 PEM 映射为 CRYPTO_PRIVATE_KEY_INVALID', async () => {
    const badPem = [
      '-----BEGIN PRIVATE KEY-----',
      '!!!!',
      '-----END PRIVATE KEY-----',
    ].join('\n');
    expect(
      await codeOf(
        openDecryptingContainer({
          source: source('cert-encrypted.ofd'),
          credentials: {
            kind: 'private-key',
            userName: 'fixture-cert-user',
            privateKey: { pem: badPem },
          },
        }),
      ),
    ).toBe('CRYPTO_PRIVATE_KEY_INVALID');
  });

});
