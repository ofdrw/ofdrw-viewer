/**
 * 子包入口：配置、服务启动与子命令入口。
 */

export {
  DEFAULT_CONFIG_TEMPLATE,
  checkDirectories,
  describeConfig,
  formatBytes,
  generateDefaultConfig,
  loadConfig,
} from './config.js';
export type { ApiServerConfig, LoadedConfig, WorkspaceSource } from './config.js';
export { ApiError } from './errors.js';
export { createLogger, purgeOldLogs } from './logger.js';
export type { ServerLogger } from './logger.js';
export { registerRoutes } from './routes/index.js';
export { startApiServer } from './server.js';
export type { RunningServer, StartOptions } from './server.js';
export { runCli } from './cli.js';
export { buildOpenApiDocument } from './openapi.js';
export { VERSION } from './version.js';
export { JobManager } from './jobs.js';
export type { JobManagerOptions } from './jobs.js';
export type { JobMeta, JobStatus } from './store.js';