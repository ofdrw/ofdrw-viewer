import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { OFDDocument, isOFDError } from 'ofdrw-viewer-engine';
import { NodeFileByteSource } from '../../src/node-file-source.js';

/** 仓库根目录。 */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const tempDirs: string[] = [];

/** 创建并登记临时目录，测试结束后统一清理。 */
async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ofdrw-cli-source-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 生成 0..255 重复填充的测试字节。 */
function sampleBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index % 256);
}

describe('NodeFileByteSource', () => {
  it('按需读取任意区间并与整文件内容一致', async () => {
    const dir = await createTempDir();
    const filePath = join(dir, 'data.bin');
    const bytes = sampleBytes(1024);
    await writeFile(filePath, bytes);
    const source = await NodeFileByteSource.open(filePath);
    try {
      expect(source.size).toBe(bytes.length);
      const reads = [
        [0, 1],
        [10, 20],
        [500, 100],
        [1023, 1],
        [64, 128],
      ] as const;
      for (const [offset, length] of reads) {
        expect(await source.read(offset, length)).toEqual(bytes.subarray(offset, offset + length));
      }
      const whole = new Uint8Array(bytes.length);
      for (let offset = 0; offset < bytes.length; offset += 37) {
        const chunk = await source.read(offset, 37);
        whole.set(chunk, offset);
      }
      expect(whole).toEqual(bytes);
    } finally {
      await source.close();
    }
  });

  it('EOF 截断并返回空数组', async () => {
    const dir = await createTempDir();
    const filePath = join(dir, 'data.bin');
    await writeFile(filePath, sampleBytes(10));
    const source = await NodeFileByteSource.open(filePath);
    try {
      expect(await source.read(10, 5)).toEqual(new Uint8Array(0));
      expect(await source.read(8, 10)).toEqual(sampleBytes(10).subarray(8));
      expect(await source.read(0, 0)).toEqual(new Uint8Array(0));
      await expect(source.read(-1, 1)).rejects.toBeInstanceOf(RangeError);
      await expect(source.read(0, -1)).rejects.toBeInstanceOf(RangeError);
    } finally {
      await source.close();
    }
  });

  it('重复 close 安全，关闭后读取报 OFD_CLOSED', async () => {
    const dir = await createTempDir();
    const filePath = join(dir, 'data.bin');
    await writeFile(filePath, sampleBytes(4));
    const source = await NodeFileByteSource.open(filePath);
    await source.close();
    await expect(source.close()).resolves.toBeUndefined();
    try {
      await source.read(0, 1);
      throw new Error('预期读取失败');
    } catch (error) {
      expect(isOFDError(error) && error.code === 'OFD_CLOSED').toBe(true);
    }
  });

  it('路径不存在/不是文件映射为退出码 1 的路径错误', async () => {
    const dir = await createTempDir();
    try {
      await NodeFileByteSource.open(join(dir, 'missing.ofd'));
      throw new Error('预期打开失败');
    } catch (error) {
      expect(error).toMatchObject({ code: 'CLI_INPUT_NOT_FOUND', exitCode: 1 });
    }
    try {
      await NodeFileByteSource.open(dir);
      throw new Error('预期打开失败');
    } catch (error) {
      expect(error).toMatchObject({ code: 'CLI_INPUT_NOT_FILE', exitCode: 1 });
    }
  });

  it('打开真实 OFD，并在文档关闭后释放文件句柄', async () => {
    const filePath = join(REPO_ROOT, 'ofd_pdf_match', 'helloworld.ofd');
    const expected = await readFile(filePath);
    const source = await NodeFileByteSource.open(filePath);
    expect(source.size).toBe(expected.length);
    expect(await source.read(0, 4)).toEqual(new Uint8Array(expected.subarray(0, 4)));

    const document = await OFDDocument.open({ source: { kind: 'custom', source } });
    try {
      expect(document.pageCount).toBe(1);
      const page = await document.getPage(0);
      expect(page.getViewport({ dpi: 96 }).width).toBeGreaterThan(0);
    } finally {
      await document.close();
    }

    try {
      await source.read(0, 1);
      throw new Error('预期文档关闭后 source 已关闭');
    } catch (error) {
      expect(isOFDError(error) && error.code === 'OFD_CLOSED').toBe(true);
    }
  });
});