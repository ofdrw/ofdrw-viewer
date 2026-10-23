/**
 * 黄金图 harness 的系统补充字体发现。
 *
 * Node 测试环境没有浏览器系统字体回退；未注入字体时，非内嵌字体样本会全部
 * `W_FONT_MISSING` 并输出空白文字，导致“引擎缺陷”与“宿主未提供字体”无法区分。
 * 本模块只在测试侧发现主机字体文件，并以惰性 `data` getter 提供 `supplementaryFonts`；
 * 引擎首次解析字体时才读取字节，避免 `OFDDocument.open` 为每个样本预读数十 MiB 字体。
 * 不改变引擎公共 API，也不内置字体。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FontInput } from '@ofdrw/ofdrw-viewer-engine';

/**
 * 系统字体候选组；每组按优先级取第一个可用文件。
 *
 * 第一组是 CJK 主字体（中文样本），第二组是西文衬线回退（Nimbus Roman，
 * 缺失时用 Noto Serif CJK），第三组是宿主 SimSun/宋体，第四组是宿主
 * FangSong/仿宋，第五组是宿主小标宋，第六组是真实 Times New Roman
 * （精确 family，避免 Nimbus 的 glyph191/Otilde 冒充 fi 连字）；存在才注入。
 * 各组都注入，按字体名评分选择，避免只取第一个导致特定 family 落空。
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
  [
    {
      family: 'SimSun',
      paths: [
        join(homedir(), '.local/share/fonts/SimSun.ttc'),
        'C:\\Windows\\Fonts\\simsun.ttc',
      ],
    },
  ],
  [
    {
      family: 'FangSong',
      paths: [
        join(homedir(), '.local/share/fonts/simfang.ttf'),
        join(homedir(), '.fonts/simfang.ttf'),
        '/mnt/c/Windows/Fonts/simfang.ttf',
        'C:\\Windows\\Fonts\\simfang.ttf',
      ],
    },
  ],
  [
    {
      family: '小标宋体',
      paths: [
        join(homedir(), '.local/share/fonts/HGXBS_CNKI.TTF'),
        '/mnt/c/Windows/Fonts/HGXBS_CNKI.TTF',
        'C:\\Windows\\Fonts\\HGXBS_CNKI.TTF',
      ],
    },
  ],
  [
    {
      family: 'Times New Roman',
      paths: [
        join(homedir(), '.local/share/fonts/times.ttf'),
        '/mnt/c/Windows/Fonts/times.ttf',
        'C:\\Windows\\Fonts\\times.ttf',
        '/usr/share/fonts/truetype/msttcorefonts/Times_New_Roman.ttf',
        '/usr/share/fonts/truetype/msttcorefonts/times.ttf',
        '/usr/share/fonts/TTF/Times_New_Roman.ttf',
      ],
    },
  ],
  [
    {
      // 楷体：SignScaleError/v4signed 等样本的 FontName=楷体，必须注入真实 family；
      // 否则引擎静默回退 Noto Sans，SSIM 低值会被误判为引擎字形缺陷。
      family: 'KaiTi',
      paths: [
        '/mnt/c/Windows/Fonts/simkai.ttf',
        'C:\\Windows\\Fonts\\simkai.ttf',
        join(homedir(), '.local/share/fonts/simkai.ttf'),
        '/usr/share/fonts/truetype/arphic/ukai.ttc',
      ],
    },
  ],
  [
    {
      // 华文楷体（STKaiti）作为 KaiTi 不可用时的第二候选；family 用于匹配 FontName=STKaiti。
      family: 'STKaiti',
      paths: [
        '/mnt/c/Windows/Fonts/STKAITI.TTF',
        'C:\\Windows\\Fonts\\STKAITI.TTF',
        join(homedir(), '.local/share/fonts/STKAITI.TTF'),
      ],
    },
  ],
  [
    {
      family: 'Tahoma',
      paths: [
        '/mnt/c/Windows/Fonts/tahoma.ttf',
        'C:\\Windows\\Fonts\\tahoma.ttf',
        join(homedir(), '.local/share/fonts/tahoma.ttf'),
      ],
    },
  ],
  [
    {
      // Courier/Courier New：v4signed 等样本的等宽字体，避免回退到 Noto Sans Mono 后字宽失真。
      family: 'Courier New',
      paths: [
        '/mnt/c/Windows/Fonts/cour.ttf',
        'C:\\Windows\\Fonts\\cour.ttf',
        join(homedir(), '.local/share/fonts/cour.ttf'),
        '/usr/share/fonts/truetype/msttcorefonts/Courier_New.ttf',
      ],
    },
  ],
];

/** 可覆盖的补充字体文件路径环境变量。 */
const FONT_PATH_ENV = 'GOLDEN_SUPPLEMENTARY_FONT';

/** 缓存：同一测试进程复用同一批惰性字体来源。 */
let cachedFonts: FontInput[] | undefined;
let cachedDescription: string[] | undefined;

/**
 * 创建惰性字体来源；`data` 首次被引擎读取时才加载文件。
 *
 * @param path 字体文件路径。
 * @param family 诊断/别名匹配使用的字体族名。
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
 * 发现系统补充字体；只做文件存在性检查，不读取字体字节。
 *
 * @returns 可直接传给 `OFDDocument.open({ supplementaryFonts })` 的字体来源；
 *          无可用字体时返回空数组。`data` 在首次解析字体时才读取。
 */
export function loadSystemSupplementaryFonts(): FontInput[] {
  if (cachedFonts) return cachedFonts;
  const fonts: FontInput[] = [];
  const description: string[] = [];
  const override = process.env[FONT_PATH_ENV];
  if (override) {
    if (existsSync(override)) {
      fonts.push(createLazyFontInput(override, 'GOLDEN_SUPPLEMENTARY_FONT'));
      description.push(override);
    }
  } else {
    for (const group of FONT_CANDIDATE_GROUPS) {
      const candidate = group.find((item) => item.paths.some((path) => existsSync(path)));
      if (!candidate) continue;
      const path = candidate.paths.find((item) => existsSync(item));
      if (!path) continue;
      fonts.push(createLazyFontInput(path, candidate.family));
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
 * @returns 发现到的字体文件路径；未注入时为空数组。
 */
export function systemSupplementaryFontDescription(): string[] {
  if (cachedDescription) return [...cachedDescription];
  loadSystemSupplementaryFonts();
  return [...(cachedDescription ?? [])];
}

/**
 * 返回本次发现到的字体族名（用于宿主字体覆盖诊断）。
 *
 * @returns 注入的 family 名列表；未发现字体时为空数组。
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
