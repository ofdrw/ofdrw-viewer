/**
 * V-CLI 独立验证共享工具。
 *
 * 只通过 CLI 源码入口 `main` 或真实构建产物观察行为；夹具来自 crypto 包，
 * 不导入 CLI 的 unit/acceptance 辅助，避免复用被测实现内部的期望。
 */

import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadImage } from '@napi-rs/canvas';
import { main } from '../../src/cli.js';
import type { OutputStream } from '../../src/log.js';

/** crypto 受保护样例目录。 */
export const FIXTURES = fileURLToPath(
  new URL('../../../ofdrw-viewer-crypto/test/fixtures/crypto/', import.meta.url),
);

/** 口令用户名。 */
export const PASSWORD_USER = 'fixture-password-user';

/** 证书用户名。 */
export const CERT_USER = 'fixture-cert-user';

/** 夹具口令（仅测试使用）。 */
export const PASSWORD = 'FixturePass123';

/** 根证书 PEM。 */
export const ROOT_PEM = join(FIXTURES, 'certs', 'root-ca.crt.pem');

/**
 * 中文字体候选。
 *
 * 字体文件不提交版本库（仓库根 `test/.fixtures/` 被 gitignore），本机可能有
 * 历史缓存，CI 依赖 `fonts-droid-fallback` / `fonts-noto-cjk` 注入；全部缺失时
 * 由调用方跳过对应用例，而不是伪造通过。
 */
const FONT_CANDIDATES = [
  fileURLToPath(new URL('../../../../test/.fixtures/fonts/DroidSansFallbackFull.ttf', import.meta.url)),
  '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc',
  '/mnt/c/Windows/Fonts/simsun.ttc',
  '/mnt/c/Windows/Fonts/msyh.ttc',
];

/** 首个可用的中文字体绝对路径；全部缺失时为 null。 */
export const FONT_FILE: string | null =
  FONT_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;

/** 根证书 DER。 */
export const ROOT_DER = join(FIXTURES, 'certs', 'root-ca.crt.der');

/** 加密证书私钥 PEM。 */
export const ENCRYPT_KEY = join(FIXTURES, 'certs', 'encrypt.key.pem');

/** 不匹配的签名私钥 PEM。 */
export const SIGNER_KEY = join(FIXTURES, 'certs', 'signer.key.pem');

/** 临时目录登记表。 */
const tempDirs: string[] = [];

/**
 * 返回夹具绝对路径。
 *
 * @param name 文件名
 * @returns 绝对路径
 */
export function fixture(name: string): string {
  return join(FIXTURES, name);
}

/**
 * 返回证书绝对路径。
 *
 * @param name 文件名
 * @returns 绝对路径
 */
export function cert(name: string): string {
  return join(FIXTURES, 'certs', name);
}

/**
 * 创建并登记临时目录。
 *
 * @param prefix 目录名前缀
 * @returns 绝对路径
 */
export async function createTempDir(prefix = 'ofdrw-vcli-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * 创建只含一个中文字体的字体目录，避免扫描整个仓库字体目录。
 *
 * 保留字体原文件名：格式由扩展名决定，`.ttc` 改名为 `.ttf` 会导致加载失败。
 *
 * @returns 字体目录绝对路径；环境中没有可用中文字体时为 null
 */
export async function createFontDir(): Promise<string | null> {
  if (FONT_FILE === null) return null;
  const dir = join(await createTempDir('ofdrw-vcli-font-'), 'fonts');
  await mkdir(dir, { recursive: true });
  await copyFile(FONT_FILE, join(dir, basename(FONT_FILE)));
  return dir;
}

/** 清理本测试进程登记的全部临时目录。 */
export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

/** 内存输出流。 */
export interface Capture {
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  stdoutText(): string;
  stderrText(): string;
}

/**
 * 创建输出捕获器。
 *
 * @returns 可注入 main 的输出流与文本读取函数
 */
export function createCapture(): Capture {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
    stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

/** 源码入口的运行结果。 */
export interface MainResult {
  /** 退出码。 */
  readonly code: number;
  /** 标准输出。 */
  readonly stdout: string;
  /** 标准错误。 */
  readonly stderr: string;
}

/**
 * 以固定 cwd 调用 CLI 源码入口。
 *
 * @param args 不含 node/脚本路径的参数
 * @param cwd 当前目录
 * @returns 退出码与输出
 */
export async function runMain(args: readonly string[], cwd: string): Promise<MainResult> {
  const capture = createCapture();
  const code = await main([...args], {
    cwd,
    stdout: capture.stdout,
    stderr: capture.stderr,
    platform: 'verification-os',
    arch: 'verification-arch',
  });
  return { code, stdout: capture.stdoutText(), stderr: capture.stderrText() };
}

/**
 * 解析一段 JSON 输出。
 *
 * @param text stdout 文本
 * @returns 解析后的对象
 */
export function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`输出不是合法 JSON：${text.slice(0, 400)}`, { cause: error });
  }
}

/**
 * 列出目录内的普通文件（不含子目录）。
 *
 * @param dir 目录
 * @returns 排序后的文件名
 */
export async function listFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir);
  const files: string[] = [];
  for (const name of names) {
    if ((await stat(join(dir, name))).isFile()) files.push(name);
  }
  return files.sort();
}

/** PNG 解码后的基本信息。 */
export interface ImageInfo {
  /** 宽，px。 */
  readonly width: number;
  /** 高，px。 */
  readonly height: number;
  /** 文件字节。 */
  readonly bytes: Buffer;
}

/**
 * 解码 PNG 并确认文件头。
 *
 * @param path 图片路径
 * @returns 尺寸与字节
 */
export async function inspectPng(path: string): Promise<ImageInfo> {
  const bytes = await readFile(path);
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`PNG 文件头不正确：${path}`);
  }
  const image = await loadImage(bytes);
  if (image.width <= 0 || image.height <= 0) {
    throw new Error(`PNG 尺寸非法：${image.width}x${image.height}`);
  }
  return { width: image.width, height: image.height, bytes };
}

/** 空间文本记录（CLI JSON 的五字段）。 */
export interface TextRecord {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * 读取 CLI 写出的空间文本 JSON，并逐项校验字段集合。
 *
 * @param path JSON 路径
 * @returns 记录数组
 */
export async function readText(path: string): Promise<TextRecord[]> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error('文本 JSON 顶层不是数组');
  for (const [index, item] of parsed.entries()) {
    if (typeof item !== 'object' || item === null) throw new Error(`第 ${index} 项不是对象`);
    const keys = Object.keys(item).sort();
    if (keys.join(',') !== 'h,text,w,x,y') {
      throw new Error(`第 ${index} 项字段不正确：${keys.join(',')}`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.text !== 'string' || record.text.length === 0) {
      throw new Error(`第 ${index} 项 text 为空`);
    }
    for (const key of ['x', 'y', 'w', 'h']) {
      if (typeof record[key] !== 'number' || !Number.isFinite(record[key])) {
        throw new Error(`第 ${index} 项 ${key} 不是数字`);
      }
    }
  }
  return parsed as TextRecord[];
}
