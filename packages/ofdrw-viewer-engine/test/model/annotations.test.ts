import { describe, expect, it, vi } from 'vitest';
import { decodeAnnotations, decodeAnnotationsIndex } from '../../src/model/decode';
import { leaf, node } from './xml';

describe('decodeAnnotationsIndex', () => {
  it('建立 PageID → FileLoc 索引，重复页保留先出现者', () => {
    const onWarning = vi.fn();
    const root = node('Annotations', {}, [
      node('Page', { PageID: '#0' }, [leaf('FileLoc', 'Page_0/Annotation.xml')]),
      node('Page', { PageID: '1' }, [leaf('FileLoc', '/Doc_0/Annots/Page_1/Annotation.xml')]),
      node('Page', { PageID: '0' }, [leaf('FileLoc', 'Duplicate.xml')]),
      node('Page', {}, [leaf('FileLoc', 'NoId.xml')]),
      node('Page', { PageID: '2' }, []),
    ]);
    const index = decodeAnnotationsIndex(root, 'Doc_0/Annots', { onWarning });
    expect(index.pageAnnotIndex).toEqual({
      '0': 'Doc_0/Annots/Page_0/Annotation.xml',
      '1': 'Doc_0/Annots/Page_1/Annotation.xml',
    });
    expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({ code: 'W_DUPLICATE_RESOURCE' }));
    expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({ code: 'W_ANNOT_EMPTY' }));
  });
});

describe('decodeAnnotations', () => {
  it('解码 Annot/Appearance 结构，空外观 warning 且不产生块', () => {
    const onWarning = vi.fn();
    const root = node('PageAnnot', {}, [
      node('Annot', { ID: '1', Type: 'Stamp', Visible: 'false' }, [
        node('Appearance', { Boundary: '1 2 100 200' }, [
          node('TextObject', { ID: '10', Boundary: '0 0 100 20', Font: '1', Size: '10' }),
        ]),
      ]),
      node('Annot', { ID: '2', Type: 'Link' }),
      node('Annot', { ID: '3', Type: 'Path' }, [node('Appearance', { Boundary: '0 0 1 1' }, [])]),
    ]);
    const annotations = decodeAnnotations(root, ['0'], { onWarning });
    expect(annotations).toHaveLength(3);
    expect(annotations[0]).toMatchObject({ id: '1', type: 'Stamp', visible: false });
    expect(annotations[0]?.boundary).toEqual({ x: 1, y: 2, w: 100, h: 200 });
    expect(annotations[0]?.appearance?.children[0]?.kind).toBe('text');
    expect(annotations[1]?.appearance).toBeUndefined();
    expect(annotations[2]?.appearance).toBeUndefined();
    expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({ code: 'W_ANNOT_EMPTY' }));
  });
});

describe('decodeAnnotations Boundary 兜底（BUG-V2-02）', () => {
  it('Appearance 缺少 @Boundary 时用子图元边界并集兜底', () => {
    const root = node('PageAnnot', {}, [
      node('Annot', { ID: '225', Type: 'Stamp' }, [
        node('Appearance', {}, [
          // 图片局部空间为单位正方形：CTM 的单位长度为 Boundary 宽/高。
          node('ImageObject', {
            ID: '30',
            ResourceID: '12',
            Boundary: '100 50 18 18',
            CTM: '18 0 0 18 100 50',
          }),
          node('ImageObject', {
            ID: '31',
            ResourceID: '13',
            Boundary: '0 0 50 12.5',
            CTM: '50 0 0 12.5 130 60',
          }),
        ]),
      ]),
    ]);
    const annotations = decodeAnnotations(root, ['0'], { onWarning: vi.fn() });
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.appearance?.children[0]?.kind).toBe('image');
    expect(annotations[0]?.boundary).toEqual({ x: 100, y: 50, w: 80, h: 22.5 });
  });

  it('多子图元取并集，显式 @Boundary 优先', () => {
    const root = node('PageAnnot', {}, [
      node('Annot', { ID: '1' }, [
        node('Appearance', {}, [
          node('PathObject', { ID: '2', Boundary: '10 10 20 20', AbbreviatedData: 'M0 0 L1 1' }),
          node('TextObject', { ID: '3', Boundary: '40 30 10 10', Font: '1', Size: '5' }),
        ]),
      ]),
      node('Annot', { ID: '2' }, [
        node('Appearance', { Boundary: '0 0 5 5' }, [
          node('PathObject', { ID: '4', Boundary: '10 10 20 20', AbbreviatedData: 'M0 0 L1 1' }),
        ]),
      ]),
    ]);
    const annotations = decodeAnnotations(root, ['0'], { onWarning: vi.fn() });
    expect(annotations[0]?.boundary).toEqual({ x: 10, y: 10, w: 40, h: 30 });
    expect(annotations[1]?.boundary).toEqual({ x: 0, y: 0, w: 5, h: 5 });
  });
});
