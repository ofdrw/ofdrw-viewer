/**
 * Attachments.xml 解码。
 *
 * 附件列表是可选文档信息；单个条目字段非法只 warning 后跳过/回退，
 * 不阻断文档打开或页面渲染。`Size` 按 GB/T 33190 以 KB 声明，模型统一换算为 byte。
 */

import type { XmlNode } from '../xml/types';
import type { AttachmentModel, ResourceId } from './types';
import type { DecodeOptions } from './decode';
import { dirnameOf, resolvePackagePath } from '../container/path';
import { attr, childText, children, emitWarning } from './decode-utils';
import { normalizeResourceId } from './ids';
import { toNumber } from '../xml/numbers';

/** 附件字段非法/缺失时的 warning 码。 */
const ATTACHMENT_FIELD_WARNING = 'W_ATTACHMENT_FIELD';

/**
 * 解码 Attachments.xml。
 *
 * `Attachment@ID` 与 `Attachment@Name` 为必选；缺失时跳过该条。重复 ID 保留先出现者。
 * `Visible` 缺省 true，`Usage` 缺省 `none`；日期、格式、ContentType、Desc 保留 XML 原文；
 * `IsEncrypted` 未声明时省略，声明值非法时省略并 warning。
 *
 * @param root Attachments.xml 根节点。
 * @param filePath Attachments.xml 的包内路径，用于解析相对 FileLoc。
 * @param options 解码选项；字段非法时通过 warning 上报。
 * @returns 附件条目，保持 XML 顺序。
 */
export function decodeAttachments(
  root: XmlNode,
  filePath: string,
  options: DecodeOptions = {},
): AttachmentModel[] {
  const baseDir = dirnameOf(filePath);
  const context = { ...(options.onWarning ? { onWarning: options.onWarning } : {}) };
  const result: AttachmentModel[] = [];
  const seenIds = new Set<ResourceId>();

  for (const node of children(root, 'Attachment')) {
    const id = normalizeResourceId(attr(node, 'ID'));
    if (!id) {
      emitWarning(context, ATTACHMENT_FIELD_WARNING, 'Attachment 缺少 ID，已跳过');
      continue;
    }
    if (seenIds.has(id)) {
      emitWarning(
        context,
        'W_DUPLICATE_RESOURCE',
        `附件 ID 重复：${id}，保留先出现者`,
        { resourceId: id },
      );
      continue;
    }

    const name = (attr(node, 'Name') ?? '').trim();
    if (!name) {
      emitWarning(
        context,
        ATTACHMENT_FIELD_WARNING,
        `附件 ${id} 缺少 Name，已跳过`,
        { resourceId: id },
      );
      continue;
    }

    seenIds.add(id);
    const model: AttachmentModel = {
      id,
      name,
      visible: decodeVisible(node, id, options),
      usage: (attr(node, 'Usage') ?? '').trim() || 'none',
    };

    const format = (attr(node, 'Format') ?? '').trim();
    if (format) model.format = format;
    const size = decodeSize(node, id, options);
    if (size !== undefined) model.size = size;
    const creationDate = (attr(node, 'CreationDate') ?? '').trim();
    if (creationDate) model.creationDate = creationDate;
    const modDate = (attr(node, 'ModDate') ?? '').trim();
    if (modDate) model.modDate = modDate;
    const contentType = (attr(node, 'ContentType') ?? '').trim();
    if (contentType) model.contentType = contentType;
    const description = (attr(node, 'Desc') ?? '').trim();
    if (description) model.description = description;
    const submissionDate = (attr(node, 'SubmissionDate') ?? '').trim();
    if (submissionDate) model.submissionDate = submissionDate;
    const isEncrypted = decodeIsEncrypted(node, id, options);
    if (isEncrypted !== undefined) model.isEncrypted = isEncrypted;

    const fileLoc = (childText(node, 'FileLoc') ?? attr(node, 'FileLoc') ?? '').trim();
    if (fileLoc) {
      try {
        model.fileLoc = resolvePackagePath(baseDir, fileLoc);
      } catch (error) {
        emitWarning(
          context,
          ATTACHMENT_FIELD_WARNING,
          `附件 ${id} 的 FileLoc 路径非法：${JSON.stringify(fileLoc)}（${String(error)}）`,
          { resourceId: id },
        );
      }
    }
    result.push(model);
  }
  return result;
}

/**
 * 解析 Attachment@Visible。
 *
 * @param node Attachment 节点。
 * @param id 附件 ID，用于 warning 定位。
 * @param options 解码选项。
 * @returns 是否可见；缺失或非法时按规范默认 true。
 */
function decodeVisible(node: XmlNode, id: ResourceId, options: DecodeOptions): boolean {
  const raw = attr(node, 'Visible');
  if (raw === undefined) return true;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  emitWarning(
    { ...(options.onWarning ? { onWarning: options.onWarning } : {}) },
    ATTACHMENT_FIELD_WARNING,
    `附件 ${id} 的 Visible 非法：${JSON.stringify(raw)}，按 true 处理`,
    { resourceId: id },
  );
  return true;
}

/**
 * 解析 Attachment@IsEncrypted。
 *
 * @param node Attachment 节点。
 * @param id 附件 ID，用于 warning 定位。
 * @param options 解码选项。
 * @returns 是否加密；未声明或非法时 undefined。
 */
function decodeIsEncrypted(
  node: XmlNode,
  id: ResourceId,
  options: DecodeOptions,
): boolean | undefined {
  const raw = attr(node, 'IsEncrypted');
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  emitWarning(
    { ...(options.onWarning ? { onWarning: options.onWarning } : {}) },
    ATTACHMENT_FIELD_WARNING,
    `附件 ${id} 的 IsEncrypted 非法：${JSON.stringify(raw)}，已省略`,
    { resourceId: id },
  );
  return undefined;
}

/**
 * 解析 Attachment@Size。
 *
 * XML 中单位为 KB；返回 byte。缺失、负数、非数值或超出安全整数范围时省略并 warning。
 *
 * @param node Attachment 节点。
 * @param id 附件 ID，用于 warning 定位。
 * @param options 解码选项。
 * @returns 附件大小，byte；未声明或非法时 undefined。
 */
function decodeSize(node: XmlNode, id: ResourceId, options: DecodeOptions): number | undefined {
  const raw = attr(node, 'Size');
  if (raw === undefined || raw.trim() === '') return undefined;
  const kb = toNumber(raw, Number.NaN);
  if (!Number.isFinite(kb) || kb < 0 || kb > Number.MAX_SAFE_INTEGER / 1024) {
    emitWarning(
      { ...(options.onWarning ? { onWarning: options.onWarning } : {}) },
      ATTACHMENT_FIELD_WARNING,
      `附件 ${id} 的 Size 非法：${JSON.stringify(raw)}，已省略`,
      { resourceId: id },
    );
    return undefined;
  }
  return Math.round(kb * 1024);
}