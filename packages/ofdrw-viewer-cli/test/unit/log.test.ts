import { describe, expect, it } from 'vitest';
import { Logger } from '../../src/log.js';
import { createStreamCapture } from './helpers.js';

describe('Logger', () => {
  it('info 写 stdout，错误与 warning 写 stderr', () => {
    const capture = createStreamCapture();
    const logger = new Logger({ stdout: capture.stdout, stderr: capture.stderr });

    logger.info('完成');
    logger.error('CLI_USAGE', '参数错误');
    logger.warn('W_FONT_DIR_EMPTY', '没有字体');
    logger.warn('W_FONT_MISSING', '缺字体', 3);

    expect(capture.stdoutText()).toBe('完成\n');
    expect(capture.stderrText()).toBe(
      '错误[CLI_USAGE]：参数错误\n' +
        '警告 [W_FONT_DIR_EMPTY]：没有字体\n' +
        '警告 [W_FONT_MISSING] 第 3 页：缺字体\n',
    );
  });

  it('按错误码累计 warning 并生成排序汇总', () => {
    const capture = createStreamCapture();
    const logger = new Logger({ stdout: capture.stdout, stderr: capture.stderr });

    logger.warn('W_FONT_MISSING', 'a');
    logger.warn('W_FONT_DIR_EMPTY', 'b');
    logger.warn('W_FONT_MISSING', 'c', 2);

    expect(logger.warningCounts()).toEqual(
      new Map([
        ['W_FONT_MISSING', 2],
        ['W_FONT_DIR_EMPTY', 1],
      ]),
    );
    expect(logger.formatWarningSummary()).toBe('警告汇总：W_FONT_DIR_EMPTY×1、W_FONT_MISSING×2');

    logger.flushWarningSummary();
    expect(capture.stderrText()).toBe(
      '警告 [W_FONT_MISSING]：a\n' +
        '警告 [W_FONT_DIR_EMPTY]：b\n' +
        '警告 [W_FONT_MISSING] 第 2 页：c\n' +
        '警告汇总：W_FONT_DIR_EMPTY×1、W_FONT_MISSING×2\n',
    );
  });

  it('没有 warning 时不输出汇总', () => {
    const capture = createStreamCapture();
    const logger = new Logger({ stdout: capture.stdout, stderr: capture.stderr });

    expect(logger.formatWarningSummary()).toBeUndefined();
    logger.flushWarningSummary();
    expect(capture.stderrText()).toBe('');
  });

  it('warningCounts 返回快照，不暴露内部 Map', () => {
    const capture = createStreamCapture();
    const logger = new Logger({ stdout: capture.stdout, stderr: capture.stderr });

    logger.warn('W_FONT_MISSING', 'a');
    const snapshot = logger.warningCounts() as Map<string, number>;
    snapshot.set('W_FONT_MISSING', 99);
    expect(logger.warningCounts().get('W_FONT_MISSING')).toBe(1);
  });
});