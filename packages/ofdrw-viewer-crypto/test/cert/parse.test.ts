import { describe, expect, it } from 'vitest';
import { AsnParser } from '@peculiar/asn1-schema';
import { Certificate } from '@peculiar/asn1-x509';
import * as asn1js from 'asn1js';
import {
  checkCertificateValidity,
  derInteger,
  derSequence,
  parseCertificate,
  parseDer,
  parseCertificates,
  sm2Verify,
  toBase64,
  toCertificateSummary,
  toHex,
  utf8Encode,
} from '@ofdrw/ofdrw-viewer-crypto';
import { fixtureBytes, fixtureText } from '../core/fixtures';

const ROOT_PEM = fixtureText('certs', 'root-ca.crt.pem');
const SIGNER_PEM = fixtureText('certs', 'signer.crt.pem');
const SIGNER_DER = fixtureBytes('certs', 'signer.crt.der');
const ROOT_DER = fixtureBytes('certs', 'root-ca.crt.der');

describe('X.509 证书解析', () => {
  it('解析 PEM / DER 并读取关键字段', () => {
    const certificate = parseCertificate(SIGNER_PEM);
    expect(certificate.version).toBe(3);
    expect(certificate.serialNumber).toBe('3e9');
    expect(certificate.subject).toBe(
      'CN=OFDRW Viewer Crypto Fixtures Signer,O=ofdrw-viewer test,C=CN',
    );
    expect(certificate.issuer).toContain('OFDRW Viewer Crypto Fixtures Root CA');
    expect(certificate.notBeforeISO).toBe('2025-01-01T00:00:00.000Z');
    expect(certificate.notAfterISO).toBe('2040-01-01T00:00:00.000Z');
    expect(certificate.publicKeyAlgorithmName).toBe('SM2');
    expect(certificate.signatureAlgorithmName).toBe('SM3withSM2');
    expect(certificate.publicKey).toHaveLength(65);
    expect(certificate.publicKey[0]).toBe(0x04);
    expect(certificate.isCA).toBe(false);
    expect(certificate.keyUsage).toEqual(['digitalSignature', 'nonRepudiation']);
    expect(certificate.extendedKeyUsage).toEqual(['1.3.6.1.5.5.7.3.2']);
    expect(certificate.subjectKeyIdentifier).toBe(
      '422684536048725414b3f1844b970b98ec582bc9',
    );
    expect(certificate.authorityKeyIdentifier).toBe(
      '1d67a44a0b56987b6164cde9247632ca217fd4f9',
    );
    expect(certificate.fingerprintSha256).toBe(
      'e425cc9af0a50ef0fd24e02fa99eb0a30b4e36d0b7b7dba3b32dc6dcfd6c6fd3',
    );
    expect(toHex(certificate.der)).toBe(toHex(SIGNER_DER));
    expect(toHex(certificate.tbsDer)).toBe(toHex(parseDer(SIGNER_DER).children[0].raw));
  });

  it('识别 CA 与 pathLenConstraint', () => {
    const root = parseCertificate(ROOT_DER);
    expect(root.isCA).toBe(true);
    expect(root.keyUsage).toEqual(['digitalSignature', 'keyCertSign', 'cRLSign']);
    expect(root.pathLenConstraint).toBeUndefined();
    expect(root.fingerprintSha256).toBe(
      '31c0849fa9066e6c39b36828f069fb9e3035687061aece24d3baa8433e6b4112',
    );
    expect(root.subject).toBe(root.issuer);
  });

  it('支持多张 PEM、拼接 DER 与 Base64 文本', () => {
    const pemBoth = `${ROOT_PEM}\n${SIGNER_PEM}`;
    const fromPem = parseCertificates(pemBoth);
    expect(fromPem.map((certificate) => certificate.serialNumber)).toEqual(['3e8', '3e9']);

    const concatenated = new Uint8Array([...ROOT_DER, ...SIGNER_DER]);
    expect(parseCertificates(concatenated).map((item) => item.serialNumber)).toEqual([
      '3e8',
      '3e9',
    ]);

    expect(parseCertificates(toBase64(SIGNER_DER))[0].serialNumber).toBe('3e9');
    expect(parseCertificate(SIGNER_DER).serialNumber).toBe('3e9');
  });

  it('忽略 PEM 中的非证书块', () => {
    const pem = `${fixtureText('certs', 'signer.key.pem')}\n${SIGNER_PEM}`;
    expect(parseCertificates(pem).map((certificate) => certificate.serialNumber)).toEqual(['3e9']);
  });

  it('与 @peculiar/asn1-x509 字段一致', () => {
    const certificate = parseCertificate(SIGNER_DER);
    const asn = AsnParser.parse(SIGNER_DER, Certificate);
    expect(BigInt(`0x${Buffer.from(asn.tbsCertificate.serialNumber).toString('hex')}`).toString(16)).toBe(
      certificate.serialNumber,
    );
    expect(asn.tbsCertificate.validity.notBefore.getTime().getTime()).toBe(
      certificate.notBefore.getTime(),
    );
    expect(asn.tbsCertificate.validity.notAfter.getTime().getTime()).toBe(
      certificate.notAfter.getTime(),
    );
    expect(asn.tbsCertificate.subject[0][0].type).toBe('2.5.4.3');
    expect(asn.tbsCertificate.subject[0][0].value.toString()).toBe(
      'OFDRW Viewer Crypto Fixtures Signer',
    );
    expect(asn.tbsCertificate.subjectPublicKeyInfo.algorithm.algorithm).toBe(
      certificate.publicKeyAlgorithm,
    );
    expect(asn.signatureAlgorithm.algorithm).toBe(certificate.signatureAlgorithm);
    expect(certificate.signatureAlgorithm).toBe('1.2.156.10197.1.501');
  });

  it('与 asn1js 结构一致', () => {
    const parsed = asn1js.fromBER(
      SIGNER_DER.buffer.slice(
        SIGNER_DER.byteOffset,
        SIGNER_DER.byteOffset + SIGNER_DER.byteLength,
      ),
    );
    expect(parsed.offset).not.toBe(-1);
    const sequence = parsed.result as asn1js.Sequence;
    expect(sequence.valueBlock.value).toHaveLength(3);
  });

  it('证书签名可由 SM2 验签（根自签 + 叶证书链）', () => {
    const root = parseCertificate(ROOT_PEM);
    const signer = parseCertificate(SIGNER_PEM);
    expect(sm2Verify(root.tbsDer, root.signature, root.publicKey)).toBe(true);
    expect(sm2Verify(signer.tbsDer, signer.signature, root.publicKey)).toBe(true);
    const tampered = signer.tbsDer.slice();
    tampered[10] ^= 0x01;
    expect(sm2Verify(tampered, signer.signature, root.publicKey)).toBe(false);
  });

  it('有效期状态按包含端点判断', () => {
    const certificate = parseCertificate(SIGNER_PEM);
    expect(checkCertificateValidity(certificate, new Date('2024-12-31T23:59:59Z'))).toBe(
      'not-yet-valid',
    );
    expect(checkCertificateValidity(certificate, new Date('2025-01-01T00:00:00Z'))).toBe(
      'valid',
    );
    expect(checkCertificateValidity(certificate, new Date('2040-01-01T00:00:00Z'))).toBe(
      'valid',
    );
    expect(checkCertificateValidity(certificate, new Date('2040-01-01T00:00:01Z'))).toBe(
      'expired',
    );
    expect(() => checkCertificateValidity(certificate, new Date('invalid'))).toThrowError(
      /Date/,
    );
  });

  it('生成稳定摘要', () => {
    const summary = toCertificateSummary(parseCertificate(SIGNER_PEM));
    expect(summary).toEqual({
      subject: 'CN=OFDRW Viewer Crypto Fixtures Signer,O=ofdrw-viewer test,C=CN',
      issuer: 'CN=OFDRW Viewer Crypto Fixtures Root CA,O=ofdrw-viewer test,C=CN',
      serialNumber: '3e9',
      notBefore: '2025-01-01T00:00:00.000Z',
      notAfter: '2040-01-01T00:00:00.000Z',
      fingerprintSha256: 'e425cc9af0a50ef0fd24e02fa99eb0a30b4e36d0b7b7dba3b32dc6dcfd6c6fd3',
      publicKeyAlgorithm: 'SM2',
      signatureAlgorithm: 'SM3withSM2',
      keyUsage: ['digitalSignature', 'nonRepudiation'],
      isCA: false,
    });
    expect(Object.keys(summary)).not.toContain('publicKey');
  });
});

describe('证书解析错误', () => {
  it('拒绝空输入、乱码与错误 PEM', () => {
    expect(() => parseCertificate('')).toThrowError(/为空/);
    expect(() => parseCertificate('!!!!')).toThrowError(/PEM\/DER/);
    expect(() =>
      parseCertificate('-----BEGIN CERTIFICATE-----\n****\n-----END CERTIFICATE-----'),
    ).toThrowError(/证书/);
    expect(() => parseCertificate('-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----')).toThrowError(
      /CERTIFICATE/,
    );
  });

  it('拒绝截断 DER 与非证书 DER', () => {
    expect(() => parseCertificate(SIGNER_DER.subarray(0, SIGNER_DER.length - 8))).toThrowError(
      /证书/,
    );
    expect(() => parseCertificate(derSequence(derInteger(1n)))).toThrowError(/Certificate|证书/);
    expect(() => parseCertificates(new Uint8Array(0))).toThrowError(/为空/);
  });

  it('强制 maxBytes 与 maxCertificates', () => {
    expect(() => parseCertificates(SIGNER_DER, { maxBytes: 32 })).toThrowError(/超过上限/);
    expect(() => parseCertificates(`${ROOT_PEM}${SIGNER_PEM}`, { maxCertificates: 1 })).toThrowError(
      /超过上限/,
    );
    expect(() =>
      parseCertificates(new Uint8Array([...ROOT_DER, ...SIGNER_DER]), { maxCertificates: 1 }),
    ).toThrowError(/超过上限/);
  });
});

describe('证书解析输入兼容', () => {
  it('接受 Uint8Array 与 UTF-8 字符串', () => {
    expect(parseCertificate(utf8Encode(SIGNER_PEM)).serialNumber).toBe('3e9');
    expect(parseCertificate(SIGNER_DER).serialNumber).toBe('3e9');
  });
});