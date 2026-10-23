import { describe, expect, it } from 'vitest';
import {
  DER_TAG,
  decodeOid,
  derBitString,
  derBoolean,
  derGeneralizedTime,
  derInteger,
  derNull,
  derOctetString,
  derOid,
  derSequence,
  derSet,
  derUtcTime,
  encodeDerLength,
  encodeDerTlv,
  fromHex,
  parseDer,
  parseDerAll,
  toHex,
} from '@ofdrw/ofdrw-viewer-crypto';

describe('DER 节点预算', () => {
  it('构造类型节点数超限抛 CRYPTO_LIMIT_EXCEEDED', () => {
    const many = derSequence(...Array.from({ length: 20 }, () => derNull()));
    expect(() => parseDer(many, { maxNodes: 10 })).toThrowError(/节点数/);
    expect(() => parseDer(many, { maxNodes: 0 })).toThrowError(/maxNodes/);
  });

  it('parseDerAll 的多个顶层 TLV 共享同一节点预算', () => {
    const many = new Uint8Array(20 * 2);
    for (let index = 0; index < 20; index += 1) {
      many[index * 2] = 0x05;
      many[index * 2 + 1] = 0x00;
    }
    expect(() => parseDerAll(many, { maxNodes: 10 })).toThrowError(/节点数/);
    expect(parseDerAll(many, { maxNodes: 20 })).toHaveLength(20);
  });
});

describe('DER 编解码', () => {
  it('保留原始 TLV，并按结构读取子节点', () => {
    const der = derSequence(derInteger(42n), derOctetString(Uint8Array.of(1, 2, 3)));
    const root = parseDer(der).requireSequence('Test');
    expect(root.children).toHaveLength(2);
    expect(root.children[0].asInteger()).toBe(42n);
    expect(toHex(root.children[1].asOctets())).toBe('010203');
    expect(toHex(root.raw)).toBe(toHex(der));
    expect(root.headerLength + root.length).toBe(der.length);
    expect(root.depth).toBe(0);
    expect(root.children[0].depth).toBe(1);
  });

  it('编码长度与高位 tag', () => {
    expect(toHex(encodeDerLength(0))).toBe('00');
    expect(toHex(encodeDerLength(127))).toBe('7f');
    expect(toHex(encodeDerLength(128))).toBe('8180');
    expect(toHex(encodeDerLength(300))).toBe('82012c');
    const tag = encodeDerTlv(
      { cls: 2, constructed: true, number: 0x1f },
      Uint8Array.of(0xaa),
    );
    expect(toHex(tag)).toBe('bf1f01aa');
  });

  it('SET 按 DER 字节序排序', () => {
    const set = derSet(derInteger(2n), derInteger(1n), derInteger(3n));
    const parsed = parseDer(set);
    expect(parsed.children.map((child) => child.asInteger())).toEqual([1n, 2n, 3n]);
  });

  it('INTEGER 支持正负与固定长度', () => {
    expect(parseDer(derInteger(0n)).asInteger()).toBe(0n);
    expect(parseDer(derInteger(128n)).asInteger()).toBe(128n);
    expect(toHex(derInteger(128n))).toBe('02020080');
    expect(parseDer(fromHex('0201ff')).asInteger()).toBe(-1n);
    expect(parseDer(fromHex('0202ff7f')).asInteger()).toBe(-129n);
    expect(() => parseDer(fromHex('0202007f')).asInteger()).toThrowError(/前导零/);
    expect(() => parseDer(fromHex('0202ff80')).asInteger()).toThrowError(/前导 0xff/);
    expect(toHex(parseDer(derInteger(fromHex('80'))).asUnsignedIntegerBytes(2))).toBe('0080');
    expect(() => parseDer(fromHex('020180')).asUnsignedIntegerBytes()).toThrowError(/非负/);
    expect(() => parseDer(fromHex('0203000080')).asUnsignedIntegerBytes()).toThrowError(
      /前导零/,
    );
    expect(() => derInteger(-1n)).toThrowError(/非负/);
  });

  it('OID 往返并支持大弧', () => {
    for (const oid of [
      '1.2.156.10197.1.501',
      '1.2.840.113549.1.7.2',
      '2.999.3',
      '0.9.2342.19200300.100.1.25',
    ]) {
      expect(parseDer(derOid(oid)).asOid()).toBe(oid);
    }
    expect(decodeOid(fromHex('2a0304'))).toBe('1.2.3.4');
    expect(() => decodeOid(fromHex('2a81'))).toThrowError(/截断/);
    expect(() => decodeOid(fromHex('2a8001'))).toThrowError(/非最小编码/);
  });

  it('BOOLEAN 与 BIT STRING 严格校验', () => {
    expect(parseDer(derBoolean(true)).asBoolean()).toBe(true);
    expect(parseDer(derBoolean(false)).asBoolean()).toBe(false);
    expect(() => parseDer(fromHex('010101')).asBoolean()).toThrowError(/0x00/);
    expect(() => parseDer(fromHex('0102ff00')).asBoolean()).toThrowError(/长度/);

    const bits = parseDer(derBitString(fromHex('a0'), 4)).asBitString();
    expect(bits.unusedBits).toBe(4);
    expect(toHex(bits.bytes)).toBe('a0');
    expect(() => parseDer(fromHex('0302a1f0')).asBitString()).toThrowError(/unused-bits/);
    expect(() => parseDer(fromHex('030204a0')).asBitStringOctets()).toThrowError(/字节对齐/);
  });

  it('时间编码/解析，包含小数秒', () => {
    const utc = new Date('2025-01-02T03:04:05.000Z');
    expect(parseDer(derUtcTime(utc)).asTime().toISOString()).toBe(utc.toISOString());
    const generalized = new Date('2050-12-31T23:59:59.000Z');
    expect(parseDer(derGeneralizedTime(generalized)).asTime().toISOString()).toBe(
      generalized.toISOString(),
    );
    const fraction = encodeDerTlv(
      { cls: 0, constructed: false, number: DER_TAG.GENERALIZED_TIME },
      new TextEncoder().encode('20250102030405.500Z'),
    );
    expect(parseDer(fraction).asTime().toISOString()).toBe('2025-01-02T03:04:05.500Z');
    expect(() => parseDer(derUtcTime(new Date('2060-01-01T00:00:00.000Z')))).toThrowError(
      /1950/,
    );
    const invalid = encodeDerTlv(
      { cls: 0, constructed: false, number: DER_TAG.UTC_TIME },
      new TextEncoder().encode('250230000000Z'),
    );
    expect(() => parseDer(invalid).asTime()).toThrowError(/范围/);
  });

  it('拒绝 BER/非最小/尾随/超限/超深输入', () => {
    expect(() => parseDer(new Uint8Array(0))).toThrowError(/为空/);
    expect(() => parseDer(fromHex('3000ff'))).toThrowError(/尾随/);
    expect(() => parseDer(fromHex('30800000'))).toThrowError(/不定长/);
    expect(() => parseDer(fromHex('30810100'))).toThrowError(/非最小编码/);
    expect(() => parseDer(fromHex('300500'))).toThrowError(/超出输入范围/);
    expect(() => parseDer(derSequence(derInteger(1n)), { maxBytes: 2 })).toThrowError(
      /超过上限/,
    );

    let nested = derInteger(1n);
    for (let i = 0; i < 5; i += 1) nested = derSequence(nested);
    expect(() => parseDer(nested, { maxDepth: 2 })).toThrowError(/嵌套深度/);
    expect(parseDer(nested, { maxDepth: 10 })).toBeTruthy();
  });

  it('parseDerAll 解析连续结构', () => {
    const one = derSequence(derInteger(1n));
    const two = derSequence(derInteger(2n));
    const nodes = parseDerAll(new Uint8Array([...one, ...two]));
    expect(nodes).toHaveLength(2);
    expect(nodes[1].children[0].asInteger()).toBe(2n);
    expect(() => parseDer(new Uint8Array([...one, ...two]))).toThrowError(/尾随/);
  });
});