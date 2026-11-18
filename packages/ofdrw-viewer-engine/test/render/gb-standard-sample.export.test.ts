/**
 * 生成标准条款媒体样例 `ofd_pdf_match/gb-12-media.ofd`。
 *
 * 该样例是 engine / UI / CLI 三包共用的回归夹具（视频图元 + 音频图元各挂 CLICK 动作），
 * 由本测试按需重新生成。样例本身**不入库**，干净检出时依赖它的用例会自动跳过。
 *
 * 生成需要外部音视频源文件：设置 `GB_VIDEO_PATH`（MP4）与 `GB_AUDIO_PATH`（MP3），
 * 静态帧取视频同目录下的 `frame.png`。未设置时本测试不产出任何文件。
 *
 * 设置 `GB_SAMPLE_OUT_DIR` 可改用其它输出目录。
 */

import { resolve } from 'node:path';
import { describe, it } from 'vitest';
import { writeMediaSample } from './gb-media-sample.builder';

/** 仓库根下的样本目录。 */
const OUTPUT_DIR = process.env.GB_SAMPLE_OUT_DIR
  ? resolve(process.env.GB_SAMPLE_OUT_DIR)
  : resolve(__dirname, '../../../../ofd_pdf_match');

describe('GB/T 33190—2016 条款样例', () => {
  it('导出 gb-12-media.ofd', () => {
    const videoPath = process.env.GB_VIDEO_PATH;
    const audioPath = process.env.GB_AUDIO_PATH;
    if (!videoPath || !audioPath) {
      console.warn('未同时设置 GB_VIDEO_PATH 与 GB_AUDIO_PATH，跳过媒体样例导出');
      return;
    }
    const output = resolve(OUTPUT_DIR, 'gb-12-media.ofd');
    const size = writeMediaSample(output, videoPath, audioPath);
    console.log(`已导出样例: ${output} (${(size / 1024).toFixed(0)} KB)`);
  });
});