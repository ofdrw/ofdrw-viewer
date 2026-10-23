/**
 * 适配层独立验收：Web Component/React/Vue 均暴露根证书与验证面板配置。
 *
 * 使用真实 `OFDViewer` 与真实 X.509 解析，只把引擎打开替身为内存文档；不复制
 * 适配层逻辑。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engineMocks = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('@ofdrw/ofdrw-viewer-engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ofdrw/ofdrw-viewer-engine')>()),
  OFDDocument: { open: engineMocks.open },
  OFDError: class extends Error {},
  isOFDError: () => false,
  toOFDError: (error: unknown) => error,
}));

import { createRef } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { flushPromises, mount } from '@vue/test-utils';
import { defineOFDViewerElement, OFDViewerElement } from '../../src/component/ofd-viewer-element';
import { OFDViewer as ReactOFDViewer, type OFDViewerHandle } from '../../src/react';
import { OFDViewer as VueOFDViewer } from '../../src/vue';
import { installDomEnvironment, resetDom } from '../helpers/environment';
import { createMockDocument } from '../helpers/document';
import type { EngineOpenMock } from '../helpers/viewer';

const openMock = engineMocks.open as unknown as EngineOpenMock;
const ROOT_PEM = readFileSync(
  join(
    repositoryRoot(process.cwd()),
    'packages/ofdrw-viewer-crypto/test/fixtures/crypto/certs/root-ca.crt.pem',
  ),
  'utf8',
);
const ROOT_DATA = new window.Uint8Array(new TextEncoder().encode(ROOT_PEM));
const PLAIN_OFD = new window.Uint8Array(
  readFileSync(
    join(
      repositoryRoot(process.cwd()),
      'packages/ofdrw-viewer-crypto/test/fixtures/crypto/plain.ofd',
    ),
  ),
);
const ROOT_SUBJECT = 'CN=OFDRW Viewer Crypto Fixtures Root CA';

/** 从测试进程目录向上定位 pnpm 工作区根。 */
function repositoryRoot(start: string): string {
  let directory = start;
  while (!existsSync(join(directory, 'pnpm-workspace.yaml'))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error('未找到 pnpm-workspace.yaml');
    directory = parent;
  }
  return directory;
}

/** 断言根摘要已替换。 */
function expectRoots(
  summaries: readonly { readonly subject: string }[],
  roots: readonly { readonly subject: string }[],
): void {
  expect(summaries).toHaveLength(1);
  expect(summaries[0]!.subject).toContain(ROOT_SUBJECT);
  expect(roots).toHaveLength(1);
  expect(roots[0]!.subject).toContain(ROOT_SUBJECT);
}

beforeEach(() => {
  resetDom();
  installDomEnvironment();
  defineOFDViewerElement();
  openMock.mockReset();
  openMock.mockResolvedValue(createMockDocument({ pageCount: 2 }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('适配层密码配置', () => {
  it('Web Component 暴露 setRootCertificates/getRootCertificates/openVerificationPanel', async () => {
    const element = document.createElement('ofd-viewer') as OFDViewerElement;
    element.source = PLAIN_OFD;
    document.body.append(element);
    await waitFor(() => expect(element.viewer).not.toBeNull());

    const summaries = await element.setRootCertificates([{ data: ROOT_DATA }]);
    expectRoots(summaries, element.getRootCertificates());
    element.openVerificationPanel();
    expect(document.querySelector('.ofd-verification-panel')).not.toBeNull();
    expect(typeof element.verify).toBe('function');
    expect(typeof element.getVerificationReport).toBe('function');
    element.remove();
  });

  it('React 句柄暴露根证书与验证面板方法', async () => {
    const ref = createRef<OFDViewerHandle>();
    const { unmount } = render(<ReactOFDViewer ref={ref} source={PLAIN_OFD} />);
    await waitFor(() => expect(ref.current?.getInstance()).not.toBeNull());

    const handle = ref.current!;
    const summaries = await handle.setRootCertificates([{ data: ROOT_DATA }]);
    expectRoots(summaries, handle.getRootCertificates());
    handle.openVerificationPanel();
    expect(document.querySelector('.ofd-verification-panel')).not.toBeNull();
    expect(typeof handle.verify).toBe('function');
    expect(typeof handle.getVerificationReport).toBe('function');
    unmount();
  });

  it('Vue expose 暴露根证书与验证面板方法', async () => {
    const wrapper = mount(VueOFDViewer, { props: { source: PLAIN_OFD }, attachTo: document.body });
    await flushPromises();
    const exposed = wrapper.vm as unknown as {
      getInstance(): {
        getRoot(): HTMLElement;
        getState(): { document: { status: string } };
      } | null;
      setRootCertificates(roots: readonly { data: Uint8Array }[]): Promise<
        readonly { subject: string }[]
      >;
      getRootCertificates(): readonly { subject: string }[];
      openVerificationPanel(): void;
      verify(): Promise<unknown>;
      getVerificationReport(): unknown;
    };
    await waitFor(() => expect(exposed.getInstance()).not.toBeNull());
    await waitFor(
      () => expect(exposed.getInstance()?.getState().document.status).toBe('ready'),
      { timeout: 5_000 },
    );

    const summaries = await exposed.setRootCertificates([{ data: ROOT_DATA }]);
    expectRoots(summaries, exposed.getRootCertificates());
    exposed.openVerificationPanel();
    await flushPromises();
    await waitFor(
      () => expect(document.querySelector('.ofd-verification-panel')).not.toBeNull(),
      { timeout: 5_000 },
    );
    expect(typeof exposed.verify).toBe('function');
    expect(typeof exposed.getVerificationReport).toBe('function');
    wrapper.unmount();
  });
});