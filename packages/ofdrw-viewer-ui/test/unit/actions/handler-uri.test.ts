/**
 * URI 动作 handler 单测（UI 动作处理机制设计 §8.3）。
 *
 * 覆盖：协议白名单（不弹框直接拒绝）、确认框取消/确认、`_self` 当前窗口跳转、
 * `_blank` 的 noopener/noreferrer、弹窗被拦截、相对地址解析。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ActionInfo } from '@ofdrw/ofdrw-viewer-engine';
import { createUriHandler } from '../../../src/actions/handlers/uri';
import type { UriConfirmRequest } from '../../../src/actions/types';

/** 构造 URI 动作。 */
function uriAction(uri: string, extra: Partial<{ base: string; target: string }> = {}): ActionInfo {
  return {
    event: 'CLICK',
    type: 'uri',
    owner: { kind: 'page', pageIndex: 0 },
    payload: { type: 'uri', uri, ...extra },
  } as ActionInfo;
}

/** 构造带记录能力的宿主。 */
function createHost(options: { confirmed?: boolean; openResult?: Window | null } = {}) {
  const requests: UriConfirmRequest[] = [];
  const openWindow = vi.fn((_url: string, _target: string, _features: string) =>
    options.openResult === undefined ? ({} as Window) : options.openResult,
  );
  const assignLocation = vi.fn();
  const handler = createUriHandler({
    confirm: async (request) => {
      requests.push(request);
      return options.confirmed ?? true;
    },
    getBaseUrl: () => 'https://docs.example.com/view/',
    openWindow,
    assignLocation,
  });
  return { handler, requests, openWindow, assignLocation };
}

const CONTEXT = { trigger: 'CLICK' as const, pageIndex: 0 };

describe('URI 协议白名单', () => {
  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['mailto:a@b.com'],
    ['tel:+8613800000000'],
    ['ftp://example.com/a'],
    ['file:///etc/passwd'],
    ['blob:https://example.com/uuid'],
  ])('拒绝 %s 且不弹确认框', async (uri) => {
    const { handler, requests, openWindow } = createHost();
    const result = await handler(CONTEXT, uriAction(uri));
    expect(result.outcome).toBe('skipped');
    expect(result.skipReason).toBe('policy');
    expect(requests).toHaveLength(0);
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('放行 http 与 https', async () => {
    for (const uri of ['http://example.com/a', 'https://example.com/b']) {
      const { handler, requests } = createHost();
      const result = await handler(CONTEXT, uriAction(uri));
      expect(result.outcome).toBe('executed');
      expect(requests).toHaveLength(1);
    }
  });
});

describe('URI 确认框', () => {
  it('取消时不打开任何窗口，返回 declined', async () => {
    const { handler, openWindow, assignLocation } = createHost({ confirmed: false });
    const result = await handler(CONTEXT, uriAction('https://evil.example.com/x'));
    expect(result.outcome).toBe('skipped');
    expect(result.skipReason).toBe('declined');
    expect(openWindow).not.toHaveBeenCalled();
    expect(assignLocation).not.toHaveBeenCalled();
  });

  it('确认后展示完整 URL 与主机名', async () => {
    const { handler, requests } = createHost();
    await handler(CONTEXT, uriAction('https://evil.example.com/path?q=1#frag'));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://evil.example.com/path?q=1#frag');
    expect(requests[0]!.host).toBe('evil.example.com');
    expect(requests[0]!.target).toBe('_blank');
  });
});

describe('URI 打开方式', () => {
  it('_blank 使用 noopener,noreferrer', async () => {
    const { handler, openWindow } = createHost();
    const result = await handler(CONTEXT, uriAction('https://example.com/', { target: '_blank' }));
    expect(result.outcome).toBe('executed');
    expect(result.target).toBe('_blank');
    expect(openWindow).toHaveBeenCalledWith(
      'https://example.com/',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('缺省 Target 按 _blank 处理', async () => {
    const { handler, openWindow } = createHost();
    await handler(CONTEXT, uriAction('https://example.com/'));
    expect(openWindow).toHaveBeenCalledWith(
      'https://example.com/',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('未知 Target 也按 _blank 处理', async () => {
    const { handler, openWindow } = createHost();
    await handler(CONTEXT, uriAction('https://example.com/', { target: '_parent' }));
    expect(openWindow).toHaveBeenCalledWith(
      'https://example.com/',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('_self 走 location.assign，事件带 target=_self', async () => {
    const { handler, assignLocation, openWindow } = createHost();
    const result = await handler(CONTEXT, uriAction('https://example.com/go', { target: '_self' }));
    expect(result.outcome).toBe('executed');
    expect(result.target).toBe('_self');
    expect(assignLocation).toHaveBeenCalledWith('https://example.com/go');
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('弹窗被拦截时返回 popup-blocked', async () => {
    const { handler } = createHost({ openResult: null });
    const result = await handler(CONTEXT, uriAction('https://example.com/'));
    expect(result.outcome).toBe('failed');
    expect(result.errorReason).toBe('popup-blocked');
  });
});

describe('URI 相对地址', () => {
  it('按 Base 解析相对地址', async () => {
    const { handler, requests } = createHost();
    await handler(CONTEXT, uriAction('guide/index.html', { base: 'https://example.com/docs/' }));
    expect(requests[0]!.url).toBe('https://example.com/docs/guide/index.html');
  });

  it('无 Base 时按文档基地址解析', async () => {
    const { handler, requests } = createHost();
    await handler(CONTEXT, uriAction('./a.html'));
    expect(requests[0]!.url).toBe('https://docs.example.com/view/a.html');
  });

  it('无法解析时返回 target-missing 且不弹框', async () => {
    const { handler, requests } = createHost();
    const result = await handler(CONTEXT, uriAction('', {}));
    expect(result.outcome).toBe('skipped');
    expect(result.skipReason).toBe('target-missing');
    expect(requests).toHaveLength(0);
  });
});