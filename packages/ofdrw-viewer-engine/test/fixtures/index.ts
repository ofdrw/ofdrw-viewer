/**
 * 测试 fixture 公共入口。
 *
 * 生成器与校验器均为测试专用代码，不进入引擎运行时；所有数据均为合成/脱敏内容。
 */

export { createZip, crc32 } from './zip-builder';
export type {
  CreateZipOptions,
  ZipBuildResult,
  ZipCompressionMethod,
  ZipEntryInput,
} from './zip-builder';
export { readZipEntries } from './zip-inspector';
export type { ParsedZipEntry, ReadZipOptions } from './zip-inspector';
export { buildXmlDocument, buildXmlElement, escapeXml } from './xml';
export type { XmlElementSpec } from './xml';
export { buildMinimalOfd, OFD_NAMESPACE } from './ofd-builder';
export type { FixtureFont, MinimalOfdOptions, MinimalOfdResult } from './ofd-builder';
export { COLOR_CASES, MATRIX_CASES, PAPER_SIZES_MM } from './matrix-color';
export type { ColorCase, MatrixCase } from './matrix-color';
export { findSystemCjkFont, loadEmbeddedFontFromOfd } from './fonts';
export type { FontFixture } from './fonts';