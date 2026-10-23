/**
 * info 明文文档元数据：engine 只读打开、页尺寸、JSON/文本、加密不可用提示
 * 与文本摘要上限。
 */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';
import { formatInfoText, runInfo, type CliInfoJson } from '../../src/info.js';
import { Logger } from '../../src/log.js';
import { createStreamCapture } from './helpers.js';

/** crypto 共用夹具目录。 */
const FIXTURES = fileURLToPath(
  new URL('../../../ofdrw-viewer-crypto/test/fixtures/crypto/', import.meta.url),
);

/** 带 Title/Author 与非常规页尺寸的真实包。 */
const LARGE_INPUT = fileURLToPath(
  new URL('../../../../ofd_pdf_match/不规范资源路径.ofd', import.meta.url),
);

/** 临时目录登记。 */
const tempDirs: string[] = [];

/**
 * 创建并登记临时目录。
 *
 * @returns 目录绝对路径
 */
async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ofdrw-cli-info-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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
  it('JSON 输出 engine 元数据与每页尺寸，缺失字段省略', async () => {
    const input = join(FIXTURES, 'plain.ofd');
    const packageSize = (await stat(input)).size;
    const { logger, capture } = createLogger();
    const code = await runInfo({ inputPath: input, json: true }, { logger });

    expect(code).toBe(0);
    const payload = JSON.parse(capture.stdoutText()) as CliInfoJson;
    expect(payload).toMatchObject({
      command: 'info',
      input,
      packageSize,
      ofdVersion: '1.0',
      encrypted: false,
      layers: [],
      users: [],
      signatureCount: 0,
      integrityPresent: false,
      warnings: [],
      document: {
        version: '1.0',
        pageCount: 2,
        pageSizes: [
          { widthMm: 210, heightMm: 297 },
          { widthMm: 210, heightMm: 297 },
        ],
        creationDate: '2021-06-02',
        creator: 'OFD R&W',
        creatorVersion: '1.9.8',
        docId: '4228962e12c247e2984e79d8334ed10e',
      },
    });
    expect(payload.ofdVersion).toBe(payload.document?.version);
    expect(payload.document).not.toHaveProperty('title');
    expect(payload.document).not.toHaveProperty('author');
    expect(payload.document).not.toHaveProperty('abstract');
  });

  it('文本输出标题、作者、创建工具、页数与页面尺寸摘要', async () => {
    const { logger, capture } = createLogger();
    const code = await runInfo({ inputPath: LARGE_INPUT, json: false }, { logger });

    expect(code).toBe(0);
    const text = capture.stdoutText();
    expect(text).toContain('标题: 结婚证.png');
    expect(text).toContain('作者: 结婚证.png');
    expect(text).toContain('页数: 1');
    expect(text).toContain('页面尺寸: 第 1 页 406.4×228.6 mm');
  });

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

  it('明文路径只调用 getMetadata/getPageInfos，不取页面也不渲染', async () => {
    const metadata = vi.spyOn(OFDDocument.prototype, 'getMetadata');
    const pageInfos = vi.spyOn(OFDDocument.prototype, 'getPageInfos');
    const getPage = vi.spyOn(OFDDocument.prototype, 'getPage');
    const exportImage = vi.spyOn(OFDDocument.prototype, 'exportPage');
    const close = vi.spyOn(OFDDocument.prototype, 'close');
    const { logger } = createLogger();

    await runInfo({ inputPath: join(FIXTURES, 'plain.ofd'), json: true }, { logger });

    expect(metadata).toHaveBeenCalledTimes(1);
    expect(pageInfos).toHaveBeenCalledTimes(1);
    expect(getPage).not.toHaveBeenCalled();
    expect(exportImage).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('加密包无凭据不输出 document，文本明确提示元数据不可用', async () => {
    const input = join(FIXTURES, 'password-encrypted.ofd');
    const openDocument = vi.spyOn(OFDDocument, 'open');
    const { logger, capture } = createLogger();
    const code = await runInfo({ inputPath: input, json: true }, { logger });

    expect(code).toBe(0);
    expect(openDocument).not.toHaveBeenCalled();
    const payload = JSON.parse(capture.stdoutText()) as CliInfoJson;
    expect(payload).toMatchObject({
      command: 'info',
      encrypted: true,
      signatureCount: 0,
      integrityPresent: false,
    });
    expect(payload).not.toHaveProperty('document');

    const textLogger = createLogger();
    const textCode = await runInfo({ inputPath: input, json: false }, { logger: textLogger.logger });
    expect(textCode).toBe(0);
    expect(textLogger.capture.stdoutText()).toContain('元数据不可用（加密文档，需凭据）');
  });
});

describe('info 文本摘要与 JSON 完整性', () => {
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
