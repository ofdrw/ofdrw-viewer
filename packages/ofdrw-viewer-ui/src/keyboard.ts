/**
 * 键盘快捷键（设计方案 §4.6 / §4.7）。
 *
 * 快捷键是阅读器行为，不劫持浏览器保留键；输入框/可编辑区域内的按键一律放行。
 * `features.keyboardShortcuts=false` 时整体停用，但按钮仍可用。翻页、缩放等动作
 * 是否可用由 `OFDViewer` 的 feature 守卫再判断。
 */

/** 快捷键动作集合；由 `OFDViewer` 注入。 */
export interface KeyboardActions {
  /** 下一页。 */
  nextPage(): void;
  /** 上一页。 */
  previousPage(): void;
  /** 首页。 */
  firstPage(): void;
  /** 末页。 */
  lastPage(): void;
  /** 放大。 */
  zoomIn(): void;
  /** 缩小。 */
  zoomOut(): void;
  /** 重置缩放。 */
  resetZoom(): void;
  /** 打开查找。 */
  find(): void;
  /** 打印。 */
  print(): void;
  /** 关闭浮层/对话框。 */
  close(): void;
}

/** 键盘控制器选项。 */
export interface KeyboardControllerOptions {
  /** 是否启用；默认 true。 */
  readonly enabled?: boolean;
  /** 事件目标；默认绑定到传入元素。 */
  readonly target?: EventTarget;
  /** 是否在捕获阶段监听；默认 false。 */
  readonly capture?: boolean;
}

/**
 * 判断事件目标是否为可编辑区域。
 *
 * @param target 事件目标。
 * @returns 可编辑/输入控件时 true。
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as HTMLElement;
  const tagName = element.tagName?.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') return true;
  if ((element as { isContentEditable?: boolean }).isContentEditable) return true;
  const contentEditable = element.getAttribute?.('contenteditable');
  return contentEditable !== null && contentEditable !== 'false';
}

/** 键盘快捷键控制器。 */
export class KeyboardController {
  private readonly target: EventTarget;
  private readonly actions: KeyboardActions;
  private readonly capture: boolean;
  private enabled: boolean;
  private attached = false;
  private readonly onKeyDown = (event: Event): void => {
    this.handle(event as KeyboardEvent);
  };

  /**
   * @param target 事件目标；通常是阅读器根节点。
   * @param actions 快捷键动作。
   * @param options 启用状态与监听阶段。
   */
  constructor(
    target: EventTarget,
    actions: KeyboardActions,
    options: KeyboardControllerOptions = {},
  ) {
    this.target = options.target ?? target;
    this.actions = actions;
    this.enabled = options.enabled ?? true;
    this.capture = options.capture ?? false;
    this.setEnabled(this.enabled);
  }

  /** 当前是否启用。 */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 启用/停用快捷键；停用时解绑监听。
   *
   * @param enabled 是否启用。
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled && !this.attached) {
      this.target.addEventListener('keydown', this.onKeyDown, this.capture);
      this.attached = true;
    } else if (!enabled && this.attached) {
      this.target.removeEventListener('keydown', this.onKeyDown, this.capture);
      this.attached = false;
    }
  }

  /** 解绑监听。 */
  destroy(): void {
    this.setEnabled(false);
  }

  /**
   * 处理按键。
   *
   * @param event 键盘事件。
   */
  private handle(event: KeyboardEvent): void {
    if (!this.enabled || event.defaultPrevented || event.isComposing) return;
    if (isEditableTarget(event.target)) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key;

    if (mod && !event.altKey && !event.shiftKey) {
      const lower = key.toLowerCase();
      if (lower === 'f') {
        event.preventDefault();
        this.actions.find();
        return;
      }
      if (lower === 'p') {
        event.preventDefault();
        this.actions.print();
        return;
      }
    }

    if (mod || event.altKey) return;

    switch (key) {
      case 'ArrowDown':
      case 'ArrowRight':
      case 'PageDown':
        event.preventDefault();
        this.actions.nextPage();
        return;
      case 'ArrowUp':
      case 'ArrowLeft':
      case 'PageUp':
        event.preventDefault();
        this.actions.previousPage();
        return;
      case 'Home':
        event.preventDefault();
        this.actions.firstPage();
        return;
      case 'End':
        event.preventDefault();
        this.actions.lastPage();
        return;
      case '+':
      case '=':
        event.preventDefault();
        this.actions.zoomIn();
        return;
      case '-':
      case '_':
        event.preventDefault();
        this.actions.zoomOut();
        return;
      case '0':
        event.preventDefault();
        this.actions.resetZoom();
        return;
      case 'Escape':
        this.actions.close();
        return;
      default:
        return;
    }
  }
}