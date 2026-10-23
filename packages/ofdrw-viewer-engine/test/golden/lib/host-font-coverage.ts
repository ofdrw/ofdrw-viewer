/**
 * 宿主字体覆盖诊断（测试侧）。
 *
 * 引擎对“请求 family 未注入”会静默回退默认字体，只靠 `W_FONT_MISSING` 无法区分
 * “字体缺失”和“族不匹配”。本模块扫描 OFD 包内非内嵌字体声明，并与 harness
 * 注入的 `supplementaryFonts` family 对比，供报告把族不匹配计入 `fontMissingCount`。
 *
 * 只读诊断：解析失败时返回空覆盖，不阻断渲染。
 */

import { readFileSync } from 'node:fs';
import { readZipEntries } from '../../fixtures/zip-inspector';
import { systemSupplementaryFontFamilies } from './system-fonts';

/** 宿主字体覆盖诊断结果。 */
export interface HostFontCoverage {
  /** OFD 请求的非内嵌字体族名（已去重，保留原写法）。 */
  requested: string[];
  /** 当前注入的字体族名。 */
  available: string[];
  /** 请求但宿主未注入的字体族名。 */
  missing: string[];
}

/** 字体族别名归并组；用于把中英文名映射到同一 canonical key。 */
const FAMILY_ALIAS_GROUPS: ReadonlyArray<readonly string[]> = [
  ['kaiti', 'kaitisc', 'kaitigb2312', 'stkaiti', '楷体', '楷体gb2312', '华文楷体'],
  ['simsun', 'songti', '宋体', '新宋体', 'nsimsun'],
  ['fangsong', '仿宋'],
  ['simhei', '黑体'],
  ['microsoftyahei', '微软雅黑'],
  ['hgxbscnki', '小标宋体'],
  ['tahoma'],
  ['couriernew', 'courier', 'courier新'],
  ['timesnewroman', 'times'],
  ['arial'],
  ['minionpro', 'minionproregular'],
];

/** 归一化字体名：去空白/连字符/下划线并转小写。 */
function normalizeFamily(name: string): string {
  return name.replace(/[\s_-]+/g, '').toLowerCase();
}

/** 字体族 canonical key；未命中别名组时返回归一化名。 */
function canonicalFamily(name: string): string {
  const normalized = normalizeFamily(name);
  for (const group of FAMILY_ALIAS_GROUPS) {
    if (group.some((alias) => normalizeFamily(alias) === normalized)) return group[0]!;
  }
  return normalized;
}

/**
 * 扫描 OFD 包内非内嵌字体声明。
 *
 * @param ofdPath OFD 文件路径。
 * @returns 请求的字体族名；解析失败返回空数组。
 */
export function requestedOfdFontFamilies(ofdPath: string): string[] {
  let entries;
  try {
    entries = readZipEntries(new Uint8Array(readFileSync(ofdPath)), { verifyCrc: false });
  } catch {
    return [];
  }
  // OFD 字体声明在 PublicRes/DocumentRes；只扫 XML，避免解压大资源。
  const xmlEntries = entries.filter((entry) => /\.xml$/i.test(entry.name));
  const decoder = new TextDecoder('utf-8');
  const families = new Set<string>();
  for (const entry of xmlEntries) {
    const text = decoder.decode(entry.data);
    const pattern = /<([A-Za-z_][\w.-]*:)?Font\b([^>]*?)(\/?)>/g;
    for (const match of text.matchAll(pattern)) {
      const attrs = match[2] ?? '';
      const selfClosing = match[3] === '/';
      let elementBody = attrs;
      if (!selfClosing) {
        const openEnd = text.indexOf('>', match.index ?? 0);
        const closeStart = text.indexOf('</', openEnd + 1);
        elementBody = text.slice(openEnd + 1, closeStart < 0 ? text.length : closeStart);
      }
      // 内嵌字体自带 FontFile，不依赖宿主；跳过以免误报族缺失。
      if (/FontFile/i.test(attrs) || /FontFile/i.test(elementBody)) continue;
      for (const attr of attrs.matchAll(/(?:FontName|FamilyName)\s*=\s*"([^"]*)"/g)) {
        const family = attr[1]?.trim();
        if (family) families.add(family);
      }
    }
  }
  return [...families];
}

/**
 * 对比 OFD 请求字体族与 harness 注入字体族。
 *
 * @param ofdPath OFD 文件路径。
 * @param availableFamilies 已注入字体族；默认取 system-fonts 的发现结果。
 * @returns 覆盖诊断；OFD 解析失败或文件不存在时 missing 为空。
 */
export function inspectHostFontCoverage(
  ofdPath: string,
  availableFamilies: readonly string[] = systemSupplementaryFontFamilies(),
): HostFontCoverage {
  const requested = requestedOfdFontFamilies(ofdPath);
  const available = [...availableFamilies];
  const availableKeys = new Set(available.map((family) => canonicalFamily(family)));
  const missing: string[] = [];
  const missingKeys = new Set<string>();
  for (const family of requested) {
    const key = canonicalFamily(family);
    if (availableKeys.has(key) || missingKeys.has(key)) continue;
    missingKeys.add(key);
    missing.push(family);
  }
  return { requested, available, missing };
}

/**
 * 生成宿主族不匹配的 warning（测试侧诊断码，不属于引擎 warning 码表）。
 *
 * @param coverage 覆盖诊断。
 * @returns 可并入样本 warnings 的便携 warning。
 */
export function hostFontMismatchWarnings(coverage: HostFontCoverage): Array<{
  code: string;
  message: string;
}> {
  return coverage.missing.map((family) => ({
    code: 'W_HOST_FONT_MISMATCH',
    message: `宿主未注入字体族 ${family}，引擎会回退默认字体；参考图使用宿主真实字体时会产生族不匹配差异`,
  }));
}