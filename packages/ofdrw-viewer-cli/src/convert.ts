/**
 * 图片转换流程入口。
 *
 * 本阶段只搭建 CLI 参数、输出与日志基础，不接 engine，因此这里保留统一
 * 签名并明确报错；后续图片链路任务在此实现打开文档、逐页渲染与汇总。
 */

import { CliError, EXIT_CODES } from './errors.js';
import type { FontFile } from './fonts.js';
import type { ImageFormat } from './output.js';

/** 图片转换所需的全部输入。 */
export interface ConvertOptions {
  /** 输入 OFD 文件绝对路径。 */
  readonly inputPath: string;
  /** 输出目录绝对路径。 */
  readonly outDir: string;
  /** 图片格式。 */
  readonly format: ImageFormat;
  /** 输出 DPI。 */
  readonly dpi: number;
  /** 选中的页号；`undefined` 表示全部页。 */
  readonly pageNumbers: readonly number[] | undefined;
  /** 补充字体文件列表。 */
  readonly fontFiles: readonly FontFile[];
}

/** 转换摘要，供成功/页级失败时输出。 */
export interface ConvertSummary {
  /** 计划处理的页数。 */
  readonly totalPages: number;
  /** 成功页数。 */
  readonly succeededPages: number;
  /** 失败页数。 */
  readonly failedPages: number;
  /** 结束时打印的单行摘要。 */
  readonly message: string;
}

/**
 * 执行图片转换。
 *
 * @param options 转换输入
 * @returns 转换摘要
 * @throws {CliError} 当前阶段尚未接入 engine，固定抛出 `CLI_ENGINE_UNAVAILABLE`
 */
export async function convertDocument(_options: ConvertOptions): Promise<ConvertSummary> {
  throw new CliError(
    'CLI_ENGINE_UNAVAILABLE',
    '图片转换链路尚未接入（当前构建只包含参数、输出与日志基础）',
    EXIT_CODES.DOCUMENT,
  );
}