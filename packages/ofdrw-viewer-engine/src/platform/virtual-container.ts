/**
 * 引擎虚拟容器公共接口（对应设计方案 2.1）。
 *
 * `VirtualContainer` 有两种使用角色：
 * - **raw package container**：直接读取 OFD 包内的存仓字节。`encrypted=true` 时
 *   `read()` 返回的是包内存仓内容（可能是密文），只能用于检查或交给 crypto
 *   解密；不得直接传给 `OFDDocument.open`（engine 会抛 `OFD_ENCRYPTED`）。
 * - **plaintext container**：`encrypted=false`，`read()` 返回明文，可注入
 *   `OFDDocument`；crypto 解密后的内存容器属于这一类。
 *
 * 默认 ZIP 容器（`openZipVirtualContainer`）属于 raw package container；明文
 * 包同样可直接使用。engine 自身不做解密。
 */

import type { OFDSource } from './source';
import type { OFDWarning } from '../warnings';

/** 包内文件元数据；路径均为规范化包内路径，size 单位为 byte。 */
export interface VirtualFileMeta {
  /** 规范化包内路径：无前导 `/`、使用 `/`、无 `..`。 */
  readonly path: string;
  /** 解压/明文字节数，单位 byte。 */
  readonly size: number;
  /** 原始 ZIP 压缩后大小，单位 byte；合成容器可省略。 */
  readonly compressedSize?: number;
  /** ZIP 压缩方式；合成容器可省略。 */
  readonly compression?: 'stored' | 'deflate';
  /** 文件来源，供诊断；合成容器填 `decrypted`/`generated`。 */
  readonly origin?: 'package' | 'decrypted' | 'generated';
}

/** 容器读取选项；maxBytes 单位 byte。 */
export interface VirtualReadOptions {
  /** 本次读取的最大字节数，单位 byte；缺省使用容器打开时的上限。 */
  readonly maxBytes?: number;
  /**
   * 取消信号；中止时抛 `OFD_ABORTED`。
   *
   * engine 高层读取路径会透传合并后的宿主 signal；能否中断进行中的 I/O 由
   * 容器实现决定（例如 ZIP 在读取边界检查，网络容器可真正中止请求）。
   */
  readonly signal?: AbortSignal;
  /** 校验/读取 warning 回调，不中断读取。 */
  readonly onWarning?: (warning: OFDWarning) => void;
  /** 是否校验 CRC/摘要，默认 true。 */
  readonly verifyChecksum?: boolean;
}

/**
 * engine 的统一只读虚拟容器。
 *
 * 生命周期：打开/构造 → `list`/`has`/`stat`/`read` → `close()`。容器返回的
 * 字节归调用方所有；`close()` 幂等，关闭后 `read`/`list` 抛 `OFD_CLOSED`，
 * `has`/`stat` 返回 false/undefined。
 *
 * 注入 `OFDDocument` 的容器必须是明文容器（`encrypted=false` 且 `read()` 返回
 * 明文）；raw package container 只能用于检查/解密，不得直接注入。
 */
export interface VirtualContainer {
  /** 原始包字节数，单位 byte；加密包为加密源大小，解密容器保留原值。 */
  readonly packageSize: number;
  /**
   * 是否为尚未解密的加密包。
   *
   * `true` 表示 raw package container：`read()` 返回存仓原始字节（可能是密文），
   * 只能用于检查/解密；`OFDDocument.open` 会拒绝。crypto 解密容器固定为
   * `false`，且 `read()` 返回明文。
   */
  readonly encrypted: boolean;
  /** 文件元数据，按 path 升序；不含目录项。 */
  list(): readonly VirtualFileMeta[];
  /** 路径是否存在；路径先规范化。 */
  has(path: string): boolean;
  /** 读取元数据；不存在/非法路径返回 undefined。 */
  stat(path: string): VirtualFileMeta | undefined;
  /**
   * 按路径读取条目。
   *
   * 明文容器（`encrypted=false`）返回明文字节；raw package container
   * （`encrypted=true`）返回包内存仓原始字节，可能是密文。返回值归调用方所有。
   *
   * @param path 包内路径，先规范化后查找。
   * @param options 读取选项。
   * @returns 调用方拥有的条目字节；明文容器返回明文，raw package container（encrypted=true）可能返回密文。
   * @throws OFDError 条目缺失/超限/已关闭/取消时。
   */
  read(path: string, options?: VirtualReadOptions): Promise<Uint8Array>;
  /** 幂等关闭；关闭后 read/list 抛 `OFD_CLOSED`。 */
  close(): Promise<void>;
}
/**
 * 由宿主提供的容器工厂。
 *
 * `source` 的所有权转交给工厂，容器 `close()` 负责释放；工厂返回的容器所有权
 * 归 engine，打开失败或 `OFDDocument.close()` 时由 engine 关闭。
 */
export type VirtualContainerFactory = (source: OFDSource) => Promise<VirtualContainer>;
