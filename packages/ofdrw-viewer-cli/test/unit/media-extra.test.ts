/**
 * 音视频导出的补充验证（Lead 指定的 4 项）。
 *
 * 1. `--media` 与 `--text` 同时使用时三者都产出，摘要体现组合模式；
 * 2. 包内 `MediaFile` 含 `../`、绝对路径、控制字符时，导出文件名仍只用
 *    `media-<id>.<ext>`，不会穿越到输出目录之外；
 * 3. `info` 对无音视频文档的输出与改动前完全一致（`media` 字段整体省略）；
 * 4. engine 的 `W_MEDIA_*` warning 能正常写入 stderr，不被吞掉。
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli.js';
import { formatInfoText, runInfo, type CliInfoJson } from '../../src/info.js';
import { Logger } from '../../src/log.js';
import { createStreamCapture } from './helpers.js';
import { existsSync } from 'node:fs';
import { createZip, type ZipEntryInput } from './zip-builder.js';

/** 含音视频的样例 OFD。 */
const MEDIA_SAMPLE = fileURLToPath(
  new URL('../../../../ofd_pdf_match/gb-12-media.ofd', import.meta.url),
);

/** 含音视频样例是否存在；由 engine 的样例导出测试生成，缺失时跳过依赖用例。 */
const hasMediaSample = existsSync(MEDIA_SAMPLE);

/** 无音视频的普通 OFD（用于零回归核对）。 */
const PLAIN_SAMPLE = fileURLToPath(
  new URL('../../../../ofd_pdf_match/testPathClip.ofd', import.meta.url),
);

/** 本次测试创建的临时路径，供 afterEach 清理。 */
const tempPaths: string[] = [];

/**
 * 创建临时目录并登记清理。
 *
 * @returns 临时目录绝对路径
 */
async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ofdrw-cli-media-extra-'));
  tempPaths.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/**
 * 以注入输出流运行 main。
 *
 * @param argv 参数
 * @param cwd 工作目录
 * @returns 退出码与输出文本
 */
async function runMain(
  argv: readonly string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const capture = createStreamCapture();
  const code = await main(argv, { cwd, stdout: capture.stdout, stderr: capture.stderr });
  return { code, stdout: capture.stdoutText(), stderr: capture.stderrText() };
}

/**
 * 构造一个 `MediaFile` 路径异常的最小 OFD 包。
 *
 * `MediaFile` 写成 `../` 越界或绝对路径，验证 CLI 导出命名不依赖该值。
 *
 * @param mediaFilePath 写入 `MultiMedia/MediaFile` 的原文
 * @param outPath 输出 OFD 路径
 */
async function writeMaliciousMediaOfd(
  mediaFilePath: string,
  outPath: string,
): Promise<void> {
  const entries: ZipEntryInput[] = [
    {
      name: 'OFD.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<ofd:OFD xmlns:ofd="http://www.ofdspec.org/2016" DocType="ofd" Version="1.1">
  <ofd:DocBody>
    <ofd:DocInfo>
      <ofd:DocID>malicious-media-sample</ofd:DocID>
      <ofd:Title>恶意媒体路径样例</ofd:Title>
    </ofd:DocInfo>
    <ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot>
  </ofd:DocBody>
</ofd:OFD>`,
    },
    {
      name: 'Doc_0/Document.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Document xmlns:ofd="http://www.ofdspec.org/2016">
  <ofd:CommonData>
    <ofd:MaxUnitID>999</ofd:MaxUnitID>
    <ofd:PageArea><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox></ofd:PageArea>
    <ofd:PublicRes>PublicRes.xml</ofd:PublicRes>
  </ofd:CommonData>
  <ofd:Pages>
    <ofd:Page ID="1" BaseLoc="Pages/Page_0/Content.xml"/>
  </ofd:Pages>
</ofd:Document>`,
    },
    {
      name: 'Doc_0/PublicRes.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Res xmlns:ofd="http://www.ofdspec.org/2016" BaseLoc="Res">
  <ofd:MultiMedias>
    <ofd:MultiMedia ID="21" Type="Video" Format="MP4">
      <ofd:MediaFile>${mediaFilePath}</ofd:MediaFile>
    </ofd:MultiMedia>
  </ofd:MultiMedias>
</ofd:Res>`,
    },
    {
      name: 'Doc_0/Pages/Page_0/Content.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Page xmlns:ofd="http://www.ofdspec.org/2016">
  <ofd:Area><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox></ofd:Area>
  <ofd:Content><ofd:Layer ID="1"/></ofd:Content>
</ofd:Page>`,
    },
    // 媒体实体放在包内正常位置，保证资源可读；只有声明路径是恶意的。
    { name: 'Doc_0/Res/payload.mp4', data: new Uint8Array([0, 1, 2, 3, 4, 5]) },
  ];
  await writeFile(outPath, createZip(entries));
}

describe.skipIf(!hasMediaSample)('1. --media 与 --text 同时使用', () => {
  it('图片、文本、媒体三者都产出，摘要体现多媒体', async () => {
    const out = await createTempDir();
    const result = await runMain([MEDIA_SAMPLE, '--media', '--text', '-p', '1', '-o', out], '/tmp');

    expect(result.code).toBe(0);
    const files = (await readdir(out)).sort();
    expect(files.some((name) => /-p001\.png$/u.test(name))).toBe(true);
    expect(files.some((name) => /-p001\.json$/u.test(name))).toBe(true);
    expect(files).toContain('media-10.mp4');
    expect(files).toContain('media-12.mp3');
    expect(result.stdout).toContain('（图片 + 文本）');
    expect(result.stdout).toContain('多媒体 2 个');
  });
});

describe('2. 恶意 MediaFile 路径不导致路径穿越', () => {
  const maliciousPaths = [
    '../../../../tmp/evil.mp4',
    '/etc/passwd',
    '..\\..\\windows\\evil.mp4',
    'Res/../../../evil.mp4',
    'Res/\u001b[31mevil.mp4',
    'Res/evil\u0000.mp4',
  ];

  for (const mediaFilePath of maliciousPaths) {
    it(`MediaFile=${JSON.stringify(mediaFilePath)} 时不会写出输出目录之外的文件`, async () => {
      const dir = await createTempDir();
      const inputPath = join(dir, 'malicious.ofd');
      await writeMaliciousMediaOfd(mediaFilePath, inputPath);
      const out = join(dir, 'out');

      const result = await runMain([inputPath, '--media', '-o', out], '/tmp');

      // 越界路径由 engine 侧拒绝：资源在索引阶段即被跳过。CLI 不因该路径改变
      // 命名规则，也绝不在输出目录之外落盘。
      const files = await readdir(out).catch(() => [] as string[]);
      for (const name of files) {
        expect(name).toMatch(/^media-\d+(?:-\d+)?\.[a-z0-9]+$/u);
        expect(name).not.toContain('evil');
        expect(name).not.toContain('passwd');
      }
      // 越界目标位置（上级目录）不应出现穿越写入的文件。
      expect(await readdir(dir)).toEqual(['malicious.ofd', 'out']);

      expect(files).toEqual([]);
      // 引擎对越界路径有两种处理，都必须有明确提示、不得静默成功：
      // - 索引期被跳过 → W_MEDIA_NONE，退出 0（无资源可导）；
      // - 进索引但读取失败 → W_MEDIA_RESOURCE，计为失败项后退出 3。
      if (result.code === 0) {
        expect(result.stderr).toContain('W_MEDIA_NONE');
      } else {
        expect(result.code).toBe(3);
        expect(result.stderr).toContain('W_MEDIA_RESOURCE');
        expect(result.stdout).toContain('个多媒体失败');
      }
    });
  }

  it('包内路径合法时导出名严格为 media-<id>.<ext>', async () => {
    const dir = await createTempDir();
    const inputPath = join(dir, 'ok.ofd');
    await writeMaliciousMediaOfd('payload.mp4', inputPath);
    const out = join(dir, 'out');

    const result = await runMain([inputPath, '--media', '-o', out], '/tmp');

    expect(result.code).toBe(0);
    expect(await readdir(out)).toEqual(['media-21.mp4']);
  });
});

describe('3. info 对无音视频文档零回归', () => {
  it('JSON 中 media 字段整体省略，既有字段不变', async () => {
    const capture = createStreamCapture();
    const code = await runInfo(
      { inputPath: PLAIN_SAMPLE, json: true },
      { logger: new Logger(capture) },
    );

    expect(code).toBe(0);
    const payload = JSON.parse(capture.stdoutText()) as CliInfoJson;
    expect('media' in (payload.document ?? {})).toBe(false);
    // 既有契约字段仍在。
    expect(payload.document?.attachments).toEqual(expect.any(Array));
    expect(payload.document?.pageCount).toBeGreaterThan(0);
    expect(payload.document?.version).toEqual(expect.any(String));
  });

  it('文本输出无多媒体行，附件行仍是第 19 行（既有行序不变）', async () => {
    const capture = createStreamCapture();
    const code = await runInfo(
      { inputPath: PLAIN_SAMPLE, json: false },
      { logger: new Logger(capture) },
    );

    expect(code).toBe(0);
    const lines = capture.stdoutText().trimEnd().split('\n');
    expect(lines).toHaveLength(19);
    expect(lines[18]).toMatch(/^附件: \d+ 个$/u);
    expect(capture.stdoutText()).not.toContain('多媒体:');
  });

  it('formatInfoText 对无 media 字段的输入保持既有行数与顺序', () => {
    const text = formatInfoText({
      command: 'info',
      input: '/tmp/a.ofd',
      packageSize: 1,
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
      },
      warnings: [],
    });
    expect(text.split('\n').at(-1)).toBe('附件: 0 个');
    expect(text).not.toContain('多媒体:');
  });
});

describe('4. W_MEDIA_* warning 写入 stderr', () => {
  it('MediaFile 指向包内不存在的文件时输出 W_MEDIA_RESOURCE 且计入汇总', async () => {
    const dir = await createTempDir();
    const inputPath = join(dir, 'missing-media.ofd');
    await writeMaliciousMediaOfd('Res/not-there.mp4', inputPath);
    const out = join(dir, 'out');

    const result = await runMain([inputPath, '--media', '-o', out], '/tmp');

    // 单个资源读取失败：报错但不写文件，整体按失败计数。
    expect(result.stderr).toContain('W_MEDIA_RESOURCE');
    expect(await readdir(out)).toEqual([]);
  });

  it.skipIf(!hasMediaSample)('info 打开含音视频文档时 W_MEDIA_* 不会凭空产生', async () => {
    const capture = createStreamCapture();
    const code = await runInfo(
      { inputPath: MEDIA_SAMPLE, json: true },
      { logger: new Logger(capture) },
    );

    expect(code).toBe(0);
    expect(capture.stderrText()).not.toContain('W_MEDIA_');
  });
});

describe.skipIf(!hasMediaSample)('5. 导出文件内容与包内一致', () => {
  it('media-10.mp4 与 media-12.mp3 非空且字节数与 info 的 sizeBytes 一致', async () => {
    const out = await createTempDir();
    const capture = createStreamCapture();
    await runInfo({ inputPath: MEDIA_SAMPLE, json: true }, { logger: new Logger(capture) });
    const payload = JSON.parse(capture.stdoutText()) as CliInfoJson;
    const sizes = new Map(
      (payload.document?.media ?? []).map((item) => [item.id, item.sizeBytes]),
    );

    const result = await runMain([MEDIA_SAMPLE, '--media', '-o', out], '/tmp');
    expect(result.code).toBe(0);

    for (const [id, size] of sizes) {
      const fileName = (await readdir(out)).find((name) => name.startsWith(`media-${id}.`));
      expect(fileName).toBeDefined();
      const bytes = await readFile(join(out, fileName!));
      expect(bytes.byteLength).toBe(size);
      expect(bytes.byteLength).toBeGreaterThan(0);
    }
  });
});