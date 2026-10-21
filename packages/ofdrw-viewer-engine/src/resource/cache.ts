/**
 * 通用 LRU 缓存。
 *
 * 预算按字节或条目数限制；图片/字体缓存使用字节预算，页面模型缓存使用条目预算。
 * `maxBytes`/`maxEntries` 为 0 表示该维度不限制。
 */

/** 缓存预算；`maxBytes` 与 `maxEntries` 同时生效。 */
export interface CacheBudget {
  /** 字节预算，byte；0 表示不限制。 */
  maxBytes: number;
  /** 条目预算；0 表示不限制。 */
  maxEntries: number;
}

/** 缓存统计。 */
export interface CacheStats {
  /** 当前条目数。 */
  entries: number;
  /** 当前估算字节数，byte。 */
  bytes: number;
}

/**
 * 泛型 LRU 缓存。
 *
 * @typeParam K 键类型。
 * @typeParam V 值类型。
 */
export class LruCache<K, V> {
  /** 按最近使用顺序保存；Map 迭代顺序中最前的是最久未使用。 */
  private readonly map = new Map<K, V>();
  /** 当前估算字节数，byte。 */
  private bytes = 0;

  /**
   * @param budget 预算。
   * @param sizeOf 值大小估算（单位 byte）；缺省按 1 byte/条计。
   */
  constructor(
    private readonly budget: CacheBudget,
    private readonly sizeOf: (value: V) => number = () => 1,
  ) {}

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
   * 写入并可能淘汰旧条目。
   *
   * @param key 键。
   * @param value 值。
   */
  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.delete(key);
    }
    const size = Math.max(0, this.sizeOf(value));
    this.map.set(key, value);
    this.bytes += size;
    this.evictOverBudget();
  }

  /**
   * 删除条目。
   *
   * @param key 键。
   * @returns 是否存在并删除。
   */
  delete(key: K): boolean {
    if (!this.map.has(key)) return false;
    const value = this.map.get(key) as V;
    this.bytes -= Math.max(0, this.sizeOf(value));
    if (this.bytes < 0) this.bytes = 0;
    this.map.delete(key);
    return true;
  }

  /** 清空缓存。 */
  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  /** 当前统计。 */
  stats(): CacheStats {
    return { entries: this.map.size, bytes: this.bytes };
  }

  /** 按预算从最久未使用开始淘汰。 */
  private evictOverBudget(): void {
    while (this.map.size > 0) {
      const overEntries = this.budget.maxEntries > 0 && this.map.size > this.budget.maxEntries;
      const overBytes = this.budget.maxBytes > 0 && this.bytes > this.budget.maxBytes;
      if (!overEntries && !overBytes) break;
      const oldestKey = this.map.keys().next().value as K;
      this.delete(oldestKey);
    }
  }
}