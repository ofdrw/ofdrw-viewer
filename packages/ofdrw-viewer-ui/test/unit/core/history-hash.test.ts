/**
 * URL hash 解析（设计方案 §6.2.1 侧栏联动）。
 *
 * 覆盖：侧栏白名单包含本轮新增的 attachments、未知取值被忽略、
 * 关闭侧栏（sidebar=）与既有取值回归。
 */
import { describe, expect, it } from 'vitest';
import { parseViewerHash } from '../../../src/history';

describe('parseViewerHash 侧栏解析', () => {
  it('识别全部合法侧栏取值（含新增的 attachments）', () => {
    for (const view of ['thumbnails', 'outline', 'bookmarks', 'signatures', 'attachments'] as const) {
      expect(parseViewerHash(`#sidebar=${view}`).sidebar).toBe(view);
    }
  });

  it('sidebar= 表示关闭侧栏', () => {
    expect(parseViewerHash('#sidebar=').sidebar).toBeNull();
  });

  it('未知侧栏取值被忽略，不产生 sidebar 字段', () => {
    const parsed = parseViewerHash('#sidebar=not-a-view');
    expect(parsed.sidebar).toBeUndefined();
    expect('sidebar' in parsed).toBe(false);
  });
});
