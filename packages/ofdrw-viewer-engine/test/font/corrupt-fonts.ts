/**
 * 真正损坏的字体字节构造器。
 *
 * 历史教训：早先用于"必须解析失败"断言的 `font_85_85.ttf` 其实是一份合法的
 * CID-keyed 裸 CFF（`FXBMIR+HiraginoSansGB-W6`，14 字形），并非损坏文件。
 * 因此这里改用**内联构造**的字节：坏法明确写在代码里，不依赖任何外部样本，
 * 也不会因为适配器能力增强而悄悄变成"可解析"。
 *
 * 每个样本都同时满足：
 * 1. 不具备任何合法字体容器签名（sfnt `OTTO`/`true`/`0x00010000`、`ttcf`、`wOFF`、`wOF2`）；
 * 2. 不具备裸 CFF 头部特征（首字节为 CFF major=1、hdrSize=4、offSize∈[1,4]）。
 */

/**
 * 构造一份在所有解析路径上都必然失败的字节。
 *
 * @returns 12 字节，签名 `04 00 00 00`，既非 sfnt 也非 CFF。
 */
export function corruptUnknownSignature(): Uint8Array {
  return new Uint8Array([0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

/**
 * 构造一份 sfnt 表目录声明的表数量远超实际长度的字节。
 *
 * 签名是合法的 `true`（Apple TrueType），但 numTables=0xFFFF 而文件仅 12 字节，
 * 表目录越界，无法解析出任何字体面。
 *
 * @returns 12 字节。
 */
export function corruptSfntTableDirectory(): Uint8Array {
  const bytes = new Uint8Array(12);
  bytes.set([0x74, 0x72, 0x75, 0x65]); // 'true'
  bytes.set([0xff, 0xff], 4); // numTables = 65535
  return bytes;
}
