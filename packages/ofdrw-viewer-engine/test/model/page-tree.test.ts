import { describe, expect, it, vi } from 'vitest';
import { flattenPageTree } from '../../src/model/page-tree';
import { node } from './xml';

describe('flattenPageTree', () => {
  it('递归前序展开，BaseLoc 相对 Document.xml 目录', () => {
    const pages = node('Pages', {}, [
      node('Page', { ID: '#0001', BaseLoc: 'Pages/Page_0/Content.xml' }),
      node('Pages', {}, [
        node('Page', { ID: '2', BaseLoc: '/Doc_0/Pages/Page_1/Content.xml' }),
      ]),
    ]);
    const tree = flattenPageTree(pages, 'Doc_0');
    expect(tree.pageCount).toBe(2);
    expect(tree.pages).toEqual([
      { id: '1', loc: 'Doc_0/Pages/Page_0/Content.xml' },
      { id: '2', loc: 'Doc_0/Pages/Page_1/Content.xml' },
    ]);
  });

  it('重复页 ID 保留先出现者并 warning', () => {
    const onWarning = vi.fn();
    const pages = node('Pages', {}, [
      node('Page', { ID: '1', BaseLoc: 'A/Content.xml' }),
      node('Page', { ID: '#1', BaseLoc: 'B/Content.xml' }),
    ]);
    const tree = flattenPageTree(pages, 'Doc_0', { onWarning });
    expect(tree.pages).toHaveLength(1);
    expect(tree.pages[0]?.loc).toBe('Doc_0/A/Content.xml');
    expect(onWarning).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'W_DUPLICATE_RESOURCE', resourceId: '1' }),
    );
  });

  it('缺少 BaseLoc/ID 时 warning，非法路径不越出包根', () => {
    const onWarning = vi.fn();
    const pages = node('Pages', {}, [
      node('Page', { ID: '1' }),
      node('Page', { BaseLoc: 'A/Content.xml' }),
      node('Page', { ID: '3', BaseLoc: '../../escape/Content.xml' }),
    ]);
    const tree = flattenPageTree(pages, 'Doc_0', { onWarning });
    expect(tree.pages.map((page) => page.id)).toEqual(['1', '3']);
    expect(tree.pages[0]?.loc).toBe('');
    expect(tree.pages[1]?.loc).toBe('');
    expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({ code: 'W_BAD_NUMBER' }));
  });
});