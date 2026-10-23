/**
 * 文档字节来源（平台无关定义）。
 *
 * 放在 platform 层是为了让 `platform/virtual-container.ts` 的容器工厂无需反向
 * 引用 `api/types`；`api/types.ts` 重新导出本类型，公共 API 路径保持不变。
 */

import type { ByteSource } from './byte-source';

/** 文档字节来源；Node/微信来源本轮只保留类型，Web 实现 arraybuffer/blob/url/custom。 */
export type OFDSource =
  | { kind: 'arraybuffer'; data: ArrayBuffer | Uint8Array }
  | { kind: 'blob'; blob: Blob }
  | { kind: 'url'; url: string; headers?: Record<string, string> }
  | { kind: 'node-file'; path: string }
  | { kind: 'wechat-file'; filePath: string }
  | { kind: 'custom'; source: ByteSource };