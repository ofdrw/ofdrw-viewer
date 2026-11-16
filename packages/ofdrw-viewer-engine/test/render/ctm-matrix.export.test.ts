/**
 * 导出 CTM / Boundary / Clips 渲染对照图，供人工确认。
 *
 * 设置环境变量 `CTM_MATRIX_OUT` 可指定输出路径；缺省写到 `.tmp/ctm-matrix/ctm-matrix.png`。
 */

import { resolve } from 'node:path';
import { describe, it } from 'vitest';
import { renderMatrixImage } from './ctm-matrix.image';

describe('CTM 渲染对照图', () => {
  it('导出对照图', async () => {
    const output = process.env.CTM_MATRIX_OUT
      ? resolve(process.env.CTM_MATRIX_OUT)
      : resolve(__dirname, '../../.tmp/ctm-matrix/ctm-matrix.png');
    await renderMatrixImage(output);
    console.log(`已导出对照图: ${output}`);
  }, 600_000);
});
