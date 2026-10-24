/**
 * V-INFO 独立验证：CLI `info` 的明文文档元数据/页尺寸与加密无凭据行为。
 *
 * 只通过 CLI 源码入口 `main` 与真实 engine/crypto 公开 API 观察结果；期望值
 * 来自 engine `getMetadata/getPageInfos` 和 crypto `inspect`，不复用 CLI 单元
 * 测试的 mock 或内部期望。`info-rich.ofd` / `info-controls.ofd` 是本目录独立
 * 构造的明文夹具，只包含 OFD 元数据与两页内容。
 */

import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';
import type { AttachmentInfo, DocumentMetadata, PageInfo } from '@ofdrw/ofdrw-viewer-engine';
import { inspect } from '@ofdrw/ofdrw-viewer-crypto';
import type { CliInfoJson } from '../../src/info.js';
import { main } from '../../src/cli.js';
import {
  CERT_USER,
  PASSWORD,
  PASSWORD_USER,
  cleanupTempDirs,
  createCapture,
  createTempDir,
  fixture,
  parseJson,
  runMain,
} from './support.js';

afterEach(cleanupTempDirs);

/** 本验证目录的独立夹具。 */
const LOCAL_FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

/**
 * 返回本目录夹具的绝对路径。
 *
 * @param name 文件名
 * @returns 绝对路径
 */
function localFixture(name: string): string {
  return join(LOCAL_FIXTURES, name);
}

/**
 * 用 engine 打开明文包并读取独立 oracle。
 *
 * @param path OFD 路径
 * @returns 元数据、页尺寸与附件元信息
 */
async function engineInfo(path: string): Promise<{
  metadata: DocumentMetadata;
  pages: readonly PageInfo[];
  attachments: readonly AttachmentInfo[];
}> {
  const data = new Uint8Array(await readFile(path));
  const document = await OFDDocument.open({ source: { kind: 'arraybuffer', data } });
  try {
    return {
      metadata: await document.getMetadata(),
      pages: await document.getPageInfos(),
      attachments: await document.getAttachments(),
    };
  } finally {
    await document.close();
  }
}

/**
 * 把 engine 元数据与附件索引收敛为 CLI document 的期望结构。
 *
 * @param metadata engine 元数据
 * @param pages engine 页信息
 * @param attachments engine 附件元信息
 * @returns 仅包含存在字段的 JSON 对象
 */
function expectedDocument(
  metadata: DocumentMetadata,
  pages: readonly PageInfo[],
  attachments: readonly AttachmentInfo[],
): Record<string, unknown> {
  return {
    version: metadata.version,
    pageCount: metadata.pageCount,
    pageSizes: pages.map((page) => ({ widthMm: page.widthMm, heightMm: page.heightMm })),
    ...(metadata.title === undefined ? {} : { title: metadata.title }),
    ...(metadata.author === undefined ? {} : { author: metadata.author }),
    ...(metadata.subject === undefined ? {} : { subject: metadata.subject }),
    ...(metadata.abstract === undefined ? {} : { abstract: metadata.abstract }),
    ...(metadata.creationDate === undefined ? {} : { creationDate: metadata.creationDate }),
    ...(metadata.modDate === undefined ? {} : { modDate: metadata.modDate }),
    ...(metadata.creator === undefined ? {} : { creator: metadata.creator }),
    ...(metadata.creatorVersion === undefined
      ? {}
      : { creatorVersion: metadata.creatorVersion }),
    ...(metadata.keywords === undefined ? {} : { keywords: metadata.keywords }),
    ...(metadata.docId === undefined ? {} : { docId: metadata.docId }),
    ...(metadata.customData === undefined ? {} : { customData: metadata.customData }),
    ...(metadata.docUsage === undefined ? {} : { docUsage: metadata.docUsage }),
    ...(metadata.docType === undefined ? {} : { docType: metadata.docType }),
    ...(metadata.documentHeader === undefined
      ? {}
      : { documentHeader: metadata.documentHeader }),
    ...(metadata.packageInfo === undefined ? {} : { packageInfo: metadata.packageInfo }),
    ...(metadata.commonData === undefined ? {} : { commonData: metadata.commonData }),
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      ...(attachment.format === undefined ? {} : { format: attachment.format }),
      ...(attachment.size === undefined ? {} : { size: attachment.size }),
      ...(attachment.modDate === undefined ? {} : { modDate: attachment.modDate }),
    })),
  };
}

/**
 * 按 CLI 文本规则格式化毫米值。
 *
 * @param value 毫米值
 * @returns 最多两位小数、无尾零的文本
 */
function formatMm(value: number): string {
  return String(Number(value.toFixed(2)));
}

/**
 * 生成文本页面尺寸摘要。
 *
 * @param pages engine 页信息
 * @returns CLI 期望的摘要文本
 */
function expectedPageSizes(pages: readonly PageInfo[]): string {
  return pages
    .map(
      (page, index) =>
        `第 ${index + 1} 页 ${formatMm(page.widthMm)}×${formatMm(page.heightMm)} mm`,
    )
    .join('；');
}

describe('V-INFO 明文文档元数据：CLI JSON 与 engine 一致', () => {
  it('普通明文夹具的 document 字段、页数与页尺寸逐字段一致', async () => {
    const cwd = await createTempDir();
    const path = fixture('plain.ofd');
    const result = await runMain(['info', path, '--json'], cwd);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const payload = parseJson<CliInfoJson>(result.stdout);
    const oracle = await engineInfo(path);
    const inspection = await inspect({
      kind: 'arraybuffer',
      data: new Uint8Array(await readFile(path)),
    });
    const fileSize = (await stat(path)).size;

    expect(payload).toMatchObject({
      command: 'info',
      input: path,
      packageSize: fileSize,
      ofdVersion: oracle.metadata.version,
      encrypted: false,
      layers: [],
      users: [],
      signatureCount: inspection.signatures.length,
      integrityPresent: inspection.integrityPresent,
    });
    expect(payload.document).toEqual(
      expectedDocument(oracle.metadata, oracle.pages, oracle.attachments),
    );
    expect(payload.document?.pageCount).toBe(oracle.metadata.pageCount);
    expect(payload.document?.pageSizes).toHaveLength(oracle.pages.length);
    for (const [index, page] of oracle.pages.entries()) {
      expect(payload.document?.pageSizes[index]).toEqual({
        widthMm: page.widthMm,
        heightMm: page.heightMm,
      });
    }
    // 夹具只提供部分 DocInfo；缺失字段必须省略而不是输出空串/null。
    for (const key of ['title', 'author', 'subject', 'abstract', 'keywords', 'customData'] as const) {
      expect(payload.document).not.toHaveProperty(key);
    }
    expect(payload.document).toMatchObject({
      creator: oracle.metadata.creator,
      creatorVersion: oracle.metadata.creatorVersion,
      creationDate: oracle.metadata.creationDate,
      docId: oracle.metadata.docId,
    });
  });

  it('富元数据夹具的全部可选字段与 engine 一致，页尺寸/页数来自真实 engine', async () => {
    const cwd = await createTempDir();
    const path = localFixture('info-rich.ofd');
    const result = await runMain(['info', path, '--json'], cwd);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const payload = parseJson<CliInfoJson>(result.stdout);
    const oracle = await engineInfo(path);

    expect(payload.document).toEqual(
      expectedDocument(oracle.metadata, oracle.pages, oracle.attachments),
    );
    expect(payload.document).toMatchObject({
      title: '富元数据标题',
      author: '作者甲',
      subject: '主题乙',
      abstract: '摘要丙',
      creationDate: '2024-01-02',
      modDate: '2024-02-03T04:05:06Z',
      creator: '测试工具',
      creatorVersion: '2.0',
      keywords: ['关键词一', '关键词二', '关键词三'],
      docId: 'rich-doc-id-001',
      customData: { 部门: '质量部', 项目: '随机访问' },
    });
    expect(payload.document?.pageCount).toBe(2);
    expect(payload.document?.pageSizes).toHaveLength(2);
    expect(payload.document?.attachments).toEqual([]);
    expect(payload.document?.docType).toBe(oracle.metadata.docType);
    expect(payload.document?.packageInfo).toEqual(oracle.metadata.packageInfo);
    for (const key of ['docRoot', 'docBodyCount', 'physicalBox', 'documentVersion'] as const) {
      expect(payload.document).not.toHaveProperty(key);
    }
  });
});

describe('V-INFO 文本输出：元数据、页尺寸、控制字符净化', () => {
  it('富元数据文本包含标题/作者/主题/日期/创建工具/页数/页面尺寸', async () => {
    const cwd = await createTempDir();
    const path = localFixture('info-rich.ofd');
    const result = await runMain(['info', path], cwd);
    const oracle = await engineInfo(path);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('标题: 富元数据标题');
    expect(result.stdout).toContain('作者: 作者甲');
    expect(result.stdout).toContain('主题: 主题乙');
    expect(result.stdout).toContain('创建时间: 2024-01-02');
    expect(result.stdout).toContain('修改时间: 2024-02-03T04:05:06Z');
    expect(result.stdout).toContain('创建工具: 测试工具（2.0）');
    expect(result.stdout).toContain('页数: 2');
    expect(result.stdout).toContain(`页面尺寸: ${expectedPageSizes(oracle.pages)}`);
    expect(result.stdout).toContain(`文档类型: ${oracle.metadata.docType ?? '无'}`);
    expect(result.stdout).toContain(`文档用途: ${oracle.metadata.docUsage ?? '无'}`);
    expect(result.stdout).toContain(`文档根: ${oracle.metadata.packageInfo?.docRoot ?? '无'}`);
    expect(result.stdout).toContain(`附件: ${oracle.attachments.length} 个`);
    expect(result.stdout).not.toContain('元数据不可用');
  });

  it('换行/制表控制字符在文本中被替换为空格，JSON 保留 engine 原值', async () => {
    const cwd = await createTempDir();
    const path = localFixture('info-controls.ofd');
    const text = await runMain(['info', path], cwd);
    const json = await runMain(['info', path, '--json'], cwd);
    const oracle = await engineInfo(path);
    expect(text.code).toBe(0);
    expect(json.code).toBe(0);
    const payload = parseJson<CliInfoJson>(json.stdout);

    expect(payload.document?.title).toBe(oracle.metadata.title);
    expect(payload.document?.author).toBe(oracle.metadata.author);
    expect(payload.document?.abstract).toBe(oracle.metadata.abstract);
    expect(payload.document?.abstract).toHaveLength(4096);
    expect(text.stdout).toContain('标题: 前 伪造: 后 尾');
    expect(text.stdout).toContain('作者: 作者 甲');
    // 不能把元数据内的换行直接注入成额外结果行。
    expect(text.stdout.split('\n').some((line) => line.startsWith('伪造:'))).toBe(false);
    expect(text.stdout).not.toContain('\u0000');
  });
});

describe('V-INFO 加密无凭据：成功查询、document 省略、提示元数据不可用', () => {
  it.each(['password-encrypted.ofd', 'cert-encrypted.ofd', 'combined-password-encrypted.ofd'])(
    '%s 文本/JSON 均 exit 0，输出加密层且不输出 document',
    async (name) => {
      const cwd = await createTempDir();
      const path = fixture(name);
      const json = await runMain(['info', path, '--json'], cwd);
      const text = await runMain(['info', path], cwd);
      expect(json.code).toBe(0);
      expect(text.code).toBe(0);
      expect(json.stderr).toBe('');
      expect(text.stderr).toBe('');
      const payload = parseJson<CliInfoJson>(json.stdout);
      const oracle = await inspect({
        kind: 'arraybuffer',
        data: new Uint8Array(await readFile(path)),
      });
      expect(payload).toMatchObject({
        command: 'info',
        encrypted: true,
        layers: oracle.layers,
        users: oracle.users,
        signatureCount: oracle.signatures.length,
        integrityPresent: oracle.integrityPresent,
      });
      expect(payload.document).toBeUndefined();
      expect(payload.users.length).toBeGreaterThan(0);
      expect(payload.users[0]?.userName).toBe(
        name === 'cert-encrypted.ofd' ? CERT_USER : PASSWORD_USER,
      );
      expect(text.stdout).toContain('元数据不可用（加密文档，需凭据）');
      expect(text.stdout).toContain(`加密: 是（${oracle.layers.length} 层）`);
      expect(text.stdout).not.toContain('页数:');
      expect(text.stdout).not.toContain('页面尺寸:');
      expect(text.stdout).not.toContain(PASSWORD);
      expect(text.stdout).not.toContain('拿来主义');
      expect(text.stdout).not.toContain('鲁迅');
    },
  );
});

describe('V-INFO 错误路径与取消', () => {
  it('不存在文件 exit 1，stdout 为空且错误码稳定', async () => {
    const cwd = await createTempDir();
    const result = await runMain(['info', join(cwd, 'missing.ofd'), '--json'], cwd);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('CLI_INPUT_NOT_FOUND');
  });

  it('非 OFD 文本 exit 2，--json 不输出不可解析内容', async () => {
    const cwd = await createTempDir();
    const path = join(cwd, 'not-ofd.ofd');
    await writeFile(path, 'not-a-zip');
    const result = await runMain(['info', path, '--json'], cwd);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('CRYPTO_INVALID_PACKAGE');
  });

  it('截断/损坏 OFD exit 2，stdout 为空', async () => {
    const cwd = await createTempDir();
    const path = join(cwd, 'corrupt.ofd');
    const bytes = new Uint8Array(await readFile(fixture('plain.ofd')));
    await writeFile(path, bytes.subarray(0, 64));
    const result = await runMain(['info', path, '--json'], cwd);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('CRYPTO_INVALID_PACKAGE');
  });

  it('注入 SIGINT/cancel 信号返回 130，不输出 JSON', async () => {
    const cwd = await createTempDir();
    const capture = createCapture();
    const controller = new AbortController();
    controller.abort();
    const code = await main(['info', localFixture('info-rich.ofd'), '--json'], {
      cwd,
      stdout: capture.stdout,
      stderr: capture.stderr,
      platform: 'verification-os',
      arch: 'verification-arch',
      signal: controller.signal,
    });
    expect(code).toBe(130);
    expect(capture.stdoutText()).toBe('');
    expect(capture.stderrText()).toContain('CRYPTO_ABORTED');
  });
});
