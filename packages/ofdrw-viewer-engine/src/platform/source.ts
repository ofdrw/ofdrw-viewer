/**
 * 文档字节来源（平台无关定义）。
 *
 * 放在 platform 层是为了让 `platform/virtual-container.ts` 的容器工厂无需反向
 * 引用 `api/types`；`api/types.ts` 重新导出本类型，公共 API 路径保持不变。
 *
 * engine 只接受字节数组、Blob 或宿主随机读源，不负责网络/文件读取；URL 与本地
 * 文件由宿主读取后转成 `arraybuffer`/`blob`，或实现 `custom` ByteSource。
 */

import type { ByteSource } from './byte-source';

/** 文档字节来源；engine 不发起网络请求或文件读取。 */
export type OFDSource =
  | { kind: 'arraybuffer'; data: ArrayBuffer | Uint8Array }
  | { kind: 'blob'; blob: Blob }
  | { kind: 'custom'; source: ByteSource };