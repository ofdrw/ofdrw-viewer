import { describe, expect, it, vi } from 'vitest';
import { decodePageResources } from '../../src/model/decode';
import { leaf, node } from './xml';

describe('decodePageResources', () => {
  it('解析 Fonts/MultiMedias/DrawParams/ColorSpaces/Composite，路径相对 BaseLoc', () => {
    const onWarning = vi.fn();
    const root = node('Res', { BaseLoc: 'Res' }, [
      node('ColorSpaces', {}, [
        node('ColorSpace', { ID: '#5', Type: 'GRAY', BitsPerComponent: '8' }, [
          node('Palette', {}, [leaf('CV', '#FF'), leaf('CV', '128')]),
        ]),
      ]),
      node('Fonts', {}, [
        node('Font', {
          ID: '#1',
          FontName: 'SimSun',
          FamilyName: '宋体',
          Charset: 'unicode',
          Serif: 'true',
          Bold: '1',
          Italic: 'false',
          FixedWidth: 'true',
        }, [leaf('FontFile', 'Fonts/simsun.ttf')]),
        node('Font', { ID: '1', FontName: 'duplicate' }, [leaf('FontFile', 'Fonts/x.ttf')]),
      ]),
      node('MultiMedias', {}, [
        node('MultiMedia', { ID: '#2', Type: 'Image', Format: 'PNG' }, [leaf('MediaFile', 'Images/a.png')]),
        node('MultiMedia', { ID: '3', Type: 'Audio' }, [leaf('MediaFile', 'a.mp3')]),
        node('MultiMedia', { ID: '4', Type: 'Image' }, []),
        node('MultiMedia', { ID: '5', Type: 'Image' }, [leaf('MediaFile', '/Doc_0/absolute.jpg')]),
      ]),
      node('DrawParams', {}, [
        node('DrawParam', {
          ID: '#2',
          Relative: '#3',
          LineWidth: '2',
          Cap: 'Round',
          Join: 'Bevel',
          DashPattern: '1 2',
          Alpha: '128',
        }, [
          node('FillColor', { Value: '255 0 0', ColorSpace: '5' }),
        ]),
      ]),
      node('CompositeGraphicUnits', {}, [
        node('CompositeGraphicUnit', { ID: '4', Width: '100', Height: '200' }, [
          node('Content', {}, [
            node('PathObject', { Boundary: '0 0 10 10' }, [leaf('AbbreviatedData', 'M 0 0 L 1 1')]),
          ]),
        ]),
      ]),
    ]);
    const set = decodePageResources(root, 'Doc_0/PageRes.xml', { onWarning });
    expect(set.fonts).toHaveLength(1);
    expect(set.fonts[0]).toMatchObject({
      id: '1',
      fontName: 'SimSun',
      familyName: '宋体',
      charset: 'unicode',
      serif: true,
      bold: true,
      italic: false,
      fixedSize: true,
      fontFile: 'Doc_0/Res/Fonts/simsun.ttf',
    });
    expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({ code: 'W_DUPLICATE_RESOURCE' }));

    expect(set.images.map((image) => image.id)).toEqual(['2', '5']);
    expect(set.images[0]).toEqual({ id: '2', mediaFile: 'Doc_0/Res/Images/a.png', format: 'png' });
    expect(set.images[1]?.mediaFile).toBe('Doc_0/absolute.jpg');
    expect(set.images[1]?.format).toBe('jpeg');

    expect(set.drawParams[0]).toMatchObject({
      id: '2',
      relative: '3',
      lineWidth: 2,
      cap: 'Round',
      join: 'Bevel',
      dashPattern: [1, 2],
      alpha: 128,
    });
    expect(set.drawParams[0]?.fillColor).toEqual({
      type: 'color',
      color: { r: 255, g: 255, b: 255, a: 255 },
    });

    expect(set.colorSpaces[0]).toMatchObject({ id: '5', type: 'GRAY', bitsPerComponent: 8 });
    expect(set.colorSpaces[0]?.palette).toEqual([
      { r: 255, g: 255, b: 255, a: 255 },
      { r: 128, g: 128, b: 128, a: 255 },
    ]);

    expect(set.compositeGraphicUnits[0]?.id).toBe('4');
    expect(set.compositeGraphicUnits[0]?.content.children[0]?.kind).toBe('path');
  });

  it('非法路径/缺少 MediaFile 时 warning 并跳过', () => {
    const onWarning = vi.fn();
    const root = node('Res', { BaseLoc: 'Res' }, [
      node('Fonts', {}, [node('Font', { ID: '1', FontName: 'A' }, [leaf('FontFile', '../../../../escape.ttf')])]),
      node('MultiMedias', {}, [
        node('MultiMedia', { ID: '2', Type: 'Image' }, [leaf('MediaFile', '../../../../escape.png')]),
      ]),
    ]);
    const set = decodePageResources(root, 'Doc_0/PageRes.xml', { onWarning });
    expect(set.fonts).toHaveLength(1);
    expect(set.fonts[0]?.fontFile).toBeUndefined();
    expect(set.images).toHaveLength(0);
    expect(onWarning).toHaveBeenCalled();
  });
});