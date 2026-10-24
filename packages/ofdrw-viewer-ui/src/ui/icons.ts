/**
 * 工具栏图标（内联 SVG，24×24 视图框）。
 *
 * 图标只描边 `currentColor`，颜色完全由 CSS 变量控制；所有图标 `aria-hidden`，
 * 可读名称由按钮的 `aria-label` 提供。
 */

import { replaceChildren } from '../compat';

/** 图标名称。 */
export type IconName =
  | 'sidebar'
  | 'previous'
  | 'next'
  | 'zoom-in'
  | 'zoom-out'
  | 'rotate'
  | 'search'
  | 'print'
  | 'export'
  | 'signature'
  | 'shield'
  | 'fullscreen'
  | 'fullscreen-exit'
  | 'info'
  | 'more'
  | 'close';

/** 图标几何定义。 */
interface IconSpec {
  /** 路径 `d`。 */
  readonly paths?: readonly string[];
  /** 圆：[cx, cy, r]。 */
  readonly circles?: readonly (readonly [number, number, number])[];
  /** 线：[x1, y1, x2, y2]。 */
  readonly lines?: readonly (readonly [number, number, number, number])[];
  /** 折线 points。 */
  readonly polylines?: readonly string[];
}

const ICONS: Readonly<Record<IconName, IconSpec>> = Object.freeze({
  sidebar: {
    paths: ['M3 4h18v16H3z', 'M9 4v16'],
  },
  previous: {
    polylines: ['15 18 9 12 15 6'],
  },
  next: {
    polylines: ['9 18 15 12 9 6'],
  },
  'zoom-in': {
    circles: [[11, 11, 7]],
    lines: [
      [21, 21, 16.65, 16.65],
      [11, 8, 11, 14],
      [8, 11, 14, 11],
    ],
  },
  'zoom-out': {
    circles: [[11, 11, 7]],
    lines: [
      [21, 21, 16.65, 16.65],
      [8, 11, 14, 11],
    ],
  },
  rotate: {
    polylines: ['23 4 23 10 17 10'],
    paths: ['M20.49 15a9 9 0 1 1-2.12-9.36L23 10'],
  },
  search: {
    circles: [[11, 11, 7]],
    lines: [[21, 21, 16.65, 16.65]],
  },
  print: {
    polylines: ['6 9 6 2 18 2 18 9'],
    paths: [
      'M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2',
      'M6 14h12v8H6z',
    ],
  },
  export: {
    paths: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'],
    polylines: ['7 10 12 15 17 10'],
    lines: [[12, 15, 12, 3]],
  },
  signature: {
    circles: [[12, 12, 9]],
    paths: ['M8 12l3 3 5-6'],
  },
  shield: {
    paths: ['M12 3l7 3v5c0 5-3.2 8.2-7 10-3.8-1.8-7-5-7-10V6z', 'M9 12l2 2 4-4'],
  },
  fullscreen: {
    paths: [
      'M8 3H5a2 2 0 0 0-2 2v3',
      'M16 3h3a2 2 0 0 1 2 2v3',
      'M21 16v3a2 2 0 0 1-2 2h-3',
      'M8 21H5a2 2 0 0 1-2-2v-3',
    ],
  },
  'fullscreen-exit': {
    paths: [
      'M8 3v3a2 2 0 0 1-2 2H3',
      'M21 8h-3a2 2 0 0 1-2-2V3',
      'M3 16h3a2 2 0 0 1 2 2v3',
      'M16 21v-3a2 2 0 0 1 2-2h3',
    ],
  },
  info: {
    circles: [[12, 12, 9]],
    lines: [[12, 11, 12, 16]],
    paths: ['M12 8h.01'],
  },
  more: {
    paths: ['M5 12h.01M12 12h.01M19 12h.01'],
  },
  close: {
    paths: ['M18 6L6 18M6 6l12 12'],
  },
});

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 创建图标元素。
 *
 * @param name 图标名称。
 * @returns `aria-hidden` 的 SVG 元素。
 */
export function createIcon(name: IconName): SVGSVGElement {
  const doc = document;
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ofd-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'more' ? '3' : '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const spec = ICONS[name];
  for (const d of spec.paths ?? []) {
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  for (const [cx, cy, r] of spec.circles ?? []) {
    const circle = doc.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', String(cx));
    circle.setAttribute('cy', String(cy));
    circle.setAttribute('r', String(r));
    svg.appendChild(circle);
  }
  for (const [x1, y1, x2, y2] of spec.lines ?? []) {
    const line = doc.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(x1));
    line.setAttribute('y1', String(y1));
    line.setAttribute('x2', String(x2));
    line.setAttribute('y2', String(y2));
    svg.appendChild(line);
  }
  for (const points of spec.polylines ?? []) {
    const polyline = doc.createElementNS(SVG_NS, 'polyline');
    polyline.setAttribute('points', points);
    svg.appendChild(polyline);
  }
  return svg;
}

/**
 * 更新已有按钮的图标，保留按钮本身与焦点。
 *
 * @param button 目标按钮。
 * @param name 新图标。
 */
export function setButtonIcon(button: HTMLElement, name: IconName): void {
  const icon = createIcon(name);
  replaceChildren(button, icon);
}