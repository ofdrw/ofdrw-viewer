/**
 * 三种适配层共用的命名/解析规则与入口契约。
 */
import { describe, expect, it } from 'vitest';
import {
  VIEWER_EVENT_BRIDGES,
  isSidebarView,
  isTheme,
  isZoomMode,
  mergeFeatures,
  readLayerPanelAttribute,
  readLayerPanelOptions,
  readScaleAttribute,
  readSidebarAttribute,
  readSupersampleAttribute,
  toDomEventName,
  toRotation,
} from '../../../src/component/support';



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

  it('读取 supersample 属性：接受预设名与 1..4 倍率，拒绝其他值', () => {
    const element = document.createElement('div');
    // 未配置时交给核心取默认预设。
    expect(readSupersampleAttribute(element)).toBeUndefined();

    for (const preset of ['off', 'auto', 'high', 'max']) {
      element.setAttribute('supersample', preset);
      expect(readSupersampleAttribute(element)).toBe(preset);
    }

    element.setAttribute('supersample', ' high ');
    expect(readSupersampleAttribute(element)).toBe('high');

    element.setAttribute('supersample', '2');
    expect(readSupersampleAttribute(element)).toBe(2);

    // 超出 1..4 或无法解析时不下发，避免把非法值传给核心。
    for (const invalid of ['0', '5', '1.5x', '', 'ultra']) {
      element.setAttribute('supersample', invalid);
      expect(readSupersampleAttribute(element)).toBeUndefined();
    }
  });

  it('sidebar 属性接受 attachments，与核心视图清单保持一致', () => {
    const element = document.createElement('div');
    element.setAttribute('sidebar', 'attachments');
    // 适配层复用 state.ts 的 SIDEBAR_VIEWS，不再维护第二份白名单。
    expect(readSidebarAttribute(element)).toBe('attachments');
    element.setAttribute('sidebar', 'none');
    expect(readSidebarAttribute(element)).toBeNull();
    element.setAttribute('sidebar', 'unknown-view');
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

  it('sidebar="layers" 作为合法视图下发', () => {
    const element = document.createElement('ofd-viewer');
    element.setAttribute('sidebar', 'layers');
    expect(readSidebarAttribute(element)).toBe('layers');
    expect(isSidebarView('layers')).toBe(true);
  });

  it('layer-panel 属性解析开关与默认可见性', () => {
    const element = document.createElement('ofd-viewer');
    expect(readLayerPanelAttribute(element)).toBeUndefined();
    expect(readLayerPanelOptions(element)).toBeUndefined();

    element.setAttribute('layer-panel', 'disabled');
    expect(readLayerPanelAttribute(element)).toEqual({ disabled: true });
    expect(readLayerPanelOptions(element)).toEqual({ disabled: true });

    element.setAttribute('layer-panel', 'enabled:false,hide:background+annotations,show:body');
    expect(readLayerPanelAttribute(element)).toEqual({
      enabled: false,
      defaultVisibility: { background: false, annotations: false, body: true },
    });

    element.setAttribute('layer-panel', 'disabled:false,off');
    expect(readLayerPanelAttribute(element)).toEqual({ enabled: false, disabled: false });
  });
});
