/**
 * Playwright 测试扩展：统一收集控制台/页面异常，失败时落盘日志。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as base, expect } from 'playwright/test';
import type { Page, Request, TestInfo } from 'playwright/test';

/** 控制台与网络异常收集器。 */
export interface IssueCollector {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
  readonly requestFailures: Array<{ url: string; error: string }>;
  readonly consoleWarnings: string[];
}

/** 不应视为应用错误的浏览器控制台文本。 */
const IGNORED_CONSOLE = [/favicon/i];

/**
 * 监听页面问题。
 *
 * @param page Playwright 页面。
 * @returns 可读的收集器。
 */
export function collectIssues(page: Page): IssueCollector {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: Array<{ url: string; error: string }> = [];
  const consoleWarnings: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' && !IGNORED_CONSOLE.some((pattern) => pattern.test(text))) {
      consoleErrors.push(text);
    }
    if (message.type() === 'warning') consoleWarnings.push(text);
  });
  page.on('pageerror', (error) => pageErrors.push(`${error.message}\n${error.stack ?? ''}`));
  page.on('requestfailed', (request: Request) => {
    const error = request.failure()?.errorText ?? 'unknown';
    // 引擎会主动中止首次整包探测请求，随后改用 Range 分段读取，属于预期行为。
    if (error.includes('ERR_ABORTED')) return;
    requestFailures.push({ url: request.url(), error });
  });
  return { consoleErrors, pageErrors, requestFailures, consoleWarnings };
}

/**
 * 断言页面没有未捕获异常或 console error。
 *
 * @param page 页面。
 * @param issues 收集器。
 */
export async function expectNoPageErrors(page: Page, issues: IssueCollector): Promise<void> {
  expect(issues.pageErrors, 'pageerror').toEqual([]);
  expect(issues.consoleErrors, 'console.error').toEqual([]);
  expect(issues.requestFailures, 'requestfailed').toEqual([]);
  expect(await page.evaluate(() => window.__errors ?? []), 'window error').toEqual([]);
}

/**
 * 失败时把控制台信息写入 artifacts，并附加到 Playwright 报告。
 *
 * @param testInfo 测试信息。
 * @param issues 收集器。
 * @param page 页面。
 */
export async function dumpFailureLog(
  testInfo: TestInfo,
  issues: IssueCollector,
  page: Page,
): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return;
  const runtime = await page
    .evaluate(() => ({
      errors: window.__errors ?? [],
      warnings: window.__harness?.consoleWarnings ?? [],
      url: location.href,
    }))
    .catch(() => ({ errors: ['page closed'], warnings: [], url: 'unknown' }));
  const log = [
    `test: ${testInfo.title}`,
    `status: ${testInfo.status}`,
    `url: ${runtime.url}`,
    '',
    '## pageerror',
    ...issues.pageErrors,
    '',
    '## console.error',
    ...issues.consoleErrors,
    '',
    '## requestfailed',
    ...issues.requestFailures.map((item) => `${item.error} ${item.url}`),
    '',
    '## window.onerror / unhandledrejection',
    ...runtime.errors,
    '',
    '## known warnings',
    ...runtime.warnings,
  ].join('\n');
  const dir = join('test', 'acceptance', 'artifacts', 'logs');
  mkdirSync(dir, { recursive: true });
  const filename = join(dir, `${testInfo.title.replaceAll(/[^\w\u4e00-\u9fa5-]+/g, '_')}.log`);
  writeFileSync(filename, log, 'utf8');
  await testInfo.attach('console.log', { body: log, contentType: 'text/plain' });
}

/** 自动收集问题的测试对象。 */
export const test = base.extend<{ issues: IssueCollector }>({
  issues: [
    async ({ page }, use, testInfo) => {
      const issues = collectIssues(page);
      await use(issues);
      await dumpFailureLog(testInfo, issues, page);
    },
    { auto: true },
  ],
});

export { expect };
