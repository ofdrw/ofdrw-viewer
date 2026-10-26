/**
 * 回归样本清单完整性：63 条（61 对基准 + manual + dense-text-perf）、19.3 分组、页数/尺寸/字体/JBIG2 标注。
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
  'basic-text-path': ['hello', 'helloworld', '1', '1-1', 'ofd-viewer-ui-showcase'],
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

  it('包含 63 对且名称唯一', () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.sourceDir).toBe('ofd_pdf_match');
    expect(manifest.count).toBe(63);
    expect(manifest.samples).toHaveLength(63);
    const names = new Set(manifest.samples.map((sample) => sample.name));
    expect(names.size).toBe(63);
    expect(names.has('manual')).toBe(true);
    expect(names.has('dense-text-perf')).toBe(true);
    expect(names.has('ofd-viewer-ui-showcase')).toBe(true);
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

  it('keyword 页 1 reason 指向参考重编码，AddWatermark p3 标为 known tolerance', () => {
    const keyword = manifest.samples.find((sample) => sample.name === 'keyword')!;
    expect(keyword.referenceMismatchPages).toEqual([1]);
    expect(keyword.referenceMismatchReason).toContain('JPEG 重编码');
    expect(keyword.referenceMismatchReason).toContain('字重 AA');

    const watermark = manifest.samples.find((sample) => sample.name === 'AddWatermarkAnnot')!;
    expect(watermark.knownTolerancePages).toHaveLength(1);
    expect(watermark.knownTolerancePages![0]!.page).toBe(3);
    expect(watermark.knownTolerancePages![0]!.maxDeltaE).toBeCloseTo(6.7545, 4);
    expect(watermark.knownTolerancePages![0]!.reason).toContain('不改变全局阈值');
  });

  it('showcase 为第 58 条：10 页、basic-text-path/P0、内嵌 SimSun 子集', () => {
    const showcase = manifest.samples.find((sample) => sample.name === 'ofd-viewer-ui-showcase')!;
    expect(showcase.groups).toEqual(['basic-text-path']);
    expect(showcase.priority).toBe('P0');
    expect(showcase.optional).toBe(false);
    expect(showcase.pdfPages).toBe(10);
    expect(showcase.ofdDeclaredPages).toBe(10);
    expect(showcase.sizeMm).toEqual({ width: 210, height: 297 });
    expect(showcase.embeddedFonts).toBe(true);
    expect(showcase.fontEntries).toBe(1);
    expect(showcase.imageEntries).toBe(0);
    expect(showcase.jb2Entries).toBe(0);
    expect(showcase.sha256).toBe('2f3940b25b48f9b45edc351d1804e50d58f0d7d172a7a19bd778a2d4d35f3458');
    expect(showcase.goldenPages).toEqual([]);
    expect(showcase.knownTolerancePages).toHaveLength(1);
    expect(showcase.knownTolerancePages![0]!.page).toBe(9);
    expect(showcase.knownTolerancePages![0]!.maxCoverageDelta).toBeCloseTo(0.26, 2);
    expect(showcase.knownTolerancePages![0]!.reason).toContain('细边框栅格化');
  });

  it('signout 字体损坏登记为 known limitation，不改样本资产', () => {
    const signout = manifest.samples.find((sample) => sample.name === 'signout')!;
    expect(signout.notes.join('\n')).toContain('known limitation');
    expect(signout.notes.join('\n')).toContain('font_3_3.ttf 损坏');
    expect(signout.referenceMismatchPages).toBeUndefined();
  });

  it('v2 入库样本按实测值登记，同名冲突旧版保留为 -v1', () => {
    // 用户裁决：ofd_pdf_match_v2 的 6 组样本以原名登记，旧版同名样本改名保留为 -v1。
    const expectations: Array<{
      name: string;
      groups: string[];
      pdfPages: number;
      ofdDeclaredPages: number;
      sizeMm: { width: number; height: number };
      fontEntries: number;
      imageEntries: number;
    }> = [
      { name: '96d93ac858b444c1b914707872dbd645', groups: ['annotation-seal'], pdfPages: 2, ofdDeclaredPages: 2, sizeMm: { width: 210, height: 297 }, fontEntries: 0, imageEntries: 0 },
      { name: 'addimage', groups: ['image'], pdfPages: 2, ofdDeclaredPages: 2, sizeMm: { width: 209, height: 147 }, fontEntries: 0, imageEntries: 2 },
      { name: 'dzbh', groups: ['annotation-seal'], pdfPages: 2, ofdDeclaredPages: 2, sizeMm: { width: 209.954, height: 296.934 }, fontEntries: 1, imageEntries: 3 },
      { name: '发票示例', groups: ['annotation-seal'], pdfPages: 1, ofdDeclaredPages: 1, sizeMm: { width: 210, height: 140 }, fontEntries: 0, imageEntries: 1 },
      { name: 'testImageOverridePage', groups: ['image'], pdfPages: 1, ofdDeclaredPages: 1, sizeMm: { width: 369.358, height: 258.939 }, fontEntries: 0, imageEntries: 2 },
    ];
    for (const expected of expectations) {
      const sample = manifest.samples.find((item) => item.name === expected.name);
      expect(sample, `缺少 v2 入库样本 ${expected.name}`).toBeDefined();
      expect(sample!.groups).toEqual(expected.groups);
      expect(sample!.priority).toBe('P0');
      expect(sample!.ofd).toBe(`ofd_pdf_match/${expected.name}.ofd`);
      expect(sample!.pdf).toBe(`ofd_pdf_match/${expected.name}.pdf`);
      expect(sample!.pdfPages, `${expected.name} PDF 页数`).toBe(expected.pdfPages);
      expect(sample!.ofdDeclaredPages, `${expected.name} OFD 声明页数`).toBe(expected.ofdDeclaredPages);
      expect(sample!.sizeMm).toEqual(expected.sizeMm);
      expect(sample!.fontEntries).toBe(expected.fontEntries);
      expect(sample!.imageEntries).toBe(expected.imageEntries);
      expect(sample!.jb2Entries).toBe(0);
      expect(sample!.goldenPages).toEqual([]);
    }

    // 旧版同名样本必须仍然存在且指向 -v1 文件，旧基准不丢。
    for (const legacy of ['发票示例-v1', 'testImageOverridePage-v1']) {
      const sample = manifest.samples.find((item) => item.name === legacy);
      expect(sample, `缺少旧版保留样本 ${legacy}`).toBeDefined();
      expect(sample!.ofd).toBe(`ofd_pdf_match/${legacy}.ofd`);
      expect(sample!.pdf).toBe(`ofd_pdf_match/${legacy}.pdf`);
      expect(sample!.pdfPages).toBe(1);
      expect(sample!.ofdDeclaredPages).toBe(1);
      expect(sample!.notes.join('\n')).toContain('改名保留为 -v1');
    }

    // testImageOverridePage 新旧 OFD 字节相同（仅 PDF 参考不同），-v1 的 sha256 应与新版一致。
    const current = manifest.samples.find((item) => item.name === 'testImageOverridePage')!;
    const legacy = manifest.samples.find((item) => item.name === 'testImageOverridePage-v1')!;
    expect(legacy.sha256).toBe(current.sha256);

    // 发票示例新旧 OFD 是不同文件，不能共用 sha256。
    const invoice = manifest.samples.find((item) => item.name === '发票示例')!;
    const invoiceLegacy = manifest.samples.find((item) => item.name === '发票示例-v1')!;
    expect(invoiceLegacy.sha256).not.toBe(invoice.sha256);
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