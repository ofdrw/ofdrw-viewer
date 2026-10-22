/**
 * Document.xml 权限声明解码。
 *
 * 只解析 `Permissions` 的布尔项、`Print@Printable/@Copies` 与
 * `ValidPeriod@StartDate/@EndDate`；不执行任何 DRM/权限强制。
 */

import type { XmlNode } from '../xml/types';
import type { PermissionModel } from './types';
import type { DecodeOptions } from './decode';
import { attr, child, childText, emitWarning } from './decode-utils';

/**
 * 解码 `Permissions` 节点。
 *
 * 缺省/缺失字段按规格回退：六项布尔权限均为 true，打印允许且份数不限，
 * 有效期不声明。非法字段 warning 后按对应默认值处理。
 *
 * @param node `Permissions` 节点；缺失时返回默认权限。
 * @param options 解码选项。
 * @returns 权限模型。
 */
export function decodePermissions(
  node: XmlNode | undefined,
  options: DecodeOptions = {},
): PermissionModel {
  const result: PermissionModel = {
    edit: true,
    annot: true,
    export: true,
    signature: true,
    watermark: true,
    printScreen: true,
  };
  if (!node) return result;
  result.edit = readPermissionBoolean(node, 'Edit', options);
  result.annot = readPermissionBoolean(node, 'Annot', options);
  result.export = readPermissionBoolean(node, 'Export', options);
  result.signature = readPermissionBoolean(node, 'Signature', options);
  result.watermark = readPermissionBoolean(node, 'Watermark', options);
  result.printScreen = readPermissionBoolean(node, 'PrintScreen', options);

  const printNode = child(node, 'Print');
  if (printNode) {
    const print: NonNullable<PermissionModel['print']> = {
      printable: readBooleanValue(
        attr(printNode, 'Printable') ?? childText(printNode, 'Printable'),
        'Print.Printable',
        true,
        options,
      ),
    };
    const copies = readCopies(printNode, options);
    if (copies !== undefined) print.copies = copies;
    result.print = print;
  }

  const validNode = child(node, 'ValidPeriod');
  if (validNode) {
    const start = (attr(validNode, 'StartDate') ?? attr(validNode, 'Start') ?? childText(validNode, 'StartDate') ?? childText(validNode, 'Start') ?? '').trim();
    const end = (attr(validNode, 'EndDate') ?? attr(validNode, 'End') ?? childText(validNode, 'EndDate') ?? childText(validNode, 'End') ?? '').trim();
    if (start || end) {
      const validPeriod: NonNullable<PermissionModel['validPeriod']> = {};
      if (start) validPeriod.start = start;
      if (end) validPeriod.end = end;
      result.validPeriod = validPeriod;
    }
  }
  return result;
}

/** 读取一个权限布尔项；缺失返回 true，非法 warning 后 true。 */
function readPermissionBoolean(
  node: XmlNode,
  name: string,
  options: DecodeOptions,
): boolean {
  return readBooleanValue(childText(node, name), name, true, options);
}

/** 解析布尔值；缺失返回 fallback，非法 warning 后 fallback。 */
function readBooleanValue(
  raw: string | undefined,
  field: string,
  fallback: boolean,
  options: DecodeOptions,
): boolean {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  emitWarning(
    options,
    'W_PERMISSION_FIELD',
    `Permissions.${field} 非法：${JSON.stringify(raw)}，按 ${fallback} 处理`,
  );
  return fallback;
}

/**
 * 解析 Print@Copies。
 *
 * `<0` 按不限处理并省略；0 表示不允许打印；正整数为份数。
 * 非法/超出安全整数范围时 warning 后按不限处理。
 *
 * @param node Print 节点。
 * @param options 解码选项。
 * @returns 份数；未声明/不限/非法时 undefined。
 */
function readCopies(node: XmlNode, options: DecodeOptions): number | undefined {
  const raw = (attr(node, 'Copies') ?? childText(node, 'Copies'))?.trim();
  if (!raw) return undefined;
  if (!/^[+-]?\d+$/.test(raw)) {
    emitWarning(options, 'W_PERMISSION_FIELD', `Permissions.Print.Copies 非法：${JSON.stringify(raw)}，按不限处理`);
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    emitWarning(options, 'W_PERMISSION_FIELD', `Permissions.Print.Copies 超出范围：${JSON.stringify(raw)}，按不限处理`);
    return undefined;
  }
  return value < 0 ? undefined : value;
}
