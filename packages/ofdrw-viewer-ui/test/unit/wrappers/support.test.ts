/**
 * 三种适配层共用的命名/解析规则与入口契约。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  VIEWER_EVENT_BRIDGES,
  isSidebarView,
  isTheme,
  isZoomMode,
  mergeFeatures,
  readScaleAttribute,
  readSidebarAttribute,
  toDomEventName,
  toRotation,
} from '../../../src/component/support';

const packageRoot = process.cwd().endsWith('ofdrw-viewer-ui')
  ? `${process.cwd()}/`
  : `${resolve(process.cwd(), 'packages/ofdrw-viewer-ui')}/`;

/**
 * 读取包内文件文本。
 *
 * @param relative 包内相对路径。
 * @returns UTF-8 文本。
 */
function read(relative: string): string {
  return readFileSync(`${packageRoot}${relative}`, 'utf8');
}

describe('wrapper 公共桥接', () => {
  it('核心事件映射为设计约定的 ofd-* 名称', () => {
    expect(toDomEventName('documentopen')).toBe('ofd-document-open');
    expect(toDomEventName('pagechanging')).toBe('ofd-page-change');
    expect(toDomEventName('error')).toBe('ofd-error');
    expect(toDomEventName('local-fonts:change')).toBe('ofd-local-fonts-change');
    expect(VIEWER_EVENT_BRIDGES).toHaveLength(23);
    expect(new Set(VIEWER_EVENT_BRIDGES.map((item) => item.dom)).size).toBe(23);
    for (const item of VIEWER_EVENT_BRIDGES) {
      expect(item.react.startsWith('on')).toBe(true);
      expect(item.vue.includes('_')).toBe(false);
    }
  });

  it('属性解析接受数字/模式并拒绝非法值', () => {
    const element = document.createElement('ofd-viewer');
    element.setAttribute('scale', '1.5');
    expect(readScaleAttribute(element)).toBe(1.5);
    element.setAttribute('scale', 'page-fit');
    expect(readScaleAttribute(element)).toBe('page-fit');
    element.setAttribute('scale', 'bogus');
    expect(readScaleAttribute(element)).toBeUndefined();
    expect(isZoomMode('page-width')).toBe(true);
    expect(isZoomMode('width')).toBe(false);
  });

  it('旋转/侧栏/主题规范化', () => {
    expect(toRotation(90)).toBe(90);
    expect(toRotation(450)).toBe(90);
    expect(toRotation(-90)).toBe(270);
    expect(toRotation(Number.NaN)).toBeUndefined();
    expect(isSidebarView('signatures')).toBe(true);
    expect(isSidebarView('thumbnails')).toBe(true);
    expect(isSidebarView('outline')).toBe(true);
    expect(isSidebarView('bookmarks')).toBe(true);
    // 本轮新增的附件侧栏必须与 SidebarView 联合类型保持一致。
    expect(isSidebarView('attachments')).toBe(true);
    // 已移除的 settings 视图不得再被识别（本机字体开关改放到「关于」对话框）。
    expect(isSidebarView('settings')).toBe(false);
    expect(isSidebarView('print')).toBe(false);
    expect(isSidebarView(null)).toBe(false);
    expect(isTheme('auto')).toBe(true);
    expect(isTheme('sepia')).toBe(false);

    const element = document.createElement('ofd-viewer');
    element.setAttribute('sidebar', 'outline');
    expect(readSidebarAttribute(element)).toBe('outline');
    element.setAttribute('sidebar', '');
    expect(readSidebarAttribute(element)).toBeNull();
    element.removeAttribute('sidebar');
    expect(readSidebarAttribute(element)).toBeUndefined();
  });

  it('读取 attachments 侧栏属性并拒绝未知取值', () => {
    const element = document.createElement('ofd-viewer');
    element.setAttribute('sidebar', 'attachments');
    expect(readSidebarAttribute(element)).toBe('attachments');
    element.setAttribute('sidebar', 'unknown-view');
    expect(readSidebarAttribute(element)).toBeUndefined();
  });

  it('mergeFeatures 不修改入参', () => {
    const current = { print: false };
    const next = mergeFeatures(current, { find: false });
    expect(next).toEqual({ print: false, find: false });
    expect(current).toEqual({ print: false });
  });
});

describe('入口契约', () => {
  it('三个 wrapper 入口都引用公共入口，核心入口不引入框架', () => {
    const reactEntry = read('src/react/index.ts');
    const vueEntry = read('src/vue/index.ts');
    const elementEntry = read('src/component/ofd-viewer-element.ts');
    expect(reactEntry).toContain("'../index'");
    expect(vueEntry).toContain("'../index'");
    expect(elementEntry).toContain("'../index'");

    const coreEntry = read('src/index.ts');
    expect(coreEntry).not.toMatch(/from\s+['"]react/);
    expect(coreEntry).not.toMatch(/from\s+['"]vue/);
  });

  it('Web Component 使用 light DOM 且未引入局部渲染 API', () => {
    const elementEntry = read('src/component/ofd-viewer-element.ts');
    expect(elementEntry).not.toContain('attachShadow');
    expect(elementEntry).not.toContain('renderRegion');
    expect(read('src/react/OFDViewer.tsx')).not.toContain('renderRegion');
    expect(read('src/vue/OFDViewer.ts')).not.toContain('renderRegion');
  });

  it('package.json 暴露 react/vue/element/component 子路径', () => {
    const pkg = JSON.parse(read('package.json')) as {
      exports: Record<string, unknown>;
    };
    for (const subpath of ['./react', './vue', './element', './component', './style.css']) {
      expect(pkg.exports[subpath]).toBeDefined();
    }
  });
});