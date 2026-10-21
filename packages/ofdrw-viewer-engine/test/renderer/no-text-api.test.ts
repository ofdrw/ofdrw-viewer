/**
 * 渲染器禁用 API 测试：不得调用 fillText/strokeText/measureText；
 * 径向渐变不得使用 createRadialGradient。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { H5Canvas2DRenderer } from '../../src/renderer/canvas2d';
import type { DrawStyle, ResolvedPaint, Viewport } from '../../src/common/types';
import { createNodeCanvas, readPixel } from './helpers';

/** 测试用线型。 */
const STYLE: DrawStyle = {
  lineWidth: 1,
  lineCap: 'Butt',
  lineJoin: 'Miter',
  miterLimit: 10,
  dashOffset: 0,
  dashPattern: [],
};

/** 红色。 */
const RED: ResolvedPaint = { kind: 'color', rgba: { r: 255, g: 0, b: 0, a: 255 } };

/** 96 DPI viewport。 */
const VIEWPORT: Viewport = { width: 10, height: 10, dpi: 96 };

/** 渲染器源码目录。 */
const RENDERER_DIR = fileURLToPath(new URL('../../src/renderer', import.meta.url));

/** gouraud 源码路径。 */
const GOURAUD_FILE = fileURLToPath(new URL('../../src/render/gouraud.ts', import.meta.url));

describe('渲染器禁用 API', () => {
  it('源码不出现 fillText/strokeText/measureText', () => {
    const files = readdirSync(RENDERER_DIR)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(RENDERER_DIR, name));
    files.push(GOURAUD_FILE);

    const forbidden = /\b(fillText|strokeText|measureText)\b/;
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(forbidden);
    }
  });

  it('H5 渲染器源码不调用 createRadialGradient', () => {
    const source = readFileSync(join(RENDERER_DIR, 'canvas2d.ts'), 'utf8');
    expect(source).not.toMatch(/createRadialGradient\s*\(/);
  });

  it('上下文若被调用文字 API 会立即失败；渲染路径/填充不触发', () => {
    const { context } = createNodeCanvas(10, 10);
    // 用会抛错的桩替换文字 API；渲染器不应触碰它们。
    const withText = context as unknown as Record<string, unknown>;
    for (const name of ['fillText', 'strokeText', 'measureText']) {
      withText[name] = () => {
        throw new Error(`不应调用 ${name}`);
      };
    }

    const renderer = new H5Canvas2DRenderer();
    renderer.beginPage(context, VIEWPORT);
    renderer.beginPath();
    renderer.rect(0, 0, 5, 5);
    renderer.fill(STYLE, RED, 'nonzero');
    expect(readPixel(context, 2, 2)).toEqual([255, 0, 0, 255]);
    renderer.endPage();
    renderer.close();
  });
});