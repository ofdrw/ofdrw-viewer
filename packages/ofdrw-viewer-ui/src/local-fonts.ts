/**
 * 本地字体读取（Local Font Access API；本地字体加载方案设计 §1、§4、§6、§7）。
 *
 * 本模块是纯查询层：能力检测、权限查询、按名字**定向**查询字体面、把字体面字节读成
 * 引擎可用的 `FontInput`。不含开关状态解析与持久化（在 `local-fonts-state.ts`），
 * 也不含声明筛选与注入顺序（在 `document-controller`）。
 *
 * 三条来自实测（设计 §1.1）的硬约束：
 * 1. 浏览器只允许在**用户手势**内申请 `local-fonts` 权限：无手势调用抛
 *    `SecurityError: User activation is required.` 且授权框不出现，不能在 `open()` 里静默申请；
 * 2. 权限为 `denied` 时 `queryLocalFonts()` **resolve 为 `[]` 而不抛错**，与「字体未安装」
 *    返回值相同，必须用 `navigator.permissions.query` 区分；
 * 3. 只做定向查询，禁止无参全量枚举（全量枚举本机 853 个字体面约 2.5 GB / 19 s）。
 *
 * 字体字节只在内存中交给引擎，不写日志、不写存储（设计 §7）。
 */

import type { FontInput } from '@ofdrw/ofdrw-viewer-engine';
import { getGlobalObject, readBlobBytes } from './compat';
import type { LocalFontStatus } from './local-fonts-state';

/** `queryLocalFonts` 返回的字体面；只声明本模块用到的字段。 */
export interface LocalFontFace {
  /** PostScript 名；`queryLocalFonts({ postscriptNames })` 的匹配键（区分大小写）。 */
  readonly postscriptName: string;
  /** 完整名称，如 `宋体`。 */
  readonly fullName: string;
  /** 字体族名，如 `宋体`。 */
  readonly family: string;
  /** 字面风格，如 `Regular`、`Bold`。 */
  readonly style: string;
  /**
   * 读取完整字体文件字节。
   *
   * @returns 字体文件 Blob（TrueType/OpenType 完整数据）。
   */
  blob(): Promise<Blob>;
}

/** 本地字体查询函数签名；只允许携带 `postscriptNames` 的定向查询。 */
export type QueryLocalFonts = (options?: {
  readonly postscriptNames?: readonly string[];
}) => Promise<readonly LocalFontFace[]>;

/** 一次定向查询中命中的字体面。 */
export interface LocalFontFaceHit {
  /** 命中的候选名（与传入的 `postscriptNames` 元素逐字相等）。 */
  readonly name: string;
  /** 命中的字体面。 */
  readonly face: LocalFontFace;
}

/** 一次定向查询的结果。 */
export interface LocalFontQueryResult {
  /** 权限/能力状态；`denied` 与 `unsupported` 时 `faces` 必为空，调用方不得当作「未安装」。 */
  readonly state: LocalFontStatus;
  /** 命中的字体面，按候选优先级排序；只含命中项。 */
  readonly faces: readonly LocalFontFaceHit[];
  /** 本次实际提交给 `queryLocalFonts` 的候选名，用于诊断（不落盘、不进日志）。 */
  readonly triedNames: readonly string[];
}

/**
 * 检测当前环境是否提供 Local Font Access API。
 *
 * 只做特性检测，不判断 UA：该 API 自 Chrome 103 起可用，而 UI 兼容目标是 Chrome 67
 * （设计 §8），因此不支持时整个能力不可见，不做 polyfill。
 *
 * @returns 存在 `queryLocalFonts` 函数时返回 true。
 */
export function supportsLocalFonts(): boolean {
  const scope = getGlobalObject() as { queryLocalFonts?: unknown };
  return typeof scope.queryLocalFonts === 'function';
}

/**
 * 读取本地字体权限状态。
 *
 * `navigator.permissions.query({ name: 'local-fonts' })` 是区分「已拒绝」与「未安装」的
 * 唯一手段（设计 §1.1）：两者调用 `queryLocalFonts()` 都得到 `[]`。
 *
 * 无法确定时一律返回 `prompt`（保守假设），**不得**用 `denied` 兜底：把「查不到权限」
 * 误判成「用户拒绝」，会导致错过本可申请授权的时机。`unsupported` 只由缺少
 * `queryLocalFonts` 函数这一条决定。
 *
 * @returns 权限状态：`unsupported` / `prompt` / `granted` / `denied`。
 */
export async function queryLocalFontsPermission(): Promise<LocalFontStatus> {
  if (!supportsLocalFonts()) return 'unsupported';
  const scope = getGlobalObject() as {
    navigator?: {
      permissions?: {
        query?: (descriptor: { name: string }) => Promise<{ state?: string }>;
      };
    };
  };
  const permissions = scope.navigator?.permissions;
  const query = permissions?.query;
  if (!permissions || typeof query !== 'function') return 'prompt';
  try {
    const status = await query.call(permissions, { name: 'local-fonts' });
    if (status?.state === 'granted') return 'granted';
    if (status?.state === 'denied') return 'denied';
    return 'prompt';
  } catch {
    // 描述符不被识别（TypeError）或 Permissions API 不可用时按「未决定」处理。
    return 'prompt';
  }
}

/**
 * 按候选名定向查询本机字体面。
 *
 * **一次声明只发起一次 `queryLocalFonts` 调用**，把该声明的整组候选名一次传入：
 * 实测首次调用有约 870–950 ms 初始化开销，逐个名字串行调用会成倍放大（设计 §1.4）。
 * 浏览器返回顺序不保证等于传入顺序，因此结果按候选名的索引重排后再返回，语义等价于
 * 「按候选优先级挑出全部命中项」。
 *
 * `denied` / `unsupported` 时直接返回空 `faces`，**不抛错**，由调用方按状态决定文案；
 * 其它异常（含无手势时的 `SecurityError`、`NotAllowedError`）同样归一为 `state`
 * 不变、`faces` 为空的失败结果，不向调用方抛出。
 *
 * @param names 候选 PostScript 名，按优先级排列；空数组时不发起任何调用。
 * @param options.signal 取消信号；中止后不再发起调用并返回空结果。
 * @returns 权限状态、命中项（按候选优先级）与实际提交的候选名。
 */
export async function queryLocalFontFaces(
  names: readonly string[],
  options: { readonly signal?: AbortSignal } = {},
): Promise<LocalFontQueryResult> {
  const state = await queryLocalFontsPermission();
  const triedNames: readonly string[] = names
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  // 候选为空时不调用：避免无意义的首次初始化开销（约 870–950 ms）。
  if (triedNames.length === 0) return { state, faces: [], triedNames: [] };
  if (state === 'unsupported' || state === 'denied') return { state, faces: [], triedNames };
  if (options.signal?.aborted) return { state, faces: [], triedNames };

  const scope = getGlobalObject() as { queryLocalFonts?: QueryLocalFonts };
  const query = scope.queryLocalFonts;
  if (typeof query !== 'function') return { state: 'unsupported', faces: [], triedNames };
  try {
    const returned = await query.call(scope, { postscriptNames: [...triedNames] });
    if (options.signal?.aborted) return { state, faces: [], triedNames };
    return { state, faces: sortHitsByPriority(returned, triedNames), triedNames };
  } catch (error) {
    // 权限被拒（NotAllowedError）与无用户手势（SecurityError）统一按「未取得结果」处理：
    // 状态仍以 Permissions API 为准，避免把失败误报成「字体未安装」。
    // 非权限类错误同样不抛给调用方：本地字体是可选增强，失败一律回退到其它来源（设计 §2.1）。
    return { state: stateOfFailure(state, error), faces: [], triedNames };
  }
}

/**
 * 把浏览器返回的字体面按候选优先级重排。
 *
 * 只保留候选名中确实出现过的项；同一候选名对应多个字体面时取第一个。
 *
 * @param returned 浏览器返回的字体面（顺序不保证）。
 * @param triedNames 提交给查询的候选名，按优先级排列。
 * @returns 按候选优先级排序的命中项。
 */
function sortHitsByPriority(
  returned: readonly LocalFontFace[],
  triedNames: readonly string[],
): readonly LocalFontFaceHit[] {
  const priority = new Map<string, number>();
  triedNames.forEach((name, index) => priority.set(name, index));
  const hits: { order: number; hit: LocalFontFaceHit }[] = [];
  const seen = new Set<string>();
  for (const face of returned) {
    const match = triedNames.find((name) => name === face.postscriptName);
    if (match === undefined || seen.has(match)) continue;
    seen.add(match);
    hits.push({ order: priority.get(match) ?? Number.MAX_SAFE_INTEGER, hit: { name: match, face } });
  }
  // 按候选优先级排序；`sort` 为就地排序，此处作用在新数组上。
  hits.sort((a, b) => a.order - b.order);
  return hits.map((item) => item.hit);
}

/**
 * 判断错误是否为权限/用户手势类错误。
 *
 * 只有 `NotAllowedError` 与 `SecurityError` 视为权限原因；其余错误（如 `TypeError` 参数
 * 错误）不按权限处理。
 *
 * @param error 任意错误。
 * @returns 是权限类错误时返回 true。
 */
export function isLocalFontPermissionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'NotAllowedError' || name === 'SecurityError';
}

/**
 * 根据查询失败原因决定对外呈现的权限状态。
 *
 * 权限类错误（无用户手势、被策略禁止）说明「尚未取得授权」，对外仍报 `prompt`，让 UI
 * 有机会在用户点击时重新申请；非权限类错误保持调用前的状态不变。
 *
 * @param state 调用前的权限状态。
 * @param error 查询抛出的错误。
 * @returns 对外呈现的权限状态。
 */
function stateOfFailure(state: LocalFontStatus, error: unknown): LocalFontStatus {
  if (!isLocalFontPermissionError(error)) return state;
  return state === 'granted' ? 'prompt' : state;
}

/**
 * 把命中的字体面读成引擎可用的字体输入。
 *
 * 字节经 `compat.ts` 的 `readBlobBytes()` 读取：Chrome 67 没有
 * `Blob.prototype.arrayBuffer`（设计 §8）。`family` 优先取调用方给出的名字（通常是
 * 文档声明的 FontName，使引擎按归一化名精确匹配命中），缺省退回字体面自身的 family。
 *
 * @param face 命中的字体面。
 * @param family 覆盖用的字体族名；通常为文档声明的 FontName。
 * @returns 引擎字体输入；字体文件为空时返回 undefined。
 * @throws {Error} 读取 Blob 字节失败时抛出，由调用方决定是否跳过该字体面。
 */
export async function readLocalFontInput(
  face: LocalFontFace,
  family?: string,
): Promise<FontInput | undefined> {
  const blob = await face.blob();
  if (!blob || typeof blob.size !== 'number' || blob.size === 0) return undefined;
  const data = await readBlobBytes(blob);
  if (data.byteLength === 0) return undefined;
  const name = (family ?? face.family ?? face.fullName ?? '').trim();
  return name ? { data, family: name } : { data };
}
