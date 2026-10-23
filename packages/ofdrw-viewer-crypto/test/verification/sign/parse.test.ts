/**
 * t13 独立验证：SES v1/v4/v5、Seal.esl、时间戳字段与 ofdrw Java 基线。
 *
 * 只使用公开 API 与 fixtures；不修改实现，也不依赖 t7 的测试构造器。
 */

import { describe, expect, it } from 'vitest';
import {
  parseSeal,
  parseSignedValue,
  parseTimestamp,
  sm3Hex,
  verifyOfd,
} from '@ofdrw/ofdrw-viewer-crypto';
import {
  buildTimestampWithNonce,
  buildV1Container,
  entryOf,
  fixtureText,
  javaExpected,
  javaIsoTime,
  parseFixtureSignature,
  verifyOptions,
} from './support';

describe('SES SignedValue / Seal 字段与 ofdrw 基线', () => {
  for (const version of ['v4', 'v5'] as const) {
    it(`SES ${version} 字段与 Java ofdrw 输出一致`, () => {
      const file = `signed-ses${version}.ofd`;
      const expected = javaExpected();
      const javaSeal = expected.seals[file]!;
      const javaSignedValue = expected.signedValues[file]!;
      const { signedValue, timestamp, sealBytes } = parseFixtureSignature(file);
      const seal = parseSeal(sealBytes);

      expect(signedValue.version).toBe(version);
      expect(signedValue.signatureAlgorithm).toBe('SM3withSM2');
      expect(signedValue.dataHash).toBe(javaSignedValue.dataHash);
      expect(javaIsoTime(signedValue.signedAt)).toBe(javaSignedValue.signedAt);
      expect(signedValue.certificate?.subject).toContain('Signer');
      expect(signedValue.certificate?.issuer).toContain('Root CA');
      expect(signedValue.seal?.version).toBe(version);
      expect(signedValue.seal?.esId).toBe(javaSeal.esId);
      expect(signedValue.seal?.name).toBe(javaSeal.name);
      expect(signedValue.byteLength).toBe(
        entryOf(file, 'Doc_0/Signs/Sign_0/SignedValue.dat').length,
      );

      expect(seal.version).toBe(javaSeal.version);
      expect(seal.esId).toBe(javaSeal.esId);
      expect(seal.name).toBe(javaSeal.name);
      expect(seal.typeCode).toBe(javaSeal.typeCode);
      expect(javaIsoTime(seal.createDate)).toBe(javaSeal.createDate);
      expect(javaIsoTime(seal.validStart)).toBe(javaSeal.validStart);
      expect(javaIsoTime(seal.validEnd)).toBe(javaSeal.validEnd);
      expect(seal.byteLength).toBe(sealBytes.length);
      expect(seal.hasSignature).toBe(true);
      expect(seal.makerCertificate?.subject).toContain('Seal Maker');
      expect(seal.certificates?.some((certificate) => certificate.subject.includes('Signer'))).toBe(
        true,
      );
      expect(seal.picture?.type).toBe(javaSeal.pictureType);
      expect(seal.picture?.widthMm).toBe(javaSeal.pictureWidthMm);
      expect(seal.picture?.heightMm).toBe(javaSeal.pictureHeightMm);
      expect(seal.picture?.dataLength).toBe(javaSeal.pictureLength);
      expect([...seal.picture!.data.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

      expect(timestamp.status).toBe('parsed-not-verified');
      expect(timestamp.tokenPresent).toBe(true);
      expect(timestamp.tokenLength).toBeGreaterThan(0);
      expect(timestamp.version).toBe(1);
      expect(timestamp.policy).toBe('1.2.156.10197.1.501.1');
      expect(timestamp.hashAlgorithm).toBe('SM3');
      expect(timestamp.genTime).toBe('2026-10-22T17:51:06.000Z');
      expect(timestamp.serialNumber).toMatch(/^[0-9a-f]+$/);
      expect(timestamp.messageImprint).toMatch(/^[0-9a-f]{64}$/);
      expect(timestamp.tsa?.subject).toContain('TSA');
      expect(timestamp.messageImprintMatchesSignature).toBe(true);
      expect(timestamp.note).toBe('已解析，未验证');
      expect(JSON.stringify(timestamp)).not.toMatch(/验证通过|时间戳有效/);
    });
  }

  it('SES v4/v5 的 Signature.xml dataHash 与 SignedValue 一致', () => {
    for (const version of ['v4', 'v5'] as const) {
      const file = `signed-ses${version}.ofd`;
      const signedValue = parseSignedValue(entryOf(file, 'Doc_0/Signs/Sign_0/SignedValue.dat'));
      const signatureXml = entryOf(file, 'Doc_0/Signs/Sign_0/Signature.xml');
      expect(signedValue.dataHash).toBe(sm3Hex(signatureXml));
    }
  });

  it('SES v1 解析字段并可由 verifyOfd 验证', async () => {
    const container = await buildV1Container();
    try {
      const signedValueBytes = await container.read('Doc_0/Signs/Sign_0/SignedValue.dat');
      const sealBytes = await container.read('Doc_0/Signs/Sign_0/Seal.esl');
      const signedValue = parseSignedValue(signedValueBytes);
      const seal = parseSeal(sealBytes);

      expect(signedValue.version).toBe('v1');
      expect(signedValue.signatureAlgorithm).toBe('SM3withSM2');
      expect(signedValue.signedAt).toBe('2026-10-23 10:00:00');
      expect(signedValue.dataHash).toMatch(/^[0-9a-f]{64}$/);
      expect(signedValue.certificate?.subject).toContain('Signer');
      expect(signedValue.seal?.version).toBe('v1');
      expect(signedValue.seal?.esId).toBe('t13-v1-es');
      expect(signedValue.seal?.name).toBe('t13 合成 v1 印章');
      expect(signedValue.seal?.picture).toMatchObject({
        type: 'PNG',
        widthMm: 40,
        heightMm: 40,
        dataLength: 8,
      });
      expect(signedValue.timestamp.status).toBe('not-present');

      expect(seal.version).toBe('v1');
      expect(seal.esId).toBe('t13-v1-es');
      expect(seal.name).toBe('t13 合成 v1 印章');
      expect(seal.typeCode).toBe(1);
      expect(seal.picture?.dataLength).toBe(8);
      expect(seal.makerCertificate?.subject).toContain('Seal Maker');

      const report = await verifyOfd({ container, ...verifyOptions() });
      expect(report.overall).toBe('valid');
      expect(report.signatures[0]?.status).toBe('valid');
      expect(report.signatures[0]?.version).toBe('v1');
      expect(report.signatures[0]?.signature.status).toBe('valid');
      expect(report.signatures[0]?.seal?.status).toBe('valid');
    } finally {
      await container.close();
    }
  });

  it('Seal.esl 证书字段与图片元信息完整', () => {
    const seal = parseSeal(entryOf('signed-sesv4.ofd', 'Doc_0/Signs/Sign_0/Seal.esl'));
    expect(seal.makerCertificate?.serialNumber).toMatch(/^[0-9a-f]+$/);
    expect(seal.makerCertificate?.notBefore).toBe('2025-01-01T00:00:00.000Z');
    expect(seal.makerCertificate?.notAfter).toBe('2040-01-01T00:00:00.000Z');
    expect(seal.makerCertificate?.keyUsage).toContain('digitalSignature');
  });

  it('时间戳 nonce 可解析且仍固定为 parsed-not-verified', () => {
    const parsed = parseTimestamp(buildTimestampWithNonce());
    expect(parsed.status).toBe('parsed-not-verified');
    expect(parsed.serialNumber).toBe('0102030405');
    expect(parsed.nonce).toBe('abcdef');
    expect(parsed.genTime).toBe('2026-10-23T03:00:00.000Z');
    expect(parsed.tsa).toBeUndefined();
    expect(parsed.note).toBe('已解析，未验证');
    expect(JSON.stringify(parsed)).not.toMatch(/验证通过|时间戳有效/);
  });

  it('非法/空时间戳不抛错，返回显式状态', () => {
    expect(parseTimestamp(new Uint8Array())).toMatchObject({
      status: 'not-present',
      tokenPresent: false,
      tokenLength: 0,
      note: '已解析，未验证',
    });
    const bad = parseTimestamp(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01]));
    expect(bad.status).toBe('parse-error');
    expect(bad.tokenPresent).toBe(true);
    expect(bad.parseError?.severity).toBe('warning');
    expect(bad.note).toBe('已解析，未验证');
  });

  it('固定文案不包含任何“验证通过”表述', () => {
    const text = fixtureText('README.md');
    expect(text).toContain('只解析、不验证');
    expect(text).not.toContain('时间戳验证通过');
  });
});
