/**
 * 系统接口：版本、健康检查、OpenAPI 描述。
 */

import { statfs } from 'node:fs/promises';
import { VERSION as CRYPTO_VERSION } from '@ofdrw/ofdrw-viewer-crypto';
import { VERSION as ENGINE_VERSION } from '@ofdrw/ofdrw-viewer-engine';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RequestContext } from '../server.js';
import { VERSION } from '../version.js';
import type { FastifyApp } from '../fastify-app.js';

/** 服务启动时间，单位毫秒时间戳。 */
const STARTED_AT = Date.now();

/** 请求上下文工厂签名。 */
export type ContextFactory = (request: FastifyRequest, reply: FastifyReply) => RequestContext;

/**
 * 注册系统与健康检查接口。
 *
 * @param app Fastify 实例
 * @param ctxOf 请求上下文工厂
 * @param openapi 生成 OpenAPI 文档的函数
 */
export function registerSystemRoutes(
  app: FastifyApp,
  ctxOf: ContextFactory,
  openapi: () => unknown,
): void {
  app.get('/api/version', async (_request: FastifyRequest, reply: FastifyReply) => {
    void reply.send({
      cli: VERSION,
      engine: ENGINE_VERSION,
      crypto: CRYPTO_VERSION,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      apiVersion: '1',
      uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
    });
  });

  app.get('/api/openapi.json', async (_request: FastifyRequest, reply: FastifyReply) => {
    void reply.type('application/json; charset=utf-8').send(JSON.stringify(openapi()));
  });

  app.get('/api/health', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = ctxOf(request, reply);
    const stats = await ctx.jobs.stats();
    let freeBytes = 0;
    try {
      const info = await statfs(ctx.jobDir);
      freeBytes = info.bavail * info.bsize;
    } catch {
      freeBytes = 0;
    }
    void reply.send({
      status: 'ok',
      maxConcurrency: ctx.config.server.maxConcurrency,
      jobs: stats,
      jobDir: { path: ctx.jobDir, freeBytes },
    });
  });
}