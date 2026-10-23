/**
 * 加密文档检测与解密（I-DEC）。
 *
 * 公共入口 `openDecryptingContainer` 返回只暴露明文的 engine
 * `VirtualContainer`；`inspect` 见包根同名导出。
 */

export { openDecryptingContainer } from './layer';
export type {
  DecryptingContainerResult,
  DecryptionLayerSummary,
  OpenDecryptingContainerOptions,
} from './layer';
