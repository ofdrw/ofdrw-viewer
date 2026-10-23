import { describe, expect, it } from 'vitest';
import {
  loadCertificate,
  loadCertificates,
  type CertificateInput,
  type CryptoWarning,
} from '@ofdrw/ofdrw-viewer-crypto';
import { fixtureBytes, fixtureText } from '../core/fixtures';

const ROOT_DER = fixtureBytes('certs', 'root-ca.crt.der');
const ROOT_PEM = fixtureText('certs', 'root-ca.crt.pem');
const SIGNER_DER = fixtureBytes('certs', 'signer.crt.der');
const SIGNER_PEM = fixtureText('certs', 'signer.crt.pem');

describe('CertificateInput 三态加载', () => {
  it('加载 data/pem/der 并去重', async () => {
    const certificates = await loadCertificates([
      { data: ROOT_DER },
      { pem: SIGNER_PEM },
      { der: SIGNER_DER },
    ]);
    expect(certificates.map((certificate) => certificate.serialNumber)).toEqual(['3e8', '3e9']);
  });

  it('loadCertificate 返回单张证书', async () => {
    expect((await loadCertificate({ pem: SIGNER_PEM })).serialNumber).toBe('3e9');
    expect((await loadCertificate({ data: ROOT_DER })).isCA).toBe(true);
  });

  it('三态之外的 URL/path/filePath 不在 crypto 接受范围内', async () => {
    for (const legacy of [
      { url: 'https://example.test/root.cer' },
      { path: 'root.crt' },
      { filePath: 'root.crt' },
    ]) {
      await expect(
        loadCertificates([legacy as unknown as CertificateInput]),
      ).rejects.toMatchObject({ code: 'CRYPTO_INVALID_ARGUMENT' });
    }
  });
});

describe('CertificateInput 失败处理', () => {
  it('默认抛 CRYPTO_CERTIFICATE_INVALID', async () => {
    await expect(loadCertificates([{ pem: 'not a certificate' }])).rejects.toMatchObject({
      code: 'CRYPTO_CERTIFICATE_INVALID',
    });
  });

  it('skipInvalid 跳过坏输入并保留后续证书', async () => {
    const warnings: CryptoWarning[] = [];
    const certificates = await loadCertificates(
      [{ pem: 'broken' }, { pem: SIGNER_PEM }],
      { skipInvalid: true, onWarning: (warning) => warnings.push(warning) },
    );
    expect(certificates.map((certificate) => certificate.serialNumber)).toEqual(['3e9']);
    expect(warnings.map((warning) => warning.code)).toContain(
      'W_CRYPTO_CERT_SOURCE_UNSUPPORTED',
    );
  });

  it('支持把失败映射为 CRYPTO_TRUST_ROOT_INVALID', async () => {
    await expect(
      loadCertificates([{ data: new Uint8Array(4) }], { invalidCode: 'CRYPTO_TRUST_ROOT_INVALID' }),
    ).rejects.toMatchObject({ code: 'CRYPTO_TRUST_ROOT_INVALID' });
  });

  it('强制上限、取消与输入形状校验', async () => {
    await expect(
      loadCertificates([{ pem: `${ROOT_PEM}${SIGNER_PEM}` }], { maxCertificates: 1 }),
    ).rejects.toMatchObject({ code: 'CRYPTO_LIMIT_EXCEEDED' });

    const controller = new AbortController();
    controller.abort();
    await expect(
      loadCertificates([{ pem: SIGNER_PEM }], { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CRYPTO_ABORTED' });

    await expect(
      loadCertificates([{ pem: SIGNER_PEM, der: SIGNER_DER } as CertificateInput]),
    ).rejects.toMatchObject({ code: 'CRYPTO_INVALID_ARGUMENT' });

    await expect(
      loadCertificates([{} as CertificateInput]),
    ).rejects.toMatchObject({ code: 'CRYPTO_INVALID_ARGUMENT' });
  });
});
