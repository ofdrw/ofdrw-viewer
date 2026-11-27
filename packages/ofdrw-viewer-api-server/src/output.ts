/**
 * 响应序列化：json / zip / multipart 三种输出与单文件发送。
 *
 * `zip` 用 fflate 压缩；`multipart` 按 `multipart/mixed` 逐段写出，首段为
 * JSON 元数据，后续为二进制产物。
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Zip, ZipPassThrough } from 'fflate';
import type { FastifyReply } from 'fastify';

/** 输出格式。 */
export type OutputFormat = 'json' | 'zip' | 'multipart';

/** 一个待输出的二进制产物。 */
export interface OutputFile {
  /** 产物文件名，如 `p001.png`。 */
  readonly name: string;
  /** 产物字节。 */
  readonly data: Uint8Array;
}

/** MIME 类型到扩展名的映射。 */
const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * 解析本次响应的输出格式。
 *
 * 请求参数 `output` 优先于配置默认值。
 *
 * @param requested 请求参数
 * @param fallback 配置默认值
 * @returns 生效格式
 * @throws {Error} 取值非法时（错误码 `CLI_USAGE`）
 */
export function resolveOutputFormat(requested: string | undefined, fallback: OutputFormat): OutputFormat {
  if (requested === undefined || requested.length === 0) return fallback;
  if (requested === 'json' || requested === 'zip' || requested === 'multipart') return requested;
  const error = new Error(`output 只支持 json / zip / multipart，收到：${requested}`);
  (error as { code?: string }).code = 'CLI_USAGE';
  throw error;
}

/**
 * 判断调用方是否期望 JSON。
 *
 * @param accept `Accept` 头
 * @returns 含 `application/json` 时为 true
 */
export function prefersJson(accept: string | undefined): boolean {
  return accept !== undefined && accept.includes('application/json');
}

/**
 * 生成 `Content-Disposition` 头。
 *
 * @param fileName 文件名
 * @returns 头字段值，ASCII 部分与 UTF-8 编码并存
 */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * 把文件列表打包为 ZIP 字节。
 *
 * @param meta 元数据对象，写入 `meta.json`
 * @param files 产物列表
 * @returns ZIP 字节
 */
export async function buildZip(meta: unknown, files: readonly OutputFile[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error !== null) throw error;
    chunks.push(chunk);
  });
  const append = (name: string, data: Uint8Array): void => {
    const entry = new ZipPassThrough(name);
    zip.add(entry);
    entry.push(data, true);
  };
  append('meta.json', new TextEncoder().encode(JSON.stringify(meta, null, 2)));
  for (const file of files) append(file.name, file.data);
  zip.end();
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * 把目录打包为 ZIP 字节。
 *
 * @param dir 目录绝对路径
 * @returns ZIP 字节；目录内文件按名称升序
 */
export async function buildZipFromDirectory(dir: string): Promise<Uint8Array> {
  const { readdir, stat } = await import('node:fs/promises');
  const entries = await readdir(dir, { withFileTypes: true });
  const files: OutputFile[] = [];
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
    if (!entry.isFile()) continue;
    const path = `${dir}/${entry.name}`;
    const info = await stat(path);
    if (info.size === 0 && entry.name === 'result.zip') continue;
    files.push({ name: basename(entry.name), data: new Uint8Array(await readFile(path)) });
  }
  return buildZip({ files: files.map((file) => file.name) }, files);
}

/**
 * 发送 JSON 响应。
 *
 * @param reply Fastify 响应
 * @param body 响应体
 * @param status 状态码
 */
export function sendJson(reply: FastifyReply, body: unknown, status = 200): void {
  void reply.status(status).type('application/json; charset=utf-8').send(JSON.stringify(body));
}

/**
 * 按输出格式发送响应。
 *
 * @param reply Fastify 响应
 * @param format 输出格式
 * @param meta JSON 元数据（zip 与 multipart 写入 `meta.json` 或首段）
 * @param files 二进制产物
 * @param status 状态码
 */
export async function sendFormatted(
  reply: FastifyReply,
  format: OutputFormat,
  meta: unknown,
  files: readonly OutputFile[],
  status = 200,
): Promise<void> {
  if (format === 'json') {
    sendJson(reply, meta, status);
    return;
  }
  if (format === 'zip') {
    const zip = await buildZip(meta, files);
    reply
      .status(status)
      .type('application/zip')
      .header('content-disposition', contentDisposition('result.zip'))
      .send(Buffer.from(zip));
    return;
  }
  const boundary = `ofdrw-${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Disposition: form-data; name="meta"\r\n\r\n${JSON.stringify(meta)}\r\n`,
    ),
  );
  for (const file of files) {
    const mime = Object.entries(MIME_EXTENSIONS).find(([, ext]) => file.name.endsWith(`.${ext}`))?.[0];
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Type: ${mime ?? 'application/octet-stream'}\r\nContent-Disposition: ${contentDisposition(file.name)}\r\n\r\n`,
      ),
    );
    parts.push(Buffer.from(file.data));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  reply
    .status(status)
    .type(`multipart/mixed; boundary=${boundary}`)
    .send(Buffer.concat(parts));
}

/**
 * 发送单个二进制文件。
 *
 * `Accept` 含 `application/json` 时改为 base64 内嵌对象。
 *
 * @param reply Fastify 响应
 * @param file 文件信息
 * @param accept `Accept` 头
 */
export function sendSingleFile(
  reply: FastifyReply,
  file: { id: string; name: string; mime: string; size: number; data: Uint8Array },
  accept: string | undefined,
): void {
  if (prefersJson(accept)) {
    sendJson(reply, {
      id: file.id,
      name: file.name,
      mime: file.mime,
      size: file.size,
      base64: Buffer.from(file.data).toString('base64'),
    });
    return;
  }
  reply
    .type(file.mime)
    .header('content-length', String(file.data.byteLength))
    .header('content-disposition', contentDisposition(file.name))
    .send(Buffer.from(file.data));
}