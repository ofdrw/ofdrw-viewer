/**
 * 文档解析类路由：转换、文本、信息、验签、目录、页、附件、媒体。
 */

import {
  collectInfo,
  exportPageImage,
  exportPageText,
  getAttachmentsIndex,
  getMediaIndex,
  getOutlinePayload,
  getPageSizes,
  readAttachment,
  readMedia,
  verifyPackage,
} from '../engine/index.js';
import { ApiError } from '../errors.js';
import { contentDisposition, resolveOutputFormat, sendFormatted, sendSingleFile } from '../output.js';
import { pageNumberParam, pathParams, renderParams, textParams } from '../params.js';
import {
  createWarningCollector,
  openFromBytes,
  readUpload,
  resolvePages,
} from './shared.js';
import type { ContextFactory } from './system.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyApp } from '../fastify-app.js';

/**
 * 注册文档解析类路由。
 *
 * @param app Fastify 实例
 * @param ctxOf 请求上下文工厂
 */
export function registerDocumentRoutes(app: FastifyApp, ctxOf: ContextFactory): void {
  /** 转图片。 */
  app.post('/api/convert', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = ctxOf(request, reply);
    const upload = await readUpload(ctx);
    const params = renderParams(upload.params, {
      dpi: ctx.config.render.dpi,
      format: ctx.config.render.format,
    });
    const warnings = createWarningCollector(ctx);
    const opened = await openFromBytes(ctx, upload.data, warnings);
    const pages = resolvePages(params.pages, opened.pageCount);

    const files = [];
    for (const page of pages) {
      const result = await exportPageImage(opened.document, page, {
        dpi: params.dpi,
        format: params.format,
        quality: params.quality,
        signal: ctx.signal,
      });
      files.push({
        page: result.page,
        width: result.width,
        height: result.height,
        name: `p${String(result.page).padStart(3, '0')}.${
          params.format === 'jpeg' ? 'jpg' : params.format
        }`,
        data: result.data,
      });
    }
    const format = resolveOutputFormat(upload.params.output, ctx.config.output.format);
    const meta = {
      pages: files.map((file) => ({
        page: file.page,
        width: file.width,
        height: file.height,
        image: Buffer.from(file.data).toString('base64'),
      })),
      failures: [],
      ...(warnings.list.length === 0 ? {} : { warnings: warnings.list }),
    };
    await sendFormatted(
      reply,
      format,
      meta,
      files.map((file) => ({ name: file.name, data: file.data })),
    );
    return reply;
  });

  /** 文本提取。 */
  app.post('/api/text', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = ctxOf(request, reply);
    const upload = await readUpload(ctx);
    const params = textParams(upload.params, ctx.config.render.dpi);
    const warnings = createWarningCollector(ctx);
    const opened = await openFromBytes(ctx, upload.data, warnings);
    const pages = resolvePages(params.pages, opened.pageCount);

    const out: Array<{ page: number; type: 'ok'; width: number; height: number; items: unknown[] } | { page: number; type: 'failed'; code: string; message: string }> = [];
    for (const page of pages) {
      try {
        const result = await exportPageText(opened.document, page, {
          dpi: params.dpi,
          includeChars: params.includeChars,
          includeInvisible: params.includeInvisible,
          includeAnnotations: params.includeAnnotations,
          signal: ctx.signal,
        });
        out.push({ page, type: 'ok', width: result.width, height: result.height, items: result.items });
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code: unknown }).code)
            : 'CLI_UNEXPECTED';
        out.push({
          page,
          type: 'failed',
          code,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const failures = out.filter((item) => item.type === 'failed');
    const body = {
      dpi: params.dpi,
      pages: out
        .filter((item): item is Extract<typeof item, { type: 'ok' }> => item.type === 'ok')
        .map((item) => ({ page: item.page, width: item.width, height: item.height, items: item.items })),
      ...(failures.length === 0 ? {} : { failures }),
      ...(warnings.list.length === 0 ? {} : { warnings: warnings.list }),
    };
    void reply.status(failures.length === 0 ? 200 : 207).send(body);
    return reply;
  });

  /** 文档信息。 */
  app.post('/api/info', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = ctxOf(request, reply);
    const upload = await readUpload(ctx);
    const warnings = createWarningCollector(ctx);
    const opened = await openFromBytes(ctx, upload.data, warnings);
    const info = await collectInfo(opened.document, opened.packageSize, opened.inspection);
    void reply.send(info);
    return reply;
  });

  /** 目录与书签。 */
  app.post('/api/outline', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = ctxOf(request, reply);
    const upload = await readUpload(ctx);
    const warnings = createWarningCollector(ctx);
    const opened = await openFromBytes(ctx, upload.data, warnings);
    const payload = await getOutlinePayload(opened.document);
    void reply.send({ ...payload, ...(warnings.list.length === 0 ? {} : { warnings: warnings.list }) });
    return reply;
  });

  /** 页尺寸与单页图片。 */
  app.post('/api/pages', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = ctxOf(request, reply);
    const upload = await readUpload(ctx);
    const warnings = createWarningCollector(ctx);
    const opened = await openFromBytes(ctx, upload.data, warnings);

    if (upload.params.page === undefined) {
      const sizes = await getPageSizes(opened.document);
      void reply.send({ ...sizes, ...(warnings.list.length === 0 ? {} : { warnings: warnings.list }) });
      return reply;
    }

    const page = pageNumberParam(upload.params);
    const params = renderParams(upload.params, {
      dpi: ctx.config.render.dpi,
      format: ctx.config.render.format,
    });
    if (page > opened.pageCount) {
      throw new ApiError('CLI_INVALID_PAGES', `页码越界：${page}（文档共 ${opened.pageCount} 页）`);
    }
    const result = await exportPageImage(opened.document, page, {
      dpi: params.dpi,
      format: params.format,
      quality: params.quality,
      signal: ctx.signal,
    });
    sendSingleFile(
      reply,
      {
        id: String(page),
        name: `p${String(page).padStart(3, '0')}.${params.format === 'jpeg' ? 'jpg' : params.format}`,
        mime: result.mime,
        size: result.data.byteLength,
        data: result.data,
      },
      request.headers.accept,
    );
    return reply;
  });

  /** 附件列表与单文件下载。 */
  app.post('/api/attachments', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = ctxOf(request, reply);
    const upload = await readUpload(ctx);
    const warnings = createWarningCollector(ctx);
    const opened = await openFromBytes(ctx, upload.data, warnings);
    const attachments = await getAttachmentsIndex(opened.document);
    void reply.send({
      attachments,
      ...(warnings.list.length === 0 ? {} : { warnings: warnings.list }),
    });
    return reply;
  });

  app.post('/api/attachments/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = pathParams(request);
    const ctx = ctxOf(request, reply);
    const upload = await readUpload(ctx);
    const warnings = createWarningCollector(ctx);
    const opened = await openFromBytes(ctx, upload.data, warnings);
    const file = await readAttachment(opened.document, id, ctx.signal);
    if (file === undefined) throw new ApiError('CLI_JOB_NOT_FOUND', `附件不存在：${id}`);
    sendSingleFile(
      reply,
      { id: id, name: file.name, mime: file.mime, size: file.size, data: file.data },
      request.headers.accept,
    );
    return reply;
  });

  /** 媒体列表与单文件下载。 */
  app.post('/api/media', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = ctxOf(request, reply);
    const upload = await readUpload(ctx);
    const warnings = createWarningCollector(ctx);
    const opened = await openFromBytes(ctx, upload.data, warnings);
    const media = await getMediaIndex(opened.document);
    void reply.send({ media, ...(warnings.list.length === 0 ? {} : { warnings: warnings.list }) });
    return reply;
  });

  app.post('/api/media/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = pathParams(request);
    const ctx = ctxOf(request, reply);
    const upload = await readUpload(ctx);
    const warnings = createWarningCollector(ctx);
    const opened = await openFromBytes(ctx, upload.data, warnings);
    const file = await readMedia(opened.document, id, ctx.signal);
    if (file === undefined) throw new ApiError('CLI_JOB_NOT_FOUND', `媒体资源不存在：${id}`);
    sendSingleFile(
      reply,
      { id: id, name: file.name, mime: file.mime, size: file.size, data: file.data },
      request.headers.accept,
    );
    return reply;
  });

  /** 签名与完整性验证。 */
  app.post('/api/verify', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = ctxOf(request, reply);
    const upload = await readUpload(ctx);
    // verifyOfd 只接受文件路径；这里写临时文件，请求结束时立即删除。
    const tempPath = await ctx.jobs.writeTemp(upload.data);
    ctx.resources.tempFiles.push(tempPath);
    const report = await verifyPackage(tempPath, {
      ...(ctx.config.verify.sm2UserId === null ? {} : { sm2UserId: ctx.config.verify.sm2UserId }),
      signal: ctx.signal,
    });
    void reply.send(report);
    return reply;
  });

  // 单文件下载支持 HEAD，便于探活。
  app.head('/api/attachments/:id', async (_request: FastifyRequest, reply: FastifyReply) => {
    void reply.status(405).header('allow', 'POST').send();
    return reply;
  });

  app.head('/api/media/:id', async (_request: FastifyRequest, reply: FastifyReply) => {
    void reply.status(405).header('allow', 'POST').send();
    return reply;
  });
}

/**
 * 重新导出 `contentDisposition` 供其他模块使用。
 */
export { contentDisposition };