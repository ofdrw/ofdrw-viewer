import { describe, expect, it, vi } from 'vitest';
import { decodePageContent } from '../../src/model/decode';
import { leaf, node } from './xml';

/** 构造带模板引用的最小页面 XML。 */
function pageWithTemplates(...templates: ReturnType<typeof node>[]) {
  return node('Page', {}, [
    node('Area', {}, [leaf('PhysicalBox', '0 0 210 297')]),
    ...templates,
    node('Content', {}, []),
  ]);
}

describe('Template 引用的 ZOrder', () => {
  it('显式 Background/Body/Foreground 原样保留', () => {
    const page = decodePageContent(
      pageWithTemplates(
        node('Template', { TemplateID: '1', ZOrder: 'Background' }),
        node('Template', { TemplateID: '2', ZOrder: 'Body' }),
        node('Template', { TemplateID: '3', ZOrder: 'Foreground' }),
      ),
      '1',
      'Doc_0/Pages/Page_0/Content.xml',
    );
    expect(page.templates).toEqual([
      { id: '1', zOrder: 'Background' },
      { id: '2', zOrder: 'Body' },
      { id: '3', zOrder: 'Foreground' },
    ]);
  });

  it('缺省 ZOrder 按 Background 处理，且 zOrder 字段保留', () => {
    const onWarning = vi.fn();
    const page = decodePageContent(
      pageWithTemplates(node('Template', { TemplateID: '#4' })),
      '1',
      'Doc_0/Pages/Page_0/Content.xml',
      { onWarning },
    );
    expect(page.templates).toEqual([{ id: '4', zOrder: 'Background' }]);
    expect('zOrder' in page.templates[0]!).toBe(true);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('非法/空 ZOrder warning 后按 Background，不清空字段', () => {
    const onWarning = vi.fn();
    const page = decodePageContent(
      pageWithTemplates(
        node('Template', { TemplateID: '5', ZOrder: 'Side' }),
        node('Template', { TemplateID: '6', ZOrder: '  ' }),
      ),
      '1',
      'Doc_0/Pages/Page_0/Content.xml',
      { onWarning },
    );
    expect(page.templates).toEqual([
      { id: '5', zOrder: 'Background' },
      { id: '6', zOrder: 'Background' },
    ]);
    expect(onWarning).toHaveBeenCalledTimes(2);
    expect(onWarning).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'W_LAYER_ORDER', objectId: '5' }),
    );
    expect(onWarning).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'W_LAYER_ORDER', objectId: '6' }),
    );
  });
});