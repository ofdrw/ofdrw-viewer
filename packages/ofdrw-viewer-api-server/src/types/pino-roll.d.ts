/**
 * `pino-roll` 的类型声明。
 *
 * pino-roll 4.x 不随包发布类型；这里只声明本包用到的最小接口，其余字段按其
 * README 转录，避免引入 `@types/pino-roll` 这类非官方声明。
 */

declare module 'pino-roll' {
  import type { SonicBoomOpts } from 'sonic-boom';

  /** 文件保留策略：轮转时删除最旧文件。 */
  interface PinoRollLimitOptions {
    /** 保留的文件数，不含当前正在写的文件。 */
    readonly count?: number;
    /** 为 true 时同时删除同名的非本服务文件。 */
    readonly removeOtherLogFiles?: boolean;
  }

  /** `pino-roll` 选项。 */
  interface PinoRollOptions extends SonicBoomOpts {
    /** 日志文件基名或返回基名的函数。 */
    readonly file: string | (() => string);
    /** 单个文件大小上限，形如 `'10m'`；与本包“不按大小切分”的策略无关。 */
    readonly size?: string | number;
    /** 轮转频率，`'daily'` 表示按天。 */
    readonly frequency?: string | number;
    /** 文件扩展名，由 pino-roll 补齐前导点。 */
    readonly extension?: string;
    /** 保留策略。 */
    readonly limit?: PinoRollLimitOptions;
    /** 是否创建指向当前文件的符号链接。 */
    readonly symlink?: boolean;
    /** 文件名中附加的日期格式（date-fns 语法）。 */
    readonly dateFormat?: string;
    /** 父目录不存在时自动创建。 */
    readonly mkdir?: boolean;
    /** 新建文件的权限位（POSIX），如 `0o640`。 */
    readonly mode?: number;
  }

  /**
   * 创建按频率轮转的文件写入流，可直接作为 pino 的 transport。
   *
   * @param options 文件与轮转选项
   * @returns 可写流
   */
  export default function roll(options: PinoRollOptions): Promise<import('node:stream').Writable>;
}