import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OFDError } from '@ofdrw/ofdrw-viewer-engine';
import type {
  OFDDocument,
  OFDOpenOptions,
  OFDPage,
  PageImageResult,
  TextContent,
  TextContentOptions,
  TextItem,
} from '@ofdrw/ofdrw-viewer-engine';
import { convertDocument } from '../../src/convert.js';
import type { ConvertOptions } from '../../src/convert.js';
import { CliError, EXIT_CODES, isCliError } from '../../src/errors.js';
import { Logger } from '../../src/log.js';
import { createStreamCapture } from '../unit/helpers.js';

/** 真实存在的示例文件，供 NodeFileByteSource 打开；假文档不解析其内容。 */
const SAMPLE_INPUT = fileURLToPath(
  new URL('../../../../ofd_pdf_match/helloworld.ofd', import.meta.url),
);

/** 仓库自带的最小 TTF，供 loadFontInputs 读取真实字体字节。 */
const FIXTURE_FONT = fileURLToPath(new URL('../fixtures/minimal.ttf', import.meta.url));

const tempDirs: string[] = [];

/** 创建并登记临时目录，测试结束后统一清理。 */
async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ofdrw-cli-convert-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 单页导出的可控行为。 */
interface FakePageSpec {
  readonly viewport?: { width: number; height: number };
  readonly exportImage?: (options: { signal?: AbortSignal }) => Promise<PageImageResult>;
  readonly getTextContent?: (options: TextContentOptions) => Promise<TextContent>;
}

/** 构造只包含 items 的文本内容；转换链路仅消费该字段。 */
function textContent(items: readonly TextItem[]): TextContent {
  return { items } as TextContent;
}

/** 构造只包含 text/rect 的文本项。 */
function textItem(
  text: string,
  rect: { x: number; y: number; width: number; height: number },
): TextItem {
  return { text, rect } as TextItem;
}

/** 构造满足 convert 所需最小接口的假文档。 */
function createFakeDocument(
  pageCount: number,
  specs: readonly FakePageSpec[],
  onClose?: () => void | Promise<void>,
): OFDDocument {
  return {
    pageCount,
    async getPage(index: number): Promise<OFDPage> {
      const spec = specs[index];
      if (spec === undefined) throw new OFDError('OFD_PAGE_NOT_FOUND', `缺少页 ${index}`);
      return {
        getViewport: () => spec.viewport ?? { width: 100, height: 100 },
        exportImage:
          spec.exportImage ??
          (async () => ({
            data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
            mime: 'image/png',
            width: 100,
            height: 100,
            dpi: 96,
          })),
        ...(spec.getTextContent === undefined
          ? {}
          : { getTextContent: spec.getTextContent }),
      } as unknown as OFDPage;
    },
    async close() {
      await onClose?.();
    },
  } as unknown as OFDDocument;
}

/** 构造打开实现的 mock，并保留调用参数。 */
function createOpenMock(
  implementation: (options: OFDOpenOptions) => Promise<OFDDocument>,
): typeof OFDDocument.open {
  return vi.fn(implementation) as unknown as typeof OFDDocument.open;
}

/** 构造转换输入。 */
function createOptions(outDir: string, overrides: Partial<ConvertOptions> = {}): ConvertOptions {
  return {
    inputPath: SAMPLE_INPUT,
    outDir,
    format: 'png',
    dpi: 96,
    pageNumbers: undefined,
    fontFiles: [{ path: FIXTURE_FONT }],
    text: false,
    ...overrides,
  };
}

/** 列出目录内容（含子目录）。 */
async function listDir(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).sort();
}

describe('convertDocument 图片链路', () => {
  it('逐页导出、命名并注入 Canvas/解码器/字体', async () => {
    const outDir = await createTempDir();
    const capture = createStreamCapture();
    const logger = new Logger({ stderr: capture.stderr });
    const exportImage = vi.fn(
      async (_options: { signal?: AbortSignal }): Promise<PageImageResult> => ({
        data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        mime: 'image/png',
        width: 100,
        height: 100,
        dpi: 96,
      }),
    );
    const close = vi.fn();
    const document = createFakeDocument(
      2,
      [{ exportImage }, { exportImage }],
      close,
    );
    const openCalls: OFDOpenOptions[] = [];
    const openDocument = createOpenMock(async (options) => {
      openCalls.push(options);
      return document;
    });

    const summary = await convertDocument(createOptions(outDir), {
      logger,
      openDocument,
    });

    expect(summary).toMatchObject({
      totalPages: 2,
      succeededPages: 2,
      failedPages: 0,
      interrupted: false,
    });
    expect(summary.message).toContain('完成：2/2 页');
    expect(close).toHaveBeenCalledOnce();
    expect(await listDir(outDir)).toEqual(['helloworld-p001.png', 'helloworld-p002.png']);
    expect(exportImage).toHaveBeenCalledTimes(2);
    expect(exportImage.mock.calls[0]?.[0]).toMatchObject({
      dpi: 96,
      format: 'png',
      quality: 0.9,
      background: '#ffffff',
    });
    const openOptions = openCalls[0];
    expect(openOptions?.source).toMatchObject({ kind: 'custom' });
    // 字体字节由 CLI 读取后以 data 注入，engine 不再接收 path/loadInput。
    expect(openOptions?.fontProvider).toBeUndefined();
    expect(openOptions?.supplementaryFonts).toHaveLength(1);
    expect(openOptions?.supplementaryFonts?.[0]?.data).toBeInstanceOf(Uint8Array);
    expect(openOptions?.supplementaryFonts?.[0]?.data.byteLength).toBeGreaterThan(0);
    expect(openOptions?.imageDecoders?.map((decoder) => decoder.format)).toEqual([
      'png',
      'jpeg',
      'webp',
    ]);
    expect(typeof openOptions?.createCanvas).toBe('function');
    expect(typeof openOptions?.encodeImage).toBe('function');
  });

  it('没有字体文件时不注入 supplementaryFonts', async () => {
    const outDir = await createTempDir();
    const logger = new Logger({ stderr: createStreamCapture().stderr });
    const openCalls: OFDOpenOptions[] = [];
    const document = createFakeDocument(1, [{}]);

    await convertDocument(createOptions(outDir, { fontFiles: [] }), {
      logger,
      openDocument: createOpenMock(async (options) => {
        openCalls.push(options);
        return document;
      }),
    });

    expect(openCalls[0]?.fontProvider).toBeUndefined();
    expect(openCalls[0]?.supplementaryFonts).toBeUndefined();
  });

  it('单页失败后继续后续页，并输出 1 起页号', async () => {
    const outDir = await createTempDir();
    const capture = createStreamCapture();
    const logger = new Logger({ stderr: capture.stderr });
    const document = createFakeDocument(3, [
      {},
      {
        exportImage: async () => {
          throw new OFDError('OFD_IMAGE_DECODE', '图片坏了');
        },
      },
      {},
    ]);

    const summary = await convertDocument(createOptions(outDir, { pageNumbers: [1, 2, 3] }), {
      logger,
      openDocument: createOpenMock(async () => document),
    });

    expect(summary).toMatchObject({
      totalPages: 3,
      succeededPages: 2,
      failedPages: 1,
      interrupted: false,
    });
    expect(summary.message).toContain('2/3 页，1 页失败');
    expect(capture.stderrText()).toContain('页面 2/3 失败 [OFD_IMAGE_DECODE]：图片坏了');
    expect(await listDir(outDir)).toEqual(['helloworld-p001.png', 'helloworld-p003.png']);
  });

  it('写入失败按页级失败处理且不残留临时文件', async () => {
    const outDir = await createTempDir();
    await mkdir(join(outDir, 'helloworld-p002.png'));
    const capture = createStreamCapture();
    const logger = new Logger({ stderr: capture.stderr });
    const document = createFakeDocument(2, [{}, {}]);

    const summary = await convertDocument(createOptions(outDir), {
      logger,
      openDocument: createOpenMock(async () => document),
    });

    expect(summary).toMatchObject({ succeededPages: 1, failedPages: 1 });
    expect(capture.stderrText()).toContain('页面 2/2 失败 [CLI_IMAGE_WRITE_FAILED]');
    const entries = await readdir(outDir);
    expect(entries.sort()).toEqual(['helloworld-p001.png', 'helloworld-p002.png']);
    expect(entries.some((entry) => entry.includes('.tmp-'))).toBe(false);
  });

  it('全部页失败仍返回摘要并逐页报错', async () => {
    const outDir = await createTempDir();
    const capture = createStreamCapture();
    const logger = new Logger({ stderr: capture.stderr });
    const document = createFakeDocument(2, [
      {
        exportImage: async () => {
          throw new OFDError('OFD_CANVAS_TOO_LARGE', '太大');
        },
      },
      {
        exportImage: async () => {
          throw new OFDError('OFD_IMAGE_DECODE', '坏了');
        },
      },
    ]);

    const summary = await convertDocument(createOptions(outDir), {
      logger,
      openDocument: createOpenMock(async () => document),
    });

    expect(summary).toMatchObject({ succeededPages: 0, failedPages: 2 });
    expect(summary.message).toContain('0/2 页，2 页失败');
    expect(await readdir(outDir)).toEqual([]);
  });

  it('已取消信号不导出任何页', async () => {
    const outDir = await createTempDir();
    const capture = createStreamCapture();
    const logger = new Logger({ stderr: capture.stderr });
    const controller = new AbortController();
    controller.abort();
    const document = createFakeDocument(2, [{}, {}]);

    const summary = await convertDocument(createOptions(outDir), {
      logger,
      signal: controller.signal,
      openDocument: createOpenMock(async () => document),
    });

    expect(summary).toMatchObject({
      totalPages: 2,
      succeededPages: 0,
      failedPages: 0,
      interrupted: true,
    });
    expect(summary.message).toContain('已取消：0/2 页');
    expect(await readdir(outDir)).toEqual([]);
  });

  it('导出中取消视为中断，不把 OFD_ABORTED 计为失败', async () => {
    const outDir = await createTempDir();
    const capture = createStreamCapture();
    const logger = new Logger({ stderr: capture.stderr });
    const controller = new AbortController();
    const document = createFakeDocument(2, [
      {
        exportImage: async () => {
          controller.abort();
          throw new OFDError('OFD_ABORTED', '已取消');
        },
      },
      {},
    ]);

    const summary = await convertDocument(createOptions(outDir), {
      logger,
      signal: controller.signal,
      openDocument: createOpenMock(async () => document),
    });

    expect(summary).toMatchObject({ succeededPages: 0, failedPages: 0, interrupted: true });
    expect(capture.stderrText()).toBe('');
    expect(await readdir(outDir)).toEqual([]);
  });

  it('页面像素超限按文档级失败抛出', async () => {
    const outDir = await createTempDir();
    const logger = new Logger({ stderr: createStreamCapture().stderr });
    const document = createFakeDocument(1, [
      { viewport: { width: 10_000, height: 10_000 } },
    ]);

    try {
      await convertDocument(createOptions(outDir), {
        logger,
        openDocument: createOpenMock(async () => document),
      });
      throw new Error('预期抛出页面超限错误');
    } catch (error) {
      expect(isCliError(error)).toBe(true);
      expect((error as CliError).code).toBe('CLI_PAGE_TOO_LARGE');
      expect((error as CliError).exitCode).toBe(EXIT_CODES.DOCUMENT);
    }
    expect(await readdir(outDir)).toEqual([]);
  });

  it('直接使用 custom NodeFileByteSource 打开本地文件', async () => {
    const outDir = await createTempDir();
    const inputPath = join(outDir, 'input.ofd');
    await writeFile(inputPath, 'fake-ofd');
    const logger = new Logger({ stderr: createStreamCapture().stderr });
    const openCalls: OFDOpenOptions[] = [];
    let openedSource: { read?: unknown; close: () => Promise<void> } | undefined;
    const document = createFakeDocument(1, [{}], async () => {
      await openedSource?.close();
    });
    const openDocument = createOpenMock(async (options) => {
      openCalls.push(options);
      if (options.source.kind === 'custom') {
        openedSource = options.source.source as unknown as typeof openedSource;
      }
      return document;
    });

    const summary = await convertDocument(createOptions(outDir, { inputPath }), {
      logger,
      openDocument,
    });

    expect(summary.succeededPages).toBe(1);
    expect(openCalls).toHaveLength(1);
    const source = openCalls[0]?.source;
    expect(source?.kind).toBe('custom');
    if (source?.kind === 'custom') {
      expect(source.source.size).toBe('fake-ofd'.length);
      // 转换结束（含文档 close）后 filehandle 必须已释放。
      await expect(source.source.read(0, 4)).rejects.toMatchObject({ code: 'OFD_CLOSED' });
    }
  });

  it('engine warning 转发为 1 起页号', async () => {
    const outDir = await createTempDir();
    const capture = createStreamCapture();
    const logger = new Logger({ stderr: capture.stderr });
    const document = createFakeDocument(1, [{}]);
    const openDocument = createOpenMock(async (options) => {
      options.onWarning?.({ code: 'W_FONT_MISSING', message: '缺字体', pageIndex: 0 });
      return document;
    });

    await convertDocument(createOptions(outDir), { logger, openDocument });

    expect(capture.stderrText()).toContain('警告 [W_FONT_MISSING] 第 1 页：缺字体');
  });
});
describe('convertDocument 空间文本链路', () => {
  it('--text 调用 getTextContent 并同时写 JSON 与图片', async () => {
    const outDir = await createTempDir();
    const capture = createStreamCapture();
    const logger = new Logger({ stderr: capture.stderr });
    const getTextContent = vi.fn(async () =>
      textContent([
        textItem('发票', { x: 100.5, y: 176.25, width: 48.125, height: 24.5 }),
        textItem('', { x: 1, y: 2, width: 3, height: 4 }),
        textItem('金额', { x: 400.75, y: 300.5, width: 96, height: 12.25 }),
      ]),
    );
    const document = createFakeDocument(1, [{ getTextContent }]);

    const summary = await convertDocument(createOptions(outDir, { text: true }), {
      logger,
      openDocument: createOpenMock(async () => document),
    });

    expect(getTextContent).toHaveBeenCalledOnce();
    expect(getTextContent).toHaveBeenCalledWith({ dpi: 96, includeChars: false });
    expect(await listDir(outDir)).toEqual([
      'helloworld-p001.json',
      'helloworld-p001.png',
    ]);
    expect(JSON.parse(await readFile(join(outDir, 'helloworld-p001.json'), 'utf8'))).toEqual([
      { text: '发票', x: 100.5, y: 176.25, w: 48.125, h: 24.5 },
      { text: '金额', x: 400.75, y: 300.5, w: 96, h: 12.25 },
    ]);
    expect(summary).toMatchObject({ succeededPages: 1, failedPages: 0 });
    expect(summary.message).toContain('（图片 + 文本）');
    expect(capture.stderrText()).toBe('');
  });

  it('空文本页写 []', async () => {
    const outDir = await createTempDir();
    const logger = new Logger({ stderr: createStreamCapture().stderr });
    const document = createFakeDocument(1, [
      { getTextContent: async () => textContent([]) },
    ]);

    await convertDocument(createOptions(outDir, { text: true }), {
      logger,
      openDocument: createOpenMock(async () => document),
    });

    expect(await readFile(join(outDir, 'helloworld-p001.json'), 'utf8')).toBe('[]');
  });

  it('不传 --text 时不调用 getTextContent、不生成 JSON', async () => {
    const outDir = await createTempDir();
    const logger = new Logger({ stderr: createStreamCapture().stderr });
    const getTextContent = vi.fn(async () => textContent([]));
    const document = createFakeDocument(1, [{ getTextContent }]);

    const summary = await convertDocument(createOptions(outDir), {
      logger,
      openDocument: createOpenMock(async () => document),
    });

    expect(getTextContent).not.toHaveBeenCalled();
    expect(await listDir(outDir)).toEqual(['helloworld-p001.png']);
    expect(summary.message).not.toContain('（图片 + 文本）');
  });

  it('文本失败不阻止图片，页面计为失败且保留图片', async () => {
    const outDir = await createTempDir();
    const capture = createStreamCapture();
    const logger = new Logger({ stderr: capture.stderr });
    const document = createFakeDocument(1, [
      {
        getTextContent: async () => {
          throw new OFDError('OFD_LIMIT_EXCEEDED', '文本坏了');
        },
      },
    ]);

    const summary = await convertDocument(createOptions(outDir, { text: true }), {
      logger,
      openDocument: createOpenMock(async () => document),
    });

    expect(summary).toMatchObject({ succeededPages: 0, failedPages: 1 });
    expect(summary.message).toContain('0/1 页（图片 + 文本），1 页失败');
    expect(capture.stderrText()).toContain('文本导出失败');
    expect(await listDir(outDir)).toEqual(['helloworld-p001.png']);
  });

  it('图片失败不阻止文本，页面计为失败且保留 JSON', async () => {
    const outDir = await createTempDir();
    const capture = createStreamCapture();
    const logger = new Logger({ stderr: capture.stderr });
    const document = createFakeDocument(1, [
      {
        getTextContent: async () =>
          textContent([textItem('文本', { x: 1, y: 2, width: 3, height: 4 })]),
        exportImage: async () => {
          throw new OFDError('OFD_IMAGE_DECODE', '图片坏了');
        },
      },
    ]);

    const summary = await convertDocument(createOptions(outDir, { text: true }), {
      logger,
      openDocument: createOpenMock(async () => document),
    });

    expect(summary).toMatchObject({ succeededPages: 0, failedPages: 1 });
    expect(await listDir(outDir)).toEqual(['helloworld-p001.json']);
    expect(JSON.parse(await readFile(join(outDir, 'helloworld-p001.json'), 'utf8'))).toHaveLength(
      1,
    );
    expect(capture.stderrText()).toContain('图片坏了');
  });

  it('文本写盘失败按页失败处理且保留图片', async () => {
    const outDir = await createTempDir();
    await mkdir(join(outDir, 'helloworld-p001.json'));
    const capture = createStreamCapture();
    const logger = new Logger({ stderr: capture.stderr });
    const document = createFakeDocument(1, [
      { getTextContent: async () => textContent([]) },
    ]);

    const summary = await convertDocument(createOptions(outDir, { text: true }), {
      logger,
      openDocument: createOpenMock(async () => document),
    });

    expect(summary).toMatchObject({ succeededPages: 0, failedPages: 1 });
    expect(capture.stderrText()).toContain('CLI_TEXT_WRITE_FAILED');
    expect(capture.stderrText()).toContain('文本导出失败');
    expect(await readFile(join(outDir, 'helloworld-p001.png'))).toBeInstanceOf(Buffer);
    const entries = await readdir(outDir);
    expect(entries).toEqual(['helloworld-p001.json', 'helloworld-p001.png']);
    expect(entries.some((entry) => entry.includes('.tmp-'))).toBe(false);
  });

  it('文本 API 缺失在逐页前报 CLI_TEXT_UNSUPPORTED 并退出 2', async () => {
    const outDir = await createTempDir();
    const logger = new Logger({ stderr: createStreamCapture().stderr });
    const document = createFakeDocument(1, [{}]);

    try {
      await convertDocument(createOptions(outDir, { text: true }), {
        logger,
        openDocument: createOpenMock(async () => document),
      });
      throw new Error('预期抛出文本 API 缺失错误');
    } catch (error) {
      expect(isCliError(error)).toBe(true);
      expect((error as CliError).code).toBe('CLI_TEXT_UNSUPPORTED');
      expect((error as CliError).exitCode).toBe(EXIT_CODES.DOCUMENT);
    }
    expect(await readdir(outDir)).toEqual([]);
  });

  it('getTextContent 报 OFD_RENDERER_UNSUPPORTED 时映射为 CLI_TEXT_UNSUPPORTED', async () => {
    const outDir = await createTempDir();
    const logger = new Logger({ stderr: createStreamCapture().stderr });
    const exportImage = vi.fn();
    const document = createFakeDocument(1, [
      {
        getTextContent: async () => {
          throw new OFDError('OFD_RENDERER_UNSUPPORTED', '当前页面未绑定文本内容驱动');
        },
        exportImage,
      },
    ]);

    try {
      await convertDocument(createOptions(outDir, { text: true }), {
        logger,
        openDocument: createOpenMock(async () => document),
      });
      throw new Error('预期抛出文本 API 不支持错误');
    } catch (error) {
      expect(isCliError(error)).toBe(true);
      expect((error as CliError).code).toBe('CLI_TEXT_UNSUPPORTED');
      expect((error as CliError).exitCode).toBe(EXIT_CODES.DOCUMENT);
    }
    expect(exportImage).not.toHaveBeenCalled();
    expect(await readdir(outDir)).toEqual([]);
  });
});

describe('convertDocument 进度回调', () => {
  it('逐页开始/结束时各回调一次，进度序号与实际页号分开', async () => {
    const outDir = await createTempDir();
    const logger = new Logger({ stderr: createStreamCapture().stderr });
    const document = createFakeDocument(5, [{}, {}, {}, {}, {}]);
    const events: string[] = [];

    await convertDocument(createOptions(outDir, { pageNumbers: [3, 5] }), {
      logger,
      openDocument: createOpenMock(async () => document),
      onPageStart: ({ index, total, pageNumber }) =>
        events.push(`start ${index}/${total} page=${pageNumber}`),
      onPageEnd: ({ index, total, pageNumber }, ok) =>
        events.push(`end ${index}/${total} page=${pageNumber} ok=${ok}`),
    });

    expect(events).toEqual([
      'start 1/2 page=3',
      'end 1/2 page=3 ok=true',
      'start 2/2 page=5',
      'end 2/2 page=5 ok=true',
    ]);
  });

  it('页面失败时结束回调 ok 为 false', async () => {
    const outDir = await createTempDir();
    const logger = new Logger({ stderr: createStreamCapture().stderr });
    const document = createFakeDocument(2, [
      {},
      {
        exportImage: async () => {
          throw new OFDError('OFD_IMAGE_DECODE', '图片坏了');
        },
      },
    ]);
    const events: string[] = [];

    await convertDocument(createOptions(outDir, { pageNumbers: [1, 2] }), {
      logger,
      openDocument: createOpenMock(async () => document),
      onPageEnd: ({ index }, ok) => events.push(`${index}:${ok}`),
    });

    expect(events).toEqual(['1:true', '2:false']);
  });
});
