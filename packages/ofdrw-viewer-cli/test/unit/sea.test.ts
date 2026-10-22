import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CACHE_MARKER,
  SeaAssetError,
  assertSecureCacheEntry,
  buildCachePaths,
  computeAssetDigest,
  isCacheComplete,
} from '../../src/sea.js';
import type { CanvasAssetManifest } from '../../src/sea.js';

const tempDirs: string[] = [];
const UID = process.getuid?.();
const POSIX = process.platform !== 'win32';

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 创建测试临时目录并登记清理。 */
async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ofdrw-cli-sea-unit-'));
  tempDirs.push(dir);
  return dir;
}

/** 构造合法清单；摘要由缓存内容计算。 */
function createManifest(digest: string): CanvasAssetManifest {
  return {
    schemaVersion: 1,
    cliVersion: '0.1.0',
    platform: 'linux',
    arch: 'x64',
    canvasVersion: '1.0.0',
    nativePackage: '@napi-rs/canvas-linux-x64-gnu',
    nodeFile: 'x.node',
    digest,
  };
}

/** 创建一份合法的缓存树。 */
async function createCache(): Promise<{
  root: string;
  dir: string;
  manifest: CanvasAssetManifest;
  assetKeys: string[];
}> {
  const root = await createTempDir();
  const dir = join(root, 'cache');
  const assets: Record<string, string> = {
    'canvas/index.js': 'module.exports = {};',
    'native/x.node': 'native',
    'native/package.json': '{"name":"native"}',
  };
  await mkdir(join(dir, 'canvas'), { recursive: true, mode: 0o700 });
  await mkdir(join(dir, 'native'), { recursive: true, mode: 0o700 });
  for (const [key, value] of Object.entries(assets)) {
    await writeFile(join(dir, key), value, { mode: 0o600 });
  }
  const assetKeys = Object.keys(assets).sort();
  const digest = await computeAssetDigest(dir, assetKeys);
  await writeFile(join(dir, CACHE_MARKER), digest, { mode: 0o600 });
  return { root, dir, manifest: createManifest(digest), assetKeys };
}

/** 校验合法缓存。 */
function expectComplete(
  cache: Awaited<ReturnType<typeof createCache>>,
  options: { uid?: number; platform?: NodeJS.Platform } = {},
): Promise<boolean> {
  return isCacheComplete(cache.root, cache.dir, cache.manifest, cache.assetKeys, {
    platform: 'linux',
    ...(UID === undefined ? {} : { uid: UID }),
    ...options,
  });
}

describe.skipIf(!POSIX)('SEA 缓存安全校验', () => {
  it('合法缓存通过全部属主/权限/摘要校验', async () => {
    const cache = await createCache();
    await expect(expectComplete(cache)).resolves.toBe(true);
  });

  it('缓存目录 0777 被拒绝', async () => {
    const cache = await createCache();
    await chmod(cache.dir, 0o777);
    await expect(expectComplete(cache)).rejects.toBeInstanceOf(SeaAssetError);
  });

  it('缓存根 0755 被拒绝', async () => {
    const cache = await createCache();
    await chmod(cache.root, 0o755);
    await expect(expectComplete(cache)).rejects.toBeInstanceOf(SeaAssetError);
  });

  it('完成标记 0644 被拒绝', async () => {
    const cache = await createCache();
    await chmod(join(cache.dir, CACHE_MARKER), 0o644);
    await expect(expectComplete(cache)).rejects.toBeInstanceOf(SeaAssetError);
  });

  it('canvas 目录 0755 被拒绝', async () => {
    const cache = await createCache();
    await chmod(join(cache.dir, 'canvas'), 0o755);
    await expect(expectComplete(cache)).rejects.toBeInstanceOf(SeaAssetError);
  });

  it('native 文件 0644 被拒绝', async () => {
    const cache = await createCache();
    await chmod(join(cache.dir, 'native', 'x.node'), 0o644);
    await expect(expectComplete(cache)).rejects.toBeInstanceOf(SeaAssetError);
  });

  it('资产文件 0644 被拒绝', async () => {
    const cache = await createCache();
    await chmod(join(cache.dir, 'canvas', 'index.js'), 0o644);
    await expect(expectComplete(cache)).rejects.toBeInstanceOf(SeaAssetError);
  });

  it('资产文件为符号链接时被拒绝', async () => {
    const cache = await createCache();
    const target = join(cache.dir, 'canvas', 'index.js');
    await rename(target, join(cache.dir, 'canvas', 'real.js'));
    await symlink(join(cache.dir, 'canvas', 'real.js'), target);
    await expect(expectComplete(cache)).rejects.toBeInstanceOf(SeaAssetError);
  });

  it('缓存根为符号链接时被拒绝', async () => {
    const cache = await createCache();
    const linkRoot = join(await createTempDir(), 'root-link');
    await symlink(cache.root, linkRoot);
    await expect(
      isCacheComplete(linkRoot, cache.dir, cache.manifest, cache.assetKeys, {
        platform: 'linux',
        ...(UID === undefined ? {} : { uid: UID }),
      }),
    ).rejects.toBeInstanceOf(SeaAssetError);
  });

  it('属主 uid 不匹配时被拒绝', async () => {
    if (UID === undefined) return;
    const cache = await createCache();
    await expect(expectComplete(cache, { uid: UID + 1 })).rejects.toBeInstanceOf(
      SeaAssetError,
    );
  });

  it('预置同名空目录不视为完整缓存', async () => {
    const root = await createTempDir();
    const dir = join(root, 'u1000-0.1.0-linux-x64-0123456789abcdef');
    await mkdir(dir, { mode: 0o700 });
    await expect(
      isCacheComplete(root, dir, createManifest('0123456789abcdef'), [], {
        platform: 'linux',
        ...(UID === undefined ? {} : { uid: UID }),
      }),
    ).resolves.toBe(false);
  });

  it('缺少完成标记时返回 false（可安全重建）', async () => {
    const cache = await createCache();
    await rm(join(cache.dir, CACHE_MARKER));
    await expect(expectComplete(cache)).resolves.toBe(false);
  });

  it('完成标记内容不匹配时返回 false', async () => {
    const cache = await createCache();
    await writeFile(join(cache.dir, CACHE_MARKER), '0000000000000000', { mode: 0o600 });
    await expect(expectComplete(cache)).resolves.toBe(false);
  });

  it('预置同名缓存但资产内容被替换时摘要校验拒绝', async () => {
    const cache = await createCache();
    await writeFile(join(cache.dir, 'canvas', 'index.js'), 'malicious()', { mode: 0o600 });
    await expect(expectComplete(cache)).rejects.toBeInstanceOf(SeaAssetError);
  });

  it('资产键尝试越界时拒绝', async () => {
    const cache = await createCache();
    await expect(computeAssetDigest(cache.dir, ['../outside'])).rejects.toBeInstanceOf(
      SeaAssetError,
    );
  });

  it('Windows 下至少拒绝符号链接', async () => {
    if (!POSIX) return;
    const cache = await createCache();
    const linkPath = join(cache.dir, 'canvas', 'link.js');
    await symlink(join(cache.dir, 'canvas', 'index.js'), linkPath);
    await expect(
      assertSecureCacheEntry(linkPath, 'file', { platform: 'win32' }),
    ).rejects.toBeInstanceOf(SeaAssetError);
  });
});

describe('SEA 缓存路径命名', () => {
  it('POSIX 根按 uid 隔离，子目录包含 uid/版本/平台/架构/摘要', () => {
    const manifest = createManifest('0123456789abcdef');
    const paths = buildCachePaths(manifest, {
      tmpDir: '/tmp/test',
      platform: 'linux',
      uid: 1234,
    });
    expect(paths.root).toBe(join('/tmp/test', 'ofdrw-viewer-cli-u1234'));
    expect(paths.root).not.toBe(join('/tmp/test', 'ofdrw-viewer-cli'));
    expect(paths.dir).toBe(
      join(paths.root, 'u1234-0.1.0-linux-x64-0123456789abcdef'),
    );
  });

  it('不同 uid 得到不同的根与缓存目录', () => {
    const manifest = createManifest('0123456789abcdef');
    const first = buildCachePaths(manifest, {
      tmpDir: '/tmp/test',
      platform: 'linux',
      uid: 1000,
    });
    const second = buildCachePaths(manifest, {
      tmpDir: '/tmp/test',
      platform: 'linux',
      uid: 1001,
    });
    expect(first.root).not.toBe(second.root);
    expect(first.dir).not.toBe(second.dir);
  });

  it('拒绝含 .. 或路径分隔符的清单字段', () => {
    expect(() =>
      buildCachePaths({ ...createManifest('0123456789abcdef'), cliVersion: '../evil' }),
    ).toThrow(SeaAssetError);
    expect(() =>
      buildCachePaths({ ...createManifest('0123456789abcdef'), platform: 'linux/x' }),
    ).toThrow(SeaAssetError);
  });

  it('Windows 无 uid 时保留固定根名并使用 win 命名空间', () => {
    const paths = buildCachePaths(createManifest('0123456789abcdef'), {
      tmpDir: '/tmp/test',
      platform: 'win32',
    });
    expect(paths.root).toBe(join('/tmp/test', 'ofdrw-viewer-cli'));
    expect(paths.dir).toBe(
      join(paths.root, 'win-0.1.0-linux-x64-0123456789abcdef'),
    );
  });
});
