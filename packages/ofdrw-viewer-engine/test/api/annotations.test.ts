/**
 * T14g：Document 声明 Annotations.xml 但读取失败时产生页级 warning。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RecordingRenderer } from '../../src/renderer/recording';
import type { OFDWarning } from '../../src/warnings';
import { buildFixtureOfd, openTestDocument, renderPage } from './helpers';

/** 读取真实样本字节。 */
function sample(name: string): Uint8Array {
  const path = fileURLToPath(new URL(`../../../../ofd_pdf_match/${name}`, import.meta.url));
  return new Uint8Array(readFileSync(path));
}

describe('缺失 Annotations.xml warning', () => {
  it('keyword.ofd 声明缺失的 Annotations.xml：页级 W_ANNOT_EMPTY 带路径且签章仍可渲染', async () => {
    const warnings: OFDWarning[] = [];
    const renderer = new RecordingRenderer();
    const doc = await openTestDocument(sample('keyword.ofd'), {
      renderer,
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      const page = await doc.getPage(0);
      await renderPage(page);
      const pageWarnings = warnings.filter(
        (warning) => warning.code === 'W_ANNOT_EMPTY' && warning.pageIndex === 0,
      );
      expect(pageWarnings).toHaveLength(1);
      expect(pageWarnings[0]?.message).toContain('Doc_0/Annotations.xml');
      // 签章 loader 与注释 warning 共存，页面不发生未捕获错误。
      expect(renderer.calls.some((call) => call.op === 'drawImage')).toBe(true);
    } finally {
      await doc.close();
    }
  });

  it('无注释声明的 h.ofd/hello.ofd 不产生注释误报', async () => {
    for (const name of ['h.ofd', 'hello.ofd']) {
      const warnings: OFDWarning[] = [];
      const doc = await openTestDocument(sample(name), {
        renderer: new RecordingRenderer(),
        onWarning: (warning) => warnings.push(warning),
      });
      try {
        await doc.getPage(0);
        expect(warnings.some((warning) => warning.code === 'W_ANNOT_EMPTY')).toBe(false);
      } finally {
        await doc.close();
      }
    }
  });

  it('正常但为空的 Annotations.xml 不新增 W_ANNOT_EMPTY', async () => {
    const warnings: OFDWarning[] = [];
    const bytes = buildFixtureOfd({
      pages: [{ id: 1, objects: [] }],
      annotations: { files: [], entries: [] },
    });
    const doc = await openTestDocument(bytes, {
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      await doc.getPage(0);
      expect(warnings.some((warning) => warning.code === 'W_ANNOT_EMPTY')).toBe(false);
    } finally {
      await doc.close();
    }
  });

  it('999.ofd 空 Appearance 每次注释只提示一次（模型解码，渲染不重复）', async () => {
    const warnings: OFDWarning[] = [];
    const doc = await openTestDocument(sample('999.ofd'), {
      renderer: new RecordingRenderer(),
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      const page = await doc.getPage(0);
      await renderPage(page);
      const emptyWarnings = warnings.filter((warning) => warning.code === 'W_ANNOT_EMPTY');
      expect(emptyWarnings).toHaveLength(1);
      expect(emptyWarnings[0]?.message).toContain('Appearance 为空');
    } finally {
      await doc.close();
    }
  });
});
