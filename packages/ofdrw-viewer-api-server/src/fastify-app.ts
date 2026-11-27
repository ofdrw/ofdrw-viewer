/**
 * Fastify 实例类型别名。
 *
 * Fastify 的实例类型随传入 logger 的具体类型变化；这里统一固定为 pino 的
 * `Logger`，避免各模块重复书写长泛型。
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

/** Fastify 实例；logger 泛型固定为 pino 的 `Logger`。 */
export type FastifyApp = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>;
