/**
 * Fastify 应用装配、路由注册与统一错误处理。
 */

import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { ApiServerConfig } from './config.js';
import { discoverSystemFonts, mergeFontFiles, scanFontDirectory } from './engine/index.js';
import type { FontFile, OpenedDocument } from './engine/index.js';
import { ApiError, toErrorBody } from './errors.js';
import { JobManager } from './jobs.js';
import { buildOpenApiDocument } from './openapi.js';
import { registerRoutes } from './routes/index.js';
import type { FastifyApp } from './fastify-app.js';

/** 需要随请求关闭的资源集合。 */
export interface RequestResources {
  /** 已打开的文档。 */
  readonly documents: OpenedDocument[];
  /** 需要删除的临时文件。 */
  readonly tempFiles: string[];
}

/** 单请求上下文。 */
export interface RequestContext {
  /** Fastify 请求。 */
  readonly request: FastifyRequest;
  /** Fastify 响应。 */
  readonly reply: FastifyReply;
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
  /** 请求级取消信号。 */
  readonly signal: AbortSignal;
  /** 登记需要在本请求结束后释放的资源。 */
  readonly resources: RequestResources;
}

/** 启动选项。 */
export interface StartOptions {
  /** 覆盖端口；`0` 表示随机端口。 */
  readonly port?: number;
  /** 覆盖监听地址。 */
  readonly host?: string;
}

/** 已启动的服务。 */
export interface RunningServer {
  /** 访问基址，形如 `http://127.0.0.1:7860`。 */
  readonly url: string;
  /** 实际监听端口。 */
  readonly port: number;
  /** Fastify 实例。 */
  readonly app: FastifyApp;
  /** 作业管理器。 */
  readonly jobs: JobManager;
  /** 日志器。 */
  readonly logger: Logger;
  /** 关闭服务并释放资源。 */
  close(): Promise<void>;
}

/**
 * 列出某个路径已注册的方法。
 *
 * 借助 Fastify 的 `printRoutes` 输出解析出路径与方法，用于 405 的 `Allow` 头。
 *
 * @param app Fastify 实例
 * @param url 请求路径
 * @returns 方法名列表；路径不存在时为空数组
 */
function findPathMethods(app: FastifyApp, url: string): string[] {
  const path = url.split('?')[0] ?? url;
  // 静态路径按已知方法逐个探测；带参数的路由不参与 405 判定。
  const candidates = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
  const methods: string[] = [];
  for (const method of candidates) {
    if (app.hasRoute({ method, url: path })) methods.push(method);
  }
  return methods;
}

/**
 * 加载默认字体：用户字体目录在前，系统字体在后，按路径去重。
 *
 * @param fontDir 补充字体目录；`null` 表示不加载
 * @param systemFonts 是否发现系统字体
 * @param logger 日志器
 * @returns 字体文件列表
 */
async function loadFonts(
  fontDir: string | null,
  systemFonts: boolean,
  logger: Logger,
): Promise<readonly FontFile[]> {
  let fonts: readonly FontFile[] = fontDir === null ? [] : await scanFontDirectory(fontDir);
  if (systemFonts) {
    const discovered = await discoverSystemFonts();
    fonts = mergeFontFiles(fonts, discovered.fonts);
  }
  logger.info({ count: fonts.length, fontDir, systemFonts }, '字体已加载');
  return fonts;
}

/**
 * 关闭文档；失败只记 warning。
 *
 * @param document 已打开的文档
 * @param logger 日志器
 */
async function closeDocumentQuietly(document: OpenedDocument, logger: Logger): Promise<void> {
  try {
    await document.close();
  } catch (error) {
    logger.warn({ err: error }, '关闭文档失败');
  }
}

/**
 * 创建请求级资源容器。
 *
 * @returns 空资源集合
 */
function createResources(): RequestResources {
  return { documents: [], tempFiles: [] };
}

/**
 * 释放请求级资源。
 *
 * @param resources 资源集合
 * @param logger 日志器
 */
export async function disposeResources(resources: RequestResources, logger: Logger): Promise<void> {
  for (const document of resources.documents) {
    await closeDocumentQuietly(document, logger);
  }
  for (const file of resources.tempFiles) {
    await rm(file, { force: true }).catch(() => undefined);
  }
  resources.documents.length = 0;
  resources.tempFiles.length = 0;
}

/**
 * 启动 API 服务器。
 *
 * @param config 生效配置
 * @param logger 日志器
 * @param jobDir 作业目录绝对路径
 * @param options 端口与监听地址覆盖
 * @returns 已启动的服务
 */
export async function startApiServer(
  config: ApiServerConfig,
  logger: Logger,
  jobDir: string,
  options: StartOptions = {},
): Promise<RunningServer> {
  const fontFiles = await loadFonts(config.render.fontDir, config.render.systemFonts, logger);

  const jobs = new JobManager({
    workDir: jobDir,
    timeoutSec: config.jobs.timeoutSec,
    defaultTtlSec: config.jobs.ttlSec,
    maxConcurrentJobs: config.jobs.maxConcurrentJobs,
    maxTotalBytes: config.jobs.maxTotalBytes,
    maxJobPages: config.limits.maxJobPages,
    fontFiles,
    logger,
  });
  await jobs.start();

  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: Math.max(config.limits.maxUploadBytes * 2, 1024 * 1024),
    // 服务端不主动因超时断开连接，超时由调用方控制。
    requestTimeout: 0,
    genReqId: () => randomBytes(4).toString('hex'),
  });

  await app.register(multipart, {
    limits: {
      fileSize: config.limits.maxUploadBytes,
      files: 1,
      fields: 64,
      fieldSize: 1024 * 1024,
    },
  });
  await app.register(cors, { origin: false });

  app.decorateRequest('ofdContext', undefined);

  app.setErrorHandler((error, request, reply) => {
    const body = toErrorBody(error);
    const traceId = String(request.id);
    if (body.status >= 500) {
      request.log.error({ traceId, code: body.code, err: error }, '请求失败');
    } else {
      request.log.warn({ traceId, code: body.code }, body.message);
    }
    void reply.status(body.status).type('application/json; charset=utf-8').send(
      JSON.stringify({ code: body.code, message: body.message, traceId }),
    );
  });

  app.setNotFoundHandler((request, reply) => {
    // 路径存在但方法不匹配时返回 405，并给出该路径允许的方法。
    const allowed = findPathMethods(app, request.url);
    const status = allowed.length > 0 ? 405 : 404;
    const body =
      status === 405
        ? {
            code: 'CLI_METHOD_NOT_ALLOWED',
            message: `方法不允许：${request.method} ${request.url}；允许 ${allowed.join(', ')}`,
            traceId: String(request.id),
          }
        : {
            code: 'CLI_ROUTE_NOT_FOUND',
            message: `接口不存在：${request.method} ${request.url}`,
            traceId: String(request.id),
          };
    if (status === 405) reply.header('allow', allowed.join(', '));
    void reply
      .status(status)
      .type('application/json; charset=utf-8')
      .send(JSON.stringify(body));
  });

  // 访问日志：每请求一行，可通过 logging.accessLog 关闭。
  if (config.logging.accessLog) {
    app.addHook('onResponse', (request, reply, done) => {
      request.log.info(
        {
          traceId: String(request.id),
          method: request.method,
          path: request.url,
          status: reply.statusCode,
          durationMs: Number(reply.elapsedTime.toFixed(1)),
          ip: request.ip,
        },
        '访问',
      );
      done();
    });
  }

  // 客户端断开时中止该请求的渲染与导出。
  app.addHook('onRequest', (request, _reply, done) => {
    const controller = new AbortController();
    (request as FastifyRequest & { abortSignal?: AbortSignal }).abortSignal = controller.signal;
    request.raw.once('aborted', () => controller.abort());
    done();
  });

  registerRoutes(app, {
    config,
    jobDir,
    logger,
    jobs,
    fontFiles,
    openapi: () => buildOpenApiDocument(config),
  });

  const port = options.port ?? config.server.port;
  const host = options.host ?? config.server.host;
  try {
    await app.listen({ port, host });
  } catch (error) {
    await jobs.close();
    const code = (error as { code?: string }).code;
    if (code === 'EADDRINUSE') {
      throw new ApiError('CLI_SERVER_PORT_IN_USE', `端口 ${port} 已被占用`, 2);
    }
    throw error;
  }

  const address = app.server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;

  return {
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`,
    port: actualPort,
    app,
    jobs,
    logger,
    async close(): Promise<void> {
      await app.close();
      await jobs.close();
    },
  };
}

