/**
 * fixture 生成器自测：合成 ZIP（stored/deflate/ZIP64/data descriptor/中文/坏包）、
 * XML 转义与最小 OFD 包结构。
 */

import { describe, expect, it } from 'vitest';
import {
  COLOR_CASES,
  MATRIX_CASES,
  buildMinimalOfd,
  buildXmlDocument,
  createZip,
  escapeXml,
  readZipEntries,
} from '../fixtures';

const decoder = new TextDecoder();

describe('合成 ZIP 生成器 + 独立解析器', () => {
  it('写入并读回 stored / deflate 条目', () => {
    const zip = createZip([
      { name: 'stored.txt', data: 'hello stored', method: 'store' },
      { name: 'deflate.txt', data: 'hello deflate '.repeat(20), method: 'deflate' },
    ]);
    const entries = readZipEntries(zip.bytes);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.name).toBe('stored.txt');
    expect(entries[0]!.method).toBe(0);
    expect(decoder.decode(entries[0]!.data)).toBe('hello stored');
    expect(entries[1]!.method).toBe(8);
    expect(decoder.decode(entries[1]!.data)).toBe('hello deflate '.repeat(20));
  });

  it('中文路径自动设置 UTF-8 标志位', () => {
    const zip = createZip([{ name: '文档/页面一.xml', data: '<a>中文</a>' }]);
    const [entry] = readZipEntries(zip.bytes);
    expect(entry!.name).toBe('文档/页面一.xml');
    expect(entry!.utf8).toBe(true);
    expect(decoder.decode(entry!.data)).toContain('中文');
  });

  it('data descriptor：本地头写 0，中央目录保留真实大小', () => {
    const zip = createZip([
      { name: 'dd.txt', data: 'descriptor payload', dataDescriptor: true, method: 'deflate' },
    ]);
    const [entry] = readZipEntries(zip.bytes);
    expect(entry!.dataDescriptor).toBe(true);
    expect(entry!.uncompressedSize).toBe('descriptor payload'.length);
    expect(decoder.decode(entry!.data)).toBe('descriptor payload');
  });

  it('ZIP64 条目：扩展字段携带 8 字节大小', () => {
    const zip = createZip([{ name: 'zip64.txt', data: 'zip64 payload', zip64: true }]);
    const [entry] = readZipEntries(zip.bytes);
    expect(entry!.zip64).toBe(true);
    expect(entry!.uncompressedSize).toBe('zip64 payload'.length);
    expect(decoder.decode(entry!.data)).toBe('zip64 payload');
  });

  it('ZIP64 EOCD + locator 可被解析', () => {
    const zip = createZip(
      [
        { name: 'a.txt', data: 'a' },
        { name: 'b.txt', data: 'b' },
      ],
      { forceZip64Eocd: true, comment: 'archive-comment' },
    );
    const entries = readZipEntries(zip.bytes);
    expect(entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt']);
    expect(entries[0]!.dataDescriptor).toBe(false);
  });

  it('允许重复路径并保留条目注释', () => {
    const zip = createZip([
      { name: 'dup.txt', data: 'first', comment: '条目一' },
      { name: 'dup.txt', data: 'second', comment: '条目二' },
    ]);
    const entries = readZipEntries(zip.bytes);
    expect(entries).toHaveLength(2);
    expect(decoder.decode(entries[0]!.data)).toBe('first');
    expect(decoder.decode(entries[1]!.data)).toBe('second');
    expect(entries[0]!.comment).toBe('条目一');
    expect(entries[1]!.comment).toBe('条目二');
  });

  it('保留路径穿越条目名（由容器层负责拒绝）', () => {
    const zip = createZip([{ name: '../evil.txt', data: 'x' }]);
    expect(readZipEntries(zip.bytes)[0]!.name).toBe('../evil.txt');
  });

  it('坏包：截断/魔数错误会抛错', () => {
    const zip = createZip([{ name: 'a.txt', data: 'abc' }]);
    expect(() => readZipEntries(zip.bytes.subarray(0, zip.bytes.length - 10))).toThrow();
    const broken = zip.bytes.slice();
    broken[0] = 0x00;
    broken[1] = 0x00;
    expect(() => readZipEntries(broken)).toThrow();
  });
});

describe('XML 与最小 OFD 包', () => {
  it('XML 转义与文档声明', () => {
    expect(escapeXml('<a & "b">')).toBe('&lt;a &amp; &quot;b&quot;&gt;');
    const xml = buildXmlDocument({ name: 'root', attrs: { a: 1 }, children: ['<text>'] });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('a="1"');
    expect(xml).toContain('&lt;text&gt;');
  });

  it('生成可解析的多页 OFD 包', () => {
    const fixture = buildMinimalOfd({ pageCount: 3, widthMm: 210, heightMm: 297, title: '三页' });
    const entries = readZipEntries(fixture.bytes);
    const names = entries.map((entry) => entry.name);
    expect(names).toContain('OFD.xml');
    expect(names).toContain('Doc_0/Document.xml');
    expect(names.filter((name) => /Pages\/Page_\d+\/Content\.xml$/.test(name))).toHaveLength(3);
    const ofdXml = decoder.decode(entries.find((entry) => entry.name === 'OFD.xml')!.data);
    expect(ofdXml).toContain('三页');
    const documentXml = decoder.decode(entries.find((entry) => entry.name === 'Doc_0/Document.xml')!.data);
    expect(documentXml.match(/<ofd:Page /g)).toHaveLength(3);
    const content = decoder.decode(
      entries.find((entry) => entry.name === 'Doc_0/Pages/Page_0/Content.xml')!.data,
    );
    expect(content).toContain('ofd:PathObject');
    expect(content).toContain('PhysicalBox');
  });

  it('带内嵌字体时生成 Res.xml 与字体条目', () => {
    const fixture = buildMinimalOfd({
      fonts: [
        {
          id: 1,
          fileName: 'Font_1.ttf',
          data: new Uint8Array([0, 1, 2, 3, 4]),
          fontName: 'FixtureCJK',
        },
      ],
    });
    const entries = readZipEntries(fixture.bytes);
    const names = entries.map((entry) => entry.name);
    expect(names).toContain('Doc_0/Res/Res.xml');
    expect(names).toContain('Doc_0/Res/Font_1.ttf');
    const content = decoder.decode(
      entries.find((entry) => entry.name === 'Doc_0/Pages/Page_0/Content.xml')!.data,
    );
    expect(content).toContain('ofd:TextObject');
    expect(content).toContain('你好 OFD');
    const res = decoder.decode(entries.find((entry) => entry.name === 'Doc_0/Res/Res.xml')!.data);
    expect(res).toContain('FixtureCJK');
  });
});

describe('矩阵/颜色 fixture 完整性', () => {
  it('矩阵用例可手工验算', () => {
    expect(MATRIX_CASES.length).toBeGreaterThanOrEqual(6);
    for (const testCase of MATRIX_CASES) {
      const [a, b, c, d, e, f] = testCase.matrix;
      const [x, y] = testCase.point;
      expect(a * x + c * y + e).toBeCloseTo(testCase.expected[0], 6);
      expect(b * x + d * y + f).toBeCloseTo(testCase.expected[1], 6);
    }
  });

  it('颜色用例的取值在合法范围', () => {
    expect(COLOR_CASES.length).toBeGreaterThanOrEqual(5);
    for (const testCase of COLOR_CASES) {
      expect(testCase.expected.r).toBeGreaterThanOrEqual(0);
      expect(testCase.expected.r).toBeLessThanOrEqual(255);
      expect(testCase.expected.a).toBeGreaterThanOrEqual(0);
      expect(testCase.expected.a).toBeLessThanOrEqual(1);
    }
  });
});