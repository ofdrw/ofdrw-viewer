/**
 * 加载视觉样式契约：token、keyframes、reduced-motion 与公开事件冻结。
 *
 * 与既有 `style.test.ts` 一致读取源码文本，避免 jsdom 不计算布局/媒体查询；
 * 缩略图骨架样式由导航模块内联注入，单独读取 `views/shared.ts`。
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = process.cwd();

/**
 * 读取包内源码文本。
 *
 * @param relativePath 相对包根的路径。
 * @returns 文件内容。
 */
async function readPackageFile(relativePath: string): Promise<string> {
  return readFile(resolve(packageRoot, relativePath), 'utf8');
}

describe('加载视觉样式契约', () => {
  it('定义骨架/旋转环 token 并覆盖 light、dark 与 auto 暗色', async () => {
    const css = await readPackageFile('src/style.css');
    expect(css).toContain('--ofd-loading-skeleton:');
    expect(css).toContain('--ofd-loading-skeleton-strong:');
    expect(css).toContain('--ofd-loading-spinner: var(--ofd-accent)');
    expect(css).toContain('--ofd-loading-spinner-size: 20px');
    expect(css).toContain('--ofd-loading-spinner-width: 2px');
    expect(css).toContain('--ofd-loading-ring-size: 32px');
    // 明色默认 + data-theme=dark + auto 暗色各覆盖一次。
    expect([...css.matchAll(/--ofd-loading-skeleton:/g)].length).toBeGreaterThanOrEqual(3);
    expect([...css.matchAll(/--ofd-loading-skeleton-strong:/g)].length).toBeGreaterThanOrEqual(3);
    expect([...css.matchAll(/--ofd-loading-spinner:/g)].length).toBeGreaterThanOrEqual(3);
  });

  it('提供旋转/骨架脉冲 keyframes 并被 loading 元素引用', async () => {
    const css = await readPackageFile('src/style.css');
    expect(css).toMatch(/@keyframes\s+ofd-loading-spin\s*\{/);
    expect(css).toMatch(/@keyframes\s+ofd-loading-skeleton-pulse\s*\{/);
    expect(css).toMatch(
      /\.ofd-page__loading-spinner\s*\{[^}]*animation:\s*ofd-loading-spin\s+900ms\s+linear\s+infinite;/s,
    );
    expect(css).toMatch(
      /\.ofd-viewer__loading-ring\s*\{[^}]*animation:\s*ofd-loading-spin\s+900ms\s+linear\s+infinite;/s,
    );
    expect(css).toMatch(
      /\.ofd-page__loading-skeleton::after\s*\{[^}]*animation:\s*ofd-loading-skeleton-pulse/s,
    );
  });

  it('首次骨架/重渲染遮罩与 150/200/120 ms 计时样式齐全', async () => {
    const css = await readPackageFile('src/style.css');
    expect(css).toMatch(/\.ofd-page__loading\[data-variant='skeleton'\]\s*\{[^}]*background:\s*transparent;/s);
    expect(css).toMatch(/\.ofd-page__loading\[data-variant='overlay'\]\s+\.ofd-page__loading-skeleton\s*\{[^}]*display:\s*none;/s);
    expect(css).toMatch(/\.ofd-page__loading\[data-fading='true'\]\s*\{[^}]*opacity:\s*0;/s);
    expect(css).toMatch(/\.ofd-page__loading\s*\{[^}]*transition:\s*opacity\s+120ms\s+linear;/s);
    expect(css).toMatch(/\.ofd-viewer__loading\s*\{[^}]*transition:\s*opacity\s+150ms\s+linear;/s);
    expect(css).toMatch(/\.ofd-viewer__loading\[data-fading='true'\]\s*\{[^}]*opacity:\s*0;/s);
    // 页面遮罩阻断点击/选择，但不拦截滚动。
    expect(css).toMatch(/\.ofd-page__loading\s*\{[^}]*cursor:\s*progress;[^}]*user-select:\s*none;/s);
    expect(css).not.toMatch(/\.ofd-page__loading\s*\{[^}]*touch-action:\s*none;/s);
  });

  it('prefers-reduced-motion 关闭脉冲/旋转/淡出；print 隐藏 loading', async () => {
    const css = await readPackageFile('src/style.css');
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.ofd-page__loading,[\s\S]*?\.ofd-viewer__loading-ring\s*\{[^}]*animation:\s*none\s*!important;[^}]*transition:\s*none\s*!important;/);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.ofd-page__loading-skeleton::after\s*\{[^}]*opacity:\s*0;/);
    expect(css).toMatch(/@media\s*print\s*\{[\s\S]*?\.ofd-viewer__loading,[\s\S]*?\.ofd-page__loading,[\s\S]*?display:\s*none\s*!important;/);
  });

  it('缩略图骨架复用 loading token，带脉冲动画与 reduced-motion 降级', async () => {
    const shared = await readPackageFile('src/views/shared.ts');
    expect(shared).toContain('.ofd-thumbnail__skeleton');
    expect(shared).toContain('background-color: var(--ofd-loading-skeleton');
    expect(shared).toContain('var(--ofd-loading-skeleton-strong');
    expect(shared).toMatch(/animation:\s*ofd-nav-skeleton-pulse\s+1\.6s\s+ease-in-out\s+infinite/);
    expect(shared).toMatch(/@keyframes\s+ofd-nav-skeleton-pulse\s*\{/);
    expect(shared).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.ofd-thumbnail__skeleton\s*\{\s*animation:\s*none;/s);
    expect(shared).toContain(".ofd-thumbnail[data-state='failed']");
    expect(shared).toContain('.ofd-thumbnail__fallback[hidden]');
  });

  it('未新增公开 UI 事件：ViewerEventMap 维持既有事件集合', async () => {
    const types = await readPackageFile('src/types.ts');
    const block = types.match(/export type ViewerEventMap = \{([\s\S]*?)\n\};/);
    expect(block).not.toBeNull();
    const keys = [...block![1]!.matchAll(/^\s{2}([A-Za-z]+):/gm)].map((match) => match[1]);
    expect(keys).toEqual([
      'documentopen',
      'documentclose',
      'pagechanging',
      'pagerendered',
      'pagesloaded',
      'scalechanging',
      'rotationchanging',
      'sidebarviewchanged',
      'findstart',
      'findmatches',
      'findcurrent',
      'selectionchange',
      'signatureclick',
      'verificationcompleted',
      'printstart',
      'printprogress',
      'printend',
      'exportprogress',
      'warning',
      'error',
      'featureschange',
      'statechange',
    ]);
    // loading 只作为视觉状态，不暴露独立公开事件。
    expect(keys.some((key) => /loading/i.test(key))).toBe(false);
  });
});