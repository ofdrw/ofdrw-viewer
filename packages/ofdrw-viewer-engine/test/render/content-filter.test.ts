/**
 * 页级绘制内容过滤单测：类型常量、白名单规范化、来源开关语义、注释类型与稳定 key。
 */

import { describe, expect, it } from 'vitest';
import {
  KNOWN_ANNOTATION_TYPES,
  isAnnotationTypeVisible,
  isPageLayerVisible,
  isSignatureVisible,
  isTemplateLayerVisible,
  resolveContentFilter,
  type PageContentFilter,
} from '../../src/render/content-filter';

describe('KNOWN_ANNOTATION_TYPES', () => {
  it('按设计文档列出常见注释类型且被冻结', () => {
    expect([...KNOWN_ANNOTATION_TYPES]).toEqual(['Link', 'Path', 'Highlight', 'Stamp', 'Watermark']);
    expect(Object.isFrozen(KNOWN_ANNOTATION_TYPES)).toBe(true);
  });
});

describe('resolveContentFilter：全画与空白', () => {
  it('未传 filter 归一化为 all', () => {
    const filter = resolveContentFilter();
    expect(filter.all).toBe(true);
    expect(filter.key).toBe('all');
    expect(filter.annotations).toBe(true);
    expect(filter.annotationTypes).toBeNull();
    expect(filter.signatures).toBe(true);
    for (const layer of ['Background', 'Body', 'Foreground', 'Custom'] as const) {
      expect(isPageLayerVisible(filter, layer)).toBe(true);
    }
    for (const layer of ['Background', 'Body', 'Foreground'] as const) {
      expect(isTemplateLayerVisible(filter, layer)).toBe(true);
    }
    expect(isAnnotationTypeVisible(filter, 'AnyType')).toBe(true);
    expect(isSignatureVisible(filter)).toBe(true);
  });

  it('传空对象为 none（空白页）', () => {
    const filter = resolveContentFilter({});
    expect(filter.all).toBe(false);
    expect(filter.key).toBe('none');
    for (const layer of ['Background', 'Body', 'Foreground', 'Custom'] as const) {
      expect(isPageLayerVisible(filter, layer)).toBe(false);
    }
    for (const layer of ['Background', 'Body', 'Foreground'] as const) {
      expect(isTemplateLayerVisible(filter, layer)).toBe(false);
    }
    expect(isAnnotationTypeVisible(filter, 'Stamp')).toBe(false);
    expect(isSignatureVisible(filter)).toBe(false);
  });

  it('与全画等价的配置归一化为 all', () => {
    const filter = resolveContentFilter({
      layers: { background: true, body: true, foreground: true, custom: true },
      annotations: true,
      signatures: true,
    });
    expect(filter.all).toBe(true);
    expect(filter.key).toBe('all');

    const verbose = resolveContentFilter({
      layers: {
        background: { page: true, templates: true },
        body: { page: true, templates: true },
        foreground: { page: true, templates: true },
        custom: { page: true, templates: true },
      },
      annotations: true,
      signatures: true,
    });
    expect(verbose.all).toBe(true);
    expect(verbose.key).toBe('all');
  });

  it('只缺签章时不是 all', () => {
    const filter = resolveContentFilter({
      layers: { background: true, body: true, foreground: true, custom: true },
    });
    expect(filter.all).toBe(false);
    expect(isSignatureVisible(filter)).toBe(false);
  });
});

describe('resolveContentFilter：图层', () => {
  it('层布尔 true 画整层（页面 + 模板），custom 没有模板位', () => {
    const filter = resolveContentFilter({ layers: { body: true, custom: true } });
    expect(isPageLayerVisible(filter, 'Body')).toBe(true);
    expect(isTemplateLayerVisible(filter, 'Body')).toBe(true);
    expect(isPageLayerVisible(filter, 'Custom')).toBe(true);
    expect(isTemplateLayerVisible(filter, 'Custom')).toBe(false);
    expect(isPageLayerVisible(filter, 'Background')).toBe(false);
    expect(isTemplateLayerVisible(filter, 'Background')).toBe(false);
    expect(isSignatureVisible(filter)).toBe(false);
  });

  it('层布尔 false 不画该层', () => {
    const filter = resolveContentFilter({ layers: { body: false, background: true } });
    expect(isPageLayerVisible(filter, 'Body')).toBe(false);
    expect(isTemplateLayerVisible(filter, 'Body')).toBe(false);
    expect(isPageLayerVisible(filter, 'Background')).toBe(true);
  });

  it('层对象 page/templates 缺省 false', () => {
    const filter = resolveContentFilter({ layers: { body: { page: true }, foreground: { templates: true } } });
    expect(isPageLayerVisible(filter, 'Body')).toBe(true);
    expect(isTemplateLayerVisible(filter, 'Body')).toBe(false);
    expect(isPageLayerVisible(filter, 'Foreground')).toBe(false);
    expect(isTemplateLayerVisible(filter, 'Foreground')).toBe(true);

    const empty = resolveContentFilter({ layers: { body: {} } });
    expect(isPageLayerVisible(empty, 'Body')).toBe(false);
    expect(isTemplateLayerVisible(empty, 'Body')).toBe(false);
    expect(empty.key).toBe('none');
  });

  it('层对象 page:false 显式不画页面内容', () => {
    const filter = resolveContentFilter({ layers: { body: { page: false, templates: true } } });
    expect(isPageLayerVisible(filter, 'Body')).toBe(false);
    expect(isTemplateLayerVisible(filter, 'Body')).toBe(true);
  });

  it('custom.templates 忽略', () => {
    const filter = resolveContentFilter({ layers: { custom: { templates: true } } });
    expect(isPageLayerVisible(filter, 'Custom')).toBe(false);
    expect(isTemplateLayerVisible(filter, 'Custom')).toBe(false);
    expect(filter.key).toBe('none');

    const both = resolveContentFilter({ layers: { custom: { page: true, templates: true } } });
    expect(isPageLayerVisible(both, 'Custom')).toBe(true);
    expect(isTemplateLayerVisible(both, 'Custom')).toBe(false);
    expect(both.key).toBe('layers=b:00,o:00,f:00,c:10;annotations=0;types=;signatures=0');
  });

  it('非法层值按未指定处理，不抛错', () => {
    const filter = resolveContentFilter({
      layers: {
        background: 'yes' as unknown as boolean,
        body: 1 as unknown as boolean,
        foreground: null as unknown as boolean,
        custom: true,
      },
      signatures: 'x' as unknown as boolean,
    });
    expect(isPageLayerVisible(filter, 'Background')).toBe(false);
    expect(isPageLayerVisible(filter, 'Body')).toBe(false);
    expect(isPageLayerVisible(filter, 'Foreground')).toBe(false);
    expect(isPageLayerVisible(filter, 'Custom')).toBe(true);
    expect(isSignatureVisible(filter)).toBe(false);
  });

  it('非法 layers 与非法 filter 不抛错', () => {
    const badLayers = resolveContentFilter({ layers: 'body' as unknown as PageContentFilter['layers'] });
    expect(badLayers.key).toBe('none');
    expect(isPageLayerVisible(badLayers, 'Body')).toBe(false);

    const badFilter = resolveContentFilter('all' as unknown as PageContentFilter);
    expect(badFilter.all).toBe(true);
    expect(badFilter.key).toBe('all');
  });
});

describe('resolveContentFilter：注释', () => {
  it('annotationTypes 出现即开启注释', () => {
    const filter = resolveContentFilter({ annotationTypes: ['Highlight', 'Stamp'] });
    expect(filter.annotations).toBe(true);
    expect(isAnnotationTypeVisible(filter, 'Stamp')).toBe(true);
    expect(isAnnotationTypeVisible(filter, 'Highlight')).toBe(true);
    expect(isAnnotationTypeVisible(filter, 'Link')).toBe(false);
    expect(isAnnotationTypeVisible(filter, undefined)).toBe(false);
  });

  it('annotations:true 且无类型列表画全部注释', () => {
    const filter = resolveContentFilter({ annotations: true });
    expect(filter.annotations).toBe(true);
    expect(filter.annotationTypes).toBeNull();
    expect(isAnnotationTypeVisible(filter, 'Stamp')).toBe(true);
    expect(isAnnotationTypeVisible(filter, undefined)).toBe(true);
  });

  it('annotationTypes 空数组不画任何注释', () => {
    const filter = resolveContentFilter({ annotationTypes: [] });
    expect(filter.annotations).toBe(true);
    expect(isAnnotationTypeVisible(filter, 'Stamp')).toBe(false);
    expect(isAnnotationTypeVisible(filter, undefined)).toBe(false);
    expect(filter.key).toBe('layers=b:00,o:00,f:00,c:00;annotations=1;types=;signatures=0');
  });

  it('annotations:false 优先，忽略 annotationTypes', () => {
    const filter = resolveContentFilter({ annotations: false, annotationTypes: ['Stamp'] });
    expect(filter.annotations).toBe(false);
    expect(filter.annotationTypes).toBeNull();
    expect(isAnnotationTypeVisible(filter, 'Stamp')).toBe(false);
    expect(filter.key).toBe('none');
  });

  it('类型去重与 trim，保持首次出现顺序', () => {
    const filter = resolveContentFilter({ annotationTypes: [' Stamp ', 'Stamp', 'Link', 'Link', '  '] });
    expect(filter.annotationTypes).toEqual(new Set(['Stamp', 'Link']));
    expect([...(filter.annotationTypes ?? [])]).toEqual(['Stamp', 'Link']);
    expect(filter.key).toBe('layers=b:00,o:00,f:00,c:00;annotations=1;types=Stamp,Link;signatures=0');
  });

  it('类型匹配区分大小写', () => {
    const filter = resolveContentFilter({ annotationTypes: ['Stamp'] });
    expect(isAnnotationTypeVisible(filter, 'Stamp')).toBe(true);
    expect(isAnnotationTypeVisible(filter, 'stamp')).toBe(false);
    expect(isAnnotationTypeVisible(filter, 'STAMP')).toBe(false);
  });

  it('宿主可扩展任意注释类型', () => {
    const filter = resolveContentFilter({ annotationTypes: ['CustomNote'] });
    expect(isAnnotationTypeVisible(filter, 'CustomNote')).toBe(true);
  });

  it('非法 annotationTypes 按未指定处理', () => {
    const filter = resolveContentFilter({ annotationTypes: 'Stamp' as unknown as string[] });
    expect(filter.annotations).toBe(false);
    expect(isAnnotationTypeVisible(filter, 'Stamp')).toBe(false);
  });

  it('非法类型项被忽略', () => {
    const filter = resolveContentFilter({ annotationTypes: [1, null, 'Stamp'] as unknown as string[] });
    expect([...(filter.annotationTypes ?? [])]).toEqual(['Stamp']);
  });
});

describe('resolveContentFilter：key', () => {
  it('按设计文档格式生成稳定 key', () => {
    const filter = resolveContentFilter({
      layers: { background: { page: true }, body: true, custom: true },
      annotationTypes: ['Highlight', 'Stamp'],
    });
    expect(filter.key).toBe('layers=b:10,o:11,f:00,c:10;annotations=1;types=Highlight,Stamp;signatures=0');
  });

  it('字段书写顺序不同但语义相同 → 同一 key', () => {
    const a = resolveContentFilter({
      layers: { body: true, background: { page: true }, custom: true },
      annotationTypes: ['Highlight', 'Stamp'],
      signatures: false,
    });
    const b = resolveContentFilter({
      signatures: false,
      annotationTypes: ['Highlight', 'Stamp'],
      layers: { custom: true, background: { page: true }, body: true },
    });
    expect(a.key).toBe(b.key);
    expect(a.key).toBe('layers=b:10,o:11,f:00,c:10;annotations=1;types=Highlight,Stamp;signatures=0');
  });

  it('类型列表去重后 key 相同', () => {
    const a = resolveContentFilter({ annotationTypes: ['Stamp', 'Stamp'] });
    const b = resolveContentFilter({ annotationTypes: ['Stamp'] });
    expect(a.key).toBe(b.key);
  });

  it('签章开关体现在 key 中', () => {
    const off = resolveContentFilter({ layers: { body: { page: true } } });
    const on = resolveContentFilter({ layers: { body: { page: true } }, signatures: true });
    expect(off.key).toBe('layers=b:00,o:10,f:00,c:00;annotations=0;types=;signatures=0');
    expect(on.key).toBe('layers=b:00,o:10,f:00,c:00;annotations=0;types=;signatures=1');
    expect(off.key).not.toBe(on.key);
  });

  it('未传 filter 的 key 固定为 all，与升级前缓存兼容', () => {
    expect(resolveContentFilter(undefined).key).toBe('all');
    expect(resolveContentFilter().key).toBe('all');
    expect(resolveContentFilter({}).key).toBe('none');
  });
});
