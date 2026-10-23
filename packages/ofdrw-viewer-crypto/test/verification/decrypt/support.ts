/**
 * V-DEC 独立验证共享工具。
 *
 * 只读取仓库内已提交的受保护样例与 Java 基准；不引用 crypto 包的内部模块。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';
import type { VirtualContainer } from '@ofdrw/ofdrw-viewer-engine';
import {
  CryptoError,
  openDecryptingContainer,
  type CryptoCredential,
  type DecryptingContainerResult,
} from '@ofdrw/ofdrw-viewer-crypto';

/** 当前验证目录。 */
const SUPPORT_DIR = dirname(fileURLToPath(import.meta.url));

/** fixture 根目录绝对路径。 */
export const FIXTURE_DIR = resolve(SUPPORT_DIR, '../../fixtures/crypto');

/** Java 解密基准 JSON 路径。 */
export const JAVA_EXPECTED_PATH = join(SUPPORT_DIR, 'java-expected.json');

/**
 * 读取 fixture 字节。
 *
 * @param segments 相对 fixture 根目录的路径片段。
 * @returns 文件字节。
 */
export function fixtureBytes(...segments: string[]): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE_DIR, ...segments)));
}

/**
 * 读取 fixture 文本。
 *
 * @param segments 相对 fixture 根目录的路径片段。
 * @returns UTF-8 文本。
 */
export function fixtureText(...segments: string[]): string {
  return readFileSync(join(FIXTURE_DIR, ...segments), 'utf8');
}

/**
 * 以内存字节构造 CryptoSource。
 *
 * @param name fixture 文件名。
 * @returns arraybuffer 来源。
 */
export function source(name: string): { kind: 'arraybuffer'; data: Uint8Array } {
  return { kind: 'arraybuffer', data: fixtureBytes(name) };
}

/** 口令凭据。 */
export const PASSWORD_CREDENTIAL: CryptoCredential = {
  kind: 'password',
  userName: 'fixture-password-user',
  password: 'FixturePass123',
};

/**
 * 证书用户私钥凭据。
 *
 * @param keyName 私钥 fixture 前缀，默认 encrypt。
 * @param userName decryptseed 用户名。
 * @returns 私钥凭据。
 */
export function certCredential(
  keyName = 'encrypt',
  userName = 'fixture-cert-user',
): CryptoCredential {
  return {
    kind: 'private-key',
    userName,
    privateKey: { pem: fixtureText('certs', `${keyName}.key.pem`) },
  };
}

/**
 * 计算字节 SHA-256。
 *
 * @param bytes 字节。
 * @returns 小写 hex。
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 读取容器全部条目。
 *
 * @param container 容器。
 * @returns path → 字节。
 */
export async function readEntries(container: VirtualContainer): Promise<Map<string, Uint8Array>> {
  const result = new Map<string, Uint8Array>();
  for (const meta of container.list()) {
    result.set(meta.path, await container.read(meta.path));
  }
  return result;
}

/**
 * 计算容器逐条目摘要。
 *
 * @param container 容器。
 * @returns path → {size, sha256}。
 */
export async function digestEntries(
  container: VirtualContainer,
): Promise<Map<string, { readonly size: number; readonly sha256: string }>> {
  const result = new Map<string, { readonly size: number; readonly sha256: string }>();
  for (const meta of container.list()) {
    const bytes = await container.read(meta.path);
    result.set(meta.path, { size: bytes.length, sha256: sha256Hex(bytes) });
  }
  return result;
}

/**
 * 捕获 CryptoError 错误码。
 *
 * @param promise 待执行 promise。
 * @returns 错误码。
 */
export async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CryptoError) return error.code;
    if (error instanceof Error && 'code' in error) return String((error as { code: unknown }).code);
    throw error;
  }
  throw new Error('promise 未按预期拒绝');
}

/**
 * 捕获错误对象。
 *
 * @param promise 待执行 promise。
 * @returns CryptoError。
 */
export async function errorOf(promise: Promise<unknown>): Promise<CryptoError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CryptoError) return error;
    throw error;
  }
  throw new Error('promise 未按预期拒绝');
}

/**
 * 解密并返回结果；调用方负责关闭容器。
 *
 * @param name fixture 名。
 * @param credentials 凭据。
 * @returns 解密结果。
 */
export function decryptFixture(
  name: string,
  credentials?: CryptoCredential | readonly CryptoCredential[],
): Promise<DecryptingContainerResult> {
  return openDecryptingContainer({
    source: source(name),
    ...(credentials === undefined ? {} : { credentials }),
  });
}

/**
 * 比较两个条目摘要表。
 *
 * @param actual 实际。
 * @param expected 期望。
 * @returns 差异描述；完全一致时为空数组。
 */
export function diffDigests(
  actual: ReadonlyMap<string, { readonly size: number; readonly sha256: string }>,
  expected: Readonly<Record<string, { readonly size: number; readonly sha256: string }>>,
): string[] {
  const differences: string[] = [];
  const actualPaths = [...actual.keys()].sort();
  const expectedPaths = Object.keys(expected).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    differences.push(`路径集合不同：actual=${actualPaths.join(',')} expected=${expectedPaths.join(',')}`);
  }
  for (const path of expectedPaths) {
    const left = actual.get(path);
    const right = expected[path];
    if (!left) {
      differences.push(`缺少条目 ${path}`);
      continue;
    }
    if (left.size !== right.size) differences.push(`${path} 长度 ${left.size} != ${right.size}`);
    if (left.sha256 !== right.sha256) differences.push(`${path} SHA-256 不一致`);
  }
  return differences;
}

/**
 * 重写 ZIP 包内容。
 *
 * @param bytes 原包字节。
 * @param mutate 对条目表的原地修改函数。
 * @returns 新包字节。
 */
export function rewriteZip(
  bytes: Uint8Array,
  mutate: (entries: Record<string, Uint8Array>) => void,
): Uint8Array {
  const entries = unzipSync(bytes);
  mutate(entries);
  return zipSync(entries, { level: 0 });
}

/**
 * 以内存字节 + 凭据解密。
 *
 * @param data 包字节。
 * @param credentials 凭据。
 * @returns 解密结果。
 */
export function decryptBytes(
  data: Uint8Array,
  credentials?: CryptoCredential | readonly CryptoCredential[],
): Promise<DecryptingContainerResult> {
  return openDecryptingContainer({
    source: { kind: 'arraybuffer', data },
    ...(credentials === undefined ? {} : { credentials }),
  });
}
