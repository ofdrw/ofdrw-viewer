/**
 * V-CERT 独立验证（一）：证书 DER 输入边界与 `certificatesToDer` 转换工具。
 *
 * 验证目标：
 * 1. crypto 公共证书接口只接收 `Uint8Array` DER；旧 `CertificateInput` 三态/PEM
 *    文本不能进入核心，类型层也不存在该三态；
 * 2. `certificatesToDer` 覆盖 PEM 单/多证书、CRLF/BOM、X509/TRUSTED CERTIFICATE、
 *    CER/DER 拼接、Base64、空输入、非法 PEM、非证书块、大小与数量上限，
 *    并为每张证书返回独立 DER 副本。
 *
 * 只使用公开 barrel 与已提交夹具；不引用 crypto 内部模块，不修改实现。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  certificatesToDer,
  loadCertificates,
  parseCertificate,
  parseCertificates,
  toBase64,
  toHex,
  verifyOfd,
  type CertificateDer,
} from '@ofdrw/ofdrw-viewer-crypto';
import {
  fixtureBytes,
  fixtureText,
  makeTempDir,
  removeTempDir,
  syncErrorCode,
  utf8,
} from '../core/support';

/** crypto 包根目录。 */
const PKG_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** 根证书 DER。 */
const ROOT_DER = fixtureBytes('certs', 'root-ca.crt.der');
/** 根证书 PEM。 */
const ROOT_PEM = fixtureText('certs', 'root-ca.crt.pem');
/** 签名证书 DER。 */
const SIGNER_DER = fixtureBytes('certs', 'signer.crt.der');
/** 签名证书 PEM。 */
const SIGNER_PEM = fixtureText('certs', 'signer.crt.pem');
/** 签名私钥 PEM（非证书块）。 */
const SIGNER_KEY_PEM = fixtureText('certs', 'signer.key.pem');
/** 明文夹具（用于验证入口边界）。 */
const PLAIN_OFD = fixtureBytes('plain.ofd');

/** 逻辑根、签名证书序列号（夹具契约）。 */
const EXPECTED_SERIALS = ['3e8', '3e9'] as const;

/**
 * 同步捕获错误码。
 *
 * @param run 被测调用。
 * @returns 错误码；未抛错返回 undefined。
 */
function codeOf(run: () => unknown): string | undefined {
  return syncErrorCode(run);
}

/**
 * 异步捕获错误码。
 *
 * @param promise 被测 Promise。
 * @returns 错误码；未拒绝返回 undefined。
 */
async function asyncCodeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { readonly code?: string }).code;
  }
}

/**
 * 断言输出 DER 与源 DER 逐字节一致。
 *
 * @param actual 转换结果。
 * @param expected 源 DER。
 */
function expectDer(actual: CertificateDer | undefined, expected: Uint8Array): void {
  expect(actual).toBeInstanceOf(Uint8Array);
  expect(toHex(actual!)).toBe(toHex(expected));
}

describe('接口边界：crypto 证书接口只接收 DER', () => {
  it('类型层拒绝 PEM 字符串、ArrayBuffer 与旧三态对象', () => {
    const typeOnly = async (): Promise<void> => {
      // @ts-expect-error 核心证书接口只接收 CertificateDer（Uint8Array）
      parseCertificate(SIGNER_PEM);
      // @ts-expect-error parseCertificates 同样只接收 DER 字节
      parseCertificates(SIGNER_PEM);
      // @ts-expect-error 加载器每项必须是一张证书 DER
      await loadCertificates([SIGNER_PEM]);
      // @ts-expect-error 旧 CertificateInput 三态对象已删除
      await loadCertificates([{ pem: SIGNER_PEM }]);
      // @ts-expect-error roots 只接收逐张证书 DER
      await verifyOfd({ source: { kind: 'arraybuffer', data: PLAIN_OFD }, roots: [ROOT_PEM] });
    };
    expect(typeOnly).toBeTypeOf('function');
  });

  it('运行时拒绝 PEM 文本/字节、ArrayBuffer 与三态对象', async () => {
    expect(codeOf(() => parseCertificate(SIGNER_PEM as never))).toBe('CRYPTO_INVALID_ARGUMENT');
    expect(codeOf(() => parseCertificates(SIGNER_PEM as never))).toBe('CRYPTO_INVALID_ARGUMENT');
    expect(codeOf(() => parseCertificate(utf8(SIGNER_PEM)))).toBe('CRYPTO_CERTIFICATE_INVALID');
    expect(codeOf(() => parseCertificates(utf8(SIGNER_PEM)))).toBe('CRYPTO_CERTIFICATE_INVALID');
    expect(
      codeOf(() => parseCertificate(SIGNER_DER.buffer as unknown as CertificateDer)),
    ).toBe('CRYPTO_INVALID_ARGUMENT');

    expect(await asyncCodeOf(loadCertificates([SIGNER_PEM as never]))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
    expect(await asyncCodeOf(loadCertificates([{ der: SIGNER_DER } as never]))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
    expect(
      await asyncCodeOf(loadCertificates([SIGNER_DER.buffer as unknown as CertificateDer])),
    ).toBe('CRYPTO_INVALID_ARGUMENT');
    expect(await asyncCodeOf(loadCertificates([utf8(SIGNER_PEM)]))).toBe(
      'CRYPTO_CERTIFICATE_INVALID',
    );
  });

  it('verifyOfd 的 roots 只接收 DER：PEM 字节 → CRYPTO_TRUST_ROOT_INVALID，文本 → 参数错误', async () => {
    const base = { source: { kind: 'arraybuffer' as const, data: PLAIN_OFD } };
    expect(await asyncCodeOf(verifyOfd({ ...base, roots: [utf8(ROOT_PEM)] }))).toBe(
      'CRYPTO_TRUST_ROOT_INVALID',
    );
    expect(await asyncCodeOf(verifyOfd({ ...base, roots: [ROOT_PEM as never] }))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
    // 转换后的 DER 被接受（明文包无签名，验证状态与根配置无关）。
    const report = await verifyOfd({ ...base, roots: certificatesToDer(ROOT_PEM) });
    expect(report.rootsConfigured).toBe(true);
  });

  it('源码与构建类型声明中不存在 CertificateInput 三态', () => {
    const sources = readdirSync(join(PKG_ROOT, 'src'), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => join(entry.parentPath, entry.name));
    expect(sources.length).toBeGreaterThan(30);
    for (const file of sources) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('CertificateInput');
    }
    const declarations = readFileSync(join(PKG_ROOT, 'dist/index.d.ts'), 'utf8');
    expect(declarations).not.toContain('CertificateInput');
    expect(declarations).toContain('type CertificateDer = Uint8Array');
  });

  it('证书 DER 类型别名在运行时就是 Uint8Array，核心返回解析结构', () => {
    const certificate = parseCertificate(SIGNER_DER);
    const summary = certificate.serialNumber;
    expect(summary).toBe('3e9');
    expect(parseCertificates(SIGNER_DER)).toHaveLength(1);
    expect(parseCertificate(certificatesToDer(ROOT_PEM)[0]!).serialNumber).toBe('3e8');
  });
});

describe('certificatesToDer：格式识别', () => {
  it('PEM 单证书、多证书保持输入顺序并逐张返回 DER', async () => {
    const single = certificatesToDer(ROOT_PEM);
    expect(single).toHaveLength(1);
    expectDer(single[0], ROOT_DER);

    const multiple = certificatesToDer(`${ROOT_PEM}\n${SIGNER_PEM}`);
    expect(multiple).toHaveLength(2);
    expectDer(multiple[0], ROOT_DER);
    expectDer(multiple[1], SIGNER_DER);
    const serials = (await loadCertificates(multiple)).map((item) => item.serialNumber);
    expect(serials).toEqual([...EXPECTED_SERIALS]);
  });

  it('CRLF、UTF-8 BOM、块外说明文字与 X509 CERTIFICATE 均可识别', () => {
    expectDer(certificatesToDer(ROOT_PEM.replaceAll('\n', '\r\n'))[0], ROOT_DER);
    expectDer(certificatesToDer(`\uFEFF${SIGNER_PEM}`)[0], SIGNER_DER);
    expectDer(certificatesToDer(`说明文字\n${SIGNER_PEM}\n附注`)[0], SIGNER_DER);
    expectDer(
      certificatesToDer(SIGNER_PEM.replaceAll('CERTIFICATE', 'X509 CERTIFICATE'))[0],
      SIGNER_DER,
    );
    expectDer(
      certificatesToDer(SIGNER_PEM.replaceAll('CERTIFICATE', 'TRUSTED CERTIFICATE'))[0],
      SIGNER_DER,
    );
  });

  it('CER 文件（DER 内容）、DER 单证书与 DER 拼接均按字节识别', async () => {
    const dir = makeTempDir('ofdrw-cert-boundary-');
    try {
      const cerPath = join(dir, 'signer.cer');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(cerPath, SIGNER_DER);
      const cer = new Uint8Array(readFileSync(cerPath));
      expectDer(certificatesToDer(cer)[0], SIGNER_DER);

      expectDer(certificatesToDer(SIGNER_DER)[0], SIGNER_DER);
      const bundle = new Uint8Array(ROOT_DER.length + SIGNER_DER.length);
      bundle.set(ROOT_DER);
      bundle.set(SIGNER_DER, ROOT_DER.length);
      const parsed = certificatesToDer(bundle);
      expect(parsed).toHaveLength(2);
      expectDer(parsed[0], ROOT_DER);
      expectDer(parsed[1], SIGNER_DER);
      expect((await loadCertificates(parsed)).map((item) => item.serialNumber)).toEqual([
        ...EXPECTED_SERIALS,
      ]);
    } finally {
      removeTempDir(dir);
    }
  });

  it('Base64 文本：单行、折行、BOM 与 UTF-8 字节输入', () => {
    const base64 = toBase64(SIGNER_DER);
    expectDer(certificatesToDer(base64)[0], SIGNER_DER);
    expectDer(certificatesToDer(base64.replace(/(.{64})/g, '$1\r\n'))[0], SIGNER_DER);
    expectDer(certificatesToDer(`\uFEFF${base64}`)[0], SIGNER_DER);
    expectDer(certificatesToDer(utf8(base64))[0], SIGNER_DER);
  });

  it('每项是独立副本，修改一项不影响其他项或再次调用', () => {
    const first = certificatesToDer(`${ROOT_PEM}\n${SIGNER_PEM}`);
    expect(first[0]).not.toBe(first[1]);
    const originalRootFirstByte = first[0]![0];
    first[0]![0] = 0xff;
    expect(first[1]![0]).not.toBe(0xff);
    expect(certificatesToDer(ROOT_PEM)[0]![0]).toBe(originalRootFirstByte);
  });
});

describe('certificatesToDer：空、非法、非证书块与上限', () => {
  it.each([
    ['空字符串', ''],
    ['纯空白', '  \r\n\t '],
    ['空字节', new Uint8Array(0)],
    ['空 ArrayBuffer', new ArrayBuffer(0)],
  ])('%s → CRYPTO_CERTIFICATE_INVALID', (_label, input) => {
    expect(codeOf(() => certificatesToDer(input as never))).toBe('CRYPTO_CERTIFICATE_INVALID');
  });

  it('非法 PEM/Base64/DER 均拒绝且不崩溃', () => {
    const invalid: unknown[] = [
      '-----BEGIN CERTIFICATE-----',
      '-----BEGIN CERTIFICATE-----\n****\n-----END CERTIFICATE-----',
      '-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----',
      '!!!!',
      new Uint8Array([0x30, 0x82, 0xff, 0xff, 0x01]),
      new Uint8Array([0x31, 0x00]),
      new Uint8Array([0x30]),
      SIGNER_DER.subarray(0, SIGNER_DER.length - 8),
      new Uint8Array([...SIGNER_DER, 0x00]),
      toBase64(utf8('not a certificate')),
    ];
    for (const input of invalid) {
      expect(codeOf(() => certificatesToDer(input as never)), String(input).slice(0, 24)).toBe(
        'CRYPTO_CERTIFICATE_INVALID',
      );
    }
  });

  it('非证书块：只含私钥 PEM 拒绝；私钥+证书混排忽略非证书块', () => {
    expect(codeOf(() => certificatesToDer(SIGNER_KEY_PEM))).toBe('CRYPTO_CERTIFICATE_INVALID');
    const mixed = `${SIGNER_KEY_PEM}\n${SIGNER_PEM}`;
    const converted = certificatesToDer(mixed);
    expect(converted).toHaveLength(1);
    expectDer(converted[0], SIGNER_DER);
  });

  it('maxBytes 同时约束输入与单张证书 DER', () => {
    expect(codeOf(() => certificatesToDer(SIGNER_PEM, { maxBytes: 64 }))).toBe(
      'CRYPTO_LIMIT_EXCEEDED',
    );
    expect(codeOf(() => certificatesToDer(SIGNER_DER, { maxBytes: SIGNER_DER.length - 1 }))).toBe(
      'CRYPTO_LIMIT_EXCEEDED',
    );
    expect(
      codeOf(() => certificatesToDer(new Uint8Array(SIGNER_DER.length + 1024), { maxBytes: 256 })),
    ).toBe('CRYPTO_LIMIT_EXCEEDED');
    // 上限恰好等于单张 DER 时允许。
    expect(certificatesToDer(SIGNER_DER, { maxBytes: SIGNER_DER.length })).toHaveLength(1);
  });

  it('maxCertificates 约束多证书数量', () => {
    expect(
      codeOf(() => certificatesToDer(`${ROOT_PEM}\n${SIGNER_PEM}`, { maxCertificates: 1 })),
    ).toBe('CRYPTO_LIMIT_EXCEEDED');
    expect(
      codeOf(() => certificatesToDer(`${ROOT_PEM}\n${SIGNER_PEM}`, { maxCertificates: 2 })),
    ).toBeUndefined();
  });

  it('非法选项与不支持的输入类型返回 CRYPTO_INVALID_ARGUMENT', () => {
    for (const options of [
      { maxBytes: 0 },
      { maxBytes: -1 },
      { maxBytes: 1.5 },
      { maxBytes: Number.NaN },
      { maxCertificates: 0 },
      { maxCertificates: -2 },
      { maxCertificates: 1.5 },
    ]) {
      expect(codeOf(() => certificatesToDer(SIGNER_PEM, options))).toBe('CRYPTO_INVALID_ARGUMENT');
    }
    for (const input of [42, null, undefined, {}, []]) {
      expect(codeOf(() => certificatesToDer(input as never))).toBe('CRYPTO_INVALID_ARGUMENT');
    }
  });
});