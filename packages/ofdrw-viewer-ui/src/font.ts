/**
 * 阅读器字体来源与解析（字体配置方案设计 §2、§3.1；本地字体加载方案设计 §3.1、§6）。
 *
 * UI 是浏览器中唯一的网络读取入口：宿主用 `FontSource` 声明字体来源，本模块把它
 * 读取为引擎可用的 `FontInput` 字节后交给引擎。读到的始终是**完整字体文件**字节，
 * UI 不做字体子集化、格式转换或内容解析。
 *
 * 本地字体（`{ local }`，`queryLocalFonts`）是可选来源：浏览器不支持、未授权、被站点
 * 策略禁止或本机未安装时，该来源被跳过，其余来源与「未引入本功能」时完全一致。
 *
 * 读取失败（网络错误、非 2xx、缺少 loader、loader 返回 null、本地字体不可用等）只跳过
 * 该来源并通过 `onError` 上报，由调用方转成 `W_FONT_MISSING` warning，不阻断文档打开。
 */

import type {
  FontAliasTable,
  FontInput,
} from '@ofdrw/ofdrw-viewer-engine';
import { DEFAULT_FONT_ALIASES } from '@ofdrw/ofdrw-viewer-engine';
import { getGlobalObject } from './compat';
import { mergeHeaders } from './document-controller';
import { expandLocalFontCandidates } from './local-font-names';
import { queryLocalFontFaces, readLocalFontInput } from './local-fonts';

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
 *
 * `local` 来源按名字查询本机已安装字体（`queryLocalFonts`），需要 `fonts.localFonts`
 * 开启且用户已授权，否则按「不支持」跳过并 warning。
 */
export type FontSource =
  | { readonly data: ArrayBuffer | Uint8Array; readonly family?: string }
  | {
      readonly url: string;
      readonly headers?: Record<string, string>;
      readonly family?: string;
    }
  | { readonly path: string; readonly family?: string }
  | { readonly filePath: string; readonly family?: string }
  | {
      /** 本机字体名：PostScript 名、英文名或中文名；数组按顺序尝试，命中即停止。 */
      readonly local: string | readonly string[] | LocalFontDeclaration;
      /** 覆盖读到的字体面 family；缺省用字体面自身的 family。 */
      readonly family?: string;
    };

/**
 * 以文档声明形态给出的本机字体。
 *
 * 传入后按 `expandLocalFontCandidates()` 展开候选（中文名 → 真实 PostScript 名并生成
 * 变体回退链），命中后 `FontInput.family` 取 `fontName`，使引擎按文档声明的名字精确匹配。
 */
export interface LocalFontDeclaration {
  /** 文档声明的 FontName，如 `宋体`。 */
  readonly fontName: string;
  /** 文档声明的 FamilyName；参与匹配，不单独产生候选。 */
  readonly familyName?: string;
  /** 文档声明为粗体时为 true。 */
  readonly bold?: boolean;
  /** 文档声明为斜体时为 true。 */
  readonly italic?: boolean;
  /** 覆盖读到的字体面 family；缺省用 `fontName`。 */
  readonly family?: string;
}

/** 自定义字体加载器；`path`/`filePath` 来源必须由宿主平台实现。 */
export type FontSourceLoader = (
  source: Extract<FontSource, { path: string } | { filePath: string }>,
) => ArrayBuffer | Uint8Array | null | Promise<ArrayBuffer | Uint8Array | null>;

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
  /**
   * 本地字体（`queryLocalFonts`）能力配置。
   *
   * 省略等价于「关闭 + 不展示开关」：此时 `{ local }` 来源按不支持跳过并 warning。
   */
  readonly localFonts?: LocalFontsOptions;
}

/** 本地字体能力配置（设计 §3.2）。 */
export interface LocalFontsOptions {
  /** 是否允许使用本机字体；缺省 false，false 时整个能力不可见。 */
  readonly enabled?: boolean;
  /** 宿主默认值：用户从未做过选择时生效；缺省 false。 */
  readonly defaultEnabled?: boolean;
  /** 是否把用户选择记在 localStorage；缺省 true。 */
  readonly remember?: boolean;
  /** 单个文档最多查询多少个文档声明字体；缺省 8。 */
  readonly maxFonts?: number;
  /** 授权确认框文案覆盖（例如内网统一口径）。 */
  readonly consentText?: string;
}

/** 字体来源解析器选项。 */
export interface FontSourceResolverOptions {
  /** path/filePath 来源的读取器；缺省时这两类来源解析失败。 */
  readonly loader?: FontSourceLoader;
  /** 文档请求参数；只使用 `headers` 与字体来源 headers 合并（来源优先）。 */
  readonly requestInit?: RequestInit;
  /**
   * 本地字体开关与别名表。
   *
   * `enabled` 缺省 false：关闭时 `{ local }` 来源直接跳过并回调 `onError`，不发起任何
   * `queryLocalFonts` 调用（REQ-0180）。
   */
  readonly localFonts?: {
    /** 是否启用本地字体来源；缺省 false。 */
    readonly enabled?: boolean;
    /** 别名表；缺省使用引擎内置别名组。 */
    readonly aliases?: FontAliasTable;
  };
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
  /** 进行中或已完成的读取 Promise；`local` 来源可展开为多个字体面。 */
  promise: Promise<FontInput[]>;
  /** 读取成功后的引擎字体输入；进行中、失败或被取消时为 undefined。 */
  value?: FontInput[];
  /** 读取是否已被取消（dispose 或 open 信号中止）。 */
  cancelled: boolean;
}

/** 字体来源解析器：把一个或多个 `FontSource` 读取为引擎可用的 `FontInput`。 */
export class FontSourceResolver {
  private readonly loader: FontSourceLoader | undefined;
  private readonly requestInit: RequestInit | undefined;
  private readonly fetchImpl: typeof fetch | null;
  /** 本地字体开关；关闭时 `{ local }` 来源直接跳过。 */
  private localFontsEnabled: boolean;
  /** 别名表：内置组或宿主组，用于把中文声明映射成 PostScript 名。 */
  private readonly aliasTable: FontAliasTable;
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
    this.localFontsEnabled = options.localFonts?.enabled === true;
    this.aliasTable = options.localFonts?.aliases ?? DEFAULT_FONT_ALIASES;
    const globalObject = getGlobalObject();
    const globalFetch = (globalObject as { fetch?: typeof fetch }).fetch;
    // 浏览器原生 fetch 必须绑定全局对象，否则调用时丢失 this。
    this.fetchImpl = globalFetch ? globalFetch.bind(globalObject) : null;
  }

  /**
   * 解析一组字体来源。
   *
   * 读取规则：`data` 直接透传；`url` 用 fetch 读取（非 2xx 视为失败）；`path`/`filePath`
   * 走 loader（返回 null 视为失败）；`local` 按名字定向查询本机字体（未开启或不支持时
   * 失败）。非 `data` 来源按来源键去重，两个列表引用同一 URL 时只读取一次；失败结果不
   * 缓存，下次 `open()` 重新尝试。取消信号中止后不再写入结果。
   *
   * 返回顺序与来源声明顺序一致：一个 `{ local }` 来源可能命中多个字体面，按来源顺序
   * 展平后交给引擎，不做重排。
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
  ): Promise<FontInput[]> {
    if (this.disposed || sources.length === 0) return [];
    if (signal?.aborted) return [];
    const tasks = sources.map(async (source) => {
      try {
        return await this.readSource(source, signal);
      } catch (error) {
        onError(source, error);
        return null;
      }
    });
    const results = await Promise.all(tasks);
    // 一源可产出 0..n 个字体面：按来源声明顺序展平。
    return results.flatMap((inputs) => inputs ?? []);
  }

  /**
   * 设置本地字体开关。
   *
   * 关闭时清空本地字体缓存：已读到的本机字体不再出现在后续 `open()` 中，回退到
   * `url`/`data`/`loader` 来源；重新开启后需要再次读取（浏览器授权状态由浏览器保留，
   * 不会重复弹授权框）。`url`/`path`/`filePath` 的缓存不受影响。
   *
   * @param enabled 是否启用本地字体来源。
   */
  setLocalFontsEnabled(enabled: boolean): void {
    if (this.localFontsEnabled === enabled) return;
    this.localFontsEnabled = enabled;
    for (const key of Array.from(this.cache.keys())) {
      if (key.startsWith('local:')) this.cache.delete(key);
    }
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
   * @returns 引擎字体输入列表；`local` 来源可能命中多个字体面。
   * @throws {Error} 来源非法、缺少 loader、读取失败、被取消或来源字节为空。
   */
  private readSource(
    source: FontSource,
    signal: AbortSignal | undefined,
  ): Promise<FontInput[]> {
    if (!isFontSourceObject(source)) {
      return Promise.reject(new Error('字体来源必须是对象'));
    }
    if ('data' in source) {
      const data = source.data;
      if (!isFontBytes(data)) {
        return Promise.reject(new Error('字体来源 data 必须是 ArrayBuffer 或 Uint8Array'));
      }
      if (data.byteLength === 0) return Promise.reject(new Error('字体来源 data 为空'));
      return Promise.resolve([withFamily({ data }, source.family)]);
    }
    const key = fontSourceKey(source);
    if (!key) return Promise.reject(new Error('字体来源缺少 url/path/filePath/local'));
    if (this.disposed || signal?.aborted) return Promise.reject(createAbortError());
    const cached = this.cache.get(key);
    if (cached) {
      // 进行中的读取复用同一 Promise；已取消的读取不返回结果，由下次 open 重新读取。
      return settleEntry(cached);
    }
    const entry: FontCacheEntry = {
      promise: undefined as unknown as Promise<FontInput[]>,
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
    entry.promise = this.loadSource(source, key, controller.signal).then(
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
        // 「本机未安装」是可缓存的负向事实：保留条目与空结果，重开不再重复查询。
        if (isNotInstalledError(error)) {
          if (!entry.cancelled) entry.value = [];
        } else if (this.cache.get(key) === entry) {
          // 其它失败/取消都不缓存：移除后下次 open 重新尝试。
          this.cache.delete(key);
        }
        throw error;
      },
    );
    this.cache.set(key, entry);
    return settleEntry(entry);
  }

  /**
   * 实际执行一次读取（url / loader / local）。
   *
   * @param source 字体来源（非 data）。
   * @param key 来源键，用于诊断。
   * @param signal 本次读取的取消信号。
   * @returns 引擎字体输入列表；URL/路径来源固定一项，本地字体可能为空。
   * @throws {Error} 读取失败或结果为空/非法。
   */
  private async loadSource(
    source: Exclude<FontSource, { data: unknown }>,
    key: string,
    signal: AbortSignal,
  ): Promise<FontInput[]> {
    if (signal.aborted) throw createAbortError();
    if ('local' in source) return this.readLocalSource(source, signal);
    let data: ArrayBuffer | Uint8Array;
    if ('url' in source) {
      data = await this.fetchFont(source, signal);
    } else {
      if (!this.loader) throw new Error('未配置字体加载器（fonts.loader），无法读取 path/filePath 来源');
      const loaded = await this.loader(source);
      if (loaded === null || loaded === undefined) throw new Error('字体加载器未返回字节');
      if (!isFontBytes(loaded)) {
        throw new Error('字体加载器返回的必须是 ArrayBuffer 或 Uint8Array');
      }
      data = loaded;
    }
    if (signal.aborted) throw createAbortError();
    if (data.byteLength === 0) throw new Error(`字体来源为空：${key}`);
    return [withFamily({ data }, source.family)];
  }

  /**
   * 读取本地字体来源。
   *
   * 先判断开关（关闭时不发起任何 `queryLocalFonts` 调用），再把声明展开成候选
   * PostScript 名，**一次调用**整批查询；命中后读字体字节。未开启、不支持、未安装或
   * 权限不足都抛错，由 `resolve()` 统一转成 `W_FONT_MISSING` 并跳过该来源——调用方看到
   * 的仍是「本地字体不可用时完全回退到其它来源」。
   *
   * @param source 带 local 的字体来源。
   * @param signal 本次读取的取消信号。
   * @returns 引擎字体输入列表（0 或 1 项）。
   * @throws {Error} 未开启、不支持、未安装、权限不足、被取消或读取失败。
   */
  private async readLocalSource(
    source: { readonly local: string | readonly string[] | LocalFontDeclaration; readonly family?: string },
    signal: AbortSignal,
  ): Promise<FontInput[]> {
    if (!this.localFontsEnabled) {
      throw new Error('本地字体来源未启用（fonts.localFonts.enabled）');
    }
    const declarations = toLocalDeclarations(source.local);
    if (declarations.length === 0) throw new Error('本地字体来源缺少字体名');

    // 展开候选：数组里的每个声明都参与，按声明顺序拼接并去重。
    const names: string[] = [];
    for (const declaration of declarations) {
      const expanded = expandLocalFontCandidates(declaration, this.aliasTable);
      for (const candidate of expanded.names) {
        if (!names.includes(candidate)) names.push(candidate);
      }
    }
    if (names.length === 0) throw new Error('本地字体来源无法展开出可查询的名字');
    if (signal.aborted) throw createAbortError();

    // 一次声明一次查询：首次调用约 870–950 ms，禁止逐名串行。
    // 查询本身可能不可取消（浏览器不响应 signal），因此与取消信号竞速：一旦中止立即
    // 以 AbortError 结束，避免打开流程被挂起的查询拖住。
    const result = await raceAbort(
      queryLocalFontFaces(names.slice(0, MAX_QUERY_NAMES), { signal }),
      signal,
    );
    if (signal.aborted) throw createAbortError();
    if (result.state === 'unsupported') throw new Error('当前浏览器不支持本地字体查询');
    if (result.state === 'denied') throw new Error('未获得本机字体访问授权');
    const hit = result.faces[0];
    // 未取得命中的两种情况必须区分（REQ-0160 / C12）：
    // - 已授权但本机未安装：可缓存的正向事实，重开不再支付首次查询开销；
    // - 权限尚未授予（prompt）：不缓存，用户授权后应能立即生效。
    if (!hit) {
      const message = `本机未安装字体：${names.join(', ')}`;
      if (result.state === 'granted') throw createNotInstalledError(message);
      throw new Error(`${message}（权限状态：${result.state}）`);
    }

    // family 优先取来源显式给出的值，其次取文档声明的 FontName，使引擎按声明名精确匹配。
    const family = source.family ?? declarations[0]?.fontName?.trim();
    const input = await readLocalFontInput(hit.face, family);
    if (!input) throw new Error(`本地字体文件为空：${hit.face.postscriptName}`);
    if (signal.aborted) throw createAbortError();
    return [input];
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
    // 字体可达数十 MiB：优先流式读取以暴露下载进度；环境无 body 流时退回一次性读取。
    const body = (response as { body?: ReadableStream<Uint8Array> | null }).body;
    if (!body || typeof body.getReader !== 'function') {
      return response.arrayBuffer();
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
 * @returns 读取成功时兑现引擎字体输入列表。
 */
function settleEntry(entry: FontCacheEntry): Promise<FontInput[]> {
  return entry.promise.then((value) => {
    if (entry.cancelled) throw createAbortError();
    return value;
  });
}

/**
 * 生成来源去重键。
 *
 * `url` 按完整 URL 字符串（含 query）去重，不按字体名；`local` 按声明（名字或字体
 * 声明对象）序列化后去重；`data` 返回 null（不缓存）。
 *
 * @param source 字体来源。
 * @returns 形如 `url:<url>` / `path:<path>` / `filePath:<filePath>` / `local:<key>` 的键；
 *   `data` 或非法 local 来源为 null。
 */
function fontSourceKey(
  source: Exclude<FontSource, { data: unknown }>,
): string | null {
  if ('url' in source) return source.url ? `url:${source.url}` : null;
  if ('path' in source) return source.path ? `path:${source.path}` : null;
  if ('filePath' in source) return source.filePath ? `filePath:${source.filePath}` : null;
  if ('local' in source) return `local:${localDeclarationKey(source.local)}`;
  return null;
}

/**
 * 生成本地字体来源的去重键。
 *
 * 数组按声明顺序拼接；字体声明对象按参与候选展开的字段拼接，保证不同声明不会误命中
 * 同一缓存项。
 *
 * @param local 来源声明（名字、名字数组或字体声明对象）。
 * @returns 去掉首尾空白的键；无有效名字时返回空串（调用方据此判为非法来源）。
 */
function localDeclarationKey(local: string | readonly string[] | LocalFontDeclaration): string {
  if (typeof local === 'string') return local.trim();
  if (Array.isArray(local)) {
    return local
      .map((name) => (typeof name === 'string' ? name.trim() : ''))
      .filter(Boolean)
      .join(',');
  }
  const declaration = local as LocalFontDeclaration;
  const parts = [
    declaration.fontName?.trim() ?? '',
    declaration.familyName?.trim() ?? '',
    declaration.bold ? 'bold' : '',
    declaration.italic ? 'italic' : '',
  ].filter(Boolean);
  return parts.join('|');
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

/** 单次 `queryLocalFonts` 调用的候选名上限（设计 §3.3 候选上限 6 与 §1.4 单次 ≤8 取严）。 */
const MAX_QUERY_NAMES = 6;

/**
 * 把本地字体来源声明规范化为候选展开用的声明列表。
 *
 * 字符串与字符串数组按名字逐个展开；字体声明对象原样使用。
 *
 * @param local 来源声明。
 * @returns 声明列表；无有效项时为空数组。
 */
function toLocalDeclarations(
  local: string | readonly string[] | LocalFontDeclaration,
): readonly LocalFontDeclaration[] {
  if (typeof local === 'string') {
    const name = local.trim();
    return name ? [{ fontName: name }] : [];
  }
  if (Array.isArray(local)) {
    return local
      .map((name) => (typeof name === 'string' ? name.trim() : ''))
      .filter(Boolean)
      .map((name) => ({ fontName: name }));
  }
  const declaration = local as LocalFontDeclaration;
  const fontName = declaration.fontName?.trim() ?? '';
  if (!fontName) return [];
  return [{ ...declaration, fontName }];
}

/**
 * 让查询与取消信号竞速。
 *
 * 浏览器不保证 `queryLocalFonts` 会响应取消信号，打开流程因此不能无限等待：信号中止时
 * 立即以 AbortError 拒绝，查询结果被丢弃（不写入缓存）。
 *
 * @param task 进行中的查询。
 * @param signal 取消信号。
 * @returns 查询结果；信号先中止时以 AbortError 拒绝。
 */
function raceAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // 查询仍会完成，吞掉其拒绝避免未处理拒绝。
    void task.catch(() => undefined);
    return Promise.reject(createAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      void task.catch(() => undefined);
      reject(createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** 「本机未安装」错误标记，用于让缓存区分可缓存事实与权限态失败。 */
const NOT_INSTALLED_CODE = 'LOCAL_FONT_NOT_INSTALLED';

/**
 * 创建「本机未安装」错误。
 *
 * @param message 诊断消息，只含字体名。
 * @returns 带 `code` 标记的错误。
 */
function createNotInstalledError(message: string): Error {
  const error = new Error(message);
  (error as Error & { code?: string }).code = NOT_INSTALLED_CODE;
  return error;
}

/**
 * 判断错误是否为「本机未安装」。
 *
 * @param error 任意错误。
 * @returns 带 `LOCAL_FONT_NOT_INSTALLED` 标记时返回 true。
 */
function isNotInstalledError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === NOT_INSTALLED_CODE
  );
}
