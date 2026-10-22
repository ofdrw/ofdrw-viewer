/**
 * 打印入口自注册测试：模块加载即向核心注册 PrintService。
 */

import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ register: vi.fn() }));

vi.mock('../../../src/viewer.ts', () => ({
  registerViewerExtension: mocks.register,
}));

import { PrintService } from '../../../src/print/print-service';

describe('print/index 自注册', () => {
  it('顶层调用 registerViewerExtension，并在实例上挂载 PrintService', async () => {
    await import('../../../src/print/index');
    expect(mocks.register).toHaveBeenCalledTimes(1);
    const extension = mocks.register.mock.calls[0]![0] as (viewer: unknown) => void;
    const attachPrintService = vi.fn();
    extension({ attachPrintService });
    expect(attachPrintService).toHaveBeenCalledTimes(1);
    expect(attachPrintService.mock.calls[0]![0]).toBeInstanceOf(PrintService);
  });
});