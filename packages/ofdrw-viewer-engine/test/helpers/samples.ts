/**
 * 真实样本目录（`ofd_pdf_match/`）的枚举与有效性识别。
 *
 * 样本目录会随仓库演进而变化（新增/删除样本、个别文件损坏或不是 ZIP），因此用例不能
 * 硬编码样本数量。本模块统一负责：
 * - 按扩展名枚举样本；
 * - 用 ZIP 魔数快速识别无法打开的文件并单独计数（不进入解析流程）；
 * - 提供「跳过比例上限」断言，既容许个别坏样本，又能在样本大面积损坏时让用例失败。
 *
 * 不读写产品代码，不修改样本文件。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根样本目录（测试文件位于 packages/ofdrw-viewer-engine/test/<子目录>）。 */
export const SAMPLE_DIR = fileURLToPath(new URL('../../../../ofd_pdf_match/', import.meta.url));

/** 无法识别的样本占全部样本的比例上限；超过视为样本库异常并让用例失败。 */
export const MAX_UNREADABLE_RATIO = 0.05;

/** 样本清单。 */
export interface SampleManifest {
  /** 全部 `.ofd` 样本文件名（按文件名升序）。 */
  readonly all: readonly string[];
  /** 可识别的样本文件名；无法识别的不包含在内。 */
  readonly readable: readonly string[];
  /** 无法识别的样本文件名（非 ZIP / 读取失败）。 */
  readonly unreadable: readonly string[];
}

/**
 * 判断文件开头是否为 ZIP 本地文件头或空归档标记。
 *
 * OFD 是 ZIP 容器；损坏文件、HTTP multipart 抓取残留等都不以此开头。
 *
 * @param bytes 文件内容的前若干字节。
 * @returns 是 ZIP 容器时返回 true。
 */
export function isZipContainer(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const [b0, b1, b2, b3] = [bytes[0], bytes[1], bytes[2], bytes[3]];
  if (b0 !== 0x50 || b1 !== 0x4b) return false;
  // PK\x03\x04（本地文件头）或 PK\x05\x06（空归档 EOCD）。
  return (b2 === 0x03 && b3 === 0x04) || (b2 === 0x05 && b3 === 0x06);
}

/**
 * 枚举样本目录并识别可用样本。
 *
 * 无法识别的文件不会让本函数抛错，而是归入 `unreadable` 并打印一次 warning，便于定位
 * 是哪些文件失效；判定口径见 `assertSampleManifest()`。
 *
 * @returns 样本清单。
 */
export function loadSampleManifest(): SampleManifest {
  const all = readdirSync(SAMPLE_DIR)
    .filter((name) => name.toLowerCase().endsWith('.ofd'))
    .sort();
  const readable: string[] = [];
  const unreadable: string[] = [];
  for (const name of all) {
    let head: Uint8Array;
    try {
      head = new Uint8Array(readFileSync(join(SAMPLE_DIR, name)).subarray(0, 4));
    } catch {
      unreadable.push(name);
      continue;
    }
    if (isZipContainer(head)) readable.push(name);
    else unreadable.push(name);
  }
  if (unreadable.length > 0) {
    // 只提示文件名，不打印内容；样本库问题不应淹没真正的回归信息。
    console.warn(`[real-samples] 跳过无法识别的样本 ${unreadable.length} 个：${unreadable.join(', ')}`);
  }
  return { all, readable, unreadable };
}

/**
 * 校验样本清单的可用性。
 *
 * 两层保护：样本数和可识别样本数都必须达到下限（防止目录为空或几乎全坏时静默通过），
 * 且无法识别的比例不得超过 `MAX_UNREADABLE_RATIO`（防止样本库大面积损坏被忽略）。
 *
 * @param manifest 样本清单。
 * @param options.minimumSamples 全部样本数下限，默认 40。
 * @param options.minimumReadable 可识别样本数下限，默认 40。
 * @returns 可识别样本文件名列表，便于调用方直接遍历。
 */
export function assertSampleManifest(
  manifest: SampleManifest,
  options: { readonly minimumSamples?: number; readonly minimumReadable?: number } = {},
): readonly string[] {
  const minimumSamples = options.minimumSamples ?? 40;
  const minimumReadable = options.minimumReadable ?? 40;
  if (manifest.all.length < minimumSamples) {
    throw new Error(
      `样本目录可用样本过少：${manifest.all.length} < ${minimumSamples}（检查 ${SAMPLE_DIR}）`,
    );
  }
  if (manifest.readable.length < minimumReadable) {
    throw new Error(
      `可识别样本过少：${manifest.readable.length} < ${minimumReadable}（共 ${manifest.all.length} 个，疑似样本库损坏）`,
    );
  }
  const ratio = manifest.unreadable.length / manifest.all.length;
  if (ratio > MAX_UNREADABLE_RATIO) {
    throw new Error(
      `无法识别的样本占比过高：${manifest.unreadable.length}/${manifest.all.length}（>${MAX_UNREADABLE_RATIO * 100}%）：${manifest.unreadable.join(', ')}`,
    );
  }
  return manifest.readable;
}
