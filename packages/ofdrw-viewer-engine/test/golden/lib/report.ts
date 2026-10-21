/**
 * 黄金图报告输出：JSON（机器读取）+ 单文件 HTML（人工审核）。
 *
 * 图片路径均相对于产物目录，HTML 可直接用本地浏览器打开；
 * JSON 中的 `artifactsDir` 为绝对路径，便于 CI 收集。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GoldenReport, GoldenSummary, SampleReport, Tolerance } from './types';

/** 报告输出路径。 */
export interface ReportPaths {
  /** report.json 绝对路径。 */
  jsonPath: string;
  /** report.html 绝对路径。 */
  htmlPath: string;
}

/** 样本结论。 */
export type SampleOutcome = 'passed' | 'failed' | 'skipped' | 'unavailable';

/**
 * 根据单页结果判定样本结论。
 *
 * @param sample 样本报告。
 * @returns 结论。
 */
export function sampleOutcome(sample: SampleReport): SampleOutcome {
  if (!sample.available) return 'skipped';
  if (sample.engineStatus === 'unavailable') return 'unavailable';
  if (sample.engineStatus === 'error') return 'failed';
  const compared = sample.pages.filter(
    (page) => page.status !== 'skipped' && page.status !== 'reference-missing',
  );
  if (compared.length === 0) return 'skipped';
  return compared.some((page) => page.status !== 'pass') ? 'failed' : 'passed';
}

/**
 * 计算报告汇总。
 *
 * @param samples 样本结果。
 * @param durationMs 总耗时，ms。
 * @returns 汇总计数。
 */
export function computeSummary(samples: readonly SampleReport[], durationMs: number): GoldenSummary {
  const summary: GoldenSummary = {
    samples: samples.length,
    samplesPassed: 0,
    samplesFailed: 0,
    samplesSkipped: 0,
    samplesUnavailable: 0,
    pages: 0,
    pagesPassed: 0,
    pagesFailed: 0,
    pagesSkipped: 0,
    durationMs,
  };
  for (const sample of samples) {
    const outcome = sampleOutcome(sample);
    if (outcome === 'passed') summary.samplesPassed += 1;
    else if (outcome === 'failed') summary.samplesFailed += 1;
    else if (outcome === 'unavailable') summary.samplesUnavailable += 1;
    else summary.samplesSkipped += 1;

    for (const page of sample.pages) {
      summary.pages += 1;
      if (page.status === 'pass') summary.pagesPassed += 1;
      else if (page.status === 'skipped' || page.status === 'reference-missing' || page.status === 'engine-unavailable') {
        summary.pagesSkipped += 1;
      } else summary.pagesFailed += 1;
    }
  }
  return summary;
}

/**
 * 写入 JSON 与 HTML 报告。
 *
 * @param artifactsDir 产物目录绝对路径。
 * @param report 报告。
 * @returns 两个输出路径。
 */
export function writeReport(artifactsDir: string, report: GoldenReport): ReportPaths {
  mkdirSync(artifactsDir, { recursive: true });
  const jsonPath = join(artifactsDir, 'report.json');
  const htmlPath = join(artifactsDir, 'report.html');
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(htmlPath, renderHtml(report), 'utf8');
  return { jsonPath, htmlPath };
}

/** HTML 转义。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 状态对应的颜色。 */
function statusColor(status: string): string {
  if (status === 'pass') return '#1a7f37';
  if (status === 'skipped' || status === 'reference-missing') return '#8a6d3b';
  if (status === 'engine-unavailable') return '#6c6c6c';
  return '#c62828';
}

/** 格式化数字（null → `-`）。 */
function fmt(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return value.toFixed(digits);
}

/** 渲染容差表。 */
function renderTolerance(tolerance: Tolerance): string {
  return `<table class="kv"><tbody>
    <tr><th>版式 bbox 容差</th><td>${tolerance.layoutMm} mm（或 1 设备像素，取较宽者）</td></tr>
    <tr><th>页面尺寸容差</th><td>${tolerance.sizeMm} mm（或 1 设备像素，取较宽者）</td></tr>
    <tr><th>关键色 ΔE2000</th><td>≤ ${tolerance.colorDeltaE}</td></tr>
    <tr><th>关键色占比差</th><td>≤ ${(tolerance.colorCoverageDelta * 100).toFixed(1)}%</td></tr>
    <tr><th>抗锯齿边缘</th><td>Sobel 梯度 &gt; ${tolerance.aaEdgeThreshold}（含 1 px 膨胀，不参与差异）</td></tr>
    <tr><th>像素差</th><td>pixelmatch threshold=${tolerance.pixelmatchThreshold}（辅助指标）</td></tr>
  </tbody></table>`;
}

/** 渲染单页行。 */
function renderPageRow(sample: SampleReport, pageIndex: number): string {
  const page = sample.pages[pageIndex]!;
  const links: string[] = [];
  if (page.enginePng) links.push(`<a href="${escapeHtml(page.enginePng)}">engine</a>`);
  if (page.referencePng) links.push(`<a href="${escapeHtml(page.referencePng)}">pdf-ref</a>`);
  if (page.baselinePng) links.push(`<a href="${escapeHtml(page.baselinePng)}">baseline</a>`);
  if (page.diffPng) links.push(`<a href="${escapeHtml(page.diffPng)}">diff</a>`);
  const metrics = page.metrics;
  const warningText = page.warnings.map((warning) => `${warning.code}: ${warning.message}`).join('\n');
  return `<tr>
    <td>${page.page}</td>
    <td style="color:${statusColor(page.status)};font-weight:600">${escapeHtml(page.status)}</td>
    <td>${page.width ?? '-'}×${page.height ?? '-'}</td>
    <td>${metrics ? fmt(metrics.layoutDeltaMm) : '-'}</td>
    <td>${metrics ? fmt(metrics.keyColorMaxDE, 2) : '-'}</td>
    <td>${metrics ? fmt(metrics.ssim, 4) : '-'}</td>
    <td>${metrics ? (metrics.pixelDiffRatio * 100).toFixed(3) + '%' : '-'}</td>
    <td>${links.join(' · ') || '-'}</td>
    <td class="warn" title="${escapeHtml(warningText)}">${page.warnings.length || '-'}</td>
    <td>${page.error ? escapeHtml(`${page.error.code ?? ''} ${page.error.message}`) : '-'}</td>
  </tr>`;
}

/** 渲染单样本区块。 */
function renderSample(sample: SampleReport): string {
  const outcome = sampleOutcome(sample);
  const warnings = sample.warnings
    .map((warning) => `<li><code>${escapeHtml(warning.code)}</code> ${escapeHtml(warning.message)}</li>`)
    .join('');
  return `<section class="sample" id="sample-${escapeHtml(sample.name)}">
    <h2>${escapeHtml(sample.name)}
      <span class="badge" style="background:${statusColor(outcome === 'passed' ? 'pass' : outcome)}">${outcome}</span>
      <span class="badge prio">${sample.priority}</span>
    </h2>
    <p class="meta">
      groups: ${sample.groups.map(escapeHtml).join(', ') || '-'} ·
      available: ${sample.available ? 'yes' : 'no'}${sample.optional ? ' (optional)' : ''} ·
      PDF pages: ${sample.pdfPages ?? '-'} · engine pages: ${sample.ofdPages ?? '-'} ·
      fonts: ${sample.fontEntries}${sample.embeddedFonts ? ' (embedded)' : ''} ·
      images: ${sample.imageEntries} · jb2: ${sample.jb2Entries} ·
      open: ${fmt(sample.openMs, 1)} ms · total: ${fmt(sample.totalMs, 1)} ms
    </p>
    ${sample.notes.length > 0 ? `<p class="notes">${sample.notes.map(escapeHtml).join('<br>')}</p>` : ''}
    ${warnings ? `<details><summary>warnings（字体缺失 ${sample.fontMissingCount}）</summary><ul>${warnings}</ul></details>` : ''}
    ${
      sample.pages.length > 0
        ? `<table class="pages"><thead><tr>
            <th>page</th><th>status</th><th>px</th><th>bbox Δmm</th><th>key ΔE</th><th>SSIM</th><th>pixel diff</th><th>images</th><th>warn</th><th>error</th>
          </tr></thead><tbody>${sample.pages.map((_, index) => renderPageRow(sample, index)).join('')}</tbody></table>`
        : '<p class="notes">无页面结果（未渲染/已跳过）。</p>'
    }
  </section>`;
}

/**
 * 生成单文件 HTML 报告。
 *
 * @param report 报告。
 * @returns HTML 文本。
 */
export function renderHtml(report: GoldenReport): string {
  const summary = report.summary;
  const samples = report.samples
    .slice()
    .sort((a, b) => a.priority.localeCompare(b.priority) || a.name.localeCompare(b.name))
    .map(renderSample)
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>OFD 黄金图报告 · ${escapeHtml(report.createdAt)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, "Segoe UI", "Noto Sans CJK SC", sans-serif; margin: 24px; color: #1f2328; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  h2 { font-size: 16px; margin: 24px 0 8px; display: flex; gap: 8px; align-items: center; }
  .meta { color: #57606a; font-size: 12px; margin: 4px 0 8px; }
  .notes { color: #8a6d3b; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { border: 1px solid #d0d7de; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f6f8fa; }
  .kv { width: auto; margin: 8px 0 16px; }
  .kv th { width: 180px; }
  .cards { display: flex; gap: 12px; flex-wrap: wrap; margin: 12px 0; }
  .card { border: 1px solid #d0d7de; border-radius: 6px; padding: 10px 14px; min-width: 110px; }
  .card b { display: block; font-size: 20px; }
  .badge { color: #fff; border-radius: 10px; padding: 1px 8px; font-size: 11px; font-weight: 600; }
  .badge.prio { background: #57606a; }
  .warn { cursor: help; }
  code { font-size: 11px; }
  details { margin: 6px 0; }
  .sample { border-top: 1px solid #d8dee4; padding-top: 8px; }
</style>
</head>
<body>
<h1>OFD 黄金图报告</h1>
<p class="meta">
  kind=${escapeHtml(report.kind)} · mode=${escapeHtml(report.mode)} · DPI=${report.dpi} ·
  created=${escapeHtml(report.createdAt)} · node=${escapeHtml(report.environment.node)} ·
  platform=${escapeHtml(report.environment.platform)}/${escapeHtml(report.environment.arch)}
</p>
<div class="cards">
  <div class="card"><b>${summary.samplesPassed}/${summary.samples}</b>样本通过</div>
  <div class="card"><b>${summary.pagesPassed}/${summary.pages}</b>页通过</div>
  <div class="card"><b>${summary.samplesFailed}</b>样本失败</div>
  <div class="card"><b>${summary.samplesUnavailable}</b>引擎不可用</div>
  <div class="card"><b>${summary.samplesSkipped}</b>跳过</div>
  <div class="card"><b>${(summary.durationMs / 1000).toFixed(1)} s</b>总耗时</div>
</div>
<h2>容差口径</h2>
${renderTolerance(report.tolerance)}
${samples}
</body>
</html>`;
}