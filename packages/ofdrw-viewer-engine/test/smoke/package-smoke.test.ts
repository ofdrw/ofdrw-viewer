/**
 * 包内 smoke：确认 `packages/ofdrw-viewer-engine/test/smoke` 路径下
 * 包别名解析、公共入口与核心纯函数可用。
 *
 * 架构边界与 DisplayList 的完整 smoke 在仓库根 `test/smoke/`；这里只做
 * 包内测试目录/别名链路的等价检查，保证 `vitest run test/smoke` 在本包内可用。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DPI,
  H5Canvas2DRenderer,
  OFDDocument,
  OFDPage,
  RenderTask,
  getPageViewport,
} from 'ofdrw-viewer-engine';

describe('package smoke', () => {
  it('通过包名解析到公共入口', () => {
    expect(typeof OFDDocument).toBe('function');
    expect(typeof OFDPage).toBe('function');
    expect(typeof RenderTask).toBe('function');
    expect(typeof H5Canvas2DRenderer).toBe('function');
  });

  it('公共纯函数在包内测试环境可用', () => {
    const viewport = getPageViewport({ width: 210, height: 297 }, { dpi: DEFAULT_DPI });
    expect(viewport.dpi).toBe(96);
    expect(viewport.width).toBeGreaterThan(viewport.height / 2);
  });
});