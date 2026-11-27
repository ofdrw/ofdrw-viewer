/**
 * 作业路由：创建、列表、元信息、单文件下载、结果 ZIP、取消。
 */

import { createReadStream } from 'node:fs';
import { contentDisposition } from '../output.js';
import { filePathParams, jobListQuery, jobParams, pathParams } from '../params.js';
import { readUpload } from './shared.js';
import type { ContextFactory } from './system.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyApp } from '../fastify-app.js';

/**
 * 注册作业路由。
 *
 * @param app Fastify 实例
 * @param ctxOf 请求上下文工厂
 */
export function registerJobRoutes(app: FastifyApp, ctxOf: ContextFactory): void {
  /** 创建作业。 */
  app.post('/api/jobs', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = ctxOf(request, reply);
    const upload = await readUpload(ctx);
    const params = jobParams(upload.params, {
      dpi: ctx.config.render.dpi,
      format: ctx.config.render.format,
      ttlSec: ctx.config.jobs.ttlSec,
    });
    const meta = await ctx.jobs.create({
      fileName: upload.fileName,
      data: upload.data,
      params,
    });
    void reply.status(201).send({
      jobId: meta.id,
      status: meta.status,
      createdAt: meta.createdAt,
      expiresAt: meta.expiresAt,
      metaUrl: `/api/jobs/${meta.id}/meta.json`,
      resultUrl: `/api/jobs/${meta.id}/result`,
    });
    return reply;
  });

  /** 作业列表。 */
  app.get('/api/jobs', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = ctxOf(request, reply);
    const query = jobListQuery(request.query as { limit?: string; status?: string });
    void reply.send(await ctx.jobs.list(query));
    return reply;
  });

  /** 作业元信息。 */
  app.get('/api/jobs/:id/meta.json', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = pathParams(request);
    const ctx = ctxOf(request, reply);
    void reply.send(await ctx.jobs.requireMeta(id));
    return reply;
  });

  /** 单个产物文件。 */
  app.get('/api/jobs/:id/files/:name', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, name } = filePathParams(request);
      const ctx = ctxOf(request, reply);
      const path = await ctx.jobs.requireFilePath(id, name);
      void reply
        .type('application/octet-stream')
        .header('content-disposition', contentDisposition(name))
        .send(createReadStream(path));
      return reply;
    },
  );

  /** 作业结果 ZIP。 */
  app.get('/api/jobs/:id/result', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = pathParams(request);
    const ctx = ctxOf(request, reply);
    const meta = await ctx.jobs.requireMeta(id);
    const dir = `${ctx.jobDir}/${meta.id}`;
    const { buildZipFromDirectory } = await import('../output.js');
    const zip = await buildZipFromDirectory(dir);
    void reply
      .type('application/zip')
      .header('content-disposition', contentDisposition(`${meta.id}.zip`))
      .send(Buffer.from(zip));
    return reply;
  });

  /** 取消并删除作业。 */
  app.delete('/api/jobs/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = pathParams(request);
    const ctx = ctxOf(request, reply);
    await ctx.jobs.remove(id);
    void reply.status(204).send();
    return reply;
  });
}