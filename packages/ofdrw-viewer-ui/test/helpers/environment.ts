/**
 * 集成测试 DOM 环境替身。
 *
 * jsdom 缺少 Canvas 2D、rAF、图片解码与 Blob URL；这里提供最小可用实现，
 * 不改变被测代码分支，也不访问真实网络。
 */

import { replaceChildren } from '../../src/compat';
import { vi } from 'vitest';

/** 单次下载记录。 */
export interface DownloadRecord {
  /** `a[download]` 设置的文件名。 */
  readonly filename: string;
  /** Object URL。 */
  readonly href: string;
  /** 由 Object URL 反查到的内容。 */
  readonly blob: Blob | undefined;
}

/** 下载捕获结果。 */
export interface DownloadCapture {
  /** 按发生顺序记录的下载。 */
  readonly downloads: DownloadRecord[];
  /** Object URL 到 Blob 的映射。 */
  readonly blobs: Map<string, Blob>;
  /** 已释放的 Object URL。 */
  readonly revoked: string[];
  /** 恢复原型/URL 替身。 */
  restore(): void;
}

/** 安装 Canvas、rAF 与设备像素比替身。 */
export function installDomEnvironment(): void {
  const context = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    translate: vi.fn(),
    setTransform: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
  // 图片 load 由解码成功替代，避免打印逐页等待 500ms 超时。
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    writable: true,
    value: () => Promise.resolve(),
  });
}

/**
 * 捕获下载：替换 Object URL 与锚点点击。
 *
 * 调用方需在 `afterEach` 中执行 `restore()`（`vi.restoreAllMocks` 亦可）。
 *
 * @returns 下载记录与恢复函数。
 */
export function captureDownloads(): DownloadCapture {
  const downloads: DownloadRecord[] = [];
  const blobs = new Map<string, Blob>();
  const revoked: string[] = [];
  let sequence = 0;
  const createObjectURL = vi.fn((blob: Blob) => {
    sequence += 1;
    const url = `blob:ofd-test-${sequence}`;
    blobs.set(url, blob);
    return url;
  });
  const revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
  Object.defineProperty(window.URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: createObjectURL,
  });
  Object.defineProperty(window.URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: revokeObjectURL,
  });
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function mockClick(this: HTMLAnchorElement): void {
      downloads.push({
        filename: this.download,
        href: this.href,
        blob: blobs.get(this.href),
      });
    });
  return {
    downloads,
    blobs,
    revoked,
    restore() {
      click.mockRestore();
      delete (window.URL as unknown as Record<string, unknown>).createObjectURL;
      delete (window.URL as unknown as Record<string, unknown>).revokeObjectURL;
    },
  };
}

/** 清空 DOM 与自定义元素注册之外的状态。 */
export function resetDom(): void {
  replaceChildren(document.body);
  document.head.querySelectorAll('style[data-ofd-print-style]').forEach((node) => node.remove());
}