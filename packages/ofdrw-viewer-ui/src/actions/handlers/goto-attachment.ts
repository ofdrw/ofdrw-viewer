/**
 * `GotoA` 动作处理器（UI 动作处理机制设计 §8.4）。
 *
 * 复用附件侧栏的既有下载流程（`saveAttachment()` 分块收集 → `Blob` → 触发下载），
 * 不另写一套附件读取。
 *
 * `NewWindow` **忽略**：浏览器下载没有"新窗口"语义，统一走现有附件下载；这一点是
 * 已确认的产品决策（设计 §14 决策 7）。
 *
 * 附件不存在、引擎不支持流式读取或读取失败时返回 `skipped('target-missing')`，
 * 不抛错、不打断后续动作。
 */

import type { ActionInfo, AttachmentInfo } from '@ofdrw/ofdrw-viewer-engine';
import type { ActionHandler, ActionHandlerResult } from '../types';

/** `saveAttachment` 的能力形状；`OFDDocument` 结构兼容。 */
export interface AttachmentSaveSource {
  /**
   * 分块写出附件内容。
   *
   * @param attachmentId 附件 ID。
   * @param sink 分块回调。
   * @param options 取消信号与分块大小。
   * @returns 写入的字节总数。
   */
  saveAttachment?(
    attachmentId: string,
    sink: (chunk: Uint8Array) => void | Promise<void>,
    options?: { signal?: AbortSignal; chunkSize?: number },
  ): Promise<number>;
}

/** GotoA handler 依赖的宿主能力。 */
export interface GotoAttachmentHandlerHost {
  /**
   * 当前文档的附件元信息。
   *
   * 可以是尚未完成的读取：handler 会等待它再查找，避免点击早于附件清单加载完成时
   * 被误判为附件不存在。
   */
  readonly getAttachments: () =>
    | readonly AttachmentInfo[]
    | Promise<readonly AttachmentInfo[]>;
  /** 底层引擎文档；用于 `saveAttachment`。 */
  readonly getDocument: () => object | null;
  /**
   * 触发下载。
   *
   * @param bytes 附件字节。
   * @param filename 下载文件名（已清洗）。
   * @param mimeType MIME 类型。
   */
  readonly download: (bytes: Uint8Array, filename: string, mimeType: string) => void;
  /** 生成安全文件名（过滤路径分隔符与控制字符）。 */
  readonly buildFilename: (attachment: AttachmentInfo) => string;
}

/**
 * 创建 `GotoA` 动作处理器。
 *
 * @param host 宿主能力。
 * @returns 动作处理器。
 */
export function createGotoAttachmentHandler(host: GotoAttachmentHandlerHost): ActionHandler {
  return async (
    context,
    action: ActionInfo,
  ): Promise<ActionHandlerResult> => {
    if (action.payload.type !== 'gotoa') {
      return { outcome: 'skipped', skipReason: 'target-missing' };
    }
    const attachId = action.payload.attachId?.trim();
    if (!attachId) return { outcome: 'skipped', skipReason: 'target-missing' };

    // 等附件清单就绪再查找；清单读取失败时按空清单处理（宿主侧不 reject）。
    const attachments = await host.getAttachments();
    const attachment = attachments.find((item) => item.id === attachId);
    if (!attachment) return { outcome: 'skipped', skipReason: 'target-missing' };

    const source = asAttachmentSource(host.getDocument());
    if (!source?.saveAttachment) return { outcome: 'skipped', skipReason: 'unsupported' };

    const chunks: Uint8Array[] = [];
    try {
      await source.saveAttachment(
        attachId,
        (chunk) => {
          // 引擎可能复用缓冲区，必须立即拷贝。
          chunks.push(chunk.slice());
        },
        context.signal ? { signal: context.signal } : undefined,
      );
    } catch (error) {
      if (isAbort(error)) return { outcome: 'cancelled' };
      return {
        outcome: 'failed',
        code: 'OFD_ATTACHMENT_READ_FAILED',
        message: error instanceof Error ? error.message : String(error),
      };
    }

    host.download(
      concatChunks(chunks),
      host.buildFilename(attachment),
      attachment.contentType ?? 'application/octet-stream',
    );
    return { outcome: 'executed' };
  };
}

/**
 * 拼接分块字节。
 *
 * @param chunks 分块字节数组。
 * @returns 拼接后的完整字节。
 */
function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/**
 * 判断引擎文档是否具备附件流式读取能力。
 *
 * @param document 引擎文档。
 * @returns 具备能力时返回附件源；否则 null。
 */
function asAttachmentSource(document: object | null): AttachmentSaveSource | null {
  if (!document) return null;
  const candidate = document as AttachmentSaveSource;
  return typeof candidate.saveAttachment === 'function' ? candidate : null;
}

/**
 * 判断错误是否为取消。
 *
 * @param error 错误对象。
 * @returns 取消时 true。
 */
function isAbort(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as { name?: unknown }).name === 'AbortError') return true;
  return (error as { code?: unknown }).code === 'OFD_ABORTED';
}