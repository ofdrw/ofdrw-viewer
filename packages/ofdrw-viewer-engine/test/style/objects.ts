import type { Box } from '../../src/common/types';
import type {
  CompositeObject,
  ImageObject,
  Layer,
  PageModel,
  PathObject,
  TextObject,
} from '../../src/model/types';

/** 默认边界。 */
export const BOX: Box = { x: 0, y: 0, w: 10, h: 10 };

/**
 * 构造文本对象。
 *
 * @param overrides 覆盖字段。
 * @returns 文本对象；单位 mm。
 */
export function makeText(overrides: Partial<TextObject> = {}): TextObject {
  return {
    kind: 'text',
    boundary: { ...BOX },
    alpha: 255,
    visible: true,
    font: '1',
    size: 10,
    hScale: 1,
    readDirection: 0,
    charDirection: 0,
    weight: 400,
    italic: false,
    fill: true,
    stroke: false,
    codes: [],
    ...overrides,
  };
}

/**
 * 构造路径对象。
 *
 * @param overrides 覆盖字段。
 * @returns 路径对象；单位 mm。
 */
export function makePath(overrides: Partial<PathObject> = {}): PathObject {
  return {
    kind: 'path',
    boundary: { ...BOX },
    alpha: 255,
    visible: true,
    data: 'M 0 0 L 10 10',
    fill: false,
    stroke: true,
    rule: 'nonzero',
    ...overrides,
  };
}

/**
 * 构造图片对象。
 *
 * @param overrides 覆盖字段。
 * @returns 图片对象。
 */
export function makeImage(overrides: Partial<ImageObject> = {}): ImageObject {
  return {
    kind: 'image',
    boundary: { ...BOX },
    alpha: 255,
    visible: true,
    resourceId: '1',
    ...overrides,
  };
}

/**
 * 构造复合对象。
 *
 * @param overrides 覆盖字段。
 * @returns 复合对象。
 */
export function makeComposite(overrides: Partial<CompositeObject> = {}): CompositeObject {
  return {
    kind: 'composite',
    boundary: { ...BOX },
    alpha: 255,
    visible: true,
    resourceId: '1',
    ...overrides,
  };
}

/**
 * 构造页面模型。
 *
 * @param layers 图层。
 * @returns 页面模型；页尺寸 210×297 mm。
 */
export function makePage(layers: Layer[]): PageModel {
  return {
    id: '1',
    area: { x: 0, y: 0, w: 210, h: 297 },
    size: { width: 210, height: 297 },
    layers,
    templates: [],
    pageRes: [],
  };
}