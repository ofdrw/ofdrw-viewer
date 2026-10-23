/**
 * crypto 包支持的输入来源。
 *
 * Node 文件优先注入 `byte-source`：crypto 通过 engine 的 `ByteSource` 按需
 * 读取 ZIP 条目，不把整包读入内存；`arraybuffer`/`blob`/`url` 保持兼容。
 * crypto 自身不 import `node:*`。
 */
import type { ByteSource } from '@ofdrw/ofdrw-viewer-engine';

export type CryptoSource =
  | {
      /** 内存字节；返回的视图归调用方所有。 */
      readonly kind: 'arraybuffer';
      readonly data: ArrayBuffer | Uint8Array;
    }
  | {
      /** 浏览器 Blob/File；由 engine 的 BlobSource 按区间读取。 */
      readonly kind: 'blob';
      readonly blob: Blob;
    }
  | {
      /** 远程地址；使用 `fetch` 读取，受 `maxSourceBytes` 限制。 */
      readonly kind: 'url';
      readonly url: string;
      readonly headers?: Record<string, string>;
    }
  | {
      /**
       * 随机访问字节源；调用方拥有并负责关闭（若有 close），crypto 只读。
       */
      readonly kind: 'byte-source';
      readonly source: ByteSource;
    };
