/**
 * 请求参数校验与归一化。
 *
 * 表单与 JSON 参数都已是字符串；这里用 zod 统一做类型转换、范围校验与
 * 取值范围检查，并复用 engine 的页码解析。
 */

import { z } from 'zod';
import { parsePageRanges } from './engine/index.js';
import { ApiError } from './errors.js';

/** 图片格式。 */
export type ImageFormat = 'png' | 'jpeg' | 'webp';

/** 校验正整数并转换。 */
const positiveInt = z.coerce.number().int().positive();

/** 校验 0–1 的小数并转换。 */
const qualityValue = z.coerce.number().min(0).max(1);

/** 布尔参数，接受 true/false/1/0。 */
const boolValue = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

/** 页码范围字符串。 */
const pagesValue = z
  .string()
  .min(1)
  .transform((value, ctx) => {
    try {
      return parsePageRanges(value);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : '页码范围非法',
      });
      return z.NEVER;
    }
  });

/**
 * 执行 zod 校验并把失败转换为 API 错误。
 *
 * @param schema 校验模式
 * @param value 待校验值
 * @param code 失败时的错误码；默认 `CLI_USAGE`
 * @param label 错误信息前缀
 * @returns 校验通过的结果
 * @throws {ApiError} 校验失败时
 */
function check<T extends z.ZodType>(
  schema: T,
  value: unknown,
  code: string,
  label: string,
): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join('；');
    throw new ApiError(code, `${label}：${detail}`);
  }
  return parsed.data;
}

/** 渲染相关参数。 */
export interface RenderParams {
  /** 选中的页号（1 起、升序去重）；`undefined` 表示全部页。 */
  readonly pages: readonly number[] | undefined;
  /** 输出 DPI。 */
  readonly dpi: number;
  /** 图片格式。 */
  readonly format: ImageFormat;
  /** JPEG/WebP 编码质量。 */
  readonly quality: number;
}

/**
 * 解析渲染参数。
 *
 * @param params 原始参数
 * @param defaults 配置中的默认值
 * @returns 归一化的渲染参数
 * @throws {ApiError} 参数非法时
 */
export function renderParams(
  params: Record<string, string>,
  defaults: { dpi: number; format: ImageFormat },
): RenderParams {
  const schema = z.object({
    pages: pagesValue.optional(),
    dpi: positiveInt.default(defaults.dpi),
    format: z.enum(['png', 'jpeg', 'webp']).default(defaults.format),
    quality: qualityValue.default(0.9),
  });
  const parsed = check(schema, params, 'CLI_USAGE', '渲染参数非法');
  return {
    pages: parsed.pages,
    dpi: parsed.dpi,
    format: parsed.format,
    quality: parsed.quality,
  };
}

/**
 * 解析文本提取参数。
 *
 * @param params 原始参数
 * @param defaultDpi 默认 DPI
 * @returns 文本参数
 * @throws {ApiError} 参数非法时
 */
export function textParams(
  params: Record<string, string>,
  defaultDpi: number,
): {
  pages: readonly number[] | undefined;
  dpi: number;
  includeChars: boolean;
  includeInvisible: boolean;
  includeAnnotations: boolean;
} {
  const schema = z.object({
    pages: pagesValue.optional(),
    dpi: positiveInt.default(defaultDpi),
    includeChars: boolValue.default(false),
    includeInvisible: boolValue.default(false),
    includeAnnotations: boolValue.default(false),
  });
  const parsed = check(schema, params, 'CLI_USAGE', '文本参数非法');
  return {
    pages: parsed.pages,
    dpi: parsed.dpi,
    includeChars: parsed.includeChars,
    includeInvisible: parsed.includeInvisible,
    includeAnnotations: parsed.includeAnnotations,
  };
}

/**
 * 解析单页参数。
 *
 * @param params 原始参数
 * @returns 页号（1 起）
 * @throws {ApiError} 缺少或非法时
 */
export function pageNumberParam(params: Record<string, string>): number {
  if (params.page === undefined) {
    throw new ApiError('CLI_USAGE', '缺少 page 参数');
  }
  return check(positiveInt, params.page, 'CLI_USAGE', 'page 参数非法');
}

/**
 * 解析作业创建参数。
 *
 * @param params 原始参数
 * @param defaults 配置默认值
 * @returns 作业参数
 * @throws {ApiError} 参数非法时
 */
export function jobParams(
  params: Record<string, string>,
  defaults: { dpi: number; format: ImageFormat; ttlSec: number },
): {
  ops: readonly ('images' | 'text' | 'media' | 'attachments')[];
  pages: readonly number[] | undefined;
  dpi: number;
  format: ImageFormat;
  quality: number;
  mediaKind: 'video' | 'audio' | undefined;
  mediaId: string | undefined;
  ttlSec: number;
} {
  const opsValue = z
    .string()
    .default('images')
    .transform((value) => value.split(',').map((item) => item.trim()).filter((item) => item.length > 0))
    .pipe(
      z
        .array(z.enum(['images', 'text', 'media', 'attachments', 'all']))
        .min(1)
        .transform((list) => {
          const expanded = new Set<'images' | 'text' | 'media' | 'attachments'>();
          for (const item of list) {
            if (item === 'all') {
              expanded.add('images');
              expanded.add('text');
              expanded.add('media');
              expanded.add('attachments');
            } else {
              expanded.add(item);
            }
          }
          return [...expanded];
        }),
    );
  const schema = z.object({
    ops: opsValue,
    pages: pagesValue.optional(),
    dpi: positiveInt.default(defaults.dpi),
    format: z.enum(['png', 'jpeg', 'webp']).default(defaults.format),
    quality: qualityValue.default(0.9),
    mediaKind: z.enum(['video', 'audio']).optional(),
    mediaId: z.string().regex(/^[0-9]{1,20}$/u, '必须是十进制资源 ID').optional(),
    ttlSec: z.coerce.number().int().min(-1).default(defaults.ttlSec),
  });
  const parsed = check(schema, params, 'CLI_USAGE', '作业参数非法');
  if ((parsed.mediaKind !== undefined || parsed.mediaId !== undefined) && !parsed.ops.includes('media')) {
    throw new ApiError('CLI_USAGE', 'mediaKind 与 mediaId 需要 ops 包含 media');
  }
  return {
    ops: parsed.ops,
    pages: parsed.pages,
    dpi: parsed.dpi,
    format: parsed.format,
    quality: parsed.quality,
    mediaKind: parsed.mediaKind,
    mediaId: parsed.mediaId,
    ttlSec: parsed.ttlSec,
  };
}

/**
 * 解析作业列表查询参数。
 *
 * @param query 查询参数
 * @returns `limit` 与 `status` 过滤条件
 * @throws {ApiError} 参数非法时
 */
export function jobListQuery(query: {
  limit?: string;
  status?: string;
}): { limit: number | undefined; status: readonly string[] | undefined } {
  const schema = z.object({
    limit: z.coerce.number().int().positive().optional(),
    status: z
      .string()
      .transform((value) => value.split(',').map((item) => item.trim()).filter((item) => item.length > 0))
      .pipe(
        z
          .array(
            z.enum(['queued', 'running', 'done', 'failed', 'cancelled', 'interrupted']),
          )
          .min(1),
      )
      .optional(),
  });
  const parsed = check(schema, query, 'CLI_USAGE', '查询参数非法');
  return { limit: parsed.limit, status: parsed.status };
}
/**
 * 解析并校验路径参数 `:id`。
 *
 * @param request Fastify 请求
 * @returns 校验后的路径参数
 * @throws {ApiError} 参数缺失或类型不符时
 */
export function pathParams(request: { params: unknown }): { id: string } {
  const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);
  if (!parsed.success) throw new ApiError('CLI_USAGE', '路径参数非法');
  return parsed.data;
}

/**
 * 解析并校验路径参数 `:id` 与 `:name`。
 *
 * @param request Fastify 请求
 * @returns 校验后的路径参数
 * @throws {ApiError} 参数缺失或类型不符时
 */
export function filePathParams(request: { params: unknown }): { id: string; name: string } {
  const parsed = z.object({ id: z.string().min(1), name: z.string().min(1) }).safeParse(request.params);
  if (!parsed.success) throw new ApiError('CLI_USAGE', '路径参数非法');
  return parsed.data;
}
