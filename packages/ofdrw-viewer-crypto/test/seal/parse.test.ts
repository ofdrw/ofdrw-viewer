/**
 * 电子印章解析：v4/v5 结构与字段、证书列表、图片、错误输入。
 */

import { describe, expect, it } from 'vitest';
import { openZipVirtualContainer } from '@ofdrw/ofdrw-viewer-engine';
import { CryptoError, parseSeal } from '@ofdrw/ofdrw-viewer-crypto';
import { fixtureBytes } from '../core/fixtures';
import {
  buildV1Seal,
  buildV1SignedContainer,
  buildV5SealWithTimestamp,
  readEntriesOf,
  readV4TimestampToken,
} from '../verify/builders';

/**
 * 读取 Seal.esl。
 *
 * @param file fixture 文件名。
 * @returns Seal.esl 字节。
 */
async function readSeal(file: string): Promise<Uint8Array> {
  const container = await openZipVirtualContainer({
    kind: 'arraybuffer',
    data: fixtureBytes(file),
  });
  try {
    return await container.read('Doc_0/Signs/Sign_0/Seal.esl');
  } finally {
    await container.close();
  }
}

/**
 * 断言解析抛出指定错误码。
 *
 * @param action 解析动作。
 * @param code 期望错误码。
 */
function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error('未抛错');
  } catch (error) {
    expect(error).toBeInstanceOf(CryptoError);
    expect((error as CryptoError).code).toBe(code);
  }
}

describe('parseSeal', () => {
  for (const [file, version] of [
    ['signed-sesv4.ofd', 'v4'],
    ['signed-sesv5.ofd', 'v5'],
  ] as const) {
    it(`解析 SES ${version} 印章`, async () => {
      const bytes = await readSeal(file);
      const seal = parseSeal(bytes);
      expect(seal).toMatchObject({
        version,
        esId: version === 'v4' ? 'OFDRWFIXTURESEALV4' : 'OFDRWFIXTURESEALV5',
        name: `OFDRW Viewer 测试印章 ${version}`,
        typeCode: 2,
        createDate: '2025-01-01T00:00:00.000Z',
        validStart: '2025-01-01T00:00:00.000Z',
        validEnd: '2040-01-01T00:00:00.000Z',
        hasSignature: true,
        byteLength: bytes.length,
      });
      expect(seal.makerCertificate?.subject).toContain('Seal Maker');
      expect(seal.certificates?.some((cert) => cert.subject.includes('Signer'))).toBe(true);
      expect(seal.picture).toMatchObject({ type: 'PNG', widthMm: 40, heightMm: 40 });
      expect(seal.picture?.dataLength).toBe(seal.picture?.data.length);
      // PNG 文件头，确认图片数据按原始字节透出。
      expect([...seal.picture!.data.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(seal.timestamp.status).toBe('not-present');
      expect(seal.warnings).toEqual([]);
    });
  }

  it('v5 印章时间戳只解析不验证', async () => {
    const token = await readV4TimestampToken();
    const seal = parseSeal(buildV5SealWithTimestamp(token));
    expect(seal.version).toBe('v5');
    expect(seal.timestamp.status).toBe('parsed-not-verified');
    expect(seal.timestamp.tokenPresent).toBe(true);
    expect(seal.timestamp.note).toBe('已解析，未验证');
    expect(JSON.stringify(seal.timestamp)).not.toContain('验证通过');
  });

  it('图片缺失/损坏时省略 picture 并记录 warning', async () => {
    for (const picture of ['missing', 'corrupt'] as const) {
      const container = await buildV1SignedContainer({ picture });
      try {
        const entries = await readEntriesOf(container);
        const seal = parseSeal(entries.get('Doc_0/Signs/Sign_0/Seal.esl')!.bytes);
        expect(seal.picture).toBeUndefined();
        expect(seal.warnings).toHaveLength(1);
        expect(seal.warnings[0]).toMatchObject({
          code: picture === 'missing' ? 'SEAL_PICTURE_MISSING' : 'SEAL_PICTURE_INVALID',
          severity: 'warning',
        });
        expect(seal.hasSignature).toBe(true);
      } finally {
        await container.close();
      }
    }
  });

  it('SES_Header.version 9/6 统一抛 CRYPTO_UNSUPPORTED_SES_VERSION', () => {
    for (const headerVersion of [9, 6]) {
      expectCode(
        () => parseSeal(buildV5SealWithTimestamp(new Uint8Array(), headerVersion)),
        'CRYPTO_UNSUPPORTED_SES_VERSION',
      );
      expectCode(() => parseSeal(buildV1Seal(headerVersion)), 'CRYPTO_UNSUPPORTED_SES_VERSION');
    }
  });

  it('v1 布局的 header version 非 1 抛 CRYPTO_UNSUPPORTED_SES_VERSION', () => {
    for (const headerVersion of [2, 4, 5]) {
      expectCode(() => parseSeal(buildV1Seal(headerVersion)), 'CRYPTO_UNSUPPORTED_SES_VERSION');
    }
    // v4/v5 布局也不能用 v1 的 header version。
    expectCode(
      () => parseSeal(buildV5SealWithTimestamp(new Uint8Array(), 1)),
      'CRYPTO_UNSUPPORTED_SES_VERSION',
    );
  });

  it('maxCertificates 低于 certList 数量抛 CRYPTO_LIMIT_EXCEEDED', () => {
    expectCode(
      () => parseSeal(buildV1Seal(1, 2), { maxCertificates: 1 }),
      'CRYPTO_LIMIT_EXCEEDED',
    );
  });

  it('ASN.1 解析超限抛 CRYPTO_LIMIT_EXCEEDED', async () => {
    const bytes = await readSeal('signed-sesv4.ofd');
    expectCode(() => parseSeal(bytes, { maxBytes: 8 }), 'CRYPTO_LIMIT_EXCEEDED');
  });

  it('非法结构抛 typed error', () => {
    try {
      parseSeal(new Uint8Array([0x30, 0x02, 0x01]));
      throw new Error('未抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(CryptoError);
      expect((error as CryptoError).code).toBe('CRYPTO_ASN1_INVALID');
    }
  });

  it('非 Uint8Array 输入抛 CRYPTO_INVALID_ARGUMENT', () => {
    try {
      parseSeal('not-bytes' as unknown as Uint8Array);
      throw new Error('未抛错');
    } catch (error) {
      expect((error as CryptoError).code).toBe('CRYPTO_INVALID_ARGUMENT');
    }
  });
});