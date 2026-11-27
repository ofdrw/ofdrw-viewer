/**
 * 请求体解析：把 JSON(base64) 与 multipart 表单归一为同一结构。
 *
 * multipart 由 `@fastify/multipart` 解析；JSON 分支自行解码 `file.base64`。
 */

import type { FastifyRequest } from 'fastify';
import { ApiError } from './errors.js';

/** 归一化后的上传请求。 */
export interface UploadedRequest {
  /** 文件名；未提供时为 `document.ofd`。 */
  readonly fileName: string;
  /** 文档字节。 */
  readonly data: Uint8Array;
  /** 其余参数（JSON 取 `params`，表单取平铺字段）。 */
  readonly params: Record<string, string>;
}

/** 表单字段合计大小上限，单位 byte。 */
const MAX_PARAM_BYTES = 1024 * 1024;

/** JSON 体结构。 */
interface JsonBody {
  readonly file?: { readonly name?: unknown; readonly base64?: unknown };
  readonly params?: Record<string, unknown>;
}

/**
 * 把 JSON 参数值转为字符串。
 *
 * 数组按逗号连接，布尔与数字取字面量；`null`/`undefined` 跳过。
 *
 * @param value 原始值
 * @returns 字符串；无法转换时为 `undefined`
 */
function stringifyParam(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((item) => stringifyParam(item)).filter((item) => item !== undefined);
    return parts.length === 0 ? undefined : parts.join(',');
  }
  return undefined;
}

/**
 * 解析 JSON 请求体。
 *
 * 文档以 `file.base64` 携带；参数取 `params`。
 *
 * @param body 已解析的 JSON 体
 * @param maxUploadBytes 上传上限，单位 byte
 * @returns 归一化请求
 * @throws {ApiError} 缺少文件、base64 非法或超限时
 */
function parseJsonBody(body: JsonBody, maxUploadBytes: number): UploadedRequest {
  const file = body.file;
  if (file === undefined || typeof file.base64 !== 'string') {
    throw new ApiError('CLI_USAGE', 'JSON 请求需要在 file.base64 中携带文档');
  }
  const buffer = Buffer.from(file.base64, 'base64');
  if (buffer.byteLength === 0) {
    throw new ApiError('CLI_USAGE', 'file.base64 解码后为空');
  }
  if (buffer.byteLength > maxUploadBytes) {
    throw new ApiError(
      'CLI_UPLOAD_TOO_LARGE',
      `文档 ${buffer.byteLength} byte 超过上限 ${maxUploadBytes} byte`,
    );
  }
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(body.params ?? {})) {
    const text = stringifyParam(value);
    if (text !== undefined) params[key] = text;
  }
  const name = typeof file.name === 'string' && file.name.length > 0 ? file.name : 'document.ofd';
  return { fileName: name, data: new Uint8Array(buffer), params };
}

/**
 * 解析 multipart 请求。
 *
 * `file` 字段为文档，其余字段平铺为参数；文件字段按流读取并累计上限检查。
 *
 * @param request Fastify 请求
 * @param maxUploadBytes 上传上限，单位 byte
 * @returns 归一化请求
 * @throws {ApiError} 缺少文件或超限时
 */
async function parseMultipartBody(
  request: FastifyRequest,
  maxUploadBytes: number,
): Promise<UploadedRequest> {
  const params: Record<string, string> = {};
  let fileName = 'document.ofd';
  let data: Uint8Array | undefined;
  let paramBytes = 0;

  if (!request.isMultipart()) {
    throw new ApiError('CLI_UNSUPPORTED_MEDIA_TYPE', '请求体需要为 application/json 或 multipart/form-data');
  }

  for await (const part of request.parts()) {
    if (part.type === 'file' && part.fieldname === 'file') {
      if (data !== undefined) {
        throw new ApiError('CLI_USAGE', '请求中只能包含一个 file 字段');
      }
      if (part.filename !== undefined && part.filename.length > 0) fileName = part.filename;
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of part.file) {
        total += chunk.byteLength;
        if (total > maxUploadBytes) {
          throw new ApiError(
            'CLI_UPLOAD_TOO_LARGE',
            `文档超过上传上限 ${maxUploadBytes} byte`,
          );
        }
        chunks.push(chunk);
      }
      data = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }
      continue;
    }
    if (part.type === 'field') {
      const text = String(part.value);
      paramBytes += Buffer.byteLength(text);
      if (paramBytes > MAX_PARAM_BYTES) {
        throw new ApiError('CLI_UPLOAD_TOO_LARGE', `表单字段合计超过上限 ${MAX_PARAM_BYTES} byte`);
      }
      params[part.fieldname] = text;
    }
  }

  if (data === undefined) {
    throw new ApiError('CLI_USAGE', '表单缺少 file 字段');
  }
  return { fileName, data, params };
}

/**
 * 解析上传请求（JSON 或 multipart）。
 *
 * @param request Fastify 请求
 * @param maxUploadBytes 文档上传上限，单位 byte
 * @returns 归一化请求
 * @throws {ApiError} 请求体格式不受支持或缺少文档时
 */
export async function parseUpload(
  request: FastifyRequest,
  maxUploadBytes: number,
): Promise<UploadedRequest> {
  if (request.isMultipart()) return parseMultipartBody(request, maxUploadBytes);
  // JSON 请求体按内容类型判定：缺少 file 属于参数错误，不是媒体类型错误。
  const contentType = request.headers['content-type'] ?? '';
  if (contentType.includes('application/json')) {
    const body = request.body;
    if (body === null || typeof body !== 'object') {
      throw new ApiError('CLI_USAGE', 'JSON 请求体需要是对象');
    }
    return parseJsonBody(body as JsonBody, maxUploadBytes);
  }
  throw new ApiError(
    'CLI_UNSUPPORTED_MEDIA_TYPE',
    '请求体需要为 application/json（file.base64）或 multipart/form-data（file 字段）',
  );
}