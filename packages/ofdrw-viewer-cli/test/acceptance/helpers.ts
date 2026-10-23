/**
 * 图片 CLI 黑盒验收辅助。
 *
 * 验收只通过真实进程（`dist/bin.js` 或 SEA 可执行文件）观察行为；
 * engine 公共 API 仅作为 `getViewport` 尺寸的独立 oracle，不参与被测链路。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';

/** 仓库根目录。 */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** CLI 包目录。 */
export const CLI_DIR = join(REPO_ROOT, 'packages', 'ofdrw-viewer-cli');

/** 普通 Node 运行方式下的 CLI 入口（构建产物）。 */
export const CLI_BIN = join(CLI_DIR, 'dist', 'bin.js');

/** SEA 可执行文件路径；与 `scripts/build-sea.mjs` 的输出保持一致。 */
export const SEA_BIN = join(
  CLI_DIR,
  'dist',
  'sea',
  process.platform === 'win32' ? 'ofdrw-viewer-cli.exe' : 'ofdrw-viewer-cli',
);

/** 真实 OFD 样本目录。 */
export const SAMPLE_DIR = join(REPO_ROOT, 'ofd_pdf_match');

/** 单页样本。 */
export const HELLO_OFD = join(SAMPLE_DIR, 'helloworld.ofd');

/** 多页样本（5 页）。 */
export const MULTI_OFD = join(SAMPLE_DIR, '999.ofd');

/** 文本主样本：2 页，第 1 页 147 项、第 2 页 8,331 项。 */
export const DENSE_OFD = join(SAMPLE_DIR, 'dense-text-perf.ofd');

/** crypto 共用受保护夹具目录。 */
export const CRYPTO_FIXTURES = join(
  REPO_ROOT,
  'packages',
  'ofdrw-viewer-crypto',
  'test',
  'fixtures',
  'crypto',
);

/** 夹具口令用户名。 */
export const CRYPTO_PASSWORD_USER = 'fixture-password-user';

/** 夹具口令。 */
export const CRYPTO_PASSWORD = 'FixturePass123';

/** 夹具证书用户名。 */
export const CRYPTO_CERT_USER = 'fixture-cert-user';

/** 夹具信任根（PEM）。 */
export const CRYPTO_ROOT = join(CRYPTO_FIXTURES, 'certs', 'root-ca.crt.pem');

/** 验收用字体候选：优先仓库本地夹具，其次常见系统字体。 */
const FONT_CANDIDATES = [
  join(REPO_ROOT, 'test', '.fixtures', 'fonts', 'DroidSansFallbackFull.ttf'),
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  'C:\\Windows\\Fonts\\arial.ttf',
];

/** 已登记、待清理的临时目录。 */
const tempDirs: string[] = [];

/**
 * 创建并登记一个临时目录。
 *
 * @param prefix 目录名前缀
 * @returns 临时目录绝对路径
 */
export async function createTempDir(prefix = 'ofdrw-cli-accept-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 清理本文件登记的临时目录；由各验收文件的 `afterEach` 调用。 */
export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
}

/** 子进程运行结果。 */
export interface ProcessResult {
  /** 退出码；被信号终止时为 `null`。 */
  readonly code: number | null;
  /** 终止信号；正常退出时为 `null`。 */
  readonly signal: NodeJS.Signals | null;
  /** 标准输出。 */
  readonly stdout: string;
  /** 标准错误。 */
  readonly stderr: string;
  /** 从启动到退出的耗时，单位毫秒。 */
  readonly durationMs: number;
  /** 是否因内部超时被 SIGKILL。 */
  readonly timedOut: boolean;
}

/** 运行子进程的选项。 */
export interface RunOptions {
  /** 工作目录，默认仓库根目录。 */
  readonly cwd?: string;
  /** 完整环境变量；省略时继承当前进程。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 启动后等待多少毫秒发送一次 SIGINT；用于中断用例。 */
  readonly sigintAfterMs?: number;
  /** 内部看门狗超时，单位毫秒，默认 120 秒。 */
  readonly timeoutMs?: number;
}

/**
 * 启动子进程并收集 stdout/stderr/退出码。
 *
 * @param command 可执行文件路径
 * @param args 参数数组
 * @param options 运行选项
 * @returns 进程结果
 */
export function runProcess(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, [...args], {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const sigintTimer =
      options.sigintAfterMs === undefined
        ? undefined
        : setTimeout(() => child.kill('SIGINT'), options.sigintAfterMs);
    const watchdog = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(sigintTimer);
      clearTimeout(watchdog);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(sigintTimer);
      clearTimeout(watchdog);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}

/**
 * 以普通 Node 运行 `dist/bin.js`。
 *
 * @param args CLI 参数
 * @param options 运行选项
 * @returns 进程结果
 */
export function runCli(
  args: readonly string[],
  options: RunOptions = {},
): Promise<ProcessResult> {
  return runProcess(process.execPath, [CLI_BIN, ...args], options);
}

/**
 * 运行 SEA 可执行文件。
 *
 * @param args CLI 参数
 * @param options 运行选项
 * @returns 进程结果
 */
export function runSea(
  args: readonly string[],
  options: RunOptions = {},
): Promise<ProcessResult> {
  return runProcess(SEA_BIN, args, options);
}

/**
 * 列出目录内的文件（不含子目录），按名称排序。
 *
 * @param dir 目录绝对路径
 * @returns 文件名数组
 */
export async function listFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir);
  const files: string[] = [];
  for (const name of names) {
    const info = await stat(join(dir, name));
    if (info.isFile()) files.push(name);
  }
  return files.sort();
}

/**
 * 递归列出目录内全部条目（含子目录），按路径排序。
 *
 * @param dir 目录绝对路径
 * @returns 相对路径数组
 */
export async function listAllEntries(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  return (await readdir(dir, { recursive: true })).sort();
}

/**
 * 查找目录内是否存在原子写临时文件残留。
 *
 * @param dir 目录绝对路径
 * @returns 含 `.tmp-` 的条目
 */
export async function findTempArtifacts(dir: string): Promise<string[]> {
  return (await listAllEntries(dir)).filter((entry) => entry.includes('.tmp-'));
}

/** 图片检查结果。 */
export interface ImageInspection {
  /** 宽，像素。 */
  readonly width: number;
  /** 高，像素。 */
  readonly height: number;
  /** 原始文件字节。 */
  readonly bytes: Buffer;
  /** 左上角 (2,2) 是否接近白色（RGB 均 >= 阈值）。 */
  readonly cornerIsWhite: boolean;
  /** 按步长抽样得到的非白像素数量。 */
  readonly nonWhiteSamples: number;
}

/**
 * 解码图片并检查尺寸、magic、白底与是否非空白。
 *
 * @param filePath 图片绝对路径
 * @param whiteThreshold 白底判定阈值（0..255），JPEG 可适当放宽
 * @returns 检查结果
 */
export async function inspectImage(
  filePath: string,
  whiteThreshold = 245,
): Promise<ImageInspection> {
  const bytes = await readFile(filePath);
  const image = await loadImage(bytes);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height).data;

  const step = 7;
  let nonWhiteSamples = 0;
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const index = (y * image.width + x) * 4;
      const red = data[index] ?? 0;
      const green = data[index + 1] ?? 0;
      const blue = data[index + 2] ?? 0;
      if (red < whiteThreshold || green < whiteThreshold || blue < whiteThreshold) {
        nonWhiteSamples += 1;
      }
    }
  }

  const cornerIndex = (Math.min(2, image.height - 1) * image.width + Math.min(2, image.width - 1)) * 4;
  const cornerIsWhite = [0, 1, 2].every(
    (offset) => (data[cornerIndex + offset] ?? 0) >= whiteThreshold,
  );

  return {
    width: image.width,
    height: image.height,
    bytes,
    cornerIsWhite,
    nonWhiteSamples,
  };
}

/** 页面在指定 DPI 下的 viewport 尺寸（px）。 */
export interface ViewportSize {
  /** 宽，像素。 */
  readonly width: number;
  /** 高，像素。 */
  readonly height: number;
}

/**
 * 用 engine 公共 API 读取样本页数。
 *
 * @param samplePath OFD 样本路径
 * @returns 文档页数
 */
export async function readSamplePageCount(samplePath: string): Promise<number> {
  const document = await OFDDocument.open({
    source: { kind: 'arraybuffer', data: await readFile(samplePath) },
  });
  try {
    return document.pageCount;
  } finally {
    await document.close();
  }
}

/**
 * 用 engine 公共 API 读取指定页在指定 DPI 下的 viewport。
 *
 * @param samplePath OFD 样本路径
 * @param pageIndex 页索引（0 起）
 * @param dpi 输出 DPI
 * @returns viewport 尺寸
 */
export async function readViewport(
  samplePath: string,
  pageIndex: number,
  dpi: number,
): Promise<ViewportSize> {
  const document = await OFDDocument.open({
    source: { kind: 'arraybuffer', data: await readFile(samplePath) },
  });
  try {
    const page = await document.getPage(pageIndex);
    const viewport = page.getViewport({ dpi });
    return { width: viewport.width, height: viewport.height };
  } finally {
    await document.close();
  }
}

/**
 * 查找可用的字体文件，供 `--font-dir` 用例复制。
 *
 * @returns 字体绝对路径；一个都不存在时为 `undefined`
 */
export function findAvailableFont(): string | undefined {
  return FONT_CANDIDATES.find((candidate) => existsSync(candidate));
}

/**
 * 把字体复制到目标目录（可指定子目录），用于验证递归扫描。
 *
 * @param fontPath 源字体路径
 * @param fontDir 目标字体根目录
 * @param subDir 目标子目录名
 * @returns 复制后的字体路径
 */
export async function copyFontInto(
  fontPath: string,
  fontDir: string,
  subDir?: string,
): Promise<string> {
  const targetDir = subDir === undefined ? fontDir : join(fontDir, subDir);
  await mkdir(targetDir, { recursive: true });
  const target = join(targetDir, `acceptance-${process.pid}.ttf`);
  await copyFile(fontPath, target);
  return target;
}

/** 空间文本记录；与 CLI 输出的五个字段一致。 */
export interface TextRecord {
  /** 文本内容。 */
  readonly text: string;
  /** 包围盒左上角 x，px。 */
  readonly x: number;
  /** 包围盒左上角 y，px。 */
  readonly y: number;
  /** 包围盒宽，px。 */
  readonly w: number;
  /** 包围盒高，px。 */
  readonly h: number;
}

/**
 * 用 engine 公共 API 读取一页空间文本，作为 CLI JSON 的 oracle。
 *
 * 独立按 `rect` 映射为 text/x/y/w/h，并过滤空 text，避免复用 CLI 的
 * `buildTextRecords` 掩盖字段映射错误。
 *
 * @param samplePath OFD 样本路径
 * @param pageIndex 页索引（0 起）
 * @param dpi 输出 DPI
 * @returns 与 CLI JSON 同结构的记录数组
 */
export async function readTextOracle(
  samplePath: string,
  pageIndex: number,
  dpi: number,
): Promise<TextRecord[]> {
  const document = await OFDDocument.open({
    source: { kind: 'arraybuffer', data: await readFile(samplePath) },
  });
  try {
    const page = await document.getPage(pageIndex);
    const content = await page.getTextContent({ dpi, includeChars: false });
    return content.items
      .filter((item) => item.text.length > 0)
      .map((item) => ({
        text: item.text,
        x: item.rect.x,
        y: item.rect.y,
        w: item.rect.width,
        h: item.rect.height,
      }));
  } finally {
    await document.close();
  }
}

/**
 * 读取 CLI 写出的空间文本 JSON 及其字节数。
 *
 * @param filePath JSON 绝对路径
 * @returns 解析后的记录数组与文件字节数
 */
export async function readTextJson(
  filePath: string,
): Promise<{ records: TextRecord[]; bytes: number }> {
  const raw = await readFile(filePath);
  return {
    records: JSON.parse(raw.toString('utf8')) as TextRecord[],
    bytes: raw.byteLength,
  };
}

/**
 * 读取文件前若干字节的十六进制字符串，便于断言 magic。
 *
 * @param filePath 文件路径
 * @param count 字节数
 * @returns 小写十六进制字符串
 */
export async function readHexPrefix(filePath: string, count: number): Promise<string> {
  const bytes = await readFile(filePath);
  return bytes.subarray(0, count).toString('hex');
}