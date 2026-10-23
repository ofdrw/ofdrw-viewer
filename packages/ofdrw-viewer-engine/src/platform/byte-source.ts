/**
 * 平台字节源接口。
 *
 * 引擎只通过该接口按需读取 ZIP 区间；具体文件/Blob/HTTP 适配由宿主或 container 层实现。
 * HTTP Range、鉴权、重试等网络策略由宿主在自定义实现中负责，engine 不内置网络访问。
 */

/** 随机可读的字节源；读取失败时应抛 OFDError。 */
export interface ByteSource {
  /** 总字节数，单位 byte；异步探测完成前允许为 0。 */
  readonly size: number;
  /**
   * 读取 `[offset, offset + length)` 的字节；越界由实现截断或抛错。
   *
   * @param offset 起始偏移，单位 byte。
   * @param length 读取长度，单位 byte。
   * @returns 读取到的字节。
   */
  read(offset: number, length: number): Promise<Uint8Array>;
  /**
   * 可选：等待异步探测完成（例如网络大小探测）；`ZipReader.open` 会先等待。
   *
   * @returns 探测完成；失败时应抛出真实错误。
   */
  ready?(): Promise<void>;
  /**
   * 可选：释放资源；容器关闭时调用，实现应幂等。
   *
   * @returns 关闭完成。
   */
  close?(): Promise<void> | void;
}