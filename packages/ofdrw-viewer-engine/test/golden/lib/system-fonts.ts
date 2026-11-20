/**
 * 黄金图 harness 的补充字体来源。
 *
 * Node 测试环境没有浏览器系统字体回退；未注入字体时，非内嵌字体样本会全部
 * `W_FONT_MISSING` 并输出空白文字，导致“引擎缺陷”与“宿主未提供字体”无法区分。
 * 字体随仓库提交（思源宋体与思源黑体，SIL OFL 1.1），测试结果不依赖机器安装的字体。
 * 以惰性 `data` getter 提供 `supplementaryFonts`，引擎首次解析字体时才读取字节，
 * 避免 `OFDDocument.open` 为每个样本预读数十 MiB 字体。
 * 不改变引擎公共 API，引擎产物不内置字体。
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FontInput } from '@ofdrw/ofdrw-viewer-engine';

/** 仓库字体目录。 */
const FONT_DIRECTORY = fileURLToPath(new URL('../../fixtures/fonts/', import.meta.url));

/** 思源宋体简体中文（SIL OFL 1.1）：衬线中文样本的主字体。 */
export const BUNDLED_SERIF_FONT_PATH = fileURLToPath(
  new URL('../../fixtures/fonts/SourceHanSerifSC-Regular.otf', import.meta.url),
);

/** 思源黑体简体中文（SIL OFL 1.1）：无衬线中文样本的主字体。 */
export const BUNDLED_SANS_FONT_PATH = fileURLToPath(
  new URL('../../fixtures/fonts/SourceHanSansCN-Regular.otf', import.meta.url),
);

/**
 * 仓库内的补充字体及其匹配的字体族名。
 *
 * 同一字体文件会以多个族名注入：OFD 样本常按 SimSun、KaiTi、FangSong 等族名请求字体，
 * 而测试只分发开源字体，因此用思源宋体的衬线字形承接这些衬线族名，用思源黑体承接无衬线族名。
 * 这样引擎按族名匹配时总能命中真实字形，不会静默回退到默认字体。
 */
const BUNDLED_FONTS: ReadonlyArray<{ family: string; path: string }> = Object.freeze([
  { family: 'Noto Serif CJK SC', path: BUNDLED_SERIF_FONT_PATH },
  { family: 'SimSun', path: BUNDLED_SERIF_FONT_PATH },
  { family: '宋体', path: BUNDLED_SERIF_FONT_PATH },
  { family: 'FangSong', path: BUNDLED_SERIF_FONT_PATH },
  { family: '仿宋', path: BUNDLED_SERIF_FONT_PATH },
  { family: '小标宋体', path: BUNDLED_SERIF_FONT_PATH },
  { family: 'Nimbus Roman', path: BUNDLED_SERIF_FONT_PATH },
  { family: 'Times New Roman', path: BUNDLED_SERIF_FONT_PATH },
  { family: 'Noto Sans CJK SC', path: BUNDLED_SANS_FONT_PATH },
  { family: 'Droid Sans Fallback', path: BUNDLED_SANS_FONT_PATH },
  { family: 'KaiTi', path: BUNDLED_SANS_FONT_PATH },
  { family: 'STKaiti', path: BUNDLED_SANS_FONT_PATH },
  { family: '楷体', path: BUNDLED_SANS_FONT_PATH },
  { family: 'Tahoma', path: BUNDLED_SANS_FONT_PATH },
  { family: 'Courier New', path: BUNDLED_SANS_FONT_PATH },
]);

/** 缓存：同一测试进程复用同一批惰性字体来源。 */
let cachedFonts: FontInput[] | undefined;
let cachedDescription: string[] | undefined;

/**
 * 创建惰性字体来源；`data` 首次被引擎读取时才加载文件。
 *
 * @param path 字体文件路径。
 * @param family 诊断与别名匹配使用的字体族名。
 * @returns 可传给 `OFDDocument.open({ supplementaryFonts })` 的字体来源。
 */
function createLazyFontInput(path: string, family: string): FontInput {
  let bytes: Uint8Array | undefined;
  return {
    family,
    get data(): Uint8Array {
      if (!bytes) {
        try {
          bytes = new Uint8Array(readFileSync(path));
        } catch {
          // 文件在发现后被删除/不可读时交给字体解析层 warning，避免阻断整页渲染。
          bytes = new Uint8Array(0);
        }
      }
      return bytes;
    },
  };
}

/**
 * 返回仓库内的补充字体；只做文件存在性检查，不读取字体字节。
 *
 * @returns 可直接传给 `OFDDocument.open({ supplementaryFonts })` 的字体来源；
 *          仓库字体缺失时返回空数组。`data` 在首次解析字体时才读取。
 */
export function loadSystemSupplementaryFonts(): FontInput[] {
  if (cachedFonts) return cachedFonts;
  const fonts: FontInput[] = [];
  const description: string[] = [];
  for (const item of BUNDLED_FONTS) {
    if (!existsSync(item.path)) continue;
    fonts.push(createLazyFontInput(item.path, item.family));
    if (!description.includes(item.path)) description.push(item.path);
  }
  cachedFonts = fonts;
  cachedDescription = description;
  return fonts;
}

/**
 * 返回本次加载的字体文件路径（用于报告/诊断，不读字节）。
 *
 * @returns 字体文件路径；仓库字体缺失时为空数组。
 */
export function systemSupplementaryFontDescription(): string[] {
  if (cachedDescription) return [...cachedDescription];
  loadSystemSupplementaryFonts();
  return [...(cachedDescription ?? [])];
}

/**
 * 返回本次注入的字体族名（用于宿主字体覆盖诊断）。
 *
 * @returns 注入的 family 名列表；仓库字体缺失时为空数组。
 */
export function systemSupplementaryFontFamilies(): string[] {
  return loadSystemSupplementaryFonts()
    .map((font) => font.family ?? '')
    .filter((family) => family.length > 0);
}

/** 清空发现缓存；仅测试隔离使用。 */
export function clearSystemSupplementaryFontCache(): void {
  cachedFonts = undefined;
  cachedDescription = undefined;
}