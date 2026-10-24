/**
 * `<ofd-viewer>` 字体配置：`fonts` property 与 `font-default`/`font-supplementary` 简写属性。
 */
import { replaceChildren } from '../../../src/compat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFontAttribute } from '../../../src/component/support';
import { FakeViewer } from './mock-viewer';

vi.mock('../../../src/index', async () => {
  const { FakeViewer: Fake } = await import('./mock-viewer');
  return { OFDViewer: Fake };
});

import { OFD_VIEWER_TAG, defineOFDViewerElement } from '../../../src/component/ofd-viewer-element';
import type { OFDViewerElement } from '../../../src/component/ofd-viewer-element';

/**
 * 创建并挂载 `<ofd-viewer>`。
 *
 * @returns 已连接的组件元素
 */
function mount(): OFDViewerElement {
  const element = document.createElement(OFD_VIEWER_TAG) as OFDViewerElement;
  element.setAttribute('src', 'a.ofd');
  document.body.append(element);
  return element;
}

beforeEach(() => {
  FakeViewer.reset();
  defineOFDViewerElement();
  replaceChildren(document.body);
});

afterEach(() => {
  replaceChildren(document.body);
  vi.restoreAllMocks();
});

describe('<ofd-viewer> 字体属性', () => {
  it('fonts property 在创建实例前设置后进入构造选项', () => {
    const element = document.createElement(OFD_VIEWER_TAG) as OFDViewerElement;
    element.setAttribute('src', 'a.ofd');
    element.fonts = { default: [{ url: '/fonts/default.woff2' }] };
    document.body.append(element);

    const viewer = FakeViewer.instances[0]!;
    expect(viewer.options.fonts).toEqual({ default: [{ url: '/fonts/default.woff2' }] });
    expect(element.fonts).toEqual({ default: [{ url: '/fonts/default.woff2' }] });
  });

  it('未配置字体时不向实例传 fonts 字段', () => {
    mount();
    expect(FakeViewer.instances[0]!.options.fonts).toBeUndefined();
  });

  it('实例存在后修改 fonts 不重建实例', () => {
    const element = mount();
    const viewer = FakeViewer.instances[0]!;
    element.fonts = { supplementary: [{ url: '/fonts/b.woff2' }] };

    expect(FakeViewer.instances).toHaveLength(1);
    expect(element.viewer).toBe(viewer);
    expect(viewer.options.fonts).toBeUndefined();
  });

  it('font-default / font-supplementary 属性映射为 [{ url }]', () => {
    const element = document.createElement(OFD_VIEWER_TAG) as OFDViewerElement;
    element.setAttribute('src', 'a.ofd');
    element.setAttribute('font-default', '/fonts/a.woff2, /fonts/b.woff2');
    element.setAttribute('font-supplementary', '/fonts/c.woff2');
    document.body.append(element);

    expect(FakeViewer.instances[0]!.options.fonts).toEqual({
      default: [{ url: '/fonts/a.woff2' }, { url: '/fonts/b.woff2' }],
      supplementary: [{ url: '/fonts/c.woff2' }],
    });
  });

  it('font-default 变更销毁并按新属性重建实例', () => {
    const element = mount();
    const first = FakeViewer.instances[0]!;
    expect(first.options.fonts).toBeUndefined();

    element.setAttribute('font-default', '/fonts/new.woff2');

    expect(first.destroyed).toBe(true);
    expect(FakeViewer.instances).toHaveLength(2);
    const second = FakeViewer.instances[1]!;
    expect(element.viewer).toBe(second);
    expect(second.options.fonts).toEqual({ default: [{ url: '/fonts/new.woff2' }] });
    // 重建保留文档来源。
    expect(second.options.source).toBe('a.ofd');
  });

  it('font-supplementary 变更同样触发重建，并保留 fonts property 的其它字段', () => {
    const element = document.createElement(OFD_VIEWER_TAG) as OFDViewerElement;
    const loader = () => new Uint8Array([1]);
    element.fonts = { default: [{ url: '/fonts/property.woff2' }], loader };
    element.setAttribute('src', 'a.ofd');
    document.body.append(element);
    expect(FakeViewer.instances[0]!.options.fonts).toEqual({
      default: [{ url: '/fonts/property.woff2' }],
      loader,
    });

    element.setAttribute('font-supplementary', '/fonts/sup.woff2');

    expect(FakeViewer.instances).toHaveLength(2);
    expect(FakeViewer.instances[1]!.options.fonts).toEqual({
      default: [{ url: '/fonts/property.woff2' }],
      loader,
      supplementary: [{ url: '/fonts/sup.woff2' }],
    });
  });

  it('属性值未变化时不重建实例', () => {
    const element = document.createElement(OFD_VIEWER_TAG) as OFDViewerElement;
    element.setAttribute('font-default', '/fonts/a.woff2');
    element.setAttribute('src', 'a.ofd');
    document.body.append(element);

    element.setAttribute('font-default', '/fonts/a.woff2');

    expect(FakeViewer.instances).toHaveLength(1);
  });

  it('属性清空后重建为不配置字体的实例', () => {
    const element = document.createElement(OFD_VIEWER_TAG) as OFDViewerElement;
    element.setAttribute('font-default', '/fonts/a.woff2');
    element.setAttribute('src', 'a.ofd');
    document.body.append(element);

    element.removeAttribute('font-default');

    expect(FakeViewer.instances).toHaveLength(2);
    expect(FakeViewer.instances[1]!.options.fonts).toBeUndefined();
  });

  it('未连接时设置字体属性在连接后生效', () => {
    const element = document.createElement(OFD_VIEWER_TAG) as OFDViewerElement;
    element.setAttribute('src', 'a.ofd');
    element.setAttribute('font-default', '/fonts/late.woff2');
    document.body.append(element);

    expect(FakeViewer.instances[0]!.options.fonts).toEqual({
      default: [{ url: '/fonts/late.woff2' }],
    });
  });
});

describe('readFontAttribute', () => {
  it('逗号分隔、去除首尾空白并丢弃空项', () => {
    const element = document.createElement('div');
    element.setAttribute('font-default', ' a.woff2 , ,b.woff2,');
    expect(readFontAttribute(element, 'font-default')).toEqual([
      { url: 'a.woff2' },
      { url: 'b.woff2' },
    ]);
  });

  it('属性缺失返回 undefined', () => {
    expect(readFontAttribute(document.createElement('div'), 'font-default')).toBeUndefined();
  });

  it('空值与纯空白/逗号返回 undefined', () => {
    const element = document.createElement('div');
    element.setAttribute('font-default', '');
    expect(readFontAttribute(element, 'font-default')).toBeUndefined();
    element.setAttribute('font-default', ' , ,  ');
    expect(readFontAttribute(element, 'font-default')).toBeUndefined();
  });

  it('保留带 query 的完整 URL 与首尾空白', () => {
    const element = document.createElement('div');
    element.setAttribute('font-default', 'https://cdn.example/f.woff2?v=1');
    expect(readFontAttribute(element, 'font-default')).toEqual([
      { url: 'https://cdn.example/f.woff2?v=1' },
    ]);
  });
});

describe('<ofd-viewer> 字体配置与「文档字体缺省」样本（拿来主义_page6.ofd）', () => {
  /**
   * 该样本的 PublicRes 只声明 `FontName="宋体"`、没有任何 FontFile，故不配字体必然空白；
   * 这里以构造选项断言 UI → 引擎的映射：字体字节非空且别名表为“内置 + 宿主追加”。
   */
  it('font-default 提供宋体替代字体时，实例收到非空 fonts.default', () => {
    const element = document.createElement(OFD_VIEWER_TAG) as OFDViewerElement;
    element.setAttribute('src', 'samples/na-lai-zhu-yi-page6.ofd');
    element.setAttribute('font-default', '/fonts/NotoSerifSC-Regular.woff2');
    document.body.append(element);

    const fonts = FakeViewer.instances[0]!.options.fonts as {
      default?: readonly { url: string }[];
    };
    expect(fonts.default).toEqual([{ url: '/fonts/NotoSerifSC-Regular.woff2' }]);
    expect(fonts.default?.length).toBeGreaterThan(0);
  });

  it('fonts.aliases 以追加语义与内置别名组组合', async () => {
    const { composeFontAliases } = await import('../../../src/font');
    const { DEFAULT_FONT_ALIASES } = await import('@ofdrw/ofdrw-viewer-engine');
    const composed = composeFontAliases([['宋体', 'notoserifscextralight']]);
    expect(composed.length).toBe(DEFAULT_FONT_ALIASES.length + 1);
    expect(composed.slice(0, DEFAULT_FONT_ALIASES.length)).toEqual(
      DEFAULT_FONT_ALIASES.map((group) => [...group]),
    );
    expect(composed.at(-1)).toEqual(['宋体', 'notoserifscextralight']);
  });
});
