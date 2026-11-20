/**
 * 字体 fixture 定位（测试 fixture 专用）。
 *
 * 合成测试使用随仓库提交的思源宋体与思源黑体，结果不随机器环境变化；
 * 仓库字体缺失时返回 null，由调用方 skip。
 * 也可以从本地 OFD 样本（不提交仓库）中提取内嵌字体，用于 T4 的字体解析测试。
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readZipEntries } from './zip-inspector';

/** 字体 fixture。 */
export interface FontFixture {
  /** 字体来源路径。 */
  path: string;
  /** 字体二进制。 */
  data: Uint8Array;
  /** 字体族名（尽可能从文件名推断）。 */
  family: string;
}

/** 随仓库提交的 CJK 字体：思源宋体简体中文（SIL OFL 1.1），覆盖中文与拉丁字形。 */
export const BUNDLED_CJK_FONT_PATH = fileURLToPath(
  new URL('./fonts/SourceHanSerifSC-Regular.otf', import.meta.url),
);

/** 随仓库提交的无衬线 CJK 字体：思源黑体简体中文（SIL OFL 1.1）。 */
export const BUNDLED_SANS_FONT_PATH = fileURLToPath(
  new URL('./fonts/SourceHanSansCN-Regular.otf', import.meta.url),
);

/** CJK 字体候选路径，按优先级排列：只用随仓库提交的字体。 */
const CJK_FONT_CANDIDATES: readonly string[] = Object.freeze([
  BUNDLED_CJK_FONT_PATH,
  BUNDLED_SANS_FONT_PATH,
]);

/**
 * 查找可用的 CJK 字体。
 *
 * @param candidates 自定义候选路径；默认使用内置列表。
 * @returns 字体 fixture；均不存在时返回 null（调用方应 skip）。
 */
export function findSystemCjkFont(candidates: readonly string[] = CJK_FONT_CANDIDATES): FontFixture | null {
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    return { path, data: new Uint8Array(readFileSync(path)), family: familyFromPath(path) };
  }
  return null;
}

/**
 * 从 OFD 包中提取第一个内嵌字体（ttf/otf/ttc）。
 *
 * 业务样本只读；提取结果只用于本地测试，不应提交仓库。
 *
 * @param ofdPath OFD 文件路径。
 * @returns 字体名与二进制；未找到时返回 null。
 */
export function loadEmbeddedFontFromOfd(ofdPath: string): { name: string; data: Uint8Array } | null {
  if (!existsSync(ofdPath)) return null;
  const entries = readZipEntries(new Uint8Array(readFileSync(ofdPath)), { verifyCrc: false });
  for (const entry of entries) {
    if (/\.(ttf|otf|ttc|cff)$/i.test(entry.name)) {
      return { name: entry.name, data: entry.data };
    }
  }
  return null;
}

/** 从路径推断字体族名。 */
function familyFromPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.(ttf|otf|ttc|cff)$/i, '');
}