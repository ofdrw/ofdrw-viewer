#!/usr/bin/env node
/**
 * Node.js 版 OFD 逐页渲染示例。
 *
 * 用 `@napi-rs/canvas` 提供 Canvas、图片解码与 PNG 编码，用
 * `@ofdrw/ofdrw-viewer-engine` 解析 OFD，并把每一页导出为 PNG 文件。
 *
 * 用法：node render.mjs [input.ofd] [outDir] [dpi] [--font <字体路径>]
 */

import { Buffer } from 'node:buffer';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { OFDDocument, isOFDError } from '@ofdrw/ofdrw-viewer-engine';

/** 默认输入文件；基于本模块位置定位，不依赖当前工作目录。 */
const DEFAULT_INPUT = fileURLToPath(new URL('./samples/doc1File.ofd', import.meta.url));

/** 默认输出目录；相对当前工作目录。 */
const DEFAULT_OUT_DIR = 'out';

/** 默认输出精度，单位 DPI。 */
const DEFAULT_DPI = 144;

/** 命令帮助文本。 */
const USAGE = `用法：node render.mjs [input.ofd] [outDir] [dpi] [--font <字体路径>]

  input.ofd   输入 OFD 文件，默认 samples/doc1File.ofd
  outDir      输出目录，默认 out（相对当前工作目录）
  dpi         输出精度，单位 DPI，必须大于 0，默认 ${DEFAULT_DPI}
  --font      补充中文字体文件（TTF/OTF/TTC）；引擎不内置 CJK 字体

示例：
  node render.mjs samples/dense-text-perf.ofd out 300
  node render.mjs samples/doc1File.ofd out 144 --font /path/to/NotoSansSC-Regular.otf`;

/**
 * 创建单个格式的图片解码插件。
 *
 * @param {'png' | 'jpeg' | 'webp'} format 图片格式，小写
 * @returns {import('@ofdrw/ofdrw-viewer-engine').ImageDecoderPlugin} 引擎图片解码插件
 */
function createImageDecoder(format) {
  return {
    format,
    async decode(bytes) {
      const image = await loadImage(Buffer.from(bytes));
      return {
        width: image.width,
        height: image.height,
        data: image,
        kind: 'source',
      };
    },
  };
}

/** PNG/JPEG/WebP 解码插件；Node 没有浏览器原生图片解码，交给 @napi-rs/canvas。 */
const imageDecoders = ['png', 'jpeg', 'webp'].map((format) => createImageDecoder(format));

/**
 * 把整页画布编码为图片字节。
 *
 * @param {import('@ofdrw/ofdrw-viewer-engine').Canvas2DLike} canvas 已绘制整页的画布
 * @param {'png' | 'jpeg' | 'webp'} format 输出格式
 * @param {number} quality 编码质量，范围 0..1；PNG 忽略该参数
 * @returns {Promise<Uint8Array>} 编码后的图片字节
 */
async function encodeImage(canvas, format, quality) {
  if (format === 'jpeg') return canvas.toBuffer('image/jpeg', quality);
  if (format === 'webp') return canvas.toBuffer('image/webp', quality);
  return canvas.toBuffer('image/png');
}

/**
 * 读取补充字体字节，供引擎 `OFDOpenOptions.loadInput` 回调使用。
 *
 * @param {import('@ofdrw/ofdrw-viewer-engine').FontInput} input 字体来源
 * @returns {Promise<Uint8Array>} 字体文件字节
 */
async function loadFontBytes(input) {
  if ('data' in input) return input.data;
  if ('url' in input) {
    const response = await fetch(input.url);
    if (!response.ok) throw new Error(`字体下载失败：HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  const path = 'path' in input ? input.path : input.filePath;
  return new Uint8Array(await readFile(path));
}

/**
 * 解析 DPI 参数。
 *
 * @param {string} value 命令行传入的 DPI 文本
 * @returns {number} 大于 0 的 DPI
 * @throws {Error} 不是有限数字或不大于 0 时抛出
 */
function parseDpi(value) {
  const dpi = Number(value);
  if (!Number.isFinite(dpi) || dpi <= 0) {
    throw new Error(`DPI 必须是大于 0 的数字，收到：${value}`);
  }
  return dpi;
}

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv 不含 node 与脚本路径的参数
 * @returns {{ input?: string, outDir?: string, dpi: number, fontPath?: string }} 解析结果；
 *   `input`/`outDir` 未提供时为 `undefined`，`dpi` 单位为 DPI
 * @throws {Error} 参数缺失、未知或非法时抛出
 */
function parseArgs(argv) {
  const positional = [];
  let fontPath;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === '--font') {
      fontPath = argv[index + 1];
      if (fontPath === undefined || fontPath === '') {
        throw new Error('--font 缺少字体文件路径');
      }
      index += 1;
    } else if (arg.startsWith('-')) {
      throw new Error(`未知参数：${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 3) {
    throw new Error(`位置参数过多：${positional.join(' ')}`);
  }

  return {
    input: positional[0],
    outDir: positional[1],
    dpi: positional[2] === undefined ? DEFAULT_DPI : parseDpi(positional[2]),
    fontPath,
  };
}

/**
 * 读取错误信息文本。
 *
 * @param {unknown} error 任意错误值
 * @returns {string} 错误信息
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 打开 OFD，逐页导出 PNG 到输出目录。
 *
 * @returns {Promise<void>}
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = resolve(options.input ?? DEFAULT_INPUT);
  const outDir = resolve(options.outDir ?? DEFAULT_OUT_DIR);
  const fontPath = options.fontPath === undefined ? undefined : resolve(options.fontPath);

  const inputStat = await stat(inputPath).catch(() => undefined);
  if (inputStat === undefined || !inputStat.isFile()) {
    throw new Error(`输入文件不存在或不是普通文件：${inputPath}`);
  }
  if (fontPath !== undefined) {
    const fontStat = await stat(fontPath).catch(() => undefined);
    if (fontStat === undefined || !fontStat.isFile()) {
      throw new Error(`字体文件不存在或不是普通文件：${fontPath}`);
    }
  }

  try {
    await mkdir(outDir, { recursive: true });
  } catch (error) {
    throw new Error(`无法创建输出目录 ${outDir}：${messageOf(error)}`, { cause: error });
  }

  let data;
  try {
    const fileBytes = await readFile(inputPath);
    data = fileBytes.buffer.slice(
      fileBytes.byteOffset,
      fileBytes.byteOffset + fileBytes.byteLength,
    );
  } catch (error) {
    throw new Error(`无法读取输入文件 ${inputPath}：${messageOf(error)}`, { cause: error });
  }

  console.log(`输入：${inputPath}`);
  console.log(`输出目录：${outDir}`);
  console.log(`DPI：${options.dpi}`);
  if (fontPath !== undefined) console.log(`补充字体：${fontPath}`);

  let doc;
  try {
    const openOptions = {
      source: { kind: 'arraybuffer', data },
      createCanvas: (width, height) => createCanvas(width, height),
      encodeImage,
      imageDecoders,
      onWarning: (warning) => {
        const page = warning.pageIndex === undefined ? '' : `（第 ${warning.pageIndex + 1} 页）`;
        console.warn(`[${warning.code}]${page} ${warning.message}`);
      },
    };
    if (fontPath !== undefined) {
      openOptions.supplementaryFonts = [{ path: fontPath }];
      openOptions.loadInput = loadFontBytes;
    }

    doc = await OFDDocument.open(openOptions);

    if (doc.pageCount === 0) {
      console.log('文档没有页面，未导出任何文件。');
      return;
    }
    console.log(`页数：${doc.pageCount}`);

    for (let index = 0; index < doc.pageCount; index += 1) {
      const pageNumber = index + 1;
      const page = await doc.getPage(index);
      const result = await page.exportImage({ dpi: options.dpi });
      const outputPath = join(outDir, `page-${pageNumber}.png`);

      await writeFile(outputPath, result.data);
      console.log(
        `第 ${pageNumber}/${doc.pageCount} 页：${result.width}×${result.height} px @ ${result.dpi} DPI -> ${outputPath}`,
      );
    }
  } finally {
    if (doc !== undefined) await doc.close();
  }
}

main().catch((error) => {
  if (isOFDError(error)) {
    console.error(`OFD 错误 [${error.code}]：${error.message}`);
    if (error.cause !== undefined) console.error(`原因：${messageOf(error.cause)}`);
  } else {
    console.error(`错误：${messageOf(error)}`);
  }
  process.exitCode = 1;
});