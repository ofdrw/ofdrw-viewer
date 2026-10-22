import { describe, expect, it, vi } from 'vitest';
import { decodeDocument, decodeOfdRoot } from '../../src/model/decode';
import { decodeBookmarks, decodeOutlines } from '../../src/model/navigation';
import { leaf, node } from './xml';

/** 构造带物理页面尺寸的最简 Page 节点。 */
function pageNode(id: string): ReturnType<typeof node> {
  return node('Page', { ID: id, BaseLoc: `Pages/Page_${id}/Content.xml` });
}

/** 构造 Goto/Dest 动作。 */
function destAction(attrs: Record<string, string>, bookmark?: string) {
  return node('Actions', {}, [
    node('Action', { Event: 'CLICK' }, [
      node('Goto', {}, [
        bookmark ? leaf('Bookmark', bookmark) : node('Dest', attrs),
      ]),
    ]),
  ]);
}

describe('Document.xml 大纲/书签解码', () => {
  it('递归保持层级/顺序/Expanded，并解析 Goto Bookmark', () => {
    const root = node('Document', {}, [
      node('Pages', {}, [pageNode('1'), pageNode('2')]),
      node('Bookmarks', {}, [
        node('Bookmark', { Name: '目标' }, [
          node('Dest', { Type: 'FitV', PageID: '2', Left: '12.5' }),
        ]),
      ]),
      node('Outlines', {}, [
        node('OutlineElem', { Title: 'A', Expanded: 'true' }, [
          destAction({ Type: 'XYZ', PageID: '1', Left: '1.25', Top: '2.5', Zoom: '1.5' }),
          node('OutlineElem', { Title: 'A-1', Expanded: 'false' }, [
            destAction({ Type: 'FitH', PageID: '2', Top: '9' }),
          ]),
        ]),
        node('OutlineElem', { Title: 'B' }, [destAction({}, '目标')]),
      ]),
    ]);
    const document = decodeDocument(root, 'Doc_0/Document.xml');
    expect(document.bookmarks).toEqual([
      { name: '目标', dest: { type: 'FitV', pageIndex: 1, leftMm: 12.5 } },
    ]);
    expect(document.outlines).toHaveLength(2);
    const first = document.outlines?.[0];
    expect(first?.title).toBe('A');
    expect(first?.expanded).toBe(true);
    expect(first?.dest).toEqual({ type: 'XYZ', pageIndex: 0, leftMm: 1.25, topMm: 2.5, zoom: 1.5 });
    expect(first?.children).toHaveLength(1);
    expect(first?.children[0]?.title).toBe('A-1');
    expect(first?.children[0]?.expanded).toBe(false);
    expect(first?.children[0]?.dest).toEqual({ type: 'FitH', pageIndex: 1, topMm: 9 });
    expect(document.outlines?.[1]?.dest).toEqual({ type: 'FitV', pageIndex: 1, leftMm: 12.5 });
  });

  it('Dest XYZ/Fit/FitH/FitV/FitR 字段与 Type 对应', () => {
    const root = node('Document', {}, [
      node('Bookmarks', {}, [
        node('Bookmark', { Name: 'xyz' }, [node('Dest', { Type: 'XYZ', PageID: 'a', Left: '1', Top: '2', Zoom: '2' })]),
        node('Bookmark', { Name: 'fit' }, [node('Dest', { Type: 'Fit', PageID: 'a' })]),
        node('Bookmark', { Name: 'fith' }, [node('Dest', { Type: 'FitH', PageID: 'a', Top: '3', Left: '99' })]),
        node('Bookmark', { Name: 'fitv' }, [node('Dest', { Type: 'FitV', PageID: 'a', Left: '4', Top: '99' })]),
        node('Bookmark', { Name: 'fitr' }, [node('Dest', { Type: 'FitR', PageID: 'a', Left: '1', Top: '2', Right: '3', Bottom: '4' })]),
      ]),
    ]);
    const bookmarks = decodeBookmarks(root, ['a']);
    expect(bookmarks.map((item) => item.dest)).toEqual([
      { type: 'XYZ', pageIndex: 0, leftMm: 1, topMm: 2, zoom: 2 },
      { type: 'Fit', pageIndex: 0 },
      { type: 'FitH', pageIndex: 0, topMm: 3 },
      { type: 'FitV', pageIndex: 0, leftMm: 4 },
      { type: 'FitR', pageIndex: 0, leftMm: 1, topMm: 2, rightMm: 3, bottomMm: 4 },
    ]);
  });

  it('无效 PageID/Type/坐标保留节点并 warning，未知书签引用 warning', () => {
    const warnings: Array<{ code: string }> = [];
    const root = node('Document', {}, [
      node('Pages', {}, [pageNode('1')]),
      node('Bookmarks', {}, [
        node('Bookmark', { Name: 'bad-page' }, [node('Dest', { Type: 'Fit', PageID: '9' })]),
        node('Bookmark', { Name: 'bad-type' }, [node('Dest', { Type: 'Nope', PageID: '1' })]),
        node('Bookmark', { Name: 'bad-number' }, [node('Dest', { Type: 'XYZ', PageID: '1', Left: 'x' })]),
        node('Bookmark', {}, [node('Dest', { Type: 'Fit', PageID: '1' })]),
      ]),
      node('Outlines', {}, [
        node('OutlineElem', { Title: '无效引用' }, [destAction({}, '不存在')]),
        node('OutlineElem', { Title: '未知类型' }, [destAction({ Type: 'FitRect', PageID: '1' })]),
      ]),
    ]);
    const document = decodeDocument(root, 'Doc_0/Document.xml', {
      onWarning: (warning) => warnings.push(warning),
    });
    expect(document.bookmarks?.map((item) => item.name)).toEqual(['bad-page', 'bad-type', 'bad-number']);
    expect(document.bookmarks?.every((item) => item.dest === undefined)).toBe(true);
    expect(document.outlines).toHaveLength(2);
    expect(document.outlines?.every((item) => item.dest === undefined)).toBe(true);
    expect(warnings.filter((warning) => warning.code === 'W_BOOKMARK_TARGET')).toHaveLength(4);
    expect(warnings.filter((warning) => warning.code === 'W_OUTLINE_TARGET')).toHaveLength(2);
  });

  it('1000 页只解码页树与大纲，不读取页面 Content', () => {
    const pages = Array.from({ length: 1000 }, (_, index) => pageNode(String(index + 1)));
    const root = node('Document', {}, [
      node('Pages', {}, pages),
      node('Outlines', {}, [
        node('OutlineElem', { Title: '末页' }, [destAction({ Type: 'Fit', PageID: '1000' })]),
      ]),
    ]);
    const document = decodeDocument(root, 'Doc_0/Document.xml');
    expect(document.pageCount).toBe(1000);
    expect(document.pages).toHaveLength(1000);
    expect(document.outlines?.[0]?.dest).toEqual({ type: 'Fit', pageIndex: 999 });
  });

  it('无 Outlines/Bookmarks 返回空数组；decodeOutlines 保持 XML 顺序', () => {
    const empty = decodeDocument(node('Document', {}, [node('Pages', {}, [pageNode('1')])]), 'Doc_0/Document.xml');
    expect(empty.outlines).toEqual([]);
    expect(empty.bookmarks).toEqual([]);
    const root = node('Document', {}, [
      node('Outlines', {}, [
        node('OutlineElem', { Title: 'first' }),
        node('OutlineElem', { Title: 'second' }),
      ]),
    ]);
    expect(decodeOutlines(root, ['1']).map((item) => item.title)).toEqual(['first', 'second']);
  });
});

describe('OFD.xml DocInfo 解码', () => {
  it('解析全字段、Keywords 与 CustomData；非法日期 warning 跳过', () => {
    const warnings: Array<{ code: string }> = [];
    const root = node('OFD', { Version: '1.2' }, [
      node('DocBody', {}, [
        node('DocInfo', {}, [
          leaf('DocID', 'doc-1'),
          leaf('Title', '标题'),
          leaf('Author', '作者'),
          leaf('Subject', '主题'),
          leaf('Abstract', '摘要'),
          leaf('CreationDate', '2020-04-25'),
          leaf('ModDate', '2020-13-01'),
          leaf('Creator', '生成器'),
          leaf('CreatorVersion', '1.2.3'),
          leaf('Keywords', 'alpha beta,gamma'),
          node('CustomDatas', {}, [
            node('CustomData', { Name: 'k' }, [], 'v'),
            node('CustomData', {}, [], '无名称'),
          ]),
        ]),
        leaf('DocRoot', '/Doc_0/'),
      ]),
      node('DocBody', {}, [
        node('DocInfo', {}, [leaf('Title', '第二文档')]),
        leaf('DocRoot', 'Doc_1'),
      ]),
      node('DocBody', {}, [leaf('DocRoot', 'Doc_2')]),
    ]);
    const info = decodeOfdRoot(root, { onWarning: (warning) => warnings.push(warning) });
    expect(info.version).toBe('1.2');
    expect(info.docRoots).toEqual(['Doc_0', 'Doc_1', 'Doc_2']);
    expect(info.docInfos).toHaveLength(3);
    expect(info.docInfos[0]).toEqual({
      docId: 'doc-1',
      title: '标题',
      author: '作者',
      subject: '主题',
      abstract: '摘要',
      creationDate: '2020-04-25',
      creator: '生成器',
      creatorVersion: '1.2.3',
      keywords: ['alpha', 'beta', 'gamma'],
      customData: { k: 'v' },
    });
    expect(info.docInfos[1]?.title).toBe('第二文档');
    expect(info.docInfos[2]).toBeUndefined();
    expect(warnings.filter((warning) => warning.code === 'W_METADATA_FIELD')).toHaveLength(2);
  });

  it('无 DocInfo 或无 DocRoot 时保持数组对齐，不抛错', () => {
    const root = node('OFD', {}, [node('DocBody', {}, [leaf('DocRoot', 'Doc_0')])]);
    const info = decodeOfdRoot(root);
    expect(info.docInfos).toEqual([undefined]);
    expect(decodeOfdRoot(node('OFD', {}, [])).docInfos).toEqual([]);
  });
});
