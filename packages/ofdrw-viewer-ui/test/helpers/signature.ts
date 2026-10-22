/**
 * 签章集成测试夹具。
 *
 * 真实 `SignedValue.dat` 来自仓库内的 ofdrw 测试资源；资源缺失时用例应显式
 * 跳过，而不是用空数据伪装通过。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SignatureEntryInfo } from '@ofdrw/ofdrw-viewer-engine';

/** 候选仓库根目录：包目录或仓库根。 */
const CANDIDATE_ROOTS = [
  process.cwd(),
  resolve(process.cwd(), '../..'),
  resolve(process.cwd(), '../../..'),
];

/** 资源相对路径。 */
const RESOURCE_RELATIVE = 'references/ofdrw/ofdrw-gm/src/test/resources';

/** 定位资源目录；不存在时返回 null。 */
function resolveResourceDir(): string | null {
  for (const root of CANDIDATE_ROOTS) {
    const candidate = resolve(root, RESOURCE_RELATIVE);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 资源目录；缺失时为 null。 */
export const SIGNATURE_RESOURCE_DIR = resolveResourceDir();

/** 是否存在真实签章样本。 */
export const HAS_SIGNATURE_FIXTURES = SIGNATURE_RESOURCE_DIR !== null;

/**
 * 读取真实 `SignedValue.dat`。
 *
 * @param name 文件名，例如 `SignedValueV4.dat`。
 * @returns 原始字节。
 * @throws {Error} 资源不存在时抛出，便于用例显式跳过。
 */
export function readSignedValueFixture(name: 'SignedValueV4.dat' | 'SignedValueV5.dat'): Uint8Array {
  if (!SIGNATURE_RESOURCE_DIR) {
    throw new Error(`未找到签章样本目录：${RESOURCE_RELATIVE}`);
  }
  return new Uint8Array(readFileSync(resolve(SIGNATURE_RESOURCE_DIR, name)));
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