/**
 * 选区与复制（设计方案 §9.3）。
 *
 * 使用浏览器原生 Selection：文本层 span 是真实 DOM 文本，跨 item/跨页选择由浏览器
 * 维护。读取选区文本时按 span 几何补回分隔符（中文不插空格、英文单词间保留空格、
 * 换行保留段落），再合并行内多余空白。
 *
 * 查找高亮位于独立覆盖层（`pointer-events: none`），不进入 DOM 选区，因此复制不受
 * 高亮影响。
 */

import { runMicrotask } from '../compat';

import { createFeatureDisabledError, OFDViewerError } from '../errors';
import { isCjkChar, normalizeSelectionText } from './geometry';
import type { TextViewerHost, ViewerBridge } from './viewer-bridge';

/** 选区片段；用于按几何关系拼接文本。 */
interface SelectedFragment {
  /** 片段文本。 */
  readonly text: string;
  /** 页码，1-based。 */
  readonly pageNumber: number;
  /** 文本框左边，单位 CSS px。 */
  readonly x: number;
  /** 文本框上边，单位 CSS px。 */
  readonly top: number;
  /** 字号，单位 CSS px。 */
  readonly size: number;
  /** 文本方向，单位弧度。 */
  readonly angle: number;
}

/** 选区管理器。 */
export class SelectionManager {
  private readonly host: TextViewerHost;
  private readonly bridge: ViewerBridge;
  /** 选区变化合并标记。 */
  private queued = false;
  /** 最近一次发布的选区文本，避免重复事件。 */
  private lastText = '';
  /** 宿主文档；用于监听 selectionchange。 */
  private readonly doc: Document | null;
  private readonly root: HTMLElement | null;
  private readonly cleanup: () => void;

  /**
   * @param host 阅读器能力集合。
   * @param bridge 核心状态/事件桥。
   */
  constructor(host: TextViewerHost, bridge: ViewerBridge) {
    this.host = host;
    this.bridge = bridge;
    this.root = host.getRoot?.() ?? null;
    this.doc =
      this.root?.ownerDocument ??
      (typeof document !== 'undefined' ? document : null);
    const listener = (): void => this.scheduleSelectionChange();
    if (this.doc && typeof this.doc.addEventListener === 'function') {
      this.doc.addEventListener('selectionchange', listener);
      this.cleanup = () => this.doc?.removeEventListener('selectionchange', listener);
    } else {
      this.cleanup = () => undefined;
    }
  }

  /**
   * 读取当前选区文本。
   *
   * @returns 规范化文本；无选区时为空字符串。
   * @throws {OFDViewerError} `features.selection=false` 时抛 `OFD_FEATURE_DISABLED`。
   */
  getSelectedText(): string {
    this.assertSelection();
    const selection = this.doc?.getSelection?.() ?? null;
    if (!selection || selection.rangeCount === 0) return '';
    const range = selection.getRangeAt(0);
    if (range.collapsed) return '';
    if (!this.isSelectionInsideViewer(selection)) return '';
    const fragments = this.collectFragments(range);
    if (fragments.length === 0) return normalizeSelectionText(selection.toString());
    return normalizeSelectionText(joinFragments(fragments));
  }

  /**
   * 复制当前选区；优先异步剪贴板，回退 `execCommand('copy')`。
   *
   * @throws {OFDViewerError} 功能关闭或剪贴板不可用时抛出。
   */
  async copySelection(): Promise<void> {
    this.assertSelection();
    const text = this.getSelectedText();
    if (text.length === 0) return;
    try {
      const clipboard =
        typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
      if (clipboard?.writeText) {
        await clipboard.writeText(text);
        return;
      }
    } catch {
      // 回退到 execCommand。
    }
    if (this.doc && copyWithExecCommand(this.doc, text)) return;
    throw new OFDViewerError('OFD_CLIPBOARD_FAILED', '当前环境不支持剪贴板');
  }

  /** 清除选区。 */
  clearSelection(): void {
    this.assertSelection();
    const selection = this.doc?.getSelection?.() ?? null;
    if (!selection) return;
    if (selection.rangeCount > 0) selection.removeAllRanges();
    if (this.lastText !== '') {
      this.lastText = '';
      this.bridge.publishSelection('');
    }
  }

  /** 释放 selectionchange 监听。 */
  destroy(): void {
    this.cleanup();
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /** 合并选区变化事件，避免拖选时每像素都写状态。 */
  private scheduleSelectionChange(): void {
    if (this.queued) return;
    this.queued = true;
    runMicrotask(() => {
      this.queued = false;
      this.publishSelectionChange();
    });
  }

  /** 发布选区变化；选区不在阅读器内时忽略。 */
  private publishSelectionChange(): void {
    if (!this.host.isFeatureEnabled('selection')) return;
    if (!this.host.isFeatureEnabled('textLayer')) return;
    const selection = this.doc?.getSelection?.() ?? null;
    if (!selection || selection.rangeCount === 0) {
      if (this.lastText !== '') {
        this.lastText = '';
        this.bridge.publishSelection('');
      }
      return;
    }
    if (selection.isCollapsed) {
      if (this.lastText !== '') {
        this.lastText = '';
        this.bridge.publishSelection('');
      }
      return;
    }
    if (!this.isSelectionInsideViewer(selection)) return;
    const text = this.getSelectedText();
    if (text === this.lastText) return;
    this.lastText = text;
    this.bridge.publishSelection(text);
  }

  /** 判断选区锚点/焦点是否落在阅读器根节点内。 */
  private isSelectionInsideViewer(selection: Selection): boolean {
    if (!this.root) return true;
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    if (!anchor && !focus) return false;
    return (
      (!!anchor && this.root.contains(anchor)) ||
      (!!focus && this.root.contains(focus))
    );
  }

  /**
   * 收集选区覆盖的文本片段。
   *
   * 使用 `comparePoint` 判断文本节点与 Range 的相对位置，只有文本节点端点都可能
   * 落在 Range 内时才读取偏移，避免依赖具体浏览器对块级序列化的差异。
   */
  private collectFragments(range: Range): SelectedFragment[] {
    const fragments: SelectedFragment[] = [];
    for (const view of this.host.getPageViews()) {
      if (view.isDestroyed || !view.textLayer) continue;
      const spans = view.textLayer.querySelectorAll<HTMLElement>(
        '.ofd-text-item, .ofd-text-char',
      );
      for (const span of spans) {
        const textNode = firstTextNode(span);
        if (!textNode) continue;
        const text = textNode.data;
        if (text.length === 0) continue;
        if (!intersects(range, textNode)) continue;
        const start = boundaryOffset(range, span, textNode, text.length, true);
        const end = boundaryOffset(range, span, textNode, text.length, false);
        if (start === null || end === null || end <= start) continue;
        const left = Number(span.dataset.x ?? '0');
        const top = Number(span.dataset.y ?? '0');
        const size = Number(span.dataset.size ?? '0');
        const angle = Number(span.dataset.angle ?? '0');
        fragments.push({
          text: text.slice(start, end),
          pageNumber: view.pageNumber,
          x: Number.isFinite(left) ? left : 0,
          top: Number.isFinite(top) ? top : 0,
          size: Number.isFinite(size) && size > 0 ? size : 1,
          angle: Number.isFinite(angle) ? angle : 0,
        });
      }
    }
    return fragments;
  }

  /** 断言选区功能可用。 */
  private assertSelection(): void {
    if (!this.host.isFeatureEnabled('selection')) {
      throw createFeatureDisabledError('selection');
    }
    if (!this.host.isFeatureEnabled('textLayer')) {
      throw createFeatureDisabledError('textLayer');
    }
  }
}

/** 读取 span 内的第一个文本节点。 */
function firstTextNode(element: HTMLElement): Text | null {
  const node = element.firstChild;
  return node && node.nodeType === 3 ? (node as Text) : null;
}

/** 判断文本节点是否与 Range 相交；不支持 intersectsNode 时按保守方式处理。 */
function intersects(range: Range, node: Text): boolean {
  if (typeof range.intersectsNode === 'function') return range.intersectsNode(node);
  return true;
}

/**
 * 计算 Range 在文本节点内的端点偏移。
 *
 * @param range 选区范围。
 * @param span 文本 span（Range 端点可能落在元素容器上）。
 * @param node 文本节点。
 * @param length 文本长度。
 * @param isStart 是否求起点；false 求终点。
 * @returns 偏移；节点不在选区内时返回 null。
 */
function boundaryOffset(
  range: Range,
  span: HTMLElement,
  node: Text,
  length: number,
  isStart: boolean,
): number | null {
  const container = isStart ? range.startContainer : range.endContainer;
  const offset = isStart ? range.startOffset : range.endOffset;
  if (container === node) return Math.min(length, Math.max(0, offset));
  if (container === span) {
    if (isStart) return offset <= 0 ? 0 : length;
    return offset <= 0 ? 0 : length;
  }
  if (typeof range.comparePoint !== 'function') {
    return isStart ? 0 : length;
  }
  const atStart = range.comparePoint(node, 0);
  const atEnd = range.comparePoint(node, length);
  if (isStart) {
    if (atStart > 0) return null;
    if (atEnd < 0) return null;
    return atStart === -1 ? 0 : 0;
  }
  if (atStart > 0) return null;
  if (atEnd < 0) return null;
  return atEnd === 1 ? length : length;
}

/**
 * 按几何关系拼接片段。
 *
 * - 不同页：换行；
 * - 同一页不同行：换行；
 * - 同一行：中文/全角之间不插空格，拉丁字符之间补一个空格；
 * - 片段本身已带空白：不重复插入。
 */
function joinFragments(fragments: readonly SelectedFragment[]): string {
  let output = '';
  let previous: SelectedFragment | null = null;
  for (const fragment of fragments) {
    if (!previous) {
      output = fragment.text;
      previous = fragment;
      continue;
    }
    let separator = '';
    if (fragment.pageNumber !== previous.pageNumber) {
      separator = '\n';
    } else {
      const size = Math.max(previous.size, fragment.size);
      // 用垂直于文本方向的距离判断是否同一行，兼容横排、竖排与任意旋转。
      const perpendicular =
        -Math.sin(previous.angle) * (fragment.x - previous.x) +
        Math.cos(previous.angle) * (fragment.top - previous.top);
      const sameLine = Math.abs(perpendicular) <= size * 0.6;
      if (!sameLine) {
        separator = '\n';
      } else if (/\s$/.test(previous.text) || /^\s/.test(fragment.text)) {
        separator = '';
      } else {
        const lastPrev = [...previous.text].pop() ?? '';
        const firstNext = [...fragment.text][0] ?? '';
        separator = isCjkChar(lastPrev) || isCjkChar(firstNext) ? '' : ' ';
      }
    }
    output += separator + fragment.text;
    previous = fragment;
  }
  return output;
}

/** 使用临时 textarea + execCommand 复制；返回是否成功。 */
function copyWithExecCommand(doc: Document, text: string): boolean {
  if (typeof doc.execCommand !== 'function') return false;
  const textarea = doc.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  Object.assign(textarea.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '1px',
    height: '1px',
    opacity: '0',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  doc.body.appendChild(textarea);
  try {
    textarea.select();
    return doc.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}