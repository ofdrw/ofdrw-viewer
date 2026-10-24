/**
 * 演示站字体配置单元测试：本地文泉驿兜底、CDN 回落、宋体别名衔接与资源路径。
 *
 * 直接读取 `site/main.ts` 源码做静态断言，并单独校验别名追加语义；不启动浏览器，
 * 避免测试依赖 DOM/网络。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// 引擎包只经 UI 的工作区依赖解析（site 包本身不声明该依赖），这里显式走同一份 workspace 链接。
import { composeFontAliases } from '../../packages/ofdrw-viewer-ui/src/font';
import { DEFAULT_FONT_ALIASES } from '../../packages/ofdrw-viewer-ui/node_modules/@ofdrw/ofdrw-viewer-engine';

/** 站点入口源码路径。 */
const MAIN_TS = fileURLToPath(new URL('../main.ts', import.meta.url));
/** 字体目录路径。 */
const FONT_DIR = fileURLToPath(new URL('../public/fonts/', import.meta.url));

/**
 * 按主干名查找带内容哈希的字体文件。
 *
 * 字体文件名形如 `source-han-serif-sc.<sha256前8位>.woff2`：内容变化时文件名随之变化，
 * 浏览器可据此长期强缓存。
 *
 * @param stem 文件名主干，例如 `source-han-serif-sc`
 * @returns 字体文件绝对路径
 */
function findHashedFont(stem: string): string {
  const pattern = new RegExp(`^${stem}\\.[0-9a-f]{8}\\.woff2$`);
  const matches = readdirSync(FONT_DIR).filter((name) => pattern.test(name));
  expect(matches, `${stem} 应只有一个带哈希的 woff2`).toHaveLength(1);
  return join(FONT_DIR, matches[0]!);
}
/** 字体说明与授权文件路径。 */
const LOCAL_FONT_NOTICE = fileURLToPath(new URL('../public/fonts/NOTICE.md', import.meta.url));

/**
 * 读取 `site/main.ts` 中 `SITE_FONT_ALIASES` 的字符串字面量组。
 *
 * @returns 每一组别名的字符串列表
 */
function readSiteAliasGroups(): string[][] {
  const source = readFileSync(MAIN_TS, 'utf8');
  const start = source.indexOf('const SITE_FONT_ALIASES');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('];', start);
  const block = source.slice(start, end);
  return [...block.matchAll(/\[([^[\]]*)\]/g)]
    .map((match) => [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]))
    .filter((group) => group.length > 0);
}

/**
 * 读取 `site/main.ts` 中默认字体来源的 URL 表达式。
 *
 * @returns 以源码文本表示的 URL 表达式列表
 */
function readDefaultFontUrls(): string[] {
  const source = readFileSync(MAIN_TS, 'utf8');
  const start = source.indexOf('default: [');
  const end = source.indexOf('],', start);
  return [...source.slice(start, end).matchAll(/url:\s*([^,}]+)/g)].map((match) =>
    match[1].trim(),
  );
}

describe('演示站字体配置', () => {
  it('本地思源宋体与文泉驿微米黑子集及其授权说明随站点分发', () => {
    // 体积与 NOTICE.md 记录一致（单位 byte）：思源宋体约 10.6 MiB、文泉驿微米黑约 1.07 MiB。
    expect(statSync(findHashedFont('source-han-serif-sc')).size).toBe(11_109_788);
    expect(statSync(findHashedFont('wqy-microhei')).size).toBe(1_118_044);
    const notice = readFileSync(LOCAL_FONT_NOTICE, 'utf8');
    expect(notice).toContain('Noto Serif CJK SC');
    expect(notice).toContain('WenQuanYi Micro Hei');
    expect(notice).toContain('SIL Open Font License');
    expect(notice).toContain('Apache License 2.0');
    expect(notice).toContain('scripts/build-site-fonts.py');
  });

  it('字体文件名带内容哈希，并配置长期强缓存头', () => {
    // 哈希命名是强缓存的前提：内容变化 → 文件名变化，旧文件不会被误用。
    for (const stem of ['source-han-serif-sc', 'wqy-microhei']) {
      const path = findHashedFont(stem);
      expect(path).toMatch(new RegExp(`${stem}\\.[0-9a-f]{8}\\.woff2$`));
    }
    // site/main.ts 必须引用文件常量，而不是把哈希写死在 URL 里，避免两处不一致。
    const source = readFileSync(MAIN_TS, 'utf8');
    for (const constant of ['LOCAL_SERIF_FILE', 'LOCAL_SANS_FILE']) {
      const match = new RegExp(`const ${constant} = '([^']+)'`).exec(source);
      expect(match, `${constant} 应声明为字符串常量`).not.toBeNull();
      expect(findHashedFont(match![1]!.replace(/^fonts\//, '').replace(/\.[0-9a-f]{8}\.woff2$/, '')))
        .toBe(join(FONT_DIR, match![1]!.replace(/^fonts\//, '')));
    }
    // 静态托管（_headers 约定）声明 immutable 缓存。
    const headers = readFileSync(fileURLToPath(new URL('../public/_headers', import.meta.url)), 'utf8');
    expect(headers).toContain('/fonts/*.woff2');
    expect(headers).toContain('immutable');
  });

  it('仅使用本地思源宋体与文泉驿微米黑，不依赖外部 CDN', () => {
    const source = readFileSync(MAIN_TS, 'utf8');
    const urls = readDefaultFontUrls();
    // 只保留一个本地来源：不再配置 CDN 回落。
    expect(urls).toHaveLength(1);
    // 本地路径必须经 import.meta.env.BASE_URL 拼接，不能硬编码以 `/` 开头的绝对路径。
    expect(urls[0]).toContain('siteAsset(LOCAL_SERIF_FILE)');
    expect(urls[0]).not.toMatch(/url:\s*['"]\//);
    expect(source).toContain('import.meta.env.BASE_URL');

    const supplementary = source.slice(source.indexOf('supplementary: ['));
    const block = supplementary.slice(0, supplementary.indexOf('],'));
    expect(block).toContain('siteAsset(LOCAL_SANS_FILE)');
    // 字体来源全部是本地文件。
    expect(block).not.toContain('https://');

    // 站点不再引入任何外部字体 CDN。
    expect(source).not.toContain('cdn.jsdelivr.net');
    expect(source).not.toContain('fontUrl(');
  });

  it('别名追加后同时保留内置组，且宋体↔思源宋体、黑体↔文泉驿互为别名', () => {
    const groups = readSiteAliasGroups();
    expect(groups).toHaveLength(2);
    const [serifGroup, sansGroup] = groups;
    for (const name of [
      '宋体',
      'simsun',
      'nsimsun',
      '新宋体',
      'notoserifcjksc',
      'notoserifsc',
      'sourcehanserifsc',
      '思源宋体',
    ]) {
      expect(serifGroup).toContain(name);
    }
    for (const name of [
      '黑体',
      'simhei',
      'heiti',
      '微软雅黑',
      'microsoftyahei',
      'wenquanyimicrohei',
      'wenquanyimicroheimono',
      '文泉驿微米黑',
    ]) {
      expect(sansGroup).toContain(name);
    }
    const composed = composeFontAliases(groups);
    // 追加语义：内置组完整保留，且新增组排在最后。
    expect(composed).toHaveLength(DEFAULT_FONT_ALIASES.length + 2);
    expect(composed.slice(0, DEFAULT_FONT_ALIASES.length)).toEqual(
      DEFAULT_FONT_ALIASES.map((group) => [...group]),
    );
    const merged = new Set(composed.flat().map((name) => name.toLowerCase()));
    expect(merged.has('simhei')).toBe(true);
    expect(merged.has('wenquanyimicrohei')).toBe(true);
    expect(merged.has('notoserifcjksc')).toBe(true);

    /** 归一化名称与引擎 `normalizeFontName` 一致：小写并去掉空白/连字符/下划线/逗号/点。 */
    const normalize = (name: string): string => name.toLowerCase().replace(/[\s\-_.,]+/g, '');
    /** 计算某名称经别名表扩散后的全部归一化名称（同一组的名称互相扩散）。 */
    const expand = (name: string): Set<string> => {
      const target = normalize(name);
      const expanded = new Set<string>([target]);
      for (const group of composed) {
        const normalized = group.map(normalize);
        if (normalized.includes(target)) for (const item of normalized) expanded.add(item);
      }
      return expanded;
    };
    expect(expand('宋体').has('notoserifcjksc')).toBe(true);
    expect(expand('黑体').has('wenquanyimicrohei')).toBe(true);
    // 跨组不误连：宋体组与文泉驿组互不包含。
    expect(expand('宋体').has('wenquanyimicrohei')).toBe(false);
  });
});
