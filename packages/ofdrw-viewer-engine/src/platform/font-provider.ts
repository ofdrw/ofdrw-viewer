/**
 * 宿主字体提供接口。
 *
 * Engine 不内置任何 CJK 字体；字体来源为内嵌 FontFile、FontProvider、defaultFonts 与 supplementaryFonts。
 * Provider 只负责找到字体字节/URL/路径，解析仍由 fontkit 完成。
 */

/** 宿主可提供的字体来源；`family` 用于诊断与别名匹配。 */
export type FontInput =
  | { data: ArrayBuffer | Uint8Array; family?: string }
  | { url: string; family?: string }
  | { path: string; family?: string }
  | { filePath: string; family?: string };

/** 字体匹配请求；字段直接来自 OFD Font 资源。 */
export interface FontMatchRequest {
  /** OFD FontName。 */
  fontName: string;
  /** OFD FamilyName（可选）。 */
  familyName?: string;
  /** unicode/prc/big5/symbol。 */
  charset: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  fixedSize: boolean;
}

/** 宿主字体提供者。 */
export interface FontProvider {
  /**
   * 返回匹配字体；`null` 表示没有匹配，也可返回多个候选按顺序回退。
   *
   * @param request 字体匹配请求。
   * @returns 一个/多个字体来源，或 `null`。
   */
  match(request: FontMatchRequest): Promise<FontInput | FontInput[] | null>;
}