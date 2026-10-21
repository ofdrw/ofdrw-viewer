import { describe, expect, it } from 'vitest';
import {
  getAttr,
  getChild,
  getChildren,
  getRequiredAttr,
  getText,
  parseXml,
  SaxesXmlParser,
} from '../../src/xml/parser';
import { OFDError } from '../../src/errors';

describe('xml/parser', () => {
  it('解析带命名空间前缀的 OFD XML，节点名取 local name', () => {
    const root = parseXml(
      `<?xml version="1.0" encoding="UTF-8"?>
       <ofd:OFD xmlns:ofd="http://www.ofdspec.org/2016" Version="1.0">
         <ofd:DocBody><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody>
       </ofd:OFD>`,
    );
    expect(root.name).toBe('OFD');
    expect(root.attrs.Version).toBe('1.0');
    expect(root.attrs['xmlns:ofd']).toBeUndefined();
    const body = getChild(root, 'DocBody');
    expect(body).toBeDefined();
    expect(getText(getChild(body!, 'DocRoot')!)).toBe('Doc_0/Document.xml');
  });

  it('兼容两种命名空间、无命名空间与带前缀属性', () => {
    const xml = `<ofd:Page xmlns:ofd="urn:ofd" xmlns:xsi="urn:xsi" xsi:type="Page" ID="1">
      <ofd:Content><ofd:Layer ID="2"/></ofd:Content>
    </ofd:Page>`;
    const root = parseXml(xml);
    expect(root.name).toBe('Page');
    expect(root.attrs.ID).toBe('1');
    expect(root.attrs['xsi:type']).toBe('Page');
    expect(root.attrs.type).toBe('Page');
    expect(getChild(root, 'Content')!.name).toBe('Content');

    const plain = parseXml('<Page ID="3"><Content/></Page>');
    expect(plain.name).toBe('Page');
    expect(getText(plain)).toBe('');

    // 默认命名空间（无前缀）同样按 local name 输出。
    const defaultNs = parseXml('<Page xmlns="http://www.ofdspec.org/2016" ID="4"><Layer/></Page>');
    expect(defaultNs.name).toBe('Page');
    expect(defaultNs.attrs.ID).toBe('4');
    expect(getChild(defaultNs, 'Layer')!.name).toBe('Layer');
  });

  it('属性名大小写敏感，已知拼写错误做兼容别名', () => {
    const root = parseXml('<Path LineWidth="1" linewidth="2" LincWidth="3" Scrif="4"/>');
    expect(root.attrs.LineWidth).toBe('1');
    expect(root.attrs.linewidth).toBe('2');
    expect(getAttr(root, 'LineWidth')).toBe('1');
    // 规范化别名不覆盖已有规范属性。
    expect(root.attrs.LincWidth).toBe('3');
    expect(getAttr(root, 'Scrim')).toBe('4');
    expect(getAttr(root, 'scrim')).toBeUndefined();
  });

  it('兼容 CodecPosition/CodecCount', () => {
    const root = parseXml('<CGTransform CodecPosition="2" CodecCount="3"/>');
    expect(getAttr(root, 'CodePosition')).toBe('2');
    expect(getAttr(root, 'CodeCount')).toBe('3');
  });

  it('拒绝 DOCTYPE/ENTITY（XXE 防护）', () => {
    for (const xml of [
      '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo/>',
      '<foo><!ENTITY xxe "x"></foo>',
      '<!doctype foo><foo/>',
    ]) {
      try {
        parseXml(xml);
        throw new Error('应当拒绝');
      } catch (error) {
        expect(error).toBeInstanceOf(OFDError);
        expect((error as OFDError).code).toBe('OFD_XML_PARSE');
      }
    }
  });

  it('非法 XML 抛 OFD_XML_PARSE', () => {
    for (const xml of ['<a><b></a>', '<a>', 'not xml']) {
      try {
        parseXml(xml);
        throw new Error('应当抛错');
      } catch (error) {
        expect(error).toBeInstanceOf(OFDError);
        expect((error as OFDError).code).toBe('OFD_XML_PARSE');
      }
    }
  });

  it('限制嵌套深度与节点数', () => {
    const nested = '<a><b><c><d/></c></b></a>';
    expect(() => parseXml(nested, { maxDepth: 3 })).toThrowError(/嵌套深度/);

    const flat = `<root>${'<x/>'.repeat(10)}</root>`;
    expect(() => parseXml(flat, { maxNodes: 5 })).toThrowError(/节点数/);
    expect(parseXml(flat, { maxNodes: 20 }).children).toHaveLength(10);
  });

  it('辅助读取函数', () => {
    const root = parseXml('<root A="1"><item> one </item><item>two</item><empty/></root>');
    expect(getAttr(root, 'A')).toBe('1');
    expect(getAttr(root, 'B')).toBeUndefined();
    expect(getRequiredAttr(root, 'A')).toBe('1');
    expect(() => getRequiredAttr(root, 'B')).toThrow(OFDError);
    expect(getChildren(root, 'item')).toHaveLength(2);
    expect(getText(getChild(root, 'item')!)).toBe('one');
    expect(getText(getChild(root, 'empty')!)).toBe('');
  });

  it('支持 Uint8Array 与 BOM、CDATA', () => {
    const bytes = new TextEncoder().encode('\uFEFF<root><![CDATA[中文 <x>]]></root>');
    const root = parseXml(bytes);
    expect(getText(root)).toBe('中文 <x>');
    expect(new SaxesXmlParser().parse('<a/>').name).toBe('a');
  });
});