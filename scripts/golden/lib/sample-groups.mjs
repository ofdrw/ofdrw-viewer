/**
 * 55 对基准样本的分组（设计方案 19.3）与第 56 对 manual 的元数据。
 *
 * 一个样本可以属于多个分组（设计方案对 1.ofd、no_page_container.ofd 等重复列出）；
 * 未列入 19.3 的样本归入 `other`，仍参与全量回归，但优先级为 P1。
 */

/** 分组定义；`samples` 为样本名（不含扩展名）。 */
export const SAMPLE_GROUPS = Object.freeze({
  'basic-text-path': {
    title: '基础文字/路径',
    samples: ['hello', 'helloworld', '1', '1-1'],
  },
  'horizontal-delta': {
    title: '横向文字/Delta/多 TextCode',
    samples: ['文字横向-数科', 'chineseDir', 'multiKeywordInTextCode'],
  },
  'transparency-blend': {
    title: '透明度/混合',
    samples: ['透明度文字', 'testPathFillOpacity'],
  },
  image: {
    title: '图片/替换/缺失',
    samples: ['containsJPEG', 'testImageNotFound', 'testImageOverridePage'],
  },
  'scan-jbig2': {
    title: '扫描件/JBIG2',
    samples: ['1', 'no_page_container', 'signedFile'],
  },
  'clip-composite': {
    title: '裁剪/复合',
    samples: ['testPathClip', 'helloworld_with_pageblock', 'intro-数科'],
  },
  pattern: {
    title: '底纹',
    samples: ['pattern类型'],
  },
  'annotation-seal': {
    title: '注释/水印/签章',
    samples: [
      'AddWatermarkAnnot',
      'hello_watermark',
      '发票监制章-数科',
      'signout',
      'v4signed',
      '20240531141733',
    ],
  },
  'irregular-structure': {
    title: '不规范结构',
    samples: ['namespace_no_std', 'path_unstd', 'no_page_container', '不规范资源路径'],
  },
  'scan-image-ctm': {
    title: '扫描件整页图片/JBIG2/非单位 CTM（manual）',
    samples: ['manual'],
  },
});

/** 未命中任何分组的样本使用的分组键。 */
export const OTHER_GROUP = 'other';

/** manual 样本元数据；不提交仓库，缺失时脚本 skip。 */
export const MANUAL_SAMPLE = Object.freeze({
  name: 'manual',
  optional: true,
  /** 黄金图只抽查 3-5 个代表页（1 起）。 */
  goldenPages: [1, 23, 45, 67, 89],
  note: '89 页 A4，整页 JPG 图片为主（ImageObject 带非单位 CTM），含 5 个 JBIG2、8 个 TTF；不提交仓库，本地存在时才跑。',
});

/**
 * 判断样本所属分组与优先级。
 *
 * @param name 样本名。
 * @returns `{groups, priority}`。
 */
export function classifySample(name) {
  const groups = [];
  for (const [key, group] of Object.entries(SAMPLE_GROUPS)) {
    if (group.samples.includes(name)) groups.push(key);
  }
  if (groups.length === 0) groups.push(OTHER_GROUP);
  const priority = groups.some((group) => group !== OTHER_GROUP) ? 'P0' : 'P1';
  return { groups, priority };
}