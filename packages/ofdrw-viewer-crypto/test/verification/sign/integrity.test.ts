/**
 * t13 独立验证：防夹带完整性、缺失/新增文件、OFDEntries 签名篡改与无保护语义。
 */

import { describe, expect, it } from 'vitest';
import { verifyOfd } from '@ofdrw/ofdrw-viewer-crypto';
import {
  fixtureBytes,
  javaIntegrity,
  memoryContainer,
  openFixtureEntries,
  verifyContainer,
  verifyFixture,
  verifyOptions,
  wrongRootPem,
} from './support';

describe('防夹带完整性正向', () => {
  it('integrity.ofd 清单与包内文件一致，Java OFDIntegrityVerifier 通过', async () => {
    const report = await verifyFixture('integrity.ofd');
    expect(report.overall).toBe('valid');
    expect(report.package.integrityPresent).toBe(true);
    expect(report.package.signatureCount).toBe(0);
    expect(report.signatures).toEqual([]);
    expect(javaIntegrity('integrity.ofd').valid).toBe(true);
    expect(report.integrity).toMatchObject({
      status: 'valid',
      entriesPath: 'OFDEntries.xml',
      signedValuePath: 'signedvalue.dat',
      fileListCount: 5,
      actualFileCount: 5,
      missingFiles: [],
      extraFiles: [],
      authenticatedAttributes: false,
    });
    expect(report.integrity?.signature.status).toBe('valid');
    expect(report.integrity?.certificate.status).toBe('valid');
    expect(report.integrity?.issues).toEqual([]);
  });

  it('签名 + 完整性组合 → 两块均 valid', async () => {
    const report = await verifyFixture('combined-signed-integrity.ofd');
    expect(report.overall).toBe('valid');
    expect(report.integrity?.status).toBe('valid');
    expect(report.signatures[0]?.status).toBe('valid');
    expect(javaIntegrity('combined-signed-integrity.ofd').valid).toBe(true);
    expect(JSON.parse(JSON.stringify(report)).integrity.status).toBe('valid');
  });

  it('加密 source 自动解密后完整性仍为 valid', async () => {
    const report = await verifyOfd({
      source: { kind: 'arraybuffer', data: fixtureBytes('combined-password-encrypted.ofd') },
      credentials: {
        kind: 'password',
        userName: 'fixture-password-user',
        password: 'FixturePass123',
      },
      ...verifyOptions(),
    });
    expect(report.overall).toBe('valid');
    expect(report.package).toMatchObject({
      encrypted: true,
      decrypted: true,
      integrityPresent: true,
    });
    expect(report.integrity?.status).toBe('valid');
    expect(report.signatures[0]?.status).toBe('valid');
  });
});

describe('防夹带完整性负例', () => {
  it('新增未登记文件 → extraFiles/INTEGRITY_EXTRA_FILE，与 Java 一致', async () => {
    const report = await verifyFixture('negative-extra-file.ofd');
    expect(report.overall).toBe('invalid');
    expect(javaIntegrity('negative-extra-file.ofd').valid).toBe(false);
    expect(report.integrity?.status).toBe('invalid');
    expect(report.integrity?.extraFiles).toEqual(['evil.txt']);
    expect(report.integrity?.fileListCount).toBe(5);
    expect(report.integrity?.actualFileCount).toBe(6);
    expect(report.integrity?.issues).toContainEqual(
      expect.objectContaining({ code: 'INTEGRITY_EXTRA_FILE', path: 'evil.txt' }),
    );
  });

  it('清单登记文件缺失 → missingFiles/INTEGRITY_FILE_MISSING', async () => {
    const entries = openFixtureEntries('integrity.ofd');
    entries.delete('Doc_0/PublicRes.xml');
    const container = memoryContainer(entries);
    try {
      const report = await verifyContainer(container);
      expect(report.overall).toBe('invalid');
      expect(report.integrity?.status).toBe('invalid');
      expect(report.integrity?.missingFiles).toEqual(['Doc_0/PublicRes.xml']);
      expect(report.integrity?.issues).toContainEqual(
        expect.objectContaining({ code: 'INTEGRITY_FILE_MISSING' }),
      );
    } finally {
      await container.close();
    }
  });

  it('OFDEntries.xml 被篡改（仍为合法 XML）→ eContent 摘要不符', async () => {
    const entries = openFixtureEntries('integrity.ofd');
    const xml = entries.get('OFDEntries.xml');
    if (!xml) throw new Error('缺少 OFDEntries.xml');
    const changed = new TextDecoder().decode(xml).replace('ofdrw-crypto', 'evil-crypto');
    expect(changed).not.toBe(new TextDecoder().decode(xml));
    entries.set('OFDEntries.xml', new TextEncoder().encode(changed));
    const container = memoryContainer(entries);
    try {
      const report = await verifyContainer(container);
      expect(report.overall).toBe('invalid');
      expect(report.integrity?.status).toBe('invalid');
      expect(report.integrity?.signature.status).toBe('invalid');
      expect(report.integrity?.issues).toContainEqual(
        expect.objectContaining({ code: 'INTEGRITY_DIGEST_MISMATCH' }),
      );
    } finally {
      await container.close();
    }
  });

  it('OFDEntries.xml 结构损坏 → INTEGRITY_ENTRIES_INVALID，与 Java 一致', async () => {
    const entries = openFixtureEntries('integrity.ofd');
    const xml = entries.get('OFDEntries.xml');
    if (!xml) throw new Error('缺少 OFDEntries.xml');
    const bad = new Uint8Array(xml);
    bad[bad.length - 1] = 0x3f; // '?'
    entries.set('OFDEntries.xml', bad);
    const container = memoryContainer(entries);
    try {
      const report = await verifyContainer(container);
      expect(javaIntegrity('security-tampered-entries.ofd').valid).toBe(false);
      expect(report.overall).toBe('invalid');
      expect(report.integrity?.status).toBe('invalid');
      expect(report.integrity?.issues).toContainEqual(
        expect.objectContaining({ code: 'INTEGRITY_ENTRIES_INVALID' }),
      );
    } finally {
      await container.close();
    }
  });

  it('signedvalue.dat 被篡改 → 完整性签名 invalid', async () => {
    const entries = openFixtureEntries('integrity.ofd');
    const signedValue = entries.get('signedvalue.dat');
    if (!signedValue) throw new Error('缺少 signedvalue.dat');
    const bad = new Uint8Array(signedValue);
    bad[bad.length - 1] ^= 0xff;
    entries.set('signedvalue.dat', bad);
    const container = memoryContainer(entries);
    try {
      const report = await verifyContainer(container);
      expect(report.overall).toBe('invalid');
      expect(report.integrity?.status).toBe('invalid');
      expect(report.integrity?.signature.status).toBe('invalid');
      expect(report.integrity?.issues.length).toBeGreaterThan(0);
    } finally {
      await container.close();
    }
  });

  it('签名仍 valid 但完整性 invalid → overall 聚合为 invalid', async () => {
    const entries = openFixtureEntries('combined-signed-integrity.ofd');
    entries.set('evil.txt', new TextEncoder().encode('unregistered'));
    const container = memoryContainer(entries);
    try {
      const report = await verifyContainer(container);
      expect(report.overall).toBe('invalid');
      expect(report.signatures[0]?.status).toBe('valid');
      expect(report.integrity?.status).toBe('invalid');
      expect(report.integrity?.extraFiles).toEqual(['evil.txt']);
    } finally {
      await container.close();
    }
  });

  it('错误根证书 → 完整性证书链 incomplete/invalid', async () => {
    const report = await verifyFixture('integrity.ofd', {
      roots: [{ pem: wrongRootPem }],
    });
    expect(report.overall).toBe('invalid');
    expect(report.integrity?.status).toBe('invalid');
    expect(report.integrity?.certificate.status).toBe('incomplete');
    expect(
      report.integrity?.certificate.issues.some((issue) => issue.code === 'CHAIN_INCOMPLETE'),
    ).toBe(true);
  });
});

describe('无完整性保护：冻结设计，不得伪造 valid', () => {
  it('只有签名没有 OFDEntries → integrity=null / integrityPresent=false', async () => {
    const report = await verifyFixture('signed-sesv4.ofd');
    expect(report.overall).toBe('valid');
    expect(report.integrity).toBeNull();
    expect(report.package.integrityPresent).toBe(false);
    expect(report.signatures[0]?.status).toBe('valid');
  });

  it('目录有 OFDEntries 但 signedvalue.dat 缺失 → 仍为 null/not-applicable', async () => {
    const entries = openFixtureEntries('integrity.ofd');
    entries.delete('signedvalue.dat');
    const container = memoryContainer(entries);
    try {
      const report = await verifyContainer(container);
      expect(report.overall).toBe('not-applicable');
      expect(report.integrity).toBeNull();
      expect(report.package.integrityPresent).toBe(false);
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain('"integrity":{"status":"valid"');
      expect(serialized).not.toContain('not-protected');
    } finally {
      await container.close();
    }
  });

  it('目录有 signedvalue.dat 但 OFDEntries.xml 缺失 → 仍为 null/not-applicable', async () => {
    const entries = openFixtureEntries('integrity.ofd');
    entries.delete('OFDEntries.xml');
    const container = memoryContainer(entries);
    try {
      const report = await verifyContainer(container);
      expect(report.overall).toBe('not-applicable');
      expect(report.integrity).toBeNull();
      expect(report.package.integrityPresent).toBe(false);
      expect(JSON.stringify(report)).not.toContain('not-protected');
    } finally {
      await container.close();
    }
  });

  it('明文无签名无完整性 → not-applicable，不能出现伪 valid', async () => {
    const report = await verifyFixture('plain.ofd');
    expect(report.overall).toBe('not-applicable');
    expect(report.integrity).toBeNull();
    expect(report.package.integrityPresent).toBe(false);
    expect(report.signatures).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('"integrity":{');
  });
});
