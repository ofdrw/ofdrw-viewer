/**
 * 多页 ZIP 打包（设计方案 §10.5）。
 *
 * PNG/JPEG/WebP 自身已压缩，ZIP 使用 store 模式（level 0）避免二次压缩；
 * `fflate` 按需动态 import，不进入首屏依赖。
 */

/** ZIP 条目。 */
export interface ZipEntry {
  /** ZIP 内文件名。 */
  readonly name: string;
  /** 文件字节。 */
  readonly data: Uint8Array;
}

/**
 * 创建 store 模式的 ZIP。
 *
 * @param entries ZIP 条目；名称必须唯一（调用方负责去重）。
 * @returns ZIP Blob。
 */
export async function createStoreZip(entries: readonly ZipEntry[]): Promise<Blob> {
  const { zipSync } = await import('fflate');
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) files[entry.name] = entry.data;
  const zipped = zipSync(files, { level: 0 });
  return new Blob([zipped as unknown as BlobPart], { type: 'application/zip' });
}