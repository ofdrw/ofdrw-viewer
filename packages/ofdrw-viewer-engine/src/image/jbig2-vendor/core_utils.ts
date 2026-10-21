/**
 * pdf.js JBIG2 字节读取工具（Apache-2.0）。
 *
 * 仅保留 JBIG2 解码需要的函数，移除 PDF 文档对象相关工具。
 */

/**
 * 向上取整的以 2 为底对数；非正数返回 0。
 *
 * @param x 输入数值。
 * @returns 位宽。
 */
export function log2(x: number): number {
  if (x <= 0) return 0;
  return Math.ceil(Math.log2(x));
}

/**
 * 读取有符号 8 位整数。
 *
 * @param data 字节。
 * @param offset 偏移，byte。
 * @returns 数值。
 */
export function readInt8(data: Uint8Array, offset: number): number {
  return (data[offset]! << 24) >> 24;
}

/**
 * 读取无符号 16 位大端整数。
 *
 * @param data 字节。
 * @param offset 偏移，byte。
 * @returns 数值。
 */
export function readUint16(data: Uint8Array, offset: number): number {
  return (data[offset]! << 8) | data[offset + 1]!;
}

/**
 * 读取无符号 32 位大端整数。
 *
 * @param data 字节。
 * @param offset 偏移，byte。
 * @returns 数值。
 */
export function readUint32(data: Uint8Array, offset: number): number {
  return (
    ((data[offset]! << 24) |
      (data[offset + 1]! << 16) |
      (data[offset + 2]! << 8) |
      data[offset + 3]!) >>>
    0
  );
}
