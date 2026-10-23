import { describe, expect, it } from 'vitest';
import {
  certificatesToDer,
  loadCertificate,
  loadCertificates,
  type CryptoWarning,
} from '@ofdrw/ofdrw-viewer-crypto';
import { fixtureBytes, fixtureText } from '../core/fixtures';

const ROOT_DER = fixtureBytes('certs', 'root-ca.crt.der');
const ROOT_PEM = fixtureText('certs', 'root-ca.crt.pem');
const SIGNER_DER = fixtureBytes('certs', 'signer.crt.der');
const SIGNER_PEM = fixtureText('certs', 'signer.crt.pem');

describe('DER 证书加载', () => {
  it('加载单张与多张 DER 并按指纹去重', async () => {
    const certificates = await loadCertificates([ROOT_DER, SIGNER_DER, SIGNER_DER]);
    expect(certificates.map((certificate) => certificate.serialNumber)).toEqual(['3e8', '3e9']);
  });

  it('loadCertificate 返回单张证书', async () => {
    expect((await loadCertificate(SIGNER_DER)).serialNumber).toBe('3e9');
    expect((await loadCertificate(ROOT_DER)).isCA).toBe(true);
  });

  it('接受 certificatesToDer 的输出', async () => {
    const certificates = await loadCertificates(
      certificatesToDer(`${ROOT_PEM}\n${SIGNER_PEM}`),
    );
    expect(certificates.map((certificate) => certificate.serialNumber)).toEqual(['3e8', '3e9']);
  });
});

describe('DER 加载失败处理', () => {
  it('默认抛 CRYPTO_CERTIFICATE_INVALID', async () => {
    await expect(loadCertificates([new Uint8Array([0x30, 0x01])])).rejects.toMatchObject({
      code: 'CRYPTO_CERTIFICATE_INVALID',
    });
  });

  it('skipInvalid 跳过坏输入并保留后续证书', async () => {
    const warnings: CryptoWarning[] = [];
    const certificates = await loadCertificates(
      [new Uint8Array([0x30, 0x01]), SIGNER_DER],
      { skipInvalid: true, onWarning: (warning) => warnings.push(warning) },
    );
    expect(certificates.map((certificate) => certificate.serialNumber)).toEqual(['3e9']);
    expect(warnings.map((warning) => warning.code)).toContain(
      'W_CRYPTO_CERT_SOURCE_UNSUPPORTED',
    );
  });

  it('支持把失败映射为 CRYPTO_TRUST_ROOT_INVALID', async () => {
    await expect(
      loadCertificates([new Uint8Array(4)], { invalidCode: 'CRYPTO_TRUST_ROOT_INVALID' }),
    ).rejects.toMatchObject({ code: 'CRYPTO_TRUST_ROOT_INVALID' });
  });

  it('强制上限、取消与输入形状校验', async () => {
    await expect(
      loadCertificates([ROOT_DER, SIGNER_DER], { maxCertificates: 1 }),
    ).rejects.toMatchObject({ code: 'CRYPTO_LIMIT_EXCEEDED' });
    await expect(
      loadCertificates([SIGNER_DER], { maxBytes: SIGNER_DER.length - 1 }),
    ).rejects.toMatchObject({ code: 'CRYPTO_LIMIT_EXCEEDED' });

    const controller = new AbortController();
    controller.abort();
    await expect(
      loadCertificates([SIGNER_DER], { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CRYPTO_ABORTED' });

    await expect(
      loadCertificates([null as unknown as Uint8Array]),
    ).rejects.toMatchObject({ code: 'CRYPTO_INVALID_ARGUMENT' });
    await expect(
      loadCertificates([new ArrayBuffer(0) as unknown as Uint8Array]),
    ).rejects.toMatchObject({ code: 'CRYPTO_INVALID_ARGUMENT' });
  });

  it('空输入数组返回空；loadCertificate 对空结果抛默认错误码', async () => {
    await expect(loadCertificates([])).resolves.toEqual([]);
    await expect(
      loadCertificate(new Uint8Array([0x30, 0x01]), { skipInvalid: true }),
    ).rejects.toMatchObject({ code: 'CRYPTO_CERTIFICATE_INVALID' });
  });
});