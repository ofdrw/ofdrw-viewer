/**
 * 导出命名单元测试：origin 优先、标题回退与不可推导时的默认名。
 */

import { describe, expect, it } from 'vitest';
import { resolveDocumentName } from '../../../src/export/filename';
import type { OutputHost } from '../../../src/export/host';
import type { ViewerOrigin } from '../../../src/state';

/**
 * 创建只提供状态的最小输出宿主。
 *
 * @param document 文档状态子集。
 * @returns 输出宿主替身。
 */
function host(document: {
  metadata?: { title?: string };
  origin?: ViewerOrigin;
}): OutputHost {
  return {
    getState: () => ({ document }),
  } as unknown as OutputHost;
}

describe('resolveDocumentName', () => {
  it('URL origin 优先于 metadata.title，取 basename 并去扩展名', () => {
    expect(
      resolveDocumentName(
        host({
          origin: { kind: 'url', url: 'https://example.com/docs/合同2026.ofd?token=x' },
          metadata: { title: '标题不应使用' },
        }),
      ),
    ).toBe('合同2026');
  });

  it('File origin 取文件名并清洗非法字符', () => {
    expect(
      resolveDocumentName(
        host({ origin: { kind: 'file', name: 'C:\\docs\\报告:终版.ofd' } }),
      ),
    ).toBe('报告_终版');
  });

  it('没有 origin 时回退 metadata.title', () => {
    expect(resolveDocumentName(host({ metadata: { title: '采购合同' } }))).toBe('采购合同');
  });

  it('blob origin 且无标题时返回 document', () => {
    expect(resolveDocumentName(host({ origin: { kind: 'blob' } }))).toBe('document');
  });

  it('URL 无路径段时回退标题，再回退 document', () => {
    expect(
      resolveDocumentName(
        host({ origin: { kind: 'url', url: 'https://example.com/' }, metadata: { title: '首页文档' } }),
      ),
    ).toBe('首页文档');
    expect(resolveDocumentName(host({ origin: { kind: 'url', url: 'https://example.com/' } }))).toBe(
      'document',
    );
  });

  it('标题为空字符串时使用默认名', () => {
    expect(resolveDocumentName(host({ metadata: { title: '   ' } }))).toBe('document');
  });
});