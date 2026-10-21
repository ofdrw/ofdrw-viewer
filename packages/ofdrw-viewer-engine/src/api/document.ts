/**
 * OFD 文档公共入口（对应设计方案 15.1）。
 *
 * T1 只冻结形状；实现由 T12（dev-api）完成：打开、页树、按需加载、缓存、取消、关闭。
 */

import type { OFDOpenOptions } from './types';
import type { OFDPage } from './page';
import { notImplemented } from '../common/not-implemented';

/**
 * 已打开的 OFD 文档。
 *
 * 生命周期：`OFDDocument.open()` → `getPage()` → `close()`；`close()` 可重复调用。
 */
export class OFDDocument {
  /** 页数，打开后立即可用。 */
  readonly pageCount: number = 0;

  /**
   * 打开文档。
   *
   * @param options 打开参数（来源、资源限制、字体/图片插件、渲染器等）。
   * @returns 文档实例。
   */
  static async open(options: OFDOpenOptions): Promise<OFDDocument> {
    void options;
    return notImplemented('OFDDocument.open');
  }

  /**
   * 按需加载指定页；索引从 0 开始。
   *
   * @param pageIndex 页索引。
   * @returns 页面实例。
   */
  async getPage(pageIndex: number): Promise<OFDPage> {
    void pageIndex;
    return notImplemented('OFDDocument.getPage');
  }

  /** 关闭并释放所有缓存；可重复调用。 */
  async close(): Promise<void> {
    return notImplemented('OFDDocument.close');
  }
}