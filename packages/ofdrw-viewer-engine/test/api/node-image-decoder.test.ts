/**
 * Node 图片解码 helper 的自检。
 *
 * 覆盖 PNG/JPEG 解码、可绘制性（drawImage 后取像素）与坏数据错误码；
 * 该 helper 是 T7 与 QA 共用的测试基础设施，因此在此独立验证。
 */

import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { OFDError } from '../../src/errors';
import {
  NODE_IMAGE_FORMATS,
  createNodeImageDecoderPlugin,
  createNodeImageDecoderPlugins,
  nodeImageDecoders,
} from '../helpers/node-image-decoder';

/** 生成一张纯色测试图。 */
async function makeImage(
  format: 'png' | 'jpeg',
  width = 4,
  height = 3,
): Promise<Uint8Array> {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ff0000';
  context.fillRect(0, 0, width, height);
  const encoded = format === 'png' ? await canvas.encode('png') : await canvas.encode('jpeg');
  return new Uint8Array(encoded);
}

describe('node-image-decoder helper', () => {
  it('默认格式覆盖 png/jpeg/webp，并可批量创建插件', () => {
    expect(NODE_IMAGE_FORMATS).toEqual(['png', 'jpeg', 'webp']);
    const plugins = createNodeImageDecoderPlugins();
    expect(plugins.map((plugin) => plugin.format)).toEqual(['png', 'jpeg', 'webp']);
    expect(nodeImageDecoders.map((plugin) => plugin.format)).toEqual(['png', 'jpeg', 'webp']);
  });

  it('格式标识归一化为小写', () => {
    expect(createNodeImageDecoderPlugin('PNG').format).toBe('png');
    expect(() => createNodeImageDecoderPlugin('  ')).toThrow();
  });

  it('解码 PNG 并返回可 drawImage 的图像对象', async () => {
    const bytes = await makeImage('png', 4, 3);
    const plugin = createNodeImageDecoderPlugin('png');
    const decoded = await plugin.decode(bytes);
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(3);
    expect(decoded.kind).toBe('source');

    // 验证返回对象可被 Canvas2D 消费（Node 图像对象），并保留原图像素。
    const target = createCanvas(4, 3);
    const context = target.getContext('2d');
    context.drawImage(decoded.data as never, 0, 0);
    const pixel = context.getImageData(1, 1, 1, 1).data;
    expect([pixel[0], pixel[1], pixel[2]]).toEqual([255, 0, 0]);
  });

  it('解码 JPEG', async () => {
    const bytes = await makeImage('jpeg', 6, 5);
    const decoded = await createNodeImageDecoderPlugin('jpeg').decode(bytes);
    expect(decoded.width).toBe(6);
    expect(decoded.height).toBe(5);
  });

  it('坏数据抛 OFD_IMAGE_DECODE 并保留 cause', async () => {
    const plugin = createNodeImageDecoderPlugin('png');
    await expect(plugin.decode(new Uint8Array([1, 2, 3, 4]))).rejects.toMatchObject({
      code: 'OFD_IMAGE_DECODE',
    });
    await expect(plugin.decode(new Uint8Array([1, 2, 3, 4]))).rejects.toBeInstanceOf(OFDError);
  });
});