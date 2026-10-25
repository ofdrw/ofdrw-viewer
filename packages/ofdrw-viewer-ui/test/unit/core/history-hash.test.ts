/**
 * URL hash 解析（设计方案 §6.2.1 侧栏联动）。
 *
 * 覆盖：侧栏白名单与 `state.ts` 的单一清单 `SIDEBAR_VIEWS` 保持一致、
 * 未知取值被忽略、关闭侧栏（sidebar=）与既有取值回归。
 */
import { describe, expect, it } from 'vitest';
import { parseViewerHash } from '../../../src/history';
import { SIDEBAR_VIEWS } from '../../../src/state';

describe('parseViewerHash 侧栏解析', () => {
  it('识别全部合法侧栏取值（遍历单一清单）', () => {
    for (const view of SIDEBAR_VIEWS) {
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
