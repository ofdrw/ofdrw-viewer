/**
 * 「更多」菜单的排版分组（滚动方式 / 视图模式）与文档属性入口。
 *
 * 覆盖：两组标题与图标、勾选状态、点击发出 layout.set 命令、文档属性仅在菜单中。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTranslator } from '../../../src/i18n';
import { MoreMenu } from '../../../src/ui/more-menu';
import { resolveFeatureStates } from '../../../src/features';
import { createFindState } from '../../../src/state';
import type { LayoutConfig } from '../../../src/page-layout';
import type { UIShellCommand, UIShellViewState } from '../../../src/ui/types';

/** 当前菜单实例；每个用例结束销毁。 */
let menu: MoreMenu | null = null;

afterEach(() => {
  menu?.destroy();
  menu = null;
  document.body.innerHTML = '';
});

/** 构造视图状态。 */
function makeState(layout: LayoutConfig = { direction: 'page', viewMode: 'single' }): UIShellViewState {
  return {
    pageNumber: 1,
    pageCount: 10,
    scale: 1,
    zoomMode: 'auto',
    rotation: 0,
    sidebarView: null,
    fullscreen: false,
    layout,
    find: createFindState(),
    theme: 'auto',
    locale: 'zh-CN',
  };
}

/**
 * 创建菜单。
 *
 * @param state 初始视图状态。
 * @param commands 命令收集数组。
 * @returns 菜单实例与根节点。
 */
function createMenu(
  state: UIShellViewState,
  commands: UIShellCommand[],
): { menu: MoreMenu; root: HTMLElement } {
  const root = document.createElement('div');
  root.className = 'ofd-viewer';
  const container = document.createElement('div');
  const button = document.createElement('button');
  container.appendChild(button);
  root.appendChild(container);
  document.body.appendChild(root);
  menu = new MoreMenu({
    button,
    container,
    translator: createTranslator('zh-CN'),
    featureStates: resolveFeatureStates(),
    state,
    onCommand: (command) => commands.push(command),
  });
  return { menu, root };
}

describe('「更多」菜单排版分组', () => {
  it('渲染两个分组标题与四个选项', () => {
    const commands: UIShellCommand[] = [];
    const { root } = createMenu(makeState(), commands);
    const titles = [...root.querySelectorAll('.ofd-more-menu__group-title')].map(
      (element) => element.textContent,
    );
    expect(titles).toEqual(['滚动方式', '视图模式', '文档信息']);
    const ids = [...root.querySelectorAll('[data-ofd-control]')].map((element) =>
      element.getAttribute('data-ofd-control'),
    );
    expect(ids).toEqual(
      expect.arrayContaining([
        'menu-scroll-page',
        'menu-scroll-horizontal',
        'menu-view-single',
        'menu-view-spread',
      ]),
    );
    // 不含已移除的书籍视图。
    expect(ids).not.toContain('menu-layout-two-column-l');
  });

  it('每个排版选项带 SVG 图标', () => {
    const commands: UIShellCommand[] = [];
    const { root } = createMenu(makeState(), commands);
    for (const id of [
      'menu-scroll-page',
      'menu-scroll-horizontal',
      'menu-view-single',
      'menu-view-spread',
    ]) {
      const item = root.querySelector(`[data-ofd-control="${id}"]`);
      expect(item?.querySelector('svg')).not.toBeNull();
    }
  });

  it('滚动方式与视图模式各自勾选当前值', () => {
    const commands: UIShellCommand[] = [];
    const { menu: instance, root } = createMenu(makeState(), commands);
    instance.update(makeState({ direction: 'horizontal', viewMode: 'spread' }));
    const checked = (id: string): string | null =>
      root.querySelector(`[data-ofd-control="${id}"]`)?.getAttribute('aria-checked') ?? null;
    expect(checked('menu-scroll-horizontal')).toBe('true');
    expect(checked('menu-scroll-page')).toBe('false');
    expect(checked('menu-view-spread')).toBe('true');
    expect(checked('menu-view-single')).toBe('false');
  });

  it('点击只提交变化的维度', () => {
    const commands: UIShellCommand[] = [];
    const { menu: instance, root } = createMenu(makeState(), commands);
    instance.open();
    root.querySelector<HTMLButtonElement>('[data-ofd-control="menu-scroll-horizontal"]')!.click();
    expect(commands).toContainEqual({ type: 'layout.set', direction: 'horizontal' });
    root.querySelector<HTMLButtonElement>('[data-ofd-control="menu-view-spread"]')!.click();
    expect(commands).toContainEqual({ type: 'layout.set', viewMode: 'spread' });
    expect(instance.isOpen).toBe(false);
  });

  it('文档属性与关于位于「文档信息」分组下', () => {
    const commands: UIShellCommand[] = [];
    const { root } = createMenu(makeState(), commands);
    const titles = [...root.querySelectorAll('.ofd-more-menu__group-title')];
    const infoTitle = titles.find((element) => element.textContent === '文档信息');
    expect(infoTitle).not.toBeUndefined();
    // 分组内顺序：标题 → 文档属性 → 关于。
    const after: Element[] = [];
    for (let node = infoTitle!.nextElementSibling; node; node = node.nextElementSibling) {
      if (node.classList.contains('ofd-more-menu__group-title')) break;
      after.push(node);
    }
    expect(after.map((element) => element.getAttribute('data-ofd-control'))).toEqual([
      'menu-document-properties',
      'menu-about',
    ]);
    const item = root.querySelector<HTMLButtonElement>(
      '[data-ofd-control="menu-document-properties"]',
    );
    item!.click();
    expect(commands).toContainEqual({ type: 'document.properties' });
  });
});
