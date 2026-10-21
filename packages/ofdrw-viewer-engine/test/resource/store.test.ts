import { describe, expect, it, vi } from 'vitest';
import type { FontResource, ResourceDefinitionSet, ResourceId } from '../../src/model/types';
import {
  buildDocumentResourceIndex,
  mergeResourceIndexes,
  ResourceStore,
  resourceSetToIndex,
} from '../../src/resource/store';
import type { PageModel } from '../../src/model/types';

/** 构造字体资源。 */
function font(id: string, name: string): FontResource {
  return {
    id,
    fontName: name,
    charset: 'unicode',
    serif: false,
    bold: false,
    italic: false,
    fixedSize: false,
  };
}

/** 构造页面模型。 */
function page(): PageModel {
  return {
    id: '1',
    area: { x: 0, y: 0, w: 210, h: 297 },
    size: { width: 210, height: 297 },
    layers: [],
    templates: [
      { id: '7', zOrder: 'Body' },
      { id: '8', zOrder: 'Background' },
    ],
    pageRes: [],
  };
}

describe('resourceSetToIndex', () => {
  it('把定义集合转成以 ID 为键的索引', () => {
    const set: ResourceDefinitionSet = {
      fonts: [font('1', 'A')],
      images: [{ id: '2', mediaFile: 'Res/image.png', format: 'png' }],
      drawParams: [{ id: '3', lineWidth: 2 }],
      compositeGraphicUnits: [{ id: '4', width: 10, height: 20, content: { kind: 'block', children: [] } }],
      colorSpaces: [{ id: '5', type: 'RGB', bitsPerComponent: 8 }],
      patterns: new Map(),
    };
    const index = resourceSetToIndex(set);
    expect(index.fonts.get('1')?.fontName).toBe('A');
    expect(index.images.get('2')?.format).toBe('png');
    expect(index.drawParams.get('3')?.lineWidth).toBe(2);
    expect(index.compositeGraphicUnits.get('4')?.width).toBe(10);
    expect(index.colorSpaces.get('5')?.type).toBe('RGB');
  });
});

describe('buildDocumentResourceIndex', () => {
  it('DocumentRes 后合并并覆盖 PublicRes，同 ID warning', () => {
    const onWarning = vi.fn();
    const document = buildDocumentResourceIndex({
      publicRes: ['PublicRes.xml'],
      documentRes: ['DocumentRes.xml'],
      indexes: [
        { fonts: new Map([['1', font('1', 'public')]]) },
        { fonts: new Map([['1', font('1', 'document')]]) },
      ],
      defaultColorSpace: '#5',
      onWarning,
    });
    expect(document.fonts.get('1')?.fontName).toBe('document');
    expect(document.defaultColorSpace).toBe('5');
    expect(document.publicRes).toEqual(['PublicRes.xml']);
    expect(onWarning).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'W_DUPLICATE_RESOURCE', resourceId: '1' }),
    );
  });

  it('mergeResourceIndexes 后层覆盖前层并归一化 ID', () => {
    const merged = mergeResourceIndexes({
      layers: [
        { fonts: new Map([['1', font('1', 'low')]]) },
        { fonts: new Map([['#001', font('1', 'high')]]) },
      ],
    });
    expect(merged.fonts.get('1')?.fontName).toBe('high');
  });
});

describe('ResourceStore 页级作用域', () => {
  it('查找顺序 page → template → document，页级覆盖 warning', () => {
    const onWarning = vi.fn();
    const document = buildDocumentResourceIndex({
      indexes: [{ fonts: new Map([['1', font('1', 'doc')], ['2', font('2', 'doc')], ['3', font('3', 'doc')]]) }],
      defaultColorSpace: '9',
    });
    const pageModel = page();
    const store = new ResourceStore(document);
    const scope = store.createPageScope({
      page: pageModel,
      document,
      pageResources: [
        { fonts: new Map([['1', font('1', 'page')]]), defaultColorSpace: '10' },
        { fonts: new Map([['1', font('1', 'page2')]]) },
      ],
      templateResources: [{ fonts: new Map([['2', font('2', 'template')]]) }],
      onWarning,
    });
    expect(scope.getFont('#001')?.fontName).toBe('page');
    expect(scope.getFont('2')?.fontName).toBe('template');
    expect(scope.getFont('3')?.fontName).toBe('doc');
    expect(scope.defaultColorSpace).toBe('10');
    expect(scope.pageId).toBe('1');
    expect(scope.templateIds).toEqual(['7', '8']);
    expect(onWarning).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'W_DUPLICATE_RESOURCE', resourceId: '1' }),
    );
  });

  it('ResourceStore 直接查询也归一化 ID', () => {
    const document = buildDocumentResourceIndex({
      indexes: [{ fonts: new Map([['12', font('12', 'A')]]) }],
    });
    const store = new ResourceStore(document);
    expect(store.getFont('#00012')?.fontName).toBe('A');
    expect(store.getFont('999')).toBeUndefined();
  });
});