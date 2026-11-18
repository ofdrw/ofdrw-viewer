/**
 * 对话框初始焦点单测（UI 动作处理机制设计 §8.3）。
 *
 * 安全确认类对话框（外部链接访问）必须默认聚焦「取消」，防回车误确认。
 */
import { describe, expect, it } from 'vitest';
import { DialogManager } from '../../../src/ui/dialog';

/** 创建挂载到文档的管理器。 */
function createManager(): DialogManager {
  const layer = document.createElement('div');
  document.body.appendChild(layer);
  return new DialogManager({ layer, translator: { t: (key: string) => key } as never });
}

describe('DialogManager 初始焦点', () => {
  it('initialFocus=cancel 且取消在前时聚焦「取消」', () => {
    const manager = createManager();
    const el = manager.open({
      name: 'externalLink',
      title: 'T',
      role: 'alertdialog',
      initialFocus: 'cancel',
      actions: [{ label: '取消' }, { label: '打开', primary: true }],
    });
    const cancel = [...el.querySelectorAll('button')].find((b) => b.textContent === '取消');
    expect(document.activeElement).toBe(cancel);
    manager.close();
  });

  it('initialFocus=cancel 且取消在末位时仍聚焦「取消」而非主按钮', () => {
    const manager = createManager();
    const el = manager.open({
      name: 'externalLink',
      title: 'T',
      role: 'alertdialog',
      initialFocus: 'cancel',
      actions: [{ label: '打开', primary: true }, { label: '取消' }],
    });
    const cancel = [...el.querySelectorAll('button')].find((b) => b.textContent === '取消');
    expect(document.activeElement).toBe(cancel);
    manager.close();
  });

  it('initialFocus=primary 时聚焦主按钮', () => {
    const manager = createManager();
    const el = manager.open({
      name: 'plain',
      title: 'T',
      initialFocus: 'primary',
      actions: [{ label: '取消' }, { label: '确定', primary: true }],
    });
    const primary = [...el.querySelectorAll('button')].find((b) => b.textContent === '确定');
    expect(document.activeElement).toBe(primary);
    manager.close();
  });
});
