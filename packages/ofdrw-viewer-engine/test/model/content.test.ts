import { describe, expect, it, vi } from 'vitest';
import type { ColorSpaceDef, ResourceId } from '../../src/model/types';
import { decodePageContent } from '../../src/model/decode';
import { leaf, node } from './xml';

/** RGB 8 位颜色空间。 */
const RGB: ColorSpaceDef = { id: '1', type: 'RGB', bitsPerComponent: 8 };

/** 构造页面 XML。 */
function pageNode(children: ReturnType<typeof node>[]) {
  return node('Page', {}, [
    node('Area', {}, [leaf('PhysicalBox', '0 0 210 297')]),
    ...children,
  ]);
}

describe('decodePageContent 基础结构', () => {
  it('解码 Area/PageRes/Template/Layer 与图层顺序', () => {
    const onWarning = vi.fn();
    const root = pageNode([
      leaf('PageRes', 'PageRes.xml'),
      node('Template', { TemplateID: '#7', ZOrder: 'Background' }),
      node('Content', {}, [
        node('Layer', { ID: '1', Type: 'Body', DrawParam: '#5' }, [
          node('PathObject', { ID: '1', Boundary: '0 0 10 10' }),
        ]),
        node('Layer', { ID: '2', Type: 'Weird' }, []),
      ]),
    ]);
    const page = decodePageContent(root, '#1', 'Doc_0/Pages/Page_0/Content.xml', { onWarning });
    expect(page.id).toBe('1');
    expect(page.area).toEqual({ x: 0, y: 0, w: 210, h: 297 });
    expect(page.size).toEqual({ width: 210, height: 297 });
    expect(page.pageRes).toEqual(['Doc_0/Pages/Page_0/PageRes.xml']);
    expect(page.templates).toEqual([{ id: '7', zOrder: 'Background' }]);
    expect(page.layers).toHaveLength(2);
    expect(page.layers[0]?.type).toBe('Body');
    expect(page.layers[0]?.drawParam).toBe('5');
    expect(page.layers[1]?.type).toBe('Body');
    expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({ code: 'W_LAYER_ORDER' }));
  });

  it('PhysicalBox 非零原点 warning，仍取 width/height', () => {
    const onWarning = vi.fn();
    const root = node('Page', {}, [node('Area', {}, [leaf('PhysicalBox', '10 20 100 200')])]);
    const page = decodePageContent(root, '1', 'Doc_0/Content.xml', { onWarning });
    expect(page.area).toEqual({ x: 10, y: 20, w: 100, h: 200 });
    expect(page.size).toEqual({ width: 100, height: 200 });
    expect(onWarning).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'W_PHYSICALBOX_ORIGIN' }),
    );
  });
});

describe('decodePageContent 图元', () => {
  it('TextObject：DeltaX g 组、\\XXXX 转义、CGTransform 兄弟/内部/属性', () => {
    const text = node('TextObject', {
      ID: '1',
      Boundary: '0 0 50 10',
      Font: '#1',
      Size: '10',
      Alpha: '128',
      Fill: 'true',
      HScale: '1.2',
    }, [
      node('CGTransform', { CodecPosition: '0', CodecCount: '2' }, [leaf('Glyphs', '3 4')]),
      node('TextCode', { X: '1', Y: '2', DeltaX: 'g 2 1.5', DeltaY: '0 -2' }, [], '\\4E2D A'),
      node('TextCode', { CodePosition: '2', CodeCount: '1', Glyphs: '9' }, [], 'B'),
    ]);
    const root = pageNode([node('Content', {}, [node('Layer', {}, [text])])]);
    const page = decodePageContent(root, '1', 'Doc_0/Content.xml');
    const object = page.layers[0]?.children[0];
    expect(object?.kind).toBe('text');
    if (object?.kind !== 'text') return;
    expect(object.font).toBe('1');
    expect(object.size).toBe(10);
    expect(object.alpha).toBe(128);
    expect(object.hScale).toBe(1.2);
    expect(object.codes[0]?.text).toBe('中 A');
    expect(object.codes[0]?.deltaX).toEqual([1.5, 1.5]);
    expect(object.codes[0]?.deltaY).toEqual([0, -2]);
    expect(object.codes[0]?.cgTransforms[0]).toEqual({
      codePosition: 0,
      codeCount: 2,
      glyphCount: 2,
      glyphs: [3, 4],
    });
    expect(object.codes[1]?.cgTransforms[0]).toMatchObject({
      codePosition: 2,
      codeCount: 1,
      glyphs: [9],
    });
  });

  it('PathObject：负 Boundary 归一化、Even-Odd、颜色空间解析', () => {
    const onWarning = vi.fn();
    const path = node('PathObject', {
      ID: '2',
      Boundary: '10 0 -5 20',
      Fill: 'true',
      Stroke: 'false',
      Rule: 'Even-Odd',
      LineWidth: '0.5',
      Cap: 'Round',
      Join: 'Bevel',
    }, [
      leaf('AbbreviatedData', 'M 0 0 L 10 10'),
      node('FillColor', { Value: '#FF0000', ColorSpace: '#1', Alpha: '128' }),
    ]);
    const root = pageNode([node('Content', {}, [node('Layer', {}, [path])])]);
    const page = decodePageContent(root, '1', 'Doc_0/Content.xml', {
      onWarning,
      colorSpaces: new Map<ResourceId, ColorSpaceDef>([['1', RGB]]),
    });
    const object = page.layers[0]?.children[0];
    expect(object?.kind).toBe('path');
    if (object?.kind !== 'path') return;
    expect(object.boundary).toEqual({ x: 5, y: 0, w: 5, h: 20 });
    expect(object.fill).toBe(true);
    expect(object.stroke).toBe(false);
    expect(object.rule).toBe('evenodd');
    expect(object.lineWidth).toBe(0.5);
    expect(object.cap).toBe('Round');
    expect(object.join).toBe('Bevel');
    expect(object.fillColor).toEqual({ type: 'color', color: { r: 255, g: 0, b: 0, a: 128 } });
    expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({ code: 'W_NEGATIVE_BOUNDARY' }));
  });

  it('ImageObject：ResourceID/Substitution/ImageMask/Border', () => {
    const image = node('ImageObject', {
      ID: '3',
      Boundary: '0 0 10 20',
      ResourceID: '#9',
      Substitution: '#10',
      ImageMask: '11',
    }, [
      node('Border', { LineWidth: '0.2', HorizonalCornerRadius: '1', VerticalCornerRadius: '2' }, [
        node('BorderColor', { Value: '0 128 255', ColorSpace: '1' }),
      ]),
    ]);
    const root = pageNode([node('Content', {}, [node('Layer', {}, [image])])]);
    const page = decodePageContent(root, '1', 'Doc_0/Content.xml', {
      colorSpaces: new Map<ResourceId, ColorSpaceDef>([['1', RGB]]),
    });
    const object = page.layers[0]?.children[0];
    expect(object?.kind).toBe('image');
    if (object?.kind !== 'image') return;
    expect(object.resourceId).toBe('9');
    expect(object.substitution).toBe('10');
    expect(object.imageMask).toBe('11');
    expect(object.border).toEqual({
      lineWidth: 0.2,
      horizontalRadius: 1,
      verticalRadius: 2,
      dashOffset: 0,
      dashPattern: [],
      color: { r: 0, g: 128, b: 255, a: 255 },
    });
  });

  it('PageBlock 嵌套与未知节点忽略', () => {
    const block = node('PageBlock', { ID: '5' }, [
      node('TextObject', { Boundary: '0 0 1 1', Font: '1', Size: '1' }),
      node('Unknown', {}, []),
    ]);
    const root = pageNode([node('Content', {}, [node('Layer', {}, [block])])]);
    const page = decodePageContent(root, '1', 'Doc_0/Content.xml');
    const object = page.layers[0]?.children[0];
    expect(object?.kind).toBe('block');
    if (object?.kind !== 'block') return;
    expect(object.children).toHaveLength(1);
    expect(object.children[0]?.kind).toBe('text');
  });

  it('Clips：Area.CTM 折叠进裁剪对象，多个 Clip 保留', () => {
    const path = node('PathObject', { ID: '1', Boundary: '0 0 10 10', Fill: 'true' }, [
      node('Clips', {}, [
        node('Clip', {}, [
          node('Area', { CTM: '2 0 0 2 10 20' }, [
            node('Path', { Boundary: '1 2 10 10', CTM: '3 0 0 3 0 0' }, [leaf('AbbreviatedData', 'M 0 0 L 1 1')]),
          ]),
        ]),
        node('Clip', {}, [node('Area', {}, [node('Text', { Boundary: '0 0 5 5', Font: '1', Size: '1' })])]),
      ]),
    ]);
    const root = pageNode([node('Content', {}, [node('Layer', {}, [path])])]);
    const page = decodePageContent(root, '1', 'Doc_0/Content.xml');
    const object = page.layers[0]?.children[0];
    expect(object?.kind).toBe('path');
    if (object?.kind !== 'path') return;
    expect(object.clips).toHaveLength(2);
    const area = object.clips?.[0]?.areas[0];
    expect(area?.kind).toBe('path');
    if (area?.kind !== 'path') return;
    expect(area.path.boundary).toEqual({ x: 12, y: 24, w: 10, h: 10 });
    expect(area.path.ctm).toEqual([6, 0, 0, 6, 10, 20]);
  });
});