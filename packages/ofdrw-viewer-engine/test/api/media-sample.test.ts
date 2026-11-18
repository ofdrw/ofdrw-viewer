/**
 * 标准条款样例 `gb-12-media.ofd` 的音视频索引回归。
 *
 * 第 1 页 `MultiMedia ID=10 Type=Video`、`ID=11 Type=Image`；第 2 页 `ID=12 Type=Audio`。
 * 样例只用于人工比对，不在 `samples.json` 黄金图清单内；文件缺失时跳过用例。
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { OFDWarning } from '../../src/warnings';
import { openTestDocument } from './helpers';

/** 样例文件路径。 */
const SAMPLE_PATH = fileURLToPath(new URL('../../../../ofd_pdf_match/gb-12-media.ofd', import.meta.url));

describe('gb-12-media.ofd 音视频资源', () => {
  it('索引出视频与音频资源，图片不进音视频索引', async () => {
    if (!existsSync(SAMPLE_PATH)) {
      console.warn(`缺少样例 ${SAMPLE_PATH}，跳过`);
      return;
    }
    const warnings: OFDWarning[] = [];
    const doc = await openTestDocument(new Uint8Array(readFileSync(SAMPLE_PATH)), {
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      const media = await doc.getMediaResources();
      expect(media.map((item) => `${item.id}:${item.kind}:${item.mimeType}`)).toEqual([
        '10:video:video/mp4',
        '12:audio:audio/mpeg',
      ]);
      expect(media[0]?.sizeBytes).toBeGreaterThan(0);
      expect(media.every((item) => item.scope === 'public')).toBe(true);
      const video = await doc.getMediaData('10');
      expect(video?.byteLength).toBe(media[0]?.sizeBytes);
      expect(await doc.getMediaResource('11')).toBeUndefined();
      expect(warnings.filter((warning) => warning.code.startsWith('W_MEDIA'))).toEqual([]);
    } finally {
      await doc.close();
    }
  });
});
