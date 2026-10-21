/**
 * pdf.js JBIG2 最小工具子集（Apache-2.0）。
 *
 * 仅保留 jbig2/ccitt/core_utils 需要的异常、shadow 与日志函数；
 * 不引入原 util.js 中的浏览器兼容 shim，避免 Node/DOM 依赖。
 */

/** 基础异常，保留 pdf.js 子类语义。 */
export class BaseException extends Error {
  /**
   * @param message 异常信息。
   */
  constructor(message: string) {
    super(message);
    this.name = 'BaseException';
  }
}

/**
 * 在对象上定义不可枚举的缓存属性并返回该值。
 *
 * @param obj 目标对象。
 * @param prop 属性名。
 * @param value 属性值。
 * @returns 写入的值。
 */
export function shadow<T>(obj: Record<string, unknown>, prop: string, value: T): T {
  Object.defineProperty(obj, prop, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return value;
}

/**
 * 输出提示信息；解码器默认静默，避免宿主控制台噪声。
 *
 * @param _args 诊断参数。
 */
export function info(..._args: unknown[]): void {
  // 解码诊断由上层 warning 统一上报。
}

/**
 * 输出警告信息；解码器默认静默。
 *
 * @param _args 诊断参数。
 */
export function warn(..._args: unknown[]): void {
  // 解码诊断由上层 warning 统一上报。
}

/**
 * 断言；失败抛 Error。
 *
 * @param condition 条件。
 * @param message 失败信息。
 */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * 不可达分支。
 *
 * @param message 失败信息。
 */
export function unreachable(message: string): never {
  throw new Error(message);
}
