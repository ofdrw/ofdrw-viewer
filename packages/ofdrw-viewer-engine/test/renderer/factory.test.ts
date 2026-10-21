/**
 * CanvasFactory 测试：create/reset/destroy、willReadFrequently、默认工厂与错误路径。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { H5CanvasFactory } from '../../src/renderer/canvas2d';
import { isOFDError } from '../../src/errors';
import type {
  Canvas2DLike,
  CanvasRenderingContext2DLike,
} from '../../src/renderer/types';

/** 捕获到的 getContext 选项。 */
interface ContextOptions {
  alpha?: boolean;
  willReadFrequently?: boolean;
}

/** 伪画布；记录 getContext 选项与 2D 调用。 */
interface FakeCanvas extends Canvas2DLike {
  optionsSeen: ContextOptions[];
  calls: string[];
}

/**
 * 创建伪画布与最小上下文。
 *
 * @param calls 调用记录数组，用于断言 reset 行为。
 * @returns 伪画布。
 */
function createFakeCanvas(calls: string[] = []): FakeCanvas {
  const canvas = {
    width: 0,
    height: 0,
    optionsSeen: [] as ContextOptions[],
    calls,
    getContext(_type: '2d', options?: ContextOptions): CanvasRenderingContext2DLike {
      canvas.optionsSeen.push(options ?? {});
      const context = {
        canvas: canvas as unknown as Canvas2DLike,
        save() {
          calls.push('save');
        },
        restore() {
          calls.push('restore');
        },
        setTransform() {
          calls.push('setTransform');
        },
        transform() {
          calls.push('transform');
        },
        translate() {
          calls.push('translate');
        },
        rotate() {
          calls.push('rotate');
        },
        scale() {
          calls.push('scale');
        },
        beginPath() {
          calls.push('beginPath');
        },
        closePath() {
          calls.push('closePath');
        },
        moveTo() {
          calls.push('moveTo');
        },
        lineTo() {
          calls.push('lineTo');
        },
        quadraticCurveTo() {
          calls.push('quadraticCurveTo');
        },
        bezierCurveTo() {
          calls.push('bezierCurveTo');
        },
        rect() {
          calls.push('rect');
        },
        clip() {
          calls.push('clip');
        },
        fill() {
          calls.push('fill');
        },
        stroke() {
          calls.push('stroke');
        },
        fillRect() {
          calls.push('fillRect');
        },
        clearRect() {
          calls.push('clearRect');
        },
        drawImage() {
          calls.push('drawImage');
        },
        createLinearGradient() {
          return { addColorStop() {} };
        },
        createRadialGradient() {
          return { addColorStop() {} };
        },
        createPattern() {
          return null;
        },
        setLineDash(segments: number[]) {
          calls.push(`setLineDash:${segments.join(',')}`);
        },
        getLineDash() {
          return [];
        },
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        fillStyle: '#000',
        strokeStyle: '#000',
        lineWidth: 1,
        lineCap: 'butt',
        lineJoin: 'miter',
        miterLimit: 10,
        imageSmoothingEnabled: true,
      };
      return context as unknown as CanvasRenderingContext2DLike;
    },
  };
  return canvas as unknown as FakeCanvas;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('H5CanvasFactory', () => {
  it('create 使用注入的 createCanvas，并传 alpha=true、willReadFrequently=!enableHWA', () => {
    const calls: string[] = [];
    const factory = new H5CanvasFactory({
      createCanvas: () => createFakeCanvas(calls),
    });
    const entry = factory.create(3, 4);
    expect(entry.canvas.width).toBe(3);
    expect(entry.canvas.height).toBe(4);
    expect((entry.canvas as FakeCanvas).optionsSeen[0]).toEqual({
      alpha: true,
      willReadFrequently: true,
    });
    expect(entry.context).toBeTruthy();
  });

  it('enableHWA=true 时 willReadFrequently=false', () => {
    const factory = new H5CanvasFactory({
      enableHWA: true,
      createCanvas: () => createFakeCanvas(),
    });
    const entry = factory.create(1, 1);
    expect((entry.canvas as FakeCanvas).optionsSeen[0]).toEqual({
      alpha: true,
      willReadFrequently: false,
    });
  });

  it('reset 改尺寸、重置变换/alpha/composite/虚线', () => {
    const calls: string[] = [];
    const factory = new H5CanvasFactory({ createCanvas: () => createFakeCanvas(calls) });
    const entry = factory.create(2, 2);
    calls.length = 0;
    factory.reset(entry, 7, 9);
    expect(entry.canvas.width).toBe(7);
    expect(entry.canvas.height).toBe(9);
    expect(calls).toContain('setTransform');
    expect(calls).toContain('setLineDash:');
    expect(entry.context.globalAlpha).toBe(1);
    expect(entry.context.globalCompositeOperation).toBe('source-over');
  });

  it('destroy 把宽高置 0', () => {
    const factory = new H5CanvasFactory({ createCanvas: () => createFakeCanvas() });
    const entry = factory.create(5, 6);
    factory.destroy(entry);
    expect(entry.canvas.width).toBe(0);
    expect(entry.canvas.height).toBe(0);
  });

  it('浏览器默认工厂使用 globalThis.document', () => {
    const fake = createFakeCanvas();
    vi.stubGlobal('document', { createElement: () => fake });
    const factory = new H5CanvasFactory({});
    const entry = factory.create(2, 3);
    expect(entry.canvas.width).toBe(2);
    expect(entry.canvas.height).toBe(3);
    expect(fake.optionsSeen[0]).toEqual({ alpha: true, willReadFrequently: true });
  });

  it('无 document 时回退 OffscreenCanvas', () => {
    const fake = createFakeCanvas();
    class FakeOffscreenCanvas {
      width: number;
      height: number;

      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }

      getContext(type: '2d', options?: ContextOptions): CanvasRenderingContext2DLike {
        return fake.getContext(type, options)!;
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    const factory = new H5CanvasFactory({});
    const entry = factory.create(4, 5);
    expect(entry.canvas.width).toBe(4);
    expect(entry.canvas.height).toBe(5);
  });

  it('既无注入也无 document/OffscreenCanvas 时抛 OFD_RENDERER_UNSUPPORTED', () => {
    const factory = new H5CanvasFactory({});
    try {
      factory.create(1, 1);
      throw new Error('expected create to throw');
    } catch (error) {
      expect(isOFDError(error)).toBe(true);
      if (isOFDError(error)) expect(error.code).toBe('OFD_RENDERER_UNSUPPORTED');
    }
  });
});