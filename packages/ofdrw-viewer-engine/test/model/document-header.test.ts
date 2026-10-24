import { describe, expect, it, vi } from 'vitest';
import { decodeDocumentHeader } from '../../src/model/document-header';
import { decodeDocument } from '../../src/model/decode';
import { leaf, node } from './xml';

describe('decodeDocumentHeader', () => {
  it('解析根属性、PageArea 与 CommonData 资源声明', () => {
    const header = decodeDocumentHeader(
      node(
        'Document',
        { DocID: 'doc-1', Version: '1.2', MaxUnitID: '2048', DocUsage: 'Normal' },
        [
          node('PageArea', {}, [
            leaf('PhysicalBox', '0 0 210 297'),
            leaf('ApplicationBox', '5 5 200 287'),
            leaf('BleedBox', '0 0 220 307'),
          ]),
          leaf('PublicRes', 'PublicRes.xml'),
          node('CommonData', {}, [
            leaf('DocumentRes', 'DocumentRes.xml'),
            leaf('TemplatePageRes', '/Tpl/PageRes.xml'),
            leaf('DefaultCS', '5'),
          ]),
        ],
      ),
    );
    expect(header).toEqual({
      docId: 'doc-1',
      version: '1.2',
      maxUnitId: 2048,
      docUsage: 'Normal',
      pageArea: {
        physicalBox: { x: 0, y: 0, w: 210, h: 297 },
        applicationBox: { x: 5, y: 5, w: 200, h: 287 },
        bleedBox: { x: 0, y: 0, w: 220, h: 307 },
      },
      publicRes: ['PublicRes.xml'],
      documentRes: ['DocumentRes.xml'],
      templatePageRes: ['Tpl/PageRes.xml'],
      defaultCs: '5',
    });
  });

  it('缺失字段省略，非法 MaxUnitID 省略并 warning', () => {
    const warnings: Array<{ code: string }> = [];
    const header = decodeDocumentHeader(
      node('Document', { MaxUnitID: 'abc' }, [node('PageArea', {}, [])]),
      { onWarning: (warning) => warnings.push(warning) },
    );
    expect(header).toBeUndefined();
    expect(warnings.some((warning) => warning.code === 'W_METADATA_FIELD')).toBe(true);
  });

  it('非法路径跳过并 warning', () => {
    const onWarning = vi.fn();
    const header = decodeDocumentHeader(
      node('Document', {}, [leaf('PublicRes', '../PublicRes.xml'), leaf('PublicRes', 'A.xml')]),
      { onWarning },
    );
    expect(header?.publicRes).toEqual(['A.xml']);
    expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({ code: 'W_METADATA_FIELD' }));
  });

  it('decodeDocument 写入 header 字段', () => {
    const document = decodeDocument(
      node('Document', { Version: '1.1', DocID: 'd' }, [node('Pages', {}, [])]),
      'Doc_0/Document.xml',
    );
    expect(document.header).toEqual({ docId: 'd', version: '1.1' });
    expect(decodeDocument(node('Document', {}, [node('Pages', {}, [])]), 'Document.xml').header).toBeUndefined();
  });

  it('PageArea 优先取 Document 根，缺失时回退 CommonData/PageArea', () => {
    const root = decodeDocumentHeader(
      node('Document', {}, [
        node('PageArea', {}, [leaf('PhysicalBox', '0 0 100 200')]),
        node('CommonData', {}, [node('PageArea', {}, [leaf('PhysicalBox', '0 0 300 400')])]),
      ]),
    );
    expect(root?.pageArea).toEqual({ physicalBox: { x: 0, y: 0, w: 100, h: 200 } });

    const fallback = decodeDocumentHeader(
      node('Document', {}, [
        node('CommonData', {}, [node('PageArea', {}, [leaf('PhysicalBox', '0 0 300 400')])]),
      ]),
    );
    expect(fallback?.pageArea).toEqual({ physicalBox: { x: 0, y: 0, w: 300, h: 400 } });
  });

  it('同名多路径按 XML 顺序保存数组并规范化前导斜杠', () => {
    const header = decodeDocumentHeader(
      node('Document', {}, [
        leaf('PublicRes', 'Pub/a.xml'),
        leaf('PublicRes', '/Pub/b.xml'),
        node('CommonData', {}, [
          leaf('DocumentRes', '/DocRes/1.xml'),
          leaf('DocumentRes', 'DocRes/2.xml'),
          leaf('TemplatePageRes', '/Tpl/x.xml'),
        ]),
      ]),
    );
    expect(header?.publicRes).toEqual(['Pub/a.xml', 'Pub/b.xml']);
    expect(header?.documentRes).toEqual(['DocRes/1.xml', 'DocRes/2.xml']);
    expect(header?.templatePageRes).toEqual(['Tpl/x.xml']);
  });

  it('MaxUnitID 优先取 Document@MaxUnitID，其次 CommonData/MaxUnitID；DefaultCS 保留原文', () => {
    const attrFirst = decodeDocumentHeader(
      node('Document', { MaxUnitID: '10' }, [
        node('CommonData', {}, [leaf('MaxUnitID', '20'), leaf('DefaultCS', ' 5 ')]),
      ]),
    );
    expect(attrFirst?.maxUnitId).toBe(10);
    expect(attrFirst?.defaultCs).toBe('5');

    const childFallback = decodeDocumentHeader(
      node('Document', {}, [node('CommonData', {}, [leaf('MaxUnitID', '20')])]),
    );
    expect(childFallback?.maxUnitId).toBe(20);
  });

  it('CommonData/MaxUnitID 非法时省略并 warning', () => {
    const onWarning = vi.fn();
    const header = decodeDocumentHeader(
      node('Document', {}, [node('CommonData', {}, [leaf('MaxUnitID', 'x1')])]),
      { onWarning },
    );
    expect(header?.maxUnitId).toBeUndefined();
    expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({ code: 'W_METADATA_FIELD' }));
  });
});
