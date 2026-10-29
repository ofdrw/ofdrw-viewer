/**
 * 黑体兜底夹具回归：验证「只声明黑体、不内嵌字体」的文档在有无宿主字体时的渲染结果。
 *
 * 夹具由 scripts/make-black-font-fixture.mjs 生成（恒定字节，可提交）；
 * 仓库中的真实样本虽声明黑体但页面未引用，无法覆盖本场景。
 * 字体取自 demo/public/fonts（随站点分发的本地兜底字体）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_FONT_ALIASES } from '../../src/font/aliases';
import type { OFDWarning } from '../../src/warnings';
import { openTestDocument, renderPage } from './helpers';

/** 仓库根目录。 */
const REPO = join(__dirname, '../../../..');
/** 黑体夹具（由 scripts/make-black-font-fixture.mjs 生成）。 */
const FIXTURE = join(REPO, 'demo/test/fixtures/black-font-only.ofd');
/** 站点字体目录。 */
const FONT_DIR = join(REPO, 'demo/public/fonts');

/**
 * 按主干名查找站点分发的带哈希字体文件。
 *
 * 字体文件名形如 `<主干>.<sha256前8位>.woff2`，每次重新生成后哈希会变，
 * 因此这里按前缀匹配而不是写死文件名。
 *
 * @param stem 文件名主干，例如 `source-han-sans-sc`
 * @returns 字体文件绝对路径
 */
function siteFont(stem: string): string {
  const pattern = new RegExp(`^${stem}\\.[0-9a-f]{8}\\.woff2$`);
  const match = readdirSync(FONT_DIR).find((name) => pattern.test(name));
  if (!match) throw new Error(`站点字体缺失：${stem}.*.woff2（请运行 scripts/build-demo-fonts.py）`);
  return join(FONT_DIR, match);
}

async function darkPixels(fonts: Record<string, unknown>, label: string) {
  const warnings: OFDWarning[] = [];
  const doc = await openTestDocument(readFileSync(FIXTURE) as unknown as Uint8Array, {
    ...(fonts as object),
    aliases: [...DEFAULT_FONT_ALIASES, ['黑体', 'simhei', 'heiti', 'notosanscjksc', '思源黑体']],
    onWarning: (warning: OFDWarning) => warnings.push(warning),
  } as never);
  try {
    const page = await doc.getPage(0);
    const { canvas, viewport } = await renderPage(page, { dpi: 96 });
    const w = Math.max(1, Math.ceil(viewport.width));
    const h = Math.max(1, Math.ceil(viewport.height));
    // 宿主 canvas 提供原生 getImageData；引擎侧类型只声明了渲染所需子集，这里按实际实现取值。
    // 该测试运行在 Node（无 DOM 类型），故用最小结构类型描述所需的读取能力。
    const context2d = canvas.canvas.getContext('2d') as unknown as {
      getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
    };
    const data = context2d.getImageData(0, 0, w, h).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 128) dark += 1;
    const codes = [...new Set(warnings.map((x) => x.code))];
    console.log(label, '| dark=', dark, '| warnings=', codes);
    return { dark, warnings: codes };
  } finally {
    await doc.close();
  }
}

describe('黑体兜底夹具（demo/test/fixtures/black-font-only.ofd）', () => {
  it('无字体时空白；思源黑体与思源宋体都能兜底', async () => {
    const sans = readFileSync(siteFont('source-han-sans-sc'));
    const serif = readFileSync(siteFont('source-han-serif-sc'));
    const none = await darkPixels({}, '无字体');
    expect(none.dark).toBe(0);
    expect(none.warnings).toContain('W_FONT_MISSING');
    const a = await darkPixels({ supplementaryFonts: [{ data: sans, family: 'Noto Sans CJK SC' }] }, '思源黑体');
    expect(a.dark).toBeGreaterThan(0);
    expect(a.warnings).not.toContain('W_FONT_MISSING');
    const b = await darkPixels({ defaultFonts: [{ data: serif, family: 'Noto Serif CJK SC' }] }, '思源宋体');
    expect(b.dark).toBeGreaterThan(0);
  }, 120000);
});
