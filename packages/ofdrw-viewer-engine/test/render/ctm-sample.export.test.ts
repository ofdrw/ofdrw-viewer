/**
 * 生成 `ofdrw-viewer-engine` 的 CTM 对照样例文档。
 *
 * 该样例与 `ctm-text.test.ts` 的契约用例同源，用于与人工制作的 PDF 参考件逐格比对。
 * 缺省写到 `.tmp/ctm-matrix/ctm-matrix.ofd`，不覆盖仓库内的参考件：
 * 样例内嵌的是完整思源宋体（约 20 MB），直接写回 `ofd_pdf_match/ctm-matrix.ofd`
 * 会把仓库里的子集字体参考件替换掉。
 *
 * 需要更新仓库参考件时，显式指定环境变量 `CTM_SAMPLE_OUT` 指向目标路径。
 */

import { resolve } from 'node:path';
import { describe, it } from 'vitest';
import { writeCtmMatrixOfd } from './ctm-sample.builder';

describe('CTM 样例文档', () => {
  it('导出 CTM 对照样例 OFD', () => {
    const output = process.env.CTM_SAMPLE_OUT
      ? resolve(process.env.CTM_SAMPLE_OUT)
      : resolve(__dirname, '../../.tmp/ctm-matrix/ctm-matrix.ofd');
    const size = writeCtmMatrixOfd(output);
    console.log(`已导出样例: ${output} (${(size / 1024).toFixed(0)} KB)`);
  });
});
