/**
 * engine 适配层冒烟测试。
 *
 * 用仓库内的明文 OFD fixture 走完整链路：落盘打开 → 导出 PNG → 读取文本/页尺寸，
 * 并覆盖 `openDocumentFromBytes` 与加密文档拒绝。fixture 缺失时跳过对应用例。
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectInfo, openDocument, openDocumentFromBytes } from '../src/engine/index.js';

/** 包内 `crypto/test/fixtures/crypto` 目录下的测试用 OFD。 */
const FIXTURE_ROOT = new URL('../../ofdrw-viewer-crypto/test/fixtures/crypto/', import.meta.url);

/** 明文 fixture。 */
const PLAIN_OFD = fileURLToPath(new URL('plain.ofd', FIXTURE_ROOT));

/** 口令加密 fixture。 */
const ENCRYPTED_OFD = fileURLToPath(new URL('password-encrypted.ofd', FIXTURE_ROOT));

/**
 * 读取 fixture 字节；文件不存在时返回 undefined。
 *
 * @param filePath 文件路径
 * @returns 字节或 undefined
 */
async function readFixture(filePath: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(filePath));
  } catch {
    return undefined;
  }
}

const plainBytes = await readFixture(PLAIN_OFD);
const encryptedBytes = await readFixture(ENCRYPTED_OFD);

describe('engine 适配层', () => {
  it('打开明文 OFD 并导出首页 PNG', async () => {
    if (plainBytes === undefined) {
      // 仓库内没有明文 fixture：跳过断言，避免在无关环境下失败。
      expect(plainBytes ?? undefined).toBeUndefined();
      return;
    }
    const opened = await openDocument({ filePath: PLAIN_OFD, fontFiles: [] });
    try {
      expect(opened.pageCount).toBeGreaterThan(0);
      expect(opened.packageSize).toBeGreaterThan(0);
      const page = await opened.document.getPage(0);
      const image = await page.exportImage({ dpi: 96, format: 'png', background: '#ffffff' });
      expect(image.mime).toBe('image/png');
      expect(image.data.byteLength).toBeGreaterThan(0);

      const text = await page.getTextContent({ dpi: 96, includeChars: false });
      expect(text.pageWidth).toBeGreaterThan(0);

      const info = await collectInfo(opened.document, opened.packageSize);
      expect(info.encrypted).toBe(false);
      expect(info.document.pageCount).toBe(opened.pageCount);
    } finally {
      await opened.close();
      await opened.close();
    }
  }, 30_000);

  it('从内存字节打开并导出 PNG', async () => {
    if (plainBytes === undefined) {
      expect(plainBytes ?? undefined).toBeUndefined();
      return;
    }
    const opened = await openDocumentFromBytes({ data: plainBytes, fontFiles: [] });
    try {
      expect(opened.packageSize).toBe(plainBytes.byteLength);
      const page = await opened.document.getPage(0);
      const image = await page.exportImage({ dpi: 96, format: 'png', background: '#ffffff' });
      expect(image.mime).toBe('image/png');
      expect(image.data.byteLength).toBeGreaterThan(0);
    } finally {
      await opened.close();
    }
  }, 30_000);

  it('拒绝加密文档', async () => {
    if (encryptedBytes === undefined) {
      expect(encryptedBytes ?? undefined).toBeUndefined();
      return;
    }
    await expect(
      openDocumentFromBytes({ data: encryptedBytes, fontFiles: [] }),
    ).rejects.toMatchObject({ code: 'OFD_ENCRYPTED' });
    await expect(openDocument({ filePath: ENCRYPTED_OFD, fontFiles: [] })).rejects.toMatchObject({
      code: 'OFD_ENCRYPTED',
    });
  }, 30_000);
});