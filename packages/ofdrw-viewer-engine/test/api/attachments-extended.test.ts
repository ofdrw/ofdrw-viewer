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
}): Uint8Array {
  return buildFixtureOfd({
    pages: onePage(),
    documentChildren: [{ name: 'ofd:Attachments', children: ['Attachments.xml'] }],
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

/** 三附件样例：两个 PDF（大小写不同）、一个无格式。 */
const SAMPLE_BYTES = Uint8Array.from([10, 20, 30, 40, 50, 60, 70]);

describe('AttachmentInfo 新字段', () => {
  it('解析 ContentType/Desc/SubmissionDate/IsEncrypted，并按 format 推断 contentType', async () => {
    const warnings: OFDWarning[] = [];
    const doc = await openTestDocument(
      attachmentOfd({
        attachments: [
          attachmentXml(
            {
              ID: '1',
              Name: '报 告.pdf',
              Format: 'pdf',
              ContentType: 'application/pdf',
              Desc: '年度报告',
              SubmissionDate: '2020-06-01',
              IsEncrypted: 'true',
            },
            'Res/a.bin',
          ),
          attachmentXml({ ID: '2', Name: 'note', Format: 'TXT' }, 'Res/b.bin'),
          attachmentXml({ ID: '3', Name: 'raw', IsEncrypted: 'maybe' }, 'Res/c.bin'),
        ],
        entries: [
          { name: 'Doc_0/Res/a.bin', data: SAMPLE_BYTES },
          { name: 'Doc_0/Res/b.bin', data: SAMPLE_BYTES },
          { name: 'Doc_0/Res/c.bin', data: SAMPLE_BYTES },
        ],
      }),
      { onWarning: (warning) => warnings.push(warning) },
    );
    try {
      const infos = await doc.getAttachments();
      expect(infos[0]).toEqual({
        id: '1',
        name: '报 告.pdf',
        format: 'pdf',
        contentType: 'application/pdf',
        description: '年度报告',
        submissionDate: '2020-06-01',
        isEncrypted: true,
        visible: true,
        usage: 'none',
      });
      expect(infos[1]?.contentType).toBe('text/plain');
      expect(infos[1]?.description).toBeUndefined();
      expect(infos[1]?.isEncrypted).toBeUndefined();
      expect(infos[2]?.contentType).toBeUndefined();
    } finally {
      await doc.close();
    }
  });

  it('未知格式且无 ContentType 时省略 contentType；非法 IsEncrypted warning 后省略', async () => {
    const warnings: OFDWarning[] = [];
    const doc = await openTestDocument(
      attachmentOfd({
        attachments: [attachmentXml({ ID: '1', Name: 'x', Format: 'weird', IsEncrypted: '?' }, 'Res/a.bin')],
        entries: [{ name: 'Doc_0/Res/a.bin', data: SAMPLE_BYTES }],
      }),
      { onWarning: (warning) => warnings.push(warning) },
    );
    try {
      const info = (await doc.getAttachments())[0];
      expect(info?.contentType).toBeUndefined();
      expect(info?.isEncrypted).toBeUndefined();
      expect(warnings.some((warning) => warning.code === 'W_ATTACHMENT_FIELD')).toBe(true);
    } finally {
      await doc.close();
    }
  });

  it('IsEncrypted 支持 true/1/yes/false/0/no，未声明时省略', async () => {
    const values = ['true', '1', 'yes', 'TRUE', 'false', '0', 'no', 'No'];
    const doc = await openTestDocument(
      attachmentOfd({
        attachments: [
          ...values.map((value, index) =>
            attachmentXml({ ID: String(index + 1), Name: `a${index}`, IsEncrypted: value }, 'Res/a.bin'),
          ),
          attachmentXml({ ID: '99', Name: 'plain' }, 'Res/a.bin'),
        ],
        entries: [{ name: 'Doc_0/Res/a.bin', data: SAMPLE_BYTES }],
      }),
    );
    try {
      const infos = await doc.getAttachments();
      expect(infos.slice(0, values.length).map((info) => info.isEncrypted)).toEqual([
        true,
        true,
        true,
        true,
        false,
        false,
        false,
        false,
      ]);
      expect(infos[values.length]).not.toHaveProperty('isEncrypted');
    } finally {
      await doc.close();
    }
  });
});

describe('附件查询接口', () => {
  it('getAttachmentByName 精确匹配；重名返回第一个并 warning', async () => {
    const warnings: OFDWarning[] = [];
    const doc = await openTestDocument(
      attachmentOfd({
        attachments: [
          attachmentXml({ ID: '1', Name: 'same' }, 'Res/a.bin'),
          attachmentXml({ ID: '2', Name: 'same' }, 'Res/b.bin'),
          attachmentXml({ ID: '3', Name: 'Same' }, 'Res/c.bin'),
        ],
        entries: [{ name: 'Doc_0/Res/a.bin', data: SAMPLE_BYTES }],
      }),
      { onWarning: (warning) => warnings.push(warning) },
    );
    try {
      const first = await doc.getAttachmentByName('same');
      expect(first?.id).toBe('1');
      expect(warnings.some((warning) => warning.code === 'W_DUPLICATE_RESOURCE')).toBe(true);
      // 名称大小写敏感。
      expect((await doc.getAttachmentByName('Same'))?.id).toBe('3');
      expect(await doc.getAttachmentByName('missing')).toBeUndefined();
    } finally {
      await doc.close();
    }
  });

  it('getAttachmentsByFormat 大小写不敏感且保持 XML 顺序；空格式返回空数组', async () => {
    const doc = await openTestDocument(
      attachmentOfd({
        attachments: [
          attachmentXml({ ID: '1', Name: 'a', Format: 'PDF' }, 'Res/a.bin'),
          attachmentXml({ ID: '2', Name: 'b', Format: 'TXT' }, 'Res/b.bin'),
          attachmentXml({ ID: '3', Name: 'c', Format: 'pdf' }, 'Res/c.bin'),
          attachmentXml({ ID: '4', Name: 'd' }, 'Res/d.bin'),
        ],
        entries: [{ name: 'Doc_0/Res/a.bin', data: SAMPLE_BYTES }],
      }),
    );
    try {
      const infos: readonly AttachmentInfo[] = await doc.getAttachmentsByFormat('pDf');
      expect(infos.map((info) => info.id)).toEqual(['1', '3']);
      expect(await doc.getAttachmentsByFormat('')).toEqual([]);
      expect(await doc.getAttachmentsByFormat('doc')).toEqual([]);
    } finally {
      await doc.close();
    }
  });

  it('getAttachmentsByFormat 忽略查询串两侧空白；getAttachmentByName 空串不匹配且不 warning', async () => {
    const warnings: OFDWarning[] = [];
    const doc = await openTestDocument(
      attachmentOfd({
        attachments: [
          attachmentXml({ ID: '1', Name: 'a', Format: 'PDF' }, 'Res/a.bin'),
          attachmentXml({ ID: '2', Name: 'b', Format: 'txt' }, 'Res/b.bin'),
        ],
        entries: [{ name: 'Doc_0/Res/a.bin', data: SAMPLE_BYTES }],
      }),
      { onWarning: (warning) => warnings.push(warning) },
    );
    try {
      expect((await doc.getAttachmentsByFormat('  pdf  ')).map((info) => info.id)).toEqual(['1']);
      // 大小写敏感：空串不会命中任何附件（附件名均为非空）。
      await expect(doc.getAttachmentByName('')).resolves.toBeUndefined();
      expect(warnings).toEqual([]);
    } finally {
      await doc.close();
    }
  });

  it('getAttachmentSize 返回声明大小（byte）；未声明或不存在时 undefined', async () => {
    const warnings: OFDWarning[] = [];
    const doc = await openTestDocument(
      attachmentOfd({
        attachments: [
          attachmentXml({ ID: '1', Name: 'a', Size: '2' }, 'Res/a.bin'),
          attachmentXml({ ID: '2', Name: 'b' }, 'Res/b.bin'),
        ],
        entries: [{ name: 'Doc_0/Res/a.bin', data: SAMPLE_BYTES }],
      }),
      { onWarning: (warning) => warnings.push(warning) },
    );
    try {
      await expect(doc.getAttachmentSize('1')).resolves.toBe(2048);
      await expect(doc.getAttachmentSize('2')).resolves.toBeUndefined();
      await expect(doc.getAttachmentSize('9')).resolves.toBeUndefined();
      expect(warnings.some((warning) => warning.code === 'W_ATTACHMENT_RESOURCE')).toBe(true);
    } finally {
      await doc.close();
    }
  });

  it('无 Attachments 声明时查询返回空/undefined 且不 warning', async () => {
    const warnings: OFDWarning[] = [];
    const doc = await openTestDocument(buildFixtureOfd({ pages: onePage() }), {
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      expect(await doc.getAttachmentByName('a')).toBeUndefined();
      expect(await doc.getAttachmentsByFormat('pdf')).toEqual([]);
      expect(await doc.getAttachmentSize('1')).toBeUndefined();
      const chunks: Uint8Array[] = [];
      expect(await doc.saveAttachment('1', (chunk) => void chunks.push(chunk))).toBe(0);
      expect(chunks).toEqual([]);
      expect(warnings).toEqual([]);
    } finally {
      await doc.close();
    }
  });
});

describe('saveAttachment', () => {
  it('分块回调顺序与包内字节一致并返回总字节数', async () => {
    const doc = await openTestDocument(
      attachmentOfd({
        attachments: [attachmentXml({ ID: '1', Name: 'a' }, 'Res/a.bin')],
        entries: [{ name: 'Doc_0/Res/a.bin', data: SAMPLE_BYTES }],
      }),
    );
    try {
      const chunks: Uint8Array[] = [];
      const total = await doc.saveAttachment('1', (chunk) => void chunks.push(chunk.slice()), {
        chunkSize: 3,
      });
      expect(total).toBe(SAMPLE_BYTES.byteLength);
      expect(chunks.map((chunk) => Array.from(chunk))).toEqual([[10, 20, 30], [40, 50, 60], [70]]);
      // 异步 sink 也被等待。
      const asyncChunks: number[] = [];
      await doc.saveAttachment('1', async (chunk) => {
        await Promise.resolve();
        asyncChunks.push(chunk.byteLength);
      }, { chunkSize: 4 });
      expect(asyncChunks).toEqual([4, 3]);
    } finally {
      await doc.close();
    }
  });

  it('chunkSize 非法（0/负数/小数）回退默认 64 KiB，小块内容一次回调', async () => {
    const doc = await openTestDocument(
      attachmentOfd({
        attachments: [attachmentXml({ ID: '1', Name: 'a' }, 'Res/a.bin')],
        entries: [{ name: 'Doc_0/Res/a.bin', data: SAMPLE_BYTES }],
      }),
    );
    try {
      for (const chunkSize of [0, -5, 1.5]) {
        const chunks: number[] = [];
        const total = await doc.saveAttachment(
          '1',
          (chunk) => void chunks.push(chunk.byteLength),
          { chunkSize },
        );
        expect(total).toBe(SAMPLE_BYTES.byteLength);
        expect(chunks).toEqual([SAMPLE_BYTES.byteLength]);
      }
    } finally {
      await doc.close();
    }
  });

  it('sink 抛错时原样上抛且不再继续读取', async () => {
    const doc = await openTestDocument(
      attachmentOfd({
        attachments: [attachmentXml({ ID: '1', Name: 'a' }, 'Res/a.bin')],
        entries: [{ name: 'Doc_0/Res/a.bin', data: SAMPLE_BYTES }],
      }),
    );
    try {
      const failure = new Error('disk full');
      let calls = 0;
      await expect(
        doc.saveAttachment(
          '1',
          () => {
            calls += 1;
            throw failure;
          },
          { chunkSize: 2 },
        ),
      ).rejects.toBe(failure);
      expect(calls).toBe(1);
    } finally {
      await doc.close();
    }
  });

  it('声明大小超过 maxAttachmentBytes 时抛 OFD_LIMIT_EXCEEDED 且不读内容', async () => {
    const doc = await openTestDocument(
      attachmentOfd({
        attachments: [attachmentXml({ ID: '1', Name: 'a', Size: '10' }, 'Res/a.bin')],
        entries: [{ name: 'Doc_0/Res/a.bin', data: SAMPLE_BYTES }],
      }),
      { limits: { maxAttachmentBytes: 1024 } },
    );
    try {
      const chunks: Uint8Array[] = [];
      await expect(
        doc.saveAttachment('1', (chunk) => void chunks.push(chunk)),
      ).rejects.toSatisfy((error: unknown) => errorCode(error) === 'OFD_LIMIT_EXCEEDED');
      expect(chunks).toEqual([]);
      await expect(doc.getAttachmentData('1')).rejects.toSatisfy(
        (error: unknown) => errorCode(error) === 'OFD_LIMIT_EXCEEDED',
      );
      await expect(doc.getAttachmentSize('1')).rejects.toSatisfy(
        (error: unknown) => errorCode(error) === 'OFD_LIMIT_EXCEEDED',
      );
    } finally {
      await doc.close();
    }
  });

  it('未配置 maxAttachmentBytes 时回退 maxEntryBytes', async () => {
    const doc = await openTestDocument(
      attachmentOfd({
        attachments: [attachmentXml({ ID: '1', Name: 'a', Size: '10' }, 'Res/a.bin')],
        entries: [{ name: 'Doc_0/Res/a.bin', data: SAMPLE_BYTES }],
      }),
      { limits: { maxEntryBytes: 1024 } },
    );
    try {
      await expect(doc.getAttachmentSize('1')).rejects.toSatisfy(
        (error: unknown) => errorCode(error) === 'OFD_LIMIT_EXCEEDED',
      );
    } finally {
      await doc.close();
    }
  });

  it('附件内容缺失时 warning 并返回 0；abort/close 返回错误码', async () => {
    const warnings: OFDWarning[] = [];
    const doc = await openTestDocument(
      attachmentOfd({
        attachments: [
          attachmentXml({ ID: '1', Name: 'missing' }, 'Res/missing.bin'),
          attachmentXml({ ID: '2', Name: 'ok' }, 'Res/ok.bin'),
        ],
        entries: [{ name: 'Doc_0/Res/ok.bin', data: SAMPLE_BYTES }],
      }),
      { onWarning: (warning) => warnings.push(warning) },
    );
    try {
      await expect(doc.saveAttachment('1', () => undefined)).resolves.toBe(0);
      expect(warnings.some((warning) => warning.code === 'W_ATTACHMENT_RESOURCE')).toBe(true);

      const controller = new AbortController();
      controller.abort();
      await expect(
        doc.saveAttachment('2', () => undefined, { signal: controller.signal }),
      ).rejects.toSatisfy((error: unknown) => errorCode(error) === 'OFD_ABORTED');
      await expect(
        doc.getAttachmentByName('ok', { signal: controller.signal }),
      ).rejects.toSatisfy((error: unknown) => errorCode(error) === 'OFD_ABORTED');
    } finally {
      await doc.close();
    }
    await expect(doc.saveAttachment('2', () => undefined)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === 'OFD_CLOSED',
    );
    await expect(doc.getAttachmentsByFormat('x')).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === 'OFD_CLOSED',
    );
  });
});
