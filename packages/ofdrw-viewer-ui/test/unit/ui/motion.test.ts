/**
 * 弹出层打开动效契约：统一时长/缓动、DOM 动画类与 reduced-motion 覆盖。
 *
 * jsdom 不执行 CSS 动画，因此这里同时断言生成的 DOM 类名和纯文本 CSS 规则。
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupShells, createShell } from './helpers';

const stylePath = resolve(process.cwd(), 'src/style.css');

/** 读取样式文本。 */
async function loadStyle(): Promise<string> {
  return readFile(stylePath, 'utf8');
}

afterEach(() => {
  cleanupShells();
});

describe('弹出层动效 CSS 契约', () => {
  it('统一使用 180ms ease-out 时长变量，仅做入场', async () => {
    const css = await loadStyle();
    expect(css).toContain('--ofd-motion-duration: 180ms');
    expect(css).toContain('只做入场，不做退出动画');

    const rules: ReadonlyArray<readonly [string, string]> = [
      ['.ofd-dialog', 'ofd-dialog-in'],
      ['.ofd-dialog__backdrop', 'ofd-fade-in'],
      ['.ofd-signature-popover--in', 'ofd-popover-in'],
      ['.ofd-more-menu--open', 'ofd-menu-in'],
      ['.ofd-viewer__findbar:not([hidden])', 'ofd-findbar-in'],
      ['.ofd-toast', 'ofd-toast-in'],
    ];
    for (const [selector, animation] of rules) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(css).toMatch(
        new RegExp(
          `${escaped}\\s*\\{[^}]*animation:\\s*${animation} var\\(--ofd-motion-duration, 180ms\\) ease-out;`,
        ),
      );
    }
    expect(css).toMatch(
      /\.ofd-viewer__sidebar\[data-mode='overlay'\]\[data-open='true'\],[\s\S]*?animation:\s*ofd-sidebar-in var\(--ofd-motion-duration, 180ms\) ease-out;/,
    );
    expect(css).not.toContain('animation: ofd-dialog-in 150ms');
    expect(css).not.toContain('animation: ofd-fade-in 100ms');
  });

  it('对话框上移、菜单缩放与浮层轻移均无回弹关键帧', async () => {
    const css = await loadStyle();
    expect(css).toMatch(
      /@keyframes ofd-dialog-in\s*\{[\s\S]*?translate\(-50%, calc\(-50% \+ 6px\)\)[\s\S]*?translate\(-50%, -50%\)/,
    );
    expect(css).toMatch(
      /@keyframes ofd-popover-in\s*\{[\s\S]*?translateY\(4px\)[\s\S]*?translateY\(0\)/,
    );
    expect(css).toMatch(
      /@keyframes ofd-menu-in\s*\{[\s\S]*?scale\(0\.96\)[\s\S]*?scale\(1\)/,
    );
    expect(css).toMatch(
      /@keyframes ofd-toast-in\s*\{[\s\S]*?translateY\(6px\)[\s\S]*?translateY\(0\)/,
    );
    // 所有新增关键帧只出现 from/to，不包含会回弹的百分比中间帧。
    const motionKeyframes = [
      'ofd-dialog-in',
      'ofd-findbar-in',
      'ofd-popover-in',
      'ofd-menu-in',
      'ofd-toast-in',
    ];
    for (const name of motionKeyframes) {
      const block = new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css)?.[1];
      expect(block).toBeDefined();
      expect(block).not.toMatch(/\n\s*\d+%\s*\{/);
    }
  });

  it('更多菜单按展开方向设置 transform-origin', async () => {
    const css = await loadStyle();
    expect(css).toMatch(
      /\.ofd-more-menu--open\s*\{[^}]*transform-origin:\s*top right;/,
    );
    expect(css).toMatch(
      /\.ofd-more-menu--open\[data-placement='above'\]\s*\{[^}]*transform-origin:\s*bottom right;/,
    );
  });

  it('reduced-motion 显式关闭新增动画（含 portal 到根节点外的回退）', async () => {
    const css = await loadStyle();
    const block = /@media \(prefers-reduced-motion: reduce\) \{\s*\.ofd-dialog,[\s\S]*?\.ofd-toast\s*\{[^}]*animation:\s*none !important;/.exec(
      css,
    );
    expect(block).not.toBeNull();
    for (const selector of [
      '.ofd-dialog,',
      '.ofd-dialog__backdrop,',
      '.ofd-signature-popover,',
      '.ofd-more-menu,',
      '.ofd-viewer__findbar,',
      '.ofd-viewer__sidebar,',
      '.ofd-viewer__sidebar-mask,',
      '.ofd-toast',
    ]) {
      expect(block![0]).toContain(selector);
    }
  });
});

describe('弹出层动效 DOM 契约', () => {
  it('对话框遮罩与内容、Toast 层使用统一动画类', () => {
    const { shell } = createShell({ width: 1280, state: { pageCount: 3 } });
    const dialog = shell.openDialog({
      name: 'documentProperties',
      title: '文档属性',
      content: '内容',
      actions: [{ label: '关闭' }],
    });
    expect(dialog.classList.contains('ofd-dialog')).toBe(true);
    expect(dialog.parentElement?.querySelector('.ofd-dialog__backdrop')).not.toBeNull();

    shell.showToast('已复制', { durationMs: 0 });
    const toast = shell.elements.toastLayer.querySelector<HTMLElement>('.ofd-toast');
    expect(toast).not.toBeNull();
    expect(shell.elements.toastLayer.hidden).toBe(false);
  });

  it('更多菜单打开时加动画类并标记展开方向，关闭即移除；焦点不受影响', () => {
    const { shell } = createShell({ width: 400, state: { pageCount: 10 } });
    const more = shell.elements.toolbar.querySelector<HTMLButtonElement>(
      '[data-ofd-control="more"]',
    )!;
    more.focus();
    more.click();
    const menu = shell.root.querySelector<HTMLElement>('.ofd-more-menu')!;
    expect(menu.hidden).toBe(false);
    expect(menu.classList.contains('ofd-more-menu--open')).toBe(true);
    expect(menu.dataset.placement).toBe('below');
    expect(menu.contains(document.activeElement)).toBe(true);

    menu.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(menu.hidden).toBe(true);
    expect(menu.classList.contains('ofd-more-menu--open')).toBe(false);
    expect(document.activeElement).toBe(more);
  });

  it('侧栏 overlay 打开时同步 data-open，供滑入动画选择器命中', () => {
    const { shell } = createShell({ width: 900, state: { pageCount: 10 } });
    expect(shell.sidebar.layout).not.toBe('inline');
    shell.update({ sidebarView: 'thumbnails' });
    expect(shell.elements.sidebar.dataset.open).toBe('true');
    expect(shell.elements.sidebarMask.hidden).toBe(false);
  });
});