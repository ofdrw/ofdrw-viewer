/**
 * SES v1/v4/v5 SignedValue、Signature.xml、Signatures.xml 解析。
 */

import { describe, expect, it } from 'vitest';
import { openZipVirtualContainer } from '@ofdrw/ofdrw-viewer-engine';
import {
  CryptoError,
  parseSignatureXml,
  parseSignaturesXml,
  parseSignedValue,
  sm3Hex,
} from '@ofdrw/ofdrw-viewer-crypto';
import { fixtureBytes } from '../core/fixtures';
import { buildV1SignedContainer } from '../verify/builders';

/**
 * 读取 fixture 包内条目。
 *
 * @param file fixture 文件名。
 * @param path 包内路径。
 * @returns 条目字节。
 */
async function readEntry(file: string, path: string): Promise<Uint8Array> {
  const container = await openZipVirtualContainer({
    kind: 'arraybuffer',
    data: fixtureBytes(file),
  });
  try {
    return await container.read(path);
  } finally {
    await container.close();
  }
}

/**
 * 捕获 CryptoError 错误码。
 *
 * @param fn 待执行函数。
 * @returns 错误码。
 */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof CryptoError) return error.code;
    throw error;
  }
  throw new Error('未按预期抛出 CryptoError');
}

describe('parseSignedValue', () => {
  for (const [file, version] of [
    ['signed-sesv4.ofd', 'v4'],
    ['signed-sesv5.ofd', 'v5'],
  ] as const) {
    it(`解析 SES ${version} 签名值`, async () => {
      const signedValue = await readEntry(file, 'Doc_0/Signs/Sign_0/SignedValue.dat');
      const signatureXml = await readEntry(file, 'Doc_0/Signs/Sign_0/Signature.xml');
      const parsed = parseSignedValue(signedValue);
      expect(parsed.version).toBe(version);
      expect(parsed.certificate?.subject).toContain('Signer');
      expect(parsed.signatureAlgorithm).toBe('SM3withSM2');
      expect(parsed.signedAt).toBe('2026-10-22T17:51:06.000Z');
      expect(parsed.dataHash).toBe(sm3Hex(signatureXml));
      expect(parsed.byteLength).toBe(signedValue.length);
      expect(parsed.seal).toMatchObject({
        version,
        esId: version === 'v4' ? 'OFDRWFIXTURESEALV4' : 'OFDRWFIXTURESEALV5',
        typeCode: 2,
        hasSignature: true,
        picture: { type: 'PNG', widthMm: 40, heightMm: 40 },
      });
      expect(parsed.seal?.makerCertificate?.subject).toContain('Seal Maker');
      expect(parsed.timestamp.status).toBe('parsed-not-verified');
      expect(parsed.timestamp.messageImprintMatchesSignature).toBe(true);
      expect(parsed.timestamp.note).toBe('已解析，未验证');
    });
  }

  it('解析 v1 SignedValue（合成向量）', async () => {
    const container = await buildV1SignedContainer();
    try {
      const bytes = await container.read('Doc_0/Signs/Sign_0/SignedValue.dat');
      const parsed = parseSignedValue(bytes);
      expect(parsed.version).toBe('v1');
      expect(parsed.certificate?.subject).toContain('Signer');
      expect(parsed.signedAt).toBe('2026-10-23 10:00:00');
      expect(parsed.dataHash).toMatch(/^[0-9a-f]{64}$/);
      expect(parsed.seal).toMatchObject({
        version: 'v1',
        esId: 'synthetic-es-v1',
        name: '合成测试印章',
        picture: { type: 'PNG', dataLength: 8 },
      });
      expect(parsed.timestamp.status).toBe('not-present');
    } finally {
      await container.close();
    }
  });

  it('拒绝不支持的 SES 版本', async () => {
    const signedValue = await readEntry('signed-sesv4.ofd', 'Doc_0/Signs/Sign_0/SignedValue.dat');
    const mutated = new Uint8Array(signedValue);
    // TBS_Sign 以 SEQUENCE { INTEGER version=4, ... } 开头，就地改为 9。
    const index = findSequence(mutated, [0x02, 0x01, 0x04]);
    expect(index).toBeGreaterThanOrEqual(0);
    mutated[index + 2] = 9;
    expect(codeOf(() => parseSignedValue(mutated))).toBe('CRYPTO_UNSUPPORTED_SES_VERSION');
  });

  it('拒绝非法 DER', () => {
    expect(codeOf(() => parseSignedValue(new Uint8Array([0x30, 0x02, 0x01])))).toBe(
      'CRYPTO_ASN1_INVALID',
    );
  });
});

describe('Signature.xml / Signatures.xml', () => {
  it('解析签名清单与引用', async () => {
    const signaturesXml = await readEntry('signed-sesv4.ofd', 'Doc_0/Signs/Signatures.xml');
    const list = parseSignaturesXml(signaturesXml);
    expect(list.signatures).toHaveLength(1);
    expect(list.signatures[0]).toMatchObject({
      id: 's001',
      type: 'Seal',
      baseLoc: '/Doc_0/Signs/Sign_0/Signature.xml',
    });
    expect(list.maxSignId).toBe('s002');

    const signatureXml = await readEntry('signed-sesv4.ofd', 'Doc_0/Signs/Sign_0/Signature.xml');
    const parsed = parseSignatureXml(signatureXml);
    expect(parsed.signedValueLoc).toBe('/Doc_0/Signs/Sign_0/SignedValue.dat');
    expect(parsed.sealLoc).toBe('/Doc_0/Signs/Sign_0/Seal.esl');
    expect(parsed.signatureMethod).toBe('1.2.156.10197.1.501');
    expect(parsed.checkMethod).toBe('SM3');
    expect(parsed.references).toHaveLength(6);
    expect(parsed.references[0]).toMatchObject({ fileRef: '/OFD.xml' });
    expect(parsed.references[0]?.checkValue).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(parsed.stampAnnots).toHaveLength(1);
    expect(parsed.raw).toEqual(signatureXml);
  });

  it('缺少 SignedValue 抛 CRYPTO_INVALID_PACKAGE', () => {
    const xml = new TextEncoder().encode(
      '<?xml version="1.0"?><ofd:Signature xmlns:ofd="http://www.ofdspec.org/2016"/>',
    );
    expect(codeOf(() => parseSignatureXml(xml))).toBe('CRYPTO_INVALID_PACKAGE');
  });
});

/**
 * 在字节中查找子序列。
 *
 * @param bytes 被查找字节。
 * @param pattern 目标序列。
 * @returns 起始下标；未找到返回 -1。
 */
function findSequence(bytes: Uint8Array, pattern: readonly number[]): number {
  for (let index = 0; index <= bytes.length - pattern.length; index += 1) {
    if (pattern.every((value, offset) => bytes[index + offset] === value)) return index;
  }
  return -1;
}