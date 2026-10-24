/**
 * 阅读器字体来源与解析（字体配置方案设计 §2、§3.1）。
 *
 * UI 是浏览器中唯一的网络读取入口：宿主用 `FontSource` 声明字体来源，本模块把它
 * 读取为引擎可用的 `FontInput` 字节后交给引擎。读到的始终是**完整字体文件**字节，
 * UI 不做字体子集化、格式转换或内容解析。
 *
 * 读取失败（网络错误、非 2xx、缺少 loader、loader 返回 null 等）只跳过该来源并
 * 通过 `onError` 上报，由调用方转成 `W_FONT_MISSING` warning，不阻断文档打开。
 */

import type {
  FontAliasTable,
  FontInput,
} from '@ofdrw/ofdrw-viewer-engine';
import { DEFAULT_FONT_ALIASES } from '@ofdrw/ofdrw-viewer-engine';
import { getGlobalObject } from './compat';
import { mergeHeaders } from './document-controller';

/**
 * 单个字体来源。
 *
 * 与 `CertificateSource` 保持同样的四态形态：
 * - `data`：已读好的字体字节，直接交给引擎，不复制；
 * - `url`：由浏览器 `fetch` 读取，`headers` 与阅读器 `requestInit.headers` 合并（来源优先）；
 * - `path` / `filePath`：由宿主 `loader` 读取，UI 自身不访问文件系统。
 *
 * `family` 只用于诊断与别名匹配，不参与“这个字体能不能用”的判断；缺省时引擎按
 * `default-<index>` 命名。
 */
export type FontSource =
  | { readonly data: ArrayBuffer | Uint8Array; readonly family?: string }
  | {
      readonly url: string;
      readonly headers?: Record<string, string>;
      readonly family?: string;
    }
  | { readonly path: string; readonly family?: string }
  | { readonly filePath: string; readonly family?: string };

/** 自定义字体加载器；`path`/`filePath` 来源必须由宿主平台实现。 */
export type FontSourceLoader = (
  source: Extract<FontSource, { path: string } | { filePath: string }>,
) => ArrayBuffer | Uint8Array | null | Promise<ArrayBuffer | Uint8Array | null>;

/**
 * 字体加载进度。
 *
 * 字体文件较大（站点兜底字体约 11 MiB），需要让宿主在加载动画上体现等待过程，
 * 而不是表现为页面卡死。
 */
export interface FontLoadProgress {
  /** 已完成读取的来源数（含失败）。 */
  readonly loaded: number;
  /** 本次需要读取的来源总数。 */
  readonly total: number;
  /** 已下载字节数，byte；无法获取总长时该值仍会随 chunks 增长。 */
  readonly loadedBytes: number;
  /** 已知总字节数，byte；服务器未提供 Content-Length 时为 0。 */
  readonly totalBytes: number;
}

/** 阅读器字体配置；只在实例创建时生效，修改后需重新 `open()`。 */
export interface ViewerFontOptions {
  /** 默认字体：文档字体完全缺省时的替代字体，引擎中优先级高于 `supplementary`。 */
  readonly default?: readonly FontSource[];
  /** 补充字体：主字体存在但缺字时逐字形补齐。 */
  readonly supplementary?: readonly FontSource[];
  /** path/filePath 来源的读取器；未提供时这两类来源被跳过并 warning。 */
  readonly loader?: FontSourceLoader;
  /**
   * 额外字体别名组。
   *
   * 语义为**追加**：UI 先以内置别名组（引擎导出的 `DEFAULT_FONT_ALIASES`）为基准，
   * 再拼上宿主提供的组后整体传给引擎，避免宿主配置覆写内置的 `宋体 → simsun` 等映射。
   */
  readonly aliases?: FontAliasTable;
}

/** 字体来源解析器选项。 */
export interface FontSourceResolverOptions {
  /** path/filePath 来源的读取器；缺省时这两类来源解析失败。 */
  readonly loader?: FontSourceLoader;
  /** 文档请求参数；只使用 `headers` 与字体来源 headers 合并（来源优先）。 */
  readonly requestInit?: RequestInit;
}

/**
 * 生成传给引擎的字体别名表：内置别名组 + 宿主追加组。
 *
 * 引擎 `FontLibraryOptions.aliases` 语义是“传入即整体替换”，因此宿主只传自己的组时
 * 会丢失内置映射；此处统一做追加。同组的重复组按数组顺序保留，引擎内部再做归一化去重。
 *
 * @param aliases 宿主追加的别名组；省略时返回内置别名组本身。
 * @returns 内置组在前、宿主组在后的只读别名表。
 */
export function composeFontAliases(
  aliases: FontAliasTable | undefined,
): FontAliasTable {
  if (!aliases || aliases.length === 0) return DEFAULT_FONT_ALIASES;
  return Object.freeze([
    ...DEFAULT_FONT_ALIASES.map((group) => group),
    ...aliases.map((group) => group),
  ]);
}

/**
 * 单次读取的缓存记录。
 *
 * `value` 只在读取成功且未被取消时写入；`cancelled` 在读取被取消时置位，
 * 保证中止后的来源不会以旧字节出现在后续 `open()` 中。
 */
interface FontCacheEntry {
  /** 进行中或已完成的读取 Promise。 */
  promise: Promise<FontInput>;
  /** 读取成功后的引擎字体输入；进行中、失败或被取消时为 undefined。 */
  value?: FontInput;
  /** 读取是否已被取消（dispose 或 open 信号中止）。 */
  cancelled: boolean;
}

/** 字体来源解析器：把一个或多个 `FontSource` 读取为引擎可用的 `FontInput`。 */
export class FontSourceResolver {
  private readonly loader: FontSourceLoader | undefined;
  private readonly requestInit: RequestInit | undefined;
  private readonly fetchImpl: typeof fetch | null;
  /** 按来源键缓存的读取结果；`data` 来源不进入缓存。 */
  private readonly cache = new Map<string, FontCacheEntry>();
  /** 进行中读取的取消函数；`dispose()` 统一中止。 */
  private readonly pending = new Set<() => void>();
  private disposed = false;

  /**
   * @param options 字体加载器与文档请求参数。
   */
  constructor(options: FontSourceResolverOptions = {}) {
    this.loader = options.loader;
    this.requestInit = options.requestInit;
    const globalObject = getGlobalObject();
    const globalFetch = (globalObject as { fetch?: typeof fetch }).fetch;
    // 浏览器原生 fetch 必须绑定全局对象，否则调用时丢失 this。
    this.fetchImpl = globalFetch ? globalFetch.bind(globalObject) : null;
  }

  /**
   * 解析一组字体来源。
   *
   * 读取规则：`data` 直接透传；`url` 用 fetch 读取（非 2xx 视为失败）；`path`/`filePath`
   * 走 loader（返回 null 视为失败）。`url`/`path`/`filePath` 按来源键去重，两个列表引用
   * 同一 URL 时只读取一次；失败结果不缓存，下次 `open()` 重新尝试。取消信号中止后
   * 不再写入结果，全部来源读取结束后返回已成功读取的字节。
   *
   * @param sources 字体来源列表；空列表直接返回空数组，不产生任何请求。
   * @param signal 取消信号，复用本次 `open()` 的 `AbortSignal`；已中止时不读取并返回空数组。
   * @param onError 单个来源读取失败回调；参数为原始来源与错误（取消也通过它上报）。

   * @returns 读取成功的字体字节；全部失败时为空数组。
   */
  async resolve(
    sources: readonly FontSource[],
    signal: AbortSignal | undefined,
    onError: (source: FontSource, error: unknown) => void,
    onProgress?: (progress: FontLoadProgress) => void,
  ): Promise<FontInput[]> {
    if (this.disposed || sources.length === 0) return [];
    if (signal?.aborted) return [];
    const total = sources.length;
    let loaded = 0;
    let loadedBytes = 0;
    let totalBytes = 0;
    const emit = (): void => {
      if (!onProgress) return;
      onProgress({ loaded, total, loadedBytes, totalBytes });
    };
    // 首个来源开始读取前先发一次 0 进度，让加载动画立即进入“正在加载字体”状态。
    emit();
    const tasks = sources.map(async (source) => {
      try {
        const input = await this.readSource(source, signal, (deltaBytes, length) => {
          loadedBytes += deltaBytes;
          if (length !== undefined) totalBytes += length;
          emit();
        });
        loaded += 1;
        emit();
        return input;
      } catch (error) {
        onError(source, error);
        loaded += 1;
        emit();
        return null;
      }
    });
    const results = await Promise.all(tasks);
    return results.filter((input): input is FontInput => input !== null && input !== undefined);
  }

  /**
   * 释放进行中的请求与缓存。
   *
   * 中止后 `resolve()` 立即返回空数组，进行中来源的读取以 AbortError 失败（同样被
   * `resolve()` 跳过）；已完成的请求不可撤销。
   */
  dispose(): void {
    this.disposed = true;
    for (const cancel of this.pending) cancel();
    this.pending.clear();
    this.cache.clear();
  }

  /**
   * 读取单个来源；失败时抛错，由 `resolve()` 统一回调。
   *
   * `data` 来源直接透传；其余来源按来源键复用进行中的 Promise 或缓存结果。
   *
   * @param source 字体来源。
   * @param signal 本次 `open()` 的取消信号。
   * @returns 引擎字体输入。
   * @throws {Error} 来源非法、缺少 loader、读取失败、被取消或来源字节为空。
   */
  private readSource(
    source: FontSource,
    signal: AbortSignal | undefined,
    onChunk: (deltaBytes: number, totalBytes: number | undefined) => void,
  ): Promise<FontInput> {
    if (!isFontSourceObject(source)) {
      return Promise.reject(new Error('字体来源必须是对象'));
    }
    if ('data' in source) {
      const data = source.data;
      if (!isFontBytes(data)) {
        return Promise.reject(new Error('字体来源 data 必须是 ArrayBuffer 或 Uint8Array'));
      }
      if (data.byteLength === 0) return Promise.reject(new Error('字体来源 data 为空'));
      onChunk(data.byteLength, data.byteLength);
      return Promise.resolve(withFamily({ data }, source.family));
    }
    const key = fontSourceKey(source);
    if (!key) return Promise.reject(new Error('字体来源缺少 url/path/filePath'));
    if (this.disposed || signal?.aborted) return Promise.reject(createAbortError());
    const cached = this.cache.get(key);
    if (cached) {
      // 进行中的读取复用同一 Promise；已取消的读取不返回结果，由下次 open 重新读取。
      return settleEntry(cached).then((input) => {
        onChunk(byteLengthOf(input.data), byteLengthOf(input.data));
        return input;
      });
    }
    const entry: FontCacheEntry = {
      promise: undefined as unknown as Promise<FontInput>,
      cancelled: false,
    };
    const controller = new AbortController();
    const cancel = (): void => {
      entry.cancelled = true;
      controller.abort();
    };
    this.pending.add(cancel);
    const forwardSignal = (): void => cancel();
    if (signal) signal.addEventListener('abort', forwardSignal, { once: true });
    const release = (): void => {
      this.pending.delete(cancel);
      if (signal) signal.removeEventListener('abort', forwardSignal);
    };
    entry.promise = this.loadSource(source, key, controller.signal, onChunk).then(
      (value) => {
        release();
        // 取消后不写入结果：中止的来源不会以旧字节出现在后续 open 中。
        if (entry.cancelled) {
          entry.value = undefined;
          throw createAbortError();
        }
        entry.value = value;
        return value;
      },
      (error: unknown) => {
        release();
        // 失败/取消都不缓存：移除后下次 open 重新尝试。
        if (this.cache.get(key) === entry) this.cache.delete(key);
        throw error;
      },
    );
    this.cache.set(key, entry);
    return settleEntry(entry);
  }

  /**
   * 实际执行一次读取（url 或 loader）。
   *
   * @param source 字体来源（非 data）。
   * @param key 来源键，用于诊断。
   * @param signal 本次读取的取消信号。
   * @returns 引擎字体输入。
   * @throws {Error} 读取失败或结果为空/非法。
   */
  private async loadSource(
    source: Exclude<FontSource, { data: unknown }>,
    key: string,
    signal: AbortSignal,
    onChunk: (deltaBytes: number, totalBytes: number | undefined) => void,
  ): Promise<FontInput> {
    if (signal.aborted) throw createAbortError();
    let data: ArrayBuffer | Uint8Array;
    if ('url' in source) {
      data = await this.fetchFont(source, signal, onChunk);
    } else {
      if (!this.loader) throw new Error('未配置字体加载器（fonts.loader），无法读取 path/filePath 来源');
      const loaded = await this.loader(source);
      if (loaded === null || loaded === undefined) throw new Error('字体加载器未返回字节');
      if (!isFontBytes(loaded)) {
        throw new Error('字体加载器返回的必须是 ArrayBuffer 或 Uint8Array');
      }
      data = loaded;
      onChunk(byteLengthOf(data), byteLengthOf(data));
    }
    if (signal.aborted) throw createAbortError();
    if (data.byteLength === 0) throw new Error(`字体来源为空：${key}`);
    return withFamily({ data }, source.family);
  }

  /**
   * 用 fetch 读取 URL 字体。
   *
   * 请求头为 `requestInit.headers` 与来源 `headers` 的合并结果（来源优先），与文档
   * 来源共用 `mergeHeaders()` 口径。
   *
   * @param source 带 url 的字体来源。
   * @param signal 合并后的取消信号。
   * @returns 字体字节。
   * @throws {Error} 环境没有 fetch、网络错误或响应非 2xx。
   */
  private async fetchFont(
    source: { readonly url: string; readonly headers?: Record<string, string> },
    signal: AbortSignal,
    onChunk: (deltaBytes: number, totalBytes: number | undefined) => void,
  ): Promise<ArrayBuffer> {
    if (!this.fetchImpl) throw new Error('当前环境没有 fetch，无法读取字体 URL');
    const headers = mergeHeaders(this.requestInit?.headers, source.headers);
    // requestInit 只取 headers 去合并；它的 signal 不沿用，统一由本次 open 的信号覆盖。
    const init: RequestInit = { ...(headers ? { headers } : {}), signal };
    const response = await this.fetchImpl(source.url, init);
    if (!response.ok) {
      throw new Error(`字体请求失败：HTTP ${response.status}`);
    }
    // 兼容缺少 headers 的极简 Response 实现（例如测试替身）：无法确定总长时按未知处理。
    const declaredHeader = response.headers?.get?.('content-length') ?? null;
    const declared = Number(declaredHeader ?? '');
    const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : undefined;
    // 字体可达数十 MiB：优先流式读取以暴露下载进度；环境无 body 流时退回一次性读取。
    const body = (response as { body?: ReadableStream<Uint8Array> | null }).body;
    if (!body || typeof body.getReader !== 'function') {
      const buffer = await response.arrayBuffer();
      onChunk(buffer.byteLength, totalBytes ?? buffer.byteLength);
      return buffer;
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        chunks.push(value);
        received += value.byteLength;
        onChunk(value.byteLength, totalBytes);
      }
    } finally {
      reader.releaseLock();
    }
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged.buffer;
  }
}

/**
 * 判断值是否为对象形态的字体来源。
 *
 * @param value 待判断值。
 * @returns 是对象时 true。
 */
function isFontSourceObject(value: unknown): value is FontSource {
  return typeof value === 'object' && value !== null;
}

/**
 * 判断值是否为可用的字体字节。
 *
 * @param data 待判断值。
 * @returns 为 `ArrayBuffer` 或 `Uint8Array` 时 true。
 */
function isFontBytes(data: unknown): data is ArrayBuffer | Uint8Array {
  return data instanceof ArrayBuffer || data instanceof Uint8Array;
}

/**
 * 把缓存记录转换为调用方可见的 Promise。
 *
 * 读取被取消（`dispose()` 或 open 信号中止）时以 AbortError 失败，即使底层读取已经完成，
 * 保证取消后不把结果交给调用方。
 *
 * @param entry 缓存记录。
 * @returns 读取成功时兑现引擎字体输入。
 */
function settleEntry(entry: FontCacheEntry): Promise<FontInput> {
  return entry.promise.then((value) => {
    if (entry.cancelled) throw createAbortError();
    return value;
  });
}

/**
 * 生成来源去重键。
 *
 * `url` 按完整 URL 字符串（含 query）去重，不按字体名；`data` 返回 null（不缓存）。
 *
 * @param source 字体来源。
 * @returns 形如 `url:<url>` / `path:<path>` / `filePath:<filePath>` 的键；`data` 为 null。
 */
function fontSourceKey(
  source: Exclude<FontSource, { data: unknown }>,
): string | null {
  if ('url' in source) return source.url ? `url:${source.url}` : null;
  if ('path' in source) return source.path ? `path:${source.path}` : null;
  if ('filePath' in source) return source.filePath ? `filePath:${source.filePath}` : null;
  return null;
}

/**
 * 组合引擎字体输入；`family` 缺省时不写该字段。
 *
 * @param input 已读取的字体字节。
 * @param family 字体族名。
 * @returns 引擎字体输入。
 */
function withFamily(
  input: { readonly data: ArrayBuffer | Uint8Array },
  family: string | undefined,
): FontInput {
  return family ? { data: input.data, family } : { data: input.data };
}

/** 创建取消错误（`name` 为 AbortError，便于调用方统一识别）。 */
function createAbortError(): Error {
  const error = new Error('字体读取已取消');
  error.name = 'AbortError';
  return error;
}

/**
 * 读取字体字节长度。
 *
 * @param data 字体字节。
 * @returns 字节数，单位 byte。
 */
function byteLengthOf(data: ArrayBuffer | Uint8Array): number {
  return data instanceof Uint8Array ? data.byteLength : data.byteLength;
}
