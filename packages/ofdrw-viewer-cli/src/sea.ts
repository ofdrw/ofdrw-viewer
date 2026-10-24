/**
 * SEA（Single Executable Application）启动期的内嵌资源准备。
 *
 * 普通 Node 运行时不做事；SEA 可执行文件启动时把内嵌的
 * `@napi-rs/canvas` JS 包、当前平台 `.node` 与清单解压到临时缓存目录，
 * 再通过环境变量告诉 `canvas.ts` 从哪里加载 Canvas。
 *
 * 缓存目录可能位于多用户可写的系统临时目录，复用前必须校验属主、权限、
 * 符号链接与全部资产摘要，避免加载他人预置的恶意 JS/native 文件。
 */

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import * as sea from 'node:sea';

/** canvas 资产清单在 SEA 中的键名。 */
const MANIFEST_ASSET_KEY = 'canvas-manifest.json';

/** 缓存完成标记文件名。 */
export const CACHE_MARKER = '.complete';

/** 缓存目录名，位于系统临时目录下。 */
const CACHE_ROOT_NAME = 'ofdrw-viewer-cli';

/** 私有目录权限。 */
const CACHE_DIR_MODE = 0o700;

/** 私有文件权限。 */
const CACHE_FILE_MODE = 0o600;

/** 清单格式版本；与构建脚本保持一致。 */
const MANIFEST_SCHEMA_VERSION = 1;

/** 可安全写入单个路径段的字符。 */
const SAFE_PATH_SEGMENT = /^[0-9A-Za-z.+_-]+$/;

/** canvas 资产清单，由构建脚本生成并内嵌。 */
export interface CanvasAssetManifest {
  /** 清单格式版本。 */
  readonly schemaVersion: number;
  /** CLI 版本，用于缓存目录命名。 */
  readonly cliVersion: string;
  /** 构建产物的平台，如 `linux`。 */
  readonly platform: string;
  /** 构建产物的 CPU 架构，如 `x64`。 */
  readonly arch: string;
  /** `@napi-rs/canvas` 的版本。 */
  readonly canvasVersion: string;
  /** 平台原生包名，如 `@napi-rs/canvas-linux-x64-gnu`。 */
  readonly nativePackage: string;
  /** 平台原生模块文件名，如 `skia.linux-x64-gnu.node`。 */
  readonly nodeFile: string;
  /** 全部内嵌资产的摘要（16 位十六进制），用于区分缓存。 */
  readonly digest: string;
}

/** 缓存路径与校验的可注入参数，供单元测试固定平台与 uid。 */
export interface CacheSecurityOptions {
  /** 平台名，默认 `process.platform`。 */
  readonly platform?: NodeJS.Platform;
  /** 期望属主 uid；默认 POSIX 下读取 `process.getuid()`。 */
  readonly uid?: number;
}

/** 缓存根与版本子目录。 */
export interface CachePaths {
  /** 缓存根目录绝对路径。 */
  readonly root: string;
  /** 本次产物专属缓存目录绝对路径。 */
  readonly dir: string;
}

/** 资源准备失败时抛出的错误，消息面向最终用户。 */
export class SeaAssetError extends Error {
  /**
   * @param message 面向用户的错误说明
   * @param options 可选的底层错误信息
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SeaAssetError';
  }
}

/** 缓存化的准备流程，保证同一进程内只执行一次。 */
let preparePromise: Promise<void> | undefined;

/**
 * 准备 SEA 运行所需的 canvas 资产。
 *
 * 普通 Node 下直接返回；SEA 下把内嵌资产解压到按用户隔离的
 * `<临时目录>/ofdrw-viewer-cli-u<uid>/u<uid>-<版本>-<平台>-<架构>-<摘要>/`
 * （Windows 无 uid 时为 `<临时目录>/ofdrw-viewer-cli/win-.../`），
 * 并设置 `OFDRW_CANVAS_DIR`、`NAPI_RS_NATIVE_LIBRARY_PATH` 与
 * `OFDRW_CLI_VERSION`。
 *
 * @returns 资源准备完成的 Promise
 * @throws {SeaAssetError} 资产缺失、平台不匹配或缓存目录不安全时抛出
 */
export function prepareSeaAssets(): Promise<void> {
  preparePromise ??= prepareSeaAssetsOnce();
  return preparePromise;
}

/**
 * 计算缓存根与版本子目录。
 *
 * POSIX 下缓存根带 uid（`ofdrw-viewer-cli-u<uid>`），避免 Linux 共享
 * /tmp 时首个用户的 0700 根阻塞其他用户；Windows 无 uid 时保留固定根名。
 * 版本子目录继续包含 uid、版本、平台、架构与摘要。
 *
 * @param manifest 资产清单
 * @param options 平台、uid 与临时目录覆盖（测试用）
 * @returns 缓存路径
 * @throws {SeaAssetError} 清单中的路径段含非法字符时抛出
 */
export function buildCachePaths(
  manifest: Pick<CanvasAssetManifest, 'cliVersion' | 'platform' | 'arch' | 'digest'>,
  options: CacheSecurityOptions & { readonly tmpDir?: string } = {},
): CachePaths {
  const platform = options.platform ?? process.platform;
  for (const [label, value] of [
    ['cliVersion', manifest.cliVersion],
    ['platform', manifest.platform],
    ['arch', manifest.arch],
    ['digest', manifest.digest],
  ] as const) {
    if (!SAFE_PATH_SEGMENT.test(value)) {
      throw new SeaAssetError(`SEA 资产清单 ${label} 含非法路径字符，请重新构建`);
    }
  }
  const uid = currentUid(platform, options.uid);
  const namespace = uid === undefined ? 'win' : `u${uid}`;
  const rootName =
    uid === undefined ? CACHE_ROOT_NAME : `${CACHE_ROOT_NAME}-${namespace}`;
  // 缓存根必须为绝对路径：TMPDIR 为相对路径时（如 `TMPDIR=tmp`）`tmpdir()` 原样返回相对值，
  // 会让 staging 目录路径不安全进而解压失败，这里统一解析为绝对路径。
  const root = resolve(options.tmpDir ?? tmpdir(), rootName);
  const dir = join(
    root,
    `${namespace}-${manifest.cliVersion}-${manifest.platform}-${manifest.arch}-${manifest.digest}`,
  );
  return { root, dir };
}

/**
 * 实际执行一次 SEA 资产准备。
 *
 * @returns 资源准备完成的 Promise
 * @throws {SeaAssetError} 资产缺失、平台不匹配或缓存目录不安全时抛出
 */
async function prepareSeaAssetsOnce(): Promise<void> {
  if (!sea.isSea()) return;

  const manifest = readManifest();
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new SeaAssetError(
      `SEA 产物平台不匹配：产物为 ${manifest.platform}-${manifest.arch}，当前运行环境为 ${process.platform}-${process.arch}，请下载对应平台的产物`,
    );
  }

  const assetKeys = embeddedAssetKeys();
  if (assetKeys.length === 0) {
    throw new SeaAssetError('SEA 产物没有内嵌 canvas 资产，请重新构建');
  }
  const nodeAssetKey = `native/${manifest.nodeFile}`;
  if (!assetKeys.includes(nodeAssetKey)) {
    throw new SeaAssetError(`SEA 资产缺少原生模块 ${nodeAssetKey}，请重新构建`);
  }

  const { root: cacheRoot, dir: cacheDir } = buildCachePaths(manifest);
  try {
    await ensureCacheRoot(cacheRoot);
    if (!(await isCacheComplete(cacheRoot, cacheDir, manifest, assetKeys))) {
      await extractAssets(manifest, cacheRoot, cacheDir, assetKeys);
    }
  } catch (error) {
    if (error instanceof SeaAssetError) throw error;
    throw new SeaAssetError(
      `无法准备内嵌 canvas 资源（缓存目录：${cacheDir}）：${errorMessage(error)}。请确认系统临时目录可写且磁盘空间充足`,
      { cause: error },
    );
  }

  process.env.OFDRW_CANVAS_DIR = cacheDir;
  process.env.NAPI_RS_NATIVE_LIBRARY_PATH = join(cacheDir, 'native', manifest.nodeFile);
  process.env.OFDRW_CLI_VERSION = manifest.cliVersion;
}

/**
 * 读取并校验内嵌的 canvas 资产清单。
 *
 * @returns 校验通过的资产清单
 * @throws {SeaAssetError} 清单缺失或字段非法时抛出
 */
function readManifest(): CanvasAssetManifest {
  if (!sea.getAssetKeys().includes(MANIFEST_ASSET_KEY)) {
    throw new SeaAssetError(`SEA 产物缺少资产清单 ${MANIFEST_ASSET_KEY}，请重新构建`);
  }

  let manifest: CanvasAssetManifest;
  try {
    manifest = JSON.parse(
      new TextDecoder().decode(sea.getRawAsset(MANIFEST_ASSET_KEY)),
    ) as CanvasAssetManifest;
  } catch (error) {
    throw new SeaAssetError(`SEA 资产清单不是合法 JSON：${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (typeof manifest !== 'object' || manifest === null) {
    throw new SeaAssetError('SEA 资产清单不是 JSON 对象，请重新构建');
  }

  const valid =
    manifest.schemaVersion === MANIFEST_SCHEMA_VERSION &&
    isSafePathSegment(manifest.cliVersion) &&
    isSafePathSegment(manifest.platform) &&
    isSafePathSegment(manifest.arch) &&
    typeof manifest.canvasVersion === 'string' &&
    typeof manifest.nativePackage === 'string' &&
    isSafePathSegment(manifest.nodeFile) &&
    typeof manifest.digest === 'string' &&
    /^[0-9a-f]{16}$/.test(manifest.digest);

  if (!valid) {
    throw new SeaAssetError('SEA 资产清单字段缺失或格式非法，请重新构建');
  }
  return manifest;
}

/**
 * 判断缓存目录是否已经完整、安全地解压。
 *
 * 只读校验全部目录/文件：拒绝符号链接、错误属主与过宽权限；随后按构建
 * 脚本相同算法重算全部资产摘要，避免预置 `.complete` 后加载恶意文件。
 *
 * @param cacheRoot 缓存根目录绝对路径
 * @param cacheDir 缓存目录绝对路径
 * @param manifest 资产清单
 * @param assetKeys 内嵌资产键（不含清单自身）
 * @param options 平台与 uid 覆盖（测试用）
 * @returns 缓存可安全复用时为 `true`；目录/文件缺失时为 `false`
 * @throws {SeaAssetError} 缓存存在但属主、权限、链接或摘要不安全时抛出
 */
export async function isCacheComplete(
  cacheRoot: string,
  cacheDir: string,
  manifest: CanvasAssetManifest,
  assetKeys: readonly string[],
  options: CacheSecurityOptions = {},
): Promise<boolean> {
  try {
    await assertSecureCacheEntry(cacheRoot, 'dir', options);
    await assertSecureCacheEntry(cacheDir, 'dir', options);

    const directories = new Set<string>();
    for (const key of assetKeys) {
      const target = resolveAssetPath(cacheDir, key);
      directories.add(dirname(target));
      await assertSecureCacheEntry(target, 'file', options);
    }
    for (const directory of directories) {
      await assertSecureCacheEntry(directory, 'dir', options);
    }

    const markerPath = join(cacheDir, CACHE_MARKER);
    await assertSecureCacheEntry(markerPath, 'file', options);
    const marker = (await readFile(markerPath, 'utf8')).trim();
    if (marker !== manifest.digest) return false;

    const actualDigest = await computeAssetDigest(cacheDir, assetKeys);
    if (actualDigest !== manifest.digest) {
      throw new SeaAssetError(
        `SEA 缓存资产摘要不匹配：${cacheDir}。请删除该缓存目录后重试`,
      );
    }
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/**
 * 校验单个缓存路径的类型、属主、权限与符号链接。
 *
 * POSIX 下要求属主为当前 uid、目录 0700、文件 0600；Windows 至少拒绝
 * 符号链接/重解析点，不检查 POSIX 权限位。
 *
 * @param path 待校验路径
 * @param kind 期望类型：目录或普通文件
 * @param options 平台与 uid 覆盖（测试用）
 * @throws {SeaAssetError} 路径不安全或类型不符时抛出
 */
export async function assertSecureCacheEntry(
  path: string,
  kind: 'dir' | 'file',
  options: CacheSecurityOptions = {},
): Promise<void> {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isNotFound(error)) throw error;
    throw new SeaAssetError(`无法检查 SEA 缓存路径：${path}（${errorMessage(error)}）`, {
      cause: error,
    });
  }

  if (stats.isSymbolicLink()) {
    throw new SeaAssetError(`SEA 缓存路径不能是符号链接：${path}`);
  }
  if (kind === 'dir' ? !stats.isDirectory() : !stats.isFile()) {
    throw new SeaAssetError(`SEA 缓存路径类型不正确（期望${kind === 'dir' ? '目录' : '文件'}）：${path}`);
  }

  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return;
  const uid = currentUid(platform, options.uid);
  if (uid !== undefined && stats.uid !== uid) {
    throw new SeaAssetError(
      `SEA 缓存路径属主异常：${path}（期望 uid ${uid}，实际 ${stats.uid}）`,
    );
  }
  const expectedMode = kind === 'dir' ? CACHE_DIR_MODE : CACHE_FILE_MODE;
  const actualMode = stats.mode & 0o777;
  if (actualMode !== expectedMode) {
    throw new SeaAssetError(
      `SEA 缓存路径权限异常：${path}（期望 0${expectedMode.toString(8)}，实际 0${actualMode.toString(8)}）`,
    );
  }
}

/**
 * 按构建脚本相同算法计算资产摘要。
 *
 * 键排序后依次更新 `key + NUL + 内容`，取 sha256 前 16 位十六进制。
 *
 * @param root 资产根目录
 * @param assetKeys 资产键（使用 `/` 分隔）
 * @returns 16 位十六进制摘要
 */
export async function computeAssetDigest(
  root: string,
  assetKeys: readonly string[],
): Promise<string> {
  const hash = createHash('sha256');
  for (const key of [...assetKeys].sort()) {
    hash.update(key);
    hash.update('\0');
    hash.update(await readFile(resolveAssetPath(root, key)));
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * 确保缓存根目录存在且安全。
 *
 * @param cacheRoot 缓存根目录绝对路径
 * @throws {SeaAssetError} 创建失败或权限/属主/链接不安全时抛出
 */
async function ensureCacheRoot(cacheRoot: string): Promise<void> {
  try {
    await mkdir(cacheRoot, { recursive: true, mode: CACHE_DIR_MODE });
  } catch (error) {
    throw new SeaAssetError(
      `无法创建 SEA 缓存根目录：${cacheRoot}（${errorMessage(error)}）`,
      { cause: error },
    );
  }
  await assertSecureCacheEntry(cacheRoot, 'dir');
}

/**
 * 解压全部内嵌资产。
 *
 * 先写入唯一 staging 目录并校验摘要，再整体 rename 到目标缓存目录；
 * 目标目录已存在但内容不完整时拒绝覆盖，避免破坏非本工具创建的目录。
 *
 * @param manifest 资产清单
 * @param cacheRoot 缓存根目录绝对路径
 * @param cacheDir 目标缓存目录绝对路径
 * @param assetKeys 内嵌资产键
 * @returns 解压完成的 Promise
 * @throws {SeaAssetError} 解压或落盘失败时抛出
 */
async function extractAssets(
  manifest: CanvasAssetManifest,
  cacheRoot: string,
  cacheDir: string,
  assetKeys: readonly string[],
): Promise<void> {
  const stageDir = join(
    cacheRoot,
    `.tmp-${manifest.digest}-${process.pid}-${Date.now().toString(36)}`,
  );

  try {
    await mkdir(stageDir, { mode: CACHE_DIR_MODE });
    for (const key of assetKeys) {
      const target = resolveAssetPath(stageDir, key);
      await mkdir(dirname(target), { recursive: true, mode: CACHE_DIR_MODE });
      await writeFile(target, Buffer.from(sea.getRawAsset(key)), { mode: CACHE_FILE_MODE });
    }
    await writeFile(join(stageDir, CACHE_MARKER), manifest.digest, {
      mode: CACHE_FILE_MODE,
    });
    const actualDigest = await computeAssetDigest(stageDir, assetKeys);
    if (actualDigest !== manifest.digest) {
      throw new SeaAssetError('内嵌 canvas 资产摘要与清单不一致，SEA 产物可能已损坏');
    }
  } catch (error) {
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof SeaAssetError) throw error;
    throw new SeaAssetError(`解压内嵌 canvas 资源失败：${errorMessage(error)}`, {
      cause: error,
    });
  }

  try {
    await rename(stageDir, cacheDir);
  } catch (error) {
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    if (await isCacheComplete(cacheRoot, cacheDir, manifest, assetKeys)) return;
    throw new SeaAssetError(
      `缓存目录已存在且内容不完整：${cacheDir}。请删除该目录后重试（不会自动覆盖非本工具创建的目录）`,
      { cause: error },
    );
  }
}

/**
 * 把 SEA 资产键解析为 staging/缓存目录内的安全路径。
 *
 * @param root 根目录绝对路径
 * @param key 资产键，使用 `/` 分隔
 * @returns 资产文件绝对路径
 * @throws {SeaAssetError} 资产键为空、含反斜杠或试图越出根目录时抛出
 */
function resolveAssetPath(root: string, key: string): string {
  if (key.length === 0 || key.includes('\\')) {
    throw new SeaAssetError(`SEA 资产键非法：${key}`);
  }
  const target = resolve(root, key);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new SeaAssetError(`SEA 资产键非法：${key}`);
  }
  return target;
}

/** 读取全部内嵌资产键，排除清单自身。 */
function embeddedAssetKeys(): string[] {
  return sea.getAssetKeys().filter((key) => key !== MANIFEST_ASSET_KEY);
}

/** 判断字符串是否可安全写入单个路径段。 */
function isSafePathSegment(value: unknown): value is string {
  return typeof value === 'string' && SAFE_PATH_SEGMENT.test(value) && !value.includes('..');
}

/** 获取当前平台 uid；Windows 无 uid 时返回 undefined。 */
function currentUid(
  platform: NodeJS.Platform,
  override: number | undefined,
): number | undefined {
  if (override !== undefined) return override;
  if (platform === 'win32') return undefined;
  return process.getuid?.();
}

/** 判断错误是否为路径不存在。 */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * 提取错误的可读消息。
 *
 * @param error 任意错误值
 * @returns 面向用户的错误消息
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
