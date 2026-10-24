import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { isOFDError } from '../../src/errors';
import type { OFDWarning } from '../../src/warnings';
import { ZipReader } from '../../src/container/zip-reader';
import { buildXmlDocument } from '../fixtures/xml';
import type { XmlElementSpec } from '../fixtures/xml';
import type { OutlineNode } from '../../src/api/ui-types';
import { OFD_NS, buildFixtureOfd, openTestDocument } from './helpers';

/** 读取仓库根下的真实样例。 */
function sample(name: string): Uint8Array {
  const path = fileURLToPath(new URL(`../../../../ofd_pdf_match/${name}`, import.meta.url));
  return new Uint8Array(readFileSync(path));
}

/** 读取错误码。 */
function errorCode(error: unknown): string | undefined {
  return isOFDError(error) ? error.code : undefined;
}

/** 构造两份文档的 OFD.xml；DocRoot 与 DocInfo 一一对应。 */
function multiDocumentOfdXml(): string {
  return buildXmlDocument({
    name: 'ofd:OFD',
    attrs: { 'xmlns:ofd': OFD_NS, DocType: 'ofd', Version: '1.3' },
    children: [
      {
        name: 'ofd:DocBody',
        children: [
          {
            name: 'ofd:DocInfo',
            children: [
              { name: 'ofd:DocID', children: ['first-id'] },
              { name: 'ofd:Title', children: ['第一份'] },
            ],
          },
          { name: 'ofd:DocRoot', children: ['Doc_0/Document.xml'] },
        ],
      },
      {
        name: 'ofd:DocBody',
        children: [
          {
            name: 'ofd:DocInfo',
            children: [
              { name: 'ofd:DocID', children: ['second-id'] },
              { name: 'ofd:Title', children: ['第二份'] },
            ],
          },
          { name: 'ofd:DocRoot', children: ['Doc_1/Document.xml'] },
        ],
      },
    ],
  });
}

/** 构造第二个文档的 Document.xml（仅页树，无资源）。 */
function secondDocumentXml(): string {
  return buildXmlDocument({
    name: 'ofd:Document',
    attrs: { 'xmlns:ofd': OFD_NS, Version: '1.3' },
    children: [
      {
        name: 'ofd:Pages',
        children: [
          { name: 'ofd:Page', attrs: { ID: 2, BaseLoc: 'Pages/Page_0/Content.xml' } },
        ],
      },
    ],
  });
}

/** 构造 ofd:Actions/ofd:Action/ofd:Goto 动作，目标为 Dest 或书签引用。 */
function ofdGoto(options: { type?: string; pageId?: number; bookmark?: string }): XmlElementSpec {
  const target: XmlElementSpec = options.bookmark
    ? { name: 'ofd:Bookmark', children: [options.bookmark] }
    : {
        name: 'ofd:Dest',
        attrs: { Type: options.type ?? 'Fit', PageID: options.pageId ?? 1 },
      };
  return {
    name: 'ofd:Actions',
    children: [
      {
        name: 'ofd:Action',
        attrs: { Event: 'CLICK' },
        children: [{ name: 'ofd:Goto', children: [target] }],
      },
    ],
  };
}

/** 计算大纲树的最大层级数（空数组为 0）。 */
function outlineDepth(nodes: readonly OutlineNode[]): number {
  return nodes.reduce(
    (max, node) => Math.max(max, 1 + outlineDepth(node.children)),
    0,
  );
}

describe('UI API：大纲/书签/文档属性', () => {
  it('z.ofd getOutline 保持 XML 顺序并映射 XYZ；getBookmarks 为空', async () => {
    const doc = await openTestDocument(sample('z.ofd'));
    try {
      const outline = await doc.getOutline();
      expect(outline).toHaveLength(5);
      expect(outline[0]?.title).toBe('11.4字型变换');
      expect(outline[0]?.expanded).toBe(true);
      expect(outline[0]?.dest).toEqual({
        type: 'XYZ',
        pageIndex: 0,
        leftMm: 80.43,
        topMm: 26.07,
        zoom: 1,
      });
      expect(outline[4]?.dest?.pageIndex).toBe(3);
      expect(await doc.getBookmarks()).toEqual([]);
    } finally {
      await doc.close();
    }
  });

  it('getOutline 保留 4 级大纲层级/顺序、Expanded 与 Dest/Bookmark', async () => {
    const bytes = buildFixtureOfd({
      pages: [1, 2, 3, 4].map((id) => ({ id, widthMm: 100, heightMm: 100, objects: [] })),
      documentChildren: [
        {
          name: 'ofd:Bookmarks',
          children: [
            {
              name: 'ofd:Bookmark',
              attrs: { Name: '末页书签' },
              children: [{ name: 'ofd:Dest', attrs: { Type: 'Fit', PageID: 4 } }],
            },
          ],
        },
        {
          name: 'ofd:Outlines',
          children: [
            {
              name: 'ofd:OutlineElem',
              attrs: { Title: '卷一', Expanded: 'true' },
              children: [
                ofdGoto({ type: 'XYZ', pageId: 1 }),
                {
                  name: 'ofd:OutlineElem',
                  attrs: { Title: '第一章', Expanded: 'false' },
                  children: [
                    {
                      name: 'ofd:OutlineElem',
                      attrs: { Title: '1.1' },
                      children: [
                        ofdGoto({ bookmark: '末页书签' }),
                        {
                          name: 'ofd:OutlineElem',
                          attrs: { Title: '1.1.1' },
                          children: [ofdGoto({ type: 'FitH', pageId: 2 })],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              name: 'ofd:OutlineElem',
              attrs: { Title: '卷二' },
              children: [ofdGoto({ type: 'Fit', pageId: 3 })],
            },
          ],
        },
      ],
    });
    const doc = await openTestDocument(bytes);
    try {
      const outline = await doc.getOutline();
      expect(outline.map((node) => node.title)).toEqual(['卷一', '卷二']);
      expect(outlineDepth(outline)).toBe(4);
      expect(outline[0]?.expanded).toBe(true);
      expect(outline[1]?.expanded).toBeUndefined();
      expect(outline[0]?.dest).toEqual({ type: 'XYZ', pageIndex: 0 });
      expect(outline[0]?.children.map((node) => node.title)).toEqual(['第一章']);
      const chapter = outline[0]?.children[0];
      expect(chapter?.expanded).toBe(false);
      const section = chapter?.children[0];
      expect(section?.title).toBe('1.1');
      expect(section?.dest).toEqual({ type: 'Fit', pageIndex: 3 });
      expect(section?.children.map((node) => node.title)).toEqual(['1.1.1']);
      expect(section?.children[0]?.children).toEqual([]);
      expect(section?.children[0]?.dest).toEqual({ type: 'FitH', pageIndex: 1 });
      expect(outline[1]?.dest).toEqual({ type: 'Fit', pageIndex: 2 });
    } finally {
      await doc.close();
    }
  });

  it('Page5.ofd getBookmarks 保留书签与 XYZ 坐标', async () => {
    const doc = await openTestDocument(sample('Page5.ofd'));
    try {
      const bookmarks = await doc.getBookmarks();
      expect(bookmarks).toEqual([
        {
          name: '新建书签',
          dest: {
            type: 'XYZ',
            pageIndex: 0,
            rightMm: 167.873,
            bottomMm: 131.0356,
          },
        },
      ]);
      expect(await doc.getOutline()).toEqual([]);
    } finally {
      await doc.close();
    }
  });

  it('getMetadata 返回 OFD 版本/页数/DocInfo 字段', async () => {
    const bytes = sample('h.ofd');
    const doc = await openTestDocument(bytes);
    try {
      expect(await doc.getMetadata()).toEqual({
        version: '1.0',
        pageCount: 5,
        packageSize: bytes.byteLength,
        docId: '5e07a151ff9847bea6b5e12b9d7c6e9a',
        creationDate: '2020-04-25',
        creator: 'OFD R&W',
        creatorVersion: '1.2.0',
        docType: 'OFD',
        documentHeader: {
          maxUnitId: 88,
          pageArea: {
            physicalBox: { x: 0, y: 0, w: 210, h: 297 },
            applicationBox: { x: 0, y: 0, w: 210, h: 297 },
          },
        },
        packageInfo: { docRoot: 'Doc_0/Document.xml', docBodyCount: 1 },
        commonData: {
          pageArea: {
            physicalBox: { x: 0, y: 0, w: 210, h: 297 },
            applicationBox: { x: 0, y: 0, w: 210, h: 297 },
          },
        },
      });
    } finally {
      await doc.close();
    }
  });

  it('getMetadata 解析 Author/ModDate/Keywords/CustomData；空 Keywords 省略', async () => {
    const doc = await openTestDocument(sample('n.ofd'));
    try {
      const metadata = await doc.getMetadata();
      expect(metadata.version).toBe('1.0');
      expect(metadata.pageCount).toBe(2);
      expect(metadata.author).toBe('iOFD® 2.1.1 ©2019-2020 dms360.cn');
      expect(metadata.creationDate).toBe('2020-01-25');
      expect(metadata.modDate).toBe('2020-01-25');
      expect(metadata.keywords).toBeUndefined();
      expect(metadata.docId).toBe('1f43817abaec4df79066eb046bc526bf');
      expect(metadata.customData).toMatchObject({
        'user.name': 'vita',
        'os.name': 'Windows 7',
      });
    } finally {
      await doc.close();
    }
  });

  it('多文档包按 documentIndex 取对应 DocInfo 与页数', async () => {
    const bytes = buildFixtureOfd({
      pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [] }],
      ofdXml: multiDocumentOfdXml(),
      extraEntries: [
        { name: 'Doc_1/Document.xml', data: secondDocumentXml() },
      ],
    });
    const first = await openTestDocument(bytes, { documentIndex: 0 });
    try {
      const metadata = await first.getMetadata();
      expect(metadata.title).toBe('第一份');
      expect(metadata.docId).toBe('first-id');
      expect(metadata.pageCount).toBe(1);
      expect(metadata.version).toBe('1.3');
    } finally {
      await first.close();
    }
    const second = await openTestDocument(bytes, { documentIndex: 1 });
    try {
      const metadata = await second.getMetadata();
      expect(metadata.title).toBe('第二份');
      expect(metadata.docId).toBe('second-id');
      expect(metadata.pageCount).toBe(1);
    } finally {
      await second.close();
    }
  });

  it('无 DocInfo 时 getMetadata 仍返回版本与页数；非法日期 warning 后省略', async () => {
    const noInfoXml = buildXmlDocument({
      name: 'ofd:OFD',
      attrs: { 'xmlns:ofd': OFD_NS, DocType: 'ofd', Version: '1.4' },
      children: [
        { name: 'ofd:DocBody', children: [{ name: 'ofd:DocRoot', children: ['Doc_0/Document.xml'] }] },
      ],
    });
    const noInfo = await openTestDocument(
      buildFixtureOfd({
        pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [] }],
        ofdXml: noInfoXml,
      }),
    );
    try {
      const metadata = await noInfo.getMetadata();
      expect(metadata).toMatchObject({ version: '1.4', pageCount: 1 });
      expect(metadata.title).toBeUndefined();
      expect(metadata.docId).toBeUndefined();
    } finally {
      await noInfo.close();
    }

    const badDateXml = buildXmlDocument({
      name: 'ofd:OFD',
      attrs: { 'xmlns:ofd': OFD_NS, DocType: 'ofd', Version: '1.4' },
      children: [
        {
          name: 'ofd:DocBody',
          children: [
            {
              name: 'ofd:DocInfo',
              children: [
                { name: 'ofd:Title', children: ['保留'] },
                { name: 'ofd:CreationDate', children: ['not-a-date'] },
              ],
            },
            { name: 'ofd:DocRoot', children: ['Doc_0/Document.xml'] },
          ],
        },
      ],
    });
    const warnings: OFDWarning[] = [];
    const badDate = await openTestDocument(
      buildFixtureOfd({
        pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [] }],
        ofdXml: badDateXml,
      }),
      { onWarning: (warning) => warnings.push(warning) },
    );
    try {
      const metadata = await badDate.getMetadata();
      expect(metadata.title).toBe('保留');
      expect(metadata.creationDate).toBeUndefined();
      expect(warnings.some((warning) => warning.code === 'W_METADATA_FIELD')).toBe(true);
    } finally {
      await badDate.close();
    }
  });

  it('三个方法缓存于 document，不额外读取页面 XML', async () => {
    const doc = await openTestDocument(sample('z.ofd'));
    const readEntry = vi.spyOn(ZipReader.prototype, 'readEntry');
    try {
      readEntry.mockClear();
      await doc.getOutline();
      await doc.getBookmarks();
      await doc.getMetadata();
      expect(readEntry).not.toHaveBeenCalled();
    } finally {
      readEntry.mockRestore();
      await doc.close();
    }
  });

  it('getMetadata 暴露 docUsage/docType/documentHeader/packageInfo/commonData', async () => {
    const ofdXml = buildXmlDocument({
      name: 'ofd:OFD',
      attrs: { 'xmlns:ofd': OFD_NS, DocType: 'OFD', Version: '1.1' },
      children: [
        {
          name: 'ofd:DocBody',
          attrs: { MaxUnitID: '512' },
          children: [
            {
              name: 'ofd:DocInfo',
              children: [
                { name: 'ofd:DocID', children: ['meta-id'] },
                { name: 'ofd:DocUsage', children: ['Normal'] },
              ],
            },
            { name: 'ofd:DocRoot', children: ['Doc_0/Document.xml'] },
          ],
        },
      ],
    });
    const doc = await openTestDocument(
      buildFixtureOfd({
        pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [] }],
        commonPageArea: { widthMm: 210, heightMm: 297 },
        ofdXml,
      }),
    );
    try {
      const metadata = await doc.getMetadata();
      expect(metadata.docUsage).toBe('Normal');
      expect(metadata.docType).toBe('OFD');
      expect(metadata.packageInfo).toEqual({
        docRoot: 'Doc_0/Document.xml',
        maxUnitId: 512,
        docBodyCount: 1,
      });
      expect(metadata.documentHeader).toEqual({
        version: '1.1',
        pageArea: { physicalBox: { x: 0, y: 0, w: 210, h: 297 } },
      });
      expect(metadata.commonData).toEqual({
        pageArea: { physicalBox: { x: 0, y: 0, w: 210, h: 297 } },
        documentVersion: '1.1',
      });
    } finally {
      await doc.close();
    }
  });

  it('packageInfo 按选中文档下标取 MaxUnitID，缺失时省略；commonData.dataDir 取首个文档资源目录', async () => {
    const ofdXml = buildXmlDocument({
      name: 'ofd:OFD',
      attrs: { 'xmlns:ofd': OFD_NS, Version: '1.0' },
      children: [
        {
          name: 'ofd:DocBody',
          children: [
            { name: 'ofd:DocRoot', children: ['Doc_0/Document.xml'] },
          ],
        },
      ],
    });
    const doc = await openTestDocument(
      buildFixtureOfd({
        pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [] }],
        documentRes: [{ path: 'Doc_0/Res/DocumentRes.xml', children: [] }],
        ofdXml,
      }),
    );
    try {
      const metadata = await doc.getMetadata();
      // DocBody 未声明 MaxUnitID：maxUnitId 键不存在，其余字段保留。
      expect(metadata.packageInfo).toEqual({
        docRoot: 'Doc_0/Document.xml',
        docBodyCount: 1,
      });
      expect(metadata.packageInfo).not.toHaveProperty('maxUnitId');
      // 头部资源路径按包根相对解析：Doc_0/Res/DocumentRes.xml → 目录 Res。
      expect(metadata.commonData?.dataDir).toBe('Res');
      // 未声明 DocType 时省略。
      expect(metadata).not.toHaveProperty('docType');
    } finally {
      await doc.close();
    }
  });

  it('新元数据字段全部缺失时不出现对应键（省略而非 undefined）', async () => {
    const ofdXml = buildXmlDocument({
      name: 'ofd:OFD',
      attrs: { 'xmlns:ofd': OFD_NS, Version: '1.0' },
      children: [
        { name: 'ofd:DocBody', children: [{ name: 'ofd:DocRoot', children: ['Doc_0/Document.xml'] }] },
      ],
    });
    const doc = await openTestDocument(
      buildFixtureOfd({ pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [] }], ofdXml }),
    );
    try {
      const metadata = await doc.getMetadata();
      expect(metadata).not.toHaveProperty('docUsage');
      expect(metadata).not.toHaveProperty('docType');
      // 夹具的 Document.xml 固定带 Version="1.1"，因此 documentHeader 只含 version。
      expect(metadata.documentHeader).toEqual({ version: '1.1' });
      expect(metadata).not.toHaveProperty('commonData');
      // packageInfo 始终存在（docRoot/docBodyCount 为必填）。
      expect(metadata.packageInfo?.docRoot).toBe('Doc_0/Document.xml');
    } finally {
      await doc.close();
    }
  });

  it('abort 拒绝 OFD_ABORTED，close 后拒绝 OFD_CLOSED', async () => {
    const doc = await openTestDocument(sample('h.ofd'));
    const controller = new AbortController();
    controller.abort();
    const aborted = await Promise.allSettled([
      doc.getOutline({ signal: controller.signal }),
      doc.getBookmarks({ signal: controller.signal }),
      doc.getMetadata({ signal: controller.signal }),
    ]);
    expect(aborted.map((item) => (item.status === 'rejected' ? errorCode(item.reason) : undefined))).toEqual([
      'OFD_ABORTED',
      'OFD_ABORTED',
      'OFD_ABORTED',
    ]);
    await doc.close();
    for (const promise of [doc.getOutline(), doc.getBookmarks(), doc.getMetadata()]) {
      const result = await Promise.allSettled([promise]);
      expect(result[0]?.status).toBe('rejected');
      if (result[0]?.status === 'rejected') expect(errorCode(result[0].reason)).toBe('OFD_CLOSED');
    }
  });
});
