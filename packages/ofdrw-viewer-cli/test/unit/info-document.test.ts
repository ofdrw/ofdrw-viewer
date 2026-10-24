/**
 * info 明文文档元数据：engine 只读打开、页尺寸、JSON/文本、加密不可用提示
 * 与文本摘要上限。
 */

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
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

/** `fflate` 的最小 ZIP 能力子集，用于测试内改写夹具。 */
interface ZipTestTools {
  /** 文本转 UTF-8 字节。 */
  strToU8(text: string): Uint8Array;
  /** 解压整包为「条目名 → 内容」。 */
  unzipSync(data: Uint8Array): Record<string, Uint8Array>;
  /** 将「条目名 → 内容」压缩为 ZIP 字节。 */
  zipSync(entries: Record<string, Uint8Array>): Uint8Array;
}

/**
 * 以基准包为基础改写/追加 ZIP 条目，生成临时 OFD 文件。
 *
 * 只复制基准包的条目内容，不写入原始包；条目名保持基准包原有顺序。
 * CLI 包不直接声明 `fflate`，因此从 engine 的依赖解析位置按需加载。
 *
 * @param source 基准 OFD 文件绝对路径
 * @param overrides 条目名 → 文本内容；同名条目替换，新条目追加
 * @returns 临时 OFD 文件绝对路径
 */
async function rewriteZipEntries(
  source: string,
  overrides: Readonly<Record<string, string>>,
): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const { createRequire } = await import('node:module');
  const require = createRequire(fileURLToPath(new URL('../../../ofdrw-viewer-engine/package.json', import.meta.url)));
  const { strToU8, unzipSync, zipSync } = require('fflate') as ZipTestTools;
  const entries: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(await readFile(source))))) {
    // 目录条目在文本改写时无意义，跳过以免 zipSync 生成空目录冲突。
    if (name.endsWith('/')) continue;
    entries[name] = bytes;
  }
  for (const [name, text] of Object.entries(overrides)) entries[name] = strToU8(text);
  const dir = await createTempDir();
  const output = join(dir, 'rewritten.ofd');
  await writeFile(output, zipSync(entries));
  return output;
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

  it('JSON 平铺 docUsage/docType/documentHeader/packageInfo/commonData 与附件列表', async () => {
    const input = join(FIXTURES, 'plain.ofd');
    const { logger, capture } = createLogger();
    const code = await runInfo({ inputPath: input, json: true }, { logger });

    expect(code).toBe(0);
    const payload = JSON.parse(capture.stdoutText()) as CliInfoJson;
    const document = payload.document;
    expect(document?.docType).toBe('OFD');
    expect(document?.packageInfo).toEqual({
      docRoot: 'Doc_0/Document.xml',
      docBodyCount: 1,
    });
    // 子对象整体平铺：不展开到顶层。
    expect(document).not.toHaveProperty('docRoot');
    expect(document).not.toHaveProperty('docBodyCount');
    expect(document).not.toHaveProperty('documentVersion');
    expect(document).not.toHaveProperty('physicalBox');
    expect(document?.documentHeader).toMatchObject({
      pageArea: { physicalBox: { x: 0, y: 0, w: 210, h: 297 } },
    });
    expect(document?.commonData).toMatchObject({
      pageArea: { physicalBox: { x: 0, y: 0, w: 210, h: 297 } },
    });
    // 无 DocUsage 声明时省略。
    expect(document).not.toHaveProperty('docUsage');
    // 无 Attachments.xml 时附件为空数组。
    expect(document?.attachments).toEqual([]);
  });

  it('文本按有值才显示补充文档用途/文档类型/文档根与附件数', async () => {
    const source = join(FIXTURES, 'plain.ofd');
    // 基准包 Document.xml 的 Pages 之后追加附件声明，指向独立 Attachments.xml。
    const documentXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ofd:Document xmlns:ofd="http://www.ofdspec.org/2016">',
      '<ofd:CommonData><ofd:PageArea><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox></ofd:PageArea></ofd:CommonData>',
      '<ofd:Pages>',
      '<ofd:Page ID="1" BaseLoc="Pages/Page_0/Content.xml"/>',
      '<ofd:Page ID="38" BaseLoc="Pages/Page_1/Content.xml"/>',
      '</ofd:Pages>',
      '<ofd:Attachments>Attachments.xml</ofd:Attachments>',
      '</ofd:Document>',
    ].join('');
    const ofdXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ofd:OFD xmlns:ofd="http://www.ofdspec.org/2016" Version="1.0" DocType="OFD">',
      '<ofd:DocBody><ofd:DocInfo>',
      '<ofd:DocID>plain-id</ofd:DocID>',
      '<ofd:DocUsage>Normal</ofd:DocUsage>',
      '</ofd:DocInfo>',
      '<ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot>',
      '</ofd:DocBody></ofd:OFD>',
    ].join('');
    const attachmentsXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ofd:Attachments xmlns:ofd="http://www.ofdspec.org/2016">',
      '<ofd:Attachment ID="9" Name="原始发票.xml" Format="xml" Size="3.5">',
      '<ofd:FileLoc>/Doc_0/Res/att.xml</ofd:FileLoc>',
      '</ofd:Attachment></ofd:Attachments>',
    ].join('');
    const input = await rewriteZipEntries(source, {
      'OFD.xml': ofdXml,
      'Doc_0/Document.xml': documentXml,
      'Doc_0/Attachments.xml': attachmentsXml,
      'Doc_0/Res/att.xml': '<root/>',
    });

    const { logger, capture } = createLogger();
    const code = await runInfo({ inputPath: input, json: true }, { logger });

    expect(code).toBe(0);
    const payload = JSON.parse(capture.stdoutText()) as CliInfoJson;
    expect(payload.document?.docUsage).toBe('Normal');
    expect(payload.document?.attachments).toHaveLength(1);
    expect(payload.document?.attachments[0]).toEqual({
      id: '9',
      name: '原始发票.xml',
      format: 'xml',
      size: 3584,
    });

    const textLogger = createLogger();
    await runInfo({ inputPath: input, json: false }, { logger: textLogger.logger });
    const text = textLogger.capture.stdoutText();
    expect(text).toContain('文档用途: Normal');
    expect(text).toContain('文档类型: OFD');
    expect(text).toContain('文档根: Doc_0/Document.xml');
    expect(text).toContain('附件: 1 个');
    expect(text.indexOf('文档类型: OFD')).toBeLessThan(text.indexOf('加密: 否'));
    expect(text.indexOf('文档用途: Normal')).toBeLessThan(text.indexOf('标题: 无'));
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
