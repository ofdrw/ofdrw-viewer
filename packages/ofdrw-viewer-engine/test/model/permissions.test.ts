import { describe, expect, it, vi } from 'vitest';
import { decodeDocument } from '../../src/model/decode';
import { decodePermissions } from '../../src/model/permissions';
import { leaf, node } from './xml';

/** 构造 Permissions 节点。 */
function permissions(children: ReturnType<typeof node>[]): ReturnType<typeof node> {
  return node('Permissions', {}, children);
}

describe('decodePermissions', () => {
  it('Permissions 缺失时六项权限全 true，print/validPeriod 省略', () => {
    expect(decodePermissions(undefined)).toEqual({
      edit: true,
      annot: true,
      export: true,
      signature: true,
      watermark: true,
      printScreen: true,
    });
  });

  it('解析六项布尔权限、Print 与 ValidPeriod 原文', () => {
    const result = decodePermissions(
      permissions([
        leaf('Edit', 'false'),
        leaf('Annot', 'true'),
        leaf('Export', 'false'),
        leaf('Signature', 'true'),
        leaf('Watermark', 'false'),
        leaf('PrintScreen', 'true'),
        node('Print', { Printable: 'false', Copies: '3' }),
        node('ValidPeriod', { StartDate: '2026-01-02', EndDate: '2026-12-31' }),
      ]),
    );
    expect(result).toEqual({
      edit: false,
      annot: true,
      export: false,
      signature: true,
      watermark: false,
      printScreen: true,
      print: { printable: false, copies: 3 },
      validPeriod: { start: '2026-01-02', end: '2026-12-31' },
    });
  });

  it('Print@Copies：0/正数保留，负数与非法值按不限处理', () => {
    const attrs = (copies: string) => node('Print', { Printable: 'true', Copies: copies });
    expect(decodePermissions(permissions([attrs('0')])).print).toEqual({ printable: true, copies: 0 });
    expect(decodePermissions(permissions([attrs('5')])).print).toEqual({ printable: true, copies: 5 });
    expect(decodePermissions(permissions([attrs('-1')])).print).toEqual({ printable: true });

    const warnings: Array<{ code: string; message: string }> = [];
    const result = decodePermissions(permissions([attrs('many')]), {
      onWarning: (warning) => warnings.push(warning),
    });
    expect(result.print).toEqual({ printable: true });
    expect(warnings).toEqual([
      expect.objectContaining({
        code: 'W_PERMISSION_FIELD',
        message: expect.stringContaining('Copies'),
      }),
    ]);
  });

  it('非法布尔值 warning 后按 true；Print 缺省 Printable 为 true', () => {
    const warnings: Array<{ code: string; message: string }> = [];
    const result = decodePermissions(
      permissions([
        leaf('Edit', 'maybe'),
        leaf('Annot', '0'),
        node('Print', {}),
      ]),
      { onWarning: (warning) => warnings.push(warning) },
    );
    expect(result.edit).toBe(true);
    expect(result.annot).toBe(false);
    expect(result.print).toEqual({ printable: true });
    expect(warnings).toEqual([
      expect.objectContaining({
        code: 'W_PERMISSION_FIELD',
        message: expect.stringContaining('Edit'),
      }),
    ]);
  });

  it('ValidPeriod 只保留声明的起止日期，允许仅一端', () => {
    expect(
      decodePermissions(permissions([node('ValidPeriod', { StartDate: '2026-01-02' })])).validPeriod,
    ).toEqual({ start: '2026-01-02' });
    expect(decodePermissions(permissions([node('ValidPeriod', {})])).validPeriod).toBeUndefined();
  });

  it('decodeDocument 集成 Permissions；无节点时默认允许', () => {
    const root = node('Document', {}, [
      node('Pages', {}, [node('Page', { ID: '1', BaseLoc: 'Pages/Page_0/Content.xml' })]),
      permissions([leaf('Edit', 'false'), node('Print', { Copies: '0' })]),
    ]);
    const document = decodeDocument(root, 'Doc_0/Document.xml');
    expect(document.permissions.edit).toBe(false);
    expect(document.permissions.print).toEqual({ printable: true, copies: 0 });
    expect(decodeDocument(node('Document', {}, []), 'Doc_0/Document.xml').permissions.edit).toBe(true);
  });
});
