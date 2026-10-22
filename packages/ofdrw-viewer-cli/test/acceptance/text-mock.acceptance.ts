/**
 * `--text` 文本 API 缺失场景的可控 mock 验收。
 *
 * 真实 engine 始终提供 `getTextContent`，无法用真实子进程触发
 * `CLI_TEXT_UNSUPPORTED`；这里在进程内调用 CLI `main`，只替换
 * `OFDDocument.open` 返回的文档，验证退出码与错误输出。
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OFDDocument, OFDError } from 'ofdrw-viewer-engine';
import { main } from '../../src/cli.js';
import type { OutputStream } from '../../src/log.js';
import { DENSE_OFD, cleanupTempDirs, createTempDir } from './helpers.js';

/** 内存输出流。 */
interface Capture {
  /** 可注入 `main` 的输出流。 */
  readonly stream: OutputStream;
  /** 当前已写入的文本。 */
  text(): string;
}

/**
 * 创建内存输出流捕获器。
 *
 * @returns 输出流与文本读取函数
 */
function createCapture(): Capture {
  let text = '';
  return {
    stream: {
      write(chunk: string): boolean {
        text += chunk;
        return true;
      },
    },
    text: () => text,
  };
}

/**
 * 构造只暴露必要方法的假文档。
 *
 * @param page 假页面
 * @returns 可被 CLI 当作 `OFDDocument` 使用的对象
 */
function createFakeDocument(page: object): OFDDocument {
  return {
    pageCount: 1,
    getPage: async () => page,
    close: async () => undefined,
  } as unknown as OFDDocument;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDirs();
});

describe('图片 CLI 黑盒验收：--text 文本 API 缺失（可控 mock）', () => {
  it('OFDPage 缺少 getTextContent 时退出 2 并输出 CLI_TEXT_UNSUPPORTED', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    vi.spyOn(OFDDocument, 'open').mockResolvedValue(createFakeDocument({}));
    const stdout = createCapture();
    const stderr = createCapture();

    const code = await main([DENSE_OFD, '-o', outDir, '--text'], {
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(2);
    expect(stderr.text()).toContain('错误[CLI_TEXT_UNSUPPORTED]');
    expect(stderr.text()).toContain('OFDPage.getTextContent 缺失');
    expect(existsSync(outDir)).toBe(true);
    expect(await readdir(outDir)).toEqual([]);
  });

  it('getTextContent 报 OFD_RENDERER_UNSUPPORTED 时退出 2', async () => {
    const cwd = await createTempDir();
    const outDir = join(cwd, 'out');
    const fakePage = {
      getViewport: (options: { dpi?: number }) => ({
        width: 100,
        height: 100,
        dpi: options.dpi ?? 96,
      }),
      getTextContent: async () => {
        throw new OFDError('OFD_RENDERER_UNSUPPORTED', '当前页面未绑定文本驱动');
      },
    };
    vi.spyOn(OFDDocument, 'open').mockResolvedValue(createFakeDocument(fakePage));
    const stdout = createCapture();
    const stderr = createCapture();

    const code = await main([DENSE_OFD, '-o', outDir, '--text'], {
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(2);
    expect(stderr.text()).toContain('错误[CLI_TEXT_UNSUPPORTED]');
    expect(await readdir(outDir)).toEqual([]);
  });
});