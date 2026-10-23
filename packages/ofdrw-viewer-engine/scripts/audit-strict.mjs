#!/usr/bin/env node
/**
 * 严格审计入口：跑全量/过滤样本，与入库基线比较，不沿用 samples.json 的旧豁免。
 *
 * 用法：
 *   pnpm -C packages/ofdrw-viewer-engine test:audit
 *   pnpm -C packages/ofdrw-viewer-engine test:audit -- --filter hello
 *   pnpm -C packages/ofdrw-viewer-engine test:audit -- --update-baseline
 *   pnpm -C packages/ofdrw-viewer-engine test:audit -- --inject-pixel 1/p1
 *
 * 退出码：0=与基线一致；1=存在未登记差异/基线过期；2=运行或输入错误。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');
const BASELINE_PATH = join(PACKAGE_ROOT, 'test', 'golden', 'baseline', 'strict-baseline.json');
const DEFAULT_OUT = join(REPO_ROOT, 'test', '.artifacts', 'audit-strict', 'latest');
const EXPECTED_SAMPLE_COUNT = 58;
const EXPECTED_PAGE_COUNT = 169;

/** 页面指标比较容差；只作为“与基线漂移”判据，不作为绝对质量阈值。 */
const METRIC_TOLERANCE = Object.freeze({
  layoutDeltaMm: 0.01,
  colorP95DE: 0.25,
  colorP95DEAll: 0.25,
  blockColorP95DE: 0.5,
  keyColorCoverageDelta: 0.005,
  inkDiffRatio: 0.002,
  contentDiffRatio: 0.002,
  pixelDiffRatio: 1e-7,
});

/** 台账中已明确登记的页面期望；任何非 pass 页若不在表中，基线更新会拒绝。 */
const pageAnnotations = new Map();

/**
 * 登记若干页面的已知期望。
 *
 * @param {string} sample 样本名。
 * @param {number[]} pages 页号（1 起）。
 * @param {{expectation: string, reason: string, bugIds?: string[], evidence?: string[]}} spec 标注。
 */
function markPages(sample, pages, spec) {
  for (const page of pages) {
    const key = `${sample}/${page}`;
    const previous = pageAnnotations.get(key);
    pageAnnotations.set(key, {
      expectation: previous?.expectation ?? spec.expectation,
      bugIds: [...new Set([...(previous?.bugIds ?? []), ...(spec.bugIds ?? [])])],
      reason: [previous?.reason, spec.reason].filter(Boolean).join('；'),
      evidence: [...new Set([...(previous?.evidence ?? []), ...(spec.evidence ?? [])])],
    });
  }
}

const INTRO = 'intro-数科';
const LEDGER = 'test/.artifacts/audit-20261023/bug-ledger.md';
markPages('1-1', [2], {
  expectation: 'product-expected',
  bugIds: ['BUG-20261023-04'],
  reason: '用户裁决：p2 标题字体/内容正确，参考标题边缘墨迹多约 1px；保留裁切，不按引擎失败处理。',
  evidence: [LEDGER, 'test/.artifacts/audit-20261023/shard-a/findings.md'],
});
markPages(INTRO, [4], {
  expectation: 'reference-mismatch',
  bugIds: ['BUG-20261023-11'],
  reason: 'OFD 该页为图片版式，PDF 参考为文字版式，参考配对不一致。',
  evidence: [LEDGER, 'test/.artifacts/audit-20261023/shard-b/findings.json'],
});
markPages(INTRO, [14, 15, 16, 17, 18, 19], {
  expectation: 'reference-mismatch',
  bugIds: ['BUG-20261023-11'],
  reason: 'p14–p19 参考配对不一致（OFD 图片版 vs PDF 黑底文字版），不计引擎内容缺陷。',
  evidence: [LEDGER, 'test/.artifacts/audit-20261023/t7-verify/intro19/report.json'],
});
markPages(INTRO, [40], {
  expectation: 'known-engine-defect',
  bugIds: ['BUG-20261023-02'],
  reason: 'RadialShd 径向渐变降级为平均色（W_RADIAL_UNSUPPORTED），已知引擎缺陷。',
  evidence: [LEDGER, 'test/.artifacts/audit-20261023/shard-b/findings.json#F-B-02'],
});
markPages(INTRO, [8, 9], {
  expectation: 'known-engine-defect',
  bugIds: ['BUG-20261023-03'],
  reason: '渐变/底纹描边降级为平均色（W_UNSUPPORTED_PAINT），已知引擎缺陷。',
  evidence: [LEDGER, 'test/.artifacts/audit-20261023/shard-b/findings.json#F-B-03'],
});
markPages(INTRO, [2, 6, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 24, 25, 26, 27], {
  expectation: 'known-tolerance',
  bugIds: ['BUG-20261023-05'],
  reason: '全出血页末行 1 设备像素白边（≈0.2646mm），已知亚像素栅格化差异。',
  evidence: [LEDGER, 'test/.artifacts/audit-20261023/shard-b/findings.json#F-B-05'],
});
markPages('testPathClip', [1], {
  expectation: 'known-engine-defect',
  bugIds: ['BUG-20261023-02'],
  reason: 'RadialShd 径向渐变降级为平均色（W_RADIAL_UNSUPPORTED）。',
  evidence: [LEDGER, 'test/.artifacts/audit-20261023/shard-b/findings.json#F-B-02'],
});
markPages('zsbk', [2], {
  expectation: 'known-engine-defect',
  bugIds: ['BUG-20261023-22'],
  reason: '内嵌 AdobeSongStd-Light CFF 子集解析失败，回退渲染脚注。',
  evidence: [LEDGER, 'test/.artifacts/audit-20261023/shard-d/findings.json'],
});
markPages('z', [3], {
  expectation: 'reference-mismatch',
  bugIds: ['BUG-20261023-13'],
  reason: '参考 PDF 泰文位置为 .notdef 十字框伪影（Tahoma 未嵌入），非引擎缺陷。',
  evidence: [LEDGER, 'test/.artifacts/audit-20261023/shard-e/findings.json'],
});
markPages('keyword', [1], {
  expectation: 'reference-reencoding',
  bugIds: ['BUG-20261023-12', 'BUG-20261023-14'],
  reason: '参考 PDF 章/底图 JPEG 重编码 + 字重 AA；已改写 samples.json reason。',
  evidence: [
    'test/.artifacts/audit-20261023/shard-c/keyword/report.json',
    'test/.artifacts/audit-20261023/shard-c/findings.md#C-03',
  ],
});
markPages('signout', [1], {
  expectation: 'known-limitation',
  bugIds: ['BUG-20261023-14'],
  reason: 'font_3_3.ttf 损坏（684B，bad sfntVersion），引擎 W_FONT_MISSING 回退；本轮不修 OFD/PDF 字体。',
  evidence: [
    'test/.artifacts/audit-20261023/shard-c/signout/report.json',
    'test/.artifacts/audit-20261023/shard-c/findings.md#4.12',
  ],
});
markPages('DigitalSign', [1], {
  expectation: 'known-limitation',
  bugIds: ['BUG-20261023-14'],
  reason: 'SignedValue.dat 仅 70B，样本签章数据缺陷；按已知限制记录。',
  evidence: ['test/.artifacts/audit-20261023/shard-c/digital-sign/report.json'],
});
markPages('SignScaleError', [1], {
  expectation: 'known-limitation',
  bugIds: ['BUG-20261023-14'],
  reason: 'Document.xml 页引用悬空（StampAnnot PageRef=2），比较页内容完整；按覆盖边界记录。',
  evidence: ['test/.artifacts/audit-20261023/shard-c/sign-scale-error/report.json'],
});
markPages('manual', [1], {
  expectation: 'known-tolerance',
  bugIds: ['BUG-20261023-16'],
  reason: 'manual p1 已知字重/AA/图像重采样容差差异，保留样本豁免说明但不沿用旧阈值。',
  evidence: ['test/.artifacts/audit-20261023/shard-d/findings.json'],
});
markPages('testImageNotFound', [1], {
  expectation: 'expected-negative',
  bugIds: ['BUG-20261023-15'],
  reason: '负样本：缺 image_135.PNG，期望 W_IMAGE_DECODE 且页面继续，参考为全透明水印。',
  evidence: ['test/.artifacts/audit-20261023/shard-d/findings.json'],
});
markPages('不规范资源路径', [1], {
  expectation: 'known-tolerance',
  bugIds: ['BUG-20261023-16'],
  reason: '样本资源路径不规范，参考重编码/AA 差异已由分片 D 登记。',
  evidence: ['test/.artifacts/audit-20261023/shard-d/findings.json'],
});
markPages('20240531141733', [1], {
  expectation: 'reference-reencoding',
  bugIds: ['BUG-20261023-07', 'BUG-20261023-12'],
  reason: '参考 PDF 章/水印重编码，另登记水印 alpha/BlendMode 未决项。',
  evidence: ['test/.artifacts/audit-20261023/shard-c/findings.md#4.9'],
});
markPages('ofd-viewer-ui-showcase', [9], {
  expectation: 'known-tolerance',
  bugIds: ['SHOWCASE-01'],
  reason: 'p9 细边框栅格化 + keyColor 小样本假阳性（colorP95DE=0、coverageΔ=25.7%）。',
  evidence: [LEDGER + '#4.1', 'test/.artifacts/audit-20261023/showcase/report.json'],
});

/** 单页 samples 中整样本参考重编码的样本（每页登记，避免整样本静默跳过）。 */
for (const sample of ['invoice-seal-shuke', 'v4signed', 'h', 'V4RideRight', 'SESV4SignDoc']) {
  markPages(sample, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], {
    expectation: 'reference-reencoding',
    bugIds: ['BUG-20261023-12'],
    reason: '参考 PDF 章/印章/底图为 JPEG 或 index+smask 重编码，非引擎内容缺陷。',
    evidence: ['test/.artifacts/audit-20261023/shard-c/findings.md#C-03'],
  });
}

/** 台账 §4 的已知类别总表（即使页面当前 pass 也显式保留）。 */
const KNOWN_CLASSES = [
  {
    id: 'BUG-20261023-04',
    class: 'product-expected',
    samples: ['1-1'],
    pages: ['1-1/2'],
    note: '用户裁决保留标题裁切；不按引擎失败处理。',
  },
  {
    id: 'BUG-20261023-02',
    class: 'known-engine-defect',
    samples: ['testPathClip', INTRO],
    pages: ['testPathClip/1', `${INTRO}/40`],
    note: 'RadialShd 降级平均色；待 engine 修复。',
  },
  {
    id: 'BUG-20261023-03',
    class: 'known-engine-defect',
    samples: [INTRO],
    pages: [`${INTRO}/8`, `${INTRO}/9`],
    note: '渐变描边降级（W_UNSUPPORTED_PAINT）。',
  },
  {
    id: 'BUG-20261023-05',
    class: 'known-tolerance',
    samples: [INTRO],
    pages: [`${INTRO}/2`, `${INTRO}/6`, `${INTRO}/11`, `${INTRO}/12`, `${INTRO}/13`, `${INTRO}/14`, `${INTRO}/15`, `${INTRO}/16`, `${INTRO}/17`, `${INTRO}/18`, `${INTRO}/19`, `${INTRO}/20`, `${INTRO}/24`, `${INTRO}/25`, `${INTRO}/26`, `${INTRO}/27`],
    note: '末行 1 设备像素白边。',
  },
  {
    id: 'BUG-20261023-22',
    class: 'known-engine-defect',
    samples: ['zsbk'],
    pages: ['zsbk/2'],
    note: 'CFF 子集解析失败回退。',
  },
  {
    id: 'BUG-20261023-11',
    class: 'reference-mismatch',
    samples: [INTRO],
    pages: [`${INTRO}/4`, `${INTRO}/14`, `${INTRO}/15`, `${INTRO}/16`, `${INTRO}/17`, `${INTRO}/18`, `${INTRO}/19`],
    note: '参考配对不一致。',
  },
  {
    id: 'BUG-20261023-12',
    class: 'reference-reencoding',
    samples: ['keyword', '20240531141733', 'invoice-seal-shuke', 'v4signed', 'h', 'V4RideRight', 'SESV4SignDoc', 'SignScaleError'],
    pages: [],
    note: '参考 PDF 章/水印/底图 JPEG 重编码。',
  },
  {
    id: 'BUG-20261023-13',
    class: 'reference-mismatch',
    samples: ['z'],
    pages: ['z/3'],
    note: '参考 .notdef 伪影。',
  },
  {
    id: 'BUG-20261023-14',
    class: 'known-limitation',
    samples: ['signout', 'DigitalSign', 'SignScaleError', 'keyword'],
    pages: ['signout/1', 'DigitalSign/1', 'SignScaleError/1', 'keyword/1'],
    note: '样本数据缺陷/说明失真；不改样本资产。',
  },
  {
    id: 'BUG-20261023-15',
    class: 'expected-negative',
    samples: ['testImageNotFound'],
    pages: ['testImageNotFound/1'],
    note: '缺图负样本行为正确。',
  },
  {
    id: 'BUG-20261023-16',
    class: 'known-tolerance',
    samples: ['hello', 'doc1File', 'helloworld', 'chineseDir', '文字横向-数科', 'containsJPEG', 'AddWatermarkAnnot', 'h', 'V4RideRight', 'keyword2', 'invoice-seal-shuke', 'manual', '不规范资源路径'],
    pages: ['AddWatermarkAnnot/3', 'manual/1', '不规范资源路径/1'],
    note: '字重/AA/图像重采样/1px 基线/细边框栅格化；不改变全局阈值。',
  },
  {
    id: 'SHOWCASE-01',
    class: 'known-tolerance',
    samples: ['ofd-viewer-ui-showcase'],
    pages: ['ofd-viewer-ui-showcase/9'],
    note: 'p9 细边框栅格化 + keyColor 小样本假阳性。',
  },
];

/** 解析命令行参数。 */
function parseArgs(argv) {
  const args = { filter: '', maxPages: null, dpi: 96, out: DEFAULT_OUT, updateBaseline: false, injectPixel: '', report: '', baseline: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--filter') args.filter = argv[++index] ?? '';
    else if (arg === '--max-pages') args.maxPages = Number(argv[++index]);
    else if (arg === '--dpi') args.dpi = Number(argv[++index]);
    else if (arg === '--out') args.out = resolve(REPO_ROOT, argv[++index]);
    else if (arg === '--update-baseline') args.updateBaseline = true;
    else if (arg === '--inject-pixel') args.injectPixel = argv[++index] ?? '';
    else if (arg === '--report') args.report = resolve(REPO_ROOT, argv[++index]);
    else if (arg === '--baseline') args.baseline = resolve(REPO_ROOT, argv[++index]);
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: test:audit [--filter 样本] [--max-pages N] [--dpi 96] [--out 目录] [--update-baseline] [--inject-pixel 样本/p页] [--report report.json] [--baseline 路径]');
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return args;
}

/** 通过 vitest 跑现有 run-all e2e；严格判定由本脚本完成，不依赖旧 sampleOutcome。 */
function runHarness(args) {
  const outDir = args.out;
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const env = {
    ...process.env,
    GOLDEN_RUN_ALL: '1',
    GOLDEN_OUT_DIR: outDir,
    GOLDEN_DPI: String(args.dpi),
    GOLDEN_REQUIRE_ENGINE: '0',
    GOLDEN_SAMPLE_FILTER: args.filter,
  };
  if (args.maxPages !== null) env.GOLDEN_MAX_PAGES = String(args.maxPages);
  else delete env.GOLDEN_MAX_PAGES;
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  try {
    execFileSync(command, ['exec', 'vitest', 'run', 'test/e2e/run-all.e2e.test.ts', '--reporter=dot'], {
      cwd: PACKAGE_ROOT,
      env,
      stdio: 'inherit',
    });
  } catch (error) {
    const reportPath = join(outDir, 'report.json');
    if (!existsSync(reportPath)) {
      throw new Error(`harness 运行失败，且未生成 report.json：${error instanceof Error ? error.message : String(error)}`);
    }
    console.warn('[audit] harness 退出码非 0，但已生成 report.json；按基线继续严格判定。');
  }
  return join(outDir, 'report.json');
}

/** 读取报告。 */
function loadReport(path) {
  if (!existsSync(path)) throw new Error(`报告不存在：${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 把报告页转为基线页。 */
function baselinePageOf(page) {
  const metrics = page.metrics ?? {};
  return {
    status: page.status,
    width: page.width,
    height: page.height,
    metrics: {
      sizeDeltaPx: metrics.sizeDeltaPx ?? null,
      layoutDeltaMm: metrics.layoutDeltaMm ?? null,
      colorP95DE: metrics.colorP95DE ?? null,
      colorP95DEAll: metrics.colorP95DEAll ?? null,
      blockColorP95DE: metrics.blockColorP95DE ?? null,
      keyColorCoverageDelta: metrics.keyColorCoverageDelta ?? null,
      inkDiffRatio: metrics.inkDiffRatio ?? null,
      contentDiffRatio: metrics.contentDiffRatio ?? null,
      pixelDiffRatio: metrics.pixelDiffRatio ?? null,
    },
  };
}

/** 捕获补充字体环境，保证基线可追溯到具体的字体候选集。 */
function captureFonts() {
  const sourcePath = join(PACKAGE_ROOT, 'test', 'golden', 'lib', 'system-fonts.ts');
  let sha256 = null;
  let candidateFamilies = [];
  try {
    const source = readFileSync(sourcePath, 'utf8');
    sha256 = createHash('sha256').update(source).digest('hex');
    candidateFamilies = [...new Set([...source.matchAll(/family:\s*'([^']+)'/g)].map((match) => match[1]))];
  } catch {
    // 字体源码缺失时仍允许审计，只把环境标为 unknown。
  }
  return {
    supplementaryFontEnv: process.env.GOLDEN_SUPPLEMENTARY_FONT ?? null,
    systemFontsPath: relative(REPO_ROOT, sourcePath),
    systemFontsSha256: sha256,
    candidateFamilies,
    note: '未设置 GOLDEN_SUPPLEMENTARY_FONT 时使用 systemFontsSha256 对应的宿主候选组；CI/复跑需固定同一字体集，设置 override 可锁定单字体。',
  };
}

/** 捕获 git 冻结信息与无关 WIP（排除本脚本产物）。 */
function captureFreeze() {
  const git = (args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  let commit = 'unknown';
  let status = [];
  try {
    commit = git(['rev-parse', 'HEAD']);
    status = git(['status', '--short', '--untracked-files=all'])
      .split('\n')
      .filter(Boolean)
      .filter((line) => !line.includes('test/.artifacts/'));
  } catch {
    // 非 git 环境仍允许审计，只记录 unknown。
  }
  return { commit, status, note: '回归包含未提交的无关改动；status 为冻结时 git status --short 快照（已排除 test/.artifacts/）。' };
}

/** 为报告页补充台账标注。 */
function annotatePage(sample, page) {
  return pageAnnotations.get(`${sample}/${page}`) ?? null;
}

/** 生成基线对象。 */
function buildBaseline(report) {
  const samples = [];
  const missingAnnotations = [];
  let pageCount = 0;
  for (const sample of report.samples) {
    const pages = [];
    for (const page of sample.pages) {
      pageCount += 1;
      const annotation = annotatePage(sample.name, page.page);
      if (annotation === null && page.status !== 'pass') {
        missingAnnotations.push(`${sample.name}/p${page.page} (${page.status})`);
      }
      pages.push({
        page: page.page,
        ...baselinePageOf(page),
        expectation: annotation?.expectation ?? (page.status === 'pass' ? 'pass' : 'unclassified'),
        bugIds: annotation?.bugIds ?? [],
        reason: annotation?.reason ?? '',
        evidence: annotation?.evidence ?? [],
      });
    }
    samples.push({ name: sample.name, pages });
  }
  if (missingAnnotations.length > 0) {
    throw new Error(`存在未登记的 non-pass 页，拒绝生成基线：\n${missingAnnotations.join('\n')}`);
  }
  const knownCount = samples.reduce(
    (sum, sample) => sum + sample.pages.filter((page) => page.expectation !== 'pass').length,
    0,
  );
  return {
    schemaVersion: 1,
    kind: 'strict-audit-baseline',
    generatedAt: new Date().toISOString(),
    command: 'pnpm -C packages/ofdrw-viewer-engine test:audit',
    dpi: report.dpi,
    reportCreatedAt: report.createdAt,
    sampleCount: samples.length,
    pageCount,
    summary: {
      statusPassPages: pageCount - samples.reduce((sum, sample) => sum + sample.pages.filter((page) => page.status !== 'pass').length, 0),
      knownPages: knownCount,
      nonPassPages: samples.reduce((sum, sample) => sum + sample.pages.filter((page) => page.status !== 'pass').length, 0),
    },
    strict: {
      usesLegacyExemptions: false,
      note: '不沿用 referenceMismatchPages/knownTolerancePages/negativeSample 作为结论；已知差异在 pages[].expectation/bugIds/reason 显式登记。',
    },
    metricTolerance: METRIC_TOLERANCE,
    knownClasses: KNOWN_CLASSES,
    fonts: captureFonts(),
    freeze: captureFreeze(),
    samples,
  };
}

/** 比较数值指标。 */
function compareMetric(name, baselineValue, currentValue) {
  if (name === 'sizeDeltaPx') {
    const base = baselineValue ?? {};
    const cur = currentValue ?? {};
    if (base.width !== cur.width || base.height !== cur.height) {
      return `sizeDeltaPx: ${base.width}×${base.height} → ${cur.width}×${cur.height}`;
    }
    return null;
  }
  if (baselineValue === null || currentValue === null) {
    if (baselineValue !== currentValue) return `${name}: ${baselineValue} → ${currentValue}`;
    return null;
  }
  const tolerance = METRIC_TOLERANCE[name];
  if (typeof tolerance !== 'number') return null;
  if (Math.abs(baselineValue - currentValue) > tolerance) {
    return `${name}: ${baselineValue} → ${currentValue} (Δ=${Math.abs(baselineValue - currentValue).toFixed(6)} > ${tolerance})`;
  }
  return null;
}

/** 比较当前报告与基线。 */
function compareWithBaseline(report, baseline, filter) {
  const failures = [];
  const baseSamples = new Map(baseline.samples.map((sample) => [sample.name, sample]));
  const currentSamples = new Map(report.samples.map((sample) => [sample.name, sample]));
  if (!filter) {
    for (const name of baseSamples.keys()) {
      if (!currentSamples.has(name)) failures.push(`缺少样本：${name}`);
    }
  }
  const exactFilter = filter.length > 0 && report.samples.some((sample) => sample.name === filter);
  let checkedSamples = 0;
  let checkedPages = 0;
  let knownPages = 0;
  for (const current of report.samples) {
    if (filter && (exactFilter ? current.name !== filter : !current.name.includes(filter))) continue;
    checkedSamples += 1;
    const baseSample = baseSamples.get(current.name);
    if (!baseSample) {
      failures.push(`基线未登记样本：${current.name}`);
      continue;
    }
    const currentPages = new Map(current.pages.map((page) => [page.page, page]));
    if (current.pages.length !== baseSample.pages.length) {
      failures.push(`${current.name}: 页数 ${current.pages.length} ≠ 基线 ${baseSample.pages.length}`);
    }
    for (const basePage of baseSample.pages) {
      checkedPages += 1;
      if (basePage.expectation !== 'pass') knownPages += 1;
      const page = currentPages.get(basePage.page);
      if (!page) {
        failures.push(`${current.name}/p${basePage.page}: 当前报告缺页`);
        continue;
      }
      if (page.status !== basePage.status) {
        failures.push(`${current.name}/p${basePage.page}: status ${basePage.status} → ${page.status}`);
      }
      for (const [name, value] of Object.entries(basePage.metrics)) {
        const currentValue = page.metrics?.[name] ?? null;
        const reason = compareMetric(name, value, currentValue);
        if (reason) failures.push(`${current.name}/p${basePage.page}: ${reason}`);
      }
    }
  }
  return { failures, checkedSamples, checkedPages, knownPages };
}

/** 固化同进程字体缓存隔离回归：dense-text-perf 先渲染后，showcase p1/p2/p5/p7 必须仍 pass。 */
function cacheIsolationFailures(report) {
  const dense = report.samples.some((sample) => sample.name === 'dense-text-perf');
  const showcase = report.samples.find((sample) => sample.name === 'ofd-viewer-ui-showcase');
  if (!dense || !showcase) return [];
  const failures = [];
  for (const pageNumber of [1, 2, 5, 7]) {
    const page = showcase.pages.find((item) => item.page === pageNumber);
    if (!page) {
      failures.push(`[cache-isolation] showcase/p${pageNumber} 缺页`);
    } else if (page.status !== 'pass') {
      failures.push(`[cache-isolation] dense-text-perf→showcase/p${pageNumber} 状态 ${page.status}，字体缓存未隔离`);
    }
  }
  return failures;
}

/** 给报告注入一个像素的差异，用于验证比较器能失败（不自称真实渲染）。 */
function injectPixel(report, selector) {
  const [sampleName, pageLabel] = selector.split('/');
  const pageNumber = Number(String(pageLabel).replace(/^p/i, ''));
  const sample = report.samples.find((item) => item.name === sampleName);
  const page = sample?.pages.find((item) => item.page === pageNumber);
  if (!page || !page.metrics || !page.width || !page.height) {
    throw new Error(`无法注入像素：${selector} 不存在或缺少 metrics/尺寸`);
  }
  const delta = 1 / (page.width * page.height);
  page.metrics.pixelDiffRatio = (page.metrics.pixelDiffRatio ?? 0) + delta;
  page.metrics.contentDiffRatio = (page.metrics.contentDiffRatio ?? 0) + delta;
  return page;
}

/** 主流程。 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const reportPath = args.report || runHarness(args);
  const report = loadReport(reportPath);
  if (args.injectPixel) {
    const page = injectPixel(report, args.injectPixel);
    console.warn(`[audit] 已注入 1px 差异：${args.injectPixel} pixelDiffRatio=${page.metrics.pixelDiffRatio}`);
  }
  const fullRun = !args.filter && args.maxPages === null;
  if (args.updateBaseline) {
    if (!fullRun) throw new Error('--update-baseline 只允许无 filter/无 max-pages 的全量运行');
    const cacheFailures = cacheIsolationFailures(report);
    if (cacheFailures.length > 0) throw new Error(cacheFailures.join('\n'));
    const baseline = buildBaseline(report);
    if (baseline.sampleCount !== EXPECTED_SAMPLE_COUNT || baseline.pageCount !== EXPECTED_PAGE_COUNT) {
      throw new Error(`全量基线不完整：samples=${baseline.sampleCount}/${EXPECTED_SAMPLE_COUNT} pages=${baseline.pageCount}/${EXPECTED_PAGE_COUNT}`);
    }
    const baselinePath = args.baseline || BASELINE_PATH;
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`[audit] 基线已写入 ${relative(REPO_ROOT, baselinePath)}：${baseline.sampleCount} 样本 / ${baseline.pageCount} 页`);
    return 0;
  }
  const baselinePath = args.baseline || BASELINE_PATH;
  if (!existsSync(baselinePath)) {
    console.error(`[audit] 基线不存在：${relative(REPO_ROOT, baselinePath)}；先运行 --update-baseline。`);
    return 2;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const result = compareWithBaseline(report, baseline, args.filter);
  result.failures.unshift(...cacheIsolationFailures(report));
  console.log(`[audit] samples=${report.samples.length} pages=${report.samples.reduce((sum, sample) => sum + sample.pages.length, 0)} checked=${result.checkedPages} known=${result.knownPages}`);
  if (result.failures.length > 0) {
    console.error(`[audit] FAIL：${result.failures.length} 项与基线不一致`);
    for (const failure of result.failures) console.error(`  - ${failure}`);
    return 1;
  }
  console.log('[audit] PASS：与严格基线一致（未使用 referenceMismatch/knownTolerance/negativeSample 豁免）');
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(`[audit] ERROR：${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}