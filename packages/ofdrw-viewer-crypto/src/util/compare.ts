/**
 * 常量时间比较工具。
 *
 * 用于签名、摘要、证书指纹等安全相关比较；普通相等判断仍可用 `===`。
 */

/**
 * 常量时间比较两个字节数组。
 *
 * 长度不同会在入口立即返回 false（长度本身不是秘密）；长度相同时
 * 始终遍历全部字节，避免按内容提前返回。
 *
 * @param a 字节数组 A。
 * @param b 字节数组 B。
 * @returns 完全相等返回 true。
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}