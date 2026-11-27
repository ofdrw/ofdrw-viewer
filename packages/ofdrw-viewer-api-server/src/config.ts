/**
 * 配置结构、加载、环境变量插值与校验。
 *
 * 配置只从 YAML 读取；工作区根由 `--workdir`、配置文件中的 `workspace`、
 * `--config` 指定文件所在目录或进程工作目录依次确定，配置中的相对路径一律相对
 * 工作区根解析，作业目录固定为工作区根下的 `jobs`。
 *
 * 未找到任何配置文件时，启动流程会在工作区根生成一份默认配置文件。
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * 把配置值转换为数字，空串不按 0 处理。
 *
 * 插值后变量缺失会得到空串，这里返回 `NaN` 让后续模式判为非法，避免静默落成 0 值。
 *
 * @param value 原始配置值
 * @returns 数字；无法解析或为空串时为 `NaN`
 */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value.trim() === '') return Number.NaN;
  return Number(value.trim());
}

/**
 * 数值配置项：接受数值或可解析的数字字符串。
 *
 * 用法为 `numberConfig('...').pipe(z.number().int().min(1))`。
 *
 * @param message 非法取值时的提示
 * @returns 预处理后的模式，需以 `.pipe()` 接上具体数值约束
 */
function numberConfig(message: string) {
  return z.preprocess(toNumber, z.number({ error: message }));
}

/** 布尔配置项：接受 YAML 布尔与字符串 `true`/`false`。 */
const boolConfig = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => value === true || value === 'true');

/** 配置项的 zod 模式；各层级均为严格模式，未知字段直接报错。 */
const configSchema = z
  .object({
    // `null` 与省略等价，便于自动生成的模板把该项显式写出。
    workspace: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .transform((value) => value ?? undefined),
    server: z
      .object({
        host: z.string().min(1).default('127.0.0.1'),
        port: numberConfig('port 必须是数字').pipe(z.number().int().min(0).max(65_535)).default(7860),
        maxConcurrency: numberConfig('maxConcurrency 必须是数字').pipe(z.number().int().min(1)).default(4),
      })
      .strict()
      .prefault({}),
    limits: z
      .object({
        maxUploadBytes: numberConfig('maxUploadBytes 必须是数字').pipe(z.number().int().min(1)).default(268_435_456),
        maxJobPages: numberConfig('maxJobPages 必须是数字').pipe(z.number().int().min(1)).default(5000),
      })
      .strict()
      .prefault({}),
    jobs: z
      .object({
        timeoutSec: numberConfig('timeoutSec 必须是数字').pipe(z.number().min(0)).default(600),
        ttlSec: numberConfig('ttlSec 必须是数字').pipe(z.number().int().min(-1)).default(300),
        maxConcurrentJobs: numberConfig('maxConcurrentJobs 必须是数字').pipe(z.number().int().min(0)).default(0),
        maxTotalBytes: numberConfig('maxTotalBytes 必须是数字').pipe(z.number().int().min(0)).default(21_474_836_480),
      })
      .strict()
      .prefault({}),
    output: z
      .object({
        format: z.enum(['json', 'zip', 'multipart']).default('json'),
      })
      .strict()
      .prefault({}),
    render: z
      .object({
        format: z.enum(['png', 'jpeg', 'webp']).default('png'),
        dpi: numberConfig('dpi 必须是数字').pipe(z.number().int().min(1)).default(96),
        fontDir: z.string().min(1).nullable().default(null),
        systemFonts: boolConfig.default(true),
      })
      .strict()
      .prefault({}),
    verify: z
      .object({
        roots: z.array(z.string()).default([]),
        sm2UserId: z.string().nullable().default(null),
      })
      .strict()
      .prefault({}),
    logging: z
      .object({
        level: z
          .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
          .default('info'),
        dir: z.string().min(1).default('./logs'),
        keepDays: numberConfig('keepDays 必须是数字').pipe(z.number().int().min(1)).default(7),
        accessLog: boolConfig.default(true),
      })
      .strict()
      .prefault({}),
  })
  .strict();

/** 配置文件的原始结构，含仅用于定位工作区的 `workspace`。 */
type RawConfig = z.infer<typeof configSchema>;

/** 解析后的配置类型，不含 `workspace`。 */
export type ApiServerConfig = Omit<RawConfig, 'workspace'>;

/** 工作区根的确定来源。 */
export type WorkspaceSource = 'cli' | 'config' | 'config-file-dir' | 'exec-dir' | 'cwd';

/** 工作区来源的展示文本。 */
const WORKSPACE_SOURCE_TEXT: Record<WorkspaceSource, string> = {
  cli: '命令行 --workdir',
  config: '配置文件 workspace',
  'config-file-dir': '配置文件所在目录',
  'exec-dir': '可执行文件所在目录',
  cwd: '进程工作目录',
};

/** 已加载的配置及其来源信息。 */
export interface LoadedConfig {
  /** 生效配置。 */
  readonly config: ApiServerConfig;
  /** 工作区根的绝对路径。 */
  readonly workspaceRoot: string;
  /** 工作区根的确定来源。 */
  readonly workspaceSource: WorkspaceSource;
  /** 作业目录绝对路径，固定为工作区根下的 `jobs`。 */
  readonly jobDir: string;
  /** 配置文件绝对路径；使用内置默认时为 `undefined`。 */
  readonly configPath: string | undefined;
  /** 配置错误列表；非空时不应启动。 */
  readonly errors: readonly string[];
}

/** 默认配置文件名。 */
export const CONFIG_FILE_NAME = 'api-server-config.yaml';

/** 默认配置文件名，内部引用。 */
const DEFAULT_CONFIG_NAME = CONFIG_FILE_NAME;

/**
 * 自动生成配置文件的内容。
 *
 * 全部为固定取值，不含任何预置的环境变量插值；需要按环境注入时在文件内自行写
 * `${VAR}` 或 `${VAR:-默认值}`。
 */
export const DEFAULT_CONFIG_TEMPLATE = `# OFD API 服务器配置
#
# 本文件由 ofdrw-api-server 在首次启动时自动生成，可直接修改；修改后重新启动生效。
# 删除本文件后再启动会重新生成一份默认配置。
#
# 工作区根按优先级确定：--workdir 参数 → 本文件的 workspace 项 →
# 本文件所在目录 → 进程工作目录。相对路径一律相对工作区根解析。
# 作业目录固定为 <工作区根>/jobs，不可单独配置。
#
# 本文件全部为固定取值，服务不预置任何环境变量；需要时可在值里写
# \${VAR} 或 \${VAR:-默认值} 从环境变量取值（未设置时替换为空串或默认值；
# 空串不会被当作 0，数值字段为空串时报校验错误）。

workspace: null

server:
  # 监听地址；仅本机可访问请保持 127.0.0.1
  host: 127.0.0.1
  # 监听端口；被占用时启动失败，不顺延
  port: 7860
  # 同步渲染的最大并发数
  maxConcurrency: 4

limits:
  # 单个上传文档的大小上限，单位 byte；默认 256 MiB
  maxUploadBytes: 268435456
  # 单个作业允许的最大页数
  maxJobPages: 5000

jobs:
  # 单个作业的超时时间，单位秒
  timeoutSec: 600
  # 作业结束后的默认保留时长，单位秒；请求可用 ttlSec:-1 指定永不过期
  ttlSec: 300
  # 同时执行的作业数；0 表示不限制
  maxConcurrentJobs: 0
  # 作业目录总占用上限，单位 byte；默认 20 GiB
  maxTotalBytes: 21474836480

output:
  # 默认响应格式：json（base64 内嵌）| zip | multipart
  format: json

render:
  # 默认图片格式：png | jpeg | webp
  format: png
  # 默认输出 DPI
  dpi: 96
  # 补充字体目录；null 表示不加载
  fontDir: null
  # 是否自动发现系统字体
  systemFonts: true

verify:
  # 默认信任根证书文件；相对路径相对工作区根
  roots: []
  # 默认 SM2 签名 userId；null 表示使用标准值
  sm2UserId: null

logging:
  # 日志级别：trace | debug | info | warn | error | fatal
  level: info
  # 日志目录；相对工作区根，按天轮转
  dir: ./logs
  # 日志保留天数
  keepDays: 7
  # 是否为每个请求记录访问日志
  accessLog: true
`;

/** 环境变量引用；`${NAME}` 或 `${NAME:-默认值}`。 */
const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * 对 YAML 解析结果中的所有字符串标量做环境变量插值。
 *
 * 变量取自 `env`；未设置或为空串时使用 `${VAR:-默认值}` 给出的默认值，没有默认值
 * 则替换为空串。插值结果仍是字符串，由 zod 按字段类型转换。
 *
 * @param value 任意 YAML 值
 * @param env 环境变量表
 * @returns 插值后的同构值
 */
function interpolate(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_PATTERN, (_raw, name: string, fallback?: string) => {
      const resolved = env[name];
      if (resolved !== undefined && resolved !== '') return resolved;
      return fallback ?? '';
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, env));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = interpolate(item, env);
    }
    return out;
  }
  return value;
}

/**
 * 把配置中的相对路径解析为绝对路径，并剔除仅用于定位工作区的 `workspace`。
 *
 * @param config 已校验的配置
 * @param root 工作区根绝对路径
 * @returns 路径解析后的新配置
 */
function resolvePaths(config: RawConfig, root: string): ApiServerConfig {
  const { workspace: _workspace, ...rest } = config;
  const resolveMaybe = (value: string): string => (isAbsolute(value) ? value : resolve(root, value));
  return {
    ...rest,
    render: {
      ...rest.render,
      fontDir: rest.render.fontDir === null ? null : resolveMaybe(rest.render.fontDir),
    },
    verify: { ...rest.verify, roots: rest.verify.roots.map(resolveMaybe) },
    logging: { ...rest.logging, dir: resolveMaybe(rest.logging.dir) },
  };
}

/**
 * 查找配置文件。
 *
 * 顺序为 `--config` 指定路径 → 工作区候选中已有的 `api-server-config.yaml` →
 * 可执行文件同目录 → 内置默认。
 *
 * 未指定 `--config` 时，先只按 `--workdir` 定位候选；若该位置没有配置文件，再退回
 * 工作目录继续查找，以便读到配置文件里的 `workspace`。
 *
 * @param options 指定路径、查找基准目录、查找候选目录与可执行文件目录
 * @returns 文件绝对路径；全部缺失时为 `undefined`
 * @throws Error 指定路径不存在时
 */
async function findConfigFile(options: {
  configPath?: string;
  baseDir: string;
  workDir?: string;
  execDir?: string;
}): Promise<string | undefined> {
  if (options.configPath !== undefined) {
    const target = isAbsolute(options.configPath)
      ? options.configPath
      : resolve(options.baseDir, options.configPath);
    await readFile(target, 'utf8');
    return target;
  }
  const readCandidate = async (dir: string): Promise<string | undefined> => {
    const candidate = join(dir, DEFAULT_CONFIG_NAME);
    try {
      await readFile(candidate, 'utf8');
      return candidate;
    } catch {
      return undefined;
    }
  };

  // 第一轮只看显式工作区；命中则工作区根确定，不再查看工作目录。
  if (options.workDir !== undefined) {
    const hit = await readCandidate(options.workDir);
    if (hit !== undefined) return hit;
  }

  // 第二轮按优先级依次尝试工作目录与可执行文件同目录。
  const hits = [
    await readCandidate(options.baseDir),
    ...(options.execDir === undefined ? [] : [await readCandidate(options.execDir)]),
  ];
  return hits.find((hit) => hit !== undefined);
}

/** 配置加载的中间结果。 */
interface Draft {
  /** 已校验但未解析路径的配置；校验失败时为默认值。 */
  readonly raw: RawConfig;
  /** 命中的配置文件绝对路径。 */
  readonly configPath: string | undefined;
  /** 配置错误列表。 */
  readonly errors: readonly string[];
}

/**
 * 在比较两个地址字符串时忽略大小写的平台上是否需要容忍大小写差异。
 *
 * Windows 与 macOS 默认文件系统不区分大小写。
 */
const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';

/**
 * 判断两个路径是否指向同一位置。
 *
 * @param a 路径一
 * @param b 路径二
 * @returns 相同返回 `true`
 */
function samePath(a: string, b: string): boolean {
  return CASE_INSENSITIVE_PATHS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * 加载并校验配置。
 *
 * 工作区根按优先级取：显式 `workDir` 参数 → 配置文件中的 `workspace` →
 * 配置文件所在目录 → 工作目录。`workspace` 与 `workDir` 的相对路径一律相对
 * 工作目录解析。
 *
 * @param options 指定工作区根、配置路径、工作目录、环境变量与可执行文件目录
 * @returns 配置、工作区根、来源、作业目录与错误列表；`errors` 非空时不可启动
 */
export async function loadConfig(
  options: {
    workDir?: string;
    configPath?: string;
    cwd?: string;
    execDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<LoadedConfig> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const explicitRoot =
    options.workDir === undefined || options.workDir === ''
      ? undefined
      : resolve(cwd, options.workDir);

  // 第一遍：定位配置文件位置；此时若已由 --workdir 确定工作区，可优先读其下的配置。
  let configPath = await findConfigFile({
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    baseDir: cwd,
    ...(explicitRoot === undefined ? {} : { workDir: explicitRoot }),
    ...(options.execDir === undefined ? {} : { execDir: options.execDir }),
  });
  let draft = await readDraft(configPath, env);

  // 第二遍：配置里的 workspace 可能指向另一目录，需到该目录重新查找配置。
  const configRoot =
    explicitRoot === undefined && draft.raw.workspace !== undefined
      ? resolve(cwd, draft.raw.workspace)
      : undefined;
  if (configRoot !== undefined && !samePath(configRoot, cwd) && !samePath(configRoot, draft.configPath ?? '')) {
    const retry = await findConfigFile({
      baseDir: cwd,
      workDir: configRoot,
      ...(options.execDir === undefined ? {} : { execDir: options.execDir }),
    });
    if (retry !== undefined && !samePath(retry, configPath ?? '')) {
      configPath = retry;
      draft = await readDraft(configPath, env);
    }
  }

  let workspaceRoot: string;
  let workspaceSource: WorkspaceSource;
  if (explicitRoot !== undefined) {
    workspaceRoot = explicitRoot;
    workspaceSource = 'cli';
  } else if (draft.raw.workspace !== undefined) {
    workspaceRoot = resolve(cwd, draft.raw.workspace);
    workspaceSource = 'config';
  } else if (configPath !== undefined) {
    workspaceRoot = resolve(configPath, '..');
    workspaceSource = 'config-file-dir';
  } else if (options.execDir !== undefined) {
    workspaceRoot = resolve(options.execDir);
    workspaceSource = 'exec-dir';
  } else {
    workspaceRoot = cwd;
    workspaceSource = 'cwd';
  }

  return {
    config: resolvePaths(draft.raw, workspaceRoot),
    workspaceRoot,
    workspaceSource,
    jobDir: join(workspaceRoot, 'jobs'),
    configPath: draft.configPath,
    errors: draft.errors,
  };
}

/**
 * 读取并校验单个配置文件。
 *
 * @param configPath 配置文件绝对路径；`undefined` 时按内置默认处理
 * @param env 环境变量表
 * @returns 中间结果；校验失败时 `raw` 为内置默认值
 */
async function readDraft(configPath: string | undefined, env: NodeJS.ProcessEnv): Promise<Draft> {
  const raw: unknown = configPath === undefined ? {} : parseYaml(await readFile(configPath, 'utf8')) ?? {};
  const parsed = configSchema.safeParse(interpolate(raw, env));

  const errors: string[] = [];
  const base = {
    configPath,
    errors,
  };
  if (parsed.success) return { ...base, raw: parsed.data };

  for (const issue of parsed.error.issues) {
    const path = issue.path.length === 0 ? '(根)' : issue.path.join('.');
    errors.push(`CLI_CONFIG_INVALID: ${path}：${issue.message}`);
  }
  // 校验失败时仍返回默认值，便于 `-t` 打印来源并统一退出。
  return { ...base, raw: configSchema.parse({}) };
}

/**
 * 在只缺少配置文件的情况下生成默认配置文件。
 *
 * 指定了 `--config`、命中了配置文件、或工作区根下已有同名文件时一律不写。
 *
 * @param loaded 已加载的配置
 * @returns 实际写入的路径；未写入时为 `undefined`
 */
export async function generateDefaultConfig(loaded: LoadedConfig): Promise<string | undefined> {
  if (loaded.configPath !== undefined) return undefined;
  const target = join(loaded.workspaceRoot, DEFAULT_CONFIG_NAME);
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(loaded.workspaceRoot, { recursive: true });
  try {
    await writeFile(target, DEFAULT_CONFIG_TEMPLATE, { encoding: 'utf8', flag: 'wx' });
    return target;
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') return undefined;
    throw error;
  }
}

/**
 * 校验配置涉及的目录是否可写。
 *
 * 目录不存在时不创建，仅在实际启动时递归创建。
 *
 * @param config 生效配置
 * @param workspaceRoot 工作区根绝对路径
 * @returns 错误列表；空数组表示通过
 */
export async function checkDirectories(
  config: ApiServerConfig,
  workspaceRoot: string,
): Promise<string[]> {
  const { access, constants, stat } = await import('node:fs/promises');
  const errors: string[] = [];
  const checks: Array<[string, string]> = [
    ['工作区', workspaceRoot],
    ['logging.dir', config.logging.dir],
  ];
  for (const [label, dir] of checks) {
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) {
        errors.push(`CLI_CONFIG_WORKDIR: ${label} 不是目录：${dir}`);
        continue;
      }
      await access(dir, constants.W_OK);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT') {
        errors.push(`CLI_CONFIG_WORKDIR: ${label} 不存在：${dir}`);
        continue;
      }
      errors.push(`CLI_CONFIG_WORKDIR: ${label} 不可写：${dir}`);
    }
  }
  if (config.render.fontDir !== null) {
    try {
      const info = await stat(config.render.fontDir);
      if (!info.isDirectory()) {
        errors.push(`CLI_CONFIG_INVALID: render.fontDir 不是目录：${config.render.fontDir}`);
      }
    } catch {
      errors.push(`CLI_CONFIG_INVALID: render.fontDir 不存在：${config.render.fontDir}`);
    }
  }
  for (const root of config.verify.roots) {
    try {
      await access(root, constants.R_OK);
    } catch {
      errors.push(`CLI_CONFIG_INVALID: verify.roots 不可读：${root}`);
    }
  }
  return errors;
}

/**
 * 把字节数格式化为人类可读文本。
 *
 * @param bytes 字节数，单位 byte
 * @returns 形如 `256 MiB` 的文本
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Number(value.toFixed(value < 10 && unit > 0 ? 1 : 0))} ${units[unit]}`;
}

/**
 * 生成 `-t` 校验输出。
 *
 * @param loaded 已加载配置
 * @param dirErrors 目录校验错误
 * @returns 多行文本与是否通过
 */
export function describeConfig(
  loaded: LoadedConfig,
  dirErrors: readonly string[] = [],
): { text: string; ok: boolean } {
  const { config, workspaceRoot, workspaceSource, jobDir, configPath } = loaded;
  const source = configPath === undefined ? '(内置默认)' : configPath;
  const errors = [...loaded.errors, ...dirErrors];
  const lines = [
    `配置来源: ${source}`,
    `工作区: ${workspaceRoot}（来源 ${WORKSPACE_SOURCE_TEXT[workspaceSource]}，相对路径基准）`,
    `服务器: http://${config.server.host}:${config.server.port}（并发 ${config.server.maxConcurrency}，请求不设服务端超时）`,
    `上传上限: ${formatBytes(config.limits.maxUploadBytes)}`,
    `作业目录: ${jobDir}（超时 ${config.jobs.timeoutSec}s，默认有效期 ${config.jobs.ttlSec}s，并发 ${config.jobs.maxConcurrentJobs === 0 ? '不限' : String(config.jobs.maxConcurrentJobs)}，上限 ${formatBytes(config.jobs.maxTotalBytes)}）`,
    `输出: ${config.output.format}`,
    `日志目录: ${config.logging.dir}（级别 ${config.logging.level}，保留 ${config.logging.keepDays} 天，访问日志${config.logging.accessLog ? '开' : '关'}）`,
  ];
  if (errors.length === 0) {
    lines.push('校验结果: 通过');
    return { text: lines.join('\n'), ok: true };
  }
  lines.push('校验结果: 失败');
  for (const error of errors) lines.push(`  ${error}`);
  return { text: lines.join('\n'), ok: false };
}