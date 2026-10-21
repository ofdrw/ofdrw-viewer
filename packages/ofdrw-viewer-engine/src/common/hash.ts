/**
 * 非加密内容哈希工具。
 *
 * 用于缓存键/内容指纹，不用于安全校验。算法为 FNV-1a 64 位，输出 16 位小写十六进制。
 */

/** FNV-1a 64 位偏移基。 */
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
/** FNV-1a 64 位质数。 */
const FNV_PRIME = 0x100000001b3n;
/** 64 位掩码。 */
const MASK_64 = 0xffffffffffffffffn;

/**
 * 计算字节串哈希。
 *
 * @param data 输入字节。
 * @returns 16 位小写十六进制哈希。
 */
export function hashBytes(data: Uint8Array): string {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < data.length; index += 1) {
    hash ^= BigInt(data[index] as number);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * 计算 UTF-8 字符串哈希。
 *
 * @param text 输入字符串。
 * @returns 16 位小写十六进制哈希。
 */
export function hashString(text: string): string {
  return hashBytes(new TextEncoder().encode(text));
}

/**
 * 把多个简单值拼接后哈希；用于缓存键（资源 ID、尺寸、样式哈希等）。
 *
 * @param parts 参与哈希的值；`undefined`/`null` 统一编码为空标记。
 * @returns 16 位小写十六进制哈希。
 */
export function hashParts(parts: readonly (string | number | boolean | undefined | null)[]): string {
  const text = parts
    .map((part) => (part === undefined || part === null ? '\u0000' : String(part)))
    .join('\u0001');
  return hashString(text);
}