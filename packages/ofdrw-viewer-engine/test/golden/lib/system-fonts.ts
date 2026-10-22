/**
 * 黄金图 harness 的系统补充字体发现。
 *
 * Node 测试环境没有浏览器系统字体回退；未注入字体时，非内嵌字体样本会全部
 * `W_FONT_MISSING` 并输出空白文字，导致“引擎缺陷”与“宿主未提供字体”无法区分。
 * 本模块只在测试侧发现主机字体文件并读取为 `supplementaryFonts` 的 `data` 来源；
 * 不改变引擎公共 API，也不内置字体。
 */

import { existsSync, readFileSync } from 'node:fs';
import type { FontInput } from 'ofdrw-viewer-engine';

/**
 * 系统字体候选组；每组按优先级取第一个可用文件。
 *
 * 第一组是 CJK 主字体（中文样本），第二组是西文衬线回退（Nimbus Roman，
 * 缺失时用 Noto Serif CJK）。两组都注入，避免只取第一个导致 z p2 的
 * Times New Roman 字形仍落到宿主默认字体。
 */
const FONT_CANDIDATE_GROUPS: ReadonlyArray<
  ReadonlyArray<{ family: string; paths: readonly string[] }>
> = [
  [
    {
      family: 'Noto Sans CJK SC',
      paths: [
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
      ],
    },
    {
      family: 'Droid Sans Fallback',
      paths: ['/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf'],
    },
    {
      family: 'WenQuanYi Micro Hei',
      paths: ['/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'],
    },
    {
      family: 'PingFang SC',
      paths: ['/System/Library/Fonts/PingFang.ttc'],
    },
    {
      family: 'SimSun',
      paths: ['C:\\Windows\\Fonts\\simsun.ttc'],
    },
  ],
  [
    {
      family: 'Nimbus Roman',
      paths: [
        '/usr/share/fonts/opentype/urw-base35/NimbusRoman-Regular.otf',
        '/usr/share/fonts/type1/urw-base35/NimbusRoman-Regular.t1',
      ],
    },
    {
      family: 'Noto Serif CJK SC',
      paths: ['/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc'],
    },
  ],
];

/** 可覆盖的补充字体文件路径环境变量。 */
const FONT_PATH_ENV = 'GOLDEN_SUPPLEMENTARY_FONT';

/** 缓存：同一测试进程只读取一次字体字节。 */
let cachedFonts: FontInput[] | undefined;
let cachedDescription: string[] | undefined;

/**
 * 发现并读取系统补充字体。
 *
 * @returns 可直接传给 `OFDDocument.open({ supplementaryFonts })` 的字体来源；
 *          无可用字体时返回空数组。
 */
export function loadSystemSupplementaryFonts(): FontInput[] {
  if (cachedFonts) return cachedFonts;
  const fonts: FontInput[] = [];
  const description: string[] = [];
  const override = process.env[FONT_PATH_ENV];
  if (override) {
    if (existsSync(override)) {
      fonts.push({ data: new Uint8Array(readFileSync(override)), family: 'GOLDEN_SUPPLEMENTARY_FONT' });
      description.push(override);
    }
  } else {
    for (const group of FONT_CANDIDATE_GROUPS) {
      const candidate = group.find((item) => item.paths.some((path) => existsSync(path)));
      if (!candidate) continue;
      const path = candidate.paths.find((item) => existsSync(item));
      if (!path) continue;
      fonts.push({ data: new Uint8Array(readFileSync(path)), family: candidate.family });
      description.push(path);
    }
  }
  cachedFonts = fonts;
  cachedDescription = description;
  return fonts;
}

/**
 * 返回本次发现到的字体文件路径（用于报告/诊断，不读字节）。
 *
 * @returns 已加载字体文件路径；未注入时为空数组。
 */
export function systemSupplementaryFontDescription(): string[] {
  if (cachedDescription) return [...cachedDescription];
  loadSystemSupplementaryFonts();
  return [...(cachedDescription ?? [])];
}

/** 清空发现缓存；仅测试隔离使用。 */
export function clearSystemSupplementaryFontCache(): void {
  cachedFonts = undefined;
  cachedDescription = undefined;
}
