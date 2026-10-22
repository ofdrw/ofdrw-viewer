/**
 * 设计边界静态/运行时断言：无 renderRegion、无 Seal.esl 公开依赖、核心不引入 React/Vue。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, expectNoPageErrors, test } from './fixtures';
import { FIXTURES, openViewer } from './support';

test('dist 核心不含 renderRegion/Seal.esl，也不直接依赖 React/Vue', async ({ page, issues }) => {
  const adapterPattern = /^(react|vue)(\.|$)/;
  const files = readdirSync('dist').filter(
    (file) => /\.(js|cjs|mjs)$/.test(file) && !adapterPattern.test(file),
  );
  expect(files.length).toBeGreaterThan(0);
  const bundle = files.map((file) => readFileSync(join('dist', file), 'utf8')).join('\n');
  expect(bundle).not.toContain('renderRegion');
  expect(bundle).not.toContain('Seal.esl');
  expect(bundle).not.toMatch(/from\s+['"]react['"]/);
  expect(bundle).not.toMatch(/from\s+['"]vue['"]/);
  expect(bundle).not.toMatch(/require\(['"]react['"]\)/);
  expect(bundle).not.toMatch(/require\(['"]vue['"]\)/);

  await openViewer(page, FIXTURES.multi);
  const runtime = await page.evaluate(() => {
    const viewer = window.__viewer as unknown as Record<string, unknown>;
    return {
      renderRegion: typeof viewer.renderRegion,
      renderRegionInPrototype: 'renderRegion' in Object.getPrototypeOf(viewer),
    };
  });
  expect(runtime.renderRegion).toBe('undefined');
  expect(runtime.renderRegionInPrototype).toBe(false);
  await expectNoPageErrors(page, issues);
});
