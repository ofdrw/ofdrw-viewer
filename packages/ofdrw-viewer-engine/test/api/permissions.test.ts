import { describe, expect, it, vi } from 'vitest';
import type { DocumentPermissions } from '../../src/index';
import { isOFDError } from '../../src/errors';
import type { OFDWarning } from '../../src/warnings';
import { ZipReader } from '../../src/container/zip-reader';
import type { XmlElementSpec } from '../fixtures/xml';
import { buildFixtureOfd, openTestDocument } from './helpers';

/** 构造最小页面 fixture。 */
function onePage() {
  return [{ id: 1, widthMm: 100, heightMm: 100, objects: [] }];
}

/** 文档权限节点。 */
function permissions(children: XmlElementSpec[]): XmlElementSpec {
  return { name: 'ofd:Permissions', children };
}

/** 读取错误码。 */
function errorCode(error: unknown): string | undefined {
  return isOFDError(error) ? error.code : undefined;
}

describe('document.getPermissions', () => {
  it('无 Permissions 时返回六项 true，print/validPeriod 省略', async () => {
    const doc = await openTestDocument(buildFixtureOfd({ pages: onePage() }));
    try {
      const expected: DocumentPermissions = {
        edit: true,
        annot: true,
        export: true,
        signature: true,
        watermark: true,
        printScreen: true,
      };
      expect(await doc.getPermissions()).toEqual(expected);
      expect(await doc.getPermissions()).toBe(await doc.getPermissions());
    } finally {
      await doc.close();
    }
  });

  it('全字段：六项权限、Print 份数与 ValidPeriod 原文', async () => {
    const doc = await openTestDocument(
      buildFixtureOfd({
        pages: onePage(),
        documentChildren: [
          permissions([
            { name: 'ofd:Edit', children: ['false'] },
            { name: 'ofd:Annot', children: ['false'] },
            { name: 'ofd:Export', children: ['true'] },
            { name: 'ofd:Signature', children: ['false'] },
            { name: 'ofd:Watermark', children: ['true'] },
            { name: 'ofd:PrintScreen', children: ['false'] },
            { name: 'ofd:Print', attrs: { Printable: 'false', Copies: '3' } },
            {
              name: 'ofd:ValidPeriod',
              attrs: { StartDate: '2026-01-02', EndDate: '2026-12-31' },
            },
          ]),
        ],
      }),
    );
    try {
      expect(await doc.getPermissions()).toEqual({
        edit: false,
        annot: false,
        export: true,
        signature: false,
        watermark: true,
        printScreen: false,
        print: { printable: false, copies: 3 },
        validPeriod: { start: '2026-01-02', end: '2026-12-31' },
      });
    } finally {
      await doc.close();
    }
  });

  it('非法字段 warning W_PERMISSION_FIELD 并按 true；非法 Copies 按不限', async () => {
    const warnings: OFDWarning[] = [];
    const doc = await openTestDocument(
      buildFixtureOfd({
        pages: onePage(),
        documentChildren: [
          permissions([
            { name: 'ofd:Edit', children: ['bad'] },
            { name: 'ofd:Print', attrs: { Printable: 'bad', Copies: 'many' } },
          ]),
        ],
      }),
      { onWarning: (warning) => warnings.push(warning) },
    );
    try {
      const result = await doc.getPermissions();
      expect(result.edit).toBe(true);
      expect(result.print).toEqual({ printable: true });
      expect(warnings.some((warning) => warning.code === 'W_PERMISSION_FIELD')).toBe(true);
    } finally {
      await doc.close();
    }
  });

  it('Print 无 Printable 默认 true；Copies=0 保留；ValidPeriod 可只声明一端', async () => {
    const doc = await openTestDocument(
      buildFixtureOfd({
        pages: onePage(),
        documentChildren: [
          permissions([
            { name: 'ofd:Print', attrs: { Copies: '0' } },
            { name: 'ofd:ValidPeriod', attrs: { StartDate: '2026-06-01' } },
          ]),
        ],
      }),
    );
    try {
      expect(await doc.getPermissions()).toEqual({
        edit: true,
        annot: true,
        export: true,
        signature: true,
        watermark: true,
        printScreen: true,
        print: { printable: true, copies: 0 },
        validPeriod: { start: '2026-06-01' },
      });
    } finally {
      await doc.close();
    }
  });

  it('只读缓存，不额外读取页面 XML', async () => {
    const doc = await openTestDocument(buildFixtureOfd({ pages: onePage() }));
    const readEntry = vi.spyOn(ZipReader.prototype, 'readEntry');
    try {
      readEntry.mockClear();
      await doc.getPermissions();
      expect(readEntry).not.toHaveBeenCalled();
    } finally {
      readEntry.mockRestore();
      await doc.close();
    }
  });

  it('abort 拒绝 OFD_ABORTED，close 后拒绝 OFD_CLOSED', async () => {
    const doc = await openTestDocument(buildFixtureOfd({ pages: onePage() }));
    const controller = new AbortController();
    controller.abort();
    await expect(doc.getPermissions({ signal: controller.signal })).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === 'OFD_ABORTED',
    );
    await doc.close();
    await expect(doc.getPermissions()).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === 'OFD_CLOSED',
    );
  });
});
