/**
 * 公共 API 层内部缓存。
 *
 * `LruCache`（resource/cache.ts）不暴露淘汰回调，无法在图片淘汰时调用
 * `ImageBitmap.close()`；这里提供一个可释放的 LRU，用于解码图片/字体/XML 等
 * 需要显式释放的资源。预算为 0 的维度表示不限制。
 */

/** 可释放 LRU 选项。 */
export interface DisposableLruOptions<V> {
  /** 字节预算，byte；0 表示不限制。 */
  maxBytes?: number;
  /** 条目预算；0 表示不限制。 */
  maxEntries?: number;
  /** 单条目的字节估算，byte。 */
  sizeOf: (value: V) => number;
  /** 淘汰/删除/清空时的释放回调。 */
  dispose?: (value: V) => void;
}

/** 缓存统计。 */
export interface DisposableLruStats {
  /** 当前条目数。 */
  entries: number;
  /** 当前估算字节数，byte。 */
  bytes: number;
}

/**
 * 带释放回调的 LRU 缓存。
 *
 * @typeParam K 键类型。
 * @typeParam V 值类型。
 */
export class DisposableLruCache<K, V> {
  /** 按最近使用顺序保存；Map 头部为最久未使用。 */
  private readonly map = new Map<K, V>();
  /** 当前估算字节数，byte。 */
  private bytes = 0;
  private readonly maxBytes: number;
  private readonly maxEntries: number;

  /**
   * @param options 预算、大小估算与释放回调。
   */
  constructor(private readonly options: DisposableLruOptions<V>) {
    this.maxBytes = Math.max(0, options.maxBytes ?? 0);
    this.maxEntries = Math.max(0, options.maxEntries ?? 0);
  }

  /**
   * 读取并刷新最近使用顺序。
   *
   * @param key 键。
   * @returns 值或 undefined。
   */
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /**
   * 判断键是否存在（不刷新顺序）。
   *
   * @param key 键。
   * @returns 是否存在。
   */
  has(key: K): boolean {
    return this.map.has(key);
  }

  /**
   * 写入并可能淘汰旧条目。
   *
   * @param key 键。
   * @param value 值。
   */
  set(key: K, value: V): void {
    if (this.map.has(key)) this.delete(key);
    this.map.set(key, value);
    this.bytes += this.sizeOf(value);
    this.evictOverBudget();
  }

  /**
   * 删除条目并释放。
   *
   * @param key 键。
   * @returns 是否存在并删除。
   */
  delete(key: K): boolean {
    if (!this.map.has(key)) return false;
    const value = this.map.get(key) as V;
    this.bytes -= this.sizeOf(value);
    if (this.bytes < 0) this.bytes = 0;
    this.map.delete(key);
    this.dispose(value);
    return true;
  }

  /** 清空缓存并释放所有值。 */
  clear(): void {
    for (const value of this.map.values()) this.dispose(value);
    this.map.clear();
    this.bytes = 0;
  }

  /** 当前统计。 */
  stats(): DisposableLruStats {
    return { entries: this.map.size, bytes: this.bytes };
  }

  /** 按预算从最久未使用开始淘汰。 */
  private evictOverBudget(): void {
    while (this.map.size > 0) {
      const overEntries = this.maxEntries > 0 && this.map.size > this.maxEntries;
      const overBytes = this.maxBytes > 0 && this.bytes > this.maxBytes;
      if (!overEntries && !overBytes) break;
      const oldestKey = this.map.keys().next().value as K;
      this.delete(oldestKey);
    }
  }

  /**
   * 计算值的大小；实现异常时按 0 计，避免缓存写入失败。
   *
   * @param value 值。
   * @returns 字节数。
   */
  private sizeOf(value: V): number {
    const size = this.options.sizeOf(value);
    return Number.isFinite(size) && size > 0 ? size : 0;
  }

  /**
   * 释放值；释放异常不向调用方传播。
   *
   * @param value 值。
   */
  private dispose(value: V): void {
    try {
      this.options.dispose?.(value);
    } catch {
      // 释放失败不影响缓存一致性。
    }
  }
}