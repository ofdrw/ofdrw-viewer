/**
 * 本机字体名与变体识别测试（设计 §3.3/§3.4、需求清单 REQ-009~REQ-012、§10 T-P1~T-P6）。
 *
 * 全部为纯函数断言：输入是引擎 `getFontResources()` 的声明字段，输出是按尝试顺序排列的
 * 候选 PostScript 名。重点守住「大小写必须是真的 PostScript 写法」——`queryLocalFonts`
 * 的 `postscriptNames` 大小写敏感（`SimSun` ≠ `Simsun`），草稿的「首字母大写」推断会让
 * 黑体等带双大写字母的名字整体失效。
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_FONT_ALIASES } from '@ofdrw/ofdrw-viewer-engine';
import {
  expandLocalFontCandidates,
  MAX_CANDIDATES_PER_DECLARATION,
} from '../../../src/local-font-names';

/**
 * 按声明展开候选（默认别名表）。
 *
 * @param input 文档字体声明。
 * @param aliases 别名表；默认内置别名组。
 * @returns 候选结构，含 source/names/base。
 */
function candidatesOf(
  input: Parameters<typeof expandLocalFontCandidates>[0],
  aliases = DEFAULT_FONT_ALIASES,
): ReturnType<typeof expandLocalFontCandidates> {
  return expandLocalFontCandidates(input, aliases);
}

/** 候选名列表。 */
function namesOf(
  input: Parameters<typeof expandLocalFontCandidates>[0],
  aliases = DEFAULT_FONT_ALIASES,
): readonly string[] {
  return candidatesOf(input, aliases).names;
}

describe('expandLocalFontCandidates 中文名识别（T-P1）', () => {
  it('宋体 → 候选含 SimSun，不含 Simsun 与中文原名', () => {
    const result = candidatesOf({ fontName: '宋体' });
    expect(result.names).toContain('SimSun');
    expect(result.names).not.toContain('Simsun');
    expect(result.names).not.toContain('simsun');
    expect(result.names).not.toContain('宋体');
    // 命中内置表时给出基础名，供诊断与后续变体展开使用。
    expect(result.base).toBe('SimSun');
    // 原始声明保留在 source 中，便于 warning 文案只引用声明名。
    expect(result.source).toBe('宋体');
  });

  it('黑体 → 候选含 SimHei，不含 Simhei', () => {
    // 双大写字母是草稿「首字母大写」推断的典型失效点。
    const names = namesOf({ fontName: '黑体' });
    expect(names).toContain('SimHei');
    expect(names).not.toContain('Simhei');
    expect(candidatesOf({ fontName: '黑体' }).base).toBe('SimHei');
  });

  it('微软雅黑 粗体 → 候选含 MicrosoftYaHei-Bold 或 MicrosoftYaHei，不含 Microsoftyahei', () => {
    const result = candidatesOf({ fontName: '微软雅黑', bold: true });
    expect(
      result.names.includes('MicrosoftYaHei-Bold') || result.names.includes('MicrosoftYaHei'),
    ).toBe(true);
    // 大小写必须逐字精确：`Microsoftyahei`（推断写法）出现在任何位置都是错误候选。
    expect(result.names).not.toContain('Microsoftyahei');
    expect(result.names.some((name) => /^Microsoftyahei(?:-|$)/.test(name))).toBe(false);
  });

  it('内置表覆盖设计 §3.4 全部条目，且都命中各自的基础名', () => {
    const table: ReadonlyArray<readonly [string, string]> = [
      ['宋体', 'SimSun'],
      ['新宋体', 'NSimSun'],
      ['黑体', 'SimHei'],
      ['楷体', 'KaiTi'],
      ['仿宋', 'FangSong'],
      ['微软雅黑', 'MicrosoftYaHei'],
      ['微软雅黑 UI', 'MicrosoftYaHeiUI'],
      ['等线', 'DengXian'],
      ['华文宋体', 'STSong'],
      ['华文中宋', 'STZhongsong'],
      ['华文楷体', 'STKaiti'],
      ['华文仿宋', 'STFangsong'],
      ['华文细黑', 'STXihei'],
      ['华文行楷', 'STXingkai'],
      ['华文新魏', 'STXinwei'],
      ['华文隶书', 'STLiti'],
      ['方正舒体', 'FZSTK--GBK1-0'],
      ['方正姚体', 'FZYTK--GBK1-0'],
      ['汉仪中黑', 'HYZhongHei-197'],
      ['苹方', 'PingFangSC-Regular'],
      ['思源宋体', 'SourceHanSerifSC-Regular'],
      ['思源黑体', 'SourceHanSansSC-Regular'],
      ['文泉驿微米黑', 'WenQuanYiMicroHei'],
      ['Arial', 'Arial'],
      ['Times New Roman', 'TimesNewRomanPSMT'],
      ['Courier New', 'CourierNewPSMT'],
      ['Calibri', 'Calibri'],
      ['Cambria', 'Cambria'],
    ];
    for (const [declared, base] of table) {
      const result = candidatesOf({ fontName: declared });
      expect(result.base, `声明「${declared}」的基础名`).toBe(base);
      expect(result.names, `声明「${declared}」的候选`).toContain(base);
    }
  });
});

/**
 * 变体回退链（T-P2）。
 *
 * 需求清单 REQ-011 / 设计 §3.3 规定的顺序是「变体后缀 → 基础名 → 原始名」，且基础名
 * 永远在变体候选之后。本组用例锁死该顺序：只要是变体候选（`SimSun-Bold`、`SimSunBold`、
 * `SimSun-Bd` 等）就必须排在基础名 `SimSun` 前面，数组顺序即尝试顺序。
 */
describe('expandLocalFontCandidates 变体回退链（T-P2）', () => {
  it('宋体 Bold → SimSun-Bold 先于 SimSunBold 与 SimSun', () => {
    const names = namesOf({ fontName: '宋体 Bold' });
    const bold = names.indexOf('SimSun-Bold');
    const boldJoined = names.indexOf('SimSunBold');
    const base = names.indexOf('SimSun');
    expect(bold, 'SimSun-Bold 位置').toBeGreaterThanOrEqual(0);
    expect(boldJoined, 'SimSunBold 位置').toBeGreaterThanOrEqual(0);
    expect(base, 'SimSun 位置').toBeGreaterThanOrEqual(0);
    expect(bold).toBeLessThan(base);
    expect(boldJoined).toBeLessThan(base);
  });

  it('bold 属性命中同一变体链，前两位是 SimSun-Bold 与 SimSunBold', () => {
    const names = namesOf({ fontName: '宋体', bold: true });
    expect(names.slice(0, 2)).toEqual(['SimSun-Bold', 'SimSunBold']);
    // 基础名永远在变体之后：`SimSun-Bold` 不存在时落回 `SimSun`。
    expect(names.indexOf('SimSun')).toBeGreaterThan(1);
  });

  it('SimHei-bold 展开顺序严格为「变体后缀 → 基础名 → 原始名」', () => {
    // 原始名本身是合法 PostScript 面：它排在最后，但因为候选整体按序尝试，
    // 只有前面的变体全部查询无果时才会用到它——顺序断言覆盖这一语义。
    const names = namesOf({ fontName: 'SimHei-bold' });
    const bold = names.indexOf('SimHei-Bold');
    const boldJoined = names.indexOf('SimHeiBold');
    const base = names.indexOf('SimHei');
    const original = names.indexOf('SimHei-bold');
    expect(bold).toBe(0);
    expect(boldJoined).toBeGreaterThan(bold);
    expect(base).toBeGreaterThan(boldJoined);
    if (original >= 0) expect(original).toBeGreaterThan(base);
    // 顺序即语义：数组是严格递增的尝试顺序，不是集合。
    expect(names.length).toBeGreaterThanOrEqual(3);

  });

  it('原始名合法时得以保留（不会因为排序被丢弃）', () => {
    const names = namesOf({ fontName: 'SimHei-Bold' });
    // 文档直接写 PostScript 面名时，必须原样出现在候选中。
    expect(names).toContain('SimHei-Bold');
    expect(names).toContain('SimHei');
  });

  it('斜体与细体变体词同样先于基础名', () => {
    const italic = namesOf({ fontName: '宋体 Italic' });
    expect(italic.indexOf('SimSun-Italic')).toBeGreaterThanOrEqual(0);
    expect(italic.indexOf('SimSun-Italic')).toBeLessThan(italic.indexOf('SimSun'));

    const light = namesOf({ fontName: '宋体 Light' });
    expect(light.slice(0, 1)).toContain('SimSunLight');

    const black = namesOf({ fontName: '宋体 Black' });
    expect(black.slice(0, 1)).toContain('SimSun-Black');
  });

  it('中文变体词「粗体」与「宋体 Bold」等价', () => {
    const chinese = namesOf({ fontName: '黑体 粗体' });
    expect(chinese.indexOf('SimHei-Bold')).toBeGreaterThanOrEqual(0);
    expect(chinese.indexOf('SimHei-Bold')).toBeLessThan(chinese.indexOf('SimHei'));
  });
});

describe('expandLocalFontCandidates 别名为辅、内置表优先（T-P3、T-P4）', () => {
  it('黑体_GB2312 → 基础名 SimHei', () => {
    const result = candidatesOf({ fontName: '黑体_GB2312' });
    expect(result.base).toBe('SimHei');
    expect(result.names).toContain('SimHei');
  });

  it('宋体(方正) 走包含匹配命中「宋体」的基础名', () => {
    const result = candidatesOf({ fontName: '宋体(方正)' });
    expect(result.base).toBe('SimSun');
    expect(result.names).toContain('SimSun');
  });

  it('华文中宋 不得被「宋体」抢先', () => {
    const result = candidatesOf({ fontName: '华文中宋' });
    expect(result.base).toBe('STZhongsong');
    expect(result.names).toContain('STZhongsong');
    // 「宋体」的包含匹配不得命中「华文中宋」，否则会去查 SimSun。
    expect(result.names).not.toContain('SimSun');
    expect(result.names[0]).toBe('STZhongsong');
  });

  it('宿主追加别名组参与归一：自定义「宋体 → fzssk」不被内置表覆盖', () => {
    const aliases = [...DEFAULT_FONT_ALIASES, ['宋体', 'FZSSK--GBK1-0']];
    const names = namesOf({ fontName: '宋体' }, aliases);
    // 别名表给出的 PostScript 写法都参与查询；内置表基础名仍在。
    expect(names).toContain('SimSun');
    expect(names.some((name) => name.toUpperCase() === 'FZSSK--GBK1-0')).toBe(true);
  });

  it('表外字体不做大小写推断：原始名原样保留，不派生「首字母大写」候选', () => {
    // `Noto Serif SC` 未命中内置表：设计 §1.3 只要求「不推断大小写」，
    // 文档原始名作为最后候选原样保留（带空格也不改写，交由查询端判定）。
    const result = candidatesOf({ fontName: 'Noto Serif SC' });
    expect(result.base).toBeUndefined();
    // 唯一候选就是原始名本身：没有任何推断产物。
    expect(result.names).toEqual(['Noto Serif SC']);
    expect(result.names.some((name) => name !== 'Noto Serif SC')).toBe(false);

    // 已是合法 PostScript 形态的表外名同样原样保留。
    const postscript = candidatesOf({ fontName: 'NotoSansSC-Regular' });
    expect(postscript.names).toContain('NotoSansSC-Regular');
  });
});

describe('expandLocalFontCandidates 大小写与空格不产生错误候选（T-P5）', () => {
  it('simsun 与 SimSun 得到完全相同的候选集（不重复提交同一字体面）', () => {
    // 输入大小写差异不改变候选；原始名归一化后与已有候选重复时不再追加，
    // 避免为同一个字体面重复提交大小写变体。
    const lower = namesOf({ fontName: 'simsun' });
    const upper = namesOf({ fontName: 'SimSun' });
    expect([...lower]).toEqual([...upper]);
    expect([...lower]).toEqual(['SimSun', 'STSong', 'NSimSun', 'SourceHanSerifSC-Regular']);
    expect(lower).toContain('SimSun');
  });

  it('带空格与连字符的声明同样归一到真实 PostScript 名', () => {
    for (const declared of ['宋 体', 'sim sun', 'Sim-Sun', ' SIMSUN ']) {
      const names = namesOf({ fontName: declared });
      expect(names, `声明「${declared}」`).toContain('SimSun');
      // 任何位置都不得出现「首字母大写」推断产物 Simsun。
      expect(names, `声明「${declared}」`).not.toContain('Simsun');
    }
  });

  it('候选保持声明大小写时不做首字母改写', () => {
    for (const names of [
      namesOf({ fontName: '黑体' }),
      namesOf({ fontName: 'simhei' }),
      namesOf({ fontName: 'Microsoft YaHei' }),
    ]) {
      expect(names).not.toContain('Simhei');
      expect(names).not.toContain('Microsoftyahei');
    }
  });
});

describe('expandLocalFontCandidates 候选上限与去重（T-P6）', () => {
  it('上限常量单独命名且取值为 6（§0.2：三个上限不得混用同一个常量）', () => {
    expect(MAX_CANDIDATES_PER_DECLARATION).toBe(6);
  });

  it('单声明候选上限为 6，且原始名不会被挤掉', () => {
    // 多组变体词最容易超限：上限必须在截断后仍然成立。
    for (const fontName of ['宋体 Bold Italic', '宋体 Bold Light Black', 'SimSun Bold Italic']) {
      const names = namesOf({ fontName });
      expect(names.length, `声明「${fontName}」`).toBeLessThanOrEqual(6);
      expect(new Set(names).size, `声明「${fontName}」去重`).toBe(names.length);
    }
    // 原始名本身是合法 PostScript 形态时保留在候选里（不会被变体候选挤掉）。
    expect(namesOf({ fontName: 'SimSun Bold Italic' })).toContain('SimSun');
  });

  it('重复候选去重且保持首次出现顺序', () => {
    const names = namesOf({ fontName: 'SimSun Bold' });
    expect(new Set(names).size).toBe(names.length);
    // SimSun 只出现一次（基础名与原始名是同一个名字）。
    expect(names.filter((name) => name === 'SimSun')).toHaveLength(1);
  });
});

describe('expandLocalFontCandidates 中文名不得进入候选（§0.2 查询约束）', () => {
  it('候选名全部为 ASCII，中文声明不原样进入查询', () => {
    for (const fontName of [
      '黑体_GB2312',
      '宋体(方正)',
      '华文中宋',
      '楷体_GB2312',
      '微软雅黑',
      '宋体 Bold',
      '仿宋_GB2312',
    ]) {
      const names = namesOf({ fontName });
      for (const name of names) {
        expect(/[^\x00-\x7f]/.test(name), `声明「${fontName}」的候选「${name}」含非 ASCII 字符`).toBe(false);
      }
    }
  });

  it('未知中文名（表外）不产生中文候选', () => {
    // 表外中文声明无法推断 PostScript 名，宁可不查也不塞中文串。
    const names = namesOf({ fontName: '某未知宋体字体' });
    expect(names.every((name) => !/[^\x00-\x7f]/.test(name))).toBe(true);
  });
});
