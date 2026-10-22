import { describe, expect, it } from 'vitest';
import { decodeAttachments } from '../../src/model/attachments';
import { decodeDocument } from '../../src/model/decode';
import type { XmlNode } from '../../src/xml/types';
import { leaf, node } from './xml';

/** 构造附件节点。 */
function attachment(attrs: Record<string, string>, children: XmlNode[] = []): XmlNode {
  return node('Attachment', attrs, children);
}

describe('decodeAttachments', () => {
  it('空附件列表返回空数组', () => {
    expect(decodeAttachments(node('Attachments'), 'Doc_0/Attachments.xml')).toEqual([]);
  });

  it('解析全部字段；Size 从 KB 换算为 byte，路径支持绝对/相对', () => {
    const result = decodeAttachments(
      node('Attachments', {}, [
        attachment(
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
          [leaf('FileLoc', '/Doc_0/Res/report.pdf')],
        ),
        attachment(
          { ID: '002', Name: 'data.bin' },
          [leaf('FileLoc', 'Res/data.bin')],
        ),
      ]),
      'Doc_0/Attachments.xml',
    );

    expect(result).toEqual([
      {
        id: '1',
        name: '报告.pdf',
        format: 'PDF',
        size: 36_494,
        creationDate: '2020-05-20T10:20:30+08:00',
        modDate: '2020-05-21',
        visible: false,
        usage: 'annotation',
        fileLoc: 'Doc_0/Res/report.pdf',
      },
      {
        id: '2',
        name: 'data.bin',
        visible: true,
        usage: 'none',
        fileLoc: 'Doc_0/Res/data.bin',
      },
    ]);
  });

  it('缺少 ID/Name 跳过；重复 ID 保留先出现者并 warning', () => {
    const warnings: Array<{ code: string; message: string }> = [];
    const result = decodeAttachments(
      node('Attachments', {}, [
        attachment({ Name: '无 ID' }),
        attachment({ ID: '1' }),
        attachment({ ID: '1', Name: '先出现' }, [leaf('FileLoc', 'Res/a.bin')]),
        attachment({ ID: '01', Name: '重复' }, [leaf('FileLoc', 'Res/b.bin')]),
      ]),
      'Doc_0/Attachments.xml',
      { onWarning: (warning) => warnings.push(warning) },
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: '1',
      name: '先出现',
      visible: true,
      usage: 'none',
      fileLoc: 'Doc_0/Res/a.bin',
    });
    expect(warnings.filter((warning) => warning.code === 'W_DUPLICATE_RESOURCE')).toHaveLength(1);
    expect(warnings.filter((warning) => warning.code === 'W_ATTACHMENT_FIELD')).toHaveLength(2);
  });

  it('非法 Size/Visible 与路径穿越 warning 后回退/省略，不阻断其他条目', () => {
    const warnings: Array<{ code: string; message: string }> = [];
    const result = decodeAttachments(
      node('Attachments', {}, [
        attachment({
          ID: '1',
          Name: 'bad',
          Size: 'many',
          Visible: 'maybe',
        }, [leaf('FileLoc', '../../escape.bin')]),
        attachment({ ID: '2', Name: 'ok' }, [leaf('FileLoc', 'Res/ok.bin')]),
      ]),
      'Doc_0/Attachments.xml',
      { onWarning: (warning) => warnings.push(warning) },
    );

    expect(result).toEqual([
      {
        id: '1',
        name: 'bad',
        visible: true,
        usage: 'none',
      },
      {
        id: '2',
        name: 'ok',
        visible: true,
        usage: 'none',
        fileLoc: 'Doc_0/Res/ok.bin',
      },
    ]);
    expect(warnings.filter((warning) => warning.code === 'W_ATTACHMENT_FIELD')).toHaveLength(3);
  });

  it('缺失 FileLoc 保留元数据且不 warning', () => {
    const warnings: Array<{ code: string }> = [];
    const result = decodeAttachments(
      node('Attachments', {}, [attachment({ ID: '1', Name: 'meta-only' })]),
      'Doc_0/Attachments.xml',
      { onWarning: (warning) => warnings.push(warning) },
    );

    expect(result).toEqual([
      { id: '1', name: 'meta-only', visible: true, usage: 'none' },
    ]);
    expect(warnings).toEqual([]);
  });
});

describe('decodeDocument 附件索引路径', () => {
  it('解析相对/绝对 Attachments 路径；无节点时 undefined', () => {
    const relative = decodeDocument(
      node('Document', {}, [
        node('Pages', {}, [node('Page', { ID: '1', BaseLoc: 'Pages/Page_0/Content.xml' })]),
        leaf('Attachments', 'Attachments.xml'),
      ]),
      'Doc_0/Document.xml',
    );
    expect(relative.attachmentsFile).toBe('Doc_0/Attachments.xml');

    const absolute = decodeDocument(
      node('Document', {}, [leaf('Attachments', '/Doc_0/Attachments.xml')]),
      'Doc_0/Document.xml',
    );
    expect(absolute.attachmentsFile).toBe('Doc_0/Attachments.xml');

    expect(
      decodeDocument(node('Document', {}, []), 'Doc_0/Document.xml').attachmentsFile,
    ).toBeUndefined();
  });
});