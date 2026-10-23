/**
 * V-DEC 独立验收：加密检测、口令/证书/组合解密、明文透传、Java 基准逐文件
 * 对比与 engine 打开/页面渲染准备。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';
import {
  inspect,
  parseCertificate,
  toCertificateSummary,
} from '@ofdrw/ofdrw-viewer-crypto';
import {
  JAVA_EXPECTED_PATH,
  PASSWORD_CREDENTIAL,
  certCredential,
  codeOf,
  decryptFixture,
  diffDigests,
  digestEntries,
  fixtureBytes,
  readEntries,
  source,
} from './support';

/** Java 基准结构。 */
interface JavaExpected {
  readonly generatedBy: string;
  readonly cases: Readonly<
    Record<string, Readonly<Record<string, { readonly size: number; readonly sha256: string }>>>
  >;
}

/** Java 解密基准。 */
const JAVA = JSON.parse(readFileSync(JAVA_EXPECTED_PATH, 'utf8')) as JavaExpected;

describe('加密检测 inspect', () => {
  it('口令加密：识别层、用户、元数据与原始包大小', async () => {
    const result = await inspect(source('password-encrypted.ofd'));
    expect(result.encrypted).toBe(true);
    expect(result.packageSize).toBe(fixtureBytes('password-encrypted.ofd').length);
    expect(result.entryCount).toBe(8);
    expect(result.ofdVersion).toBeUndefined();
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0]).toMatchObject({
      layer: 0,
      id: '1',
      decryptSeedPath: 'decryptseed.dat',
      entriesMapPath: 'entriesmap.dat',
    });
    expect(result.layers[0].encryptDate).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(result.users).toEqual([
      { userName: 'fixture-password-user', method: 'password' },
    ]);
    expect(result.signatures).toEqual([]);
    expect(result.integrityPresent).toBe(false);
  });

  it('证书加密：识别证书用户并输出与证书文件一致的摘要', async () => {
    const result = await inspect(source('cert-encrypted.ofd'));
    expect(result.encrypted).toBe(true);
    expect(result.entryCount).toBe(8);
    expect(result.users).toHaveLength(1);
    const user = result.users[0];
    expect(user.userName).toBe('fixture-cert-user');
    expect(user.method).toBe('certificate');
    const expected = toCertificateSummary(parseCertificate(fixtureBytes('certs', 'encrypt.crt.der')));
    expect(user.certificate).toEqual(expected);
    expect(user.certificate?.fingerprintSha256).toBe(
      '20fd11b661cf3638747de012a72b26f61dc48af95cd7eb5b7c41834e38332331',
    );
    expect(user.certificate?.subject).toContain('Encrypt');
  });

  it('明文包：不识别加密层，可直接读取 OFD 版本', async () => {
    const result = await inspect(source('plain.ofd'));
    expect(result.encrypted).toBe(false);
    expect(result.layers).toEqual([]);
    expect(result.users).toEqual([]);
    expect(result.ofdVersion).toBe('1.0');
    expect(result.entryCount).toBe(5);
    expect(result.packageSize).toBe(5226);
    expect(result.signatures).toEqual([]);
    expect(result.integrityPresent).toBe(false);
  });

  it('组合加密包在解密前不暴露签名/完整性内容', async () => {
    const result = await inspect(source('combined-password-encrypted.ofd'));
    expect(result.encrypted).toBe(true);
    expect(result.entryCount).toBe(14);
    expect(result.layers).toHaveLength(1);
    expect(result.signatures).toEqual([]);
    expect(result.integrityPresent).toBe(false);
  });
});

describe('解密结果与 Java OFDDecryptor 基准', () => {
  it('Java 基准自身证明：口令/证书解密结果等于明文，组合解密等于签名+完整性中间态', () => {
    expect(JAVA.generatedBy).toContain('ofdrw 2.4.0');
    expect(JAVA.cases['password-encrypted.ofd']).toEqual(JAVA.cases['plain.ofd']);
    expect(JAVA.cases['cert-encrypted.ofd']).toEqual(JAVA.cases['plain.ofd']);
    expect(JAVA.cases['combined-password-encrypted.ofd']).toEqual(
      JAVA.cases['combined-signed-integrity.ofd'],
    );
    expect(Object.keys(JAVA.cases['plain.ofd'] ?? {})).toHaveLength(5);
  });

  it('口令解密逐文件与 Java OFDDecryptor 输出一致', async () => {
    const result = await decryptFixture('password-encrypted.ofd', PASSWORD_CREDENTIAL);
    try {
      expect(result.plaintext).toBe(false);
      expect(result.layers).toHaveLength(1);
      expect(result.layers[0]).toMatchObject({
        id: '1',
        user: { userName: 'fixture-password-user', method: 'password' },
        entriesMapMode: 'encrypted',
        decryptedEntries: 5,
      });
      expect(result.layers[0].removedMetadata).toEqual(
        expect.arrayContaining(['Encryptions.xml', 'decryptseed.dat', 'entriesmap.dat']),
      );
      expect(result.container.encrypted).toBe(false);
      expect(result.container.packageSize).toBe(fixtureBytes('password-encrypted.ofd').length);
      expect(diffDigests(await digestEntries(result.container), JAVA.cases['password-encrypted.ofd'] ?? {})).toEqual([]);
    } finally {
      await result.container.close();
    }
  });

  it('证书解密（PEM 私钥）逐文件与 Java OFDDecryptor 输出一致', async () => {
    const result = await decryptFixture('cert-encrypted.ofd', certCredential());
    try {
      expect(result.layers[0].user).toMatchObject({
        userName: 'fixture-cert-user',
        method: 'certificate',
      });
      expect(diffDigests(await digestEntries(result.container), JAVA.cases['cert-encrypted.ofd'] ?? {})).toEqual([]);
    } finally {
      await result.container.close();
    }
  });

  it('证书解密支持 PKCS#8 DER 私钥，结果与 PEM 相同', async () => {
    const result = await decryptFixture('cert-encrypted.ofd', {
      kind: 'private-key',
      userName: 'fixture-cert-user',
      privateKey: { der: fixtureBytes('certs', 'encrypt.key.der') },
    });
    try {
      expect(diffDigests(await digestEntries(result.container), JAVA.cases['cert-encrypted.ofd'] ?? {})).toEqual([]);
    } finally {
      await result.container.close();
    }
  });

  it('组合样例解密后与 Java 的签名+完整性中间态逐文件一致，并保留签名/完整性', async () => {
    const result = await decryptFixture('combined-password-encrypted.ofd', PASSWORD_CREDENTIAL);
    try {
      expect(result.layers[0].decryptedEntries).toBe(11);
      expect(diffDigests(await digestEntries(result.container), JAVA.cases['combined-password-encrypted.ofd'] ?? {})).toEqual([]);
      expect(result.inspection.encrypted).toBe(true);
      expect(result.inspection.signatures).toHaveLength(1);
      expect(result.inspection.signatures[0]).toMatchObject({ id: 's001', type: 'Seal' });
      expect(result.inspection.integrityPresent).toBe(true);
      expect(result.container.has('Doc_0/Signs/Sign_0/SignedValue.dat')).toBe(true);
      expect(result.container.has('OFDEntries.xml')).toBe(true);
    } finally {
      await result.container.close();
    }
  });

  it('明文包原样透传：字节、包大小与 Java 明文基准一致', async () => {
    const result = await decryptFixture('plain.ofd', PASSWORD_CREDENTIAL);
    try {
      expect(result.plaintext).toBe(true);
      expect(result.layers).toEqual([]);
      expect(result.warnings.map((warning) => warning.code)).toContain(
        'W_CRYPTO_CREDENTIAL_IGNORED',
      );
      expect(result.container.packageSize).toBe(fixtureBytes('plain.ofd').length);
      expect(diffDigests(await digestEntries(result.container), JAVA.cases['plain.ofd'] ?? {})).toEqual([]);
      expect(result.container.has('OFD.xml')).toBe(true);
    } finally {
      await result.container.close();
    }
  });
});

describe('解密后 engine 打开与页面渲染准备', () => {
  it('engine 打开的页数、元数据、页尺寸与明文基准一致', async () => {
    const plainDoc = await OFDDocument.open({ source: source('plain.ofd') });
    const decrypted = await decryptFixture('password-encrypted.ofd', PASSWORD_CREDENTIAL);
    const decryptedDoc = await OFDDocument.open({ container: decrypted.container });
    try {
      expect(decryptedDoc.pageCount).toBe(plainDoc.pageCount);
      expect(decryptedDoc.pageCount).toBe(2);

      const plainMeta = await plainDoc.getMetadata();
      const decryptedMeta = await decryptedDoc.getMetadata();
      expect(decryptedMeta.version).toBe(plainMeta.version);
      expect(decryptedMeta.pageCount).toBe(plainMeta.pageCount);
      expect(decryptedMeta.docId).toBe(plainMeta.docId);
      expect(decryptedMeta.creator).toBe(plainMeta.creator);
      expect(decryptedMeta.creationDate).toBe(plainMeta.creationDate);
      expect(decryptedMeta.packageSize).toBe(fixtureBytes('password-encrypted.ofd').length);

      const plainInfos = await plainDoc.getPageInfos();
      const decryptedInfos = await decryptedDoc.getPageInfos();
      expect(decryptedInfos).toEqual(plainInfos);
      expect(decryptedInfos).toHaveLength(2);

      for (let index = 0; index < decryptedDoc.pageCount; index += 1) {
        const plainPage = await plainDoc.getPage(index);
        const decryptedPage = await decryptedDoc.getPage(index);
        expect(decryptedPage.getSize()).toEqual(plainPage.getSize());
        await expect(decryptedPage.prepare()).resolves.toBeUndefined();
        const text = await decryptedPage.getTextContent();
        expect(text.pageIndex).toBe(index);
        expect(text.items).toEqual(await plainPage.getTextContent().then((value) => value.items));
      }
    } finally {
      await decryptedDoc.close();
      await plainDoc.close();
      // engine 借用容器：doc.close 后容器仍由调用方持有并可用。
      expect(decrypted.container.has('OFD.xml')).toBe(true);
      await decrypted.container.close();
    }
  });

  it('engine 直接打开原始加密源应拒绝并提示先解密', async () => {
    expect(
      await codeOf(OFDDocument.open({ source: source('password-encrypted.ofd') })),
    ).toBe('OFD_ENCRYPTED');
  });

  it('组合样例解密后 engine 可打开全部页面并完成 prepare', async () => {
    const decrypted = await decryptFixture('combined-password-encrypted.ofd', PASSWORD_CREDENTIAL);
    const doc = await OFDDocument.open({ container: decrypted.container });
    try {
      expect(doc.pageCount).toBe(2);
      const infos = await doc.getPageInfos({ start: 0, count: 2 });
      expect(infos.map((info) => [info.widthMm, info.heightMm])).toEqual([
        [210, 297],
        [210, 297],
      ]);
      for (let index = 0; index < doc.pageCount; index += 1) {
        const page = await doc.getPage(index);
        await expect(page.prepare()).resolves.toBeUndefined();
      }
      const entries = await readEntries(decrypted.container);
      expect(entries.has('Doc_0/Signs/Sign_0/Seal.esl')).toBe(true);
      expect(entries.has('signedvalue.dat')).toBe(true);
    } finally {
      await doc.close();
      await decrypted.container.close();
    }
  });
});
