/**
 * 签章集成测试夹具。
 *
 * 真实 `SignedValue.dat` 取自版本库内已提交的加密夹具（`signed-sesv4.ofd` /
 * `signed-sesv5.ofd`），与单元测试共用同一来源，不依赖不纳入版本管理的
 * 仓库根 `references/` 目录。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SignatureEntryInfo } from '@ofdrw/ofdrw-viewer-engine';
import { unzipSync } from 'fflate';

/** 夹具目录：`packages/ofdrw-viewer-ui/test/helpers/signature.ts` → crypto 夹具。 */
const FIXTURE_DIR = resolve(
  import.meta.dirname,
  '../../../ofdrw-viewer-crypto/test/fixtures/crypto',
);

/** 签章样本文件名 → 所属 OFD 包。 */
const PACKAGE_BY_NAME = {
  'SignedValueV4.dat': 'signed-sesv4.ofd',
  'SignedValueV5.dat': 'signed-sesv5.ofd',
} as const;

/** 已解压的 OFD 包缓存；键为包文件名。 */
const packageCache = new Map<string, Record<string, Uint8Array>>();

/**
 * 解压签章样本所属的 OFD 包。
 *
 * @param packageName 包文件名。
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
 * 读取真实 `SignedValue.dat`。
 *
 * @param name 文件名，例如 `SignedValueV4.dat`。
 * @returns 原始字节。
 * @throws {Error} 夹具缺失或包内没有签章值文件时抛出。
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
  return new Uint8Array(entries[path]!);
}

/** 构造签章摘要；戳记默认位于第 2 页。 */
export function createSignatureEntry(
  overrides: Partial<SignatureEntryInfo> = {},
): SignatureEntryInfo {
  return {
    id: 'sig-1',
    type: 'Seal',
    baseLoc: 'Signs/Signature.xml',
    provider: { name: 'OFD R&W', company: 'ofdrw', version: '1.0' },
    signatureDateTime: '2020-10-12T11:14:03Z',
    references: [{ fileRef: '/Doc_0/Document.xml' }],
    stamps: [
      {
        id: 'stamp-1',
        pageId: 'page-2',
        pageIndex: 1,
        boundary: { x: 10, y: 12, w: 40, h: 30 },
        clip: { x: 2, y: 2, w: 36, h: 26 },
      },
    ],
    signedValuePath: 'Signs/SignedValue_sig-1.dat',
    hasSignedValue: true,
    ...overrides,
  };
}
