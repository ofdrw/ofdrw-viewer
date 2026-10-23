/**
 * 签章测试夹具。
 *
 * 直接读取仓库内真实 `SignedValue.dat` 样本；损坏样本使用非 DER 字节。
 * 测试不再构造 ASN.1，解析统一走 crypto 包。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 仓库根：vitest 可能从仓库根或包目录启动。 */
const REPO_ROOT = existsSync(resolve(process.cwd(), 'references'))
  ? process.cwd()
  : resolve(process.cwd(), '../..');
const RESOURCE_DIR = resolve(
  REPO_ROOT,
  'references/ofdrw/ofdrw-gm/src/test/resources',
);

/**
 * 读取真实 SignedValue 夹具。
 *
 * @param name 夹具文件名。
 * @returns 文件字节。
 */
export function readSignedValueFixture(
  name: 'SignedValueV4.dat' | 'SignedValueV5.dat',
): Uint8Array {
  return new Uint8Array(readFileSync(resolve(RESOURCE_DIR, name)));
}

/**
 * 损坏的签名值：非 DER 字节。
 *
 * @returns 无法解析的字节。
 */
export function corruptSignedValue(): Uint8Array {
  return new Uint8Array([0x30, 0x82, 0x01, 0x00, 0x00]);
}