/**
 * 回归样本清单完整性：57 对（55 基准 + manual + dense-text-perf）、19.3 分组、页数/尺寸/字体/JBIG2 标注。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './lib/artifacts';
import {
  MANUAL_GROUP,
  OTHER_GROUP,
  REQUIRED_GROUPS,
  TEXT_PERF_GROUP,
  loadSampleManifest,
} from './lib/samples';

/** 设计方案 19.3 明确点名的样本与分组（独立于脚本实现，用于交叉校验）。 */
const EXPECTED_GROUP_SAMPLES: Record<string, string[]> = {
  'basic-text-path': ['hello', 'helloworld', '1', '1-1'],
  'horizontal-delta': ['文字横向-数科', 'chineseDir', 'multiKeywordInTextCode'],
  'transparency-blend': ['透明度文字', 'testPathFillOpacity'],
  image: ['containsJPEG', 'testImageNotFound', 'testImageOverridePage'],
  'scan-jbig2': ['1', 'no_page_container', 'signedFile'],
  'clip-composite': ['testPathClip', 'helloworld_with_pageblock', 'intro-数科'],
  pattern: ['pattern类型'],
  'annotation-seal': [
    'AddWatermarkAnnot',
    'hello_watermark',
    '发票监制章-数科',
    'signout',
    'v4signed',
    '20240531141733',
  ],
  'irregular-structure': ['namespace_no_std', 'path_unstd', 'no_page_container', '不规范资源路径'],
};

describe('回归样本清单', () => {
  const manifest = loadSampleManifest();

  it('包含 57 对且名称唯一', () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.sourceDir).toBe('ofd_pdf_match');
    expect(manifest.count).toBe(57);
    expect(manifest.samples).toHaveLength(57);
    const names = new Set(manifest.samples.map((sample) => sample.name));
    expect(names.size).toBe(57);
    expect(names.has('manual')).toBe(true);
    expect(names.has('dense-text-perf')).toBe(true);
  });

  it('19.3 分组完整，重复列出的样本属于多个分组', () => {
    expect([...REQUIRED_GROUPS, MANUAL_GROUP]).toHaveLength(10);
    for (const group of REQUIRED_GROUPS) {
      const members = manifest.samples.filter((sample) => sample.groups.includes(group));
      expect(members.length, `分组 ${group} 为空`).toBeGreaterThan(0);
    }
    for (const [group, names] of Object.entries(EXPECTED_GROUP_SAMPLES)) {
      for (const name of names) {
        const sample = manifest.samples.find((item) => item.name === name);
        expect(sample, `缺少样本 ${name}`).toBeDefined();
        expect(sample!.groups, `${name} 应属于 ${group}`).toContain(group);
      }
    }
    const one = manifest.samples.find((sample) => sample.name === '1')!;
    expect(one.groups).toEqual(expect.arrayContaining(['basic-text-path', 'scan-jbig2']));
    const noPageContainer = manifest.samples.find((sample) => sample.name === 'no_page_container')!;
    expect(noPageContainer.groups).toEqual(expect.arrayContaining(['scan-jbig2', 'irregular-structure']));
  });

  it('每个样本都有优先级；未分组样本归入 other 且为 P1', () => {
    for (const sample of manifest.samples) {
      expect(sample.groups.length).toBeGreaterThan(0);
      expect(['P0', 'P1']).toContain(sample.priority);
      expect(sample.goldenPages.every((page) => page >= 1)).toBe(true);
      if (sample.groups.length === 1 && sample.groups[0] === OTHER_GROUP) {
        expect(sample.priority).toBe('P1');
      } else {
        expect(sample.priority).toBe('P0');
      }
    }
  });

  it('manual 为可选样本：89 页 A4、5 个 JBIG2、8 个 TTF、黄金图 3-5 页', () => {
    const manual = manifest.samples.find((sample) => sample.name === 'manual')!;
    expect(manual.optional).toBe(true);
    expect(manual.groups).toContain(MANUAL_GROUP);
    expect(manual.goldenPages.length).toBeGreaterThanOrEqual(3);
    expect(manual.goldenPages.length).toBeLessThanOrEqual(5);
    if (manual.available) {
      expect(manual.pdfPages).toBe(89);
      expect(manual.ofdDeclaredPages).toBe(89);
      expect(manual.sizeMm).toEqual({ width: 210, height: 297 });
      expect(manual.jb2Entries).toBe(5);
      expect(manual.fontEntries).toBe(8);
      expect(manual.embeddedFonts).toBe(true);
      expect(manual.imageEntries).toBeGreaterThan(0);
    }
  });

  it('dense-text-perf 为可选 P0 文本性能样本，缺失时 skip', () => {
    const perf = manifest.samples.find((sample) => sample.name === 'dense-text-perf')!;
    expect(perf.optional).toBe(true);
    expect(perf.priority).toBe('P0');
    expect(perf.groups).toEqual([TEXT_PERF_GROUP]);
    expect(perf.goldenPages).toEqual([]);
    if (perf.available) {
      expect(perf.pdfPages).toBe(2);
      expect(perf.ofdDeclaredPages).toBe(2);
      expect(perf.sizeMm).toEqual({ width: 210, height: 297 });
      expect(perf.embeddedFonts).toBe(true);
      expect(perf.fontEntries).toBeGreaterThan(0);
      expect(perf.jb2Entries).toBe(0);
    } else {
      expect(perf.notes.join('\n')).toContain('skip');
    }
  });

  it('intro-数科 标注参考配对不匹配页，doc1File 标注文字页容差', () => {
    const intro = manifest.samples.find((sample) => sample.name === 'intro-数科')!;
    expect(intro.referenceMismatchPages).toEqual([4, 14, 15, 16, 17, 18, 19, 32, 34, 35, 40, 42]);
    expect(intro.referenceMismatchReason).toContain('图片版式');
    expect(intro.referenceMismatchReason).toContain('p19');
    expect(intro.referenceMismatchReason).toContain('机器人');
    expect(intro.notes.join('\n')).toContain('参考配对不一致');

    const doc = manifest.samples.find((sample) => sample.name === 'doc1File')!;
    expect(doc.notes.join('\n')).toContain('文字页容差');
    expect(doc.notes.join('\n')).toContain('普通页仍 0.5mm');
  });

  it('z p2 使用用户权威图，且仅覆盖 p2', () => {
    const z = manifest.samples.find((sample) => sample.name === 'z')!;
    expect(z.referenceOverride).toMatchObject({
      page: 2,
      path: 'test/fixtures/reference/z-p002-authoritative.png',
      width: 794,
      height: 1123,
      targetContentBBoxPx: { x: 120, y: 129, width: 551, height: 723 },
    });
    expect(z.referenceOverride!.reason).toContain('He affixed his fine sign');
    expect(existsSync(join(REPO_ROOT, z.referenceOverride!.path))).toBe(true);
    const others = manifest.samples.filter((sample) => sample.referenceOverride && sample.name !== 'z');
    expect(others).toHaveLength(0);
  });

  it('z p3 为参考 .notdef 伪影，不要求引擎画 tofu', () => {
    const z = manifest.samples.find((sample) => sample.name === 'z')!;
    expect(z.referenceMismatchPages).toEqual([3]);
    expect(z.referenceMismatchReason).toContain('Tahoma');
    expect(z.referenceMismatchReason).toContain('.notdef');
    expect(z.referenceMismatchReason).toContain('无 FontFile');
    expect(z.knownTolerancePages).toBeUndefined();
  });

  it('testImageNotFound p1 为负样本，manual p1 为 known tolerance', () => {
    const notFound = manifest.samples.find((sample) => sample.name === 'testImageNotFound')!;
    expect(notFound.negativeSample).toBeDefined();
    expect(notFound.negativeSample!.pages).toEqual([1]);
    expect(notFound.negativeSample!.expectedWarnings).toContain('W_IMAGE_DECODE');
    expect(notFound.negativeSample!.requireContent).toBe(true);
    expect(notFound.negativeSample!.reason).toContain('页面继续');

    const manual = manifest.samples.find((sample) => sample.name === 'manual')!;
    expect(manual.knownTolerancePages).toHaveLength(1);
    expect(manual.knownTolerancePages![0]!.page).toBe(1);
    expect(manual.knownTolerancePages![0]!.maxDeltaE).toBe(2.4);
    expect(manual.knownTolerancePages![0]!.maxCoverageDelta).toBe(0.613);
    expect(manual.knownTolerancePages![0]!.reason).toContain('不改变全局阈值');
  });

  it('keyword 页 1 标为参考不匹配，AddWatermark p3 标为 known tolerance', () => {
    const keyword = manifest.samples.find((sample) => sample.name === 'keyword')!;
    expect(keyword.referenceMismatchPages).toEqual([1]);
    expect(keyword.referenceMismatchReason).toContain('斜向水印');
    expect(keyword.referenceMismatchReason).toContain('表格');

    const watermark = manifest.samples.find((sample) => sample.name === 'AddWatermarkAnnot')!;
    expect(watermark.knownTolerancePages).toHaveLength(1);
    expect(watermark.knownTolerancePages![0]!.page).toBe(3);
    expect(watermark.knownTolerancePages![0]!.maxDeltaE).toBeCloseTo(6.7545, 4);
    expect(watermark.knownTolerancePages![0]!.reason).toContain('不改变全局阈值');
  });

  it('本地样本存在时：PDF/OFD 页数一致、尺寸换算正确、文件可访问', () => {
    const sampleDir = join(REPO_ROOT, 'ofd_pdf_match');
    if (!existsSync(sampleDir)) {
      // 业务样本可能不在 CI 工作区；清单结构检查已在上面覆盖。
      return;
    }
    for (const sample of manifest.samples) {
      if (!sample.available) continue;
      expect(sample.ofd, `${sample.name} 缺 OFD 路径`).not.toBeNull();
      expect(sample.pdf, `${sample.name} 缺 PDF 路径`).not.toBeNull();
      expect(existsSync(join(REPO_ROOT, sample.ofd!))).toBe(true);
      expect(existsSync(join(REPO_ROOT, sample.pdf!))).toBe(true);
      expect(sample.ofdDeclaredPages, `${sample.name} OFD 页数`).toBe(sample.pdfPages);
      if (sample.pageSizePt && sample.sizeMm) {
        expect(sample.sizeMm.width).toBeCloseTo((sample.pageSizePt.width * 25.4) / 72, 2);
        expect(sample.sizeMm.height).toBeCloseTo((sample.pageSizePt.height * 25.4) / 72, 2);
      }
    }
  });
});