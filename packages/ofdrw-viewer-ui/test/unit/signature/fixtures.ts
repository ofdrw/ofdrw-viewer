/**
 * 签章测试夹具。
 *
 * 直接读取版本库内已提交的加密夹具 `signed-sesv4.ofd` / `signed-sesv5.ofd`，
 * 从 OFD 包内取出真实 `SignedValue.dat`；损坏样本使用非 DER 字节。
 * 测试不再构造 ASN.1，解析统一走 crypto 包。
 *
 * 不使用仓库根 `references/` 下的 ofdrw 源码资源：该目录不纳入版本管理，
 * 在 CI 干净检出时必然缺失。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';

/** 夹具目录：`packages/ofdrw-viewer-ui/test/unit/signature/fixtures.ts` → crypto 测试夹具。 */
const FIXTURE_DIR = resolve(
  import.meta.dirname,
  '../../../../ofdrw-viewer-crypto/test/fixtures/crypto',
);

/** 签章样本文件名 → 所属 OFD 包。 */
const PACKAGE_BY_NAME = {
  'SignedValueV4.dat': 'signed-sesv4.ofd',
  'SignedValueV5.dat': 'signed-sesv5.ofd',
} as const;

/** 解压缓存：键为 OFD 文件名，值为包内路径 → 文件字节。 */
const packageCache = new Map<string, Record<string, Uint8Array>>();

/**
 * 解压签章样本所属的 OFD 包。
 *
 * @param packageName 包文件名，单位不限（字符串）。
 * @returns 包内路径 → 文件字节。
 */
function readPackage(packageName: string): Record<string, Uint8Array> {
  const cached = packageCache.get(packageName);
  if (cached) return cached;
  const entries = unzipSync(
    new Uint8Array(readFileSync(resolve(FIXTURE_DIR, packageName))),
  );
  packageCache.set(packageName, entries);
  return entries;
}

/**
 * 读取真实 SignedValue 夹具。
 *
 * @param name 夹具文件名，`SignedValueV4.dat` 或 `SignedValueV5.dat`。
 * @returns 文件字节。
 * @throws {Error} OFD 包内不存在对应签名的 `SignedValue.dat` 时抛出。
 */
export function readSignedValueFixture(
  name: keyof typeof PACKAGE_BY_NAME,
): Uint8Array {
  const entries = readPackage(PACKAGE_BY_NAME[name]);
  const path = Object.keys(entries).find((entry) =>
    /(^|\/)Signs\/[^/]+\/SignedValue\.dat$/.test(entry),
  );
  if (!path) {
    throw new Error(`${PACKAGE_BY_NAME[name]} 包内缺少 SignedValue.dat`);
  }
  const data = entries[path]!;
  return new Uint8Array(data);
}

/**
 * 损坏的签名值：非 DER 字节。
 *
 * @returns 无法解析的字节。
 */
export function corruptSignedValue(): Uint8Array {
  return new Uint8Array([0x30, 0x82, 0x01, 0x00, 0x00]);
}

