/**
 * 基础可访问性：焦点陷阱、焦点恢复、ARIA 状态与读屏播报。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FocusTrap,
  LiveAnnouncer,
  getFocusableElements,
  restoreFocus,
  setDisabled,
  setExpanded,
  setPressed,
} from '../../../src/a11y';

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function createButtons(count: number): { container: HTMLElement; buttons: HTMLButtonElement[] } {
  const container = document.createElement('div');
  const buttons: HTMLButtonElement[] = [];
  for (let index = 0; index < count; index += 1) {
    const button = document.createElement('button');
    button.textContent = `button-${index}`;
    container.appendChild(button);
    buttons.push(button);
  }
  document.body.appendChild(container);
  return { container, buttons };
}

describe('FocusTrap', () => {
  it('Tab 在容器内循环，Esc 回调，关闭后焦点回到触发元素', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'trigger';
    document.body.appendChild(trigger);
    trigger.focus();

    const { container, buttons } = createButtons(2);
    const onEscape = vi.fn();
    const trap = new FocusTrap(container, { onEscape });
    trap.activate();
    expect(trap.isActive).toBe(true);
    expect(document.activeElement).toBe(buttons[0]);

    buttons[1].focus();
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(buttons[0]);

    buttons[0].focus();
    container.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(buttons[1]);

    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(onEscape).toHaveBeenCalledTimes(1);

    trap.deactivate();
    expect(document.activeElement).toBe(trigger);
  });

  it('不移动焦点时可以保持外部焦点', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const { container } = createButtons(1);
    const trap = new FocusTrap(container);
    trap.activate({ moveFocus: false });
    expect(document.activeElement).toBe(trigger);
    trap.deactivate({ restoreFocus: false });
    expect(document.activeElement).toBe(trigger);
  });
});

describe('焦点工具', () => {
  it('过滤隐藏与禁用元素', () => {
    const { container, buttons } = createButtons(3);
    buttons[1].disabled = true;
    buttons[2].hidden = true;
    expect(getFocusableElements(container)).toEqual([buttons[0]]);
  });

  it('不恢复已断开或不可聚焦的元素', () => {
    const { buttons } = createButtons(1);
    const trigger = buttons[0];
    trigger.focus();
    trigger.remove();
    restoreFocus(trigger);
    expect(document.activeElement).not.toBe(trigger);
  });
});

describe('ARIA 状态辅助', () => {
  it('禁用时写 aria-disabled 与原因 tooltip，恢复时清理', () => {
    const button = document.createElement('button') as HTMLButtonElement;
    document.body.appendChild(button);
    setDisabled(button, true, '打印不可用');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('data-feature-disabled')).toBe('true');
    expect(button.title).toBe('打印不可用');
    setDisabled(button, false);
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    expect(button.title).toBe('');
  });

  it('展开与按下状态', () => {
    const button = document.createElement('button');
    setExpanded(button, true);
    setPressed(button, true);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    setExpanded(button, false);
    setPressed(button, false);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('LiveAnnouncer', () => {
  it('异步写入 aria-live 区域并支持清空', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    document.body.appendChild(root);
    const announcer = new LiveAnnouncer(root);
    expect(announcer.element.getAttribute('aria-live')).toBe('polite');
    announcer.announce('第 2 页，共 5 页');
    vi.runAllTimers();
    expect(announcer.element.textContent).toBe('第 2 页，共 5 页');
    announcer.clear();
    expect(announcer.element.textContent).toBe('');
    announcer.destroy();
    expect(root.contains(announcer.element)).toBe(false);
  });
});