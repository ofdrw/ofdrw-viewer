/**
 * 读屏播报器：把页码、查找结果等状态写入隐藏的 `aria-live` 区域。
 *
 * 同一文本重复播报时先清空再写入，确保读屏再次朗读。
 */
export class LiveAnnouncer {
  /** `aria-live` 区域元素。 */
  readonly element: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 创建播报器并挂载到根节点。
   *
   * @param root 阅读器根节点。
   * @param politeness 播报优先级；默认 `polite`。
   */
  constructor(
    root: HTMLElement,
    politeness: 'polite' | 'assertive' = 'polite',
  ) {
    const doc = root.ownerDocument;
    this.element = doc.createElement('div');
    this.element.className = 'ofd-sr-only ofd-viewer__announcer';
    this.element.setAttribute('aria-live', politeness);
    this.element.setAttribute('aria-atomic', 'true');
    root.appendChild(this.element);
  }

  /**
   * 播报一段文本。
   *
   * @param message 文本；空字符串忽略。
   */
  announce(message: string): void {
    if (message.length === 0) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.element.textContent = '';
    this.timer = setTimeout(() => {
      this.element.textContent = message;
      this.timer = null;
    }, 0);
  }

  /** 立即清空播报内容并取消等待中的播报。 */
  clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.element.textContent = '';
  }

  /** 移除播报区域。 */
  destroy(): void {
    this.clear();
    this.element.remove();
  }
}