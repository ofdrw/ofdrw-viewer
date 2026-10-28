/**
 * `<ofd-viewer>` Web Component：属性映射、property、事件与生命周期。
 */
import { replaceChildren } from '../../../src/compat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeViewer } from './mock-viewer';

vi.mock('../../../src/index', async () => {
  const { FakeViewer: Fake } = await import('./mock-viewer');
  return { OFDViewer: Fake };
});

import {
  OFD_VIEWER_TAG,
  OFDViewerElement,
  defineOFDViewerElement,
} from '../../../src/component/ofd-viewer-element';

/** 等待自定义元素生命周期与微任务完成。 */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  FakeViewer.reset();
  defineOFDViewerElement();
  replaceChildren(document.body);
});

afterEach(() => {
  replaceChildren(document.body);
  vi.restoreAllMocks();
});

describe('<ofd-viewer>', () => {
  it('注册标签并使用 light DOM 创建核心实例', async () => {
    expect(customElements.get(OFD_VIEWER_TAG)).toBe(OFDViewerElement);

    const element = document.createElement(OFD_VIEWER_TAG) as OFDViewerElement;
    element.setAttribute('src', 'a.ofd');
    element.setAttribute('page', '2');
    element.setAttribute('scale', '1.25');
    element.setAttribute('rotation', '90');
    element.setAttribute('theme', 'dark');
    element.setAttribute('locale', 'en-US');
    element.setAttribute('sidebar', 'outline');
    element.features = { print: false };
    document.body.append(element);

    const viewer = FakeViewer.instances[0]!;
    expect(element.viewer).toBe(viewer);
    expect(viewer.options.container).toBe(element);
    expect(viewer.options.source).toBe('a.ofd');
    expect(viewer.options.initialPage).toBe(2);
    expect(viewer.options.initialScale).toBe(1.25);
    expect(viewer.options.rotation).toBe(90);
    expect(viewer.options.theme).toBe('dark');
    expect(viewer.options.locale).toBe('en-US');
    expect(viewer.options.sidebar).toBe('outline');
    expect(viewer.options.features).toEqual({ print: false });
    // light DOM：核心 DOM 是元素的子节点，而不是 shadow root。
    expect(element.shadowRoot).toBeNull();
    expect(element.querySelector('.fake-ofd-viewer')).not.toBeNull();
    expect(Object.getOwnPropertyDescriptor(OFDViewerElement.prototype, 'viewer')?.set).toBeUndefined();
    expect((await element.exportOfd())?.filename).toBe('fake.ofd');
  });

  it('supersample 属性在构造时下发给核心，变更后按新值重建实例', async () => {
    const element = document.createElement(OFD_VIEWER_TAG) as OFDViewerElement;
    element.setAttribute('src', 'a.ofd');
    element.setAttribute('supersample', 'high');
    document.body.append(element);

    const first = FakeViewer.instances[0]!;
    // 该属性只在创建实例时生效：与字体简写属性一样走构造选项。
    expect(first.options.supersample).toBe('high');

    element.setAttribute('supersample', '3');
    await tick();
    const second = FakeViewer.instances.at(-1)!;
    expect(second).not.toBe(first);
    expect(second.options.supersample).toBe(3);

    // 非法值不下发，核心按默认预设处理。
    element.setAttribute('supersample', 'ultra');
    await tick();
    expect(FakeViewer.instances.at(-1)!.options.supersample).toBeUndefined();
  });

  it('sidebar="attachments" 传递给核心而不被静默忽略', async () => {
    const element = document.createElement(OFD_VIEWER_TAG) as OFDViewerElement;
    element.setAttribute('src', 'a.ofd');
    element.setAttribute('sidebar', 'attachments');
    document.body.append(element);

    const viewer = FakeViewer.instances[0]!;
    // 初始 sidebar 属性经 normalizeSidebarView 校验后进入构造选项；
    // 修复前会被判为非法并丢弃为 undefined，导致附件侧栏被静默忽略。
    expect(viewer.options.sidebar).toBe('attachments');

    // 运行期切换到 attachments 也必须下发到核心（先切到别的视图再切回）。
    element.setAttribute('sidebar', 'outline');
    element.setAttribute('sidebar', 'attachments');
    await tick();
    expect(viewer.sidebarCalls).toContain('attachments');
  });

  it('sidebar 既有取值（thumbnails/outline/bookmarks/signatures）仍正常', async () => {
    const element = document.createElement(OFD_VIEWER_TAG) as OFDViewerElement;
    element.setAttribute('src', 'a.ofd');
    document.body.append(element);
    const viewer = FakeViewer.instances[0]!;

    for (const view of ['thumbnails', 'outline', 'bookmarks', 'signatures'] as const) {
      element.setAttribute('sidebar', view);
    }
    await tick();

    expect(viewer.sidebarCalls).toEqual(
      expect.arrayContaining(['thumbnails', 'outline', 'bookmarks', 'signatures']),
    );
  });

  it('非法 sidebar 取值被忽略', async () => {
    const element = document.createElement(OFD_VIEWER_TAG) as OFDViewerElement;
    element.setAttribute('src', 'a.ofd');
    document.body.append(element);
    const viewer = FakeViewer.instances[0]!;
    const before = viewer.sidebarCalls.length;

    element.setAttribute('sidebar', 'not-a-view');
    await tick();

    expect(viewer.sidebarCalls.length).toBe(before);
  });

  it('属性变化映射到实例方法且不重建实例', async () => {
    const element = document.createElement(OFD_VIEWER_TAG) as OFDViewerElement;
    element.setAttribute('src', 'a.ofd');
    document.body.append(element);
    const viewer = FakeViewer.instances[0]!;

    element.setAttribute('page', '3');
    element.setAttribute('scale', 'page-fit');
    element.setAttribute('rotation', '180');
    element.setAttribute('theme', 'light');
    element.setAttribute('locale', 'zh-CN');
    element.setAttribute('sidebar', 'bookmarks');
    element.setAttribute('sidebar', '');
    element.setAttribute('src', 'b.ofd');
    await tick();

    expect(FakeViewer.instances).toHaveLength(1);
    expect(viewer.pageCalls).toContain(3);
    expect(viewer.zoomModeCalls).toContain('page-fit');
    expect(viewer.rotationCalls).toContain(180);
    expect(viewer.themeCalls).toContain('light');
    expect(viewer.localeCalls).toContain('zh-CN');
    expect(viewer.sidebarCalls).toContain('bookmarks');
    expect(viewer.sidebarCalls).toContain(null);
    expect(viewer.openCalls).toContain('b.ofd');
    expect(element.viewer).toBe(viewer);
  });

  it('features property 合并更新，并可通过 setFeatures 调用', () => {
    const element = document.createElement(OFD_VIEWER_TAG) as OFDViewerElement;
    element.setAttribute('src', 'a.ofd');
    document.body.append(element);
    const viewer = FakeViewer.instances[0]!;

    element.features = { find: false };
    expect(viewer.featureCalls.at(-1)).toEqual({ find: false });
    element.setFeatures({ print: false }, { display: 'disable' });
    expect(viewer.featureCalls.at(-1)).toEqual({ print: false });
    expect(element.features).toEqual({ find: false, print: false });
  });

  it('核心事件映射为 ofd-* CustomEvent', () => {
    const element = document.createElement(OFD_VIEWER_TAG) as OFDViewerElement;
    element.setAttribute('src', 'a.ofd');
    document.body.append(element);
    const viewer = FakeViewer.instances[0]!;
    const received: CustomEvent[] = [];
    element.addEventListener('ofd-page-change', (event) => {
      received.push(event as CustomEvent);
    });
    element.addEventListener('ofd-error', (event) => {
      received.push(event as CustomEvent);
    });

    viewer.emit('pagechanging', { pageNumber: 2, previous: 1 });
    viewer.emit('error', { code: 'OFD_OPEN_FAILED', message: 'bad' });

    expect(received).toHaveLength(2);
    expect(received[0]!.type).toBe('ofd-page-change');
    expect(received[0]!.detail).toEqual({ pageNumber: 2, previous: 1 });
    expect(received[0]!.bubbles).toBe(true);
    expect(received[0]!.composed).toBe(true);
    expect(received[1]!.type).toBe('ofd-error');
  });

  it('转发本机字体方法与事件，未连接时返回默认状态', async () => {
    const element = document.createElement(OFD_VIEWER_TAG) as OFDViewerElement;
    // 未连接元素没有实例：查询返回默认状态、订阅得到空退订函数。
    expect(element.getLocalFontsStatus().supported).toBe(false);
    expect(element.getLocalFontsStatus().visible).toBe(false);
    expect(typeof element.onLocalFontsStatusChange(() => undefined)).toBe('function');
    await expect(element.setLocalFontsEnabled(true)).rejects.toThrow('阅读器尚未创建');

    element.setAttribute('src', 'a.ofd');
    document.body.append(element);
    const viewer = FakeViewer.instances[0]!;
    const received: CustomEvent[] = [];
    element.addEventListener('ofd-local-fonts-change', (event) => {
      received.push(event as CustomEvent);
    });

    expect(element.getLocalFontsStatus()).toBe(viewer.localFontsStatus);
    await element.setLocalFontsEnabled(true);

    expect(viewer.localFontsCalls).toEqual([true]);
    expect(element.getLocalFontsStatus().enabled).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe('ofd-local-fonts-change');
    expect((received[0]!.detail as { enabled: boolean }).enabled).toBe(true);
  });

  it('支持 source property（Blob），断开销毁、重连重建且保留来源', async () => {
    const element = document.createElement(OFD_VIEWER_TAG) as OFDViewerElement;
    const source = new Blob(['ofd']);
    element.source = source;
    document.body.append(element);
    await tick();
    const first = FakeViewer.instances[0]!;
    expect(first.options.source).toBe(source);

    element.remove();
    expect(first.destroyed).toBe(true);
    expect(element.viewer).toBeNull();

    document.body.append(element);
    await tick();
    const second = FakeViewer.instances[1]!;
    expect(FakeViewer.instances).toHaveLength(2);
    expect(second.options.source).toBe(source);
    expect(element.viewer).toBe(second);
  });

  it('省略 src 时仍创建实例（供查询参数预览），随后设置 src 打开文档', async () => {
    const element = document.createElement(OFD_VIEWER_TAG) as OFDViewerElement;
    document.body.append(element);
    expect(element.viewer).not.toBeNull();
    expect((element.viewer as unknown as FakeViewer).options.source).toBeUndefined();
    element.setAttribute('src', 'later.ofd');
    await tick();
    expect(FakeViewer.instances).toHaveLength(1);
    const viewer = element.viewer as unknown as FakeViewer;
    expect(viewer.options.source).toBeUndefined();
    expect(viewer.openCalls).toEqual(['later.ofd']);
  });
});