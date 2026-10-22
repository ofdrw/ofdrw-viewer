/**
 * 集成测试阅读器创建辅助。
 *
 * 测试文件负责用 `vi.mock` 注入内存引擎；这里只负责重置打开替身、挂载容器并
 * 返回文档对象，便于同时断言阅读器与引擎侧调用。
 */

import type { OFDViewerOptions } from '../../src/index';
import { OFDViewer } from '../../src/index';
import {
  createMockDocument,
  type MockDocumentOptions,
  type MockEngineDocument,
} from './document';

/** 引擎打开替身的最小结构（`vi.fn()` 结构兼容）。 */
export interface EngineOpenMock {
  /** 清空历史与实现。 */
  mockReset(): unknown;
  /** 设置成功返回的内存文档。 */
  mockResolvedValue(value: unknown): unknown;
  /** 设置一次失败；用于打开失败用例。 */
  mockRejectedValueOnce?(value: unknown): unknown;
}

/** 创建结果。 */
export interface CreatedViewer {
  /** 阅读器实例。 */
  readonly viewer: OFDViewer;
  /** 内存引擎文档。 */
  readonly document: MockEngineDocument;
}

/**
 * 创建阅读器（不等待 ready）。
 *
 * @param openMock 引擎打开替身。
 * @param documentOptions 内存文档配置。
 * @param viewerOptions 额外阅读器选项。
 * @returns 阅读器与内存文档。
 */
export function createViewer(
  openMock: EngineOpenMock,
  documentOptions: MockDocumentOptions = {},
  viewerOptions: Partial<OFDViewerOptions> = {},
): CreatedViewer {
  const document = createMockDocument(documentOptions);
  openMock.mockReset();
  openMock.mockResolvedValue(document);
  const viewer = new OFDViewer({
    container: documentElementContainer(),
    source: new ArrayBuffer(8),
    ...viewerOptions,
  });
  return { viewer, document };
}

/**
 * 创建阅读器并等待首次打开完成。
 *
 * @param openMock 引擎打开替身。
 * @param documentOptions 内存文档配置。
 * @param viewerOptions 额外阅读器选项。
 * @returns 已就绪的阅读器与内存文档。
 */
export async function openViewer(
  openMock: EngineOpenMock,
  documentOptions: MockDocumentOptions = {},
  viewerOptions: Partial<OFDViewerOptions> = {},
): Promise<CreatedViewer> {
  const created = createViewer(openMock, documentOptions, viewerOptions);
  await created.viewer.ready;
  return created;
}

/** 统一挂载到 body；每个用例前清空 DOM。 */
function documentElementContainer(): HTMLElement {
  return document.body;
}