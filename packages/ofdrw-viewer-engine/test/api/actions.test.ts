import { describe, expect, it } from 'vitest';
import type { ActionInfo } from '../../src/index';
import type { OFDWarning } from '../../src/warnings';
import { OFD_NS, buildFixtureOfd, openTestDocument } from './helpers';
import type { FixturePage } from './helpers';

/** 第 1 页：图像图元带 CLICK/Movie；路径图元（无 ID）带 CLICK/Sound；页面带 PO 动作。 */
function actionPage(): FixturePage {
  return {
    id: 1,
    widthMm: 100,
    heightMm: 100,
    objects: [
      {
        name: 'ofd:ImageObject',
        attrs: { ID: '30', Boundary: '0 0 10 10', ResourceID: '11', CTM: '10 0 0 10 0 0' },
        children: [
          { name: 'ofd:Border', attrs: { LineWidth: '1' } },
          {
            name: 'ofd:Actions',
            children: [
              {
                name: 'ofd:Action',
                attrs: { Event: 'CLICK' },
                children: [{ name: 'ofd:Movie', attrs: { ResourceID: '10' } }],
              },
            ],
          },
        ],
      },
      {
        name: 'ofd:PathObject',
        attrs: { Boundary: '20 20 10 10', Fill: 'true', Stroke: 'false' },
        children: [
          { name: 'ofd:AbbreviatedData', children: ['M 0 0 L 10 0 L 10 10 C'] },
          {
            name: 'ofd:Actions',
            children: [
              {
                name: 'ofd:Action',
                attrs: { Event: 'CLICK' },
                children: [{ name: 'ofd:Sound', attrs: { ResourceID: '12', Volume: '50' } }],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** 构造含四类宿主动作的文档。 */
function actionOfd(options: { pageActions?: boolean; documentActions?: boolean; outlineActions?: boolean } = {}): Uint8Array {
  const page = actionPage();
  return buildFixtureOfd({
    pages: [page],
    publicRes: [
      {
        path: 'Doc_0/PublicRes.xml',
        children: [
          {
            name: 'ofd:MultiMedias',
            children: [
              {
                name: 'ofd:MultiMedia',
                attrs: { ID: 10, Type: 'Video', Format: 'MP4' },
                children: [{ name: 'ofd:MediaFile', children: ['video.mp4'] }],
              },
              {
                name: 'ofd:MultiMedia',
                attrs: { ID: 11, Type: 'Image', Format: 'PNG' },
                children: [{ name: 'ofd:MediaFile', children: ['frame.png'] }],
              },
              {
                name: 'ofd:MultiMedia',
                attrs: { ID: 12, Type: 'Audio', Format: 'MP3' },
                children: [{ name: 'ofd:MediaFile', children: ['audio.mp3'] }],
              },
            ],
          },
        ],
      },
    ],
    extraEntries: [
      { name: 'Doc_0/video.mp4', data: new Uint8Array([1]) },
      { name: 'Doc_0/frame.png', data: new Uint8Array([2]) },
      { name: 'Doc_0/audio.mp3', data: new Uint8Array([3]) },
    ],
    documentChildren: [
      ...(options.pageActions === false
        ? []
        : []),
      ...(options.outlineActions
        ? [
            {
              name: 'ofd:Outlines',
              children: [
                {
                  name: 'ofd:OutlineElem',
                  attrs: { Title: '第一章' },
                  children: [
                    {
                      name: 'ofd:Actions',
                      children: [
                        {
                          name: 'ofd:Action',
                          attrs: { Event: 'CLICK' },
                          children: [{ name: 'ofd:URI', attrs: { URI: 'https://example.com' } }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ]
        : []),
      ...(options.documentActions
        ? [
            {
              name: 'ofd:Actions',
              children: [
                {
                  name: 'ofd:Action',
                  attrs: { Event: 'DO' },
                  children: [{ name: 'ofd:Movie', attrs: { ResourceID: '10', Operator: 'Play' } }],
                },
              ],
            },
          ]
        : []),
    ],
  });
}

/** 关闭文档并断言无异常。 */
async function closeQuietly(doc: { close(): Promise<void> }): Promise<void> {
  await doc.close();
}

describe('动作查询', () => {
  it('文档级动作在 open 阶段同步可得', async () => {
    const doc = await openTestDocument(actionOfd({ documentActions: true }));
    try {
      const actions = doc.getDocumentActions();
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        event: 'DO',
        type: 'movie',
        owner: { kind: 'document' },
        payload: { type: 'movie', resourceId: '10', operator: 'Play' },
      });
    } finally {
      await closeQuietly(doc);
    }
  });

  it('无动作时各查询返回空数组', async () => {
    const doc = await openTestDocument(
      buildFixtureOfd({ pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [] }] }),
    );
    try {
      expect(doc.getDocumentActions()).toEqual([]);
      expect(await doc.getPageActions(0)).toEqual([]);
      expect(await doc.getObjectActions(0, { objectId: '1' })).toEqual([]);
      expect(await doc.getObjectActions(0, { path: [0] })).toEqual([]);
      expect(await doc.getOutlineActions([0])).toEqual([]);
      expect(await doc.getPageActionsByEvent(0, 'CLICK')).toEqual([]);
    } finally {
      await closeQuietly(doc);
    }
  });

  it('图元动作按 objectId 与页内路径定位', async () => {
    const doc = await openTestDocument(actionOfd());
    try {
      const byId = await doc.getObjectActions(0, { objectId: '30' });
      expect(byId).toHaveLength(1);
      expect(byId[0]).toMatchObject({
        event: 'CLICK',
        type: 'movie',
        owner: { kind: 'object', pageIndex: 0, objectId: '30' },
        payload: { resourceId: '10' },
      });
      // 无 ID 图元按页内路径（Content → Layer → 图元 逐级下标）定位。
      const byPath = await doc.getObjectActions(0, { path: [0, 1] });
      expect(byPath).toHaveLength(1);
      expect(byPath[0]).toMatchObject({ type: 'sound', payload: { resourceId: '12', volume: 50 } });
      expect(await doc.getObjectActions(0, { path: [0, 0] })).toEqual([]);
    } finally {
      await closeQuietly(doc);
    }
  });

  it('getPageActionsByEvent 聚合页级与图元动作', async () => {
    const doc = await openTestDocument(actionOfd());
    try {
      const clicks = await doc.getPageActionsByEvent(0, 'CLICK');
      expect(clicks.map((action: ActionInfo) => action.type).sort()).toEqual(['movie', 'sound']);
      expect(await doc.getPageActionsByEvent(0, 'PO')).toEqual([]);
    } finally {
      await closeQuietly(doc);
    }
  });

  it('大纲动作可从 getOutlineActions 读取，且 getOutline 快照不回归', async () => {
    const doc = await openTestDocument(actionOfd({ outlineActions: true }));
    try {
      const outline = await doc.getOutline();
      expect(outline).toHaveLength(1);
      expect(outline[0]?.title).toBe('第一章');
      expect(outline[0]?.dest).toBeUndefined();
      const actions = await doc.getOutlineActions([0]);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        type: 'uri',
        owner: { kind: 'outline', path: [0] },
        payload: { type: 'uri', uri: 'https://example.com' },
      });
      expect(await doc.getOutlineActions([1])).toEqual([]);
      expect(await doc.getOutlineActions([0, 0])).toEqual([]);
    } finally {
      await closeQuietly(doc);
    }
  });

  it('动作查询的页索引越界抛 OFD_PAGE_NOT_FOUND，关闭后抛 OFD_CLOSED', async () => {
    const doc = await openTestDocument(actionOfd());
    const codes: string[] = [];
    for (const run of [
      () => doc.getPageActions(9),
      () => doc.getObjectActions(9, { objectId: '30' }),
      () => doc.getPageActionsByEvent(9, 'CLICK'),
    ]) {
      const error = await run().catch((caught: unknown) => caught);
      codes.push((error as { code?: string }).code ?? 'none');
    }
    expect(codes).toEqual(['OFD_PAGE_NOT_FOUND', 'OFD_PAGE_NOT_FOUND', 'OFD_PAGE_NOT_FOUND']);
    await closeQuietly(doc);
    const closed = await doc.getPageActions(0).catch((caught: unknown) => caught);
    expect((closed as { code?: string }).code).toBe('OFD_CLOSED');
  });

  it('非法动作降级为 warning，不影响文档打开与渲染数据', async () => {
    const warnings: OFDWarning[] = [];
    const bytes = buildFixtureOfd({
      pages: [
        {
          id: 1,
          widthMm: 100,
          heightMm: 100,
          objects: [
            {
              name: 'ofd:PathObject',
              attrs: { ID: '50', Boundary: '0 0 10 10', Fill: 'true', Stroke: 'false' },
              children: [
                { name: 'ofd:AbbreviatedData', children: ['M 0 0 L 10 0 L 10 10 C'] },
                {
                  name: 'ofd:Actions',
                  children: [
                    { name: 'ofd:Action', attrs: {}, children: [{ name: 'ofd:Sound', attrs: { ResourceID: '1' } }] },
                    {
                      name: 'ofd:Action',
                      attrs: { Event: 'CLICK' },
                      children: [
                        { name: 'ofd:Movie', attrs: { ResourceID: '999' } },
                        { name: 'ofd:Sound', attrs: { ResourceID: '1' } },
                      ],
                    },
                    { name: 'ofd:Action', attrs: { Event: 'CLICK' }, children: [{ name: 'ofd:Sound', attrs: {} }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
      documentChildren: [
        {
          name: 'ofd:Outlines',
          children: [
            {
              name: 'ofd:OutlineElem',
              attrs: { Title: 'bad' },
              children: [
                {
                  name: 'ofd:Actions',
                  children: [
                    {
                      name: 'ofd:Action',
                      attrs: { Event: 'CLICK' },
                      children: [{ name: 'ofd:Goto', attrs: {} , children: [{ name: 'ofd:Dest', attrs: { Type: 'XYZ', PageID: '99' } }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const doc = await openTestDocument(bytes, { onWarning: (warning) => warnings.push(warning) });
    try {
      const objectActions = await doc.getObjectActions(0, { objectId: '50' });
      // 缺 Event 与缺 ResourceID 的两条被跳过，多动作体取第一个。
      expect(objectActions).toHaveLength(1);
      expect(objectActions[0]?.payload).toMatchObject({ type: 'movie', resourceId: '999' });
      const codes = new Set(warnings.map((warning) => warning.code));
      expect(codes.has('W_ACTION_INVALID')).toBe(true);
      expect(codes.has('W_ACTION_MULTIPLE_BODY')).toBe(true);
      expect(codes.has('W_ACTION_RESOURCE_MISSING')).toBe(true);
      // 大纲 Goto 的 Dest 无效：动作保留但不含 dest。
      const outlineActions = await doc.getOutlineActions([0]);
      expect(outlineActions[0]?.payload).toEqual({ type: 'goto' });
      expect(codes.has('W_ACTION_TARGET')).toBe(true);
      // 页面仍可正常取页。
      const page = await doc.getPage(0);
      expect(page.index).toBe(0);
    } finally {
      await closeQuietly(doc);
    }
  });

  it('页级 PO 动作与页级资源作用域', async () => {
    const bytes = buildFixtureOfd({
      pages: [
        {
          id: 1,
          widthMm: 100,
          heightMm: 100,
          objects: [],
          pageRes: ['Res.xml'],
        },
      ],
      extraEntries: [
        {
          name: 'Doc_0/Pages/Page_1/Res.xml',
          data: Buffer.from(
            `<?xml version="1.0" encoding="UTF-8"?><ofd:Res xmlns:ofd="${OFD_NS}">` +
              '<ofd:MultiMedias><ofd:MultiMedia ID="5" Type="Audio" Format="WAV">' +
              '<ofd:MediaFile>page.wav</ofd:MediaFile></ofd:MultiMedia></ofd:MultiMedias></ofd:Res>',
          ),
        },
        { name: 'Doc_0/Pages/Page_1/Doc_0/Pages/Page_1/page.wav', data: new Uint8Array([9]) },
        { name: 'Doc_0/Pages/Page_1/page.wav', data: new Uint8Array([9]) },
      ],
    });
    const doc = await openTestDocument(bytes);
    try {
      expect(await doc.getMediaResource('5', { pageIndex: 0 })).toBeDefined();
      expect(await doc.hasImageResource('5', { pageIndex: 0 })).toBe(false);
    } finally {
      await closeQuietly(doc);
    }
  });
});

describe('hasImageResource', () => {
  it('图片 ID → true；音视频与不存在的 ID → false', async () => {
    const doc = await openTestDocument(actionOfd());
    try {
      expect(await doc.hasImageResource('11')).toBe(true);
      expect(await doc.hasImageResource('10')).toBe(false);
      expect(await doc.hasImageResource('12')).toBe(false);
      expect(await doc.hasImageResource('999')).toBe(false);
      expect(await doc.hasImageResource('')).toBe(false);
    } finally {
      await closeQuietly(doc);
    }
  });

  it('页级图片资源需 pageIndex 才可见', async () => {
    const bytes = buildFixtureOfd({
      pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [], pageRes: ['Res.xml'] }],
      extraEntries: [
        {
          name: 'Doc_0/Pages/Page_1/Res.xml',
          data: Buffer.from(
            `<?xml version="1.0" encoding="UTF-8"?><ofd:Res xmlns:ofd="${OFD_NS}">` +
              '<ofd:MultiMedias><ofd:MultiMedia ID="7" Type="Image" Format="PNG">' +
              '<ofd:MediaFile>cover.png</ofd:MediaFile></ofd:MultiMedia></ofd:MultiMedias></ofd:Res>',
          ),
        },
        { name: 'Doc_0/Pages/Page_1/cover.png', data: new Uint8Array([1]) },
      ],
    });
    const doc = await openTestDocument(bytes);
    try {
      expect(await doc.hasImageResource('7', { pageIndex: 0 })).toBe(true);
      expect(await doc.hasImageResource('7')).toBe(false);
    } finally {
      await closeQuietly(doc);
    }
  });
});