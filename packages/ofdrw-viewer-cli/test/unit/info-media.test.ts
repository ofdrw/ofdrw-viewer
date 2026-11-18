/**
 * info 的媒体字段：`document.media[]` 与文本 `多媒体:` 行。
 *
 * 覆盖"无音视频时完全省略"（既有输出兼容）与"有音视频时输出计数"两条路径，
 * 以及 `sizeBytes`/`format` 缺失即省略的字段规则。
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatInfoText, runInfo, type CliInfoJson, type CliMedia } from '../../src/info.js';
import { Logger } from '../../src/log.js';
import { createStreamCapture } from './helpers.js';

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
 * 构造最小可用的 info 结构。
 *
 * @param media 媒体列表；`undefined` 表示无该字段
 * @returns info JSON
 */
function buildInfo(media?: readonly CliMedia[]): CliInfoJson {
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
    },
    warnings: [],
  };
}

describe('info 文本的多媒体行', () => {
  it('无音视频时不输出多媒体行，既有输出保持不变', () => {
    const text = formatInfoText(buildInfo());
    expect(text).not.toContain('多媒体:');
    // 附件行仍是最后一行，既有格式未变。
    expect(text.trimEnd().endsWith('附件: 0 个')).toBe(true);
  });

  it('媒体数组为空时同样不输出多媒体行', () => {
    expect(formatInfoText(buildInfo([]))).not.toContain('多媒体:');
  });

  it('有音视频时在附件行之后输出分类型计数', () => {
    const text = formatInfoText(
      buildInfo([
        { id: '10', kind: 'video', mimeType: 'video/mp4', scope: 'public' },
        { id: '12', kind: 'audio', mimeType: 'audio/mpeg', scope: 'public' },
        { id: '13', kind: 'video', mimeType: 'video/webm', scope: 'document' },
      ]),
    );
    expect(text).toContain('多媒体: 视频 2 个，音频 1 个');
    const lines = text.split('\n');
    const attachmentIndex = lines.findIndex((line) => line.startsWith('附件:'));
    const mediaIndex = lines.findIndex((line) => line.startsWith('多媒体:'));
    expect(mediaIndex).toBe(attachmentIndex + 1);
  });

  it('只有音频或只有视频时数量为 0 的分项照常输出', () => {
    expect(
      formatInfoText(buildInfo([{ id: '1', kind: 'audio', mimeType: 'audio/mpeg', scope: 'public' }])),
    ).toContain('多媒体: 视频 0 个，音频 1 个');
    expect(
      formatInfoText(buildInfo([{ id: '2', kind: 'video', mimeType: 'video/mp4', scope: 'public' }])),
    ).toContain('多媒体: 视频 1 个，音频 0 个');
  });
});

describe('info JSON 的 media 字段', () => {
  it('无音视频时省略 media 字段，不写 undefined', async () => {
    // 走真实流程：无音视频的文档不应在 JSON 中出现 media 键。
    const input = fileURLToPath(
      new URL('../../../../ofd_pdf_match/testPathClip.ofd', import.meta.url),
    );
    const { logger, capture } = createLogger();
    const code = await runInfo({ inputPath: input, json: true }, { logger });

    expect(code).toBe(0);
    const json = JSON.parse(capture.stdoutText()) as CliInfoJson;
    expect(json.document).toBeDefined();
    expect('media' in (json.document ?? {})).toBe(false);
  });

  it('文本无音视频时不输出多媒体行（真实流程）', async () => {
    const input = fileURLToPath(
      new URL('../../../../ofd_pdf_match/testPathClip.ofd', import.meta.url),
    );
    const { logger, capture } = createLogger();
    const code = await runInfo({ inputPath: input, json: false }, { logger });

    expect(code).toBe(0);
    expect(capture.stdoutText()).not.toContain('多媒体:');
    expect(capture.stdoutText()).toContain('附件:');
  });

  it('媒体条目只含元信息，缺失字段省略', () => {
    const json = JSON.parse(
      JSON.stringify(
        buildInfo([
          {
            id: '12',
            kind: 'video',
            mimeType: 'video/mp4',
            format: 'MP4',
            sizeBytes: 1048576,
            scope: 'document',
          },
          { id: '13', kind: 'audio', mimeType: 'audio/mpeg', scope: 'page' },
        ]),
      ),
    ) as CliInfoJson;
    expect(json.document?.media).toEqual([
      {
        id: '12',
        kind: 'video',
        mimeType: 'video/mp4',
        format: 'MP4',
        sizeBytes: 1048576,
        scope: 'document',
      },
      { id: '13', kind: 'audio', mimeType: 'audio/mpeg', scope: 'page' },
    ]);
    const second = (json.document?.media?.[1] ?? {}) as unknown as Record<string, unknown>;
    expect('format' in second).toBe(false);
    expect('sizeBytes' in second).toBe(false);
  });
});

/** 真实媒体样例由 engine 的样例导出测试生成；未生成时跳过。 */
const hasMediaSample = existsSync(
  fileURLToPath(new URL('../../../../ofd_pdf_match/gb-12-media.ofd', import.meta.url)),
);

describe.skipIf(!hasMediaSample)('info 对真实媒体样例的输出', () => {
  it('gb-12-media.ofd 的 media[] 与 engine 索引一致', async () => {
    const input = fileURLToPath(
      new URL('../../../../ofd_pdf_match/gb-12-media.ofd', import.meta.url),
    );
    const { logger, capture } = createLogger();
    const code = await runInfo({ inputPath: input, json: true }, { logger });

    expect(code).toBe(0);
    const payload = JSON.parse(capture.stdoutText()) as CliInfoJson;
    const media = payload.document?.media ?? [];
    // 样例含 Video(10) 与 Audio(12)；Image(11) 不进 media。
    expect(media.map((item) => item.id)).toEqual(['10', '12']);
    expect(media.map((item) => item.kind)).toEqual(['video', 'audio']);
    expect(media[0]?.mimeType).toBe('video/mp4');
    expect(media[1]?.mimeType).toBe('audio/mpeg');
    for (const item of media) {
      expect(item.scope).toBe('public');
      expect(item.sizeBytes ?? 0).toBeGreaterThan(0);
    }
  });

  it('gb-12-media.ofd 文本输出含多媒体行', async () => {
    const input = fileURLToPath(
      new URL('../../../../ofd_pdf_match/gb-12-media.ofd', import.meta.url),
    );
    const { logger, capture } = createLogger();
    const code = await runInfo({ inputPath: input, json: false }, { logger });

    expect(code).toBe(0);
    expect(capture.stdoutText()).toContain('多媒体: 视频 1 个，音频 1 个');
  });
});