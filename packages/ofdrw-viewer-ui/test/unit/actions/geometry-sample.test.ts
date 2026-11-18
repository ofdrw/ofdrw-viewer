/**
 * 动作几何端到端回归（音视频与动作方案设计 §5.5 / §7.2）。
 *
 * 用工作区真实样例 `ofd_pdf_match/gb-12-media.ofd` 验证：
 * - `getPageActionGeometries()` 输出的页面像素几何与手工换算一致；
 * - 这些几何经 `toActionBox` 后能正确建命中表并命中图元区域。
 *
 * 坐标口径：96 DPI、未旋转页面像素，原点页面 `PhysicalBox` 左上角。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';
import { createClickTable, hitTestTable } from '../../../src/actions/click-table';
import { toActionBox } from '../../../src/actions/geometry';

/**
 * 样例文件路径（仓库根下的 `ofd_pdf_match/`）。
 *
 * 样例由 `packages/ofdrw-viewer-engine/test/render/gb-standard-sample.export.test.ts`
 * 生成；未生成时整组用例跳过，避免在干净检出上误报失败。
 */
const SAMPLE = resolve(__dirname, '../../../../../ofd_pdf_match/gb-12-media.ofd');

/** 样例不存在时跳过（需要先跑 engine 的样例导出测试）。 */
const hasSample = existsSync(SAMPLE);

/** 96 DPI 下每毫米像素数。 */
const PX_PER_MM = 96 / 25.4;

/** 打开样例文档。 */
async function openSample(): Promise<OFDDocument> {
  const bytes = new Uint8Array(readFileSync(SAMPLE));
  return OFDDocument.open({ source: { kind: 'arraybuffer', data: bytes } });
}

describe.skipIf(!hasSample)('真实样例 gb-12-media.ofd 的动作几何', () => {
  it('第 1 页视频图元 Boundary 换算为预期页面像素', async () => {
    const doc = await openSample();
    try {
      const entries = await doc.getPageActionGeometries(0, { dpi: 96 });
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.action.type).toBe('movie');
      expect(entry.action.event).toBe('CLICK');
      expect(entry.geometry.source).toBe('object');
      // 样例的 ImageObject Boundary 为 "68.5 34 160 90"（mm）。
      const box = toActionBox(entry.geometry);
      expect(box.left).toBeCloseTo(68.5 * PX_PER_MM, 1);
      expect(box.top).toBeCloseTo(34 * PX_PER_MM, 1);
      expect(box.width).toBeCloseTo(160 * PX_PER_MM, 1);
      expect(box.height).toBeCloseTo(90 * PX_PER_MM, 1);
    } finally {
      await doc.close();
    }
  });

  it('第 2 页音频按钮图元同样可定位', async () => {
    const doc = await openSample();
    try {
      const entries = await doc.getPageActionGeometries(1, { dpi: 96 });
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.action.type).toBe('sound');
      expect(toActionBox(entry.geometry).width).toBeGreaterThan(0);
      expect(toActionBox(entry.geometry).height).toBeGreaterThan(0);
    } finally {
      await doc.close();
    }
  });

  it('几何可建命中表：封面中心命中、页面角落不命中', async () => {
    const doc = await openSample();
    try {
      const entries = await doc.getPageActionGeometries(0, { dpi: 96 });
      const items = entries
        .filter((entry) => entry.action.event === 'CLICK')
        .map((entry, index) => ({
          action: entry.action,
          bbox: toActionBox(entry.geometry),
          source: entry.geometry.source,
          paintOrder: index,
        }));
      const table = createClickTable(items);
      const box = toActionBox(entries[0]!.geometry);
      // 封面中心命中。
      const center = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      expect(hitTestTable(table, center)?.actions[0]?.type).toBe('movie');
      // 页面左下角（远离视频矩形）不命中。
      expect(hitTestTable(table, { x: 10, y: 700 })).toBeUndefined();
    } finally {
      await doc.close();
    }
  });

  it('多 DPI 下几何按比例缩放（确认 engine 统一换算）', async () => {
    const doc = await openSample();
    try {
      const at96 = toActionBox((await doc.getPageActionGeometries(0, { dpi: 96 }))[0]!.geometry);
      const at192 = toActionBox((await doc.getPageActionGeometries(0, { dpi: 192 }))[0]!.geometry);
      expect(at192.left).toBeCloseTo(at96.left * 2, 0);
      expect(at192.width).toBeCloseTo(at96.width * 2, 0);
    } finally {
      await doc.close();
    }
  });
});