import { describe, expect, it } from 'vitest';
import type { AttachmentInfo } from '../../src/index';
import type { OFDWarning } from '../../src/warnings';
import { isOFDError } from '../../src/errors';
import { buildXmlDocument } from '../fixtures/xml';
import type { XmlElementSpec } from '../fixtures/xml';
import type { ZipEntryInput } from '../fixtures/zip-builder';
import { buildFixtureOfd, openTestDocument } from './helpers';

/** 单页最小文档。 */
function onePage() {
  return [{ id: 1, widthMm: 100, heightMm: 100, objects: [] }];
}

/** 构造附件索引条目。 */
function attachmentXml(
  attrs: Record<string, string | number>,
  fileLoc?: string,
): XmlElementSpec {
  return {
    name: 'ofd:Attachment',
    attrs,
    ...(fileLoc ? { children: [{ name: 'ofd:FileLoc', children: [fileLoc] }] } : {}),
  };
}

/** 构造 Attachments.xml 条目。 */
function attachmentsEntry(attachments: XmlElementSpec[]): ZipEntryInput {
  return {
    name: 'Doc_0/Attachments.xml',
    data: buildXmlDocument({
      name: 'ofd:Attachments',
      attrs: { 'xmlns:ofd': 'http://www.ofdspec.org/2016' },
      children: attachments,
    }),
  };
}

/** 构造带附件声明的文档。 */
function attachmentOfd(options: {
  attachments?: XmlElementSpec[];
  entries?: ZipEntryInput[];
  declare?: boolean;
}): Uint8Array {
  const declare = options.declare ?? true;
  return buildFixtureOfd({
    pages: onePage(),
    documentChildren: declare
      ? [{ name: 'ofd:Attachments', children: ['Attachments.xml'] }]
      : [],
    extraEntries: [
      ...(options.attachments ? [attachmentsEntry(options.attachments)] : []),
      ...(options.entries ?? []),
    ],
  });
}

/** 读取错误码。 */
function errorCode(error: unknown): string | undefined {
  return isOFDError(error) ? error.code : undefined;
}

describe('document.getAttachments / getAttachmentData', () => {
  it('无 Attachments 声明返回空数组；取数据返回 undefined 且不 warning', async () => {
    const warnings: OFDWarning[] = [];
    const doc = await openTestDocument(buildFixtureOfd({ pages: onePage() }), {
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      expect(await doc.getAttachments()).toEqual([]);
      expect(await doc.getAttachmentData('1')).toBeUndefined();
      expect(warnings).toEqual([]);
    } finally {
      await doc.close();
    }
  });

  it('解析元信息并返回原始字节；支持绝对/相对 FileLoc 与 ID 规范化', async () => {
    const first = Uint8Array.from([0x00, 0x25, 0x50, 0x44, 0x46, 0xff, 0x3c]);
    const second = Uint8Array.from([0x3c, 0x62, 0x61, 0x64, 0x3e]);
    const doc = await openTestDocument(
      attachmentOfd({
        attachments: [
          attachmentXml(
            {
              ID: '1',
              Name: ' 报告.pdf ',
              Format: 'PDF',
              Size: '35.638671875',
              CreationDate: '2020-05-20T10:20:30+08:00',
              ModDate: '2020-05-21',
              Visible: 'false',
              Usage: 'annotation',
            },
            '/Doc_0/Res/report.bin',
          ),
          attachmentXml({ ID: '002', Name: 'data.bin' }, 'Res/data.bin'),
        ],
        entries: [
          { name: 'Doc_0/Res/report.bin', data: first },
          { name: 'Doc_0/Res/data.bin', data: second },
        ],
      }),
    );
    try {
      const infos: readonly AttachmentInfo[] = await doc.getAttachments();
      expect(infos).toEqual([
        {
          id: '1',
          name: '报告.pdf',
          format: 'PDF',
          size: 36_494,
          creationDate: '2020-05-20T10:20:30+08:00',
          modDate: '2020-05-21',
          visible: false,
          usage: 'annotation',
        },
        {
          id: '2',
          name: 'data.bin',
          visible: true,
          usage: 'none',
        },
      ]);
      expect(await doc.getAttachments()).toBe(infos);
      expect(await doc.getAttachmentData('1')).toEqual(first);
      expect(await doc.getAttachmentData('002')).toEqual(second);
      // 附件内容不做 XML/图片解析：非法 XML 字节原样返回。
      expect(Array.from((await doc.getAttachmentData('2')) ?? [])).toEqual(Array.from(second));
    } finally {
      await doc.close();
    }
  });

  it('声明了 Attachments.xml 但文件缺失：warning 后返回空数组', async () => {
    const warnings: OFDWarning[] = [];
    const doc = await openTestDocument(
      buildFixtureOfd({
        pages: onePage(),
        documentChildren: [{ name: 'ofd:Attachments', children: ['Attachments.xml'] }],
      }),
      { onWarning: (warning) => warnings.push(warning) },
    );
    try {
      await expect(doc.getAttachments()).resolves.toEqual([]);
      expect(warnings.some((warning) => warning.code === 'W_ATTACHMENT_RESOURCE')).toBe(true);
      await expect(doc.getAttachmentData('1')).resolves.toBeUndefined();
    } finally {
      await doc.close();
    }
  });

  it('条目缺失 FileLoc / 文件缺失 / ID 不存在时 warning 并返回 undefined', async () => {
    const warnings: OFDWarning[] = [];
    const valid = Uint8Array.from([1, 2, 3]);
    const doc = await openTestDocument(
      attachmentOfd({
        attachments: [
          attachmentXml({ ID: '1', Name: 'missing-file' }, 'Res/missing.bin'),
          attachmentXml({ ID: '2', Name: 'no-loc' }),
          attachmentXml({ ID: '3', Name: 'valid' }, 'Res/valid.bin'),
        ],
        entries: [{ name: 'Doc_0/Res/valid.bin', data: valid }],
      }),
      { onWarning: (warning) => warnings.push(warning) },
    );
    try {
      await expect(doc.getAttachmentData('1')).resolves.toBeUndefined();
      await expect(doc.getAttachmentData('2')).resolves.toBeUndefined();
      await expect(doc.getAttachmentData('99')).resolves.toBeUndefined();
      await expect(doc.getAttachmentData('3')).resolves.toEqual(valid);
      expect(warnings.filter((warning) => warning.code === 'W_ATTACHMENT_RESOURCE')).toHaveLength(3);
    } finally {
      await doc.close();
    }
  });

  it('非法条目 warning 后跳过/回退，保留合法条目', async () => {
    const warnings: OFDWarning[] = [];
    const doc = await openTestDocument(
      attachmentOfd({
        attachments: [
          attachmentXml({ Name: '无 ID' }),
          attachmentXml({ ID: '1' }),
          attachmentXml({ ID: '2', Name: 'bad-size', Size: 'many', Visible: 'maybe' }, 'Res/a.bin'),
          attachmentXml({ ID: '2', Name: 'duplicate' }, 'Res/b.bin'),
          attachmentXml({ ID: '3', Name: 'ok' }, 'Res/ok.bin'),
        ],
        entries: [
          { name: 'Doc_0/Res/a.bin', data: 'a' },
          { name: 'Doc_0/Res/ok.bin', data: 'ok' },
        ],
      }),
      { onWarning: (warning) => warnings.push(warning) },
    );
    try {
      const infos = await doc.getAttachments();
      expect(infos.map((info) => info.id)).toEqual(['2', '3']);
      expect(infos[0]).toEqual({
        id: '2',
        name: 'bad-size',
        visible: true,
        usage: 'none',
      });
      expect(warnings.some((warning) => warning.code === 'W_ATTACHMENT_FIELD')).toBe(true);
      expect(warnings.some((warning) => warning.code === 'W_DUPLICATE_RESOURCE')).toBe(true);
      await expect(doc.getAttachmentData('2')).resolves.toEqual(new TextEncoder().encode('a'));
    } finally {
      await doc.close();
    }
  });

  it('abort 返回 OFD_ABORTED；关闭后返回 OFD_CLOSED', async () => {
    const doc = await openTestDocument(
      attachmentOfd({
        attachments: [attachmentXml({ ID: '1', Name: 'a' }, 'Res/a.bin')],
        entries: [{ name: 'Doc_0/Res/a.bin', data: 'a' }],
      }),
    );
    const controller = new AbortController();
    controller.abort();
    await expect(doc.getAttachments({ signal: controller.signal })).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === 'OFD_ABORTED',
    );
    await expect(
      doc.getAttachmentData('1', { signal: controller.signal }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === 'OFD_ABORTED');

    await doc.close();
    await expect(doc.getAttachments()).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === 'OFD_CLOSED',
    );
    await expect(doc.getAttachmentData('1')).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === 'OFD_CLOSED',
    );
  });
});