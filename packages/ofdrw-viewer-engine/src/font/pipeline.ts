/**
 * 字体适配流水线。
 *
 * 处理顺序与用户约定的架构一致：
 * 1. 推断层 `detectFontKind` 判定封装类型；
 * 2. 适配器层按类型分派到对应转换函数；
 * 3. 归一化产物统一交给 fontkit 解析。
 *
 * 每个适配器互相隔离：某个适配器内部失败时返回 null，由调用方回落原有错误路径，
 * 不会影响其它类型的判定与转换结果。
 */

import { adaptBareCff } from './cff-bare';
import { detectFontKind, type FontKind } from './font-kind';

/** 单个适配器的转换契约。 */
export interface FontAdapter {
  /**
   * 把该类型的字节转换为 fontkit 可解析的字节。
   *
   * @param bytes 原始字体字节。
   * @returns 归一化字节；无法适配时返回 null。
   */
  (bytes: Uint8Array): Uint8Array | null;
}

/**
 * 直通适配器：已是被 fontkit 原生支持的容器，无需转换。
 *
 * @param bytes 原始字体字节。
 * @returns 原字节。
 */
const passthrough: FontAdapter = (bytes) => bytes;

/** 按类型注册的适配器。 */
const ADAPTERS: Readonly<Record<FontKind, FontAdapter | null>> = {
  sfnt: passthrough,
  ttcf: passthrough,
  woff: passthrough,
  woff2: passthrough,
  'bare-cff': adaptBareCff,
  // 无法识别的类型不做任何转换，交由 fontkit 报错后转成 OFD_FONT_PARSE。
  unknown: null,
};

/**
 * 推断字体类型并执行对应适配。
 *
 * @param bytes 原始字体字节。
 * @returns 适配产物与判定出的类型；未知类型返回类型本身。
 */
export function normalizeFontBytes(bytes: Uint8Array): {
  kind: FontKind;
  bytes: Uint8Array;
} {
  const kind = detectFontKind(bytes);
  const adapter = ADAPTERS[kind];
  if (!adapter) return { kind, bytes };
  try {
    return { kind, bytes: adapter(bytes) ?? bytes };
  } catch {
    // 适配器内部异常不应中断整体流程，原样返回让 fontkit 走原有失败路径。
    return { kind, bytes };
  }
}
