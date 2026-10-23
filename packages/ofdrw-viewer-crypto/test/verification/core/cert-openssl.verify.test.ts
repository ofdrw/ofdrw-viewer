/**
 * V-CORE 独立验证：X.509 证书解析、DER 加载器与入口转换工具。
 *
 * 字段期望值全部由 OpenSSL 3 `x509` 命令实时输出；加载器只接受 DER，
 * PEM/Base64/多证书由 `certificatesToDer` 在入口转换。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  certificatesToDer,
  checkCertificateValidity,
  loadCertificate,
  loadCertificates,
  parseCertificate,
  parseCertificates,
  sm2Verify,
  toBase64,
  toCertificateSummary,
  type CertificateDer,
  type CryptoWarning,
} from '@ofdrw/ofdrw-viewer-crypto';
import {
  FIXTURE_ROOT,
  OPENSSL_AVAILABLE,
  asyncErrorCode,
  fixtureBytes,
  fixtureText,
  makeTempDir,
  opensslVerifyCertificate,
  readOpenSslCertificate,
  removeTempDir,
  syncErrorCode,
  utf8,
} from './support';

/** 5 张测试证书（根、签名、印章、加密、时间戳）。 */
const CERT_NAMES = ['root-ca', 'signer', 'seal', 'encrypt', 'tsa'] as const;

/** 证书 fixture 访问器。 */
const CERT_FILES = CERT_NAMES.map((name) => ({
  name,
  der: fixtureBytes('certs', `${name}.crt.der`),
  pemPath: join(FIXTURE_ROOT, 'certs', `${name}.crt.pem`),
}));

/** 根证书 PEM。 */
const ROOT_PEM = fixtureText('certs', 'root-ca.crt.pem');
/** 签名证书 PEM。 */
const SIGNER_PEM = fixtureText('certs', 'signer.crt.pem');
/** 签名证书 DER。 */
const SIGNER_DER = fixtureBytes('certs', 'signer.crt.der');
/** 根证书 DER。 */
const ROOT_DER = fixtureBytes('certs', 'root-ca.crt.der');

/**
 * 把 Uint8Array 的精确区间转为 ArrayBuffer。
 *
 * @param bytes 字节。
 * @returns 独立 ArrayBuffer。
 */
function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('证书字段与 OpenSSL 输出对照', () => {
  it.skipIf(!OPENSSL_AVAILABLE)('5 张证书的主体/颁发者/序列号/有效期/指纹/扩展/公钥逐项一致', () => {
    for (const file of CERT_FILES) {
      const parsed = parseCertificate(file.der);
      const facts = readOpenSslCertificate(file.pemPath);

      expect(parsed.subject, file.name).toBe(facts.subject);
      expect(parsed.issuer, file.name).toBe(facts.issuer);
      expect(parsed.serialNumber, file.name).toBe(facts.serialNumber);
      expect(parsed.notBefore.getTime(), file.name).toBe(facts.notBefore.getTime());
      expect(parsed.notAfter.getTime(), file.name).toBe(facts.notAfter.getTime());
      expect(parsed.notBeforeISO, file.name).toBe(facts.notBefore.toISOString());
      expect(parsed.notAfterISO, file.name).toBe(facts.notAfter.toISOString());
      expect(parsed.fingerprintSha256, file.name).toBe(facts.fingerprintSha256);
      expect(parsed.isCA, file.name).toBe(facts.isCA);
      expect(parsed.keyUsage, file.name).toEqual(facts.keyUsage);
      expect(parsed.extendedKeyUsage ?? [], file.name).toEqual(facts.extendedKeyUsage);
      expect(parsed.subjectKeyIdentifier, file.name).toBe(facts.subjectKeyIdentifier);
      expect(parsed.authorityKeyIdentifier, file.name).toBe(facts.authorityKeyIdentifier);
      expect(Buffer.from(parsed.publicKey).toString('hex'), file.name).toBe(
        Buffer.from(facts.publicKey).toString('hex'),
      );
      expect(parsed.version, file.name).toBe(3);
      expect(parsed.publicKeyAlgorithm, file.name).toBe('1.2.840.10045.2.1');
      expect(parsed.publicKeyAlgorithmName, file.name).toBe('SM2');
      expect(parsed.signatureAlgorithm, file.name).toBe('1.2.156.10197.1.501');
      expect(parsed.signatureAlgorithmName, file.name).toBe('SM3withSM2');
      expect(parsed.curveOid, file.name).toBe('1.2.156.10197.1.301');
    }
  });

  it('证书摘要与解析结果一致且不含公钥/私钥等敏感字段', () => {
    const certificate = parseCertificate(SIGNER_DER);
    const summary = toCertificateSummary(certificate);
    expect(summary).toEqual({
      subject: certificate.subject,
      issuer: certificate.issuer,
      serialNumber: certificate.serialNumber,
      notBefore: certificate.notBeforeISO,
      notAfter: certificate.notAfterISO,
      fingerprintSha256: certificate.fingerprintSha256,
      publicKeyAlgorithm: certificate.publicKeyAlgorithmName,
      signatureAlgorithm: certificate.signatureAlgorithmName,
      keyUsage: certificate.keyUsage,
      isCA: certificate.isCA,
    });
    expect(Object.keys(summary).sort()).toEqual([
      'fingerprintSha256',
      'isCA',
      'issuer',
      'keyUsage',
      'notAfter',
      'notBefore',
      'publicKeyAlgorithm',
      'serialNumber',
      'signatureAlgorithm',
      'subject',
    ]);
    expect(JSON.stringify(summary)).not.toMatch(/BEGIN|PRIVATE|04[0-9a-f]{128}/i);
  });

  it.skipIf(!OPENSSL_AVAILABLE)('证书签名链可由 OpenSSL 与包内 SM2 验签共同验证', () => {
    const root = parseCertificate(ROOT_DER);
    expect(
      opensslVerifyCertificate(
        join(FIXTURE_ROOT, 'certs', 'root-ca.crt.pem'),
        join(FIXTURE_ROOT, 'certs', 'root-ca.crt.pem'),
      ),
    ).toBe(true);
    expect(sm2Verify(root.tbsDer, root.signature, root.publicKey)).toBe(true);

    for (const name of ['signer', 'seal', 'encrypt', 'tsa'] as const) {
      const leafPath = join(FIXTURE_ROOT, 'certs', `${name}.crt.pem`);
      expect(
        opensslVerifyCertificate(leafPath, join(FIXTURE_ROOT, 'certs', 'root-ca.crt.pem')),
        name,
      ).toBe(true);
      const leaf = parseCertificate(fixtureBytes('certs', `${name}.crt.der`));
      expect(sm2Verify(leaf.tbsDer, leaf.signature, root.publicKey), name).toBe(true);
    }

    const signer = parseCertificate(SIGNER_DER);
    const tampered = signer.tbsDer.slice();
    tampered[10] ^= 0x01;
    expect(sm2Verify(tampered, signer.signature, root.publicKey)).toBe(false);
  });

  it('有效期按包含端点判断，异常时间拒绝', () => {
    const certificate = parseCertificate(SIGNER_DER);
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
    expect(syncErrorCode(() => checkCertificateValidity(certificate, new Date('invalid')))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
  });
});

describe('PEM / DER / CER / Base64 入口转换', () => {
  it('同一证书的 PEM、DER、Base64 文本转换结果一致', () => {
    const fromPem = certificatesToDer(SIGNER_PEM);
    const fromDer = certificatesToDer(SIGNER_DER);
    const fromBase64 = certificatesToDer(toBase64(SIGNER_DER));
    for (const certificates of [fromPem, fromDer, fromBase64]) {
      expect(certificates).toHaveLength(1);
      expect(parseCertificate(certificates[0]!).serialNumber).toBe('3e9');
      expect(Buffer.from(certificates[0]!).toString('hex')).toBe(
        Buffer.from(SIGNER_DER).toString('hex'),
      );
    }
  });

  it('二进制 .cer（DER 内容）可按字节转换', () => {
    const dir = makeTempDir('ofdrw-crypto-cer-');
    try {
      const cer = join(dir, 'signer.cer');
      writeFileSync(cer, SIGNER_DER);
      const bytes = new Uint8Array(readFileSync(cer));
      const certificate = parseCertificate(certificatesToDer(bytes)[0]!);
      expect(certificate.serialNumber).toBe('3e9');
      expect(certificate.fingerprintSha256).toBe(
        parseCertificate(SIGNER_DER).fingerprintSha256,
      );
    } finally {
      removeTempDir(dir);
    }
  });

  it('支持多证书 PEM、拼接 DER 与混合顺序', () => {
    const pemBoth = `${ROOT_PEM}\n${SIGNER_PEM}`;
    expect(certificatesToDer(pemBoth)).toHaveLength(2);

    const concatenated = new Uint8Array(ROOT_DER.length + SIGNER_DER.length);
    concatenated.set(ROOT_DER);
    concatenated.set(SIGNER_DER, ROOT_DER.length);
    expect(parseCertificates(concatenated).map((item) => item.serialNumber)).toEqual([
      '3e8',
      '3e9',
    ]);

    const reverse = new Uint8Array(SIGNER_DER.length + ROOT_DER.length);
    reverse.set(SIGNER_DER);
    reverse.set(ROOT_DER, SIGNER_DER.length);
    expect(parseCertificates(reverse).map((item) => item.serialNumber)).toEqual(['3e9', '3e8']);
  });
});

describe('DER 证书加载器', () => {
  it('ArrayBuffer/Uint8Array 仅在转换后进入 crypto', async () => {
    const fromDer = await loadCertificates([SIGNER_DER]);
    const fromConvertedPem = await loadCertificates(certificatesToDer(SIGNER_PEM));
    const fromConvertedBuffer = await loadCertificates(
      certificatesToDer(exactArrayBuffer(SIGNER_DER)),
    );
    for (const certificates of [fromDer, fromConvertedPem, fromConvertedBuffer]) {
      expect(certificates).toHaveLength(1);
      expect(certificates[0].serialNumber).toBe('3e9');
    }
  });

  it('非 Uint8Array 与旧四态来源不被 crypto 接受', async () => {
    for (const legacy of [
      { url: 'https://example.invalid/root.cer' },
      { path: 'root.crt' },
      { filePath: 'root.crt' },
      exactArrayBuffer(SIGNER_DER),
    ]) {
      expect(
        await asyncErrorCode(loadCertificates([legacy as unknown as CertificateDer])),
      ).toBe('CRYPTO_INVALID_ARGUMENT');
    }
  });

  it('跨输入去重（按 SHA-256 指纹）且保持首次顺序', async () => {
    const certificates = await loadCertificates([ROOT_DER, ROOT_DER, SIGNER_DER, SIGNER_DER]);
    expect(certificates.map((item) => item.serialNumber)).toEqual(['3e8', '3e9']);
  });

  it('空输入返回空数组；loadCertificate 对空结果抛默认错误码', async () => {
    await expect(loadCertificates([])).resolves.toEqual([]);
    expect(
      await asyncErrorCode(loadCertificate(new Uint8Array(0), { skipInvalid: true })),
    ).toBe('CRYPTO_CERTIFICATE_INVALID');
  });
});

describe('输入失败、限制与畸形输入', () => {
  it('畸形 DER 被拒绝且不崩溃', () => {
    const malformed: Uint8Array[] = [
      new Uint8Array(0),
      new Uint8Array([0x30]),
      new Uint8Array([0x30, 0x82, 0xff, 0xff, 0x01]),
      new Uint8Array([0x31, 0x00]),
      utf8('not a certificate'),
      fixtureBytes('certs', 'signer.key.der'),
    ];
    for (const input of malformed) {
      expect(syncErrorCode(() => parseCertificate(input)), `bytes ${input.length}`).toBe(
        'CRYPTO_CERTIFICATE_INVALID',
      );
    }

    const texts = [
      '',
      '!!!!',
      '-----BEGIN CERTIFICATE-----\n****\n-----END CERTIFICATE-----',
      '-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----',
      toBase64(utf8('garbage')),
    ];
    for (const input of texts) {
      expect(syncErrorCode(() => certificatesToDer(input)), input.slice(0, 20)).toBe(
        'CRYPTO_CERTIFICATE_INVALID',
      );
    }
  });

  it('畸形/超限证书经 loader 默认抛错，skipInvalid 时 warning 并继续', async () => {
    const warnings: CryptoWarning[] = [];
    const certificates = await loadCertificates(
      [new Uint8Array([0x30, 0x01]), SIGNER_DER],
      { skipInvalid: true, onWarning: (warning) => warnings.push(warning) },
    );
    expect(certificates.map((item) => item.serialNumber)).toEqual(['3e9']);
    expect(warnings[0]?.code).toBe('W_CRYPTO_CERT_SOURCE_UNSUPPORTED');

    expect(await asyncErrorCode(loadCertificates([new Uint8Array(4)]))).toBe(
      'CRYPTO_CERTIFICATE_INVALID',
    );
    expect(
      await asyncErrorCode(
        loadCertificates([new Uint8Array(4)], { invalidCode: 'CRYPTO_TRUST_ROOT_INVALID' }),
      ),
    ).toBe('CRYPTO_TRUST_ROOT_INVALID');
    expect(
      await asyncErrorCode(
        loadCertificates([SIGNER_DER], { maxBytes: SIGNER_DER.length - 1 }),
      ),
    ).toBe('CRYPTO_LIMIT_EXCEEDED');
    expect(
      await asyncErrorCode(loadCertificates([ROOT_DER, SIGNER_DER], { maxCertificates: 1 })),
    ).toBe('CRYPTO_LIMIT_EXCEEDED');
  });

  it('取消与输入形状返回明确错误码', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await asyncErrorCode(loadCertificates([SIGNER_DER], { signal: controller.signal })),
    ).toBe('CRYPTO_ABORTED');

    expect(await asyncErrorCode(loadCertificates([utf8(SIGNER_PEM)]))).toBe(
      'CRYPTO_CERTIFICATE_INVALID',
    );
    expect(
      await asyncErrorCode(loadCertificate('root.crt' as unknown as CertificateDer)),
    ).toBe('CRYPTO_INVALID_ARGUMENT');
    expect(await asyncErrorCode(loadCertificate(null as unknown as CertificateDer))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
  });

  it('parseCertificates 直接限制：maxBytes/maxCertificates/空输入', () => {
    expect(syncErrorCode(() => parseCertificate(new Uint8Array(0)))).toBe(
      'CRYPTO_CERTIFICATE_INVALID',
    );
    expect(
      syncErrorCode(() => parseCertificate(SIGNER_DER, { maxBytes: SIGNER_DER.length - 1 })),
    ).toBe('CRYPTO_LIMIT_EXCEEDED');
    expect(
      syncErrorCode(() =>
        parseCertificates(new Uint8Array([...ROOT_DER, ...SIGNER_DER]), {
          maxCertificates: 1,
        }),
      ),
    ).toBe('CRYPTO_LIMIT_EXCEEDED');
    expect(syncErrorCode(() => parseCertificate(SIGNER_DER, { maxBytes: 0 }))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
    expect(syncErrorCode(() => parseCertificates(SIGNER_DER, { maxCertificates: 0 }))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
    expect(
      syncErrorCode(() => parseCertificate(new Uint8Array([...ROOT_DER, ...SIGNER_DER]))),
    ).toBe('CRYPTO_CERTIFICATE_INVALID');
  });
});