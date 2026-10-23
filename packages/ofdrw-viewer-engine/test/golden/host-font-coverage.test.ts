import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createZip } from '../fixtures/zip-builder';
import { inspectHostFontCoverage, requestedOfdFontFamilies } from './lib/host-font-coverage';

/** 构造一个最小 OFD 包（只含字体声明，不要求可渲染）。 */
function createOfdFixture(publicResXml: string): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'ofd-font-coverage-'));
  const path = join(directory, 'fixture.ofd');
  const zip = createZip([
    { name: 'OFD.xml', data: '<ofd:OFD/>' },
    { name: 'Doc_0/PublicRes.xml', data: publicResXml },
  ]);
  writeFileSync(path, zip.bytes);
  return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

describe('宿主字体覆盖诊断', () => {
  it('提取非内嵌字体族，跳过 FontFile 内嵌字体', () => {
    const fixture = createOfdFixture(`<ofd:PublicRes xmlns:ofd="http://www.ofdspec.org/2016">
      <ofd:Fonts>
        <ofd:Font FontName="楷体" FamilyName="楷体" ID="45"/>
        <ofd:Font FontName="SimSun" FamilyName="宋体" ID="46"><ofd:FontFile>font_46.ttf</ofd:FontFile></ofd:Font>
      </ofd:Fonts>
    </ofd:PublicRes>`);
    try {
      expect(requestedOfdFontFamilies(fixture.path)).toEqual(['楷体']);
      const coverage = inspectHostFontCoverage(fixture.path, ['Noto Sans CJK SC']);
      expect(coverage.missing).toEqual(['楷体']);
    } finally {
      fixture.cleanup();
    }
  });

  it('KaiTi/STKaiti 别名可覆盖楷体请求，Tahoma/Courier 按原名匹配', () => {
    const fixture = createOfdFixture(`<ofd:PublicRes xmlns:ofd="http://www.ofdspec.org/2016">
      <ofd:Fonts>
        <ofd:Font FontName="KaiTi" FamilyName="楷体" ID="1"/>
        <ofd:Font FontName="Tahoma" FamilyName="Tahoma" ID="2"/>
        <ofd:Font FontName="Courier New" FamilyName="Courier New" ID="3"/>
      </ofd:Fonts>
    </ofd:PublicRes>`);
    try {
      const coverage = inspectHostFontCoverage(fixture.path, ['KaiTi', 'Tahoma', 'Courier New']);
      expect(coverage.missing).toEqual([]);
      const byStKaiti = inspectHostFontCoverage(fixture.path, ['STKaiti', 'Tahoma', 'Courier New']);
      expect(byStKaiti.missing).toEqual([]);
      const missingAll = inspectHostFontCoverage(fixture.path, []);
      expect(missingAll.missing).toHaveLength(3);
    } finally {
      fixture.cleanup();
    }
  });

  it('非 OFD/损坏包安全降级为空覆盖', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ofd-font-coverage-broken-'));
    const path = join(directory, 'broken.ofd');
    writeFileSync(path, 'not a zip');
    try {
      expect(() => inspectHostFontCoverage(path, ['KaiTi'])).not.toThrow();
      expect(inspectHostFontCoverage(path, ['KaiTi']).missing).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});