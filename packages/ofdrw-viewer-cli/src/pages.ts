/**
 * 页码范围解析与越界校验。
 *
 * 页码从 1 开始；解析结果始终去重并升序。页码越界校验要等拿到文档
 * `pageCount` 后由图片链路调用。
 */

import { CliError, EXIT_CODES } from './errors.js';

/** 单个页码区间允许的最大跨度（含两端），防止解析时无界展开。 */
export const MAX_PAGE_RANGE_SPAN = 100_000;

/** `--pages` 去重合并后允许选择的最大总页数。 */
export const MAX_SELECTED_PAGES = 100_000;

/**
 * 解析页码范围，如 `1-3,5`。
 *
 * 支持逗号分隔的单页与闭区间；重复/重叠页以及乱序输入会自动去重并升序
 * 排列。允许逗号与连字符两侧出现空白。
 *
 * @param raw 原始页码范围字符串
 * @returns 升序去重的页号数组（1 起）
 * @throws {CliError} 语法非法、页号小于 1、区间倒置或超过页数上限时抛出（退出码 1）
 */
export function parsePageRanges(raw: string): number[] {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const token of raw.split(',')) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token.trim());
    if (match === null) {
      throw invalidPageRanges(raw);
    }
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 1 ||
      end < start
    ) {
      throw invalidPageRanges(raw);
    }
    if (end - start + 1 > MAX_PAGE_RANGE_SPAN) {
      throw pageRangeTooLarge(raw);
    }
    ranges.push({ start, end });
  }

  // 先合并区间再按总页数限流，重叠输入不能被重复计数。
  ranges.sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  let total = 0;
  for (const range of merged) total += range.end - range.start + 1;
  if (total > MAX_SELECTED_PAGES) throw pageRangeTooLarge(raw);

  const pages: number[] = [];
  for (const range of merged) {
    for (let pageNumber = range.start; pageNumber <= range.end; pageNumber += 1) {
      pages.push(pageNumber);
    }
  }
  return pages;
}

/**
 * 校验页号不超过文档总页数。
 *
 * 页码越界属于用法错误（退出码 1），应在打开文档后、逐页导出前调用。
 *
 * @param pageNumbers 待校验页号（1 起）
 * @param pageCount 文档总页数
 * @throws {CliError} 页号越界或页数非法时抛出
 */
export function validatePageNumbers(
  pageNumbers: readonly number[],
  pageCount: number,
): void {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new CliError('CLI_INVALID_PAGES', `文档页数非法：${pageCount}`, EXIT_CODES.USAGE);
  }
  const outOfRange = pageNumbers.filter(
    (pageNumber) =>
      !Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount,
  );
  if (outOfRange.length > 0) {
    throw new CliError(
      'CLI_INVALID_PAGES',
      `页码越界：${outOfRange.join(', ')}（文档共 ${pageCount} 页）`,
      EXIT_CODES.USAGE,
    );
  }
}

/**
 * 结合文档页数得到最终页号列表。
 *
 * 未指定 `--pages` 时返回 `1..pageCount`；指定时先校验越界并去重升序。
 *
 * @param selected `parsePageRanges` 的结果；`undefined` 表示全部页
 * @param pageCount 文档总页数
 * @returns 升序页号数组
 * @throws {CliError} 页号越界、文档页数非法或全部页超过上限时抛出（退出码 1）
 */
export function resolvePageNumbers(
  selected: readonly number[] | undefined,
  pageCount: number,
): number[] {
  if (selected !== undefined) {
    validatePageNumbers(selected, pageCount);
    return [...new Set(selected)].sort((left, right) => left - right);
  }
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new CliError('CLI_INVALID_PAGES', `文档页数非法：${pageCount}`, EXIT_CODES.USAGE);
  }
  if (pageCount > MAX_SELECTED_PAGES) {
    throw new CliError(
      'CLI_INVALID_PAGES',
      `文档页数过大：${pageCount}，最多支持 ${MAX_SELECTED_PAGES} 页`,
      EXIT_CODES.USAGE,
    );
  }
  return Array.from({ length: pageCount }, (_, index) => index + 1);
}

/** 构造范围过大错误；在分配/展开前快速失败。 */
function pageRangeTooLarge(raw: string): CliError {
  return new CliError(
    'CLI_INVALID_PAGES',
    `--pages 选择范围过大：单段最多 ${MAX_PAGE_RANGE_SPAN} 页、总计最多 ${MAX_SELECTED_PAGES} 页；收到 ${JSON.stringify(raw)}`,
    EXIT_CODES.USAGE,
  );
}

/** 构造统一的页码范围错误。 */
function invalidPageRanges(raw: string): CliError {
  return new CliError(
    'CLI_INVALID_PAGES',
    `--pages 语法非法：${JSON.stringify(raw)}；示例：1-3,5`,
    EXIT_CODES.USAGE,
  );
}
