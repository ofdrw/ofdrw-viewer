/**
 * 最小单页 PDF 生成器（harness 自检专用）。
 *
 * 只支持一个页面与一段内容流，用于验证 pdftoppm 参考渲染链路，
 * 不依赖业务 PDF 原件。PDF 坐标系原点在左下，调用方负责 y 翻转。
 */

/** 最小 PDF 选项。 */
export interface MinimalPdfOptions {
  /** 页宽，pt。 */
  widthPt: number;
  /** 页高，pt。 */
  heightPt: number;
  /** 内容流（PDF 操作符，ASCII）。 */
  content: string;
  /** 文档标题（写入 Info，可选）。 */
  title?: string;
}

/**
 * 构造最小单页 PDF。
 *
 * @param options 页面尺寸与内容流。
 * @returns PDF 字节（ASCII）。
 */
export function buildMinimalPdf(options: MinimalPdfOptions): Uint8Array {
  const { widthPt, heightPt, content } = options;
  const encoder = new TextEncoder();
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] ` +
      '/Resources << /ProcSet [/PDF] >> /Contents 4 0 R >>',
    `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`,
  ];

  const header = '%PDF-1.4\n';
  let body = '';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(encoder.encode(header + body).length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = encoder.encode(header + body).length;
  const xrefLines = offsets
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  const trailer =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xrefLines}` +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(header + body + trailer);
}