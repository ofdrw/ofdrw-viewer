/**
 * 导出入口自注册测试：模块加载即向核心注册 ExportService。
 */

import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ register: vi.fn() }));

vi.mock('../../../src/viewer.ts', () => ({
  registerViewerExtension: mocks.register,
}));

import { ExportService } from '../../../src/export/export-service';

describe('export/index 自注册', () => {
  it('顶层调用 registerViewerExtension，并在实例上挂载 ExportService', async () => {
    await import('../../../src/export/index');
    expect(mocks.register).toHaveBeenCalledTimes(1);
    const extension = mocks.register.mock.calls[0]![0] as (viewer: unknown) => void;
    const attachExportService = vi.fn();
    extension({ attachExportService });
    expect(attachExportService).toHaveBeenCalledTimes(1);
    expect(attachExportService.mock.calls[0]![0]).toBeInstanceOf(ExportService);
  });
});