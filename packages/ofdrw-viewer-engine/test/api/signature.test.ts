/**
 * T14c 签章 API 接线：Signatures.xml/Seal.esl 通过 PreparePageLoader 进入页面渲染。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ZipReader } from '../../src/container/zip-reader';
import { RecordingRenderer } from '../../src/renderer/recording';
import type { OFDWarning } from '../../src/warnings';
import { nodeImageDecoders } from '../helpers/node-image-decoder';
import { buildFixtureOfd, openTestDocument, renderPage } from './helpers';

/** 读取样本字节。 */
function sample(name: string): Uint8Array {
  const path = fileURLToPath(new URL(`../../../../ofd_pdf_match/${name}`, import.meta.url));
  return new Uint8Array(readFileSync(path));
}

/** 收集渲染器中的图片绘制调用。 */
function drawCalls(renderer: RecordingRenderer): Array<{ width: number; height: number }> {
  return renderer.calls.flatMap((call) =>
    call.op === 'drawImage' ? [{ width: call.transform[0] ?? 0, height: call.transform[3] ?? 0 }] : [],
  );
}

describe('签章 API 接线', () => {
  it('h.ofd 通过 loader 读取 Seal.esl 并绘制 2 个印章', async () => {
    const warnings: OFDWarning[] = [];
    const renderer = new RecordingRenderer();
    const readEntry = vi.spyOn(ZipReader.prototype, 'readEntry');
    const doc = await openTestDocument(sample('h.ofd'), {
      renderer,
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      const page = await doc.getPage(0);
      await renderPage(page);
      expect(drawCalls(renderer)).toEqual([
        { width: 40, height: 40 },
        { width: 40, height: 40 },
      ]);
      expect(readEntry.mock.calls.some(([path]) => path === 'Doc_0/Signs/Signatures.xml')).toBe(true);
      expect(readEntry.mock.calls.some(([path]) => /Seal\.esl$/i.test(path))).toBe(true);
      expect(warnings.some((warning) => warning.code === 'W_IMAGE_DECODE')).toBe(false);
    } finally {
      readEntry.mockRestore();
      await doc.close();
    }
  });

  it('hello.ofd 无 Signatures.xml：不读取签章条目且不绘制印章', async () => {
    const warnings: OFDWarning[] = [];
    const renderer = new RecordingRenderer();
    const readEntry = vi.spyOn(ZipReader.prototype, 'readEntry');
    const doc = await openTestDocument(sample('hello.ofd'), {
      renderer,
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      await renderPage(await doc.getPage(0));
      expect(drawCalls(renderer)).toEqual([]);
      expect(readEntry.mock.calls.some(([path]) => /Signs|Seal\.esl/i.test(path))).toBe(false);
      expect(warnings.some((warning) => /签章|Seal/i.test(warning.message))).toBe(false);
    } finally {
      readEntry.mockRestore();
      await doc.close();
    }
  });

  it('同一页重复渲染复用已解码 Seal 图片', async () => {
    const png = nodeImageDecoders.find((decoder) => decoder.format === 'png');
    if (!png) throw new Error('测试环境缺少 PNG 解码器');
    let decodes = 0;
    const countingDecoder = {
      format: 'png',
      decode: async (data: Uint8Array) => {
        decodes += 1;
        return png.decode(data);
      },
    };
    const doc = await openTestDocument(sample('h.ofd'), {
      renderer: new RecordingRenderer(),
      imageDecoders: [countingDecoder],
    });
    try {
      const page = await doc.getPage(0);
      await renderPage(page);
      await renderPage(page);
      expect(decodes).toBe(2);
    } finally {
      await doc.close();
    }
  });

  it('Seal 图片解码失败只 warning，页面继续渲染', async () => {
    const warnings: OFDWarning[] = [];
    const renderer = new RecordingRenderer();
    const doc = await openTestDocument(sample('h.ofd'), {
      renderer,
      imageDecoders: [],
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      const page = await doc.getPage(0);
      await expect(renderPage(page)).resolves.toBeDefined();
      expect(warnings.some((warning) => warning.code === 'W_IMAGE_DECODE')).toBe(true);
      expect(drawCalls(renderer)).toEqual([]);
    } finally {
      await doc.close();
    }
  });

  it('Signatures.xml 损坏时 warning 后继续渲染页面', async () => {
    const warnings: OFDWarning[] = [];
    const bytes = buildFixtureOfd({
      pages: [{ id: 1, widthMm: 80, heightMm: 120, objects: [] }],
      extraEntries: [{ name: 'Doc_0/Signs/Signatures.xml', data: '<ofd:Signatures' }],
    });
    const renderer = new RecordingRenderer();
    const doc = await openTestDocument(bytes, {
      renderer,
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      const page = await doc.getPage(0);
      await expect(renderPage(page)).resolves.toBeDefined();
      expect(warnings.some((warning) => warning.code === 'W_BAD_NUMBER' && warning.message.includes('签章索引'))).toBe(true);
    } finally {
      await doc.close();
    }
  });
});
