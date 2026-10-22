/**
 * 字体测试 fixture 管理。
 *
 * 字体文件均不提交：系统字体复制到 `test/.fixtures/fonts/`，真实 OFD 内嵌字体
 * 在运行时解压到同一目录。缺少来源的测试应显式 skip，而不是伪造通过。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

/** 仓库根目录。 */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** 字体 fixture 目录（gitignore）。 */
export const FONT_FIXTURE_DIR = join(REPO_ROOT, 'test/.fixtures/fonts');

/** T4 测试产物目录（gitignore）。 */
export const ARTIFACT_DIR = join(REPO_ROOT, 'test/.artifacts/t4');

/** fixture 集合；值为 null 表示当前环境缺失。 */
export interface FontFixtures {
  /** 正常拉丁 TTF（DejaVu Sans）。 */
  dejavu: string | null;
  /** 正常拉丁粗体 TTF。 */
  dejavuBold: string | null;
  /** 正常拉丁斜体 TTF。 */
  dejavuOblique: string | null;
  /** CJK TTF（Droid Sans Fallback）。 */
  cjkTtf: string | null;
  /** CFF CID 的 TTC（Noto Serif CJK）。 */
  notoTtc: string | null;
  /** Times 兼容衬线字体（Nimbus Roman，可选）。 */
  nimbusRoman: string | null;
  /** CFF CID 的单字体 OTF（仓库参考目录，可选）。 */
  cffOtf: string | null;
  /** 无 cmap/name/OS2 的剥离子集（从 doc1File.ofd 解压）。 */
  stripped: string | null;
  /** 扩展名与内容不符的坏字体（从 intro-数科.ofd 解压）。 */
  broken: string | null;
  /** 正常 CJK 内嵌字体（从 ano.ofd 解压）。 */
  embeddedCjk: string | null;
}

/** 系统字体候选路径。 */
const SYSTEM_FONTS = {
  dejavu: [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf',
  ],
  dejavuBold: ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
  dejavuOblique: ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf'],
  cjkTtf: [
    '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  ],
  notoTtc: [
    '/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  ],
  nimbusRoman: ['/usr/share/fonts/opentype/urw-base35/NimbusRoman-Regular.otf'],
};

/**
 * 确保目录存在。
 *
 * @param dir 目录路径。
 */
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * 从候选路径中复制第一个存在的系统字体到 fixture 目录。
 *
 * @param candidates 系统字体绝对路径候选。
 * @param destinationName fixture 文件名。
 * @returns fixture 路径；全部缺失时返回 null。
 */
function copySystemFont(candidates: readonly string[], destinationName: string): string | null {
  const destination = join(FONT_FIXTURE_DIR, destinationName);
  if (existsSync(destination)) return destination;
  const source = candidates.find((candidate) => existsSync(candidate));
  if (!source) return null;
  ensureDir(FONT_FIXTURE_DIR);
  copyFileSync(source, destination);
  return destination;
}

/**
 * 从真实 OFD 样本解压一个条目到 fixture 目录。
 *
 * @param ofdName `ofd_pdf_match/` 下的文件名。
 * @param entry ZIP 条目路径。
 * @param destinationName fixture 文件名。
 * @returns fixture 路径；样本/条目缺失或解压失败时返回 null。
 */
function extractFromOfd(ofdName: string, entry: string, destinationName: string): string | null {
  const destination = join(FONT_FIXTURE_DIR, destinationName);
  if (existsSync(destination)) return destination;
  const ofdPath = join(REPO_ROOT, 'ofd_pdf_match', ofdName);
  if (!existsSync(ofdPath)) return null;
  try {
    const files = unzipSync(new Uint8Array(readFileSync(ofdPath)));
    const data = files[entry];
    if (!data) return null;
    ensureDir(FONT_FIXTURE_DIR);
    writeFileSync(destination, data);
    return destination;
  } catch {
    return null;
  }
}

/**
 * 准备全部 fixture；可重复调用。
 *
 * @returns 每个 fixture 的绝对路径或 null。
 */
export function ensureFixtures(): FontFixtures {
  ensureDir(FONT_FIXTURE_DIR);
  ensureDir(ARTIFACT_DIR);
  return {
    dejavu: copySystemFont(SYSTEM_FONTS.dejavu, 'DejaVuSans.ttf'),
    dejavuBold: copySystemFont(SYSTEM_FONTS.dejavuBold, 'DejaVuSans-Bold.ttf'),
    dejavuOblique: copySystemFont(SYSTEM_FONTS.dejavuOblique, 'DejaVuSans-Oblique.ttf'),
    cjkTtf: copySystemFont(SYSTEM_FONTS.cjkTtf, 'DroidSansFallbackFull.ttf'),
    notoTtc: copySystemFont(SYSTEM_FONTS.notoTtc, 'NotoSerifCJK-Bold.ttc'),
    nimbusRoman: copySystemFont(SYSTEM_FONTS.nimbusRoman, 'NimbusRoman-Regular.otf'),
    cffOtf: (() => {
      const source = join(
        REPO_ROOT,
        'references/ofdrw/ofdrw-layout/src/test/resources/NotoSerifCJKsc-Regular.otf',
      );
      if (!existsSync(source)) return null;
      const destination = join(FONT_FIXTURE_DIR, 'NotoSerifCJKsc-Regular.otf');
      if (!existsSync(destination)) copyFileSync(source, destination);
      return destination;
    })(),
    stripped: extractFromOfd('doc1File.ofd', 'Doc_1/Res/font_1.otf', 'stripped-nocmap.otf'),
    broken: extractFromOfd('intro-数科.ofd', 'Doc_0/Res/font_85_85.ttf', 'broken.ttf'),
    embeddedCjk: extractFromOfd('ano.ofd', 'Doc_0/Res/font_91_91.ttf', 'simsun-extracted.ttf'),
  };
}

/**
 * 读取 fixture 字节。
 *
 * @param path fixture 路径。
 * @returns 字体字节。
 */
export function readFixture(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}