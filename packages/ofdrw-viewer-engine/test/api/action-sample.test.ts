/**
 * 标准条款样例 `gb-12-media.ofd` 的动作回归。
 *
 * 第 1 页 `ImageObject`（`Border` 之后跟 `Actions/Action Event="CLICK"/Movie ResourceID=10`）；
 * 第 2 页 `PathObject`（`AbbreviatedData` 之后跟 `Actions/Sound ResourceID=12`）。
 * 样例只用于人工比对，不在 `samples.json` 黄金图清单内；文件缺失时跳过用例。
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { OFDWarning } from '../../src/warnings';
import { openTestDocument } from './helpers';

/** 样例文件路径。 */
const SAMPLE_PATH = fileURLToPath(new URL('../../../../ofd_pdf_match/gb-12-media.ofd', import.meta.url));

describe('gb-12-media.ofd 动作', () => {
  it('Actions 位于 Border/AbbreviatedData 之后仍可解析', async () => {
    if (!existsSync(SAMPLE_PATH)) {
      console.warn(`缺少样例 ${SAMPLE_PATH}，跳过`);
      return;
    }
    const warnings: OFDWarning[] = [];
    const doc = await openTestDocument(new Uint8Array(readFileSync(SAMPLE_PATH)), {
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      expect(doc.getDocumentActions()).toEqual([]);

      const page0 = await doc.getPageActionsByEvent(0, 'CLICK');
      expect(page0).toHaveLength(1);
      expect(page0[0]).toMatchObject({
        event: 'CLICK',
        type: 'movie',
        owner: { kind: 'object', pageIndex: 0 },
        payload: { type: 'movie', resourceId: '10', operator: 'Play' },
      });
      expect(page0[0]?.owner.kind === 'object' ? page0[0].owner.objectId : undefined).toBeDefined();

      const page1 = await doc.getPageActionsByEvent(1, 'CLICK');
      expect(page1).toHaveLength(1);
      expect(page1[0]).toMatchObject({
        event: 'CLICK',
        type: 'sound',
        payload: { type: 'sound', resourceId: '12', volume: 100, repeat: false, synchronous: false },
      });
      // 音频动作挂在 PathObject（非图像图元）上，验证 CT_GraphicUnit 全图元支持。
      expect(page1[0]?.owner.kind).toBe('object');

      expect(warnings.filter((warning) => warning.code.startsWith('W_ACTION'))).toEqual([]);
    } finally {
      await doc.close();
    }
  });
});
