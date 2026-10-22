/**
 * 轻量页面区域读取：缺失 Area/PhysicalBox 不在解码阶段 warning，
 * 页尺寸回退 warning 统一由 resolvePageArea 在最终 A4 时产生。
 */

import { describe, expect, it, vi } from 'vitest';
import { decodePageAreaXml } from '../../src/model/page-info';

/** 把字符串编码为 UTF-8 字节。 */
function bytes(xml: string): Uint8Array {
  return new TextEncoder().encode(xml);
}

describe('decodePageAreaXml', () => {
  it('缺少 Area/PhysicalBox 时不产生 W_BAD_NUMBER，并保留模板引用', () => {
    const onWarning = vi.fn();
    const info = decodePageAreaXml(
      bytes(
        '<ofd:Page xmlns:ofd="http://www.ofdspec.org/2016">' +
          '<ofd:Template TemplateID="9" ZOrder="Background" />' +
          '<ofd:Content /></ofd:Page>',
      ),
      '10',
      onWarning,
    );

    expect(info.area).toBeUndefined();
    expect(info.templates).toEqual([{ id: '9' }]);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('显式 PhysicalBox 宽高非正仍按原语义 warning', () => {
    const onWarning = vi.fn();
    const info = decodePageAreaXml(
      bytes(
        '<ofd:Page xmlns:ofd="http://www.ofdspec.org/2016">' +
          '<ofd:Area><ofd:PhysicalBox>0 0 0 297</ofd:PhysicalBox></ofd:Area>' +
          '<ofd:Content /></ofd:Page>',
      ),
      '10',
      onWarning,
    );

    expect(info.area).toEqual({ x: 0, y: 0, w: 0, h: 297 });
    expect(onWarning).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'W_BAD_NUMBER' }),
    );
  });

  it('PhysicalBox 原点非零仍按原语义 warning', () => {
    const onWarning = vi.fn();
    const info = decodePageAreaXml(
      bytes(
        '<ofd:Page xmlns:ofd="http://www.ofdspec.org/2016">' +
          '<ofd:Area><ofd:PhysicalBox>10 20 210 297</ofd:PhysicalBox></ofd:Area>' +
          '<ofd:Content /></ofd:Page>',
      ),
      '10',
      onWarning,
    );

    expect(info.area).toEqual({ x: 10, y: 20, w: 210, h: 297 });
    expect(onWarning).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'W_PHYSICALBOX_ORIGIN' }),
    );
  });
});