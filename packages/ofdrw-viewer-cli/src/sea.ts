/**
 * SEA（Single Executable Application）启动期的内嵌资源准备。
 *
 * 普通 Node 运行时不做事；SEA 可执行文件启动时把内嵌的
 * `@napi-rs/canvas` JS 包、当前平台 `.node` 与清单解压到临时缓存目录，
 * 再通过环境变量告诉 `canvas.ts` 从哪里加载 Canvas。
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import * as sea from 'node:sea';

/** canvas 资产清单在 SEA 中的键名。 */
const MANIFEST_ASSET_KEY = 'canvas-manifest.json';

/** 缓存完成标记文件名。 */
const CACHE_MARKER = '.complete';

/** 缓存目录名，位于系统临时目录下。 */
const CACHE_ROOT_NAME = 'ofdrw-viewer-cli';

/** 清单格式版本；与构建脚本保持一致。 */
const MANIFEST_SCHEMA_VERSION = 1;

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
 * 普通 Node 下直接返回；SEA 下把内嵌资产解压到
 * `<临时目录>/ofdrw-viewer-cli/<版本>-<平台>-<架构>-<摘要>/`，
 * 并设置 `OFDRW_CANVAS_DIR` 与 `NAPI_RS_NATIVE_LIBRARY_PATH`。
 *
 * 该函数可重复调用；同一进程内只会执行一次解压检查。
 *
 * @returns 资源准备完成的 Promise
 * @throws {SeaAssetError} 资产缺失、平台不匹配或缓存目录不可写时抛出
 */
export function prepareSeaAssets(): Promise<void> {
  preparePromise ??= prepareSeaAssetsOnce();
  return preparePromise;
}

/**
 * 实际执行一次 SEA 资产准备。
 *
 * @returns 资源准备完成的 Promise
 * @throws {SeaAssetError} 资产缺失、平台不匹配或缓存目录不可写时抛出
 */
async function prepareSeaAssetsOnce(): Promise<void> {
  if (!sea.isSea()) return;

  const manifest = readManifest();
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new SeaAssetError(
      `SEA 产物平台不匹配：产物为 ${manifest.platform}-${manifest.arch}，当前运行环境为 ${process.platform}-${process.arch}，请下载对应平台的产物`,
    );
  }

  const cacheRoot = join(tmpdir(), CACHE_ROOT_NAME);
  const cacheDir = join(
    cacheRoot,
    `${manifest.cliVersion}-${manifest.platform}-${manifest.arch}-${manifest.digest}`,
  );

  try {
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    if (!(await isCacheComplete(cacheDir, manifest))) {
      await extractAssets(manifest, cacheRoot, cacheDir);
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

  const valid =
    manifest.schemaVersion === MANIFEST_SCHEMA_VERSION &&
    typeof manifest.cliVersion === 'string' &&
    manifest.cliVersion.length > 0 &&
    typeof manifest.platform === 'string' &&
    typeof manifest.arch === 'string' &&
    typeof manifest.canvasVersion === 'string' &&
    typeof manifest.nativePackage === 'string' &&
    typeof manifest.nodeFile === 'string' &&
    manifest.nodeFile.length > 0 &&
    typeof manifest.digest === 'string' &&
    /^[0-9a-f]{16}$/.test(manifest.digest);

  if (!valid) {
    throw new SeaAssetError('SEA 资产清单字段缺失或格式非法，请重新构建');
  }
  return manifest;
}

/**
 * 判断缓存目录是否已经完整解压。
 *
 * @param cacheDir 缓存目录绝对路径
 * @param manifest 资产清单
 * @returns 缓存可复用时为 `true`
 */
async function isCacheComplete(
  cacheDir: string,
  manifest: CanvasAssetManifest,
): Promise<boolean> {
  try {
    const marker = (await readFile(join(cacheDir, CACHE_MARKER), 'utf8')).trim();
    if (marker !== manifest.digest) return false;
    await stat(join(cacheDir, 'canvas', 'index.js'));
    await stat(join(cacheDir, 'native', manifest.nodeFile));
    return true;
  } catch {
    return false;
  }
}

/**
 * 解压全部内嵌资产。
 *
 * 先写入唯一 staging 目录并落完成标记，再整体 rename 到目标缓存目录；
 * 目标目录已存在但内容不完整时拒绝覆盖，避免破坏非本工具创建的目录。
 *
 * @param manifest 资产清单
 * @param cacheRoot 缓存根目录绝对路径
 * @param cacheDir 目标缓存目录绝对路径
 * @returns 解压完成的 Promise
 * @throws {SeaAssetError} 解压或落盘失败时抛出
 */
async function extractAssets(
  manifest: CanvasAssetManifest,
  cacheRoot: string,
  cacheDir: string,
): Promise<void> {
  const stageDir = join(
    cacheRoot,
    `.tmp-${manifest.digest}-${process.pid}-${Date.now().toString(36)}`,
  );

  try {
    await mkdir(stageDir, { mode: 0o700 });
    for (const key of sea.getAssetKeys()) {
      if (key === MANIFEST_ASSET_KEY) continue;
      const target = resolveAssetPath(stageDir, key);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, Buffer.from(sea.getRawAsset(key)), { mode: 0o600 });
    }
    await writeFile(join(stageDir, CACHE_MARKER), manifest.digest, { mode: 0o600 });
  } catch (error) {
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    throw new SeaAssetError(`解压内嵌 canvas 资源失败：${errorMessage(error)}`, {
      cause: error,
    });
  }

  try {
    await rename(stageDir, cacheDir);
  } catch (error) {
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    if (await isCacheComplete(cacheDir, manifest)) return;
    throw new SeaAssetError(
      `缓存目录已存在且内容不完整：${cacheDir}。请删除该目录后重试（不会自动覆盖非本工具创建的目录）`,
      { cause: error },
    );
  }
}

/**
 * 把 SEA 资产键解析为 staging 目录内的安全路径。
 *
 * @param root staging 根目录绝对路径
 * @param key 资产键，使用 `/` 分隔
 * @returns 资产文件绝对路径
 * @throws {SeaAssetError} 资产键试图越出 staging 目录时抛出
 */
function resolveAssetPath(root: string, key: string): string {
  const target = resolve(root, key);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new SeaAssetError(`SEA 资产键非法：${key}`);
  }
  return target;
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