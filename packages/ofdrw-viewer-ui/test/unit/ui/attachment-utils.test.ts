/**
 * 附件工具函数（设计方案 §6.2）。
 *
 * 覆盖：大小/日期格式化、阈值判断、文件名过滤（路径穿越与控制字符）、
 * ZIP 条目去重、分块拼接（ZIP 打包复用 export/zip.ts 的 createStoreZip，不在此测试）。
 */
import { describe, expect, it } from 'vitest';
import type { AttachmentInfo } from '@ofdrw/ofdrw-viewer-engine';
import {
  ATTACHMENT_LARGE_THRESHOLD_BYTES,
  buildAttachmentFilename,
  concatChunks,
  formatAttachmentDate,
  formatAttachmentSize,
  isLargeAttachment,
  sanitizeAttachmentName,
  uniqueAttachmentEntryName,
} from '../../../src/attachment-utils';
import { createTranslator } from '../../../src/i18n';

const zh = createTranslator('zh-CN');

/** 构造附件元信息。 */
function makeAttachment(patch: Partial<AttachmentInfo> = {}): AttachmentInfo {
  return { id: 'a1', name: '说明.pdf', ...patch };
}

describe('大小与日期格式化', () => {
  it('按 KB/MB 分级展示，缺失显示 -', () => {
    expect(formatAttachmentSize(zh, 2048)).toBe('2 KB');
    expect(formatAttachmentSize(zh, 1024 * 1024 * 3)).toBe('3 MB');
    expect(formatAttachmentSize(zh, undefined)).toBe('-');
    expect(formatAttachmentSize(zh, -1)).toBe('-');
  });

  it('日期优先 ModDate，回退 CreationDate，都没有显示 -', () => {
    expect(
      formatAttachmentDate(makeAttachment({ modDate: '2024-02-02', creationDate: '2024-01-01' }), zh),
    ).toBe('2024-02-02');
    expect(formatAttachmentDate(makeAttachment({ creationDate: '2024-01-01' }), zh)).toBe(
      '2024-01-01',
    );
    expect(formatAttachmentDate(makeAttachment(), zh)).toBe('-');
  });
});

describe('大附件阈值', () => {
  it('阈值为 500 MB（524288000 byte）', () => {
    expect(ATTACHMENT_LARGE_THRESHOLD_BYTES).toBe(524288000);
  });

  it('仅声明大小超过阈值时判定为过大；未声明按普通附件处理', () => {
    expect(isLargeAttachment(makeAttachment({ size: ATTACHMENT_LARGE_THRESHOLD_BYTES }))).toBe(
      false,
    );
    expect(isLargeAttachment(makeAttachment({ size: ATTACHMENT_LARGE_THRESHOLD_BYTES + 1 }))).toBe(
      true,
    );
    expect(isLargeAttachment(makeAttachment())).toBe(false);
  });
});

describe('文件名安全', () => {
  it('过滤路径分隔符、.. 与控制字符', () => {
    expect(sanitizeAttachmentName('../../etc/passwd')).toBe('etc_passwd');
    expect(sanitizeAttachmentName('a\\b/c.txt')).toBe('a_b_c.txt');
    expect(sanitizeAttachmentName('bad\u0000name\u001f.txt')).toBe('badname.txt');
    expect(sanitizeAttachmentName('..')).toBe('');
  });

  it('优先 name，其次 id；无扩展名时按格式补全', () => {
    expect(buildAttachmentFilename(makeAttachment({ name: '报告.pdf' }))).toBe('报告.pdf');
    expect(buildAttachmentFilename(makeAttachment({ name: '', id: 'att-9' }))).toBe('att-9');
    expect(buildAttachmentFilename(makeAttachment({ name: 'data', format: 'PDF' }))).toBe(
      'data.pdf',
    );
    expect(buildAttachmentFilename(makeAttachment({ name: '../x', format: 'png' }))).toBe('x.png');
  });

  it('ZIP 条目重名追加序号', () => {
    const used = new Set<string>();
    expect(uniqueAttachmentEntryName('a.pdf', used)).toBe('a.pdf');
    expect(uniqueAttachmentEntryName('a.pdf', used)).toBe('a-2.pdf');
    expect(uniqueAttachmentEntryName('a.pdf', used)).toBe('a-3.pdf');
  });
});

describe('ZIP 打包', () => {
  it('分块按顺序拼接', () => {
    const merged = concatChunks([
      new Uint8Array([1, 2]),
      new Uint8Array([3]),
      new Uint8Array([4, 5]),
    ]);
    expect([...merged]).toEqual([1, 2, 3, 4, 5]);
  });
});
