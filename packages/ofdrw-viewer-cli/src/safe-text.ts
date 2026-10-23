/**
 * 终端文本的安全展示工具。
 *
 * OFD 包内的 UserName、签名 ID、时间戳解析错误等都属于不可信输入。直接
 * 拼接到多行文本中时，换行可能伪造额外结果行，ESC 可能注入 ANSI 控制序列。
 * 本模块只在文本展示前清理控制字符；`--json` 输出必须保留原始值。
 */

/** ANSI CSI 转义序列；先整体移除，避免只删 ESC 后留下 `[31m`。 */
const ANSI_CSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;

/** 需要从终端文本中移除的控制字符：C0/C1、行/段分隔符。 */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

/**
 * 把不可信字符串转换为单行安全文本。
 *
 * 控制字符替换为空格，保留其余字符；不修改 JSON 输出。
 *
 * @param value 待展示的不可信字符串
 * @returns 不含控制字符的单行文本
 */
export function sanitizeDisplayText(value: string): string {
  return value.replace(ANSI_CSI, '').replace(CONTROL_CHARACTERS, ' ');
}