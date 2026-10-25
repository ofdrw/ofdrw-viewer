/**
 * 本地字体名归一化与变体展开（本地字体加载方案设计 §3.3、§3.4）。
 *
 * OFD 文档声明的 FontName 是「中文名 + 可能带变体后缀」（如 `宋体`、`宋体 Bold`、
 * `黑体_GB2312`），而浏览器 `queryLocalFonts({ postscriptNames })` 只接受**区分大小写的
 * PostScript 名**。实测（设计 §1.3）：`SimSun` 命中，而 `simsun`、`宋体`、
 * `Microsoft YaHei` 均不命中，且 `SimHei-Bold` 这类不存在的变体会返回空数组。
 *
 * 本模块把文档声明转换成一条按优先级排列的候选名列表，由本地字体读取方依次尝试：
 *
 * 1. 别名表（内置别名组 + `fonts.aliases`）：命中后取同组内可用的 PostScript 写法；
 * 2. 内置常见字体表：给出真实 PostScript 名与变体后缀（`SimSun-Bold` 等）；
 * 3. 文档原始名：部分文档直接写 PostScript 名（`SimSun`），原样保留在最后。
 *
 * 大小写原则：**不推断大小写**。PostScript 名的大小写无法由名称内容推导
 * （`simsun` → `SimSun` 而非 `Simsun`），因此只采用内置表给出的真实写法，或本身
 * 已是合法 PostScript 形态（含大写字母）的名称；其余一律丢弃。
 *
 * 本模块只处理字符串，不访问 DOM、不读取字体文件、不产生 I/O。
 */

import type { FontAliasTable } from '@ofdrw/ofdrw-viewer-engine';

/** 单个字体声明展开后的候选名。 */
export interface LocalFontCandidates {
  /** 原始声明（FontName），用于诊断与日志。 */
  readonly source: string;
  /** 按尝试顺序排列的候选 PostScript 名；已去重、已剔除中文名。 */
  readonly names: readonly string[];
  /** 命中内置字体表时的基础名；未能识别时为 undefined。 */
  readonly base?: string;
}

/** 内置常见字体条目：`keys` 参与匹配（归一化后比较），`postscript` 为真实字体面名。 */
interface CommonFontEntry {
  /** 匹配用的名称集合（中文名、英文名、PostScript 名），比较前统一归一化。 */
  readonly keys: readonly string[];
  /** 基础 PostScript 名（不带变体后缀）。 */
  readonly postscript: string;
}

/**
 * 内置常见字体表（设计 §3.4）。
 *
 * 只收录中文环境与常见西文环境的高频字体；`postscript` 取自真实字体面的名称，仅用于
 * **生成候选名**，不承诺该字体一定已安装——未命中时读取方会继续尝试后续候选。
 */
const COMMON_FONTS: readonly CommonFontEntry[] = [
  { keys: ['宋体', 'simsun', 'songti'], postscript: 'SimSun' },
  { keys: ['新宋体', 'nsimsun'], postscript: 'NSimSun' },
  { keys: ['simsunextb'], postscript: 'SimSun-ExtB' },
  { keys: ['黑体', 'simhei', 'heiti'], postscript: 'SimHei' },
  { keys: ['楷体', 'kaiti'], postscript: 'KaiTi' },
  { keys: ['仿宋', 'fangsong'], postscript: 'FangSong' },
  { keys: ['微软雅黑', 'microsoftyahei', 'msyahei', 'msyh'], postscript: 'MicrosoftYaHei' },
  { keys: ['微软雅黑ui', 'microsoftyaheiui'], postscript: 'MicrosoftYaHeiUI' },
  { keys: ['等线', 'dengxian'], postscript: 'DengXian' },
  { keys: ['华文宋体', 'stsong'], postscript: 'STSong' },
  { keys: ['华文中宋', '中宋', 'stzhongsong', 'zhongsong'], postscript: 'STZhongsong' },
  { keys: ['华文楷体', 'stkaiti'], postscript: 'STKaiti' },
  { keys: ['华文仿宋', 'stfangsong'], postscript: 'STFangsong' },
  { keys: ['华文细黑', '细黑', 'stxihei'], postscript: 'STXihei' },
  { keys: ['华文行楷', '行楷', 'stxingkai'], postscript: 'STXingkai' },
  { keys: ['华文新魏', '新魏', 'stxinwei'], postscript: 'STXinwei' },
  { keys: ['华文隶书', '隶书', 'stliti'], postscript: 'STLiti' },
  { keys: ['方正舒体', '舒体', 'fzshuti'], postscript: 'FZSTK--GBK1-0' },
  { keys: ['方正姚体', '姚体', 'fzyaoti'], postscript: 'FZYTK--GBK1-0' },
  { keys: ['汉仪中黑', 'hyzhonghei'], postscript: 'HYZhongHei-197' },
  { keys: ['苹方', 'pingfang', 'pingfangsc'], postscript: 'PingFangSC-Regular' },
  { keys: ['思源宋体', 'sourcehanserifsc'], postscript: 'SourceHanSerifSC-Regular' },
  { keys: ['思源黑体', 'sourcehansanssc'], postscript: 'SourceHanSansSC-Regular' },
  { keys: ['文泉驿微米黑', 'wenquanyimicrohei'], postscript: 'WenQuanYiMicroHei' },
  { keys: ['arial'], postscript: 'Arial' },
  { keys: ['timesnewroman', 'times'], postscript: 'TimesNewRomanPSMT' },
  { keys: ['couriernew', 'courier'], postscript: 'CourierNewPSMT' },
  { keys: ['calibri'], postscript: 'Calibri' },
  { keys: ['cambria'], postscript: 'Cambria' },
];

/** 变体词 → 标准词干；比较时要求前后为分隔符或字符串边界。 */
const STYLE_STEMS: ReadonlyArray<readonly [string, string]> = [
  ['extrabold', 'black'],
  ['ultrabold', 'black'],
  ['semibold', 'bold'],
  ['demibold', 'bold'],
  ['extralight', 'light'],
  ['ultralight', 'light'],
  ['hairline', 'light'],
  ['black', 'black'],
  ['heavy', 'black'],
  ['bold', 'bold'],
  ['medium', 'medium'],
  ['light', 'light'],
  ['thin', 'light'],
  ['italic', 'italic'],
  ['oblique', 'italic'],
  ['regular', 'regular'],
  ['normal', 'regular'],
  ['roman', 'regular'],
];

/** 中文变体词 → 标准词干。 */
const CHINESE_STYLE_STEMS: ReadonlyArray<readonly [string, string]> = [
  ['粗体', 'bold'],
  ['加粗', 'bold'],
  ['细体', 'light'],
  ['中粗', 'medium'],
  ['斜体', 'italic'],
  ['特粗', 'black'],
];

/** 变体词干 → 各风格下常见的 PostScript 后缀（按尝试顺序，设计 §3.3）。 */
const STYLE_SUFFIXES: { readonly [stem: string]: readonly string[] } = {
  bold: ['-Bold', 'Bold', '-Bd'],
  light: ['Light', '-Light', 'Lt'],
  medium: ['-Medium', 'Medium'],
  black: ['-Black', 'Black', '-Heavy'],
  italic: ['-Italic', 'Italic'],
};

/** 单个字体声明的候选名上限（设计 §3.3；同时满足 §1.4 单次查询候选名上限）。 */
export const MAX_CANDIDATES_PER_DECLARATION = 6;

/** 为「原始名」预留的候选位：保证文档原样写的 PostScript 名不会因配额被挤掉。 */
const RESERVED_FOR_ORIGINAL = 1;

/**
 * 归一化字体名：转小写并移除空白、连字符、下划线、逗号与点。
 *
 * 与引擎 `normalizeFontName`（`src/font/aliases.ts`）口径一致；此处本地实现，避免 UI
 * 依赖引擎内部模块。
 *
 * @param name 原始字体名。
 * @returns 归一化名称；输入为空时返回空串。
 */
export function normalizeLocalFontName(name: string | undefined | null): string {
  if (!name) return '';
  return name.toLowerCase().replace(/[\s\-_,.]+/g, '');
}

/**
 * 判断名称是否为内置表/别名表产出的严格查询键。
 *
 * PostScript 面名不含空白，实测（设计 §1.3）带空格的名称不能命中，因此内置表与别名表
 * 驱动的候选必须是**不含空白的纯 ASCII** 名称。
 *
 * @param name 候选名称。
 * @returns 非空、无空白、纯 ASCII 时返回 true。
 */
function isQueryKeyName(name: string | undefined): name is string {
  if (!name) return false;
  return !/[^\x21-\x7e]/.test(name);
}

/**
 * 判断名称是否为可直接保留的文档原始名。
 *
 * 文档原始名是宿主/文档原样给出的名字，剔除会让内置表之外的字体彻底没有候选；
 * 只要不含非 ASCII 字符（中文名实测不命中）就保留，是否命中共由浏览器判定。
 *
 * @param name 文档声明的原始名。
 * @returns 非空、纯 ASCII 时返回 true。
 */
function isOriginalName(name: string | undefined): name is string {
  if (!name) return false;
  return !/[^\x20-\x7e]/.test(name);
}

/**
 * 判断名称是否本身就是可信的 PostScript 写法。
 *
 * PostScript 名的大小写无法由内容推导（`simsun` 的真实写法是 `SimSun`），因此只有含
 * 大写字母的 ASCII 名称才视为可信；全小写名必须经由内置表还原为真实写法后才可用。
 *
 * @param name 候选名称。
 * @returns 含大写字母的纯 ASCII 名称返回 true。
 */
function looksLikePostscriptName(name: string | undefined): name is string {
  return isQueryKeyName(name) && /[A-Z]/.test(name);
}

/**
 * 抽取名字中的变体词并归一化为标准词干。
 *
 * @param name 字体声明名。
 * @returns 标准词干列表，如 `['bold']`；无变体词时为空数组。
 */
function styleWordsOf(name: string): readonly string[] {
  const lower = name.toLowerCase();
  const stems: string[] = [];
  for (const [word, stem] of STYLE_STEMS) {
    // 变体词必须独立成词：前后为分隔符、数字或字符串边界，避免 `Blackadder` 命中 `black`。
    const pattern = new RegExp(`(^|[\\s\\-_])${word}($|[\\s\\-_0-9])`);
    if (pattern.test(lower) && !stems.includes(stem)) stems.push(stem);
  }
  for (const [word, stem] of CHINESE_STYLE_STEMS) {
    if (name.includes(word) && !stems.includes(stem)) stems.push(stem);
  }
  return stems;
}

/**
 * 去掉名字中的变体词，得到用于匹配内置表的基础名。
 *
 * @param name 字体声明名。
 * @returns 去词后的名称；全部被去掉时返回原值。
 */
function stripStyleWords(name: string): string {
  let result = name;
  for (const [word] of STYLE_STEMS) {
    result = result.replace(new RegExp(`[\\s\\-_]*${word}[\\s\\-_]*`, 'gi'), ' ');
  }
  for (const [word] of CHINESE_STYLE_STEMS) {
    result = result.split(word).join(' ');
  }
  return result.trim() || name;
}

/**
 * 在内置常见字体表中匹配声明名的基础 PostScript 名。
 *
 * 先做归一化后的**精确匹配**（避免「华文中宋」被「宋体」抢先命中），再退到**包含匹配**
 * （覆盖 `宋体(方正)` 这类带说明的写法）。
 *
 * @param declared 参与匹配的声明名列表（已去掉变体词）。
 * @returns 基础 PostScript 名；无命中时 undefined。
 */
function matchCommonBase(declared: readonly string[]): string | undefined {
  const normalized = declared.map((name) => normalizeLocalFontName(name)).filter(Boolean);
  if (normalized.length === 0) return undefined;
  for (const entry of COMMON_FONTS) {
    const keys = entry.keys.map((key) => normalizeLocalFontName(key)).filter(Boolean);
    if (normalized.some((name) => keys.includes(name))) return entry.postscript;
  }
  for (const entry of COMMON_FONTS) {
    const keys = entry.keys.map((key) => normalizeLocalFontName(key)).filter(Boolean);
    if (normalized.some((name) => keys.some((key) => name.includes(key)))) return entry.postscript;
  }
  return undefined;
}

/**
 * 把别名组成员还原为可查询的 PostScript 名。
 *
 * 大小写无法从名称内容推断（`simsun` 的真实写法是 `SimSun`），因此只在内置表中查得
 * 真实写法，或成员本身已含大写字母时采用；否则返回 undefined。
 *
 * @param member 别名组中的名称。
 * @returns 可查询的 PostScript 名；无法确定时 undefined。
 */
function postscriptNameOf(member: string): string | undefined {
  const trimmed = member.trim();
  if (!trimmed) return undefined;
  const fromTable = matchCommonBase([trimmed]);
  if (fromTable) return fromTable;
  return looksLikePostscriptName(trimmed) ? trimmed : undefined;
}

/**
 * 把文档字体声明展开为候选 PostScript 名列表。
 *
 * 展开顺序固定（设计 §3.3）：变体后缀 → 基础名 → 文档原始名。候选名总数上限 6 个，
 * 并为原始名保留至少一个位置，避免文档原样写的 PostScript 名被变体候选挤掉。
 *
 * @param input 文档声明的字体名与字体属性；`familyName` 参与匹配但不单独产生候选。
 * @param aliases 别名表（调用方应传入 `composeFontAliases()` 的结果：内置组 + 宿主组）。
 * @returns 候选名列表；输入为空时 `names` 为空数组。
 */
export function expandLocalFontCandidates(
  input: {
    readonly fontName: string;
    readonly familyName?: string;
    readonly bold?: boolean;
    readonly italic?: boolean;
  },
  aliases: FontAliasTable = [],
): LocalFontCandidates {
  const source = (input.fontName ?? '').trim();
  if (!source) return { source: '', names: [] };

  // 参与匹配的名称：FontName 优先，再补 FamilyName；去重且丢弃空值。
  const declared: string[] = [];
  for (const name of [source, (input.familyName ?? '').trim()]) {
    if (name && !declared.includes(name)) declared.push(name);
  }

  // 变体词：先看声明名里的词，再看文档的 bold/italic 属性。
  const stems: string[] = [];
  for (const name of declared) {
    for (const stem of styleWordsOf(name)) {
      if (!stems.includes(stem)) stems.push(stem);
    }
  }
  if (stems.length === 0) {
    if (input.bold) stems.push('bold');
    if (input.italic) stems.push('italic');
  }

  // 展开顺序（设计 §3.3）：变体后缀 → 基础名 → 原始名。
  // 别名表只负责把声明归一化到可查询写法，因此其产出排在基础名之后，避免别名组里的
  // 其它基础名（`STSong`、`NSimSun`）挤掉更精确的变体候选。
  const base = matchCommonBase(declared.map((name) => stripStyleWords(name)));
  const names: string[] = [];

  /**
   * 追加候选名。
   *
   * 非 ASCII 名（中文名）一律丢弃且**不占用配额**。`trusted` 为 true 表示内置表/别名表
   * 给出的真实写法，只做严格查询键校验；`original` 为 true 表示文档原始名，只要求纯
   * ASCII；两者都为 false 时要求名称本身已是可信的 PostScript 写法。
   *
   * @param name 候选名。
   * @param trusted 是否来自内置表或别名表的可信写法。
   * @param original 是否来自文档原始声明。
   */
  const push = (name: string | undefined, trusted = false, original = false): void => {
    const trimmed = name?.trim();
    if (!trimmed) return;
    if (trusted) {
      if (!isQueryKeyName(trimmed)) return;
    } else if (original) {
      if (!isOriginalName(trimmed)) return;
    } else if (!looksLikePostscriptName(trimmed)) {
      return;
    }
    if (names.includes(trimmed)) return;
    names.push(trimmed);
  };

  // 1. 变体后缀：命中内置表时按变体词生成精确名。
  //    为「基础名」与「原始名」各保留一个位置，保证两者不被变体候选挤掉。
  const variantBudget = MAX_CANDIDATES_PER_DECLARATION - 1 - RESERVED_FOR_ORIGINAL;
  if (base) {
    for (const stem of stems) {
      for (const suffix of STYLE_SUFFIXES[stem] ?? []) {
        if (names.length >= variantBudget) break;
        push(`${base}${suffix}`, true);
      }
    }
  }

  // 2. 基础名：命中内置表时给出真实写法。
  if (base) push(base, true);

  // 3. 别名表：声明（含去变体词后的基础名）所在别名组的 PostScript 写法。
  const declaredKeys = new Set<string>();
  for (const name of declared) {
    declaredKeys.add(normalizeLocalFontName(name));
    declaredKeys.add(normalizeLocalFontName(stripStyleWords(name)));
  }
  // 别名成员占用的槽位上限：为文档原始名至少保留一个位置（见下方第 4 步）。
  const aliasBudget = MAX_CANDIDATES_PER_DECLARATION - RESERVED_FOR_ORIGINAL;
  for (const group of aliases) {
    const members = group.map((member) => normalizeLocalFontName(member)).filter(Boolean);
    const hit = [...declaredKeys].some((key) => key !== '' && members.includes(key));
    if (!hit) continue;
    for (const member of group) {
      if (names.length >= aliasBudget) break;
      push(postscriptNameOf(member), true);
    }
  }

  // 4. 文档原始名：原样保留（含空格也不改写），文档直接写 PostScript 面名时才能命中。
  //    跳过规则：仅当它与已有候选「归一化后相同且大小写仅有大小写差异」时跳过，
  //    使 `simsun` 与 `SimSun` 得到相同候选集（不为同一面重复提交大小写变体）；
  //    而 `SimHei-bold` 与 `SimHei` 虽然归一化后不同（含连字符与词干），必须双双保留。
  for (const name of declared) {
    const key = normalizeLocalFontName(name);
    const duplicated = key !== '' && names.some((existing) => normalizeLocalFontName(existing) === key);
    if (duplicated && !names.includes(name)) {
      // 已有同归一化名的候选，且原始名本身是纯大小写变体（无额外分隔符/词干）→ 跳过。
      const hasExtraParts = /[^A-Za-z0-9]/.test(name.replace(/^[\w.-]+$/, '')) || isStyledName(name);
      if (!hasExtraParts) continue;
    }
    push(name, false, true);
  }

  return {
    source,
    names: names.slice(0, MAX_CANDIDATES_PER_DECLARATION),
    ...(base ? { base } : {}),
  };

}

/**
 * 判断名称是否带变体词（用于区分 `SimSun` 与 `SimHei-bold` 这类原始名）。
 *
 * @param name 原始声明名。
 * @returns 含粗体/斜体等变体词时返回 true。
 */
function isStyledName(name: string): boolean {
  return styleWordsOf(name).length > 0;
}
