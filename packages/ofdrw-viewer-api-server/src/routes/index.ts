/**
 * 路由注册入口：把请求上下文工厂注入各组路由，并在响应结束后释放资源。
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiServerConfig } from '../config.js';
import type { FontFile } from '../engine/index.js';
import type { JobManager } from '../jobs.js';
import type { RequestContext } from '../server.js';
import { disposeResources } from '../server.js';
import type { Logger } from 'pino';
import { registerDocumentRoutes } from './documents.js';
import { registerJobRoutes } from './jobs.js';
import { registerSystemRoutes } from './system.js';
import type { FastifyApp } from '../fastify-app.js';

/** 路由依赖。 */
export interface RouteDeps {
  /** 生效配置。 */
  readonly config: ApiServerConfig;
  /** 作业目录绝对路径，固定为工作区根下的 `jobs`。 */
  readonly jobDir: string;
  /** 日志器。 */
  readonly logger: Logger;
  /** 作业管理器。 */
  readonly jobs: JobManager;
  /** 字体文件。 */
  readonly fontFiles: readonly FontFile[];
  /** 生成 OpenAPI 文档的函数。 */
  readonly openapi: () => unknown;
}

/**
 * 注册全部路由。
 *
 * 每个请求创建一个上下文，并在响应连接关闭后统一关闭文档与删除临时文件。
 *
 * @param app Fastify 实例
 * @param deps 路由依赖
 */
export function registerRoutes(app: FastifyApp, deps: RouteDeps): void {
  const ctxOf = (request: FastifyRequest, reply: FastifyReply): RequestContext => {
    const signal =
      (request as FastifyRequest & { abortSignal?: AbortSignal }).abortSignal ??
      new AbortController().signal;
    const context: RequestContext = {
      request,
      reply,
      config: deps.config,
      jobDir: deps.jobDir,
      logger: deps.logger,
      jobs: deps.jobs,
      fontFiles: deps.fontFiles,
      signal,
      resources: { documents: [], tempFiles: [] },
    };
    reply.raw.once('close', () => {
      void disposeResources(context.resources, context.logger);
    });
    return context;
  };

  registerSystemRoutes(app, ctxOf, deps.openapi);
  registerDocumentRoutes(app, ctxOf);
  registerJobRoutes(app, ctxOf);
}