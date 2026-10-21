/**
 * T7 warning 汇总与去重：按 `(code, pageIndex, objectId)` 去重后再上报宿主。
 */

import { describe, expect, it } from 'vitest';
import type { OFDWarning } from '../../src/warnings';
import {
  buildFixtureOfd,
  buildImageOfd,
  createPng,
  openTestDocument,
  renderPage,
} from './helpers';
import type { XmlElementSpec } from '../fixtures/xml';

/** 收集 warning 并返回列表。 */
function collector(): { warnings: OFDWarning[]; onWarning: (warning: OFDWarning) => void } {
  const warnings: OFDWarning[] = [];
  return { warnings, onWarning: (warning) => warnings.push(warning) };
}

/** 单页图片对象，可选 CTM。 */
function imageObject(id: number, withCtm: boolean): XmlElementSpec {
  return {
    name: 'ofd:ImageObject',
    attrs: {
      ID: id,
      Boundary: '10 10 10 10',
      ResourceID: '10',
      ...(withCtm ? { CTM: '10 0 0 10 0 0' } : {}),
    },
  };
}

/** 两页、同一图片资源、均无 CTM。 */
function buildTwoPageImageOfd(): Uint8Array {
  return buildFixtureOfd({
    pages: [
      { id: 1, widthMm: 100, heightMm: 100, objects: [imageObject(11, false)] },
      { id: 2, widthMm: 100, heightMm: 100, objects: [imageObject(21, false)] },
    ],
    publicRes: [
      {
        path: 'Doc_0/Res/Res.xml',
        children: [
          {
            name: 'ofd:MultiMedias',
            children: [
              {
                name: 'ofd:MultiMedia',
                attrs: { ID: 10, Type: 'Image', Format: 'PNG' },
                children: [{ name: 'ofd:MediaFile', children: ['image.png'] }],
              },
            ],
          },
        ],
      },
    ],
    extraEntries: [{ name: 'Doc_0/Res/image.png', data: createPng() }],
  });
}

describe('warning 去重与分页归属', () => {
  it('同一页重复渲染的 W_IMAGE_NO_CTM 只上报一次；不同页分别上报', async () => {
    const { warnings, onWarning } = collector();
    const doc = await openTestDocument(buildTwoPageImageOfd(), { onWarning });
    try {
      for (const index of [0, 1]) {
        const page = await doc.getPage(index);
        await renderPage(page);
        await renderPage(page);
      }
      const noCtm = warnings.filter((warning) => warning.code === 'W_IMAGE_NO_CTM');
      expect(noCtm).toHaveLength(2);
      expect(noCtm.map((warning) => warning.pageIndex)).toEqual([0, 1]);
      expect(noCtm.map((warning) => warning.objectId)).toEqual(['11', '21']);
    } finally {
      await doc.close();
    }
  });

  it('缺少图片解码器时降级 warning 且重复渲染不重复上报', async () => {
    const { warnings, onWarning } = collector();
    const doc = await openTestDocument(buildImageOfd({ withCtm: true }), {
      onWarning,
      imageDecoders: [],
    });
    try {
      const page = await doc.getPage(0);
      await renderPage(page);
      await renderPage(page);
      const decodeWarnings = warnings.filter((warning) => warning.code === 'W_IMAGE_DECODE');
      // 两条不同上下文：资源级“解码失败”和对象级“图片未解码已跳过”。
      expect(decodeWarnings).toHaveLength(2);
      expect(decodeWarnings.every((warning) => warning.pageIndex === 0)).toBe(true);
      expect(decodeWarnings.some((warning) => warning.objectId === '11')).toBe(true);
    } finally {
      await doc.close();
    }
  });

  it('默认不传 onWarning 时静默且渲染不中断', async () => {
    const doc = await openTestDocument(buildImageOfd({ withCtm: true }), {
      imageDecoders: [],
    });
    try {
      const page = await doc.getPage(0);
      const { canvas } = await renderPage(page);
      expect(canvas.pixel(5, 5)).toEqual([255, 255, 255, 255]);
    } finally {
      await doc.close();
    }
  });
});