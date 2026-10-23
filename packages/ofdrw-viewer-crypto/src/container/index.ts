/**
 * 明文容器（I-DEC）。
 *
 * `openDecryptingContainer` 返回本目录的 `MemoryVirtualContainer`，engine 只
 * 能看到明文路径与明文字节；加密元数据在解密时已过滤。
 */

export { MemoryVirtualContainer } from './memory-container';
export type { MemoryEntryOrigin } from './memory-container';
export {
  dirnameVirtualPath,
  normalizeVirtualPath,
  resolveVirtualPath,
} from './paths';
