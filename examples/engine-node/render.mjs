#!/usr/bin/env node
/**
 * Node.js 版 OFD 逐页导出示例。
 *
 * 用 @napi-rs/canvas 提供 Canvas 和图片解码，用引擎把每一页导出为 PNG。
 * 用法：node render.mjs [input.ofd] [outDir]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';

/** 默认输入：11 页、内嵌字体的样例。 */
const DEFAULT_INPUT = fileURLToPath(new URL('./samples/doc1File.ofd', import.meta.url));
/** 默认输出目录。 */
const DEFAULT_OUT_DIR = 'out';
/** 输出精度，单位 DPI。 */
const DPI = 144;

/**
 * 创建图片解码插件，供引擎读取 OFD 内嵌的 PNG/JPEG 图片。
 *
 * @param {'png' | 'jpeg'} format 图片格式。
 * @returns {import('@ofdrw/ofdrw-viewer-engine').ImageDecoderPlugin} 解码插件。
 */
function createDecoder(format) {
  return {
    format,
    async decode(bytes) {
      const image = await loadImage(Buffer.from(bytes));
      return { width: image.width, height: image.height, data: image, kind: 'source' };
    },
  };
}

/** 从命令行读取输入文件与输出目录。 */
const inputPath = resolve(process.argv[2] ?? DEFAULT_INPUT);
const outDir = resolve(process.argv[3] ?? DEFAULT_OUT_DIR);

const file = await readFile(inputPath);
const data = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);

const doc = await OFDDocument.open({
  source: { kind: 'arraybuffer', data },
  createCanvas,
  imageDecoders: [createDecoder('png'), createDecoder('jpeg')],
  // 导出图片时由宿主负责编码；这里统一用 PNG。
  encodeImage: (canvas) => canvas.toBuffer('image/png'),
  onWarning: (warning) => console.warn(`[${warning.code}] ${warning.message}`),
});

try {
  await mkdir(outDir, { recursive: true });

  for (let index = 0; index < doc.pageCount; index += 1) {
    const result = await (await doc.getPage(index)).exportImage({ dpi: DPI });
    const outputPath = join(outDir, `page-${index + 1}.png`);
    await writeFile(outputPath, result.data);
    console.log(`第 ${index + 1}/${doc.pageCount} 页 -> ${outputPath}`);
  }

  console.log(`完成：${doc.pageCount} 页已导出到 ${outDir}`);
} finally {
  await doc.close();
}