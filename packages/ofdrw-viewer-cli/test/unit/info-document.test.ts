/**
 * info 文本输出：warning、缺失字段占位与前 5 页截断。
 *
 * 明文元数据与 engine 的逐字段一致性由
 * `test/verification/cli-info-document.verify.test.ts` 覆盖。
 */

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatInfoText, runInfo, type CliInfoJson } from '../../src/info.js';
import { Logger } from '../../src/log.js';
import { createStreamCapture } from './helpers.js';

/**
 * 创建带内存输出的日志器。
 *
 * @returns 日志器与捕获器
 */
function createLogger(): {
  logger: Logger;
  capture: ReturnType<typeof createStreamCapture>;
} {
  const capture = createStreamCapture();
  return { logger: new Logger(capture), capture };
}

describe('info 明文文档元数据', () => {
  it('engine warning 按 CLI 规则输出，不改变退出码', async () => {
    const input = fileURLToPath(
      new URL('../../../../ofd_pdf_match/testPathClip.ofd', import.meta.url),
    );
    const { logger, capture } = createLogger();
    const code = await runInfo({ inputPath: input, json: true }, { logger });

    expect(code).toBe(0);
    expect(capture.stderrText()).toContain('警告 [W_IMAGE_DECODE]');
    expect(capture.stderrText()).toContain('警告汇总：W_IMAGE_DECODE×1');
    const payload = JSON.parse(capture.stdoutText()) as CliInfoJson;
    expect(payload.document?.pageCount).toBeGreaterThan(0);
  });
});

describe('info 文本摘要与 JSON 完整性', () => {
  it('补充字段全缺失时文本不输出空的文档用途/文档类型/文档根行', () => {
    const info: CliInfoJson = {
      command: 'info',
      input: '/tmp/input.ofd',
      packageSize: 100,
      ofdVersion: '1.0',
      encrypted: false,
      layers: [],
      users: [],
      signatureCount: 0,
      integrityPresent: false,
      document: {
        version: '1.0',
        pageCount: 1,
        pageSizes: [{ widthMm: 210, heightMm: 297 }],
        // 未提供 docUsage/docType/packageInfo，文本按“无”占位而不是空串。
        attachments: [],
      },
      warnings: [],
    };

    const text = formatInfoText(info);
    expect(text).toContain('文档用途: 无');
    expect(text).toContain('文档根: 无');
    // docType 缺失时该行不出现。
    expect(text).not.toContain('文档类型:');
    expect(text).toContain('附件: 0 个');
    expect(text).not.toMatch(/文档用途:\s*$/m);
    expect(text).not.toMatch(/文档根:\s*$/m);
  });

  it('页面很多时文本只展示前 5 页，JSON 保留全部页尺寸', () => {
    const pageSizes = Array.from({ length: 8 }, (_, index) => ({
      widthMm: 210 + index,
      heightMm: 297,
    }));
    const info: CliInfoJson = {
      command: 'info',
      input: '/tmp/input.ofd',
      packageSize: 100,
      ofdVersion: '1.0',
      encrypted: false,
      layers: [],
      users: [],
      signatureCount: 0,
      integrityPresent: false,
      document: {
        version: '1.0',
        pageCount: 8,
        pageSizes,
        title: '标题\n伪造: x\u001b[31m',
        author: '作者',
        subject: '主题',
        abstract: '摘要',
        creationDate: '2021-06-02',
        modDate: '2021-06-03',
        creator: '工具',
        creatorVersion: '2.0',
        keywords: ['关键字'],
        docId: 'doc-id',
        customData: { 部门: '测试' },
        docUsage: 'Normal',
        docType: 'OFD',
        documentHeader: { version: '1.0', maxUnitId: 56 },
        packageInfo: { docRoot: 'Doc_0/Document.xml', docBodyCount: 1 },
        commonData: { documentVersion: '1.0' },
        attachments: [],
      },
      warnings: [],
    };

    const text = formatInfoText(info);
    expect(text).toContain('标题: 标题 伪造: x');
    expect(text).toContain('作者: 作者');
    expect(text).toContain('主题: 主题');
    expect(text).toContain('创建时间: 2021-06-02');
    expect(text).toContain('修改时间: 2021-06-03');
    expect(text).toContain('创建工具: 工具（2.0）');
    expect(text).toContain('文档用途: Normal');
    expect(text).toContain('文档类型: OFD');
    expect(text).toContain('文档根: Doc_0/Document.xml');
    expect(text).toContain('附件: 0 个');
    expect(text).toContain('页数: 8');
    expect(text).toContain('页面尺寸: 第 1 页 210×297 mm');
    expect(text).toContain('第 5 页 214×297 mm');
    expect(text).not.toContain('第 6 页');
    expect(text).toContain('…（共 8 页，完整尺寸见 --json）');
    expect(text).not.toContain('\u001b');

    const json = JSON.parse(JSON.stringify(info)) as CliInfoJson;
    expect(json.document?.pageSizes).toHaveLength(8);
    expect(json.document?.customData).toEqual({ 部门: '测试' });
  });
});