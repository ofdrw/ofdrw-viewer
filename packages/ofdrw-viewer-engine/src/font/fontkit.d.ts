/**
 * `fontkit` 2.0.4 的最小类型声明。
 *
 * 上游包只发布 JS、不带 `.d.ts`；字体层只使用本文件列出的成员，
 * 其余 fontkit 能力（layout/subset/变体）不进入 v1 契约。
 */
declare module 'fontkit' {
  /** fontkit 路径命令；`args` 的含义随 `command` 变化。 */
  interface FontkitPathCommand {
    command: string;
    args: number[];
  }

  /** fontkit 字形轮廓。 */
  interface FontkitPath {
    commands: FontkitPathCommand[];
  }

  /** fontkit 字形；坐标单位为字体单位、y 向上。 */
  interface FontkitGlyph {
    id: number;
    advanceWidth: number;
    path: FontkitPath;
    bbox?: {
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
    };
  }

  /** fontkit 字体面；TTC 的每个面也具有相同形状。 */
  interface FontkitFont {
    familyName?: string;
    postscriptName?: string;
    fullName?: string;
    unitsPerEm: number;
    numGlyphs: number;
    /** 字体有 cmap 时为真；剥离子集可能为 undefined。 */
    cmap?: unknown;
    'OS/2'?: { usWeightClass?: number };
    head?: { macStyle?: { bold?: boolean; italic?: boolean } };
    post?: { italicAngle?: number };
    /** 仅字体集合（TTC）存在。 */
    fonts?: FontkitFont[];
    /**
     * 按字形 ID 取字形。
     *
     * @param glyphId 字形 ID。
     * @returns fontkit 字形。
     */
    getGlyph(glyphId: number): FontkitGlyph;
    /**
     * 按 Unicode 码点取字形；无 cmap 时可能抛错。
     *
     * @param codePoint Unicode 码点。
     * @returns fontkit 字形。
     */
    glyphForCodePoint(codePoint: number): FontkitGlyph;
  }

  /**
   * 解析字体字节。
   *
   * @param buffer 字体文件字节；Node Buffer 也是 Uint8Array。
   * @param postscriptName 可选，用于从 TTC 中直接选择字体面。
   * @returns 单字体或字体集合。
   */
  export function create(
    buffer: Uint8Array | ArrayBuffer,
    postscriptName?: string,
  ): FontkitFont;

  /** 默认导出与命名导出一致。 */
  const fontkit: { create: typeof create };
  export default fontkit;
}