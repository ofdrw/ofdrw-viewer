/**
 * 页面查询参数预览来源单元测试：file 绝对/相对/编码、base64 纯/URL-safe/data URI、
 * 非法协议、非法/超限数据、优先级与 hash 隔离。
 */

import { describe, expect, it, vi } from 'vitest';
import { OFDViewerError } from '../../../src/errors';
import {
  DEFAULT_MAX_BASE64_BYTES,
  readPreviewSourceFromLocation,
} from '../../../src/source/query-source';
import { UI_WARNING_CODES } from '../../../src/diagnostics';

/** 构造最小 location。 */
function locationOf(search: string, href = `https://example.com/app/index.html${search}`) {
  return { href, search };
}

/** 断言返回的绝对 URL。 */
function expectFile(search: string, expected: string, href?: string): void {
  expect(readPreviewSourceFromLocation(locationOf(search, href))).toBe(expected);
}

/** 断言抛出 UI 错误。 */
function expectInvalid(run: () => unknown): OFDViewerError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(OFDViewerError);
    expect((error as OFDViewerError).code).toBe('OFD_INVALID_OPTION');
    return error as OFDViewerError;
  }
  throw new Error('期望抛出 OFDViewerError');
}

describe('readPreviewSourceFromLocation > file', () => {
  it('绝对 http(s) 地址直接使用', () => {
    expectFile(
      `?file=${encodeURIComponent('https://cdn.example.com/docs/a.ofd?x=1')}`,
      'https://cdn.example.com/docs/a.ofd?x=1',
    );
  });

  it('二次 URI 编码后仍还原为原始地址', () => {
    const url = 'https://cdn.example.com/合同 2026.ofd';
    expectFile(`?file=${encodeURIComponent(encodeURIComponent(url))}`, encodeURI(url));
  });

  it('相对路径以当前页面地址为 base 解析', () => {
    expectFile('?file=docs%2Fa.ofd', 'https://example.com/app/docs/a.ofd');
    expectFile('?file=..%2Ffiles%2Fa.ofd', 'https://example.com/files/a.ofd');
  });

  it('根路径相对地址解析到同源根', () => {
    expectFile('?file=%2Ffiles%2Fa.ofd', 'https://example.com/files/a.ofd');
  });

  it('拒绝 file://、javascript:、data: 等非 HTTP(S) 协议', () => {
    expectInvalid(() =>
      readPreviewSourceFromLocation(locationOf(`?file=${encodeURIComponent('file:///etc/passwd')}`)),
    );
    expectInvalid(() =>
      readPreviewSourceFromLocation(
        locationOf(`?file=${encodeURIComponent('javascript:alert(1)')}`),
      ),
    );
    expectInvalid(() =>
      readPreviewSourceFromLocation(
        locationOf(`?file=${encodeURIComponent('data:text/ofd;base64,AAAA')}`),
      ),
    );
  });

  it('file 为空或非法 URL 时报明确错误', () => {
    expectInvalid(() => readPreviewSourceFromLocation(locationOf('?file=')));
    expectInvalid(() =>
      readPreviewSourceFromLocation(locationOf('?file=http%3A%2F%2F%5Binvalid')),
    );
  });

  it('与 hash 页码/缩放互不干扰', () => {
    expectFile(
      '?file=docs%2Fa.ofd',
      'https://example.com/app/docs/a.ofd',
      'https://example.com/app/?file=docs%2Fa.ofd#page=3&zoom=2',
    );
  });

  it('无关参数或空查询返回 null', () => {
    expect(readPreviewSourceFromLocation(locationOf(''))).toBeNull();
    expect(readPreviewSourceFromLocation(locationOf('?page=2&zoom=1.5'))).toBeNull();
    expect(readPreviewSourceFromLocation(locationOf('#'))).toBeNull();
  });
});

describe('readPreviewSourceFromLocation > base64', () => {
  /** 解码结果转文本。 */
  function textOf(search: string, maxBase64Bytes?: number): string {
    const options = maxBase64Bytes === undefined ? {} : { maxBase64Bytes };
    const source = readPreviewSourceFromLocation(locationOf(search), options);
    expect(source).toBeInstanceOf(Uint8Array);
    return new TextDecoder().decode(source as Uint8Array);
  }

  it('纯 base64 解码为字节', () => {
    expect(textOf('?base64=aGVsbG8=')).toBe('hello');
  });

  it('兼容缺失 padding 与 URL-safe 字符', () => {
    expect(textOf('?base64=aGVsbG8')).toBe('hello');
    expect(textOf('?base64=SGVsbG8td29ybGQ_')).toBe('Hello-world?');
    expect(textOf('?base64=SGVsbG8td29ybGQ_')).toEqual('Hello-world?');
  });

  it('兼容查询串中的空格（原 + 被解码为空格）', () => {
    // Pj4+Pg== 是 “>>>>” 的 base64；未编码的 + 会被 URLSearchParams 解码为空格。
    expect(textOf('?base64=Pj4+Pg==')).toBe('>>>>');
    expect(textOf('?base64=Pj4%2BPg%3D%3D')).toBe('>>>>');
  });

  it('支持 data URI（含大小写与多余参数）', () => {
    expect(textOf('?base64=data:application/ofd;base64,aGVsbG8=')).toBe('hello');
    expect(textOf('?base64=DATA:application/ofd;charset=utf-8;BASE64,aGVsbG8=')).toBe('hello');
  });

  it('data URI 缺少 ;base64 标记时报错', () => {
    expectInvalid(() =>
      readPreviewSourceFromLocation(locationOf('?base64=data:application/ofd,aGVsbG8=')),
    );
  });

  it('非法 base64 字符或长度报错', () => {
    expectInvalid(() => readPreviewSourceFromLocation(locationOf('?base64=!!!!')));
    expectInvalid(() => readPreviewSourceFromLocation(locationOf('?base64=a')));
  });

  it('base64 为空时报错', () => {
    expectInvalid(() => readPreviewSourceFromLocation(locationOf('?base64=')));
  });

  it('解码后超过上限时报错', () => {
    const error = expectInvalid(() =>
      readPreviewSourceFromLocation(locationOf('?base64=aGVsbG8='), { maxBase64Bytes: 4 }),
    );
    expect(error.message).toContain('4');
  });

  it('默认上限为 64 MiB', () => {
    expect(DEFAULT_MAX_BASE64_BYTES).toBe(64 * 1024 * 1024);
  });
});

describe('readPreviewSourceFromLocation > 优先级', () => {
  it('file 与 base64 同时存在时优先 file 并产生 warning', () => {
    const onWarning = vi.fn();
    const source = readPreviewSourceFromLocation(
      locationOf('?file=docs%2Fa.ofd&base64=aGVsbG8='),
      { onWarning },
    );
    expect(source).toBe('https://example.com/app/docs/a.ofd');
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0]?.[0]).toMatchObject({
      code: UI_WARNING_CODES.W_QUERY_SOURCE,
      message: expect.stringContaining('file'),
    });
  });
});