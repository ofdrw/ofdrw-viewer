/**
 * 选区与复制（设计方案 §9.3、选区高亮块状渲染设计 §6）。
 *
 * 使用浏览器原生 Selection：文本层 span 是真实 DOM 文本，跨 item/跨页选择由浏览器
 * 维护。选区建立时构建 `SelectionModel` 并冻结为 `SelectionSnapshot`：逐字符判定
 * Range 归属，再用文本层缓存的 `TextRow` 反查行标识，按“行不同插入换行、行内按
 * CJK/拉丁规则补空格”拼接文本。之后复制与块状高亮只读快照，页被淘汰、span 被移除
 * 或原生 Selection 折叠都不影响正确性。
 *
 * 行归属是查表而非距离阈值，因此复制结果与高亮/查找使用同一份行划分；文本层未就绪、
 * 引擎未返回字符几何或浏览器缺少 `Range.comparePoint`/`intersectsNode` 时，模型退回
 * `legacy`，沿用旧的 span 几何距离判定，保证功能可用。
 *
 * 查找高亮与后续的选区块高亮均位于独立覆盖层（`pointer-events: none`），不进入 DOM
 * 选区，因此复制不受高亮影响。
 */

import { runMicrotask } from '../compat';

import type { TextQuad } from '@ofdrw/ofdrw-viewer-engine';
import { createFeatureDisabledError, OFDViewerError } from '../errors';
import type {
  CharRef,
  ProjectedRect,
  RowFlowRect,
  SelectionBox,
} from './geometry';
import {
  applyRowGap,
  FLOW_MERGE_EPSILON,
  flowOf,
  isCjkChar,
  mergeFlowIntervals,
  normalizeSelectionText,
  projectQuad,
  SELECTION_ROW_GAP_PX,
  unprojectRect,
} from './geometry';
import type {
  TextViewerHost,
  ViewerBridge,
  ViewerTextLayerServiceLike,
} from './viewer-bridge';

/** 选区端点页 span 超过 pin 预算的警告码。 */
export const W_SELECTION_UNPINNABLE = 'W_SELECTION_UNPINNABLE';

/** 选区覆盖页已无文本/数据、无法保证完整时的警告码。 */
export const W_SELECTION_EVICTED = 'W_SELECTION_EVICTED';

/** 选区几何模型；复制与高亮共同消费。 */
export interface SelectionModel {
  /** 选区片段，按阅读顺序排序。 */
  readonly fragments: readonly SelectionFragment[];
  /** 抽取模式；legacy 表示回退到旧逻辑。 */
  readonly mode: 'vector' | 'legacy';
  /**
   * 选区页区间内没有 span 或没有文本数据的页码（升序，1-based）。
   * 非空表示模型不完整，调用方不得返回部分文本。
   */
  readonly incompletePages?: readonly number[];
}

/** 单个选区片段。 */
export interface SelectionFragment {
  /** 被选中的文本。 */
  readonly text: string;
  /** 页码，1-based。 */
  readonly pageNumber: number;
  /** 所属行的稳定标识；无法判定时为 null。 */
  readonly rowId: string | null;
  /** 字符在 96 DPI 坐标系中的四边形；缺失时无高亮。 */
  readonly quad: TextQuad | null;
  /** 主轴方向，单位弧度。 */
  readonly axisRowRad: number;
  /** 字符所属 TextItem 下标；供后续选区快照消费。 */
  readonly itemIndex?: number;
  /** 字符在 TextItem 内的下标；item 级片段为 null。 */
  readonly charIndex?: number | null;
}

/**
 * 完整选区快照：建立选区时冻结，之后复制与高亮只读本对象。
 *
 * `fragments` 是逐字符的权威数据（页码、item/char 下标、quad、rowId）；`rectsByPage`
 * 是预先按行合并、留缝后的块状高亮矩形，供页被淘汰后直接绘制。快照与 DOM 存活性
 * 无关，布局变化也不重建。
 */
export interface SelectionSnapshot extends SelectionModel {
  /** 规范化后的完整选区文本；与 `getSelectedText()` 返回值一致。 */
  readonly text: string;
  /** 每页已合并、留缝的块状高亮矩形；页坐标 96 DPI。 */
  readonly rectsByPage: ReadonlyMap<number, readonly SelectionBox[]>;
  /** 每页行主轴方向，单位弧度。 */
  readonly axisByPage: ReadonlyMap<number, number>;
  /** 选区覆盖的页码（升序，1-based）。 */
  readonly pageNumbers: readonly number[];
  /** 选区页区间内不可用、导致模型不完整的页码（升序，1-based）。 */
  readonly incompletePages?: readonly number[];
  /** 选区起始页，1-based。 */
  readonly startPage: number;
  /** 选区结束页，1-based。 */
  readonly endPage: number;
  /** 建立快照时的原生锚点/焦点节点及偏移；用于识别 DOM 导致的选区变化。 */
  readonly anchorNode: Node | null;
  readonly focusNode: Node | null;
  readonly anchorOffset: number;
  readonly focusOffset: number;
  /** 快照版本号；每次建立/失效递增，便于诊断。 */
  readonly version: number;
}

/** 内部草稿：片段 + 排序所需的行序号与阅读方向位置。 */
interface FragmentDraft {
  /** 片段文本。 */
  readonly text: string;
  /** 页码，1-based。 */
  readonly pageNumber: number;
  /** 行标识。 */
  readonly rowId: string;
  /** 字符四边形。 */
  readonly quad: TextQuad;
  /** 主轴方向，单位弧度。 */
  readonly axisRowRad: number;
  /** 字符所属 TextItem 下标。 */
  readonly itemIndex: number;
  /** 字符在 TextItem 内的下标。 */
  readonly charIndex: number;
  /** 行在主轴法向上的序号。 */
  readonly rowOrdinal: number;
  /** 字符在阅读推进方向上的起点，单位 px。 */
  readonly flowMin: number;
  /** 采集顺序；用于同位置时的稳定排序。 */
  readonly order: number;
}

/** 旧逻辑的选区片段；仅 `legacy` 模式使用。 */
interface LegacyFragment {
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

/** 行内相邻字符判定为“无间隔”的容差，单位 px。 */
const FLOW_JOIN_EPSILON = 0.5;

/** 回退模型：无片段，复制走旧逻辑。 */
const LEGACY_SELECTION_MODEL: SelectionModel = { fragments: [], mode: 'legacy' };

/** 空选区模型：清空块状高亮，恢复原生选区样式。 */
const EMPTY_SELECTION_MODEL: SelectionModel = { fragments: [], mode: 'vector' };

/** 选区管理器。 */
export class SelectionManager {
  private readonly host: TextViewerHost;
  private readonly bridge: ViewerBridge;
  /** 文本层查询服务；缺失时选区提取走旧逻辑。 */
  private readonly textLayerService: ViewerTextLayerServiceLike | null;
  /** 选区变化合并标记。 */
  private queued = false;
  /** 最近一次发布的选区文本，避免重复事件。 */
  private lastText = '';
  /** 宿主文档；用于监听 selectionchange。 */
  private readonly doc: Document | null;
  private readonly root: HTMLElement | null;
  private readonly cleanups: Array<() => void> = [];
  /** 高亮重绘合并标记。 */
  private highlightQueued = false;
  /** 上一次触发高亮重算的缩放倍率，用于忽略仅滚动引起的 statechange。 */
  private lastScale = Number.NaN;
  /** 上一次触发高亮重算的页旋转角度。 */
  private lastRotation = -1;
  /** 最近一次被接受的选区快照；复制与高亮的唯一权威数据源。 */
  private lastSnapshot: SelectionSnapshot | null = null;
  /** 本模块主动改 DOM 的抑制计数；仅在微任务窗口内非 0。 */
  private suppressDepth = 0;
  /** 快照版本号；每次建立或清空递增。 */
  private snapshotVersion = 0;
  /** 是否已销毁；阻止排队中的微任务在销毁后重建快照。 */
  private destroyed = false;
  /** 最近一次清空快照的原因；诊断与回归测试使用。 */
  private snapshotClearedReason: string | null = null;
  /** 上一次告警的不完整页集合；避免同一选区重复发 warning。 */
  private lastIncompleteKey: string | null = null;

  /**
   * @param host 阅读器能力集合。
   * @param bridge 核心状态/事件桥。
   * @param textLayerService 文本层查询服务；省略时选区提取回退旧逻辑。
   */
  constructor(
    host: TextViewerHost,
    bridge: ViewerBridge,
    textLayerService: ViewerTextLayerServiceLike | null = null,
  ) {
    this.host = host;
    this.bridge = bridge;
    this.textLayerService = textLayerService;
    this.root = host.getRoot?.() ?? null;
    this.doc =
      this.root?.ownerDocument ??
      (typeof document !== 'undefined' ? document : null);
    const listener = (): void => this.scheduleSelectionChange();
    const copyListener = (event: Event): void => this.handleCopy(event);
    const pointerListener = (event: Event): void => this.handlePointerDown(event);
    const keyListener = (event: Event): void => this.handleKeyDown(event);
    const pointerUpListener = (event: Event): void => this.handlePointerUp(event);
    if (this.doc && typeof this.doc.addEventListener === 'function') {
      this.doc.addEventListener('selectionchange', listener);
      this.doc.addEventListener('copy', copyListener, true);
      this.doc.addEventListener('pointerdown', pointerListener, true);
      this.doc.addEventListener('keydown', keyListener, true);
      this.doc.addEventListener('pointerup', pointerUpListener);
      this.cleanups.push(() => {
        this.doc?.removeEventListener('selectionchange', listener);
        this.doc?.removeEventListener('copy', copyListener, true);
        this.doc?.removeEventListener('pointerdown', pointerListener, true);
        this.doc?.removeEventListener('keydown', keyListener, true);
        this.doc?.removeEventListener('pointerup', pointerUpListener);
      });
    }
    // 缩放/旋转、页数据变化、功能开关都可能改变文本层几何或可用性；按当前选区重绘高亮。
    // 滚动也会提交 statechange，但整页构建后文本层节点不再变化；这里用缩放/旋转
    // 变化过滤，避免拖选期间每帧重算字符几何。
    const state = host.getState().view;
    this.lastScale = state.scale;
    this.lastRotation = state.rotation;
    const refresh = (): void => this.scheduleHighlightRefresh();
    this.cleanups.push(
      host.on('statechange', () => {
        const view = host.getState().view;
        if (view.scale === this.lastScale && view.rotation === this.lastRotation) return;
        this.lastScale = view.scale;
        this.lastRotation = view.rotation;
        refresh();
      }),
      host.on('pagesloaded', refresh),
      host.on('featureschange', () => {
        if (!this.selectionAvailable()) this.clearSnapshot('feature');
        else refresh();
      }),
      host.on('documentopen', () => this.clearSnapshot('documentopen')),
      host.on('documentclose', () => this.clearSnapshot('documentclose')),
    );
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
    const snapshot = this.lastSnapshot;
    if (snapshot) {
      // 新选区在阅读器之外：旧快照已不再对应当前意图，清空后回退。
      if (
        selection &&
        !selection.isCollapsed &&
        !this.isSelectionInsideViewer(selection) &&
        !this.isSelectionDetached(selection)
      ) {
        this.clearSnapshot('selection-outside');
        return '';
      }
      return snapshot.text;
    }
    if (!selection || selection.rangeCount === 0) return '';
    const range = selection.getRangeAt(0);
    if (range.collapsed) return '';
    if (!this.isSelectionInsideViewer(selection)) return '';
    const model = this.buildSelectionModel(range);
    if (this.handleIncompleteModel(model)) return '';
    return this.textOfSelection(selection, range, model);
  }

  /**
   * 取最近一次被接受的完整选区快照；无有效选区时为 null。
   *
   * 快照包含完整片段（页码、item/char 下标、行标识、字符四边形）、规范化文本与
   * 每页预合并矩形；复制与块状高亮都只读该对象，与 DOM 存活性无关。
   *
   * @returns 完整选区快照；无有效选区时为 null。
   */
  getSelectionSnapshot(): SelectionSnapshot | null {
    return this.lastSnapshot;
  }

  /**
   * 标记本模块即将改动选区所在页的 DOM。
   *
   * 仅用于淘汰页、整页重建等会移除 span 的操作；抑制窗口在当前微任务结束时关闭。
   * 用户显式取消（pointerdown/Escape/键盘）不经过该标志，永远优先。
   */
  suppressSelectionChangeForDomMutation(): void {
    if (this.suppressDepth === 0) {
      runMicrotask(() => {
        this.suppressDepth = 0;
      });
    }
    this.suppressDepth += 1;
  }

  /**
   * 构建选区几何模型；复制与后续高亮统一从这里取数。
   *
   * 逐 span 用 `Range.intersectsNode()` 剪枝，再逐字符用 `Range.comparePoint()` 求出
   * 真实的部分区间；字符的 quad 与行标识由文本层服务按页缓存查表得到。
   *
   * @param range 原生选区范围。
   * @returns 按阅读顺序排序的片段与模式；无法使用字符级几何时 `.mode === 'legacy'`。
   */
  buildSelectionModel(range: Range): SelectionModel {
    const service = this.textLayerService;
    if (
      !service ||
      typeof range.comparePoint !== 'function' ||
      typeof range.intersectsNode !== 'function'
    ) {
      return LEGACY_SELECTION_MODEL;
    }
    try {
      const drafts: FragmentDraft[] = [];
      let order = 0;
      for (const view of this.host.getPageViews()) {
        if (view.isDestroyed || !view.textLayer) continue;
        const pageNumber = view.pageNumber;
        const spans = view.textLayer.querySelectorAll<HTMLElement>(
          '.ofd-text-item, .ofd-text-char',
        );
        if (spans.length === 0) continue;
        const axisRowRad = service.getAxisRowRad(pageNumber);
        // 页文本内容尚未就绪：无法查表，整体回退旧逻辑。
        if (axisRowRad === null || !Number.isFinite(axisRowRad)) {
          return LEGACY_SELECTION_MODEL;
        }
        for (const span of spans) {
          const textNode = firstTextNode(span);
          if (!textNode) continue;
          const text = textNode.data;
          if (text.length === 0) continue;
          if (!range.intersectsNode(textNode)) continue;
          const start = boundaryOffset(range, textNode, text.length, true);
          const end = boundaryOffset(range, textNode, text.length, false);
          if (start === null || end === null || end <= start) continue;
          const itemIndex = Number(span.dataset.itemIndex ?? '');
          if (!Number.isInteger(itemIndex) || itemIndex < 0) {
            return LEGACY_SELECTION_MODEL;
          }
          const selections = charSelectionsOfSpan(span, itemIndex, text, start, end);
          if (selections.length === 0) continue;
          const quads = service.getCharQuads(
            pageNumber,
            selections.map((selection) => selection.ref),
          );
          for (let index = 0; index < selections.length; index += 1) {
            const quad = quads[index];
            const selection = selections[index]!;
            const rowId = service.getRowIdOf(pageNumber, selection.ref);
            // 字符几何或行归属缺失：无法查表，整体回退旧逻辑。
            if (!quad || rowId === null) return LEGACY_SELECTION_MODEL;
            drafts.push({
              text: selection.text,
              pageNumber,
              rowId,
              quad,
              axisRowRad,
              itemIndex,
              charIndex: selection.ref.charIndex,
              rowOrdinal: rowOrdinalOf(rowId),
              flowMin: flowRangeOfQuad(quad, axisRowRad).min,
              order: order++,
            });
          }
        }
      }
      if (drafts.length === 0) return { fragments: [], mode: 'vector' };
      drafts.sort(compareDrafts);
      const fragments = drafts.map((draft) => ({
        text: draft.text,
        pageNumber: draft.pageNumber,
        rowId: draft.rowId,
        quad: draft.quad,
        axisRowRad: draft.axisRowRad,
        itemIndex: draft.itemIndex,
        charIndex: draft.charIndex,
      }));
      const incompletePages = this.incompletePagesOfRange(range, fragments);
      return { fragments, mode: 'vector', incompletePages };
    } catch {
      // 计算异常（含 comparePoint 在不支持的节点上抛错）时回退旧逻辑。
      return LEGACY_SELECTION_MODEL;
    }
  }

  /**
   * 复制当前选区；优先异步剪贴板，回退 `execCommand('copy')`。
   *
   * @throws {OFDViewerError} 功能关闭或剪贴板不可用时抛出。
   */
  async copySelection(): Promise<void> {
    this.assertSelection();
    // getSelectedText 优先返回快照；无快照时才回退 DOM。
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

  /** 清除选区、快照与块状高亮。 */
  clearSelection(): void {
    this.assertSelection();
    this.clearSnapshot('clear-selection', true);
  }

  /** 释放监听并清空块状高亮；不改写原生选区。 */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearSnapshot('destroy');
    for (const cleanup of this.cleanups.splice(0)) cleanup();
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

  /** 发布选区变化并重绘块状高亮；已建快照不被 DOM 变化误清。 */
  private publishSelectionChange(): void {
    if (this.destroyed) return;
    if (!this.selectionAvailable()) {
      if (this.lastSnapshot) this.clearSnapshot('feature');
      return;
    }
    // 本模块改 DOM 的微任务窗口内，事件可能只是 DOM 副作用，不重算旧快照。
    if (this.suppressDepth > 0) return;
    const selection = this.doc?.getSelection?.() ?? null;
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      // 折叠/无 Range 可能由淘汰页、append 构建或浏览器归一化造成，不据此清空。
      if (this.lastSnapshot) return;
      this.renderSelection(EMPTY_SELECTION_MODEL);
      this.publishText('');
      return;
    }
    // 端点页被淘汰时浏览器可能把一端改锚到 body；只要旧快照仍在，不能据此重建。
    if (this.lastSnapshot && this.isSelectionDetached(selection)) return;
    if (this.lastSnapshot && this.isSnapshotEndpointDetached()) return;
    if (!this.isSelectionInsideViewer(selection)) {
      this.clearSnapshot('selection-outside');
      return;
    }
    // 原生 Selection 未变化时，事件可能来自我们移除中间页 span；保留快照。
    if (this.lastSnapshot && this.isSameSelectionAsSnapshot(selection)) return;
    const range = selection.getRangeAt(0);
    const model = this.buildSelectionModel(range);
    if (this.handleIncompleteModel(model)) return;
    if (model.mode !== 'vector' || model.fragments.length === 0) {
      // 新选区无法建立完整快照：旧快照必须让位，复制回退现有逻辑。
      this.lastSnapshot = null;
      this.snapshotClearedReason = 'model-incomplete';
      this.snapshotVersion += 1;
      this.renderSelection(model);
      this.publishText(this.textOfSelection(selection, range, model));
      return;
    }
    const snapshot = this.createSnapshot(model, selection, range);
    this.lastSnapshot = snapshot;
    this.snapshotClearedReason = null;
    this.snapshotVersion = snapshot.version;
    this.lastIncompleteKey = null;
    if (!this.renderSelection(snapshot)) {
      this.lastSnapshot = null;
      return;
    }
    this.publishText(snapshot.text);
  }

  /**
   * 按选区模型拼接文本；vector 模式不再回读旧距离逻辑。
   *
   * @param selection 原生选区。
   * @param range 选区范围。
   * @param model 选区几何模型。
   * @returns 规范化文本。
   */
  private textOfSelection(selection: Selection, range: Range, model: SelectionModel): string {
    if (model.mode === 'vector') {
      if (model.fragments.length === 0) {
        return normalizeSelectionText(selection.toString());
      }
      return normalizeSelectionText(joinFragments(model.fragments));
    }
    const fragments = this.collectLegacyFragments(range);
    if (fragments.length === 0) return normalizeSelectionText(selection.toString());
    return normalizeSelectionText(joinLegacyFragments(fragments));
  }

  /**
   * 发布选区文本；与上次相同则不发事件。
   *
   * @param text 规范化文本。
   */
  private publishText(text: string): void {
    if (text === this.lastText) return;
    this.lastText = text;
    this.bridge.publishSelection(text);
  }

  /** 布局/页数据/功能变化后合帧重绘高亮。 */
  private scheduleHighlightRefresh(): void {
    if (this.highlightQueued) return;
    this.highlightQueued = true;
    runMicrotask(() => {
      this.highlightQueued = false;
      this.refreshHighlight();
    });
  }

  /** 布局/页数据/功能变化后重绘高亮；已有快照时只重绘，不重建。 */
  private refreshHighlight(): void {
    if (this.destroyed) return;
    if (!this.selectionAvailable()) {
      this.clearSnapshot('feature');
      return;
    }
    if (this.lastSnapshot) {
      // 缩放/旋转/页淘汰不是用户取消：复用同一快照与 96 DPI 矩形。
      this.renderSelection(this.lastSnapshot);
      return;
    }
    const selection = this.doc?.getSelection?.() ?? null;
    if (
      !selection ||
      selection.rangeCount === 0 ||
      selection.isCollapsed ||
      !this.isSelectionInsideViewer(selection)
    ) {
      this.renderSelection(EMPTY_SELECTION_MODEL);
      return;
    }
    const range = selection.getRangeAt(0);
    const model = this.buildSelectionModel(range);
    if (this.handleIncompleteModel(model)) return;
    if (model.mode !== 'vector' || model.fragments.length === 0) {
      this.renderSelection(model);
      return;
    }
    const snapshot = this.createSnapshot(model, selection, range);
    this.lastSnapshot = snapshot;
    this.snapshotVersion = snapshot.version;
    this.lastIncompleteKey = null;
    this.renderSelection(snapshot);
  }

  /**
   * 驱动文本层重绘块状选区层；高亮异常不影响复制/选区文本。
   *
   * @param model 选区模型。
   */
  private renderSelection(model: SelectionModel | SelectionSnapshot): boolean {
    const pinnedPages = endpointPagesOf(model);
    if (this.textLayerService?.setPinnedPages?.(pinnedPages) === false) {
      this.clearUnpinnableSelection();
      return false;
    }
    try {
      this.textLayerService?.renderSelection?.(model);
    } catch {
      // 忽略高亮渲染异常，选区文本与复制保持可用。
    }
    return true;
  }

  /**
   * 端点页 span 超出 pin 预算：清空选区并告警，避免保留残缺选区。
   *
   * 只由 pin 预算拒绝触发；显式取消仍走 {@link clearSelection}。
   */
  private clearUnpinnableSelection(): void {
    this.clearSnapshot('unpinnable', true);
    this.bridge.warn(
      W_SELECTION_UNPINNABLE,
      '选区端点页文本量超过 pin 预算，已清空选区，请缩小选择范围。',
    );
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
   * 收集选区覆盖的文本片段（旧逻辑）。
   *
   * 从左/上/字号内联样式与旋转角读几何，用距离阈值推测行关系；仅在 `legacy`
   * 模式（文本层几何不可用）下使用。
   */
  private collectLegacyFragments(range: Range): LegacyFragment[] {
    const fragments: LegacyFragment[] = [];
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
        const start = legacyBoundaryOffset(range, span, textNode, text.length, true);
        const end = legacyBoundaryOffset(range, span, textNode, text.length, false);
        if (start === null || end === null || end <= start) continue;
        // 生产构建为降低 DOM 成本会省略 legacy dataset；几何必须从内联样式读取。
        const left = inlineNumber(span, 'left');
        const top = inlineNumber(span, 'top');
        const size = inlineNumber(span, 'font-size');
        const angle = inlineRotationOf(span);
        fragments.push({
          text: text.slice(start, end),
          pageNumber: view.pageNumber,
          x: left,
          top,
          size: size > 0 ? size : 1,
          angle,
        });
      }
    }
    return fragments;
  }

  /** 选区功能是否开启；关闭时快照必须失效。 */
  private selectionAvailable(): boolean {
    return (
      this.host.isFeatureEnabled('selection') && this.host.isFeatureEnabled('textLayer')
    );
  }

  /** 把已构建的模型冻结为快照，并预先合并每页高亮矩形。 */
  private createSnapshot(
    model: SelectionModel,
    selection: Selection,
    range: Range,
  ): SelectionSnapshot {
    const fragments = model.fragments;
    const pageNumbers = [...new Set(fragments.map((fragment) => fragment.pageNumber))].sort(
      (first, second) => first - second,
    );
    const rectsByPage = new Map<number, readonly SelectionBox[]>();
    const axisByPage = new Map<number, number>();
    for (const pageNumber of pageNumbers) {
      const pageFragments = fragments.filter((fragment) => fragment.pageNumber === pageNumber);
      const axisRowRad = pageFragments[0]?.axisRowRad ?? 0;
      axisByPage.set(pageNumber, axisRowRad);
      rectsByPage.set(pageNumber, selectionBoxesOfFragments(pageFragments, axisRowRad));
    }
    return {
      ...model,
      text: this.textOfSelection(selection, range, model),
      rectsByPage,
      axisByPage,
      pageNumbers,
      startPage: pageNumbers[0] ?? 1,
      endPage: pageNumbers[pageNumbers.length - 1] ?? 1,
      anchorNode: selection.anchorNode,
      focusNode: selection.focusNode,
      anchorOffset: selection.anchorOffset,
      focusOffset: selection.focusOffset,
      version: this.snapshotVersion + 1,
    };
  }

  /**
   * 选区页区间内没有 span 或没有文本数据的页。
   *
   * 区间由实际片段与 Range 端点共同确定；中间页被 LRU 淘汰后仍能识别缺口，避免
   * 只返回端点页文本。
   *
   * @param range 原生选区范围。
   * @param fragments 已抽取的选区片段。
   * @returns 不完整页码（升序，1-based）；完整时为空数组。
   */
  private incompletePagesOfRange(
    range: Range,
    fragments: readonly SelectionFragment[],
  ): number[] {
    const pages = new Set<number>();
    for (const fragment of fragments) pages.add(fragment.pageNumber);
    for (const node of [range.startContainer, range.endContainer]) {
      const pageNumber = this.pageNumberOfNode(node);
      if (pageNumber !== null) pages.add(pageNumber);
    }
    if (pages.size === 0) return [];
    const first = Math.min(...pages);
    const last = Math.max(...pages);
    const incomplete: number[] = [];
    for (let pageNumber = first; pageNumber <= last; pageNumber += 1) {
      const view = this.host.getPageView(pageNumber);
      const spanCount =
        view && !view.isDestroyed
          ? view.textLayer.querySelectorAll('.ofd-text-item, .ofd-text-char').length
          : 0;
      const axisRowRad = this.textLayerService?.getAxisRowRad(pageNumber);
      const hasData = axisRowRad !== null && axisRowRad !== undefined;
      if (spanCount === 0 || !hasData) incomplete.push(pageNumber);
    }
    return incomplete;
  }

  /** 节点所属页码；不在任何页视图内时返回 null。 */
  private pageNumberOfNode(node: Node | null): number | null {
    if (!node) return null;
    for (const view of this.host.getPageViews()) {
      if (view.isDestroyed) continue;
      if (view.element === node || view.element.contains(node)) return view.pageNumber;
    }
    return null;
  }

  /**
   * 不完整模型兜底：清空选区并告警，绝不返回部分文本。
   *
   * @param model 选区模型。
   * @returns 模型是否不完整（已清空）。
   */
  private handleIncompleteModel(model: SelectionModel): boolean {
    const pages = model.incompletePages ?? [];
    if (pages.length === 0) return false;
    const key = pages.join(',');
    this.clearSnapshot('model-incomplete', true);
    if (this.lastIncompleteKey !== key) {
      this.lastIncompleteKey = key;
      this.bridge.warn(
        W_SELECTION_EVICTED,
        `选区覆盖的第 ${pages.join('、')} 页文本已不可用，已清空选区；请滚回该页重新选择。`,
        pages[0]! - 1,
      );
    }
    return true;
  }

  /**
   * 清空快照、pin 与块状高亮。
   *
   * @param reason 诊断原因。
   * @param removeNative 是否同时移除原生 Range；显式 clearSelection 才需要。
   */
  private clearSnapshot(reason: string, removeNative = false): void {
    const hadSelection = this.lastSnapshot !== null || this.lastText !== '';
    this.lastSnapshot = null;
    this.snapshotClearedReason = reason;
    this.snapshotVersion += 1;
    if (removeNative) {
      const selection = this.doc?.getSelection?.() ?? null;
      if (selection?.rangeCount) selection.removeAllRanges();
    }
    this.renderSelection(EMPTY_SELECTION_MODEL);
    if (hadSelection) {
      this.lastText = '';
      this.bridge.publishSelection('');
    }
  }

  /** 判断当前原生选区是否与快照完全一致；一致说明事件只是 DOM 副作用。 */
  private isSameSelectionAsSnapshot(selection: Selection): boolean {
    const snapshot = this.lastSnapshot;
    if (!snapshot || selection.rangeCount === 0 || selection.isCollapsed) return false;
    return (
      selection.anchorNode === snapshot.anchorNode &&
      selection.focusNode === snapshot.focusNode &&
      selection.anchorOffset === snapshot.anchorOffset &&
      selection.focusOffset === snapshot.focusOffset
    );
  }

  /** 原生选区端点是否已脱离文档；淘汰页移除 span 后会出现。 */
  private isSelectionDetached(selection: Selection): boolean {
    const nodes = [selection.anchorNode, selection.focusNode];
    return nodes.some((node) => !!node && !node.isConnected);
  }

  /** 快照自身的端点是否已脱离文档；端点页淘汰后用于保留旧内容。 */
  private isSnapshotEndpointDetached(): boolean {
    const snapshot = this.lastSnapshot;
    if (!snapshot) return false;
    return (
      (!!snapshot.anchorNode && !snapshot.anchorNode.isConnected) ||
      (!!snapshot.focusNode && !snapshot.focusNode.isConnected)
    );
  }

  /** 是否为输入框/可编辑元素；不区分是否位于阅读器根节点内。 */
  private isEditableElement(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      target.isContentEditable
    );
  }

  /** 原生 copy：快照有效时覆盖剪贴板并阻止默认复制；输入控件内一律放行。 */
  private handleCopy(event: Event): void {
    // 输入控件自己的复制永远优先，避免把旧选区文本写进剪贴板。
    if (this.isEditableElement(event.target)) return;
    const snapshot = this.lastSnapshot;
    if (!snapshot || event.defaultPrevented) return;
    const selection = this.doc?.getSelection?.() ?? null;
    if (
      selection &&
      !selection.isCollapsed &&
      !this.isSelectionInsideViewer(selection) &&
      !this.isSelectionDetached(selection)
    ) {
      return;
    }
    const clipboard = (event as ClipboardEvent).clipboardData;
    if (!clipboard?.setData) return;
    clipboard.setData('text/plain', snapshot.text);
    event.preventDefault();
  }

  /** 点击（无 Shift）清空快照；滚动条拖动不算取消选择。 */
  private handlePointerDown(event: Event): void {
    if (!this.lastSnapshot) return;
    const mouse = event as MouseEvent;
    if (typeof mouse.button === 'number' && mouse.button !== 0) return;
    if (mouse.shiftKey) return;
    if (this.isEditableElement(mouse.target)) return;
    if (isScrollbarPointerDown(mouse, this.root)) return;
    this.clearSnapshot('pointerdown', true);
  }

  /**
   * 鼠标单击后的清理：pointerdown 已清空快照和 Range，但浏览器默认动作可能重新
   * 建立折叠 Range。此时若没有新选区，清掉这个空 Range，保证原生选区也归零。
   *
   * @param event 指针抬起事件。
   */
  private handlePointerUp(event: Event): void {
    if (this.snapshotClearedReason !== 'pointerdown' || this.lastSnapshot) return;
    const mouse = event as MouseEvent;
    if (typeof mouse.button === 'number' && mouse.button !== 0) return;
    if (this.isEditableElement(mouse.target)) return;
    const selection = this.doc?.getSelection?.() ?? null;
    if (selection?.rangeCount && selection.isCollapsed) selection.removeAllRanges();
  }

  /** Esc/方向键/可打印键取消选区；Ctrl/Meta/Alt 与 Shift 扩选不清空。 */
  private handleKeyDown(event: Event): void {
    if (!this.lastSnapshot) return;
    const keyboard = event as KeyboardEvent;
    if (keyboard.isComposing) return;
    if (keyboard.ctrlKey || keyboard.metaKey || keyboard.altKey) return;
    // 与 pointerdown 使用同一判定：阅读器内的查找框/表单控件也视为输入目标。
    if (this.isEditableElement(keyboard.target)) return;
    const key = keyboard.key ?? '';
    if (key === 'Escape') {
      this.clearSnapshot('escape', true);
      return;
    }
    if (keyboard.shiftKey) return;
    const isArrow =
      key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown';
    const isPrintable = key.length === 1 || key === 'Backspace' || key === 'Delete';
    if (isArrow || isPrintable) this.clearSnapshot('keydown', true);
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

/**
 * 把同页选区片段合并为块状高亮矩形。
 *
 * 与文本层绘制算法保持一致：按 rowId 分组投影到行主轴，flow 方向并集、perp 方向
 * 取并集，最后行间留缝并反变换回 96 DPI 页坐标。快照建立时算一次，页淘汰后直接复用。
 *
 * @param fragments 同一页的选区片段。
 * @param axisRowRad 行主轴方向，单位弧度。
 * @returns 页坐标中的选区矩形。
 */
function selectionBoxesOfFragments(
  fragments: readonly SelectionFragment[],
  axisRowRad: number,
): SelectionBox[] {
  const rows = new Map<string, ProjectedRect[]>();
  for (const fragment of fragments) {
    if (!fragment.quad || fragment.rowId === null) continue;
    const projected = projectQuad(fragment.quad, axisRowRad);
    const row = rows.get(fragment.rowId);
    if (row) row.push(projected);
    else rows.set(fragment.rowId, [projected]);
  }
  const rects: RowFlowRect[] = [];
  for (const [rowId, projected] of rows) {
    const intervals = mergeFlowIntervals(
      projected.map((rect) => ({ min: rect.flowMin, max: rect.flowMax })),
    );
    for (const interval of intervals) {
      let perpMin = Number.POSITIVE_INFINITY;
      let perpMax = Number.NEGATIVE_INFINITY;
      for (const rect of projected) {
        if (rect.flowMax < interval.min - FLOW_MERGE_EPSILON) continue;
        if (rect.flowMin > interval.max + FLOW_MERGE_EPSILON) continue;
        perpMin = Math.min(perpMin, rect.perpMin);
        perpMax = Math.max(perpMax, rect.perpMax);
      }
      if (!Number.isFinite(perpMin)) continue;
      rects.push({
        rowId,
        flowMin: interval.min,
        flowMax: interval.max,
        perpMin,
        perpMax,
      });
    }
  }
  return applyRowGap(rects, SELECTION_ROW_GAP_PX).map((rect) =>
    unprojectRect(rect, axisRowRad),
  );
}

/**
 * 判断 pointerdown 是否落在滚动条槽内，避免拖滚动条被误判为取消选区。
 *
 * @param event 指针事件。
 * @param root 阅读器根节点；到根后停止向上检查。
 * @returns 命中滚动条时 true。
 */
function isScrollbarPointerDown(event: MouseEvent, root: HTMLElement | null): boolean {
  if (!(event.target instanceof Element)) return false;
  for (let element: Element | null = event.target; element; element = element.parentElement) {
    if (!(element instanceof HTMLElement)) continue;
    const rect = element.getBoundingClientRect();
    const vertical =
      event.clientX >= rect.left + element.clientWidth &&
      event.clientX <= rect.right &&
      element.scrollHeight > element.clientHeight;
    const horizontal =
      event.clientY >= rect.top + element.clientHeight &&
      event.clientY <= rect.bottom &&
      element.scrollWidth > element.clientWidth;
    if (vertical || horizontal) return true;
    if (element === root) break;
  }
  return false;
}

/** 选区模型覆盖的端点页（首尾页）；空模型返回空数组。 */
function endpointPagesOf(model: SelectionModel): number[] {
  if (model.fragments.length === 0) return [];
  const pages = new Set<number>([model.fragments[0]!.pageNumber]);
  const last = model.fragments[model.fragments.length - 1]!;
  pages.add(last.pageNumber);
  return [...pages].sort((a, b) => a - b);
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
 * 计算 Range 在文本节点内的端点偏移（字符级）。
 *
 * 端点容器就是文本节点时直接取偏移；否则用 `Range.comparePoint()` 逐字符判定：
 * 起点取首个“不早于选区起点”的字符下标，终点取末个“不晚于选区终点”的字符下标。
 * 因此中间被部分选中的 span 得到真实的部分区间，而不是整段。
 *
 * @param range 选区范围。
 * @param node 文本节点。
 * @param length 文本长度。
 * @param isStart 是否求起点；false 求终点。
 * @returns 偏移；节点与选区无交集时返回 null。
 */
function boundaryOffset(
  range: Range,
  node: Text,
  length: number,
  isStart: boolean,
): number | null {
  const container = isStart ? range.startContainer : range.endContainer;
  const offset = isStart ? range.startOffset : range.endOffset;
  if (container === node) return Math.min(length, Math.max(0, offset));
  if (isStart) {
    for (let index = 0; index <= length; index += 1) {
      if (range.comparePoint(node, index) >= 0) return index;
    }
    return null;
  }
  for (let index = length; index >= 0; index -= 1) {
    if (range.comparePoint(node, index) <= 0) return index;
  }
  return null;
}

/**
 * 把 span 内选中的文本区间拆成字符级片段。
 *
 * 字符级 span 对应一个字符；item 级 span 按 Unicode 码点拆分，码点顺序与
 * `TextItem.chars` 一致，因此码点下标可直接作为 `CharRef.charIndex`。
 *
 * @param span 文本 span。
 * @param itemIndex 所属 TextItem 下标。
 * @param text span 文本。
 * @param start 选中区间起点（UTF-16 偏移）。
 * @param end 选中区间终点（UTF-16 偏移，不含）。
 * @returns 字符引用与对应文本；跨度数据非法时返回空数组。
 */
function charSelectionsOfSpan(
  span: HTMLElement,
  itemIndex: number,
  text: string,
  start: number,
  end: number,
): Array<{ readonly ref: CharRef; readonly text: string }> {
  const charIndexAttr = span.dataset.charIndex;
  if (charIndexAttr !== undefined) {
    const charIndex = Number(charIndexAttr);
    if (!Number.isInteger(charIndex) || charIndex < 0) return [];
    return [{ ref: { itemIndex, charIndex }, text: text.slice(start, end) }];
  }
  const codePointStart = codePointIndexAt(text, start);
  const codePointEnd = codePointIndexAt(text, end);
  const selections: Array<{ readonly ref: CharRef; readonly text: string }> = [];
  let codePointIndex = 0;
  for (const codePointText of text) {
    if (codePointIndex >= codePointEnd) break;
    if (codePointIndex >= codePointStart) {
      selections.push({
        ref: { itemIndex, charIndex: codePointIndex },
        text: codePointText,
      });
    }
    codePointIndex += 1;
  }
  return selections;
}

/**
 * 计算 UTF-16 偏移对应的码点下标。
 *
 * @param text 文本。
 * @param utf16Offset UTF-16 偏移。
 * @returns 起点严格位于偏移之前的码点数量。
 */
function codePointIndexAt(text: string, utf16Offset: number): number {
  let index = 0;
  let cursor = 0;
  for (const codePointText of text) {
    if (cursor >= utf16Offset) return index;
    cursor += codePointText.length;
    index += 1;
  }
  return index;
}

/**
 * 计算四边形在阅读推进方向上的投影区间。
 *
 * @param quad 字符四边形。
 * @param axisRowRad 主轴方向，单位弧度。
 * @returns 投影最小/最大值，单位 px。
 */
function flowRangeOfQuad(
  quad: TextQuad,
  axisRowRad: number,
): { readonly min: number; readonly max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const point of quad) {
    const flow = flowOf({ left: point.x, top: point.y }, axisRowRad);
    if (flow < min) min = flow;
    if (flow > max) max = flow;
  }
  return { min, max };
}

/**
 * 从行 ID 提取行在主轴法向上的序号。
 *
 * `TextRow.id` 的格式为 `${首个 itemIndex}:${行序号}`（见 `geometry.ts`），行序号即
 * 文本层行划分中的法向序号；格式异常时排到末尾。
 *
 * @param rowId 行标识。
 * @returns 行序号。
 */
function rowOrdinalOf(rowId: string): number {
  const separator = rowId.lastIndexOf(':');
  const parsed = separator >= 0 ? Number(rowId.slice(separator + 1)) : Number.NaN;
  return Number.isInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/** 片段排序：页码 → 行法向序号 → 行内 flow 位置 → 采集顺序。 */
function compareDrafts(first: FragmentDraft, second: FragmentDraft): number {
  if (first.pageNumber !== second.pageNumber) {
    return first.pageNumber - second.pageNumber;
  }
  if (first.rowOrdinal !== second.rowOrdinal) {
    return first.rowOrdinal - second.rowOrdinal;
  }
  if (first.flowMin !== second.flowMin) return first.flowMin - second.flowMin;
  return first.order - second.order;
}

/**
 * 按行归属拼接片段文本。
 *
 * - 上一个字符的 rowId 与当前不同（或跨页）：插入换行；
 * - 同一行且 source 相邻（flow 间距不超过 {@link FLOW_JOIN_EPSILON}）：不插分隔；
 * - 同一行但有间隔：中文/全角之一不插空格，拉丁字符之间补一个空格；
 * - 片段本身已带空白：不重复插入。
 *
 * 行判定只依赖 rowId 查表，不使用任何字号/距离阈值。
 *
 * @param fragments 按阅读顺序排序的片段。
 * @returns 拼接文本。
 */
function joinFragments(fragments: readonly SelectionFragment[]): string {
  let output = '';
  let previous: SelectionFragment | null = null;
  let previousFlowMax = Number.NaN;
  for (const fragment of fragments) {
    const flowRange = fragment.quad
      ? flowRangeOfQuad(fragment.quad, fragment.axisRowRad)
      : null;
    let separator = '';
    if (previous) {
      const sameRow =
        fragment.pageNumber === previous.pageNumber &&
        fragment.rowId !== null &&
        fragment.rowId === previous.rowId;
      if (!sameRow) {
        separator = '\n';
      } else if (/\s$/.test(previous.text) || /^\s/.test(fragment.text)) {
        separator = '';
      } else {
        const gap =
          flowRange && Number.isFinite(previousFlowMax)
            ? flowRange.min - previousFlowMax
            : Number.POSITIVE_INFINITY;
        // 同一 span 内相邻字符的 flow 首尾相接，不需要补空格；只有跨 span 的间隔
        // 才按 CJK/拉丁规则决定是否插入空格。
        if (gap > FLOW_JOIN_EPSILON) {
          const lastPrevious = [...previous.text].pop() ?? '';
          const firstNext = [...fragment.text][0] ?? '';
          separator =
            isCjkChar(lastPrevious) || isCjkChar(firstNext) ? '' : ' ';
        }
      }
    }
    output += separator + fragment.text;
    previous = fragment;
    previousFlowMax = flowRange ? flowRange.max : Number.NaN;
  }
  return output;
}

/**
 * 读取 span 内联样式的数值；缺失或非法时返回 0。
 *
 * @param span 文本 span。
 * @param property CSS 属性名。
 * @returns 数值，单位随属性（px 等）；非法时为 0。
 */
function inlineNumber(span: HTMLElement, property: string): number {
  const value = Number.parseFloat(span.style.getPropertyValue(property));
  return Number.isFinite(value) ? value : 0;
}

/**
 * 从 span 内联 transform 读取旋转角。
 *
 * 文本层只写 `matrix(...)` 或 `rotate(...)`；未写 transform 表示水平文本。
 *
 * @param span 文本 span。
 * @returns 旋转角，单位弧度。
 */
function inlineRotationOf(span: HTMLElement): number {
  const value = span.style.getPropertyValue('transform').replace(/\s+/g, '');
  // 部分 DOM 实现（如 jsdom）不支持内联 transform；保留最小角度兜底数据。
  if (value === '') {
    const fallback = Number(span.dataset.angle ?? '0');
    return Number.isFinite(fallback) ? fallback : 0;
  }
  const matrix = /^matrix\(([^)]*)\)$/.exec(value);
  if (matrix) {
    const parts = matrix[1]!.split(',').map(Number);
    if (parts.length === 6 && parts.every((part) => Number.isFinite(part))) {
      return Math.atan2(parts[1]!, parts[0]!);
    }
    return 0;
  }
  const rotate = /^rotate\(([-+0-9.eE]+)(deg|rad|turn)?\)$/.exec(value);
  if (!rotate) return 0;
  const amount = Number(rotate[1]);
  if (!Number.isFinite(amount)) return 0;
  if (rotate[2] === 'deg') return (amount * Math.PI) / 180;
  if (rotate[2] === 'turn') return amount * 2 * Math.PI;
  return amount;
}

/**
 * 计算 Range 在文本节点内的端点偏移（旧逻辑）。
 *
 * 对非端点节点恒返回整段，仅用于 `legacy` 回退路径。
 *
 * @param range 选区范围。
 * @param span 文本 span（Range 端点可能落在元素容器上）。
 * @param node 文本节点。
 * @param length 文本长度。
 * @param isStart 是否求起点；false 求终点。
 * @returns 偏移；节点不在选区内时返回 null。
 */
function legacyBoundaryOffset(
  range: Range,
  span: HTMLElement,
  node: Text,
  length: number,
  isStart: boolean,
): number | null {
  const container = isStart ? range.startContainer : range.endContainer;
  const offset = isStart ? range.startOffset : range.endOffset;
  if (container === node) return Math.min(length, Math.max(0, offset));
  if (container === span) return offset <= 0 ? 0 : length;
  if (typeof range.comparePoint !== 'function') {
    return isStart ? 0 : length;
  }
  const atStart = range.comparePoint(node, 0);
  const atEnd = range.comparePoint(node, length);
  if (atStart > 0 || atEnd < 0) return null;
  return isStart ? 0 : length;
}

/**
 * 按几何关系拼接片段（旧逻辑）。
 *
 * - 不同页：换行；
 * - 同一页不同行：换行；
 * - 同一行：中文/全角之间不插空格，拉丁字符之间补一个空格；
 * - 片段本身已带空白：不重复插入。
 *
 * @param fragments 旧逻辑片段。
 * @returns 拼接文本。
 */
function joinLegacyFragments(fragments: readonly LegacyFragment[]): string {
  let output = '';
  let previous: LegacyFragment | null = null;
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