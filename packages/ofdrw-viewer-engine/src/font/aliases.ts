/**
 * 字体名归一化与别名表（对应设计方案 12.2）。
 *
 * OFD 的 FontName/FamilyName 可能是中文名、英文名或 PostScript 名，
 * 且大小写/空格不稳定；此处统一归一化，并允许宿主扩展别名表。
 */

/** 字体别名表：键与值都会被归一化，同一组内的名称互为别名。 */
export type FontAliasTable = ReadonlyArray<readonly string[]>;

/**
 * 内置别名组。
 *
 * 只收录常见中文字体与它们的英文/PostScript 名；不指向具体字体文件，
 * 也不表示引擎内置这些字体。
 */
export const DEFAULT_FONT_ALIASES: FontAliasTable = Object.freeze([
  ['宋体', 'simsun', 'songti', 'stsong', 'nsimsun', '新宋体', 'notoserifcjksc', 'sourcehanserifsc'],
  ['黑体', 'simhei', 'heiti', 'stheiti', 'notosanscjksc', 'sourcehansanssc'],
  ['楷体', 'kaiti', 'stkaiti', '楷体_gb2312', 'kaiti_gb2312'],
  ['仿宋', 'fangsong', 'stfangsong', '仿宋_gb2312', 'fangsong_gb2312'],
  ['微软雅黑', 'microsoftyahei', 'msyahei', 'msyh'],
  ['等线', 'dengxian'],
  ['华文中宋', 'stzhongsong', 'zhongsong'],
  ['小标宋体', '小标宋', '华光小标宋_cnki', 'hgxbs_cnki', 'fzxbs'],
  ['方正书宋', 'fzshusong'],
  ['arial', 'helvetica', 'liberationsans'],
  ['times new roman', 'timesnewroman', 'times', 'liberationserif', 'nimbusroman', 'nimbusromanregular'],
  ['courier new', 'couriernew', 'courier', 'liberationmono'],
]);

/**
 * 归一化字体名：转小写并移除空白、连字符、下划线、逗号与点。
 *
 * @param name 原始字体名。
 * @returns 归一化名称；输入为空时返回空串。
 */
export function normalizeFontName(name: string | undefined | null): string {
  if (!name) return '';
  return name.toLowerCase().replace(/[\s\-_,.]+/g, '');
}

/**
 * 建立“归一化名称 → 别名组”的索引。
 *
 * @param aliases 别名组；缺省使用 `DEFAULT_FONT_ALIASES`。
 * @returns 索引表。
 */
function buildAliasIndex(
  aliases: FontAliasTable = DEFAULT_FONT_ALIASES,
): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, readonly string[]>();
  for (const group of aliases) {
    const normalized = group.map((name) => normalizeFontName(name)).filter(Boolean);
    if (normalized.length === 0) continue;
    const unique = Array.from(new Set(normalized));
    for (const name of unique) {
      const existing = index.get(name);
      index.set(name, existing ? Array.from(new Set([...existing, ...unique])) : unique);
    }
  }
  return index;
}

/** 默认别名索引（模块加载时建立一次）。 */
const DEFAULT_ALIAS_INDEX = buildAliasIndex();

/**
 * 展开一个字体名可能命中的全部归一化名称。
 *
 * @param name 原始字体名。
 * @param aliases 自定义别名组；缺省使用内置表。
 * @returns 归一化候选名（含自身，去重，顺序稳定）。
 */
export function expandFontName(name: string | undefined | null, aliases?: FontAliasTable): string[] {
  const normalized = normalizeFontName(name);
  if (!normalized) return [];
  const index = aliases ? buildAliasIndex(aliases) : DEFAULT_ALIAS_INDEX;
  const candidates = index.get(normalized);
  return candidates ? [...candidates] : [normalized];
}

/**
 * 展开多个字体名（例如 FontName + FamilyName + PostScript 名）。
 *
 * @param names 原始字体名列表。
 * @param aliases 自定义别名组。
 * @returns 归一化候选名，去重且保持首次出现顺序。
 */
export function expandFontNames(
  names: readonly (string | undefined | null)[],
  aliases?: FontAliasTable,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    for (const candidate of expandFontName(name, aliases)) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      result.push(candidate);
    }
  }
  return result;
}

/**
 * 判断两个字体名是否通过别名表视为同一字体。
 *
 * @param a 字体名 A。
 * @param b 字体名 B。
 * @param aliases 自定义别名组。
 * @returns 命中任一共同归一化名称时返回 true。
 */
export function fontNamesMatch(
  a: string | undefined | null,
  b: string | undefined | null,
  aliases?: FontAliasTable,
): boolean {
  const left = new Set(expandFontNames([a], aliases));
  if (left.size === 0) return false;
  return expandFontNames([b], aliases).some((name) => left.has(name));
}