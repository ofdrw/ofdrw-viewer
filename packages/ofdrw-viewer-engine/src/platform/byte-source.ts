/**
 * 平台字节源接口。
 *
 * 引擎只通过该接口按需读取 ZIP 区间；具体文件/Blob/HTTP 适配由宿主或 container 层实现。
 */

/** 随机可读的字节源；读取失败时应抛 OFDError。 */
export interface ByteSource {
  /** 总字节数，单位 byte。 */
  readonly size: number;
  /**
   * 读取 `[offset, offset + length)` 的字节；越界由实现截断或抛错。
   *
   * @param offset 起始偏移，单位 byte。
   * @param length 读取长度，单位 byte。
   * @returns 读取到的字节。
   */
  read(offset: number, length: number): Promise<Uint8Array>;
}