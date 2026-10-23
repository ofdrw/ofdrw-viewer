/**
 * 样式契约：主题变量、断点、层级与独立 CSS 入口。
 *
 * 纯文本断言，避免 jsdom 不执行布局/媒体查询带来的盲区。
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// vitest 由 pnpm -C packages/ofdrw-viewer-ui 启动，工作目录即包根目录。
const packageRoot = process.cwd();
const stylePath = resolve(packageRoot, 'src/style.css');
const packagePath = resolve(packageRoot, 'package.json');

async function loadStyle(): Promise<string> {
  return readFile(stylePath, 'utf8');
}

describe('style.css 主题与布局契约', () => {
  it('工具栏 32/44、侧栏 200、四档断点', async () => {
    const css = await loadStyle();
    expect(css).toContain('--ofd-toolbar-height: 32px');
    expect(css).toContain('--ofd-sidebar-width: 200px');
    expect(css).toContain("--ofd-toolbar-height: 44px");
    expect(css).toContain("[data-viewport='compact']");
    expect(css).toContain("[data-viewport='mobile']");
    expect(css).toContain("[data-viewport='narrow']");
    expect(css).toContain('@media (max-width: 1023px)');
    expect(css).toContain('@media (max-width: 767px)');
    expect(css).toContain('@media (max-width: 479px)');
    expect(css).toContain('@media (pointer: coarse)');
    expect(css).toContain('--ofd-touch-target: 44px');
  });

  it('提供 light/dark/auto 与外壳层级变量', async () => {
    const css = await loadStyle();
    expect(css).toContain("[data-theme='dark']");
    expect(css).toContain("[data-theme='auto']");
    expect(css).toContain('prefers-color-scheme: dark');
    expect(css).toContain('prefers-contrast: more');
    expect(css).toContain('--ofd-scrim');
    expect(css).toContain('--ofd-menu-shadow');
    expect(css).toContain('--ofd-dialog-shadow');
    expect(css).toContain('--ofd-toast-shadow');
    expect(css).toContain('--ofd-sidebar-shadow');
    expect(css).toContain('--ofd-z-findbar');
    expect(css).toContain('--ofd-z-dialog');
    expect(css).toContain('--ofd-z-toast');
    expect(css).toContain('.ofd-viewer__sidebar-mask');
  });

  it('查找栏/对话框/Toast 与 a11y 样式存在', async () => {
    const css = await loadStyle();
    expect(css).toContain('.ofd-viewer__findbar');
    expect(css).toContain('.ofd-viewer__dialog-layer');
    expect(css).toContain('.ofd-viewer__toast-layer');
    expect(css).toContain('.ofd-dialog__backdrop');
    expect(css).toContain('.ofd-more-menu');
    expect(css).toContain('.ofd-sr-only');
    expect(css).toContain('.ofd-viewer [hidden]');
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(css).toContain('.ofd-sidebar__resizer');
    expect(css).toContain('.ofd-sidebar__panel');
    expect(css).toContain('ofd-sidebar-in');
    expect(css).toContain('prefers-reduced-motion: reduce');
  });

  it('输入占位符使用次要文本色且不透明', async () => {
    const css = await loadStyle();
    expect(css).toMatch(
      /\.ofd-input::placeholder\s*\{[^}]*color:\s*var\(--ofd-text-secondary\);[^}]*opacity:\s*1;/s,
    );
    // 正常输入文字仍使用主文本色，不受占位符规则影响。
    expect(css).toMatch(/\.ofd-input,[\s\S]*?color:\s*var\(--ofd-text\);/);
  });

  it('输出对话框 hover/focus 显式着色且不依赖 !important', async () => {
    const css = await loadStyle();
    expect(css).toContain('--ofd-accent-hover: #0a58b5');
    expect(css).toContain('--ofd-accent-hover: #8cbcff');
    expect(css).toMatch(
      /\.ofd-dialog__action--primary:hover,\s*\.ofd-dialog__action--primary:focus-visible\s*\{[^}]*background:\s*var\(--ofd-accent-hover\);/s,
    );
    expect(css).toMatch(
      /\.ofd-select option:checked\s*\{[^}]*background-color:\s*var\(--ofd-accent\);/s,
    );
    expect(css).toMatch(
      /\.ofd-output-check:hover,[\s\S]*?background:\s*var\(--ofd-hover-bg\);/s,
    );
    expect(css).toMatch(
      /\.ofd-output-quality\s*\{[^}]*accent-color:\s*var\(--ofd-accent\);/s,
    );
    expect(css).not.toMatch(
      /\.ofd-output-(?:form|check|quality)[^{]*\{[^}]*!important/s,
    );
  });

  it('组件规则不出现硬编码颜色（颜色集中在 --ofd-* 变量）', async () => {
    const css = await loadStyle();
    const offenders = css
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => /#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(line))
      .filter(({ line }) => !line.includes('--ofd-'))
      .filter(({ line }) => !line.startsWith('*') && !line.startsWith('/*'));
    expect(offenders).toEqual([]);
  });

  it('CSS 作为独立子路径导出', async () => {
    const pkg = JSON.parse(await readFile(packagePath, 'utf8')) as {
      exports: Record<string, unknown>;
    };
    expect(pkg.exports['./style.css']).toBe('./dist/style.css');
  });
});