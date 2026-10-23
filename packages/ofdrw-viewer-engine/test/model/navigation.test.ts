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

  it('4 级嵌套保持层级/顺序/Expanded/Dest 与 Bookmark 引用', () => {
    const root = node('Document', {}, [
      node('Pages', {}, [pageNode('1'), pageNode('2'), pageNode('3')]),
      node('Bookmarks', {}, [
        node('Bookmark', { Name: '深层书签' }, [
          node('Dest', { Type: 'Fit', PageID: '3' }),
        ]),
      ]),
      node('Outlines', {}, [
        node('OutlineElem', { Title: '卷一', Expanded: 'true' }, [
          destAction({ Type: 'XYZ', PageID: '1', Left: '5' }),
          node('OutlineElem', { Title: '第一章', Expanded: 'false' }, [
            node('OutlineElem', { Title: '1.1', Expanded: 'true' }, [
              node('OutlineElem', { Title: '1.1.1' }, [destAction({}, '深层书签')]),
              node('OutlineElem', { Title: '1.1.2' }, [
                destAction({ Type: 'FitR', PageID: '3' }),
              ]),
            ]),
            node('OutlineElem', { Title: '1.2' }, [
              destAction({ Type: 'FitH', PageID: '2', Top: '7.5' }),
            ]),
          ]),
        ]),
        node('OutlineElem', { Title: '卷二', Expanded: '0' }, [
          node('OutlineElem', { Title: '第二章' }, [destAction({ Type: 'Fit', PageID: '2' })]),
        ]),
      ]),
    ]);
    const [volume1, volume2] = decodeDocument(root, 'Doc_0/Document.xml').outlines ?? [];
    expect(volume1?.title).toBe('卷一');
    expect(volume1?.expanded).toBe(true);
    expect(volume1?.dest).toEqual({ type: 'XYZ', pageIndex: 0, leftMm: 5 });
    expect(volume1?.children.map((item) => item.title)).toEqual(['第一章']);
    const chapter1 = volume1?.children[0];
    expect(chapter1?.expanded).toBe(false);
    expect(chapter1?.children.map((item) => item.title)).toEqual(['1.1', '1.2']);
    const section11 = chapter1?.children[0];
    expect(section11?.expanded).toBe(true);
    expect(section11?.children.map((item) => item.title)).toEqual(['1.1.1', '1.1.2']);
    expect(section11?.children[0]?.expanded).toBeUndefined();
    expect(section11?.children[0]?.dest).toEqual({ type: 'Fit', pageIndex: 2 });
    expect(section11?.children[1]?.children).toEqual([]);
    expect(section11?.children[1]?.dest).toEqual({ type: 'FitR', pageIndex: 2 });
    expect(chapter1?.children[1]?.dest).toEqual({ type: 'FitH', pageIndex: 1, topMm: 7.5 });
    expect(volume2?.expanded).toBe(false);
    expect(volume2?.children[0]?.dest).toEqual({ type: 'Fit', pageIndex: 1 });
  });

  it('超过 64 层时截断更深子节点并 warning，保留前 65 层', () => {
    // 构造 70 层（L0…L69）大纲，自底向上包装。
    let nested: ReturnType<typeof node> = node('OutlineElem', { Title: 'L69' });
    for (let depth = 68; depth >= 0; depth -= 1) {
      nested = node('OutlineElem', { Title: `L${depth}` }, [nested]);
    }
    const warnings: Array<{ code: string; message: string }> = [];
    const outlines = decodeOutlines(
      node('Document', {}, [node('Outlines', {}, [nested])]),
      [],
      { onWarning: (warning) => warnings.push(warning) },
    );
    const titles: string[] = [];
    let current = outlines[0];
    while (current) {
      titles.push(current.title);
      current = current.children[0];
    }
    // depth 0…64 共 65 个节点保留；depth 65 起被截断。
    expect(titles).toHaveLength(65);
    expect(titles.at(-1)).toBe('L64');
    const truncations = warnings.filter(
      (warning) => warning.code === 'W_OUTLINE_TARGET' && warning.message.includes('64'),
    );
    expect(truncations).toHaveLength(1);

    // 恰好 64 层（L0…L63）不触发截断。
    let exactly64: ReturnType<typeof node> = node('OutlineElem', { Title: 'L63' });
    for (let depth = 62; depth >= 0; depth -= 1) {
      exactly64 = node('OutlineElem', { Title: `L${depth}` }, [exactly64]);
    }
    const exactWarnings: Array<{ code: string }> = [];
    const exact = decodeOutlines(
      node('Document', {}, [node('Outlines', {}, [exactly64])]),
      [],
      { onWarning: (warning) => exactWarnings.push(warning) },
    );
    let exactDepth = 0;
    let exactCurrent = exact[0];
    while (exactCurrent?.children[0]) {
      exactDepth += 1;
      exactCurrent = exactCurrent.children[0];
    }
    expect(exactDepth).toBe(63);
    expect(exactCurrent?.title).toBe('L63');
    expect(exactWarnings.filter((warning) => warning.code === 'W_OUTLINE_TARGET')).toHaveLength(0);
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
