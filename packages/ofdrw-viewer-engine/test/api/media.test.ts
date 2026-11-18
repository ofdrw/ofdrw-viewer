import { describe, expect, it } from 'vitest';
import type { OFDWarning } from '../../src/warnings';
import { isOFDError } from '../../src/errors';
import type { ZipEntryInput } from '../fixtures/zip-builder';
import type { XmlElementSpec } from '../fixtures/xml';
import { buildFixtureOfd, openTestDocument } from './helpers';

/** 构造 `MultiMedias` 资源节点。 */
function multiMedias(entries: XmlElementSpec[]): XmlElementSpec[] {
  return [{ name: 'ofd:MultiMedias', children: entries }];
}

/** 构造单条 `MultiMedia`。 */
function multiMedia(
  attrs: Record<string, string | number>,
  file?: string,
): XmlElementSpec {
  return {
    name: 'ofd:MultiMedia',
    attrs,
    ...(file ? { children: [{ name: 'ofd:MediaFile', children: [file] }] } : {}),
  };
}

/** 读取错误码。 */
function errorCode(error: unknown): string | undefined {
  return isOFDError(error) ? error.code : undefined;
}

/** 三页：第 1 页用视频资源、第 2 页用页级音频资源、第 3 页无媒体。 */
function mediaOfd(extraEntries: ZipEntryInput[] = []): Uint8Array {
  return buildFixtureOfd({
    pages: [
      { id: 1, widthMm: 100, heightMm: 100, objects: [] },
      { id: 2, widthMm: 100, heightMm: 100, objects: [], pageRes: ['Res.xml'] },
      { id: 3, widthMm: 100, heightMm: 100, objects: [] },
    ],
    publicRes: [
      {
        path: 'Doc_0/PublicRes.xml',
        children: multiMedias([
          multiMedia({ ID: 10, Type: 'Video', Format: 'MP4' }, 'video.mp4'),
          multiMedia({ ID: 11, Type: 'Image', Format: 'PNG' }, 'frame.png'),
        ]),
      },
    ],
    extraEntries: [
      { name: 'Doc_0/video.mp4', data: new Uint8Array([1, 2, 3, 4]) },
      { name: 'Doc_0/frame.png', data: new Uint8Array([9]) },
      { name: 'Doc_0/Pages/Page_2/audio.mp3', data: new Uint8Array([5, 6]) },
      {
        name: 'Doc_0/Pages/Page_2/Res.xml',
        data: Buffer.from(
          '<?xml version="1.0" encoding="UTF-8"?>' +
            '<ofd:Res xmlns:ofd="http://www.ofdspec.org/2016">' +
            '<ofd:MultiMedias>' +
            '<ofd:MultiMedia ID="20" Type="Audio" Format="MP3"><ofd:MediaFile>audio.mp3</ofd:MediaFile></ofd:MultiMedia>' +
            '</ofd:MultiMedias></ofd:Res>',
        ),
      },
      ...extraEntries,
    ],
  });
}

describe('音视频资源查询', () => {
  it('索引只含音视频，按 ID 升序且带 scope/declaredIn/sizeBytes', async () => {
    const doc = await openTestDocument(mediaOfd());
    try {
      // 页级资源只在对应页加载后才进入作用域，因此文档级索引只有公共资源。
      const media = await doc.getMediaResources();
      expect(media.map((item) => item.id)).toEqual(['10']);
      expect(media[0]).toEqual({
        id: '10',
        kind: 'video',
        mediaFile: 'Doc_0/video.mp4',
        mimeType: 'video/mp4',
        format: 'MP4',
        scope: 'public',
        declaredIn: 'Doc_0/PublicRes.xml',
        sizeBytes: 4,
      });
      expect((await doc.getMediaResources()).map((item) => item.id)).toEqual(['10']);

      const single = await doc.getMediaResource('10');
      expect(single?.sizeBytes).toBe(4);
      // 页级资源在对应页加载后按页作用域可见。
      expect((await doc.getMediaResource('20', { pageIndex: 1 }))?.sizeBytes).toBe(2);
    } finally {
      await doc.close();
    }
  });

  it('无音视频时返回空数组且不读取内容', async () => {
    const doc = await openTestDocument(
      buildFixtureOfd({
        pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [] }],
      }),
    );
    try {
      expect(await doc.getMediaResources()).toEqual([]);
      expect(await doc.getMediaResource('1')).toBeUndefined();
      expect(await doc.getMediaData('1')).toBeUndefined();
    } finally {
      await doc.close();
    }
  });

  it('getMediaData 返回原始字节；图片类型返回 undefined', async () => {
    const doc = await openTestDocument(mediaOfd());
    try {
      expect(await doc.getMediaData('10')).toEqual(new Uint8Array([1, 2, 3, 4]));
      expect(await doc.getMediaData('10', { maxBytes: 4 })).toEqual(new Uint8Array([1, 2, 3, 4]));
      expect(await doc.getMediaData('11')).toBeUndefined();
      expect(await doc.getMediaResource('11')).toBeUndefined();
      expect(await doc.getMediaData('999')).toBeUndefined();
    } finally {
      await doc.close();
    }
  });

  it('超过 maxMediaBytes 时按声明大小预检抛 OFD_LIMIT_EXCEEDED', async () => {
    const doc = await openTestDocument(mediaOfd());
    try {
      const error = await doc.getMediaData('10', { maxBytes: 3 }).catch((caught: unknown) => caught);
      expect(errorCode(error)).toBe('OFD_LIMIT_EXCEEDED');
    } finally {
      await doc.close();
    }

    const limited = await openTestDocument(mediaOfd(), {
      limits: { maxMediaBytes: 2 },
    });
    try {
      expect(await limited.getMediaData('20')).toEqual(new Uint8Array([5, 6]));
      const error = await limited.getMediaData('10').catch((caught: unknown) => caught);
      expect(errorCode(error)).toBe('OFD_LIMIT_EXCEEDED');
    } finally {
      await limited.close();
    }
  });

  it('页级资源按 pageIndex 生效；无页上下文回退任意页并报 W_MEDIA_SCOPE_AMBIGUOUS', async () => {
    const warnings: OFDWarning[] = [];
    const doc = await openTestDocument(mediaOfd(), { onWarning: (warning) => warnings.push(warning) });
    try {
      expect(await doc.getMediaResource('20', { pageIndex: 1 })).toBeDefined();
      expect(await doc.getMediaData('20', { pageIndex: 1 })).toEqual(new Uint8Array([5, 6]));
      expect(await doc.getMediaResource('20', { pageIndex: 0 })).toBeUndefined();
      const fallback = await doc.getMediaResource('20');
      expect(fallback?.id).toBe('20');
      expect(fallback?.mediaFile).toBe('Doc_0/Pages/Page_2/audio.mp3');
      expect(warnings.some((warning) => warning.code === 'W_MEDIA_SCOPE_AMBIGUOUS')).toBe(true);
    } finally {
      await doc.close();
    }
  });

  it('pageIndex 越界抛 OFD_PAGE_NOT_FOUND', async () => {
    const doc = await openTestDocument(mediaOfd());
    try {
      const error = await doc.getMediaResource('10', { pageIndex: 9 }).catch((caught: unknown) => caught);
      expect(errorCode(error)).toBe('OFD_PAGE_NOT_FOUND');
    } finally {
      await doc.close();
    }
  });

  it('超过 maxMediaResourceCount 时忽略多余声明并报 W_MEDIA_LIMIT', async () => {
    const warnings: OFDWarning[] = [];
    const doc = await openTestDocument(
      buildFixtureOfd({
        pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [] }],
        publicRes: [
          {
            path: 'Doc_0/PublicRes.xml',
            children: multiMedias([
              multiMedia({ ID: 10, Type: 'Video' }, 'a.mp4'),
              multiMedia({ ID: 11, Type: 'Audio' }, 'b.mp3'),
            ]),
          },
        ],
        extraEntries: [
          { name: 'Doc_0/a.mp4', data: new Uint8Array([1]) },
          { name: 'Doc_0/b.mp3', data: new Uint8Array([2]) },
        ],
      }),
      { limits: { maxMediaResourceCount: 1 }, onWarning: (warning) => warnings.push(warning) },
    );
    try {
      expect((await doc.getMediaResources()).map((item) => item.id)).toEqual(['10']);
      expect(warnings.some((warning) => warning.code === 'W_MEDIA_LIMIT')).toBe(true);
    } finally {
      await doc.close();
    }
  });

  it('超过 maxEntryBytes 的媒体条目仍能打开；受 maxMediaBytes 两档控制', async () => {
    // 声明 80 MiB（store 不压缩，避免解压开销）；超过默认 maxEntryBytes(64 MiB)。
    const size = 80 * 1024 * 1024;
    const big = new Uint8Array(size);
    big[0] = 7;
    const bytes = buildFixtureOfd({
      pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [] }],
      publicRes: [
        {
          path: 'Doc_0/PublicRes.xml',
          children: multiMedias([multiMedia({ ID: 30, Type: 'Video', Format: 'MP4' }, 'big.mp4')]),
        },
      ],
      extraEntries: [{ name: 'Doc_0/big.mp4', data: big, method: 'store' }],
    });
    // ① 文档正常打开（不再因条目超过 maxEntryBytes 而整包失败）。
    const doc = await openTestDocument(bytes);
    try {
      // ② 索引能拿到声明大小，不读内容。
      const resource = await doc.getMediaResource('30');
      expect(resource?.sizeBytes).toBe(size);
      // ③ 在 maxMediaBytes（默认 256 MiB）内可完整读取。
      const data = await doc.getMediaData('30');
      expect(data?.byteLength).toBe(size);
      expect(data?.[0]).toBe(7);
      // ④ 超过 maxMediaBytes 时抛 OFD_LIMIT_EXCEEDED，而不是打开失败。
      const error = await doc
        .getMediaData('30', { maxBytes: 64 * 1024 * 1024 })
        .catch((caught: unknown) => caught);
      expect(errorCode(error)).toBe('OFD_LIMIT_EXCEEDED');
      expect(await doc.getMediaData('30', { maxBytes: size })).toHaveLength(size);
    } finally {
      await doc.close();
    }
  }, 60_000);

  it('关闭后查询抛 OFD_CLOSED', async () => {
    const doc = await openTestDocument(mediaOfd());
    await doc.close();
    const error = await doc.getMediaResources().catch((caught: unknown) => caught);
    expect(errorCode(error)).toBe('OFD_CLOSED');
  });
});