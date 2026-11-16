/**
 * 生成 `ofd_pdf_match/ctm-matrix.ofd` 样例文档。
 *
 * 该样例与 `ctm-text.test.ts` 的契约用例同源，用于与人工制作的 PDF 参考件逐格比对。
 * 设置环境变量 `CTM_SAMPLE_OUT` 可指定输出路径。
 */

import { resolve } from 'node:path';
import { describe, it } from 'vitest';
import { writeCtmMatrixOfd } from './ctm-sample.builder';

describe('CTM 样例文档', () => {
  it('导出 ofd_pdf_match/ctm-matrix.ofd', () => {
    const output = process.env.CTM_SAMPLE_OUT
      ? resolve(process.env.CTM_SAMPLE_OUT)
      : resolve(__dirname, '../../../../ofd_pdf_match/ctm-matrix.ofd');
    const size = writeCtmMatrixOfd(output);
    console.log(`已导出样例: ${output} (${(size / 1024).toFixed(0)} KB)`);
  });
});
