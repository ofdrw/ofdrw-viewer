/**
 * CLI 输入源：info/verify/加密转图片向 crypto 传 `byte-source`，且句柄在
 * 成功、异常与取消后关闭；info 对大包只按需读取，不整包读入。
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CryptoError } from '@ofdrw/ofdrw-viewer-crypto';
import type { OFDDocument, OFDPage } from '@ofdrw/ofdrw-viewer-engine';
import { convertDocument } from '../../src/convert.js';
import { runInfo } from '../../src/info.js';
import { Logger } from '../../src/log.js';
import { NodeFileByteSource } from '../../src/node-file-source.js';
import { runVerify } from '../../src/verify.js';
import { createStreamCapture } from './helpers.js';

/** 捕获 crypto 实际收到的输入源。 */
const captured = vi.hoisted(() => ({
  inspectSource: undefined as unknown,
  verifySource: undefined as unknown,
  decryptSource: undefined as unknown,
}));

vi.mock('@ofdrw/ofdrw-viewer-crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ofdrw/ofdrw-viewer-crypto')>();
  return {
    ...actual,
    inspect: (...args: Parameters<typeof actual.inspect>) => {
      captured.inspectSource = args[0];
      return actual.inspect(...args);
    },
    verifyOfd: (...args: Parameters<typeof actual.verifyOfd>) => {
      captured.verifySource = args[0].source;
      return actual.verifyOfd(...args);
    },
    openDecryptingContainer: (...args: Parameters<typeof actual.openDecryptingContainer>) => {
      captured.decryptSource = args[0].source;
      return actual.openDecryptingContainer(...args);
    },
  };
});

/** crypto 共用夹具目录。 */
const FIXTURES = fileURLToPath(
  new URL('../../../ofdrw-viewer-crypto/test/fixtures/crypto/', import.meta.url),
);

/** 较大的真实 OFD，用于证明 info 只按需读取；627,373 byte。 */
const LARGE_INPUT = fileURLToPath(
  new URL('../../../../ofd_pdf_match/不规范资源路径.ofd', import.meta.url),
);

/** 夹具口令与用户名。 */
const PASSWORD = 'FixturePass123';
const PASSWORD_USER = 'fixture-password-user';

/** 临时目录登记。 */
const tempDirs: string[] = [];

/**
 * 创建并登记临时目录。
 *
 * @returns 目录绝对路径
 */
async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ofdrw-cli-byte-source-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * 创建只满足 convert 最小接口的假文档。
 *
 * @returns 假文档
 */
function createFakeDocument(): OFDDocument {
  return {
    pageCount: 1,
    async getPage(): Promise<OFDPage> {
      return {
        getViewport: () => ({ width: 100, height: 100 }),
        async exportImage() {
          return {
            data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
            mime: 'image/png',
            width: 100,
            height: 100,
            dpi: 96,
          };
        },
      } as unknown as OFDPage;
    },
    async close() {},
  } as unknown as OFDDocument;
}

/**
 * 断言 crypto 收到 `byte-source` 且底层是 NodeFileByteSource。
 *
 * @param source crypto 捕获的输入源
 * @returns 底层文件源
 */
function expectByteSource(source: unknown): NodeFileByteSource {
  expect(source).toMatchObject({ kind: 'byte-source' });
  const byteSource = (source as { source?: unknown }).source;
  expect(byteSource).toBeInstanceOf(NodeFileByteSource);
  return byteSource as NodeFileByteSource;
}

/**
 * 断言文件句柄已关闭。
 *
 * @param source 文件源
 */
async function expectClosed(source: NodeFileByteSource): Promise<void> {
  await expect(source.read(0, 1)).rejects.toMatchObject({ code: 'OFD_CLOSED' });
}

describe('info 的随机访问输入', () => {
  it('向 crypto 传 byte-source，只读取少量区间，并在成功后关闭句柄', async () => {
    const size = (await stat(LARGE_INPUT)).size;
    let bytesRead = 0;
    const originalRead = NodeFileByteSource.prototype.read;
    const readSpy = vi
      .spyOn(NodeFileByteSource.prototype, 'read')
      .mockImplementation(async function (
        this: NodeFileByteSource,
        ...args: Parameters<typeof originalRead>
      ) {
        const bytes = await originalRead.apply(this, args);
        bytesRead += bytes.length;
        return bytes;
      });
    const { logger, capture } = createLogger();

    try {
      const code = await runInfo({ inputPath: LARGE_INPUT, json: true }, { logger });
      expect(code).toBe(0);
      const byteSource = expectByteSource(captured.inspectSource);
      expect(bytesRead).toBeGreaterThan(0);
      expect(bytesRead).toBeLessThan(size / 4);
      await expectClosed(byteSource);
      expect(JSON.parse(capture.stdoutText())).toMatchObject({
        command: 'info',
        packageSize: size,
      });
    } finally {
      readSpy.mockRestore();
    }
  });

  it('异常时也关闭句柄', async () => {
    const dir = await createTempDir();
    const input = join(dir, 'bad.ofd');
    await writeFile(input, 'not a zip');
    const { logger } = createLogger();

    await expect(runInfo({ inputPath: input, json: true }, { logger })).rejects.toBeInstanceOf(
      CryptoError,
    );
    const byteSource = expectByteSource(captured.inspectSource);
    await expectClosed(byteSource);
  });

  it('取消时也关闭句柄', async () => {
    const { logger } = createLogger();
    const controller = new AbortController();
    controller.abort();

    await expect(
      runInfo(
        { inputPath: join(FIXTURES, 'plain.ofd'), json: true },
        { logger, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'CRYPTO_ABORTED' });
    const byteSource = expectByteSource(captured.inspectSource);
    await expectClosed(byteSource);
  });
});

describe('verify 的随机访问输入', () => {
  it('向 crypto 传 byte-source 并在成功后关闭句柄', async () => {
    const { logger } = createLogger();
    const code = await runVerify(
      {
        inputPath: join(FIXTURES, 'signed-sesv4.ofd'),
        json: true,
        credentials: {},
        rootPaths: [join(FIXTURES, 'certs', 'root-ca.crt.pem')],
      },
      { logger },
    );

    expect(code).toBe(0);
    const byteSource = expectByteSource(captured.verifySource);
    await expectClosed(byteSource);
  });

  it('凭据错误抛错时也关闭句柄', async () => {
    const { logger } = createLogger();

    await expect(
      runVerify(
        {
          inputPath: join(FIXTURES, 'password-encrypted.ofd'),
          json: true,
          credentials: { user: PASSWORD_USER, password: 'wrong-password' },
          rootPaths: [],
        },
        { logger },
      ),
    ).rejects.toBeInstanceOf(CryptoError);
    const byteSource = expectByteSource(captured.verifySource);
    await expectClosed(byteSource);
  });

  it('取消时也关闭句柄', async () => {
    const { logger } = createLogger();
    const controller = new AbortController();
    controller.abort();

    await expect(
      runVerify(
        {
          inputPath: join(FIXTURES, 'signed-sesv4.ofd'),
          json: true,
          credentials: {},
          rootPaths: [],
        },
        { logger, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'CRYPTO_ABORTED' });
    const byteSource = expectByteSource(captured.verifySource);
    await expectClosed(byteSource);
  });
});

describe('加密转图片的随机访问输入', () => {
  it('向 openDecryptingContainer 传 byte-source，并在结束后关闭句柄', async () => {
    const { logger } = createLogger();
    const outDir = await createTempDir();
    await mkdir(outDir, { recursive: true });
    const openDocument = vi.fn(async () => createFakeDocument()) as unknown as typeof OFDDocument.open;

    const summary = await convertDocument(
      {
        inputPath: join(FIXTURES, 'password-encrypted.ofd'),
        outDir,
        format: 'png',
        dpi: 96,
        pageNumbers: [1],
        fontFiles: [],
        text: false,
        credentials: {
          kind: 'password',
          userName: PASSWORD_USER,
          password: PASSWORD,
        },
      },
      { logger, openDocument },
    );

    expect(summary).toMatchObject({ succeededPages: 1, failedPages: 0 });
    const byteSource = expectByteSource(captured.decryptSource);
    await expectClosed(byteSource);
  });

  it('凭据错误抛错时也关闭句柄', async () => {
    const { logger } = createLogger();
    const outDir = await createTempDir();

    await expect(
      convertDocument(
        {
          inputPath: join(FIXTURES, 'password-encrypted.ofd'),
          outDir,
          format: 'png',
          dpi: 96,
          pageNumbers: [1],
          fontFiles: [],
          text: false,
          credentials: {
            kind: 'password',
            userName: PASSWORD_USER,
            password: 'wrong-password',
          },
        },
        { logger, openDocument: vi.fn(async () => createFakeDocument()) as unknown as typeof OFDDocument.open },
      ),
    ).rejects.toBeInstanceOf(CryptoError);
    const byteSource = expectByteSource(captured.decryptSource);
    await expectClosed(byteSource);
  });
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
