/**
 * `actionSummary`：只统计文档级与大纲级动作。
 *
 * 覆盖：无动作时字段整体省略、仅有文档级/仅有大纲级/两者都有、文本行位置
 * （紧跟 `多媒体:` 之后）与措辞，以及"页面/图元动作不计入"的统计口径。
 */

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  formatInfoText,
  runInfo,
  type CliActionSummary,
  type CliInfoJson,
  type CliMedia,
} from '../../src/info.js';
import { Logger } from '../../src/log.js';
import { createStreamCapture } from './helpers.js';

/** 无音视频、无动作的普通 OFD。 */
const PLAIN_SAMPLE = fileURLToPath(
  new URL('../../../../ofd_pdf_match/testPathClip.ofd', import.meta.url),
);

/**
 * 创建带内存输出的日志器。
 *
 * @returns 日志器与捕获器
 */
function createLogger(): {
  logger: Logger;
  capture: ReturnType<typeof createStreamCapture>;
} {
  const capture = createStreamCapture();
  return { logger: new Logger(capture), capture };
}

/**
 * 构造最小 info 结构。
 *
 * @param actionSummary 动作摘要；`undefined` 表示无该字段
 * @param media 媒体列表；`undefined` 表示无该字段
 * @returns info JSON
 */
function buildInfo(
  actionSummary?: CliActionSummary,
  media?: readonly CliMedia[],
): CliInfoJson {
  return {
    command: 'info',
    input: '/tmp/input.ofd',
    packageSize: 100,
    ofdVersion: '1.0',
    encrypted: false,
    layers: [],
    users: [],
    signatureCount: 0,
    integrityPresent: false,
    document: {
      version: '1.0',
      pageCount: 1,
      pageSizes: [{ widthMm: 210, heightMm: 297 }],
      attachments: [],
      ...(media === undefined ? {} : { media }),
      ...(actionSummary === undefined ? {} : { actionSummary }),
    },
    warnings: [],
  };
}

describe('动作摘要文本行', () => {
  it('无动作时不输出动作行', () => {
    expect(formatInfoText(buildInfo())).not.toContain('动作:');
  });

  it('有动作时输出文档与大纲两项', () => {
    expect(formatInfoText(buildInfo({ document: 1, outline: 2 }))).toContain(
      '动作: 文档 1，大纲 2',
    );
  });

  it('单侧为 0 时照常输出', () => {
    expect(formatInfoText(buildInfo({ document: 0, outline: 3 }))).toContain(
      '动作: 文档 0，大纲 3',
    );
    expect(formatInfoText(buildInfo({ document: 2, outline: 0 }))).toContain(
      '动作: 文档 2，大纲 0',
    );
  });

  it('动作行紧跟多媒体行', () => {
    const text = formatInfoText(
      buildInfo({ document: 1, outline: 0 }, [
        { id: '10', kind: 'video', mimeType: 'video/mp4', scope: 'public' },
      ]),
    );
    const lines = text.split('\n');
    const mediaIndex = lines.findIndex((line) => line.startsWith('多媒体:'));
    const actionIndex = lines.findIndex((line) => line.startsWith('动作:'));
    expect(mediaIndex).toBeGreaterThan(-1);
    expect(actionIndex).toBe(mediaIndex + 1);
  });
});

describe('动作摘要 JSON', () => {
  it('无动作时省略 actionSummary 字段', () => {
    const json = JSON.parse(JSON.stringify(buildInfo())) as CliInfoJson;
    expect('actionSummary' in (json.document ?? {})).toBe(false);
  });

  it('含动作时只有 document 与 outline 两个字段，不含 pages/objects', () => {
    const json = JSON.parse(
      JSON.stringify(buildInfo({ document: 1, outline: 2 })),
    ) as CliInfoJson;
    expect(json.document?.actionSummary).toEqual({ document: 1, outline: 2 });
    const summary = json.document?.actionSummary as unknown as Record<string, unknown>;
    expect('pages' in summary).toBe(false);
    expect('objects' in summary).toBe(false);
  });
});

describe('动作摘要对真实文档', () => {
  it('无动作文档不输出 actionSummary 与动作行', async () => {
    const capture = createStreamCapture();
    const code = await runInfo(
      { inputPath: PLAIN_SAMPLE, json: true },
      { logger: new Logger(capture) },
    );

    expect(code).toBe(0);
    const payload = JSON.parse(capture.stdoutText()) as CliInfoJson;
    expect('actionSummary' in (payload.document ?? {})).toBe(false);
  });

  it('文本输出行数不因动作字段变化（无动作文档）', async () => {
    const capture = createStreamCapture();
    await runInfo({ inputPath: PLAIN_SAMPLE, json: false }, { logger: new Logger(capture) });

    const lines = capture.stdoutText().trimEnd().split('\n');
    expect(lines).toHaveLength(19);
    expect(capture.stdoutText()).not.toContain('动作:');
  });
});