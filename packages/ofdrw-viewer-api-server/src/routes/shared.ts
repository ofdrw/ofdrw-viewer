/**
 * 路由共享辅助：打开文档、收集 warning。
 */

import { openDocumentFromBytes } from '../engine/index.js';
import type { OpenedDocument } from '../engine/index.js';
import { ApiError } from '../errors.js';
import { parseUpload } from '../input.js';
import type { UploadedRequest } from '../input.js';
import type { RequestContext } from '../server.js';

/** 单页 warning 收集器。 */
export interface WarningCollector {
  /** 已收集的 warning。 */
  readonly list: Array<{ code: string; message: string; page?: number }>;
  /** engine warning 回调。 */
  readonly onWarning: (warning: { code: string; message: string; pageIndex?: number }) => void;
}

/**
 * 创建 warning 收集器；warning 同时写入日志。
 *
 * @param ctx 请求上下文
 * @returns 收集器
 */
export function createWarningCollector(ctx: RequestContext): WarningCollector {
  const list: Array<{ code: string; message: string; page?: number }> = [];
  return {
    list,
    onWarning: (warning) => {
      const page = warning.pageIndex === undefined ? undefined : warning.pageIndex + 1;
      list.push({
        code: warning.code,
        message: warning.message,
        ...(page === undefined ? {} : { page }),
      });
      ctx.logger.warn({ code: warning.code, page }, warning.message);
    },
  };
}

/**
 * 解析上传请求。
 *
 * @param ctx 请求上下文
 * @returns 归一化的上传请求
 */
export async function readUpload(ctx: RequestContext): Promise<UploadedRequest> {
  return parseUpload(ctx.request, ctx.config.limits.maxUploadBytes);
}

/**
 * 从内存字节打开文档，并登记到请求资源以便请求结束时关闭。
 *
 * @param ctx 请求上下文
 * @param data 文档字节
 * @param warnings warning 收集器
 * @returns 已打开文档
 */
export async function openFromBytes(
  ctx: RequestContext,
  data: Uint8Array,
  warnings: WarningCollector,
): Promise<OpenedDocument> {
  const opened = await openDocumentFromBytes({
    data,
    fontFiles: ctx.fontFiles,
    signal: ctx.signal,
    onWarning: warnings.onWarning,
  });
  ctx.resources.documents.push(opened);
  return opened;
}

/**
 * 解析选中页号并校验越界。
 *
 * @param pages 选中的页号；`undefined` 表示全部页
 * @param pageCount 文档总页数
 * @returns 升序页号数组
 * @throws {ApiError} 页码越界时
 */
export function resolvePages(
  pages: readonly number[] | undefined,
  pageCount: number,
): number[] {
  if (pages === undefined) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }
  const outOfRange = pages.filter((page) => page < 1 || page > pageCount);
  if (outOfRange.length > 0) {
    throw new ApiError(
      'CLI_INVALID_PAGES',
      `页码越界：${outOfRange.join(', ')}（文档共 ${pageCount} 页）`,
    );
  }
  return [...new Set(pages)].sort((left, right) => left - right);
}