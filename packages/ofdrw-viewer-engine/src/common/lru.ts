/**
 * 通用 LRU 缓存。
 *
 * 同时支持“条目数”和“字节数”两种预算；容量参数为 0 或负数表示不限制。
 * 该实现只做同步内存缓存，不依赖平台 API。
 */

/** LRU 缓存选项。 */
export interface LruCacheOptions<V> {
  /** 最大条目数；缺省不限制。 */
  maxEntries?: number;
  /** 最大字节数；缺省不限制。 */
  maxBytes?: number;
  /**
   * 计算单个值的字节数；缺省按 1 计。
   * 设置 `maxBytes` 时应提供，否则字节预算退化为条目数预算。
   */
  sizeOf?: (value: V) => number;
}

/** LRU 统计。 */
export interface LruCacheStats {
  /** 当前条目数。 */
  entries: number;
  /** 当前累计字节数（由 `sizeOf` 估算）。 */
  bytes: number;
  /** 命中次数。 */
  hits: number;
  /** 未命中次数。 */
  misses: number;
  /** 被淘汰的条目数（含因单条超预算而未缓存的条目）。 */
  evictions: number;
}

/** 缓存条目。 */
interface CacheEntry<V> {
  value: V;
  size: number;
}

/**
 * 通用 LRU 缓存。
 *
 * 读取会刷新最近使用顺序；写入后按条目数/字节数从最旧开始淘汰。
 * 单个值超过字节预算时不会缓存，避免一个超大对象挤掉全部小对象。
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, CacheEntry<V>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly sizeOf: (value: V) => number;
  private byteSize = 0;
  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;

  /**
   * 创建缓存。
   *
   * @param options 容量与计量选项。
   */
  constructor(options: LruCacheOptions<V> = {}) {
    this.maxEntries = normalizeLimit(options.maxEntries);
    this.maxBytes = normalizeLimit(options.maxBytes);
    this.sizeOf = options.sizeOf ?? (() => 1);
  }

  /** 当前条目数。 */
  get size(): number {
    return this.map.size;
  }

  /** 当前累计字节数。 */
  get bytes(): number {
    return this.byteSize;
  }

  /**
   * 读取并刷新最近使用顺序。
   *
   * @param key 缓存键。
   * @returns 缓存值或 undefined。
   */
  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      this.missCount += 1;
      return undefined;
    }
    this.hitCount += 1;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /**
   * 读取但不刷新最近使用顺序。
   *
   * @param key 缓存键。
   * @returns 缓存值或 undefined。
   */
  peek(key: K): V | undefined {
    return this.map.get(key)?.value;
  }

  /**
   * 判断是否存在。
   *
   * @param key 缓存键。
   * @returns 是否存在。
   */
  has(key: K): boolean {
    return this.map.has(key);
  }

  /**
   * 写入缓存；已存在时覆盖并刷新顺序。
   *
   * @param key 缓存键。
   * @param value 缓存值。
   */
  set(key: K, value: V): void {
    const size = sanitizeSize(this.sizeOf(value));
    this.delete(key);
    if (this.maxBytes > 0 && size > this.maxBytes) {
      // 单条已超预算，缓存它只会立刻被淘汰。
      this.evictionCount += 1;
      return;
    }
    this.map.set(key, { value, size });
    this.byteSize += size;
    this.evict();
  }

  /**
   * 删除条目。
   *
   * @param key 缓存键。
   * @returns 是否删除了条目。
   */
  delete(key: K): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    this.map.delete(key);
    this.byteSize -= entry.size;
    return true;
  }

  /** 清空缓存并重置计量（保留累计统计）。 */
  clear(): void {
    this.map.clear();
    this.byteSize = 0;
  }

  /**
   * 按当前缓存状态淘汰，直到满足条目数/字节预算。
   *
   * @returns 本次淘汰的条目数。
   */
  evict(): number {
    let removed = 0;
    while (
      (this.maxEntries > 0 && this.map.size > this.maxEntries) ||
      (this.maxBytes > 0 && this.byteSize > this.maxBytes)
    ) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      const entry = this.map.get(oldest.value as K);
      this.map.delete(oldest.value as K);
      if (entry) this.byteSize -= entry.size;
      this.evictionCount += 1;
      removed += 1;
    }
    return removed;
  }

  /** 当前统计快照。 */
  stats(): LruCacheStats {
    return {
      entries: this.map.size,
      bytes: this.byteSize,
      hits: this.hitCount,
      misses: this.missCount,
      evictions: this.evictionCount,
    };
  }
}

/**
 * 归一化容量：0/负数/非有限值视为“不限制”（返回 0）。
 *
 * @param value 原始容量。
 * @returns 非负容量；0 表示不限制。
 */
function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/**
 * 归一化单个条目的字节数；非法值按 0。
 *
 * @param value 原始字节数。
 * @returns 非负整数。
 */
function sanitizeSize(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value);
}