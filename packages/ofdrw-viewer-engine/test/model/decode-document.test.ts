import { describe, expect, it, vi } from 'vitest';
import { decodeDocument } from '../../src/model/decode';
import { leaf, node } from './xml';

describe('decodeDocument', () => {
  it('解析 CommonData、模板索引、页树与注释索引文件', () => {
    const documentNode = node('Document', { Version: '1.0' }, [
      node('CommonData', {}, [
        node('PageArea', {}, [leaf('PhysicalBox', '0 0 210 297')]),
        leaf('PublicRes', 'PublicRes.xml'),
        leaf('DocumentRes', 'DocumentRes.xml'),
        leaf('MaxUnitID', '100'),
        leaf('DefaultCS', '#5'),
        node('TemplatePage', { ID: '#7', ZOrder: 'Foreground' }, [
          leaf('BaseLoc', 'Tpl_7/Content.xml'),
        ]),
      ]),
      leaf('Annotations', 'Annots/Annotations.xml'),
      node('Pages', {}, [
        node('Page', { ID: '1', BaseLoc: 'Pages/Page_0/Content.xml' }),
      ]),
    ]);
    const document = decodeDocument(documentNode, 'Doc_0/Document.xml');
    expect(document.docRoot).toBe('Doc_0');
    expect(document.version).toBe('1.0');
    expect(document.pageCount).toBe(1);
    expect(document.pages[0]).toEqual({ id: '1', loc: 'Doc_0/Pages/Page_0/Content.xml' });
    expect(document.annotationsFile).toBe('Doc_0/Annots/Annotations.xml');
    expect(document.commonData?.pageArea).toEqual({ x: 0, y: 0, w: 210, h: 297 });
    expect(document.commonData?.publicRes).toEqual(['Doc_0/PublicRes.xml']);
    expect(document.commonData?.documentRes).toEqual(['Doc_0/DocumentRes.xml']);
    expect(document.commonData?.maxUnitId).toBe('100');
    expect(document.commonData?.defaultColorSpaceId).toBe('5');
    expect(document.templatePages['7']).toEqual({
      id: '7',
      baseLoc: 'Doc_0/Tpl_7/Content.xml',
      zOrder: 'Foreground',
    });
  });

  it('缺少 Pages 时按 0 页并 warning', () => {
    const onWarning = vi.fn();
    const document = decodeDocument(node('Document', {}, []), 'Doc_0/Document.xml', { onWarning });
    expect(document.pageCount).toBe(0);
    expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({ code: 'W_BAD_NUMBER' }));
  });

  it('重复 TemplatePage ID 保留先出现者', () => {
    const onWarning = vi.fn();
    const documentNode = node('Document', {}, [
      node('CommonData', {}, [
        node('TemplatePage', { ID: '1' }, [leaf('BaseLoc', 'A.xml')]),
        node('TemplatePage', { ID: '#1' }, [leaf('BaseLoc', 'B.xml')]),
      ]),
      node('Pages', {}, []),
    ]);
    const document = decodeDocument(documentNode, 'Doc_0/Document.xml', { onWarning });
    expect(document.templatePages['1']?.baseLoc).toBe('Doc_0/A.xml');
    expect(onWarning).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'W_DUPLICATE_RESOURCE', resourceId: '1' }),
    );
  });
});