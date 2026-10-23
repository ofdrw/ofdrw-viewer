/**
 * 逐页把 OFD 导出为 PNG。
 *
 * 用法：node render.mjs [input.ofd] [outDir]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';

/** 输入文件（默认 11 页样例）和输出目录（默认 ./out）。 */
const input = process.argv[2] ?? join(import.meta.dirname, 'samples/doc1File.ofd');
const outDir = resolve(process.argv[3] ?? 'out');

/**
 * 把 OFD 内嵌的 PNG/JPEG 解码成引擎可用的图片。
 *
 * @param {'png' | 'jpeg'} format 图片格式。
 * @returns 引擎的图片解码插件。
 */
const decodeImage = (format) => ({
  format,
  async decode(bytes) {
    const image = await loadImage(Buffer.from(bytes));
    return { width: image.width, height: image.height, data: image, kind: 'source' };
  },
});

const doc = await OFDDocument.open({
  // Buffer 本身就是 Uint8Array，可以直接作为字节来源。
  source: { kind: 'arraybuffer', data: await readFile(input) },
  createCanvas, // 页面画布由 @napi-rs/canvas 提供
  imageDecoders: [decodeImage('png'), decodeImage('jpeg')],
  encodeImage: (canvas) => canvas.toBuffer('image/png'), // 导出的图片由宿主编码
});

await mkdir(outDir, { recursive: true });

for (let i = 0; i < doc.pageCount; i += 1) {
  const { data } = await (await doc.getPage(i)).exportImage({ dpi: 144 }); // 固定 144 DPI
  const file = join(outDir, `page-${i + 1}.png`);
  await writeFile(file, data);
  console.log(`第 ${i + 1}/${doc.pageCount} 页 -> ${file}`);
}

await doc.close();
console.log(`完成：${doc.pageCount} 页已导出到 ${outDir}`);