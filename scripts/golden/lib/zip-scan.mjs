/**
 * ZIP 元信息扫描（脚本侧，生成样本清单用）。
 *
 * 与测试侧 `zip-inspector.ts` 独立实现，只读取中央目录并按需解压 XML；
 * 不依赖引擎源码，保证样本清单可在引擎完成前生成。
 */

import { inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;

/**
 * 列出 ZIP 条目（不解压数据）。
 *
 * @param buffer ZIP 内容。
 * @returns 条目元信息数组。
 */
export function listEntries(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const eocd = findEocd(view);
  let count = view.getUint16(eocd + 10, true);
  let centralOffset = view.getUint32(eocd + 16, true);

  if (count === 0xffff || centralOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator >= 0 && view.getUint32(locator, true) === ZIP64_LOCATOR_SIGNATURE) {
      const zip64Offset = Number(view.getBigUint64(locator + 8, true));
      if (view.getUint32(zip64Offset, true) !== ZIP64_EOCD_SIGNATURE) {
        throw new Error('ZIP64 EOCD 签名错误');
      }
      count = Number(view.getBigUint64(zip64Offset + 32, true));
      centralOffset = Number(view.getBigUint64(zip64Offset + 48, true));
    }
  }

  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new Error(`ZIP 中央目录签名错误 @ ${cursor}`);
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    let compressedSize = view.getUint32(cursor + 20, true);
    let uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    let localOffset = view.getUint32(cursor + 42, true);
    const nameStart = cursor + 46;
    const extraStart = nameStart + nameLength;
    const commentStart = extraStart + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');

    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      let field = extraStart;
      while (field + 4 <= commentStart) {
        const id = view.getUint16(field, true);
        const size = view.getUint16(field + 2, true);
        if (id === 0x0001) {
          let offset = field + 4;
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = Number(view.getBigUint64(offset, true));
            offset += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(view.getBigUint64(offset, true));
            offset += 8;
          }
          if (localOffset === 0xffffffff) {
            localOffset = Number(view.getBigUint64(offset, true));
          }
          break;
        }
        field += 4 + size;
      }
    }

    entries.push({ name, flags, method, compressedSize, uncompressedSize, localOffset });
    cursor = commentStart + commentLength;
  }
  return entries;
}

/**
 * 读取单个条目内容（stored/deflate）。
 *
 * @param buffer ZIP 内容。
 * @param name 条目名。
 * @returns 解压后的 Buffer；不存在时为 null。
 */
export function readEntry(buffer, name) {
  const entry = listEntries(buffer).find((item) => item.name === name);
  if (!entry) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(entry.localOffset, true) !== LOCAL_SIGNATURE) {
    throw new Error(`ZIP 本地头签名错误：${name}`);
  }
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const payload = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return payload;
  if (entry.method === 8) return inflateRawSync(payload);
  throw new Error(`不支持的压缩方式 ${entry.method}：${name}`);
}

/**
 * 扫描 OFD 包，统计字体/图片/JBIG2 条目。
 *
 * @param ofdPath OFD 路径。
 * @returns 条目名与分类计数。
 */
export function scanOfdPackage(ofdPath) {
  const buffer = readFileSync(ofdPath);
  const entries = listEntries(buffer);
  const names = entries.map((entry) => entry.name);
  const fontEntries = names.filter((name) => /\.(ttf|otf|ttc|cff)$/i.test(name)).length;
  const imageEntries = names.filter((name) => /\.(png|jpe?g|jbig2?|jb2|tiff?|bmp|gif|webp)$/i.test(name)).length;
  const jb2Entries = names.filter((name) => /\.(jbig2|jb2)$/i.test(name)).length;
  const documentEntry = names.find((name) => /(^|\/)Document\.xml$/i.test(name));
  let ofdPages = null;
  if (documentEntry) {
    const xml = readEntry(buffer, documentEntry).toString('utf8');
    // 只统计 Page 元素，排除 PageArea/Pages 容器。
    const matches = xml.match(/<(?:[A-Za-z_][\w.-]*:)?Page[\s>]/g);
    ofdPages = matches ? matches.length : null;
  }
  return { names, fontEntries, imageEntries, jb2Entries, ofdPages };
}

function findEocd(view) {
  const length = view.byteLength;
  const min = Math.max(0, length - 22 - 0xffff);
  for (let offset = length - 22; offset >= min; offset -= 1) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
    if (offset + 22 + view.getUint16(offset + 20, true) === length) return offset;
  }
  throw new Error('ZIP 缺少 EOCD');
}