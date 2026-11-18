/**
 * 音视频资源导出：从取出的 `MediaResource` 元信息还原安全文件名并整块落盘。
 *
 * 设计约束（docs/音视频与动作方案设计.md §9.3）：
 * - 文件名**只**由资源 ID 与 MIME 推导扩展名拼成 `media-<id>.<ext>`，绝不使用包内
 *   原始 `MediaFile` 名，杜绝 `../` 路径穿越与终端控制字符注入；
 * - 走 `getMediaData()` 整块读取 + `writeFileAtomic` 原子写，不使用分块接口；
 * - 同目录已有同名文件时不覆盖，改用 `media-<id>-<n>.<ext>` 递增序号。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isOFDError } from '@ofdrw/ofdrw-viewer-engine';
import {
  CliError,
  EXIT_CODES,
  errorMessage,
} from './errors.js';
import { writeFileAtomic } from './output.js';
import { sanitizeDisplayText } from './safe-text.js';

/** 无法判定扩展名时的回退扩展名（不含点）。 */
export const MEDIA_FALLBACK_EXTENSION = 'bin';

/**
 * 资源 ID 的安全字符集：仅允许十进制数字。
 *
 * `MediaResource.id` 已由 engine 归一化为十进制字符串；导出文件名与
 * `--media-id` 参数都要求符合该形态，任何其他字符都不会进入文件名。
 */
export const SAFE_MEDIA_ID = /^[0-9]{1,20}$/u;

/**
 * 校验资源 ID 是否为合法的十进制资源标识。
 *
 * @param id 待校验的资源 ID
 * @returns 符合 {@link SAFE_MEDIA_ID} 时返回 true
 */
export function isValidMediaId(id: string): boolean {
  return SAFE_MEDIA_ID.test(id);
}

/** 冲突序号的最大尝试次数；超过则放弃，避免无限循环。 */
const MAX_NAME_ATTEMPTS = 1000;

/**
 * MIME 类型到文件扩展名的映射；键为小写 MIME，值为不含点的扩展名。
 *
 * 覆盖 engine MIME 表可能产出的音视频类型；未列出的 MIME 回退到
 * {@link MEDIA_FALLBACK_EXTENSION}。
 */
const MIME_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/x-ms-wma': 'wma',
  'video/mp4': 'mp4',
  'video/x-m4v': 'm4v',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'video/x-msvideo': 'avi',
  'video/avi': 'avi',
  'video/x-ms-wmv': 'wmv',
  'video/x-flv': 'flv',
  'video/quicktime': 'mov',
  'video/x-avs': 'avs',
  'video/avs': 'avs',
  'video/mpeg': 'mpg',
});

/**
 * 由 MIME 类型推导文件扩展名。
 *
 * 只取 `/` 前的类型段并按小写查询；带 `; charset=` 等参数时先截断。无法判定
 * 时返回 {@link MEDIA_FALLBACK_EXTENSION}。
 *
 * @param mimeType MIME 类型，例如 `video/mp4`
 * @returns 不含点的扩展名，例如 `mp4`；无法判定时 `bin`
 */
export function mediaExtensionOfMime(mimeType: string): string {
  const essence = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return MIME_EXTENSIONS[essence] ?? MEDIA_FALLBACK_EXTENSION;
}

/**
 * 生成音视频导出文件名（不含目录）。
 *
 * 只用资源 ID 与推导扩展名；engine 已保证 ID 为十进制字符串，调用方须先用
 * {@link isValidMediaId} 校验，因此结果永远不含路径分隔符、`..` 或控制字符。
 *
 * @param id 资源 ID（十进制字符串）
 * @param mimeType MIME 类型
 * @param sequence 冲突序号；`undefined` 或 1 时不追加，2 起追加 `-<n>`
 * @returns 形如 `media-12.mp4` 或 `media-12-2.mp4` 的文件名
 * @throws {CliError} ID 不是十进制资源标识时抛出（退出码 1）
 */
export function buildMediaFileName(
  id: string,
  mimeType: string,
  sequence?: number,
): string {
  if (!isValidMediaId(id)) {
    throw new CliError(
      'CLI_USAGE',
      `资源 ID 必须是十进制数字，收到：${sanitizeDisplayText(id)}`,
      EXIT_CODES.USAGE,
    );
  }
  const suffix = sequence === undefined || sequence <= 1 ? '' : `-${sequence}`;
  return `media-${id}${suffix}.${mediaExtensionOfMime(mimeType)}`;
}

/**
 * 在输出目录中挑选不冲突的音视频文件路径。
 *
 * 依次尝试 `media-<id>.<ext>`、`media-<id>-2.<ext>`…，直到该路径尚不存在。
 * 判定使用进程内已登记名字 + 磁盘真实存在性，避免覆盖用户已有文件。
 *
 * @param outDir 输出目录绝对路径
 * @param id 资源 ID
 * @param mimeType MIME 类型
 * @param taken 本次导出中已占用的绝对路径集合（会被原地更新）
 * @returns 可写入的绝对路径
 * @throws {CliError} 连续 {@link MAX_NAME_ATTEMPTS} 次均冲突时抛出（退出码 1）
 */
export function reserveMediaFilePath(
  outDir: string,
  id: string,
  mimeType: string,
  taken: Set<string>,
): string {
  for (let sequence = 1; sequence <= MAX_NAME_ATTEMPTS; sequence += 1) {
    const candidate = join(outDir, buildMediaFileName(id, mimeType, sequence));
    if (!taken.has(candidate) && !existsSync(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  throw new CliError(
    'CLI_USAGE',
    `输出目录中同名音视频文件过多，无法为资源 ${sanitizeDisplayText(id)} 生成文件名`,
    EXIT_CODES.USAGE,
  );
}

/** 待导出的音视频资源（元信息 + 已解析的输出路径）。 */
export interface MediaExportItem {
  /** 资源 ID。 */
  readonly id: string;
  /** 媒体类型。 */
  readonly kind: 'audio' | 'video';
  /** MIME 类型。 */
  readonly mimeType: string;
  /** 目标文件绝对路径。 */
  readonly filePath: string;
}

/** 取单个资源字节的读取函数签名，便于单测注入假实现。 */
export type MediaDataReader = (
  id: string,
  signal?: AbortSignal,
) => Promise<Uint8Array | undefined>;

/**
 * 读取单个音视频资源并原子写入目标文件。
 *
 * 读取失败或返回 `undefined` 时抛 {@link CliError}；超限（engine 抛
 * `OFD_LIMIT_EXCEEDED`）转为 `CLI_MEDIA_TOO_LARGE`。
 *
 * @param item 导出项（含目标路径）
 * @param read 字节读取函数，通常是 `document.getMediaData` 的包装
 * @param signal 取消信号
 * @returns 写入的字节数（byte）
 * @throws {CliError} 资源不可用 / 超限 / 写盘失败
 */
export async function exportMediaFile(
  item: MediaExportItem,
  read: MediaDataReader,
  signal?: AbortSignal,
): Promise<number> {
  let data: Uint8Array | undefined;
  try {
    data = await read(item.id, signal);
  } catch (error) {
    if (isOFDError(error) && error.code === 'OFD_LIMIT_EXCEEDED') {
      throw new CliError(
        'CLI_MEDIA_TOO_LARGE',
        `音视频资源 ${sanitizeDisplayText(item.id)} 超过单个资源大小上限：${errorMessage(error as Error)}`,
        EXIT_CODES.DOCUMENT,
        { cause: error },
      );
    }
    throw error;
  }
  if (data === undefined) {
    throw new CliError(
      'CLI_MEDIA_NOT_FOUND',
      `音视频资源 ${sanitizeDisplayText(item.id)} 不可用（包内文件缺失或类型不符）`,
      EXIT_CODES.USAGE,
    );
  }
  try {
    await writeFileAtomic(item.filePath, data);
  } catch (error) {
    throw new CliError(
      'CLI_MEDIA_WRITE_FAILED',
      `写入音视频文件失败：${item.filePath}（${errorMessage(error)}）`,
      EXIT_CODES.DOCUMENT,
      { cause: error },
    );
  }
  return data.byteLength;
}