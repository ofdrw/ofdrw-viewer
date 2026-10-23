import { describe, expect, it } from 'vitest';
import {
  certificatesToDer,
  loadCertificates,
  parseCertificate,
  toBase64,
  toHex,
  utf8Encode,
  verifyOfd,
  type CertificateDer,
  type CryptoWarning,
} from '@ofdrw/ofdrw-viewer-crypto';
import { fixtureBytes, fixtureText } from '../core/fixtures';

const ROOT_DER = fixtureBytes('certs', 'root-ca.crt.der');
const ROOT_PEM = fixtureText('certs', 'root-ca.crt.pem');
const SIGNER_DER = fixtureBytes('certs', 'signer.crt.der');
const SIGNER_PEM = fixtureText('certs', 'signer.crt.pem');
const SIGNER_KEY_PEM = fixtureText('certs', 'signer.key.pem');

/** 断言同步抛出的 CryptoError 错误码。 */
function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? 'NO_CODE';
  }
  throw new Error('未按预期抛出错误');
}

/** 把 DER 数组解析为序列号数组。 */
async function serialsOf(certificates: readonly CertificateDer[]): Promise<string[]> {
  return (await loadCertificates(certificates)).map((item) => item.serialNumber);
}

describe('certificatesToDer 格式识别', () => {
  it('PEM 单证书与多证书', async () => {
    const single = certificatesToDer(ROOT_PEM);
    expect(single).toHaveLength(1);
    expect(toHex(single[0]!)).toBe(toHex(ROOT_DER));

    const multiple = certificatesToDer(`${ROOT_PEM}\n${SIGNER_PEM}`);
    expect(await serialsOf(multiple)).toEqual(['3e8', '3e9']);
  });

  it('PEM 兼容 CRLF、BOM、块外说明文字与 TRUSTED CERTIFICATE', async () => {
    const crlf = ROOT_PEM.replace(/\n/g, '\r\n');
    expect(toHex(certificatesToDer(crlf)[0]!)).toBe(toHex(ROOT_DER));

    const decorated = `\uFEFF证书说明\n${SIGNER_PEM}\n附注\n`;
    expect(toHex(certificatesToDer(decorated)[0]!)).toBe(toHex(SIGNER_DER));

    const bomBase64 = `\uFEFF${toBase64(SIGNER_DER)}`;
    expect(toHex(certificatesToDer(bomBase64)[0]!)).toBe(toHex(SIGNER_DER));

    const bomBytes = new Uint8Array([0xef, 0xbb, 0xbf, ...SIGNER_DER]);
    expect(toHex(certificatesToDer(bomBytes)[0]!)).toBe(toHex(SIGNER_DER));

    const trusted = SIGNER_PEM.replaceAll('CERTIFICATE', 'TRUSTED CERTIFICATE');
    expect(toHex(certificatesToDer(trusted)[0]!)).toBe(toHex(SIGNER_DER));
  });

  it('CER 与 DER 拼接', async () => {
    expect(toHex(certificatesToDer(ROOT_DER)[0]!)).toBe(toHex(ROOT_DER));

    const bundle = new Uint8Array(ROOT_DER.length + SIGNER_DER.length);
    bundle.set(ROOT_DER);
    bundle.set(SIGNER_DER, ROOT_DER.length);
    expect(await serialsOf(certificatesToDer(bundle))).toEqual(['3e8', '3e9']);
  });

  it('Base64 文本单行、折行与字节输入', async () => {
    const singleLine = toBase64(SIGNER_DER);
    expect(toHex(certificatesToDer(singleLine)[0]!)).toBe(toHex(SIGNER_DER));

    const folded = singleLine.replace(/(.{64})/g, '$1\r\n');
    expect(toHex(certificatesToDer(folded)[0]!)).toBe(toHex(SIGNER_DER));

    expect(toHex(certificatesToDer(utf8Encode(singleLine))[0]!)).toBe(toHex(SIGNER_DER));
  });

  it('输出顺序与输入一致且元素为独立副本', async () => {
    const bundle = certificatesToDer(`${ROOT_PEM}\n${SIGNER_PEM}`);
    expect(await serialsOf(bundle)).toEqual(['3e8', '3e9']);
    const first = bundle[0]!;
    const before = first[0]!;
    first[0] = 0xff;
    expect(bundle[1]![0]).not.toBe(0xff);
    expect(certificatesToDer(ROOT_PEM)[0]![0]).toBe(before);
  });
});

describe('certificatesToDer 错误与上限', () => {
  it('空输入与非法 PEM/Base64/DER', () => {
    for (const empty of ['', '   \n\t', new Uint8Array(0), new ArrayBuffer(0)]) {
      expect(codeOf(() => certificatesToDer(empty))).toBe('CRYPTO_CERTIFICATE_INVALID');
    }
    for (const invalid of [
      '-----BEGIN CERTIFICATE-----',
      '-----BEGIN CERTIFICATE-----\n****\n-----END CERTIFICATE-----',
      SIGNER_KEY_PEM,
      '!!!!',
      new Uint8Array([0x30, 0x82, 0xff, 0xff, 0x01]),
      new Uint8Array([0x31, 0x00]),
      SIGNER_DER.subarray(0, SIGNER_DER.length - 8),
      new Uint8Array([...SIGNER_DER, 0x00]),
    ]) {
      expect(codeOf(() => certificatesToDer(invalid))).toBe('CRYPTO_CERTIFICATE_INVALID');
    }
  });

  it('maxBytes/maxCertificates 超限与选项非法', () => {
    expect(codeOf(() => certificatesToDer(SIGNER_PEM, { maxBytes: 32 }))).toBe(
      'CRYPTO_LIMIT_EXCEEDED',
    );
    expect(codeOf(() => certificatesToDer(SIGNER_DER, { maxBytes: SIGNER_DER.length - 1 }))).toBe(
      'CRYPTO_LIMIT_EXCEEDED',
    );
    expect(
      codeOf(() =>
        certificatesToDer(`${ROOT_PEM}\n${SIGNER_PEM}`, { maxCertificates: 1 }),
      ),
    ).toBe('CRYPTO_LIMIT_EXCEEDED');
    expect(codeOf(() => certificatesToDer(SIGNER_PEM, { maxBytes: 0 }))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
    expect(codeOf(() => certificatesToDer(SIGNER_PEM, { maxCertificates: -1 }))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
    expect(codeOf(() => certificatesToDer(42 as never))).toBe('CRYPTO_INVALID_ARGUMENT');
  });
});

describe('核心证书接口只接收 DER', () => {
  it('类型层拒绝 PEM 字符串与三态对象', () => {
    const typeOnly = async (): Promise<void> => {
      // @ts-expect-error 核心只接收 CertificateDer
      await loadCertificates([SIGNER_PEM]);
      // @ts-expect-error 三态证书对象已删除
      await loadCertificates([{ der: SIGNER_DER }]);
    };
    expect(typeOnly).toBeTypeOf('function');
  });

  it('运行时拒绝 PEM 字节、字符串与 ArrayBuffer', async () => {
    await expect(loadCertificates([utf8Encode(SIGNER_PEM)])).rejects.toMatchObject({
      code: 'CRYPTO_CERTIFICATE_INVALID',
    });
    await expect(
      loadCertificates([SIGNER_PEM as unknown as CertificateDer]),
    ).rejects.toMatchObject({ code: 'CRYPTO_INVALID_ARGUMENT' });
    await expect(
      loadCertificates([SIGNER_DER.buffer as unknown as CertificateDer]),
    ).rejects.toMatchObject({ code: 'CRYPTO_INVALID_ARGUMENT' });
    expect(codeOf(() => parseCertificate(SIGNER_PEM as never))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
  });

  it('verifyOfd 的 roots 拒绝 PEM 字节（CRYPTO_TRUST_ROOT_INVALID）', async () => {
    await expect(
      verifyOfd({
        source: { kind: 'arraybuffer', data: fixtureBytes('plain.ofd') },
        roots: [utf8Encode(ROOT_PEM)],
      }),
    ).rejects.toMatchObject({ code: 'CRYPTO_TRUST_ROOT_INVALID' });
  });

  it('skipInvalid 跳过坏 DER 并保留后续证书', async () => {
    const warnings: CryptoWarning[] = [];
    const certificates = await loadCertificates(
      [new Uint8Array([0x30, 0x01]), SIGNER_DER],
      { skipInvalid: true, onWarning: (warning) => warnings.push(warning) },
    );
    expect(certificates.map((item) => item.serialNumber)).toEqual(['3e9']);
    expect(warnings.map((item) => item.code)).toContain('W_CRYPTO_CERT_SOURCE_UNSUPPORTED');
  });
});