/**
 * CLI 测试用的最小 ZIP 构造器。
 *
 * 只支持 stored/deflate 两种压缩方式与普通（非 ZIP64）条目，足以生成 OFD 测试包。
 * `name` **不做任何规范化**：允许写入 `../` 与绝对路径，用于构造"恶意 MediaFile"
 * 场景，验证 CLI 的导出文件名不依赖包内原始路径。
 */

import { deflateRawSync } from 'node:zlib';

/** 单个待写入条目。 */
export interface ZipEntryInput {
  /** 包内路径；允许 `../` 等异常形态，写包时原样保留。 */
  name: string;
  /** 条目内容；字符串按 UTF-8 编码。 */
  data: Uint8Array | string;
  /** 压缩方式，默认 deflate。 */
  method?: 'store' | 'deflate';
}

/** CRC-32 查表。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * 计算 CRC-32。
 *
 * @param data 字节
 * @returns 无符号 32 位 CRC
 */
function crc32(data: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

/**
 * 生成 ZIP 归档字节。
 *
 * 文件名统一按 UTF-8 编码并设置通用标志位 bit 11，避免中文条目名乱码。
 *
 * @param entries 待写入条目，按顺序写入
 * @returns 完整 ZIP 字节
 */
export function createZip(entries: readonly ZipEntryInput[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const raw = typeof entry.data === 'string' ? new TextEncoder().encode(entry.data) : entry.data;
    const deflate = entry.method !== 'store';
    const payload = deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
    const method = deflate ? 8 : 0;
    const crc = crc32(raw);

    const local = new Uint8Array(30 + nameBytes.length + payload.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04_03_4b_50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x08_00, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, payload.length, true);
    localView.setUint32(22, raw.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(payload, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02_01_4b_50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x08_00, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, payload.length, true);
    centralView.setUint32(24, raw.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06_05_4b_50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, eocd];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}