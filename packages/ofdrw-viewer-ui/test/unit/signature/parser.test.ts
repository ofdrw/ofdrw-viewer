/**
 * `SignedValue.dat` 解析器单元测试。
 *
 * 覆盖真实 v4/v5 夹具、构造的 v1、缺证书/坏证书、损坏 DER、未知版本、
 * 时间戳字段与文件大小/深度/节点限制。
 */

import { describe, expect, it } from 'vitest';
import {
  parseSignedValue,
  isSignatureParseError,
  MAX_ASN1_DEPTH,
  MAX_ASN1_NODES,
} from '../../../src/signature/asn1';
import {
  buildV1SignedValue,
  corruptSignedValue,
  deepNestedSequence,
  readSignedValueFixture,
  v4WithBadCert,
  v4WithoutCert,
  v4WithTimestamp,
  v4WithUnknownVersion,
} from './fixtures';

describe('parseSignedValue', () => {
  it('解析真实 v4 夹具：版本、签章时间、证书、算法、印章属性与图片', async () => {
    const result = await parseSignedValue(readSignedValueFixture('SignedValueV4.dat'));

    expect(result.version).toBe('v4');
    expect(result.warnings).toEqual([]);
    expect(result.seal).toMatchObject({
      version: 'v4',
      esId: '51f044b76510434e9bc67a1185c2fba5',
      name: 'OFD R&W 测试用印章',
      typeCode: 3,
      typeLabel: '未知',
      createDate: '2020-04-22T02:09:00.000Z',
      validStart: '2020-04-22T02:09:00.000Z',
      validEnd: '2022-04-22T02:09:00.000Z',
      image: { format: 'PNG', widthMm: 40, heightMm: 40 },
    });
    expect(result.signer?.signedAt).toBe('2020-10-12T11:14:03.000Z');
    expect(result.signer?.signedAtSource).toBe('timeInfo');
    expect(result.signer?.algorithm).toEqual({
      oid: '1.2.156.10197.1.501',
      name: 'SM2-with-SM3',
    });
    expect(result.signer?.certificate?.subjectAttributes).toMatchObject({
      cn: 'Test Certificate',
      o: 'OFD R&W',
      st: 'Zhejiang',
      l: 'Hangzhou',
    });
    expect(result.signer?.certificate?.issuer).toContain(
      'OFD Reader and WriterROOT Certificate',
    );
    expect(result.signer?.certificate?.serialNumber).toMatch(/^[0-9a-f]+$/);
    expect(result.signer?.certificate?.notBefore).toBe('2020-04-21T14:39:08.000Z');
    expect(result.signer?.certificate?.signatureAlgorithm?.oid).toBe(
      '1.2.156.10197.1.501',
    );
    expect(result.signer?.dataHash).toMatch(/^[0-9a-f]+$/);
    expect(result.signer?.timestampPresent).toBeUndefined();
  });

  it('解析真实 v5 夹具', async () => {
    const result = await parseSignedValue(readSignedValueFixture('SignedValueV5.dat'));

    expect(result.version).toBe('v5');
    expect(result.seal?.version).toBe('v5');
    expect(result.seal?.name).toBe('OFD R&W V5测试用印章');
    expect(result.signer?.signedAt).toBe('2026-04-24T08:53:26.000Z');
    expect(result.signer?.timestampPresent).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('解析构造的 v1：时间来自 BIT STRING ASCII、证书在 TBS 内', async () => {
    const result = await parseSignedValue(buildV1SignedValue());

    expect(result.version).toBe('v1');
    expect(result.seal?.version).toBe('v1');
    expect(result.seal?.name).toBe('测试个人印章');
    expect(result.seal?.typeLabel).toBe('个人印章');
    expect(result.seal?.esId).toBe('V1SEALID');
    expect(result.seal?.createDate).toBe('2020-01-01T00:00:00.000Z');
    expect(result.seal?.validEnd).toBe('2022-01-01T00:00:00.000Z');
    expect(result.signer?.signedAt).toBe('2020-01-25T08:07:31.000Z');
    expect(result.signer?.signedAtSource).toBe('timeInfo');
    expect(result.signer?.certificate?.subjectAttributes?.cn).toBe('Test Certificate');
    expect(result.warnings).toEqual([]);
  });

  it('v1 时间戳令牌：不猜测时间，只标记含时间戳并 warning', async () => {
    const result = await parseSignedValue(buildV1SignedValue({ timestampToken: true }));

    expect(result.signer?.signedAt).toBeUndefined();
    expect(result.signer?.signedAtSource).toBe('timestamp-token');
    expect(result.signer?.timestampPresent).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toContain('W_SIGNATURE_TIME');
  });

  it('v4 缺少证书：仍返回时间/算法/印章，并给出缺证书 warning', async () => {
    const result = await parseSignedValue(v4WithoutCert());

    expect(result.version).toBe('v4');
    expect(result.signer?.certificate).toBeUndefined();
    expect(result.signer?.signedAt).toBe('2020-10-12T11:14:03.000Z');
    expect(result.signer?.algorithm?.oid).toBe('1.2.156.10197.1.501');
    expect(result.seal?.name).toBe('OFD R&W 测试用印章');
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'W_SIGNATURE_CERT' }),
      ]),
    );
  });

  it('v4 坏证书：证书解析失败但不影响其他字段', async () => {
    const result = await parseSignedValue(v4WithBadCert());

    expect(result.signer?.certificate).toBeUndefined();
    expect(result.signer?.signedAt).toBe('2020-10-12T11:14:03.000Z');
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'W_SIGNATURE_CERT' }),
      ]),
    );
  });

  it('v4 [0] 时间戳字段只标记“含时间戳”，不解析内容', async () => {
    const result = await parseSignedValue(v4WithTimestamp());

    expect(result.signer?.timestampPresent).toBe(true);
    expect(result.signer?.signedAt).toBe('2020-10-12T11:14:03.000Z');
  });

  it('未知版本：仍按结构解析并 warning', async () => {
    const result = await parseSignedValue(v4WithUnknownVersion(9));

    expect(result.version).toBe('unknown');
    expect(result.warnings.map((warning) => warning.code)).toContain('W_SIGNATURE_VERSION');
    expect(result.signer?.signedAt).toBe('2020-10-12T11:14:03.000Z');
  });

  it('损坏 DER：抛 W_SIGNATURE_ASN1', async () => {
    await expect(parseSignedValue(corruptSignedValue())).rejects.toSatisfy(
      (error: unknown) => isSignatureParseError(error) && error.code === 'W_SIGNATURE_ASN1',
    );
  });

  it('文件大小限制：解析前拒绝超限文件', async () => {
    await expect(
      parseSignedValue(readSignedValueFixture('SignedValueV4.dat'), {
        limits: { maxBytes: 8 },
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isSignatureParseError(error) && error.code === 'W_SIGNATURE_LIMIT',
    );
  });

  it('深度限制：超过上限抛 W_SIGNATURE_LIMIT', async () => {
    await expect(
      parseSignedValue(deepNestedSequence(MAX_ASN1_DEPTH + 5)),
    ).rejects.toSatisfy(
      (error: unknown) => isSignatureParseError(error) && error.code === 'W_SIGNATURE_LIMIT',
    );
  });

  it('节点数限制：超过上限抛 W_SIGNATURE_LIMIT', async () => {
    await expect(
      parseSignedValue(readSignedValueFixture('SignedValueV4.dat'), {
        limits: { maxNodes: 10 },
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isSignatureParseError(error) && error.code === 'W_SIGNATURE_LIMIT',
    );
  });

  it('默认限制常量满足设计文档（16 MB / 32 层 / 100k 节点）', () => {
    expect(MAX_ASN1_DEPTH).toBe(32);
    expect(MAX_ASN1_NODES).toBe(100_000);
  });
});